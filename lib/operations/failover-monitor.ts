import { readFailoverReadiness, type ReadinessReport } from './failover-readiness';
import { readWorkerProgress } from './worker-progress-query';
import { readModelCapacityUnknowns, unknownCapacityReport, type CapacityUnknownReport } from './model-capacity-unknowns';
import { readDiscoveryMonitor, type DiscoveryMonitorReport } from './discovery-monitor';

type ProgressReport = Awaited<ReturnType<typeof readWorkerProgress>>;
export type MonitorStatus = {
  measuredAt: string;
  overall: 'ok' | 'unknown' | 'alarm';
  readiness: ReadinessReport | null;
  progress: ProgressReport | null;
  capacityUnknowns?: CapacityUnknownReport;
  discovery?: DiscoveryMonitorReport;
};

/**
 * 2026-10-31: 모델 장부의 `review`(확인 못함 · 사람 검토)는 overall 에 들어가지 않는다 — 일을 멈추지 않으므로 경보·DOWN 이 아니다.
 * overall 을 alarm 으로 만드는 장부 상태는 `alarm`(검토 적체 문턱 초과·기한 넘긴 점유 행)뿐이고, 장부를 읽지 못하면 unknown 이다.
 */
export function combineMonitorStatus(readiness: ReadinessReport | null, progress: ProgressReport | null,
  capacityUnknowns?: CapacityUnknownReport, discovery?: DiscoveryMonitorReport): MonitorStatus {
  const overall = readiness?.overall === 'alarm' || progress?.overall === 'alarm' || capacityUnknowns?.status === 'alarm' || discovery?.overall === 'alarm' ? 'alarm'
    : !readiness || !progress || progress.overall === 'unknown' || capacityUnknowns?.status === 'unknown' || discovery?.overall === 'unknown' ? 'unknown' : 'ok';
  return { measuredAt: new Date().toISOString(), overall, readiness, progress, ...(capacityUnknowns ? { capacityUnknowns } : {}), ...(discovery ? { discovery } : {}) };
}

export function exitCodeFor(overall: MonitorStatus['overall']): number {
  return overall === 'alarm' ? 2 : overall === 'unknown' ? 1 : 0;
}

export async function readMonitorStatus(): Promise<MonitorStatus> {
  const [readiness, progress, capacity, discovery] = await Promise.allSettled([readFailoverReadiness(), readWorkerProgress(), readModelCapacityUnknowns(), readDiscoveryMonitor()]);
  return combineMonitorStatus(readiness.status === 'fulfilled' ? readiness.value : null,
    progress.status === 'fulfilled' ? progress.value : null, capacity.status === 'fulfilled' ? capacity.value : unknownCapacityReport(),
    discovery.status === 'fulfilled' ? discovery.value : { at: new Date().toISOString(), overall: 'unknown', failures: { v: 1, covered: [], failures: [] } });
}
