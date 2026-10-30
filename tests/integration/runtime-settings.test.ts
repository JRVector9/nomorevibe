import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { TEST_DATABASE_URL } from "./setup";

/*
 * PR 1a WP-A: runtime_settings(0152) 저장 → 감사 → 읽기, revision compare-and-set, DR fence, 같은 reload 로 워커가 읽는 판, 적용 확인.
 * 자기 DB 를 만들고 지운다(공유 test DB 의 한 행짜리 문서·fence 행을 건드리지 않는다). 운영 DB·모델 끝점은 닿지 않는다.
 */
const name = `nomorevibe_test_runtime_settings_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
let created = false;
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  vi.stubEnv("DATABASE_URL", url.toString());
}, 120000);
afterAll(async () => {
  const { setRuntimeSettingsForTest, setRuntimeSettingsLoader } = await import("@/lib/operations/runtime-settings-store");
  const { setServingContractSnapshotForTest } = await import("@/lib/llm/serving-contract-store");
  setRuntimeSettingsForTest(null); setServingContractSnapshotForTest(null); setRuntimeSettingsLoader(null);
  vi.unstubAllEnvs();
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

const audits = () => client`SELECT action, target, ok, error, detail FROM operations_audit WHERE action = 'runtime-settings-save' ORDER BY id`;
const row = async () => (await client`SELECT values, revision::int revision, updated_by FROM runtime_settings WHERE id = 1`)[0];

it("0152 seeds the empty document (revision 1, 판 default) and the DB refuses a second row, a document without version or revision 0", async () => {
  const { readRuntimeSettingsRow } = await import("@/lib/operations/runtime-settings");
  expect(await readRuntimeSettingsRow()).toMatchObject({ values: { version: 1 }, revision: 1, updatedBy: "migration:0152" });
  await expect(client`INSERT INTO runtime_settings (id, values, updated_by) VALUES (2, '{"version":1}', 'x')`).rejects.toThrow();
  await expect(client`UPDATE runtime_settings SET values = '{"budgets":{}}' WHERE id = 1`).rejects.toThrow();
  await expect(client`UPDATE runtime_settings SET revision = 0 WHERE id = 1`).rejects.toThrow();
  expect((await row()).revision).toBe(1);
});

it("save → audit → read: a group patch bumps the revision, audits before/after/changes, and the row carries the sparse document", async () => {
  const { saveRuntimeSettings, readRuntimeSettingsRow } = await import("@/lib/operations/runtime-settings");
  const { storedSettingsVersion } = await import("@/lib/operations/runtime-settings-schema");
  const result = await saveRuntimeSettings({ "crawl-publish": 90_000 }, "jr", { group: "budgets", expectedRevision: 1 });
  expect(result).toEqual({ ok: true, revision: 2, version: storedSettingsVersion({ budgets: { "crawl-publish": 90_000 } }) });
  expect(await row()).toEqual({ values: { version: 1, budgets: { "crawl-publish": 90_000 } }, revision: 2, updated_by: "jr" });
  expect(await readRuntimeSettingsRow()).toMatchObject({ values: { version: 1, budgets: { "crawl-publish": 90_000 } }, revision: 2, updatedBy: "jr" });
  const [audit] = await audits();
  expect(audit).toMatchObject({ action: "runtime-settings-save", target: "runtime_settings:budgets", ok: true, error: null });
  expect(audit.detail).toMatchObject({ group: "budgets", revision: 2, version: result.ok ? result.version : null,
    changes: [{ path: "budgets.crawl-publish", before: 120_000, after: 90_000, label: "발행 틱 예산(ms)" }] });
  expect(audit.detail.before["crawl-publish"]).toBe(120_000);
  expect(audit.detail.after["crawl-publish"]).toBe(90_000);
  expect(audit.detail.after["product-translate"]).toBe("auto");
});

it("compare-and-set: a stale expectedRevision is refused and audited; nothing changes", async () => {
  const { saveRuntimeSettings } = await import("@/lib/operations/runtime-settings");
  expect(await saveRuntimeSettings({ "crawl-seed": 40_000 }, "jr", { group: "budgets", expectedRevision: 1 })).toEqual({ ok: false, issues: ["stale_form"] });
  expect(await row()).toMatchObject({ values: { version: 1, budgets: { "crawl-publish": 90_000 } }, revision: 2 });
  const trail = await audits();
  expect(trail).toHaveLength(2);
  expect(trail[1]).toMatchObject({ ok: false, error: "stale_form", target: "runtime_settings:budgets" });
  expect(trail[1].detail).toMatchObject({ revision: 2, expectedRevision: 1 });
});

it("validation refuses the effective document (budget below the call ceiling, unknown job, out of range) and audits the refusal; the row stays", async () => {
  const { saveRuntimeSettings } = await import("@/lib/operations/runtime-settings");
  const lowered = await saveRuntimeSettings({ "product-translate": 200_000 }, "jr", { group: "budgets", expectedRevision: 2 });
  expect(lowered).toEqual({ ok: false, issues: ["budget_below_call_timeout:product-translate"] });
  expect(await saveRuntimeSettings({ nope: 60_000, "crawl-seed": 10 }, "jr", { group: "budgets" })).toEqual({ ok: false,
    issues: expect.arrayContaining(["unknown_job:nope", "runtime_settings_invalid:budgets.crawl-seed"]) });
  expect(await saveRuntimeSettings({ x: 1 }, "jr", { group: "devices" })).toEqual({ ok: false, issues: ["group_not_editable:devices"] });
  expect(await saveRuntimeSettings([1], "jr", { group: "routes" })).toEqual({ ok: false, issues: ["runtime_settings_invalid:routes"] });
  expect(await saveRuntimeSettings({ "crawl-seed": 40_000 }, "   ", { group: "budgets" })).toEqual({ ok: false, issues: ["invalid_actor"] });
  expect(await row()).toMatchObject({ values: { version: 1, budgets: { "crawl-publish": 90_000 } }, revision: 2 });
  const trail = await audits();
  expect(trail).toHaveLength(6);
  expect(trail[2]).toMatchObject({ ok: false, error: "budget_below_call_timeout:product-translate" });
  expect(trail[2].detail.changes).toEqual([{ path: "budgets.product-translate", before: "auto", after: 200_000, label: "공개 번역 틱 예산(ms)" }]);
});

it("the same reload serves the saved 판 to the route-policy overlay, the store and ensureRuntimeSettings; null resets a key to its default", async () => {
  const { saveRuntimeSettings } = await import("@/lib/operations/runtime-settings");
  const { storedSettingsVersion } = await import("@/lib/operations/runtime-settings-schema");
  const store = await import("@/lib/operations/runtime-settings-store");
  const serving = await import("@/lib/llm/serving-contract-store");
  const { modelTimeoutMs } = await import("@/lib/llm/model-registry");
  const saved = await saveRuntimeSettings({ timeouts: { "crawl-tagline": 46_000 } }, "jr", { group: "routes", expectedRevision: 2 });
  expect(saved).toMatchObject({ ok: true, revision: 3 });
  expect(modelTimeoutMs("crawl-tagline", {})).toBe(45_000);   // not reloaded yet
  await serving.refreshServingContracts();
  expect(serving.servingContractSnapshot().runtime).toMatchObject({ revision: 3, version: saved.ok ? saved.version : null,
    stored: { version: 1, budgets: { "crawl-publish": 90_000 }, routes: { timeouts: { "crawl-tagline": 46_000 } } } });
  expect(store.runtimeSettingsSnapshot()).toMatchObject({ source: "db", revision: 3, version: saved.ok ? saved.version : null });
  expect(store.runtimeSettings().routes.timeouts["crawl-tagline"]).toBe(46_000);
  expect(store.runtimeSettings().budgets["crawl-publish"]).toBe(90_000);
  expect(modelTimeoutMs("crawl-tagline", {})).toBe(46_000);
  // ensureRuntimeSettings rides the same reload
  const reset = await saveRuntimeSettings({ timeouts: { "crawl-tagline": null } }, "jr", { group: "routes" });
  expect(reset).toEqual({ ok: true, revision: 4, version: storedSettingsVersion({ budgets: { "crawl-publish": 90_000 } }) });
  expect(store.runtimeSettings().routes.timeouts["crawl-tagline"]).toBe(46_000);   // process snapshot until the next reload
  const fresh = await store.ensureRuntimeSettings(0);
  expect(fresh).toMatchObject({ revision: 4, version: reset.ok ? reset.version : null });
  expect(fresh.settings.routes.timeouts["crawl-tagline"]).toBe(45_000);
  expect(modelTimeoutMs("crawl-tagline", {})).toBe(45_000);
  expect(await row()).toMatchObject({ values: { version: 1, budgets: { "crawl-publish": 90_000 } }, revision: 4 });
});

it("a route known only through a registry override is accepted once the override exists; the override save is checked against the saved route policy", async () => {
  const { saveRuntimeSettings } = await import("@/lib/operations/runtime-settings");
  const { saveAdminRegistryOverride, disableAdminRegistryOverride } = await import("@/lib/operations/admin-model-registry");
  const { DEFAULT_MODEL_DEFINITIONS } = await import("@/lib/llm/model-registry");
  const store = await import("@/lib/operations/runtime-settings-store");
  const m1 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!, supa = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "supa:review")!;
  expect(await saveRuntimeSettings({ timeouts: { "m1-spare": 30_000 } }, "jr", { group: "routes" })).toEqual({ ok: false, issues: ["unknown_route:m1-spare"] });
  await saveAdminRegistryOverride({ ...m1, key: "m1:second", purposes: ["m1-spare"] }, "jr");
  expect(await saveRuntimeSettings({ timeouts: { "m1-spare": 30_000 } }, "jr", { group: "routes" })).toMatchObject({ ok: true, revision: 5 });
  await store.ensureRuntimeSettings(0);
  expect(store.runtimeSettings().routes.timeouts["m1-spare"]).toBe(30_000);
  // Disabling the override leaves an unknown route in the document: the reload keeps serving (that key falls back) and the next save says why it refuses
  expect(await disableAdminRegistryOverride("m1:second", "jr")).toBe(true);
  await store.ensureRuntimeSettings(0);
  expect(store.runtimeSettings().routes.timeouts["m1-spare"]).toBeUndefined();
  expect(await saveRuntimeSettings({ "crawl-seed": 40_000 }, "jr", { group: "budgets" })).toEqual({ ok: false, issues: ["unknown_route:m1-spare"] });
  expect(await saveRuntimeSettings({ timeouts: { "m1-spare": null } }, "jr", { group: "routes" })).toMatchObject({ ok: true, revision: 6 });

  // Saved deadline ladder (gateway 57 s) → a model bound of 58 s would leave less than the 2 s skew to the client bound: refused; 59 s passes
  expect(await saveRuntimeSettings({ deadlines: { "review-gateway": { gatewayMs: 57_000 } } }, "jr", { group: "routes" })).toMatchObject({ ok: true, revision: 7 });
  await expect(saveAdminRegistryOverride({ ...supa, timeoutMs: 58_000 }, "jr")).rejects.toThrow("model_registry_invalid");
  await saveAdminRegistryOverride({ ...supa, timeoutMs: 59_000 }, "jr");
  // Symmetrically the route policy cannot move the ladder under the saved model bound (the invalid registry also nulls every route
  // ceiling, so the schema's cross-check adds auto_budget_without_route:product-translate as a cascade — the primary reason is what matters)
  expect(await saveRuntimeSettings({ deadlines: { "review-gateway": { gatewayMs: 58_000 } } }, "jr", { group: "routes" }))
    .toMatchObject({ ok: false, issues: expect.arrayContaining(["model_role_deadline_order_inverted"]) });
  expect(await row()).toMatchObject({ revision: 7 });
  expect(await disableAdminRegistryOverride("supa:review", "jr")).toBe(true);
  expect(await saveRuntimeSettings({ deadlines: { "review-gateway": null } }, "jr", { group: "routes" })).toMatchObject({ ok: true, revision: 8 });
});

it("a fenced site refuses the save before any write (no row change, no audit row)", async () => {
  const { saveRuntimeSettings } = await import("@/lib/operations/runtime-settings");
  const before = await row(), trail = (await audits()).length;
  await client`UPDATE dr_writer_fence SET state = 'fenced', reason = 'operator_fence',
    fenced_db = '{"systemIdentifier":"7000000000000000001","databaseOid":"16384","databaseName":"wpa_fenced"}'::jsonb WHERE id = 1`;
  try {
    expect(await saveRuntimeSettings({ "crawl-seed": 40_000 }, "jr", { group: "budgets" })).toEqual({ ok: false, issues: ["site_fenced"] });
  } finally {
    await client`UPDATE dr_writer_fence SET state = 'active', reason = NULL, fenced_db = NULL WHERE id = 1`;
  }
  expect(await row()).toEqual(before);
  expect((await audits()).length).toBe(trail);
  expect(await saveRuntimeSettings({ "crawl-seed": 40_000 }, "jr", { group: "budgets", expectedRevision: before.revision })).toMatchObject({ ok: true, revision: before.revision + 1 });
});

it("apply status compares the saved 판 with each role's reported runtimeSettingsVersion and points at the limits page", async () => {
  const { readRuntimeSettingsApply, readRuntimeSettingsRow, RUNTIME_SETTINGS_APPLY_HREF } = await import("@/lib/operations/runtime-settings");
  const { storedSettingsVersion } = await import("@/lib/operations/runtime-settings-schema");
  const { observe } = await import("@/lib/operations/observations");
  const saved = storedSettingsVersion((await readRuntimeSettingsRow()).values);
  expect(saved).toMatch(/^[0-9a-f]{16}$/);
  await observe("service:text:wpa", { role: "text", status: "running", runtimeSettingsVersion: saved, runtimeSettingsReadAt: 1_700_000_000_000, registryEnv: false });
  await observe("service:crawler:wpa", { role: "crawler", status: "running" });                      // 판을 싣지 않는 옛 워커
  await observe("service:reviewer:wpa", { role: "reviewer", status: "running", runtimeSettingsVersion: "default", runtimeSettingsReadAt: 1 });   // 옛 판
  let apply = await readRuntimeSettingsApply();
  expect(apply.savedVersion).toBe(saved);
  const role = (name: string) => apply.roles.find(item => item.role === name)!;
  expect(role("text")).toMatchObject({ state: "applied", reportedVersion: saved, observedAt: 1_700_000_000_000 });
  expect(role("crawler")).toMatchObject({ state: "unknown", reportedVersion: null });
  expect(role("reviewer")).toMatchObject({ state: "waiting", reportedVersion: "default", lagging: false });
  expect(role("publisher").state).toBe("inactive");
  expect(apply.allApplied).toBe(false);
  expect(apply.attention).toBeNull();
  // 저장한 지 11분 — 옛 판으로 도는 역할이 조치할 일로 오른다
  await client`UPDATE runtime_settings SET updated_at = clock_timestamp() - interval '11 minutes' WHERE id = 1`;
  apply = await readRuntimeSettingsApply();
  expect(role("reviewer").lagging).toBe(true);
  expect(apply.attention).toMatchObject({ key: "settings-apply", count: 1, href: RUNTIME_SETTINGS_APPLY_HREF, title: "저장한 실시간 한도가 워커에 닿지 않음" });
  expect(apply.attention?.href).toBe("/admin/models/limits#apply");
});
