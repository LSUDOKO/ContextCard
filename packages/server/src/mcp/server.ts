// Per-card MCP server: the tool list IS the capability surface (locked pattern).
// A read-only card never sees save_document; sub-cards-off never sees
// issue/revoke_subcard. Stateless: a fresh McpServer per request (cheap; no
// session state to corrupt).
//
// Every tool call: liveness + budget check (typed refusals) -> scope-gated DataHub
// access -> ledger debit. Refusals come back as isError:true + structured JSON so
// agents can explain themselves ("over_period_limit, remaining 12 calls, resets at
// ...") instead of crashing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import {
  EngineError,
  RefusalError,
  assertCardSpendable,
  authorizeAccess,
  authorizeSpend,
  cardTreeKey,
  entityTypeFromUrn,
  fiatSpentTotal,
  filterSearchResults,
  gateEntity,
  isSensitiveEntity,
  issueSubCard,
  lineageDepthFor,
  periodWindow,
  revokeCard,
  recordAccess,
  scopedSearchInput,
  type CardRow,
  type CardTerms,
  type DataHubClient,
  type HubEntityMeta,
  type Store,
} from "@datacards/engine";
import type { AppDeps } from "../deps";
import { recordFiatDecision, recentFiatDecision } from "../stripe/decisions";
import { SHOP_MERCHANT } from "../shop/catalog";

const mcpTracer = trace.getTracer("datacards-server");

const SERVER_INFO = { name: "datacards", version: "0.1.0" };

// Surfaced to clients at initialize. Claude Code's tool search (default-on) keys
// discovery on this text and truncates at 2KB: keep it a compact routing guide.
const INSTRUCTIONS = [
  "datacards is a scoped, revocable access card granted by a data steward. The connection itself is the card; every tool call is checked against the card's terms: allowed domains/platforms/entity types, call budget per period, expiry, and write-back scope.",
  "Tools: `card` reports live state — remaining budget, terms, recent access. `search` finds datasets/dashboards/charts/documents in the catalog. `get_entities` fetches detailed metadata by URN. `get_lineage` traces upstream/downstream lineage (depth capped by the card). `list_schema_fields` lists a dataset's columns. `get_dataset_queries` fetches real SQL queries referencing a dataset. On cards with write-back, `save_document` persists findings back to DataHub's knowledge base so the next agent inherits them.",
  "A frozen card still answers `card` but refuses other tools. Refusals name the violated term; read the message before retrying.",
].join("\n\n");

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function refused(e: RefusalError): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
}

function failed(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }], isError: true };
}

/** The LIMIT of a SELECT, or null when the statement has none (comments aside — this
 * is a governance guard, not a SQL parser; a crafted comment can't raise a limit
 * past the card's cap, only hide one and get refused for it). */
function parseSqlLimit(sql: string): number | null {
  const m = sql.match(/limit\s+(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The "Agent-Accessed" tag written back to DataHub after a governed query. */
const TAG_AGENT_ACCESSED = "urn:li:tag:Agent-Accessed";

// Every tool call is wrapped in an mcp_tool_<name> span so agent activity is fully
// observable: which tool, how long, did it error, on which card, and the typed
// refusal code on failure.
async function run(toolName: string, cardId: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  return mcpTracer.startActiveSpan(`mcp_tool_${toolName}`, async (span) => {
    span.setAttribute("mcp.tool", toolName);
    span.setAttribute("mcp.kind", "tool_call");
    span.setAttribute("card_id", cardId);
    try {
      const result = await (async (): Promise<ToolResult> => {
        try {
          return ok(await fn());
        } catch (e) {
          if (e instanceof RefusalError) return refused(e);
          if (e instanceof EngineError) return failed(`${e.stage}: ${e.message}`);
          return failed(e instanceof Error ? e.message : String(e));
        }
      })();
      const isError = result.isError ?? false;
      span.setAttribute("mcp.is_error", isError);
      if (isError) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "tool call failed" });
        const first = result.content[0];
        if (first && first.type === "text") {
          try {
            const parsed = JSON.parse(first.text) as { code?: string; message?: string };
            if (parsed.code) span.setAttribute("mcp.refusal_code", parsed.code);
            if (parsed.message) span.setAttribute("mcp.error_message", parsed.message);
          } catch {
            /* body not JSON — ignore */
          }
        }
      }
      return result;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// The card URL minting (the server's public base for card URLs)
// ---------------------------------------------------------------------------

export function cardUrl(secret: string): string {
  const base = process.env.DATACARDS_PUBLIC_MCP_BASE ?? `http://localhost:${process.env.PORT ?? 4070}`;
  return `${base}/c/${secret}/mcp`;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function buildMcpServer(deps: AppDeps, card: CardRow): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const store: Store = deps.store;
  const datahub: DataHubClient | null = deps.datahub;
  const now = () => Math.floor(Date.now() / 1000);
  // serialize budget-debiting sections per card TREE: concurrent calls must
  // validate one-at-a-time or both can pass a read-then-write check.
  const treeKey = cardTreeKey(store, card.id);
  const locked = <T>(fn: () => Promise<T>): Promise<T> => deps.mutex.run(treeKey, fn);

  // the DataHub source must be configured for any read to work
  const hub = (): DataHubClient => {
    if (!datahub) throw new RefusalError("source_unavailable", "DataHub is not configured on this server");
    return datahub;
  };

  /** liveness + budget for one metered call; returns the remaining budget. */
  const metered = (units = 1) => {
    const chain = store.ancestorChain(card.id);
    if (!chain.length) throw new RefusalError("card_not_found", "no such card");
    return authorizeAccess(store, chain, now(), units);
  };

  /** gate a fetched entity against the card's scope; throws a typed refusal. */
  const gate = (meta: HubEntityMeta) => {
    const chain = store.ancestorChain(card.id);
    const leaf = chain[0]!;
    gateEntity(leaf.policy, meta);
  };

  const budgetTail = (r: ReturnType<typeof metered>) => ({
    remaining_this_period: r.remainingThisPeriod,
    remaining_lifetime: r.remainingLifetime,
    period_resets_at: r.periodResetsAt,
  });

  // ---- card (always) ----
  server.registerTool(
    "card",
    {
      title: "Card status",
      description:
        "Your access card's live state: remaining budget this period, lifetime remaining, expiry, terms, recent access log, sub-cards. Call this first to learn what you can do.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      run("card", card.id, async () => {
        const state = store.cardState(card.id, now());
        if (!state) throw new RefusalError("card_not_found", "no such card");
        const iso = (sec: number | null | undefined) => (sec == null ? null : new Date(sec * 1000).toISOString());
        const access = store.listCharges(card.id, 10).map((c) => ({
          tool: c.kind,
          target: c.to_urn,
          status: c.status,
          memo: c.memo,
          at: iso(c.created_at),
        }));
        return { ...state, period_resets_at: iso(state.period_resets_at), expires_at: iso(state.expires_at), recent_access: access };
      }),
  );

  // ---- search (always: the discovery tool) ----
  server.registerTool(
    "search",
    {
      title: "Search the data catalog",
      description:
        "Search DataHub for datasets, dashboards, charts, containers, glossary terms, and documents. Results are automatically filtered to this card's scope (domains, platforms, entity types, glossary terms). Use get_entities on the top result URNs to compare.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("search query, e.g. 'revenue orders'"),
        count: z.number().int().min(1).max(25).optional().describe("max results (default 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { query: string; count?: number }) =>
      run("search", card.id, () =>
        locked(async () => {
          const remaining = metered();
          const chain = store.ancestorChain(card.id);
          const leaf = chain[0]!;
          const input = scopedSearchInput(leaf.policy, { query: args.query, count: args.count ?? 10 });
          const res = await hub().search(input);
          // belt-and-braces on top of the injected upstream filters: drop rows the
          // card's entities/entity-types allowlist can prove are out of scope.
          const results = filterSearchResults(leaf.policy, res.results);
          const memo = `q="${args.query}" -> ${res.total} hits`;
          recordAccess(store, card.id, { kind: "search", memo, status: "ok" });
          return { query: args.query, total: res.total, results, budget: budgetTail(remaining) };
        }),
      ),
  );

  // ---- get_entities (always) ----
  server.registerTool(
    "get_entities",
    {
      title: "Get entity metadata",
      description:
        "Fetch detailed metadata for one or more entities by URN (schema, platform, domain, owners, tags, glossary terms, description). Pass an array of the top search-result URNs to compare candidates. Entities outside this card's scope are refused.",
      inputSchema: {
        urns: z.array(z.string().describe("entity URN")).min(1).max(10).describe("URNs to fetch (batch to compare candidates)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { urns: string[] }) =>
      run("get_entities", card.id, () =>
        locked(async () => {
          const remaining = metered();
          const metas: HubEntityMeta[] = [];
          for (const urn of args.urns) {
            const meta = await hub().getEntity(urn);
            if (!meta) throw new RefusalError("entity_not_allowed", `entity ${urn} not found in DataHub`, { urn });
            gate(meta);
            metas.push(meta);
          }
          recordAccess(store, card.id, { kind: "get_entities", to_urn: metas[0]!.urn, memo: `${metas.length} entit${metas.length === 1 ? "y" : "ies"}`, status: "ok" });
          const out = metas.map((m) => ({
            urn: m.urn,
            type: m.type,
            name: m.name,
            description: m.description,
            platform: m.platformName,
            domain: m.domainNames,
            glossary_terms: m.glossaryTermUrns,
            tags: m.tags,
            owners: m.owners.map((o) => ({ urn: o.urn, name: o.name })),
            last_ingested: m.lastIngested,
          }));
          return { entities: out, budget: budgetTail(remaining) };
        }),
      ),
  );

  // ---- get_lineage (always) ----
  server.registerTool(
    "get_lineage",
    {
      title: "Trace data lineage",
      description:
        "Trace upstream or downstream lineage from an entity, capped at this card's lineage depth (ask `card` for your limit). Refuses hops beyond the cap (lineage_depth_exceeded) and entities outside scope.",
      inputSchema: {
        urn: z.string().describe("starting entity URN"),
        direction: z.enum(["UPSTREAM", "DOWNSTREAM"]).describe("UPSTREAM = its inputs, DOWNSTREAM = its consumers"),
        max_hops: z.number().int().min(1).max(3).optional().describe("hops (default = the card's cap)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { urn: string; direction: "UPSTREAM" | "DOWNSTREAM"; max_hops?: number }) =>
      run("get_lineage", card.id, () =>
        locked(async () => {
          const remaining = metered();
          const chain = store.ancestorChain(card.id);
          const leaf = chain[0]!;
          // the root must itself be inside the card's scope
          const root = await hub().getEntity(args.urn);
          if (!root) throw new RefusalError("entity_not_allowed", `entity ${args.urn} not found in DataHub`, { urn: args.urn });
          gate(root);
          const cap = lineageDepthFor(leaf.policy);
          const requested = args.max_hops ?? cap;
          if (requested > cap) {
            throw new RefusalError("lineage_depth_exceeded", `this card's lineage depth is capped at ${cap} hops`, {
              cap,
              requested,
            });
          }
          const res = await hub().getLineage({ urn: args.urn, direction: args.direction, maxHops: requested });
          // drop nodes the card's allowlists can prove are out of scope (the depth
          // cap already bounded the request; this kills the same-dimension leaks)
          const nodes = filterSearchResults(leaf.policy, res.nodes);
          recordAccess(store, card.id, { kind: "get_lineage", to_urn: args.urn, memo: `${args.direction.toLowerCase()} ${res.total} node(s)`, status: "ok" });
          return { direction: args.direction, total: nodes.length, nodes, budget: budgetTail(remaining) };
        }),
      ),
  );

  // ---- list_schema_fields (always) ----
  server.registerTool(
    "list_schema_fields",
    {
      title: "List dataset schema fields",
      description:
        "List the columns of a dataset with types and descriptions. Use after search to understand a table's structure before writing SQL.",
      inputSchema: {
        urn: z.string().describe("dataset URN"),
        keyword: z.string().max(100).optional().describe("only fields whose path contains this keyword"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { urn: string; keyword?: string }) =>
      run("list_schema_fields", card.id, () =>
        locked(async () => {
          const remaining = metered();
          const meta = await hub().getEntity(args.urn);
          if (!meta) throw new RefusalError("entity_not_allowed", `entity ${args.urn} not found in DataHub`, { urn: args.urn });
          gate(meta);
          let fields = meta.schemaFields ?? [];
          if (args.keyword) {
            const k = args.keyword.toLowerCase();
            fields = fields.filter((f) => f.fieldPath.toLowerCase().includes(k));
          }
          recordAccess(store, card.id, { kind: "list_schema_fields", to_urn: args.urn, memo: `${fields.length} field(s)`, status: "ok" });
          return { urn: args.urn, fields, budget: budgetTail(remaining) };
        }),
      ),
  );

  // ---- get_dataset_queries (always) ----
  server.registerTool(
    "get_dataset_queries",
    {
      title: "Get SQL queries for a dataset",
      description:
        "Fetch real SQL queries that reference a dataset — manual and system-generated — to learn join patterns, filters, and conventions before writing your own SQL.",
      inputSchema: {
        urn: z.string().describe("dataset URN"),
        source: z.enum(["MANUAL", "SYSTEM"]).optional().describe("filter by query origin"),
        count: z.number().int().min(1).max(25).optional().describe("max queries (default 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { urn: string; source?: "MANUAL" | "SYSTEM"; count?: number }) =>
      run("get_dataset_queries", card.id, () =>
        locked(async () => {
          const remaining = metered();
          const meta = await hub().getEntity(args.urn);
          if (!meta) throw new RefusalError("entity_not_allowed", `entity ${args.urn} not found in DataHub`, { urn: args.urn });
          gate(meta);
          const queries = await hub().getDatasetQueries({ urn: args.urn, source: args.source, count: args.count ?? 10 });
          recordAccess(store, card.id, { kind: "get_dataset_queries", to_urn: args.urn, memo: `${queries.length} query(ies)`, status: "ok" });
          return {
            urn: args.urn,
            queries: queries.map((q) => ({ urn: q.urn, name: q.name, description: q.description, source: q.source, statement: q.statement, language: q.language })),
            budget: budgetTail(remaining),
          };
        }),
      ),
  );

  // ---- query_data (always): governed SQL preview ----
  server.registerTool(
    "query_data",
    {
      title: "Run a governed SQL query against a dataset",
      description:
        "Preview a dataset through a SQL query validated against this card's terms AND DataHub governance: the dataset must be in scope, must not carry a PII/sensitive classification (refusal pii_blocked), and — when the card sets maxRows — the SQL needs LIMIT <= maxRows (refusal row_limit_exceeded). No SQL warehouse is attached, so the answer is a schema-backed column preview, not live rows.",
      inputSchema: {
        urn: z.string().describe("dataset URN (must be in this card's scope)"),
        sql: z.string().min(1).max(2000).describe("SELECT statement; add LIMIT n when the card caps rows (ask card for maxRows)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { urn: string; sql: string }) =>
      run("query_data", card.id, () =>
        locked(async () => {
          const remaining = metered();
          const chain = store.ancestorChain(card.id);
          const leaf = chain[0]!;
          const meta = await hub().getEntity(args.urn);
          if (!meta) throw new RefusalError("entity_not_allowed", `entity ${args.urn} not found in DataHub`, { urn: args.urn });
          gate(meta); // the card's scope gate (typed refusal)
          // DataHub governance: a PII / sensitive classification blocks the query
          if (isSensitiveEntity(meta)) {
            throw new RefusalError(
              "pii_blocked",
              `dataset ${args.urn} carries a PII/sensitive classification — this card may not query it`,
              { urn: args.urn, glossary_terms: meta.glossaryTermUrns, tags: meta.tags },
            );
          }
          // row-limit enforcement against the card's maxRows
          const maxRows = leaf.policy.maxRows;
          let limit: number | null = parseSqlLimit(args.sql);
          if (maxRows !== null) {
            if (limit === null) {
              throw new RefusalError("row_limit_exceeded", `this card caps queries at ${maxRows} rows — add LIMIT ${maxRows} to your SQL`, { urn: args.urn, max_rows: maxRows });
            }
            if (limit > maxRows) {
              throw new RefusalError("row_limit_exceeded", `LIMIT ${limit} exceeds this card's ${maxRows}-row cap`, { urn: args.urn, max_rows: maxRows, requested: limit });
            }
          }
          const fields = (meta.schemaFields ?? []).slice(0, 25).map((f) => ({
            column: f.fieldPath,
            type: f.type,
            description: f.description,
          }));
          recordAccess(store, card.id, { kind: "query_data", to_urn: args.urn, memo: `LIMIT ${limit ?? "∞"} · ${fields.length} cols`, status: "ok" });
          // best-effort write-back: mark the dataset as agent-accessed (never fatal)
          const tagged = await hub().addTagToEntity(args.urn, TAG_AGENT_ACCESSED);
          return {
            urn: args.urn,
            sql: args.sql,
            status: "preview",
            note: "no SQL warehouse is attached — schema-backed column preview, not live execution",
            row_cap: maxRows,
            limit_used: limit,
            columns: fields,
            tagged,
            budget: budgetTail(remaining),
          };
        }),
      ),
  );

  // ---- lineage_check (always): what would break? ----
  server.registerTool(
    "lineage_check",
    {
      title: "Check what a change would break",
      description:
        "Trace downstream lineage from an entity (depth capped by the card) and summarize the impact: how many consumers, by type. The root must be in scope; the summary is this card's view of the neighborhood — owners are not fetched per node.",
      inputSchema: {
        urn: z.string().describe("entity URN (must be in this card's scope)"),
        max_hops: z.number().int().min(1).max(3).optional().describe("hops (default = the card's cap)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { urn: string; max_hops?: number }) =>
      run("lineage_check", card.id, () =>
        locked(async () => {
          const remaining = metered();
          const chain = store.ancestorChain(card.id);
          const leaf = chain[0]!;
          const root = await hub().getEntity(args.urn);
          if (!root) throw new RefusalError("entity_not_allowed", `entity ${args.urn} not found in DataHub`, { urn: args.urn });
          gate(root);
          const cap = lineageDepthFor(leaf.policy);
          const requested = args.max_hops ?? cap;
          if (requested > cap) {
            throw new RefusalError("lineage_depth_exceeded", `this card's lineage depth is capped at ${cap} hops`, { cap, requested });
          }
          const res = await hub().getLineage({ urn: args.urn, direction: "DOWNSTREAM", maxHops: requested, count: 50 });
          const nodes = filterSearchResults(leaf.policy, res.nodes);
          const byType = new Map<string, number>();
          for (const n of nodes) {
            const t = (n.type ?? entityTypeFromUrn(n.urn) ?? "ENTITY").toUpperCase();
            byType.set(t, (byType.get(t) ?? 0) + 1);
          }
          recordAccess(store, card.id, { kind: "lineage_check", to_urn: args.urn, memo: `${nodes.length} downstream node(s)`, status: "ok" });
          const impact = [...byType.entries()].map(([t, n]) => `${n} ${t.toLowerCase()}${n > 1 ? "s" : ""}`);
          return {
            urn: args.urn,
            direction: "DOWNSTREAM",
            max_hops: requested,
            total: nodes.length,
            impact: impact.length ? impact : ["no downstream consumers in this card's view"],
            affected_by_type: Object.fromEntries(byType),
            budget: budgetTail(remaining),
          };
        }),
      ),
  );

  // ---- save_document (write-back cards ONLY: the tool list is the surface) ----
  if (card.policy.mutations === "documents") {
    server.registerTool(
      "save_document",
      {
        title: "Save a document to the knowledge base",
        description:
          "Persist findings back to DataHub's knowledge base (insight, decision, FAQ, analysis, summary, recommendation, note). The document is linked to the assets you read and becomes visible to every future agent — this is how the team's context compounds. Confirm with the steward before writing.",
        inputSchema: {
          document_type: z
            .enum(["Insight", "Decision", "FAQ", "Analysis", "Summary", "Recommendation", "Note", "Context"])
            .describe("what kind of document this is"),
          title: z.string().min(1).max(200).describe("descriptive title"),
          content: z.string().min(1).max(20000).describe("markdown content"),
          related_assets: z.array(z.string()).max(10).optional().describe("URNs of the assets this document is about (must be in this card's scope)"),
        },
        annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async (args: { document_type: string; title: string; content: string; related_assets?: string[] }) =>
        run("save_document", card.id, () =>
          locked(async () => {
            const remaining = metered();
            // related assets must themselves be inside the card's scope
            const related: string[] = [];
            for (const urn of args.related_assets ?? []) {
              const meta = await hub().getEntity(urn);
              if (!meta) throw new RefusalError("entity_not_allowed", `entity ${urn} not found in DataHub`, { urn });
              gate(meta);
              related.push(urn);
            }
            const result = await hub().saveDocument({
              title: args.title,
              content: args.content,
              docType: args.document_type,
              relatedAssets: related,
            });
            if (!result.success) throw new EngineError("save_document", result.message);
            recordAccess(store, card.id, {
              kind: "save_document",
              to_urn: result.urn,
              memo: `"${args.title}"`,
              status: "ok",
            });
            return { success: true, urn: result.urn, message: result.message, budget: budgetTail(remaining) };
          }),
        ),
    );
  }

  // ---- payments (Stripe test-mode lane: spend-budget cards ONLY, Stripe configured) ----
  if (deps.stripe && card.policy.spend) {
    server.registerTool(
      "card_credentials",
      {
        title: "Reveal the card's payment Visa",
        description:
          "Reveal the Stripe test-mode Visa linked to this card (PAN, expiry, CVC) so a human or agent can check out at the demo shop. The number is the payment credential — treat it like the card URL. Test-mode only.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () =>
        run("card_credentials", card.id, async () => {
          const icId = await deps.stripe!.ensureCardForCard(card.id);
          if (!icId) throw new RefusalError("source_unavailable", "Stripe account has no cardholder to mint against");
          const det = await deps.stripe!.getCardDetails(icId, { reveal: true });
          if (!store.getFiatLink(card.id)) {
            store.setFiatLink({
              card_id: card.id,
              stripe_card_id: det.id,
              last4: det.last4,
              brand: det.brand,
              exp_month: det.exp_month,
              exp_year: det.exp_year,
              created_at: now(),
            });
          }
          return {
            card_number: det.number,
            exp_month: det.exp_month,
            exp_year: det.exp_year,
            cvc: det.cvc,
            brand: det.brand,
            last4: det.last4,
            note: "stripe test mode — the number is a test Visa, not a real card",
          };
        }),
    );

    server.registerTool(
      "fiat_pay",
      {
        title: "Pay over the Stripe test-mode lane",
        description:
          "Buy from the demo shop against this card's spend budget (budget.spend, USD per window). Liveness and every ancestor's spend cap are checked first (refusals over_spend_limit / no_spend_budget / card_frozen); the receipt carries the remaining spend.",
        inputSchema: {
          amount: z.number().min(0.01).max(500).describe("USD amount, e.g. 4.90"),
          merchant: z.string().min(1).max(80).optional().describe("merchant name for the receipt (default s0nder supply co.)"),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: { amount: number; merchant?: string }) =>
        run("fiat_pay", card.id, () =>
          locked(async () => {
            const cents = Math.round(args.amount * 100);
            if (!Number.isInteger(cents) || cents < 1) throw new RefusalError("invalid_terms", "amount must be at least $0.01");
            const chain = store.ancestorChain(card.id);
            if (!chain.length) throw new RefusalError("card_not_found", "no such card");
            const callTail = metered(); // this tool call costs 1 unit against period/lifetime
            const spend = authorizeSpend(store, chain, now(), cents);
            const icId = await deps.stripe!.ensureCardForCard(card.id);
            if (!icId) throw new RefusalError("source_unavailable", "Stripe account has no cardholder to mint against");
            // the webhook resolves THIS card from the Issuing card id — persist the
            // link up front so a first-ever fiat_pay (no prior card_credentials or
            // dashboard mint) still maps to a live card instead of no_card_mapping
            if (!store.getFiatLink(card.id)) {
              const det = await deps.stripe!.getCardDetails(icId);
              store.setFiatLink({
                card_id: card.id,
                stripe_card_id: det.id,
                last4: det.last4,
                brand: det.brand,
                exp_month: det.exp_month,
                exp_year: det.exp_year,
                created_at: now(),
              });
            }
            const auth = await deps.stripe!.createTestAuthorization({
              cardId: icId,
              amountCents: cents,
              merchantName: args.merchant ?? SHOP_MERCHANT,
            });
            // if the webhook fired during the round-trip and declined, honor it
            const webhook = recentFiatDecision(auth.id);
            if (webhook && !webhook.approved) {
              throw new Error(`the payment lane declined: ${webhook.reason}`, { cause: { authorization_id: auth.id } });
            }
            // book the charge once, idempotent on the Stripe authorization id —
            // recordAccess replays if the webhook already booked this exact row
            // (it then answers duplicate_delivery on its own delivery), and a
            // UNIQUE race mid-flight resolves the same way instead of crashing.
            // If the webhook WON, its row carries the spend but not the tool call
            // (units: 0) — book a second, spend-free row so THIS call still
            // debits the call budget and shows up in the access log.
            const recorded = recordAccess(store, card.id, {
              idempotencyKey: `stripe-${auth.id}`,
              kind: "fiat_pay",
              units: 1,
              spend_usd_cents: cents,
              memo: `visa · ${args.merchant ?? SHOP_MERCHANT} · ${auth.id}`,
              status: "ok",
            });
            if (!recorded.replayed) {
              fiatSpentTotal.add(cents / 100);
            } else {
              recordAccess(store, card.id, {
                idempotencyKey: `fiat_pay-${auth.id}`,
                kind: "fiat_pay",
                units: 1,
                memo: `visa · ${args.merchant ?? SHOP_MERCHANT} · ${auth.id} (webhook-booked)`,
                status: "ok",
              });
            }
            recordFiatDecision(auth.id, { approved: true, reason: "in_budget", cardId: card.id });
            // receipt's remaining spend: when the webhook booked mid-flight, re-read
            // the committed ledger so the number isn't stale (spend may already be
            // drawn by the webhook's row)
            const ledgerSpend = (() => {
              if (!recorded.replayed) return { remaining: spend.remainingSpend, resetsAt: spend.spendResetsAt };
              let remaining: number | null = null;
              let resetsAt: number | null = null;
              for (const c of store.ancestorChain(card.id)) {
                const p = c.policy;
                if (!p.spend) continue;
                const w = periodWindow(c.created_at, p.spend.seconds, now());
                remaining = Math.max(0, p.spend.amount - store.subtreeSpendSince(c.id, w.start));
                resetsAt = w.resetsAt;
              }
              return { remaining, resetsAt };
            })();
            return {
              approved: true,
              authorization_id: auth.id,
              amount: args.amount,
              merchant: args.merchant ?? SHOP_MERCHANT,
              last4: (await deps.stripe!.getCardDetails(icId)).last4,
              remaining_spend: ledgerSpend.remaining,
              spend_resets_at: ledgerSpend.resetsAt,
              budget: budgetTail(callTail),
            };
          }),
        ),
    );
  }

  // ---- sub-cards ----
  if (card.terms.subcards !== false) {
    server.registerTool(
      "issue_subcard",
      {
        title: "Issue a sub-card",
        description:
          "Mint a tighter child card for a sub-agent. Scope must be a subset of this card's; omitted budget terms inherit this card's remaining budget. Returns the sub-card's connection URL — treat it as a secret.",
        inputSchema: {
          name: z.string().min(1).max(80).describe("label shown in the steward's dashboard"),
          terms: z
            .object({
              scope: z
                .object({
                  domains: z.array(z.string()).optional(),
                  platforms: z.array(z.string()).optional(),
                  entityTypes: z.array(z.string()).optional(),
                  entities: z.array(z.string()).optional(),
                  glossaryTerms: z.array(z.string()).optional(),
                  lineageDepth: z.number().int().min(1).max(3).optional(),
                })
                .optional(),
              budget: z
                .object({
                  period: z.object({ amount: z.number().int().min(1), seconds: z.number().int().min(60) }).optional(),
                  lifetime: z.object({ amount: z.number().int().min(1) }).optional(),
                })
                .optional(),
              mutations: z.enum(["none", "documents"]).optional(),
              expiry: z.number().int().optional(),
              maxUses: z.number().int().min(1).optional(),
              subcards: z.boolean().optional(),
            })
            .describe("child terms; every dimension must fit inside this card's"),
        },
        annotations: { openWorldHint: false },
      },
      async (args: { name: string; terms: unknown }) =>
        run("issue_subcard", card.id, async () => {
          const chain = store.ancestorChain(card.id);
          if (!chain.length) throw new RefusalError("card_not_found", "no such card");
          assertCardSpendable(chain, now()); // liveness only, unmetered
          const issued = await issueSubCard(store, { parentCardId: card.id, name: args.name, terms: args.terms as CardTerms });
          return { card_id: issued.cardId, card_url: cardUrl(issued.secret), terms: issued.terms };
        }),
    );

    server.registerTool(
      "revoke_subcard",
      {
        title: "Revoke a sub-card",
        description:
          "Kill a sub-card you issued (and its descendants): the server stops honoring it instantly and its URL dies. Descendants only — not_your_subcard otherwise.",
        inputSchema: {
          card_id: z.string().describe("the sub-card's id (from issue_subcard or card)"),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: { card_id: string }) =>
        run("revoke_subcard", card.id, async () => {
          const target = store.getCard(args.card_id);
          if (!target || target.parent_card_id !== card.id) {
            throw new RefusalError("invalid_terms", "not your sub-card", { card_id: args.card_id });
          }
          revokeCard(store, args.card_id);
          return { status: "revoked", card_id: args.card_id };
        }),
    );
  }

  return server;
}
