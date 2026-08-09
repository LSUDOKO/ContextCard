// OpenTelemetry metrics + structured logs. All custom signals for DataCards:
//   metrics   datacards.cards_issued_total / active_cards / queries_total / errors_total
//   logs      card lifecycle (card_event), access events (tool calls), typed refusals
// The server preloads the SDK (packages/server/src/otel.ts); this module only
// declares meters/loggers, so the engine stays a pure library.

import { metrics } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

const meter = metrics.getMeter("datacards");
const logger = logs.getLogger("datacards");

// ---- metrics ----

export const cardsIssuedTotal = meter.createCounter("datacards.cards_issued_total", {
  description: "Cards issued (root + sub) across all stewards",
});
export const activeCards = meter.createUpDownCounter("datacards.active_cards", {
  description: "Live gauge of issued minus revoked",
});
export const queriesTotal = meter.createCounter("datacards.queries_total", {
  description: "Agent tool calls served (search, get_entities, ...)",
});
export const errorsTotal = meter.createCounter("datacards.errors_total", {
  description: "Every 403/422/502/500 response + failed tool calls",
});
export const fiatSpentTotal = meter.createCounter("datacards.fiat_spent_total", {
  description: "USD (dollars) settled through the Stripe test-mode payment lane",
});

// ---- structured logs ----

export function emitCardLog(event: string, cardId: string, extra: Record<string, string> = {}): void {
  logger.emit({
    severityText: "INFO",
    severityNumber: SeverityNumber.INFO,
    body: `card ${event}: ${cardId}`,
    attributes: { card_event: event, card_id: cardId, ...extra },
  });
}

export function emitAccessLog(tool: string, cardId: string, target: string, outcome: string, memo: string): void {
  logger.emit({
    severityText: outcome === "ok" ? "INFO" : "WARN",
    severityNumber: outcome === "ok" ? SeverityNumber.INFO : SeverityNumber.WARN,
    body: `access ${tool}: ${outcome}`,
    attributes: { access_tool: tool, card_id: cardId, target, outcome, memo },
  });
}

export function emitRefusalLog(cardId: string, reason: string, attemptedUnits: string): void {
  logger.emit({
    severityText: "WARN",
    severityNumber: SeverityNumber.WARN,
    body: `refusal: ${reason}`,
    attributes: { refusal_reason: reason, card_id: cardId, attempted_units: attemptedUnits },
  });
}

export function emitErrorLog(operation: string, message: string, extra: Record<string, string> = {}): void {
  logger.emit({
    severityText: "ERROR",
    severityNumber: SeverityNumber.ERROR,
    body: `error: ${message}`,
    attributes: { operation, error_message: message, ...extra },
  });
}
