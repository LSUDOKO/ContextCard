import { describe, expect, test } from "bun:test";
import { Store } from "../src/store";
import { authorizeSpend, recordAccess, validateBudget, validateSpend } from "../src/access";
import { issueRootCard, issueSubCard } from "../src/issuance";
import { attenuate, compilePolicy } from "../src/policy";
import { RefusalError } from "../src/errors";
import type { CardTerms } from "../src/types";

const NOW = Math.floor(Date.now() / 1000);

function freshStore(): Store {
  return new Store(":memory:");
}

const spendTerms: CardTerms = {
  budget: { period: { amount: 100, seconds: 86400 }, spend: { amount: 1000, seconds: 86400 } }, // $10/day spend
  scope: { domains: ["urn:li:domain:finance"], entityTypes: ["DATASET"] },
};

describe("compilePolicy (spend)", () => {
  test("budget.spend is validated and normalized", () => {
    const p = compilePolicy({ budget: { spend: { amount: 250, seconds: 604800 } } }, NOW);
    expect(p.spend).toEqual({ amount: 250, seconds: 604800 });
    expect(() => compilePolicy({ budget: { spend: { amount: 0, seconds: 86400 } } }, NOW)).toThrow(RefusalError);
    expect(() => compilePolicy({ budget: { spend: { amount: 10, seconds: 30 } } }, NOW)).toThrow(RefusalError); // min 60s
  });

  test("spend alone satisfies the at-least-one-cap rule", () => {
    expect(compilePolicy({ budget: { spend: { amount: 100, seconds: 86400 } } }, NOW).spend).not.toBeNull();
  });

  test("maxRows validates", () => {
    expect(compilePolicy({ budget: { spend: { amount: 100, seconds: 86400 } }, maxRows: 500 }, NOW).maxRows).toBe(500);
    expect(() => compilePolicy({ budget: { spend: { amount: 100, seconds: 86400 } }, maxRows: 0 }, NOW)).toThrow(
      RefusalError,
    );
  });
});

describe("validateSpend (fiat lane)", () => {
  test("passes within the window and returns remaining", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: spendTerms });
    const chain = store.ancestorChain(root.cardId);
    const r = validateSpend(store, chain, NOW, 400);
    expect(r.remainingSpend).toBe(600);
    expect(r.spendResetsAt).not.toBeNull();
  });

  test("refuses over the window cap with a typed code", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: spendTerms });
    const chain = store.ancestorChain(root.cardId);
    try {
      validateSpend(store, chain, NOW, 1001); // cap is 1000 cents
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("over_spend_limit");
    }
  });

  test("child purchases draw down the parent's spend window", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: spendTerms });
    const child = issueSubCard(store, { parentCardId: root.cardId, name: "child", terms: {} });
    store.insertCharge({
      id: crypto.randomUUID(),
      card_id: child.cardId,
      idempotency_key: `stripe-test-${crypto.randomUUID()}`,
      kind: "fiat_pay",
      to_urn: null,
      units: 1,
      spend_usd_cents: 800,
      status: "ok",
      memo: "visa",
      created_at: NOW,
    });
    expect(store.subtreeSpendSince(root.cardId, 0)).toBe(800);
    const chain = store.ancestorChain(child.cardId);
    try {
      validateSpend(store, chain, NOW, 201);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("over_spend_limit");
    }
  });

  test("refuses no_spend_budget when no card in the chain has spend", () => {
    const store = freshStore();
    const root = issueRootCard(store, {
      userId: "steward",
      name: "root",
      terms: { budget: { period: { amount: 100, seconds: 86400 } } },
    });
    const chain = store.ancestorChain(root.cardId);
    try {
      validateSpend(store, chain, NOW, 100);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("no_spend_budget");
    }
  });

  test("authorizeSpend checks liveness first", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: spendTerms });
    store.setCardStatus(root.cardId, "frozen");
    const chain = store.ancestorChain(root.cardId);
    expect(() => authorizeSpend(store, chain, NOW, 100)).toThrowError(RefusalError);
  });
});

describe("attenuate (spend + maxRows)", () => {
  const parent = compilePolicy(
    {
      budget: { period: { amount: 500, seconds: 86400 }, spend: { amount: 2000, seconds: 86400 } },
      maxRows: 500,
    },
    NOW,
  );
  const remaining = { periodRemaining: 100, lifetimeRemaining: null, spendRemaining: 1500 };

  test("omitted spend inherits the parent capped to remaining; maxRows inherits", () => {
    const c = attenuate(parent, remaining, {}, NOW);
    expect(c.budget?.spend).toEqual({ amount: 1500, seconds: 86400 });
    expect(c.maxRows).toBe(500);
  });

  test("explicit spend must fit the parent cap and its remaining", () => {
    const ok = attenuate(parent, remaining, { budget: { spend: { amount: 1200, seconds: 86400 } } }, NOW);
    expect(ok.budget?.spend?.amount).toBe(1200);
    expect(() => attenuate(parent, remaining, { budget: { spend: { amount: 1600, seconds: 86400 } } }, NOW)).toThrow(
      RefusalError,
    );
    expect(() => attenuate(parent, remaining, { maxRows: 501 }, NOW)).toThrow(RefusalError);
  });

  test("a child may not add spend the parent lacks", () => {
    const noSpend = compilePolicy({ budget: { period: { amount: 10, seconds: 86400 } } }, NOW);
    expect(() =>
      attenuate(
        noSpend,
        { periodRemaining: 5, lifetimeRemaining: null, spendRemaining: null },
        { budget: { spend: { amount: 100, seconds: 86400 } } },
        NOW,
      ),
    ).toThrow(RefusalError);
  });
});

describe("recordAccess (idempotent ledger)", () => {
  test("replays on the same idempotency key without double-debiting", () => {
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: spendTerms });
    const first = recordAccess(store, root.cardId, {
      idempotencyKey: "stripe-auth-1",
      kind: "fiat_pay",
      units: 1,
      spend_usd_cents: 300,
      memo: "visa",
      status: "ok",
    });
    const second = recordAccess(store, root.cardId, {
      idempotencyKey: "stripe-auth-1",
      kind: "fiat_pay",
      units: 1,
      spend_usd_cents: 300,
      memo: "visa",
      status: "ok",
    });
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(store.subtreeSpendSince(root.cardId, 0)).toBe(300); // once, never 600
    expect(store.subtreeUnitsSince(root.cardId, 0)).toBe(1);
  });

  test("the webhook/fiat_pay UNIQUE race resolves as replayed, not a crash", () => {
    // the webhook books the row first (units: 0 — a purchase, not a tool call),
    // then fiat_pay races in with the same authorization id: recordAccess must
    // report replayed and never double-book spend
    const store = freshStore();
    const root = issueRootCard(store, { userId: "steward", name: "root", terms: spendTerms });
    store.insertCharge({
      id: crypto.randomUUID(),
      card_id: root.cardId,
      idempotency_key: "stripe-auth-2",
      kind: "fiat",
      to_urn: null,
      units: 0,
      spend_usd_cents: 400,
      status: "ok",
      memo: "visa",
      created_at: NOW,
    });
    const recorded = recordAccess(store, root.cardId, {
      idempotencyKey: "stripe-auth-2",
      kind: "fiat_pay",
      units: 1,
      spend_usd_cents: 400,
      memo: "visa",
      status: "ok",
    });
    expect(recorded.replayed).toBe(true);
    expect(store.subtreeSpendSince(root.cardId, 0)).toBe(400);
  });
});

describe("maxUses ignores the payment lane's browser rows", () => {
  test("units:0 fiat/checkout rows never consume the use budget", () => {
    const store = freshStore();
    const root = issueRootCard(store, {
      userId: "steward",
      name: "root",
      terms: {
        budget: { period: { amount: 100, seconds: 86400 }, spend: { amount: 1000, seconds: 86400 } },
        maxUses: 2,
      },
    });
    // two browser-side purchases (units: 0) — these are NOT tool calls
    store.insertCharge({
      id: crypto.randomUUID(),
      card_id: root.cardId,
      idempotency_key: "stripe-a",
      kind: "fiat",
      to_urn: null,
      units: 0,
      spend_usd_cents: 100,
      status: "ok",
      memo: "visa",
      created_at: NOW,
    });
    store.insertCharge({
      id: crypto.randomUUID(),
      card_id: root.cardId,
      idempotency_key: "stripe-b",
      kind: "checkout",
      to_urn: null,
      units: 0,
      spend_usd_cents: 200,
      status: "ok",
      memo: "shop",
      created_at: NOW,
    });
    recordAccess(store, root.cardId, { kind: "search", memo: "q=orders" }); // 1 real tool call
    expect(store.subtreeUsesCount(root.cardId)).toBe(1); // purchases did not count
    const chain = store.ancestorChain(root.cardId);
    expect(() => validateBudget(store, chain, NOW, 1)).not.toThrow(); // 2nd call still allowed
    recordAccess(store, root.cardId, { kind: "get_entities", to_urn: "urn:li:dataset:a", memo: "1 entity" });
    expect(store.subtreeUsesCount(root.cardId)).toBe(2);
    try {
      validateBudget(store, store.ancestorChain(root.cardId), NOW, 1);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("uses_exhausted");
    }
  });
});
