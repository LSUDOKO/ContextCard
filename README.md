<div align="center">
   <img width="480" height="350" alt="Gemini_Generated_Image_rvpbjurvpbjurvpb-removebg-preview" src="https://github.com/user-attachments/assets/aec7c9c0-d8a3-42ed-96ff-dcc6bb921a28" />
</div>

# DataCards

Scoped, revocable **context cards** that gate what AI agents can see and do inside your DataHub catalog — which domains, platforms and entity types, how many calls per period, and whether they can write findings back. Any agent plugs a card in over MCP; the connection is the card, and revoking it kills access instantly.

[![DataHub Hackathon](https://img.shields.io/badge/DataHub-Hackathon-3021ff)](https://devpost.com)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-Instrumented-3021ff)](https://opentelemetry.io)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-blue)](https://modelcontextprotocol.io)

A data steward issues an agent a card instead of an admin token. The agent gets a URL; the server checks every tool call against the card's terms, meters it on a ledger, and refuses out-of-scope work with typed, structured refusals the agent can act on. Revoke the card and the URL dies instantly.

---

## Table of Contents

- [The Idea](#the-idea)
- [How a Data Call Happens](#how-a-data-call-happens)
- [Agent Tools](#agent-tools)
- [Connecting a Card to an Agent](#connecting-a-card-to-an-agent)
- [Card Terms](#card-terms)
- [Sub-Cards & Attenuation](#sub-cards--attenuation)
- [Architecture](#architecture)
- [Deep DataHub Integration](#deep-datahub-integration)
- [Observability](#observability)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Security Model](#security-model)
- [Documentation](#documentation)

---

## The Idea

Agents need catalog context: the right datasets, their lineage, the queries that feed them. The status quo is binary — either an admin token (the agent can read and write everything, forever) or nothing. DataCards applies the model the card industry settled on decades ago:

- **Your DataHub is the account.** Nothing is copied or exported; the agent always reads the live catalog through the server.
- **The card is a policy.** Terms compiled to an enforceable rule set: allowed domains / platforms / entity types / entity URNs / glossary terms, lineage depth, call budget per fixed window, lifetime cap, usage count, expiry, and write-back scope.
- **The agent holds the card, not the keys.** The agent gets an MCP endpoint URL. Behind it, every call is checked against the card's terms and metered — the agent never holds credentials to the catalog.
- **Revoke kills it instantly.** Freeze or revoke a card (or its whole sub-card tree) and every tool call stops, server-side immediately.

```
DataHub catalog   (the account)
   +-- card  (finance domain · 500 calls/day · read-only)   <- issued by the steward
       +-- agent A plugs it in over MCP
       +-- sub-card (one dataset · 50 calls/day)            <- redelegation, narrower terms
           +-- sub-agent B plugs it in
```

**Why DataHub:** the metadata graph is exactly where context for agents should live — and where it should stay guarded. DataCards turns a DataHub deployment into a policy surface: search, lineage, schema, and query knowledge become *metered, auditable, revocable privileges* rather than an all-or-nothing token. Write-back cards close the loop the hackathon track asks for: an agent persists findings as documents, so the next agent inherits the knowledge.

---

## How a Data Call Happens

1. The agent calls a tool on its MCP connection (say `search`). The connection URL encodes a secret card id.
2. The server loads the card and its ancestor chain. Every card must be alive — not frozen, not revoked, not expired (a **liveness** check).
3. The call is validated against every ancestor's budget (each call costs 1 unit): the fixed-window period cap, the lifetime cap, and the usage count. Refusals are typed and structured, not generic errors.
4. The request is **scoped** before it leaves the server: search filters (domains, platforms, entity types, glossary terms) are injected into the upstream GraphQL query, and lineage is capped at the card's depth. Direct URN reads are gated against the fetched entity's facts.
5. On success, the ledger records one debit (idempotent on a retry key — a flaky network can't double-charge), an OpenTelemetry span closes with the tool name and card id, and the response carries the remaining budget so the agent can pace itself.

A refused call looks like this — structured, actionable:

```json
{
  "status": "refused",
  "code": "over_period_limit",
  "message": "this call exceeds the period budget (498/500 used)",
  "detail": { "card_id": "card_8f2c", "remaining_this_period": 2, "period_resets_at": 1786646400 }
}
```

Refusal codes include `card_frozen`, `card_revoked`, `card_expired`, `over_period_limit`, `over_lifetime_limit`, `uses_exhausted`, `entity_not_allowed`, `domain_not_allowed`, `platform_not_allowed`, `entity_type_not_allowed`, `lineage_depth_exceeded`, `invalid_terms`, and `exceeds_parent_terms`.

---

## Agent Tools

The exact set a card exposes matches its terms — the **tool list is the permission surface**. A read-only card never sees `save_document`; a card with `subcards: false` never sees `issue_subcard`.

| Tool | Purpose | Gated by |
|---|---|---|
| `card` | Live state: remaining budget, terms, recent access, sub-cards | always available |
| `search` | Catalog search; results auto-filtered to the card's scope | budget · scope filters |
| `get_entities` | Detailed metadata for up to 10 URNs (schema, platform, domain, owners, tags, glossary terms) | budget · per-URN gate |
| `get_lineage` | Upstream/downstream lineage, depth capped by the card | budget · depth cap · root gate |
| `list_schema_fields` | Dataset columns with types and descriptions | budget · per-URN gate |
| `get_dataset_queries` | Real SQL queries (manual or system) referencing a dataset | budget · per-URN gate |
| `query_data` | Governed SQL preview: scope + PII/sensitive checks (`pii_blocked`) and row-limit enforcement (`row_limit_exceeded`) | budget · scope · governance · maxRows |
| `lineage_check` | Downstream impact summary — what would break if this entity changed | budget · depth cap · root gate |
| `save_document` | Persist findings back to the knowledge base, linked to assets in scope | write-back cards only |
| `card_credentials` | Reveal the Stripe test-mode Visa linked to the card (PAN/expiry/CVC) | spend-budget cards · Stripe configured |
| `fiat_pay` | Buy from the demo shop against the card's spend budget | spend-budget cards · Stripe configured |
| `issue_subcard` | Mint a tighter child card for a sub-agent; returns its connection URL | subcards on · attenuation |
| `revoke_subcard` | Kill a sub-card you issued (descendants die too) | subcards on · ownership |

---

## Connecting a Card to an Agent

```bash
# Lane A: secret in the URL path (works everywhere, treat the URL as a password)
claude mcp add datacards --transport http https://<host>/c/<card-secret>/mcp
```

Lane A works in Claude Code, Cursor, VS Code, Gemini CLI, Windsurf, claude.ai custom connectors, or any MCP client that speaks Streamable HTTP. A self-hosted OAuth 2.1 lane (Lane C) is available for clients that require it: add the bare endpoint, the client discovers the OAuth lane, and the steward grants a card through a browser consent page. Revoking the card kills every token issued for it.

### Buying something with the card (Stripe test-mode lane)

Cards issued with a `budget.spend` term expose `card_credentials` and `fiat_pay` (see [Agent Tools](#agent-tools)) — requires `STRIPE_SECRET_KEY` (test mode) set on the server, see [Environment Variables](#environment-variables). Once connected (Lane A above), the agent can:

```
> use card_credentials to get the test Visa, then fiat_pay $4.90 at the demo shop
```

1. `card_credentials` mints/reveals a Stripe Issuing test-mode Visa (PAN, expiry, CVC) tied to the card.
2. `fiat_pay` checks the card's (and every ancestor's) spend cap, authorizes the charge against Stripe, and books it to the ledger — idempotent on the Stripe authorization id, so a retried call never double-charges.
3. The receipt includes `remaining_spend` and `spend_resets_at` so the agent knows its budget without a second call.

Every dollar is Stripe test money against a test-mode Issuing card — no real funds move. `card_credentials`/`fiat_pay` are absent from the tool list entirely on cards without a `budget.spend` term or when Stripe isn't configured.

---

## Card Terms

The terms vocabulary (validated and normalized at issue time):

| Field | Meaning |
|---|---|
| `scope.domains` | Domain URNs the card may read. Search is filtered; direct reads outside refuse. |
| `scope.platforms` | Platform URNs (snowflake, bigquery, ...) the card may read. |
| `scope.entityTypes` | Entity types allowed (DATASET, DASHBOARD, CHART, CONTAINER, GLOSSARYTERM, DOCUMENT, DATAFLOW, DATAJOB, MLMODEL, ...). |
| `scope.entities` | Explicit entity URN allowlist. Exclusive when no broader rule admits the entity. |
| `scope.glossaryTerms` | Only entities tagged with one of these glossary terms are visible. |
| `scope.lineageDepth` | Max lineage hops, 1–3. 1 is direct only; 3 means the neighborhood. |
| `budget.period` | Calls per fixed window: `{ amount, seconds }`. Resets at start + k·seconds. |
| `budget.lifetime` | Cumulative lifetime call ceiling. Stacks with period. |
| `budget.spend` | USD (in cents) per fixed window for the Stripe test-mode payment lane (shop checkout / `fiat_pay`). Absent = no payments. |
| `mutations` | `"none"` (default, read-only) or `"documents"` (save_document write-back). |
| `expiry` | Unix seconds. The card dies after this. |
| `maxUses` | Total number of tool calls. |
| `subcards` | May this card mint sub-cards? Default true. |
| `maxRows` | Max rows a single `query_data` call may return. Absent = no row cap. |

Every card needs at least one budget cap; scope is optional and an absent scope means full-catalog reads — still budgeted, still expiring, still revocable.

---

## Sub-Cards & Attenuation

An agent with a card can delegate downward with `issue_subcard`. Sub-cards are the enforcement surface's **attenuation** rules, applied at issue time:

- **Scope is subset-only.** A child may not name a domain, platform, entity, glossary term, or depth the parent doesn't already have.
- **Budget inherits capped to remaining.** Omitted child budgets inherit the parent's cap, clamped to what's actually left. Explicit caps must fit inside both the parent's cap and its remaining budget.
- **Mutations only narrow.** A child can take `documents → none`, never the reverse.
- **Expiry never extends.** A child's expiry cannot outlive the parent's.
- **Every child call draws down ancestors.** The ledger walks the whole chain, so a sub-agent can never exceed a budget its parent didn't approve.

---

## Architecture

Bun monorepo, three packages:

```
packages/
  engine/     pure core: policy compiler, scope matching, access pipeline, ledger, SQLite store
  server/     Hono: REST API + per-card MCP endpoint + OAuth lane + OTLP export
  dashboard/  Next.js: admin-token login, card deck, terms composer, activity feed, in-app docs
```

Key pieces:

- **Policy compiler** (`engine/src/policy.ts`): compiles human terms into a normalized, validated `CardPolicy`, and exposes the scope-matching primitives — `scopeAllows` (per-entity gates), `scopeSearchFilters` (search filters injected upstream), `degreeFilterValues` (lineage depth caps), and `attenuate` (sub-card subset rules).
- **Access pipeline** (`engine/src/access.ts`): liveness checks → budget validation across the whole ancestor chain (fixed windows, subtree-wide sums) → scope gating → idempotent ledger debits. The DataCards analog of GlassPay's spend pipeline.
- **DataHub client** (`engine/src/datahub.ts`): a TypeScript port of DataHub's official MCP server — the GraphQL shapes for search, entity details, lineage, dataset queries, and document saving — so the enforcement layer sits directly in front of the real catalog API.
- **Per-card MCP server** (`server/src/mcp/server.ts`): stateless, the tool list derived from the card's terms, every call wrapped in an `mcp_tool_<name>` OpenTelemetry span.
- **SQLite store**: cards, ancestor chains, budget counters, and the access ledger in one file — fixed-window budgets and subtree sums computed there.
- **OAuth lane** (`server/src/oauth/`): a self-hosted OAuth 2.1 authorization server (RFC 9728 discovery, PKCE S256, rotating refresh tokens) for clients that require OAuth; issued tokens are card-scoped and die when the card is revoked.

---

## Deep DataHub Integration

DataCards is not a wrapper around a demo dataset — it reads and writes your **live catalog** through the standard DataHub GMS API. The client (`engine/src/datahub.ts`) is a typed TypeScript port of the GraphQL surface DataHub's official MCP server uses, so the enforcement layer sits directly in front of the real catalog.

**Reads (GraphQL, `/api/graphql`)**

| DataHub surface | Used by | Notes |
|---|---|---|
| `searchAcrossEntities` | `search` | The card's scope is compiled into the upstream query: `types` = the card's entity types, `orFilters` = domains / platforms / glossary terms, `skipHighlighting` for lean payloads. |
| `entity(urn)` (GetEntity) | `get_entities`, `list_schema_fields`, and every per-URN gate | Schema fields, platform, domain, tags, glossary terms, owners, editable description, last ingested. |
| `searchAcrossLineage` | `get_lineage` | The card's lineage depth becomes the `degree` orFilter (`1`, `2`, or `1,2,3+`), mirroring the official server's degree semantics. |
| `listQueries` | `get_dataset_queries` | Real SQL (manual + system) referencing a dataset — join patterns and conventions, not documentation. |
| `me { corpUser }` | authorship | Attribution for write-back (`save_document` author). |

**Auth:** `DATAHUB_GMS_TOKEN` (personal access token) or quickstart-style basic auth (`DATAHUB_USERNAME` / `DATAHUB_PASSWORD`, defaulting to `datahub:datahub`) — the client mints a session token via `/authenticate` and re-mints it for REST calls.

**Write-back (REST ingest, `/entities?action=ingest`):** `save_document` persists a Document — `documentInfo` + `documentSettings` aspects, created under DataHub's shared documents folder and linked to the exact assets the card read — the same flow as the official server's `save_document`, so documents appear in the DataHub UI and in every future agent's search.

**Scope is enforced in three places, not one:** *upstream* (filters injected into the GraphQL query before it leaves the server), *at the boundary* (per-URN gates on every direct read, with typed refusals), and *after the fact* (results filtered by what the card's allowlists can prove is in scope). DataHub never sees an unscoped query — the chain stays the backstop.

---

## Observability

Every tool call is a trace, every refusal is a trace event with its code, every ledger write is a metric. The server ships OpenTelemetry with configurable OTLP export (SigNoz, Grafana, Jaeger — any collector):

- **Traces:** `mcp_tool_<name>` spans with card id, error flag, refusal code, and latency. See which agents burned budget on what, and where.
- **Metrics:** access counts, refusal counts by code, budget consumption per card.
- **Logs:** structured access events with card, tool, target URN, and status — the raw audit trail, also readable in the dashboard's activity feed.

```
agent ── tool call ──> MCP server ── liveness ──> budget (ancestor chain)
                          │
                          ├── scope gates ──> DataHub GraphQL (filtered)
                          │
                          └── ledger debit ──> response + remaining budget
```

---

## Getting Started

Requires [bun](https://bun.sh).

```bash
bun install
cp .env.example .env                       # then fill in:
# DATACARDS_ADMIN_TOKEN=<secret>                 steward bearer token (the dashboard login)
# DATAHUB_GMS_URL=<your DataHub GraphQL>         the catalog the cards read

bun dev                                    # server on :4070
bun run --cwd packages/dashboard dev       # dashboard on :4071
```

Point it at any DataHub instance — including the local quickstart (GMS on `:8080`):

```bash
datahub docker quickstart        # DataHub quickstart with demo data
# then in .env: DATAHUB_GMS_URL=http://localhost:8080
```

Sign in to the dashboard with the admin token and issue a card, or via the API:

```bash
curl -X POST localhost:4070/api/cards \
  -H "Authorization: Bearer $DATACARDS_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "revenue-analyst",
    "terms": {
      "scope": {
        "domains": ["urn:li:domain:finance"],
        "entityTypes": ["DATASET", "DASHBOARD"],
        "glossaryTerms": ["urn:li:glossaryTerm:revenue"],
        "lineageDepth": 2
      },
      "budget": { "period": { "amount": 500, "seconds": 86400 } },
      "mutations": "documents",
      "expiry": 1789488000
    }
  }'
# -> { "card_id": ..., "card_url": "http://localhost:4070/c/<secret>/mcp", ... }
```

Plug the `card_url` into an agent and it can explore your catalog within the card's terms.

## Tests

```bash
bun test                 # engine + server suites
bun run typecheck        # engine + server + dashboard (per-package tsc)
```

---

## Environment Variables

| Var | Required | Purpose |
|---|---|---|
| `DATACARDS_ADMIN_TOKEN` | yes | steward bearer token for the dashboard API (`/api/*`) — the dashboard login is this token |
| `DATAHUB_GMS_URL` | yes | your DataHub GraphQL endpoint |
| `DATAHUB_GMS_TOKEN` / `DATAHUB_USERNAME` / `DATAHUB_PASSWORD` | no | auth for the GMS (bearer, or basic auth defaulting to datahub/datahub) |
| `PORT` | no | server port (default 4070) |
| `DATACARDS_DB_PATH` | no | SQLite path (default `.dev/datacards.sqlite`) |
| `DATACARDS_MASTER_KEY` | no | 64 hex chars; encrypts card secrets at rest so the reveal/rotate features work (unset = hash-only, secrets unrevealable) |
| `DATACARDS_PUBLIC_MCP_BASE` | prod | public origin used when rendering card URLs (unset = localhost) |
| `DATACARDS_CORS_ORIGINS` | no | comma-separated allowed origins for the API |
| `DATACARDS_ALLOWED_HOSTS` | no | extra Host headers accepted on the MCP endpoint (comma-separated) |
| `DATACARDS_MCP_RATE_LIMIT` / `DATACARDS_MCP_BAD_SECRET_LIMIT` | no | per-card and per-IP-bad-secret request ceilings per minute (defaults 240 / 30) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | no | Stripe **TEST-mode** key + webhook secret — enables the demo shop and the payment tools (`card_credentials`, `fiat_pay`); any non-test key disables the lane |
| `DATACARDS_SHOP_RATE_LIMIT` | no | per-IP demo-shop checkout ceiling per minute (default 20) |
| `DATACARDS_DASHBOARD_BASE` | OAuth lane | dashboard origin hosting the OAuth consent page (default `http://localhost:4071`) |
| `DATACARDS_OAUTH_ACCESS_TTL` / `DATACARDS_OAUTH_REFRESH_TTL` | no | OAuth access / refresh token lifetimes in seconds (defaults 3600 / 2592000) |
| `DATACARDS_OAUTH_REDIRECT_HOSTS` | no | if set, restricts OAuth `https` redirect-URI hosts to this allowlist (recommended in prod) |
| `DATACARDS_TRUST_PROXY_HOPS` | no | trusted proxy hops for client-IP rate limiting (default 1) |
| `NEXT_PUBLIC_DATACARDS_API` | dashboard | server API base, e.g. `http://localhost:4070/api` |

OpenTelemetry variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, ...) are documented in `.env.example`.

---

## Security Model

- **Custody**: the catalog stays yours. The agent never holds a DataHub credential — its card URL is checked against the live catalog through the server, and revoked URLs die instantly.
- **Limits enforced twice**: at call time (typed refusals) and at the boundary (search filters and per-URN gates injected into the upstream GraphQL). The chain stays the backstop.
- **Budgets are subtree-wide**: a sub-card's call draws down every ancestor's budget, so a runaway sub-agent can't burn budget a parent never approved.
- **Ledger integrity**: debits are idempotent on a retry key; concurrent calls on one card tree serialize through a per-tree mutex.
- **MCP surface hardening**: per-card and bad-secret rate limits, host allowlist, 1 MiB body cap, secrets never echoed in errors or logs.
- **Revocation layers**: freeze (server, reversible) → revoke (card + subtree, permanent) → delete (purge card and ledger).

---

## Documentation

| Document | Contents |
|---|---|
| [In-app docs](https://github.com/LSUDOKO/GlassPay/tree/main/packages/dashboard/app/docs) | The full reference, in the house style (also served at `/docs`) |
| [docs/devpost-submission.md](docs/devpost-submission.md) | The full Devpost submission package: description, track fit, judging-criteria map, demo video script |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## License

Apache 2.0. See [LICENSE](LICENSE).
