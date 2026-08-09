// Stripe Issuing real-time authorization webhook (test-mode Visa lane). The HARD
// constraint: synchronous {"approved": bool} within Stripe's 2-SECOND window,
// decided ENTIRELY from the local card snapshot — never a DataHub RPC in this
// handler. An approved authorization records a "fiat" charge (with spend_usd_cents)
// against the SAME budget the card's tool calls draw down: one card, data lane AND
// payment lane. No on-chain leg exists: Stripe test-mode settles itself.
//
// Mapping: the Issuing card carries metadata.dc_card_id -> the DataCards card id.
// The ledger write is idempotent on `stripe-<authorization_id>`; the in-process
// fiat_pay tool / shop checkout record the same row first, so a duplicate webhook
// delivery never double-books.
//
// Signature verification: stripe-signature header (t=...,v1=HMAC-SHA256(`${t}.${body}`))
// via WebCrypto; secret in STRIPE_WEBHOOK_SECRET.
//
// Concurrency: the decide -> book section is ENTIRELY synchronous (no await
// between decideAuthorization and insertCharge), so it is atomic on the JS thread
// — no mutex needed, and none is taken: a blocking lock behind a slow DataHub RPC
// on the same card tree could blow Stripe's 2s window. The in-process callers
// (fiat_pay, shop checkout) serialize under the card-tree mutex across their own
// awaits; the UNIQUE (card_id, idempotency_key) index resolves any cross-path
// race on the same authorization id.
//
// Residual risk (accepted): this handler's spend READ can be stale relative to a
// locked fiat_pay/shop checkout that has authorized but not yet booked (it holds
// the tree mutex across `await createTestAuthorization`), so two concurrent
// purchases could both pass the same window cap by up to one authorization.
// Blocking on the mutex would close that but risks the 2s window whenever the
// same tree is mid-DataHub-RPC; the UNIQUE index + duplicate_delivery still
// guarantee a given authorization is never booked twice.

import { trace } from "@opentelemetry/api";
import { Hono } from "hono";
import { authorizeSpend, fiatSpentTotal, type CardRow, type Store } from "@datacards/engine";
import type { AppDeps } from "../deps";
import { recordFiatDecision } from "./decisions";

const tracer = trace.getTracer("datacards-server");
const STRIPE_VERSION = "2025-03-31.basil";
const TOLERANCE_S = 300;

// ---------------------------------------------------------------------------
// signature verification (WebCrypto, no stripe SDK)
// ---------------------------------------------------------------------------

export async function verifyStripeSignature(
  body: string,
  header: string | undefined,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=", 2) as [string, string]),
  ) as Record<string, string>;
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const v1 = parts.v1;
  if (!v1) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${body}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// the 2s decision (local store only)
// ---------------------------------------------------------------------------

/** Decide a purchase against the card's WHOLE ancestor chain (leaf first, root
 * last), exactly like a tool call: every ancestor's freeze / expiry / spend window
 * binds. Pure local reads — safe inside Stripe's 2s window. */
export function decideAuthorization(
  store: Store,
  cardId: string,
  amountCents: number,
  nowS: number,
): { approved: boolean; reason: string; chain: CardRow[] | null } {
  const chain = store.ancestorChain(cardId);
  if (chain.length === 0) return { approved: false, reason: "unknown_card", chain: null };
  try {
    authorizeSpend(store, chain, nowS, amountCents);
    return { approved: true, reason: "in_budget", chain };
  } catch (e) {
    const reason = e instanceof Error && "code" in e && typeof (e as { code?: unknown }).code === "string"
      ? ((e as { code: string }).code)
      : "declined";
    return { approved: false, reason, chain };
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function stripeRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/stripe/webhook", async (c) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "webhook not configured" }, 503);
    const body = await c.req.text();
    if (!(await verifyStripeSignature(body, c.req.header("stripe-signature"), secret))) {
      return c.json({ error: "bad signature" }, 400);
    }

    let event: {
      type: string;
      data: {
        object: {
          id: string;
          amount?: number;
          currency?: string;
          pending_request?: { amount?: number; currency?: string } | null;
          card?: { id?: string } | null;
          merchant_data?: { name?: string | null } | null;
        };
      };
    };
    try {
      event = JSON.parse(body) as typeof event;
    } catch {
      return c.json({ error: "bad json" }, 400); // signed but malformed — never crash
    }

    if (event.type !== "issuing_authorization.request") {
      return c.json({ received: true }); // other events: ack only
    }

    return tracer.startActiveSpan("stripe_webhook_auth", async (span) => {
      const auth = event.data.object;
      const nowS = Math.floor(Date.now() / 1000);
      const stripeCardId = auth.card?.id;
      const link = stripeCardId ? deps.store.getFiatLinkByStripeCardId(stripeCardId) : null;
      const cardId = link?.card_id ?? null;
      const currency = auth.pending_request?.currency ?? auth.currency ?? "usd";
      const amountCentsRaw = auth.pending_request?.amount ?? auth.amount;
      const amountCents = amountCentsRaw ?? 0;

      span.setAttribute("stripe.charge_id", auth.id);
      span.setAttribute("card_id", cardId ?? "unknown");
      span.setAttribute("latency_critical", true);

      let approved = false;
      let reason = "no_card_mapping";
      if (currency !== "usd") {
        reason = "unsupported_currency";
      } else if (amountCentsRaw === undefined || !Number.isInteger(amountCentsRaw) || amountCentsRaw < 0) {
        reason = "invalid_amount";
      } else if (cardId && deps.store.chargeByIdempotency(cardId, `stripe-${auth.id}`)) {
        approved = true;
        reason = "duplicate_delivery"; // the in-process caller already booked this row
      } else if (cardId) {
        const decision = decideAuthorization(deps.store, cardId, amountCents, nowS);
        approved = decision.approved;
        reason = decision.reason;

        if (approved) {
          const merchant = auth.merchant_data?.name;
          const chargeId = crypto.randomUUID();
          try {
            deps.store.insertCharge({
              id: chargeId,
              card_id: cardId,
              idempotency_key: `stripe-${auth.id}`,
              kind: "fiat",
              to_urn: null,
              units: 0,
              spend_usd_cents: amountCents,
              status: "ok",
              memo: `visa · ${merchant ? `${merchant} · ` : ""}${auth.id}`,
              created_at: nowS,
            });
            fiatSpentTotal.add(amountCents / 100);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/UNIQUE constraint failed/i.test(msg)) {
              // raced with the in-process caller's identical row: already booked
            } else {
              approved = false;
              reason = "persist_failed";
              console.error(`[stripe] charge persist failed for ${auth.id}: ${msg}`);
            }
          }
        }
      }

      recordFiatDecision(auth.id, { approved, reason, cardId });
      console.log(`[stripe] issuing_authorization.request ${auth.id}: ${approved ? "APPROVE" : "DECLINE"} (${reason})`);
      c.header("Stripe-Version", STRIPE_VERSION);

      span.setAttribute("app.response.approved", approved);
      span.setAttribute("app.response.reason", reason);
      span.end();

      return c.json({ approved });
    });
  });

  return app;
}
