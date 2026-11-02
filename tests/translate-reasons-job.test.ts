import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { packBatch, translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { textRankUnusableText } from "@/lib/llm/ai-task-resolver";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

const mocks = vi.hoisted(() => ({ untried: vi.fn(), retry: vi.fn(), record: vi.fn(), translate: vi.fn() }));
vi.mock("@/lib/crawl/translations", () => ({
  untriedTranslations: mocks.untried, retryableTranslations: mocks.retry, recordWorkerTranslations: mocks.record,
}));
vi.mock("@/lib/crawl/translate", () => ({ translateToKorean: mocks.translate }));
vi.mock("@/lib/crawl/reason-translation-model-capacity", () => ({
  translateReasonsWithModelCapacity: async (batch: { body: string }[], _lease: unknown,
    options: { timeoutMs: number; signal?: AbortSignal }) => ({ kind: "disabled",
    result: await mocks.translate(batch.map(item => item.body), options.timeoutMs, undefined, options.signal) }),
}));

const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(), lease: { name: "reason-translate", token: "t", requestedVersion: 1 } });
const item = (hash: string, attempts = 0) => ({ hash, body: `English reason ${hash}`, attempts });
/** 순위(PR B, 「작업 ↔ 모델」)의 모델 — 잡은 이 순위의 범위에서 부르고 이 이름으로 적는다. */
const MODEL = "[MLX] gpt-oss-120b";
const SECOND = "[m1] gemma-second";
const SECOND_CONNECTION = "0b0c0d0e-0000-4000-8000-0000000000bb", SECOND_BASE = "http://second.test:8000/v1";
/** The admin engine contract for the rank's model — the only thing that opens the route since the gateway was removed (2026-10-30). */
const direct = (change: Partial<StoredServingContract> = {}): StoredServingContract => ({ ...textContract("reason-translate", MODEL), ...change });
const unusable = (code: string, model = MODEL) =>
  ({ done: true, degraded: { code: "all_ranks_unusable", detail: `심사 사유 번역: 1순위 test-engine · ${model}: ${textRankUnusableText(code)}` } });

it("capacity admission preserves the pending reason and consumes no attempt or write", async () => {
  // PR B: 계약이 닫힌 것(provider_contract_unavailable)은 이 모델만의 미룸이다 — 순위가 하나뿐이면 그 순위를 쉬게 하고, 한 건도 못 했으니 까닭을 남긴다
  const deferred = new ModelCapacityDeferredError("provider_contract_unavailable");
  mocks.untried.mockResolvedValue([item("capacity")]);
  mocks.translate.mockRejectedValue(deferred);
  const ctx = context();
  expect(await translateReasons(ctx)).toEqual(unusable("provider_contract_unavailable"));
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  expect(ctx.log).toHaveBeenCalledWith("translate.all_ranks_unusable", { translated: 0, failed: 0 });
  expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", { ranks: 1, "unusable.1.provider_contract_unavailable": 1 });
});

it("그 모델만의 미룸이면 같은 묶음을 다음 순위로 넘기고 2순위의 이름으로 적는다", async () => {
  pinTextRanks([textRankRow("reason-translate", MODEL),
    textRankRow("reason-translate", SECOND, { rank: 2, connectionId: SECOND_CONNECTION, baseUrl: SECOND_BASE, label: "second" })]);
  setServingContractSnapshotForTest([direct(), textContract("reason-translate", SECOND, { baseUrl: SECOND_BASE })]);
  mocks.untried.mockResolvedValueOnce([item("a")]).mockResolvedValue([]);
  const seen: string[] = [];
  mocks.translate.mockImplementation(async () => {
    seen.push(textTaskModel("reason-translate"));
    if (textTaskModel("reason-translate") === MODEL) throw new ModelCapacityDeferredError("unmapped");
    return { ok: true, translations: ["가"] };
  });
  const ctx = context();
  expect(await translateReasons(ctx)).toEqual({ done: true });
  expect(seen).toEqual([MODEL, SECOND]);
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith([{ hash: "a", translated: "가", error: undefined }], SECOND, context().lease);
  expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", { ranks: 2, "served.2": 1, "unusable.1.unmapped": 1 });
});

beforeEach(() => {
  vi.resetAllMocks();
  pinTextRanks({ "reason-translate": MODEL });
  setServingContractSnapshotForTest([direct()]);
  mocks.record.mockResolvedValue(undefined);
  // 잡은 두 줄을 번갈아 본다 — 밝히지 않은 줄은 비어 있는 것으로 둔다
  mocks.untried.mockResolvedValue([]);
  mocks.retry.mockResolvedValue([]);
});
afterEach(() => { setServingContractSnapshotForTest(null); pinTextRanks(null); vi.unstubAllEnvs(); });

it.each([
  ["no_direct_contract", [], undefined],
  ["no_direct_contract", [direct({ transport: "gateway" })], undefined],
  ["no_direct_contract", [textContract("reason-translate", "[m1] another-model")], undefined],
  ["gateway_auth", [direct({ auth: "gateway" })], undefined],
  // 보내는 키는 연결의 키다(PR B) — 연결에 저장한 키가 열리지 않으면 그 순위를 쓸 수 없다
  ["stored_key_unreadable", [direct()], { keyUnreadable: true }],
] as const)("순위의 직접 연결 계약으로 열리지 않으면(%s) 아무것도 하지 않는다 — ABCLLM_API_KEY 는 읽지 않는다", async (code, rows, rank) => {
  if (rank) pinTextRanks([textRankRow("reason-translate", MODEL, rank)]);
  setServingContractSnapshotForTest(rows);
  vi.stubEnv("ABCLLM_API_KEY", "ignored-gateway-key");
  const ctx = context();
  // 아무것도 하지 않은 틱은 성공이 아니다 — 러너가 성공 시각을 옮기지 않고 조치할 일이 올린다
  expect(await translateReasons(ctx)).toEqual(unusable(code));
  expect(mocks.untried).not.toHaveBeenCalled();
  expect(mocks.retry).not.toHaveBeenCalled();
  expect(mocks.translate).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith("translate.skipped", { reason: "all_ranks_unusable" });
});

it("순위가 없으면 아무것도 하지 않고 no_task_models 로 남긴다 — 코드 기본값·환경변수로 대신 부르지 않는다", async () => {
  pinTextRanks({});
  vi.stubEnv("ABCLLM_MODEL", MODEL);
  const ctx = context();
  expect(await translateReasons(ctx)).toEqual({ done: true, degraded: { code: "no_task_models", detail: expect.stringContaining("심사 사유 번역: ") } });
  expect(mocks.untried).not.toHaveBeenCalled();
  expect(mocks.translate).not.toHaveBeenCalled();
  expect(vi.mocked(ctx.log).mock.calls).toEqual([["translate.skipped", { reason: "no_task_models" }], ["ai_task.ranks", { ranks: 0 }]]);
});

it.each([
  ["저장한 키", { auth: "stored" as const, apiKey: "engine-key" }],
  // 계약 행의 저장 키가 열리지 않아도 상관없다 — 보내는 키는 연결의 키다(PR B)
  ["열리지 않는 계약 행 키", { auth: "stored" as const, apiKey: null }],
])("엔진 직접 연결 계약(%s)이 있으면 ABCLLM_API_KEY 없이도 옮긴다", async (_name, change) => {
  setServingContractSnapshotForTest([direct(change)]);
  vi.stubEnv("ABCLLM_API_KEY", undefined);
  mocks.untried.mockResolvedValueOnce([item("a")]).mockResolvedValue([]);
  mocks.translate.mockResolvedValue({ ok: true, translations: ["가"] });
  expect(await translateReasons(context())).toEqual({ done: true });
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  expect(mocks.record).toHaveBeenCalledWith([{ hash: "a", translated: "가", error: undefined }], MODEL, context().lease);
});

it("처음 보는 글을 묶어 옮기고, 남은 것이 없으면 끝낸다", async () => {
  mocks.untried.mockResolvedValueOnce([item("a"), item("b"), item("c")]).mockResolvedValue([]);
  mocks.translate.mockResolvedValue({ ok: true, translations: ["가", "나", null] });

  expect(await translateReasons(context())).toEqual({ done: true });
  expect(mocks.untried).toHaveBeenCalledWith(8);
  expect(mocks.translate.mock.calls[0][0]).toEqual(["English reason a", "English reason b", "English reason c"]);
  // 한 항목이 비면 그것만 실패로 — 나머지는 남긴다
  expect(mocks.record).toHaveBeenCalledWith([
    { hash: "a", translated: "가", error: undefined }, { hash: "b", translated: "나", error: undefined }, { hash: "c", translated: null, error: undefined },
  ], MODEL, context().lease);
});

it("여러 번 실패한 글은 묶지 않고 혼자 옮긴다 — 옆의 멀쩡한 글까지 끌고 실패하지 않게", async () => {
  mocks.retry.mockResolvedValueOnce([item("x", 3), item("y", 3), item("z", 3)]).mockResolvedValue([]);
  mocks.translate.mockResolvedValue({ ok: true, translations: ["엑스"] });
  await translateReasons(context());
  expect(mocks.translate.mock.calls[0][0]).toEqual(["English reason x"]);
});

it("게이트웨이가 막히면 실패로 남기고 이번 틱을 멈춘다 — 다음 틱에 이어 간다", async () => {
  mocks.untried.mockResolvedValue([item("a"), item("b")]);
  mocks.translate.mockResolvedValue({ ok: false, error: "timeout" });
  expect(await translateReasons(context())).toEqual({ done: false });
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  expect(mocks.record).toHaveBeenCalledWith([{ hash: "a", translated: null, error: "timeout" }, { hash: "b", translated: null, error: "timeout" }], MODEL, context().lease);
});

it("순위가 둘이면 실패한 묶음의 순위만 이 틱 동안 쉬고 다음 묶음은 2순위가 맡는다", async () => {
  pinTextRanks([textRankRow("reason-translate", MODEL),
    textRankRow("reason-translate", SECOND, { rank: 2, connectionId: SECOND_CONNECTION, baseUrl: SECOND_BASE, label: "second" })]);
  setServingContractSnapshotForTest([direct(), textContract("reason-translate", SECOND, { baseUrl: SECOND_BASE })]);
  mocks.untried.mockResolvedValueOnce([item("a")]).mockResolvedValueOnce([item("b")]).mockResolvedValue([]);
  mocks.translate.mockImplementation(async () => textTaskModel("reason-translate") === MODEL
    ? { ok: false, error: "timeout" } : { ok: true, translations: ["나"] });
  const ctx = context();
  expect(await translateReasons(ctx)).toEqual({ done: true });
  expect(mocks.record.mock.calls.map(([rows, model]) => [rows, model])).toEqual([
    [[{ hash: "a", translated: null, error: "timeout" }], MODEL], [[{ hash: "b", translated: "나", error: undefined }], SECOND]]);
  expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", { ranks: 2, "served.1": 1, "served.2": 1, "unusable.1.engine_failed": 1 });
});

it("시간이 모자라면 다음 틱으로 넘긴다", async () => {
  let calls = 0;
  const ctx = { ...context(), hasBudget: () => calls++ < 1 };
  mocks.untried.mockResolvedValue([item("a")]);
  mocks.translate.mockResolvedValue({ ok: true, translations: ["가"] });
  expect(await translateReasons(ctx)).toEqual({ done: false });
  expect(mocks.translate).toHaveBeenCalledTimes(1);
});

it("글자 수로 묶는다 — 최대 4건·1,600자, 순서를 지키고, 긴 글 하나는 혼자 간다", () => {
  const text = (chars: number, id: string) => ({ id, body: "x".repeat(chars) });
  expect(packBatch([text(400, "a"), text(400, "b"), text(400, "c"), text(400, "d"), text(10, "e")]).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  expect(packBatch([text(700, "a"), text(700, "b"), text(700, "c")]).map((i) => i.id)).toEqual(["a", "b"]);
  expect(packBatch([text(2_000, "long"), text(10, "b")]).map((i) => i.id)).toEqual(["long"]);
  expect(packBatch([])).toEqual([]);
});

it("stops before a later solo-retry member so the eligible prefix passes complete batch validation", () => {
  const first = item("first", 1), solo = item("solo", 3), latest = item("latest");
  expect(packBatch([first, solo, latest])).toEqual([first]);
  expect(packBatch([solo, first])).toEqual([solo]);
});

it("틱 끝에 시간이 모자라면 새로 부르지 않는다 — 줄어든 제한으로 헛실패하지 않게", async () => {
  vi.useFakeTimers();
  try {
    mocks.untried.mockResolvedValue([item("a")]);
    // 한 번 부르는 데 30초 — 두 번째를 부르기엔 24초밖에 남지 않는다
    mocks.translate.mockImplementation(async () => { vi.advanceTimersByTime(30_000); return { ok: true, translations: ["가"] }; });
    expect(await translateReasons(context())).toEqual({ done: false });
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    // reason-translate 경로 상한 45초(PR B부터 경로 값만 본다 — 순위가 고른 모델마다의 값과 최솟값을 내지 않는다)
    expect(mocks.translate.mock.calls[0][1]).toBe(45_000);
  } finally { vi.useRealTimers(); }
});

it("shutdown during translation must not write a successful late response", async () => {
  const stopping = new AbortController();
  mocks.untried.mockResolvedValueOnce([item("a")]).mockResolvedValue([]);
  mocks.translate.mockImplementation(async () => { stopping.abort(); return { ok: true, translations: ["가"] }; });
  await translateReasons({ ...context(), signal: stopping.signal });
  expect(mocks.record).not.toHaveBeenCalled();
});

it("이어지는 틱은 번갈아 가던 차례를 잇는다 — 늘 실패하는 재시도 묶음이 처음 보는 글을 굶기지 않는다", async () => {
  mocks.retry.mockResolvedValue([item("failing", 1)]);
  mocks.untried.mockResolvedValue([item("fresh")]);
  // 첫 묶음이 실패하면 그 순위를 이 틱 동안 쉬게 한다 — 순위가 하나뿐이면 틱을 접는 것과 같다(엔진이 막힌 것일 수 있다)
  mocks.translate.mockResolvedValue({ ok: false, error: "timeout" });
  await translateReasons(context()); await translateReasons(context());
  // 두 틱에 걸쳐 두 줄이 한 번씩 차례를 얻는다. 예전에는 틱마다 실패 줄부터 시작해 fresh 가 영영 불리지 않았다
  expect(mocks.translate.mock.calls.map(([texts]) => texts)).toEqual(expect.arrayContaining([["English reason failing"], ["English reason fresh"]]));
  expect(mocks.translate).toHaveBeenCalledTimes(2);
});
