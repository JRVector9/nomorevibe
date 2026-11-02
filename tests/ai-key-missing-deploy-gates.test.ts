import { afterEach, describe, expect, it } from "vitest";
import { firstReviewRanksDegraded, firstReviewRanks, secondReviewRanks, secondReviewRanksDegraded } from "@/lib/crawl/review-task-ranks";
import { catalogJobsForBatch } from "@/lib/jobs/batches";
import { degradedObservation } from "@/lib/jobs/runner";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { resolveTextTaskRanks, TextTaskRanks } from "@/lib/llm/ai-task-resolver";
import { AI_TASK_KEY_MISSING_CAUSE, onlyKeyMissing } from "@/lib/llm/ai-tasks";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { applyAllSkippedBlock, applyKeyMissingHold, buildWorkerProgress } from "@/lib/operations/worker-progress-query";
import type { ThroughputSnapshot } from "@/lib/operations/throughput-model";
import { pinReviewRanks } from "./review-task-ranks-fixture";
import { TEST_TEXT_BASE_URL, textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * 키 없는 연결 때문에 배포 관문이 막히지 않는다(2026-11-02 사람 결정 「키 없어도 배포는 되게 — 모델은 관리자가 지정」).
 * 모든 순위가 키 없는 연결뿐(connection_key_missing)이면 잡 degraded 에 cause 를 싣고, 진행 감시는 그 단계를 경보·재시작하지 않는다
 * (worker progress overall → 배포 사전·사후 관문 progress=ok). 다른 진짜 정체는 그대로 경보다. 시험 키는 모두 가짜다.
 */
const FAKE_KEY = "test-fake-key-gate";
afterEach(() => { setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); pinReviewRanks(null); });

function reviewContract(routeId: "crawl-agent-review" | "second-review", model: string): StoredServingContract {
  return { routeId, model, auth: "stored", apiKey: FAKE_KEY, transport: "direct",
    contract: { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId, provider: "abcllm", model, responseModel: model, deploymentRevision: `test-${model}`,
      endpoint: `${TEST_TEXT_BASE_URL}/chat/completions`, totalTokenBound: 32_768 } };
}

describe("degraded cause — 모든 순위가 키 없는 연결뿐일 때만", () => {
  it("onlyKeyMissing: 비어 있지 않고 모두 connection_key_missing 일 때만 참", () => {
    expect(onlyKeyMissing(["connection_key_missing", "connection_key_missing"])).toBe(true);
    expect(onlyKeyMissing(["connection_key_missing", "no_direct_contract"])).toBe(false);
    expect(onlyKeyMissing(["connection_key_missing", null])).toBe(false);
    expect(onlyKeyMissing([])).toBe(false);
  });

  it("text: 모든 순위가 키 없는 연결이면 cause, 다른 까닭이 섞이면 cause 없음(예전 경보 그대로)", () => {
    setServingContractSnapshotForTest([textContract("reason-translate", "m3-model", { auth: "stored", apiKey: FAKE_KEY })]);
    setAiTaskModelsForTest([textRankRow("reason-translate", "m3-model", { label: "m3-mlx" })]);
    expect(new TextTaskRanks(resolveTextTaskRanks("reason-translate")).earlyDegraded()).toMatchObject({ code: "all_ranks_unusable", cause: AI_TASK_KEY_MISSING_CAUSE });
    // 2순위는 계약이 없는 모델 — 키 없음이 아닌 까닭이 섞였다
    setAiTaskModelsForTest([textRankRow("reason-translate", "m3-model", { label: "m3-mlx" }),
      textRankRow("reason-translate", "no-contract-model", { rank: 2, label: "m3-mlx" })]);
    const mixed = new TextTaskRanks(resolveTextTaskRanks("reason-translate")).earlyDegraded();
    expect(mixed?.code).toBe("all_ranks_unusable");
    expect(mixed).not.toHaveProperty("cause");
  });

  it("text: 틱 안에서 쉬게 된 순위(엔진 내려감 등)가 있으면 cause 없음", () => {
    setServingContractSnapshotForTest([textContract("reason-translate", "m3-model", { auth: "stored", apiKey: FAKE_KEY })]);
    setAiTaskModelsForTest([textRankRow("reason-translate", "m3-model", { apiKey: FAKE_KEY })]);
    const ranks = new TextTaskRanks(resolveTextTaskRanks("reason-translate"));
    ranks.pause(ranks.bindings()[0], "engine_connection_refused");
    expect(ranks.degraded()).not.toHaveProperty("cause");
  });

  it("1차·2차 심사: 모든 순위가 키 없는 연결이면 cause", () => {
    pinReviewRanks(null);
    setServingContractSnapshotForTest([reviewContract("crawl-agent-review", "m3-review"), reviewContract("second-review", "m3-voter")]);
    setAiTaskModelsForTest([textRankRow("first-review", "m3-review", { label: "m3-mlx" }), textRankRow("second-review", "m3-voter", { label: "m3-mlx" })]);
    expect(firstReviewRanksDegraded(firstReviewRanks())).toMatchObject({ code: "all_ranks_unusable", cause: AI_TASK_KEY_MISSING_CAUSE });
    expect(secondReviewRanksDegraded(secondReviewRanks())).toMatchObject({ code: "all_ranks_unusable", cause: AI_TASK_KEY_MISSING_CAUSE });
  });

  it("job 관측은 cause 를 그대로 싣고(꼴이 맞을 때만), 없으면 예전 모양 그대로", () => {
    const at = new Date("2026-11-02T12:00:00Z");
    expect(degradedObservation({ code: "all_ranks_unusable", detail: "d", cause: AI_TASK_KEY_MISSING_CAUSE }, at)).toMatchObject({ cause: AI_TASK_KEY_MISSING_CAUSE });
    expect(degradedObservation({ code: "all_ranks_unusable", detail: "d" }, at)).toEqual({ code: "all_ranks_unusable", detail: "d", critical: false,
      at: at.toISOString(), streak: 1, since: at.toISOString() });
    expect(degradedObservation({ code: "all_ranks_unusable", cause: "Bad Cause!" }, at)).not.toHaveProperty("cause");
  });
});

describe("진행 감시 — 키 없는 연결 보류(applyKeyMissingHold)", () => {
  const now = new Date("2026-11-02T12:00:00Z");
  const observed = (job: string, degraded: Record<string, unknown> | null, ageMs = 30_000) =>
    [{ key: `job:${job}`, value: degraded ? { degraded } : {}, observedAt: new Date(now.getTime() - ageMs) }];
  const keyMissing = { code: "all_ranks_unusable", cause: AI_TASK_KEY_MISSING_CAUSE, detail: "사유 번역: 1순위 m3-mlx · m3-model: 연결에 키가 없음", streak: 7 };
  const textStage = { job: "reason-translate", reason: "no_progress", alarm: true, restartEligible: false, errors5m: 0 };

  it("text no_progress + 신선한 cause 관측 → 경보·재시작 없음(held backoff), skipBlock key_missing", () => {
    expect(applyKeyMissingHold(textStage, observed("reason-translate", keyMissing), now)).toEqual({ ...textStage, held: true, reason: "backoff", alarm: false,
      restartEligible: false, skipBlock: { reason: "key_missing", code: "all_ranks_unusable", detail: keyMissing.detail, streak: 7 } });
  });

  it("옛 401 실패만 남은 upstream_stalled 도 보류; 5분 안 새 실패·잡 오류가 있으면 경보 그대로", () => {
    const stalled = { ...textStage, reason: "upstream_stalled" };
    expect(applyKeyMissingHold(stalled, observed("reason-translate", keyMissing), now)).toMatchObject({ alarm: false, reason: "backoff" });
    expect(applyKeyMissingHold({ ...stalled, errors5m: 2 }, observed("reason-translate", keyMissing), now)).toMatchObject({ alarm: true, reason: "upstream_stalled" });
    expect(applyKeyMissingHold(stalled, observed("reason-translate", keyMissing), now, "boom")).toMatchObject({ alarm: true, reason: "upstream_stalled" });
  });

  it("약하게 하지 않는다: cause 없음·다른 code·오래된 관측·worker_missing·순위 잡이 아님 → 그대로", () => {
    expect(applyKeyMissingHold(textStage, observed("reason-translate", { ...keyMissing, cause: undefined }), now)).toBe(textStage);
    expect(applyKeyMissingHold(textStage, observed("reason-translate", { ...keyMissing, code: "no_task_models" }), now)).toBe(textStage);
    expect(applyKeyMissingHold(textStage, observed("reason-translate", keyMissing, 10 * 60_000), now)).toBe(textStage);
    expect(applyKeyMissingHold(textStage, observed("reason-translate", null), now)).toBe(textStage);
    const missing = { ...textStage, reason: "worker_missing" };
    expect(applyKeyMissingHold(missing, observed("reason-translate", keyMissing), now)).toBe(missing);
    const fetch = { ...textStage, job: "crawl-fetch" };
    expect(applyKeyMissingHold(fetch, observed("crawl-fetch", keyMissing), now)).toBe(fetch);
  });

  it("1차 심사 no_progress(재시작 대상)도 보류 — applyAllSkippedBlock 뒤에도 경보·재시작 없음", () => {
    const first = { job: "crawl-agent-review", reason: "no_progress", alarm: true, restartEligible: true, errors5m: 0 };
    const held = applyAllSkippedBlock(applyKeyMissingHold(first, observed("crawl-agent-review", keyMissing), now), observed("crawl-agent-review", keyMissing), now);
    expect(held).toMatchObject({ alarm: false, restartEligible: false, held: true, skipBlock: { reason: "key_missing" } });
    // cause 없는 all_ranks_unusable 는 예전처럼: 재시작만 끄고 경보는 남는다
    const plain = applyAllSkippedBlock(applyKeyMissingHold(first, observed("crawl-agent-review", { code: "all_ranks_unusable" }), now),
      observed("crawl-agent-review", { code: "all_ranks_unusable" }), now);
    expect(plain).toMatchObject({ alarm: true, restartEligible: false, reason: "no_progress", skipBlock: { reason: "all_skipped" } });
  });

  it("buildWorkerProgress: 키 없는 연결뿐인 text 단계 하나 때문에 overall 이 alarm 이 되지 않는다(배포 관문 progress=ok); cause 없으면 alarm", () => {
    const at = now.toISOString();
    const throughput = { measuredAt: at, stages: [] } as unknown as ThroughputSnapshot;
    const running = (role: string) => ({ key: `service:${role}:m3-${role}`, value: { status: "running", restartCount5m: 0 }, observedAt: now });
    const instances = ["scheduler", "crawler", "reviewer", "publisher", "maintenance", "text"].map(running);
    const textInput = { key: "reason-translate" as const, enabled: true, waiting: 120, oldestMinutes: 45, completed5m: 0, progress5m: 0, errors5m: 0,
      deferred: 0, manualAttention: 0, providerErrors: 0, providerErrorMinutes: null };
    const batch = { mode: "legacy", writerContractVersion: 0 };
    const jobs = catalogJobsForBatch(batch).map(job => ({ name: job.name, nextScheduledAt: now, notBefore: null }));
    const report = (degraded: Record<string, unknown>) => buildWorkerProgress(throughput, jobs, [...instances, ...observed("reason-translate", degraded)], now,
      batch, [textInput]);
    const held = report(keyMissing);
    expect(held.stages.find(stage => stage.stage === "reason-translate")).toMatchObject({ alarm: false, held: true, reason: "backoff", skipBlock: { reason: "key_missing" } });
    expect(held.stages.filter(stage => stage.alarm)).toEqual([]);
    const alarmed = report({ code: "all_ranks_unusable" });
    expect(alarmed.stages.find(stage => stage.stage === "reason-translate")).toMatchObject({ alarm: true, reason: "no_progress" });
    expect(alarmed.overall).toBe("alarm");
    expect(held.overall).toBe("ok");
  });
});
