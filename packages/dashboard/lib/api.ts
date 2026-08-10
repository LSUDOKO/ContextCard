// Dashboard API client. AUTH: every call carries the steward's DATACARDS_ADMIN_TOKEN
// (entered at login, held in localStorage) as the Bearer. No shared secret ships in
// the bundle. IDENTITY: the dashboard acts for a single steward user ("steward" by
// default; the userId query overrides for multi-team setups).

import { authToken } from "@/app/providers";

const BASE = process.env.NEXT_PUBLIC_DATACARDS_API ?? "http://localhost:4070/api";

const REQUEST_TIMEOUT_MS = 20_000;
const COMPILE_TIMEOUT_MS = 30_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) return AbortSignal.timeout(ms);
  if (typeof AbortController === "undefined") return undefined;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(new DOMException("request timed out", "TimeoutError")), ms);
  return ctl.signal;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = authToken;
  if (!token) throw new Error("not signed in");
  const signal = init?.signal ?? timeoutSignal(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // When the API is reached through an ngrok free tunnel (hosted dashboard ->
        // server running on the steward's own machine), ngrok answers browser
        // user-agents with an HTML interstitial instead of proxying. This header
        // opts out of it. Harmless on every other host.
        "ngrok-skip-browser-warning": "1",
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error("request timed out");
    }
    throw e;
  }
  let body: { message?: string; error?: string } | null = null;
  try {
    body = (await res.json()) as { message?: string; error?: string } | null;
  } catch {
    if (res.ok) throw new Error("malformed response body");
  }
  if (!res.ok) {
    // a revoked token should surface the login screen
    if (res.status === 401 || res.status === 503) throw new UnauthorizedError(body?.message ?? `http ${res.status}`);
    throw new Error(body?.message ?? body?.error ?? `http ${res.status}`);
  }
  return body as T;
}

class UnauthorizedError extends Error {}

// ---------------------------------------------------------------------------
// Types (mirror the engine's CardTerms / CardState)
// ---------------------------------------------------------------------------

export type DataScope = {
  domains?: string[];
  platforms?: string[];
  entityTypes?: string[];
  entities?: string[];
  glossaryTerms?: string[];
  lineageDepth?: number;
};

export type CardTermsInput = {
  scope?: DataScope;
  budget?: {
    period?: { amount: number; seconds: number };
    lifetime?: { amount: number };
    /** USD cents per fixed window for the Stripe test-mode payment lane */
    spend?: { amount: number; seconds: number };
  };
  mutations?: "none" | "documents";
  expiry?: number;
  maxUses?: number;
  subcards?: boolean;
  /** max rows per query_data call (row-limit enforcement) */
  maxRows?: number;
};

export type CardState = {
  card_id: string;
  name: string;
  status: string;
  terms: CardTermsInput;
  remaining_this_period: number | null;
  remaining_lifetime: number | null;
  period_resets_at: number | null;
  remaining_spend: number | null;
  spend_resets_at: number | null;
  expires_at: number | null;
  uses_remaining: number | null;
  subcards: string[];
  parent_card_id?: string | null;
  created_at?: number;
};

export type TreeNode = { card: CardState; children: TreeNode[] };

export type AccessEntry = {
  id: string;
  tool: string;
  target: string | null;
  units: number;
  status: string;
  memo: string | null;
  at: number;
};

export type CompileResult = {
  draft: CardTermsInput | null;
  labels: string[];
  warnings: string[];
};

export const api = {
  me: () => call<{ connected: boolean; user: { urn: string; username: string; displayName: string | null } | null; gms_url?: string }>("/me"),

  // --- cards ---
  issueCard: (name: string, terms: CardTermsInput) =>
    call<{ card_id: string; card_url: string; terms: CardTermsInput }>("/cards", {
      method: "POST",
      body: JSON.stringify({ name, terms }),
    }),
  cards: () => call<CardState[]>("/cards"),
  card: (id: string) => call<CardState & { access: AccessEntry[] }>(`/cards/${id}`),
  tree: () => call<{ tree: TreeNode[] }>("/tree"),
  url: (id: string) => call<{ card_url: string }>(`/cards/${id}/url`),
  rotate: (id: string) => call<{ card_url: string }>(`/cards/${id}/rotate`, { method: "POST" }),
  fiatLink: (id: string) =>
    call<{ linked: boolean; last4?: string; brand?: string | null; exp_month?: number; exp_year?: number; reason?: string }>(
      `/cards/${id}/fiat`,
    ),
  freeze: (id: string) => call<{ status: string }>(`/cards/${id}/freeze`, { method: "POST" }),
  unfreeze: (id: string) => call<{ status: string }>(`/cards/${id}/unfreeze`, { method: "POST" }),
  revoke: (id: string) => call<{ status: string }>(`/cards/${id}/revoke`, { method: "POST" }),
  nuke: () => call<{ status: string }>("/nuke", { method: "POST", body: "{}" }),
  deleteCard: (id: string) => call<{ deleted: boolean; removed: number }>(`/cards/${id}`, { method: "DELETE" }),

  // --- plain-language draft (server resolves names against the real catalog) ---
  compile: (intent: string) =>
    call<CompileResult>("/cards/compile", {
      method: "POST",
      body: JSON.stringify({ intent }),
      signal: timeoutSignal(COMPILE_TIMEOUT_MS),
    }),

  // --- OAuth consent (the /connect card-picker page) ---
  oauthRequest: (id: string) =>
    call<{ request_id: string; client_name: string | null; redirect_host: string; scope: string | null; expires_at: number }>(
      `/oauth/request?id=${encodeURIComponent(id)}`,
    ),
  oauthApprove: (requestId: string, cardId: string) =>
    call<{ redirect_to: string }>("/oauth/approve", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, card_id: cardId }),
    }),
  oauthDeny: (requestId: string) =>
    call<{ redirect_to: string }>("/oauth/deny", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId }),
    }),
};

export { UnauthorizedError };
