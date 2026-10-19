import { db } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { operationsObservations } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { listJobStates } from "@/lib/jobs/runner";
import { WITHOUT_JOB_DEFERRALS } from "@/lib/jobs/deferral-observation";
import { readJobBatchMode } from "@/lib/jobs/batch-repository";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { AGENT_DETECTOR_VERSION } from "@/lib/domain/evidence/agents/types";
import { AI_LEVEL_RULES_VERSION } from "@/lib/domain/evidence/ai-level-labels";
import { agentLimitedSettledSql, agentRefreshDueAtSql } from "@/lib/domain/evidence/agents/refresh-policy";
import { evidenceSourceTargetCtesSql } from "@/lib/domain/evidence/source-demand";
import { AGENT_SCAN_CONSUMER_PREFIX, agentScanByClaims, readAgentScanMode, type AgentScanModeState } from "@/lib/domain/evidence/agents/claim-control";
import { latestServiceInstance, serviceInstancesFromObservations } from "./instance";
import { pipelineThroughput } from "./throughput";
import type { ThroughputSnapshot } from "./throughput-model";
import { classifyLiveness, classifyScheduler, classifyStage, laneForJob, parseAgentProviderFailure, parseRuntimeLanes, runtimeLaneStall,
  type AgentProviderFailure, type ProgressStageInput, type ProgressStageKey, type StageProgress } from "./worker-progress";

type ProgressJob = { name: string; nextScheduledAt: Date | null; notBefore: Date | null; lockedAt?: Date | null;
  leaseToken?: string | null; cursor?: unknown; lastError?: string | null };
const jobForStage: Record<ProgressStageKey, string> = { fetch: "crawl-fetch", judge: "crawl-judge", first: "crawl-agent-review",
  second: "second-review", publish: "crawl-publish", evidence: "product-evidence-refresh",
  "agent-evidence": "agent-evidence-refresh", "ai-level": "ai-level-refresh" };
export type WorkerLaneProgress = { role: string; name: string; jobs: string[]; state: string; currentJob: string | null;
  startedAt: number | null; pollStartedAt: number | null; lastProgressAt: number; pollAgeMs: number | null;
  progressAgeMs: number; reason: string | null; alarm: boolean; restartEligible: boolean };
// 출처·저장소마다 다음 재시도 시각을 받은 개별 실패(없는 저장소, 사이트 HTTP 오류, 시간 초과 등)는 공급자 장애가 아니다.
// 재시도 예정이어도 공급자 장애로 세는 것은 GitHub 계정 단위 실패뿐이다 — 한도·인증 403/401은 수집기가 이 코드로 바꾼다.
// 기한이 지난 개별 실패는 대기(waiting)로 남아 정체 경보가 맡고, 최근 5분 실패는 errors5m 이 맡는다.
const EVIDENCE_PROVIDER_FAILURE_CODES = ["rate_limited", "auth_unavailable"];
// 제작 근거 스캔의 'unavailable' 은 없는 저장소와 인증 실패를 함께 담아 저장소별 실패로 본다.
// 인증·한도로 스캔을 시작조차 못 하면 잡 커서의 공급자 실패(job_failure)로 남아 계속 경보한다.
const AGENT_PROVIDER_FAILURE_CODES = ["rate_limited"];
const sqlTextList = (values: string[]) => sql.join(values.map(value => sql`${value}`), sql`, `);
/** consumer 생존 판정 — pipeline-control status 의 consumers 와 같은 2분 */
const CONSUMER_HEARTBEAT_MS = 120_000;

export type WorkerProgressReport = { measuredAt: string; overall: "alarm" | "unknown" | "ok";
  stages: StageProgress[]; scheduler: ReturnType<typeof classifyScheduler>; liveness: ReturnType<typeof classifyLiveness>[];
  /** Optional for readers/fixtures written before lane metadata was introduced. */
  lanes?: WorkerLaneProgress[]; activeJobs?: string[] };

/** Canonical URLs avoid capture/replacement regexes; legacy URL handling stays mode-specific. */
export function progressRepositoryKeySql(repoUrl: SQL, mode: "agent" | "ai"): SQL {
  const canonical = sql`CASE WHEN ${repoUrl} ~ '^https://github[.]com/[^/]+/[^/#?]+/?$'
    AND right(lower(rtrim(${repoUrl}, '/')), 4) <> '.git'
    THEN lower(rtrim(substring(${repoUrl} from 20), '/')) END`;
  const fallback = mode === "agent"
    ? sql`lower(substring(${repoUrl} from '^https://github[.]com/([^/]+/[^/#?]+?)([.]git)?/?$'))`
    : sql`substring(regexp_replace(regexp_replace(lower(rtrim(${repoUrl}, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')
        from '^https://github[.]com/([^/]+/[^/#?]+)$')`;
  return sql`coalesce(${canonical}, ${fallback})`;
}

export function buildWorkerProgress(
  throughput: ThroughputSnapshot,
  jobs: ProgressJob[],
  observations: Array<{ key: string; value: Record<string, unknown>; observedAt: Date | string }>,
  now: Date,
  batch: { mode: string; writerContractVersion: number },
  evidence: ProgressStageInput[] = [],
  agentScan: AgentScanModeState | null = null,
): WorkerProgressReport {
  const instances = serviceInstancesFromObservations(observations);
  const liveness = (["scheduler", "crawler", "reviewer", "publisher", "maintenance", "text"] as const).map(role => {
    const instance = latestServiceInstance(instances, role);
    const observedAt = instance && (instance.value.status === "running" || instance.value.status === "starting")
      ? instance.observedAt instanceof Date ? instance.observedAt : new Date(instance.observedAt) : null;
    return classifyLiveness(role, observedAt, now,
      typeof instance?.value.restartCount5m === "number" ? instance.value.restartCount5m : 0);
  });
  const isObserved = (role: "scheduler" | "crawler" | "reviewer" | "publisher") =>
    liveness.some(row => row.role === role && !row.alarm);
  const agentScanConsumerAlive = instances.some(row => row.role === "crawler" && row.instanceId.startsWith(AGENT_SCAN_CONSUMER_PREFIX)
    && (row.value.status === "running" || row.value.status === "starting")
    && now.getTime() - new Date(row.observedAt as string | Date).getTime() <= CONSUMER_HEARTBEAT_MS);
  const states = new Map(jobs.map(job => [job.name, job]));
  const classified: StageProgress[] = [...throughput.stages, ...evidence].map(stage => {
    const job = states.get(jobForStage[stage.key]);
    const classifiedStage = classifyStage(stage, job ?? null, isObserved(["fetch", "evidence", "agent-evidence", "ai-level"].includes(stage.key)
      ? "crawler" : stage.key === "publish" ? "publisher" : "reviewer"), now);
    const result = stage.key === "agent-evidence" && agentScan && agentScan.mode !== "legacy"
      ? agentScanStage(classifiedStage, agentScan, agentScanConsumerAlive) : classifiedStage;
    return { ...result, job: jobForStage[stage.key], lane: laneForJob(result.role, jobForStage[stage.key]),
      waiting: stage.waiting, oldestMinutes: stage.oldestMinutes, completed5m: stage.completed5m,
      progress5m: stage.progress5m, errors5m: stage.errors5m, deferred: stage.deferred,
      ...("providerErrors" in stage ? { providerErrors: stage.providerErrors, providerErrorMinutes: stage.providerErrorMinutes } : {}) };
  });
  const lanes = (["crawler", "reviewer", "publisher", "maintenance", "text"] as const).flatMap(role => {
    const instance = latestServiceInstance(instances, role);
    if (!instance || instance.value.status !== "running" || liveness.some(row => row.role === role && row.alarm)) return [];
    const metadata = parseRuntimeLanes(instance.value.lanes, role);
    const limits = instance.value.laneLimits as { progressMs?: unknown; jobMs?: unknown } | undefined;
    const boundedLimit = (value: unknown, fallback: number) => typeof value === "number" && Number.isSafeInteger(value)
      && value >= 60_000 && value <= 3_600_000 ? value : fallback;
    return (metadata ?? []).map(lane => {
      const reason = runtimeLaneStall(lane, now.getTime(), {
        progressMs: boundedLimit(limits?.progressMs, 90_000), jobMs: boundedLimit(limits?.jobMs, role === "maintenance" ? 600_000 : 180_000),
      });
      return { role, ...lane, pollAgeMs: lane.pollStartedAt === null ? null : Math.max(0, now.getTime() - lane.pollStartedAt),
        progressAgeMs: Math.max(0, now.getTime() - lane.lastProgressAt), reason, alarm: reason !== null, restartEligible: reason !== null };
    });
  });
  const activeJobs = jobs.filter(job => job.leaseToken && job.lockedAt &&
    now.getTime() - job.lockedAt.getTime() <= STALE_LOCK_MS).map(job => job.name);
  const stages = classified.map(stage => {
    if (stage.reason !== "no_progress" || !stage.job || !activeJobs.includes(stage.job)) return stage;
    const lane = lanes.find(row => row.role === stage.role && row.currentJob === stage.job && row.state === "running");
    let healthyRun = lane && lane.reason === null && lane.startedAt !== null && lane.startedAt <= now.getTime();
    // Older supervisors did not publish lanes; retain the exact-job hard timeout fallback.
    const instance = latestServiceInstance(instances, stage.role);
    if (!lane && instance && instance.value.lanes === undefined && instance.value.status === "running" && isObserved(stage.role)
      && instance.value.currentJob === stage.job && instance.value.state === "running") {
      const startedAt = instance.value.jobStartedAt;
      healthyRun = typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt <= now.getTime()
        && now.getTime() - startedAt <= 180_000;
    }
    return healthyRun ? { ...stage, reason: "running" as const, alarm: false, restartEligible: false } : stage;
  });
  const scheduler = classifyScheduler(jobs, isObserved("scheduler"), now, batch);
  const alarm = liveness.some(row => row.alarm) || stages.some(row => row.alarm) || lanes.some(row => row.alarm) || scheduler.alarm;
  const unknown = stages.some(row => row.reason === "unknown_age") || scheduler.reason === "unknown_schedule";
  return { measuredAt: throughput.measuredAt, overall: alarm ? "alarm" as const : unknown ? "unknown" as const : "ok" as const,
    stages, scheduler, liveness, lanes, activeJobs };
}

/**
 * items·draining 의 제작 근거 단계(설계 §4.5, R4). legacy 잡은 GitHub 를 부르지 않고 스캔은 consumer 가 맡으므로
 * crawler 를 재시작해도 고쳐지지 않는다 — 재시작 대상이 아니다(restartEligible false). items 인데 consumer 관측이
 * 2분 넘게 없으면 consumer_missing 경보다(설정상 중지는 그대로 둔다).
 */
function agentScanStage(stage: StageProgress, agentScan: AgentScanModeState, consumerAlive: boolean): StageProgress {
  if (agentScan.mode === "items" && !consumerAlive && stage.reason !== "paused")
    return { ...stage, reason: "consumer_missing", alarm: true, restartEligible: false };
  return { ...stage, restartEligible: false };
}

/**
 * items·draining(from items)의 제작 근거 대상 — consumer 가 맡는 claim 표(active 행)로 센다(설계 §4.5).
 * 대기·최장 대기는 consumer 가 잡을 수 있는 시각(due_at 과 저장소별 retry_after 중 늦은 쪽), 처리·오류는 최신 스캔으로 센다.
 * 스캔 행이 없는 저장소의 실패(처음 보는 저장소의 metadata 404 등)는 잡 커서의 1건이 아니라 claim 행의 실패 기록으로 센다.
 * 시각 열은 모두 시간대 없는 UTC 다.
 */
function agentClaimTargetsSql(): SQL {
  return sql`latest_agent AS (
        SELECT DISTINCT ON (s.repository_key) s.* FROM agent_repository_scans s
        JOIN agent_repository_claims c ON c.repository_key = s.repository_key AND c.state = 'active'
        WHERE s.scope = '' AND s.detector_version = ${AGENT_DETECTOR_VERSION}
        ORDER BY s.repository_key, s.started_at DESC, s.id DESC
      ), agent_targets AS (
        SELECT greatest(c.due_at, c.retry_after) AS due_at, s.state,
          coalesce(${agentLimitedSettledSql(sql`s`)}, false) AS settled,
          coalesce(s.last_error_code, CASE WHEN s.id IS NULL THEN c.last_error_code END) AS error_code,
          s.completed_at, CASE WHEN s.id IS NULL THEN c.last_finished_at ELSE s.started_at END AS started_at,
          s.file_count, s.request_count,
          CASE WHEN s.id IS NULL THEN c.first_failure_at ELSE coalesce(s.completed_at, s.started_at) END AS error_since,
          false AS job_failure
        FROM agent_repository_claims c LEFT JOIN latest_agent s USING (repository_key)
        WHERE c.state = 'active'
      )`;
}

/**
 * 근거 읽기 실행기 — 배포 관문(readWorkerProgress)은 지금처럼 주 DB `db` 를 넘기고,
 * 운영센터 새 숫자는 readReplicaOnly(lib/db) 가 주는 복제본을 넘긴다(운영센터 v8 PR3). SQL·설정은 같다.
 */
export type EvidenceProgressExecutor = Pick<typeof db, "transaction">;

/** Current eligible identities only. Rates count their latest persisted outputs, not ticks, HTTP requests or historical scans. */
export async function evidenceProgress(executor: EvidenceProgressExecutor, settings: CrawlSettings, now: Date, skipUnseen: boolean,
  failure: AgentProviderFailure | null, agentClaims = false): Promise<ProgressStageInput[]> {
  const at = sql`${now.toISOString()}::timestamp`;
  const preScanFailure = sql`d.repository_key = ${failure?.repositoryKey ?? ""}
    AND (s.id IS NULL OR s.started_at <= ${failure?.lastFailureAt ?? now.toISOString()}::timestamp)`;
  const agentTargets = agentClaims ? agentClaimTargetsSql() : sql`agent_inputs AS MATERIALIZED (
        -- Avoid parallel sorted finalization over long keys under the database locale.
        SELECT ${progressRepositoryKeySql(sql`repo_url`, "agent")} AS repository_key, created_at,
          status NOT IN ('seeded','verified') AS requires_daily
        FROM products WHERE status != 'banned' AND repo_url ~ '^https://github.com/[^/]+/[^/#?]+/?$'
        UNION ALL SELECT lower(repo), updated_at, true FROM crawl_candidates WHERE state IN ('new','needs_review','approved')
      ), agent_demand AS (
        SELECT repository_key, min(created_at) AS created_at, bool_or(requires_daily) AS requires_daily
        FROM agent_inputs GROUP BY repository_key
      ), latest_agent AS (
        SELECT DISTINCT ON (s.repository_key) s.* FROM agent_repository_scans s JOIN agent_demand d USING (repository_key)
        WHERE scope = '' AND detector_version = ${AGENT_DETECTOR_VERSION}
        ORDER BY s.repository_key, started_at DESC, id DESC
      ), agent_targets AS (
        SELECT greatest(d.created_at,
          ${agentRefreshDueAtSql(sql`s`, sql`d.requires_daily`, settings.agentEvidence.backgroundRefreshDays, at)}) AS due_at, s.state,
          -- 범위 제한으로 끝난 partial 은 잡이 complete 처럼 주기로만 다시 본다 — 재시도 예약(deferred)으로 세지 않는다
          coalesce(${agentLimitedSettledSql(sql`s`)}, false) AS settled,
          coalesce(s.last_error_code, CASE WHEN ${preScanFailure} THEN ${failure?.code ?? null} END) AS error_code,
          s.completed_at, CASE WHEN ${preScanFailure} THEN ${failure?.lastFailureAt ?? null}::timestamp ELSE s.started_at END AS started_at,
          s.file_count, s.request_count,
          CASE WHEN ${preScanFailure} THEN ${failure?.firstFailureAt ?? null}::timestamp
            ELSE greatest(d.created_at, s.completed_at) END AS error_since,
          -- 잡 커서가 기록한 스캔 전 공급자 실패는 저장소별 재시도 대기가 아니다
          coalesce(${preScanFailure}, false) AS job_failure
        FROM agent_demand d LEFT JOIN latest_agent s USING (repository_key)
      )`;
  const rows = await executor.transaction(async tx => {
    await tx.execute(sql`SET LOCAL jit = off`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<{ key: "evidence" | "agent-evidence" | "ai-level"; waiting: number; oldest: number | null;
      completed: number; progress: number; errors: number; deferred: number; provider_errors: number; error_age: number | null }>(sql`
      WITH ${evidenceSourceTargetCtesSql()}, ${agentTargets}, ai_current AS MATERIALIZED (
        -- Avoid one long-key index probe per target when demand cardinality is underestimated.
        SELECT repository_key, rules_version, next_check_at, checked_at, last_error
        FROM repository_ai_levels WHERE rules_version = ${AI_LEVEL_RULES_VERSION}
      ), ai_public AS MATERIALIZED (
        -- Reuse normalization across the projection, NULL filter and unseen-idle lookup.
        SELECT ${progressRepositoryKeySql(sql`repo_url`, "ai")} AS repository_key, created_at FROM public_products
      ), ai_demand AS (
        SELECT repository_key, min(created_at) AS created_at FROM (
          SELECT p.repository_key, p.created_at FROM ai_public p
          LEFT JOIN ai_current seen ON seen.repository_key = p.repository_key
          WHERE NOT ${skipUnseen} OR seen.repository_key IS NOT NULL
          UNION ALL SELECT lower(repo), updated_at FROM crawl_candidates
            WHERE state IN ('new','needs_review','approved') AND repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
        ) d WHERE repository_key IS NOT NULL GROUP BY repository_key
      ), ai_targets AS (
        SELECT greatest(d.created_at, r.next_check_at) AS due_at, r.checked_at, r.last_error AS error_code,
          greatest(d.created_at, r.checked_at) AS error_since
        FROM ai_demand d LEFT JOIN ai_current r ON r.repository_key = d.repository_key AND r.rules_version = ${AI_LEVEL_RULES_VERSION}
      )
      SELECT 'evidence' AS key,
        count(*) FILTER (WHERE due_at <= ${at})::int AS waiting,
        extract(epoch FROM (${at} - min(due_at) FILTER (WHERE due_at <= ${at}))) / 60 AS oldest,
        count(*) FILTER (WHERE success_at > ${at} - interval '5 minutes' AND success_at <= ${at})::int AS completed,
        count(*) FILTER (WHERE success_at > ${at} - interval '5 minutes' AND success_at <= ${at})::int AS progress,
        count(*) FILTER (WHERE error_code IS NOT NULL AND error_code <> 'budget_exhausted'
          AND failure_at > ${at} - interval '5 minutes' AND failure_at <= ${at})::int AS errors,
        count(*) FILTER (WHERE due_at > ${at} AND error_code IS NOT NULL)::int AS deferred,
        count(*) FILTER (WHERE error_code IN (${sqlTextList(EVIDENCE_PROVIDER_FAILURE_CODES)}))::int AS provider_errors,
        extract(epoch FROM (${at} - min(error_since) FILTER (WHERE error_code IN (${sqlTextList(EVIDENCE_PROVIDER_FAILURE_CODES)})))) / 60 AS error_age
      FROM source_targets
      UNION ALL SELECT 'agent-evidence', count(*) FILTER (WHERE due_at <= ${at})::int,
        extract(epoch FROM (${at} - min(due_at) FILTER (WHERE due_at <= ${at}))) / 60,
        count(*) FILTER (WHERE state = 'complete' AND error_code IS NULL AND completed_at > ${at} - interval '5 minutes' AND completed_at <= ${at})::int,
        count(*) FILTER (WHERE state IN ('partial','complete') AND error_code IS NULL AND (file_count > 0 OR request_count > 0)
          AND started_at > ${at} - interval '5 minutes' AND started_at <= ${at})::int,
        count(*) FILTER (WHERE error_code IS NOT NULL AND error_code NOT IN ('budget_exhausted','alias_recheck_required')
          AND started_at > ${at} - interval '5 minutes' AND started_at <= ${at})::int,
        count(*) FILTER (WHERE due_at > ${at} AND ((state = 'partial' AND NOT settled) OR error_code IS NOT NULL))::int,
        count(*) FILTER (WHERE job_failure OR error_code IN (${sqlTextList(AGENT_PROVIDER_FAILURE_CODES)}))::int,
        extract(epoch FROM (${at} - min(error_since) FILTER (WHERE job_failure OR error_code IN (${sqlTextList(AGENT_PROVIDER_FAILURE_CODES)})))) / 60
      FROM agent_targets
      UNION ALL SELECT 'ai-level', count(*) FILTER (WHERE due_at <= ${at})::int,
        extract(epoch FROM (${at} - min(due_at) FILTER (WHERE due_at <= ${at}))) / 60,
        count(*) FILTER (WHERE error_code IS NULL AND checked_at > ${at} - interval '5 minutes' AND checked_at <= ${at})::int,
        count(*) FILTER (WHERE error_code IS NULL AND checked_at > ${at} - interval '5 minutes' AND checked_at <= ${at})::int,
        0, count(*) FILTER (WHERE due_at > ${at} AND error_code IS NOT NULL)::int,
        -- Repository absence has a normal 72h recheck; retain its deferred demand without claiming a provider outage.
        count(*) FILTER (WHERE error_code IS NOT NULL AND error_code <> 'not_found')::int,
        extract(epoch FROM (${at} - min(error_since) FILTER (WHERE error_code IS NOT NULL AND error_code <> 'not_found'))) / 60
      FROM ai_targets
    `);
  }, { accessMode: "read only" });
  return rows.map(row => ({ key: row.key, enabled: row.key !== "agent-evidence" || settings.agentEvidence.enabled,
    waiting: Number(row.waiting), oldestMinutes: row.oldest === null ? null : Math.max(0, Number(row.oldest)),
    completed5m: Number(row.completed), progress5m: Number(row.progress), errors5m: row.key === "ai-level" ? null : Number(row.errors),
    deferred: Number(row.deferred), providerErrors: Number(row.provider_errors),
    // Estimate age since target creation/last success, not the unavailable first failure timestamp.
    providerErrorMinutes: row.error_age === null ? null : Math.max(0, Number(row.error_age)),
  }));
}

/**
 * Agent/AI collectors carry provider reset times in their existing cursor rather than job.notBefore.
 * 관문과 운영센터가 같은 보정을 쓰도록 나눠 둔다 — 다른 잡과 지난·더 이른 retryAfter 는 그대로 돌려준다.
 */
export function withProviderBackoff<J extends { name: string; notBefore: Date | null; cursor?: unknown }>(jobs: J[], now: Date): J[] {
  return jobs.map(job => {
    if (job.name !== "agent-evidence-refresh" && job.name !== "ai-level-refresh") return job;
    const retryAfter = (job.cursor as { retryAfter?: unknown } | null)?.retryAfter;
    const retry = typeof retryAfter === "string" ? new Date(retryAfter) : null;
    return retry && Number.isFinite(retry.getTime()) && retry > now && (!job.notBefore || retry > job.notBefore)
      ? { ...job, notBefore: retry } : job;
  });
}

export async function readWorkerProgress(now = new Date()) {
  const [settings, jobs, batch, agentScan] = await Promise.all([getSettings(), listJobStates(), readJobBatchMode(), readAgentScanMode(db)]);
  const aiCursor = jobs.find(job => job.name === "ai-level-refresh")?.cursor as { unseenIdleUntil?: unknown } | null;
  const idleUntil = typeof aiCursor?.unseenIdleUntil === "string" ? Date.parse(aiCursor.unseenIdleUntil) : NaN;
  const agentCursor = jobs.find(job => job.name === "agent-evidence-refresh")?.cursor as { providerFailure?: unknown } | null;
  // claim 표로 셀 때는 잡 커서의 스캔 전 실패(legacy 스캔의 기록)를 쓰지 않는다
  const agentClaims = agentScanByClaims(agentScan);
  // 관문은 주 DB 에서 읽는다 — 복제본 지연·장애가 배포·재시작 판정을 바꾸지 않게
  const [throughput, observations, evidence] = await Promise.all([
    pipelineThroughput(settings, now), db.select().from(operationsObservations).where(WITHOUT_JOB_DEFERRALS),
    evidenceProgress(db, settings, now, Number.isFinite(idleUntil) && idleUntil > now.getTime(),
      agentClaims ? null : parseAgentProviderFailure(agentCursor?.providerFailure), agentClaims),
  ]);
  return buildWorkerProgress(throughput, withProviderBackoff(jobs, now), observations, now, batch, evidence, agentScan);
}
