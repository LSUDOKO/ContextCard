// Full HTTP-surface integration tests for the payment lane: /shop/checkout against
// a fake Stripe, the real-time authorization webhook end-to-end (HMAC signature ->
// 2s local decision -> ledger), idempotent delivery, and the refusal paths. No
// ports: createApp(deps).fetch drives every route in-process.

process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration_test";
process.env.DATACARDS_SHOP_RATE_LIMIT = "10000";

import { describe, expect, test } from "bun:test";
import { KeyedMutex, Store } from "@datacards/engine";
import { createApp } from "../src/app";
import { StripeClient } from "../src/stripe/client";
import type { AppDeps } from "../src/deps";
import { FakeStripe, signStripeWebhook } from "./helpers/fake-stripe";

type CardTerms = { budget?: { spend?: { amount: number; seconds: number } }; scope?: Record<string, unknown> };

function harness() {
  const store = new Store(":memory:");
  const fake = new FakeStripe();
  const deps: AppDeps = {
    store,
    datahub: null,
    stripe: new StripeClient("sk_test_integration0000000000000000", fake.fetchFn),
    adminToken: "test-admin-token",
    mutex: new KeyedMutex(),
  };
  const app = createApp(deps);
  // the fake Stripe's webhook callback hits the REAL /stripe/webhook handler with a
  // genuine HMAC signature, exactly like the live rail
  fake.fireWebhook = async (event) => {
    const body = JSON.stringify(event);
    const res = await app.request("/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signStripeWebhook(fake.webhookSecret, body) },
      body,
    });
    return (await res.json()) as { approved: boolean };
  };

  const admin = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { authorization: "Bearer test-admin-token", ...(init.headers ?? {}) },
  });

  const issueCard = async (terms: CardTerms) => {
    const res = await app.request(
      "/api/cards",
      admin({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "test", terms }) }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as { card_id: string; card_url: string };
  };

  const mintVisa = async (cardId: string) => {
    const res = await app.request(`/api/cards/${cardId}/fiat`, admin());
    expect(res.status).toBe(200);
    return (await res.json()) as { linked: boolean; last4?: string };
  };

  const cardDetail = async (cardId: string) => {
    const res = await app.request(`/api/cards/${cardId}`, admin());
    expect(res.status).toBe(200);
    return (await res.json()) as { remaining_spend: number | null; access: Array<{ tool: string; units: number; status: string; memo: string | null }> };
  };

  const checkout = (product_id: string, card: { number: string; exp_month: number; exp_year: number; cvc: string }) =>
    app.request("/shop/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product_id, card }),
    });

  return { store, fake, app, issueCard, mintVisa, cardDetail, checkout };
}

const authEvent = (id: string, cardId: string, amount: number) => ({
  type: "issuing_authorization.request",
  data: {
    object: {
      id,
      amount,
      currency: "usd",
      pending_request: { amount, currency: "usd" },
      card: { id: cardId },
      merchant_data: { name: "webhook test" },
    },
  },
});

describe("shop checkout (fake Stripe)", () => {
  test("approves a linked card; the webhook books the row, the shop dedupes", async () => {
    const { fake, issueCard, mintVisa, cardDetail, checkout } = harness();
    const { card_id } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    const link = await mintVisa(card_id);
    expect(link.linked).toBe(true);
    const visa = fake.panFor(link.last4!);
    expect(visa).not.toBeNull();

    const res = await checkout("espresso", visa!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: boolean; remaining_spend: number };
    expect(body.approved).toBe(true);
    expect(body.remaining_spend).toBe(495); // $5.00 - $0.05
    // the rail really fired: one signed webhook round-trip for the authorization
    expect(fake.webhookFired).toHaveLength(1);
    expect(fake.auths).toHaveLength(1);

    // the WEBHOOK's own ledger row is what landed (kind "fiat"), not the shop's
    const detail = await cardDetail(card_id);
    expect(detail.remaining_spend).toBe(495);
    expect(detail.access).toHaveLength(1);
    expect(detail.access[0]).toMatchObject({ tool: "fiat", units: 0, status: "ok" });
    expect(detail.access[0].memo).toContain("s0nder supply co.");
  });

  test("refuses an unrecognized card without touching Stripe", async () => {
    const { fake, checkout } = harness();
    const res = await checkout("espresso", { number: "4242424242424242", exp_month: 12, exp_year: 2030, cvc: "123" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approved: boolean; reason: string };
    expect(body).toMatchObject({ approved: false, reason: "card_not_recognized" });
    expect(fake.auths).toHaveLength(0);
    expect(fake.webhookFired).toHaveLength(0);
  });

  test("declines over_spend_limit before any Stripe authorization", async () => {
    const { fake, issueCard, mintVisa, checkout } = harness();
    const { card_id } = await issueCard({ budget: { spend: { amount: 10, seconds: 86400 } } }); // $0.10/day
    const link = await mintVisa(card_id);
    const visa = fake.panFor(link.last4!)!;

    const first = (await (await checkout("espresso", visa)).json()) as { approved: boolean };
    const second = (await (await checkout("espresso", visa)).json()) as { approved: boolean };
    expect(first.approved).toBe(true); // 5 of 10
    expect(second.approved).toBe(true); // exactly 10/10
    const third = (await (await checkout("stickers", visa)).json()) as { approved: boolean; reason: string };
    expect(third).toMatchObject({ approved: false, reason: "over_spend_limit" });
    // the refused purchase never reached Stripe
    expect(fake.auths).toHaveLength(2);
  });

  test("the shop is disabled (503) when Stripe is not configured", async () => {
    const deps: AppDeps = {
      store: new Store(":memory:"),
      datahub: null,
      stripe: null,
      adminToken: "test-admin-token",
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

describe("stripe webhook end-to-end", () => {
  test("approves in-budget, then declines the same card once it's spent", async () => {
    const { fake, issueCard, mintVisa, cardDetail } = harness();
    const { card_id } = await issueCard({ budget: { spend: { amount: 100, seconds: 86400 } } });
    const link = await mintVisa(card_id);
    const icId = fake.icIdFor(card_id)!;

    const approve = await fake.fireWebhook(authEvent("iauth_test_e2e_1", icId, 60));
    expect(approve).toEqual({ approved: true });
    const decline = await fake.fireWebhook(authEvent("iauth_test_e2e_2", icId, 60)); // 60 + 60 > 100
    expect(decline).toEqual({ approved: false });

    const detail = await cardDetail(card_id);
    expect(detail.access).toHaveLength(1); // only the approved authorization booked
    expect(detail.remaining_spend).toBe(40);
  });

  test("duplicate delivery answers duplicate_delivery without double-booking", async () => {
    const { fake, issueCard, mintVisa, cardDetail } = harness();
    const { card_id } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    const link = await mintVisa(card_id);
    const event = authEvent("iauth_test_dup", fake.icIdFor(card_id)!, 100);

    expect(await fake.fireWebhook(event)).toEqual({ approved: true });
    expect(await fake.fireWebhook(event)).toEqual({ approved: true }); // Stripe retried

    const detail = await cardDetail(card_id);
    expect(detail.access).toHaveLength(1);
    expect(detail.remaining_spend).toBe(400); // spent once, never twice
  });

  test("rejects a bad signature with 400", async () => {
    const { app } = harness();
    const body = JSON.stringify(authEvent("iauth_test_bad", "ic_test_x", 50));
    const res = await app.request("/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signStripeWebhook("whsec_wrong", body) },
      body,
    });
    expect(res.status).toBe(400);
  });

  test("declines an unknown card with no_card_mapping", async () => {
    const { fake } = harness();
    const decision = await fake.fireWebhook(authEvent("iauth_test_unknown", "ic_test_nope", 50));
    expect(decision).toEqual({ approved: false });
  });

  test("a stale timestamp is rejected (tolerance window)", async () => {
    const { app } = harness();
    const body = JSON.stringify(authEvent("iauth_test_old", "ic_test_x", 50));
    const t = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes old
    const sig = await signStripeWebhookAt("whsec_integration_test", body, t);
    const res = await app.request("/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
      body,
    });
    expect(res.status).toBe(400);
  });
});

// the WebCrypto-based verify uses the timestamp inside the header; the test fake
// signs at a chosen timestamp so the tolerance window is actually exercised
async function signStripeWebhookAt(secret: string, body: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}
