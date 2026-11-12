import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2차 검수 「동시에」(투표자 1) 표 배정 — 2026-11-12 「동시에」 전 단계 검토.
 * 예전: 표를 배정하는 순간 모든 구성원의 장비가 가득이면 고르기가 null 이라 표를 만들지 않고 말없이 넘겼고(소비자가 장비를 채우는 동안 새 후보가 표를 못 얻음),
 * 용량 장부가 DRAIN 이면 고르기의 draining 이 유지보수 틱 전체(정산·고아 정리·실패 표 재시도·발행분 표본)를 던졌다.
 * 지금: 표 배정은 줄에 설 수 있는 구성원을 돌림 차례로 고르고(queueWhenFull·rotate), 장부가 열려 있지 않으면 이 틱에는 배정만 건너뛴다.
 */
const mocks = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: mocks.choose }));
vi.mock("@/lib/llm/ai-task-resolver", () => ({ taskModels: () => [] }));
const MEMBER = "0b0c0d0e-0000-4000-8000-00000000c0c0";
const config = Object.freeze({ task: "second-review", slot: 1, mode: "workload_pool", revision: 3, updatedAt: null, reserveRanks: false,
  members: [{ memberId: MEMBER, position: 1, connectionId: "0b0c0d0e-0000-4000-8000-0000000000c1", model: "qwen-next", options: {},
    canonicalModel: "qwen-next", deviceId: "gpu", engineKey: "e".repeat(64), connection: {} }] });
vi.mock("@/lib/crawl/review-task-ranks", () => ({
  settingsReviewersActive: () => false, reviewTaskRanksPinned: () => false, reviewRouteContracts: () => [],
  bindReviewTaskRank: () => ({ binding: null, unusable: "rank_disabled", detail: null }),
  resolveReviewTaskRanks: (_task: string, slot = 1) => ({ task: "second-review", slot, routeId: "second-review", status: "ok",
    candidates: slot === 1 ? [{ rank: {}, unusable: null, detail: null, poolMember: config.members[0],
      binding: { routeId: "second-review", provider: "abcllm", identity: "qwen-next", engineModel: "qwen-next", connectionId: config.members[0].connectionId, deviceId: "gpu" } }] : [] }),
}));
import { insertSecondReviewWorkloadRows } from "@/lib/crawl/second-review-workload";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig } from "@/lib/llm/ai-task-execution-config";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { ProductTransaction } from "@/lib/domain/products/generation";

// tests/setup-env.ts 가 매 시험 앞에 빈 표로 고정한다 — 그 뒤에 투표자 1 의 묶음을 고정한다
beforeEach(() => setAiTaskExecutionConfigsForTest([config as unknown as AiTaskExecutionConfig]));
afterEach(() => mocks.choose.mockReset());

function fakeTx() {
  const inserted: unknown[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: (value: unknown) => {
      inserted.push(value);
      return { onConflictDoNothing: () => ({ returning: async () => [{ id: inserted.length, ...(value as object) }] }), then: (resolve: (v: unknown) => void) => resolve(undefined) };
    } }),
  };
  return { tx: tx as unknown as ProductTransaction, inserted };
}
const proposed = { candidateId: 41, generationKey: "g", inputHash: "h", trigger: "ai1_approved" } as never;

describe("2차 「동시에」 표 배정", () => {
  it("줄에 설 수 있는 구성원을 돌림 차례로 고른다(지금 빈 칸이 없어도 표를 만든다)", async () => {
    mocks.choose.mockResolvedValue({ provider: "abcllm", identity: "qwen-next", memberId: MEMBER,
      poolSelection: { task: "second-review", slot: 1, configRevision: 3, memberId: MEMBER, position: 1, policyEpoch: 1, policyRevision: 1, policyHash: "x" } });
    const { tx, inserted } = fakeTx();
    const rows = await insertSecondReviewWorkloadRows(tx, [proposed]);
    expect(mocks.choose.mock.calls[0][2]).toMatchObject({ executor: tx, queueWhenFull: true, rotate: true });
    expect(rows).toHaveLength(1);
    expect(inserted).toEqual([expect.objectContaining({ candidateId: 41, provider: "abcllm", model: "qwen-next" }),
      expect.objectContaining({ taskSlot: 1, configRevision: 3, memberId: MEMBER })]);
  });

  it.each(["draining", "disabled", "policy_changed"] as const)("용량 장부가 열려 있지 않으면(%s) 이 틱에는 배정만 건너뛴다 — 유지보수 틱을 던지지 않는다", async reason => {
    mocks.choose.mockRejectedValue(new ModelCapacityDeferredError(reason));
    const { tx, inserted } = fakeTx();
    await expect(insertSecondReviewWorkloadRows(tx, [proposed, { ...(proposed as object), candidateId: 42 } as never])).resolves.toEqual([]);
    expect(inserted).toEqual([]);
    expect(mocks.choose).toHaveBeenCalledTimes(1);   // 첫 미룸에서 멈춘다 — 같은 답을 후보마다 다시 묻지 않는다
  });

  it("그 밖의 미룸(배정 표를 못 읽음 등)은 예전처럼 던진다", async () => {
    mocks.choose.mockRejectedValue(new ModelCapacityDeferredError("assignments_unavailable"));
    const { tx } = fakeTx();
    await expect(insertSecondReviewWorkloadRows(tx, [proposed])).rejects.toMatchObject({ reason: "assignments_unavailable" });
  });
});
