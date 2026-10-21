import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { clickEvents, products, rateLimits } from "@/lib/db/schema";
import { makerReplies, productReactions } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { PublicAuthError } from "@/lib/domain/accounts/errors";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { productVisitorHash } from "@/lib/domain/products/visitors";
import type { ReactionTag } from "@/lib/me/contract";
import {
  nextChangeCount, REACTION_SUMMARY_MIN, ReactionError, reviewReactionComment, TRIED_VERIFY_DAYS,
  type ReactionListItem, type ReactionMine, type ReactionSummary, type ReactionWrite,
} from "./contract";

/**
 * 써봤어요 저장소 — 한 제품에 한 사람(계정 또는 이 브라우저) 평가 하나.
 *
 * 열쇠가 둘이다: 로그인하면 user_id, 아니면 제품별 방문자 해시(productVisitorHash, /go 의 click_events 와 같은 값).
 * 두 고유 색인을 한 ON CONFLICT 로 함께 지킬 수 없어, 쓰기는 모두 제품별 advisory lock 안에서 읽고 고른 뒤 쓴다.
 * 익명 행은 user_id 가 비어 있을 때만 그 브라우저의 것이다 — 계정 행에 남은 해시로는 로그아웃한 브라우저가 읽지 못한다.
 * 로그인한 쓰기는 이 브라우저의 익명 행을 읽지도 가져가지도 않는다 — 익명 행은 써봤어요 탭의 «옮기기»(mergeBrowserReactions)로만
 * 계정에 붙는다(공용 PC 에서 남이 남긴 평가가 묻지도 않고 내 계정에 붙지 않게).
 */

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;
type ReactionRow = typeof productReactions.$inferSelect;
/** 요청한 사람 — 로그인 계정 id 와 nmv_visitor 원문(해시는 제품마다 여기서 만든다) */
export type ReactionOwner = { userId: number | null; visitor: string | null };

/** pg_advisory_xact_lock(이 값, product_id) — 제품 하나의 평가 쓰기를 한 줄로 세운다 */
const REACTION_LOCK = 6983;
const HOUR = 3_600;
/** 신뢰할 IP 가 없을 때 제품 하나에 시간당 랭킹에 세는 새 익명 줄 — 넘으면 받기는 하되 랭킹·공개 요약에서 뺀다 */
export const UNTRUSTED_NEW_ANONYMOUS_PER_HOUR = 30;
/** 제품 하나에 시간당 랭킹에 세는 평가 변경 — 넘은 변경은 받기는 하되 랭킹·공개 요약에서 뺀다 */
export const REACTION_FLOOD_PER_HOUR = 120;

const toMine = (row: ReactionRow): ReactionMine => ({
  verdict: row.verdict, tags: row.tags as ReactionTag[], comment: row.comment, commentState: row.commentState,
  triedVerified: row.triedVerified, updatedAt: row.updatedAt.toISOString(),
});

async function findProduct(source: Executor, slug: string): Promise<{ id: number } | null> {
  const [product] = await source.select({ id: products.id, status: products.status }).from(products).where(eq(products.slug, slug));
  return product && product.status !== "banned" ? { id: product.id } : null;
}

/** 공개 요약 — 급증으로 뺀 행은 세지 않는다. 셋 미만이면 숫자를 내지 않는다 */
async function summaryOf(source: Executor, productId: number): Promise<ReactionSummary | null> {
  const [row] = await source.select({
    tried: sql<number>`count(*)::int`,
    good: sql<number>`count(*) filter (where ${productReactions.verdict} = 'good')::int`,
    meh: sql<number>`count(*) filter (where ${productReactions.verdict} = 'meh')::int`,
    bad: sql<number>`count(*) filter (where ${productReactions.verdict} = 'bad')::int`,
  }).from(productReactions).where(and(eq(productReactions.productId, productId), eq(productReactions.rankingExcluded, false)));
  return row && row.tried >= REACTION_SUMMARY_MIN ? row : null;
}

/** 이 계정의 행과 이 브라우저 해시를 쥔 행(누구 것이든) — 해시를 쥔 행은 쓰기가 해시를 옮길지 정할 때만 본다 */
function ownedRows(source: Executor, productId: number, userId: number | null, hash: string | null): Promise<ReactionRow[]> {
  const keys = [userId ? eq(productReactions.userId, userId) : undefined, hash ? eq(productReactions.visitorHash, hash) : undefined].filter(Boolean);
  if (keys.length === 0) return Promise.resolve([]);
  return source.select().from(productReactions).where(and(eq(productReactions.productId, productId), or(...keys)));
}

/** 내 평가 — 로그인하면 계정 행만, 아니면 이 브라우저의 익명 행. 로그인했어도 익명 행으로 넘어가지 않는다(합치기는 묻고 나서만) */
function currentOf(rows: ReactionRow[], userId: number | null, hash: string | null): ReactionRow | undefined {
  if (userId) return rows.find((row) => row.userId === userId);
  return hash ? rows.find((row) => row.visitorHash === hash && row.userId === null) : undefined;
}

export async function lockProduct(tx: Transaction, productId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${REACTION_LOCK}, ${productId})`);
}

/** 같은 TX 안의 한도 — 한 줄이 실제로 바뀔 때만 센다(실패하면 함께 되돌린다) */
async function withinQuota(tx: Transaction, key: string, limit: number, seconds: number): Promise<boolean> {
  const window = sql.raw(`interval '${seconds} seconds'`);
  const [row] = await tx.insert(rateLimits).values({ key, count: 1, resetAt: sql`now() + ${window}` }).onConflictDoUpdate({
    target: rateLimits.key,
    set: {
      count: sql`case when ${rateLimits.resetAt} <= now() then 1 else ${rateLimits.count} + 1 end`,
      resetAt: sql`case when ${rateLimits.resetAt} <= now() then now() + ${window} else ${rateLimits.resetAt} end`,
    },
  }).returning({ count: rateLimits.count });
  return Boolean(row) && row.count <= limit;
}

/** 7일 안에 같은 제품별 해시로 /go 를 지났다 = 써봄 확인 */
async function clickedRecently(tx: Transaction, slug: string, hash: string): Promise<boolean> {
  const [row] = await tx.select({ id: clickEvents.id }).from(clickEvents).where(and(
    eq(clickEvents.slug, slug), eq(clickEvents.visitorHash, hash),
    gte(clickEvents.occurredAt, sql`timezone('UTC', now()) - ${TRIED_VERIFY_DAYS} * interval '1 day'`),
  )).limit(1);
  return Boolean(row);
}

/** 여러 제품을 오가는 연타 한도의 열쇠 — 제품을 넘어 이을 수 없는 해시와 따로 둔다(rate_limits 에만) */
export function reactionRateKey(visitor: string): string | null {
  return productVisitorHash("rl:", visitor);
}

const sameTags = (left: string[], right: string[]) => left.length === right.length && left.every((tag, index) => tag === right[index]);

/**
 * 상세 판 읽기 — 상세를 볼 때마다 부른다. 제품은 상세와 같은 공개 읽기 캐시(identity)로, 요약은 30초 공개 읽기 캐시로 읽는다.
 * 로그인하면 계정 행만 주 DB 에서 찾는다. 익명은 이 브라우저가 평가했다고 기억할 때만(reacted) 찾는다 — 처음 보는 제품마다
 * 주 DB 를 묻지 않는다. 기억이 지워졌어도 판의 평가 단추는 평가만 보내 남은 태그·한 줄을 지우지 않는다.
 */
export async function readReaction(slug: string, owner: ReactionOwner, options: { reacted?: boolean } = {}): Promise<{ mine: ReactionMine | null; summary: ReactionSummary | null }> {
  const product = await publicRead("detail", ["identity", slug], () => getProductIdentity(slug));
  if (!product) throw new ReactionError("reaction_not_found", 404);
  const hash = !owner.userId && owner.visitor && options.reacted !== false ? productVisitorHash(slug, owner.visitor) : null;
  const [mine, summary] = await Promise.all([
    owner.userId || hash ? onPrimary(async () => currentOf(await ownedRows(db, product.id, owner.userId, hash), owner.userId, hash)) : undefined,
    publicRead("count", ["reaction-summary", product.id], () => summaryOf(db, product.id)),
  ]);
  return { mine: mine ? toMine(mine) : null, summary };
}

/** 지운 평가에 달린 메이커 답장도 함께 지운다 — 대상 없는 답장을 남기지 않는다 */
async function dropReplies(tx: Transaction, ids: string[]) {
  if (ids.length) await tx.delete(makerReplies).where(and(eq(makerReplies.targetType, "reaction"), inArray(makerReplies.targetId, ids)));
}

/**
 * 평가 저장(바꾸기 포함). 바뀐 것이 없으면 쓰지 않는다. 한 행은 KST 하루 REACTION_CHANGES_PER_DAY 번까지 바뀐다.
 * 보내지 않은 태그·한 줄(undefined)은 남겨 둔 값을 그대로 둔다 — 판의 평가 단추는 평가만 보낸다.
 * - 로그인: 계정 행만 고친다(없으면 새로). 이 브라우저의 익명 행은 그대로 두고, 그 행이 쥔 해시도 가져오지 않는다.
 * - 익명: 이 브라우저 해시를 계정 행이 쥐고 있으면(로그아웃한 브라우저) 그 행에서 해시를 떼고 새 행을 만든다.
 * 랭킹 제외는 쓸 때마다 다시 정한다 — 그 시간 제품의 변경이 넘쳤거나(REACTION_FLOOD_PER_HOUR) 신뢰할 IP 없는 익명 줄 한도를
 * 넘었을 때만. 실제로 바뀐 쓰기만 센다(같은 값을 다시 보내는 것으로 넘치게 할 수 없다).
 */
/**
 * 로그인 쓰기는 계정 행을 먼저(FOR SHARE) 잡는다 — 탈퇴(FOR UPDATE 뒤 평가를 지운다)가 끝난 뒤 깨어난 쓰기는 401 로 멈추고,
 * 평가 행·제품 잠금을 쥐기 전에 기다리므로 탈퇴와 서로 막히지 않는다
 */
async function lockLiveUser(tx: Transaction, userId: number): Promise<void> {
  const [user] = await tx.select({ id: publicUsers.id }).from(publicUsers).where(and(eq(publicUsers.id, userId), isNull(publicUsers.deletedAt))).for("share");
  if (!user) throw new PublicAuthError(401, "login_required");
}

export function putReaction(slug: string, owner: ReactionOwner, input: ReactionWrite, options: { untrustedIp?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  return onPrimary(() => db.transaction(async (tx) => {
    if (owner.userId) await lockLiveUser(tx, owner.userId);
    const product = await findProduct(tx, slug);
    if (!product) throw new ReactionError("reaction_not_found", 404);
    const hash = owner.visitor ? productVisitorHash(slug, owner.visitor) : null;
    if (!owner.userId && !hash) throw new ReactionError("reaction_unavailable", 503);
    await lockProduct(tx, product.id);
    const rows = await ownedRows(tx, product.id, owner.userId, hash);
    const current = currentOf(rows, owner.userId, hash);
    const holder = hash ? rows.find((row) => row.visitorHash === hash && row.id !== current?.id) : undefined;
    // 로그아웃한 브라우저 — 계정 행에서 이 브라우저 해시를 떼고 익명 행이 갖는다
    if (holder && !owner.userId) await tx.update(productReactions).set({ visitorHash: null }).where(eq(productReactions.id, holder.id));
    // 로그인: 다른 행(이 브라우저의 익명 행·다른 계정 행)이 쥔 해시는 가져오지 않는다
    const visitorHash = hash && !(holder && owner.userId) ? hash : current?.visitorHash ?? null;
    const userId = owner.userId;
    const tags = input.tags ?? (current?.tags as ReactionTag[] | undefined) ?? [];
    const comment = input.comment === undefined ? current?.comment ?? null : input.comment;
    const same = current && current.verdict === input.verdict && sameTags(current.tags, tags) && current.comment === comment;
    if (current && same && current.visitorHash === visitorHash) {
      return { mine: toMine(current), summary: await summaryOf(tx, product.id) };
    }
    const changes = same ? current.changesToday : nextChangeCount(current ?? null, now);
    if (changes === null) throw new ReactionError("reaction_change_limited", 429);

    let commentState = current?.commentState ?? null;
    let commentReason = current?.commentReason ?? null;
    if (comment !== (current?.comment ?? null)) {
      // 메이커 답장은 옛 한 줄에 단 것이다 — 한 줄이 바뀌거나 지워지면 함께 지운다
      if (current) await dropReplies(tx, [current.id]);
      if (comment === null) {
        commentState = null;
        commentReason = null;
      } else {
        // 한 줄 한도 — 기존 로그인 댓글과 같은 시간당 5·하루 20
        const author = owner.userId ? `user:${owner.userId}` : `visitor:${reactionRateKey(owner.visitor!)}`;
        if (!await withinQuota(tx, `reaction-comment:hour:${author}`, 5, HOUR) || !await withinQuota(tx, `reaction-comment:day:${author}`, 20, 24 * HOUR)) {
          throw new ReactionError("reaction_rate_limited", 429);
        }
        ({ state: commentState, reason: commentReason } = reviewReactionComment(comment));
      }
    }
    // 소유만 바뀌면(해시만 옮김) 랭킹 제외도 그대로 둔다
    let rankingExcluded = current?.rankingExcluded ?? false;
    if (!same) {
      const flood = !await withinQuota(tx, `reaction:product:${slug}`, REACTION_FLOOD_PER_HOUR, HOUR);
      // 신뢰할 IP 가 없으면 쿠키를 새로 받아 오는 익명 연타를 IP 묶음이 막지 못한다 — 제품마다 새 익명 줄을 세어 넘친 것은 랭킹에서 뺀다.
      // 뺐던 익명 줄을 고쳐 다시 세게 하는 것도 새 줄로 센다(고치기로 한도를 돌아가지 못하게)
      const capped = !flood && !userId && options.untrustedIp && (!current || current.rankingExcluded)
        ? !await withinQuota(tx, `reaction-anonymous-new:product:${product.id}`, UNTRUSTED_NEW_ANONYMOUS_PER_HOUR, HOUR) : false;
      rankingExcluded = flood || capped;
    }
    const values = {
      verdict: input.verdict, tags, comment, commentState, commentReason,
      triedVerified: Boolean(current?.triedVerified) || (hash ? await clickedRecently(tx, slug, hash) : false),
      rankingExcluded, source: input.source, device: input.device, locale: input.locale, userId, visitorHash,
    };
    // 소유만 바뀌면(해시만 옮김) 하루 횟수·바꾼 때를 그대로 둔다
    const counted = same ? {} : { changesToday: changes, updatedAt: now };
    let row: ReactionRow | undefined;
    if (current) {
      [row] = await tx.update(productReactions).set({ ...values, ...counted }).where(eq(productReactions.id, current.id)).returning();
    } else {
      const insert = tx.insert(productReactions).values({ ...values, productId: product.id, changesToday: 1, createdAt: now, updatedAt: now });
      const set = { ...values, changesToday: sql`${productReactions.changesToday} + 1`, updatedAt: now };
      // lock 안이라 겹치지 않지만, 열쇠마다 맞는 부분 고유 색인으로 한 번 더 막는다
      [row] = userId
        ? await insert.onConflictDoUpdate({ target: [productReactions.productId, productReactions.userId], targetWhere: sql.raw("user_id is not null"), set }).returning()
        : await insert.onConflictDoUpdate({ target: [productReactions.productId, productReactions.visitorHash], targetWhere: sql.raw("visitor_hash is not null"), set }).returning();
    }
    return { mine: toMine(row!), summary: await summaryOf(tx, product.id) };
  }));
}

/** 내 평가 지우기 — 로그인이면 계정 행만(이 브라우저의 익명 행은 남의 것일 수 있어 그대로 둔다), 아니면 이 브라우저의 익명 행 */
export function deleteReaction(slug: string, owner: ReactionOwner): Promise<{ deleted: boolean; summary: ReactionSummary | null }> {
  return onPrimary(() => db.transaction(async (tx) => {
    const product = await findProduct(tx, slug);
    if (!product) throw new ReactionError("reaction_not_found", 404);
    const hash = owner.visitor ? productVisitorHash(slug, owner.visitor) : null;
    if (!owner.userId && !hash) return { deleted: false, summary: await summaryOf(tx, product.id) };
    await lockProduct(tx, product.id);
    const deleted = await tx.delete(productReactions).where(and(eq(productReactions.productId, product.id), owner.userId
      ? eq(productReactions.userId, owner.userId) : and(eq(productReactions.visitorHash, hash!), isNull(productReactions.userId))))
      .returning({ id: productReactions.id });
    await dropReplies(tx, deleted.map((row) => row.id));
    return { deleted: deleted.length > 0, summary: await summaryOf(tx, product.id) };
  }));
}

const listSelection = {
  reaction: productReactions, slug: products.slug, name: products.name, ogImage: products.ogImage, category: products.category,
  replyBody: makerReplies.body, replyAt: makerReplies.createdAt,
  // 탈퇴한 계정의 이름은 내보내지 않는다 — 화면이 그 언어로 적는다
  replyAuthor: sql<string | null>`case when ${publicUsers.deletedAt} is null then ${publicUsers.displayName} end`,
};
type ListRow = { reaction: ReactionRow; slug: string; name: string; ogImage: string | null; category: string;
  replyBody: string | null; replyAt: Date | null; replyAuthor: string | null };

/** 써봤어요 목록에 보이는 제품 — 내린(banned) 제품은 뺀다. 마이페이지 머리 숫자(summary.ts)도 이 조건으로 센다 */
export const reactionListVisible = ne(products.status, "banned");

function listQuery(where: ReturnType<typeof and>) {
  return db.select(listSelection).from(productReactions)
    .innerJoin(products, eq(products.id, productReactions.productId))
    // 메이커 답장은 검수를 지난 것만(MY6 이 쓴다)
    .leftJoin(makerReplies, and(eq(makerReplies.targetType, "reaction"), eq(makerReplies.targetId, productReactions.id), eq(makerReplies.reviewState, "accepted")))
    .leftJoin(publicUsers, eq(publicUsers.id, makerReplies.authorUserId))
    .where(and(where, reactionListVisible))
    .orderBy(desc(productReactions.updatedAt), asc(productReactions.id));
}

const toItem = (row: ListRow): ReactionListItem => ({
  ...toMine(row.reaction), slug: row.slug, name: row.name, ogImage: row.ogImage?.startsWith("/") && !row.ogImage.startsWith("//") ? row.ogImage : null, category: row.category,
  reply: row.replyBody && row.replyAt ? { body: row.replyBody, authorName: row.replyAuthor, createdAt: row.replyAt.toISOString() } : null,
});

/** 계정의 평가 — 최근에 바꾼 순 */
export function listUserReactions(userId: number, limit = 500): Promise<ReactionListItem[]> {
  return onPrimary(async () => (await listQuery(eq(productReactions.userId, userId)).limit(limit)).map(toItem));
}

/**
 * 이 브라우저가 기억한 slug 중 이 쿠키의 익명 행만 — slug 없이는 찾을 수 없다(해시가 제품마다 다르다, Q4).
 * slug 로 제품 id 를 먼저 찾고 (product_id, visitor_hash) 짝마다 색인 한 번씩 찾는다 — 해시만으로는 표 전체를 훑는다.
 */
export async function listBrowserReactions(slugs: string[], visitor: string): Promise<ReactionListItem[]> {
  const bySlug = new Map(slugs.flatMap((slug) => {
    const hash = productVisitorHash(slug, visitor);
    return hash ? [[slug, hash] as const] : [];
  }));
  if (bySlug.size === 0) return [];
  const rows = await onPrimary(async () => {
    const targets = await db.select({ id: products.id, slug: products.slug }).from(products).where(and(inArray(products.slug, [...bySlug.keys()]), reactionListVisible));
    if (targets.length === 0) return [];
    const pairs = targets.map((target) => and(eq(productReactions.productId, target.id), eq(productReactions.visitorHash, bySlug.get(target.slug)!)));
    return listQuery(and(or(...pairs), isNull(productReactions.userId)));
  });
  return rows.filter((row) => bySlug.get(row.slug) === row.reaction.visitorHash).map(toItem);
}

/**
 * 첫 로그인 합치기(L4) — 이 브라우저가 평가한 제품마다 익명 행을 찾아 계정에 붙인다.
 * 계정 행이 이미 있으면 updated_at 이 새것을 남기고 다른 것을 지운다. 제품 lock 은 id 순으로 잡는다.
 */
export async function mergeBrowserReactions(userId: number, slugs: string[], visitor: string): Promise<{ merged: number }> {
  if (slugs.length === 0) return { merged: 0 };
  return onPrimary(() => db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    const targets = await tx.select({ id: products.id, slug: products.slug }).from(products)
      .where(and(inArray(products.slug, slugs), ne(products.status, "banned"))).orderBy(asc(products.id));
    let merged = 0;
    for (const product of targets) {
      const hash = productVisitorHash(product.slug, visitor);
      if (!hash) break;
      await lockProduct(tx, product.id);
      const rows = await ownedRows(tx, product.id, userId, hash);
      const anonymous = rows.find((row) => row.visitorHash === hash && row.userId === null);
      if (!anonymous) continue;
      const mine = rows.find((row) => row.userId === userId);
      const triedVerified = anonymous.triedVerified || Boolean(mine?.triedVerified);
      if (!mine || anonymous.updatedAt > mine.updatedAt) {
        if (mine) {
          await tx.delete(productReactions).where(eq(productReactions.id, mine.id));
          await dropReplies(tx, [mine.id]);
        }
        await tx.update(productReactions).set({ userId, triedVerified }).where(eq(productReactions.id, anonymous.id));
      } else {
        await tx.delete(productReactions).where(eq(productReactions.id, anonymous.id));
        await dropReplies(tx, [anonymous.id]);
        await tx.update(productReactions).set({ visitorHash: mine.visitorHash ?? hash, triedVerified }).where(eq(productReactions.id, mine.id));
      }
      merged += 1;
    }
    return { merged };
  }));
}
