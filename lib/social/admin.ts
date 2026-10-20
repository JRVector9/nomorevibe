import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, products, socialPosts, socialTalkDecisions, type TalkHomeDecision } from "@/lib/db/schema";

/** 카탈로그의 HN 화제 수집 잡(lib/jobs/catalog.ts) */
const HN_TALK_JOB = "hn-talk";
/** products_repository_identity_idx 와 같은 식(lib/social/talk.ts) */
const PRODUCT_IDENTITY = sql`regexp_replace(regexp_replace(lower(rtrim(${products.repoUrl}, '/')), '^https?://(www[.])?', 'https://'), '[.]git$', '')`;
export const REPOSITORY_KEY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** 관리자 화면의 화제 글 — 창 안의 모든 상태(보임·숨김·지워짐), 점수 큰 순 */
export async function listTalkPostsForAdmin(since: Date, limit = 200) {
  const rows = await db.select({
    id: socialPosts.id, source: socialPosts.source, externalId: socialPosts.externalId, kind: socialPosts.kind, title: socialPosts.title,
    linkTarget: socialPosts.linkTarget, repositoryKey: socialPosts.repositoryKey, postedAt: socialPosts.postedAt,
    points: socialPosts.points, comments: socialPosts.comments, state: socialPosts.state, stateReason: socialPosts.stateReason,
    excluded: sql<boolean>`coalesce(${socialTalkDecisions.excluded}, false)`,
  }).from(socialPosts)
    .leftJoin(socialTalkDecisions, eq(socialTalkDecisions.repositoryKey, socialPosts.repositoryKey))
    .where(gte(socialPosts.postedAt, since))
    .orderBy(desc(socialPosts.points), desc(socialPosts.id))
    .limit(limit);
  const keys = [...new Set(rows.map(row => row.repositoryKey).filter((key): key is string => Boolean(key)))];
  const linked = keys.length ? await db.select({ key: sql<string>`substring(${PRODUCT_IDENTITY} from '^https://github[.]com/(.+)$')`, slug: products.slug, status: products.status })
    .from(products)
    .where(sql`${PRODUCT_IDENTITY} in (${sql.join(keys.map(key => sql`${"https://github.com/" + key}`), sql`, `)})`)
    .orderBy(products.id) : [];
  const productByKey = new Map<string, { slug: string; status: string }>();
  for (const row of linked) if (!productByKey.has(row.key)) productByKey.set(row.key, { slug: row.slug, status: row.status });
  return rows.map(row => ({ ...row, product: row.repositoryKey ? productByKey.get(row.repositoryKey) ?? null : null }));
}

export type AdminTalkPost = Awaited<ReturnType<typeof listTalkPostsForAdmin>>[number];

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

/** 수집 잡의 마지막 회차 */
export async function hnTalkJobState() {
  const [row] = await db.select({ lastRunAt: jobs.lastRunAt, lastError: jobs.lastError, cursor: jobs.cursor })
    .from(jobs).where(eq(jobs.name, HN_TALK_JOB)).limit(1);
  return row ?? null;
}
