// Mock Stripe Issuing API — the "simulated rail" for local demos.
//
// Real Stripe test mode needs a STRIPE_SECRET_KEY; this mock implements the tiny
// Issuing subset the server's StripeClient uses, so the WHOLE payment lane runs
// with no external account: mint a test Visa, check out at the demo shop, and the
// real-time authorization webhook fires with a genuine HMAC signature and the
// server's 2s decision is honored — exactly like Stripe's test helper.
//
// Point the server at it with:
//   STRIPE_SECRET_KEY=<your_test_secret_key>
//   STRIPE_BASE_URL=http://localhost:4020
//   STRIPE_WEBHOOK_SECRET=<your_webhook_secret>
//
// Env for the mock itself:
//   MOCK_STRIPE_PORT        default 4020
//   STRIPE_WEBHOOK_SECRET   webhook signing secret (unset = webhook disabled; the
//                           lane then approves every test authorization locally)
//   MOCK_STRIPE_WEBHOOK_URL where to POST issuing_authorization.request events
//                           (default http://localhost:4070/stripe/webhook)
//
// Run: bun scripts/mock-stripe.ts

import { createHmac, randomBytes } from "node:crypto";

const PORT = Number(process.env.MOCK_STRIPE_PORT ?? 4020);
const WEBHOOK_URL = process.env.MOCK_STRIPE_WEBHOOK_URL ?? "http://localhost:4070/stripe/webhook";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const WEBHOOK_TIMEOUT_MS = 2500; // Stripe's own real-time window

type MockCard = {
  id: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  brand: string;
  status: string;
  number: string;
  cvc: string;
  cardholder: { id: string; name: string };
  metadata: Record<string, string>;
};

const cardholder = { id: "ich_test_0000000000000000", name: "DataCards Demo" };
const cards = new Map<string, MockCard>();
const auths = new Map<string, { approved: boolean; amount: number; currency: string; merchant: string }>();

const randomId = (prefix: string): string => `${prefix}_test_${randomBytes(8).toString("hex")}`;

// Visa check digit so the PAN is a valid test number (the shop/issuing paths don't
// care, but a real-looking card keeps the demo honest).
function luhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

function mintCard(metadata: Record<string, string>): MockCard {
  const partial = `424242${Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join("")}`;
  const number = `${partial}${luhnCheckDigit(partial)}`;
  const exp = new Date();
  return {
    id: randomId("ic"),
    last4: number.slice(-4),
    exp_month: exp.getMonth() + 1,
    exp_year: exp.getFullYear() + 2,
    brand: "visa",
    status: "active",
    number,
    cvc: String(Math.floor(100 + Math.random() * 900)),
    cardholder,
    metadata,
  };
}

/** Public card view; PAN/CVC only when the caller expands them (like real Stripe). */
function cardView(card: MockCard, expand: Set<string>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: card.id,
    last4: card.last4,
    exp_month: card.exp_month,
    exp_year: card.exp_year,
    brand: card.brand,
    status: card.status,
    cardholder: card.cardholder,
    metadata: card.metadata,
  };
  if (expand.has("number")) base.number = card.number;
  if (expand.has("cvc")) base.cvc = card.cvc;
  return base;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function signWebhook(secret: string, body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

/** Fire the real-time authorization webhook and await the server's 2s decision.
 * On timeout/error the mock defaults to APPROVE (real Stripe's fallback when the
 * platform's sync response is lost). */
async function requestWebhookDecision(authId: string, cardId: string, amount: number, currency: string, merchant: string): Promise<boolean> {
  if (!WEBHOOK_SECRET) {
    console.log(`[mock-stripe] webhook disabled — auto-approving ${authId}`);
    return true;
  }
  const event = {
    type: "issuing_authorization.request",
    data: {
      object: {
        id: authId,
        amount,
        currency,
        pending_request: { amount, currency },
        card: { id: cardId },
        merchant_data: { name: merchant },
      },
    },
  };
  const body = JSON.stringify(event);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signWebhook(WEBHOOK_SECRET, body),
        "stripe-version": "2025-03-31.basil",
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const decision = (await res.json()) as { approved?: boolean };
    console.log(`[mock-stripe] ${authId} card=${cardId} $${(amount / 100).toFixed(2)} -> webhook ${res.status} approved=${decision.approved}`);
    return decision.approved === true;
  } catch (e) {
    console.warn(`[mock-stripe] webhook to ${WEBHOOK_URL} failed (${e instanceof Error ? e.message : e}) — defaulting to APPROVE`);
    return true;
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;
    const key = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!/^(sk|rk)_test_/.test(key)) return json({ error: { message: "invalid or missing secret key (test-mode keys only)" } }, 401);

    // ---- cardholders ----
    if (method === "GET" && path === "/v1/issuing/cardholders") {
      return json({ data: [cardholder], has_more: false });
    }

    // ---- cards ----
    if (method === "GET" && path === "/v1/issuing/cards") {
      const list = [...cards.values()].filter((c) => c.status === "active").map((c) => cardView(c, new Set()));
      return json({ data: list, has_more: false });
    }

    const cardMatch = path.match(/^\/v1\/issuing\/cards\/([^/]+)$/);
    if (method === "GET" && cardMatch) {
      const card = cards.get(cardMatch[1]!);
      if (!card) return json({ error: { message: `No such issuing card: ${cardMatch[1]}` } }, 404);
      const expand = new Set(url.searchParams.getAll("expand[]"));
      return json(cardView(card, expand));
    }

    if (method === "POST" && path === "/v1/issuing/cards") {
      const form = await req.formData();
      const card = mintCard({
        ...(form.get("metadata[dc_card_id]") ? { dc_card_id: String(form.get("metadata[dc_card_id]")) } : {}),
      });
      cards.set(card.id, card);
      console.log(`[mock-stripe] minted ${card.id} last4=${card.last4} dc_card_id=${card.metadata.dc_card_id ?? "-"}`);
      return json(cardView(card, new Set(["number", "cvc"])));
    }

    // ---- test helpers ----
    if (method === "POST" && path === "/v1/test_helpers/issuing/fund_balance") {
      return json({ balance: { available: [{ amount: 1_000_000, currency: "usd" }] } });
    }

    if (method === "POST" && path === "/v1/test_helpers/issuing/authorizations") {
      const form = await req.formData();
      const cardId = String(form.get("card") ?? "");
      const amount = Number(form.get("amount") ?? 0);
      const currency = String(form.get("currency") ?? "usd");
      const merchant = String(form.get("merchant_data[name]") ?? "s0nder supply co.");
      const card = cards.get(cardId);
      if (!card) return json({ error: { message: `No such issuing card: ${cardId}` } }, 404);
      if (!Number.isInteger(amount) || amount < 1) return json({ error: { message: "invalid amount" } }, 400);

      const id = randomId("iauth");
      const approved = await requestWebhookDecision(id, cardId, amount, currency, merchant);
      auths.set(id, { approved, amount, currency, merchant });
      return json({
        id,
        approved,
        status: approved ? "approved" : "declined",
        amount,
        currency,
        request_history: [{ reason: approved ? null : "webhook_declined" }],
      });
    }

    return json({ error: { message: `Not Found: ${method} ${path}` } }, 404);
  },
});

console.log(`[mock-stripe] Issuing (test-mode) mock listening on :${PORT}`);
if (WEBHOOK_SECRET) console.log(`[mock-stripe] webhooks -> ${WEBHOOK_URL} (signed, ${WEBHOOK_TIMEOUT_MS}ms window)`);
