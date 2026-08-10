# Examples

Real artifacts captured from a running stack — a self-hosted DataHub v1.7 quickstart,
the DataCards server, and Stripe test mode. Nothing here is illustrative or hand-written:
every response was produced by the code in this repository and pasted in verbatim.

The catalog behind these examples is DataHub's own sample data (64 entities), organised
into two domains — `urn:li:domain:finance` (4 assets) and `urn:li:domain:marketing` —
with `fct_users_deleted` and `logging_events` carrying `urn:li:tag:PII`.

## `card-terms/`

The terms a steward composes. These are the input to the policy compiler
(`packages/engine/src/policy.ts`), which normalizes and validates them into a `CardPolicy`.

| File | What it demonstrates |
|---|---|
| `finance-analyst.json` | Domain scope, daily call budget, lineage depth, row cap, write-back |
| `spend-capped.json` | A fiat spend budget, which is what unlocks the payment tools |
| `subcard-attenuated.json` | A child card, narrower than its parent on every dimension |

## `refusals/`

The typed, structured refusals an agent receives when it oversteps. Each names the
dimension that refused and carries the facts the agent needs to correct itself — which is
the difference between a guardrail an agent can work with and an opaque 403.

| File | Code | Triggered by |
|---|---|---|
| `domain-not-allowed.json` | `domain_not_allowed` | Reading a Marketing dataset with a Finance-scoped card |
| `pii-blocked.json` | `pii_blocked` | Querying a table DataHub classifies as PII |
| `row-limit-exceeded.json` | `row_limit_exceeded` | `LIMIT 5000` against a 100-row card |
| `over-spend-limit.json` | `over_spend_limit` | A $4.90 purchase on a $3.00/day card |

The full set of codes is in `packages/engine/src/errors.ts`: `card_frozen`, `card_revoked`,
`card_expired`, `over_period_limit`, `over_lifetime_limit`, `uses_exhausted`,
`entity_not_allowed`, `domain_not_allowed`, `platform_not_allowed`,
`entity_type_not_allowed`, `lineage_depth_exceeded`, `invalid_terms`,
`exceeds_parent_terms`, `no_spend_budget`, `over_spend_limit`, `pii_blocked`,
`row_limit_exceeded`.

## `tool-output/`

Successful MCP tool responses. Note the `budget` tail on each: every answer tells the agent
what it has left, so it can pace itself rather than discovering exhaustion by failing.

| File | Tool | Worth noticing |
|---|---|---|
| `search-scoped.json` | `search` | 4 results from a 64-entity catalog — the other 60 were never fetched, because the card's scope was compiled into the upstream GraphQL `orFilters` |
| `query-data-preview.json` | `query_data` | Schema-backed column preview with the card's row cap applied |
| `save-document.json` | `save_document` | Write-back returning the new DataHub document URN |
| `card-status.json` | `card` | What an agent learns when it asks its own card what it may do |

## `datahub-artifacts/`

What the agent leaves behind in the catalog — the loop closing.

| File | What it is |
|---|---|
| `agent-authored-document.json` | A Document entity written back by an agent, read out of DataHub via GraphQL, linked to the dataset it analyses |

## Reproducing these

```bash
./scripts/local.sh up        # self-hosted DataHub
./scripts/local.sh dev       # server :4070 + dashboard :4071
./scripts/local.sh stripe    # Stripe webhook forwarding (payment examples only)

# issue a card, then drive it:
bun scripts/mcp-call.ts "$CARD_URL" search '{"query":"*","count":10}'
```
