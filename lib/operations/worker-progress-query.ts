import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { operationsObservations } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { listJobStates } from "@/lib/jobs/runner";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { AGENT_DETECTOR_VERSION } from "@/lib/domain/evidence/agents/types";
import { AI_LEVEL_RULES_VERSION } from "@/lib/domain/evidence/ai-level-labels";
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
export type WorkerProgressReport = { measuredAt: string; overall: "alarm" | "unknown" | "ok";
  stages: StageProgress[]; scheduler: ReturnType<typeof classifyScheduler>; liveness: ReturnType<typeof classifyLiveness>[];
  /** Optional for readers/fixtures written before lane metadata was introduced. */
  lanes?: WorkerLaneProgress[]; activeJobs?: string[] };

export function buildWorkerProgress(
  throughput: ThroughputSnapshot,
  jobs: ProgressJob[],
  observations: Array<{ key: string; value: Record<string, unknown>; observedAt: Date | string }>,
  now: Date,
  evidence: ProgressStageInput[] = [],
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
  const states = new Map(jobs.map(job => [job.name, job]));
  const classified: StageProgress[] = [...throughput.stages, ...evidence].map(stage => {
    const job = states.get(jobForStage[stage.key]);
    const result = classifyStage(stage, job ?? null, isObserved(["fetch", "evidence", "agent-evidence", "ai-level"].includes(stage.key)
      ? "crawler" : stage.key === "publish" ? "publisher" : "reviewer"), now);
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
  const scheduler = classifyScheduler(jobs, isObserved("scheduler"), now);
  const alarm = liveness.some(row => row.alarm) || stages.some(row => row.alarm) || lanes.some(row => row.alarm) || scheduler.alarm;
  const unknown = stages.some(row => row.reason === "unknown_age") || scheduler.reason === "unknown_schedule";
  return { measuredAt: throughput.measuredAt, overall: alarm ? "alarm" as const : unknown ? "unknown" as const : "ok" as const,
    stages, scheduler, liveness, lanes, activeJobs };
}

/** Current eligible identities only. Rates count their latest persisted outputs, not ticks, HTTP requests or historical scans. */
async function evidenceProgress(settings: CrawlSettings, now: Date, skipUnseen: boolean, failure: AgentProviderFailure | null): Promise<ProgressStageInput[]> {
  const at = sql`${now.toISOString()}::timestamp`;
  const preScanFailure = sql`d.repository_key = ${failure?.repositoryKey ?? ""}
    AND (s.id IS NULL OR s.started_at <= ${failure?.lastFailureAt ?? now.toISOString()}::timestamp)`;
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL jit = off`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<{ key: "evidence" | "agent-evidence" | "ai-level"; waiting: number; oldest: number | null;
      completed: number; progress: number; errors: number; deferred: number; provider_errors: number; error_age: number | null }>(sql`
      WITH public_products AS MATERIALIZED (
        SELECT slug, url, repo_url, created_at, updated_at FROM products WHERE status IN ('seeded','verified')
      ), source_targets AS (
        SELECT greatest(l.created_at, s.created_at, s.next_attempt_at) AS due_at,
          CASE WHEN s.source_url = l.url THEN s.last_success_at END AS success_at,
          CASE WHEN s.source_url = l.url THEN s.last_failure_at END AS failure_at,
          CASE WHEN s.source_url = l.url THEN s.last_error_code END AS error_code,
          greatest(l.created_at, s.created_at, s.last_success_at) AS error_since
        FROM public_products p JOIN product_links l ON l.slug = p.slug AND l.visible
        LEFT JOIN product_evidence_sources s ON s.slug = l.slug AND s.kind = l.kind AND s.source_key = l.normalized_key
        UNION ALL
        SELECT CASE WHEN s.id IS NOT NULL AND s.source_url IS DISTINCT FROM p.url THEN p.updated_at
            ELSE greatest(p.created_at, s.created_at, s.next_attempt_at) END,
          CASE WHEN s.source_url = p.url THEN s.last_success_at END,
          CASE WHEN s.source_url = p.url THEN s.last_failure_at END,
          CASE WHEN s.source_url = p.url THEN s.last_error_code END,
          greatest(p.created_at, s.created_at, s.last_success_at)
        FROM public_products p JOIN product_evidence_sources s ON s.slug = p.slug
          AND s.provider = 'product_site' AND s.source_key = 'canonical_site'
      ), agent_demand AS (
        SELECT repository_key, min(created_at) AS created_at FROM (
          SELECT lower(substring(repo_url from '^https://github[.]com/([^/]+/[^/#?]+?)([.]git)?/?$')) AS repository_key, created_at
          FROM products WHERE status != 'banned' AND repo_url ~ '^https://github.com/[^/]+/[^/#?]+/?$'
          UNION ALL SELECT lower(repo), updated_at FROM crawl_candidates WHERE state IN ('new','needs_review','approved')
        ) d GROUP BY repository_key
      ), latest_agent AS (
        SELECT DISTINCT ON (s.repository_key) s.* FROM agent_repository_scans s JOIN agent_demand d USING (repository_key)
        WHERE scope = '' AND detector_version = ${AGENT_DETECTOR_VERSION}
        ORDER BY s.repository_key, started_at DESC, id DESC
      ), agent_targets AS (
        SELECT greatest(d.created_at, s.next_attempt_at) AS due_at, s.state,
          coalesce(s.last_error_code, CASE WHEN ${preScanFailure} THEN ${failure?.code ?? null} END) AS error_code,
          s.completed_at, CASE WHEN ${preScanFailure} THEN ${failure?.lastFailureAt ?? null}::timestamp ELSE s.started_at END AS started_at,
          s.file_count, s.request_count,
          CASE WHEN ${preScanFailure} THEN ${failure?.firstFailureAt ?? null}::timestamp
            ELSE greatest(d.created_at, s.completed_at) END AS error_since
        FROM agent_demand d LEFT JOIN latest_agent s USING (repository_key)
      ), ai_public AS MATERIALIZED (
        -- Reuse normalization across the projection, NULL filter and unseen-idle lookup.
        SELECT substring(regexp_replace(regexp_replace(lower(rtrim(repo_url, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')
          from '^https://github[.]com/([^/]+/[^/#?]+)$') AS repository_key, created_at FROM public_products
      ), ai_demand AS (
        SELECT repository_key, min(created_at) AS created_at FROM (
          SELECT repository_key, created_at FROM ai_public p WHERE NOT ${skipUnseen} OR EXISTS (
            SELECT 1 FROM repository_ai_levels r WHERE r.repository_key = p.repository_key AND r.rules_version = ${AI_LEVEL_RULES_VERSION})
          UNION ALL SELECT lower(repo), updated_at FROM crawl_candidates
            WHERE state IN ('new','needs_review','approved') AND repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
        ) d WHERE repository_key IS NOT NULL GROUP BY repository_key
      ), ai_targets AS (
        SELECT greatest(d.created_at, r.next_check_at) AS due_at, r.checked_at, r.last_error AS error_code,
          greatest(d.created_at, r.checked_at) AS error_since
        FROM ai_demand d LEFT JOIN repository_ai_levels r ON r.repository_key = d.repository_key AND r.rules_version = ${AI_LEVEL_RULES_VERSION}
      )
      SELECT 'evidence' AS key,
        count(*) FILTER (WHERE due_at <= ${at})::int AS waiting,
        extract(epoch FROM (${at} - min(due_at) FILTER (WHERE due_at <= ${at}))) / 60 AS oldest,
        count(*) FILTER (WHERE success_at > ${at} - interval '5 minutes' AND success_at <= ${at})::int AS completed,
        count(*) FILTER (WHERE success_at > ${at} - interval '5 minutes' AND success_at <= ${at})::int AS progress,
        count(*) FILTER (WHERE error_code IS NOT NULL AND error_code <> 'budget_exhausted'
          AND failure_at > ${at} - interval '5 minutes' AND failure_at <= ${at})::int AS errors,
        count(*) FILTER (WHERE due_at > ${at} AND error_code IS NOT NULL)::int AS deferred,
        count(*) FILTER (WHERE error_code IS NOT NULL AND error_code <> 'budget_exhausted')::int AS provider_errors,
        extract(epoch FROM (${at} - min(error_since) FILTER (WHERE error_code IS NOT NULL AND error_code <> 'budget_exhausted'))) / 60 AS error_age
      FROM source_targets
      UNION ALL SELECT 'agent-evidence', count(*) FILTER (WHERE due_at <= ${at})::int,
        extract(epoch FROM (${at} - min(due_at) FILTER (WHERE due_at <= ${at}))) / 60,
        count(*) FILTER (WHERE state = 'complete' AND error_code IS NULL AND completed_at > ${at} - interval '5 minutes' AND completed_at <= ${at})::int,
        count(*) FILTER (WHERE state IN ('partial','complete') AND error_code IS NULL AND (file_count > 0 OR request_count > 0)
          AND started_at > ${at} - interval '5 minutes' AND started_at <= ${at})::int,
        count(*) FILTER (WHERE error_code IS NOT NULL AND error_code NOT IN ('budget_exhausted','alias_recheck_required')
          AND started_at > ${at} - interval '5 minutes' AND started_at <= ${at})::int,
        count(*) FILTER (WHERE due_at > ${at} AND (state = 'partial' OR error_code IS NOT NULL))::int,
        count(*) FILTER (WHERE error_code IS NOT NULL AND error_code NOT IN ('budget_exhausted','alias_recheck_required'))::int,
        extract(epoch FROM (${at} - min(error_since) FILTER (WHERE error_code IS NOT NULL AND error_code NOT IN ('budget_exhausted','alias_recheck_required')))) / 60
      FROM agent_targets
      UNION ALL SELECT 'ai-level', count(*) FILTER (WHERE due_at <= ${at})::int,
        extract(epoch FROM (${at} - min(due_at) FILTER (WHERE due_at <= ${at}))) / 60,
        count(*) FILTER (WHERE error_code IS NULL AND checked_at > ${at} - interval '5 minutes' AND checked_at <= ${at})::int,
        count(*) FILTER (WHERE error_code IS NULL AND checked_at > ${at} - interval '5 minutes' AND checked_at <= ${at})::int,
        0, count(*) FILTER (WHERE due_at > ${at} AND error_code IS NOT NULL)::int, count(*) FILTER (WHERE error_code IS NOT NULL)::int,
        extract(epoch FROM (${at} - min(error_since) FILTER (WHERE error_code IS NOT NULL))) / 60
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

export async function readWorkerProgress(now = new Date()) {
  const [settings, jobs] = await Promise.all([getSettings(), listJobStates()]);
  const aiCursor = jobs.find(job => job.name === "ai-level-refresh")?.cursor as { unseenIdleUntil?: unknown } | null;
  const idleUntil = typeof aiCursor?.unseenIdleUntil === "string" ? Date.parse(aiCursor.unseenIdleUntil) : NaN;
  const agentCursor = jobs.find(job => job.name === "agent-evidence-refresh")?.cursor as { providerFailure?: unknown } | null;
  const [throughput, observations, evidence] = await Promise.all([
    pipelineThroughput(settings, now), db.select().from(operationsObservations),
    evidenceProgress(settings, now, Number.isFinite(idleUntil) && idleUntil > now.getTime(), parseAgentProviderFailure(agentCursor?.providerFailure)),
  ]);
  // Agent/AI collectors carry provider reset times in their existing cursor rather than job.notBefore.
  const withBackoff = jobs.map(job => {
    if (job.name !== "agent-evidence-refresh" && job.name !== "ai-level-refresh") return job;
    const retryAfter = (job.cursor as { retryAfter?: unknown } | null)?.retryAfter;
    const retry = typeof retryAfter === "string" ? new Date(retryAfter) : null;
    return retry && Number.isFinite(retry.getTime()) && retry > now && (!job.notBefore || retry > job.notBefore)
      ? { ...job, notBefore: retry } : job;
  });
  return buildWorkerProgress(throughput, withBackoff, observations, now, evidence);
}
