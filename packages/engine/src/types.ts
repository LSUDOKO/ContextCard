// Core domain types. CardTerms is the terms_json vocabulary (DataCards capability
// spec v1). A card grants an agent SCOPED, REVOCABLE access to a DataHub context
// graph: which domains / platforms / entity types / entities / glossary terms it
// may touch, how many tool calls it may burn per period, whether it may write
// documents back, and when it dies. The tool surface the agent sees is derived
// from these terms (a read-only card never sees save_document).

// ---------------------------------------------------------------------------
// Terms (what the steward composes / a parent agent attenuates)
// ---------------------------------------------------------------------------

export type DataScope = {
  /** Domain URNs the card may access (urn:li:domain:...). Search results are
   * filtered; direct URN reads outside these domains refuse. */
  domains?: string[];
  /** Data platform URNs (urn:li:dataPlatform:snowflake, ...). */
  platforms?: string[];
  /** Entity types allowed (DATASET, DASHBOARD, CHART, CONTAINER, GLOSSARYTERM,
   * DOCUMENT, DATAFLOW, DATAJOB, MLMODEL, ...). */
  entityTypes?: string[];
  /** Explicit entity URN allowlist (urn:li:dataset:(...), ...). */
  entities?: string[];
  /** Glossary term URNs: only entities carrying one of these terms are visible. */
  glossaryTerms?: string[];
  /** Max lineage hops (1..3). A 3 means "whole neighborhood"; 1 is direct only. */
  lineageDepth?: number;
};

export type DataBudget = {
  /** Recurring cap: tool calls per fixed window (period resets at start + k*seconds). */
  period?: { amount: number; seconds: number };
  /** Cumulative lifetime ceiling in tool calls. Stacks with period. */
  lifetime?: { amount: number };
  /** Recurring fiat cap: USD (in cents) per fixed window for the Stripe test-mode
   * lane (shop checkout + fiat_pay). Absent = the card cannot pay over the fiat lane. */
  spend?: { amount: number; seconds: number };
};

export type CardTerms = {
  /** What the card may see. An absent/empty scope = full-catalog reads (still
   * budget-, expiry- and uses-bound). */
  scope?: DataScope;
  /** Call budget. Every tool call costs 1 unit (sub-cards draw down ancestors too). */
  budget?: DataBudget;
  /** Write-back capability: "documents" allows save_document (the agent persists
   * findings so the next agent inherits them). "none" (default) = read-only. */
  mutations?: "none" | "documents";
  /** Unix seconds. Card dies after this. */
  expiry?: number;
  /** Total number of tool calls. */
  maxUses?: number;
  /** May this card mint sub-cards? Default true. */
  subcards?: boolean;
  /** Max rows a single query_data call may return (row-limit enforcement). Absent = no cap. */
  maxRows?: number;
};

// ---------------------------------------------------------------------------
// Live state (tool + dashboard facing)
// ---------------------------------------------------------------------------

export type CardStatus = "active" | "frozen" | "revoked" | "nuked" | "expired";

export type CardState = {
  card_id: string;
  name: string;
  status: CardStatus;
  terms: CardTerms;
  remaining_this_period: number | null;
  remaining_lifetime: number | null;
  period_resets_at: number | null;
  /** USD cents left in the fiat spend window (Stripe test-mode lane). */
  remaining_spend: number | null;
  spend_resets_at: number | null;
  expires_at: number | null;
  uses_remaining: number | null;
  subcards: string[];
};

export type AccessLogEntry = {
  id: string;
  kind: string; // tool name: search, get_entities, save_document, ...
  to_urn: string | null;
  units: number;
  status: "ok" | "refused" | "failed";
  memo: string | null;
  at: number;
};

// ---------------------------------------------------------------------------
// DataHub client responses (the context the agent actually gets)
// ---------------------------------------------------------------------------

export type HubEntityMeta = {
  urn: string;
  type: string | null;
  name: string | null;
  description: string | null;
  platformUrn: string | null;
  platformName: string | null;
  domainUrns: string[];
  domainNames: string[];
  glossaryTermUrns: string[];
  tags: string[];
  owners: Array<{ urn: string; name: string | null }>;
  /** dataset schema fields (list_schema_fields) */
  schemaFields?: Array<{ fieldPath: string; type: string | null; description: string | null; nullable: boolean | null }>;
  lastIngested: number | null;
  raw: unknown;
};

export type HubSearchResult = {
  urn: string;
  type: string | null;
  name: string | null;
};

export type HubSearchResponse = {
  start: number;
  count: number;
  total: number;
  results: HubSearchResult[];
  facets?: Array<{ field: string; displayName: string; aggregations: Array<{ value: string; count: number; displayName: string }> }>;
};

export type HubLineageNode = {
  urn: string;
  type: string | null;
  name: string | null;
  degree: number | null;
  paths: Array<{ urn: string; type: string | null }>;
};

export type HubLineageResponse = {
  direction: "UPSTREAM" | "DOWNSTREAM";
  total: number;
  nodes: HubLineageNode[];
};

export type HubQueryInfo = {
  urn: string;
  name: string | null;
  description: string | null;
  source: string | null;
  statement: string | null;
  language: string | null;
  subjects: string[]; // dataset urns
};

export type HubDocumentResult = {
  success: boolean;
  urn: string | null;
  message: string;
  author: string | null;
};
