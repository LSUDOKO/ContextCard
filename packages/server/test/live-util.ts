// Real-client utilities shared by the live integration suites (live-*.test.ts).
// Nothing fake lives in this repo: when the relevant credentials are present the
// suites run against the REAL Stripe test-mode API (api.stripe.com) and a REAL
// DataHub GMS; when they're absent the suites skip with a message. Everything in
// this file is a real client or a real HTTP helper — no doubles, no mocks.

// DataHubClient is a value import (realDatahub calls its static factory) — a
// `type` import here erases at runtime and the factory call throws.
import { DataHubClient, isSensitiveEntity, type HubEntityMeta } from "@datacards/engine";
import type { Hono } from "hono";
import { makeStripeClient, type StripeClient } from "../src/stripe/client";

/** Stripe test-mode keys only — mirrors the server's own gate. */
export const STRIPE_TEST_KEY_RE = /^(sk|rk)_test_/;

/** Stripe test-mode secret key from env (empty when unset). */
export const liveStripeKey = (): string => process.env.STRIPE_SECRET_KEY ?? "";
/** Stripe webhook signing secret from env (empty when unset). */
export const liveWebhookSecret = (): string => process.env.STRIPE_WEBHOOK_SECRET ?? "";
/** Port the live webhook round-trip listens on. Point the Stripe CLI here:
 *   stripe listen --forward-to http://localhost:4099/stripe/webhook
 * (override with DATACARDS_TEST_WEBHOOK_PORT). */
export const LIVE_WEBHOOK_PORT = Number(process.env.DATACARDS_TEST_WEBHOOK_PORT ?? 4099);

/** The REAL Stripe test-mode client built from env, or null without a test key. */
export function realStripe(env: NodeJS.ProcessEnv = process.env): StripeClient | null {
  return makeStripeClient(env);
}

/** The REAL DataHub GMS client built from env (PAT or basic auth), or null. */
export function realDatahub(): DataHubClient | null {
  return DataHubClient.fromEnv();
}

/** Serve the real app on LIVE_WEBHOOK_PORT so the Stripe CLI can forward REAL
 * webhooks into it. Returns a stop handle for teardown. */
export async function bootWebhookListener(app: Hono): Promise<() => Promise<void>> {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ port: LIVE_WEBHOOK_PORT, fetch: app.fetch });
  } catch (e) {
    throw new Error(
      `cannot bind the webhook listener on :${LIVE_WEBHOOK_PORT} (${e instanceof Error ? e.message : String(e)}) — is another datacards test run or process listening there? (DATACARDS_TEST_WEBHOOK_PORT overrides)`,
    );
  }
  console.log(
    `[live] webhook listener on :${LIVE_WEBHOOK_PORT} — run: stripe listen --forward-to http://localhost:${LIVE_WEBHOOK_PORT}/stripe/webhook`,
  );
  return async () => {
    server.stop(true);
  };
}

/** Best-effort cleanup: deactivate a minted test-mode Issuing card (real API call,
 * so repeated live runs don't pile up active test cards on the account). */
export async function deactivateIssuingCard(key: string, icId: string): Promise<void> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/issuing/cards/${icId}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ status: "inactive" }).toString(),
    });
    if (!res.ok) {
      console.warn(`[live] could not deactivate test card ${icId} (http ${res.status}) — it stays active on the account`);
    }
  } catch (e) {
    console.warn(`[live] could not deactivate test card ${icId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Find a real, non-sensitive dataset in the catalog (real search + entity reads).
 * Used when DATACARDS_TEST_DATASET_URN isn't pinned. */
export async function discoverDataset(client: DataHubClient): Promise<HubEntityMeta | null> {
  const res = await client.search({ query: "*", types: ["DATASET"], count: 10 });
  for (const r of res.results) {
    const meta = await client.getEntity(r.urn);
    if (meta && !isSensitiveEntity(meta)) return meta;
  }
  return null;
}

/** HMAC-SHA256 over `${t}.${body}` with WebCrypto — the exact math the server's
 * verifyStripeSignature performs — used to sign webhook events for the in-process
 * handler tests (real crypto against the real handler; no fake service involved). */
export async function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const v1 = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v1=${v1}`;
}

/** Real MCP client for the card-secret lane: initialize -> initialized -> tools/call.
 * The server's per-card lane is stateless, so each POST stands alone; the transport
 * answers either JSON or SSE depending on Accept — both are parsed here. */
export async function mcpCall(
  app: Hono,
  secret: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{
  isError: boolean;
  data: Record<string, unknown>;
  envelope: { error?: { message?: string } } | null;
}> {
  const url = `/c/${secret}/mcp`;
  // app.request() sends no Host header, and the MCP lane's DNS-rebinding guard
  // rejects a missing Host outright once DATACARDS_PUBLIC_MCP_BASE arms the
  // allowlist. A real client always sends one, so the test does too.
  const post = (body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "localhost",
      },
      body: JSON.stringify(body),
    });
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "live-integration-test", version: "1" },
    },
  });
  if (init.status !== 200) throw new Error(`initialize failed: ${init.status} ${await init.text()}`);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  const text = await call.text();
  if (call.status !== 200) throw new Error(`tools/call failed: ${call.status} ${text}`);

  let envelopes: Array<{ id?: number; result?: unknown; error?: { message?: string } }>;
  if ((call.headers.get("content-type") ?? "").includes("text/event-stream")) {
    envelopes = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as { id?: number; result?: unknown; error?: { message?: string } });
  } else {
    const parsed = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
    envelopes = Array.isArray(parsed) ? parsed : [parsed];
  }
  const envelope = envelopes.find((e) => e.id === 2) ?? null;
  if (!envelope) throw new Error(`no tools/call envelope in: ${text}`);
  if (envelope.error) return { isError: true, data: {}, envelope };

  const result = envelope.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
  const firstText = result?.content?.find((c) => c.type === "text")?.text ?? "";
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(firstText) as Record<string, unknown>;
  } catch {
    data = { message: firstText }; // SDK-level errors are plain text
  }
  return { isError: result?.isError ?? false, data, envelope };
}
