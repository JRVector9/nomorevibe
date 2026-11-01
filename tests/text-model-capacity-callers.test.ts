import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { profileEvidence } from "@/lib/domain/products/search-profile";
import type { JobContext } from "@/lib/jobs/runner";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import { displayProjectName } from "@/lib/domain/products/display-name";
import { writeKoreanTaglines } from "@/lib/jobs/products/korean-tagline";
import { translateDemandedProductFields } from "@/lib/jobs/products/translations";
import { productTranslationSourceHash } from "@/lib/domain/products/translation-policy";
import { resolveSearchQuery, warmQueryTranslation } from "@/lib/domain/products/search-translation";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { TAGLINE_MODEL } from "@/lib/crawl/tagline";
import { PROFILE_MODEL } from "@/lib/domain/products/search-profile";
import { VERIFY_MODEL } from "@/lib/domain/products/search-verify";
import { KOREAN_TAGLINE_MODEL, PRODUCT_TRANSLATE_MODEL, SEARCH_QUERY_MODEL, TRANSLATE_MODEL } from "@/lib/crawl/translate";

const mocks = vi.hoisted(() => ({ tagline: vi.fn(), profile: vi.fn(), verify: vi.fn(), korean: vi.fn(), product: vi.fn(), query: vi.fn(),
  tagTasks: vi.fn(), profiles: vi.fn(), verifications: vi.fn(), koreanTasks: vi.fn(), productTasks: vi.fn(),
  tagWrite: vi.fn(), profileWrite: vi.fn(), verifyWrite: vi.fn(), koreanWrite: vi.fn(), productWrite: vi.fn(),
  cache: vi.fn(), cacheWrite: vi.fn(), primary: vi.fn(), log: vi.fn(), control: vi.fn() }));
vi.mock("@/lib/llm/capacity-repository", async load => ({
  ...await load<typeof import("@/lib/llm/capacity-repository")>(), readModelCapacityCallerControl: mocks.control,
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true }) }));
vi.mock("@/lib/crawl/tagline", async (load) => ({ ...await load<typeof import("@/lib/crawl/tagline")>(), writeTagline: mocks.tagline }));
vi.mock("@/lib/crawl/tagline-model-capacity", () => ({
  writeCrawlTaglineWithModelCapacity: async (task: import("@/lib/crawl/taglines").TaglineTask, _lease: unknown,
    options: { timeoutMs: number; signal?: AbortSignal }) => ({ kind: "result", askOrdinal: 1,
    result: await mocks.tagline((await import("@/lib/crawl/tagline")).taglineEvidence(task.candidate.repo, task.document),
      { signal: options.signal, timeoutMs: options.timeoutMs }),
  }),
}));
vi.mock("@/lib/domain/products/search-profile", async (load) => ({ ...await load<typeof import("@/lib/domain/products/search-profile")>(), writeKeywords: mocks.profile }));
vi.mock("@/lib/domain/products/search-profile-model-capacity", () => ({
  writeKeywordsWithModelCapacity: async (task: import("@/lib/domain/products/search-profiles").ProfileTask,
    _lease: unknown, options: { timeoutMs: number; signal?: AbortSignal }) => ({
    kind: "result", result: await mocks.profile(profileEvidence(task.product, task.reviewerNote), options),
  }),
}));
vi.mock("@/lib/domain/products/search-verify-model-capacity", () => ({
  verifyKeywordsWithModelCapacity: async (task: import("@/lib/domain/products/search-profiles").ProfileTask, _lease: unknown,
    options: { timeoutMs: number; signal?: AbortSignal; request?: typeof fetch }) => ({ kind: "result",
    result: await mocks.verify({ evidence: profileEvidence(task.product, task.reviewerNote), keywords: [...task.profile!.keywordsEn, ...task.profile!.keywordsKo] },
      { request: options.request, signal: options.signal, timeoutMs: options.timeoutMs }),
  }),
}));
vi.mock("@/lib/domain/products/search-verify", async (load) => ({ ...await load<typeof import("@/lib/domain/products/search-verify")>(),
  verifyKeywords: mocks.verify, verifyKeywordsInChunks: mocks.verify }));
vi.mock("@/lib/crawl/translate", async (load) => ({ ...await load<typeof import("@/lib/crawl/translate")>(),
  translateTaglinesToKorean: mocks.korean, translateProductFields: mocks.product,
  translateQueryToEnglish: mocks.query, translateChineseQueryToEnglish: mocks.query }));
vi.mock("@/lib/crawl/taglines", () => ({ pendingTaglines: mocks.tagTasks, recordTaglineResult: mocks.tagWrite }));
vi.mock("@/lib/domain/products/search-profiles", () => ({ pendingProfiles: mocks.profiles, pendingVerifications: mocks.verifications,
  recordProfileResult: mocks.profileWrite, recordVerificationResult: mocks.verifyWrite }));
vi.mock("@/lib/domain/products/korean-taglines", async load => ({
  ...await load<typeof import("@/lib/domain/products/korean-taglines")>(), homeListSlugs: async () => [], pendingKoreanTaglines: mocks.koreanTasks,
  recordKoreanTaglines: mocks.koreanWrite }));
vi.mock("@/lib/domain/products/korean-tagline-model-capacity", () => ({
  translateKoreanTaglinesWithModelCapacity: async (tasks: readonly import("@/lib/domain/products/korean-taglines").KoreanTaglineTask[],
    _home: readonly string[], _lease: unknown, options: { timeoutMs: number; signal?: AbortSignal }) => {
    const { koreanTaglineSource } = await import("@/lib/domain/products/korean-taglines");
    return { kind: "result", result: await mocks.korean(tasks.map(task => ({
      name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task),
    })), options.timeoutMs, undefined, options.signal) };
  },
}));
vi.mock("@/lib/domain/products/translations", () => ({ pendingProductTranslations: mocks.productTasks, recordProductTranslations: mocks.productWrite }));
vi.mock("@/lib/domain/products/product-translation-model-capacity", () => ({
  translateProductFieldsWithModelCapacity: async (tasks: readonly import("@/lib/domain/products/translations").ProductTranslationTask[],
    _lease: unknown, options: { timeoutMs: number; signal?: AbortSignal }) => ({ kind: "result",
    result: await mocks.product(tasks.map(task => ({ name: task.source.name, locale: task.locale, field: task.field,
      text: task.field === "tagline" ? task.source.tagline : task.source.description ?? "" })), options.timeoutMs, undefined, options.signal),
  }),
}));
vi.mock("@/lib/domain/products/search-query-model-capacity", () => ({ translateQueryWithModelCapacity: async () => ({ kind: "legacy" }) }));
vi.mock("@/lib/crawl/translations", () => ({ recordTranslations: mocks.cacheWrite }));
vi.mock("@/lib/db", () => ({ db: {
  select: () => ({ from: () => ({ where: mocks.cache }) }), execute: async () => [{ lexeme: "document" }],
}, onPrimary: mocks.primary }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: mocks.log, warn: mocks.log } }));

const latch = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const context = (name: string): JobContext<null> => ({ cursor: null, lease: { name, token: "fixture-token", requestedVersion: 9 },
  hasBudget: () => true, save: vi.fn(), log: vi.fn() });
const product = (id: number) => ({ id, slug: `doc-${id}`, name: `Doc ${id}`, url: `https://doc-${id}.test`, category: "Tools",
  tagline: "Document tool", description: "Manage documents", status: "verified", searchTopics: null, searchPageText: null, searchReadme: null });
const profileTask = (id: number) => ({ product: product(id), profile: null, reviewerNote: null });
const tagTask = (id: number) => ({ candidate: { repo: `fixture/doc-${id}` },
  document: { productUrl: `https://doc-${id}.test`, repoMeta: {}, pageMeta: { title: `Doc ${id}`, textSample: "Document manager" } }, written: null });
const scenarios = [
  { name: "crawl-tagline", run: writeTaglines, tasks: mocks.tagTasks, call: mocks.tagline, write: mocks.tagWrite,
    task: tagTask, concurrency: 2, result: { ok: true, tagline: "Document manager", source: "page" } },
  { name: "product-search-profile", run: writeSearchProfiles, tasks: mocks.profiles, call: mocks.profile, write: mocks.profileWrite,
    task: profileTask, concurrency: 2, result: { ok: true, en: ["document tool"], ko: ["문서 관리"] } },
  { name: "product-search-verify", run: verifySearchKeywords, tasks: mocks.verifications, call: mocks.verify, write: mocks.verifyWrite,
    task: (id: number) => ({ ...profileTask(id), profile: { keywordsEn: ["document tool"], keywordsKo: [], verifyError: null } }),
    concurrency: 4, result: { ok: true, unsupported: [] } },
];

beforeEach(() => {
  vi.resetAllMocks();
  // Each text route is served by a directly connected engine (admin contract, transport direct); no gateway key exists.
  setServingContractSnapshotForTest(([["crawl-tagline", TAGLINE_MODEL], ["product-search-profile", PROFILE_MODEL],
    ["product-search-verify", VERIFY_MODEL], ["product-tagline-ko", KOREAN_TAGLINE_MODEL], ["product-translate", PRODUCT_TRANSLATE_MODEL],
    ["reason-translate", TRANSLATE_MODEL], ["search-query-translate", SEARCH_QUERY_MODEL]] as const).map(([routeId, model]) =>
    ({ routeId, model, contract: {}, auth: "none" as const, apiKey: null, transport: "direct" as const })));
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "false");
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "false");
  mocks.control.mockResolvedValue({ mode: "disabled" });
  mocks.tagWrite.mockResolvedValue({ stored: true, released: false });
  mocks.profileWrite.mockResolvedValue(true);
  mocks.verifyWrite.mockResolvedValue(true);
  mocks.cache.mockResolvedValue([]);
  mocks.primary.mockImplementation(async (load: () => Promise<unknown>) => load());
});
afterEach(() => { vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });

it.each(scenarios)("$name drains existing calls without aborting peers or admitting another after capacity defer", async scenario => {
  const finish = latch(), entered = latch();
  const deferred = new ModelCapacityDeferredError("capacity");
  const signals: AbortSignal[] = [];
  scenario.tasks.mockResolvedValue(Array.from({ length: scenario.concurrency + 2 }, (_, index) => scenario.task(index + 1)));
  scenario.call.mockRejectedValueOnce(deferred).mockImplementation(async (_input, options: { signal: AbortSignal }) => {
    signals.push(options.signal); entered.resolve(); await finish.promise; return scenario.result;
  });
  let ended = false, failure: unknown, outcome: unknown;
  const work = scenario.run(context(scenario.name)).then(value => { outcome = value; }, error => { failure = error; }).finally(() => { ended = true; });
  try {
    await Promise.race([entered.promise, work]);
    await Promise.resolve();
    expect(signals).toHaveLength(scenario.concurrency - 1);
    expect(signals.every(signal => !signal.aborted)).toBe(true);
    expect(ended).toBe(false);
  } finally { finish.resolve(); await work; }
  // 동료가 항목을 끝낸 뒤의 포화 미룸은 던지지 않고 건수를 돌려준다 — 러너가 lastSuccessAt 을 옮긴다. 0건이면 종전대로 던진다.
  expect(failure).toBeUndefined();
  expect(outcome).toEqual({ done: false, deferred: "model_capacity", processed: scenario.concurrency - 1 });
  expect(scenario.call).toHaveBeenCalledTimes(scenario.concurrency);
  expect(scenario.write).toHaveBeenCalledTimes(scenario.concurrency - 1);
  expect(scenario.write.mock.calls.every(call => call[0].candidate?.repo !== "fixture/doc-1" && call[0].product?.id !== 1)).toBe(true);
});

it.each(scenarios)("$name preserves a genuine peer error ahead of a capacity rejection", async scenario => {
  const finish = latch(), entered = latch(), failure = new Error("actual_result_write_failure");
  scenario.tasks.mockResolvedValue(Array.from({ length: scenario.concurrency }, (_, index) => scenario.task(index + 1)));
  scenario.call.mockRejectedValueOnce(new ModelCapacityDeferredError("capacity")).mockImplementation(async () => {
    entered.resolve(); await finish.promise; throw failure;
  });
  let caught: unknown;
  const work = scenario.run(context(scenario.name)).catch(error => { caught = error; });
  try { await Promise.race([entered.promise, work]); } finally { finish.resolve(); await work; }
  expect(caught).toBe(failure);
  expect(scenario.write).not.toHaveBeenCalled();
});

it("Korean tagline admission does not consume a product attempt or backoff", async () => {
  const failure = new ModelCapacityDeferredError("capacity");
  mocks.koreanTasks.mockResolvedValue([{ productId: 1, name: "Doc", tagline: "Document tool", repoUrl: null, attempts: 0 }]);
  mocks.korean.mockRejectedValue(failure);
  await expect(writeKoreanTaglines(context("product-tagline-ko"))).rejects.toBe(failure);
  expect(mocks.control).toHaveBeenCalledOnce();
  expect(mocks.korean).toHaveBeenCalledOnce();
  expect(mocks.koreanWrite).not.toHaveBeenCalled();
});

it("product field admission leaves an eligible demand untouched", async () => {
  const source = { id: 1, name: "Doc", tagline: "문서를 관리하는 도구" };
  const failure = new ModelCapacityDeferredError("capacity");
  mocks.productTasks.mockResolvedValue([{ source, field: "tagline", locale: "en", sourceHash: productTranslationSourceHash(source, "tagline"), eligible: true }]);
  mocks.product.mockRejectedValue(failure);
  await expect(translateDemandedProductFields(context("product-translate"))).rejects.toBe(failure);
  expect(mocks.productWrite).not.toHaveBeenCalled();
});

// 2026-10-30 결정("미확인이 되어도 절대 멈추지 않는다"): 한 후보·한 묶음만의 미룸은 그 대상만 넘기고 같은 틱의 다음 대상을 계속한다.
it.each(["dispatched", "work_busy"] as const)("crawl-tagline passes one candidate's %s refusal and keeps writing the rest of the tick", async reason => {
  const tasks = [1, 2, 3].map(id => ({ ...tagTask(id), candidate: { id, repo: `fixture/doc-${id}` } }));
  mocks.tagTasks.mockResolvedValueOnce(tasks).mockResolvedValue([]);
  mocks.tagline.mockImplementation(async (evidence: { url: string }) => {
    if (evidence.url === "https://doc-1.test") throw new ModelCapacityDeferredError(reason);
    return { ok: true, tagline: "Document manager", source: "page" };
  });
  const ctx = context("crawl-tagline");
  expect(await writeTaglines(ctx)).toEqual({ done: true });
  expect(mocks.tagWrite.mock.calls.map(call => call[0].candidate.id).sort()).toEqual([2, 3]);
  expect(mocks.tagTasks.mock.calls.map(call => call[1])).toEqual([{ skipBusy: true, exclude: [] }, { skipBusy: true, exclude: [1] }]);
  expect(ctx.log).toHaveBeenCalledWith("tagline.passed", { repo: "fixture/doc-1", reason });
});

it("crawl-tagline still defers the whole tick on a saturation capacity refusal", async () => {
  const tasks = [1, 2].map(id => ({ ...tagTask(id), candidate: { id, repo: `fixture/doc-${id}` } }));
  const deferred = new ModelCapacityDeferredError("capacity");
  mocks.tagTasks.mockResolvedValueOnce(tasks).mockResolvedValue([]);
  mocks.tagline.mockRejectedValue(deferred);
  await expect(writeTaglines(context("crawl-tagline"))).rejects.toBe(deferred);
  expect(mocks.tagWrite).not.toHaveBeenCalled();
});

it.each(["dispatched", "work_busy"] as const)("product-translate passes a %s batch and translates the next demanded field in the same tick", async reason => {
  const first = { id: 1, name: "Doc", tagline: "문서를 관리하는 도구" }, second = { id: 2, name: "Pad", tagline: "메모를 정리하는 도구" };
  const task = (source: typeof first) => ({ source, field: "tagline", locale: "en", sourceHash: productTranslationSourceHash(source, "tagline"),
    attempts: 0, eligible: true });
  mocks.productTasks.mockResolvedValueOnce([task(first)]).mockResolvedValueOnce([task(second)]).mockResolvedValue([]);
  mocks.product.mockRejectedValueOnce(new ModelCapacityDeferredError(reason)).mockResolvedValueOnce({ ok: true, outputs: ["Pad organizes your notes"] });
  mocks.productWrite.mockResolvedValue(1);
  expect(await translateDemandedProductFields(context("product-translate"))).toEqual({ done: true });
  expect(mocks.productTasks.mock.calls.map(call => call[1])).toEqual([{ exclude: [] }, { exclude: ["product-translate:1:en:tagline"] }]);
  // 호출한 묶음은 틱마다 하나다 — 넘긴 묶음은 호출하지 않았다
  expect(mocks.product).toHaveBeenCalledTimes(2);
  expect(mocks.productWrite).toHaveBeenCalledOnce();
  expect(mocks.productWrite.mock.calls[0][0].map((entry: { task: { source: { id: number } } }) => entry.task.source.id)).toEqual([2]);
});

it.each(["문서 정리", "代码编辑器", "程式碼編輯器"])("query defer keeps original search and pending without caching failure: %s", async query => {
  mocks.query.mockRejectedValue(new ModelCapacityDeferredError("provider_contract_unavailable"));
  const result = await resolveSearchQuery(query, { waitForTranslation: true });
  expect(result).toMatchObject({ translated: null, translationPending: true });
  expect(result.queries).toMatchObject({ texts: [query] });
  expect(mocks.cacheWrite).not.toHaveBeenCalled();
  expect(mocks.primary).not.toHaveBeenCalled();
});

it("warm query capacity defer settles without writing a failure cache or retrying", async () => {
  mocks.query.mockRejectedValue(new ModelCapacityDeferredError("draining"));
  await warmQueryTranslation("문서 정리");
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.cacheWrite).not.toHaveBeenCalled();
});

it("a cache hit remains usable without another call or write", async () => {
  mocks.cache.mockResolvedValue([{ translated: "document tool" }]);
  const result = await resolveSearchQuery("문서 정리", { waitForTranslation: true });
  expect(result.translated).toBe("document tool");
  expect(result.translationPending).toBeUndefined();
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.cacheWrite).not.toHaveBeenCalled();
});

it("ordinary failed query transport still records the existing failed cache on primary", async () => {
  mocks.query.mockResolvedValue({ ok: false, error: "network" });
  const result = await resolveSearchQuery("문서 정리", { waitForTranslation: true });
  expect(result.translationPending).toBeUndefined();
  expect(mocks.cacheWrite).toHaveBeenCalledWith([{ hash: expect.any(String), translated: null, error: "network" }], expect.any(String), "en");
  expect(mocks.primary).toHaveBeenCalledTimes(1);
});

it("product-search-profile: one worker's lock_timeout (55P03) never aborts the sibling's sent call and still fails the tick (2026-10-31)", async () => {
  const finish = latch(), entered = latch(), signals: AbortSignal[] = [];
  const timeout = Object.assign(new Error("Failed query: select \"id\" from \"model_capacity_control\" where \"id\" = $1 for share"),
    { cause: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) });
  mocks.profiles.mockResolvedValue([profileTask(1), profileTask(2), profileTask(3)]);
  mocks.profile.mockImplementationOnce(async (_input, options: { signal: AbortSignal }) => {
    signals.push(options.signal); entered.resolve(); await finish.promise; return { ok: true, en: ["document tool"], ko: ["문서 관리"] };
  }).mockImplementationOnce(async () => { await entered.promise; throw timeout; });
  const work = writeSearchProfiles(context("product-search-profile")).then(() => null, error => error);
  await entered.promise; await new Promise(resolve => setTimeout(resolve, 10));
  // 예전: 55P03 이 result_write_failed 로 controller.abort() 를 불러 옆 일꾼의 보내진 호출이 끊기고 그 요청이 미확인으로 남았다
  expect(signals.every(signal => !signal.aborted)).toBe(true);
  finish.resolve();
  expect(await work).toBe(timeout);
  expect(mocks.profile).toHaveBeenCalledTimes(2);
  expect(mocks.profileWrite).toHaveBeenCalledTimes(1);
  expect(mocks.log).toHaveBeenCalledWith("search_profile.lock_timeout_holders", expect.objectContaining({ holders: expect.any(Array) }));
});
