// LIVE integration suite — the REAL Stripe test-mode API (api.stripe.com). No
// doubles anywhere: the StripeClient here is the production client talking to real
// Stripe; the Visa minted is a real test-mode Issuing card; the webhook round-trip
// is Stripe -> `stripe listen` -> this server. Runs when STRIPE_SECRET_KEY is a
// test-mode key (sk_test_/rk_test_); skips with a message otherwise.
//
// The real-time webhook tests additionally need the Stripe CLI forwarding into this
// server:
//   stripe listen --forward-to http://localhost:4099/stripe/webhook
// with STRIPE_WEBHOOK_SECRET set to the whsec_ secret that CLI prints
// (DATACARDS_TEST_WEBHOOK_PORT overrides the port).
//
// Heads-up: if the Stripe account already has issuing_authorization.request
// webhook endpoints configured (e.g. a deployed server), those receive the test
// authorizations too — they must answer the same way (or be removed) or the
// authorization may be declined by a stale endpoint.
//
// The fiat_pay tool's race branches (tool books first while the webhook delivery is
// slow; honoring a mid-flight webhook decline) need to race the real webhook against
// the tool's own booking, so they are covered live only. The webhook-side invariants
// they depend on — duplicate delivery never double-books, decline-at-cap, signature
// rejection — are covered in-process at the bottom of this file.

process.env.DATACARDS_SHOP_RATE_LIMIT = "10000";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyedMutex, Store, issueRootCard } from "@datacards/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { recentFiatDecision } from "../src/stripe/decisions";
import {
  LIVE_WEBHOOK_PORT,
  STRIPE_TEST_KEY_RE,
  bootWebhookListener,
  deactivateIssuingCard,
  liveStripeKey,
  liveWebhookSecret,
  mcpCall,
  realStripe,
  signWebhook,
} from "./live-util";

const key = liveStripeKey();
const live = STRIPE_TEST_KEY_RE.test(key);
const webhookSecret = liveWebhookSecret();
const webhookLive = live && webhookSecret.length > 0;

if (!live) {
  console.warn(
    "[live-stripe] SKIPPED: set STRIPE_SECRET_KEY to a test-mode key (sk_test_...) to run this suite against the real Stripe API",
  );
} else if (!webhookSecret) {
  console.warn(
    `[live-stripe] webhook round-trip tests SKIPPED: run \`stripe listen --forward-to http://localhost:${LIVE_WEBHOOK_PORT}/stripe/webhook\` and set STRIPE_WEBHOOK_SECRET to the whsec_ secret it prints`,
  );
}

function harness() {
  const store = new Store(":memory:");
  const stripe = realStripe()!; // live gate guarantees this
  const deps: AppDeps = {
    store,
    datahub: null,
    stripe,
    adminToken: "live-test-admin",
    mutex: new KeyedMutex(),
  };
  const app = createApp(deps);
  const admin = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { authorization: "Bearer live-test-admin", ...(init.headers ?? {}) },
  });

  const issueCard = async (terms: Record<string, unknown>) => {
    const res = await app.request(
      "/api/cards",
      admin({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "live-test", terms }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { card_id: string; card_url: string };
    const secret = body.card_url.match(/\/c\/([^/]+)\/mcp$/)?.[1] ?? "";
    expect(secret).toBeTruthy();
    return { card_id: body.card_id, secret };
  };

  const mintVisa = async (cardId: string) => {
    const res = await app.request(`/api/cards/${cardId}/fiat`, admin());
    expect(res.status).toBe(200);
    return (await res.json()) as { linked: boolean; last4?: string };
  };

  const cardDetail = async (cardId: string) => {
    const res = await app.request(`/api/cards/${cardId}`, admin());
    expect(res.status).toBe(200);
    return (await res.json()) as {
      remaining_spend: number | null;
      access: Array<{ tool: string; status: string; memo: string | null }>;
    };
  };

  const checkout = (productId: string, card: { number: string; exp_month: number; exp_year: number; cvc: string }) =>
    app.request("/shop/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: productId, card }),
    });

  /** Reveal the card's real test Visa over the MCP lane, shaped for checkout. */
  const revealVisa = async (secret: string) => {
    const creds = await mcpCall(app, secret, "card_credentials", {});
    expect(creds.isError, `card_credentials failed: ${JSON.stringify(creds.data)}`).toBe(false);
    const number = String(creds.data.card_number ?? "");
    expect(number).toMatch(/^\d{12,19}$/);
    return {
      number,
      exp_month: Number(creds.data.exp_month),
      exp_year: Number(creds.data.exp_year),
      cvc: String(creds.data.cvc ?? ""),
    };
  };

  return { store, stripe, app, issueCard, mintVisa, cardDetail, checkout, revealVisa };
}

const suite = live ? describe : describe.skip;

suite("live Stripe payment lane (real api.stripe.com)", () => {
  test("issue -> mint a real test Visa -> reveal over MCP -> shop checkout approves and books once", async () => {
    const { store, issueCard, mintVisa, cardDetail, checkout, revealVisa } = harness();
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    const link = await mintVisa(card_id);
    expect(link.linked, "mint failed — does the Stripe account have an active cardholder?").toBe(true);

    const visa = await revealVisa(secret);
    const res = await checkout("espresso", visa);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: boolean; remaining_spend: number };
    expect(body.approved, `checkout refused: ${JSON.stringify(body)}`).toBe(true);
    expect(body.remaining_spend).toBe(495); // $5.00 - $0.05

    // one purchase booked, exactly once (shop row + any webhook row dedupe to one)
    const detail = await cardDetail(card_id);
    expect(detail.remaining_spend).toBe(495);
    expect(detail.access.filter((a) => a.status === "ok")).toHaveLength(1);
    expect(store.subtreeSpendSince(card_id, 0)).toBe(5);

    await deactivateIssuingCard(key, store.getFiatLink(card_id)!.stripe_card_id);
  }, 30000);

  test("over_spend_limit refuses a purchase beyond the spend cap", async () => {
    const { store, issueCard, mintVisa, checkout, revealVisa } = harness();
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 10, seconds: 86400 } } }); // $0.10/day
    const link = await mintVisa(card_id);
    expect(link.linked, "mint failed — does the Stripe account have an active cardholder?").toBe(true);
    const visa = await revealVisa(secret);

    const first = (await (await checkout("espresso", visa)).json()) as { approved: boolean };
    const second = (await (await checkout("espresso", visa)).json()) as { approved: boolean };
    expect(first.approved).toBe(true); // 5 of 10
    expect(second.approved).toBe(true); // exactly 10/10
    const third = (await (await checkout("stickers", visa)).json()) as { approved: boolean; reason: string };
    expect(third).toMatchObject({ approved: false, reason: "over_spend_limit" });
    // the refused purchase never booked
    expect(store.subtreeSpendSince(card_id, 0)).toBe(10);

    await deactivateIssuingCard(key, store.getFiatLink(card_id)!.stripe_card_id);
  }, 30000);

  test("shop refuses a card it doesn't recognize", async () => {
    const { checkout } = harness();
    const res = await checkout("espresso", { number: "4242424242424242", exp_month: 12, exp_year: 2030, cvc: "123" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: boolean; reason: string };
    expect(body).toMatchObject({ approved: false, reason: "card_not_recognized" });
  }, 30000);

  test("fiat_pay over MCP approves within the spend budget and books once", async () => {
    const { store, issueCard, mintVisa, app } = harness();
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    const link = await mintVisa(card_id);
    expect(link.linked, "mint failed — does the Stripe account have an active cardholder?").toBe(true);

    const out = await mcpCall(app, secret, "fiat_pay", { amount: 4.9 });
    expect(out.isError, `fiat_pay failed: ${JSON.stringify(out.data)}`).toBe(false);
    expect(out.data.approved).toBe(true);
    expect(out.data.remaining_spend).toBe(10); // $5.00 - $4.90
    // spend drawn once (webhook row + tool-call row never double-count spend)
    expect(store.subtreeSpendSince(card_id, 0)).toBe(490);

    await deactivateIssuingCard(key, store.getFiatLink(card_id)!.stripe_card_id);
  }, 30000);

  test("fiat_pay refuses over the spend cap before any Stripe call", async () => {
    const { issueCard, app } = harness();
    const { secret } = await issueCard({ budget: { spend: { amount: 100, seconds: 86400 } } });

    const out = await mcpCall(app, secret, "fiat_pay", { amount: 1.01 }); // 101 > 100
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe("over_spend_limit");
  }, 30000);
});

const webhookSuite = webhookLive ? describe : describe.skip;

webhookSuite("real-time authorization webhook (stripe listen -> this server)", () => {
  // ONE shared harness: the webhook listener serves the SAME app/store the tests
  // drive, so Stripe's real webhooks resolve against the very cards these tests issue.
  const h = harness();
  let stopListener: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    stopListener = await bootWebhookListener(h.app);
  });
  afterAll(async () => {
    if (stopListener) await stopListener();
  });

  test("approves in-budget: the REAL webhook decides and books the fiat row", async () => {
    const { store, issueCard, mintVisa, cardDetail, checkout, revealVisa } = h;
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    const link = await mintVisa(card_id);
    expect(link.linked, "mint failed — does the Stripe account have an active cardholder?").toBe(true);

    const res = await checkout("espresso", await revealVisa(secret));
    const body = (await res.json()) as { approved: boolean; authorization_id: string };
    expect(body.approved, `checkout refused: ${JSON.stringify(body)}`).toBe(true);

    // the real-time lane really decided inside Stripe's 2s window
    const decision = recentFiatDecision(body.authorization_id);
    expect(decision).not.toBeNull();
    expect(decision?.approved).toBe(true);

    // the WEBHOOK's own row (kind "fiat") landed first; the shop's insert deduped
    const detail = await cardDetail(card_id);
    const rows = detail.access.filter((a) => a.status === "ok");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe("fiat");

    await deactivateIssuingCard(key, store.getFiatLink(card_id)!.stripe_card_id);
  }, 30000);

  test("declines a charge that exceeds the card's spend budget", async () => {
    const { store, issueCard, mintVisa, cardDetail, checkout, revealVisa, stripe } = h;
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 10, seconds: 86400 } } }); // $0.10
    const link = await mintVisa(card_id);
    expect(link.linked, "mint failed — does the Stripe account have an active cardholder?").toBe(true);

    // use the budget: one espresso ($0.05) leaves $0.05
    const res = await checkout("espresso", await revealVisa(secret));
    expect(((await res.json()) as { approved: boolean }).approved).toBe(true);

    // push a $0.06 authorization straight through the REAL Stripe test helper — the
    // webhook handler must decline it (over_spend_limit) inside the 2s window
    const icId = store.getFiatLink(card_id)!.stripe_card_id;
    const auth = await stripe.createTestAuthorization({ cardId: icId, amountCents: 6, merchantName: "s0nder supply co." });
    expect(auth.approved).toBe(false);
    const decision = recentFiatDecision(auth.id);
    expect(decision?.approved).toBe(false);
    expect(decision?.reason).toBe("over_spend_limit");
    // nothing new booked
    const detail = await cardDetail(card_id);
    expect(detail.access.filter((a) => a.status === "ok")).toHaveLength(1);

    await deactivateIssuingCard(key, icId);
  }, 30000);
});

// No network, no keys — runs always.
describe("shop without Stripe configured", () => {
  test("checkout answers 503", async () => {
    const deps: AppDeps = {
      store: new Store(":memory:"),
      datahub: null,
      stripe: null,
      adminToken: "x",
      mutex: new KeyedMutex(),
    };
    const app = createApp(deps);
    const res = await app.request("/shop/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id: "espresso", card: { number: "4242424242424242", exp_month: 12, exp_year: 2030, cvc: "123" } }),
    });
    expect(res.status).toBe(503);
  });
});

// The webhook HANDLER end-to-end, in-process: real signature crypto, real engine
// store, real ledger — no Stripe/DataHub involved (the handler must never call
// either inside the 2s window). This keeps the duplicate-delivery, decline-at-cap,
// and signature-rejection invariants covered with no fake service anywhere.
describe("stripe webhook handler (in-process: real crypto + real engine)", () => {
  const secret = "whsec_unit_test";
  const savedWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  beforeAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = secret;
  });
  afterAll(() => {
    process.env.STRIPE_WEBHOOK_SECRET = savedWebhookSecret;
  });

  const authEvent = (id: string, cardId: string, amount: number) => ({
    type: "issuing_authorization.request",
    data: {
      object: {
        id,
        amount,
        currency: "usd",
        pending_request: { amount, currency: "usd" },
        card: { id: cardId },
        merchant_data: { name: "s0nder supply co." },
      },
    },
  });

  const harness = () => {
    const store = new Store(":memory:");
    const app = createApp({ store, datahub: null, stripe: null, adminToken: "x", mutex: new KeyedMutex() });
    const root = issueRootCard(store, {
      userId: "steward",
      name: "handler-test",
      terms: { budget: { spend: { amount: 500, seconds: 86400 } } },
    });
    store.setFiatLink({
      card_id: root.cardId,
      stripe_card_id: "ic_test_handler",
      last4: "4242",
      brand: "visa",
      exp_month: 8,
      exp_year: 2028,
      created_at: Math.floor(Date.now() / 1000),
    });
    const fire = async (event: unknown) => {
      const body = JSON.stringify(event);
      const res = await app.request("/stripe/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": await signWebhook(secret, body) },
        body,
      });
      return { res, body: (await res.json()) as { approved?: boolean } };
    };
    return { store, app, cardId: root.cardId, fire };
  };

  test("approves in-budget, books the fiat row, and journals the decision", async () => {
    const { store, cardId, fire } = harness();
    const { res, body } = await fire(authEvent("iauth_test_handler_1", "ic_test_handler", 5));
    expect(res.status).toBe(200);
    expect(body.approved).toBe(true);
    expect(recentFiatDecision("iauth_test_handler_1")).toMatchObject({ approved: true, reason: "in_budget" });
    const rows = store.listCharges(cardId, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "fiat", units: 0, spend_usd_cents: 5, status: "ok" });
    expect(rows[0].memo).toContain("s0nder supply co.");
  });

  test("a duplicate delivery answers duplicate_delivery and never double-books", async () => {
    const { store, cardId, fire } = harness();
    const event = authEvent("iauth_test_handler_dup", "ic_test_handler", 100);
    expect((await fire(event)).body.approved).toBe(true);
    expect((await fire(event)).body.approved).toBe(true); // Stripe retried
    expect(store.listCharges(cardId, 10)).toHaveLength(1);
    expect(store.subtreeSpendSince(cardId, 0)).toBe(100); // spent once, never twice
  });

  test("declines when the card's spend budget is exhausted", async () => {
    const { store, cardId, fire } = harness();
    expect((await fire(authEvent("iauth_test_handler_a", "ic_test_handler", 5))).body.approved).toBe(true); // 5 of 500
    expect((await fire(authEvent("iauth_test_handler_b", "ic_test_handler", 495))).body.approved).toBe(true); // exactly 500/500
    const decline = await fire(authEvent("iauth_test_handler_c", "ic_test_handler", 1));
    expect(decline.body.approved).toBe(false);
    expect(recentFiatDecision("iauth_test_handler_c")).toMatchObject({ approved: false, reason: "over_spend_limit" });
    expect(store.listCharges(cardId, 10)).toHaveLength(2); // only approved authorizations booked
  });

  test("an unknown Issuing card declines with no_card_mapping", async () => {
    const { fire } = harness();
    const { body } = await fire(authEvent("iauth_test_handler_none", "ic_test_nope", 5));
    expect(body.approved).toBe(false);
  });

  test("a bad signature is rejected with 400", async () => {
    const { app } = harness();
    const body = JSON.stringify(authEvent("iauth_test_handler_bad", "ic_test_handler", 5));
    const res = await app.request("/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": await signWebhook("whsec_wrong", body) },
      body,
    });
    expect(res.status).toBe(400);
  });
});
