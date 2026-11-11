import { afterEach, describe, expect, it, vi } from "vitest";
const selector = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("@/lib/llm/ai-task-workload-selector", () => ({ chooseTaskWorkloadMember: selector.choose }));
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import type { TextTaskRankBinding } from "@/lib/llm/ai-task-rank-scope";
import { resolveTextTaskRanks, TextTaskRanks, type TextRankResolution } from "@/lib/llm/ai-task-resolver";
import type { AiTaskExecutionConfig } from "@/lib/llm/ai-task-execution-config";
import { recordProviderRateLimit, resetProviderRateLimitsForTest } from "@/lib/llm/provider-rate-limit";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * 공급자 429 뒤 쉬는 순위·구성원(2026-11-11, provider-rate-limit.ts) — 순위 대체는 그 순위를 부르지 않고 다음 순위로 넘기며, 작업 분산은 쉬는 구성원을
 * 고르지 않는다(고른 뒤의 미룸은 다른 구성원에 넘기지 않으므로 쉬는 구성원이 뽑히면 분산 전체가 멈춘다). 모두 쉬면 포화처럼 미룬다.
 */
const SECOND = "0b0c0d0e-0000-4000-8000-0000000000aa", SECOND_BASE = "http://second.test:8000/v1", EXAONE = "k-exaone_v2.5";
afterEach(() => { setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); resetProviderRateLimitsForTest(); selector.choose.mockReset(); });

describe("순위 대체", () => {
  const twoRanks = () => {
    setServingContractSnapshotForTest([textContract("product-tagline-ko", "gpt-oss-120b"),
      textContract("product-tagline-ko", EXAONE, { baseUrl: SECOND_BASE })]);
    setAiTaskModelsForTest([textRankRow("product-tagline-ko", "gpt-oss-120b"),
      textRankRow("product-tagline-ko", EXAONE, { rank: 2, connectionId: SECOND, baseUrl: SECOND_BASE, label: "LG EXAONE" })]);
    return new TextTaskRanks(resolveTextTaskRanks("product-tagline-ko"));
  };
  it("쉬는 순위는 부르지 않고 같은 일을 다음 순위로 넘긴다 — 다른 경로의 쉼은 상관없다", async () => {
    recordProviderRateLimit({ routeId: "product-tagline-ko", provider: "abcllm", model: "gpt-oss-120b" }, 60_000);
    recordProviderRateLimit({ routeId: "reason-translate", provider: "abcllm", model: EXAONE }, 60_000);
    const ranks = twoRanks(), called: number[] = [];
    expect(await ranks.run(async binding => { called.push(binding.rank); return binding.rank; })).toMatchObject({ kind: "served", value: 2 });
    expect(called).toEqual([2]);
    expect(ranks.summary()).toMatchObject({ "served.2": 1, "unusable.1.rate_limited": 1 });
  });
  it("모든 순위가 쉬면 일을 부르지 않고 포화로 본다(잡은 model_capacity 로 미룬다, degraded 아님)", async () => {
    for (const model of ["gpt-oss-120b", EXAONE]) recordProviderRateLimit({ routeId: "product-tagline-ko", provider: "abcllm", model }, 60_000);
    const ranks = twoRanks(), work = vi.fn();
    expect(await ranks.run(work)).toEqual({ kind: "unusable" });
    expect(work).not.toHaveBeenCalled();
    expect(ranks.saturated()).toBe(true);
    expect(ranks.degraded().detail).toContain("429");
  });
});

describe("작업 분산", () => {
  const binding = (memberId: string, model: string, deviceId: string): TextTaskRankBinding => Object.freeze({ routeId: "reason-translate", rank: 0, memberId,
    connectionId: `${memberId}-connection`, connectionLabel: model, identity: model, engineModel: model, provider: "abcllm", bearer: null, deviceId });
  const gemma = binding("member-gemma", "m1-gemma", "m1-qwen"), exaone = binding("member-exaone", EXAONE, "exaone-api");
  const resolution = { routeId: "reason-translate", status: "ok",
    candidates: [gemma, exaone].map(row => ({ rank: { rank: 0 }, binding: row, unusable: null, memberId: row.memberId })) } as unknown as TextRankResolution;
  const execution = { task: "reason-translate", slot: 1, mode: "workload_pool", revision: 3, updatedAt: null, members: [] } as unknown as AiTaskExecutionConfig;
  it("쉬는 구성원은 고르기 후보에서 빼고, 남은 구성원이 일을 받는다", async () => {
    recordProviderRateLimit({ routeId: "reason-translate", provider: "abcllm", model: EXAONE }, 60_000);
    selector.choose.mockImplementation(async (_config, candidates: readonly TextTaskRankBinding[]) => candidates[0] ?? null);
    const ranks = new TextTaskRanks(resolution, execution);
    expect(await ranks.run(async chosen => chosen.identity)).toMatchObject({ kind: "served", value: "m1-gemma" });
    expect(selector.choose.mock.calls[0][1].map((row: TextTaskRankBinding) => row.memberId)).toEqual(["member-gemma"]);
  });
  it("모든 구성원이 쉬면 고르지 않고 포화로 본다", async () => {
    for (const model of ["m1-gemma", EXAONE]) recordProviderRateLimit({ routeId: "reason-translate", provider: "abcllm", model }, 60_000);
    const ranks = new TextTaskRanks(resolution, execution), work = vi.fn();
    expect(await ranks.run(work)).toEqual({ kind: "unusable" });
    expect(selector.choose).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
    expect(ranks.saturated()).toBe(true);
  });
});
