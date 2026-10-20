import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { products, productUpdates } from "@/lib/db/schema";
import { notifications, userFollows } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { listedRepositoryOwner } from "@/lib/domain/products/github-owner";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { logger } from "@/lib/observability/logger";
import type { FollowTarget, NotificationKind } from "./contract";
import { enqueueNotificationEmails } from "./email-outbox";
import { makerKeyOf } from "./follow-keys";

/**
 * 알림 만들기(L7·Q7)와 알림함 읽기. 발행·사실 수집 워커도 부르므로 server-only 를 붙이지 않는다.
 *
 * payload 는 화면 한 줄을 그릴 만큼만 둔다(lib/me/notification-view.ts) — 제품 이름·타일은 product_id 로 그때그때 읽는다.
 * - followed_release: { title, updateId } · followed_delisted: { reason: "down" | "removed" }
 * - maker_new_project: { maker } · category_new: { week, total, categories: [{ category, count }] }
 * - comment_reviewed: { decision, feedbackId } · maker_reply(MY6): { maker?, excerpt?, feedbackId? }
 * - new_listing_mine(MY5): { repo? } · inbox_new: { count }
 */

const PUBLIC_STATUSES = ["seeded", "verified"] as const;
type Executor = typeof db | ProductTransaction;

/** 넣은 줄 — 메일 설정이 «즉시»인 계정에게 같은 트랜잭션에서 발송함 한 줄(lib/me/email-outbox.ts, 던지지 않는다) */
type InsertedRow = { id: number | string; user_id: number; kind: NotificationKind; product_id: number | null; dedupe_key: string };
const INSERTED = sql`returning id, user_id, kind, product_id, dedupe_key`;
function queueEmails(rows: readonly InsertedRow[], executor: Executor): Promise<number> {
  return enqueueNotificationEmails(rows.map((row) => ({ id: Number(row.id), userId: row.user_id, kind: row.kind, productId: row.product_id, dedupeKey: row.dedupe_key })), executor);
}

/** 알림은 덧붙이는 일이다 — 실패해도 부른 쪽(발행·수집·심사)은 그대로 끝난다. 파이프라인 재생(replay) 범위에서는 알리지 않는다 */
async function quietly(event: string, fields: Record<string, unknown>, run: () => Promise<number>): Promise<number> {
  if (currentReplayDb()) return 0;
  try {
    return await run();
  } catch (error) {
    logger.warn(event, { ...fields, error });
    return 0;
  }
}

/**
 * 팔로한 계정마다 한 줄 — 한 문장(INSERT … SELECT)이라 팔로가 많아도 왕복은 하나다. 같은 (계정, dedupe_key) 는 건너뛴다.
 * followedBefore 가 있으면 그 전에 팔로한 계정만(내려가기 시작한 뒤 팔로한 사람에게 '내려갔어요'를 보내지 않게).
 * 넣은 줄의 «즉시» 메일은 같은 executor(부른 쪽 lease 쓰기)로 발송함에 넣는다. 넣은 수
 */
export async function notifyFollowers(input: {
  targetType: FollowTarget; targetKeys: string[]; kind: NotificationKind; productId?: number | null;
  payload?: Record<string, unknown>; dedupeKey: string; followedBefore?: Date | null;
}, executor: Executor = db): Promise<number> {
  if (!input.targetKeys.length) return 0;
  const keys = sql.join(input.targetKeys.map((key) => sql`${key}`), sql`, `);
  const rows = await onPrimary(() => executor.execute<InsertedRow>(sql`
    insert into ${notifications} (user_id, kind, product_id, payload, dedupe_key)
    select distinct f.user_id, ${input.kind}, ${input.productId ?? null}::int, ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.dedupeKey.slice(0, 120)}
      from ${userFollows} f
      join ${publicUsers} u on u.id = f.user_id and u.deleted_at is null
     where f.target_type = ${input.targetType} and f.target_key in (${keys})
       ${input.followedBefore ? sql`and f.created_at < ${input.followedBefore.toISOString()}::timestamptz` : sql``}
    on conflict (user_id, dedupe_key) do nothing
    ${INSERTED}`));
  if (rows.length) await queueEmails(rows, executor);
  return rows.length;
}

/** 관리자가 보류한 내 글을 공개하거나 거절했다(held → accepted·rejected). 사이트 안에만 알린다 */
export function notifyCommentReviewed(feedback: { id: string; productId: number; authorUserId: number }, decision: "accepted" | "rejected"): Promise<number> {
  return quietly("me.notify_comment_reviewed_failed", { feedbackId: feedback.id }, async () => {
    const rows = await onPrimary(() => db.execute<InsertedRow>(sql`
      insert into ${notifications} (user_id, kind, product_id, payload, dedupe_key)
      select u.id, 'comment_reviewed', ${feedback.productId}::int, ${JSON.stringify({ decision, feedbackId: feedback.id })}::jsonb,
             ${`comment_reviewed:${feedback.id}:${decision}`}
        from ${publicUsers} u where u.id = ${feedback.authorUserId} and u.deleted_at is null
      on conflict (user_id, dedupe_key) do nothing
      ${INSERTED}`));
    // 사이트 안에만 두는 종류라 메일 줄은 생기지 않는다 — 다른 길과 같은 자리에서 부른다
    if (rows.length) await queueEmails(rows, db);
    return rows.length;
  });
}

/**
 * 공개 제품에 방금 새 릴리스(GitHub 릴리스·메이커가 쓴 업데이트)가 붙었다 — 팔로한 사람에게 업데이트마다 한 줄.
 * 처음 관측하거나 저장소를 다시 이을 때는 지난 릴리스가 한꺼번에(최대 10개) 들어온다. 그래서 하루 안에 넣은 것 가운데
 * 7일 안에 낸 것만, 최근 셋까지만 알린다. 수집 잡은 lease 를 넘긴다 — 넣기는 그 lease 쓰기(fence·lease 확인) 안에서 한다.
 */
export function notifyNewReleases(productId: number, lease?: JobLease): Promise<number> {
  return quietly("me.notify_release_failed", { productId }, () => onPrimary(async () => {
    const [product] = await db.select({ slug: products.slug, status: products.status }).from(products).where(eq(products.id, productId));
    if (!product || !(PUBLIC_STATUSES as readonly string[]).includes(product.status)) return 0;
    const released = sql`coalesce(${productUpdates.publishedAt}, ${productUpdates.observedAt})`;
    const updates = await db.select({ id: productUpdates.id, title: productUpdates.title }).from(productUpdates)
      .where(and(eq(productUpdates.slug, product.slug), eq(productUpdates.visible, true), isNull(productUpdates.makerDeletedAt),
        inArray(productUpdates.sourceKind, ["github_release", "maker"]), sql`${productUpdates.createdAt} >= now() - interval '1 day'`,
        sql`${released} >= now() - interval '7 days'`))
      .orderBy(desc(released)).limit(3);
    if (!updates.length) return 0;
    return withJobLeaseWrite(lease, async (tx) => {
      let total = 0;
      for (const update of updates) {
        total += await notifyFollowers({ targetType: "product", targetKeys: [String(productId)], kind: "followed_release", productId,
          payload: { title: update.title.slice(0, 80), updateId: update.id }, dedupeKey: `followed_release:${update.id}` }, tx);
      }
      return total;
    });
  }));
}

/**
 * 새 프로젝트가 공개됐다(수집 발행·메이커 확인) — 그 GitHub 주인을 팔로한 사람에게. 기본 목록에서 빼는 것(개인 프로필)은 알리지 않는다.
 * 발행 잡은 lease 를 넘긴다 — 넣기는 그 lease 쓰기 안에서 한다.
 */
export function notifyMakerNewProject(slug: string, lease?: JobLease): Promise<number> {
  return quietly("me.notify_maker_project_failed", { slug }, () => onPrimary(async () => {
    const [product] = await db.select({ id: products.id, status: products.status, category: products.category, source: products.source,
      claimedAt: products.claimedAt, repoUrl: products.repoUrl, repoRenamedTo: products.repoRenamedTo }).from(products).where(eq(products.slug, slug));
    if (!product || !(PUBLIC_STATUSES as readonly string[]).includes(product.status)) return 0;
    if (hiddenByDefault(product.category) && product.source === "crawler" && !product.claimedAt) return 0;
    const key = makerKeyOf(product.repoUrl, product.repoRenamedTo);
    if (!key) return 0;
    return withJobLeaseWrite(lease, (tx) => notifyFollowers({ targetType: "maker", targetKeys: [key], kind: "maker_new_project", productId: product.id,
      payload: { maker: listedRepositoryOwner(product.repoUrl, product.repoRenamedTo)?.login ?? key }, dedupeKey: `maker_new_project:${product.id}` }, tx));
  }));
}

/** 알림함 한 쪽 — 최근 것부터(created_at, id). 다음 쪽은 앞 쪽 마지막 줄의 id(cursor) 뒤 — 내 줄이 아닌 id 면 빈 쪽이다 */
export const NOTIFICATION_PAGE = 30;

export type NotificationRow = {
  id: number; kind: NotificationKind; payload: Record<string, unknown>; createdAt: Date; readAt: Date | null;
  product: { slug: string; name: string; ogImage: string | null; category: string } | null;
};

export async function listNotifications(userId: number, options: { before?: number; limit?: number } = {}): Promise<{ items: NotificationRow[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(options.limit ?? NOTIFICATION_PAGE, 1), 50);
  const rows = await onPrimary(() => db.select({ id: notifications.id, kind: notifications.kind, payload: notifications.payload,
    createdAt: notifications.createdAt, readAt: notifications.readAt,
    slug: products.slug, name: products.name, ogImage: products.ogImage, category: products.category })
    .from(notifications).leftJoin(products, eq(products.id, notifications.productId))
    .where(and(eq(notifications.userId, userId), options.before ? sql`(${notifications.createdAt}, ${notifications.id}) < (
      select n.created_at, n.id from ${notifications} n where n.id = ${options.before} and n.user_id = ${userId})` : undefined))
    .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit + 1));
  const items = rows.slice(0, limit).map(({ slug, name, ogImage, category, ...row }) => ({
    ...row, product: slug && name && category ? { slug, name, ogImage, category } : null,
  }));
  return { items, nextCursor: rows.length > limit ? items[items.length - 1].id : null };
}

/** 안 읽은 수 — 종·아래 탭 점이 매 화면 묻는다. 부분 색인(notifications_unread_idx)만 읽고 100에서 멈춘다 */
export async function unreadNotificationCount(userId: number): Promise<number> {
  const [row] = await onPrimary(() => db.execute<{ count: number }>(sql`
    select count(*)::int as count from (select 1 from ${notifications} where user_id = ${userId} and read_at is null limit 100) n`));
  return Number(row?.count ?? 0);
}

/** 읽음 표시 — 내 줄만. ids 는 최대 100개. 바뀐 수 */
export async function markNotificationsRead(userId: number, target: { ids: number[] } | { all: true }): Promise<number> {
  const rows = await onPrimary(() => db.update(notifications).set({ readAt: sql`now()` })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), "ids" in target ? inArray(notifications.id, target.ids) : undefined))
    .returning({ id: notifications.id }));
  return rows.length;
}
