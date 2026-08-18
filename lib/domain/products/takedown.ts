import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { takedownRequests, type TakedownRequest } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { type Result, ok, fail } from "./errors";
import { isUnclaimed } from "./view";
import { banProduct } from "./manage";
import * as repo from "./repository";

/**
 * 내려달라는 요청.
 *
 * 우리가 대신 올린 제품은 주인이 부탁한 적이 없다. 상세 페이지에 "원치 않으시면
 * 내려드립니다"라고 적어 두고 정작 말할 곳이 없으면 그 약속은 거짓말이 된다.
 *
 * 소유 증명을 요구하지 않는다. 증명을 받으려면 우리 토큰을 그 사이트에 올리라고 해야 하는데,
 * 내려달라는 사람에게 먼저 뭔가를 붙이라고 할 수는 없다. 대신 사람이 보고 처리한다.
 */

const MAX_REASON = 500;

export async function requestTakedown(
  slug: string,
  reason?: string | null,
): Promise<Result<{ slug: string }>> {
  const product = await repo.findBySlug(slug);
  if (!product || product.status === "banned") return fail({ kind: "not_found" });

  /**
   * 주인이 있는 제품은 이 창구가 아니다. 수정 키로 스스로 지울 수 있고, 남이 내려달라고
   * 요청할 수 있게 두면 멀쩡한 제품을 흔드는 길이 된다.
   */
  if (!isUnclaimed(product)) {
    return fail({
      kind: "forbidden",
      message: "주인이 있는 제품입니다. 수정 키로 직접 삭제할 수 있습니다",
    });
  }

  const trimmed = reason?.trim().slice(0, MAX_REASON) || null;
  const values = { slug, reason: trimmed, requestedAt: new Date() };
  // 같은 제품에 여러 번 오면 최신 요청 하나로 남긴다 — 큐가 같은 항목으로 차지 않게
  await db
    .insert(takedownRequests)
    .values(values)
    .onConflictDoUpdate({
      target: takedownRequests.slug,
      set: { ...values, handledAt: null, handledBy: null, outcome: null },
    });

  logger.info("takedown.requested", { slug, url: product.url });
  return ok({ slug });
}

/** 아직 사람이 보지 않은 요청 */
export async function pendingTakedowns(limit = 50): Promise<TakedownRequest[]> {
  return db
    .select()
    .from(takedownRequests)
    .where(isNull(takedownRequests.handledAt))
    .orderBy(desc(takedownRequests.requestedAt))
    .limit(limit);
}

export type TakedownAction = "remove" | "dismiss";

/**
 * 요청 처리.
 *
 * 내릴 때 행을 지우지 않고 banned로 둔다. 지우면 수집기가 다음 바퀴에 같은 URL을 다시 주워
 * 올린다 — 내려달라고 한 사람에게 그것만큼 무례한 일이 없다.
 */
export async function resolveTakedown(
  slug: string,
  action: TakedownAction,
  admin: string,
): Promise<Result<{ slug: string; action: TakedownAction }>> {
  const [request] = await db
    .select()
    .from(takedownRequests)
    .where(and(eq(takedownRequests.slug, slug), isNull(takedownRequests.handledAt)));
  if (!request) return fail({ kind: "not_found" });

  if (action === "remove") {
    const banned = await banProduct(slug);
    if (!banned.ok) return banned;
    await repo.deleteOgImage(slug);
  }

  await db
    .update(takedownRequests)
    .set({ handledAt: new Date(), handledBy: admin, outcome: action === "remove" ? "removed" : "dismissed" })
    .where(eq(takedownRequests.slug, slug));

  logger.info("takedown.resolved", { slug, action, admin });
  return ok({ slug, action });
}
