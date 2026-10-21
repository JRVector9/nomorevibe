import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { crawlReviewAttempts, crawlTaglines, productAuditAttempts, productEmbeddings, productIntroChecks, productKoreanTaglines,
  productSearchProfiles, productTranslations, secondReviews, textTranslations } from "@/lib/db/schema";
import { readJobDeferrals, type JobDeferralSummary } from "@/lib/jobs/deferral-observation";
import { READ_JOB_TALLIES, summarizeJobTallies, type JobTallySummary } from "@/lib/jobs/tally";
import { FIRST_MODEL_CALL_SQL, SECOND_VOTED_SQL } from "./dashboard";
import { DB_CLOCK_SQL, replicaCache } from "./replica-cache";
import type { ModelSlot } from "./stage-registry";
import type { ReplicaRead } from "./replica-hold";
import { buildWorkerProgress, evidenceProgress, withProviderBackoff } from "./worker-progress-query";
import { parseAgentProviderFailure, type ProgressStageInput, type StageProgress } from "./worker-progress";
import { agentScanByClaims, readAgentScanMode, type AgentScanModeState } from "@/lib/domain/evidence/agents/claim-control";

/**
 * 운영센터 개편 v8 의 새 숫자 — 지금 화면에 없던 수만 여기서 읽는다. 지금 있는 숫자는 지금처럼 렌더마다 읽는다(render-reads.ts).
 *
 * 모두 복제본 전용(readReplicaOnly)이고, 못 읽으면 보류다. 값마다 DB 시각(at)을 달아 화면이 "기준 08:44:02 (DB)"로 보인다.
 * 캐시는 인스턴스마다 따로라 m3·mini 가 같은 시각 근처에서 조금 다른 수를 보일 수 있다 — 그래서 DB 시각을 단다.
 */

/** 이번 시(정시부터 DB 지금까지) 프론티어에 들어온 레포를 신호별로 — 들어오는 곳 칸의 GitHub / Show HN 나눔 */
export type SourceSplit = { at: string; signals: { signal: string; count: number }[] };

/** 프론티어(작은 표, 인덱스 없는 discovered_at)를 한 번 훑는다. 정시 경계도 DB 시계로 잰다 */
const SOURCE_SPLIT_SQL = sql`
  WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at)
  SELECT ${DB_CLOCK_SQL} AS at, coalesce((
    SELECT jsonb_agg(jsonb_build_object('signal', s.signal, 'count', s.n) ORDER BY s.n DESC, s.signal) FROM (
      SELECT f.signal, count(*)::int AS n FROM crawl_frontier f, clock
      WHERE f.discovered_at >= date_trunc('hour', clock.at) AND f.discovered_at <= clock.at GROUP BY f.signal
    ) s), '[]'::jsonb) AS signals`;

const splitCache = replicaCache<SourceSplit>({ event: "operations.source_split_unavailable", ttlMs: 60_000, bypass: false });

function signalRows(value: unknown): SourceSplit["signals"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => row && typeof row.signal === "string" && Number.isSafeInteger(row.count) && row.count >= 0
    ? [{ signal: row.signal as string, count: row.count as number }] : []);
}

/** 복제본 전용 · 60초 캐시(새로고침도 건너뛰지 않는다) · 열쇠는 이번 시 — 정시가 지나면 새로 센다 */
export function readSourceSplit(now = new Date()): Promise<ReplicaRead<SourceSplit>> {
  return splitCache(String(Math.floor(now.getTime() / 3_600_000)), async (replica) => {
    const [row] = await replica.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return tx.execute<{ at: string; signals: unknown }>(SOURCE_SPLIT_SQL);
    }, { accessMode: "read only" });
    return { at: row.at, signals: signalRows(row.signals) };
  });
}

/** 보강 근거 3단계(공개 근거·개발 AI 근거·AI 단계)의 판정 — 배포 관문과 같은 SQL·같은 판정, 복제본에서 */
export type EvidenceVerdicts = { at: string; stages: StageProgress[] };

/** 근거 CTE 는 무겁다(3초 상한) — 20초 캐시, 새로고침이 건너뛰어도 인스턴스당 1분에 3번까지 */
const evidenceCache = replicaCache<{ at: string; rows: ProgressStageInput[]; agentScan: AgentScanModeState }>({
  event: "operations.evidence_verdicts_unavailable", ttlMs: 20_000, bypass: true, perMinute: 3,
});

type EvidenceJob = { name: string; nextScheduledAt: Date | null; notBefore: Date | null; lockedAt?: Date | null;
  leaseToken?: string | null; cursor?: unknown; lastError?: string | null };

export async function readEvidenceVerdicts(input: {
  settings: CrawlSettings; jobs: EvidenceJob[];
  observations: Array<{ key: string; value: Record<string, unknown>; observedAt: Date | string }>;
  batch: { mode: string; writerContractVersion: number } | null; now: Date; fresh: boolean;
}): Promise<ReplicaRead<EvidenceVerdicts>> {
  const { settings, jobs, now } = input;
  // readWorkerProgress 와 같은 입력 — AI 단계의 안 본 대상 쉬기, 개발 AI 근거의 공급자 실패
  const aiCursor = jobs.find((job) => job.name === "ai-level-refresh")?.cursor as { unseenIdleUntil?: unknown } | null;
  const idleUntil = typeof aiCursor?.unseenIdleUntil === "string" ? Date.parse(aiCursor.unseenIdleUntil) : NaN;
  const skipUnseen = Number.isFinite(idleUntil) && idleUntil > now.getTime();
  const agentCursor = jobs.find((job) => job.name === "agent-evidence-refresh")?.cursor as { providerFailure?: unknown } | null;
  const failure = parseAgentProviderFailure(agentCursor?.providerFailure);
  const key = JSON.stringify([settings.agentEvidence.enabled, settings.agentEvidence.backgroundRefreshDays, skipUnseen, failure]);
  const read = await evidenceCache(key, async (replica) => {
    const [clock] = await replica.execute<{ at: string }>(sql`SELECT ${DB_CLOCK_SQL} AS at`);
    // 제작 근거 스캔이 claim 표(consumer)로 돌면 그 표로 센다 — 잡 커서의 스캔 전 실패는 legacy 스캔의 것이다
    const agentScan = await readAgentScanMode(replica);
    const agentClaims = agentScanByClaims(agentScan);
    return { at: clock.at, agentScan,
      rows: await evidenceProgress(replica, settings, new Date(clock.at), skipUnseen, agentClaims ? null : failure, agentClaims) };
  }, input.fresh);
  if (!read.ok) return read;
  // 판정은 렌더마다 지금 잡 상태로 한다(재시도 보정·일시 중지·워커 생존) — 숫자만 캐시에서 온다
  const report = buildWorkerProgress({ measuredAt: read.value.at, stages: [] }, withProviderBackoff(jobs, now), input.observations, now,
    input.batch ?? { mode: "legacy", writerContractVersion: 0 }, read.value.rows, read.value.agentScan);
  return { ok: true, value: { at: read.value.at, stages: report.stages } };
}

/**
 * 모델 자리 하나의 호출 — 창(24h 또는 7일) 안 전체와 최근 1시간. 정확한 자리(1차 · 2차 투표·예비 · 키워드 짓기 · 발행분 감사)는 호출 기록,
 * 근사 자리(stage-registry approximated)는 결과 행이다 — 다시 쓰면 덮이고 실패 행은 마지막 시도만 남는다(참고로만 보인다).
 */
export type SlotWindow = { slot: string; observed: string | null; calls1h: number; failed1h: number; calls: number; failed: number;
  agree1h: number | null; agree: number | null };
export type SlotWindows = { at: string; window: "24h" | "7d"; rows: SlotWindow[] };
type SlotRef = Pick<ModelSlot, "key" | "model">;

const SPANS = { "24h": sql`interval '24 hours'`, "7d": sql`interval '7 days'` } as const;

/**
 * 자리별 호출을 한 문장에서 같은 모양(slot · model · done_at · failed · agreed)으로 모아 센다. 경계는 DB 시계(clock CTE)다.
 * 1차는 모델 카드(modelHealth)와 같은 firstModelCall, 2차는 같은 끝난 표(voted)·취소 제외 기준이다.
 */
export function modelSlotCallsSql(slots: readonly SlotRef[], window: "24h" | "7d"): SQL {
  const within = (column: AnyPgColumn) => sql`${column} > clock.at - ${SPANS[window]} AND ${column} <= clock.at`;
  const has = (key: string) => slots.some((slot) => slot.key === key);
  const branch = (key: string, model: AnyPgColumn, doneAt: AnyPgColumn, failed: SQL, from: SQL, where: SQL = sql`true`) =>
    sql`SELECT ${key}::text AS slot, ${model}::text AS model, ${doneAt} AS done_at, (${failed}) AS failed, NULL::boolean AS agreed
      FROM ${from}, clock WHERE (${where}) AND ${within(doneAt)}`;
  const seconds = slots.filter((slot) => slot.key.startsWith("second-") && slot.model);
  const branches: SQL[] = [];
  if (has("first")) branches.push(branch("first", crawlReviewAttempts.model, crawlReviewAttempts.completedAt,
    sql`${crawlReviewAttempts.state} = 'failed'`, sql`${crawlReviewAttempts}`, FIRST_MODEL_CALL_SQL));
  if (seconds.length) branches.push(sql`SELECT s.slot, ${secondReviews.model}::text, ${secondReviews.reviewedAt}, ${secondReviews.errorCode} IS NOT NULL,
      CASE WHEN ${SECOND_VOTED_SQL} THEN ${secondReviews.secondDecision} = ${secondReviews.firstDecision} END
    FROM ${secondReviews} JOIN (VALUES ${sql.join(seconds.map((slot) => sql`(${slot.key}::text, ${slot.model}::text)`), sql`, `)}) AS s(slot, model)
      ON s.model = ${secondReviews.model}, clock
    WHERE ${secondReviews.errorCode} IS DISTINCT FROM 'cancelled' AND ${within(secondReviews.reviewedAt)}`);
  if (has("keywords")) branches.push(
    branch("keywords", productSearchProfiles.model, productSearchProfiles.generatedAt, sql`false`, sql`${productSearchProfiles}`),
    branch("keywords", productSearchProfiles.model, productSearchProfiles.updatedAt, sql`true`, sql`${productSearchProfiles}`,
      sql`${productSearchProfiles.errorCode} IS NOT NULL`));
  if (has("audit")) branches.push(branch("audit", productAuditAttempts.model, productAuditAttempts.completedAt,
    sql`${productAuditAttempts.errorCode} IS NOT NULL`, sql`${productAuditAttempts}`));
  // 근사 자리 — 결과 행
  if (has("keyword-verify")) branches.push(
    branch("keyword-verify", productSearchProfiles.verifyModel, productSearchProfiles.verifiedAt, sql`false`, sql`${productSearchProfiles}`),
    branch("keyword-verify", productSearchProfiles.verifyModel, productSearchProfiles.updatedAt, sql`true`, sql`${productSearchProfiles}`,
      sql`${productSearchProfiles.verifyError} IS NOT NULL`));
  if (has("embedding")) branches.push(branch("embedding", productEmbeddings.model, productEmbeddings.embeddedAt, sql`false`, sql`${productEmbeddings}`));
  if (has("product-translate")) branches.push(branch("product-translate", productTranslations.model, productTranslations.updatedAt,
    sql`${productTranslations.status} = 'failed'`, sql`${productTranslations}`,
    sql`${productTranslations.status} IN ('ready', 'failed') AND ${productTranslations.provenance}->>'kind' = 'machine'`));
  if (has("reason-translate")) branches.push(branch("reason-translate", textTranslations.model, textTranslations.updatedAt,
    sql`${textTranslations.status} = 'failed'`, sql`${textTranslations}`));
  if (has("tagline-ko")) branches.push(branch("tagline-ko", productKoreanTaglines.model, productKoreanTaglines.updatedAt,
    sql`${productKoreanTaglines.errorCode} IS NOT NULL`, sql`${productKoreanTaglines}`,
    sql`${productKoreanTaglines.errorCode} IS NOT NULL OR ${productKoreanTaglines.taglineKo} IS NOT NULL`));
  if (has("intro-check")) branches.push(branch("intro-check", productIntroChecks.model, productIntroChecks.updatedAt,
    sql`${productIntroChecks.errorCode} IS NOT NULL`, sql`${productIntroChecks}`,
    sql`${productIntroChecks.errorCode} IS NOT NULL OR ${productIntroChecks.verdict} IS NOT NULL`));
  if (has("tagline")) branches.push(branch("tagline", crawlTaglines.model, crawlTaglines.updatedAt,
    sql`${crawlTaglines.errorCode} IS NOT NULL`, sql`${crawlTaglines}`));
  const recent = sql`done_at > clock.at - interval '1 hour'`;
  return sql`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at),
    calls AS (${branches.length ? sql.join(branches, sql` UNION ALL `) : sql`SELECT NULL::text AS slot, NULL::text AS model, NULL::timestamp AS done_at, false AS failed, NULL::boolean AS agreed WHERE false`}),
    counted AS (
      SELECT slot, (array_agg(model ORDER BY done_at DESC))[1] AS observed,
        count(*) FILTER (WHERE ${recent})::int AS calls1h, count(*) FILTER (WHERE failed AND ${recent})::int AS failed1h,
        count(*)::int AS calls, count(*) FILTER (WHERE failed)::int AS failed,
        avg(agreed::int) FILTER (WHERE ${recent})::float8 AS agree1h, avg(agreed::int)::float8 AS agree
      FROM calls, clock GROUP BY slot
    )
    SELECT to_char(c.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
      coalesce((SELECT jsonb_agg(to_jsonb(counted) ORDER BY counted.slot) FROM counted), '[]'::jsonb) AS slots
    FROM clock c`;
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
const ratio = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
function slotWindowRows(value: unknown): SlotWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => row && typeof row.slot === "string" ? [{ slot: row.slot as string,
    observed: typeof row.observed === "string" ? row.observed : null, calls1h: count(row.calls1h), failed1h: count(row.failed1h),
    calls: count(row.calls), failed: count(row.failed), agree1h: ratio(row.agree1h), agree: ratio(row.agree) }] : []);
}

const slotDayCache = replicaCache<SlotWindows>({ event: "operations.model_slots_unavailable", ttlMs: 60_000, bypass: false });
const slotWeekCache = replicaCache<SlotWindows>({ event: "operations.model_slots_week_unavailable", ttlMs: 10 * 60_000, bypass: false });

function readSlots(read: typeof slotDayCache, slots: readonly SlotRef[], window: "24h" | "7d", timeout: string) {
  return read(JSON.stringify(slots.map((slot) => [slot.key, slot.model])), async (replica) => {
    const [row] = await replica.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeout}'`));
      return tx.execute<{ at: string; slots: unknown }>(modelSlotCallsSql(slots, window));
    }, { accessMode: "read only" });
    return { at: row.at, window, rows: slotWindowRows(row.slots) };
  });
}

/** 모델 자리 24h(+최근 1시간) — 복제본 전용 · 60초 캐시(새로고침도 건너뛰지 않는다) */
export const readModelSlotWindows = (slots: readonly SlotRef[]) => readSlots(slotDayCache, slots, "24h", "5s");
/** 모델 자리 7일 참고 — 복제본 전용 · 10분 캐시(두 표의 7일 훑기라 새로고침도 건너뛰지 않는다) */
export const readModelSlotWeek = (slots: readonly SlotRef[]) => readSlots(slotWeekCache, slots, "7d", "10s");

/** 잡을 미룬 이유(defer:<job>, PR4) — 최근 1시간 */
export type DeferralsRead = { at: string; jobs: JobDeferralSummary[] };
const deferralCache = replicaCache<DeferralsRead>({ event: "operations.deferrals_unavailable", ttlMs: 15_000, bypass: true });

/** 복제본 전용 · 15초 캐시(새로고침이 건너뛰고 다시 쓴다). readReplicaOnly 범위 안이라 readJobDeferrals 의 db 가 복제본이다 */
export function readDeferrals(fresh: boolean): Promise<ReplicaRead<DeferralsRead>> {
  return deferralCache("defer", async () => {
    const read = await readJobDeferrals(<T,>(load: () => Promise<T>) => load());
    if (read.state !== "ready") throw new Error(`deferrals_${read.reason}`);
    return { at: read.at, jobs: read.jobs };
  }, fresh);
}

/** 수집기 회차 누적(job-tally:<job>) — 크롤러 활동 표의 최근 1시간·24시간 칸 */
export type TalliesRead = { at: string; jobs: JobTallySummary[] };
const tallyCache = replicaCache<TalliesRead>({ event: "operations.job_tallies_unavailable", ttlMs: 15_000, bypass: true });

/** 복제본 전용 · 15초 캐시(새로고침이 건너뛰고 다시 쓴다). 창은 읽은 DB 시각 기준으로 더한다 */
export function readTallies(fresh: boolean): Promise<ReplicaRead<TalliesRead>> {
  return tallyCache("tally", async (replica) => {
    const [row] = await replica.execute<{ at: string; rows: unknown }>(READ_JOB_TALLIES);
    return { at: row.at, jobs: summarizeJobTallies(row.at, row.rows) };
  }, fresh);
}
