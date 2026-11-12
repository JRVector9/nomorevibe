import { afterEach, describe, expect, it, vi } from "vitest";
const selector = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: selector.choose }));
import { AI_TASKS } from "@/lib/llm/ai-tasks";
import { aiTaskExecutionInputSchema, aiTaskPoolCappedLanes, aiTaskPoolFeatures, aiTaskSupportsPool,
  type AiTaskExecutionConfig, type AiTaskPoolMember } from "@/lib/llm/ai-task-execution-config";
import type { TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { TextTaskRanks, type TextRankResolution } from "@/lib/llm/ai-task-resolver";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { resetProviderRateLimitsForTest } from "@/lib/llm/provider-rate-limit";

/**
 * 「동시에」(workload_pool, 2026-11-12 운영 콘솔 개편 2b) — 묶은 모델이 함께 일한다.
 * - 칸 수를 적은 묶음은 칸 수의 합만큼 줄을 돌리고, 구성원마다 자기 칸 수를 넘겨 받지 않는다(빈 칸이 있는 구성원에게만 나눠 보낸다).
 * - 한 구성원이 서면(그 구성원만의 미룸) 그 일만 넘기고 다음 일은 남은 구성원이 받는다. 모두 서면 예비 순위(설정에 있을 때만).
 * - 설정이 없으면(순위대로, 칸 수 없는 옛 묶음) 지금 동작 그대로다.
 */
afterEach(() => { selector.choose.mockReset(); resetProviderRateLimitsForTest(); });

const ROUTE = "product-translate" as const;
const binding = (memberId: string | null, model: string, rank = 0): TextTaskRankBinding => Object.freeze({ routeId: ROUTE, rank,
  ...(memberId ? { memberId, configRevision: 4 } : {}), connectionId: `${model}-connection`, connectionLabel: model, identity: model, engineModel: model,
  provider: "abcllm" as const, bearer: null, deviceId: `${model}-device` });
const candidate = (row: TextTaskRankBinding) => ({ rank: { rank: row.rank, model: row.identity, connection: { label: row.connectionLabel } },
  binding: row, unusable: null, ...(row.memberId ? { memberId: row.memberId } : {}) });
const resolution = (rows: TextTaskRankBinding[]) => ({ routeId: ROUTE, status: "ok", candidates: rows.map(candidate) }) as unknown as TextRankResolution;
const member = (memberId: string, model: string, position: number, maxSlots: number | null) =>
  ({ memberId, position, connectionId: `${model}-connection`, model, maxSlots }) as unknown as AiTaskPoolMember;
const config = (members: AiTaskPoolMember[], reserveRanks = false): AiTaskExecutionConfig =>
  ({ task: ROUTE, slot: 1, mode: "workload_pool", revision: 4, updatedAt: null, members, reserveRanks }) as AiTaskExecutionConfig;

const qwen = binding("member-qwen", "gpu3090-qwen"), m1 = binding("member-m1", "m1max");
/** 고르기 힌트: 받은 후보 중 첫째(실제 고르기는 장비 빈 칸·압력 — 여기서는 칸 수 거르기만 본다) */
const firstCandidate = () => selector.choose.mockImplementation(async (_config, candidates: readonly TextTaskRankBinding[]) => candidates[0] ?? null);
/** 끝을 밖에서 정하는 일 — 여러 줄이 함께 일하는 동안의 칸 셈을 본다 */
function gate() {
  const waiting: (() => void)[] = [];
  return { work: (seen: string[]) => async (chosen: TextTaskRankBinding) => { seen.push(chosen.identity); await new Promise<void>(resolve => waiting.push(resolve)); return chosen.identity; },
    release: () => waiting.splice(0).forEach(resolve => resolve()) };
}

describe("지원 표(aiTaskSupportsPool) — 화면·저장·실행이 이것만 묻는다", () => {
  it("밀린 text 단계 여섯은 칸 수·예비까지, 카테고리 분류·1차·2차(투표자 1)·검색어 번역은 예전 분산만, 나머지는 지원하지 않는다", () => {
    const full = ["product-translate", "reason-translate", "product-search-verify", "product-search-profile", "product-tagline-ko", "crawl-tagline"];
    const distribute = ["search-query-translate", "first-review", "second-review", "publish-classify"];
    for (const task of AI_TASKS) {
      const expected = full.includes(task.id) || distribute.includes(task.id);
      expect([task.id, aiTaskSupportsPool(task.id)]).toEqual([task.id, expected]);
      expect([task.id, aiTaskPoolFeatures(task.id)]).toEqual([task.id, { slotCaps: full.includes(task.id), reserve: full.includes(task.id) }]);
    }
    // 2차 투표자 2·3 은 같은 후보를 각자 판정하는 뜻이라 건드리지 않는다
    expect([2, 3].map(slot => aiTaskSupportsPool("second-review", slot))).toEqual([false, false]);
    expect(aiTaskSupportsPool("no-such-task")).toBe(false);
  });

  it("저장 검증: 칸 수·예비는 따르는 작업에만, 칸 수는 모두 적거나 모두 비우고, 순위대로에는 싣지 않는다", () => {
    const input = (task: string, members: object[], extra: object = {}) => aiTaskExecutionInputSchema.safeParse({ task, slot: 1, expectedRevision: null,
      mode: "workload_pool", members, ...extra });
    const issues = (result: ReturnType<typeof input>) => result.success ? [] : result.error.issues.map(issue => issue.message);
    const a = { connectionId: "0b0c0d0e-0000-4000-8000-0000000000a1", model: "gpu3090-qwen" }, b = { connectionId: "0b0c0d0e-0000-4000-8000-0000000000b1", model: "m1max" };
    expect(input("product-translate", [{ ...a, maxSlots: 5 }, { ...b, maxSlots: 2 }], { reserveRanks: true }).success).toBe(true);
    expect(input("product-translate", [a, b]).success).toBe(true);
    expect(issues(input("product-translate", [{ ...a, maxSlots: 5 }, b]))).toEqual(["ai_task_pool_slot_caps_partial"]);
    expect(issues(input("product-translate", [{ ...a, maxSlots: 9 }]))).not.toEqual([]);
    expect(issues(input("publish-classify", [{ ...a, maxSlots: 2 }]))).toEqual(["ai_task_pool_slot_caps_unsupported"]);
    expect(issues(input("first-review", [a], { reserveRanks: true }))).toEqual(["ai_task_pool_reserve_unsupported"]);
    expect(issues(input("audit-review", [a]))).toEqual(["ai_task_pool_task_unsupported"]);
    expect(issues(aiTaskExecutionInputSchema.safeParse({ task: "product-translate", slot: 1, expectedRevision: 3, mode: "fallback", members: [], reserveRanks: true })))
      .toEqual(["ai_task_fallback_uses_existing_ranks"]);
  });

  it("함께 도는 줄 수 = 칸 수의 합(16에서 자름) — 칸 수가 없거나 따르지 않는 작업이면 null(단계 동시 수 그대로)", () => {
    const pool = (task: string, maxSlots: (number | null)[]) => ({ task, slot: 1, mode: "workload_pool" as const, members: maxSlots.map(value => ({ maxSlots: value })) });
    expect(aiTaskPoolCappedLanes(pool("product-translate", [5, 2]))).toBe(7);
    expect(aiTaskPoolCappedLanes(pool("product-translate", [8, 8, 8]))).toBe(16);
    expect(aiTaskPoolCappedLanes(pool("product-translate", [null, null]))).toBeNull();
    expect(aiTaskPoolCappedLanes(pool("publish-classify", [3]))).toBeNull();
    expect(aiTaskPoolCappedLanes({ ...pool("product-translate", [3]), mode: "fallback" })).toBeNull();
  });
});

describe("기본 동작(설정 없음·칸 수 없는 묶음)은 그대로다", () => {
  it("순위대로: 줄 수는 단계 동시 수, 1순위가 서면 같은 일을 2순위로 — 그 미룸은 잡 밖으로 나가지 않는다", async () => {
    const ranks = new TextTaskRanks(resolution([binding(null, "first", 1), binding(null, "second", 2)]));
    expect(ranks.lanes(1)).toBe(1);
    expect(ranks.lanes(3)).toBe(3);
    const seen: string[] = [];
    const result = await ranks.run(async chosen => {
      seen.push(chosen.identity);
      if (chosen.identity === "first") throw new ModelCapacityDeferredError("capacity");
      return chosen.identity;
    });
    expect(result).toMatchObject({ kind: "served", value: "second" });
    expect(seen).toEqual(["first", "second"]);
    expect(selector.choose).not.toHaveBeenCalled();
    expect(ranks.summary()).toEqual({ ranks: 2, "served.2": 1, "unusable.1.capacity": 1 });
    // 순위대로에서 일만의 미룸은 예전처럼 work 범위만 넘긴다(구성원 미룸이란 없다)
    expect(ranks.skipsWork(new ModelCapacityDeferredError("work_busy"))).toBe(true);
    expect(ranks.skipsWork(new ModelCapacityDeferredError("capacity"))).toBe(false);
  });

  it("칸 수 없는 옛 묶음: 줄 수는 단계 동시 수, 빈 칸이 없으면 줄에 설 구성원을 고르게 하고 그것도 없으면 capacity 로 틱을 미룬다(구성원 미룸이 아니다)", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, null), member("member-m1", "m1max", 2, null)]));
    expect(ranks.lanes(1)).toBe(1);
    selector.choose.mockResolvedValue(null);
    const error = await ranks.run(async () => "never").catch(caught => caught);
    expect(error).toBeInstanceOf(ModelCapacityDeferredError);
    expect(error.reason).toBe("capacity");
    expect(ranks.skipsWork(error)).toBe(false);
    // 2026-11-12: 순위대로처럼 장부 줄에 선다 — 고르기에 「줄에 설 구성원」을 묻는다(빈 칸만 고르면 같은 장비의 대기 행에 계속 밀린다)
    expect(selector.choose.mock.calls[0][2]).toMatchObject({ queueWhenFull: true });
    expect(ranks.summary()).toEqual({ ranks: 0, pool_members: 2, pool_revision: 4 });
  });
});

describe("동시에 — 칸 수", () => {
  it("칸 수의 합만큼 함께 일하고, 구성원마다 자기 칸 수를 넘겨 받지 않는다(빈 칸이 있는 구성원에게만 고르기 후보를 준다)", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, 2), member("member-m1", "m1max", 2, 1)]));
    expect(ranks.lanes(1)).toBe(3);
    firstCandidate();
    const { work, release } = gate(), seen: string[] = [];
    const running = [ranks.run(work(seen)), ranks.run(work(seen)), ranks.run(work(seen))];
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen.sort()).toEqual(["gpu3090-qwen", "gpu3090-qwen", "m1max"]);
    // 셋이 함께 골랐다 — 셋째 줄은 고르는 동안 qwen 의 칸이 찼으니 다시 골랐고, 그때는 칸이 찬 qwen 이 후보에서 빠졌다
    expect(selector.choose).toHaveBeenCalledTimes(4);
    expect(selector.choose.mock.calls[3][1].map((row: TextTaskRankBinding) => row.memberId)).toEqual(["member-m1"]);
    // 넷째 줄: 모든 구성원이 자기 칸 수만큼 일하는 중 — 이 줄만 조용히 끝난다(고르지도 부르지도 않는다)
    expect(await ranks.run(work(seen))).toEqual({ kind: "idle" });
    expect(selector.choose).toHaveBeenCalledTimes(4);
    release();
    expect((await Promise.all(running)).map(row => row.kind)).toEqual(["served", "served", "served"]);
    // 칸이 비면 다시 받는다
    const again = ranks.run(work(seen));
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    release();
    expect(await again).toMatchObject({ kind: "served" });
    expect(ranks.summary()).toEqual({ ranks: 0, pool_members: 2, pool_revision: 4, pool_lanes: 3,
      "member_served.member-qwen": 3, "member_served.member-m1": 1 });
  });

  it("장비에 빈 칸이 없다는 힌트(고르기가 빔)면 이 줄만 끝내고 포화로 센다 — 다른 줄은 계속한다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, 1), member("member-m1", "m1max", 2, 1)]));
    selector.choose.mockResolvedValueOnce(null);
    expect(await ranks.run(async () => "never")).toEqual({ kind: "idle" });
    expect(ranks.poolIdle()).toBe(true);
    expect(ranks.saturated()).toBe(true);
    expect(ranks.exhausted).toBe(false);
    firstCandidate();
    expect(await ranks.run(async chosen => chosen.identity)).toMatchObject({ kind: "served", value: "gpu3090-qwen" });
  });

  it("한 구성원이 서면(그 구성원만의 미룸) 그 일만 넘기고 — 같은 일을 다른 구성원에 넘기지 않는다 — 다음 일은 남은 구성원이 받는다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, 3), member("member-m1", "m1max", 2, 2)]));
    firstCandidate();
    const calls: string[] = [];
    const error = await ranks.run(async chosen => { calls.push(chosen.identity); throw new ModelCapacityDeferredError("model_quota"); }).catch(caught => caught);
    expect(calls).toEqual(["gpu3090-qwen"]);
    expect(ranks.skipsWork(error)).toBe(true);
    // 다른 오류 객체(같은 까닭이라도 구성원이 던진 것이 아님)는 넘기지 않는다
    expect(ranks.skipsWork(new ModelCapacityDeferredError("model_quota"))).toBe(false);
    expect(await ranks.run(async chosen => { calls.push(chosen.identity); return chosen.identity; })).toMatchObject({ kind: "served", value: "m1max" });
    expect(selector.choose.mock.calls[1][1].map((row: TextTaskRankBinding) => row.memberId)).toEqual(["member-m1"]);
    expect(ranks.usable().map(row => row.identity)).toEqual(["m1max"]);
    expect(ranks.summary()).toMatchObject({ "member_unusable.member-qwen.model_quota": 1, "member_served.member-m1": 1 });
  });

  it("모든 구성원이 서고 예비가 없으면 일을 부르지 않고 다 쓴 것으로 본다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen]), config([member("member-qwen", "gpu3090-qwen", 1, 2)]));
    ranks.pause(qwen, "engine_failed");
    const work = vi.fn();
    expect(await ranks.run(work)).toEqual({ kind: "unusable" });
    expect(work).not.toHaveBeenCalled();
    expect(ranks.exhausted).toBe(true);
  });
});

describe("동시에 — 예비 순위", () => {
  const reserve = () => resolution([binding(null, "supa", 1), binding(null, "exaone", 2)]);
  it("묶음이 모두 서면 예비 순위를 순위 차례로 쓴다(예비 1순위가 서면 같은 일을 예비 2순위로) — 순위처럼 served.<순위> 로 센다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, 2), member("member-m1", "m1max", 2, 1)], true), reserve());
    ranks.lanes(1);
    ranks.pause(qwen, "engine_network"); ranks.pause(m1, "rate_limited");
    const seen: string[] = [];
    const result = await ranks.run(async chosen => {
      seen.push(chosen.identity);
      if (chosen.identity === "supa") throw new ModelCapacityDeferredError("capacity");
      return chosen.identity;
    });
    expect(result).toMatchObject({ kind: "served", value: "exaone" });
    expect(seen).toEqual(["supa", "exaone"]);
    expect(selector.choose).not.toHaveBeenCalled();
    expect(ranks.summary()).toMatchObject({ ranks: 2, "served.2": 1, "unusable.1.capacity": 1, pool_members: 2 });
    expect(ranks.degraded().detail).toContain("예비 1순위");
  });

  it("예비는 단계 동시 수(lanes 의 base)만큼만 함께 부른다 — 넘는 줄은 idle", async () => {
    const ranks = new TextTaskRanks(resolution([qwen]), config([member("member-qwen", "gpu3090-qwen", 1, 4)], true), reserve());
    expect(ranks.lanes(1)).toBe(4);
    ranks.pause(qwen, "engine_failed");
    const { work, release } = gate(), seen: string[] = [];
    const first = ranks.run(work(seen));
    await vi.waitFor(() => expect(seen).toEqual(["supa"]));
    expect(await ranks.run(work(seen))).toEqual({ kind: "idle" });
    release();
    expect(await first).toMatchObject({ kind: "served", value: "supa" });
  });

  it("구성원이 살아 있으면 예비를 부르지 않는다 · 예비까지 모두 서면 다 쓴 것", async () => {
    const ranks = new TextTaskRanks(resolution([qwen]), config([member("member-qwen", "gpu3090-qwen", 1, 1)], true), reserve());
    firstCandidate();
    expect(await ranks.run(async chosen => chosen.identity)).toMatchObject({ kind: "served", value: "gpu3090-qwen" });
    ranks.pause(qwen, "engine_failed");
    for (const row of ranks.usable()) ranks.pause(row, "engine_failed");
    expect(await ranks.run(async () => "never")).toEqual({ kind: "unusable" });
    expect(ranks.exhausted).toBe(true);
  });
});

/**
 * 2026-11-12 「동시에」 전 단계 검토(공개 번역을 동시에로 바꾸니 멈춘다는 소유자 보고) — 고르기가 비거나 이어받을 구성원이 쉴 때의 길.
 * 예전: 칸 수 없는 묶음은 고르기가 비면 capacity 로 틱 전체를 접고(예비 순위를 부르지 않음), 줄에 세워 둔 구성원이 쉬면 그 일 하나 때문에 틱 전체를 접었다.
 */
describe("동시에 — 빈 칸이 없을 때·쉬는 구성원의 지난 일", () => {
  const reserve = () => resolution([binding(null, "supa", 1), binding(null, "exaone", 2)]);

  it("예비가 있으면 묶음의 장비에 빈 칸이 없을 때 예비 순위가 받는다(칸 수 없는 묶음) — 고르기는 줄에 설 구성원을 찾지 않는다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, null), member("member-m1", "m1max", 2, null)], true), reserve());
    ranks.lanes(1);
    selector.choose.mockResolvedValue(null);
    expect(await ranks.run(async chosen => chosen.identity)).toMatchObject({ kind: "served", value: "supa" });
    expect(selector.choose.mock.calls[0][2]).toMatchObject({ queueWhenFull: false });
    expect(ranks.summary()).toMatchObject({ "served.1": 1 });
  });

  it("칸 수를 적은 묶음도 빈 칸이 없으면 예비가 받고, 예비까지 모두 서면 다 쓴 것이 아니라 이 줄만 끝낸다(idle) — 구성원은 살아 있다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, 2), member("member-m1", "m1max", 2, 1)], true), reserve());
    ranks.lanes(1);
    selector.choose.mockResolvedValue(null);
    const seen: string[] = [];
    const result = await ranks.run(async chosen => { seen.push(chosen.identity); throw new ModelCapacityDeferredError("capacity"); });
    expect(seen).toEqual(["supa", "exaone"]);
    expect(result).toEqual({ kind: "idle" });
    expect(ranks.exhausted).toBe(false);
    expect(ranks.poolIdle()).toBe(true);
    // 구성원은 쉬지 않는다 — 다음 일은 다시 구성원을 고른다
    firstCandidate();
    expect(await ranks.run(async chosen => chosen.identity)).toMatchObject({ kind: "served", value: "gpu3090-qwen" });
  });

  it("줄에 세워 둔 구성원이 이 틱에 쉬면: 같은 이름의 (다른 연결) 예비 순위가 이어받는다", async () => {
    // 같은 장부 이름을 다른 연결(같은 주소의 연결 두 줄)로 묶은 예비 순위 — 같은 연결이면 함께 쉰다(아래 「같은 엔진」)
    const shared = Object.freeze({ ...binding(null, "gpu3090-qwen", 1), connectionId: "another-connection" });
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, null), member("member-m1", "m1max", 2, null)], true),
      resolution([shared]));
    ranks.lanes(1);
    ranks.pause(qwen, "capacity");
    const seen: string[] = [];
    expect(await ranks.run(async chosen => { seen.push(`${chosen.rank}:${chosen.identity}`); return "ok"; }, { prefer: "gpu3090-qwen" }))
      .toMatchObject({ kind: "served", value: "ok" });
    expect(seen).toEqual(["1:gpu3090-qwen"]);
    expect(selector.choose).not.toHaveBeenCalled();
  });

  it("줄에 세워 둔 구성원이 쉬고 예비가 없으면: 그 일만 넘긴다(skipsWork) — 다른 구성원에 넘기지도, 틱 전체를 접지도 않는다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, null), member("member-m1", "m1max", 2, null)]));
    ranks.lanes(2);
    ranks.pause(qwen, "capacity");
    const work = vi.fn(async () => "never");
    const error = await ranks.run(work, { prefer: "gpu3090-qwen" }).catch(caught => caught);
    expect(error).toBeInstanceOf(ModelCapacityDeferredError);
    expect(ranks.skipsWork(error)).toBe(true);
    expect(work).not.toHaveBeenCalled();
    expect(selector.choose).not.toHaveBeenCalled();
    // 다음 일(이어받을 것 없음)은 남은 구성원이 받는다
    firstCandidate();
    expect(await ranks.run(async chosen => chosen.identity)).toMatchObject({ kind: "served", value: "m1max" });
  });

  it("고르기가 이어받을 구성원을 받지 않으면(연결이 그 사이 닫힘 등) 그 일만 넘긴다", async () => {
    const ranks = new TextTaskRanks(resolution([qwen, m1]), config([member("member-qwen", "gpu3090-qwen", 1, null), member("member-m1", "m1max", 2, null)]));
    selector.choose.mockResolvedValue(null);
    const error = await ranks.run(async () => "never", { prefer: "gpu3090-qwen" }).catch(caught => caught);
    expect(ranks.skipsWork(error)).toBe(true);
    expect(selector.choose.mock.calls[0][2]).toMatchObject({ preferIdentity: "gpu3090-qwen" });
  });
});

describe("동시에 — 같은 엔진을 두 자리에 넣은 구성원(운영 사례: m1-gemma 두 번)", () => {
  const gemmaA = binding("member-gemma-a", "m1-gemma"), gemmaB = binding("member-gemma-b", "m1-gemma"), gpt = binding("member-gpt", "gpt-oss-120b");
  const pool = () => new TextTaskRanks(resolution([gpt, gemmaA, gemmaB]),
    config([member("member-gpt", "gpt-oss-120b", 1, null), member("member-gemma-a", "m1-gemma", 2, null), member("member-gemma-b", "m1-gemma", 3, null)]));

  it("한 자리가 그 모델만의 까닭(포화)으로 서면 같은 엔진의 다른 자리도 함께 쉰다 — 쉬지 않은 쪽이 같은 미룸을 되풀이하지 않는다", async () => {
    const ranks = pool();
    selector.choose.mockImplementation(async (_config, candidates: readonly TextTaskRankBinding[]) =>
      candidates.find(row => row.identity === "m1-gemma") ?? candidates[0] ?? null);
    const error = await ranks.run(async () => { throw new ModelCapacityDeferredError("capacity"); }).catch(caught => caught);
    expect(ranks.skipsWork(error)).toBe(true);
    expect(ranks.usable().map(row => row.memberId)).toEqual(["member-gpt"]);
    expect(await ranks.run(async chosen => chosen.identity)).toMatchObject({ kind: "served", value: "gpt-oss-120b" });
    expect(selector.choose.mock.calls[1][1].map((row: TextTaskRankBinding) => row.memberId)).toEqual(["member-gpt"]);
    expect(ranks.summary()).toMatchObject({ "member_unusable.member-gemma-a.capacity": 1, "member_unusable.member-gemma-b.capacity": 1 });
  });

  it("엔진이 내려갔다는 증명(engine-down)도 같은 엔진의 자리를 함께 쉬게 한다", () => {
    const ranks = pool();
    for (let index = 0; index < 5 && !ranks.failed(gemmaA, "network"); index++) { /* 연결 거절이 잇따른다 */ }
    expect(ranks.usable().map(row => row.memberId)).toEqual(["member-gpt"]);
  });

  it("같은 연결·같은 이름의 예비 순위도 함께 쉰다(운영 사례: gpt-oss 가 구성원이자 예비 1·2순위) — 엔진이 내려간 모델을 예비로 다시 부르지 않는다", async () => {
    const ranks = new TextTaskRanks(resolution([gpt, gemmaA]),
      config([member("member-gpt", "gpt-oss-120b", 1, null), member("member-gemma-a", "m1-gemma", 2, null)], true),
      resolution([binding(null, "gpt-oss-120b", 1), binding(null, "gpt-oss-120b", 2), binding(null, "m1-gemma", 3)]));
    ranks.lanes(1);
    ranks.pause(gpt, "engine_network");
    ranks.pause(gemmaA, "capacity");
    const seen: string[] = [];
    expect(await ranks.run(async chosen => { seen.push(`${chosen.rank}:${chosen.identity}`); return "ok"; })).toEqual({ kind: "unusable" });
    expect(seen).toEqual([]);   // 예비 1·2(gpt-oss)·3(m1-gemma) 모두 구성원과 같은 엔진이라 함께 쉰다
    expect(ranks.saturated()).toBe(true);
  });

  it("순위대로의 같은 모델 반복 순위는 그대로다(한 순위가 서도 다른 순위는 쉬지 않는다)", () => {
    const ranks = new TextTaskRanks(resolution([binding(null, "gpt-oss-120b", 1), binding(null, "gpt-oss-120b", 2)]));
    ranks.pause({ rank: 1 }, "capacity");
    expect(ranks.usable().map(row => row.rank)).toEqual([2]);
  });
});
