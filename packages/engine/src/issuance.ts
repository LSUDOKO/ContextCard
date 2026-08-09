// Issuance: root + sub-card creation. Server-side only — a card is a bearer
// secret, not a signed delegation, so there is no client-signing lane. Sub-card
// terms are attenuated against the parent (scope subset-only, budget capped to
// the parent's remaining) before persist, mirroring the on-chain chain-3
// redelegation GlassPay proved.

import { attenuate, compilePolicy } from "./policy";
import { activeCards, cardsIssuedTotal, emitCardLog } from "./telemetry";
import { encryptSecret, hashCardSecret, periodWindow, randomSecret, type CardRow, type Store } from "./store";
import type { CardTerms } from "./types";

export type IssuedCard = { cardId: string; secret: string; terms: CardTerms; parent_card_id: string | null };

function persist(store: Store, c: Omit<CardRow, "created_at" | "policy">): IssuedCard {
  const secret = randomSecret();
  const secretEnc = encryptSecret(secret);
  const policy = compilePolicy(c.terms, Math.floor(Date.now() / 1000));
  store.createCard({ ...c, policy, secret_hash: hashCardSecret(secret), secret_enc: secretEnc });
  cardsIssuedTotal.add(1);
  activeCards.add(1);
  emitCardLog(c.parent_card_id ? "subcard_issued" : "issued", c.id, { parent: c.parent_card_id ?? "" });
  return { cardId: c.id, secret, terms: c.terms, parent_card_id: c.parent_card_id };
}

export function issueRootCard(
  store: Store,
  input: { userId: string; name: string; terms: CardTerms },
): IssuedCard {
  const now = Math.floor(Date.now() / 1000);
  store.upsertUser({ id: input.userId, name: input.name });
  const cardId = crypto.randomUUID();
  return persist(store, {
    id: cardId,
    user_id: input.userId,
    parent_card_id: null,
    name: input.name,
    secret_hash: "", // replaced in persist()
    secret_enc: null,
    terms: input.terms,
    status: "active",
  });
}

export function issueSubCard(
  store: Store,
  input: { parentCardId: string; name: string; terms: CardTerms },
): IssuedCard {
  const now = Math.floor(Date.now() / 1000);
  const parent = store.getCard(input.parentCardId);
  if (!parent) throw new Error("parent card not found");
  const p = parent.policy;
  // remaining budget of the parent (the child may inherit at most this much)
  const w = p.period ? periodWindow(parent.created_at, p.period.seconds, now) : null;
  const periodRemaining = p.period
    ? Math.max(0, p.period.amount - store.subtreeUnitsSince(parent.id, w!.start))
    : null;
  const lifetimeRemaining = p.lifetime !== null ? Math.max(0, p.lifetime - store.subtreeUnitsLifetime(parent.id)) : null;
  const spendRemaining = p.spend
    ? Math.max(0, p.spend.amount - store.subtreeSpendSince(parent.id, periodWindow(parent.created_at, p.spend.seconds, now).start))
    : null;
  const childTerms = attenuate(p, { periodRemaining, lifetimeRemaining, spendRemaining }, input.terms, now);
  const cardId = crypto.randomUUID();
  return persist(store, {
    id: cardId,
    user_id: parent.user_id,
    parent_card_id: parent.id,
    name: input.name,
    secret_hash: "",
    secret_enc: null,
    terms: childTerms,
    status: "active",
  });
}
