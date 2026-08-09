// Lifecycle ops. No crypto, no relayer: freeze (reversible), revoke (card +
// subtree, permanent), nuke (every card of the user), delete (dead trees only).
// The chain-of-trust backstop GlassPay had on-chain is replaced by the server
// being the single authority over card status — revocation is instant, which is
// the product's promise ("dead the moment you revoke").

import { activeCards, emitCardLog } from "./telemetry";
import { decryptSecret, encryptSecret, hashCardSecret, randomSecret, type Store } from "./store";
import { RefusalError } from "./errors";

export function freezeCard(store: Store, cardId: string): void {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  if (card.status !== "active") throw new RefusalError("invalid_terms", "only active cards can be frozen");
  store.setCardStatus(cardId, "frozen");
  emitCardLog("frozen", cardId);
}

export function unfreezeCard(store: Store, cardId: string): void {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  if (card.status !== "frozen") throw new RefusalError("invalid_terms", "only frozen cards can be unfrozen");
  store.setCardStatus(cardId, "active");
  emitCardLog("unfrozen", cardId);
}

export function revokeCard(store: Store, cardId: string): void {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  if (card.status === "revoked" || card.status === "nuked") return; // idempotent
  const count = store.subtreeIds(cardId).length;
  store.setSubtreeStatus(cardId, "revoked");
  activeCards.add(-count);
  emitCardLog("revoked", cardId, { subtree: String(count) });
}

export function nukeAll(store: Store, userId: string): void {
  const cards = store.listCards(userId);
  const live = cards.filter((c) => c.status === "active" || c.status === "frozen");
  store.setAllUserCardsStatus(userId, "nuked");
  activeCards.add(-live.length);
  emitCardLog("nuked", userId, { cards: String(live.length) });
}

/** Hard-delete a DEAD card tree (revoked/nuked/expired only — nothing live may be
 * deleted, including a live descendant, checked subtree-wide). */
export function deleteDeadCard(store: Store, cardId: string): { removed: number } {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  const state = store.cardState(cardId, Math.floor(Date.now() / 1000));
  const alive = state && (state.status === "active" || state.status === "frozen");
  if (alive) throw new RefusalError("invalid_terms", "only revoked, nuked, or expired cards can be deleted");
  // no live descendants either
  for (const id of store.subtreeIds(cardId)) {
    const s = store.cardState(id, Math.floor(Date.now() / 1000));
    if (s && (s.status === "active" || s.status === "frozen")) {
      throw new RefusalError("invalid_terms", `descendant ${id} is still live`);
    }
  }
  const removed = store.deleteCardTree(cardId);
  return { removed };
}

export function rotateCardSecret(store: Store, cardId: string): string {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  const secret = randomSecret();
  store.rotateSecret(cardId, hashCardSecret(secret), encryptSecret(secret));
  emitCardLog("secret_rotated", cardId);
  return secret;
}

/** Re-view the stored secret (encrypted at rest under DATACARDS_MASTER_KEY). */
export function viewCardSecret(store: Store, cardId: string): string | null {
  const card = store.getCard(cardId);
  if (!card || !card.secret_enc) return null;
  return decryptSecret(card.secret_enc);
}
