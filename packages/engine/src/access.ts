// The access pipeline: validate (typed refusals) -> gate (scope) -> record (ledger).
// The DataCards analog of GlassPay's spend.ts. Every tool call costs budget units
// against the whole ancestor chain; every scope dimension is enforced here AND
// mirrored into the upstream query (search filters / lineage degree caps).

import { RefusalError } from "./errors";
import { compilePolicy, entityTypeFromUrn, scopeAllows, scopeSearchFilters, type CardPolicy, type EntityFacts } from "./policy";
import { emitAccessLog, emitRefusalLog, queriesTotal } from "./telemetry";
import { periodWindow, type CardRow, type Store } from "./store";
import type { HubEntityMeta } from "./types";

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

export function assertCardSpendable(chain: CardRow[], now: number): void {
  for (const card of chain) {
    if (card.status === "frozen") {
      emitRefusalLog(card.id, "card_frozen", "0");
      throw new RefusalError("card_frozen", `card ${card.id === chain[0]!.id ? "" : "(ancestor) "}is frozen`, { card_id: card.id });
    }
    if (card.status === "revoked" || card.status === "nuked") {
      emitRefusalLog(card.id, "card_revoked", "0");
      throw new RefusalError("card_revoked", "card has been revoked", { card_id: card.id });
    }
    if (card.terms.expiry !== undefined && now >= card.terms.expiry) {
      emitRefusalLog(card.id, "card_expired", "0");
      throw new RefusalError("card_expired", "card has expired", { card_id: card.id, expired_at: card.terms.expiry });
    }
  }
}

// ---------------------------------------------------------------------------
// Budget validation (subtree-wide, fixed windows, every ancestor)
// ---------------------------------------------------------------------------

export type RemainingBudget = {
  remainingThisPeriod: number | null;
  remainingLifetime: number | null;
  periodResetsAt: number | null;
};

/** Validate units against every ancestor's budget; throws typed refusals. Also
 * returns the remaining budget after this charge (for receipts). */
export function validateBudget(store: Store, chain: CardRow[], now: number, units: number): RemainingBudget {
  if (!Number.isInteger(units) || units < 1) {
    throw new RefusalError("invalid_terms", "units must be a positive integer");
  }
  let remainingThisPeriod: number | null = null;
  let remainingLifetime: number | null = null;
  let periodResetsAt: number | null = null;
  for (const c of chain) {
    const p = c.policy;
    if (p.period) {
      const w = periodWindow(c.created_at, p.period.seconds, now);
      const used = store.subtreeUnitsSince(c.id, w.start);
      if (used + units > p.period.amount) {
        emitRefusalLog(c.id, "over_period_limit", String(units));
        throw new RefusalError(
          "over_period_limit",
          `this call exceeds the period budget (${used}/${p.period.amount} used)`,
          { card_id: c.id, remaining_this_period: Math.max(0, p.period.amount - used), period_resets_at: w.resetsAt },
        );
      }
      remainingThisPeriod = p.period.amount - (used + units);
      periodResetsAt = w.resetsAt;
    }
    if (p.lifetime !== null) {
      const used = store.subtreeUnitsLifetime(c.id);
      if (used + units > p.lifetime) {
        emitRefusalLog(c.id, "over_lifetime_limit", String(units));
        throw new RefusalError("over_lifetime_limit", `this call exceeds the card's lifetime budget (${used}/${p.lifetime} used)`, {
          card_id: c.id,
          remaining_lifetime: Math.max(0, p.lifetime - used),
        });
      }
      remainingLifetime = p.lifetime - (used + units);
    }
    if (p.maxUses !== null) {
      const used = store.subtreeUsesCount(c.id);
      if (used >= p.maxUses) {
        emitRefusalLog(c.id, "uses_exhausted", "0");
        throw new RefusalError("uses_exhausted", `card has used all ${p.maxUses} allowed calls`, { card_id: c.id });
      }
    }
  }
  return { remainingThisPeriod, remainingLifetime, periodResetsAt };
}

// ---------------------------------------------------------------------------
// Spend validation (the fiat lane: Stripe test-mode purchases against budget.spend)
// ---------------------------------------------------------------------------

/** Does the card's (or an ancestor's) spend window admit `cents`? Walks the whole
 * chain like validateBudget — a sub-card's purchase draws down every ancestor's
 * spend cap. Refuses over_spend_limit; a chain with NO spend budget refuses
 * no_spend_budget (a payment card needs budget.spend). */
export function validateSpend(
  store: Store,
  chain: CardRow[],
  now: number,
  cents: number,
): { remainingSpend: number | null; spendResetsAt: number | null } {
  if (!Number.isInteger(cents) || cents < 1) {
    throw new RefusalError("invalid_terms", "amount must be a positive integer (USD cents)");
  }
  let anySpend = false;
  let remainingSpend: number | null = null;
  let spendResetsAt: number | null = null;
  for (const c of chain) {
    const p = c.policy;
    if (!p.spend) continue;
    anySpend = true;
    const w = periodWindow(c.created_at, p.spend.seconds, now);
    const spent = store.subtreeSpendSince(c.id, w.start);
    if (spent + cents > p.spend.amount) {
      emitRefusalLog(c.id, "over_spend_limit", String(cents));
      throw new RefusalError(
        "over_spend_limit",
        `this purchase exceeds the card's spend budget ($${(spent / 100).toFixed(2)}/$${(p.spend.amount / 100).toFixed(2)} this window)`,
        { card_id: c.id, remaining_spend: Math.max(0, p.spend.amount - spent), spend_resets_at: w.resetsAt },
      );
    }
    remainingSpend = p.spend.amount - (spent + cents);
    spendResetsAt = w.resetsAt;
  }
  if (!anySpend) {
    emitRefusalLog(chain[0]?.id ?? "", "no_spend_budget", String(cents));
    throw new RefusalError("no_spend_budget", "this card has no spend budget (budget.spend) — the payment lane is not enabled", {});
  }
  return { remainingSpend, spendResetsAt };
}

/** One-stop fiat authorization: liveness + spend budget for a purchase. */
export function authorizeSpend(store: Store, chain: CardRow[], now: number, cents: number) {
  assertCardSpendable(chain, now);
  return validateSpend(store, chain, now, cents);
}

// ---------------------------------------------------------------------------
// DataHub governance (PII / sensitive classifications on the fetched entity)
// ---------------------------------------------------------------------------

/** Glossary-term and tag hints that mark an entity as PII / sensitive. Terms are
 * URNs (urn:li:glossaryTerm:...), tags are display names — both matched
 * case-insensitively, so "PII", "pii", "gdpr-sensitive" all block. */
const SENSITIVE_RE = /pii|gdpr|sensitive|phi|confidential|personal|secret|restricted/i;

export function isSensitiveEntity(meta: { glossaryTermUrns?: string[]; tags?: string[] }): boolean {
  if (meta.glossaryTermUrns?.some((t) => SENSITIVE_RE.test(t))) return true;
  if (meta.tags?.some((t) => SENSITIVE_RE.test(t))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Scope gating
// ---------------------------------------------------------------------------

/** Search input for the upstream query, pinned to the card's scope. */
export function scopedSearchInput(policy: CardPolicy, req: { query: string; count?: number }) {
  const { types, orFilters } = scopeSearchFilters(policy);
  return { query: req.query, types, orFilters, count: req.count };
}

/** Max lineage hops this card may traverse (its own cap, else the default 3). */
export function lineageDepthFor(policy: CardPolicy): number {
  return policy.scope.lineageDepth ?? 3;
}

/** Gate a fetched entity's facts against the card scope; throws a typed refusal. */
export function gateEntity(policy: CardPolicy, facts: EntityFacts): void {
  const verdict = scopeAllows(policy, facts);
  if (verdict.ok) return;
  const detail: Record<string, unknown> = { urn: facts.urn };
  if (facts.type) detail.type = facts.type;
  if (facts.domainUrns?.length) detail.domains = facts.domainUrns;
  if (facts.platformUrn) detail.platform = facts.platformUrn;
  emitRefusalLog("", verdict.reason ?? "entity_not_allowed", "");
  throw new RefusalError(verdict.reason ?? "entity_not_allowed", `entity ${facts.urn} is outside this card's scope`, detail);
}

/** Gate a list of entity facts (any outside scope refuses the whole batch). */
export function gateEntities(policy: CardPolicy, metas: HubEntityMeta[]): HubEntityMeta[] {
  for (const m of metas) gateEntity(policy, m);
  return metas;
}

/** Filter search/lineage results down to what the card's scope can PROVE is
 * allowed from a bare result row: the entities allowlist (by urn) and the
 * entity-types allowlist (by type or the URN shape). Domain/platform dims can't
 * be checked without entity facts — those are enforced upstream by the injected
 * search filters (scopeSearchFilters). Out-of-scope rows are dropped, not
 * refused: search is a discovery surface, and the upstream filters already
 * pinned the query. */
export function filterSearchResults<T extends { urn: string; type?: string | null }>(
  policy: CardPolicy,
  results: T[],
): T[] {
  const s = policy.scope;
  if (!s.entities?.length && !s.entityTypes?.length) return results;
  return results.filter((r) => {
    const urn = r.urn.toLowerCase();
    if (s.entities?.length && !s.entities.includes(urn)) return false;
    if (s.entityTypes?.length) {
      const t = (r.type ?? entityTypeFromUrn(urn) ?? "").toUpperCase();
      if (t && !s.entityTypes.includes(t)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Ledger recording (idempotent)
// ---------------------------------------------------------------------------

export type RecordAccessInput = {
  kind: string; // tool name
  to_urn?: string | null;
  units?: number;
  /** USD cents for payment-lane tool calls (fiat_pay); null for pure data calls. */
  spend_usd_cents?: number | null;
  memo?: string;
  status?: "ok" | "refused" | "failed";
  idempotencyKey?: string;
};

/** Record one access event (a budget debit) against a card. Idempotent on
 * (card, idempotencyKey): retries return the original row without double-debiting.
 * A UNIQUE-conflict on the same key mid-flight (e.g. the Stripe webhook racing
 * fiat_pay for the same authorization id) resolves the same way: the identical
 * event was already booked by the other path, so it's reported as replayed —
 * never an error, never a double debit. */
export function recordAccess(store: Store, cardId: string, input: RecordAccessInput): { id: string; replayed: boolean } {
  const units = input.units ?? 1;
  if (input.idempotencyKey) {
    const existing = store.chargeByIdempotency(cardId, input.idempotencyKey);
    if (existing) return { id: existing.id, replayed: true };
  }
  const id = crypto.randomUUID();
  try {
    store.insertCharge({
      id,
      card_id: cardId,
      idempotency_key: input.idempotencyKey ?? null,
      kind: input.kind,
      to_urn: input.to_urn ?? null,
      units,
      spend_usd_cents: input.spend_usd_cents ?? null,
      status: input.status ?? "ok",
      memo: input.memo ?? null,
      created_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    if (input.idempotencyKey && e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      const existing = store.chargeByIdempotency(cardId, input.idempotencyKey);
      if (existing) return { id: existing.id, replayed: true };
    }
    throw e;
  }
  queriesTotal.add(1);
  emitAccessLog(input.kind, cardId, input.to_urn ?? "", input.status ?? "ok", input.memo ?? "");
  return { id, replayed: false };
}

/** One-stop helper for the MCP tools: liveness + budget + (optionally) the ledger
 * write. Returns the remaining budget for the receipt. */
export function authorizeAccess(store: Store, chain: CardRow[], now: number, units = 1): RemainingBudget {
  assertCardSpendable(chain, now);
  return validateBudget(store, chain, now, units);
}

// ---------------------------------------------------------------------------
// compilePolicy re-export for callers that only import from the barrel
// ---------------------------------------------------------------------------

export { compilePolicy };
export type { CardPolicy };
