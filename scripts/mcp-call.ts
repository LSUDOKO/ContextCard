// Minimal MCP (Streamable HTTP) client for demos/scripts. The SDK transport
// requires `initialize` to be the SOLE message in its request, so the call runs
// as three sequential POSTs; the server's per-card lane is stateless per request
// (session management disabled), so no Mcp-Session-Id is needed and each request
// may stand alone.
//
// Usage:
//   bun scripts/mcp-call.ts <card-secret-or-url> <tool> ['{"json":"args"}']
//   bun scripts/mcp-call.ts 'http://localhost:4070/c/<secret>/mcp' card_credentials '{}'
//
// Env: DATACARDS_BASE (default http://localhost:4070)

const [rawSecret, tool, rawArgs] = process.argv.slice(2);
if (!rawSecret || !tool) {
  console.error("usage: bun scripts/mcp-call.ts <card-secret-or-url> <tool> ['{json args}']");
  process.exit(2);
}
const secret = rawSecret.match(/\/c\/([^/]+)\/mcp$/) ? rawSecret.match(/\/c\/([^/]+)\/mcp$/)?.[1]! : rawSecret;
const base = process.env.DATACARDS_BASE ?? "http://localhost:4070";
let args: Record<string, unknown> = {};
if (rawArgs) {
  try {
    args = JSON.parse(rawArgs) as Record<string, unknown>;
  } catch {
    console.error("args must be valid JSON");
    process.exit(2);
  }
}

const endpoint = `${base}/c/${secret}/mcp`;
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function post(body: unknown): Promise<{ status: number; text: string; ctype: string }> {
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text(), ctype: res.headers.get("content-type") ?? "" };
}

function envelopes(text: string, ctype: string): Array<{ id?: number; result?: unknown; error?: unknown }> {
  if (ctype.includes("text/event-stream")) {
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()) as { id?: number; result?: unknown; error?: unknown });
  }
  const parsed = JSON.parse(text) as { id?: number; result?: unknown; error?: unknown } | Array<{ id?: number; result?: unknown; error?: unknown }>;
  return Array.isArray(parsed) ? parsed : [parsed];
}

// 1. initialize (must be the only message in its request)
const init = await post({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "datacards-demo", version: "0.1.0" } },
});
if (init.status !== 200) {
  console.error(`initialize http ${init.status}: ${init.text.slice(0, 300)}`);
  process.exit(1);
}
const initEnvelope = envelopes(init.text, init.ctype).find((e) => e.id === 1);
if (initEnvelope?.error) {
  console.error(JSON.stringify(initEnvelope.error, null, 2));
  process.exit(1);
}

// 2. notifications/initialized (notification only -> 202 Accepted)
await post({ jsonrpc: "2.0", method: "notifications/initialized" });

// 3. tools/call
const call = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
const callEnvelope = envelopes(call.text, call.ctype).find((e) => e.id === 2);
if (call.status !== 200 || !callEnvelope) {
  console.error(`tools/call http ${call.status}: ${call.text.slice(0, 400)}`);
  process.exit(1);
}
if (callEnvelope.error) {
  console.error(JSON.stringify(callEnvelope.error, null, 2));
  process.exit(1);
}
const result = callEnvelope.result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
console.log(result?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(result));
if (result?.isError) process.exit(1);
