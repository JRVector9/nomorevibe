import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { socialPosts, type SocialSource } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { HnTalkPost } from "./hn-talk-source";

/** 출처와 무관한 글 한 건 — HN 수집과 X 보고가 같은 모양으로 넣는다. 저장소 열쇠는 site 글만 비운다(social-schema.ts) */
export type SocialPostInput = Omit<HnTalkPost, "repositoryKey"> & { repositoryKey: string | null };

/** 값이 그대로여도 이만큼 지나면 관측 한 줄을 다시 남긴다 — 곡선이 끊기지 않게 */
const OBSERVATION_REFRESH = "6 hours";

/**
 * 글을 넣거나 마지막 값으로 덮고, 값이 바뀐 글만 관측을 한 줄 남긴다.
 *
 * 관리자가 숨긴 글(hidden)은 다시 보여도 숨긴 채로 둔다. 원문이 지워져 내렸던 글(gone)이 다시 보이면 되살린다.
 */
export async function recordSocialPosts(source: SocialSource, posts: readonly SocialPostInput[], observedAt: Date, lease?: JobLease) {
  if (!posts.length) return { inserted: 0, updated: 0, observed: 0 };
  return withJobLeaseWrite(lease, tx => writeSocialPosts(tx, source, posts, observedAt));
}

/** recordSocialPosts 의 본문 — 이미 연 쓰기 트랜잭션 안에서(웹 관문의 X 보고 받기) */
export async function writeSocialPosts(tx: ProductTransaction, source: SocialSource, posts: readonly SocialPostInput[], observedAt: Date) {
  const unique = [...new Map(posts.map(post => [post.externalId, post])).values()];
  if (!unique.length) return { inserted: 0, updated: 0, observed: 0 };
  const rows = await tx.insert(socialPosts).values(unique.map(post => ({
    source, externalId: post.externalId, kind: post.kind, title: post.title, linkUrl: post.linkUrl,
    linkTarget: post.linkTarget, repositoryKey: post.repositoryKey, postedAt: post.postedAt,
    points: post.points, comments: post.comments, frontPage: post.frontPage,
    firstSeenAt: observedAt, lastSeenAt: observedAt,
  }))).onConflictDoUpdate({
    target: [socialPosts.source, socialPosts.externalId],
    set: {
      title: sql`excluded.title`,
      linkUrl: sql`excluded.link_url`,
      linkTarget: sql`excluded.link_target`,
      repositoryKey: sql`excluded.repository_key`,
      kind: sql`excluded.kind`,
      points: sql`excluded.points`,
      comments: sql`excluded.comments`,
      frontPage: sql`${socialPosts.frontPage} or excluded.front_page`,
      lastSeenAt: sql`greatest(${socialPosts.lastSeenAt}, excluded.last_seen_at)`,
      state: sql`case when ${socialPosts.state} = 'gone' then 'visible' else ${socialPosts.state} end`,
      stateReason: sql`case when ${socialPosts.state} = 'gone' then null else ${socialPosts.stateReason} end`,
      stateChangedAt: sql`case when ${socialPosts.state} = 'gone' then excluded.last_seen_at else ${socialPosts.stateChangedAt} end`,
    },
  }).returning({ id: socialPosts.id, inserted: sql<boolean>`xmax = 0` });
  const at = observedAt.toISOString();
  const observed = await tx.execute<{ post_id: number }>(sql`
    INSERT INTO social_post_observations (post_id, observed_at, points, comments)
    SELECT p.id, ${at}::timestamptz, p.points, p.comments
    FROM social_posts p
    LEFT JOIN LATERAL (
      SELECT o.observed_at, o.points, o.comments FROM social_post_observations o
      WHERE o.post_id = p.id ORDER BY o.observed_at DESC LIMIT 1
    ) last ON true
    WHERE p.id IN (${sql.join(rows.map(row => sql`${row.id}`), sql`, `)})
      AND (last.observed_at IS NULL OR last.points <> p.points OR last.comments <> p.comments
        OR last.observed_at <= ${at}::timestamptz - ${OBSERVATION_REFRESH}::interval)
    ON CONFLICT DO NOTHING
    RETURNING post_id`);
  const inserted = rows.filter(row => row.inserted).length;
  return { inserted, updated: rows.length - inserted, observed: observed.length };
}

/** 창 안의 보이는 글 중 이번 회차에 돌아오지 않은 것 — 지워졌는지 ID로 다시 물을 대상 */
export async function postsMissingSince(source: SocialSource, postedSince: Date, seenBefore: Date, limit = 200) {
  return db.select({ id: socialPosts.id, externalId: socialPosts.externalId }).from(socialPosts)
    .where(and(eq(socialPosts.source, source), eq(socialPosts.state, "visible"),
      gte(socialPosts.postedAt, postedSince), lt(socialPosts.lastSeenAt, seenBefore)))
    .orderBy(socialPosts.postedAt)
    .limit(limit);
}

/** 원문이 사라진 글을 내린다. 관리자가 숨긴 글은 그대로 둔다 */
export async function markSocialPostsGone(ids: readonly number[], at: Date, lease?: JobLease): Promise<number> {
  if (!ids.length) return 0;
  const rows = await withJobLeaseWrite(lease, tx => tx.update(socialPosts)
    .set({ state: "gone", stateReason: "source_missing", stateChangedAt: at })
    .where(and(inArray(socialPosts.id, [...ids]), eq(socialPosts.state, "visible")))
    .returning({ id: socialPosts.id }));
  return rows.length;
}

/** 출처가 사용할 수 없다고 알린 글(ID)을 내린다 — 이미 받은 글만, 관리자가 숨긴 글은 그대로 */
export async function markSocialPostsGoneByExternalId(tx: ProductTransaction, source: SocialSource, externalIds: readonly string[], at: Date): Promise<number> {
  if (!externalIds.length) return 0;
  const rows = await tx.update(socialPosts)
    .set({ state: "gone", stateReason: "source_unavailable", stateChangedAt: at })
    .where(and(eq(socialPosts.source, source), inArray(socialPosts.externalId, [...externalIds]), eq(socialPosts.state, "visible")))
    .returning({ id: socialPosts.id });
  return rows.length;
}

/** 보관 기간이 지난 글을 지운다(관측은 함께 지워진다). 한 번에 limit 건까지 */
export async function deleteExpiredSocialPosts(postedBefore: Date, lease?: JobLease, limit = 500): Promise<number> {
  const rows = await withJobLeaseWrite(lease, tx => tx.execute<{ id: number }>(sql`
    DELETE FROM social_posts WHERE id IN (
      SELECT id FROM social_posts WHERE posted_at < ${postedBefore.toISOString()}::timestamptz ORDER BY posted_at LIMIT ${limit}
    ) RETURNING id`));
  return rows.length;
}
