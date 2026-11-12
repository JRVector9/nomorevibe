import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ untried: vi.fn(), retry: vi.fn(), record: vi.fn(), translate: vi.fn(), choose: vi.fn() }));
vi.mock("@/lib/crawl/translations", () => ({
  untriedTranslations: mocks.untried, retryableTranslations: mocks.retry, recordWorkerTranslations: mocks.record,
}));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: mocks.choose }));
const expectation = Object.freeze({ kind: "reason_translation_write" as const });
vi.mock("@/lib/crawl/reason-translation-model-capacity", () => ({
  translateReasonsWithModelCapacity: async (batch: { body: string }[], _lease: unknown, options: { pendingClaims?: { requestIds: Set<string> } }) =>
    ({ kind: "ready", batch, expectation, unknown: false, result: await mocks.translate(batch, options) }),
}));
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig, AiTaskPoolMember } from "@/lib/llm/ai-task-execution-config";
import { textTaskModel, type TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * 사유 번역의 「동시에」(2026-11-12): 칸 수를 적은 묶음이면 칸 수의 합만큼 줄이 함께 돌고, 구성원마다 자기 칸 수를 넘지 않는다.
 * 한 구성원이 서면 그 묶음만 넘기고 남은 구성원이 계속한다. 설정이 없으면 예전처럼 한 줄로 차례차례다.
 */
const QWEN = "gpu3090-qwen", M1 = "m1max";
const QWEN_ID = "0b0c0d0e-0000-4000-8000-0000000000a1", M1_ID = "0b0c0d0e-0000-4000-8000-0000000000b1";
const QWEN_BASE = "http://qwen.test:8000/v1", M1_BASE = "http://m1.test:8000/v1";
const member = (memberId: string, model: string, connectionId: string, baseUrl: string, position: number, maxSlots: number | null): AiTaskPoolMember =>
  Object.freeze({ memberId, position, connectionId, model, options: {}, canonicalModel: model, deviceId: "test-device", engineKey: "0".repeat(64), maxSlots,
    connection: textRankRow("reason-translate", model, { connectionId, baseUrl, label: model }).connection });
const pool = (qwenSlots: number | null, m1Slots: number | null): AiTaskExecutionConfig => Object.freeze({ task: "reason-translate", slot: 1,
  mode: "workload_pool", revision: 2, updatedAt: null, reserveRanks: false,
  members: [member("0b0c0d0e-0000-4000-8000-00000000aaaa", QWEN, QWEN_ID, QWEN_BASE, 1, qwenSlots),
    member("0b0c0d0e-0000-4000-8000-00000000bbbb", M1, M1_ID, M1_BASE, 2, m1Slots)] });
const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(), lease: { name: "reason-translate", token: "t", requestedVersion: 1 } });
// 묶음 하나에 글 하나(글자 수 한도 1,600 — 1,000자 글 둘은 묶이지 않는다)
const item = (hash: string) => ({ hash: hash.padEnd(64, "0"), body: `${hash} `.repeat(600), attempts: 0 });

/** 호출마다 모델별·전체 동시 수를 잰다 */
function meter() {
  const now = new Map<string, number>(), max = new Map<string, number>();
  let total = 0, maxTotal = 0;
  return {
    async call<T>(model: string, run: () => Promise<T>): Promise<T> {
      now.set(model, (now.get(model) ?? 0) + 1); max.set(model, Math.max(max.get(model) ?? 0, now.get(model)!));
      total++; maxTotal = Math.max(maxTotal, total);
      try { return await run(); } finally { now.set(model, now.get(model)! - 1); total--; }
    },
    max: (model: string) => max.get(model) ?? 0, maxTotal: () => maxTotal,
  };
}

let queue: ReturnType<typeof item>[] = [];
const recorded = new Map<string, string>();
beforeEach(() => {
  vi.resetAllMocks();
  recorded.clear();
  pinTextRanks([]);
  setServingContractSnapshotForTest([textContract("reason-translate", QWEN, { baseUrl: QWEN_BASE }), textContract("reason-translate", M1, { baseUrl: M1_BASE })]);
  // DB 처럼: 적은 글은 다시 나오지 않는다
  mocks.untried.mockImplementation(async (limit: number) => queue.filter(row => !recorded.has(row.hash)).slice(0, limit));
  mocks.retry.mockResolvedValue([]);
  mocks.record.mockImplementation(async (rows: { hash: string }[], model: string) => { for (const row of rows) recorded.set(row.hash, model); return rows.length; });
  mocks.choose.mockImplementation(async (_config, candidates: readonly TextTaskRankBinding[]) => candidates[0] ?? null);
});
afterEach(() => { setAiTaskExecutionConfigsForTest(null); setServingContractSnapshotForTest(null); pinTextRanks(null); });

describe("사유 번역 「동시에」", () => {
  it("칸 수(qwen 2 · m1 1)의 합만큼 함께 돌고, 구성원마다 칸 수를 넘지 않으며, 일감이 두 구성원에게 나뉜다", async () => {
    queue = ["a", "b", "c", "d", "e", "f"].map(item);
    setAiTaskExecutionConfigsForTest([pool(2, 1)]);
    const seen = meter();
    mocks.translate.mockImplementation(async (batch: unknown[], options: { pendingClaims?: unknown }) => {
      // 여러 줄일 때는 이 틱이 집은 장부 요청을 줄끼리 나눠 보는 표(pendingClaims)를 호출 쪽에 넘긴다
      expect(options.pendingClaims).toBeDefined();
      const model = textTaskModel("reason-translate");
      return seen.call(model, async () => { await new Promise(resolve => setTimeout(resolve, 15)); return { ok: true, translations: batch.map(() => "번역") }; });
    });
    const ctx = context();
    expect(await translateReasons(ctx)).toEqual({ done: true });
    expect(recorded.size).toBe(6);
    expect(seen.maxTotal()).toBe(3);
    expect(seen.max(QWEN)).toBe(2);
    expect(seen.max(M1)).toBe(1);
    expect(new Set(recorded.values())).toEqual(new Set([QWEN, M1]));
    expect(ctx.log).toHaveBeenCalledWith("translate.done", { translated: 6, failed: 0, drained: true, lanes: 3 });
    expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", expect.objectContaining({ pool_members: 2, pool_revision: 2, pool_lanes: 3 }));
  });

  it("한 구성원이 서면(그 구성원만의 미룸) 그 묶음만 넘기고 — 다른 구성원에게 넘기지 않는다 — 남은 구성원이 나머지를 끝낸다", async () => {
    queue = ["a", "b", "c", "d"].map(item);
    setAiTaskExecutionConfigsForTest([pool(2, 1)]);
    const calls: string[] = [];
    mocks.translate.mockImplementation(async (batch: { hash: string }[]) => {
      const model = textTaskModel("reason-translate");
      calls.push(`${model}:${batch[0].hash.slice(0, 1)}`);
      if (model === QWEN) throw new ModelCapacityDeferredError("route_quota");
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true, translations: batch.map(() => "번역") };
    });
    const ctx = context();
    // 넘긴 묶음이 남아 있으니 다 끝난 틱은 아니다
    expect(await translateReasons(ctx)).toEqual({ done: false });
    const passed = calls.filter(call => call.startsWith(QWEN)).map(call => call.slice(-1));
    // 넘긴 글은 이 틱에 다시 부르지 않는다(m1 으로도)
    for (const hash of passed) expect(calls).not.toContain(`${M1}:${hash}`);
    expect([...recorded.values()].every(model => model === M1)).toBe(true);
    expect(recorded.size).toBe(4 - passed.length);
    expect(ctx.log).toHaveBeenCalledWith("translate.passed", expect.objectContaining({ reason: "route_quota" }));
    expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", expect.objectContaining({ "member_unusable.0b0c0d0e-0000-4000-8000-00000000aaaa.route_quota": 1 }));
  });

  it("기본(순위대로)은 예전처럼 한 줄로 차례차례 — 동시에 하나만 부르고 줄끼리 나눌 표도 넘기지 않는다", async () => {
    queue = ["a", "b", "c"].map(item);
    pinTextRanks({ "reason-translate": QWEN });
    setServingContractSnapshotForTest([textContract("reason-translate", QWEN)]);
    const seen = meter();
    mocks.translate.mockImplementation(async (batch: unknown[], options: { pendingClaims?: unknown }) => {
      expect(options.pendingClaims).toBeUndefined();
      return seen.call(textTaskModel("reason-translate"), async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, translations: batch.map(() => "번역") }; });
    });
    const ctx = context();
    expect(await translateReasons(ctx)).toEqual({ done: true });
    expect(seen.maxTotal()).toBe(1);
    expect(recorded.size).toBe(3);
    expect(mocks.choose).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenLastCalledWith("ai_task.ranks", { ranks: 1, "served.1": 3 });
  });

  it("칸 수를 적지 않은 옛 묶음도 예전처럼 한 줄이다", async () => {
    queue = ["a", "b"].map(item);
    setAiTaskExecutionConfigsForTest([pool(null, null)]);
    const seen = meter();
    mocks.translate.mockImplementation(async (batch: unknown[], options: { pendingClaims?: unknown }) => {
      expect(options.pendingClaims).toBeUndefined();
      return seen.call(textTaskModel("reason-translate"), async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, translations: batch.map(() => "번역") }; });
    });
    expect(await translateReasons(context())).toEqual({ done: true });
    expect(seen.maxTotal()).toBe(1);
    expect(recorded.size).toBe(2);
  });
});
