import { notLike, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbErrorFields } from "@/lib/db/error-fields";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { operationsObservations } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { writerSiteActive } from "@/lib/operations/dr/epoch";

/**
 * 잡을 미룬 이유 관측 — 잡마다 operations_observations 한 줄(defer:<job>).
 *
 * 지금은 왜 미뤘는지(모델 자리·HTTP 접속 허가·소스 버퍼·앞 단계 막힘·작업 배치 막힘·host 예산 …)가 로그에만 남는다.
 * job:<name> 에 넣지 않는다 — runner 가 틱마다 덮어쓰고, 검색 신선도(search-health-model)·크롤러 활동이 그 키를 읽는다.
 *
 * 쓰기는 잡마다 이유가 바뀔 때, 같은 이유면 1분에 한 번만 한다(그 사이 횟수는 프로세스 안에 모았다가 다음 쓰기에 싣는다).
 * 값은 마지막 이유·기록 시각(DB 시계)과 분 단위 횟수 묶음(최근 60분만 남김)이라, 덮어써도 최근 1시간 횟수가 남는다.
 * 일정·재시도·관문은 이 관측을 읽지 않는다.
 */
export const JOB_DEFERRAL_KEY_PREFIX = "defer:";
/** 같은 이유를 다시 쓰는 최소 간격(잡마다·프로세스마다) */
export const JOB_DEFERRAL_WRITE_INTERVAL_MS = 60_000;
/** 분 묶음을 남기고 세는 창 */
export const JOB_DEFERRAL_WINDOW_MINUTES = 60;
/** operations_observations.key 는 varchar(80) */
const KEY_MAX = 80;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const BUCKET = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)\|([a-z][a-z0-9_]{0,63})$/;

export function jobDeferralKey(name: string): string {
  return `${JOB_DEFERRAL_KEY_PREFIX}${name}`;
}

/** 관측 표 전체를 주 DB 에서 읽는 기존 읽기(관리자 operationsData·진행 판정)는 이 키를 빼고 읽는다 — 읽는 양이 이 관측 전과 같다 */
export const WITHOUT_JOB_DEFERRALS = notLike(operationsObservations.key, `${JOB_DEFERRAL_KEY_PREFIX}%`);

export type JobDeferralWrite = { key: string; reason: string; counts: Record<string, number> };

/**
 * 프로세스 안 쓰기 조절기. 잡의 첫 미룸과 이유가 바뀐 미룸은 바로, 같은 이유는 1분에 한 번 쓴다.
 * 쓰기가 실패해도 던지지 않는다 — 모은 횟수는 다음 쓰기에 다시 싣고, 실패한 시도도 간격에 센다(재시도로 DB 를 두드리지 않게).
 */
export function createJobDeferralRecorder(deps: {
  write: (input: JobDeferralWrite) => Promise<void>;
  now?: () => number;
  warn?: (event: string, fields: Record<string, unknown>) => void;
}): (name: string, reason: string) => Promise<void> {
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, { reason: string | null; at: number; counts: Record<string, number>; writing: boolean }>();
  return async (name, reason) => {
    const key = jobDeferralKey(name);
    if (key.length > KEY_MAX || !REASON.test(reason)) return;
    const state = jobs.get(name) ?? { reason: null, at: -Infinity, counts: {}, writing: false };
    jobs.set(name, state);
    state.counts[reason] = (state.counts[reason] ?? 0) + 1;
    const at = now();
    if (state.writing || (state.reason === reason && at - state.at < JOB_DEFERRAL_WRITE_INTERVAL_MS)) return;
    const counts = state.counts;
    Object.assign(state, { reason, at, counts: {}, writing: true });
    try {
      await deps.write({ key, reason, counts });
    } catch (error) {
      for (const [item, count] of Object.entries(counts)) state.counts[item] = (state.counts[item] ?? 0) + count;
      deps.warn?.("job.deferral_observation_failed", { job: name, reason, ...dbErrorFields(error) });
    } finally {
      state.writing = false;
    }
  };
}

/**
 * 한 줄 upsert. 분 묶음 키는 "YYYY-MM-DDTHH:MMZ|이유"(DB 시계, UTC)이고, 기존 줄과 같은 키는 더하고 60분보다 오래된 키는 버린다.
 * 동시에 두 프로세스가 써도(역할 인계 중) ON CONFLICT 가 행 하나를 잠그고 합친다.
 */
function deferralUpsert(input: JobDeferralWrite) {
  return sql`WITH clock AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS at),
    fresh AS (
      SELECT to_char(date_trunc('minute', clock.at), 'YYYY-MM-DD"T"HH24:MI"Z"') || '|' || added_count.key AS k, added_count.value::int AS n
      FROM clock, jsonb_each_text(${JSON.stringify(input.counts)}::text::jsonb) added_count
    )
    INSERT INTO operations_observations (key, value, observed_at)
    SELECT ${input.key}::text, jsonb_build_object('reason', ${input.reason}::text,
        'at', to_char(clock.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'counts', coalesce((SELECT jsonb_object_agg(fresh.k, fresh.n) FROM fresh), '{}'::jsonb)), clock.at
    FROM clock
    ON CONFLICT (key) DO UPDATE SET observed_at = excluded.observed_at, value = jsonb_build_object(
      'reason', excluded.value->'reason', 'at', excluded.value->'at',
      'counts', (SELECT coalesce(jsonb_object_agg(kept.k, kept.n), '{}'::jsonb) FROM (
        SELECT merged.k, sum(merged.n)::int AS n FROM (
          SELECT prior_count.key AS k, prior_count.value::int AS n
          FROM jsonb_each_text(CASE WHEN jsonb_typeof(operations_observations.value->'counts') = 'object'
            THEN operations_observations.value->'counts' ELSE '{}'::jsonb END) prior_count
          WHERE prior_count.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z[|][a-z][a-z0-9_]{0,63}$'
            AND prior_count.value ~ '^[0-9]{1,9}$'
          UNION ALL
          SELECT added_count.key, added_count.value::int FROM jsonb_each_text(excluded.value->'counts') added_count
        ) merged
        WHERE merged.k >= to_char(date_trunc('minute', excluded.observed_at) - interval '60 minutes', 'YYYY-MM-DD"T"HH24:MI"Z"')
        GROUP BY merged.k
      ) kept))`;
}

export async function writeJobDeferral(input: JobDeferralWrite): Promise<void> {
  // 격리 replay 는 고정 handler profile 로만 쓴다 — 미룸 관측을 남기지 않는다(capture 표가 그대로)
  if (currentReplayDb()) return;
  await db.transaction(async tx => {
    // DR writer fence 가 이 TX 의 첫 lock 이다(runner 의 미룸 release TX 와 같은 순서). fenced DB 에는 쓰지 않는다
    if (!await writerSiteActive(tx)) return;
    await tx.execute(deferralUpsert(input));
  });
}

/** 워커 프로세스 하나에 하나 — scripts/worker.ts 가 runner 의 미룸과 claim 전 admission 미룸을 여기로 보낸다 */
export const recordJobDeferral = createJobDeferralRecorder({ write: writeJobDeferral, warn: logger.warn });

export type JobDeferralSummary = {
  job: string;
  /** 마지막으로 기록한 미룬 이유(코드) */
  reason: string;
  /** 그 기록 시각(DB 시계, UTC). 같은 이유는 1분에 한 번 쓰므로 최대 약 1분 늦다 */
  lastDeferredAt: string;
  /** 최근 1시간(분 단위, 읽은 DB 시각 기준) 미룬 횟수 */
  lastHour: number;
  lastHourByReason: Record<string, number>;
};
export type JobDeferralsRead =
  | { state: "ready"; /** 읽은 DB 시각(UTC) */ at: string; jobs: JobDeferralSummary[] }
  | { state: "held"; reason: "replica_unavailable" | "read_failed" };
/** 복제본 전용 읽기 실행기 — 복제본이 없거나 밀렸거나 취소되면 null(주 DB 로 넘기지 않는다) */
export type ReplicaOnlyRead = <T>(load: () => Promise<T>) => Promise<T | null>;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function summarizeJobDeferrals(at: string, rows: unknown): JobDeferralSummary[] {
  const nowMinute = Math.floor(Date.parse(at) / 60_000);
  if (!Number.isFinite(nowMinute) || !Array.isArray(rows)) return [];
  const cutoff = nowMinute - (JOB_DEFERRAL_WINDOW_MINUTES - 1);
  return rows.flatMap((row): JobDeferralSummary[] => {
    if (!record(row) || typeof row.key !== "string" || !row.key.startsWith(JOB_DEFERRAL_KEY_PREFIX) || !record(row.value)) return [];
    const { reason, at: lastDeferredAt, counts } = row.value;
    if (typeof reason !== "string" || typeof lastDeferredAt !== "string" || !Number.isFinite(Date.parse(lastDeferredAt))) return [];
    const lastHourByReason: Record<string, number> = {};
    for (const [bucket, count] of Object.entries(record(counts) ? counts : {})) {
      const match = BUCKET.exec(bucket);
      if (!match || !Number.isSafeInteger(count) || (count as number) < 0) continue;
      if (Date.parse(match[1]) / 60_000 < cutoff) continue;
      lastHourByReason[match[2]] = (lastHourByReason[match[2]] ?? 0) + (count as number);
    }
    const lastHour = Object.values(lastHourByReason).reduce((sum, count) => sum + count, 0);
    return [{ job: row.key.slice(JOB_DEFERRAL_KEY_PREFIX.length), reason, lastDeferredAt, lastHour, lastHourByReason }];
  }).sort((a, b) => Date.parse(b.lastDeferredAt) - Date.parse(a.lastDeferredAt));
}

const READ_DEFERRALS = sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
  coalesce((SELECT jsonb_agg(jsonb_build_object('key', o.key, 'value', o.value) ORDER BY o.key)
    FROM operations_observations o WHERE o.key LIKE 'defer:%'), '[]'::jsonb) AS rows`;

/** 화면용 읽기. 복제본 전용 실행기를 받아 그 안에서만 읽고, 못 읽으면 "보류"다 */
export async function readJobDeferrals(replicaOnly: ReplicaOnlyRead): Promise<JobDeferralsRead> {
  let result: Array<{ at?: unknown; rows?: unknown }> | null;
  try {
    result = await replicaOnly(() => db.execute<{ at: string; rows: unknown }>(READ_DEFERRALS));
  } catch {
    return { state: "held", reason: "read_failed" };
  }
  if (!result) return { state: "held", reason: "replica_unavailable" };
  const [row] = result;
  if (typeof row?.at !== "string") return { state: "held", reason: "read_failed" };
  return { state: "ready", at: row.at, jobs: summarizeJobDeferrals(row.at, row.rows) };
}
