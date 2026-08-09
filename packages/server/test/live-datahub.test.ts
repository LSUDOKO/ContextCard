// LIVE integration suite — a REAL DataHub GMS. No doubles anywhere: the DataHub
// client here is the production client talking to the real GraphQL/REST endpoints.
// Runs when DATAHUB_GMS_URL is set (auth via DATAHUB_GMS_TOKEN, or
// DATAHUB_USERNAME/DATAHUB_PASSWORD basic auth); skips with a message otherwise.
//
// query_data reads governance from the entity's REAL tags/glossary terms and writes
// the Agent-Accessed tag for real (verified by re-fetching the entity). The dataset
// under test comes from env when pinned, else auto-discovered:
//   DATACARDS_TEST_DATASET_URN      a normal (non-PII) dataset URN
//   DATACARDS_TEST_PII_DATASET_URN  a dataset whose tags/glossary terms match
//                                   pii/gdpr/sensitive/phi/confidential/personal/
//                                   secret/restricted (required for the refusal test)

import { describe, expect, test } from "bun:test";
import { KeyedMutex, Store, isSensitiveEntity } from "@datacards/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { discoverDataset, mcpCall, realDatahub } from "./live-util";

const gmsUrl = (process.env.DATAHUB_GMS_URL ?? "").trim();
const live = gmsUrl.length > 0;
const configuredDataset = (process.env.DATACARDS_TEST_DATASET_URN ?? "").trim();
const piiDataset = (process.env.DATACARDS_TEST_PII_DATASET_URN ?? "").trim();

if (!live) {
  console.warn(
    "[live-datahub] SKIPPED: set DATAHUB_GMS_URL (+ DATAHUB_GMS_TOKEN, or DATAHUB_USERNAME/DATAHUB_PASSWORD) to run against a real catalog",
  );
} else if (!piiDataset) {
  console.warn(
    "[live-datahub] the pii_blocked test SKIPPED: set DATACARDS_TEST_PII_DATASET_URN to a dataset whose tags/glossary terms match PII/sensitive in this catalog",
  );
}

function harness() {
  const store = new Store(":memory:");
  const datahub = realDatahub()!; // the live gate guarantees this
  const deps: AppDeps = {
    store,
    datahub,
    stripe: null,
    adminToken: "live-test-admin",
    mutex: new KeyedMutex(),
  };
  const app = createApp(deps);
  const admin = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { authorization: "Bearer live-test-admin", ...(init.headers ?? {}) },
  });

  const issueCard = async (terms: Record<string, unknown>) => {
    const res = await app.request(
      "/api/cards",
      admin({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "live-test", terms }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { card_id: string; card_url: string };
    const secret = body.card_url.match(/\/c\/([^/]+)\/mcp$/)?.[1] ?? "";
    expect(secret).toBeTruthy();
    return { card_id: body.card_id, secret };
  };

  return { store, datahub, app, issueCard };
}

const suite = live ? describe : describe.skip;

suite("live DataHub GMS (query_data governance + write-back)", () => {
  test("previews a real in-scope dataset and the Agent-Accessed tag really lands on it", async () => {
    const { store, datahub, app, issueCard } = harness();
    const meta = configuredDataset ? await datahub.getEntity(configuredDataset) : await discoverDataset(datahub);
    if (!meta) {
      throw new Error(
        "no usable dataset found — set DATACARDS_TEST_DATASET_URN to a real non-PII dataset URN in this catalog",
      );
    }
    if (isSensitiveEntity(meta)) {
      throw new Error(
        `dataset ${meta.urn} is PII/sensitive — query_data would (correctly) refuse it; set DATACARDS_TEST_DATASET_URN to a non-sensitive dataset`,
      );
    }
    const urn = meta.urn;

    const { card_id, secret } = await issueCard({
      budget: { period: { amount: 100, seconds: 86400 } },
      scope: { entities: [urn], entityTypes: ["DATASET"] },
      maxRows: 100,
    });
    const out = await mcpCall(app, secret, "query_data", { urn, sql: "SELECT * FROM <dataset> LIMIT 50" });
    expect(out.isError, `query_data failed: ${JSON.stringify(out.data)}`).toBe(false);
    expect(out.data.status).toBe("preview");
    expect(out.data.urn).toBe(urn);

    // the tag write-back REALLY mutated the catalog: re-fetch the entity and find it
    const after = await datahub.getEntity(urn);
    const tags = after?.tags ?? [];
    expect(tags.some((t) => t.includes("Agent-Accessed")), `Agent-Accessed missing on ${urn} — tags: ${JSON.stringify(tags)}`).toBe(true);

    const charges = store.listCharges(card_id, 10);
    expect(charges[0]).toMatchObject({ kind: "query_data", units: 1, status: "ok", to_urn: urn });
  }, 30000);

  test("refuses a PII/sensitive dataset with pii_blocked and writes no tag", async () => {
    if (!piiDataset) {
      throw new Error("set DATACARDS_TEST_PII_DATASET_URN to a PII/sensitive dataset in this catalog");
    }
    const { store, datahub, app, issueCard } = harness();
    const meta = await datahub.getEntity(piiDataset);
    if (!meta) throw new Error(`entity ${piiDataset} not found in this catalog`);
    if (!isSensitiveEntity(meta)) {
      throw new Error(
        `entity ${piiDataset} has no PII/sensitive classification (tags/glossary terms) — query_data would allow it; pick a dataset tagged PII/sensitive`,
      );
    }
    const tagsBefore = meta.tags;

    const { card_id, secret } = await issueCard({
      budget: { period: { amount: 100, seconds: 86400 } },
      scope: { entities: [piiDataset] },
    });
    const out = await mcpCall(app, secret, "query_data", { urn: piiDataset, sql: "SELECT * FROM customers LIMIT 10" });
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe("pii_blocked");

    // a refusal writes nothing: no tag, no ledger debit
    const after = await datahub.getEntity(piiDataset);
    expect(after?.tags ?? []).toEqual(tagsBefore);
    expect(store.listCharges(card_id, 10)).toHaveLength(0);
  }, 30000);
});
