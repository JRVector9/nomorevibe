import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentRepositoryObservations,
  agentRepositoryScans,
  crawlCandidates,
  crawlDocuments,
  products,
  productUpdates,
  type ProductStatus,
} from "@/lib/db/schema";
import { getSettings as getCrawlSettings } from "@/lib/crawl/settings";
import { agentClientLabel } from "@/lib/domain/evidence/agents/view";
import { clickChangePercent } from "@/lib/domain/ranking/math";
import { CATEGORIES, type Category } from "./schema";

const DAY_MS = 86_400_000;
const LISTED: ProductStatus[] = ["verified", "seeded"];
export const BORN_CHANGE_MIN = 20;
export const ACTIVE_LIMIT = 10;
export const METHOD_VERSION = "2.1";

/**
 * 홈 윗줄과 리더보드.
 *
 * 헷갈리던 "이번 주"를 동사로 가른다 — 태어났다(저장소를 처음 만듦) · 새 버전을 냈다(릴리스) ·
 * 소개됐다(우리 목록에 오름). 홈에는 앞의 둘만 싣는다.
 */
export type HomePulse = {
  asOf: Date;
  timezone: "Asia/Seoul";
  methodVersion: typeof METHOD_VERSION;
  /** 저장소를 처음 만든 날(GitHub created_at)이 끝난 7일 안인 공개 프로젝트 */
  born: { current: number; previous: number; change: number | null };
  /** 끝난 7일에 새 버전(GitHub 릴리스·제작자 업데이트)을 낸 프로젝트 */
  updates: { projects: number; releases: number };
  /** 새 버전을 가장 많이 낸 프로젝트 */
  active: { slug: string; name: string; category: Category; releases: number; stars: number | null }[];
  /** 분야별 공개 수와 그중 이번 주 태어난 수 — 공개 수 순 */
  categories: { key: Category; total: number; born: number }[];
  /** 저장소에서 흔적을 찾은 제작 도구. 관찰 사실 공개가 꺼져 있으면 null */
  tools: { scanned: number; withTool: number; rows: { label: string; count: number }[] } | null;
  total: number;
};

export function kstCalendarDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 오늘 KST 0시. 아직 끝나지 않은 오늘은 집계에 넣지 않는다. */
export function kstMidnightUtc(now: Date): Date {
  return new Date(`${kstCalendarDate(now)}T00:00:00+09:00`);
}

export function completedWindows(now: Date) {
  const asOf = kstMidnightUtc(now);
  return {
    asOf,
    weekStart: new Date(asOf.getTime() - 7 * DAY_MS),
    prevStart: new Date(asOf.getTime() - 14 * DAY_MS),
  };
}

export function formatAsOfKst(asOf: Date): string {
  const [, month, day] = kstCalendarDate(asOf).split("-");
  return `${month}.${day} 00:00 KST 기준`;
}

export function emptyHomePulse(now: Date): HomePulse {
  return {
    asOf: completedWindows(now).asOf,
    timezone: "Asia/Seoul",
    methodVersion: METHOD_VERSION,
    born: { current: 0, previous: 0, change: null },
    updates: { projects: 0, releases: 0 },
    active: [],
    categories: [],
    tools: null,
    total: 0,
  };
}

function at(date: Date) {
  return sql`${date.toISOString()}::timestamptz`;
}

/**
 * 집계를 잠깐 재사용하는 시간.
 *
 * 창은 KST 0시에 닫힌 완료 구간이라 같은 날에는 결과가 거의 바뀌지 않지만, 제품 상태(차단·검증)는
 * 지금 값으로 거르므로 하루 내내 담아 두면 차단한 제품이 자정까지 숫자·목록에 남는다. 1분이면
 * 요청마다 돌던 쿼리가 인스턴스당 분당 한 번으로 줄고, 상태 변화는 1분 안에 반영된다.
 * 공개 목록·카테고리 필터 개수는 담아 두지 않는다 — 차단·생존 상태가 바로 보여야 한다.
 */
const HOME_PULSE_TTL_MS = 60_000;
let cachedPulse: { key: string; expiresAt: number; value: Promise<HomePulse> } | null = null;

/** 집계 창은 now 의 KST 날짜로만 정해진다 — 그 날짜와 집계 버전을 키로 잡는다 */
export async function getHomePulse(now = new Date()): Promise<HomePulse> {
  const key = `${kstCalendarDate(now)}:${METHOD_VERSION}`;
  if (cachedPulse?.key === key && now.getTime() < cachedPulse.expiresAt) return cachedPulse.value;
  const entry = { key, expiresAt: now.getTime() + HOME_PULSE_TTL_MS, value: loadHomePulse(now) };
  cachedPulse = entry;
  try {
    return await entry.value;
  } catch (error) {
    // 실패는 담아 두지 않는다 — 다음 요청이 다시 집계한다
    if (cachedPulse === entry) cachedPulse = null;
    throw error;
  }
}

/** 캐시 없이 한 번 집계한다 — 통합 테스트가 직접 부른다 */
export async function loadHomePulse(now: Date): Promise<HomePulse> {
  const { asOf, weekStart, prevStart } = completedWindows(now);
  const asOfAt = at(asOf);
  const weekAt = at(weekStart);
  const prevAt = at(prevStart);
  const releasedAt = sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt})`;
  const newVersion = and(
    inArray(products.status, LISTED),
    eq(productUpdates.visible, true),
    sql`${productUpdates.makerDeletedAt} is null`,
    inArray(productUpdates.sourceKind, ["github_release", "maker"]),
    sql`${releasedAt} >= ${weekAt}`,
    sql`${releasedAt} < ${asOfAt}`,
  );

  /** 제품 p 의 저장소 메타 d — 제품에 후보가 여럿이면 마지막 것 */
  const repoOf = sql`
    left join lateral (select c.repo from ${crawlCandidates} c where c.published_slug = p.slug order by c.id desc limit 1) c on true
    left join ${crawlDocuments} d on d.repo = c.repo`;
  const bornAt = sql`(d.repo_meta->>'created_at')::timestamptz`;

  const [categoryRows, updateRow, activeRows, tools] = await Promise.all([
    db.execute<{ category: Category; total: number; born: number; born_prev: number }>(sql`
      select p.category, count(*)::int as total,
             (count(*) filter (where ${bornAt} >= ${weekAt} and ${bornAt} < ${asOfAt}))::int as born,
             (count(*) filter (where ${bornAt} >= ${prevAt} and ${bornAt} < ${weekAt}))::int as born_prev
        from ${products} p ${repoOf}
       where p.status in ('verified', 'seeded') and coalesce(p.verified_at, p.created_at) < ${asOfAt}
       group by p.category`),
    db
      .select({
        releases: sql<number>`count(*)::int`,
        projects: sql<number>`count(distinct ${productUpdates.slug})::int`,
      })
      .from(productUpdates)
      .innerJoin(products, eq(products.slug, productUpdates.slug))
      .where(newVersion)
      .then((rows) => rows[0]),
    db.execute<{ slug: string; name: string; category: Category; releases: number; stars: number | null }>(sql`
      select p.slug, p.name, p.category, u.releases, (d.repo_meta->>'stargazers_count')::int as stars
        from (select ${productUpdates.slug} as slug, count(*)::int as releases
                from ${productUpdates} join ${products} on ${products.slug} = ${productUpdates.slug}
               where ${newVersion} group by ${productUpdates.slug}) u
        join ${products} p on p.slug = u.slug ${repoOf}
       order by u.releases desc, p.slug
       limit ${ACTIVE_LIMIT}`),
    // 제품 화면에서 관찰 사실을 숨겨 둔 동안에는 홈에서도 세지 않는다
    getCrawlSettings().then((settings) => settings.agentEvidence.displayObservedFacts ? loadTools(asOfAt) : null),
  ]);

  const rows = [...categoryRows];
  const byCategory = new Map(rows.map((row) => [row.category, row]));
  const current = rows.reduce((sum, row) => sum + Number(row.born), 0);
  const previous = rows.reduce((sum, row) => sum + Number(row.born_prev), 0);

  return {
    asOf,
    timezone: "Asia/Seoul",
    methodVersion: METHOD_VERSION,
    born: { current, previous, change: clickChangePercent(current, previous, BORN_CHANGE_MIN) },
    updates: {
      projects: updateRow?.projects ?? 0,
      releases: updateRow?.releases ?? 0,
    },
    active: [...activeRows].map((row) => ({
      slug: row.slug,
      name: row.name,
      category: row.category,
      releases: Number(row.releases),
      stars: row.stars === null ? null : Number(row.stars),
    })),
    categories: CATEGORIES
      .map((key) => ({ key, total: Number(byCategory.get(key)?.total ?? 0), born: Number(byCategory.get(key)?.born ?? 0) }))
      .filter((row) => row.total > 0)
      .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key)),
    tools,
    total: rows.reduce((sum, row) => sum + Number(row.total), 0),
  };
}

/** 공개 제품 저장소마다 마지막으로 끝난 도구 흔적 조사 — 흔적은 사용 주장이지 실행 증명이 아니다 */
async function loadTools(asOfAt: ReturnType<typeof at>): Promise<NonNullable<HomePulse["tools"]>> {
  const scanned = sql`
    with repos as (
      select distinct lower(c.repo) as repo_key, p.slug
        from ${products} p join ${crawlCandidates} c on c.published_slug = p.slug
       where p.status in ('verified', 'seeded') and coalesce(p.verified_at, p.created_at) < ${asOfAt}),
    latest as (
      select distinct on (repository_key) id, repository_key from ${agentRepositoryScans}
       where state in ('complete', 'partial') and scope = ''
       order by repository_key, completed_at desc nulls last, id desc)
    select r.slug, s.id as scan_id from repos r join latest s on s.repository_key = r.repo_key`;
  const [clientRows, coverageRows] = await Promise.all([
    db.execute<{ client: string; count: number }>(sql`
      select o.facts->>'client' as client, count(distinct r.slug)::int as count
        from (${scanned}) r join ${agentRepositoryObservations} o on o.scan_id = r.scan_id
       where o.facts->>'client' is not null
       group by 1`),
    db.execute<{ scanned: number; with_tool: number }>(sql`
      select count(distinct r.slug)::int as scanned,
             (count(distinct r.slug) filter (where exists (
               select 1 from ${agentRepositoryObservations} o where o.scan_id = r.scan_id and o.facts->>'client' is not null)))::int as with_tool
        from (${scanned}) r`),
  ]);
  // 같은 도구가 다른 키로 잡혀도(roo·roo-code) 한 줄로 — 조사기는 한 저장소에 한 가지 키만 남긴다
  const counts = new Map<string, number>();
  for (const row of clientRows) {
    const label = agentClientLabel(row.client);
    counts.set(label, (counts.get(label) ?? 0) + Number(row.count));
  }
  const [coverage] = [...coverageRows];
  return {
    scanned: Number(coverage?.scanned ?? 0),
    withTool: Number(coverage?.with_tool ?? 0),
    rows: [...counts]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
  };
}
