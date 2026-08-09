// The app factory: ONE Hono process serving the MCP endpoint (card-secret lanes),
// the dashboard REST API, and the OAuth lane. In dev (localhost) every route is
// reachable on the single host.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { ENGINE_VERSION } from "@datacards/engine";
import type { AppDeps } from "./deps";
import { mcpRoutes } from "./mcp/routes";
import { apiRoutes } from "./api/routes";
import { oauthRoutes } from "./oauth/routes";
import { OAuthStore } from "./oauth/store";
import { stripeRoutes } from "./stripe/routes";
import { shopRoutes } from "./shop/routes";

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const otel = trace.getTracer("datacards-server");

  // OpenTelemetry middleware: wraps every request in a root span with route pattern,
  // method, status code. startActiveSpan makes it the ACTIVE span for the whole
  // handler, so every child span (auto-instrumented fetch/DB, mcp_tool_*) waterfalls
  // under it as one distributed trace.
  app.use("*", async (c, next) => {
    await otel.startActiveSpan(`HTTP ${c.req.method} ${c.req.routePath ?? c.req.path}`, async (span) => {
      span.setAttribute("http.method", c.req.method);
      span.setAttribute("http.url", c.req.path);
      span.setAttribute("http.route", c.req.routePath ?? c.req.path);
      try {
        await next();
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        span.setAttribute("http.status_code", c.res.status);
        span.end();
      }
    });
  });

  // OAuth lane storage rides the same sqlite database as the engine store
  const oauth = new OAuthStore(deps.store.db);

  app.get("/health", (c) => c.json({ ok: true, engine: ENGINE_VERSION, datahub: deps.datahub !== null }));

  // dashboard API is browser-consumed (dev: localhost:4071)
  app.use(
    "/api/*",
    cors({
      origin: (origin) => {
        const allowed = (process.env.DATACARDS_CORS_ORIGINS ?? "http://localhost:4071").split(",");
        return allowed.includes(origin) ? origin : null;
      },
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  app.route("/", oauthRoutes(deps, oauth));
  app.route("/", mcpRoutes(deps, oauth));
  // the Stripe webhook is Stripe-to-server (signature-verified, no auth) and the shop
  // is a public storefront (rate-limited, no auth) — both mounted outside /api
  app.route("/", stripeRoutes(deps));
  app.route("/", shopRoutes(deps));
  app.route("/api", apiRoutes(deps, oauth));

  return app;
}
