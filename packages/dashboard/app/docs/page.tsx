"use client";

// /docs: the reference, in the house style. A quiet left TOC rail (scroll-spy,
// theme toggle + back-to-app at the foot) beside one prose column. Public route,
// no auth: documentation reads the same signed-in or out. Everything here is
// grounded in the actual engine/server/dashboard code, not aspirational.

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { ThemeToggle } from "../components/Theme";
import { IconCheck, IconCopy, copyText } from "../components/ui";

// ---------------------------------------------------------------------------
// Table of contents: grouped into proper sections (drives the nav). The groups
// follow the body's reading order exactly, so the scroll-spy and the clicks
// never jump out of sequence.
// ---------------------------------------------------------------------------

const NAV: { group: string; items: { id: string; label: string }[] }[] = [
  {
    group: "Concepts",
    items: [
      { id: "overview", label: "Overview" },
      { id: "lifecycle", label: "How a Data Call Happens" },
      { id: "enforcement", label: "Enforcement & Refusals" },
    ],
  },
  {
    group: "Cards",
    items: [
      { id: "issuing", label: "Issuing a Card" },
      { id: "terms", label: "Card Terms" },
      { id: "subcards", label: "Sub-Cards & Attenuation" },
    ],
  },
  {
    group: "Connect",
    items: [
      { id: "connect", label: "Connecting an Agent" },
      { id: "tools", label: "MCP Tools" },
      { id: "auth", label: "Auth & Connection URLs" },
    ],
  },
  {
    group: "Operations",
    items: [
      { id: "observability", label: "Observability" },
      { id: "api", label: "REST API" },
      { id: "selfhost", label: "Self-Hosting" },
    ],
  },
];
const FLAT = NAV.flatMap((g) => g.items);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Code({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="doccode">
      <pre>{code}</pre>
      <button
        className={`doccopy${done ? " done" : ""}`}
        aria-label="Copy to clipboard"
        title="Copy"
        onClick={async () => {
          if (await copyText(code)) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        }}
      >
        {done ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="doctablewrap">
      <table className="doctable">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Note({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <div className={`docnote${warn ? " warn" : ""}`}>
      <span className="ni" aria-hidden>
        {warn ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.6 15 13.5H1z" />
            <path d="M8 6.2v3.6M8 11.6v.1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6.6" />
            <path d="M8 7.4v4M8 4.7v.1" />
          </svg>
        )}
      </span>
      <p>{children}</p>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="docsec" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const [active, setActive] = useState(FLAT[0].id);

  // scroll-spy: highlight the section whose top sits in the upper band of the viewport
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-12% 0px -72% 0px", threshold: 0 },
    );
    for (const s of FLAT) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  return (
    <div className="docs">
      {/* the aurora: subtle page weather behind the chrome */}
      <div className="docaurora" aria-hidden>
        <i className="docbeamA" />
        <i className="docbeamB" />
        <i className="docbeamC" />
      </div>
      <aside className="docnav">
        <Link className="brand" href="/">
          DataCards
        </Link>
        <span className="docnavlabel">Documentation</span>
        <nav className="docnavlist">
          {NAV.map((g) => (
            <Fragment key={g.group}>
              <div className="docnavgroup">{g.group}</div>
              {g.items.map((s) => (
                <a key={s.id} className={`docnavitem${active === s.id ? " on" : ""}`} href={`#${s.id}`}>
                  {s.label}
                </a>
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="docnavfoot">
          <ThemeToggle />
          <Link className="docback" href="/">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span>Open the App</span>
          </Link>
        </div>
      </aside>

      <main className="docbody">
        <div className="docwrap">
          {/* hero */}
          <header className="dochero">
            <span className="doceyebrow">The context card for agents</span>
            <h1>Documentation</h1>
            <p className="docsub">
              DataCards issues scoped, revocable access cards that gate what an AI agent can see and do inside a
              DataHub catalog — which domains, platforms and entity types, how many calls per period, and whether it
              can write findings back. Any agent plugs a card in over MCP; the connection is the card, and revoking it
              kills access instantly.
            </p>
          </header>

          {/* ---- Overview ---- */}
          <Section id="overview" title="Overview">
            <p className="docp">
              Agents need catalog context: the right datasets, their lineage, the queries that feed them. Handing an
              agent an admin token to the whole metadata graph is reckless — one bad instruction and it reads, or
              writes, everything. DataCards takes the model the card industry settled on decades ago and applies it to
              metadata access: the data steward stays the owner, and the agent gets a <b>card</b>, a scoped authority
              to draw from the catalog.
            </p>
            <ul className="docul">
              <li className="docli">
                <b>Your DataHub is the account.</b> Nothing is copied or exported; the agent always reads the live
                catalog through the server.
              </li>
              <li className="docli">
                <b>The card is a policy.</b> Terms compiled to an enforceable rule set: allowed domains / platforms /
                entity types / entity URNs / glossary terms, lineage depth, call budget per fixed window, lifetime
                cap, usage count, expiry, and write-back scope.
              </li>
              <li className="docli">
                <b>The agent holds the card, not the keys.</b> What the agent gets is an MCP endpoint URL. Behind it,
                every call is checked against the card's terms and metered on a ledger — the agent never holds
                credentials to the catalog.
              </li>
              <li className="docli">
                <b>Revoke kills it instantly.</b> Freeze or revoke a card (or its whole sub-card tree) and every tool
                call stops, server-side immediately.
              </li>
            </ul>

            <div className="docdiagram">
              {`DataHub catalog   `}<span className="mut">(the account)</span>{`
   └── `}<b>card</b>{`   `}<span className="mut">finance domain · 500 calls/day · read-only</span>{`    ← issued by the steward
        ├── agent A plugs it in over MCP
        └── `}<b>sub-card</b>{`   `}<span className="mut">one dataset · 50 calls/day</span>{`   ← redelegation, narrower terms
             └── sub-agent B plugs it in`}
            </div>

            <p className="docp">
              DataCards is a fork of GlassPay — an agentic spending-card system — re-aimed at metadata. The same
              enforcement shape applies: typed refusals instead of silent failures, a metered ledger, sub-card
              attenuation, and OpenTelemetry traces for every tool call. It plugs into any DataHub deployment through
              the standard GraphQL API.
            </p>

            <div className="docfacts">
              <div className="docfact">
                <div className="fk">Dashboard</div>
                <div className="fv">
                  <span>datacards (your deployment)</span>
                </div>
              </div>
              <div className="docfact">
                <div className="fk">API + MCP</div>
                <div className="fv">
                  <span>datacards-api (your deployment)</span>
                </div>
              </div>
              <div className="docfact">
                <div className="fk">Data source</div>
                <div className="fv">
                  <span>your DataHub GMS (GraphQL)</span>
                </div>
              </div>
            </div>
          </Section>

          {/* ---- Lifecycle ---- */}
          <Section id="lifecycle" title="How a Data Call Happens">
            <p className="docp">One agent tool call, end to end:</p>
            <ol className="docul">
              <li className="docli">
                The agent calls a tool on its MCP connection (say <span className="code">search</span>). The
                connection URL encodes a secret card id.
              </li>
              <li className="docli">
                The server loads the card and its ancestor chain. Every card in the chain must be alive: not frozen,
                not revoked, not expired — a <b>liveness</b> check.
              </li>
              <li className="docli">
                The call is validated against every ancestor's budget (each costs 1 unit): the fixed-window period
                cap, the lifetime cap, and the usage count. Refusals are typed and structured, not generic errors.
              </li>
              <li className="docli">
                The request is <b>scoped</b> before it ever leaves the server: search filters (domains, platforms,
                entity types, glossary terms) are injected into the upstream GraphQL query, and lineage is capped at
                the card's depth. Direct URN reads are gated against the fetched entity's facts.
              </li>
              <li className="docli">
                On success the ledger records one debit against the card (idempotent on a retry key, so a flaky
                network can't double-charge), an OpenTelemetry span closes with the tool name and card id, and the
                response carries the remaining budget so the agent can pace itself.
              </li>
            </ol>

            <div className="docdiagram">
              {`agent ── tool call ──> MCP server ── liveness ──> budget (ancestor chain)
                                      │
                                      ├── scope gates ──> DataHub GraphQL (filtered)
                                      │
                                      └── ledger debit ──> response + remaining budget`}
            </div>
          </Section>

          {/* ---- Enforcement ---- */}
          <Section id="enforcement" title="Enforcement & Refusals">
            <p className="docp">
              A refused call is not an error blob — it is a structured refusal naming the violated term, so the agent
              can explain itself and adapt. The MCP response carries <span className="code">isError: true</span> and a
              JSON body like this:
            </p>
            <Code
              code={`{
  "status": "refused",
  "code": "over_period_limit",
  "message": "this call exceeds the period budget (498/500 used)",
  "detail": {
    "card_id": "card_8f2c",
    "remaining_this_period": 2,
    "period_resets_at": 1786646400
  }
}`}
            />
            <p className="docp">The refusal codes the engine emits:</p>
            <Table
              head={["Code", "Meaning"]}
              rows={[
                [<span key="1" className="code">card_frozen</span>, "The card (or an ancestor) was frozen by the steward. Only `card` still answers."],
                [<span key="2" className="code">card_revoked</span>, "The card or an ancestor was revoked. The connection is dead."],
                [<span key="3" className="code">card_expired</span>, "The card's expiry passed."],
                [<span key="4" className="code">over_period_limit</span>, "The call would exceed the card's budget for this fixed window."],
                [<span key="5" className="code">over_lifetime_limit</span>, "The call would exceed the card's cumulative lifetime budget."],
                [<span key="6" className="code">uses_exhausted</span>, "The card's total call count is spent."],
                [<span key="7" className="code">entity_not_allowed</span>, "The entity URN is outside the card's scope (or doesn't exist)."],
                [<span key="8" className="code">domain_not_allowed</span>, "The entity lives in a domain the card may not read."],
                [<span key="9" className="code">platform_not_allowed</span>, "The entity's platform is not in the card's scope."],
                [<span key="10" className="code">entity_type_not_allowed</span>, "The entity's type (e.g. MLMODEL) is not in the card's scope."],
                [<span key="11" className="code">lineage_depth_exceeded</span>, "The request asked for more lineage hops than the card allows."],
                [<span key="12" className="code">invalid_terms</span>, "The card's terms failed validation."],
                [<span key="13" className="code">exceeds_parent_terms</span>, "A sub-card tried to exceed its parent's scope or budget."],
              ]}
            />
            <Note>
              Budget checks walk the whole ancestor chain — a sub-card's call draws down its parent's budget too.
              That is what keeps a runaway sub-agent from burning through a budget its parent never approved.
            </Note>
          </Section>

          {/* ---- Issuing ---- */}
          <Section id="issuing" title="Issuing a Card">
            <p className="docp">
              The steward issues a card from the dashboard: name the agent's mission, compose the scope (domains,
              platforms, entity types, specific URNs, glossary terms), set the budget (calls per window, lifetime
              cap, expiry), and choose whether the card may write documents back. Issuing is one REST call:
            </p>
            <Code
              code={`POST /api/cards
Authorization: Bearer <DATACARDS_ADMIN_TOKEN>

{
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
}

→ 201 {
  "card_id": "card_8f2c",
  "card_url": "https://datacards.example/c/secret…/mcp",
  "terms": { …compiled terms… }
}`}
            />
            <p className="docp">
              The response's <span className="code">card_url</span> is the only thing the agent ever needs. Paste it
              into Claude Code, Cursor, or any MCP client — the server surfaces the tool list <i>from the card's
              terms</i>.
            </p>
            <Note warn>
              The connection URL embeds the card secret. Treat it like a card number: share it only with the agent
              that should hold the card, and rotate by issuing a fresh card.
            </Note>
          </Section>

          {/* ---- Terms ---- */}
          <Section id="terms" title="Card Terms">
            <p className="docp">The terms vocabulary (the <span className="code">terms_json</span> in the engine's card table):</p>
            <Table
              head={["Field", "Meaning"]}
              rows={[
                [<span key="1" className="code">scope.domains</span>, "Domain URNs the card may read. Search is filtered; direct reads outside refuse."],
                [<span key="2" className="code">scope.platforms</span>, "Platform URNs (snowflake, bigquery, …) the card may read."],
                [<span key="3" className="code">scope.entityTypes</span>, "Entity types allowed (DATASET, DASHBOARD, CHART, CONTAINER, GLOSSARYTERM, DOCUMENT, DATAFLOW, DATAJOB, MLMODEL, …)."],
                [<span key="4" className="code">scope.entities</span>, "Explicit entity URN allowlist. Exclusive when no broader rule admits the entity."],
                [<span key="5" className="code">scope.glossaryTerms</span>, "Only entities tagged with one of these glossary terms are visible."],
                [<span key="6" className="code">scope.lineageDepth</span>, "Max lineage hops, 1–3. 1 is direct only; 3 means the neighborhood."],
                [<span key="7" className="code">budget.period</span>, "Calls per fixed window: { amount, seconds }. Resets at start + k·seconds."],
                [<span key="8" className="code">budget.lifetime</span>, "Cumulative lifetime call ceiling. Stacks with period."],
                [<span key="8b" className="code">budget.spend</span>, "USD (in cents) per fixed window for the Stripe test-mode payment lane (shop checkout / fiat_pay). Absent = no payments."],
                [<span key="9" className="code">mutations</span>, "\"none\" (default, read-only) or \"documents\" (save_document write-back)."],
                [<span key="10" className="code">expiry</span>, "Unix seconds. The card dies after this."],
                [<span key="11" className="code">maxUses</span>, "Total number of tool calls."],
                [<span key="12" className="code">subcards</span>, "May this card mint sub-cards? Default true."],
                [<span key="13" className="code">maxRows</span>, "Max rows a single query_data call may return. Absent = no row cap."],
              ]}
            />
            <p className="docp">
              Every card needs at least one budget cap (<span className="code">budget.period</span> and/or{" "}
              <span className="code">budget.lifetime</span>); scope is optional and an absent scope means full-catalog
              reads — still budgeted, still expiring, still revocable. All URNs are normalized (lowercased, deduped)
              at compile time and validated before a card is stored.
            </p>
          </Section>

          {/* ---- Sub-cards ---- */}
          <Section id="subcards" title="Sub-Cards & Attenuation">
            <p className="docp">
              An agent with a card can delegate downward: <span className="code">issue_subcard</span> mints a tighter
              card for a sub-agent. Sub-cards are the enforcement surface's <b>attenuation</b> rules, applied at
              issue time:
            </p>
            <ul className="docul">
              <li className="docli">
                <b>Scope is subset-only and restriction-inheriting.</b> A child may not name a domain, platform,
                entity, glossary term, or depth the parent doesn't already have — and any restriction the parent
                carries that the child omits is inherited, so a sub-card can never be wider than its parent.
              </li>
              <li className="docli">
                <b>Budget inherits capped to remaining.</b> Omitted child budgets inherit the parent's cap, clamped to
                what's actually left. Explicit caps must fit inside both the parent's cap and its remaining budget.
              </li>
              <li className="docli">
                <b>Mutations only narrow.</b> A child can take <span className="code">documents → none</span>, never
                the reverse. Write-back is never silently inherited.
              </li>
              <li className="docli">
                <b>Expiry never extends.</b> A child's expiry cannot outlive the parent's.
              </li>
              <li className="docli">
                <b>Every child call draws down ancestors.</b> The ledger walks the whole chain, so a sub-agent can
                never exceed a budget its parent didn't approve.
              </li>
            </ul>
            <div className="docdiagram">
              {`card  finance · 500/day`}{`
   └── sub-card  one dataset · 50/day
        └── sub-sub-card  · read-only · 10/day   ← each step narrower, never wider`}
            </div>
            <p className="docp">
              A parent can kill any direct sub-card with <span className="code">revoke_subcard</span> — descendants
              die with it. The steward's dashboard can freeze, revoke, or delete any card in the tree.
            </p>
          </Section>

          {/* ---- Connect ---- */}
          <Section id="connect" title="Connecting an Agent">
            <p className="docp">
              The agent connects with the card URL, exactly like any other MCP server:
            </p>
            <Code
              code={`claude mcp add datacards --transport http https://datacards.example/c/card_8f2c_<secret>/mcp`}
            />
            <p className="docp">
              At <span className="code">initialize</span> the server reports its tool list — derived from this card's
              terms. A read-only card never sees <span className="code">save_document</span>; a card with{" "}
              <span className="code">subcards: false</span> never sees <span className="code">issue_subcard</span>.
              The tool list <i>is</i> the permission surface. The server also embeds instructions that route the agent
              to the right tool for its first move, and most clients index that text for tool search.
            </p>
          </Section>

          {/* ---- Tools ---- */}
          <Section id="tools" title="MCP Tools">
            <Table
              head={["Tool", "What it does", "Gated by"]}
              rows={[
                [<span key="1" className="code">card</span>, "Live state: remaining budget, terms, recent access log, sub-cards.", "always available"],
                [<span key="2" className="code">search</span>, "Catalog search; results auto-filtered to the card's scope.", "budget · scope filters"],
                [<span key="3" className="code">get_entities</span>, "Detailed metadata for up to 10 URNs (schema, platform, domain, owners, tags, glossary terms).", "budget · per-URN gate"],
                [<span key="4" className="code">get_lineage</span>, "Upstream/downstream lineage, depth capped by the card.", "budget · depth cap · root gate"],
                [<span key="5" className="code">list_schema_fields</span>, "Dataset columns with types and descriptions; optional keyword filter.", "budget · per-URN gate"],
                [<span key="6" className="code">get_dataset_queries</span>, "Real SQL queries (manual or system) referencing a dataset.", "budget · per-URN gate"],
                [<span key="6b" className="code">query_data</span>, "Governed SQL preview: scope + PII/sensitive checks (refusal pii_blocked) and row-limit enforcement (row_limit_exceeded).", "budget · scope · governance · maxRows"],
                [<span key="6c" className="code">lineage_check</span>, "Downstream impact summary — what would break if this entity changed.", "budget · depth cap · root gate"],
                [<span key="7" className="code">save_document</span>, "Persist findings back to the knowledge base, linked to assets in scope.", "write-back cards only · per-URN gate"],
                [<span key="7b" className="code">card_credentials</span>, "Reveal the Stripe test-mode Visa linked to the card (PAN/expiry/CVC).", "spend-budget cards · Stripe configured"],
                [<span key="7c" className="code">fiat_pay</span>, "Buy from the demo shop against the card's spend budget.", "spend-budget cards · Stripe configured"],
                [<span key="8" className="code">issue_subcard</span>, "Mint a tighter child card; returns its connection URL.", "subcards on · attenuation"],
                [<span key="9" className="code">revoke_subcard</span>, "Kill a sub-card you issued (descendants die too).", "subcards on · ownership"],
              ]}
            />
            <p className="docp">
              Every call is wrapped in an <span className="code">mcp_tool_&lt;name&gt;</span> OpenTelemetry span with
              the tool name, card id, error flag, and refusal code as attributes — the activity feed in the dashboard
              and your OTLP collector read the same events.
            </p>
          </Section>

          {/* ---- Auth ---- */}
          <Section id="auth" title="Auth & Connection URLs">
            <p className="docp">
              Two auth surfaces, deliberately different:
            </p>
            <ul className="docul">
              <li className="docli">
                <b>Stewards (the dashboard)</b> sign in with the server's admin token
                (<span className="code">DATACARDS_ADMIN_TOKEN</span>), sent as a bearer token on every API call —
                or with a self-hosted OAuth 2.1 authorization-code flow when configured.
              </li>
              <li className="docli">
                <b>Agents (MCP)</b> authenticate with the card URL's secret. The server resolves the card, checks
                liveness, and answers only within the card's terms. No agent ever sees a DataHub credential.
              </li>
            </ul>
            <Note>
              The card secret is the agent's whole identity. There is deliberately no second factor and no session:
              if the secret leaks, revoke the card — the URL dies instantly, no key rotation anywhere.
            </Note>
          </Section>

          {/* ---- Observability ---- */}
          <Section id="observability" title="Observability">
            <p className="docp">
              Every tool call is a trace, every refusal is a trace event with its code, every ledger write is a
              metric. The server ships OpenTelemetry with configurable OTLP export (SigNoz, Grafana, Jaeger — any
              collector). What you get:
            </p>
            <ul className="docul">
              <li className="docli">
                <b>Traces:</b> <span className="code">mcp_tool_&lt;name&gt;</span> spans with card id, error flag,
                refusal code, and latency. See which agents burned budget on what, and where.
              </li>
              <li className="docli">
                <b>Metrics:</b> access counts, refusal counts by code, budget consumption per card.
              </li>
              <li className="docli">
                <b>Logs:</b> structured access events with card, tool, target URN, and status — the raw audit trail
                for every card, queryable in the dashboard's activity feed.
              </li>
            </ul>
          </Section>

          {/* ---- REST API ---- */}
          <Section id="api" title="REST API">
            <p className="docp">The dashboard speaks to the same HTTP surface you can curl:</p>
            <Table
              head={["Route", "Method", "Purpose"]}
              rows={[
                [<span key="1" className="code">/api/*</span>, "Bearer", "Every dashboard call carries the admin token (DATACARDS_ADMIN_TOKEN) as a bearer header."],
                [<span key="2" className="code">/api/cards</span>, "GET", "List the card tree (all cards, parents and sub-cards)."],
                [<span key="3" className="code">/api/cards</span>, "POST", "Issue a card from terms JSON."],
                [<span key="4" className="code">/api/cards/:id</span>, "GET", "One card's live state + activity."],
                [<span key="5" className="code">/api/cards/:id/freeze · /unfreeze</span>, "POST", "Toggle the card (and its tree) off/on. `card` still answers."],
                [<span key="6" className="code">/api/cards/:id/revoke</span>, "POST", "Revoke the card and its descendants. URL dies instantly."],
                [<span key="7" className="code">/api/cards/:id/rotate</span>, "POST", "Mint a new secret for the same card (URL changes, terms don't)."],
                [<span key="8" className="code">/api/cards/:id</span>, "DELETE", "Purge the card and its ledger rows."],
                [<span key="9" className="code">/api/me</span>, "GET", "DataHub reachability + the connected user (also /health on the bare root)."],
              ]}
            />
            <p className="docp">
              Every response carries the card's remaining budget where relevant, and every mutation is recorded in
              the same access log the agents produce — the steward's dashboard shows humans and agents on one ledger.
            </p>
          </Section>

          {/* ---- Self-host ---- */}
          <Section id="selfhost" title="Self-Hosting">
            <p className="docp">Three processes, one <span className="code">DATAHUB_GMS_URL</span> pointing at your DataHub GMS:</p>
            <ul className="docul">
              <li className="docli">
                <b>datacards-api</b> — the Hono server: REST API, MCP endpoint, OAuth, OTLP export. Storage is a
                SQLite file (set <span className="code">DATACARDS_DB_PATH</span>); budget windows and ledger are
                computed there.
              </li>
              <li className="docli">
                <b>datacards dashboard</b> — the Next.js app (admin token login, card deck, terms composer, activity
                feed). Set <span className="code">NEXT_PUBLIC_DATACARDS_API</span> and the server's admin token.
              </li>
              <li className="docli">
                <b>DataHub</b> — your existing GMS. The server only ever talks to it through GraphQL, with scopes
                injected upstream.
              </li>
            </ul>
            <Code
              code={`# server
DATACARDS_ADMIN_TOKEN=…          # steward bearer token (the dashboard login)
DATAHUB_GMS_URL=https://datahub.example/graphql
DATACARDS_PUBLIC_MCP_BASE=https://datacards.example   # mints card URLs
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 # optional
DATACARDS_DB_PATH=./datacards.db`}
            />
            <Note>
              MCP is transport-agnostic: the same server answers HTTP (<span className="code">/c/:id/mcp</span>) and,
              when mounted in-process, streamable HTTP or stdio — so a card can be handed to a local CLI agent with
              nothing but a URL.
            </Note>
          </Section>

          <hr className="docrule" />
          <p className="docp mut">
            DataCards · built for the DataHub Agent Hackathon · forked from GlassPay, the agentic spending-card
            system.
          </p>
        </div>
      </main>
    </div>
  );
}
