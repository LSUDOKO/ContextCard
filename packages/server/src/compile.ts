// The plain-language drafter (no LLM): an intent like "let my agent explore the
// revenue dashboards in the Finance domain" is tokenized, and every meaningful
// name is resolved by SEARCHING THE REAL CATALOG. The draft's scope can therefore
// only ever contain entities that actually exist in DataHub — a model could not
// inject a phantom URN even if we had one.

import { EngineError, type DataHubClient, type CardTerms } from "@datacards/engine";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "to", "of", "in", "on", "at", "my", "our", "your", "let",
  "access", "agent", "agents", "card", "cards", "read", "view", "explore", "browse", "see", "query", "queries",
  "data", "dataset", "datasets", "table", "tables", "dashboard", "dashboards", "chart", "charts", "catalog",
  "only", "about", "across", "from", "that", "this", "these", "those", "upstream", "downstream", "lineage",
  "needed", "need", "wants", "want", "can", "could", "would", "should", "give", "grant", "allow", "limited",
  "domain", "domains", "finance", "marketing", "sales", "engineering", "hr", "operations",
]);

const TYPE_HINTS: Array<[RegExp, string[]]> = [
  [/\bdashboard/i, ["DASHBOARD"]],
  [/\bchart/i, ["CHART"]],
  [/\bdocument|\bknowledge|\bwiki|\brunbook|\bfaq/i, ["DOCUMENT"]],
  [/\bglossary|\bterm|\bdefinition/i, ["GLOSSARYTERM"]],
  [/\bml\b|\bmachine learning|\bmodel/i, ["MLMODEL", "MLFEATURETABLE"]],
  [/\btable|\bdataset|\bwarehouse|\bview\b/i, ["DATASET"]],
];

export async function resolveIntent(
  datahub: DataHubClient,
  intent: string,
): Promise<{ draft: CardTerms; labels: string[]; warnings: string[] }> {
  const types = TYPE_HINTS.find(([re]) => re.test(intent))?.[1] ?? ["DATASET", "DASHBOARD", "CHART"];
  const tokens = intent
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const query = tokens.join(" ");

  const warnings: string[] = [];
  if (!query) {
    warnings.push("could not extract any searchable names from the intent");
    return { draft: { budget: { period: { amount: 100, seconds: 604800 } } }, labels: [], warnings };
  }

  // one search over the hinted types; fall back to a broad search on no hits.
  // A down DataHub must surface as a clean "compiler needs the live catalog"
  // failure (502), not a raw fetch error (500) in the dashboard's composer.
  const search = async (args: { query: string; types?: string[]; count?: number }) => {
    try {
      return await datahub.search(args);
    } catch (e) {
      throw new EngineError("compile", `DataHub unreachable — the compiler needs the live catalog (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  let res = await search({ query, types, count: 10 });
  if (res.total === 0 && types.length > 1) {
    res = await search({ query, count: 10 });
  }
  if (res.total === 0) {
    warnings.push(`nothing in the catalog matched "${query}" — the draft is scope-free (full-catalog reads)`);
    return { draft: { budget: { period: { amount: 100, seconds: 604800 } } }, labels: [], warnings };
  }

  const entities = res.results.map((r) => r.urn);
  const platforms = [...new Set(entities.map((u) => platformFromUrn(u)).filter((p): p is string => !!p))];
  const entityTypes = [...new Set(entities.map((u) => entityTypeFromUrn(u)).filter((t): t is string => !!t))];

  const scope: NonNullable<CardTerms["scope"]> = {};
  if (entityTypes.length) scope.entityTypes = entityTypes;
  if (platforms.length) scope.platforms = platforms;
  scope.entities = entities;
  scope.lineageDepth = 2;

  const labels = res.results.map((r) => `${r.name ?? r.urn} (${r.type ?? "entity"})`);
  if (res.total > entities.length) warnings.push(`showing ${entities.length} of ${res.total} matches; tighten the intent for a smaller allowlist`);

  return {
    draft: { scope, budget: { period: { amount: 100, seconds: 604800 } } },
    labels,
    warnings,
  };
}

function platformFromUrn(urn: string): string | null {
  const m = urn.match(/^urn:li:dataPlatform:([^,()]+)/);
  return m ? `urn:li:dataPlatform:${m[1]}` : null;
}

function entityTypeFromUrn(urn: string): string | null {
  const m = urn.match(/^urn:li:([a-zA-Z]+):/);
  if (!m) return null;
  const map: Record<string, string> = {
    dataset: "DATASET",
    dashboard: "DASHBOARD",
    chart: "CHART",
    container: "CONTAINER",
    dataflow: "DATAFLOW",
    datajob: "DATAJOB",
    mlmodel: "MLMODEL",
    glossaryterm: "GLOSSARYTERM",
    document: "DOCUMENT",
  };
  return map[m[1]!.toLowerCase()] ?? null;
}
