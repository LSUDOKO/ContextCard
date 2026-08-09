// @datacards/server: the one always-on process.
// Serves the MCP endpoint (/c/<secret>/mcp), the dashboard REST API, and the
// OAuth lane. Access calls are synchronous against DataHub, so there is no
// reconcile/settlement sweep — the ledger is written before the call returns.

import { createApp } from "./app";
import { envInt, realDeps } from "./deps";

const deps = realDeps();
const app = createApp(deps);
const port = envInt("PORT", 4070);

if (!deps.adminToken) console.warn("[deps] no DATACARDS_ADMIN_TOKEN set: /api/* is disabled");
if (!deps.datahub) console.warn("[deps] no DATAHUB_GMS_URL set: agent tools will answer 503 (source_unavailable)");

console.log(`datacards server listening on :${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
