import { describe, expect, test } from "bun:test";
import { Store, cardTreeKey, hashCardSecret } from "../src/store";
import { issueRootCard, issueSubCard } from "../src/issuance";
import { RefusalError } from "../src/errors";
import type { CardTerms } from "../src/types";

const NOW = Math.floor(Date.now() / 1000);

function freshStore(): Store {
  return new Store(":memory:");
}

const rootTerms: CardTerms = {
  scope: {
    domains: ["urn:li:domain:finance"],
    entityTypes: ["DATASET", "DASHBOARD"],
    glossaryTerms: ["urn:li:glossaryterm:revenue"],
    lineageDepth: 2,
  },
  budget: { period: { amount: 500, seconds: 86400 }, lifetime: { amount: 5000 } },
  mutations: "documents",
  expiry: NOW + 86400 * 30,
};

describe("issueRootCard", () => {
  test("creates an active card with a bearer secret", () => {
    const store = freshStore();
    const issued = issueRootCard(store, { userId: "steward", name: "analyst", terms: rootTerms });
    const row = store.getCard(issued.cardId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("active");
    expect(row!.parent_card_id).toBeNull();
    expect(issued.secret.length).toBeGreaterThanOrEqual(32);
    expect(row!.secret_hash).toBe(hashCardSecret(issued.secret));
    expect(row!.policy.scope.entityTypes).toEqual(["DATASET", "DASHBOARD"]);
  });

  test("invalid terms refuse at issue time", () => {
    const store = freshStore();
    expect(() => issueRootCard(store, { userId: "steward", name: "x", terms: { scope: {} } })).toThrow(
      RefusalError,
    );
  });
});

describe("issueSubCard", () => {
  test("attenuates against the parent end to end", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: rootTerms });
    const child = issueSubCard(store, {
      parentCardId: root.cardId,
      name: "child",
      terms: { scope: { domains: ["urn:li:domain:finance"] }, budget: { period: { amount: 50, seconds: 86400 } } },
    });
    const row = store.getCard(child.cardId)!;
    expect(row.parent_card_id).toBe(root.cardId);
    expect(row.user_id).toBe("steward");
    // inherited lifetime + expiry + the parent's restricting scope dims (domains
    // narrowed, entityTypes/glossaryTerms inherited), narrowed period cap
    expect(row.policy.lifetime).toBe(5000);
    expect(row.policy.expiry).toBe(rootTerms.expiry);
    expect(row.policy.scope.domains).toEqual(["urn:li:domain:finance"]);
    expect(row.policy.scope.entityTypes).toEqual(["DATASET", "DASHBOARD"]);
    expect(row.policy.scope.glossaryTerms).toEqual(["urn:li:glossaryterm:revenue"]);
    expect(row.policy.period?.amount).toBe(50);
  });

  test("sub-card of a sub-card: three-deep tree draws down every ancestor", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: rootTerms });
    const a = issueSubCard(store, { parentCardId: root.cardId, name: "a", terms: {} });
    const b = issueSubCard(store, { parentCardId: a.cardId, name: "b", terms: { scope: { entityTypes: ["DATASET"] } } });
    const chain = store.ancestorChain(b.cardId);
    expect(chain.map((c) => c.id)).toEqual([b.cardId, a.cardId, root.cardId]);
    // subtree ids: root + a + b
    const key = cardTreeKey(store, root.cardId);
    expect(key.split(",")).toHaveLength(3);
  });

  test("child cannot exceed parent scope or budget", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: rootTerms });
    expect(() =>
      issueSubCard(store, { parentCardId: root.cardId, name: "bad", terms: { scope: { domains: ["urn:li:domain:marketing"] } } }),
    ).toThrow(RefusalError);
    expect(() =>
      issueSubCard(store, { parentCardId: root.cardId, name: "bad", terms: { budget: { period: { amount: 600, seconds: 86400 } } } }),
    ).toThrow(RefusalError);
    expect(() =>
      issueSubCard(store, { parentCardId: root.cardId, name: "bad", terms: { mutations: "documents" } }),
    ).not.toThrow();
  });
});
