// The policy compiler: CardTerms -> a validated, normalized CardPolicy, plus the
// scope-matching helpers the enforcement layer uses. This is the DataCards analog
// of GlassPay's caveat compiler: terms are compiled to enforceable rules here, and
// every rule is enforced BOTH at call time (typed refusals) and at the DataHub
// boundary (search filters injected into the upstream query, per-URN gates).

import { RefusalError } from "./errors";
import type { CardTerms, DataScope } from "./types";

export type CardPolicy = {
  scope: DataScope; // normalized (lowercased urns, deduped, lineageDepth capped)
  mutations: "none" | "documents";
  period: { amount: number; seconds: number } | null;
  lifetime: number | null;
  /** USD cents per fixed window for the Stripe test-mode fiat lane. */
  spend: { amount: number; seconds: number } | null;
  /** Max rows per query_data call (row-limit enforcement). */
  maxRows: number | null;
  expiry: number | null;
  maxUses: number | null;
  subcards: boolean;
};

const URN_RE = /^urn:li:[a-z]+[a-z0-9]*:/i;
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/; // platform/entity-type names

function invalid(message: string, field?: string): never {
  throw new RefusalError("invalid_terms", message, field ? { field } : {});
}

/** Normalize a scope in place: trim, case-normalize per field (URNs lowercase;
 * entity types UPPERCASE so they compare with DataHub's canonical entity-type
 * strings), dedupe AFTER normalization so case-insensitive duplicates collapse,
 * clamp lineageDepth. */
function normalizeScope(scope: DataScope | undefined): DataScope {
  const out: DataScope = {};
  if (!scope) return out;
  const norm = (arr: string[] | undefined, caseFn: (s: string) => string): string[] | undefined =>
    arr === undefined ? undefined : [...new Set(arr.map((s) => caseFn(s.trim())).filter(Boolean))];
  out.domains = norm(scope.domains, (s) => s.toLowerCase());
  out.platforms = norm(scope.platforms, (s) => s.toLowerCase());
  out.entityTypes = norm(scope.entityTypes, (s) => s.toUpperCase());
  out.entities = norm(scope.entities, (s) => s.toLowerCase());
  out.glossaryTerms = norm(scope.glossaryTerms, (s) => s.toLowerCase());
  if (scope.lineageDepth !== undefined) out.lineageDepth = Math.max(1, Math.min(3, Math.floor(scope.lineageDepth)));
  return out;
}

export function compilePolicy(terms: CardTerms, now: number): CardPolicy {
  const scope = normalizeScope(terms.scope);
  // domains / entities / glossary terms are always URNs — require the shape.
  // platforms accept a URN or a bare platform name (e.g. "snowflake"); entity
  // types are uppercase names; lineageDepth is a number.
  for (const field of ["domains", "entities", "glossaryTerms"] as const) {
    for (const v of scope[field] ?? []) {
      if (!URN_RE.test(v)) invalid(`scope.${field} entries must be URNs (got "${v}")`, `scope.${field}`);
    }
  }
  for (const v of scope.platforms ?? []) {
    if (v.includes(":") && !URN_RE.test(v)) invalid(`bad urn in scope.platforms: ${v}`, `scope.platforms`);
  }
  const budget = terms.budget;
  let period: { amount: number; seconds: number } | null = null;
  if (budget?.period) {
    if (!Number.isInteger(budget.period.amount) || budget.period.amount < 1) invalid("budget.period.amount must be an integer >= 1", "budget.period.amount");
    if (!Number.isInteger(budget.period.seconds) || budget.period.seconds < 60) invalid("budget.period.seconds must be >= 60", "budget.period.seconds");
    period = { amount: budget.period.amount, seconds: budget.period.seconds };
  }
  let lifetime: number | null = null;
  if (budget?.lifetime) {
    if (!Number.isInteger(budget.lifetime.amount) || budget.lifetime.amount < 1) invalid("budget.lifetime.amount must be an integer >= 1", "budget.lifetime.amount");
    lifetime = budget.lifetime.amount;
  }
  let spend: { amount: number; seconds: number } | null = null;
  if (budget?.spend) {
    if (!Number.isInteger(budget.spend.amount) || budget.spend.amount < 1) invalid("budget.spend.amount must be an integer >= 1 (USD cents)", "budget.spend.amount");
    if (!Number.isInteger(budget.spend.seconds) || budget.spend.seconds < 60) invalid("budget.spend.seconds must be >= 60", "budget.spend.seconds");
    spend = { amount: budget.spend.amount, seconds: budget.spend.seconds };
  }
  if (!period && !lifetime && !spend) invalid("a card needs at least one budget cap: budget.period and/or budget.lifetime and/or budget.spend");
  if (terms.expiry !== undefined) {
    if (!Number.isInteger(terms.expiry) || terms.expiry <= now) invalid("expiry must be in the future", "expiry");
  }
  if (terms.maxUses !== undefined) {
    if (!Number.isInteger(terms.maxUses) || terms.maxUses < 1) invalid("maxUses must be >= 1", "maxUses");
  }
  if (terms.maxRows !== undefined) {
    if (!Number.isInteger(terms.maxRows) || terms.maxRows < 1) invalid("maxRows must be an integer >= 1", "maxRows");
  }
  const mutations = terms.mutations === "documents" ? "documents" : "none";
  return {
    scope,
    mutations,
    period,
    lifetime,
    spend,
    maxRows: terms.maxRows ?? null,
    expiry: terms.expiry ?? null,
    maxUses: terms.maxUses ?? null,
    subcards: terms.subcards !== false,
  };
}

// ---------------------------------------------------------------------------
// Scope matching (the enforcement primitives)
// ---------------------------------------------------------------------------

const ENTITY_TYPE_BY_URN: Array<[RegExp, string]> = [
  [/^urn:li:dataset:/, "DATASET"],
  [/^urn:li:dashboard:/, "DASHBOARD"],
  [/^urn:li:chart:/, "CHART"],
  [/^urn:li:container:/, "CONTAINER"],
  [/^urn:li:dataFlow:/, "DATAFLOW"],
  [/^urn:li:dataJob:/, "DATAJOB"],
  [/^urn:li:mlModel:/, "MLMODEL"],
  [/^urn:li:mlFeatureTable:/, "MLFEATURETABLE"],
  [/^urn:li:glossaryTerm:/, "GLOSSARYTERM"],
  [/^urn:li:domain:/, "DOMAIN"],
  [/^urn:li:document:/, "DOCUMENT"],
  [/^urn:li:corpUser:/, "CORPUSER"],
  [/^urn:li:corpGroup:/, "CORPGROUP"],
  [/^urn:li:dataProduct:/, "DATAPRODUCT"],
  [/^urn:li:dataPlatform:/, "DATAPLATFORM"],
];

/** Best-effort entity type for a URN (used when the upstream response lacks one). */
export function entityTypeFromUrn(urn: string): string | null {
  const u = urn.toLowerCase();
  for (const [re, type] of ENTITY_TYPE_BY_URN) if (re.test(u)) return type;
  return null;
}

export type EntityFacts = {
  urn: string;
  type?: string | null;
  platformUrn?: string | null;
  domainUrns?: string[];
  glossaryTermUrns?: string[];
};

/** Does the policy's scope admit this entity? Returns { ok, reason } where reason
 * names the refusing dimension for a typed refusal. */
export function scopeAllows(policy: CardPolicy, facts: EntityFacts): { ok: boolean; reason: "entity_not_allowed" | "domain_not_allowed" | "platform_not_allowed" | "entity_type_not_allowed" | null } {
  const s = policy.scope;
  if (!s.domains && !s.platforms && !s.entityTypes && !s.entities && !s.glossaryTerms) return { ok: true, reason: null };
  const urn = facts.urn.toLowerCase();
  if (s.entities) {
    if (s.entities.includes(urn)) return { ok: true, reason: null };
    // explicit allowlist is exclusive unless broader rules also admit it
  }
  if (s.domains && facts.domainUrns) {
    const hit = facts.domainUrns.some((d) => s.domains!.includes(d.toLowerCase()));
    if (hit) return { ok: true, reason: null };
  }
  if (s.platforms && facts.platformUrn) {
    if (s.platforms.includes(facts.platformUrn.toLowerCase())) return { ok: true, reason: null };
  }
  if (s.entityTypes && facts.type) {
    if (s.entityTypes.includes(facts.type.toUpperCase())) return { ok: true, reason: null };
  }
  if (s.glossaryTerms && facts.glossaryTermUrns) {
    const hit = facts.glossaryTermUrns.some((t) => s.glossaryTerms!.includes(t.toLowerCase()));
    if (hit) return { ok: true, reason: null };
  }
  if (s.entityTypes && facts.type && !s.entityTypes.includes(facts.type.toUpperCase())) return { ok: false, reason: "entity_type_not_allowed" };
  if (s.domains && facts.domainUrns) return { ok: false, reason: "domain_not_allowed" };
  if (s.platforms && facts.platformUrn) return { ok: false, reason: "platform_not_allowed" };
  return { ok: false, reason: "entity_not_allowed" };
}

/** DataHub search filters that pin a scope onto an upstream search: domain /
 * platform / entity-type / glossary-term filters, compiled to orFilters. */
export function scopeSearchFilters(policy: CardPolicy): { types?: string[]; orFilters?: Array<{ and: Array<{ field: string; values: string[]; condition: string }> }> } {
  const s = policy.scope;
  if (!s.domains && !s.platforms && !s.entityTypes && !s.glossaryTerms) return {};
  const and: Array<{ field: string; values: string[]; condition: string }> = [];
  if (s.domains) and.push({ field: "domains", values: s.domains, condition: "EQUAL" });
  if (s.platforms) and.push({ field: "platform", values: s.platforms, condition: "EQUAL" });
  if (s.glossaryTerms) and.push({ field: "glossaryTerms", values: s.glossaryTerms, condition: "EQUAL" });
  return { types: s.entityTypes, orFilters: and.length ? [{ and }] : undefined };
}

/** The lineage-degree filter values for a depth cap (mirrors the reference MCP
 * server: 1-2 hops are exact degrees, 3+ is the catch-all "3+"). */
export function degreeFilterValues(maxHops: number): string[] {
  if (maxHops <= 2) return Array.from({ length: maxHops }, (_, i) => String(i + 1));
  return ["1", "2", "3+"];
}

// ---------------------------------------------------------------------------
// Sub-card attenuation (caps only narrow; scope only subsets)
// ---------------------------------------------------------------------------

export type ParentRemaining = {
  periodRemaining: number | null;
  lifetimeRemaining: number | null;
  /** USD cents left in the parent's spend window (null when it has no spend cap). */
  spendRemaining: number | null;
};

function exceeds(field: string, message: string): never {
  throw new RefusalError("exceeds_parent_terms", message, { field });
}

/**
 * Validate + fill child terms against the parent. Omitted budget/expiry terms
 * inherit the parent capped to remaining; scope restrictions INHERIT when the
 * child omits them and must be subsets when the child specifies them (a child
 * can never be wider than its parent — dropping a parent restriction would
 * widen, since dimensions match as an OR); mutations never inherit upward.
 */
export function attenuate(parentPolicy: CardPolicy, remaining: ParentRemaining, child: CardTerms, now: number): CardTerms {
  const out: CardTerms = structuredClone(child);

  // --- scope: never wider than the parent, under ANY combination ---
  // scopeAllows matches dimensions as an OR, so a child that drops a parent
  // restriction OR adds a dimension the parent doesn't restrict would widen the
  // reachable set (a domain-only parent must not end up with a platform-scoped
  // child, which would admit every entity on that platform in ANY domain). Three
  // rules keep the child's scope equal-or-narrower than the parent's:
  //   1. every dimension the parent restricts is INHERITED when the child omits it;
  //   2. a child may not ADD a dimension the parent doesn't restrict (unless the
  //      parent is entirely unrestricted);
  //   3. explicit entries for a shared dimension must be a subset of the parent's.
  // A child that omits scope entirely inherits the parent's whole scope (never
  // "full catalog").
  const SCOPED_URNS = ["domains", "platforms", "entities", "glossaryTerms"] as const;
  const ALL_DIMS = ["domains", "platforms", "entityTypes", "entities", "glossaryTerms"] as const;
  const pScope = parentPolicy.scope;
  const parentRestricted = !!(
    pScope.domains?.length ||
    pScope.platforms?.length ||
    pScope.entityTypes?.length ||
    pScope.entities?.length ||
    pScope.glossaryTerms?.length
  );
  if (out.scope) {
    const childScope = out.scope;
    for (const dim of ALL_DIMS) {
      const parentList = pScope[dim];
      if (parentList && parentList.length) {
        if (childScope[dim] === undefined) childScope[dim] = [...parentList]; // (1) inherit
      } else if (parentRestricted && childScope[dim] !== undefined) {
        exceeds(`scope.${dim}`, `the parent card does not restrict ${dim}; a child may not add it`); // (2)
      }
    }
    if (pScope.lineageDepth !== undefined) {
      if (childScope.lineageDepth === undefined) childScope.lineageDepth = pScope.lineageDepth; // (1)
    }
    // (3) subset checks for shared dimensions
    const subset = (field: (typeof SCOPED_URNS)[number], childList: string[] | undefined) => {
      if (!childList) return;
      const parentList = pScope[field] ?? [];
      if (parentList.length === 0) return; // parent unrestricted: any child scope fits
      for (const v of childList) {
        if (!parentList.includes(v.toLowerCase())) exceeds(`scope.${field}`, `${v} is not in the parent's scope`);
      }
    };
    subset("domains", childScope.domains);
    subset("platforms", childScope.platforms);
    subset("entities", childScope.entities);
    subset("glossaryTerms", childScope.glossaryTerms);
    if (childScope.entityTypes) {
      const parentTypes = pScope.entityTypes ?? [];
      if (parentTypes.length) {
        for (const t of childScope.entityTypes) {
          if (!parentTypes.includes(t.toUpperCase())) exceeds("scope.entityTypes", `${t} is not in the parent's scope`);
        }
      }
    }
    const childDepth = childScope.lineageDepth;
    if (childDepth !== undefined && pScope.lineageDepth !== undefined && childDepth > pScope.lineageDepth) {
      exceeds("scope.lineageDepth", "child lineage depth exceeds the parent's");
    }
  } else {
    // child with no scope inherits the parent's ENTIRE scope — a sub-card must
    // never silently open up to the full catalog when its parent is scoped
    out.scope = structuredClone(pScope);
  }

  // --- budget: inherit capped to remaining when omitted; else must fit ---
  const pPeriod = parentPolicy.period;
  if (pPeriod) {
    if (!out.budget?.period) {
      out.budget = { ...(out.budget ?? {}), period: { amount: Math.min(pPeriod.amount, remaining.periodRemaining ?? pPeriod.amount), seconds: pPeriod.seconds } };
    } else if (out.budget.period.amount > pPeriod.amount) {
      exceeds("budget.period.amount", `child period cap exceeds the parent's ${pPeriod.amount}`);
    } else if (remaining.periodRemaining !== null && out.budget.period.amount > remaining.periodRemaining) {
      exceeds("budget.period.amount", `child period cap exceeds the parent's remaining (${remaining.periodRemaining})`);
    }
  } else if (out.budget?.period) {
    exceeds("budget.period", "parent card has no period budget");
  }
  if (parentPolicy.lifetime !== null) {
    if (!out.budget?.lifetime) {
      out.budget = { ...(out.budget ?? {}), lifetime: { amount: Math.min(parentPolicy.lifetime, remaining.lifetimeRemaining ?? parentPolicy.lifetime) } };
    } else if (out.budget.lifetime.amount > parentPolicy.lifetime) {
      exceeds("budget.lifetime.amount", `child lifetime cap exceeds the parent's ${parentPolicy.lifetime}`);
    } else if (remaining.lifetimeRemaining !== null && out.budget.lifetime.amount > remaining.lifetimeRemaining) {
      exceeds("budget.lifetime.amount", `child lifetime cap exceeds the parent's remaining (${remaining.lifetimeRemaining})`);
    }
  } else if (out.budget?.lifetime) {
    exceeds("budget.lifetime", "parent card has no lifetime budget");
  }
  if (parentPolicy.spend) {
    if (!out.budget?.spend) {
      out.budget = { ...(out.budget ?? {}), spend: { amount: Math.min(parentPolicy.spend.amount, remaining.spendRemaining ?? parentPolicy.spend.amount), seconds: parentPolicy.spend.seconds } };
    } else if (out.budget.spend.amount > parentPolicy.spend.amount) {
      exceeds("budget.spend.amount", `child spend cap exceeds the parent's ${parentPolicy.spend.amount}`);
    } else if (remaining.spendRemaining !== null && out.budget.spend.amount > remaining.spendRemaining) {
      exceeds("budget.spend.amount", `child spend cap exceeds the parent's remaining (${remaining.spendRemaining})`);
    }
  } else if (out.budget?.spend) {
    exceeds("budget.spend", "parent card has no spend budget");
  }

  // --- mutations: a child can only narrow (documents -> none) ---
  if (out.mutations === "documents" && parentPolicy.mutations !== "documents") {
    exceeds("mutations", "parent card does not allow write-back");
  }

  // --- expiry ---
  if (parentPolicy.expiry !== null) {
    if (out.expiry === undefined) out.expiry = parentPolicy.expiry;
    else if (out.expiry > parentPolicy.expiry) exceeds("expiry", "child expiry exceeds the parent's");
  }

  // --- maxUses ---
  if (parentPolicy.maxUses !== null && out.maxUses !== undefined && out.maxUses > parentPolicy.maxUses) {
    exceeds("maxUses", "child maxUses exceeds the parent's");
  }

  // --- maxRows: inherit when omitted; a child may never widen it ---
  if (parentPolicy.maxRows !== null) {
    if (out.maxRows === undefined) out.maxRows = parentPolicy.maxRows;
    else if (out.maxRows > parentPolicy.maxRows) exceeds("maxRows", `child maxRows exceeds the parent's ${parentPolicy.maxRows}`);
  }

  compilePolicy(out, now); // final validation (throws invalid_terms)
  return out;
}
