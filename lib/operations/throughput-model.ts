export type ThroughputStatus = "paused" | "stalled" | "backlog" | "processing" | "idle";

export type ThroughputStage = {
  key: "fetch" | "judge" | "first" | "second" | "publish";
  label: string;
  unit: "건" | "표";
  completed1m: number;
  completed5m: number;
  /** Queue progress can include rule decisions or reused AI results. */
  progress5m?: number;
  waiting: number;
  oldestMinutes: number | null;
  ageLabel?: string;
  enabled: boolean;
  /** Last stored errors, not a complete history of failed calls. Null = unavailable. */
  errors5m: number | null;
  queueNote: string;
  detail: string;
  status: ThroughputStatus;
};

export type ThroughputSnapshot = { measuredAt: string; stages: ThroughputStage[] };

/** A one-minute zero is normal for scheduled/batched work; require an aged queue. */
export function throughputStatus(stage: Pick<ThroughputStage,
  "enabled" | "waiting" | "oldestMinutes" | "completed5m" | "progress5m">): ThroughputStatus {
  if (!stage.enabled) return "paused";
  const progress = stage.progress5m ?? stage.completed5m;
  if (stage.waiting > 0 && stage.oldestMinutes !== null && stage.oldestMinutes >= 5) {
    if (progress === 0) return "stalled";
    if (stage.waiting > progress / 5 * 30) return "backlog";
  }
  return progress > 0 ? "processing" : "idle";
}
