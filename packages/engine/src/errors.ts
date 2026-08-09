// Typed errors. RefusalError carries a stable, agent-readable code + context so
// MCP clients can relay refusals honestly (over_period_limit, domain_not_allowed,
// ...). EngineError is a server-side fault (stage + message, sanitized).

export type RefusalCode =
  | "invalid_terms"
  | "card_not_found"
  | "card_frozen"
  | "card_revoked"
  | "card_expired"
  | "over_period_limit"
  | "over_lifetime_limit"
  | "over_spend_limit"
  | "no_spend_budget"
  | "pii_blocked"
  | "row_limit_exceeded"
  | "uses_exhausted"
  | "domain_not_allowed"
  | "platform_not_allowed"
  | "entity_type_not_allowed"
  | "entity_not_allowed"
  | "lineage_depth_exceeded"
  | "mutation_not_allowed"
  | "exceeds_parent_terms"
  | "source_unavailable";

export class RefusalError extends Error {
  readonly code: RefusalCode;
  readonly context: Record<string, unknown>;

  constructor(code: RefusalCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = "RefusalError";
    this.code = code;
    this.context = context;
  }

  toJSON(): { code: RefusalCode; message: string; context: Record<string, unknown> } {
    return { code: this.code, message: this.message, context: this.context };
  }
}

export class EngineError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.stage = stage;
  }
}
