import "server-only";
import { inArray, sql } from "drizzle-orm";
import { sharedStore } from "@/lib/cache/shared";
import { db, onReplica } from "@/lib/db";
import { crawlPublicationChanges, jobs as jobRows, operationsObservations, products, socialPosts, socialTalkDecisions, type SocialSource } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import { formatInterval } from "@/lib/format/time";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { isPausedJob, jobStatusLabel, type ObservedJob } from "@/lib/jobs/status";
import { homeTalkLineup, PRODUCT_IDENTITY, TALK_LIST_LIMIT, talkGroups, type TalkEntry } from "@/lib/social/talk";
import { talkPublicEnabled } from "@/lib/social/flags";
import { jobHealthThresholds, readJobDegraded } from "./job-health";
import { sharedLoader } from "./shared-cache";
import { readXStatus, X_COLLECTOR_SCHEDULE, X_STATUS_KEY } from "./x-status";
import type { ProjectFlowOverview, SocialCollector, SocialCollectorStatus, SocialFlowOverview } from "./flow-overview-model";

export const SOCIAL_FLOW_JOBS = ["hn-talk", "bluesky-talk"] as const;

/** Same read-only snapshot for the stock count and both equal-duration publication windows.
 * Automatic publication uses the DB transition journal, not mutable product creation/status rows.
 */
export const projectFlowOverviewSql = sql`
  WITH observed AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at),
  registered AS (
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE ${products.status} IN ('seeded', 'verified'))::int AS listed,
      count(*) FILTER (WHERE ${products.status} = 'unverified')::int AS unverified,
      count(*) FILTER (WHERE ${products.status} = 'banned')::int AS banned
    FROM ${products}
  ), publications AS MATERIALIZED (
    SELECT ${crawlPublicationChanges.occurredAt} AS at FROM ${crawlPublicationChanges}, observed
    WHERE ${crawlPublicationChanges.delta} = 1
      AND ${crawlPublicationChanges.occurredAt} > observed.at - interval '48 hours'
      AND ${crawlPublicationChanges.occurredAt} <= observed.at
  ), totals AS (
    SELECT count(*) FILTER (WHERE p.at > o.at - interval '1 hour')::int AS last_hour,
      count(*) FILTER (WHERE p.at > o.at - interval '24 hours')::int AS current_day,
      count(*) FILTER (WHERE p.at <= o.at - interval '24 hours')::int AS previous_day
    FROM publications p CROSS JOIN observed o
  ), buckets AS (
    SELECT date_trunc('hour', p.at) AS hour, count(*)::int AS n
    FROM publications p CROSS JOIN observed o
    WHERE p.at >= date_trunc('hour', o.at) - interval '23 hours' GROUP BY 1
  ), hours AS (
    SELECT date_trunc('hour', o.at) - g * interval '1 hour' AS hour
    FROM observed o CROSS JOIN generate_series(23, 0, -1) AS g
  )
  SELECT to_char(o.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS measured_at,
    r.total, r.listed, r.unverified, r.banned, t.last_hour, t.current_day, t.previous_day,
    (SELECT jsonb_agg(jsonb_build_object('hour', to_char(h.hour, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'count', coalesce(b.n, 0)) ORDER BY h.hour) FROM hours h LEFT JOIN buckets b ON b.hour = h.hour) AS hours
  FROM observed o CROSS JOIN registered r CROSS JOIN totals t`;

export async function readProjectFlowOverview(): Promise<ProjectFlowOverview> {
  return onReplica(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL jit = off`);
    const [row] = await tx.execute<{ measured_at: string; total: number; listed: number; unverified: number; banned: number;
      last_hour: number; current_day: number; previous_day: number; hours: ProjectFlowOverview["hours"] }>(projectFlowOverviewSql);
    if (!row || !Array.isArray(row.hours) || row.hours.length !== 24) throw new Error("flow_overview_unreadable");
    return { measuredAt: row.measured_at, registered: row.total, listed: row.listed, unverified: row.unverified, banned: row.banned,
      published1h: row.last_hour, published24h: row.current_day, previous24h: row.previous_day, hours: row.hours };
  }, { accessMode: "read only", isolationLevel: "repeatable read" }));
}

type SocialJob = { paused: boolean; runtimeLabel?: string | null; lastSuccessAt: string | null; lastError: boolean; execution?: "locked" | "stale" | "none" };
export type SocialFlowJobs = Record<string, SocialJob>;

/**
 * jobs 한 행 → 운영 화면의 작업 상태(멈춤·이름표·잠김). 운영 홈의 작업 제어 판과 SNS 수집기 줄이 같은 계산을 쓴다 —
 * 두 화면이 같은 잡을 다르게 말하지 않게.
 */
export function jobRuntimeState(job: ObservedJob & { lastSuccessAt: Date | null }, now: number) {
  return { paused: isPausedJob(job, now), runtimeLabel: jobStatusLabel(job, now), lastSuccessAt: job.lastSuccessAt?.toISOString() ?? null,
    lastError: !!job.lastError, execution: (job.lockedAt ? now - job.lockedAt.getTime() > STALE_LOCK_MS ? "stale" : "locked" : "none") as "locked" | "stale" | "none" };
}

/**
 * A job row without a live execution or a successful run is not proof of a healthy collector.
 * freshness 를 주면 진짜 성공이 끊긴 잡(워커가 죽어 아무도 잡을 집지 않으면 잠김·오류 없이 유휴로 남는다)을 수집 지연으로 본다 —
 * 기준은 경보와 같은 job-health 의 보류 기준(6주기, 바닥 30분)이다.
 */
export function socialCollectorRuntime(job: SocialJob | undefined, enabled: boolean, degraded: boolean,
  freshness?: { now: number; intervalMs: number | null }): Pick<SocialCollector, "status" | "tone"> {
  if (!job) return { status: "작업 관측 미확인", tone: "gray" };
  if (!enabled || job.paused) return { status: "수집 중지", tone: "gray" };
  if (job.execution === "stale" || job.runtimeLabel === "중단·회수 대기") return { status: "중단·회수 대기", tone: "amber" };
  if (degraded || job.lastError) return { status: degraded ? "수집 미완료" : "오류", tone: "amber" };
  if (job.execution === "locked" || job.runtimeLabel === "실행 중") return { status: "실행 중", tone: "green" };
  if (!job.runtimeLabel || job.runtimeLabel === "실행 기록 없음" || !job.lastSuccessAt) return { status: job.runtimeLabel ?? "상태 미확인", tone: "gray" };
  if (freshness?.intervalMs && freshness.now - Date.parse(job.lastSuccessAt) > jobHealthThresholds(freshness.intervalMs).staleHoldMs) return { status: "수집 지연", tone: "amber" };
  // 유휴 = 다음 회차를 기다리는 정상 상태 — 운영자에게는 "동작 중"으로 말한다
  return job.runtimeLabel === "유휴" ? { status: "동작 중", tone: "green" } : { status: job.runtimeLabel, tone: "gray" };
}
const SOURCES: readonly SocialSource[] = ["hn", "bluesky", "x", "geeknews"];
const SOURCE_LABEL: Record<SocialSource, string> = { hn: "Hacker News", bluesky: "Bluesky", x: "X", geeknews: "GeekNews" };
/** 출처별 crawler 잡 — X 는 외부 수집기 보고, GeekNews 는 자동 잡이 없다 */
const SOURCE_JOB: Partial<Record<SocialSource, (typeof SOCIAL_FLOW_JOBS)[number]>> = { hn: "hn-talk", bluesky: "bluesky-talk" };
/** 주기는 카탈로그에서 읽는다 — 글에 박아 두면 주기를 바꿔도 화면이 옛 주기를 말한다(#597) */
const intervalOf = (name: string) => JOB_CATALOG.find(entry => entry.name === name)?.intervalMs ?? null;

type SocialSourceRow = { source: SocialSource; count: number; recent: number; linked: number; last_seen: string | null };
type SocialObservation = { key: string; value: unknown; observedAt: string | Date };

/** 출처별 보관 글 수·최근 24시간 새 글·마지막 확인 — linked(제품 연결 수)는 운영 홈만 센다(글마다 제품 색인을 한 번씩 본다) */
async function readSocialSourceRows(now: Date, linked: boolean): Promise<SocialSourceRow[]> {
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const rows = await tx.execute<SocialSourceRow>(sql`
      SELECT ${socialPosts.source} AS source, count(*)::int AS count,
        count(*) FILTER (WHERE ${socialPosts.firstSeenAt} > ${now.toISOString()}::timestamptz - interval '24 hours'
          AND ${socialPosts.firstSeenAt} <= ${now.toISOString()}::timestamptz)::int AS recent,
        ${linked ? sql`count(*) FILTER (WHERE ${socialPosts.repositoryKey} IS NOT NULL AND EXISTS (
          SELECT 1 FROM ${products} WHERE ${PRODUCT_IDENTITY} = 'https://github.com/' || ${socialPosts.repositoryKey}))::int` : sql`0`} AS linked,
        to_char(max(${socialPosts.lastSeenAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen
      FROM ${socialPosts} GROUP BY ${socialPosts.source}`);
    return [...rows];
  }, { accessMode: "read only" });
}

/** X 보고와 수집 잡의 제 일 못 함(job:<name>) 관측 */
function readSocialObservations(): Promise<SocialObservation[]> {
  return db.select({ key: operationsObservations.key, value: operationsObservations.value, observedAt: operationsObservations.observedAt })
    .from(operationsObservations).where(inArray(operationsObservations.key, [X_STATUS_KEY, ...SOCIAL_FLOW_JOBS.map(name => `job:${name}`)]));
}

/**
 * 출처마다 수집기가 지금 일하는지 — 운영 홈 SNS 칸과 콘텐츠 운영 SNS 탭이 이 하나로 판정한다.
 * HN·Bluesky 는 crawler 잡 상태, X 는 외부 수집기의 하루 보고, GeekNews 는 자동 잡이 없다(보관 글만).
 */
export function buildSocialCollectors({ rows, observations, jobs, enabled, now }: {
  rows: readonly Omit<SocialSourceRow, "linked">[]; observations: readonly SocialObservation[]; jobs: SocialFlowJobs; enabled: boolean; now: Date;
}): SocialCollector[] {
  // Inspect the persisted authenticated collector report; this read does not assert this web's receiver-secret configuration.
  const x = readXStatus(observations, now, true);
  return SOURCES.map(source => {
    const stored = rows.find(row => row.source === source);
    const base = { source, label: SOURCE_LABEL[source], stored: stored?.count ?? 0, new24h: stored?.recent ?? 0,
      lastSeenAt: stored?.last_seen ?? null, href: `/admin/content?tab=social&source=${source}` };
    if (source === "x") {
      const labels = { unconfigured: "수신 설정 미확인", missing: "보고 없음", invalid: "보고 형식 미확인", disabled: "중지 보고", ok: "정상 보고", stale: "보고 지연", error: "오류 보고" };
      return { ...base, status: x.report?.mode === "dry-run" ? "시험 실행 보고" : labels[x.state],
        // 보고가 끊겼거나 모양이 어긋나면 동작 중이 아니다 — 운영센터 X 칸(xSummary)처럼 주황
        tone: x.state === "error" ? "red" : x.state === "stale" || x.state === "invalid" ? "amber" : x.state === "ok" && x.report?.mode === "live" ? "green" : "gray",
        lastSuccessAt: x.report?.lastSuccessAt ?? null, note: `외부 수집기 · ${X_COLLECTOR_SCHEDULE} · 일일 보고 기준`, statusHref: "/admin/status?tab=crawlers" };
    }
    const name = SOURCE_JOB[source];
    if (!name) return { ...base, status: "수집 잡 없음", tone: "gray", lastSuccessAt: null, note: "보관 글만 표시 · 현재 자동 잡 미등록", statusHref: null };
    const job = jobs[name], intervalMs = intervalOf(name);
    const degraded = readJobDegraded(observations.find(row => row.key === `job:${name}`)?.value).current;
    const statusHref = `/admin/status?tab=jobs&job=${name}`;
    return { ...base, href: statusHref, statusHref, ...socialCollectorRuntime(job, enabled, !!degraded, { now: now.getTime(), intervalMs }),
      lastSuccessAt: job?.lastSuccessAt ?? null, note: `${formatInterval(intervalMs)} 주기 · crawler${degraded ? ` · ${degraded.code}` : ""}` };
  });
}

/** 수집 잡 두 줄만 — 운영 홈은 작업 제어 판(listJobStates)에서 같은 jobRuntimeState 로 만든다 */
async function readSocialFlowJobs(now: number): Promise<SocialFlowJobs> {
  const rows = await db.select({ name: jobRows.name, lockedAt: jobRows.lockedAt, notBefore: jobRows.notBefore, lastRunAt: jobRows.lastRunAt,
    lastSuccessAt: jobRows.lastSuccessAt, lastError: jobRows.lastError, requestedVersion: jobRows.requestedVersion, processedVersion: jobRows.processedVersion })
    .from(jobRows).where(inArray(jobRows.name, [...SOCIAL_FLOW_JOBS]));
  return Object.fromEntries(rows.map(row => [row.name, jobRuntimeState(row, now)]));
}

/**
 * 콘텐츠 운영 SNS 탭의 수집기 줄 — 운영 홈과 같은 판정(buildSocialCollectors)이고, 화제 순위·제품 연결 수는 읽지 않는다.
 * 목록을 넘길 때마다 다시 읽지 않게 웹 여러 대가 15초 나눠 쓴다(흐름 화면 conveyor 와 같은 층).
 */
const collectorCache = sharedLoader<SocialCollectorStatus>({ namespace: "admin:social-collectors", ttlMs: 15_000, store: sharedStore });

export function readSocialCollectors(): Promise<SocialCollectorStatus> {
  return collectorCache("v1", () => {
    const now = new Date();
    return onReplica(async () => {
      const [rows, observations, jobs, settings] = await Promise.all([
        readSocialSourceRows(now, false), readSocialObservations(), readSocialFlowJobs(now.getTime()), getSettings(),
      ]);
      return { measuredAt: now.toISOString(), collectors: buildSocialCollectors({ rows, observations, jobs, enabled: settings.enabled, now }) };
    });
  });
}

/** Reuses the public talk selector without the unrelated star-growth/history reads in listTalk. */
export function socialPublicationCounts(groups: Awaited<ReturnType<typeof talkGroups>>,
  decisions: readonly { repositoryKey: string; homeDecision: "approved" | "talk_only" | null }[]) {
  const scored = groups.filter(group => group.score !== null);
  const byKey = new Map(decisions.map(row => [row.repositoryKey, row.homeDecision]));
  const entries: TalkEntry[] = scored.slice(0, TALK_LIST_LIMIT).map((group, index) => ({
    ...group, score: group.score!, rank: index + 1, sources: [...new Set(group.posts.map(post => post.source))],
    byMaker: group.posts.some(post => post.kind === "show"), starGrowth: null, homeDecision: byKey.get(group.repositoryKey) ?? null,
  }));
  // loadHomeTalk reads a top-20 board, then applies the shared five-place home lineup.
  const home = homeTalkLineup(entries.slice(0, 20));
  return { qualifiedProjects: scored.length, talkProjects: entries.length, homeWaiting: home.waiting.length,
    homeProjects: (home.lead ? 1 : 0) + home.rest.length };
}

export async function readSocialFlowOverview(jobs: SocialFlowJobs): Promise<SocialFlowOverview> {
  const now = new Date();
  return onReplica(async () => {
    const [raw, observations, groups, settings] = await Promise.all([
      readSocialSourceRows(now, true), readSocialObservations(), talkGroups(now, "now"), getSettings(),
    ]);
    const selected = groups.filter(group => group.score !== null).slice(0, TALK_LIST_LIMIT);
    const decisions = selected.length ? await db.select({ repositoryKey: socialTalkDecisions.repositoryKey, homeDecision: socialTalkDecisions.homeDecision })
      .from(socialTalkDecisions).where(inArray(socialTalkDecisions.repositoryKey, selected.map(group => group.repositoryKey))) : [];
    const counts = socialPublicationCounts(groups, decisions);
    const collectors = buildSocialCollectors({ rows: raw, observations, jobs, enabled: settings.enabled, now });
    return { measuredAt: now.toISOString(), stored: raw.reduce((sum, row) => sum + row.count, 0), new24h: raw.reduce((sum, row) => sum + row.recent, 0),
      linked: raw.reduce((sum, row) => sum + row.linked, 0), ...counts, publicEnabled: talkPublicEnabled(), collectors };
  });
}
