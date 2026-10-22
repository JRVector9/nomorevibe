import { and, desc, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, operationsObservations, products, socialPosts, socialTalkDecisions, type SocialPostState, type SocialSource, type TalkHomeDecision } from "@/lib/db/schema";
import { readXStatus, X_STATUS_KEY } from "@/lib/operations/x-status";
import { readJobDegraded } from "@/lib/operations/job-health";
import { PRODUCT_IDENTITY, publicProductChecks, talkGroups } from "./talk";
import { shownPostIds, talkPlacement, talkVerdict, type TalkProductCheck } from "./talk-reasons";

/** 카탈로그의 HN·Bluesky 화제 수집 잡(lib/jobs/catalog.ts) */
const HN_TALK_JOB = "hn-talk";
const BLUESKY_TALK_JOB = "bluesky-talk";
export const REPOSITORY_KEY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** 모은 글 한 쪽 */
export const TALK_ADMIN_PAGE_SIZE = 50;
export type TalkAdminLink = "all" | "product" | "none" | "site";
/**
 * 모은 글 거르기 — 출처·상태·제품 연결(제품 있음·제품 없음·저장소 아님)·지금 /talk 에 보이는지, 순서(최근 게시·점수).
 * 모르는 값은 전체로 읽는다.
 */
export type TalkAdminFilter = {
  source: SocialSource | "all";
  state: SocialPostState | "all";
  link: TalkAdminLink;
  talk: "all" | "on" | "off";
  sort: "recent" | "points";
};

const pick = <T extends string>(raw: unknown, values: readonly T[], fallback: T): T =>
  typeof raw === "string" && (values as readonly string[]).includes(raw) ? raw as T : fallback;

/** ?source=&state=&link=&talk=&sort= 를 거르기로 */
export function talkAdminFilter(params: Record<string, unknown>): TalkAdminFilter {
  return {
    source: pick(params.source, ["all", "hn", "x", "geeknews", "bluesky"] as const, "all"),
    state: pick(params.state, ["all", "visible", "hidden", "gone"] as const, "all"),
    link: pick(params.link, ["all", "product", "none", "site"] as const, "all"),
    talk: pick(params.talk, ["all", "on", "off"] as const, "all"),
    sort: pick(params.sort, ["recent", "points"] as const, "recent"),
  };
}

/** 저장소 키로 이어진 제품이 있다(상태와 무관) — products_repository_identity_idx 를 탄다 */
const hasProduct = sql`(${socialPosts.repositoryKey} is not null and exists (
  select 1 from ${products} where ${PRODUCT_IDENTITY} = 'https://github.com/' || ${socialPosts.repositoryKey}))`;

function linkCondition(link: TalkAdminLink): SQL | undefined {
  if (link === "product") return hasProduct;
  if (link === "none") return sql`(${socialPosts.repositoryKey} is not null and not ${hasProduct})`;
  if (link === "site") return sql`${socialPosts.repositoryKey} is null`;
  return undefined;
}

function talkCondition(talk: TalkAdminFilter["talk"], shown: readonly number[]): SQL | undefined {
  if (talk === "on") return shown.length ? inArray(socialPosts.id, [...shown]) : sql`false`;
  if (talk === "off" && shown.length) return notInArray(socialPosts.id, [...shown]);
  return undefined;
}

export type TalkAdminSummary = {
  total: number;
  source: Record<SocialSource, number>;
  state: Record<SocialPostState, number>;
  link: Record<Exclude<TalkAdminLink, "all">, number>;
  talk: { on: number; off: number };
  /** 출처마다 마지막으로 글을 돌려받은 시각 */
  lastSeenAt: Partial<Record<SocialSource, Date>>;
};

/** 거르기 전 전체 수 — 거르기 단추 옆 숫자. shown 은 지금 /talk 에 보이는 글 수 */
async function talkAdminSummary(shown: number): Promise<TalkAdminSummary> {
  const rows = await db.select({
    source: socialPosts.source, state: socialPosts.state,
    count: sql<number>`count(*)::int`,
    site: sql<number>`(count(*) filter (where ${socialPosts.repositoryKey} is null))::int`,
    linked: sql<number>`(count(*) filter (where ${hasProduct}))::int`,
    lastSeenAt: sql<string | null>`max(${socialPosts.lastSeenAt})::text`,
  }).from(socialPosts).groupBy(socialPosts.source, socialPosts.state);
  const summary: TalkAdminSummary = {
    total: 0, source: { hn: 0, x: 0, geeknews: 0, bluesky: 0 }, state: { visible: 0, hidden: 0, gone: 0 },
    link: { product: 0, none: 0, site: 0 }, talk: { on: shown, off: 0 }, lastSeenAt: {},
  };
  for (const row of rows) {
    summary.total += row.count;
    summary.source[row.source] += row.count;
    summary.state[row.state] += row.count;
    summary.link.product += row.linked;
    summary.link.site += row.site;
    summary.link.none += row.count - row.linked - row.site;
    const seen = row.lastSeenAt ? new Date(row.lastSeenAt) : null;
    const known = summary.lastSeenAt[row.source];
    if (seen && (!known || seen > known)) summary.lastSeenAt[row.source] = seen;
  }
  summary.talk.off = summary.total - shown;
  return summary;
}

/** 쪽에 든 저장소의 제품 — 같은 저장소에 제품이 둘이면 공개 제품, 그다음 먼저 등록된 것 */
async function productsByKey(keys: readonly string[]): Promise<Map<string, TalkProductCheck>> {
  if (!keys.length) return new Map();
  const rows = await db.select({
    key: sql<string>`substring(${PRODUCT_IDENTITY} from '^https://github[.]com/(.+)$')`,
    slug: products.slug, status: products.status, ...publicProductChecks(),
  }).from(products)
    .where(sql`${PRODUCT_IDENTITY} in (${sql.join(keys.map(key => sql`${"https://github.com/" + key}`), sql`, `)})`)
    .orderBy(products.id);
  const byKey = new Map<string, TalkProductCheck>();
  for (const { key, ...row } of rows) {
    const current = byKey.get(key);
    if (!current || (row.publicProduct && !current.publicProduct)) byKey.set(key, row);
  }
  return byKey;
}

/**
 * 관리자 화면의 모은 글 — 보관 중인 모든 글(HN·X·Bluesky, 보임·숨김·지워짐, 저장소 없는 글까지)을 거르고 한 쪽씩.
 * 보관은 90일(수집 잡이 지난 글을 지운다)이라 따로 창을 걸지 않는다.
 * 글마다 지금 /talk 에 보이는지와 아니면 왜인지(talkVerdict)를 붙인다. /talk 조건은 talkGroups 가 공개 화면과 같은 식으로 읽는다.
 */
export async function listTalkPostsPage(filter: TalkAdminFilter, options: { now: Date; page: number; pageSize?: number }) {
  const { now } = options;
  const pageSize = options.pageSize ?? TALK_ADMIN_PAGE_SIZE;
  const placement = talkPlacement(await talkGroups(now, "now"));
  const shown = shownPostIds(placement);
  const where = and(
    filter.source === "all" ? undefined : eq(socialPosts.source, filter.source),
    filter.state === "all" ? undefined : eq(socialPosts.state, filter.state),
    linkCondition(filter.link), talkCondition(filter.talk, shown),
  );
  // 최근 게시 순은 social_posts_posted_idx 를 탄다
  const order = filter.sort === "points" ? [desc(socialPosts.points), desc(socialPosts.id)] : [desc(socialPosts.postedAt), desc(socialPosts.id)];
  const [rows, [counted], summary] = await Promise.all([
    db.select({
      id: socialPosts.id, source: socialPosts.source, externalId: socialPosts.externalId, kind: socialPosts.kind, title: socialPosts.title,
      linkUrl: socialPosts.linkUrl, linkTarget: socialPosts.linkTarget, repositoryKey: socialPosts.repositoryKey, postedAt: socialPosts.postedAt,
      points: socialPosts.points, comments: socialPosts.comments, frontPage: socialPosts.frontPage,
      state: socialPosts.state, stateReason: socialPosts.stateReason,
      firstSeenAt: socialPosts.firstSeenAt, lastSeenAt: socialPosts.lastSeenAt,
      excluded: sql<boolean>`coalesce(${socialTalkDecisions.excluded}, false)`,
    }).from(socialPosts)
      .leftJoin(socialTalkDecisions, eq(socialTalkDecisions.repositoryKey, socialPosts.repositoryKey))
      .where(where)
      .orderBy(...order)
      .limit(pageSize).offset(Math.max(0, options.page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)::int` }).from(socialPosts).where(where),
    talkAdminSummary(shown.length),
  ]);
  const productByKey = await productsByKey([...new Set(rows.map(row => row.repositoryKey).filter((key): key is string => Boolean(key)))]);
  return {
    total: counted?.total ?? 0,
    summary,
    rows: rows.map(row => {
      const product = row.repositoryKey ? productByKey.get(row.repositoryKey) ?? null : null;
      return { ...row, product, talk: talkVerdict({ ...row, product }, placement, now) };
    }),
  };
}

export type AdminTalkPost = Awaited<ReturnType<typeof listTalkPostsPage>>["rows"][number];

/** 글을 숨기거나 다시 보인다. 원문이 지워진 글(gone)은 건드리지 않는다 — 다시 보이면 수집이 되살린다 */
export async function setSocialPostsState(ids: readonly number[], state: "visible" | "hidden", at = new Date()): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.update(socialPosts)
    .set({ state, stateReason: state === "hidden" ? "admin" : null, stateChangedAt: at })
    .where(and(inArray(socialPosts.id, [...ids]), eq(socialPosts.state, state === "hidden" ? "visible" : "hidden")))
    .returning({ id: socialPosts.id });
  return rows.length;
}

/** 저장소를 화제에서 빼거나 되돌린다 — /talk·홈·상세 띠에서 모두 빠진다 */
export async function setTalkExcluded(repositoryKey: string, excluded: boolean, actor: string, reason: string | null) {
  if (!REPOSITORY_KEY.test(repositoryKey)) throw new Error("invalid_repository_key");
  await db.insert(socialTalkDecisions).values({ repositoryKey, excluded, reason, decidedBy: actor, decidedAt: new Date() })
    .onConflictDoUpdate({ target: socialTalkDecisions.repositoryKey, set: { excluded, reason, decidedBy: actor, decidedAt: new Date() } });
}

/** 홈 첫 화면 1위 자리 — approved 면 오르고, talk_only 면 /talk 에만, null 이면 정하지 않음 */
export async function setTalkHomeDecision(repositoryKey: string, decision: TalkHomeDecision | null, actor: string) {
  if (!REPOSITORY_KEY.test(repositoryKey)) throw new Error("invalid_repository_key");
  await db.insert(socialTalkDecisions).values({ repositoryKey, homeDecision: decision, decidedBy: actor, decidedAt: new Date() })
    .onConflictDoUpdate({ target: socialTalkDecisions.repositoryKey, set: { homeDecision: decision, decidedBy: actor, decidedAt: new Date() } });
}

/**
 * 수집 잡의 마지막 회차 — 돈 시각(lastRunAt)과 진짜 성공(lastSuccessAt)을 함께, 그리고 검색이 막혀 제 일을 못 한 회차(job:<name> 관측의
 * degraded — 지금 이어지는 것, lastDegraded — 끊기기 전 마지막 것). 전에는 던진 실패(lastError)만 보여 검색 실패가 "마지막 오류"에 오르지 않았다
 */
export async function hnTalkJobState(name = HN_TALK_JOB) {
  const [[row], [observation]] = await Promise.all([
    db.select({ lastRunAt: jobs.lastRunAt, lastSuccessAt: jobs.lastSuccessAt, lastError: jobs.lastError, cursor: jobs.cursor })
      .from(jobs).where(eq(jobs.name, name)).limit(1),
    db.select({ value: operationsObservations.value }).from(operationsObservations).where(eq(operationsObservations.key, `job:${name}`)).limit(1),
  ]);
  if (!row) return null;
  const { current, last } = readJobDegraded(observation?.value);
  return { ...row, degraded: current, lastDegraded: last };
}
export const blueskyTalkJobState = () => hnTalkJobState(BLUESKY_TALK_JOB);

/**
 * X 수집기의 하루 보고(관측 줄 x-status 한 줄) — 운영센터와 같은 readXStatus 로 읽는다. 화면 설명의 검색어(좋아요 하한)를
 * 보고에서 가져와, 수집기 검색어가 바뀌어도 글이 묵지 않게 한다. 못 읽으면 null.
 */
export async function xTalkStatus(now: Date) {
  const rows = await db.select({ key: operationsObservations.key, value: operationsObservations.value, observedAt: operationsObservations.observedAt })
    .from(operationsObservations).where(eq(operationsObservations.key, X_STATUS_KEY)).limit(1);
  return readXStatus(rows, now);
}
