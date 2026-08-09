// Stripe test-mode lane: signature verification + the local-only 2s authorization
// decision (the pieces that must never call DataHub or hit the network).

import { describe, expect, test } from "bun:test";
import { Store } from "@datacards/engine";
import { issueRootCard, issueSubCard } from "@datacards/engine";
import { decideAuthorization, verifyStripeSignature } from "../src/stripe/routes";

const NOW = Math.floor(Date.now() / 1000);

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifyStripeSignature", () => {
  test("accepts a valid signature", async () => {
    const body = '{"type":"issuing_authorization.request"}';
    const t = Math.floor(Date.now() / 1000);
    const v1 = await hmacHex("whsec_test", `${t}.${body}`);
    expect(await verifyStripeSignature(body, `t=${t},v1=${v1}`, "whsec_test", t)).toBe(true);
  });

  test("rejects a wrong secret, a stale timestamp, and a missing header", async () => {
    const body = "{}";
    const t = Math.floor(Date.now() / 1000);
    const v1 = await hmacHex("whsec_test", `${t}.${body}`);
    expect(await verifyStripeSignature(body, `t=${t},v1=${v1}`, "whsec_wrong", t)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${t - 1000},v1=${v1}`, "whsec_test", t)).toBe(false);
    expect(await verifyStripeSignature(body, undefined, "whsec_test", t)).toBe(false);
  });
});

describe("decideAuthorization (local-only)", () => {
  test("approves within the spend window", () => {
    const store = new Store(":memory:");
    const root = issueRootCard(store, {
      userId: "steward",
      name: "root",
      terms: { budget: { spend: { amount: 2000, seconds: 86400 } } },
    });
    const d = decideAuthorization(store, root.cardId, 400, NOW);
    expect(d.approved).toBe(true);
    expect(d.reason).toBe("in_budget");
  });

  test("refuses over_spend_limit from the local snapshot", () => {
    const store = new Store(":memory:");
    const root = issueRootCard(store, {
      userId: "steward",
      name: "root",
      terms: { budget: { spend: { amount: 500, seconds: 86400 } } },
    });
    const d = decideAuthorization(store, root.cardId, 501, NOW);
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("over_spend_limit");
  });

  test("a sub-card purchase is judged against the whole ancestor chain", () => {
    const store = new Store(":memory:");
    const root = issueRootCard(store, {
      userId: "steward",
      name: "root",
      terms: { budget: { spend: { amount: 1000, seconds: 86400 } } },
    });
    const child = issueSubCard(store, { parentCardId: root.cardId, name: "child", terms: {} });
    // burn the parent's spend window through the child, then a fresh auth must refuse
    store.insertCharge({
      id: crypto.randomUUID(),
      card_id: child.cardId,
      idempotency_key: "stripe-seed",
      kind: "fiat_pay",
      to_urn: null,
      units: 1,
      spend_usd_cents: 900,
      status: "ok",
      memo: "visa",
      created_at: NOW,
    });
    const d = decideAuthorization(store, child.cardId, 200, NOW);
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("over_spend_limit");
  });

  test("unknown card refuses with unknown_card", () => {
    const store = new Store(":memory:");
    const d = decideAuthorization(store, "no-such-card", 100, NOW);
    expect(d.approved).toBe(false);
    expect(d.reason).toBe("unknown_card");
  });
});
