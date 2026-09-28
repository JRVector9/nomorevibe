import type { ThroughputStage } from "./throughput-model";
import { JOB_CATALOG } from "@/lib/jobs/catalog";

export type ProgressReason = "paused" | "no_work" | "progressing" | "backoff" |
  "upstream_or_job_error" | "unknown_age" | "warming_up" | "worker_missing" | "no_progress";
export type StageProgress = { role: "crawler" | "reviewer"; stage: ThroughputStage["key"];
  reason: ProgressReason; alarm: boolean };

export function classifyStage(
  stage: Pick<ThroughputStage, "key" | "enabled" | "waiting" | "oldestMinutes" | "completed5m" | "progress5m" | "errors5m">,
  job: { notBefore: Date | null } | null,
  observed: boolean,
  now: Date,
): StageProgress {
  let reason: ProgressReason;
  if (!stage.enabled) reason = "paused";
  else if (stage.waiting === 0) reason = "no_work";
  else if ((stage.progress5m ?? stage.completed5m) > 0) reason = "progressing";
  else if (job?.notBefore && job.notBefore > now) reason = "backoff";
  else if (stage.errors5m !== null && stage.errors5m > 0) reason = "upstream_or_job_error";
  else if (stage.oldestMinutes === null) reason = "unknown_age";
  else if (stage.oldestMinutes < (stage.key === "judge" ? 15 : 5)) reason = "warming_up";
  else reason = observed ? "no_progress" : "worker_missing";
  return { role: stage.key === "fetch" ? "crawler" : "reviewer", stage: stage.key,
    reason, alarm: reason === "no_progress" || reason === "worker_missing" };
}

export type SchedulerReason = "scheduled" | "unknown_schedule" | "worker_missing" | "scheduler_missed";
export type SchedulerProgress = { role: "scheduler"; reason: SchedulerReason; alarm: boolean; overdueJobs: string[] };

export function classifyLiveness(role: "scheduler" | "crawler" | "reviewer", observedAt: Date | null, now: Date,
  restartCount5m = 0) {
  const missing = !observedAt || now.getTime() - observedAt.getTime() > 45_000;
  const reason = missing ? "worker_missing" as const : restartCount5m >= 3 ? "restart_loop" as const : "present" as const;
  return { role, reason, alarm: reason !== "present" };
}

export function classifyScheduler(
  jobs: Array<{ name: string; nextScheduledAt: Date | null; notBefore: Date | null }>,
  observed: boolean,
  now: Date,
): SchedulerProgress {
  const intervals = new Map(JOB_CATALOG.filter(job => job.intervalMs !== null)
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
