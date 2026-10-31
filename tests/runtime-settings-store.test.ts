import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUNTIME_SETTINGS, storedSettingsVersion } from "@/lib/operations/runtime-settings-schema";
import { ensureRuntimeSettings, publishRuntimeSettingsSnapshot, runtimeSettings, runtimeSettingsSnapshot, runtimeSettingsSnapshotFromStored,
  setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { applyRuntimeSettingsPatch, RUNTIME_SETTINGS_AUDIT_ACTION, runtimeSettingsAuditTarget } from "@/lib/operations/runtime-settings";
import { checkRegistryOverrides } from "@/lib/operations/admin-model-registry";
import { DEFAULT_MODEL_DEFINITIONS, modelTimeoutMs, type ModelDefinition } from "@/lib/llm/model-registry";
import { servingContractSnapshotFromRows, servingRuntimeSettingsSnapshot, setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";

afterEach(() => { setRuntimeSettingsForTest(null); setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); });

describe("sparse patch (applyRuntimeSettingsPatch)", () => {
  it("그룹 범위로만 덮고 null 은 키를 지운다; 빈 객체는 남기지 않고 version 은 늘 1 이다", () => {
    const stored = { version: 1, budgets: { "crawl-publish": 90_000, "crawl-seed": 40_000 }, routes: { timeouts: { "crawl-tagline": 46_000 } } };
    const budgets = applyRuntimeSettingsPatch(stored, "budgets", { "crawl-publish": null, "product-audit": 80_000 });
    expect(budgets.issues).toEqual([]);
    expect(budgets.stored).toEqual({ version: 1, budgets: { "crawl-seed": 40_000, "product-audit": 80_000 }, routes: { timeouts: { "crawl-tagline": 46_000 } } });
    // 다른 그룹의 키는 그대로다; 그룹의 마지막 키를 지우면 그룹도 사라진다 → 판은 다른 그룹만으로 정해진다
    const routes = applyRuntimeSettingsPatch(budgets.stored, "routes", { timeouts: { "crawl-tagline": null } });
    expect(routes.stored).toEqual({ version: 1, budgets: { "crawl-seed": 40_000, "product-audit": 80_000 } });
    expect(storedSettingsVersion(routes.stored)).toBe(storedSettingsVersion({ budgets: { "product-audit": 80_000, "crawl-seed": 40_000 } }));
    expect(applyRuntimeSettingsPatch(routes.stored, "budgets", { "crawl-seed": null, "product-audit": null }).stored).toEqual({ version: 1 });
    expect(applyRuntimeSettingsPatch(null, "budgets", {}).stored).toEqual({ version: 1 });
    expect(applyRuntimeSettingsPatch("garbage", "budgets", { "crawl-seed": 30_000 }).stored).toEqual({ version: 1, budgets: { "crawl-seed": 30_000 } });
  });
  it("객체는 한 단계씩 깊이 덮는다 — 한도의 한 칸만 바꾸거나 되돌릴 수 있다", () => {
    const first = applyRuntimeSettingsPatch({ version: 1 }, "routes", { limits: { "crawl-tagline": { maxTokens: 300 } } });
    expect(first.stored).toEqual({ version: 1, routes: { limits: { "crawl-tagline": { maxTokens: 300 } } } });
    const second = applyRuntimeSettingsPatch(first.stored, "routes", { limits: { "crawl-tagline": { concurrency: 1 } }, timeouts: { "crawl-tagline": 46_000 } });
    expect(second.stored.routes).toEqual({ limits: { "crawl-tagline": { maxTokens: 300, concurrency: 1 } }, timeouts: { "crawl-tagline": 46_000 } });
    const third = applyRuntimeSettingsPatch(second.stored, "routes", { limits: { "crawl-tagline": { maxTokens: null, concurrency: null } } });
    expect(third.stored.routes).toEqual({ timeouts: { "crawl-tagline": 46_000 } });
    const jobs = applyRuntimeSettingsPatch({ version: 1, jobs: { "reason-translate": { batch: 2, batchChars: 900 } } }, "jobs", { "reason-translate": { batch: null } });
    expect(jobs.stored).toEqual({ version: 1, jobs: { "reason-translate": { batchChars: 900 } } });
    expect(applyRuntimeSettingsPatch(jobs.stored, "jobs", { "reason-translate": null }).stored).toEqual({ version: 1 });
    expect(applyRuntimeSettingsPatch({ version: 1 }, "translation", { product: { batchChars: 9_000, maxAttempts: undefined } }).stored)
      .toEqual({ version: 1, translation: { product: { batchChars: 9_000 } } });
  });
  it("기한 사다리의 relayMs: null 은 값이다(중계 층 없음) — 지우기가 아니다", () => {
    const ladder = applyRuntimeSettingsPatch({ version: 1 }, "routes", { deadlines: { "review-gateway": { relayMs: null, clientMs: 65_000 } } });
    expect(ladder.stored).toEqual({ version: 1, routes: { deadlines: { "review-gateway": { relayMs: null, clientMs: 65_000 } } } });
    expect(applyRuntimeSettingsPatch(ladder.stored, "routes", { deadlines: { "review-gateway": { clientMs: null } } }).stored)
      .toEqual({ version: 1, routes: { deadlines: { "review-gateway": { relayMs: null } } } });
    expect(applyRuntimeSettingsPatch(ladder.stored, "routes", { deadlines: { "review-gateway": null } }).stored).toEqual({ version: 1 });
  });
  it("devices 그룹과 객체가 아닌 patch 는 모양에서 거절한다", () => {
    expect(applyRuntimeSettingsPatch({ version: 1 }, "devices", { x: 1 })).toEqual({ stored: { version: 1 }, issues: ["group_not_editable:devices"] });
    expect(applyRuntimeSettingsPatch({ version: 1 }, "budgets", [1]).issues).toEqual(["runtime_settings_invalid:budgets"]);
    expect(applyRuntimeSettingsPatch({ version: 1 }, "budgets", 5).issues).toEqual(["runtime_settings_invalid:budgets"]);
    expect(RUNTIME_SETTINGS_AUDIT_ACTION).toBe("runtime-settings-save");
    expect(runtimeSettingsAuditTarget("budgets")).toBe("runtime_settings:budgets");
  });
});

describe("serving-contract reload carries the runtime_settings row", () => {
  const runtimeRow = (values: unknown, revision: number | string, updated_at = "2026-10-30T00:00:00.000Z") => ({ values, revision, updated_at });
  it("snapshot.runtime 은 저장 문서·판·revision 이고 token 은 revision/updated_at 으로 바뀐다", () => {
    const none = servingContractSnapshotFromRows([], 1_000);
    expect(none.runtime).toBeNull();
    const a = servingContractSnapshotFromRows([], 1_000, [], runtimeRow({ version: 1, budgets: { "crawl-seed": 45_000 } }, "3"));
    expect(a.runtime).toEqual({ stored: { version: 1, budgets: { "crawl-seed": 45_000 } }, version: storedSettingsVersion({ budgets: { "crawl-seed": 45_000 } }), revision: 3,
      updatedAt: "2026-10-30T00:00:00.000Z" });
    const b = servingContractSnapshotFromRows([], 1_000, [], runtimeRow({ version: 1, budgets: { "crawl-seed": 45_000 } }, 4, "2026-10-30T00:00:01.000Z"));
    expect(b.token).not.toBe(a.token);
    expect(none.token).not.toBe(a.token);
    expect(servingContractSnapshotFromRows([], 2_000, [], runtimeRow({ version: 1, budgets: { "crawl-seed": 45_000 } }, "3")).token).toBe(a.token);
  });
  it("servingRuntimeSettingsSnapshot 은 덮어쓴 등록부의 purposes 를 아는 경로로 풀고, 같은 내용은 한 번만 푼다(loadedAt 만 따라간다)", () => {
    const m1 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!;
    const spare: ModelDefinition = { ...m1, key: "m1:second", purposes: ["m1-spare"] };
    const stored = { version: 1, routes: { timeouts: { "m1-spare": 30_000 } }, budgets: { "crawl-seed": 45_000 } };
    const without = servingRuntimeSettingsSnapshot(servingContractSnapshotFromRows([], 1_000, [], runtimeRow(stored, 5)))!;
    // 기본 등록부만 알면 m1-spare 는 모르는 경로 → 기본값(없음)으로 두고 나머지는 반영한다
    expect(without.settings.routes.timeouts["m1-spare"]).toBeUndefined();
    expect(without.settings.budgets["crawl-seed"]).toBe(45_000);
    expect(without).toMatchObject({ source: "db", revision: 5, loadedAt: 1_000, version: storedSettingsVersion(stored) });
    const withSpare = servingRuntimeSettingsSnapshot(servingContractSnapshotFromRows([], 2_000, [{ key: "m1:second", definition: spare, updated_at: "t" }], runtimeRow(stored, 5)))!;
    expect(withSpare.settings.routes.timeouts["m1-spare"]).toBe(30_000);
    const again = servingRuntimeSettingsSnapshot(servingContractSnapshotFromRows([], 3_000, [{ key: "m1:second", definition: spare, updated_at: "t" }], runtimeRow(stored, 5)))!;
    expect(again.settings).toBe(withSpare.settings);
    expect(again.loadedAt).toBe(3_000);
    expect(servingRuntimeSettingsSnapshot(servingContractSnapshotFromRows([], 3_000))).toBeNull();
  });
  it("publishRuntimeSettingsSnapshot 은 프로세스 스냅샷을 올리되 테스트 고정은 덮지 않는다", () => {
    const built = runtimeSettingsSnapshotFromStored({ version: 1, budgets: { "crawl-seed": 45_000 } }, 2).snapshot;
    publishRuntimeSettingsSnapshot(built);
    expect(runtimeSettingsSnapshot()).toBe(built);
    expect(runtimeSettings().budgets["crawl-seed"]).toBe(45_000);
    setRuntimeSettingsForTest({ version: 1, budgets: { "crawl-seed": 35_000 } });
    publishRuntimeSettingsSnapshot(built);
    expect(runtimeSettings().budgets["crawl-seed"]).toBe(35_000);
    setRuntimeSettingsForTest(null);
    expect(runtimeSettings()).toBe(DEFAULT_RUNTIME_SETTINGS);
  });
  it("loader: 스위치가 꺼져 있으면(MODEL_SERVING_CONTRACTS_DB=0) 기본값을 유지하고 DB 를 건드리지 않는다", async () => {
    vi.stubEnv("MODEL_SERVING_CONTRACTS_DB", "0");
    vi.stubEnv("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:1/never");
    const snapshot = await ensureRuntimeSettings(0);
    expect(snapshot.source).toBe("default");
    expect(snapshot.version).toBe("default");
    expect(runtimeSettings()).toBe(DEFAULT_RUNTIME_SETTINGS);
  });
});

describe("registry override check against the live route policy", () => {
  const supa = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "supa:review")!;
  it("기본 정책에서는 통과하는 모델 상한이, 저장된 게이트웨이 기한 아래에서는 사다리 위반으로 거절된다", () => {
    // 58초: 기본 사다리(게이트웨이 55초 + 2초 ≤ 58초)로는 맞다
    expect(checkRegistryOverrides([{ ...supa, timeoutMs: 58_000 }], {})).toMatchObject({ ok: true });
    expect(checkRegistryOverrides([{ ...supa, timeoutMs: 58_000 }], {}, DEFAULT_RUNTIME_SETTINGS.routes)).toMatchObject({ ok: true });
    const routes = { ...DEFAULT_RUNTIME_SETTINGS.routes, deadlines: { "review-gateway": { engineMs: 50_000, relayMs: null, gatewayMs: 57_000, clientMs: 60_000 } } };
    expect(checkRegistryOverrides([{ ...supa, timeoutMs: 58_000 }], {}, routes)).toEqual({ ok: false, reason: "model_registry_invalid" });
    expect(checkRegistryOverrides([{ ...supa, timeoutMs: 59_000 }], {}, routes)).toMatchObject({ ok: true });
    // 기본 인자는 지금 판이다
    setRuntimeSettingsForTest({ version: 1, routes: { deadlines: { "review-gateway": { gatewayMs: 57_000 } } } });
    expect(modelTimeoutMs("review-gateway", {})).toBe(60_000);
    expect(checkRegistryOverrides([{ ...supa, timeoutMs: 58_000 }], {})).toEqual({ ok: false, reason: "model_registry_invalid" });
  });
});
