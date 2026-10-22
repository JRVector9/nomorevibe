import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { makerReplies, notifications, productMakerMembers, productReactions } from "@/lib/db/me-schema";
import { operationsAudit, products } from "@/lib/db/schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { clipText } from "@/lib/me/notification-view";
import { notifyPublishedMakerReply } from "@/lib/me/maker-reply-notify";
import { adminAuditRow } from "./admin-log";
import { AdminRequestError, assertAdminActor, parseAdminRequest, replyReviewInput, type reviewStates } from "./admin-requests-contract";

type ReviewState = typeof reviewStates[number];
export async function makerReplyQueue(options: { state?: ReviewState | "all"; offset?: number; limit?: number } = {}) {
  const where = options.state === "all" ? undefined : eq(makerReplies.reviewState, options.state ?? "held");
  const offset = Math.max(0, Math.min(100000, Math.trunc(options.offset ?? 0)));
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 25)));
  return onPrimary(async () => {
    const [items, [total]] = await Promise.all([
      db.select({ reply: makerReplies, slug: products.slug, productName: products.name, authorName: publicUsers.displayName,
        targetBody: sql<string | null>`case when ${makerReplies.targetType} = 'feedback' then
          (select f.body from product_feedback f where f.id = ${makerReplies.targetId} and f.product_id = ${makerReplies.productId}) else
          (select r.comment from product_reactions r where r.id = ${makerReplies.targetId} and r.product_id = ${makerReplies.productId}) end` })
        .from(makerReplies).innerJoin(products, eq(products.id, makerReplies.productId))
        .innerJoin(publicUsers, eq(publicUsers.id, makerReplies.authorUserId)).where(where)
        .orderBy(asc(makerReplies.createdAt), asc(makerReplies.id)).offset(offset).limit(limit),
      db.select({ count: sql<number>`count(*)::int` }).from(makerReplies).where(where),
    ]);
    return { count: total?.count ?? 0, items, nextOffset: offset + items.length < (total?.count ?? 0) ? offset + items.length : null };
  });
}
/** 작성자의 답장 쓰기와 같은 대상 lock. version은 같은 글→수정→원복(ABA)도 구별한다. */
export async function reviewMakerReply(value: unknown, adminLogin: string) {
  assertAdminActor(adminLogin);
  const input = parseAdminRequest(replyReviewInput, value);
  return onPrimary(() => db.transaction(async tx => {
    const [target] = await tx.select().from(makerReplies).where(eq(makerReplies.id, input.id));
    if (!target) throw new AdminRequestError("not_found");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`maker-reply:${target.targetType}:${target.targetId}`}))`);
    const [current] = await tx.select().from(makerReplies).where(eq(makerReplies.id, input.id)).for("update");
    if (!current) throw new AdminRequestError("not_found");
    if (current.reviewVersion !== input.version || current.reviewState !== input.expectedState) throw new AdminRequestError("conflict");
    const [product] = await tx.select({ status: products.status }).from(products).where(eq(products.id, current.productId));
    const original = current.targetType === "feedback"
      ? (await tx.select({ recipient: productFeedback.authorUserId }).from(productFeedback)
        .where(and(eq(productFeedback.id, current.targetId), eq(productFeedback.productId, current.productId), eq(productFeedback.reviewState, "accepted"))))[0]
      : (await tx.select({ recipient: productReactions.userId }).from(productReactions)
        .where(and(eq(productReactions.id, current.targetId), eq(productReactions.productId, current.productId), eq(productReactions.commentState, "accepted"))))[0];
    if (input.decision === "accepted") {
      const [active] = await tx.execute<{ active: boolean }>(sql`select exists (select 1 from ${productMakerMembers} m
        join ${publicUsers} u on u.id=m.user_id where m.product_id=${current.productId} and m.user_id=${current.authorUserId}
        and m.revoked_at is null and u.deleted_at is null) as active`);
      if (!product || product.status === "banned" || !original || !active?.active) throw new AdminRequestError("not_found");
    }
    const [reviewed] = await tx.update(makerReplies).set({ reviewState: input.decision, reviewRequired: input.decision === "rejected", reviewVersion: sql`${makerReplies.reviewVersion} + 1` })
      .where(eq(makerReplies.id, current.id)).returning();
    await tx.insert(operationsAudit).values(await adminAuditRow(adminLogin, { action: "maker_reply.review", target: current.id,
      detail: { productId: current.productId, before: current.reviewState, decision: reviewed.reviewState, version: reviewed.reviewVersion } }));
    // 이미 받은 알림의 본문도 숨긴다. 행은 남겨 복원해도 같은 답장을 다시 알리지 않는다.
    await tx.update(notifications).set({ payload: input.decision === "rejected" ? sql`${notifications.payload} - 'excerpt'`
      : sql`${notifications.payload} || jsonb_build_object('excerpt', ${clipText(reviewed.body, 120)}::text)` })
      .where(and(eq(notifications.kind, "maker_reply"), eq(notifications.dedupeKey, `maker_reply:${reviewed.id}`)));
    const notified = input.decision === "accepted" ? await notifyPublishedMakerReply(tx, reviewed, original?.recipient ?? null) : false;
    return { ...reviewed, notified };
  }));
}
