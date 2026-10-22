import { and, asc, eq } from "drizzle-orm";
import { products } from "@/lib/db/schema";
import { publicIdentities } from "@/lib/db/public-user-schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { makerReplies } from "@/lib/db/me-schema";
import { clipText } from "./notification-view";
import { notify } from "./notify";
import { logger } from "@/lib/observability/logger";

/** 답장 쓰기/검수와 같은 대상 lock·트랜잭션에서 알린다. 숨김 후 복원해도 답장당 알림 하나. */
export async function notifyPublishedMakerReply(tx: ProductTransaction, reply: typeof makerReplies.$inferSelect, recipient: number | null): Promise<boolean> {
  if (reply.reviewState !== "accepted" || recipient === null || recipient === reply.authorUserId) return false;
  try {
    return await tx.transaction(async savepoint => {
      const [identity] = await savepoint.select({ login: publicIdentities.providerLogin }).from(publicIdentities)
        .where(and(eq(publicIdentities.userId, reply.authorUserId), eq(publicIdentities.provider, "github"))).orderBy(asc(publicIdentities.id)).limit(1);
      const [product] = await savepoint.select({ name: products.name }).from(products).where(eq(products.id, reply.productId));
      return notify({ userId: recipient, kind: "maker_reply", productId: reply.productId, dedupeKey: `maker_reply:${reply.id}`,
        payload: { name: product?.name ?? null, ...(identity?.login ? { maker: `@${identity.login}` } : {}), excerpt: clipText(reply.body, 120),
          ...(reply.targetType === "feedback" ? { feedbackId: reply.targetId } : {}) } }, savepoint);
    });
  } catch (error) {
    logger.warn("maker.reply_notify_failed", { replyId: reply.id, errorName: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}
