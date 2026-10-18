import { batchJobsForRole, catalogJobsForBatch, type BatchRole } from '@/lib/jobs/batches';
import type { ThroughputStage } from "./throughput-model";
import { lanesForRole, type JobRole } from "@/lib/jobs/catalog";
import { isPausedJob } from "@/lib/jobs/status";

export type RuntimeLane = {
  name: string; jobs: string[]; state: "idle" | "polling" | "running" | "stopping";
  currentJob: string | null; startedAt: number | null; pollStartedAt: number | null; lastProgressAt: number;
};
export type AgentProviderFailure = { repositoryKey: string; code: "rate_limited" | "timeout" | "unavailable" | "invalid";
  firstFailureAt: string; lastFailureAt: string; failures: number };

/** Bounded metadata in the existing job cursor; arbitrary error bodies never reach monitoring. */
export function parseAgentProviderFailure(value: unknown): AgentProviderFailure | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AgentProviderFailure>;
  const first = typeof row.firstFailureAt === "string" ? Date.parse(row.firstFailureAt) : NaN;
  const last = typeof row.lastFailureAt === "string" ? Date.parse(row.lastFailureAt) : NaN;
  if (typeof row.repositoryKey !== "string" || row.repositoryKey.length > 200 || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(row.repositoryKey)
    || !["rate_limited", "timeout", "unavailable", "invalid"].includes(row.code ?? "")
    || !Number.isFinite(first) || !Number.isFinite(last) || first > last || last > Date.now() + 60_000
    || !Number.isSafeInteger(row.failures) || row.failures! < 1 || row.failures! > 1_000_000) return null;
  return { repositoryKey: row.repositoryKey, code: row.code!, firstFailureAt: new Date(first).toISOString(),
    lastFailureAt: new Date(last).toISOString(), failures: row.failures! };
}

/** IPC/observation metadata contains only catalog names and finite clocks, never arbitrary job payloads. */
export function parseRuntimeLanes(value: unknown, role: string): RuntimeLane[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const allowed = new Set([...batchJobsForRole(role as BatchRole,"legacy"),...batchJobsForRole(role as BatchRole,"versioned")]);
  const names = new Set<string>(), jobs = new Set<string>();
  const clock = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= Date.now() + 60_000;
  const result: RuntimeLane[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") return null;
    const lane = row as Partial<RuntimeLane>;
    if (typeof lane.name !== "string" || names.has(lane.name) || !Array.isArray(lane.jobs) ||
      lane.jobs.length === 0 || lane.jobs.length > 32 || lane.name !== lane.jobs[0] ||
      lane.jobs.some(job => typeof job !== "string" || !allowed.has(job) || jobs.has(job)) ||
      new Set(lane.jobs).size !== lane.jobs.length || !["idle", "polling", "running", "stopping"].includes(lane.state ?? "") ||
      !clock(lane.lastProgressAt) || !(lane.startedAt === null || clock(lane.startedAt)) ||
      !(lane.pollStartedAt === null || clock(lane.pollStartedAt)) ||
      !(lane.currentJob === null || lane.jobs.includes(lane.currentJob ?? "")) ||
      (lane.state === "running" && (lane.currentJob === null || lane.startedAt === null)) ||
      (lane.state === "polling" && lane.pollStartedAt === null) ||
      (lane.state !== "running" && (lane.currentJob !== null || lane.startedAt !== null)) ||
      (lane.state !== "polling" && lane.pollStartedAt !== null)) return null;
    names.add(lane.name); lane.jobs.forEach(job => jobs.add(job));
    result.push({ name: lane.name, jobs: [...lane.jobs], state: lane.state!, currentJob: lane.currentJob!,
      startedAt: lane.startedAt!, pollStartedAt: lane.pollStartedAt!, lastProgressAt: lane.lastProgressAt });
  }
  return result;
}

export function laneForJob(role: BatchRole, job: string): string {
  return lanesForRole(role as JobRole).find(lane => lane.includes(job))?.[0] ?? job;
}

export function runtimeLaneStall(lane: RuntimeLane, now: number, limits: { progressMs: number; jobMs: number }): string | null {
  if (lane.state === "stopping") return null;
  if (lane.state === "polling" && lane.pollStartedAt !== null && now - lane.pollStartedAt > limits.progressMs) return "lane_poll_timeout";
  if (lane.state === "running" && lane.startedAt !== null && now - lane.startedAt > limits.jobMs) return "job_timeout";
  if (lane.state === "idle" && now - lane.lastProgressAt > limits.progressMs) return "lane_progress_timeout";
  return null;
}

export type ProgressReason = "paused" | "no_work" | "progressing" | "running" | "backoff" |
  "upstream_or_job_error" | "upstream_stalled" | "unknown_age" | "warming_up" | "worker_missing" | "no_progress" | "manual_attention";
export type ProgressStageKey = ThroughputStage["key"] | "evidence" | "agent-evidence" | "ai-level" | "uptime";
/** 보강 근거 단계 이름 — 새 화면 요소에 "쉬운 말(코드)"로 쓴다(운영센터 v8). 지금 화면 글자는 그대로 둔다 */
export const EVIDENCE_STAGE_LABELS = {
  evidence: "제품 근거(evidence)",
  "agent-evidence": "개발 AI 근거(agent-evidence)",
  "ai-level": "AI 제작 단계(ai-level)",
} as const satisfies Record<Extract<ProgressStageKey, "evidence" | "agent-evidence" | "ai-level">, string>;
export type ProgressStageInput = Omit<Pick<ThroughputStage, "key" | "enabled" | "waiting" | "oldestMinutes" | "completed5m" | "progress5m" | "errors5m" | "manualAttention">, "key"> & {
  key: ProgressStageKey; deferred?: number; providerErrors?: number; providerErrorMinutes?: number | null;
  /** 일감이 있어도 정책이 일부러 쉬게 한 상태(응답 점검 split 의 home 차단기 열림) — 재시작으로 고칠 수 없는 대기다 */
  held?: boolean;
};
export type StageProgress = { role: "crawler" | "reviewer" | "publisher" | "maintenance"; stage: ProgressStageKey;
  reason: ProgressReason; alarm: boolean; restartEligible?: boolean; manualAttention?: number;
  job?: string; lane?: string; waiting?: number; oldestMinutes?: number | null; completed5m?: number;
  progress5m?: number | null; errors5m?: number | null; deferred?: number; providerErrors?: number; providerErrorMinutes?: number | null;
  held?: boolean };

/** 단계를 처리하는 역할 — 응답 점검(uptime, split claims 모드에서만 보고)은 maintenance 다 */
export function progressStageRole(key: ProgressStageKey): StageProgress["role"] {
  return ["fetch", "evidence", "agent-evidence", "ai-level"].includes(key) ? "crawler" : key === "publish" ? "publisher"
    : key === "uptime" ? "maintenance" : "reviewer";
}

export function classifyStage(
  stage: ProgressStageInput,
  job: { notBefore: Date | null; lastError?: string | null } | null,
  observed: boolean,
  now: Date,
): StageProgress {
  let reason: ProgressReason;
  const deferred = ["evidence", "agent-evidence", "ai-level"].includes(stage.key) ? stage.deferred ?? 0 : 0;
  const errors = Math.max(stage.providerErrors ?? 0, stage.errors5m ?? 0) + (job?.lastError ? 1 : 0);
  if (!stage.enabled || isPausedJob(job ?? undefined, now.getTime())) reason = "paused";
  else if (stage.waiting === 0 && !deferred) reason = (stage.manualAttention ?? 0) > 0 ? "manual_attention" : "no_work";
  else if ((stage.progress5m ?? stage.completed5m) > 0) reason = "progressing";
  // Alert on aged demand plus recorded provider failures even during its retry delay. A restart cannot repair credentials or an upstream outage.
  else if ((stage.providerErrorMinutes ?? stage.oldestMinutes ?? 0) >= 30 && errors > 0) reason = "upstream_stalled";
  else if (job?.notBefore && job.notBefore > now) reason = "backoff";
  else if (errors > 0) reason = "upstream_or_job_error";
  else if (stage.held) reason = "backoff";
  else if (stage.waiting === 0 && deferred > 0) reason = "backoff";
  else if (stage.oldestMinutes === null) reason = "unknown_age";
  else if (stage.oldestMinutes < (stage.key === "judge" ? 15 : stage.key === "publish" ? 10 : 5)) reason = "warming_up";
  else reason = observed ? "no_progress" : "worker_missing";
  return { role: progressStageRole(stage.key), stage: stage.key,
    reason, alarm: reason === "no_progress" || reason === "worker_missing" || reason === "upstream_stalled",
    restartEligible: reason === "no_progress", manualAttention: stage.manualAttention ?? 0 };
}

export type SchedulerReason = "scheduled" | "unknown_schedule" | "worker_missing" | "scheduler_missed";
export type SchedulerProgress = { role: "scheduler"; reason: SchedulerReason; alarm: boolean; overdueJobs: string[] };

export function classifyLiveness(role: "scheduler" | "crawler" | "reviewer" | "publisher" | "maintenance" | "text", observedAt: Date | null, now: Date,
  restartCount5m = 0) {
  const missing = !observedAt || now.getTime() - observedAt.getTime() > 45_000;
  const reason = missing ? "worker_missing" as const : restartCount5m >= 3 ? "restart_loop" as const : "present" as const;
  return { role, reason, alarm: reason !== "present" };
}

export function classifyScheduler(
  jobs: Array<{ name: string; nextScheduledAt: Date | null; notBefore: Date | null }>,
  observed: boolean,
  now: Date,
  batch: { mode: string; writerContractVersion: number },
): SchedulerProgress {
  // 지금 batch 상태에서 scheduler 가 일정을 미는 잡만 본다(requestDueJobs 의 scheduledJobs 와 같은 기준).
  // legacy 에서도 근거 새로 고침이 versioned 전용 잡 행을 요청해 두므로, 그 행의 빈 예약을 '예약 모름'으로 세지 않는다.
  const intervals = new Map(catalogJobsForBatch(batch).filter(job => job.intervalMs !== null)
    .map(job => [job.name, job.intervalMs!]));
  const relevant = jobs.filter(job => intervals.has(job.name) &&
    !(job.name === "product-intro-check" && job.notBefore && job.notBefore > now));
  const overdueJobs = relevant.filter(job => job.nextScheduledAt &&
    now.getTime() - job.nextScheduledAt.getTime() > 2 * intervals.get(job.name)!).map(job => job.name);
  const reason: SchedulerReason = overdueJobs.length ? "scheduler_missed"
    : relevant.some(job => !job.nextScheduledAt) || relevant.length === 0 ? "unknown_schedule"
      : observed ? "scheduled" : "worker_missing";
  return { role: "scheduler", reason, alarm: reason === "scheduler_missed" || reason === "worker_missing", overdueJobs };
}
