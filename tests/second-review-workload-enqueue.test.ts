import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2차 검수 「동시에」(투표자 1) 표 배정.
 * 2026-11-12 「동시에」 전 단계 검토: 표를 배정하는 순간 모든 구성원의 장비가 가득이면 고르기가 null 이라 표를 만들지 않고 말없이 넘겼고,
 * 용량 장부가 DRAIN 이면 고르기의 draining 이 유지보수 틱 전체를 던졌다 — 지금은 줄에 설 수 있는 구성원을 돌림 차례로 고르고, 장부가 닫혀 있으면 배정만 건너뛴다.
 * 2026-11-12 소유자 「1,2차도 동시에 선택하면 새 동작을 따르게」: 칸 수(구성원의 끝나지 않은 표 상한)와 예비(저장된 순위의 첫 쓸 수 있는 순위)를 따른다.
 */
const mocks = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: mocks.choose }));
vi.mock("@/lib/llm/ai-task-resolver", () => ({
  taskModels: (_task: string, slot: number) => slot === 1 ? [{ task: "second-review", slot: 1, rank: 1, model: "legacy-voter", enabled: true, options: {}, connection: {} }] : [],
}));
const MEMBER = "0b0c0d0e-0000-4000-8000-00000000c0c0", OTHER = "0b0c0d0e-0000-4000-8000-00000000d0d0";
const poolMember = (memberId: string, model: string, position: number, maxSlots: number | null) => ({ memberId, position,
  connectionId: `0b0c0d0e-0000-4000-8000-00000000000${position}`, model, options: {}, canonicalModel: model, deviceId: "gpu", engineKey: "e".repeat(64), maxSlots, connection: {} });
let config: Record<string, unknown> = {};
let membersUnusable = false;
const configure = (members: ReturnType<typeof poolMember>[], reserveRanks = false) => {
  config = { task: "second-review", slot: 1, mode: "workload_pool", revision: 3, updatedAt: null, reserveRanks, members };
  setAiTaskExecutionConfigsForTest([config as unknown as AiTaskExecutionConfig]);
};
const binding = (model: string, connectionId = "c") => ({ routeId: "second-review", provider: "abcllm", identity: model, engineModel: model, connectionId, deviceId: "gpu" });
vi.mock("@/lib/crawl/review-task-ranks", async load => ({
  ...await load<typeof import("@/lib/crawl/review-task-ranks")>(),
  settingsReviewersActive: () => false, reviewTaskRanksPinned: () => false, reviewRouteContracts: () => [],
  bindReviewTaskRank: (_task: string, rank: { model: string }) => ({ rank, unusable: null, detail: null, binding: binding(rank.model) }),
  resolveReviewTaskRanks: (_task: string, slot = 1) => ({ task: "second-review", slot, routeId: "second-review", status: "ok",
    execution: slot === 1 ? config : undefined,
    candidates: slot === 1 ? (config.members as ReturnType<typeof poolMember>[]).map(member => ({ rank: { rank: member.position },
      unusable: membersUnusable ? "connection_disabled" : null, detail: null,
      poolMember: member, binding: binding(member.model, member.connectionId) })) : [] }),
}));
import { insertSecondReviewWorkloadRows, secondReviewPoolHasEligibleMember, secondReviewPoolReserve } from "@/lib/crawl/second-review-workload";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig } from "@/lib/llm/ai-task-execution-config";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { ProductTransaction } from "@/lib/domain/products/generation";

// tests/setup-env.ts 가 매 시험 앞에 빈 표로 고정한다 — 그 뒤에 투표자 1 의 묶음을 고정한다
beforeEach(() => configure([poolMember(MEMBER, "qwen-next", 1, null)]));
afterEach(() => { mocks.choose.mockReset(); membersUnusable = false; });

/** loads: 모델마다 끝나지 않은 표(pending) 수 — 칸 수를 적은 묶음에서만 읽는다 */
function fakeTx(loads: Record<string, number> = {}) {
  const inserted: Record<string, unknown>[] = [];
  let loadReads = 0;
  const tx = {
    select: (fields?: Record<string, unknown>) => ({ from: () => ({ where: () => {
      const rows = Promise.resolve([]);
      return Object.assign(rows, { groupBy: async () => {
        if (!fields || !("n" in fields)) throw new Error("unexpected_group_by");
        loadReads++;
        return Object.entries(loads).map(([model, n]) => ({ provider: "abcllm", model, n }));
      } });
    } }) }),
    insert: () => ({ values: (value: Record<string, unknown>) => {
      inserted.push(value);
      return { onConflictDoNothing: () => ({ returning: async () => [{ id: inserted.length, ...value }] }), then: (resolve: (v: unknown) => void) => resolve(undefined) };
    } }),
  };
  return { tx: tx as unknown as ProductTransaction, inserted, loadReads: () => loadReads };
}
const proposed = { candidateId: 41, generationKey: "g", inputHash: "h", trigger: "ai1_approved" } as never;
const second = { candidateId: 42, generationKey: "g2", inputHash: "h2", trigger: "ai1_approved" } as never;
/** 고르기 힌트: 받은 후보 중 첫째(장비 사정은 여기서 보지 않는다) */
const firstCandidate = () => mocks.choose.mockImplementation(async (_config, candidates: readonly { memberId: string; provider: string; identity: string }[]) =>
  candidates[0] ? { ...candidates[0], poolSelection: { task: "second-review", slot: 1, configRevision: 3, memberId: candidates[0].memberId, position: 1,
    policyEpoch: 1, policyRevision: 1, policyHash: "x" } } : null);

describe("2차 「동시에」 표 배정", () => {
  it("줄에 설 수 있는 구성원을 돌림 차례로 고른다(지금 빈 칸이 없어도 표를 만든다) — 칸 수를 적지 않았으면 표 수를 읽지 않는다", async () => {
    firstCandidate();
    const { tx, inserted, loadReads } = fakeTx();
    const rows = await insertSecondReviewWorkloadRows(tx, [proposed]);
    expect(mocks.choose.mock.calls[0][2]).toMatchObject({ executor: tx, queueWhenFull: true, rotate: true });
    expect(rows).toHaveLength(1);
    expect(inserted).toEqual([expect.objectContaining({ candidateId: 41, provider: "abcllm", model: "qwen-next" }),
      expect.objectContaining({ taskSlot: 1, configRevision: 3, memberId: MEMBER })]);
    expect(loadReads()).toBe(0);
  });

  it.each(["draining", "disabled", "policy_changed"] as const)("용량 장부가 열려 있지 않으면(%s) 이 틱에는 배정만 건너뛴다 — 유지보수 틱을 던지지 않는다", async reason => {
    mocks.choose.mockRejectedValue(new ModelCapacityDeferredError(reason));
    const { tx, inserted } = fakeTx();
    await expect(insertSecondReviewWorkloadRows(tx, [proposed, second])).resolves.toEqual([]);
    expect(inserted).toEqual([]);
    expect(mocks.choose).toHaveBeenCalledTimes(1);   // 첫 미룸에서 멈춘다 — 같은 답을 후보마다 다시 묻지 않는다
  });

  it("그 밖의 미룸(배정 표를 못 읽음 등)은 예전처럼 던진다", async () => {
    mocks.choose.mockRejectedValue(new ModelCapacityDeferredError("assignments_unavailable"));
    const { tx } = fakeTx();
    await expect(insertSecondReviewWorkloadRows(tx, [proposed])).rejects.toMatchObject({ reason: "assignments_unavailable" });
  });
});

describe("2차 「동시에」 — 칸 수와 예비(1·2차도 새 동작)", () => {
  it("칸 수 합에 닿은 구성원(끝나지 않은 표 = 칸 수)은 고르기 후보에서 빠지고, 남은 구성원이 받는다", async () => {
    configure([poolMember(MEMBER, "qwen-next", 1, 2), poolMember(OTHER, "deepseek", 2, 1)]);
    firstCandidate();
    const { tx, inserted } = fakeTx({ "qwen-next": 2 });
    await insertSecondReviewWorkloadRows(tx, [proposed]);
    expect(mocks.choose.mock.calls[0][1].map((row: { memberId: string }) => row.memberId)).toEqual([OTHER]);
    expect(inserted[0]).toMatchObject({ model: "deepseek" });
  });

  it("이 틱에 배정한 표도 바로 센다 — 칸 수 1 인 구성원은 한 표만 받고, 다음 후보는 예비(저장된 1순위, 배정 행 없는 첫 표)가 받는다", async () => {
    configure([poolMember(MEMBER, "qwen-next", 1, 1)], true);
    firstCandidate();
    const { tx, inserted } = fakeTx();
    const rows = await insertSecondReviewWorkloadRows(tx, [proposed, second]);
    expect(rows.map(row => row.model)).toEqual(["qwen-next", "legacy-voter"]);
    // 예비 표에는 배정 행을 쓰지 않는다 — 배정 행 없는 첫 표는 저장된 첫 순위만 회원이다(표 수는 후보마다 하나 그대로)
    expect(inserted.filter(row => "memberId" in row)).toHaveLength(1);
    expect(inserted.filter(row => row.candidateId === 42)).toEqual([expect.objectContaining({ provider: "abcllm", model: "legacy-voter" })]);
  });

  it("예비가 꺼져 있으면 칸이 찬 동안 표를 만들지 않는다(다음 틱에 다시) — 던지지 않는다", async () => {
    configure([poolMember(MEMBER, "qwen-next", 1, 1)], false);
    firstCandidate();
    const { tx, inserted } = fakeTx({ "qwen-next": 1 });
    await expect(insertSecondReviewWorkloadRows(tx, [proposed])).resolves.toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("예비가 칸이 찬 구성원과 같은 엔진(같은 장부 이름)이면 예비도 받지 않는다 — 같은 엔진 두 자리는 칸 수를 더해 함께 찬다", async () => {
    // 저장된 1순위가 구성원과 같은 모델(legacy-voter) — 두 자리(칸 1+1)로 넣었다
    configure([poolMember(MEMBER, "legacy-voter", 1, 1), poolMember(OTHER, "legacy-voter", 2, 1)], true);
    firstCandidate();
    const busy = fakeTx({ "legacy-voter": 1 });
    expect((await insertSecondReviewWorkloadRows(busy.tx, [proposed])).map(row => row.model)).toEqual(["legacy-voter"]);   // 합 2 중 1 — 아직 받는다
    mocks.choose.mockClear();
    const full = fakeTx({ "legacy-voter": 2 });
    await expect(insertSecondReviewWorkloadRows(full.tx, [proposed])).resolves.toEqual([]);
    expect(mocks.choose.mock.calls[0][1]).toEqual([]);
    expect(full.inserted).toEqual([]);
  });
});

describe("2차 「동시에」 — 구성원을 모두 쓸 수 없을 때의 예비", () => {
  it("예비를 켰으면 표를 낼 수 있다(관문을 사람에게 넘기지 않는다) — 예비가 꺼졌으면 예전처럼 없다", () => {
    membersUnusable = true;
    configure([poolMember(MEMBER, "qwen-next", 1, null)], true);
    expect(secondReviewPoolReserve()).toEqual({ provider: "abcllm", model: "legacy-voter" });
    expect(secondReviewPoolHasEligibleMember()).toBe(true);
    configure([poolMember(MEMBER, "qwen-next", 1, null)], false);
    expect(secondReviewPoolReserve()).toBeNull();
    expect(secondReviewPoolHasEligibleMember()).toBe(false);
  });

  it("쓸 수 있는 구성원이 없으면 예비 순위가 표를 받는다", async () => {
    membersUnusable = true;
    configure([poolMember(MEMBER, "qwen-next", 1, null)], true);
    firstCandidate();
    const { tx } = fakeTx();
    expect((await insertSecondReviewWorkloadRows(tx, [proposed])).map(row => row.model)).toEqual(["legacy-voter"]);
  });
});
