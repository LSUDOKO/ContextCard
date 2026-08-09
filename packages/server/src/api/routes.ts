// Dashboard REST API. One auth lane: Bearer DATACARDS_ADMIN_TOKEN (the steward's
// token; the dashboard carries it, curl/scripts use it). Every card route is
// scoped to the requesting userId (admin picks via query/body; default "steward").
//
// Issuance is server-side (a card is a bearer secret, not a signed delegation),
// so there is no wallet, no onboard, no prepare/finalize dance.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  EngineError,
  RefusalError,
  deleteDeadCard,
  freezeCard,
  issueRootCard,
  nukeAll,
  revokeCard,
  rotateCardSecret,
  unfreezeCard,
  viewCardSecret,
  type CardTerms,
} from "@datacards/engine";
import { errorsTotal, emitCardLog, emitErrorLog } from "@datacards/engine";
import type { AppDeps } from "../deps";
import { cardUrl } from "../mcp/server";
import { appendRedirectParams } from "../oauth/routes";
import type { OAuthStore } from "../oauth/store";
import { resolveIntent } from "../compile";

/** Default steward user id when a request does not pick one. */
const DEFAULT_USER = "steward";

/** Constant-time bearer compare (hash both sides so length differences don't leak). */
const tokenEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export function apiRoutes(deps: AppDeps, oauth: OAuthStore): Hono {
  const app = new Hono();
  const now = () => Math.floor(Date.now() / 1000);

  // ---- auth: admin token ----
  app.use("*", async (c: Context, next: Next) => {
    if (!deps.adminToken) return c.json({ error: "api disabled (no DATACARDS_ADMIN_TOKEN)" }, 503);
    const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token && tokenEqual(token, deps.adminToken)) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  const handle = async (c: Context, fn: () => Promise<unknown>) => {
    try {
      return c.json((await fn()) as never);
    } catch (e) {
      errorsTotal.add(1);
      const route = c.req.routePath ?? c.req.path;
      const method = c.req.method;
      if (e instanceof RefusalError) {
        const refusal = e.toJSON();
        emitErrorLog(`HTTP ${method} ${route}`, e.message, { status: "422", code: refusal.code ?? "" });
        return c.json(refusal, 422);
      }
      if (e instanceof EngineError) {
        emitErrorLog(`HTTP ${method} ${route}`, e.message, { status: "502", stage: e.stage });
        return c.json({ status: "error", stage: e.stage, message: e.message }, 502);
      }
      emitErrorLog(`HTTP ${method} ${route}`, e instanceof Error ? e.message : String(e), { status: "500" });
      return c.json({ status: "error", message: e instanceof Error ? e.message : String(e) }, 500);
    }
  };

  const userId = (c: Context): string => {
    const requested = c.req.query("userId") ?? c.req.header("x-datacards-user") ?? null;
    return requested?.trim() ? requested.trim() : DEFAULT_USER;
  };

  const ownedCard = (c: Context, id: string) => {
    const card = deps.store.getCard(id);
    if (!card || card.user_id !== userId(c)) throw new RefusalError("card_not_found", "no such card");
    return card;
  };

  // Cascade OAuth-token revocation alongside card revoke/nuke: no live-looking
  // grant rows survive a dead card.
  const cascadeRevokeTokens = (cardId: string) => {
    for (const id of deps.store.subtreeIds(cardId)) oauth.revokeTokensByCardId(id);
  };

  // ---- DataHub introspection for the dashboard header ----
  app.get("/me", (c) =>
    handle(c, async () => {
      if (!deps.datahub) return { connected: false };
      const me = await deps.datahub.getMe();
      return { connected: true, user: me, gms_url: process.env.DATAHUB_GMS_URL };
    }),
  );

  // ---- cards ----
  app.post("/cards", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { name: string; terms: CardTerms; userId?: string };
      if (!body.name?.trim()) throw new RefusalError("invalid_terms", "name required");
      const uid = body.userId?.trim() ? body.userId.trim() : DEFAULT_USER;
      const issued = await issueRootCard(deps.store, { userId: uid, name: body.name.trim(), terms: body.terms });
      emitCardLog("issued", issued.cardId, { user: uid });
      return { card_id: issued.cardId, card_url: cardUrl(issued.secret), terms: issued.terms };
    }),
  );

  app.get("/cards", (c) =>
    handle(c, async () =>
      deps.store.listCards(userId(c)).map((card) => ({
        ...deps.store.cardState( card.id, now()),
        parent_card_id: card.parent_card_id,
        created_at: card.created_at,
      })),
    ),
  );

  app.get("/cards/:id", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"));
      const state = deps.store.cardState( card.id, now());
      if (!state) throw new RefusalError("card_not_found", "no such card");
      const charges = deps.store.listCharges(card.id, 50);
      return {
        ...state,
        parent_card_id: card.parent_card_id,
        created_at: card.created_at,
        access: charges.map((ch) => ({
          id: ch.id,
          tool: ch.kind,
          target: ch.to_urn,
          units: ch.units,
          status: ch.status,
          memo: ch.memo,
          at: ch.created_at,
        })),
      };
    }),
  );

  app.get("/cards/:id/url", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"));
      const secret = await viewCardSecret(deps.store, card.id);
      if (!secret) throw new RefusalError("card_not_found", "no secret on file for this card");
      emitCardLog("url_revealed", card.id);
      return { card_url: cardUrl(secret) };
    }),
  );

  app.post("/cards/:id/rotate", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"));
      const secret = rotateCardSecret(deps.store, card.id);
      return { card_url: cardUrl(secret) };
    }),
  );

  // Stripe test-mode Visa link (minted lazily on first read). last4/brand/expiry only —
  // the full PAN/CVC stays server-side and is revealed solely through card_credentials.
  app.get("/cards/:id/fiat", (c) =>
    handle(c, async () => {
      if (!deps.stripe) return { linked: false, reason: "stripe_disabled" };
      const card = ownedCard(c, c.req.param("id"));
      const existing = deps.store.getFiatLink(card.id);
      if (existing) {
        return { linked: true, last4: existing.last4, brand: existing.brand, exp_month: existing.exp_month, exp_year: existing.exp_year };
      }
      const icId = await deps.stripe.ensureCardForCard(card.id);
      if (!icId) return { linked: false, reason: "no_cardholder" };
      const det = await deps.stripe.getCardDetails(icId);
      deps.store.setFiatLink({
        card_id: card.id,
        stripe_card_id: det.id,
        last4: det.last4,
        brand: det.brand,
        exp_month: det.exp_month,
        exp_year: det.exp_year,
        created_at: now(),
      });
      return { linked: true, last4: det.last4, brand: det.brand, exp_month: det.exp_month, exp_year: det.exp_year };
    }),
  );

  app.post("/cards/:id/freeze", (c) =>
    handle(c, async () => {
      freezeCard(deps.store, ownedCard(c, c.req.param("id")).id);
      return { status: "frozen" };
    }),
  );

  app.post("/cards/:id/unfreeze", (c) =>
    handle(c, async () => {
      unfreezeCard(deps.store, ownedCard(c, c.req.param("id")).id);
      return { status: "active" };
    }),
  );

  // Server-side immediate revoke (card + subtree). No client signing, no relayer:
  // the server is the single authority over status.
  app.post("/cards/:id/revoke", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"));
      revokeCard(deps.store, card.id);
      cascadeRevokeTokens(card.id);
      return { status: "revoked" };
    }),
  );

  app.post("/nuke", (c) =>
    handle(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
      const uid = body.userId?.trim() ? body.userId.trim() : DEFAULT_USER;
      nukeAll(deps.store, uid);
      for (const card of deps.store.listCards(uid)) cascadeRevokeTokens(card.id);
      return { status: "nuked", user_id: uid };
    }),
  );

  app.delete("/cards/:id", (c) =>
    handle(c, async () => {
      const cardId = ownedCard(c, c.req.param("id")).id;
      const ids = deps.store.subtreeIds(cardId);
      const r = deleteDeadCard(deps.store, cardId);
      for (const id of ids) oauth.revokeTokensByCardId(id);
      return { deleted: true, removed: r.removed };
    }),
  );

  // ---- plain-language draft: resolve names -> scope via DataHub search ----
  // No LLM: every name is resolved by searching the real catalog, so a draft can
  // never contain a URN that isn't actually in DataHub.
  app.post("/cards/compile", (c) =>
    handle(c, async () => {
      if (!deps.datahub) throw new EngineError("compile", "compiler disabled (no DATAHUB_GMS_URL configured)");
      const body = (await c.req.json()) as { intent?: string };
      const intent = body.intent?.trim();
      if (!intent) throw new RefusalError("invalid_terms", "intent required");
      if (intent.length > 500) throw new RefusalError("invalid_terms", "intent too long (max 500 chars)");
      return resolveIntent(deps.datahub, intent);
    }),
  );

  // ---- tree (deck view's data) ----
  app.get("/tree", (c) =>
    handle(c, async () => {
      const uid = userId(c);
      const cards = deps.store.listCards(uid);
      type Node = { card: ReturnType<typeof deps.store.cardState>; children: Node[] };
      const byParent = new Map<string | null, typeof cards>();
      for (const card of cards) {
        const list = byParent.get(card.parent_card_id) ?? [];
        list.push(card);
        byParent.set(card.parent_card_id, list);
      }
      const build = (parentId: string | null): Node[] =>
        (byParent.get(parentId) ?? []).map((card) => ({
          card: deps.store.cardState( card.id, now()),
          children: build(card.id),
        }));
      return { tree: build(null) };
    }),
  );

  // ---- OAuth consent (the card-picker backend) ----
  // /authorize (oauth/routes.ts) 302s the browser to the dashboard /connect page,
  // which drives these through the same token-authed API.

  const ownedRequest = (c: Context, requestId: string) => {
    const r = oauth.getRequest(requestId);
    if (!r) throw new RefusalError("invalid_terms", "unknown or expired authorization request");
    if (!oauth.bindRequestUser(requestId, userId(c))) {
      throw new RefusalError("invalid_terms", "unknown or expired authorization request");
    }
    return r;
  };

  app.get("/oauth/request", (c) =>
    handle(c, async () => {
      const id = c.req.query("id");
      if (!id) throw new RefusalError("invalid_terms", "id required");
      const r = ownedRequest(c, id);
      const client = oauth.getClient(r.client_id);
      let redirectHost = r.redirect_uri;
      try {
        redirectHost = new URL(r.redirect_uri).host || r.redirect_uri;
      } catch {}
      return {
        request_id: r.request_id,
        client_name: client?.client_name ?? null,
        redirect_host: redirectHost,
        scope: r.scope,
        expires_at: r.expires_at,
      };
    }),
  );

  app.post("/oauth/approve", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { request_id?: string; card_id?: string };
      if (!body.request_id || !body.card_id) {
        throw new RefusalError("invalid_terms", "request_id and card_id required");
      }
      const r = ownedRequest(c, body.request_id);
      const card = ownedCard(c, body.card_id);
      const state = deps.store.cardState( card.id, now());
      if (!state || state.status === "revoked" || state.status === "nuked" || state.status === "expired") {
        throw new RefusalError("card_revoked", "this card is no longer live");
      }
      oauth.deleteRequest(body.request_id);
      const code = oauth.createCode(
        {
          client_id: r.client_id,
          redirect_uri: r.redirect_uri,
          code_challenge: r.code_challenge,
          card_id: card.id,
          user_id: card.user_id,
          resource: r.resource,
          scope: r.scope,
        },
        120,
      );
      return {
        redirect_to: appendRedirectParams(r.redirect_uri, { code, ...(r.state ? { state: r.state } : {}) }),
      };
    }),
  );

  app.post("/oauth/deny", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { request_id?: string };
      if (!body.request_id) throw new RefusalError("invalid_terms", "request_id required");
      const r = ownedRequest(c, body.request_id);
      oauth.deleteRequest(body.request_id);
      return {
        redirect_to: appendRedirectParams(r.redirect_uri, {
          error: "access_denied",
          error_description: "the user denied the request",
          ...(r.state ? { state: r.state } : {}),
        }),
      };
    }),
  );

  return app;
}
