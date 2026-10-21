import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit, products } from "@/lib/db/schema";
import { productReactions } from "@/lib/db/me-schema";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { ReactionError } from "./contract";
import { lockProduct } from "./repository";

/**
 * 보류한 써봤어요 한 줄 검수(/admin/reactions) — 자동 검사(reviewReactionComment)가 링크·멘션·반복·미끼 문구로 보류한 한 줄을
 * 사람이 공개하거나 숨긴다. 공개해야 메이커 받은 편지함에 오르고 답장할 수 있다.
 */

/** 검수 대기 한 줄 — 오래된 것부터 */
export type HeldReactionComment = {
  id: string; slug: string; productName: string; comment: string; reason: string | null; signedIn: boolean; createdAt: string; updatedAt: string;
};

export async function heldReactionComments(limit = 100): Promise<{ count: number; items: HeldReactionComment[] }> {
  const held = eq(productReactions.commentState, "held");
  return onPrimary(async () => {
    const [rows, [total]] = await Promise.all([
      db.select({ reaction: productReactions, slug: products.slug, name: products.name }).from(productReactions)
        .innerJoin(products, eq(products.id, productReactions.productId)).where(held)
        .orderBy(asc(productReactions.createdAt), asc(productReactions.id)).limit(limit),
      db.select({ count: sql<number>`count(*)::int` }).from(productReactions).where(held),
    ]);
    return {
      count: total?.count ?? 0,
      items: rows.map(({ reaction, slug, name }) => ({
        id: reaction.id, slug, productName: name, comment: reaction.comment ?? "", reason: reaction.commentReason, signedIn: reaction.userId !== null,
        createdAt: reaction.createdAt.toISOString(), updatedAt: reaction.updatedAt.toISOString(),
      })),
    };
  });
}

/**
 * 보류한 한 줄을 공개(accepted)하거나 숨긴다(rejected). 관리자가 본 글(comment)이 그대로일 때만 — 그 사이 고쳤으면 409.
 * 글쓴이의 쓰기와 같은 제품 lock 안에서 바꾼다. 바꾼 때(updated_at)는 글쓴이의 것이라 두고, 누가 정했는지는 운영 기록에 남긴다.
 */
export async function reviewHeldReactionComment(input: { id: string; comment: string; decision: "accepted" | "rejected"; adminLogin: string }): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id) || !["accepted", "rejected"].includes(input.decision)
    || !input.comment || !input.adminLogin.trim() || input.adminLogin.length > 120) throw new ReactionError("reaction_invalid", 400);
  await onPrimary(() => db.transaction(async (tx) => {
    const [target] = await tx.select({ productId: productReactions.productId }).from(productReactions).where(eq(productReactions.id, input.id));
    if (!target) throw new ReactionError("reaction_not_found", 404);
    await lockProduct(tx, target.productId);
    const [reviewed] = await tx.update(productReactions).set({ commentState: input.decision })
      .where(and(eq(productReactions.id, input.id), eq(productReactions.commentState, "held"), eq(productReactions.comment, input.comment)))
      .returning({ id: productReactions.id, reason: productReactions.commentReason });
    if (!reviewed) throw new ReactionError("reaction_conflict", 409);
    await tx.insert(operationsAudit).values(await adminAuditRow(input.adminLogin, {
      action: "reaction.comment_review", target: reviewed.id, detail: { productId: target.productId, decision: input.decision, autoReason: reviewed.reason },
    }));
  }));
}
