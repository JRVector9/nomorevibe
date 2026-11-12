import { JOB_CATALOG } from "./catalog";

/**
 * 잡 주기 덮어쓰기(2026-11-12 운영 콘솔 조각 4a) — 주기의 원천은 카탈로그(lib/jobs/catalog.ts intervalMs)이고, 운영 설정
 * runtime_settings 의 jobs.<잡>.intervalMs 가 있으면 그 값이 이긴다. 순수 모듈이다(DB·Next 없이 쓴다).
 *
 * - 덮어쓸 수 있는 잡: 카탈로그에 주기가 있는 잡(요청으로만 도는 랭킹·heartbeat 는 주기가 없어 뺀다).
 * - 범위: 1분(scheduler 가 10초마다 보고, 카탈로그의 가장 짧은 주기도 1분이다) ~ 24시간. 너무 짧은 주기는 저장이 거절한다.
 * - 저장 문서에 없거나 읽을 수 없으면 코드 기본값 — 덮어쓰기가 하나도 없으면 scheduler 의 동작은 예전과 같다(tests/job-intervals.test.ts).
 */
export const JOB_INTERVAL_MIN_MS = 60_000;
export const JOB_INTERVAL_MAX_MS = 24 * 60 * 60_000;

const CATALOG_INTERVALS: ReadonlyMap<string, number | null> = new Map(JOB_CATALOG.map(job => [job.name, job.intervalMs]));

/** 카탈로그(코드)의 주기. 모르는 잡·주기가 없는 잡은 null */
export function catalogIntervalMs(job: string): number | null { return CATALOG_INTERVALS.get(job) ?? null; }
/** 주기를 화면에서 고칠 수 있는 잡인가 — 카탈로그에 주기가 있는 잡 */
export function intervalOverridable(job: string): boolean { return catalogIntervalMs(job) !== null; }
export function validIntervalMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= JOB_INTERVAL_MIN_MS && value <= JOB_INTERVAL_MAX_MS;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * 저장 문서(runtime_settings.values, sparse)의 잡 주기 덮어쓰기만 — 던지지 않는다. 모르는 잡·주기 없는 잡·범위 밖 값은 버린다(코드 기본값).
 * scheduler 가 틱마다 이것으로 주기를 고른다. 관리자 저장 검사(resolveRuntimeSettings)와 같은 범위다.
 */
export function jobIntervalOverrides(stored: unknown): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const jobs = isPlainObject(stored) ? stored.jobs : undefined;
  if (!isPlainObject(jobs)) return out;
  for (const [job, knobs] of Object.entries(jobs)) {
    if (!intervalOverridable(job) || !isPlainObject(knobs)) continue;
    const value = knobs.intervalMs;
    if (validIntervalMs(value)) out.set(job, value);
  }
  return out;
}

/** 지금 쓰는 주기 — 덮어쓰기가 있으면 그것, 없으면 카탈로그. 주기가 없는 잡은 null */
export function effectiveJobIntervalMs(job: string, overrides: ReadonlyMap<string, number> = new Map()): number | null {
  const base = catalogIntervalMs(job);
  if (base === null) return null;
  return overrides.get(job) ?? base;
}

/** 화면의 주기 글자 — 1분·30분·2시간·1일 2시간 */
export function intervalText(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}초`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
  const days = Math.floor(hours / 24), hourRest = hours % 24;
  return hourRest ? `${days}일 ${hourRest}시간` : `${days}일`;
}
