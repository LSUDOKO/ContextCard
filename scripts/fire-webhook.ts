// Fire a SIGNED issuing_authorization.request webhook event at the server — used to
// demo the real-time 2s decision lane without Stripe (e.g. a decline when the card's
// spend budget is exhausted). The server resolves the DataCards card from the
// fiat_links mapping by the Issuing card id.
//
// Usage:
//   bun scripts/fire-webhook.ts <stripe-card-id> <amount-cents> [merchant]
//   bun scripts/fire-webhook.ts ic_test_abcdef1234 90 "demo merchant"
//
// Env: STRIPE_WEBHOOK_SECRET (required — must match the server's),
//      DATACARDS_BASE (default http://localhost:4070)

import { createHmac } from "node:crypto";

const [stripeCardId, amountRaw, merchant] = process.argv.slice(2);
if (!stripeCardId || !amountRaw) {
  console.error("usage: bun scripts/fire-webhook.ts <stripe-card-id> <amount-cents> [merchant]");
  process.exit(2);
}
const secret = process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error("STRIPE_WEBHOOK_SECRET is required (must match the server's)");
  process.exit(2);
}
const amount = Number(amountRaw);
if (!Number.isInteger(amount) || amount < 1) {
  console.error("amount-cents must be a positive integer");
  process.exit(2);
}
const base = process.env.DATACARDS_BASE ?? "http://localhost:4070";

const authId = `iauth_test_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const event = {
  type: "issuing_authorization.request",
  data: {
    object: {
      id: authId,
      amount,
      currency: "usd",
      pending_request: { amount, currency: "usd" },
      card: { id: stripeCardId },
      merchant_data: { name: merchant ?? "demo merchant" },
    },
  },
};
const body = JSON.stringify(event);
const t = Math.floor(Date.now() / 1000);
const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

const res = await fetch(`${base}/stripe/webhook`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "stripe-signature": `t=${t},v1=${sig}`,
    "stripe-version": "2025-03-31.basil",
  },
  body,
});
const decision = (await res.json()) as { approved?: boolean };
console.log(`webhook ${res.status}: ${JSON.stringify(decision)}  (auth=${authId} card=${stripeCardId} $${(amount / 100).toFixed(2)})`);
process.exit(res.ok ? 0 : 1);
