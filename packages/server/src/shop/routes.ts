// Demo merchant: "s0nder supply co.", a generic web shop that happens to accept the
// test-mode Visa a card carries. Checkout matches the entered card against the linked
// Issuing cards (cheap last4+expiry key, then constant-time full compare) and — only
// after the card's OWN spend budget approves — fires a REAL Stripe test-mode
// authorization, so the webhook (when configured) re-checks the same budget like any
// other charge. No on-chain leg: Stripe test mode settles the purchase itself.
//
// Secret hygiene: the entered PAN never leaves the handler. Not logged, not echoed;
// responses carry last4 at most.
//
// Concurrency: the whole validate -> authorize -> book section runs under the card
// tree's mutex (the same serialization every MCP tool uses), so two concurrent
// checkouts can never both pass the spend check.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createHash, timingSafeEqual } from "node:crypto";
import { authorizeSpend, cardTreeKey, fiatSpentTotal, type Store } from "@datacards/engine";
import { envInt, type AppDeps } from "../deps";
import { RateLimiter, clientIp } from "../ratelimit";
import { recordFiatDecision, recentFiatDecision } from "../stripe/decisions";
import { SHOP_MERCHANT, SHOP_PRODUCTS } from "./catalog";

/** Constant-time string equality (hash both sides so length differences don't leak). */
const credentialsEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const dollars = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function shopRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  // the shop is public cross-origin (it lives on the dashboard origin, the server on
  // another port); checkout stays unauthenticated but rate-limited per IP
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));
  const checkoutLimit = new RateLimiter(envInt("DATACARDS_SHOP_RATE_LIMIT", 20), 60_000);

  app.get("/shop/products", (c) =>
    c.json({
      merchant: SHOP_MERCHANT,
      products: SHOP_PRODUCTS.map((p) => ({ id: p.id, name: p.name, price: dollars(p.priceCents) })),
    }),
  );

  app.post("/shop/checkout", async (c) => {
    if (!deps.stripe) return c.json({ error: "shop disabled (no test-mode STRIPE_SECRET_KEY)" }, 503);
    if (!checkoutLimit.allow(clientIp(c), Date.now())) return c.json({ error: "too many requests" }, 429);

    let body: {
      product_id?: unknown;
      card?: { number?: unknown; exp_month?: unknown; exp_year?: unknown; cvc?: unknown } | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "malformed body" }, 400);
    }
    const card = body.card;
    if (
      typeof body.product_id !== "string" ||
      !card ||
      typeof card !== "object" ||
      typeof card.number !== "string" ||
      (typeof card.exp_month !== "string" && typeof card.exp_month !== "number") ||
      (typeof card.exp_year !== "string" && typeof card.exp_year !== "number") ||
      typeof card.cvc !== "string"
    ) {
      return c.json({ error: "malformed body" }, 400);
    }
    const product = SHOP_PRODUCTS.find((p) => p.id === body.product_id);
    if (!product) return c.json({ error: "unknown product" }, 404);

    const number = card.number.replace(/[\s-]/g, ""); // digits only
    const expMonth = Number(card.exp_month);
    let expYear = Number(card.exp_year);
    if (!/^\d{12,19}$/.test(number) || !Number.isInteger(expMonth) || !Number.isInteger(expYear)) {
      return c.json({ error: "malformed card" }, 400);
    }
    if (expYear < 100) expYear += 2000; // accept 2-digit years

    // cheap-key match first (last4 + expiry from the non-revealed list), then reveal
    // ONLY the candidate(s): never one reveal call per active card per attempt
    const last4 = number.slice(-4);
    const candidates = (await deps.stripe.listActiveCardSummaries()).filter(
      (s) => s.last4 === last4 && Number(s.exp_month) === expMonth && Number(s.exp_year) === expYear,
    );
    let match: { cardId: string; last4: string } | null = null;
    for (const cand of candidates) {
      const det = await deps.stripe.getCardDetails(cand.id, { reveal: true });
      // constant-time over the full credential tuple: string === short-circuits on
      // the first differing byte, a (weak) timing oracle on matched-prefix length
      if (credentialsEqual(`${det.number}|${det.exp_month}|${det.exp_year}|${det.cvc}`, `${number}|${expMonth}|${expYear}|${card.cvc}`)) {
        match = { cardId: cand.id, last4: det.last4 };
        break;
      }
    }
    if (!match) return c.json({ approved: false, reason: "card_not_recognized" });

    // resolve the DataCards card behind the Visa; the whole spend path runs under the
    // card tree's mutex so concurrent purchases serialize (no double-spend window)
    const link = deps.store.getFiatLinkByStripeCardId(match.cardId);
    if (!link) return c.json({ approved: false, reason: "card_not_recognized" });
    const store: Store = deps.store;
    const nowS = Math.floor(Date.now() / 1000);

    const decision = await deps.mutex.run(cardTreeKey(store, link.card_id), async () => {
      const chain = store.ancestorChain(link.card_id);
      if (chain.length === 0) return { approved: false as const, reason: "unknown_card", remainingSpend: null as number | null, auth: null };
      let remainingSpend: number | null = null;
      try {
        remainingSpend = authorizeSpend(store, chain, nowS, product.priceCents).remainingSpend;
      } catch (e) {
        const reason = e instanceof Error && "code" in e && typeof (e as { code?: unknown }).code === "string"
          ? (e as { code: string }).code
          : "declined";
        return { approved: false as const, reason, remainingSpend: null, auth: null };
      }
      const auth = await deps.stripe!.createTestAuthorization({
        cardId: match!.cardId,
        amountCents: product.priceCents,
        merchantName: SHOP_MERCHANT,
      });
      // if the webhook fired during the round-trip and disagreed, honor its decline
      const webhook = recentFiatDecision(auth.id);
      if (webhook && !webhook.approved) {
        return { approved: false as const, reason: webhook.reason, remainingSpend, auth };
      }
      // book the charge once (idempotent on the Stripe authorization id — the
      // webhook's own delivery will find this row and answer duplicate_delivery)
      const existing = store.chargeByIdempotency(link.card_id, `stripe-${auth.id}`);
      if (!existing) {
        try {
          store.insertCharge({
            id: crypto.randomUUID(),
            card_id: link.card_id,
            idempotency_key: `stripe-${auth.id}`,
            kind: "checkout",
            to_urn: null,
            units: 0, // a browser purchase is not a tool call — it never consumes call budget
            spend_usd_cents: product.priceCents,
            status: "ok",
            memo: `shop · ${SHOP_MERCHANT} · ${product.name}`,
            created_at: nowS,
          });
          fiatSpentTotal.add(product.priceCents / 100);
        } catch (e) {
          if (!(e instanceof Error && /UNIQUE constraint failed/i.test(e.message))) throw e;
        }
      }
      recordFiatDecision(auth.id, { approved: true, reason: "in_budget", cardId: link.card_id });
      return { approved: true as const, reason: "approved", remainingSpend, auth };
    });

    if (!decision.approved) {
      return c.json({ approved: false, reason: decision.reason, last4: match.last4 });
    }
    return c.json({
      approved: true,
      reason: "approved",
      authorization_id: decision.auth!.id,
      product: { id: product.id, name: product.name, price: dollars(product.priceCents) },
      last4: match.last4,
      remaining_spend: decision.remainingSpend,
    });
  });

  return app;
}
