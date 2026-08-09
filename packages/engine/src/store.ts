// bun:sqlite store: users, cards, charges (the access ledger) + the accounting math.
//
// ACCOUNTING LAW: a sub-card's usage draws down EVERY ancestor's budget — the same
// "subtree-wide" discipline GlassPay proved for money. A lead agent's card that
// issued sub-cards to sub-agents must not be surprised by their draw. Every tool
// call costs `units` (1 by default) against the whole ancestor chain's period and
// lifetime caps; period windows are FIXED (reset at start + k*seconds).

import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { compilePolicy, type CardPolicy } from "./policy";
import type { CardState, CardStatus, CardTerms } from "./types";

// ---------------------------------------------------------------------------
// Secret + encryption helpers (no wallet: cards carry bearer secrets)
// ---------------------------------------------------------------------------

export const hashCardSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export const randomSecret = (): string => randomBytes(32).toString("base64url");

const ENC_ALGO = "aes-256-gcm";

/** AES-256-GCM envelope encryption for the re-viewable secret. Requires
 * DATACARDS_MASTER_KEY (32-byte hex). Null master key => secrets are hash-only. */
export function encryptSecret(secret: string): Uint8Array | null {
  const hex = process.env.DATACARDS_MASTER_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENC_ALGO, Buffer.from(hex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, tag, ct]));
}

export function decryptSecret(enc: Uint8Array): string | null {
  const hex = process.env.DATACARDS_MASTER_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  try {
    const buf = Buffer.from(enc);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv(ENC_ALGO, Buffer.from(hex, "hex"), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Period window math (fixed windows, like the on-chain enforcer it replaces)
// ---------------------------------------------------------------------------

export type PeriodWindow = { start: number; resetsAt: number };

export function periodWindow(startDate: number, periodSeconds: number, now: number): PeriodWindow {
  if (now < startDate) return { start: startDate, resetsAt: startDate + periodSeconds };
  const k = Math.floor((now - startDate) / periodSeconds);
  const start = startDate + k * periodSeconds;
  return { start, resetsAt: start + periodSeconds };
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type ChargeStatus = "ok" | "refused" | "failed";

export type UserRow = { id: string; name: string | null; created_at: number };

export type CardRow = {
  id: string;
  user_id: string;
  parent_card_id: string | null;
  name: string;
  secret_hash: string;
  secret_enc: Uint8Array | null;
  terms: CardTerms;
  policy: CardPolicy;
  status: Exclude<CardStatus, "expired">; // "expired" is derived from terms+clock
  created_at: number;
};

export type ChargeRow = {
  id: string;
  card_id: string;
  idempotency_key: string | null;
  kind: string; // tool name
  to_urn: string | null;
  units: number;
  /** USD cents for fiat-lane charges (shop checkout / fiat_pay); null for tool calls. */
  spend_usd_cents: number | null;
  status: ChargeStatus;
  memo: string | null;
  created_at: number;
};

export type FiatLinkRow = {
  card_id: string;
  stripe_card_id: string;
  last4: string;
  brand: string | null;
  exp_month: number;
  exp_year: number;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class Store {
  readonly db: Database;

  constructor(path: string = process.env.DATACARDS_DB_PATH?.trim() || ".dev/datacards.sqlite") {
    // SQLite can't create a file in a missing directory (SQLITE_CANTOPEN) —
    // make the parent dir up front, including for the documented default.
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        parent_card_id TEXT REFERENCES cards(id),
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        secret_enc BLOB,
        terms_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);
      CREATE INDEX IF NOT EXISTS idx_cards_parent ON cards(parent_card_id);
      CREATE TABLE IF NOT EXISTS charges (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id),
        idempotency_key TEXT,
        kind TEXT NOT NULL,
        to_urn TEXT,
        units INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        memo TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_charges_card ON charges(card_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_charges_idem
        ON charges(card_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS fiat_links (
        card_id TEXT PRIMARY KEY REFERENCES cards(id),
        stripe_card_id TEXT NOT NULL,
        last4 TEXT NOT NULL,
        brand TEXT,
        exp_month INTEGER NOT NULL,
        exp_year INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const cols = this.db.query(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "secret_enc")) {
      this.db.exec(`ALTER TABLE cards ADD COLUMN secret_enc BLOB`);
    }
    const chCols = this.db.query(`PRAGMA table_info(charges)`).all() as Array<{ name: string }>;
    if (!chCols.some((c) => c.name === "spend_usd_cents")) {
      this.db.exec(`ALTER TABLE charges ADD COLUMN spend_usd_cents INTEGER`);
    }
  }

  // ---- users ----

  upsertUser(u: { id: string; name?: string | null }): void {
    this.db
      .query(
        `INSERT INTO users (id, name, created_at) VALUES ($id, $name, unixepoch())
         ON CONFLICT(id) DO UPDATE SET name = COALESCE($name, name)`,
      )
      .run({ $id: u.id, $name: u.name ?? null });
  }

  getUser(id: string): UserRow | null {
    return (this.db.query(`SELECT * FROM users WHERE id = $id`).get({ $id: id }) as UserRow) ?? null;
  }

  // ---- cards ----

  createCard(c: Omit<CardRow, "created_at"> & { created_at?: number }): void {
    this.db
      .query(
        `INSERT INTO cards (id, user_id, parent_card_id, name, secret_hash, secret_enc, terms_json, status, created_at)
         VALUES ($id, $user, $parent, $name, $hash, $senc, $terms, $status, $created)`,
      )
      .run({
        $id: c.id,
        $user: c.user_id,
        $parent: c.parent_card_id,
        $name: c.name,
        $hash: c.secret_hash,
        $senc: c.secret_enc,
        $terms: JSON.stringify(c.terms),
        $status: c.status,
        $created: c.created_at ?? Math.floor(Date.now() / 1000),
      });
  }

  private rowToCard(r: Record<string, unknown> | null): CardRow | null {
    if (!r) return null;
    const terms = JSON.parse(r.terms_json as string) as CardTerms;
    return {
      id: r.id as string,
      user_id: r.user_id as string,
      parent_card_id: (r.parent_card_id as string) ?? null,
      name: r.name as string,
      secret_hash: r.secret_hash as string,
      secret_enc: r.secret_enc ? new Uint8Array(r.secret_enc as Uint8Array) : null,
      terms,
      policy: compilePolicy(terms, Math.floor(Date.now() / 1000)),
      status: r.status as CardRow["status"],
      created_at: r.created_at as number,
    };
  }

  getCard(id: string): CardRow | null {
    return this.rowToCard(this.db.query(`SELECT * FROM cards WHERE id = $id`).get({ $id: id }) as never);
  }

  getCardBySecretHash(hash: string): CardRow | null {
    return this.rowToCard(this.db.query(`SELECT * FROM cards WHERE secret_hash = $h`).get({ $h: hash }) as never);
  }

  listCards(userId: string): CardRow[] {
    const rows = this.db.query(`SELECT * FROM cards WHERE user_id = $u ORDER BY created_at`).all({ $u: userId }) as never[];
    return rows.map((r) => this.rowToCard(r)!);
  }

  listChildren(parentCardId: string): CardRow[] {
    const rows = this.db
      .query(`SELECT * FROM cards WHERE parent_card_id = $p ORDER BY created_at`)
      .all({ $p: parentCardId }) as never[];
    return rows.map((r) => this.rowToCard(r)!);
  }

  /** The card and ALL its descendants (recursive). */
  subtreeIds(cardId: string): string[] {
    const rows = this.db
      .query(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM cards WHERE id = $id
           UNION ALL
           SELECT c.id FROM cards c JOIN sub s ON c.parent_card_id = s.id
         ) SELECT id FROM sub`,
      )
      .all({ $id: cardId }) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Ancestor chain card rows, this card FIRST, root LAST. */
  ancestorChain(cardId: string): CardRow[] {
    const chain: CardRow[] = [];
    let cur = this.getCard(cardId);
    while (cur) {
      chain.push(cur);
      cur = cur.parent_card_id ? this.getCard(cur.parent_card_id) : null;
    }
    return chain;
  }

  setCardStatus(cardId: string, status: CardRow["status"]): void {
    this.db.query(`UPDATE cards SET status = $s WHERE id = $id`).run({ $s: status, $id: cardId });
  }

  deleteCardTree(cardId: string): number {
    const ids = this.subtreeIds(cardId);
    if (ids.length === 0) return 0;
    const delCharges = this.db.query(`DELETE FROM charges WHERE card_id = $id`);
    const delCard = this.db.query(`DELETE FROM cards WHERE id = $id`);
    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) delCharges.run({ $id: id });
      for (const id of [...items].reverse()) delCard.run({ $id: id });
    });
    tx(ids);
    return ids.length;
  }

  setSubtreeStatus(cardId: string, status: CardRow["status"]): void {
    const ids = this.subtreeIds(cardId);
    const q = this.db.query(`UPDATE cards SET status = $s WHERE id = $id`);
    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) q.run({ $s: status, $id: id });
    });
    tx(ids);
  }

  setAllUserCardsStatus(userId: string, status: CardRow["status"]): void {
    this.db.query(`UPDATE cards SET status = $s WHERE user_id = $u`).run({ $s: status, $u: userId });
  }

  rotateSecret(cardId: string, newHash: string, newSecretEnc: Uint8Array | null = null): void {
    this.db
      .query(`UPDATE cards SET secret_hash = $h, secret_enc = $e WHERE id = $id`)
      .run({ $h: newHash, $e: newSecretEnc, $id: cardId });
  }

  // ---- charges (the access ledger) ----

  insertCharge(ch: Omit<ChargeRow, "spend_usd_cents"> & { spend_usd_cents?: number | null }): void {
    this.db
      .query(
        `INSERT INTO charges (id, card_id, idempotency_key, kind, to_urn, units, spend_usd_cents, status, memo, created_at)
         VALUES ($id, $card, $idem, $kind, $to, $units, $spend, $status, $memo, $created)`,
      )
      .run({
        $id: ch.id,
        $card: ch.card_id,
        $idem: ch.idempotency_key,
        $kind: ch.kind,
        $to: ch.to_urn,
        $units: ch.units,
        $spend: ch.spend_usd_cents ?? null,
        $status: ch.status,
        $memo: ch.memo,
        $created: ch.created_at,
      });
  }

  updateCharge(id: string, fields: { status?: ChargeStatus; memo?: string }): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { $id: id };
    if (fields.status !== undefined) {
      sets.push("status = $status");
      params.$status = fields.status;
    }
    if (fields.memo !== undefined) {
      sets.push("memo = $memo");
      params.$memo = fields.memo;
    }
    if (!sets.length) return;
    this.db.query(`UPDATE charges SET ${sets.join(", ")} WHERE id = $id`).run(params as never);
  }

  private rowToCharge(r: Record<string, unknown> | null): ChargeRow | null {
    if (!r) return null;
    return {
      id: r.id as string,
      card_id: r.card_id as string,
      idempotency_key: (r.idempotency_key as string) ?? null,
      kind: r.kind as string,
      to_urn: (r.to_urn as string) ?? null,
      units: Number(r.units),
      spend_usd_cents: r.spend_usd_cents === null || r.spend_usd_cents === undefined ? null : Number(r.spend_usd_cents),
      status: r.status as ChargeStatus,
      memo: (r.memo as string) ?? null,
      created_at: r.created_at as number,
    };
  }

  getCharge(id: string): ChargeRow | null {
    return this.rowToCharge(this.db.query(`SELECT * FROM charges WHERE id = $id`).get({ $id: id }) as never);
  }

  deleteCharge(id: string): void {
    this.db.query(`DELETE FROM charges WHERE id = $id`).run({ $id: id });
  }

  chargeByIdempotency(cardId: string, key: string): ChargeRow | null {
    return this.rowToCharge(
      this.db
        .query(`SELECT * FROM charges WHERE card_id = $c AND idempotency_key = $k`)
        .get({ $c: cardId, $k: key }) as never,
    );
  }

  listCharges(cardId: string, limit = 25): ChargeRow[] {
    const rows = this.db
      .query(`SELECT * FROM charges WHERE card_id = $c ORDER BY created_at DESC LIMIT $l`)
      .all({ $c: cardId, $l: limit }) as never[];
    return rows.map((r) => this.rowToCharge(r)!);
  }

  // ---- accounting (units, SUBTREE-wide, fixed windows) ----

  /** Units drawn across the subtree since `windowStart` (status = ok). */
  subtreeUnitsSince(cardId: string, windowStart: number): number {
    const ids = this.subtreeIds(cardId);
    const placeholders = ids.map((_, i) => `$c${i}`).join(",");
    const params: Record<string, unknown> = { $start: windowStart };
    ids.forEach((id, i) => (params[`$c${i}`] = id));
    const r = this.db
      .query(
        `SELECT COALESCE(SUM(units), 0) AS n FROM charges
         WHERE card_id IN (${placeholders}) AND status = 'ok' AND created_at >= $start`,
      )
      .get(params as never) as { n: number };
    return Number(r.n);
  }

  subtreeUnitsLifetime(cardId: string): number {
    return this.subtreeUnitsSince(cardId, 0);
  }

  /** USD cents drawn across the subtree since `windowStart` (fiat lane, status = ok). */
  subtreeSpendSince(cardId: string, windowStart: number): number {
    const ids = this.subtreeIds(cardId);
    const placeholders = ids.map((_, i) => `$c${i}`).join(",");
    const params: Record<string, unknown> = { $start: windowStart };
    ids.forEach((id, i) => (params[`$c${i}`] = id));
    const r = this.db
      .query(
        `SELECT COALESCE(SUM(spend_usd_cents), 0) AS n FROM charges
         WHERE card_id IN (${placeholders}) AND status = 'ok' AND spend_usd_cents IS NOT NULL AND created_at >= $start`,
      )
      .get(params as never) as { n: number };
    return Number(r.n);
  }

  subtreeSpendLifetime(cardId: string): number {
    return this.subtreeSpendSince(cardId, 0);
  }

  // ---- fiat links (the Stripe test-mode Visa bound to a card) ----

  getFiatLink(cardId: string): FiatLinkRow | null {
    return (this.db.query(`SELECT * FROM fiat_links WHERE card_id = $id`).get({ $id: cardId }) as FiatLinkRow) ?? null;
  }

  /** Reverse lookup for the Stripe webhook: an authorization arrives with the
   * Issuing card id, and we must resolve the DataCards card that owns it. */
  getFiatLinkByStripeCardId(stripeCardId: string): FiatLinkRow | null {
    return (this.db.query(`SELECT * FROM fiat_links WHERE stripe_card_id = $id`).get({ $id: stripeCardId }) as FiatLinkRow) ?? null;
  }

  setFiatLink(row: FiatLinkRow): void {
    this.db
      .query(
        `INSERT INTO fiat_links (card_id, stripe_card_id, last4, brand, exp_month, exp_year, created_at)
         VALUES ($card, $s, $l4, $brand, $em, $ey, $created)
         ON CONFLICT(card_id) DO UPDATE SET stripe_card_id = $s, last4 = $l4, brand = $brand, exp_month = $em, exp_year = $ey`,
      )
      .run({
        $card: row.card_id,
        $s: row.stripe_card_id,
        $l4: row.last4,
        $brand: row.brand,
        $em: row.exp_month,
        $ey: row.exp_year,
        $created: row.created_at,
      });
  }

  /** Number of ok TOOL CALLS through this card's subtree (maxUses mirror).
   * units > 0 filters out the payment lane's browser-side rows (Stripe webhook
   * "fiat", shop "checkout" — units: 0): a purchase is not a tool call and must
   * not burn the card's use budget. */
  subtreeUsesCount(cardId: string): number {
    const ids = this.subtreeIds(cardId);
    const placeholders = ids.map((_, i) => `$c${i}`).join(",");
    const params: Record<string, unknown> = {};
    ids.forEach((id, i) => (params[`$c${i}`] = id));
    const r = this.db
      .query(`SELECT COUNT(*) AS n FROM charges WHERE card_id IN (${placeholders}) AND status = 'ok' AND units > 0`)
      .get(params as never) as { n: number };
    return Number(r.n);
  }

  // ---- live state ----

  /** The agent/dashboard-facing state snapshot for a card. */
  cardState(cardId: string, now: number): CardState | null {
    const card = this.getCard(cardId);
    if (!card) return null;
    const expired = card.terms.expiry !== undefined && now >= card.terms.expiry;
    const status: CardState["status"] = expired ? "expired" : card.status;
    const p = card.policy;
    let remainingThisPeriod: number | null = null;
    let resetsAt: number | null = null;
    if (p.period) {
      const w = periodWindow(card.created_at, p.period.seconds, now);
      const used = this.subtreeUnitsSince(cardId, w.start);
      remainingThisPeriod = Math.max(0, p.period.amount - used);
      resetsAt = w.resetsAt;
    }
    let remainingLifetime: number | null = null;
    if (p.lifetime !== null) remainingLifetime = Math.max(0, p.lifetime - this.subtreeUnitsLifetime(cardId));
    let remainingSpend: number | null = null;
    let spendResetsAt: number | null = null;
    if (p.spend) {
      const w = periodWindow(card.created_at, p.spend.seconds, now);
      const used = this.subtreeSpendSince(cardId, w.start);
      remainingSpend = Math.max(0, p.spend.amount - used);
      spendResetsAt = w.resetsAt;
    }
    const usesRemaining = p.maxUses !== null ? Math.max(0, p.maxUses - this.subtreeUsesCount(cardId)) : null;
    return {
      card_id: card.id,
      name: card.name,
      status,
      terms: card.terms,
      remaining_this_period: remainingThisPeriod,
      remaining_lifetime: remainingLifetime,
      period_resets_at: resetsAt,
      remaining_spend: remainingSpend,
      spend_resets_at: spendResetsAt,
      expires_at: card.terms.expiry ?? null,
      uses_remaining: usesRemaining,
      subcards: this.listChildren(cardId).map((c) => c.id),
    };
  }

  close(): void {
    this.db.close();
  }
}

/** A stable serialization key for a card's whole tree (itself + descendants).
 * Used as the per-tree mutex key so concurrent metered calls on one card tree
 * validate one-at-a-time. */
export function cardTreeKey(store: Store, cardId: string): string {
  return store.subtreeIds(cardId).sort().join(",");
}
