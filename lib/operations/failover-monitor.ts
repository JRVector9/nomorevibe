import { readFailoverReadiness, type ReadinessReport } from './failover-readiness';
import { readWorkerProgress } from './worker-progress-query';

type ProgressReport = Awaited<ReturnType<typeof readWorkerProgress>>;
export type MonitorStatus = {
  measuredAt: string;
  overall: 'ok' | 'unknown' | 'alarm';
  readiness: ReadinessReport | null;
  progress: ProgressReport | null;
};

export function combineMonitorStatus(readiness: ReadinessReport | null, progress: ProgressReport | null): MonitorStatus {
  const overall = readiness?.overall === 'alarm' || progress?.overall === 'alarm' ? 'alarm'
    : !readiness || !progress || progress.overall === 'unknown' ? 'unknown' : 'ok';
  return { measuredAt: new Date().toISOString(), overall, readiness, progress };
}

export function exitCodeFor(overall: MonitorStatus['overall']): number {
  return overall === 'alarm' ? 2 : overall === 'unknown' ? 1 : 0;
}

export async function readMonitorStatus(): Promise<MonitorStatus> {
  const [readiness, progress] = await Promise.allSettled([readFailoverReadiness(), readWorkerProgress()]);
  return combineMonitorStatus(readiness.status === 'fulfilled' ? readiness.value : null,
    progress.status === 'fulfilled' ? progress.value : null);
}
