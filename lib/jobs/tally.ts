import { notLike, sql, type SQL } from "drizzle-orm";
import { operationsObservations } from "@/lib/db/schema";
import { JOB_CATALOG, type JobRole } from "./catalog";
import { COLLECTOR_EVENTS } from "./collector-events";

/**
 * 수집기 회차 누적 — 잡마다 operations_observations 한 줄(job-tally:<job>). 워커가 runJob 에 tally 를 켤 때만 쓴다.
 *
 * job:<name> 은 성공한 틱마다 덮어써 "마지막 회차"만 남는다. 1분마다 도는 원본 수집은 늘 "원본 확보 0~5 · 이번 탐색 완료"라
 * 크롤러 활동 표가 멈춘 것처럼 보였다. 그래서 같은 이벤트 숫자를 시간 묶음에 더해 둔다 — 새 예약 잡 없이 runner 가 틱을 끝내며 쓴다.
 *
 * - 묶음 열쇠는 "h<YYYY-MM-DDTHH>|<지표>"(정시, 최근 25칸)와 "m<YYYY-MM-DDTHH:MM>|<지표>"(10분, 최근 7칸). DB 시계(UTC)다.
 * - 지표는 "<이벤트>#<필드>"(그 틱의 숫자 합)와 "<이벤트>"(나온 횟수), 틱 자체는 "@ok"·"@failed"·"@degraded"(끝났지만 제 일을 못 한 틱 — @ok 에도 든다).
 * - 한 줄 upsert 가 지난 값과 합치고 창 밖 묶음을 버린다. 두 프로세스가 같이 써도(역할 인계 중) ON CONFLICT 가 행을 잠그고 더한다.
 * - 실패한 틱은 "@failed"와 lastFailedAt 만 남긴다(그 틱의 이벤트는 job:<name> 처럼 세지 않는다). 미룬 틱은 defer:<job> 이 맡는다.
 * - 화면은 이 키를 크롤러 활동에서만 따로 읽는다 — 관측 표 전체 읽기(operationsData·진행 판정)는 WITHOUT_JOB_TALLIES 로 뺀다.
 */
export const JOB_TALLY_KEY_PREFIX = "job-tally:";
export const jobTallyKey = (name: string) => `${JOB_TALLY_KEY_PREFIX}${name}`;
export const WITHOUT_JOB_TALLIES = notLike(operationsObservations.key, `${JOB_TALLY_KEY_PREFIX}%`);

/** 크롤러 활동에 오르는 수집기 — crawler 역할 전부와 다른 역할이 맡은 바깥 수집 */
export const EXTERNAL_COLLECTORS: ReadonlySet<string> = new Set(["uptime-ping", "news-refresh", "product-thumbnail-refresh", "product-repo-review"]);
export const COLLECTOR_JOBS = JOB_CATALOG.filter((job): job is typeof job & { role: JobRole } =>
  job.role === "crawler" || (job.role !== "scheduler" && EXTERNAL_COLLECTORS.has(job.name)));
export const COLLECTOR_NAMES: ReadonlySet<string> = new Set(COLLECTOR_JOBS.map((job) => job.name));

/** 더하면 뜻이 없는 필드 — 페이지 번호·남은 한도·이번 대상 같은 그때의 자리 값. 이름이 Id 로 끝나는 번호(scanId 등)도 뺀다 */
const NOT_ADDITIVE = new Set(["page", "backlogPages", "remaining", "limit", "skewMs", "incompleteWindows", "due", "targets"]);
const IDENTIFIER = /(^id|Id|Ids)$/;
/** 더해서 뜻이 있는 필드인가 — 화면(크롤러 활동)이 누적을 보일 때도 같은 기준을 쓴다 */
export const isAdditiveField = (field: string) => !NOT_ADDITIVE.has(field) && !IDENTIFIER.test(field);
const EVENT = /^[a-z][a-z0-9_.]{0,63}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** 한 틱에 싣는, 화면이 모르는 지표 수 상한 — 화면이 아는 지표(collector-events.ts)는 이 수와 따로 늘 싣는다 */
export const TALLY_METRICS_PER_TICK = 48;
const VALUE_MAX = 1_000_000_000;

export type TallyEvent = { event: string; counts: Record<string, number | boolean> };

/**
 * 한 틱의 이벤트를 지표별 합으로 모은다. 0 은 싣지 않는다(빈 틱이 열쇠를 늘리지 않게). runner 가 ctx.log 마다 넣는다 —
 * 관측에 남기는 마지막 12개가 아니라 그 틱의 모든 이벤트다. 이벤트마다 나온 횟수("<이벤트>")도 센다 — 한도·인증 대기처럼
 * 숫자를 함께 싣는 알림도 몇 번 났는지 보인다.
 * 화면이 아는 이벤트·필드(collector-events.ts)는 늘 싣고, 그 밖의 것은 한 틱에 TALLY_METRICS_PER_TICK 개까지만 싣는다 —
 * 틱 끝에 남기는 요약(crawl.fetched·evidence.refresh_batch)이 앞선 잡다한 이벤트에 밀려 잘리지 않게.
 */
export function createTally() {
  const totals = new Map<string, number>();
  let others = 0;
  const add = (metric: string, value: number, known: boolean) => {
    if (!totals.has(metric)) {
      if (!known && others >= TALLY_METRICS_PER_TICK) return;
      if (!known) others++;
    }
    totals.set(metric, Math.min(VALUE_MAX, (totals.get(metric) ?? 0) + value));
  };
  return {
    add({ event, counts }: TallyEvent) {
      if (!EVENT.test(event)) return;
      const definition = Object.hasOwn(COLLECTOR_EVENTS, event) ? COLLECTOR_EVENTS[event] : null;
      add(event, 1, definition !== null);
      for (const [field, value] of Object.entries(counts)) {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || !FIELD.test(field) || !isAdditiveField(field)) continue;
        if (value > 0) add(`${event}#${field}`, Math.min(VALUE_MAX, value), definition?.fields.includes(field) === true);
      }
    },
    counts: (): Record<string, number> => Object.fromEntries(totals),
  };
}

export function tallyCounts(events: readonly TallyEvent[]): Record<string, number> {
  const tally = createTally();
  for (const event of events) tally.add(event);
  return tally.counts();
}

/** 지난 값 열쇠의 모양 — 이 모양이 아니면 합치지 않고 버린다(손으로 고친 줄·옛 모양) */
const STORED_KEY = String.raw`^(h[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}|m[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2})[|](@ok|@failed|@degraded|[a-z][a-z0-9_.]{0,63}(#[A-Za-z][A-Za-z0-9_]{0,31})?)$`;
const hourOf = (at: SQL) => sql`'h' || to_char(date_trunc('hour', ${at}), 'YYYY-MM-DD"T"HH24')`;
const tenOf = (at: SQL) => sql`'m' || to_char(date_trunc('hour', ${at}) + floor(extract(minute FROM ${at}) / 10) * interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI')`;
const iso = (at: SQL) => sql`to_char(${at}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * 한 줄 upsert. counts 는 이번 틱의 지표(tallyCounts)에 "@ok"/"@failed"를 더한 것. failed 면 lastFailedAt 을 DB 시각으로 고친다.
 * 정시 묶음은 이번 시 포함 25칸, 10분 묶음은 이번 칸 포함 7칸만 남긴다.
 */
export function jobTallyUpsert(name: string, counts: Record<string, number>, options: { failed?: boolean } = {}): SQL {
  const at = sql`clock.at`;
  const prior = sql`CASE WHEN jsonb_typeof(operations_observations.value->'counts') = 'object' THEN operations_observations.value->'counts' ELSE '{}'::jsonb END`;
  const written = sql`excluded.observed_at`;
  return sql`WITH clock AS (SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS at),
    added AS (
      SELECT bucket.prefix || '|' || tick.key AS k, tick.value::bigint AS n
      FROM clock, LATERAL (VALUES (${hourOf(at)}), (${tenOf(at)})) AS bucket(prefix),
        jsonb_each_text(${JSON.stringify(counts)}::text::jsonb) tick
    )
    INSERT INTO operations_observations (key, value, observed_at)
    SELECT ${jobTallyKey(name)}::text, jsonb_build_object('at', ${iso(at)},
        'counts', coalesce((SELECT jsonb_object_agg(added.k, added.n) FROM added), '{}'::jsonb))
        || CASE WHEN ${options.failed === true} THEN jsonb_build_object('lastFailedAt', ${iso(at)}) ELSE '{}'::jsonb END, clock.at
    FROM clock
    ON CONFLICT (key) DO UPDATE SET observed_at = excluded.observed_at, value =
      (CASE WHEN jsonb_typeof(operations_observations.value) = 'object' THEN operations_observations.value ELSE '{}'::jsonb END)
      || (excluded.value - 'counts')
      || jsonb_build_object('counts', (SELECT coalesce(jsonb_object_agg(kept.k, kept.n), '{}'::jsonb) FROM (
        SELECT merged.k, least(sum(merged.n), ${VALUE_MAX * 1000})::bigint AS n FROM (
          SELECT prior_count.key AS k, prior_count.value::bigint AS n FROM jsonb_each_text(${prior}) prior_count
          WHERE prior_count.key ~ ${STORED_KEY} AND prior_count.value ~ '^[0-9]{1,15}$'
          UNION ALL
          SELECT tick.key, tick.value::bigint FROM jsonb_each_text(excluded.value->'counts') tick
        ) merged
        WHERE (merged.k LIKE 'h%' AND merged.k >= ${hourOf(sql`(${written} - interval '24 hours')`)})
          OR (merged.k LIKE 'm%' AND merged.k >= ${tenOf(sql`(${written} - interval '60 minutes')`)})
        GROUP BY merged.k
      ) kept))`;
}

export type TallyWindow = Record<string, number>;
export type JobTallySummary = {
  job: string;
  /** 최근 1시간(10분 묶음 7칸 — 60~70분) · 최근 24시간(정시 묶음 24칸, 이번 시 포함 — 23~24시간) 지표 합 */
  hour: TallyWindow; day: TallyWindow;
  /** 마지막으로 실패한 틱(DB 시계). 없으면 null */
  lastFailedAt: string | null;
};

const BUCKET = /^([hm])(\d{4}-\d{2}-\d{2}T\d{2}(?::\d{2})?)\|(.+)$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isoOrNull = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** 읽은 DB 시각(at) 기준으로 창마다 더한다. 창 밖 묶음·모양이 틀린 열쇠·음수는 버린다 */
export function summarizeJobTallies(at: string, rows: unknown): JobTallySummary[] {
  const now = Date.parse(at);
  if (!Number.isFinite(now) || !Array.isArray(rows)) return [];
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000;
  const tenStart = Math.floor(now / 600_000) * 600_000 - 60 * 60_000;
  return rows.flatMap((row): JobTallySummary[] => {
    if (!record(row) || typeof row.key !== "string" || !row.key.startsWith(JOB_TALLY_KEY_PREFIX) || !record(row.value)) return [];
    const hour: TallyWindow = {}, day: TallyWindow = {};
    for (const [key, value] of Object.entries(record(row.value.counts) ? row.value.counts : {})) {
      const match = BUCKET.exec(key);
      if (!match || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
      const start = Date.parse(match[1] === "h" ? `${match[2]}:00:00Z` : `${match[2]}:00Z`);
      // 쓴 곳(주 DB)과 읽는 곳(복제본)의 시계가 조금 어긋나도 이번 칸을 버리지 않는다
      if (!Number.isFinite(start) || start > now + 60_000) continue;
      const target = match[1] === "h" ? (start >= hourStart ? day : null) : (start >= tenStart ? hour : null);
      if (target) target[match[3]] = (target[match[3]] ?? 0) + value;
    }
    return [{ job: row.key.slice(JOB_TALLY_KEY_PREFIX.length), hour, day, lastFailedAt: isoOrNull(row.value.lastFailedAt) }];
  });
}

/** 크롤러 활동이 읽는 문장 — 수집기 줄만, 읽은 DB 시각과 함께 */
export const READ_JOB_TALLIES = sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
  coalesce((SELECT jsonb_agg(jsonb_build_object('key', o.key, 'value', o.value) ORDER BY o.key)
    FROM operations_observations o WHERE o.key LIKE 'job-tally:%'), '[]'::jsonb) AS rows`;
