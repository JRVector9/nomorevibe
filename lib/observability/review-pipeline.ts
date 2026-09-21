import { randomUUID } from "node:crypto";
import { logger } from "./logger";

type Stage = "first" | "second" | "publish" | "judge" | "text";
type Fields = {
  stage: Stage; candidateId?: number; firstAttemptId?: number; secondReviewId?: number;
  sourceRevisionHash?: string; generationKey?: string; provider?: string; model?: string;
  job?: string; runId?: string; callId?: string; durationMs?: number; waitMs?: number;
  ok?: boolean; error?: string; state?: string; nextJob?: string; requestedVersion?: number;
};
type Sink = (event: string, fields: Record<string, unknown>) => void;
const ALLOWED = new Set("stage candidateId firstAttemptId secondReviewId sourceRevisionHash generationKey provider model job runId callId durationMs waitMs ok error state nextJob requestedVersion".split(" "));

/** Best-effort telemetry: never let logging retry a model or roll back a committed decision. */
export function emitPipelineEvent(kind: string, fields: Fields, sink: Sink = logger.info): void {
  try {
    const safe = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
      ALLOWED.has(key) && (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))));
    sink("review.pipeline", { version: 1, kind, at: new Date().toISOString(), clock: "application_utc", ...safe });
  } catch { /* Missing logs remain unknown in the report. */ }
}

/** Measures the existing provider adapter (including response parsing), excluding DB preparation/save. */
export async function measureReviewCall<T extends { ok: boolean; error?: string }>(
  fields: Fields, call: () => Promise<T>, sink: Sink = logger.info,
): Promise<T> {
  const context = { ...fields, callId: randomUUID() };
  emitPipelineEvent("model_start", context, sink);
  const started = performance.now();
  try {
    const result = await call();
    emitPipelineEvent("model_end", { ...context, durationMs: performance.now() - started,
      ok: result.ok, ...(!result.ok ? { error: result.error } : {}) }, sink);
    return result;
  } catch (error) {
    emitPipelineEvent("model_end", { ...context, durationMs: performance.now() - started, ok: false, error: "adapter_exception" }, sink);
    throw error;
  }
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  const percentile = (p: number) => values.length ? values[Math.ceil(p * values.length) - 1] : null;
  return { samples: values.length, p50: percentile(.5), p95: percentile(.95) };
}
export function summarizePipelineEvents(events: Record<string, unknown>[]) {
  let clockAnomalies = 0;
  const stages = Object.fromEntries((["first", "second", "publish", "judge", "text"] as const).map(stage => {
    const rows = events.filter(row => row.version === 1 && row.stage === stage);
    const ends = new Map<string, Record<string, unknown>>();
    const waits: number[] = [];
    for (const row of rows) {
      if (typeof row.durationMs === "number" && row.durationMs < 0 || typeof row.waitMs === "number" && row.waitMs < 0) { clockAnomalies++; continue; }
      if (row.kind === "model_end" && typeof row.callId === "string" && typeof row.durationMs === "number" && Number.isFinite(row.durationMs)) ends.set(row.callId, row);
      if (row.kind === "queue" && typeof row.waitMs === "number" && Number.isFinite(row.waitMs)) waits.push(row.waitMs);
    }
    const started = new Set(rows.filter(row => row.kind === "model_start" && typeof row.callId === "string").map(row => row.callId as string));
    return [stage, { calls: ends.size, failed: [...ends.values()].filter(row => row.ok === false).length,
      reused: rows.filter(row => row.kind === "reused").length,
      committed: rows.filter(row => row.kind === "committed").length,
      incomplete: [...started].filter(id => !ends.has(id)).length,
      modelMs: distribution([...ends.values()].map(row => row.durationMs as number)), queueMs: distribution(waits) }];
  })) as Record<Stage, { calls: number; failed: number; reused: number; committed: number; incomplete: number; modelMs: ReturnType<typeof distribution>; queueMs: ReturnType<typeof distribution> }>;
  return { ...stages, clockAnomalies, clock: "application_utc; queue timestamps originate in DB; host skew not corrected", unobserved: "unknown" };
}
