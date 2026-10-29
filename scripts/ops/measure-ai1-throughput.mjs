// AI1(crawl-agent-review) 처리량과 예약 낭비를 모델별로 잰다. 모든 쿼리는 읽기 전용 TX 하나다.
// 기존 worker 이미지 안에서 그 DATABASE_URL 로 실행한다(scripts/ops/measure-review-stall.mjs 와 같은 방식):
//   AI1_WINDOW_MINUTES=60 AI1_BUCKET_MINUTES=10 node scripts/ops/measure-ai1-throughput.mjs
// 2026-10-29 전용 줄(ai1)·틱 안 예약 대기 배포 전후를 같은 정의로 비교하려는 것이다:
// - buckets: 모델·구간별 queued/reserved/dispatch_started/reservation_expired/reservation_cancelled/wait_expired 사건 수
// - slots: 모델별 물리 슬롯 시간 — 미사용 만료 예약(reserved→expired)·취소 예약·쓴 예약(reserved→dispatch)·호출(dispatch→정산) 초와
//   미사용 만료 비율(unusedShare). 구간 안에서 끝난 것만 센다
// - attempts: 모델·구간별 AI1 시도(automatic, 재사용 아님) 성공·실패 수
// - backlog: 자동 승인(approved·decided_by auto)이면서 AI1 시도가 한 번도 없는 후보 수 — 잡의 정확한 대상 조건(reviewCandidatePredicate)이
//   아니라 추세를 보는 근사다
import postgres from 'postgres';

const ROUTE = 'crawl-agent-review';

function bounded(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`expected integer ${min}..${max}`);
  return number;
}

/** sql: postgres.js 클라이언트 또는 TX. 읽기 전용 TX 안에서 부른다 */
export async function measureAi1Throughput(sql, { windowMinutes = 60, bucketMinutes = 10, backlog = true } = {}) {
  const bucketSeconds = bucketMinutes * 60;
  const [clock] = await sql`SELECT now() AS measured_at, now() - make_interval(mins => ${windowMinutes}) AS since, pg_is_in_recovery() AS replica`;
  const since = clock.since;
  const buckets = await sql`SELECT r.model,
      to_timestamp(floor(extract(epoch FROM e.created_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
      count(*) FILTER (WHERE e.kind = 'queued')::int AS queued,
      count(*) FILTER (WHERE e.kind = 'reserved')::int AS reserved,
      count(*) FILTER (WHERE e.kind = 'dispatch_started')::int AS dispatched,
      count(*) FILTER (WHERE e.kind = 'reservation_expired')::int AS reservation_expired,
      count(*) FILTER (WHERE e.kind = 'reservation_cancelled')::int AS reservation_cancelled,
      count(*) FILTER (WHERE e.kind = 'wait_expired')::int AS wait_expired
    FROM model_capacity_events e JOIN model_capacity_requests r ON r.request_id = e.request_id
    WHERE r.route_id = ${ROUTE} AND e.created_at > ${since}
    GROUP BY 1, 2 ORDER BY 1, 2`;
  // 예약 하나는 reserved 사건이 하나다(reserved → dispatched | withdrawn). 끝 사건이 구간 안인 것만 더한다
  const slots = await sql`WITH exits AS (
      SELECT r.model, x.kind, extract(epoch FROM x.created_at - g.created_at)::float8 AS seconds
      FROM model_capacity_events x
      JOIN model_capacity_events g ON g.request_id = x.request_id AND g.kind = 'reserved'
      JOIN model_capacity_requests r ON r.request_id = x.request_id
      WHERE r.route_id = ${ROUTE} AND x.created_at > ${since}
        AND x.kind IN ('reservation_expired', 'reservation_cancelled', 'dispatch_started')
      UNION ALL
      SELECT r.model, 'call' AS kind, extract(epoch FROM s.created_at - d.created_at)::float8 AS seconds
      FROM model_capacity_events s
      JOIN model_capacity_events d ON d.request_id = s.request_id AND d.kind = 'dispatch_started'
      JOIN model_capacity_requests r ON r.request_id = s.request_id
      WHERE r.route_id = ${ROUTE} AND s.created_at > ${since} AND s.kind IN ('dispatch_settled', 'dispatch_released'))
    SELECT model,
      count(*) FILTER (WHERE kind = 'reservation_expired')::int AS expired,
      coalesce(sum(seconds) FILTER (WHERE kind = 'reservation_expired'), 0)::float8 AS expired_s,
      count(*) FILTER (WHERE kind = 'reservation_cancelled')::int AS cancelled,
      coalesce(sum(seconds) FILTER (WHERE kind = 'reservation_cancelled'), 0)::float8 AS cancelled_s,
      count(*) FILTER (WHERE kind = 'dispatch_started')::int AS used,
      coalesce(sum(seconds) FILTER (WHERE kind = 'dispatch_started'), 0)::float8 AS grant_to_dispatch_s,
      count(*) FILTER (WHERE kind = 'call')::int AS calls,
      coalesce(sum(seconds) FILTER (WHERE kind = 'call'), 0)::float8 AS call_s
    FROM exits GROUP BY 1 ORDER BY 1`;
  const attempts = await sql`SELECT a.model,
      to_timestamp(floor(extract(epoch FROM a.completed_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
      count(*) FILTER (WHERE a.state = 'succeeded')::int AS succeeded,
      count(*) FILTER (WHERE a.state = 'failed')::int AS failed
    FROM crawl_review_attempts a
    WHERE a.kind = 'automatic' AND a.provider IS DISTINCT FROM 'rules' AND a.reused_from_attempt_id IS NULL AND a.completed_at > ${since}
    GROUP BY 1, 2 ORDER BY 1, 2`;
  const [pending] = backlog ? await sql`SELECT count(*)::int AS approved_never_attempted FROM crawl_candidates c
    WHERE c.state = 'approved' AND c.decided_by = 'auto'
      AND NOT EXISTS (SELECT 1 FROM crawl_review_attempts a WHERE a.candidate_id = c.id)` : [null];
  return {
    measuredAt: clock.measured_at, since, replica: clock.replica, windowMinutes, bucketMinutes,
    buckets, attempts,
    slots: slots.map(row => {
      const occupied = row.expired_s + row.cancelled_s + row.grant_to_dispatch_s + row.call_s;
      return { ...row, unusedShare: occupied > 0 ? Number(((row.expired_s + row.cancelled_s) / occupied).toFixed(4)) : null,
        dispatchesPerHour: Number((row.used * 60 / windowMinutes).toFixed(1)) };
    }),
    backlog: pending,
  };
}

async function main() {
  const windowMinutes = bounded(process.env.AI1_WINDOW_MINUTES, 60, 5, 24 * 60);
  const bucketMinutes = bounded(process.env.AI1_BUCKET_MINUTES, 10, 1, 60);
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10, prepare: false });
  try {
    const result = await sql.begin('read only', async tx => {
      await tx`SET LOCAL statement_timeout = '25s'`;
      return measureAi1Throughput(tx, { windowMinutes, bucketMinutes });
    });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(JSON.stringify({ error: e.code ?? e.name, message: e.message }));
    process.exitCode = 1;
  } finally { await sql.end({ timeout: 2 }); }
}

if (process.argv[1] && /measure-ai1-throughput\.mjs$/.test(process.argv[1])) void main();
