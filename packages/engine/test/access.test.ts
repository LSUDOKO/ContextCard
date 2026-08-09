import { describe, expect, test } from "bun:test";
import { Store, periodWindow } from "../src/store";
import {
  assertCardSpendable,
  authorizeAccess,
  filterSearchResults,
  gateEntity,
  recordAccess,
  validateBudget,
} from "../src/access";
import { issueRootCard, issueSubCard } from "../src/issuance";
import { RefusalError } from "../src/errors";
import type { CardTerms } from "../src/types";

const NOW = Math.floor(Date.now() / 1000);

function freshStore(): Store {
  return new Store(":memory:");
}

const dayTerms: CardTerms = {
  budget: { period: { amount: 100, seconds: 86400 }, lifetime: { amount: 1000 } },
  scope: { domains: ["urn:li:domain:finance"], entityTypes: ["DATASET"] },
  mutations: "documents",
};

function mkChain(store: Store, rootTerms: CardTerms) {
  const root = issueRootCard(store, { userId: "steward", name: "root", terms: rootTerms });
  const child = issueSubCard(store, {
    parentCardId: root.cardId,
    name: "child",
    terms: { scope: { domains: ["urn:li:domain:finance"], entityTypes: ["DATASET"] } },
  });
  return { root, child, chain: store.ancestorChain(child.cardId) };
}

describe("assertCardSpendable (liveness)", () => {
  test("frozen card refuses", () => {
    const store = freshStore();
    const { root, child } = mkChain(store, dayTerms);
    store.setCardStatus(root.cardId, "frozen");
    const chain = store.ancestorChain(child.cardId); // fresh rows: status from the DB
    try {
      assertCardSpendable(chain, NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("card_frozen");
    }
  });

  test("revoked ancestor refuses", () => {
    const store = freshStore();
    const { root, child } = mkChain(store, dayTerms);
    store.setCardStatus(root.cardId, "revoked");
    const chain = store.ancestorChain(child.cardId);
    expect(() => assertCardSpendable(chain, NOW)).toThrowError(RefusalError);
  });

  test("expired card refuses", () => {
    const store = freshStore();
    // issued with a near expiry, then checked AFTER it passes
    const { child } = mkChain(store, { ...dayTerms, expiry: NOW + 60 });
    const chain = store.ancestorChain(child.cardId);
    try {
      assertCardSpendable(chain, NOW + 120);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("card_expired");
    }
  });
});

describe("validateBudget (subtree-wide, fixed windows)", () => {
  test("period and lifetime pass within caps", () => {
    const store = freshStore();
    const { chain } = mkChain(store, dayTerms);
    const r = validateBudget(store, chain, NOW, 1);
    expect(r.remainingThisPeriod).toBe(99);
    expect(r.remainingLifetime).toBe(999);
    expect(r.periodResetsAt).not.toBeNull();
  });

  test("child draws down the parent's period budget", () => {
    const store = freshStore();
    const { root, child, chain } = mkChain(store, dayTerms);
    // burn 90 via the child
    for (let i = 0; i < 90; i++) recordAccess(store, child.cardId, { kind: "search", status: "ok" });
    expect(store.subtreeUnitsSince(root.cardId, 0)).toBe(90);
    // 10 left this period: 11 must refuse over_period_limit
    try {
      validateBudget(store, chain, NOW, 11);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("over_period_limit");
    }
    const ok = validateBudget(store, chain, NOW, 10);
    expect(ok.remainingThisPeriod).toBe(0);
  });

  test("lifetime cap refuses when exhausted", () => {
    const store = freshStore();
    const { root, child } = mkChain(store, { budget: { lifetime: { amount: 5 } } });
    for (let i = 0; i < 5; i++) recordAccess(store, child.cardId, { kind: "get_entities", status: "ok" });
    const chain = store.ancestorChain(child.cardId);
    try {
      validateBudget(store, chain, NOW, 1);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("over_lifetime_limit");
    }
    expect(store.subtreeUnitsLifetime(root.cardId)).toBe(5);
  });

  test("maxUses refuses when spent", () => {
    const store = freshStore();
    const { root, child } = mkChain(store, { budget: { lifetime: { amount: 100 } }, maxUses: 3 });
    for (let i = 0; i < 3; i++) recordAccess(store, child.cardId, { kind: "search", status: "ok" });
    const chain = store.ancestorChain(child.cardId);
    try {
      validateBudget(store, chain, NOW, 1);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("uses_exhausted");
    }
    void root;
  });

  test("units must be a positive integer", () => {
    const store = freshStore();
    const { chain } = mkChain(store, dayTerms);
    expect(() => validateBudget(store, chain, NOW, 0)).toThrowError(RefusalError);
  });
});

describe("recordAccess (idempotent ledger)", () => {
  test("debits once; idempotency key replays the original row", () => {
    const store = freshStore();
    const { child } = mkChain(store, dayTerms);
    const a = recordAccess(store, child.cardId, { kind: "search", status: "ok", idempotencyKey: "k1" });
    const b = recordAccess(store, child.cardId, { kind: "search", status: "ok", idempotencyKey: "k1" });
    expect(a.id).toBe(b.id);
    expect(b.replayed).toBe(true);
    expect(store.subtreeUnitsLifetime(child.cardId)).toBe(1);
  });

  test("refused/failed rows never debit budget", () => {
    const store = freshStore();
    const { child } = mkChain(store, dayTerms);
    recordAccess(store, child.cardId, { kind: "search", status: "refused", memo: "over_period_limit" });
    recordAccess(store, child.cardId, { kind: "get_entities", status: "failed" });
    expect(store.subtreeUnitsLifetime(child.cardId)).toBe(0);
  });
});

describe("gateEntity", () => {
  test("refuses out-of-scope entities with a typed reason", () => {
    const store = freshStore();
    const { child } = mkChain(store, dayTerms);
    const policy = store.getCard(child.cardId)!.policy;
    gateEntity(policy, { urn: "urn:li:dataset:(prod,orders,1)", domainUrns: ["urn:li:domain:finance"], type: "DATASET" });
    try {
      gateEntity(policy, { urn: "urn:li:mlmodel:bert", type: "MLMODEL" });
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("entity_type_not_allowed");
    }
  });
});

describe("periodWindow (fixed windows)", () => {
  test("resets at start + k*seconds", () => {
    const w = periodWindow(1_000, 100, 1_250);
    expect(w.start).toBe(1_200);
    expect(w.resetsAt).toBe(1_300);
  });

  test("before start clamps to the initial window", () => {
    const w = periodWindow(1_000, 100, 900);
    expect(w.start).toBe(1_000);
    expect(w.resetsAt).toBe(1_100);
  });
});

describe("authorizeAccess", () => {
  test("one-stop: liveness + budget for a metered call", () => {
    const store = freshStore();
    const { child, chain } = mkChain(store, dayTerms);
    const r = authorizeAccess(store, chain, NOW, 1);
    expect(r.remainingThisPeriod).toBe(99);
  });
});

describe("filterSearchResults", () => {
  test("drops rows the entities/entity-types allowlists can prove out of scope", () => {
    const store = freshStore();
    const { child } = mkChain(store, dayTerms); // scope: finance domain + DATASET type
    const policy = store.getCard(child.cardId)!.policy;
    const kept = filterSearchResults(policy, [
      { urn: "urn:li:dataset:(prod,orders,1)", type: "DATASET" },
      { urn: "urn:li:mlmodel:bert", type: "MLMODEL" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.urn).toBe("urn:li:dataset:(prod,orders,1)");
  });

  test("unrestricted scopes pass everything through", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "s", name: "r", terms: { budget: { lifetime: { amount: 10 } } } });
    const policy = store.getCard(root.cardId)!.policy;
    const kept = filterSearchResults(policy, [{ urn: "urn:li:mlmodel:bert", type: "MLMODEL" }]);
    expect(kept).toHaveLength(1);
  });
});
