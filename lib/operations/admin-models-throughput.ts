/** Only settled ledger rows with real start/end timestamps form the sample. Queue time is included. */
export type ModelCompletion = {
  routeId: string; provider: string; model: string; state: string;
  queuedAt: string; settledAt: string | null; responseOk: boolean | null;
};
export type Throughput = {
  count: number; medianMs: number | null; p90Ms: number | null;
  perHour: number | null; failureRate: number | null; classified: number;
};
export type ThroughputWindows = { hour: Throughput; day: Throughput };
export type ModelThroughput = { byModel: Record<string, ThroughputWindows>; byStage: Record<string, ThroughputWindows> };
export const throughputModelKey = (row: { provider: string; model: string }) => JSON.stringify([row.provider, row.model]);

/** Linear median and nearest-rank p90 (ceil(.9*n), 1-based); no fictitious zero for empty samples. */
export function calculateThroughput(rows: readonly ModelCompletion[], observedAt: string, hours: 1 | 24): Throughput {
  const end = Date.parse(observedAt), start = end - hours * 3_600_000;
  const sample = rows.filter(row => {
    const at = Date.parse(row.queuedAt), done = row.settledAt ? Date.parse(row.settledAt) : NaN;
    return row.state === "settled" && Number.isFinite(at) && done >= start && done <= end && done >= at;
  });
  const durations = sample.map(row => Date.parse(row.settledAt!) - Date.parse(row.queuedAt)).sort((a, b) => a - b);
  const n = durations.length, classified = sample.filter(row => row.responseOk !== null).length;
  return { count: n, medianMs: n ? (durations[Math.floor((n - 1) / 2)] + durations[Math.floor(n / 2)]) / 2 : null,
    p90Ms: n ? durations[Math.ceil(n * .9) - 1] : null, perHour: n ? n / hours : null,
    failureRate: classified ? sample.filter(row => row.responseOk === false).length / classified : null, classified };
}
export function buildModelThroughput(rows: readonly ModelCompletion[], observedAt: string): ModelThroughput {
  const group = (key: (row: ModelCompletion) => string) => {
    const groups = new Map<string, ModelCompletion[]>();
    for (const row of rows) { const id = key(row); groups.set(id, [...(groups.get(id) ?? []), row]); }
    return Object.fromEntries([...groups].map(([id, sample]) => [id, {
      hour: calculateThroughput(sample, observedAt, 1), day: calculateThroughput(sample, observedAt, 24),
    }]));
  };
  return { byModel: group(throughputModelKey), byStage: group(row => row.routeId) };
}
