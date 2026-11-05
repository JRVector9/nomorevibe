import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { crawlPublicationChanges, operationsObservations, products, socialPosts, socialTalkDecisions, type SocialSource } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import { homeTalkLineup, PRODUCT_IDENTITY, TALK_LIST_LIMIT, talkGroups, type TalkEntry } from "@/lib/social/talk";
import { talkPublicEnabled } from "@/lib/social/flags";
import { readJobDegraded } from "./job-health";
import { readXStatus, X_STATUS_KEY } from "./x-status";
import type { ProjectFlowOverview, SocialCollector, SocialFlowOverview } from "./flow-overview-model";

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
/** A job row without a live execution or a successful run is not proof of a healthy collector. */
export function socialCollectorRuntime(job: SocialJob | undefined, enabled: boolean, degraded: boolean): Pick<SocialCollector, "status" | "tone"> {
  if (!job) return { status: "작업 관측 미확인", tone: "gray" };
  if (!enabled || job.paused) return { status: "수집 중지", tone: "gray" };
  if (job.execution === "stale" || job.runtimeLabel === "중단·회수 대기") return { status: "중단·회수 대기", tone: "amber" };
  if (degraded || job.lastError) return { status: degraded ? "수집 미완료" : "오류", tone: "amber" };
  if (job.execution === "locked" || job.runtimeLabel === "실행 중") return { status: "실행 중", tone: "green" };
  if (!job.runtimeLabel || job.runtimeLabel === "실행 기록 없음" || !job.lastSuccessAt) return { status: job.runtimeLabel ?? "상태 미확인", tone: "gray" };
  return { status: job.runtimeLabel, tone: job.runtimeLabel === "유휴" ? "green" : "gray" };
}
const SOURCES: readonly SocialSource[] = ["hn", "bluesky", "x", "geeknews"];
const SOURCE_LABEL: Record<SocialSource, string> = { hn: "Hacker News", bluesky: "Bluesky", x: "X", geeknews: "GeekNews" };

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
      db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
        const rows = await tx.execute<{ source: SocialSource; count: number; recent: number; linked: number; last_seen: string | null }>(sql`
          SELECT ${socialPosts.source} AS source, count(*)::int AS count,
            count(*) FILTER (WHERE ${socialPosts.firstSeenAt} > ${now.toISOString()}::timestamptz - interval '24 hours'
              AND ${socialPosts.firstSeenAt} <= ${now.toISOString()}::timestamptz)::int AS recent,
            count(*) FILTER (WHERE ${socialPosts.repositoryKey} IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${products} WHERE ${PRODUCT_IDENTITY} = 'https://github.com/' || ${socialPosts.repositoryKey}))::int AS linked,
            to_char(max(${socialPosts.lastSeenAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen
          FROM ${socialPosts} GROUP BY ${socialPosts.source}`);
        return [...rows];
      }, { accessMode: "read only" }),
      db.select({ key: operationsObservations.key, value: operationsObservations.value, observedAt: operationsObservations.observedAt })
        .from(operationsObservations).where(inArray(operationsObservations.key, [X_STATUS_KEY, ...SOCIAL_FLOW_JOBS.map(name => `job:${name}`)])),
      talkGroups(now, "now"), getSettings(),
    ]);
    const selected = groups.filter(group => group.score !== null).slice(0, TALK_LIST_LIMIT);
    const decisions = selected.length ? await db.select({ repositoryKey: socialTalkDecisions.repositoryKey, homeDecision: socialTalkDecisions.homeDecision })
      .from(socialTalkDecisions).where(inArray(socialTalkDecisions.repositoryKey, selected.map(group => group.repositoryKey))) : [];
    const counts = socialPublicationCounts(groups, decisions);
    // Inspect the persisted authenticated collector report; this read does not assert this web's receiver-secret configuration.
    const x = readXStatus(observations, now, true);
    const collectors: SocialCollector[] = SOURCES.map(source => {
      const stored = raw.find(row => row.source === source);
      const base = { source, label: SOURCE_LABEL[source], stored: stored?.count ?? 0, new24h: stored?.recent ?? 0,
        lastSeenAt: stored?.last_seen ?? null, href: `/admin/content?tab=social&source=${source}` };
      if (source === "x") {
        const labels = { unconfigured: "수신 설정 미확인", missing: "보고 없음", invalid: "보고 형식 미확인", disabled: "중지 보고", ok: "정상 보고", stale: "보고 지연", error: "오류 보고" };
        return { ...base, status: x.report?.mode === "dry-run" ? "시험 실행 보고" : labels[x.state],
          tone: x.state === "error" ? "red" : x.state === "ok" && x.report?.mode === "live" ? "green" : "gray",
          lastSuccessAt: x.report?.lastSuccessAt ?? null, note: "외부 수집기 · 일일 보고 기준" };
      }
      if (source === "geeknews") return { ...base, status: "수집 잡 없음", tone: "gray", lastSuccessAt: null, note: "보관 글만 표시 · 현재 자동 잡 미등록" };
      const name = source === "hn" ? "hn-talk" : "bluesky-talk", job = jobs[name];
      const degraded = readJobDegraded(observations.find(row => row.key === `job:${name}`)?.value).current;
      return { ...base, href: `/admin/status?tab=jobs&job=${name}`, ...socialCollectorRuntime(job, settings.enabled, !!degraded), lastSuccessAt: job?.lastSuccessAt ?? null,
        note: `${source === "hn" ? "30분" : "2시간"} 주기 · crawler${degraded ? ` · ${degraded.code}` : ""}` };
    });
    return { measuredAt: now.toISOString(), stored: raw.reduce((sum, row) => sum + row.count, 0), new24h: raw.reduce((sum, row) => sum + row.recent, 0),
      linked: raw.reduce((sum, row) => sum + row.linked, 0), ...counts, publicEnabled: talkPublicEnabled(), collectors };
  });
}
