// Server dependency wiring. ONE process serves MCP + dashboard API + OAuth,
// all gated by the same store. Engine objects are singletons here; tests build
// their own AppDeps (the live integration suites reuse the same real clients
// from env — no doubles anywhere).

import { DataHubClient, KeyedMutex, Store } from "@datacards/engine";
import { makeStripeClient, type StripeClient } from "./stripe/client";

export type AppDeps = {
  store: Store;
  /** DataHub GMS client (search/entity/lineage/documents); null = DataHub not
   * configured (DATAHUB_GMS_URL unset) -> read tools answer 503. */
  datahub: DataHubClient | null;
  /** Stripe Issuing test-mode client; null = fiat lane disabled (no test-mode key) */
  stripe: StripeClient | null;
  /** ops bearer token (server-side curl/scripts + the dashboard lane) */
  adminToken: string | null;
  /** serializes access per card tree (root id) so concurrent calls can't
   * double-pass a budget check */
  mutex: KeyedMutex;
};

/** Numeric env with a default that survives the empty string (the .env.example
 * ships optional vars as `KEY=`; Bun loads them as "" and Number("") is 0). */
export function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

export function realDeps(): AppDeps {
  return {
    store: new Store(), // DATACARDS_DB_PATH or :memory:
    datahub: DataHubClient.fromEnv(),
    stripe: makeStripeClient(),
    adminToken: process.env.DATACARDS_ADMIN_TOKEN ?? null,
    mutex: new KeyedMutex(),
  };
}


