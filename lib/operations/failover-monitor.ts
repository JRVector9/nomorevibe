import { readFailoverReadiness, type ReadinessReport } from './failover-readiness';
import { readWorkerProgress } from './worker-progress-query';
import { readModelCapacityUnknowns, unknownCapacityReport, type CapacityUnknownReport } from './model-capacity-unknowns';

type ProgressReport = Awaited<ReturnType<typeof readWorkerProgress>>;
export type MonitorStatus = {
  measuredAt: string;
  overall: 'ok' | 'unknown' | 'alarm';
  readiness: ReadinessReport | null;
  progress: ProgressReport | null;
  capacityUnknowns?: CapacityUnknownReport;
};

export function combineMonitorStatus(readiness: ReadinessReport | null, progress: ProgressReport | null,
  capacityUnknowns?: CapacityUnknownReport): MonitorStatus {
  const overall = readiness?.overall === 'alarm' || progress?.overall === 'alarm' || capacityUnknowns?.status === 'alarm' ? 'alarm'
    : !readiness || !progress || progress.overall === 'unknown' || capacityUnknowns?.status === 'unknown' ? 'unknown' : 'ok';
  return { measuredAt: new Date().toISOString(), overall, readiness, progress, ...(capacityUnknowns ? { capacityUnknowns } : {}) };
}

export function exitCodeFor(overall: MonitorStatus['overall']): number {
  return overall === 'alarm' ? 2 : overall === 'unknown' ? 1 : 0;
}

export async function readMonitorStatus(): Promise<MonitorStatus> {
  const [readiness, progress, capacity] = await Promise.allSettled([readFailoverReadiness(), readWorkerProgress(), readModelCapacityUnknowns()]);
  return combineMonitorStatus(readiness.status === 'fulfilled' ? readiness.value : null,
    progress.status === 'fulfilled' ? progress.value : null, capacity.status === 'fulfilled' ? capacity.value : unknownCapacityReport());
}
