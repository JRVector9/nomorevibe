import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { makerReplies } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import type { FeedbackView } from "@/lib/domain/feedback/contract";
import { listMyFeedback } from "@/lib/domain/feedback/repository";

/** 의견 탭 — 내가 쓴 긴 글(product_feedback) 최근 100개와 공개된 메이커 답장(maker_replies, target_type = feedback) */
/** authorDisplayName 이 null 이면 탈퇴한 계정(화면이 그 언어로 적는다) */
export type MakerReplyView = { body: string; authorDisplayName: string | null; createdAt: string };
export type OpinionView = FeedbackView & { reply: MakerReplyView | null };

export async function listMyOpinions(userId: number): Promise<OpinionView[]> {
  const feedback = await listMyFeedback(userId);
  if (!feedback.length) return [];
  const replies = await onPrimary(() => db.select({ targetId: makerReplies.targetId, body: makerReplies.body, createdAt: makerReplies.createdAt,
    authorDisplayName: sql<string | null>`case when ${publicUsers.deletedAt} is null then ${publicUsers.displayName} end` })
    .from(makerReplies).innerJoin(publicUsers, eq(publicUsers.id, makerReplies.authorUserId))
    .where(and(eq(makerReplies.targetType, "feedback"), eq(makerReplies.reviewState, "accepted"), inArray(makerReplies.targetId, feedback.map((item) => item.id)))));
  const byTarget = new Map(replies.map((reply) => [reply.targetId, { body: reply.body, authorDisplayName: reply.authorDisplayName, createdAt: reply.createdAt.toISOString() }]));
  return feedback.map((item) => ({ ...item, reply: byTarget.get(item.id) ?? null }));
}
