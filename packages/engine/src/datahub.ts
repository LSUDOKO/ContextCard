// DataHub client: GraphQL (reads) + REST ingest (document write-back). A fetch-only
// port of the official mcp-server-datahub's DataHub access, so a card's server can
// query the context graph directly. Auth: DATAHUB_GMS_TOKEN (PAT), or basic
// username/password against /authenticate (datahub:datahub for quickstart).

import { EngineError } from "./errors";
import type {
  HubDocumentResult,
  HubEntityMeta,
  HubLineageResponse,
  HubQueryInfo,
  HubSearchResponse,
} from "./types";

export type DataHubClientConfig = {
  baseUrl: string;
  token: string;
};

// MLModel is deliberately absent: MLModelProperties.name is the one nullable
// `name` in the schema, and mixing it in makes GraphQL reject the whole selection
// with a FieldsConflict. MLModel results still come back — just without a name.
// datahub: add `... on MLModel { properties { mlName: name } }` plus a mapping
// branch if ML assets ever need labels.
const SEARCH_FRAGMENT = `
  fragment SearchEntityInfo on Entity {
    urn
    ... on Dataset { properties { name } }
    ... on Chart { properties { name } }
    ... on Dashboard { properties { name } }
    ... on Container { properties { name } }
    ... on GlossaryTerm { properties { name } }
    ... on GlossaryNode { properties { name } }
    ... on Domain { properties { name } }
    ... on DataProduct { properties { name } }
    ... on DataFlow { properties { name } }
    ... on DataJob { properties { name } }
  }
`;

const ENTITY_DETAILS = `
  query GetEntity($urn: String!) {
    entity(urn: $urn) {
      urn
      type
      ... on Dataset {
        name
        platform { urn name }
        properties { name description lastModified { time } }
        editableProperties { description }
        domain { domain { urn properties { name } } }
        tags { tags { tag { urn properties { name } } } }
        glossaryTerms { terms { term { urn properties { name } } } }
        ownership { owners { owner { ... on CorpUser { urn properties { displayName } } ... on CorpGroup { urn properties { displayName } } } } }
        schemaMetadata {
          fields { fieldPath type nativeDataType description nullable }
          createdAt
        }
      }
      ... on Dashboard {
        properties { name description lastModified { time } }
        platform { urn name }
        domain { domain { urn properties { name } } }
        tags { tags { tag { urn properties { name } } } }
        glossaryTerms { terms { term { urn properties { name } } } }
        ownership { owners { owner { ... on CorpUser { urn properties { displayName } } ... on CorpGroup { urn properties { displayName } } } } }
      }
      ... on Chart {
        properties { name description lastModified { time } }
        platform { urn name }
        domain { domain { urn properties { name } } }
        tags { tags { tag { urn properties { name } } } }
        glossaryTerms { terms { term { urn properties { name } } } }
        ownership { owners { owner { ... on CorpUser { urn properties { displayName } } ... on CorpGroup { urn properties { displayName } } } } }
      }
      ... on Container {
        properties { name description }
        platform { urn name }
        domain { domain { urn properties { name } } }
        tags { tags { tag { urn properties { name } } } }
        glossaryTerms { terms { term { urn properties { name } } } }
        ownership { owners { owner { ... on CorpUser { urn properties { displayName } } ... on CorpGroup { urn properties { displayName } } } } }
      }
      ... on DataProduct {
        properties { name description }
        domain { domain { urn properties { name } } }
        tags { tags { tag { urn properties { name } } } }
        glossaryTerms { terms { term { urn properties { name } } } }
      }
      ... on GlossaryTerm {
        properties { name description }
        domain { domain { urn properties { name } } }
      }
      ... on Document {
        info { title contents { text } }
        domain { domain { urn properties { name } } }
        tags { tags { tag { urn properties { name } } } }
        glossaryTerms { terms { term { urn properties { name } } } }
      }
    }
  }
`;

const LINEAGE_QUERY = `
  query GetEntityLineage($input: SearchAcrossLineageInput!) {
    searchAcrossLineage(input: $input) {
      total
      searchResults {
        entity {
          urn
          type
          ... on Dataset { name }
          ... on Dashboard { properties { name } }
          ... on Chart { properties { name } }
          ... on Container { properties { name } }
          ... on DataJob { properties { name } }
        }
        degree
        paths { path { urn type } }
      }
    }
  }
`;

const SEARCH_QUERY = `
  ${SEARCH_FRAGMENT}
  query Search($types: [EntityType!], $query: String!, $orFilters: [AndFilterInput!], $count: Int!, $start: Int!, $searchFlags: SearchFlags) {
    searchAcrossEntities(input: {
      query: $query
      count: $count
      start: $start
      types: $types
      orFilters: $orFilters
      searchFlags: $searchFlags
    }) {
      start
      count
      total
      searchResults { entity { ...SearchEntityInfo } }
      facets { field displayName aggregations { value count displayName } }
    }
  }
`;

const QUERIES_QUERY = `
  query ListQueries($input: ListQueriesInput!) {
    listQueries(input: $input) {
      start
      total
      count
      queries {
        urn
        properties { name description source statement { value language } }
        subjects { dataset { urn } }
      }
    }
  }
`;

const GET_ME_QUERY = `
  query GetMe {
    me { corpUser { urn username info { displayName fullName } } }
  }
`;

export class DataHubClient {
  constructor(private readonly cfg: DataHubClientConfig) {}

  static fromEnv(): DataHubClient | null {
    const baseUrl = (process.env.DATAHUB_GMS_URL ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl) return null;
    const token = (process.env.DATAHUB_GMS_TOKEN ?? "").trim();
    if (token) return new DataHubClient({ baseUrl, token });
    // quickstart-style basic auth: mint a session token once via /authenticate
    const user = (process.env.DATAHUB_USERNAME ?? "datahub").trim();
    const pass = (process.env.DATAHUB_PASSWORD ?? "datahub").trim();
    return new DataHubClient({ baseUrl, token: `basic:${user}:${pass}` });
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>, operationName: string): Promise<T> {
    let token = this.cfg.token;
    if (token.startsWith("basic:")) {
      const [, u, p] = token.split(":");
      const res = await fetch(`${this.cfg.baseUrl}/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      if (!res.ok) throw new EngineError("datahub", `authentication failed (http ${res.status})`);
      const body = (await res.json()) as { accessToken?: string };
      if (!body.accessToken) throw new EngineError("datahub", "authentication returned no token");
      token = body.accessToken;
    }
    const res = await fetch(`${this.cfg.baseUrl}/api/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables, operationName }),
    });
    if (!res.ok) throw new EngineError("datahub", `graphql failed (http ${res.status})`);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) {
      throw new EngineError("datahub", `graphql error: ${body.errors[0]!.message ?? "unknown"}`);
    }
    if (!body.data) throw new EngineError("datahub", "graphql returned no data");
    return body.data;
  }

  private async ingest(aspects: Array<{ aspectName: string; aspect: Record<string, unknown> }>, urn: string, entityType: string): Promise<void> {
    let token = this.cfg.token;
    // re-mint a real token for the REST call (basic auth is not accepted on REST)
    if (token.startsWith("basic:")) {
      const [, u, p] = token.split(":");
      const res = await fetch(`${this.cfg.baseUrl}/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      });
      const body = (await res.json()) as { accessToken?: string };
      if (!body.accessToken) throw new EngineError("datahub", "authentication returned no token");
      token = body.accessToken;
    }
    // Aspect-level writes go to /aspects?action=ingestProposal. (/entities?action=ingest
    // is the legacy snapshot lane and rejects this payload with "Parameter 'entity' is
    // required".) The aspect itself travels as a JSON *string* under value/contentType.
    for (const a of aspects) {
      const res = await fetch(`${this.cfg.baseUrl}/aspects?action=ingestProposal`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          proposal: {
            entityType,
            entityUrn: urn,
            aspectName: a.aspectName,
            changeType: "UPSERT",
            aspect: { value: asciiJson(a.aspect), contentType: "application/json" },
          },
        }),
      });
      if (!res.ok) {
        throw new EngineError("datahub", `ingest ${a.aspectName} failed (http ${res.status}): ${(await res.text()).slice(0, 200)}`);
      }
    }
  }

  // ---- reads ----

  async search(input: {
    query: string;
    types?: string[];
    orFilters?: Array<{ and: Array<{ field: string; values: string[]; condition: string }> }>;
    count?: number;
    start?: number;
  }): Promise<HubSearchResponse> {
    const count = Math.min(Math.max(input.count ?? 10, 1), 50);
    const data = await this.graphql<{
      searchAcrossEntities: {
        start: number;
        count: number;
        total: number;
        searchResults: Array<{ entity: { urn: string; properties?: { name?: string | null } | null } }>;
        facets?: Array<{ field: string; displayName: string; aggregations: Array<{ value: string; count: number; displayName: string }> }>;
      };
    }>(
      SEARCH_QUERY,
      {
        query: input.query || "*",
        types: input.types ?? null,
        orFilters: input.orFilters ?? null,
        count,
        start: input.start ?? 0,
        searchFlags: { skipHighlighting: true, maxAggValues: 5 },
      },
      "Search",
    );
    const s = data.searchAcrossEntities;
    return {
      start: s.start,
      count: s.count,
      total: s.total,
      results: s.searchResults.map((r) => {
        const e = r.entity as { urn: string; type?: string | null; properties?: { name?: string | null } | null };
        return { urn: e.urn, type: e.type ?? null, name: e.properties?.name ?? null };
      }),
      facets: s.facets,
    };
  }

  async getEntity(urn: string): Promise<HubEntityMeta | null> {
    const data = await this.graphql<{ entity: Record<string, unknown> | null }>(ENTITY_DETAILS, { urn }, "GetEntity");
    return data.entity ? (metaFromEntity(data.entity) as HubEntityMeta) : null;
  }

  async getLineage(input: {
    urn: string;
    direction: "UPSTREAM" | "DOWNSTREAM";
    maxHops: number;
    count?: number;
  }): Promise<HubLineageResponse> {
    const degree = input.maxHops <= 2 ? Array.from({ length: input.maxHops }, (_, i) => String(i + 1)) : ["1", "2", "3+"];
    const data = await this.graphql<{
      searchAcrossLineage: {
        total: number;
        searchResults: Array<{
          entity: { urn: string; type?: string | null; name?: string | null; properties?: { name?: string | null } | null };
          degree: number | null;
          paths: Array<{ path: Array<{ urn: string; type: string | null }> }>;
        }>;
      };
    }>(
      LINEAGE_QUERY,
      {
        input: {
          urn: input.urn,
          direction: input.direction,
          query: "*",
          start: 0,
          count: Math.min(Math.max(input.count ?? 25, 1), 100),
          orFilters: [{ and: [{ field: "degree", values: degree, condition: "EQUAL" }] }],
          searchFlags: { skipHighlighting: true, maxAggValues: 3 },
        },
      },
      "GetEntityLineage",
    );
    const s = data.searchAcrossLineage;
    return {
      direction: input.direction,
      total: s.total,
      nodes: s.searchResults.map((r) => {
        const e = r.entity;
        return {
          urn: e.urn,
          type: e.type ?? null,
          name: e.name ?? e.properties?.name ?? null,
          degree: r.degree,
          paths: r.paths.flatMap((p) => p.path ?? []),
        };
      }),
    };
  }

  async getDatasetQueries(input: { urn: string; source?: "MANUAL" | "SYSTEM"; count?: number }): Promise<HubQueryInfo[]> {
    const data = await this.graphql<{
      listQueries: {
        queries: Array<{
          urn: string;
          properties: {
            name?: string | null;
            description?: string | null;
            source?: string | null;
            statement?: { value?: string | null; language?: string | null } | null;
          };
          subjects: Array<{ dataset: { urn: string } }>;
        }>;
      };
    }>(
      QUERIES_QUERY,
      {
        input: {
          start: 0,
          count: Math.min(Math.max(input.count ?? 10, 1), 50),
          source: input.source ?? null,
          // ListQueriesInput takes a single datasetUrn — there is no `subjects` input
          datasetUrn: input.urn,
        },
      },
      "ListQueries",
    );
    return data.listQueries.queries.map((q) => ({
      urn: q.urn,
      name: q.properties.name ?? null,
      description: q.properties.description ?? null,
      source: q.properties.source ?? null,
      statement: q.properties.statement?.value ?? null,
      language: q.properties.statement?.language ?? null,
      subjects: q.subjects.map((s) => s.dataset.urn),
    }));
  }

  async getMe(): Promise<{ urn: string; username: string; displayName: string | null } | null> {
    try {
      const data = await this.graphql<{ me: { corpUser: { urn: string; username: string; info?: { displayName?: string | null } | null } | null } | null }>(
        GET_ME_QUERY,
        {},
        "GetMe",
      );
      const u = data.me?.corpUser;
      if (!u) return null;
      return { urn: u.urn, username: u.username, displayName: u.info?.displayName ?? null };
    } catch {
      return null; // attribution is best-effort; never fail the write on it
    }
  }

  // ---- write-back (documents) ----

  /** Save/update a standalone knowledge document. Mirrors the official server's
   * save_document: creates a Document under the shared folder, linked to the
   * related assets the card read. */
  async saveDocument(input: {
    title: string;
    content: string;
    docType: string;
    relatedAssets?: string[];
  }): Promise<HubDocumentResult> {
    const me = await this.getMe();
    const actor = me?.urn ?? "urn:li:corpuser:datahub";
    const docId = `card-${crypto.randomUUID()}`;
    const urn = `urn:li:document:${docId}`;
    const parent = "urn:li:document:__system_shared_documents";
    const nowMs = Date.now();
    // DocumentInfo requires contents / status / created / lastModified; the body
    // lives under contents.text (a bare `text` field is rejected with a 422).
    const stamp = { time: nowMs, actor };
    const aspect = {
      title: input.title,
      contents: { text: input.content },
      status: { state: "PUBLISHED" },
      type: input.docType.toUpperCase(),
      parentDocument: { document: parent },
      relatedDocuments: [],
      // each entry is { asset: <urn> } — a `dataset` key fails validation with
      // "/relatedAssets/0/asset :: field is required"
      relatedAssets: (input.relatedAssets ?? []).map((urn2) => ({ asset: urn2 })),
      created: stamp,
      lastModified: stamp,
    };
    await this.ingest(
      [
        { aspectName: "documentInfo", aspect },
        { aspectName: "documentSettings", aspect: { showInGlobalContext: true, lastModified: { time: nowMs, actor } } },
      ],
      urn,
      "document",
    );
    // the shared folder must exist for the doc to be findable; ensure it (idempotent)
    await this.ingest(
      [
        {
          aspectName: "documentInfo",
          aspect: {
            title: "Shared",
            contents: { text: "Contains shared documents authored through AI agents." },
            status: { state: "PUBLISHED" },
            type: "FOLDER",
            // parentDocument is OMITTED, not null: a null fails validation with
            // "/parentDocument :: record type is not backed by a DataMap", and the
            // .catch below would swallow it — leaving the folder titled "Untitled".
            relatedDocuments: [],
            relatedAssets: [],
            created: stamp,
            lastModified: stamp,
          },
        },
      ],
      parent,
      "document",
    ).catch(() => {});
    return { success: true, urn, message: `Successfully created document: ${input.title}`, author: me?.displayName ?? null };
  }

  // ---- tag write-back (the "Agent-Accessed" marker) ----

  /** Attach a tag to an entity, preserving its existing tags (a best-effort merge,
   * never a blind overwrite). Uses the standard GMS REST ingest with the globalTags
   * aspect. Returns false on any failure — the caller treats tagging as non-critical.
   */
  async addTagToEntity(urn: string, tagUrn: string): Promise<boolean> {
    try {
      const existing = await this.getEntity(urn);
      const have = new Set<string>();
      const raw = (existing?.raw as { tags?: { tags?: Array<{ tag?: { urn?: string } }> } } | undefined)?.tags?.tags ?? [];
      for (const t of raw) if (t.tag?.urn) have.add(t.tag.urn);
      if (have.has(tagUrn)) return true;
      await this.ingest(
        [{ aspectName: "globalTags", aspect: { tags: [...have, tagUrn].map((tag) => ({ tag })) } }],
        urn,
        entityTypeForUrn(urn),
      );
      return true;
    } catch {
      return false;
    }
  }
}

/** JSON with every non-ASCII character \uXXXX-escaped. The aspect payload rides
 * inside a JSON *string* field, and GMS rejects raw non-ASCII there with a
 * request-level "failed validation" 400 — so an em dash in an agent's findings
 * would kill the whole write. A charset header does not help; escaping does. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The GMS ingest entityType for a URN (lowercase prefix, defaulting to dataset). */
function entityTypeForUrn(urn: string): string {
  const m = urn.match(/^urn:li:([a-z]+):/i);
  return m ? m[1]!.toLowerCase() : "dataset";
}

/** Map a raw GraphQL entity payload to the normalized HubEntityMeta. */
function metaFromEntity(e: Record<string, unknown>): Partial<HubEntityMeta> {
  const props = (e.properties ?? {}) as Record<string, unknown>;
  const editable = (e.editableProperties ?? {}) as Record<string, unknown>;
  const platform = e.platform as Record<string, unknown> | undefined;
  const domain = e.domain as { domain?: { urn?: string; properties?: { name?: string } } } | undefined;
  const tags = e.tags as { tags?: Array<{ tag?: { urn?: string; properties?: { name?: string } } }> } | undefined;
  const terms = e.glossaryTerms as { terms?: Array<{ term?: { urn?: string; properties?: { name?: string } } }> } | undefined;
  const ownership = e.ownership as { owners?: Array<{ owner?: { urn?: string; properties?: { displayName?: string } } }> } | undefined;
  const schema = e.schemaMetadata as
    | { fields?: Array<{ fieldPath?: string; type?: string | null; nativeDataType?: string | null; description?: string | null; nullable?: boolean | null }>; createdAt?: number | null }
    | undefined;
  const name = (props.name ?? e.name ?? null) as string | null;
  return {
    urn: e.urn as string,
    type: (e.type as string) ?? null,
    name,
    description: ((editable.description ?? props.description) as string | null) ?? null,
    platformUrn: platform?.urn as string | undefined | null,
    platformName: platform?.name as string | undefined | null,
    domainUrns: domain?.domain?.urn ? [domain.domain.urn] : [],
    domainNames: domain?.domain?.properties?.name ? [domain.domain.properties.name] : [],
    glossaryTermUrns: (terms?.terms ?? []).map((t) => t.term?.urn ?? "").filter(Boolean),
    tags: (tags?.tags ?? []).map((t) => t.tag?.properties?.name ?? t.tag?.urn ?? "").filter(Boolean),
    owners: (ownership?.owners ?? [])
      .map((o) => ({ urn: o.owner?.urn ?? "", name: o.owner?.properties?.displayName ?? null }))
      .filter((o) => o.urn),
    schemaFields: schema?.fields?.map((f) => ({
      fieldPath: f.fieldPath ?? "",
      type: f.type ?? f.nativeDataType ?? null,
      description: f.description ?? null,
      nullable: f.nullable ?? null,
    })),
    lastIngested: schema?.createdAt ?? null,
    raw: e,
  };
}
