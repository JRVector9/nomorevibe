import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { makerReplies } from "@/lib/db/me-schema";
import { products } from "@/lib/db/schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import type { FeedbackView } from "@/lib/domain/feedback/contract";
import { listMyFeedback } from "@/lib/domain/feedback/repository";

/** 의견 탭 — 내가 쓴 긴 글(product_feedback) 최근 100개와 공개된 메이커 답장(maker_replies, target_type = feedback) */
/** authorDisplayName 이 null 이면 탈퇴한 계정(화면이 그 언어로 적는다) */
export type MakerReplyView = { body: string; authorDisplayName: string | null; createdAt: string };
/** category·ogImage 는 제품 타일(ProductIcon) — 저장·써봤어요·팔로 탭과 같은 색·글자·아이콘으로 그린다 */
export type OpinionView = FeedbackView & { reply: MakerReplyView | null; category: string | null; ogImage: string | null };

export async function listMyOpinions(userId: number): Promise<OpinionView[]> {
  const feedback = await listMyFeedback(userId);
  if (!feedback.length) return [];
  const [replies, tiles] = await onPrimary(() => Promise.all([
    db.select({ targetId: makerReplies.targetId, body: makerReplies.body, createdAt: makerReplies.createdAt,
      authorDisplayName: sql<string | null>`case when ${publicUsers.deletedAt} is null then ${publicUsers.displayName} end` })
      .from(makerReplies).innerJoin(publicUsers, eq(publicUsers.id, makerReplies.authorUserId))
      .where(and(eq(makerReplies.targetType, "feedback"), eq(makerReplies.reviewState, "accepted"), inArray(makerReplies.targetId, feedback.map((item) => item.id)))),
    db.select({ id: products.id, category: products.category, ogImage: products.ogImage }).from(products)
      .where(inArray(products.id, [...new Set(feedback.map((item) => item.productId))])),
  ]));
  const byTarget = new Map(replies.map((reply) => [reply.targetId, { body: reply.body, authorDisplayName: reply.authorDisplayName, createdAt: reply.createdAt.toISOString() }]));
  const tileOf = new Map(tiles.map((tile) => [tile.id, tile]));
  return feedback.map((item) => ({ ...item, reply: byTarget.get(item.id) ?? null,
    category: tileOf.get(item.productId)?.category ?? null, ogImage: tileOf.get(item.productId)?.ogImage ?? null }));
}
