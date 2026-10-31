import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_JOB_BUDGET_MS, DEFAULT_RUNTIME_SETTINGS, JOB_CALL_ROUTES, RUNTIME_SETTING_GROUPS, RUNTIME_SETTING_LABELS, effectiveJobBudgetMs,
  jobCallCeilingMs, jobKnob, resolveRuntimeSettings, runtimeSettingLabel, runtimeSettingsSchema, runtimeSettingsWarnings, storedSettingsVersion,
  type RuntimeSettings } from "@/lib/operations/runtime-settings-schema";
import { ensureRuntimeSettings, lastRuntimeSettingsRead, runtimeSettings, runtimeSettingsSnapshot, runtimeSettingsSnapshotFromStored,
  setRuntimeSettingsForTest, setRuntimeSettingsLoader, withRuntimeSettings } from "@/lib/operations/runtime-settings-store";
import { DEFAULT_MODEL_DEADLINES, DEFAULT_MODEL_DEFINITIONS, DEFAULT_MODEL_PURPOSE_LIMITS, DEFAULT_MODEL_TIMEOUTS, modelLimits, modelTimeoutMs,
  setModelRoutePolicyOverlay } from "@/lib/llm/model-registry";
import { PRODUCT_TRANSLATION_JOB_BUDGET_MS, PRODUCT_TRANSLATION_JOB_MARGIN_MS, REVIEW_GATEWAY_LADDER, productTranslationJobBudgetMs,
  reviewGatewayLadder } from "@/lib/llm/deadline-ladder";
import { PRODUCT_TRANSLATION_BATCH_CHARS, PRODUCT_TRANSLATION_DEMAND_LIMIT, PRODUCT_TRANSLATION_MAX_ATTEMPTS, PRODUCT_TRANSLATION_MAX_SOURCE_CHARS,
  packProductTranslationBatch, productTranslationPolicy } from "@/lib/domain/products/translation-policy";
import "@/lib/llm/serving-contract-store";

afterEach(() => { setRuntimeSettingsForTest(null); setRuntimeSettingsLoader(null); });

const leaves = (value: unknown, prefix = ""): string[] => value && typeof value === "object"
  ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, prefix ? `${prefix}.${key}` : key)) : [prefix];

describe("runtime settings defaults", () => {
  it("빈 저장 문서는 오늘의 상수와 같고 issues 가 없다 — 판은 default", () => {
    for (const stored of [null, undefined, {}, { version: 1 }]) {
      const { settings, issues } = resolveRuntimeSettings(stored);
      expect(issues).toEqual([]);
      expect(settings).toEqual(DEFAULT_RUNTIME_SETTINGS);
      expect(storedSettingsVersion(stored)).toBe("default");
    }
    expect(runtimeSettingsSchema.safeParse({ version: 1, ...DEFAULT_RUNTIME_SETTINGS }).success).toBe(true);
    // 막지 않는 경고만: 55초 예산 셋과 product-audit 70초는 상한 + 15초 안쪽; crawl-tagline 은 jobRunOptions 에 줄이 없어 runner 기본 25초로 돌며 상한은 45초다
    expect(runtimeSettingsWarnings(DEFAULT_RUNTIME_SETTINGS).sort()).toEqual(["budget_default_below_call_timeout:crawl-tagline", "budget_margin_thin:product-audit",
      "budget_margin_thin:product-search-profile", "budget_margin_thin:product-tagline-ko", "budget_margin_thin:reason-translate"]);
  });
  it("경로 한도는 등록부 상수, 번역 묶음은 translation-policy 상수, 틱 예산은 jobRunOptions 리터럴이다", () => {
    expect(DEFAULT_RUNTIME_SETTINGS.routes.limits).toEqual(DEFAULT_MODEL_PURPOSE_LIMITS);
    expect(DEFAULT_RUNTIME_SETTINGS.routes.limits["product-translate"]).toEqual({ maxTokens: 30_000, concurrency: 1, timeoutMs: 300_000 });
    expect(DEFAULT_RUNTIME_SETTINGS.routes.timeouts).toEqual(DEFAULT_MODEL_TIMEOUTS);
    expect(DEFAULT_RUNTIME_SETTINGS.routes.deadlines).toEqual(DEFAULT_MODEL_DEADLINES);
    expect(DEFAULT_RUNTIME_SETTINGS.routes.deadlines["review-gateway"]).toEqual({ engineMs: 50_000, relayMs: null, gatewayMs: 55_000, clientMs: 60_000 });
    expect(reviewGatewayLadder()).toEqual(REVIEW_GATEWAY_LADDER);
    const product = DEFAULT_RUNTIME_SETTINGS.translation.product;
    expect(product).toEqual({ maxSourceChars: 30_000, batchChars: 8_000, batchMax: 4, demandLimit: 80, maxAttempts: 4, jobMarginMs: 15_000 });
    expect([PRODUCT_TRANSLATION_MAX_SOURCE_CHARS, PRODUCT_TRANSLATION_BATCH_CHARS, PRODUCT_TRANSLATION_DEMAND_LIMIT, PRODUCT_TRANSLATION_MAX_ATTEMPTS,
      PRODUCT_TRANSLATION_JOB_MARGIN_MS]).toEqual([30_000, 8_000, 80, 4, 15_000]);
    expect(productTranslationPolicy()).toEqual(product);
    expect(DEFAULT_RUNTIME_SETTINGS.budgets["crawl-agent-review"]).toBe(110_000);
    expect(DEFAULT_RUNTIME_SETTINGS.budgets["product-translate"]).toBe("auto");
    expect(effectiveJobBudgetMs("crawl-agent-review", DEFAULT_RUNTIME_SETTINGS)).toBe(110_000);
    expect(effectiveJobBudgetMs("product-translate", DEFAULT_RUNTIME_SETTINGS)).toBe(315_000);
    expect(effectiveJobBudgetMs("product-translate", DEFAULT_RUNTIME_SETTINGS)).toBe(PRODUCT_TRANSLATION_JOB_BUDGET_MS);
    expect(productTranslationJobBudgetMs()).toBe(315_000);
    expect(effectiveJobBudgetMs("crawl-judge", DEFAULT_RUNTIME_SETTINGS)).toBe(DEFAULT_JOB_BUDGET_MS);
    expect(jobCallCeilingMs("product-translate", DEFAULT_RUNTIME_SETTINGS)).toBe(300_000);
    expect(jobCallCeilingMs("crawl-agent-review", DEFAULT_RUNTIME_SETTINGS)).toBe(60_000);
    expect(jobCallCeilingMs("product-audit", DEFAULT_RUNTIME_SETTINGS)).toBe(60_000);          // max(product-audit 45s, review-gateway 60s)
    expect(jobCallCeilingMs("human-deepseek-review", DEFAULT_RUNTIME_SETTINGS)).toBe(60_000);  // m3:review model timeout
    expect(jobCallCeilingMs("audit-screen-review", DEFAULT_RUNTIME_SETTINGS)).toBe(130_000);   // screen-review 90s + 40s draw
    expect(jobCallCeilingMs("product-intro-check", DEFAULT_RUNTIME_SETTINGS)).toBe(90_000);    // jobs.product-intro-check.callMs
    expect(jobCallCeilingMs("crawl-publish", DEFAULT_RUNTIME_SETTINGS)).toBeNull();
    // crawl-tagline 만 예산 줄이 없다(runner 기본 25초) — 나머지 호출 경로 잡은 모두 jobRunOptions 리터럴이 있다
    expect(Object.keys(JOB_CALL_ROUTES).filter(job => !(job in DEFAULT_RUNTIME_SETTINGS.budgets))).toEqual(["crawl-tagline"]);
    expect(effectiveJobBudgetMs("crawl-tagline", DEFAULT_RUNTIME_SETTINGS)).toBe(DEFAULT_JOB_BUDGET_MS);
    expect(jobKnob(DEFAULT_RUNTIME_SETTINGS, "reason-translate", "batchChars")).toBe(1_600);
    expect(jobKnob(DEFAULT_RUNTIME_SETTINGS, "crawl-tagline", "minCallMs")).toBe(15_000);
    expect(() => jobKnob(DEFAULT_RUNTIME_SETTINGS, "crawl-tagline", "soloAttempts")).toThrow("runtime_settings_knob_missing:crawl-tagline.soloAttempts");
  });
  it("모든 키에 한국어 이름표가 있다", () => {
    for (const path of leaves(DEFAULT_RUNTIME_SETTINGS)) expect(RUNTIME_SETTING_LABELS[path], path).toBeTruthy();
    expect(RUNTIME_SETTING_LABELS["routes.limits.product-translate.timeoutMs"]).toBe("공개 번역 호출 상한(ms)");
    expect(runtimeSettingLabel("budgets.crawl-fetch")).toBe("원본 확보 틱 예산(ms)");
    expect(runtimeSettingLabel("routes.timeouts.brand-new-route")).toBe("brand-new-route 호출 상한(ms)");
    expect(RUNTIME_SETTING_GROUPS).toEqual(["routes", "translation", "jobs", "budgets", "devices"]);
  });
});

describe("resolveRuntimeSettings", () => {
  it("낮춘 값·범위 밖·모르는 키는 던지지 않고 issues 로 돌려준다", () => {
    const lowered = resolveRuntimeSettings({ version: 1, budgets: { "product-translate": 200_000, "reason-translate": 30_000 } });
    expect(lowered.issues).toEqual(expect.arrayContaining(["budget_below_call_timeout:product-translate", "budget_below_min_call:reason-translate"]));
    expect(lowered.settings.budgets["product-translate"]).toBe(200_000);
    const invalid = resolveRuntimeSettings({ version: 1, budgets: { "crawl-agent-review": 10, nope: 60_000 }, routes: { timeouts: { ghost: 5_000, "crawl-tagline": 100 } },
      jobs: { "crawl-tagline": { soloAttempts: 2, batch: 0 } }, translation: { product: { batchChars: 40_000, batchMax: 5 } }, extra: 1 });
    expect(invalid.issues).toEqual(expect.arrayContaining(["runtime_settings_invalid:budgets.crawl-agent-review", "unknown_job:nope", "unknown_route:ghost",
      "runtime_settings_invalid:routes.timeouts.crawl-tagline", "unknown_job_knob:crawl-tagline.soloAttempts", "runtime_settings_invalid:jobs.crawl-tagline.batch",
      "batch_exceeds_source_cap", "runtime_settings_invalid:translation.product.batchMax", "unknown_group:extra"]));
    expect(invalid.settings.budgets["crawl-agent-review"]).toBe(110_000);
    expect(invalid.settings.routes.timeouts["crawl-tagline"]).toBe(45_000);
    expect(invalid.settings.jobs["crawl-tagline"]).toEqual({ batch: 12, minCallMs: 15_000 });
    expect(invalid.settings.translation.product.batchChars).toBe(40_000);
    expect(resolveRuntimeSettings("garbage").issues).toEqual(["runtime_settings_unreadable"]);
    expect(resolveRuntimeSettings([1]).settings).toEqual(DEFAULT_RUNTIME_SETTINGS);
    const inverted = resolveRuntimeSettings({ version: 1, routes: { deadlines: { "review-gateway": { clientMs: 50_000 } } } });
    expect(inverted.issues).toContain("deadline_order_inverted");
    expect(resolveRuntimeSettings({ version: 1, routes: { timeouts: { "crawl-tagline": 46_000 }, deadlines: { "crawl-tagline": { engineMs: 45_000, relayMs: null, gatewayMs: 48_000, clientMs: 46_000 } } } }).issues)
      .toEqual(expect.arrayContaining(["deadline_order_inverted", "timeout_below_engine_bound:crawl-tagline"]));
  });
  it("sparse 패치는 기본값 위에 덮이고 판은 내용으로만 정해진다", () => {
    const { settings, issues } = resolveRuntimeSettings({ version: 1, routes: { timeouts: { "crawl-tagline": 46_000 }, limits: { "product-translate": { timeoutMs: 200_000 } } },
      jobs: { "reason-translate": { batch: 2 } }, budgets: { "crawl-judge": 30_000, "product-tagline-ko": null } });
    expect(issues).toEqual([]);
    expect(settings.routes.timeouts["crawl-tagline"]).toBe(46_000);
    expect(settings.routes.limits["product-translate"]).toEqual({ maxTokens: 30_000, concurrency: 1, timeoutMs: 200_000 });
    expect(settings.jobs["reason-translate"]).toEqual({ batch: 2, batchChars: 1_600, minCallMs: 30_000, soloAttempts: 3 });
    expect(settings.budgets["crawl-judge"]).toBe(30_000);
    expect(settings.budgets["product-tagline-ko"]).toBe(55_000);
    expect(effectiveJobBudgetMs("product-translate", settings)).toBe(215_000);
    const a = storedSettingsVersion({ version: 1, budgets: { "crawl-judge": 30_000 }, routes: { timeouts: { "crawl-tagline": 46_000 } } });
    const b = storedSettingsVersion({ routes: { timeouts: { "crawl-tagline": 46_000 }, limits: {} }, budgets: { "product-tagline-ko": null, "crawl-judge": 30_000 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(storedSettingsVersion({ budgets: { "crawl-judge": 31_000 } })).not.toBe(a);
  });
});

describe("runtime settings store", () => {
  it("withRuntimeSettings 는 await 를 넘어 스냅샷을 고정하고 읽은 판을 남긴다", async () => {
    const pinned = runtimeSettingsSnapshotFromStored({ version: 1, budgets: { "crawl-publish": 90_000 } }, 7).snapshot;
    expect(pinned.source).toBe("db");
    expect(pinned.revision).toBe(7);
    expect(runtimeSettingsSnapshot().version).toBe("default");
    await withRuntimeSettings(pinned, async () => {
      expect(runtimeSettings().budgets["crawl-publish"]).toBe(90_000);
      await new Promise(resolve => setTimeout(resolve, 5));
      setRuntimeSettingsForTest({ version: 1, budgets: { "crawl-publish": 60_000 } });
      expect(runtimeSettings().budgets["crawl-publish"]).toBe(90_000);
      expect(runtimeSettingsSnapshot()).toBe(pinned);
      expect((await ensureRuntimeSettings(0)).version).toBe(pinned.version);
    });
    expect(runtimeSettings().budgets["crawl-publish"]).toBe(60_000);
    expect(lastRuntimeSettingsRead()).toEqual({ version: pinned.version, at: expect.any(Number), registryEnv: false });
    setRuntimeSettingsForTest(null);
    expect(runtimeSettings()).toBe(DEFAULT_RUNTIME_SETTINGS);
  });
  it("ensureRuntimeSettings 는 loader 를 통해 새 스냅샷을 받고 실패해도 던지지 않는다", async () => {
    let calls = 0;
    setRuntimeSettingsLoader(async () => { calls++; if (calls === 1) throw new Error("db_down"); return runtimeSettingsSnapshotFromStored({ version: 1, budgets: { "crawl-seed": 45_000 } }, 3).snapshot; });
    expect((await ensureRuntimeSettings(0)).version).toBe("default");
    expect((await ensureRuntimeSettings(0)).settings.budgets["crawl-seed"]).toBe(45_000);
    expect(runtimeSettings().budgets["crawl-seed"]).toBe(45_000);
    expect((await ensureRuntimeSettings()).revision).toBe(3);   // fresh — loader not called again
    expect(calls).toBe(2);
  });
  it("경로 한도는 등록부 덮개로 modelTimeoutMs/modelLimits 에 닿고 MODEL_REGISTRY_CONFIG env 는 그대로 이긴다", () => {
    expect(modelTimeoutMs("crawl-tagline", {})).toBe(45_000);
    setRuntimeSettingsForTest({ version: 1, routes: { timeouts: { "crawl-tagline": 46_000 }, limits: { "crawl-tagline": { maxTokens: 300, concurrency: 1 } } } });
    expect(modelTimeoutMs("crawl-tagline", {})).toBe(46_000);
    expect(modelLimits("crawl-tagline", {})).toEqual({ maxTokens: 300, concurrency: 1 });
    expect(modelTimeoutMs("crawl-tagline", { MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS }) })).toBe(45_000);
    setRuntimeSettingsForTest(null);
    expect(modelTimeoutMs("crawl-tagline", {})).toBe(45_000);
    // A policy that fails the merged registry schema keeps the code-default routes instead of throwing.
    setModelRoutePolicyOverlay(() => ({ deadlines: { "review-gateway": { engineMs: 50_000, relayMs: null, gatewayMs: 55_000, clientMs: 40_000 } } }));
    try { expect(modelTimeoutMs("review-gateway", {})).toBe(60_000); } finally { setModelRoutePolicyOverlay(() => runtimeSettings().routes); }
  });
  it("packProductTranslationBatch 는 넘긴 정책을 쓰고 기본은 지금 판이다", () => {
    const task = (id: number, chars: number) => ({ source: { id, name: `p${id}`, tagline: "t", description: "d".repeat(chars) }, field: "description" as const });
    const tasks = [task(1, 3_000), task(2, 3_000), task(3, 3_000)];
    expect(packProductTranslationBatch(tasks).map(t => t.source.id)).toEqual([1, 2]);
    const policy: RuntimeSettings["translation"]["product"] = { ...productTranslationPolicy(), batchChars: 100 };
    expect(packProductTranslationBatch(tasks, policy).map(t => t.source.id)).toEqual([1]);
    setRuntimeSettingsForTest({ version: 1, translation: { product: { batchChars: 9_000 } } });
    expect(packProductTranslationBatch(tasks).map(t => t.source.id)).toEqual([1, 2, 3]);
  });
});
