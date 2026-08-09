// Test double for the Stripe Issuing (test-mode) API surface the server's
// StripeClient talks to. Injected through the client's fetchFn seam — no network,
// no ports. Mirrors scripts/mock-stripe.ts (the demo mock), but webhooks are fired
// through an injectable callback so tests drive the real /stripe/webhook handler
// in-process (signed, exactly like the live rail).

import { createHmac, randomBytes } from "node:crypto";

export type WebhookEvent = {
  type: string;
  data: { object: Record<string, unknown> };
};

type FakeCard = {
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

const randomId = (prefix: string): string => `${prefix}_test_${randomBytes(8).toString("hex")}`;

/** Visa check digit so minted PANs are structurally valid. */
export function luhnCheckDigit(digits: string): number {
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

/** HMAC signature the way Stripe signs webhooks (t=...,v1=...) — matches the
 * server's verifyStripeSignature (WebCrypto SHA-256). */
export function signStripeWebhook(secret: string, body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

export class FakeStripe {
  cards = new Map<string, FakeCard>();
  cardholder = { id: "ich_test_0000000000000000", name: "Integration Test" };
  webhookSecret = "whsec_integration_test";
  /** every authorization the server asked the fake to create */
  auths: Array<{ id: string; cardId: string; amount: number; currency: string; merchant: string; approved: boolean }> = [];
  /** every webhook event the fake fired (assert the rail really fired) */
  webhookFired: Array<{ id: string; cardId: string; amount: number }> = [];
  /** tests wire this to the app's /stripe/webhook; returns the server's decision */
  fireWebhook: (event: WebhookEvent) => Promise<{ approved: boolean }> = async () => ({ approved: true });

  // ---- seeding / introspection helpers (test-side) ----

  mint(dcCardId: string): FakeCard {
    const partial = `424242${Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join("")}`;
    const number = `${partial}${luhnCheckDigit(partial)}`;
    const exp = new Date();
    const card: FakeCard = {
      id: randomId("ic"),
      last4: number.slice(-4),
      exp_month: exp.getMonth() + 1,
      exp_year: exp.getFullYear() + 2,
      brand: "visa",
      status: "active",
      number,
      cvc: String(Math.floor(100 + Math.random() * 900)),
      cardholder: this.cardholder,
      metadata: dcCardId ? { dc_card_id: dcCardId } : {},
    };
    this.cards.set(card.id, card);
    return card;
  }

  panFor(last4: string): { number: string; cvc: string; exp_month: number; exp_year: number } | null {
    const card = [...this.cards.values()].find((c) => c.last4 === last4);
    if (!card) return null;
    return { number: card.number, cvc: card.cvc, exp_month: card.exp_month, exp_year: card.exp_year };
  }

  icIdFor(dcCardId: string): string | null {
    return [...this.cards.values()].find((c) => c.metadata.dc_card_id === dcCardId)?.id ?? null;
  }

  // ---- the fetchFn StripeClient uses ----

  fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const key = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    if (!/^(sk|rk)_test_/.test(key)) {
      return json({ error: { message: "invalid or missing secret key (test-mode keys only)" } }, 401);
    }

    if (method === "GET" && u.pathname === "/v1/issuing/cardholders") {
      return json({ data: [this.cardholder], has_more: false });
    }

    if (method === "GET" && u.pathname === "/v1/issuing/cards") {
      const list = [...this.cards.values()]
        .filter((c) => c.status === "active")
        .map((c) => view(c, new Set()));
      return json({ data: list, has_more: false });
    }

    const cardMatch = u.pathname.match(/^\/v1\/issuing\/cards\/([^/]+)$/);
    if (method === "GET" && cardMatch) {
      const card = this.cards.get(cardMatch[1]!);
      if (!card) return json({ error: { message: `No such issuing card: ${cardMatch[1]}` } }, 404);
      return json(view(card, new Set(u.searchParams.getAll("expand[]"))));
    }

    if (method === "POST" && u.pathname === "/v1/issuing/cards") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const card = this.mint(String(form.get("metadata[dc_card_id]") ?? ""));
      return json(view(card, new Set(["number", "cvc"])));
    }

    if (method === "POST" && u.pathname === "/v1/test_helpers/issuing/fund_balance") {
      return json({ balance: { available: [{ amount: 1_000_000, currency: "usd" }] } });
    }

    if (method === "POST" && u.pathname === "/v1/test_helpers/issuing/authorizations") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const cardId = String(form.get("card") ?? "");
      const amount = Number(form.get("amount") ?? 0);
      const currency = String(form.get("currency") ?? "usd");
      const merchant = String(form.get("merchant_data[name]") ?? "s0nder supply co.");
      const card = this.cards.get(cardId);
      if (!card) return json({ error: { message: `No such issuing card: ${cardId}` } }, 404);
      if (!Number.isInteger(amount) || amount < 1) return json({ error: { message: "invalid amount" } }, 400);

      const id = randomId("iauth");
      // the fake awaits the server's real-time decision, like Stripe's test helper
      const decision = await this.fireWebhook({
        type: "issuing_authorization.request",
        data: {
          object: {
            id,
            amount,
            currency,
            pending_request: { amount, currency },
            card: { id: cardId },
            merchant_data: { name: merchant },
          },
        },
      });
      this.auths.push({ id, cardId, amount, currency, merchant, approved: decision.approved });
      this.webhookFired.push({ id, cardId, amount });
      return json({
        id,
        approved: decision.approved,
        status: decision.approved ? "approved" : "declined",
        amount,
        currency,
        request_history: [{ reason: decision.approved ? null : "webhook_declined" }],
      });
    }

    return json({ error: { message: `Not Found: ${method} ${u.pathname}` } }, 404);
  };
}

function view(card: FakeCard, expand: Set<string>): Record<string, unknown> {
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
