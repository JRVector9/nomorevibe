import "server-only";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, operationsAudit } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { heldReactionComments } from "@/lib/domain/reactions/review";
import { introRequestQueue, pendingIntroRequestCount } from "@/lib/domain/products/intro-requests";
import { takedownQueue, takedownSummary } from "@/lib/domain/products/takedown";
import { logger } from "@/lib/observability/logger";
import { sharedInbox } from "./inbox";
import { assembleRequestOverview, REQUEST_HISTORY_ACTIONS, type RequestRead } from "./admin-request-workspace-model";

/** Failures are not empty queues. Log only the error class, never request text or contact data. */
export async function readRequestSection<T>(key: string, load: () => Promise<T>): Promise<RequestRead<T>> {
  try { return { ok: true, data: await load() }; }
  catch (error) {
    logger.warn("admin_request_workspace.unavailable", { section: key, errorName: error instanceof Error ? error.name : "unknown" });
    return { ok: false };
  }
}

export async function readRequestOverview(fresh = false) {
  const [summary, reactions] = await Promise.all([
    readRequestSection("overview", () => sharedInbox(fresh)),
    readRequestSection("reaction-summary", async () => {
      const queue = await heldReactionComments(5);
      return { count: queue.count, items: queue.items.map(item => ({ id: item.id, name: item.productName,
        why: "써봤어요 한 줄 공개 검토", since: item.createdAt })) };
    }),
  ]);
  return assembleRequestOverview(summary.ok ? summary.data : null, reactions);
}

export async function readCorrectionRequests() {
  const [takedowns, intros] = await Promise.all([
    readRequestSection("takedowns", async () => {
      const [summary, items] = await Promise.all([takedownSummary(), takedownQueue(500)]);
      return { summary, items };
    }),
    readRequestSection("intro-requests", async () => {
      const [count, items] = await Promise.all([pendingIntroRequestCount(), introRequestQueue(200)]);
      return { count, items };
    }),
  ]);
  return { takedowns, intros };
}

/** Actual registration state, not a new manual approval queue. The DTO contains no edit or verification tokens. */
export async function readRegistrationWorkspace() {
  const [pending, makerChecks] = await Promise.all([
    readRequestSection("registration", () => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '4s'`);
      const where = eq(products.status, "unverified");
      const [items, [total]] = await Promise.all([
        tx.select({ id: products.id, slug: products.slug, name: products.name, source: products.source,
          createdAt: products.createdAt, verifyMethod: products.verifyMethod }).from(products).where(where)
          .orderBy(asc(products.createdAt), asc(products.id)).limit(25),
        tx.select({ count: sql<number>`count(*)::int` }).from(products).where(where),
      ]);
      return { count: total?.count ?? 0, items };
    }, { accessMode: "read only" })),
    readRequestSection("maker-checks", () => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '4s'`);
      return tx.select({ productId: products.id, slug: products.slug, name: products.name, method: productMakerMembers.method,
        role: productMakerMembers.role, verifiedAt: productMakerMembers.verifiedAt, recheckAt: productMakerMembers.recheckAt,
        revokedAt: productMakerMembers.revokedAt, revokedReason: productMakerMembers.revokedReason })
        .from(productMakerMembers).innerJoin(products, eq(products.id, productMakerMembers.productId))
        .orderBy(desc(productMakerMembers.verifiedAt), desc(productMakerMembers.productId)).limit(25);
    }, { accessMode: "read only" })),
  ]);
  return { pending, makerChecks };
}

/** A bounded audit projection: no IP, user agent, request body, raw detail or contact address leaves this reader. */
export function readRequestHistory() {
  return readRequestSection("request-history", () => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '4s'`);
    return tx.select({ id: operationsAudit.id, action: operationsAudit.action, target: operationsAudit.target,
      actor: operationsAudit.actor, at: operationsAudit.createdAt, ok: operationsAudit.ok })
      .from(operationsAudit).where(inArray(operationsAudit.action, [...REQUEST_HISTORY_ACTIONS]))
      .orderBy(desc(operationsAudit.id)).limit(100);
  }, { accessMode: "read only" }));
}
