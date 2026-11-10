import { readFailoverReadiness, type ReadinessReport } from './failover-readiness';
import { readWorkerProgress } from './worker-progress-query';
import { capacityReviewOnlyAlarm, readModelCapacityUnknowns, unknownCapacityReport, type CapacityUnknownReport } from './model-capacity-unknowns';

type ProgressReport = Awaited<ReturnType<typeof readWorkerProgress>>;
/** overall 에 넣지 않은 사람 확인 사유. `capacity_review` = 장부 경보가 검토 목록 문턱(review_*)뿐이다(2026-11-10). */
export type MonitorWarning = 'capacity_review';
export type MonitorStatus = {
  measuredAt: string;
  overall: 'ok' | 'unknown' | 'alarm';
  readiness: ReadinessReport | null;
  progress: ProgressReport | null;
  capacityUnknowns?: CapacityUnknownReport;
  warnings?: MonitorWarning[];
};

/**
 * 2026-10-31: 모델 장부의 `review`(확인 못함 · 사람 검토)는 overall 에 들어가지 않는다 — 일을 멈추지 않으므로 경보·DOWN 이 아니다.
 * overall 을 alarm 으로 만드는 장부 상태는 `alarm`(기한 넘긴 점유 행이 있는 경보)뿐이고, 장부를 읽지 못하면 unknown 이다.
 * 2026-11-10 소유자 결정: 장부 경보가 검토 목록 문턱(review_backlog·review_stale)뿐이고 점유 행이 멈추지 않았으면 overall 에 넣지 않고
 * `warnings: ['capacity_review']` 로 따로 알린다(capacityUnknowns 는 그대로 alarm·alarmReasons). 다른 경보·unknown 은 지금처럼 overall 을 정한다.
 */
export function combineMonitorStatus(readiness: ReadinessReport | null, progress: ProgressReport | null,
  capacityUnknowns?: CapacityUnknownReport): MonitorStatus {
  const reviewOnly = capacityReviewOnlyAlarm(capacityUnknowns);
  const overall = readiness?.overall === 'alarm' || progress?.overall === 'alarm' || (capacityUnknowns?.status === 'alarm' && !reviewOnly) ? 'alarm'
    : !readiness || !progress || progress.overall === 'unknown' || capacityUnknowns?.status === 'unknown' ? 'unknown' : 'ok';
  return { measuredAt: new Date().toISOString(), overall, readiness, progress, ...(capacityUnknowns ? { capacityUnknowns } : {}),
    ...(reviewOnly ? { warnings: ['capacity_review' as const] } : {}) };
}

export function exitCodeFor(overall: MonitorStatus['overall']): number {
  return overall === 'alarm' ? 2 : overall === 'unknown' ? 1 : 0;
}

export async function readMonitorStatus(): Promise<MonitorStatus> {
  const [readiness, progress, capacity] = await Promise.allSettled([readFailoverReadiness(), readWorkerProgress(), readModelCapacityUnknowns()]);
  return combineMonitorStatus(readiness.status === 'fulfilled' ? readiness.value : null,
    progress.status === 'fulfilled' ? progress.value : null, capacity.status === 'fulfilled' ? capacity.value : unknownCapacityReport());
}
