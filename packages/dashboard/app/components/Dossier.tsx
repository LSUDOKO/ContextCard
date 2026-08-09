"use client";

// The dossier for the selected card: status + verbs (connect / freeze / revoke /
// rotate / delete), the remaining-budget readings with a gauge, the scope term
// sheet, the sub-card rows, and the access feed beneath.

import { useState } from "react";
import type { AccessEntry, CardState, TreeNode } from "@/lib/api";
import { api } from "@/lib/api";
import { Activity, type FeedRow } from "./Activity";
import { ConnectOverlay } from "./ConnectOverlay";
import { fmtCountdown, IconRevoke, IconSnowflake, isDead, shortHex } from "./ui";

type DossierProps = {
  node: TreeNode | null;
  feed: FeedRow[];
  onRefresh: () => void | Promise<void>;
  onIssue: () => void;
};

export function Dossier({ node, feed, onRefresh, onIssue }: DossierProps) {
  const [connectOpen, setConnectOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!node) {
    return (
      <div className="dossier">
        <div className="dhead">
          <div>
            <div className="dtitle">No cards yet</div>
            <div className="dsub">Issue an access card, hand its URL to an agent, watch every call land here.</div>
          </div>
          <button className="dbtn" onClick={onIssue} data-testid="issue-first">
            Issue Your First Card
          </button>
        </div>
        <div className="readings">
          <p className="statline">The deck is empty · every agent's context access starts as a card.</p>
        </div>
        <div className="panes">
          <div className="pane">
            <div className="paneh">Activity</div>
            <Activity feed={feed} empty="No calls yet." />
          </div>
        </div>
      </div>
    );
  }

  const card = node.card;
  const dead = isDead(card.status);
  const remaining = card.remaining_this_period ?? card.remaining_lifetime;
  const cap =
    card.terms.budget?.period?.amount ??
    card.terms.budget?.lifetime?.amount ??
    (card.remaining_lifetime !== null && card.remaining_this_period === null ? card.remaining_lifetime : null);
  const pct = cap && remaining !== null ? Math.min(100, (remaining / cap) * 100) : 100;
  const verbs = (
    <>
      <button className="vpill" disabled={dead} onClick={() => void openConnect()} data-testid="connect">
        Connect Agent
      </button>
      {card.status === "frozen" ? (
        <button className="vpill" onClick={() => void act(() => api.unfreeze(card.card_id))} data-testid="unfreeze">
          Unfreeze
        </button>
      ) : (
        <button className="vpill" disabled={dead} onClick={() => void act(() => api.freeze(card.card_id))} data-testid="freeze">
          <IconSnowflake size={13} />
          Freeze
        </button>
      )}
      <button className="vpill danger" disabled={dead} onClick={() => void act(() => api.revoke(card.card_id))} data-testid="revoke">
        <IconRevoke size={13} />
        Revoke
      </button>
      <button className="vpill" disabled={dead} onClick={() => void act(() => api.rotate(card.card_id))} data-testid="rotate">
        Rotate URL
      </button>
      {dead && (
        <button className="vpill danger stay" onClick={() => void act(() => api.deleteCard(card.card_id))} data-testid="delete-card">
          Delete Card
        </button>
      )}
    </>
  );

  async function openConnect() {
    setErr(null);
    setBusy(true);
    try {
      const r = await api.url(card.card_id);
      setUrl(r.card_url);
      setConnectOpen(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const s = card.terms.scope;
  const scopeRows: Array<[string, string]> = [];
  if (!s || (!s.domains && !s.platforms && !s.entityTypes && !s.entities && !s.glossaryTerms)) {
    scopeRows.push(["Scope", "Full catalog reads"]);
  } else {
    if (s.domains?.length) scopeRows.push(["Domains", s.domains.map((d) => shortHex(d, 20, 8)).join(", ")]);
    if (s.platforms?.length) scopeRows.push(["Platforms", s.platforms.map((p) => p.split(":").pop() ?? p).join(", ")]);
    if (s.entityTypes?.length) scopeRows.push(["Types", s.entityTypes.join(", ")]);
    if (s.entities?.length) scopeRows.push(["Entities", `${s.entities.length} pinned`]);
    if (s.glossaryTerms?.length) scopeRows.push(["Glossary", s.glossaryTerms.map((g) => g.split(":").pop() ?? g).join(", ")]);
    if (s.lineageDepth) scopeRows.push(["Lineage", `up to ${s.lineageDepth} hop${s.lineageDepth === 1 ? "" : "s"}`]);
  }
  scopeRows.push([
    "Write-Back",
    card.terms.mutations === "documents" ? "save_document allowed" : "Read-only",
  ]);
  scopeRows.push([
    "Payments",
    card.terms.budget?.spend
      ? `Visa test-mode · ${card.remaining_spend !== null ? `$${(card.remaining_spend / 100).toFixed(2)} left` : "linked"}`
      : "No payment lane (no budget.spend)",
  ]);
  if (card.terms.maxRows) scopeRows.push(["Max Rows", `${card.terms.maxRows} per query`]);

  return (
    <div className="dossier">
      <div className="dhead">
        <div>
          <div className="dtitle">
            {card.name}
            <span className={`chip ${card.status}`}>{card.status}</span>
          </div>
          <div className="dsub">
            {card.expires_at
              ? `expires ${new Date(card.expires_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
              : "no expiry"}
            {card.period_resets_at ? ` · resets ${fmtCountdown(card.period_resets_at)}` : ""}
          </div>
        </div>
        <div className="verbs">{verbs}</div>
      </div>

      {err && (
        <p className="err" style={{ margin: "8px 0" }}>
          {err}
        </p>
      )}

      <div className="readings">
        <div className="reading">
          <span className="rl">Calls left this period</span>
          <span className="rf num" data-testid="remaining">
            {remaining !== null ? remaining : "∞"}
            {cap ? <em>of {cap}</em> : null}
          </span>
          <span className="bar">
            <i style={{ width: `${pct}%` }} />
          </span>
        </div>
        {card.remaining_lifetime !== null && card.remaining_this_period !== null && (
          <div className="reading">
            <span className="rl">Lifetime left</span>
            <span className="rf num">{card.remaining_lifetime}</span>
          </div>
        )}
        {card.remaining_spend !== null && (
          <div className="reading">
            <span className="rl">Spend left · Stripe lane</span>
            <span className="rf num">${(card.remaining_spend / 100).toFixed(2)}</span>
          </div>
        )}
        {card.uses_remaining !== null && (
          <div className="reading">
            <span className="rl">Uses left</span>
            <span className="rf num">{card.uses_remaining}</span>
          </div>
        )}
        {!dead && (
          <p className="statline">
            Every call draws down the budget · sub-cards share the same pool, so a sub-agent can&apos;t outspend the
            lead.
          </p>
        )}
      </div>

      <div className="panes">
        <div className="pane">
          <div className="paneh">Activity</div>
          <Activity feed={feed} />
        </div>
        <div className="pane">
          <div className="paneh">Scope</div>
          <div className="termsheet">
            {scopeRows.map(([label, value]) => (
              <div className="trow" key={label}>
                <span className="tl">{label}</span>
                <span className="tv code">{value}</span>
              </div>
            ))}
          </div>
          {node.children.length > 0 && (
            <>
              <div className="paneh" style={{ marginTop: 14 }}>
                Sub-Cards
              </div>
              <div className="subcards">
                {node.children.map((child) => (
                  <div className={`subcard ${isDead(child.card.status) ? "dead" : ""}`} key={child.card.card_id}>
                    <span className="scname">{child.card.name}</span>
                    <span className="scstate num">
                      {child.card.remaining_this_period !== null
                        ? `${child.card.remaining_this_period} calls left`
                        : child.card.status}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {connectOpen && url && (
        <ConnectOverlay
          card={card}
          url={url}
          rotating={busy}
          onRotate={() =>
            void (async () => {
              try {
                const r = await api.rotate(card.card_id);
                setUrl(r.card_url);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              }
            })()
          }
          onClose={() => {
            setConnectOpen(false);
            setUrl(null);
          }}
        />
      )}
    </div>
  );
}

/** subtree access entries flattened into one feed (card-first attribution) */
export function flattenFeed(card: CardState | null, kids: TreeNode[], accessByCard: Map<string, AccessEntry[]>): FeedRow[] {
  const rows: FeedRow[] = [];
  if (card) for (const a of accessByCard.get(card.card_id) ?? []) rows.push({ entry: a, cardName: card.name });
  for (const kid of kids) for (const a of accessByCard.get(kid.card.card_id) ?? []) rows.push({ entry: a, cardName: kid.card.name });
  rows.sort((a, b) => b.entry.at - a.entry.at);
  return rows;
}
