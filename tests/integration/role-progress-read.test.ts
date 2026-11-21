import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryClaims, categoryDecisions, crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges, jobs,
  operationsObservations, pipelineStageModes, secondReviews } from "@/lib/db/schema";
import { saveSettings } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { requestDueJobs } from "@/lib/jobs/control";
import { AGENT_SCAN_PRIORITY } from "@/lib/domain/evidence/agents/claims";
import { AI_TASK_KEY_MISSING_CAUSE } from "@/lib/llm/ai-tasks";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { readRoleProgress, readWorkerProgress, ROLE_PROGRESS_STAGES, type RoleStageProgress } from "@/lib/operations/worker-progress-query";
import { checkRoleProgress, selectUnexplainedStall } from "@/scripts/role-worker";
import { ensureSchema, resetTables } from "./setup";

/**
 * 역할 감독의 제 역할 읽기(readRoleProgress, 2026-11-21)가 전체 읽기(readWorkerProgress — 배포 관문·감시)에서 그 역할 감독이 쓰는 몫과
 * 같은 값을 내는지, 그래서 재시작 판정(selectUnexplainedStall)이 같은지를 여러 DB 상태에서 견준다. 같은 `now` 로 두 번 읽는다.
 */
const STAGE_ROLES = ["crawler", "reviewer", "publisher"] as const;
const SERVICE_ROLES = ["scheduler", "crawler", "reviewer", "publisher", "maintenance", "text"] as const;
const drainPolicy: ModelCapacityPolicy = { version: 1, globalLimit: 3, providerLimits: { account: 3 }, groupLimits: { alpha: 3 },
  poolLimits: { reviewer: 2, text: 1 }, weights: { first: 4, second: 2, background: 1 }, maxWaiting: 20, queueTtlMs: 120_000, reservationTtlMs: 30_000,
  routes: [{ routeId: "second-review", provider: "fixture", model: "m", providerBudgetId: "account", groupId: "alpha" }] };
let originalCapacity: { mode: string; policy: unknown; policy_hash: string | null };

beforeAll(async () => {
  ensureSchema();
  [originalCapacity] = await db.execute<typeof originalCapacity>(sql`SELECT mode, policy, policy_hash FROM model_capacity_control WHERE id = 1`);
});
const restoreControls = async () => {
  await db.update(pipelineStageModes).set({ mode: "legacy", drainingFrom: null }).where(inArray(pipelineStageModes.stage, ["ai1", "ai2"]));
  await db.execute(sql`UPDATE agent_scan_control SET mode = 'legacy', draining_from = NULL WHERE id = 1`);
  await db.execute(sql`UPDATE model_capacity_control SET mode = ${originalCapacity.mode},
    policy = ${originalCapacity.policy === null ? null : JSON.stringify(originalCapacity.policy)}::text::jsonb, policy_hash = ${originalCapacity.policy_hash} WHERE id = 1`);
};
beforeEach(async () => {
  await resetTables();
  for (const table of [secondReviews, categoryDecisions, crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges,
    agentRepositoryClaims, jobs, operationsObservations]) await db.delete(table);
  await restoreControls();
  await saveSettings({ enabled: true, reviewMode: "off", secondReview: { enabled: true } }, "test");
});
afterAll(restoreControls);

const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);
const observe = (key: string, observedAt: Date, value: Record<string, unknown> = { status: "running" }) =>
  db.insert(operationsObservations).values({ key, value, observedAt })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { value, observedAt } });
/** scheduler 가 예약을 밀고 있고(scheduled) 여섯 역할이 모두 관측되는 바탕 */
async function healthy(now: Date, except: readonly string[] = []) {
  await requestDueJobs();
  for (const role of SERVICE_ROLES) if (!except.includes(role)) await observe(`service:${role}:fixture`, now);
}
/** 역할마다 제 단계가 5~15분 넘게 기다리고 최근 진행이 없는 일감 */
async function stalledWork(now: Date) {
  await db.insert(crawlFrontier).values({ repo: "role/fetch", signal: "test", state: "pending", discoveredAt: ago(now, 10),
    updatedAt: ago(now, 10), nextAttemptAt: ago(now, 10) });
  await db.insert(crawlDocuments).values({ repo: "role/judge", repoMeta: {}, fetchedAt: ago(now, 20) });
  const [candidate] = await db.insert(crawlCandidates).values({ repo: "role/second", state: "needs_review", updatedAt: ago(now, 480) }).returning();
  await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo, trigger: "sample", firstDecision: "approve",
    inputHash: "a".repeat(64), provider: "abcllm", model: "fixture", createdAt: ago(now, 480) });
  await db.insert(crawlCandidates).values({ repo: "role/publish", state: "approved", reason: "passed", decidedBy: "auto", updatedAt: ago(now, 120) });
  await db.insert(categoryDecisions).values({ repo: "role/publish", sourceHash: "h", category: null, reason: "held", actor: "test",
    retryAt: ago(now, 11), updatedAt: ago(now, 61) });
}

/** 전체 읽기와 역할 읽기를 같은 시각으로 읽어, 역할 감독이 쓰는 몫과 재시작 판정이 같은지 본다. 전체 보고서와 역할별 판정을 돌려준다 */
async function compare(now: Date) {
  const full = await readWorkerProgress(now, { includeText: false });
  const triggers = {} as Record<(typeof STAGE_ROLES)[number], ReturnType<typeof selectUnexplainedStall>>;
  for (const role of STAGE_ROLES) {
    const mine = await readRoleProgress(role, now) as RoleStageProgress;
    expect(mine, role).toEqual({ measuredAt: full.measuredAt, role, scheduler: full.scheduler, stageKeys: ROLE_PROGRESS_STAGES[role],
      stages: full.stages.filter(stage => stage.role === role),
      liveness: full.liveness.filter(row => row.role === "scheduler" || row.role === role),
      lanes: full.lanes!.filter(lane => lane.role === role), activeJobs: full.activeJobs });
    expect(mine.stages.map(stage => stage.stage), role).toEqual(ROLE_PROGRESS_STAGES[role]);
    triggers[role] = selectUnexplainedStall(mine, role);
    expect(triggers[role], role).toEqual(selectUnexplainedStall(full, role));
  }
  // maintenance·text 감독은 scheduler 판정 하나만 쓴다 — 단계·줄·생존 칸은 없다(읽지 않음)
  for (const role of ["maintenance", "text"] as const)
    expect(await readRoleProgress(role, now), role).toEqual({ measuredAt: full.measuredAt, role, scheduler: full.scheduler });
  return { full, triggers };
}
const stageOf = (full: Awaited<ReturnType<typeof readWorkerProgress>>, key: string) => full.stages.find(stage => stage.stage === key);

describe("역할 읽기 = 전체 읽기에서 그 역할의 몫", () => {
  it("일감이 없고 모두 살아 있으면 어느 역할도 정체가 아니다", async () => {
    const now = new Date();
    await healthy(now);
    const { full, triggers } = await compare(now);
    expect(full.scheduler.reason).toBe("scheduled");
    expect(full.stages.filter(stage => stage.alarm)).toEqual([]);
    expect(triggers).toEqual({ crawler: null, reviewer: null, publisher: null });
    // 감독의 15초 판정도 같다(지금 시각으로 읽는다). maintenance 는 scheduler 판정에 제 응답 점검 진행을 더해 본다
    for (const role of [...STAGE_ROLES, "maintenance"] as const) expect(await checkRoleProgress(role), role).toBe(false);
  });

  it("역할마다 제 단계가 멈추면 그 역할만의 재시작 트리거가 같다", async () => {
    const now = new Date();
    await healthy(now);
    await stalledWork(now);
    const { full, triggers } = await compare(now);
    for (const key of ["fetch", "judge", "second", "publish"])
      expect(stageOf(full, key), key).toMatchObject({ reason: "no_progress", alarm: true, restartEligible: true });
    expect(triggers.crawler).toMatchObject({ kind: "stage", job: "crawl-fetch", restartEligible: true });
    expect(triggers.reviewer).toMatchObject({ kind: "stage", job: "crawl-judge", restartEligible: true });
    expect(triggers.publisher).toMatchObject({ kind: "stage", job: "crawl-publish", restartEligible: true });
    for (const role of STAGE_ROLES)
      expect(await checkRoleProgress(role), role).toMatchObject({ kind: "stage", job: triggers[role]!.job, lane: triggers[role]!.lane, restartEligible: true });
    // versioned batch 후보는 이 판정을 하지 않는다
    expect(await checkRoleProgress("crawler", 1)).toBe(false);
  });

  it("멈춘 잡·오류·줄 정지·도는 잡이 판정을 같은 쪽으로 바꾼다", async () => {
    const now = new Date();
    await healthy(now);
    await stalledWork(now);
    await db.delete(crawlDocuments);
    // 관리자가 멈춘 수집, 오류가 남은 발행, 임대를 쥐고 도는 2차 심사
    await db.update(jobs).set({ notBefore: new Date("2100-01-01") }).where(eq(jobs.name, "crawl-fetch"));
    await db.update(jobs).set({ lastError: "boom" }).where(eq(jobs.name, "crawl-publish"));
    await db.update(jobs).set({ leaseToken: randomUUID(), lockedAt: now }).where(eq(jobs.name, "second-review"));
    const lane = (name: string, jobsInLane: string[], state: string, startedAgoMs: number | null) => ({ name, jobs: jobsInLane, state,
      currentJob: state === "running" ? name : null, startedAt: startedAgoMs === null ? null : now.getTime() - startedAgoMs,
      pollStartedAt: null, lastProgressAt: now.getTime() - 1_000 });
    // crawler: 근거 새로 고침 줄이 한도(180초)를 넘겨 돌고 있다 → 줄 정지
    await observe("service:crawler:fixture", now, { status: "running", lanes: [lane("product-evidence-refresh", ["product-evidence-refresh"], "running", 600_000)] });
    const { full, triggers } = await compare(now);
    expect(stageOf(full, "fetch")).toMatchObject({ reason: "paused", alarm: false });
    expect(stageOf(full, "publish")).toMatchObject({ reason: "upstream_or_job_error", restartEligible: false });
    expect(full.activeJobs).toEqual(["second-review"]);
    expect(full.lanes).toEqual([expect.objectContaining({ role: "crawler", reason: "job_timeout", restartEligible: true })]);
    expect(triggers.crawler).toMatchObject({ kind: "lane", reason: "job_timeout" });
    // 2차 심사 잡이 임대를 쥐고 도는 동안은 그 단계의 정체로 reviewer 를 재시작하지 않는다
    expect(stageOf(full, "second")).toMatchObject({ reason: "no_progress", restartEligible: true });
    expect(triggers.reviewer).toBeNull();
    expect(triggers.publisher).toBeNull();
  });

  it("관측이 없거나 낡은 역할, 예전 키만 있는 역할, scheduler 부재를 같게 본다", async () => {
    const now = new Date();
    await healthy(now, ["scheduler", "crawler", "reviewer", "publisher"]);
    await stalledWork(now);
    await observe("service:reviewer:fixture", ago(now, 2));
    await observe("publisher", now);
    const first = await compare(now);
    expect(first.full.scheduler.reason).toBe("worker_missing");
    expect(first.full.liveness.filter(row => row.alarm).map(row => row.role)).toEqual(["scheduler", "crawler", "reviewer"]);
    expect(stageOf(first.full, "fetch")).toMatchObject({ reason: "worker_missing", alarm: true, restartEligible: false });
    expect(stageOf(first.full, "publish")).toMatchObject({ reason: "no_progress", restartEligible: true });
    // scheduler 판정이 scheduled 가 아니면 단계 정체로 재시작하지 않는다
    expect(first.triggers).toEqual({ crawler: null, reviewer: null, publisher: null });
    // 예전 키(scheduler)만으로도 scheduler 가 관측된다 — 그때는 살아 있는 publisher 만 재시작 대상이다
    await observe("scheduler", now);
    const second = await compare(now);
    expect(second.full.scheduler.reason).toBe("scheduled");
    expect(second.triggers).toMatchObject({ crawler: null, reviewer: null, publisher: { kind: "stage", job: "crawl-publish" } });
  });

  it("건 단위 consumer 가 맡은 2차 심사: consumer 부재·생존·비우는 중", async () => {
    const now = new Date();
    await healthy(now);
    await stalledWork(now);
    await db.delete(crawlDocuments);
    await db.update(pipelineStageModes).set({ mode: "items" }).where(eq(pipelineStageModes.stage, "ai2"));
    const missing = await compare(now);
    expect(stageOf(missing.full, "second")).toMatchObject({ reason: "consumer_missing", alarm: true, restartEligible: false, lane: "ai2-consumer" });
    expect(missing.triggers.reviewer).toBeNull();
    await observe("service:reviewer:ai2-consumer-m3", now);
    const alive = await compare(now);
    expect(stageOf(alive.full, "second")).toMatchObject({ reason: "no_progress", alarm: true, restartEligible: false });
    expect(alive.triggers.reviewer).toBeNull();
    await db.update(pipelineStageModes).set({ mode: "draining", drainingFrom: "items" }).where(eq(pipelineStageModes.stage, "ai2"));
    const draining = await compare(now);
    expect(stageOf(draining.full, "second")).toMatchObject({ reason: "backoff", alarm: false, restartEligible: false });
  });

  it("모델 용량 DRAIN 은 심사 단계를 보류로 두고 다른 역할의 판정은 그대로다", async () => {
    const now = new Date();
    await healthy(now);
    await stalledWork(now);
    await db.delete(crawlDocuments);
    await db.execute(sql`UPDATE model_capacity_control SET mode = 'draining', policy = ${JSON.stringify(drainPolicy)}::text::jsonb,
      policy_hash = ${modelCapacityPolicyHash(drainPolicy)} WHERE id = 1`);
    const { full, triggers } = await compare(now);
    expect(stageOf(full, "second")).toMatchObject({ held: true, reason: "backoff", alarm: false, restartEligible: false });
    expect(triggers.reviewer).toBeNull();
    // 발행은 분류 drain 관측이 없으면 지금처럼 정체다
    expect(triggers.publisher).toMatchObject({ kind: "stage", job: "crawl-publish" });
    expect(triggers.crawler).toMatchObject({ kind: "stage", job: "crawl-fetch" });
  });

  it("막 끝난 틱이 모든 순위를 쓸 수 없다고 알린 2차 심사는 재시작 대상에서 빠진다", async () => {
    const now = new Date();
    await healthy(now);
    await stalledWork(now);
    await db.delete(crawlDocuments);
    await observe("job:second-review", now, { degraded: { code: "all_ranks_unusable", detail: "no usable rank", streak: 3 } });
    const skipped = await compare(now);
    expect(stageOf(skipped.full, "second")).toMatchObject({ reason: "no_progress", alarm: true, restartEligible: false,
      skipBlock: { reason: "all_skipped", code: "all_ranks_unusable", streak: 3 } });
    expect(skipped.triggers.reviewer).toBeNull();
    // 키 없는 연결뿐이면 설정의 일로 보류한다(경보·재시작 없음)
    await observe("job:second-review", now, { degraded: { code: "all_ranks_unusable", cause: AI_TASK_KEY_MISSING_CAUSE } });
    const held = await compare(now);
    expect(stageOf(held.full, "second")).toMatchObject({ held: true, reason: "backoff", alarm: false, restartEligible: false,
      skipBlock: { reason: "key_missing" } });
    // 관측이 낡으면(틱이 멈춘 워커) 지금처럼 재시작 대상이다
    await observe("job:second-review", ago(now, 10), { degraded: { code: "all_ranks_unusable", cause: AI_TASK_KEY_MISSING_CAUSE } });
    const stale = await compare(now);
    expect(stale.triggers.reviewer).toMatchObject({ kind: "stage", job: "second-review", restartEligible: true });
  });

  it("제작 근거 스캔이 consumer 몫이면 crawler 는 consumer 관측과 스캔 관측을 함께 읽는다", async () => {
    const now = new Date();
    await healthy(now);
    await saveSettings({ agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true } }, "test");
    await db.insert(crawlCandidates).values({ repo: "acme/due", updatedAt: ago(now, 20) });
    await db.execute(sql`INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at, state)
      VALUES ('acme/due', ${AGENT_SCAN_PRIORITY.newCandidate}, true, ${ago(now, 10).toISOString()}::timestamp, 'active')`);
    await db.execute(sql`UPDATE agent_scan_control SET mode = 'items', draining_from = NULL WHERE id = 1`);
    const missing = await compare(now);
    expect(stageOf(missing.full, "agent-evidence")).toMatchObject({ waiting: 1, reason: "consumer_missing", alarm: true, restartEligible: false });
    // 살아 있는 consumer 가 공급자 대기 중이면 그 재개 시각까지 backoff 다
    const instanceId = "agent-scan-consumer-m3", bootedAt = now.getTime() - 60_000;
    await observe(`service:crawler:${instanceId}`, now, { status: "running", childPid: 4321, bootedAt });
    await observe(`agent-scan:${instanceId}`, now, { instanceId, running: 0, pid: 4321, bootedAt: bootedAt + 1_000, bootId: randomUUID(),
      pausedUntil: new Date(now.getTime() + 10 * 60_000).toISOString() });
    const paused = await compare(now);
    expect(stageOf(paused.full, "agent-evidence")).toMatchObject({ waiting: 1, reason: "backoff", alarm: false, restartEligible: false });
    // 스캔 관측이 없으면 대기를 주장하지 않는다
    await db.delete(operationsObservations).where(eq(operationsObservations.key, `agent-scan:${instanceId}`));
    const unpaused = await compare(now);
    expect(stageOf(unpaused.full, "agent-evidence")).toMatchObject({ reason: "no_progress", alarm: true, restartEligible: false });
  });

  it("심사 단계 control 행이 없으면 어느 역할의 읽기도 판정을 내지 않는다", async () => {
    const now = new Date();
    await healthy(now);
    await stalledWork(now);
    const [row] = await db.select().from(pipelineStageModes).where(eq(pipelineStageModes.stage, "ai1"));
    await db.delete(pipelineStageModes).where(eq(pipelineStageModes.stage, "ai1"));
    try {
      await expect(readWorkerProgress(now, { includeText: false })).rejects.toThrow("review_stage_modes_missing");
      for (const role of [...STAGE_ROLES, "maintenance", "text"] as const)
        await expect(readRoleProgress(role, now), role).rejects.toThrow("review_stage_modes_missing");
    } finally {
      await db.insert(pipelineStageModes).values(row);
    }
  });
});
