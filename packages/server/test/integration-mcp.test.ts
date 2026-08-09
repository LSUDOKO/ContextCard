// MCP integration tests over the real Streamable HTTP lane (/c/<secret>/mcp,
// initialize -> initialized -> tools/call) with a fake Stripe + a fake DataHub:
//   query_data — scope gating, PII governance (pii_blocked), row-limit enforcement,
//                and the Agent-Accessed tag write-back
//   fiat_pay   — spend-budget approvals, over_spend_limit refusals, honoring a
//                mid-flight webhook decline, and the absent-tool surface

process.env.STRIPE_WEBHOOK_SECRET = "whsec_integration_test";
process.env.DATACARDS_SHOP_RATE_LIMIT = "10000";

import { describe, expect, test } from "bun:test";
import { KeyedMutex, Store, type DataHubClient } from "@datacards/engine";
import { createApp } from "../src/app";
import { StripeClient } from "../src/stripe/client";
import { recordFiatDecision } from "../src/stripe/decisions";
import type { AppDeps } from "../src/deps";
import { FakeStripe, signStripeWebhook } from "./helpers/fake-stripe";
import { FakeDataHub, meta } from "./helpers/fake-datahub";

const ORDERS = "urn:li:dataset:(urn:li:dataPlatform:snowflake,orders,PROD)";
const CUSTOMERS = "urn:li:dataset:(urn:li:dataPlatform:snowflake,customers,PROD)";

const ORDERS_META = meta({
  urn: ORDERS,
  name: "orders",
  schemaFields: [
    { fieldPath: "order_id", type: "string", description: "primary key", nullable: false },
    { fieldPath: "amount", type: "double", description: null, nullable: false },
    { fieldPath: "region", type: "string", description: null, nullable: true },
  ],
});
const CUSTOMERS_META = meta({
  urn: CUSTOMERS,
  name: "customers",
  glossaryTermUrns: ["urn:li:glossaryTerm:PersonallyIdentifiableInformation"],
  tags: ["PII"],
  schemaFields: [{ fieldPath: "email", type: "string", description: null, nullable: false }],
});

type McpOutcome = {
  isError: boolean;
  data: { code?: string; message?: string; status?: string; approved?: boolean; remaining_spend?: number } & Record<string, unknown>;
  envelope: { error?: { message?: string } } | null;
};

function harness() {
  const store = new Store(":memory:");
  const fake = new FakeStripe();
  const hub = new FakeDataHub().set(ORDERS_META).set(CUSTOMERS_META);
  const deps: AppDeps = {
    store,
    datahub: hub as unknown as DataHubClient,
    stripe: new StripeClient("sk_test_integration0000000000000000", fake.fetchFn),
    adminToken: "test-admin-token",
    mutex: new KeyedMutex(),
  };
  const app = createApp(deps);
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

  const issueCard = async (terms: Record<string, unknown>) => {
    const res = await app.request(
      "/api/cards",
      admin({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "test", terms }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { card_id: string; card_url: string };
    const secret = body.card_url.match(/\/c\/([^/]+)\/mcp$/)?.[1];
    expect(secret).toBeTruthy();
    return { card_id: body.card_id, secret: secret! };
  };

  const mintVisa = async (cardId: string) => {
    const res = await app.request(`/api/cards/${cardId}/fiat`, admin());
    return (await res.json()) as { linked: boolean; last4?: string };
  };

  // the SDK requires initialize to be the sole message in its request; the server's
  // per-card lane is stateless, so each POST stands alone (session mgmt disabled)
  const mcp = async (secret: string, tool: string, args: Record<string, unknown>): Promise<McpOutcome> => {
    const url = `/c/${secret}/mcp`;
    const post = (body: unknown) =>
      app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      });
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "integration-test", version: "1" } },
    });
    expect(init.status).toBe(200);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    expect(call.status).toBe(200);
    const text = await call.text();
    // the transport streams SSE when the Accept allows it — parse both shapes
    let envelopes: Array<{ id?: number; result?: unknown; error?: { message?: string } }>;
    if ((call.headers.get("content-type") ?? "").includes("text/event-stream")) {
      envelopes = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()) as { id?: number; result?: unknown; error?: { message?: string } });
    } else {
      const parsed = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
      envelopes = Array.isArray(parsed) ? parsed : [parsed];
    }
    const envelope = envelopes.find((e) => e.id === 2) ?? null;
    if (!envelope) throw new Error(`no tools/call envelope in: ${text}`);
    if (envelope.error) return { isError: true, data: {}, envelope };
    const result = envelope.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    // tool results carry JSON, but SDK-level errors (unknown tool, bad schema) are
    // plain-text with isError: true — surface the raw text when JSON.parse fails
    const firstText = result?.content?.find((c) => c.type === "text")?.text ?? "";
    let data: McpOutcome["data"] = {};
    try {
      data = JSON.parse(firstText) as McpOutcome["data"];
    } catch {
      data = { message: firstText } as McpOutcome["data"];
    }
    return { isError: result?.isError ?? false, data, envelope };
  };

  return { store, fake, hub, app, issueCard, mintVisa, mcp };
}

describe("MCP query_data", () => {
  test("previews an in-scope dataset, writes Agent-Accessed, debits one call", async () => {
    const { store, hub, issueCard, mcp } = harness();
    const { card_id, secret } = await issueCard({
      budget: { period: { amount: 100, seconds: 86400 } },
      scope: { entities: [ORDERS], entityTypes: ["DATASET"] },
      maxRows: 100,
    });

    const out = await mcp(secret, "query_data", { urn: ORDERS, sql: "SELECT * FROM orders LIMIT 50" });
    expect(out.isError).toBe(false);
    expect(out.data.status).toBe("preview");
    expect(out.data.row_cap).toBe(100);
    expect(out.data.limit_used).toBe(50);
    expect((out.data.columns as unknown[]).length).toBe(3);
    // the tag write-back hit the catalog
    expect(hub.tagWrites).toContainEqual({ urn: ORDERS, tag: "urn:li:tag:Agent-Accessed" });
    // the ledger debited exactly one call
    const charges = store.listCharges(card_id, 10);
    expect(charges[0]).toMatchObject({ kind: "query_data", units: 1, status: "ok", to_urn: ORDERS });
  });

  test("refuses a PII-classified dataset with pii_blocked (no tag, no debit)", async () => {
    const { store, hub, issueCard, mcp } = harness();
    const { card_id, secret } = await issueCard({
      budget: { period: { amount: 100, seconds: 86400 } },
      scope: { entities: [CUSTOMERS] },
      maxRows: 100,
    });

    const out = await mcp(secret, "query_data", { urn: CUSTOMERS, sql: "SELECT * FROM customers LIMIT 10" });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe("pii_blocked");
    expect(hub.tagWrites).toHaveLength(0);
    expect(store.listCharges(card_id, 10)).toHaveLength(0); // refusals never debit
  });

  test("enforces maxRows: missing LIMIT and oversized LIMIT are refused", async () => {
    const { issueCard, mcp } = harness();
    const { secret } = await issueCard({
      budget: { period: { amount: 100, seconds: 86400 } },
      scope: { entities: [ORDERS] },
      maxRows: 10,
    });

    const noLimit = await mcp(secret, "query_data", { urn: ORDERS, sql: "SELECT * FROM orders" });
    expect(noLimit.isError).toBe(true);
    expect(noLimit.data.code).toBe("row_limit_exceeded");

    const tooBig = await mcp(secret, "query_data", { urn: ORDERS, sql: "SELECT * FROM orders LIMIT 500" });
    expect(tooBig.isError).toBe(true);
    expect(tooBig.data.code).toBe("row_limit_exceeded");

    const ok = await mcp(secret, "query_data", { urn: ORDERS, sql: "SELECT * FROM orders LIMIT 10" });
    expect(ok.isError).toBe(false);
  });

  test("refuses entities outside the card's scope with entity_not_allowed", async () => {
    const { issueCard, mcp } = harness();
    const { secret } = await issueCard({
      budget: { period: { amount: 100, seconds: 86400 } },
      scope: { entities: [ORDERS] },
    });

    const out = await mcp(secret, "query_data", { urn: CUSTOMERS, sql: "SELECT 1 LIMIT 1" });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe("entity_not_allowed");
  });
});

describe("MCP fiat_pay", () => {
  test("approves within the spend budget and books the charge once", async () => {
    const { store, fake, issueCard, mcp } = harness();
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });

    const out = await mcp(secret, "fiat_pay", { amount: 4.9 });
    expect(out.isError).toBe(false);
    expect(out.data.approved).toBe(true);
    expect(out.data.remaining_spend).toBe(10); // $5.00 - $4.90
    expect(fake.webhookFired).toHaveLength(1); // the rail fired and the webhook decided

    // the webhook books first (its "fiat" row carries the spend); fiat_pay's record
    // replays and books a spend-free tool-call row — spend counted once, calls once
    const charges = store.listCharges(card_id, 10);
    const webhookRow = charges.find((c) => c.kind === "fiat");
    const callRow = charges.find((c) => c.kind === "fiat_pay");
    expect(webhookRow).toMatchObject({ units: 0, spend_usd_cents: 490, status: "ok" });
    expect(callRow).toMatchObject({ units: 1, spend_usd_cents: null, status: "ok" });
    expect(store.subtreeSpendSince(card_id, 0)).toBe(490);
    expect(store.subtreeUnitsSince(card_id, 0)).toBe(1);
  });

  test("books first when the webhook delivery is slow; the later delivery dedupes", async () => {
    // Stripe usually delivers the webhook BEFORE the in-process caller books, but a
    // slow delivery must not double-book either: fiat_pay books the spend row itself
    // (the !replayed branch), then the late webhook answers duplicate_delivery
    const { store, fake, app, issueCard, mcp } = harness();
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    let lateWebhook: { approved: boolean } | null = null;
    fake.fireWebhook = async (event) => {
      const body = JSON.stringify(event);
      setTimeout(() => {
        app.request("/stripe/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": signStripeWebhook(fake.webhookSecret, body) },
          body,
        })
          .then((r) => r.json() as Promise<{ approved: boolean }>)
          .then((j) => {
            lateWebhook = j;
          })
          .catch(() => {});
      }, 0);
      return { approved: true };
    };

    const out = await mcp(secret, "fiat_pay", { amount: 4.9 });
    expect(out.isError).toBe(false);
    // fiat_pay booked the spend row itself — no webhook row yet
    const charges = store.listCharges(card_id, 10);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ kind: "fiat_pay", units: 1, spend_usd_cents: 490, status: "ok" });
    expect(store.subtreeSpendSince(card_id, 0)).toBe(490);
    expect(store.subtreeUnitsSince(card_id, 0)).toBe(1);

    // let the delayed webhook delivery land — it must approve (duplicate_delivery)
    // and never double-book
    await Bun.sleep(25);
    expect(lateWebhook).toEqual({ approved: true });
    expect(store.listCharges(card_id, 10)).toHaveLength(1);
    expect(store.subtreeSpendSince(card_id, 0)).toBe(490);
  });

  test("refuses over the spend cap with over_spend_limit before touching Stripe", async () => {
    const { fake, issueCard, mcp } = harness();
    const { secret } = await issueCard({ budget: { spend: { amount: 100, seconds: 86400 } } });

    const out = await mcp(secret, "fiat_pay", { amount: 1.01 }); // 101 cents > 100
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe("over_spend_limit");
    expect(fake.auths).toHaveLength(0);
  });

  test("honors a mid-flight webhook decline", async () => {
    const { store, fake, issueCard, mcp } = harness();
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    // simulate the webhook having DECLINED this authorization during the round-trip
    // (e.g. Stripe-side cardholder insufficient funds), while the local budget passed
    fake.fireWebhook = async (event) => {
      const id = (event.data.object as { id: string }).id;
      recordFiatDecision(id, { approved: false, reason: "card_holder_insufficient_funds", cardId: card_id });
      return { approved: false };
    };

    const out = await mcp(secret, "fiat_pay", { amount: 1.0 });
    expect(out.isError).toBe(true);
    expect(out.data.message).toContain("declined");
    expect(store.listCharges(card_id, 10)).toHaveLength(0); // nothing booked
  });

  test("payment tools are absent from a no-spend card's surface", async () => {
    const { issueCard, mcp } = harness();
    const { secret } = await issueCard({ budget: { period: { amount: 100, seconds: 86400 } } });

    // the tool list IS the permission surface: fiat_pay doesn't exist for this card
    const out = await mcp(secret, "fiat_pay", { amount: 1.0 });
    expect(out.isError).toBe(true);
    const message = out.envelope?.error?.message ?? out.data.message ?? "";
    expect(message).toContain("fiat_pay");
  });

  test("card_credentials reveals the linked Visa", async () => {
    const { fake, issueCard, mintVisa, mcp } = harness();
    const { card_id, secret } = await issueCard({ budget: { spend: { amount: 500, seconds: 86400 } } });
    const link = await mintVisa(card_id);
    expect(link.linked).toBe(true);

    const out = await mcp(secret, "card_credentials", {});
    expect(out.isError).toBe(false);
    expect(out.data.card_number).toBe(fake.panFor(link.last4!)!.number);
    expect(out.data.last4).toBe(link.last4);
  });
});
