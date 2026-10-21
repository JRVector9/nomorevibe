import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { BLUESKY_BOT_HOLD, type BlueskyTalkPost } from "./bluesky-talk-source";
import { writeSocialPosts } from "./repository";
import { PRODUCT_IDENTITY } from "./talk";

/**
 * Bluesky 글 쓰기 — 넣기·덮기·관측은 다른 출처와 같은 writeSocialPosts, 그 위에 Bluesky 만의 숨김(라벨·봇)을 같은 트랜잭션에서 건다.
 *
 * 숨김은 state = hidden 에 까닭(state_reason)을 단다. 관리자가 숨긴 글('admin')은 건드리지 않는다.
 * - label:<값>: 회차마다 다시 정한다 — 라벨이 붙으면 숨기고(관리자가 다시 보이게 한 글도), 떼어지면 다시 보인다.
 * - bot_suspected: 한 번 걸면 관리자가 다시 보이게 하기 전까지 둔다. 관리자가 보이게 한 글(state_changed_at 이 있다)에는 다시 걸지 않는다.
 */
/** 수집기가 건 숨김(관리자가 건 것이 아닌) — 다시 묻기·내리기·풀기의 대상 */
const SYSTEM_HOLD = sql`(state = 'hidden' and (state_reason = ${BLUESKY_BOT_HOLD} or state_reason like 'label:%'))`;

/** 글을 남기고 라벨 숨김을 맞춘다 */
export async function recordBlueskyPosts(posts: readonly BlueskyTalkPost[], observedAt: Date, lease?: JobLease) {
  if (!posts.length) return { inserted: 0, updated: 0, observed: 0, held: 0, released: 0 };
  return withJobLeaseWrite(lease, async tx => {
    const written = await writeSocialPosts(tx, "bluesky", posts, observedAt, { periodic: false });
    return { ...written, ...await applyLabelHolds(tx, posts, observedAt) };
  });
}

/**
 * 라벨 숨김 — 라벨이 있으면 보이는 글·봇 숨김·다른 라벨 숨김을 그 라벨로, 없으면 라벨 숨김만 푼다.
 * 원문 삭제로 내렸다가 이번에 되살아난 글(writeSocialPosts 가 visible 로 돌림)도 여기서 다시 맞춘다.
 */
async function applyLabelHolds(tx: ProductTransaction, posts: readonly BlueskyTalkPost[], at: Date) {
  const unique = [...new Map(posts.map(post => [post.externalId, post.labelHold])).entries()];
  const values = sql.join(unique.map(([id, hold]) => sql`(${id}, ${hold}::varchar)`), sql`, `);
  const rows = await tx.execute<{ held: boolean }>(sql`
    UPDATE social_posts p SET
      state = CASE WHEN v.hold IS NULL THEN 'visible' ELSE 'hidden' END,
      state_reason = v.hold,
      state_changed_at = ${at.toISOString()}::timestamptz
    FROM (VALUES ${values}) AS v(external_id, hold)
    WHERE p.source = 'bluesky' AND p.external_id = v.external_id
      AND (
        (v.hold IS NOT NULL AND (p.state = 'visible' OR (p.state = 'hidden' AND p.state_reason IS DISTINCT FROM v.hold
          AND (p.state_reason = ${BLUESKY_BOT_HOLD} OR p.state_reason LIKE 'label:%'))))
        OR (v.hold IS NULL AND p.state = 'hidden' AND p.state_reason LIKE 'label:%')
      )
    RETURNING v.hold IS NOT NULL AS held`);
  const held = rows.filter(row => row.held).length;
  return { held, released: rows.length - held };
}

/**
 * 봇으로 보이는 계정 — 창 안에 GitHub 링크 글을 minPosts 개 이상 남긴 계정. 계정 칸이 없으므로 글 ID 의 DID 부분으로 세고,
 * 결과는 이 회차 메모리에만 둔다(어느 계정이 봇인지 저장하지 않는다).
 */
export async function heavyBlueskyAccounts(postedSince: Date, minPosts: number): Promise<string[]> {
  const rows = await db.execute<{ did: string }>(sql`
    SELECT split_part(external_id, '/', 1) AS did FROM social_posts
    WHERE source = 'bluesky' AND posted_at >= ${postedSince.toISOString()}::timestamptz
    GROUP BY 1 HAVING count(*) >= ${minPosts}`);
  return rows.map(row => row.did);
}

/**
 * 봇 숨김 — 그 계정의 창 안 보이는 글을 숨긴다. 한 번도 상태를 바꾼 적 없는 글과 이번 회차에 상태가 바뀐 글(되살아남·라벨 풀림)만:
 * 관리자가 다시 보이게 한 글은 state_changed_at 이 그때라 다시 숨기지 않는다.
 */
export async function holdBotPosts(dids: readonly string[], postedSince: Date, at: Date, lease?: JobLease): Promise<number> {
  if (!dids.length) return 0;
  const rows = await withJobLeaseWrite(lease, tx => tx.execute<{ id: number }>(sql`
    UPDATE social_posts SET state = 'hidden', state_reason = ${BLUESKY_BOT_HOLD}, state_changed_at = ${at.toISOString()}::timestamptz
    WHERE source = 'bluesky' AND state = 'visible' AND posted_at >= ${postedSince.toISOString()}::timestamptz
      AND split_part(external_id, '/', 1) IN (${sql.join(dids.map(did => sql`${did}`), sql`, `)})
      AND (state_changed_at IS NULL OR state_changed_at = ${at.toISOString()}::timestamptz)
    RETURNING id`));
  return rows.length;
}

/** 저장소 키로 이어진 제품이 있다 — 공개 화면에 오를 수 있는 글이라 먼저 다시 묻는다 */
const linked = sql`(repository_key IS NOT NULL AND EXISTS (
  SELECT 1 FROM products WHERE ${PRODUCT_IDENTITY} = 'https://github.com/' || social_posts.repository_key))`;

/**
 * 이번 회차에 다시 물을 글 — 검색에서 돌아오지 않은 글 중
 * 1) 제품에 이어진 보이는 글(공개 화면 기간 visibleSince 안) — 지운 글이 하루 안에 빠지도록 회차마다 먼저,
 * 2) 창(windowSince) 안의 나머지 보이는·수집기가 숨긴 글 — 오래 확인 못 한 것부터.
 */
export async function blueskyPostsToRecheck(windowSince: Date, visibleSince: Date, seenBefore: Date, limit: number) {
  return db.execute<{ id: number; external_id: string }>(sql`
    SELECT id, external_id FROM social_posts
    WHERE source = 'bluesky' AND last_seen_at < ${seenBefore.toISOString()}::timestamptz
      AND ((posted_at >= ${windowSince.toISOString()}::timestamptz AND (state = 'visible' OR ${SYSTEM_HOLD}))
        OR (posted_at >= ${visibleSince.toISOString()}::timestamptz AND state = 'visible' AND ${linked}))
    ORDER BY (state = 'visible' AND ${linked}) DESC, last_seen_at, id
    LIMIT ${limit}`);
}

/** 다시 물었는데 돌아오지 않은 글(지워짐·계정 내려감)을 내린다. 관리자가 숨긴 글은 그대로 */
export async function markBlueskyPostsGone(ids: readonly number[], at: Date, lease?: JobLease): Promise<number> {
  if (!ids.length) return 0;
  const rows = await withJobLeaseWrite(lease, tx => tx.execute<{ id: number }>(sql`
    UPDATE social_posts SET state = 'gone', state_reason = 'source_missing', state_changed_at = ${at.toISOString()}::timestamptz
    WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) AND source = 'bluesky' AND (state = 'visible' OR ${SYSTEM_HOLD})
    RETURNING id`));
  return rows.length;
}

/**
 * 원문이 지워진 Bluesky 글은 goneBefore 가 지나면 행째 지운다(관측도 함께) — 지운 글의 주소를 90일 보관까지 들고 있지 않는다.
 * 그 사이에는 관리자 화면에 '원문 삭제'로 보이고, 다시 나타나면(계정 복구 등) 되살린다.
 */
export async function purgeGoneBlueskyPosts(goneBefore: Date, lease?: JobLease, limit = 500): Promise<number> {
  const rows = await withJobLeaseWrite(lease, tx => tx.execute<{ id: number }>(sql`
    DELETE FROM social_posts WHERE id IN (
      SELECT id FROM social_posts WHERE source = 'bluesky' AND state = 'gone' AND state_changed_at < ${goneBefore.toISOString()}::timestamptz
      ORDER BY state_changed_at LIMIT ${limit}
    ) RETURNING id`));
  return rows.length;
}
