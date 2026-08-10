# ContextCard (DataCards)

**Scoped, revocable context cards that gate what AI agents can see and do inside your DataHub catalog.**

---

## Inspiration

Every team wiring an AI agent into their data catalog hits the same wall. The agent needs context — which datasets exist, how they connect, who owns them, what queries already run against them — and the only way to give it that context today is to hand over an admin token. That token reads everything, forever: finance, HR, customer PII, the lot. There is no middle setting between "full access" and "no access," and no way to take it back short of rotating credentials and hoping the agent's operator actually deleted their copy.

Meanwhile, an ordinary payment card has solved a harder version of this problem for decades. A card is not an account — it is a *policy* pointing at an account. It has a limit, an expiry, a merchant category, a statement showing every use, and a freeze button that works instantly without closing the bank account behind it. You hand someone a card precisely because you are *not* handing them your account.

We wanted that model for metadata. Your DataHub deployment is the account. The card is the policy. The agent holds the card and never touches the keys.

## What it does

A data steward issues an agent a **card** instead of a token. The card's terms are composed in a dashboard: which domains, platforms, entity types, entity URNs and glossary terms it may touch; how many tool calls it may burn per period and over its lifetime; how deep it may walk lineage; how many rows a single query may return; whether it may write findings back; and when it dies.

The agent receives one thing: an MCP endpoint URL. Behind that URL, every tool call is checked against the card's terms, metered on a ledger, and traced. There is no credential to leak because the agent never holds one.

Four things make it more than a permissions wrapper:

**Scope is enforced upstream, not filtered afterwards.** The card's domain, platform, entity-type and glossary-term restrictions are compiled into the `orFilters` of the GraphQL query we send to DataHub. The agent's search never sees out-of-scope entities, because they were never fetched. Direct URN reads are gated separately against the entity's own facts.

**Refusals are typed and structured, not generic errors.** An agent that oversteps gets `domain_not_allowed` with the domain the entity actually belongs to, or `pii_blocked` with the glossary terms that triggered it, or `row_limit_exceeded` telling it the cap and what it asked for. Sixteen refusal codes in total. An agent can read these and correct itself, which is the difference between a guardrail and a wall.

**The catalog's own governance is inherited, not re-implemented.** We never wrote a PII rule into the card model. A table classified as sensitive in DataHub — by tag or glossary term — refuses `query_data` because the catalog already made that judgement and the card respects it.

**The tool list is the permission surface.** A read-only card never sees `save_document`. A card with `subcards: false` never sees `issue_subcard`. A card without a spend budget never sees the payment tools. The agent cannot attempt what it cannot see.

Cards can mint **sub-cards** — an orchestrating agent delegating to a sub-agent — and attenuation is enforced in both directions: a child's scope must be a subset of its parent's, and every call a child makes draws down every ancestor's budget. A lead agent is never surprised by what its delegates spent.

Revoking a card, or nuking its entire sub-card tree, kills every downstream connection server-side, immediately.

We also built the model out past metadata to prove it generalises: a card with a fiat spend budget can mint a real Stripe Issuing test card and make purchases at a demo storefront. When Stripe asks for an authorization decision, our webhook answers from the card's own remaining budget inside Stripe's two-second window. The decline is not the merchant's and not Stripe's — it is the card's terms, enforced in about a second.

## How we built it

A Bun + TypeScript monorepo, three packages, roughly 7,700 lines.

**`engine`** holds the domain core and has no HTTP in it. `policy.ts` compiles the terms a steward writes into a validated, normalized `CardPolicy` and provides the scope-matching helpers. `store.ts` is a `bun:sqlite` store holding users, cards and the charge ledger, plus the accounting math: fixed period windows, subtree-wide budget draw-down, AES-256-GCM envelope encryption for re-viewable card secrets, and idempotent debits keyed so a flaky network retry can never double-charge. `access.ts` is the pipeline — liveness, budget, scope gate, ledger write. `datahub.ts` is a fetch-only DataHub client covering search, entity details, lineage, dataset queries, and REST aspect ingest for write-back.

**`server`** is one Hono process serving four lanes: the MCP Streamable-HTTP endpoint (card-secret and OAuth), the dashboard REST API, a self-hosted OAuth 2.1 authorization server so agent clients can connect the standard way, and the Stripe test-mode lane with its demo storefront. An OpenTelemetry middleware wraps every request in a root span so each tool call, DB query and upstream fetch waterfalls underneath it as one distributed trace.

**`dashboard`** is a Next.js App Router UI where the steward composes terms, watches the access log, and freezes or revokes.

Everything runs locally: a self-hosted DataHub v1.7 quickstart in Docker, the server, the dashboard, and the Stripe CLI forwarding real test-mode webhooks. One script brings the whole stack up and one tears it down, containers and volumes included, so nothing is left behind on the machine.

We took one hard rule on testing: **no mocks anywhere.** The integration suites either run against the real Stripe test API and a real DataHub GMS, or they skip with a message explaining what to set. Nothing is faked, so nothing passes that would fail in reality.

## Challenges we ran into

**The integration only looked finished.** Our DataHub client was written against the documented API shapes and typechecked cleanly, the unit tests passed, and every read path appeared correct. Then we stood up a real DataHub v1.7 and pointed the live suite at it. Eight distinct bugs surfaced within an hour, none of which any amount of local testing would have caught:

- Document write-back posted to `/entities?action=ingest`, the legacy snapshot lane, which rejects aspect-level payloads outright. The correct endpoint is `/aspects?action=ingestProposal`, with the aspect travelling as a JSON *string* under `value`/`contentType`.
- The `documentInfo` aspect needs `contents.text`, `status`, `created` and `lastModified`; a bare `text` field returns 422.
- `ownership { owners { owner { urn ... } } }` is invalid — `OwnerType` is a union, so `urn` has to sit inside each inline fragment.
- Four fields we selected simply don't exist in this version: `schemaMetadata.lastObserved`, `ContainerProperties.lastModified`, `DocumentInfo.text`, and `ListQueriesInput.subjects` (it takes a single `datasetUrn`). `SearchFlagsInput` is really `SearchFlags`.
- `MLModelProperties.name` is the one nullable `name` in the schema, and mixing it into a selection with the non-null ones makes GraphQL reject the *entire* query with a `FieldsConflict`.
- `relatedAssets` entries want `{asset: urn}`, not `{dataset: urn}`.
- **Non-ASCII characters broke every write.** Because the aspect payload rides inside a JSON string field, GMS rejects raw non-ASCII there with a request-level 400 — a `charset` header makes no difference. A single em dash in an agent's findings killed the whole document. Since LLM-written prose is full of em dashes and smart quotes, this would have failed constantly in real use and only under exactly the conditions a demo produces. The fix is to `\uXXXX`-escape the aspect JSON.
- The shared parent folder sent `parentDocument: null`, which fails validation — and a `.catch(() => {})` swallowed the error silently, so the folder sat titled "Untitled" forever with no sign anything was wrong.

There was a ninth, and it is the one that stung: our live test suite imported `DataHubClient` with a `type` import. That erases at runtime, so the factory call threw a `ReferenceError` and the entire DataHub suite reported as *skipped* rather than failed. The tests we were counting on to catch all of the above had been quietly not running.

**Self-hosting DataHub taught us its auth model the hard way.** Disabling metadata-service auth to skip the token dance breaks the UI login entirely, because the frontend signs a user in by asking GMS to mint a session token and GMS refuses to do that when auth is off. Turning it back on then failed with `WeakKeyException: the signing key's size is 168 bits` — HS256 needs at least 256. And the local `stripe listen` signs webhooks with the CLI's own secret, not the dashboard endpoint secret; using the wrong one fails every signature check silently enough to look like the webhook never arrived.

**Getting concurrency right on a budget check.** Two tool calls arriving simultaneously against the same card must not both pass a budget check that only one of them can afford. We serialize per card tree with a keyed mutex, and made every debit idempotent so the Stripe webhook racing our own `fiat_pay` for the same authorization resolves as a replay rather than a double charge.

## Accomplishments that we're proud of

**The refusals are the product, and they work against a real catalog.** Watching an agent ask for a PII-classified table and get back a structured `pii_blocked` that names the exact glossary terms — from a rule we never wrote, inherited straight from DataHub's own governance — is the moment the whole idea justifies itself.

**No mocks, and the suite is green.** 55 engine tests and 23 server tests, zero failures and zero skips, with the server suite running against the real Stripe test API and a real DataHub GMS. Real Stripe Issuing authorizations approved in budget and declined over it, by our webhook, inside Stripe's window.

**Scope enforcement that actually pushes down.** A card scoped to one domain sees 4 of 64 catalog entities, and those 60 were never fetched. That is a genuinely different security property from filtering a full result set after the fact.

**The whole thing runs on a laptop and leaves nothing behind.** Self-hosted DataHub, server, dashboard and payment lane, up with one command and gone with another — containers, volumes, caches and generated config included.

**Sub-card attenuation that is actually sound.** Getting delegation right is subtle: because scope dimensions match as an OR, a child that merely *drops* a parent restriction would silently widen its reach. Children inherit every dimension the parent restricts, may not introduce a dimension the parent doesn't restrict, and must be a subset where they overlap.

## What we learned

**Typechecking and unit tests certify your assumptions, not reality.** Every one of those nine bugs lived in the gap between the API we assumed and the API that answers on port 8081. Nothing but a real instance was ever going to close it.

**Introspection beats documentation.** Once we started asking the running GMS what its schema actually was rather than reading about it, fixes went from guesswork to a single query. Docs describe a version; introspection describes *your* version.

**A skipped test is worse than a failing one.** A failure is loud. A skip looks like a deliberate choice you made earlier, and it hid a completely broken integration behind a reassuring green summary.

**Never swallow an error you can't see the consequences of.** `.catch(() => {})` on the folder write cost us more debugging time than the bug deserved, because the only symptom was a slightly wrong word in a UI.

**Structured refusals change how an agent behaves.** With a generic 403, an agent retries or invents an answer. Given a code, a reason and the relevant facts, it explains the boundary to the user and works within it. Error design is agent UX.

## What's next for ContextCard

**Horizontal scale.** Budget correctness currently rests on a single sqlite file and an in-process mutex, which is right for a single instance and wrong for a fleet. Moving the ledger to Postgres and the per-tree lock to advisory locks or Redis is the first real production step.

**Unify the two enforcement points.** Search filters compose scope dimensions with AND upstream, while the direct-URN gate matches them with OR. That means a URN read can be admitted on a dimension search would have excluded. We want one semantics, chosen deliberately and enforced identically in both places.

**Real query execution.** `query_data` is honest about being a schema-backed preview because no warehouse is attached. Wiring it to an actual engine — with the row cap and PII gate already in place doing the governing — turns it from a preview into a genuinely governed query lane.

**Column-level scope.** DataHub already models schema fields and field-level glossary terms. A card that grants a table but masks three columns is a natural next term, and the metadata to enforce it is already there.

**Anomaly detection on the ledger.** Every call is already recorded with tool, target, timestamp and card. Fraud detection is the other half of what makes cards work in the real world, and the data to do it is sitting in the charges table.

**CI, and a public test catalog.** The live suites need to run on every commit against a disposable DataHub, so the class of bug we spent this hackathon finding gets caught by a machine next time instead of by us.
