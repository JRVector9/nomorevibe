import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import type { ModelCapacityMode } from '@/lib/llm/capacity';
import { readFailoverReadiness, type ReadinessReport } from './failover-readiness';
import { readWorkerProgress } from './worker-progress-query';
import { capacityReviewOnlyAlarm, readModelCapacityUnknowns, unknownCapacityReport, type CapacityUnknownReport } from './model-capacity-unknowns';

type ProgressReport = Awaited<ReturnType<typeof readWorkerProgress>>;
/** overall 에 넣지 않은 사람 확인 사유. `capacity_review` = 장부 경보가 검토 목록 문턱(review_*)뿐이다(2026-11-10). */
export type MonitorWarning = 'capacity_review';
/**
 * 모델 접수 모드(model_capacity_control id=1)와 그 행이 마지막으로 바뀐 시각(이 프로세스 시계의 epoch ms). 2026-11-11 배포 창 DRAIN 동안의
 * 진행 경보 알림 유예(Oracle watchdog)가 읽는 관측일 뿐 overall·경보·배포 관문을 바꾸지 않는다.
 * `changedAt` 은 updated_at 이다 — 모드 전환뿐 아니라 정책 쓰기에도 바뀌므로 「DRAIN 이 시작된 시각」 그 자체가 아니라 그 뒤의 어느 때다
 * (나이를 짧게 볼 수는 있어도 길게 보지 않는다). Oracle 은 이 나이와 자기 관측 중 이른 쪽으로 DRAIN 나이를 잰다.
 */
export type CapacityModeObservation = { mode: ModelCapacityMode; changedAt: number };
export type MonitorStatus = {
  measuredAt: string;
  overall: 'ok' | 'unknown' | 'alarm';
  readiness: ReadinessReport | null;
  progress: ProgressReport | null;
  capacityUnknowns?: CapacityUnknownReport;
  capacityMode?: CapacityModeObservation;
  warnings?: MonitorWarning[];
};

const CAPACITY_MODES: readonly string[] = ['open', 'draining', 'disabled'] satisfies ModelCapacityMode[];

/**
 * 2026-10-31: 모델 장부의 `review`(확인 못함 · 사람 검토)는 overall 에 들어가지 않는다 — 일을 멈추지 않으므로 경보·DOWN 이 아니다.
 * overall 을 alarm 으로 만드는 장부 상태는 `alarm`(기한 넘긴 점유 행이 있는 경보)뿐이고, 장부를 읽지 못하면 unknown 이다.
 * 2026-11-10 소유자 결정: 장부 경보가 검토 목록 문턱(review_backlog·review_stale)뿐이고 점유 행이 멈추지 않았으면 overall 에 넣지 않고
 * `warnings: ['capacity_review']` 로 따로 알린다(capacityUnknowns 는 그대로 alarm·alarmReasons). 다른 경보·unknown 은 지금처럼 overall 을 정한다.
 * 접수 모드(capacityMode)는 덧붙이기만 한다 — DRAINING 이어도 overall 은 그대로다(배포 관문·운영 홈·Kuma 는 지금처럼 경보를 본다).
 */
export function combineMonitorStatus(readiness: ReadinessReport | null, progress: ProgressReport | null,
  capacityUnknowns?: CapacityUnknownReport, capacityMode?: CapacityModeObservation): MonitorStatus {
  const reviewOnly = capacityReviewOnlyAlarm(capacityUnknowns);
  const overall = readiness?.overall === 'alarm' || progress?.overall === 'alarm' || (capacityUnknowns?.status === 'alarm' && !reviewOnly) ? 'alarm'
    : !readiness || !progress || progress.overall === 'unknown' || capacityUnknowns?.status === 'unknown' ? 'unknown' : 'ok';
  return { measuredAt: new Date().toISOString(), overall, readiness, progress, ...(capacityUnknowns ? { capacityUnknowns } : {}),
    ...(capacityMode ? { capacityMode } : {}), ...(reviewOnly ? { warnings: ['capacity_review' as const] } : {}) };
}

export function exitCodeFor(overall: MonitorStatus['overall']): number {
  return overall === 'alarm' ? 2 : overall === 'unknown' ? 1 : 0;
}

/** DB 한 줄 → 관측. 나이는 DB 시계로 잰 것을 이 프로세스 시계(now)로 옮긴다 — 호스트 사이 시계 차이가 끼지 않는다. 틀린 줄은 던진다. */
export function parseCapacityModeObservation(row: { mode?: unknown; age_ms?: unknown } | undefined, now: number): CapacityModeObservation {
  const age = typeof row?.age_ms === 'string' && row.age_ms.trim() !== '' ? Number(row.age_ms) : row?.age_ms;
  if (!row || typeof row.mode !== 'string' || !CAPACITY_MODES.includes(row.mode) || typeof age !== 'number' || !Number.isFinite(age) || age < 0
    || !Number.isSafeInteger(now) || now < 0) throw new Error('capacity_mode_invalid');
  return { mode: row.mode as ModelCapacityMode, changedAt: Math.max(0, Math.floor(now - age)) };
}

/** 잠금 없이 한 줄을 읽는다(행 잠금을 쥔 장부 TX 를 기다리지 않는다). 읽지 못하면 던진다 — readMonitorStatus 가 칸을 뺀다(옛 monitor 와 같다). */
export async function readCapacityModeObservation(): Promise<CapacityModeObservation> {
  if (currentReplayDb()) throw new Error('capacity_mode_replay_unsupported');
  const rows = await onPrimary(() => db.execute<{ mode: string; age_ms: number | string }>(sql`SELECT mode,
    greatest(0, extract(epoch FROM clock_timestamp() - updated_at) * 1000)::float8 AS age_ms
    FROM model_capacity_control WHERE id = 1`));
  return parseCapacityModeObservation(Array.from(rows)[0], Date.now());
}

export async function readMonitorStatus(): Promise<MonitorStatus> {
  const [readiness, progress, capacity, mode] = await Promise.allSettled([readFailoverReadiness(), readWorkerProgress(), readModelCapacityUnknowns(),
    readCapacityModeObservation()]);
  return combineMonitorStatus(readiness.status === 'fulfilled' ? readiness.value : null,
    progress.status === 'fulfilled' ? progress.value : null, capacity.status === 'fulfilled' ? capacity.value : unknownCapacityReport(),
    mode.status === 'fulfilled' ? mode.value : undefined);
}
