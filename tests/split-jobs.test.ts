import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";

/**
 * 합성 잡 분해(2026-10-31, PR 3a-C) — 한 틱에 두 장비(gpu3090·M3)를 차례로 부르던 세 잡을 단계마다 자기 잡·자기 줄로 나눴다.
 *   human-deepseek-review → held-qwen-retry · human-deepseek-review · split-confirm
 *   second-review          → second-review · split-tiebreak
 *   product-audit          → product-audit · audit-qwen · audit-second-opinion
 * 여기서는 (1) 새 잡이 자기 단계 함수만 그 lease·마감으로 부르고 done 을 어떻게 내는지, (2) M3 DeepSeek 자리(deepseek-slot.ts)가 호출을 하나로 줄 세우는지,
 * (3) 줄 수준에서 한 잡의 느림·실패가 다른 잡의 틱을 미루지 않는지(가짜 시계, 3a-A 의 worker-runtime 시험과 같은 모양)를 본다.
 * 단계 함수 자체는 각자의 시험(held-qwen-retry·gate-split-tiebreak·audit-second-opinion-auto 통합 시험)이 DB 로 본다.
 */
const mocks = vi.hoisted(() => ({ settings: vi.fn(), held: vi.fn(), confirm: vi.fn(), tiebreak: vi.fn(), opinions: vi.fn() }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/crawl/held-qwen-retry", () => ({ runHeldQwenRetry: mocks.held }));
vi.mock("@/lib/crawl/gate-split-confirm", () => ({ runSplitTiebreakConfirmations: mocks.confirm }));
vi.mock("@/lib/crawl/gate-split-tiebreak", () => ({ runGateSplitTiebreak: mocks.tiebreak }));
vi.mock("@/lib/crawl/audit-second-opinion-auto", () => ({ runQwenSecondOpinions: mocks.opinions }));

import { retryHeldQwen } from "@/lib/crawl/jobs/held-qwen-retry";
import { confirmGateSplits } from "@/lib/crawl/jobs/split-confirm";
import { tiebreakGateSplits } from "@/lib/crawl/jobs/split-tiebreak";
import { reviewAuditSecondOpinions } from "@/lib/crawl/jobs/audit-second-opinion";
import { withDeepSeekSlot } from "@/lib/crawl/deepseek-slot";
import { JOB_CATALOG, lanesForRole } from "@/lib/jobs/catalog";
import { JOBS } from "@/lib/jobs/registry";
import { legacyLocalModelJob, localModelJob } from "@/lib/llm/local-model-capacity-contract";
import { MODEL_POOL_JOBS } from "@/lib/llm/admin-model-pools";
import { DEFAULT_RUNTIME_SETTINGS, JOB_CALL_ROUTES } from "@/lib/operations/runtime-settings-schema";
import { EMERGENCY_JOB_POLICY } from "@/lib/operations/emergency-priority";
import { stageForJob } from "@/lib/operations/stage-registry";
import { jobRunOptions, runWorker } from "@/scripts/worker";

const SPLIT_JOBS = ["held-qwen-retry", "split-confirm", "split-tiebreak", "audit-qwen", "audit-second-opinion"] as const;
const context = (name: string, over: Partial<JobContext<null>> = {}): JobContext<null> => ({ cursor: null, save: vi.fn(), hasBudget: () => true,
  deadlineAt: Date.now() + 110_000, log: vi.fn(), lease: { name, token: "t", requestedVersion: 1 }, ...over });
const tally = (audit: Partial<{ asked: number; caughtUp: number }> = {}, published = 0) => ({
  audit: { asked: 0, approve: 0, reject: 0, needsReview: 0, released: 0, skipped: 0, autoKept: 0, autoHeld: 0, caughtUp: 0, leftThin: 0, leftSplit: 0, ...audit },
  published: { asked: published, kept: 0, noted: 0, skipped: 0 }, failed: 0, endpointError: null });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ enabled: true });
  mocks.held.mockResolvedValue({ started: 0, rejected: 0, pipeline: 0, held: 0, failed: 0, reapplied: 0 });
  mocks.confirm.mockResolvedValue({ calls: 0 });
  mocks.tiebreak.mockResolvedValue({ calls: 0 });
  mocks.opinions.mockResolvedValue(tally());
});
afterEach(() => vi.useRealTimers());

describe("카탈로그·장부·예산 — 새 잡은 전 잡과 같은 역할·단계에 자기 줄·자기 예산으로 선다", () => {
  it("다섯 잡이 reviewer 의 1분 잡이고 저마다 줄이 있으며, 처리기·모델 풀·비상 자리·단계 표에 빠짐없이 들어 있다", () => {
    for (const name of SPLIT_JOBS) {
      expect(JOB_CATALOG.find(job => job.name === name), name).toMatchObject({ role: "reviewer", intervalMs: 60_000 });
      expect(JOB_CATALOG.find(job => job.name === name)?.lane, name).toBeDefined();
      expect(lanesForRole("reviewer").filter(lane => lane.includes(name)), name).toEqual([[name]]);
      expect(JOBS[name], name).toBeTypeOf("function");
      expect(MODEL_POOL_JOBS.has(name), name).toBe(true);
      expect(EMERGENCY_JOB_POLICY[name], name).toBeDefined();
      expect(stageForJob(name), name).not.toBeNull();
    }
    expect(stageForJob("held-qwen-retry")?.key).toBe("human");
    expect(stageForJob("split-confirm")?.key).toBe("human");
    expect(stageForJob("split-tiebreak")?.key).toBe("second");
    expect(stageForJob("audit-qwen")?.key).toBe("audit");
    expect(stageForJob("audit-second-opinion")?.key).toBe("audit");
  });

  it("예산은 전 잡의 봉투 그대로다 — 사람 검토 110초·2차 110초·감사 70초", () => {
    const budget = (name: string) => jobRunOptions(name, { requestedOnly: true }).budgetMs;
    expect([budget("held-qwen-retry"), budget("split-confirm")]).toEqual([110_000, 110_000]);
    expect(budget("split-tiebreak")).toBe(110_000);
    expect([budget("audit-qwen"), budget("audit-second-opinion")]).toEqual([70_000, 70_000]);
    expect([budget("human-deepseek-review"), budget("second-review"), budget("product-audit")]).toEqual([110_000, 110_000, 70_000]);
    for (const name of SPLIT_JOBS) expect(JOB_CALL_ROUTES[name], name).toBeDefined();
    expect(Object.keys(JOB_CALL_ROUTES).filter(job => !(job in DEFAULT_RUNTIME_SETTINGS.budgets))).toEqual(["crawl-tagline"]);
  });

  it("장부 binding 의 job.name 은 그 호출을 띄운 잡이다 — purpose 하나에 잡 하나, 옛 합성 이름은 읽기만", () => {
    const repo = "acme/demo";
    expect(localModelJob({ kind: "candidate", purpose: "held_qwen", attemptId: 1, candidateId: 2, repo })).toBe("held-qwen-retry");
    expect(localModelJob({ kind: "candidate", purpose: "human_deepseek", attemptId: 1, candidateId: 2, repo })).toBe("human-deepseek-review");
    expect(localModelJob({ kind: "split", purpose: "deepseek_confirm", tiebreakId: 1, candidateId: 2, generationKey: "a".repeat(64), repo })).toBe("split-confirm");
    expect(localModelJob({ kind: "split", purpose: "qwen_tiebreak", tiebreakId: 1, candidateId: 2, generationKey: "a".repeat(64), repo })).toBe("split-tiebreak");
    expect(localModelJob({ kind: "audit", purpose: "audit", itemId: 1, slug: "tool" })).toBe("audit-qwen");
    expect(localModelJob({ kind: "audit", purpose: "second_opinion", itemId: 1, slug: "tool" })).toBe("audit-second-opinion");
    expect(localModelJob({ kind: "published", purpose: "published_filter", secondReviewId: 1, slug: "tool" })).toBe("audit-second-opinion");
    expect(legacyLocalModelJob({ kind: "audit", purpose: "audit", itemId: 1, slug: "tool" })).toBe("product-audit");
  });
});

describe("새 잡은 자기 단계 함수만 자기 lease 로 부른다", () => {
  it("held-qwen-retry — 한 틱을 돌리고 센 것을 적는다. 일을 했으면 done:false", async () => {
    const ctx = context("held-qwen-retry");
    expect(await retryHeldQwen(ctx)).toEqual({ done: true });
    expect(mocks.held).toHaveBeenCalledExactlyOnceWith(ctx, { enabled: true });
    expect(ctx.log).toHaveBeenCalledWith("crawl.held_qwen_retry", expect.objectContaining({ started: 0, refreshed: 0 }));
    mocks.held.mockResolvedValue({ started: 2, rejected: 1, pipeline: 1, held: 0, failed: 0, reapplied: 0, skipped: undefined });
    expect(await retryHeldQwen(context("held-qwen-retry"))).toEqual({ done: false });
    mocks.held.mockResolvedValue({ started: 0, rejected: 0, pipeline: 0, held: 0, failed: 0, reapplied: 0, refreshed: 1 });
    expect(await retryHeldQwen(context("held-qwen-retry"))).toEqual({ done: false });
    await expect(retryHeldQwen(context("held-qwen-retry", { lease: undefined }))).rejects.toThrow("held_qwen_job_required");
  });

  it("split-confirm — 확인 한 틱을 lease 로 부르고, 부른 수가 0 이면 done", async () => {
    const ctx = context("split-confirm");
    expect(await confirmGateSplits(ctx)).toEqual({ done: true });
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(ctx, ctx.lease);
    mocks.confirm.mockResolvedValue({ calls: 1 });
    expect(await confirmGateSplits(context("split-confirm"))).toEqual({ done: false });
    await expect(confirmGateSplits(context("split-confirm", { lease: undefined }))).rejects.toThrow("split_confirm_job_required");
  });

  it("split-tiebreak — 2차 잡이 넘기던 마감(108초) 그대로 판가름을 부른다", async () => {
    const before = Date.now();
    const ctx = context("split-tiebreak");
    expect(await tiebreakGateSplits(ctx)).toEqual({ done: true });
    expect(mocks.tiebreak).toHaveBeenCalledExactlyOnceWith(ctx, ctx.lease, { deadlineAt: expect.any(Number) });
    const { deadlineAt } = mocks.tiebreak.mock.calls[0][2] as { deadlineAt: number };
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 108_000);
    expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 108_000);
    mocks.tiebreak.mockResolvedValue({ calls: 3 });
    expect(await tiebreakGateSplits(context("split-tiebreak"))).toEqual({ done: false });
    await expect(tiebreakGateSplits(context("split-tiebreak", { lease: undefined }))).rejects.toThrow("split_tiebreak_job_required");
  });

  // 3a-B 가 사람 검토 잡 안에 두었던 "한 단계의 오류가 다음 단계를 건너뛰게 하지 않는다"는 잡을 셋으로 나눈 뒤 잡·줄 단위 격리로 대신한다(아래 가짜 시계 시험).
  // 잡 하나 안에서는 lease 잃음·DR fence 를 그대로 던져 쓰기를 멈춘다 — 단계 wrapper 가 삼키지 않는다
  it("lease 잃음·DR fence 는 새 잡도 그대로 던진다 — 그 뒤 쓰기를 멈춘다", async () => {
    const { JobLeaseLostError } = await import("@/lib/jobs/lease");
    const { DrWriterFencedError } = await import("@/lib/operations/dr/epoch");
    mocks.held.mockRejectedValue(new JobLeaseLostError());
    await expect(retryHeldQwen(context("held-qwen-retry"))).rejects.toBeInstanceOf(JobLeaseLostError);
    mocks.confirm.mockRejectedValue(new DrWriterFencedError("site_fenced"));
    await expect(confirmGateSplits(context("split-confirm"))).rejects.toBeInstanceOf(DrWriterFencedError);
    mocks.tiebreak.mockRejectedValue(new JobLeaseLostError());
    await expect(tiebreakGateSplits(context("split-tiebreak"))).rejects.toBeInstanceOf(JobLeaseLostError);
  });

  it("audit-second-opinion — 묻거나 따라잡은 것이 있으면 done:false, 단계의 오류는 단계가 잡는다", async () => {
    const ctx = context("audit-second-opinion");
    expect(await reviewAuditSecondOpinions(ctx)).toEqual({ done: true });
    expect(mocks.opinions).toHaveBeenCalledExactlyOnceWith(ctx, { enabled: true });
    mocks.opinions.mockResolvedValue(tally({ asked: 2 }));
    expect(await reviewAuditSecondOpinions(context("audit-second-opinion"))).toEqual({ done: false });
    mocks.opinions.mockResolvedValue(tally({ caughtUp: 1 }));
    expect(await reviewAuditSecondOpinions(context("audit-second-opinion"))).toEqual({ done: false });
    mocks.opinions.mockResolvedValue(tally({}, 1));
    expect(await reviewAuditSecondOpinions(context("audit-second-opinion"))).toEqual({ done: false });
    await expect(reviewAuditSecondOpinions(context("audit-second-opinion", { lease: undefined }))).rejects.toThrow("audit_second_opinion_job_required");
  });
});

describe("M3 DeepSeek 자리(deepseek-slot.ts) — 위임과 확인이 다른 줄에서 돌아도 호출은 하나씩", () => {
  it("동시에 들어온 호출을 들어온 차례로 하나씩 돌리고, 던진 호출도 자리를 놓는다", async () => {
    vi.useFakeTimers();
    let inFlight = 0, max = 0;
    const order: string[] = [];
    const call = (name: string, ms: number, fail = false) => withDeepSeekSlot(async () => {
      inFlight++; max = Math.max(max, inFlight); order.push(`${name}:start`);
      await new Promise(resolve => setTimeout(resolve, ms));
      inFlight--; order.push(`${name}:end`);
      if (fail) throw new Error(`${name}_failed`);
      return name;
    });
    const results = Promise.allSettled([call("delegate", 60), call("confirm", 45, true), call("delegate-2", 10)]);
    await vi.advanceTimersByTimeAsync(200);
    expect((await results).map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(max).toBe(1);
    expect(order).toEqual(["delegate:start", "delegate:end", "confirm:start", "confirm:end", "delegate-2:start", "delegate-2:end"]);
  });
});

/**
 * 줄 수준의 격리(가짜 시계) — reviewer 줄 표(lanesForRole)를 그대로 쓴다. Qwen 직접 감사 줄이 한 틱을 65초 붙잡고 보류 재심사 줄이 틱마다 던져도,
 * 사람 큐 위임·갈림 확인·갈림 판가름·2차 심사·감사·두 번째 의견 줄은 각자 poll 간격(5초)마다 돈다. 3a-C 전에는 셋이 한 잡이라 이 느림·실패가 같은 틱의
 * 다른 단계를 세웠다(사람 검토 잡: Qwen 재심사 뒤에 위임, 위임 뒤에 확인; 2차 잡: 판가름의 오류가 표 심사 틱을 실패로; 감사 잡: 두 번째 의견을 기다려 닫음).
 */
it("한 새 잡의 느림·실패가 다른 새 잡의 틱을 미루지 않는다 — reviewer 줄 표 그대로, 가짜 시계 60초", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const ends: Array<{ name: string; at: number }> = [];
  // 느린 줄 하나(Qwen 직접 감사 65초)와 틱마다 던지는 줄 둘(보류 재심사·갈림 확인 — 3a-C 전에는 사람 큐 위임과 한 잡이었다)
  const slow = ["audit-qwen"], failing = ["held-qwen-retry", "split-confirm"];
  const watched = ["human-deepseek-review", "split-tiebreak", "second-review", "product-audit", "audit-second-opinion"];
  const names = [...slow, ...failing, ...watched];
  const lanes = lanesForRole("reviewer").filter(lane => lane.some(name => names.includes(name)));
  expect(lanes).toHaveLength(names.length);
  const work = runWorker({ role: "reviewer", signal: controller.signal, intervalMs: 5_000 }, {
    names, lanes, seen: async () => {}, pending: async () => names,
    run: async name => {
      if (slow.includes(name)) await new Promise(resolve => setTimeout(resolve, 65_000));
      if (failing.includes(name)) throw new Error("qwen_unreachable");
      ends.push({ name, at: Date.now() });
      return { status: "completed", done: true };
    },
  });
  const started = Date.now();
  await vi.advanceTimersByTimeAsync(60_000);
  // t=0, 5, …, 60초: 13번씩, 간격은 정확히 poll 간격 — 느린 줄(아직 한 틱도 안 끝남)·던지는 줄(틱마다 실패)과 무관하다
  for (const name of watched) {
    const ticks = ends.filter(end => end.name === name);
    expect(ticks, name).toHaveLength(13);
    expect(ticks.map(end => end.at - started), name).toEqual(Array.from({ length: 13 }, (_, index) => index * 5_000));
  }
  expect(ends.filter(end => end.name === "audit-qwen")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(ends.filter(end => end.name === "audit-qwen")).toHaveLength(1);
  controller.abort();
  const result = await work;
  // 던진 두 줄의 실패만 실패로 센다 — 줄마다 13~14번(60초 동안 5초마다)
  expect(result.failures).toBeGreaterThanOrEqual(26);
});
