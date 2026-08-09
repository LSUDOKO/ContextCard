// Structural test double for the DataHub client the MCP server calls (duck-typed,
// cast to DataHubClient at the harness). Backed by an in-memory catalog so tests
// seed exactly the entities they need (schemas, PII classifications) and assert
// what the server asked of the catalog (the Agent-Accessed tag write-back).

import type {
  HubDocumentResult,
  HubEntityMeta,
  HubLineageResponse,
  HubQueryInfo,
  HubSearchResponse,
} from "@datacards/engine";

export class FakeDataHub {
  entities = new Map<string, HubEntityMeta>();
  /** every addTagToEntity call, in order — { urn, tag } */
  tagWrites: Array<{ urn: string; tag: string }> = [];

  set(meta: HubEntityMeta): this {
    this.entities.set(meta.urn, meta);
    return this;
  }

  async search(input: {
    query: string;
    types?: string[];
    orFilters?: unknown;
    count?: number;
    start?: number;
  }): Promise<HubSearchResponse> {
    const q = (input.query || "*").toLowerCase();
    const results = [...this.entities.values()]
      .filter((e) => q === "*" || (e.name ?? "").toLowerCase().includes(q))
      .slice(0, input.count ?? 10)
      .map((e) => ({ urn: e.urn, type: e.type, name: e.name }));
    return { start: input.start ?? 0, count: results.length, total: results.length, results, facets: [] };
  }

  async getEntity(urn: string): Promise<HubEntityMeta | null> {
    return this.entities.get(urn) ?? null;
  }

  async getLineage(input: { urn: string; direction: "UPSTREAM" | "DOWNSTREAM"; maxHops: number }): Promise<HubLineageResponse> {
    return { direction: input.direction, total: 0, nodes: [] };
  }

  async getDatasetQueries(input: { urn: string }): Promise<HubQueryInfo[]> {
    void input;
    return [];
  }

  async getMe(): Promise<{ urn: string; username: string; displayName: string | null } | null> {
    return { urn: "urn:li:corpuser:datahub", username: "datahub", displayName: "DataHub" };
  }

  async saveDocument(input: { title: string; content: string }): Promise<HubDocumentResult> {
    return { success: true, urn: `urn:li:document:${crypto.randomUUID()}`, message: `created ${input.title}`, author: null };
  }

  async addTagToEntity(urn: string, tag: string): Promise<boolean> {
    this.tagWrites.push({ urn, tag });
    return true;
  }
}

/** Standard fixture builder so tests stay terse. */
export function meta(over: Partial<HubEntityMeta> & { urn: string }): HubEntityMeta {
  return {
    type: "DATASET",
    name: null,
    description: null,
    platformUrn: "urn:li:dataPlatform:snowflake",
    platformName: "snowflake",
    domainUrns: [],
    domainNames: [],
    glossaryTermUrns: [],
    tags: [],
    owners: [],
    lastIngested: 1_780_000_000_000,
    raw: {},
    schemaFields: [],
    ...over,
  };
}
