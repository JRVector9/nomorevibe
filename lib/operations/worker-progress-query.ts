import { db } from "@/lib/db";
import { operationsObservations } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import { listJobStates } from "@/lib/jobs/runner";
import { latestServiceInstance, serviceInstancesFromObservations } from "./instance";
import { pipelineThroughput } from "./throughput";
import type { ThroughputSnapshot } from "./throughput-model";
import { classifyLiveness, classifyScheduler, classifyStage, type StageProgress } from "./worker-progress";

export function buildWorkerProgress(
  throughput: ThroughputSnapshot,
  jobs: Array<{ name: string; nextScheduledAt: Date | null; notBefore: Date | null }>,
  observations: Array<{ key: string; value: Record<string, unknown>; observedAt: Date | string }>,
  now: Date,
) {
  const instances = serviceInstancesFromObservations(observations);
  const liveness = (["scheduler", "crawler", "reviewer"] as const).map(role => {
    const instance = latestServiceInstance(instances, role);
    const observedAt = instance && (instance.value.status === "running" || instance.value.status === "starting")
      ? instance.observedAt instanceof Date ? instance.observedAt : new Date(instance.observedAt) : null;
    return classifyLiveness(role, observedAt, now,
      typeof instance?.value.restartCount5m === "number" ? instance.value.restartCount5m : 0);
  });
  const isObserved = (role: "scheduler" | "crawler" | "reviewer") =>
    liveness.some(row => row.role === role && !row.alarm);
  const states = new Map(jobs.map(job => [job.name, job]));
  const jobForStage = { fetch: "crawl-fetch", judge: "crawl-judge", first: "crawl-agent-review",
    second: "second-review" } as const;
  const stages: StageProgress[] = throughput.stages.flatMap(stage => {
    if (stage.key === "publish") return [];
    const job = states.get(jobForStage[stage.key]);
    const role = stage.key === "fetch" ? "crawler" : "reviewer";
    return [classifyStage(stage, job ?? null, isObserved(role), now)];
  });
  const scheduler = classifyScheduler(jobs, isObserved("scheduler"), now);
  const alarm = liveness.some(row => row.alarm) || stages.some(row => row.alarm) || scheduler.alarm;
  const unknown = stages.some(row => row.reason === "unknown_age") || scheduler.reason === "unknown_schedule";
  return { measuredAt: throughput.measuredAt, overall: alarm ? "alarm" as const : unknown ? "unknown" as const : "ok" as const,
    stages, scheduler, liveness };
}

export async function readWorkerProgress(now = new Date()) {
  const settings = await getSettings();
  const [throughput, jobs, observations] = await Promise.all([
    pipelineThroughput(settings, now), listJobStates(), db.select().from(operationsObservations),
  ]);
  return buildWorkerProgress(throughput, jobs, observations, now);
}
