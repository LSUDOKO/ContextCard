"use client";

// Home: steward login (admin token) -> the cockpit. The deck's carousel selects
// which root card the dossier reads; the + at the deck's edge opens the issue
// modal (a card being born); the connect overlay hands the URL to an agent.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, UnauthorizedError, type AccessEntry, type CardTermsInput, type TreeNode } from "@/lib/api";
import { useAuth } from "./providers";
import { Boot } from "./components/Boot";
import { Login } from "./components/Login";
import { Cockpit } from "./components/Shell";
import { Dossier, flattenFeed } from "./components/Dossier";
import { CardFace } from "./components/CardHero";
import { Select } from "./components/Select";
import { UrlBox, ConnectChips } from "./components/Authority";
import { ChipDots, Guilloche, IconClose, isDead } from "./components/ui";

export default function Home() {
  const { token, setToken, clear } = useAuth();
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [bootDone, setBootDone] = useState(false);

  const tryToken = useCallback(
    async (t: string) => {
      setLoginErr(null);
      setToken(t);
      setAuthed(true); // the cockpit's first poll proves it; a 401 bounces back
      setBootDone(false);
    },
    [setToken],
  );

  useEffect(() => {
    if (!token) return;
    api
      .cards()
      .then(() => setAuthed(true))
      .catch((e) => {
        if (e instanceof UnauthorizedError) {
          clear();
          setAuthed(false);
          setLoginErr("That token was rejected · check DATACARDS_ADMIN_TOKEN on the server.");
        } else {
          setAuthed(true); // server reachable but maybe DataHub down — the cockpit shows the error
        }
      });
  }, [token, clear]);

  // Boot lifts once the app has something to show: the cockpit when a token
  // checks out, the login screen when there is no token at all. Gating this on
  // `authed` alone strands a first-time visitor — no token means no successful
  // cards() call, so the overlay would sit over the login form forever.
  useEffect(() => {
    if (authed || !token) {
      const t = setTimeout(() => setBootDone(true), 500);
      return () => clearTimeout(t);
    }
  }, [authed, token]);

  if (!token) {
    return (
      <>
        <Login onSubmit={tryToken} error={loginErr} />
        <AnimatePresence>{!bootDone && <Boot progress={1} note="Ready" />}</AnimatePresence>
      </>
    );
  }
  if (!authed) {
    return (
      <>
        <Boot progress={0.6} note="Checking the server" />
      </>
    );
  }

  return <Dashboard onLogout={clear} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessByCard, setAccessByCard] = useState<Map<string, AccessEntry[]>>(new Map());
  const [selId, setSelId] = useState<string | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { tree: t } = await api.tree();
      setTree(t);
      setError(null);
      setLoaded(true);
      // pull access for the visible cards (hero + its children)
      const ids = new Set<string>();
      for (const n of t) {
        ids.add(n.card.card_id);
        for (const c of n.children) ids.add(c.card.card_id);
      }
      const entries = await Promise.all([...ids].map((id) => api.card(id).catch(() => null)));
      const map = new Map<string, AccessEntry[]>();
      entries.forEach((d, i) => {
        if (d) map.set(d.card_id, d.access);
      });
      setAccessByCard(map);
    } catch (e) {
      if (e instanceof UnauthorizedError) onLogout();
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onLogout]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const heroNode =
    (selId ? tree.find((n) => n.card.card_id === selId) : undefined) ??
    tree.find((n) => !isDead(n.card.status)) ??
    tree[0] ??
    null;

  const feed = useMemo(
    () => flattenFeed(heroNode?.card ?? null, heroNode?.children ?? [], accessByCard),
    [heroNode, accessByCard],
  );

  return (
    <Cockpit
      nukeable={tree.some((n) => n.card.status === "active" || n.card.status === "frozen")}
      aggregate={
        loaded
          ? `${tree.length} root card${tree.length === 1 ? "" : "s"} · ${feed.length} calls in view`
          : undefined
      }
    >
      {error && (
        <p className="err" style={{ margin: "0 8px 10px" }}>
          {error}
        </p>
      )}

      <div className="deck" data-testid="deck">
        {tree.length === 0 && (
          <div className="deckempty">
            <p>No cards yet · issue one, hand the URL to an agent, watch its context access land here.</p>
          </div>
        )}
        {tree.map((n, i) => (
          <button
            key={n.card.card_id}
            className={`deckitem${heroNode?.card.card_id === n.card.card_id ? " on" : ""}`}
            onClick={() => setSelId(n.card.card_id)}
            aria-label={n.card.name}
            data-testid={`deck-card-${n.card.name}`}
          >
            <CardFace card={n.card} dimmed={heroNode?.card.card_id !== n.card.card_id && !isDead(n.card.status)} />
          </button>
        ))}
        <button className="deckadd" onClick={() => setIssueOpen(true)} data-testid="issue" aria-label="Issue a card">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M8 2.5v11M2.5 8h11" />
          </svg>
        </button>
      </div>

      <Dossier node={heroNode} feed={feed} onRefresh={refresh} onIssue={() => setIssueOpen(true)} />

      <AnimatePresence>
        {issueOpen && (
          <IssueModal
            key="issue"
            firstCard={tree.length === 0}
            onIssued={() => refresh()}
            onClose={() => setIssueOpen(false)}
          />
        )}
      </AnimatePresence>
    </Cockpit>
  );
}

// ---------------------------------------------------------------------------
// IssueModal: "a card being born". Plain language drafts the scope by searching
// the REAL catalog (the server resolves names -> URNs; a draft can never contain
// an entity that isn't in DataHub). The terms sheet stays fully editable; issue
// is one server call (no wallet ceremony).
// ---------------------------------------------------------------------------

const PERIODS = [86400, 604800, 2592000];
const closestPeriod = (s: number) => PERIODS.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function IssueModal({
  firstCard,
  onIssued,
  onClose,
}: {
  firstCard: boolean;
  onIssued: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("Analyst Agent");
  const [amount, setAmount] = useState("200");
  const [period, setPeriod] = useState(604800);
  const [lifetime, setLifetime] = useState("");
  const [spend, setSpend] = useState("");
  const [maxRows, setMaxRows] = useState("");
  const [expiryDays, setExpiryDays] = useState(30);
  const [maxUses, setMaxUses] = useState("");
  const [mutations, setMutations] = useState<"none" | "documents">("none");
  const [subcards, setSubcards] = useState(true);
  const [domains, setDomains] = useState("");
  const [platforms, setPlatforms] = useState("");
  const [types, setTypes] = useState("");
  const [lineage, setLineage] = useState("");

  const [intent, setIntent] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draftN, setDraftN] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  function buildTerms(): CardTermsInput {
    const scope: NonNullable<CardTermsInput["scope"]> = {};
    const ds = splitList(domains);
    const ps = splitList(platforms);
    const ts = splitList(types);
    if (ds.length) scope.domains = ds;
    if (ps.length) scope.platforms = ps;
    if (ts.length) scope.entityTypes = ts.map((t) => t.toUpperCase());
    if (lineage.trim()) scope.lineageDepth = Math.max(1, Math.min(3, parseInt(lineage, 10) || 1));
    const budget: NonNullable<CardTermsInput["budget"]> = {};
    if (amount.trim() && parseInt(amount, 10) > 0) budget.period = { amount: parseInt(amount, 10), seconds: period };
    if (lifetime.trim() && parseInt(lifetime, 10) > 0) budget.lifetime = { amount: parseInt(lifetime, 10) };
    const spendCents = Math.round(parseFloat(spend) * 100);
    if (spend.trim() && Number.isFinite(spendCents) && spendCents > 0) {
      budget.spend = { amount: spendCents, seconds: period };
    }
    const uses = parseInt(maxUses, 10);
    const rows = parseInt(maxRows, 10);
    return {
      ...(Object.keys(scope).length ? { scope } : {}),
      ...(Object.keys(budget).length ? { budget } : {}),
      mutations,
      expiry: Math.floor(Date.now() / 1000) + expiryDays * 86400,
      subcards,
      ...(Number.isFinite(uses) && uses >= 1 ? { maxUses: uses } : {}),
      ...(Number.isFinite(rows) && rows >= 1 ? { maxRows: rows } : {}),
    };
  }

  function applyDraft(r: { draft: CardTermsInput | null }) {
    const d = r.draft;
    if (!d) return;
    if (d.budget?.period) {
      setAmount(String(d.budget.period.amount));
      setPeriod(closestPeriod(d.budget.period.seconds));
    }
    setLifetime(d.budget?.lifetime ? String(d.budget.lifetime.amount) : "");
    setSpend(d.budget?.spend ? String(d.budget.spend.amount / 100) : "");
    setMaxRows(d.maxRows ? String(d.maxRows) : "");
    if (d.scope?.domains) setDomains(d.scope.domains.join(", "));
    if (d.scope?.platforms) setPlatforms(d.scope.platforms.join(", "));
    if (d.scope?.entityTypes) setTypes(d.scope.entityTypes.join(", "));
    setLineage(d.scope?.lineageDepth ? String(d.scope.lineageDepth) : "");
    setDraftN((n) => n + 1);
  }

  async function compile() {
    if (!intent.trim() || compiling) return;
    setCompiling(true);
    setCompileErr(null);
    setLabels([]);
    setWarnings([]);
    try {
      const r = await api.compile(intent.trim());
      setLabels(r.labels);
      setWarnings(r.warnings);
      applyDraft(r);
    } catch (e) {
      setCompileErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCompiling(false);
    }
  }

  async function issue() {
    setErr(null);
    setIssuedUrl(null);
    const terms = buildTerms();
    if (!terms.budget?.period && !terms.budget?.lifetime) {
      setErr("A card needs a call budget · set a period and/or lifetime cap");
      return;
    }
    setBusy(true);
    try {
      const res = await api.issueCard(name.trim() || "Analyst Agent", terms);
      setIssuedUrl(res.card_url);
      onIssued();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const drafted = draftN > 0;
  const filled = drafted || editOpen;
  const chips: string[] = [];
  if (amount.trim() && parseInt(amount, 10) > 0)
    chips.push(`${amount.trim()} calls / ${period <= 86400 ? "day" : period <= 604800 ? "wk" : "30d"}`);
  if (lifetime.trim()) chips.push(`${lifetime.trim()} calls lifetime`);
  if (spend.trim()) chips.push(`$${spend.trim()} spend / ${period <= 86400 ? "day" : period <= 604800 ? "wk" : "30d"}`);
  if (maxRows.trim()) chips.push(`${maxRows.trim()} rows max / query`);
  const ds = splitList(domains);
  const ps = splitList(platforms);
  const ts = splitList(types);
  if (ds.length) chips.push(`${ds.length} domain${ds.length === 1 ? "" : "s"}`);
  if (ps.length) chips.push(`${ps.length} platform${ps.length === 1 ? "" : "s"}`);
  if (ts.length) chips.push(ts.join(", "));
  chips.push(mutations === "documents" ? "Write-back" : "Read-only");
  chips.push(subcards ? "Sub-cards allowed" : "No sub-cards");

  const field = (label: string, el: React.ReactNode) => (
    <div className="field">
      <label>{label}</label>
      {el}
    </div>
  );

  return (
    <motion.div
      className="mscrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Issue a New Card"
        initial={{ opacity: 0, y: 26, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 360, damping: 30 } }}
        exit={{ opacity: 0, y: 14, scale: 0.98, transition: { duration: 0.16 } }}
      >
        <div className="mhead">
          <div>
            <div className="mtitle">{firstCard ? "Issue Your First Card" : "Issue a New Card"}</div>
            <div className="msub">Describe the access in plain language · the draft resolves names against the real catalog</div>
          </div>
          <button className="closex" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>

        {issuedUrl ? (
          <div style={{ marginTop: 18 }}>
            <div className="ok" style={{ marginBottom: 8 }}>
              Card issued · hand this URL to your agent (it is the credential):
            </div>
            <UrlBox url={issuedUrl} testid="issued-url" />
            <ConnectChips url={issuedUrl} cardName={name} />
            <div className="mfoot">
              <button className="dbtn" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <textarea
              className="dtext"
              value={intent}
              maxLength={500}
              autoFocus
              disabled={compiling}
              placeholder='Describe the access · "let my agent explore revenue dashboards in the Finance domain, 200 calls a week"'
              onChange={(e) => setIntent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) compile();
              }}
              data-testid="compile-intent"
            />
            {compiling && (
              <div className="draftbar" role="progressbar" aria-label="Searching the catalog">
                <i />
              </div>
            )}
            <div className="drow">
              <span className="mhint">
                {compiling ? "Searching DataHub for what you named…" : "Names are resolved against the catalog · nothing gets invented"}
              </span>
              <button
                className={`dbtn${drafted && !compiling ? " quiet" : ""}`}
                onClick={compile}
                disabled={compiling || !intent.trim()}
                data-testid="compile-go"
              >
                {compiling && <span className="bspin" aria-hidden />}
                {compiling ? "Searching…" : "Draft Scope"}
              </button>
            </div>
            {compileErr && (
              <p className="err" style={{ marginTop: 10 }}>
                {compileErr}
              </p>
            )}

            <div className="born">
              <div className={`minicard${filled ? " fill" : ""}`}>
                <div className="mc-mark">datacards</div>
                <div className="mc-chip">
                  <ChipDots />
                </div>
                <div className="mc-pan num">{amount.trim() ? `${amount.trim()} calls` : "context"}</div>
                <div className="mc-name">{name || "Analyst Agent"}</div>
                <div className="mc-cap">{chips.slice(0, 2).join(" · ")}</div>
                <div className="mc-band">
                  <Guilloche width={520} height={64} strands={9} amp={14} animate={filled || compiling} />
                </div>
              </div>
              {filled && <TermChips key={draftN} items={chips} />}
              {labels.length > 0 && (
                <div className="lblchips" data-testid="compile-labels">
                  {labels.map((l, i) => (
                    <span key={i} className="lblchip">
                      <i className="lk registry" />
                      {l}
                    </span>
                  ))}
                </div>
              )}
              {warnings.length > 0 && (
                <div className="vnotes" data-testid="compile-warnings">
                  <div className="vh">
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                      <path d="M6 1.2 11 10H1z" strokeLinejoin="round" />
                      <path d="M6 4.6v2.6M6 8.9v.1" />
                    </svg>
                    The draft needs a look · review before issuing
                  </div>
                  <ul>
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <button className="ordiv" onClick={() => setEditOpen((v) => !v)}>
              <span>{editOpen ? "Hide the Term Sheet" : "Edit Terms Yourself"}</span>
            </button>

            <AnimatePresence initial={false}>
              {editOpen && (
                <motion.div
                  key="termsheet"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{
                    height: "auto",
                    opacity: 1,
                    transition: { height: { duration: 0.36, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.28, delay: 0.08 } },
                  }}
                  exit={{ height: 0, opacity: 0, transition: { height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.14 } } }}
                  style={{ overflow: "hidden" }}
                >
                  <div className={`composer2${draftN ? " flash" : ""}`} key={draftN}>
                    <div className="csec">
                      <div className="cseclbl">Card</div>
                      <div className="csecrow">
                        {field("Name", <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 150 }} data-testid="composer-name" />)}
                        {field("Expires · Days", <input type="number" value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} style={{ width: 72 }} />)}
                        {field("Max Uses", <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" style={{ width: 72 }} />)}
                        {field("Sub-Cards", <Select value={subcards ? "yes" : "no"} options={[{ value: "yes", label: "Allowed" }, { value: "no", label: "No" }]} onChange={(v) => setSubcards(v === "yes")} width={104} />)}
                      </div>
                    </div>
                    <div className="csec">
                      <div className="cseclbl">Budget · Tool Calls</div>
                      <div className="csecrow">
                        {field("Calls", <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="None" style={{ width: 92 }} data-testid="composer-amount" />)}
                        {field("Per", <Select value={String(period)} options={[{ value: "86400", label: "Day" }, { value: "604800", label: "Week" }, { value: "2592000", label: "30 Days" }]} onChange={(v) => setPeriod(Number(v))} width={104} />)}
                        {field("Lifetime Cap", <input value={lifetime} onChange={(e) => setLifetime(e.target.value)} placeholder="None" style={{ width: 92 }} />)}
                        {field("Spend · $", <input value={spend} onChange={(e) => setSpend(e.target.value)} placeholder="None" style={{ width: 92 }} title="USD per window for the Stripe test-mode shop" data-testid="composer-spend" />)}
                      </div>
                    </div>
                    <div className="csec">
                      <div className="cseclbl">Scope · DataHub</div>
                      <div className="csecrow">
                        {field("Domains", <input className="wide" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="urn:li:domain:finance, …" data-testid="composer-domains" />)}
                        {field("Platforms", <input className="wide" value={platforms} onChange={(e) => setPlatforms(e.target.value)} placeholder="urn:li:dataPlatform:snowflake, …" />)}
                        {field("Entity Types", <input value={types} onChange={(e) => setTypes(e.target.value)} placeholder="DATASET, DASHBOARD, CHART" style={{ width: 220 }} />)}
                        {field("Lineage Depth", <input value={lineage} onChange={(e) => setLineage(e.target.value)} placeholder="1–3" style={{ width: 72 }} />)}
                        {field("Max Rows / Query", <input value={maxRows} onChange={(e) => setMaxRows(e.target.value)} placeholder="None" style={{ width: 92 }} data-testid="composer-maxrows" />)}
                        {field("Write-Back", <Select value={mutations} options={[{ value: "none", label: "Read-only" }, { value: "documents", label: "Documents" }]} onChange={(v) => setMutations(v as "none" | "documents")} width={120} />)}
                      </div>
                    </div>
                    <p className="chint">Empty scope = full-catalog reads · budget and expiry always bind</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {err && (
              <p className="err" style={{ marginTop: 12 }}>
                {err}
              </p>
            )}

            <div className="mfoot">
              <button className="mghost" onClick={onClose}>
                Cancel
              </button>
              <button className="dbtn" onClick={issue} disabled={busy} data-testid="composer-issue">
                {busy ? "Issuing…" : "Issue Card"}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

// chips stagger in as the draft lands · mount with .in applied a frame later
function TermChips({ items }: { items: string[] }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="tchips num">
      {items.map((s, i) => (
        <span key={`${s}-${i}`} className={armed ? "in" : ""} style={{ transitionDelay: armed ? `${120 + i * 110}ms` : "0ms" }}>
          {s}
        </span>
      ))}
    </div>
  );
}
