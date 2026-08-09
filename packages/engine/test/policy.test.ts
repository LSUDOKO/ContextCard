import { describe, expect, test } from "bun:test";
import { compilePolicy, scopeAllows, scopeSearchFilters, degreeFilterValues, attenuate } from "../src/policy";
import { RefusalError } from "../src/errors";
import type { CardTerms } from "../src/types";

const NOW = 1_800_000_000;

describe("compilePolicy", () => {
  test("requires at least one budget cap", () => {
    expect(() => compilePolicy({ scope: {} }, NOW)).toThrowError(RefusalError);
    try {
      compilePolicy({ scope: {} }, NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as RefusalError).code).toBe("invalid_terms");
    }
  });

  test("rejects bad period shapes", () => {
    expect(() => compilePolicy({ budget: { period: { amount: 0, seconds: 86400 } } }, NOW)).toThrow();
    expect(() => compilePolicy({ budget: { period: { amount: 5, seconds: 30 } } }, NOW)).toThrow(); // min 60s
    expect(() => compilePolicy({ budget: { period: { amount: 2.5, seconds: 86400 } } }, NOW)).toThrow();
  });

  test("normalizes scope: lowercase urns, dedupe, clamp lineageDepth", () => {
    const p = compilePolicy(
      {
        scope: {
          domains: ["URN:LI:DOMAIN:FINANCE", "urn:li:domain:finance"],
          entityTypes: ["dataset", "DASHBOARD"],
          entities: ["urn:li:dataset:(prod,orders,1)", "URN:LI:DATASET:(prod,orders,1)"],
          lineageDepth: 9,
        },
        budget: { period: { amount: 10, seconds: 86400 } },
      },
      NOW,
    );
    expect(p.scope.domains).toEqual(["urn:li:domain:finance"]);
    expect(p.scope.entityTypes).toEqual(["DATASET", "DASHBOARD"]);
    expect(p.scope.entities).toEqual(["urn:li:dataset:(prod,orders,1)"]);
    expect(p.scope.lineageDepth).toBe(3);
  });

  test("rejects malformed urns in scope fields", () => {
    expect(() =>
      compilePolicy(
        { scope: { domains: ["not-a-urn"] }, budget: { lifetime: { amount: 100 } } },
        NOW,
      ),
    ).toThrow();
  });

  test("validates expiry and maxUses", () => {
    expect(() => compilePolicy({ budget: { lifetime: { amount: 5 } }, expiry: NOW - 10 }, NOW)).toThrow();
    expect(() => compilePolicy({ budget: { lifetime: { amount: 5 } }, maxUses: 0 }, NOW)).toThrow();
    const p = compilePolicy({ budget: { lifetime: { amount: 5 } }, maxUses: 7, expiry: NOW + 100 }, NOW);
    expect(p.maxUses).toBe(7);
    expect(p.expiry).toBe(NOW + 100);
  });

  test("mutations default to none; subcards default true", () => {
    const p = compilePolicy({ budget: { lifetime: { amount: 5 } } }, NOW);
    expect(p.mutations).toBe("none");
    expect(p.subcards).toBe(true);
    const w = compilePolicy({ budget: { lifetime: { amount: 5 } }, mutations: "documents", subcards: false }, NOW);
    expect(w.mutations).toBe("documents");
    expect(w.subcards).toBe(false);
  });
});

describe("scopeAllows", () => {
  const policy = (scope: CardTerms["scope"]) =>
    compilePolicy({ scope, budget: { lifetime: { amount: 100 } } }, NOW);

  test("empty scope admits everything", () => {
    const p = policy({});
    expect(scopeAllows(p, { urn: "urn:li:dataset:(prod,orders,1)" }).ok).toBe(true);
  });

  test("entity allowlist is exclusive", () => {
    const p = policy({ entities: ["urn:li:dataset:(prod,orders,1)"] });
    expect(scopeAllows(p, { urn: "urn:li:dataset:(prod,orders,1)" }).ok).toBe(true);
    const other = scopeAllows(p, { urn: "urn:li:dataset:(prod,users,1)" });
    expect(other.ok).toBe(false);
    expect(other.reason).toBe("entity_not_allowed");
  });

  test("domain match admits; wrong domain refuses with typed reason", () => {
    const p = policy({ domains: ["urn:li:domain:finance"] });
    expect(scopeAllows(p, { urn: "urn:li:dataset:(prod,orders,1)", domainUrns: ["urn:li:domain:finance"] }).ok).toBe(true);
    const no = scopeAllows(p, { urn: "urn:li:dataset:(prod,orders,1)", domainUrns: ["urn:li:domain:marketing"] });
    expect(no.ok).toBe(false);
    expect(no.reason).toBe("domain_not_allowed");
  });

  test("platform gate", () => {
    const p = policy({ platforms: ["urn:li:dataplatform:snowflake"] });
    const ok = scopeAllows(p, { urn: "urn:li:dataset:(prod,orders,1)", platformUrn: "urn:li:dataPlatform:snowflake" });
    expect(ok.ok).toBe(true);
    const bad = scopeAllows(p, { urn: "urn:li:dataset:(prod,orders,1)", platformUrn: "urn:li:dataPlatform:bigquery" });
    expect(bad.reason).toBe("platform_not_allowed");
  });

  test("entity-type gate", () => {
    const p = policy({ entityTypes: ["DATASET", "DASHBOARD"] });
    expect(scopeAllows(p, { urn: "urn:li:dashboard:myboard", type: "DASHBOARD" }).ok).toBe(true);
    const bad = scopeAllows(p, { urn: "urn:li:mlmodel:bert", type: "MLMODEL" });
    expect(bad.reason).toBe("entity_type_not_allowed");
  });

  test("glossary-term gate", () => {
    const p = policy({ glossaryTerms: ["urn:li:glossaryterm:revenue"] });
    const ok = scopeAllows(p, { urn: "urn:li:dataset:(prod,orders,1)", glossaryTermUrns: ["urn:li:glossaryTerm:revenue"] });
    expect(ok.ok).toBe(true);
  });
});

describe("scopeSearchFilters", () => {
  test("compiles orFilters from domains/platforms/glossary terms", () => {
    const p = compilePolicy(
      {
        scope: {
          domains: ["urn:li:domain:finance"],
          platforms: ["urn:li:dataplatform:snowflake"],
          entityTypes: ["DATASET"],
        },
        budget: { lifetime: { amount: 100 } },
      },
      NOW,
    );
    const f = scopeSearchFilters(p);
    expect(f.types).toEqual(["DATASET"]);
    expect(f.orFilters?.[0].and).toHaveLength(2);
  });

  test("empty for unrestricted scope", () => {
    expect(scopeSearchFilters(compilePolicy({ budget: { lifetime: { amount: 100 } } }, NOW))).toEqual({});
  });
});

describe("degreeFilterValues", () => {
  test("1-2 hops are exact degrees; 3+ is the catch-all", () => {
    expect(degreeFilterValues(1)).toEqual(["1"]);
    expect(degreeFilterValues(2)).toEqual(["1", "2"]);
    expect(degreeFilterValues(3)).toEqual(["1", "2", "3+"]);
  });
});

describe("attenuate", () => {
  const parent = compilePolicy(
    {
      scope: {
        domains: ["urn:li:domain:finance"],
        entityTypes: ["DATASET"],
        lineageDepth: 2,
      },
      budget: { period: { amount: 500, seconds: 86400 }, lifetime: { amount: 5000 } },
      mutations: "documents",
      expiry: NOW + 86400 * 30,
      maxUses: 500,
    },
    NOW,
  );
  const remaining = { periodRemaining: 120, lifetimeRemaining: 4000 };

  test("scope must be a subset of the parent's", () => {
    expect(() => attenuate(parent, remaining, { scope: { domains: ["urn:li:domain:marketing"] } }, NOW)).toThrow(
      RefusalError,
    );
    expect(() => attenuate(parent, remaining, { scope: { entityTypes: ["MLMODEL"] } }, NOW)).toThrow();
    expect(() => attenuate(parent, remaining, { scope: { lineageDepth: 3 } }, NOW)).toThrow();
    const ok = attenuate(parent, remaining, { scope: { domains: ["urn:li:domain:finance"], entityTypes: ["DATASET"], lineageDepth: 1 } }, NOW);
    expect(ok.scope?.domains).toEqual(["urn:li:domain:finance"]);
    expect(ok.scope?.entityTypes).toEqual(["DATASET"]);
    expect(ok.scope?.lineageDepth).toBe(1);
  });

  test("omitted scope restrictions inherit from the parent (never wider)", () => {
    // a child that only narrows domains must NOT end up platform-scoped: the
    // parent's entityTypes restriction is inherited, so the child can never be
    // wider than the parent (scopeAllows ORs dimensions)
    const child = attenuate(parent, remaining, { scope: { domains: ["urn:li:domain:finance"] } }, NOW);
    expect(child.scope?.domains).toEqual(["urn:li:domain:finance"]);
    expect(child.scope?.entityTypes).toEqual(["DATASET"]); // inherited — the child only narrowed domains
    expect(child.scope?.lineageDepth).toBe(2); // inherited
    // a child that tries to switch to a dimension the parent doesn't restrict is refused
    expect(() => attenuate(parent, remaining, { scope: { platforms: ["urn:li:dataplatform:snowflake"] } }, NOW)).toThrow(
      RefusalError,
    );
    // a child with NO scope inherits the parent's ENTIRE scope — never full catalog
    const bare = attenuate(parent, remaining, {}, NOW);
    expect(bare.scope?.domains).toEqual(["urn:li:domain:finance"]);
    expect(bare.scope?.entityTypes).toEqual(["DATASET"]);
  });

  test("omitted budget inherits the parent capped to remaining", () => {
    const child = attenuate(parent, remaining, {}, NOW);
    expect(child.budget?.period).toEqual({ amount: 120, seconds: 86400 });
    expect(child.budget?.lifetime).toEqual({ amount: 4000 });
  });

  test("explicit caps must fit remaining; over-caps refuse", () => {
    const ok = attenuate(parent, remaining, { budget: { period: { amount: 50, seconds: 86400 } } }, NOW);
    expect(ok.budget?.period?.amount).toBe(50);
    expect(() => attenuate(parent, remaining, { budget: { period: { amount: 200, seconds: 86400 } } }, NOW)).toThrow(
      RefusalError,
    );
    expect(() => attenuate(parent, remaining, { budget: { lifetime: { amount: 9999 } } }, NOW)).toThrow();
  });

  test("mutations only narrow; expiry never extends", () => {
    expect(attenuate(parent, remaining, { mutations: "documents" }, NOW).mutations).toBe("documents");
    expect(() => attenuate({ ...parent, mutations: "none" }, remaining, { mutations: "documents" }, NOW)).toThrow();
    expect(attenuate(parent, remaining, {}, NOW).expiry).toBe(parent.expiry);
    expect(() => attenuate(parent, remaining, { expiry: NOW + 86400 * 60 }, NOW)).toThrow();
  });
});
