import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, products, productHealth } from "@/lib/db/schema";
import { notifications, userFollows } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { listedByDefault, notAuditHeld, notDown } from "@/lib/domain/products/repository";
import { AUDIT_HOLD_PURGE, AUDIT_RELEASE_PURGE } from "@/lib/crawl/product-audit-hold";
import { periodContaining } from "@/lib/domain/ranking/period";
import { formatDay } from "@/lib/format/time";
import { withJobLeaseWrite } from "@/lib/jobs/control";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { NOTIFICATION_RETENTION_DAYS } from "@/lib/me/contract";
import { enqueueNotificationEmails } from "@/lib/me/email-outbox";
import { categoryOfKey } from "@/lib/me/follow-keys";
import { notifyFollowers } from "@/lib/me/notifications";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const PUBLIC_STATUSES = ["seeded", "verified"] as const;
/** 팔로한 제품 id 들 — 열쇠는 글자라 숫자 모양만 바꾼다(다른 것은 null 이 되어 빠진다) */
const followedProductIds = sql`(select case when f.target_key ~ '^[0-9]{1,9}$' then f.target_key::int end
  from ${userFollows} f where f.target_type = 'product')`;

/**
 * purgeId = 끝까지 읽은 id, floor = 처음 시작한 곳(그 앞의 차단은 알리지 않는다).
 * down = 이미 알린 «닿지 않음» — 제품 id → 내려가기 시작한 시각(ISO). 그 시각 전에 팔로한 사람은 첫 알림 때 이미 다 받았다
 */
export type DelistedCursor = { purgeId: number; floor?: number; down?: Record<string, string> };
/**
 * cdn_purges id 는 sequence 라 트랜잭션이 늦게 commit 되면 낮은 id 가 커서 뒤에 나타난다 — 틱마다 커서 앞 500개를 다시 본다(floor 아래로는 가지 않는다).
 * 다시 보는 것은 하루 안에 적힌 줄만이다 — 늦은 commit 은 그보다 훨씬 짧고, 90일 지나 지운 알림(notification-prune)을 새로 넣지 않는다.
 * dedupe_key 에 purge id 가 있어 다시 봐도 한 줄이고, 팔로한 사람이 있는 줄만 다시 넣어 본다.
 */
const PURGE_OVERLAP = 500;
/**
 * 내려감이 아닌 지우기 줄 — 내려달라는 요청·삭제, 그리고 감사 보류를 걸고 푼 줄(product-audit-hold.ts). 보류는 내린 것이 아니라 알리지 않는다.
 * 보류 줄을 다시 보는 사이(하루) 그 제품이 차단되면 상태만 보고는 내려간 줄로 읽힌다 — 차단은 트리거가 따로 적은 줄로 한 번만 알린다
 */
const NOT_DELISTED = new Set(["takedown", "deleted", AUDIT_HOLD_PURGE, AUDIT_RELEASE_PURGE]);
/** 한 틱에 보는 «닿지 않음» 후보 수 — 팔로된 공개 제품 가운데 7일 안에 내려간 것 */
const DOWN_LIMIT = 500;

/**
 * 팔로한 프로젝트가 목록에서 빠지면 알린다(followed_delisted). 내리는 길이 아홉 갈래라(관리자 차단·내려달라는 요청·감사·
 * 재검토·스팸·저장소 사라짐·가동 자동 차단 …) 길마다 끼우지 않고 둘을 본다.
 * - 상태가 공개에서 빠짐: DB 트리거가 같은 트랜잭션에 적는 cdn_purges(0057)를 id 순서로 따라 읽는다. 처음에는 지금 끝에서 시작한다.
 *   그 줄이 적히기 전에 팔로한 사람에게만 보낸다(풀렸다 다시 내려간 제품을 그 사이 팔로한 사람이 옛 차단까지 받지 않게).
 * - 닿지 않음(연속 실패, 목록의 notDown): 상태 열이 없다 — 팔로된 공개 제품 가운데 지금 가려진 것을, 내려가기 시작한 날 하나로 묶는다.
 *   그날 전에 팔로한 사람에게만, 7일 안에 시작된 것만 보낸다. 한 번 보낸 (제품, 시작 시각)은 커서에 남겨 틱마다 다시 넣어 보지 않는다.
 */
export async function sendDelistedNotifications(ctx: JobContext<DelistedCursor>): Promise<JobOutcome<DelistedCursor>> {
  let cursor = ctx.cursor;
  if (!cursor) {
    const [row] = await db.select({ max: sql<number>`coalesce(max(${cdnPurges.id}), 0)::int` }).from(cdnPurges);
    cursor = { purgeId: row.max };
  }
  const floor = cursor.floor ?? cursor.purgeId;
  const notifiedDown = cursor.down ?? {};
  cursor = { purgeId: cursor.purgeId, floor, down: notifiedDown };
  let removed = 0;
  let scanned = Math.max(cursor.purgeId - PURGE_OVERLAP, floor);
  const reached = cursor.purgeId;
  for (let round = 0; round < 10 && ctx.hasBudget(); round += 1) {
    // 적힌 시각은 마이크로초까지 글자로 — 시간대 없는 UTC 벽시계다
    const rows = await db.select({ id: cdnPurges.id, reason: cdnPurges.reason, productId: products.id, status: products.status,
      createdAt: sql<string>`to_char(${cdnPurges.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      followed: sql<boolean>`exists (select 1 from ${userFollows} f where f.target_type = 'product' and f.target_key = ${products.id}::text)` })
      .from(cdnPurges).leftJoin(products, eq(products.slug, cdnPurges.slug))
      .where(and(gt(cdnPurges.id, scanned), sql`(${cdnPurges.id} > ${reached} or ${cdnPurges.createdAt} > (now() at time zone 'UTC') - interval '1 day')`))
      .orderBy(asc(cdnPurges.id)).limit(200);
    if (!rows.length) break;
    const delisted = rows.filter((row) => row.productId !== null && row.status !== null && row.followed
      && !NOT_DELISTED.has(row.reason) && !(PUBLIC_STATUSES as readonly string[]).includes(row.status));
    if (delisted.length) removed += await withJobLeaseWrite(ctx.lease, async (tx) => {
      let total = 0;
      for (const row of delisted) {
        total += await notifyFollowers({ targetType: "product", targetKeys: [String(row.productId)], kind: "followed_delisted", productId: row.productId,
          payload: { reason: "removed" }, dedupeKey: `followed_delisted:${row.productId}:removed:${row.id}`, followedBefore: row.createdAt }, tx);
      }
      return total;
    });
    scanned = rows[rows.length - 1].id;
    if (scanned > cursor.purgeId) {
      cursor = { ...cursor, purgeId: scanned };
      await ctx.save(cursor);
    }
    if (rows.length < 200) break;
  }

  const since = sql`coalesce(${productHealth.downSince}, ${products.repoMissingSince})`;
  const hidden = await db.select({ id: products.id, downSince: productHealth.downSince, repoMissingSince: products.repoMissingSince })
    .from(products).leftJoin(productHealth, eq(productHealth.slug, products.slug))
    .where(and(sql`${products.id} in ${followedProductIds}`, inArray(products.status, [...PUBLIC_STATUSES]), listedByDefault, sql`not ${notDown}`,
      // 시간대 없는 UTC 벽시계 열이다
      sql`${since} > (now() at time zone 'UTC') - interval '7 days'`))
    .orderBy(sql`${since} desc`, asc(products.id)).limit(DOWN_LIMIT);
  const recent = hidden.flatMap((row) => {
    const since = row.downSince ?? row.repoMissingSince;
    return since && Date.now() - since.getTime() < 7 * DAY_MS ? [{ id: row.id, since }] : [];
  });
  // 이미 보낸 것은 넣어 보지 않는다. 다시 살아나 후보에서 빠진 제품은 커서에서도 지운다(다음에 내려가면 새 시작 시각이다)
  const fresh = recent.filter((row) => notifiedDown[String(row.id)] !== row.since.toISOString());
  const down = fresh.length ? await withJobLeaseWrite(ctx.lease, async (tx) => {
    let total = 0;
    for (const row of fresh) {
      total += await notifyFollowers({ targetType: "product", targetKeys: [String(row.id)], kind: "followed_delisted", productId: row.id,
        payload: { reason: "down" }, dedupeKey: `followed_delisted:${row.id}:down:${formatDay(row.since)}`, followedBefore: row.since }, tx);
    }
    return total;
  }) : 0;
  cursor = { ...cursor, down: Object.fromEntries(recent.map((row) => [String(row.id), row.since.toISOString()])) };
  if (removed || down) ctx.log("notifications.delisted", { removed, down });
  return { done: true, cursor };
}

export type CategoryDigestCursor = { week: string; afterUserId: number; done: boolean };
/**
 * 월요일 00:00(KST)부터 하루 동안만 보낸다 — 주간 메일 요약(기본 월요일 09:00, lib/me/email-outbox.ts)보다 먼저 넣어 그 주 메일에 담기게.
 * 잡이 그 주 내내 멈춰 있었다면 지난 주 요약을 늦게 보내지 않고 건너뛴다
 */
const DIGEST_WINDOW_MS = DAY_MS;
const DIGEST_BATCH = 200;

/** 이번 주 요약 시각과 주 열쇠 — 월요일 0시(KST)가 주의 시작이다(lib/domain/ranking/period.ts) */
export function categoryDigestWeek(now: Date): { key: string; sendAt: Date } {
  const week = periodContaining(now, "weekly");
  return { key: week.key, sendAt: week.startsAt };
}

/**
 * 팔로한 분야의 새 등재 — 주 1회 묶음 한 줄(category_new, Q7). 분야를 팔로한 계정마다 지난 7일(지난 주 월요일 0시부터 이번 주 월요일 0시 전까지) 새로 올라온
 * 공개 제품 수를 분야별로 세어 하나로 적는다. 새 것이 없으면 쓰지 않는다. dedupe_key 가 주마다 하나라 다시 돌아도 한 줄이다.
 */
export async function sendCategoryDigest(ctx: JobContext<CategoryDigestCursor>, now = new Date()): Promise<JobOutcome<CategoryDigestCursor>> {
  const { key, sendAt } = categoryDigestWeek(now);
  if (now < sendAt || now.getTime() >= sendAt.getTime() + DIGEST_WINDOW_MS) return { done: true, cursor: ctx.cursor };
  let cursor: CategoryDigestCursor = ctx.cursor?.week === key ? ctx.cursor : { week: key, afterUserId: 0, done: false };
  if (cursor.done) return { done: true, cursor };

  const from = new Date(sendAt.getTime() - 7 * DAY_MS).toISOString(), until = sendAt.toISOString();
  // products 의 시각 열은 시간대 없는 UTC 벽시계다
  const listedAt = sql`coalesce(${products.verifiedAt}, ${products.createdAt})`;
  const counts = new Map((await db.select({ category: products.category, total: sql<number>`count(*)::int` }).from(products)
    .where(and(inArray(products.status, [...PUBLIC_STATUSES]), listedByDefault, notAuditHeld,
      sql`${listedAt} >= (${from}::timestamptz at time zone 'UTC') and ${listedAt} < (${until}::timestamptz at time zone 'UTC')`))
    .groupBy(products.category)).map((row) => [row.category.toLowerCase(), row.total]));

  let written = 0;
  while (ctx.hasBudget()) {
    const users = await db.select({ userId: userFollows.userId, keys: sql<string[]>`array_agg(${userFollows.targetKey})` }).from(userFollows)
      .innerJoin(publicUsers, eq(publicUsers.id, userFollows.userId))
      .where(and(eq(userFollows.targetType, "category"), gt(userFollows.userId, cursor.afterUserId), sql`${publicUsers.deletedAt} is null`))
      .groupBy(userFollows.userId).orderBy(asc(userFollows.userId)).limit(DIGEST_BATCH);
    if (!users.length) {
      cursor = { ...cursor, done: true };
      break;
    }
    const rows = users.flatMap(({ userId, keys }) => {
      const found = keys.flatMap((slug) => categoryOfKey(slug) && counts.get(slug) ? [{ category: slug, count: counts.get(slug)! }] : [])
        .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
      if (!found.length) return [];
      const total = found.reduce((sum, item) => sum + item.count, 0);
      return [{ userId, kind: "category_new" as const, payload: { week: key, total, categories: found.slice(0, 3), others: found.length - 1 },
        dedupeKey: `category_new:${key}` }];
    });
    // 분야 칸은 «즉시»를 고를 수 없어 메일 줄은 생기지 않는다 — 다른 알림 길과 같은 자리에서 발송함을 부른다(주간 요약이 묶는다)
    if (rows.length) written += await withJobLeaseWrite(ctx.lease, async (tx) => {
      const inserted = await tx.insert(notifications).values(rows).onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
        .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind, productId: notifications.productId, dedupeKey: notifications.dedupeKey });
      await enqueueNotificationEmails(inserted, tx);
      return inserted.length;
    });
    cursor = { ...cursor, afterUserId: users[users.length - 1].userId };
    await ctx.save(cursor);
  }
  ctx.log("notifications.category_digest", { week: key, written, done: cursor.done });
  return { done: true, cursor };
}

const PRUNE_BATCH = 1_000;

/** 90일 지난 알림을 지운다 — 한 번에 1,000줄씩, 틱 예산 안에서 */
export async function pruneNotifications(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  let deleted = 0;
  for (let round = 0; round < 50 && ctx.hasBudget(); round += 1) {
    const rows = await withJobLeaseWrite(ctx.lease, (tx) => tx.execute<{ id: number }>(sql`
      delete from ${notifications} where id in (
        select id from ${notifications} where created_at < now() - make_interval(days => ${NOTIFICATION_RETENTION_DAYS})
         order by created_at limit ${PRUNE_BATCH}
      ) returning id`));
    deleted += rows.length;
    if (rows.length < PRUNE_BATCH) break;
  }
  if (deleted) ctx.log("notifications.pruned", { deleted });
  return { done: true };
}
