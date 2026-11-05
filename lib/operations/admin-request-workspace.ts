import "server-only";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, operationsAudit } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { heldReactionComments } from "@/lib/domain/reactions/review";
import { feedbackAdminQueue } from "@/lib/domain/feedback/repository";
import { makerReplyQueue } from "./maker-reply-review";
import { contactRequestQueue } from "./contact-requests";
import { introRequestQueue, pendingIntroRequestCount } from "@/lib/domain/products/intro-requests";
import { takedownQueue, takedownSummary } from "@/lib/domain/products/takedown";
import { logger } from "@/lib/observability/logger";
import { sharedInbox } from "./inbox";
import { assembleRequestOverview, REQUEST_HISTORY_ACTIONS, type RequestRead } from "./admin-request-workspace-model";

export type RequestKind = "takedown" | "intro" | "contact" | "feedback" | "replies" | "reactions";
export type WorkspaceRequest = {
  key: string; name: string; type: string; status: string; at: Date | string; waitHours: number; next: string; body: string; slug: string | null;
} & (
  | { kind: "takedown"; record: Awaited<ReturnType<typeof takedownQueue>>[number] }
  | { kind: "intro"; record: Awaited<ReturnType<typeof introRequestQueue>>[number] }
  | { kind: "contact"; record: Awaited<ReturnType<typeof contactRequestQueue>>["items"][number] }
  | { kind: "feedback"; record: Awaited<ReturnType<typeof feedbackAdminQueue>>["items"][number] }
  | { kind: "replies"; record: Awaited<ReturnType<typeof makerReplyQueue>>["items"][number] }
  | { kind: "reactions"; record: Awaited<ReturnType<typeof heldReactionComments>>["items"][number] }
);

/** Each queue is bounded and independent. No contact email, raw request or verification token is sent to a client list. */
export async function readRequestWorkspaceQueues(kinds: readonly RequestKind[], state = "open", offset = 0, cursor?: string, selectedKey?: string) {
  const selectedId = selectedKey?.slice(selectedKey.indexOf(":") + 1);
  const now = Date.now(), age = (at: string | Date) => Math.max(0, (now - new Date(at).getTime()) / 3_600_000);
  const reviews = ["held", "accepted", "rejected", "all"].includes(state) ? state as "held" | "accepted" | "rejected" | "all" : "held";
  const contactState = ["new", "in_progress", "waiting", "resolved", "spam", "all", "open"].includes(state) ? state as "new" | "in_progress" | "waiting" | "resolved" | "spam" | "all" | "open" : "open";
  const results = await Promise.all(kinds.map(async kind => ({ kind, result: await readRequestSection<{ count: number; items: WorkspaceRequest[]; nextOffset?: number | null; nextCursor?: string | null; overdue?: number }>(kind, async () => {
    if (kind === "takedown") { const [summary, rows] = await Promise.all([takedownSummary(), takedownQueue(selectedId ? 1 : 50, selectedId ? { slug: selectedId } : undefined)]); return { count: summary.pending, overdue: summary.overdue, items: rows.map(record => ({ kind, record, key: `takedown:${record.slug}`, name: record.product?.name ?? record.slug, type: "내림 요청", status: "접수", at: record.requestedAt, waitHours: record.ageHours, next: "공개 중단·유지 검토", body: record.reason ?? "요청 사유 —", slug: record.slug })) }; }
    if (kind === "intro") { const [count, rows] = await Promise.all([pendingIntroRequestCount(), introRequestQueue(selectedId ? 1 : 50, selectedId ? { id: Number(selectedId) } : undefined)]); return { count, items: rows.map(record => ({ kind, record, key: `intro:${record.id}`, name: record.product?.name ?? record.slug, type: "소개 수정", status: "접수", at: record.createdAt, waitHours: record.ageHours, next: "현재 소개와 대조", body: record.message, slug: record.slug })) }; }
    if (kind === "contact") { const queue = await contactRequestQueue({ state: contactState, offset, ...(selectedId ? { id: selectedId, limit: 1 } : {}) }); return { count: queue.count, nextOffset: queue.nextOffset, items: queue.items.map(record => ({ kind, record, key: `contact:${record.id}`, name: record.subject, type: "문의", status: record.status === "new" ? "접수" : record.status === "in_progress" ? "처리 중" : record.status === "waiting" ? "상대방 대기" : record.status === "resolved" ? "해결" : "스팸", at: record.receivedAt, waitHours: age(record.receivedAt), next: "메일함 회신·처리 기록", body: record.body, slug: null })) }; }
    if (kind === "feedback") { const queue = await feedbackAdminQueue({ state: reviews, limit: selectedId ? 1 : 25, cursor, ...(selectedId ? { id: selectedId } : {}) }); return { count: queue.count, nextCursor: queue.nextCursor, items: queue.items.map(record => ({ kind, record, key: `feedback:${record.id}`, name: record.productName, type: "피드백", status: record.reviewState === "held" ? "보류" : record.reviewState === "accepted" ? "공개" : "숨김", at: record.createdAt, waitHours: age(record.createdAt), next: "공개·숨김·복원", body: record.body, slug: record.slug })) }; }
    if (kind === "replies") { const queue = await makerReplyQueue({ state: reviews, offset, ...(selectedId ? { id: selectedId, limit: 1 } : {}) }); return { count: queue.count, nextOffset: queue.nextOffset, items: queue.items.map(record => ({ kind, record, key: `replies:${record.reply.id}`, name: record.productName, type: "메이커 답장", status: record.reply.reviewState === "held" ? "보류" : record.reply.reviewState === "accepted" ? "공개" : "숨김", at: record.reply.createdAt, waitHours: age(record.reply.createdAt), next: "원문 대조·공개 검토", body: record.reply.body, slug: record.slug })) }; }
    const queue = await heldReactionComments(selectedId ? 1 : 50, selectedId ? { id: selectedId } : undefined); return { count: queue.count, items: queue.items.map(record => ({ kind: "reactions" as const, record, key: `reactions:${record.id}`, name: record.productName, type: "써봤어요", status: "보류", at: record.createdAt, waitHours: age(record.createdAt), next: "한 줄 공개 검토", body: record.comment, slug: record.slug })) };
  }) })));
  return { results, items: results.flatMap(source => source.result.ok ? source.result.data.items : []).sort((a, b) => a.kind === "takedown" && b.kind !== "takedown" ? -1 : b.kind === "takedown" && a.kind !== "takedown" ? 1 : b.waitHours - a.waitHours),
    count: results.reduce((total, source) => total + (source.result.ok ? source.result.data.count : 0), 0), failed: results.filter(source => !source.result.ok).map(source => source.kind) };
}

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
