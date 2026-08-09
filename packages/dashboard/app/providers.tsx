"use client";

// Providers for the DataCards dashboard. No wallet, no Privy: the steward logs in
// with the server's DATACARDS_ADMIN_TOKEN (kept in localStorage, sent as Bearer on
// every /api call). The token never rides the bundle — it is entered at runtime.

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { MotionConfig } from "motion/react";

const TOKEN_KEY = "datacards-token";

type AuthCtx = {
  token: string | null;
  setToken: (t: string) => void;
  clear: () => void;
};

const Ctx = createContext<AuthCtx>({ token: null, setToken: () => {}, clear: () => {} });

export function useAuth(): AuthCtx {
  return useContext(Ctx);
}

/** module-level token holder so lib/api.ts can attach it without prop drilling */
export let authToken: string | null = null;
export function setAuthToken(t: string | null): void {
  authToken = t;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);

  // hydrate from storage once (client only)
  useEffect(() => {
    try {
      const t = localStorage.getItem(TOKEN_KEY);
      if (t) {
        setTokenState(t);
        setAuthToken(t);
      }
    } catch {
      // storage unavailable — the user re-enters the token
    }
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({
      token,
      setToken: (t) => {
        setTokenState(t);
        setAuthToken(t);
        try {
          localStorage.setItem(TOKEN_KEY, t);
        } catch {
          // private mode: token lives for the session only
        }
      },
      clear: () => {
        setTokenState(null);
        setAuthToken(null);
        try {
          localStorage.removeItem(TOKEN_KEY);
        } catch {}
      },
    }),
    [token],
  );

  return (
    <Ctx.Provider value={value}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </Ctx.Provider>
  );
}
