import "server-only";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { adminContactRequests as requests, type ContactStatus } from "@/lib/db/admin-contact-schema";
import { adminAuditRow } from "./admin-log";
import { AdminRequestError, assertAdminActor, contactInput, contactUpdateInput, parseAdminRequest } from "./admin-requests-contract";

export async function createContactRequest(value: unknown, adminLogin: string) {
  assertAdminActor(adminLogin);
  const input = parseAdminRequest(contactInput, value);
  return onPrimary(() => db.transaction(async tx => {
    const [created] = await tx.insert(requests).values({ ...input, createdBy: adminLogin, updatedBy: adminLogin }).returning();
    await tx.insert(operationsAudit).values(await adminAuditRow(adminLogin, {
      action: "contact_request.create", target: created.id, detail: { status: created.status, version: created.version },
    }));
    return created;
  }));
}
export async function updateContactRequest(value: unknown, adminLogin: string) {
  assertAdminActor(adminLogin);
  const input = parseAdminRequest(contactUpdateInput, value);
  return onPrimary(() => db.transaction(async tx => {
    const [current] = await tx.select().from(requests).where(eq(requests.id, input.id)).for("update");
    if (!current) throw new AdminRequestError("not_found");
    if (current.version !== input.version) throw new AdminRequestError("conflict");
    const [updated] = await tx.update(requests).set({ status: input.status, handlingNote: input.handlingNote,
      version: sql`${requests.version} + 1`, updatedBy: adminLogin, updatedAt: sql`now()` }).where(eq(requests.id, current.id)).returning();
    await tx.insert(operationsAudit).values(await adminAuditRow(adminLogin, {
      action: "contact_request.update", target: current.id, detail: { before: current.status, status: updated.status, version: updated.version },
    }));
    return updated;
  }));
}
/** 기본은 미처리·처리 중·회신 대기. 개인정보는 이 전용 화면에서만 읽는다. */
export async function contactRequestQueue(options: { state?: ContactStatus | "open" | "all"; offset?: number; limit?: number } = {}) {
  const state = options.state ?? "open";
  const where = state === "all" ? undefined : state === "open" ? inArray(requests.status, ["new", "in_progress", "waiting"]) : eq(requests.status, state);
  const offset = Math.max(0, Math.min(100000, Math.trunc(options.offset ?? 0)));
  const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? 25)));
  return onPrimary(async () => {
    const [items, [total]] = await Promise.all([
      db.select().from(requests).where(where).orderBy(asc(requests.receivedAt), asc(requests.id)).offset(offset).limit(limit),
      db.select({ count: sql<number>`count(*)::int` }).from(requests).where(where),
    ]);
    return { count: total?.count ?? 0, items, nextOffset: offset + items.length < (total?.count ?? 0) ? offset + items.length : null };
  });
}
/** 오늘 할 일의 공유 캐시에는 개인정보를 넣지 않는다 — 수·ID·상태만. */
export async function contactRequestSummary(limit = 5) {
  return onPrimary(async () => {
    const where = inArray(requests.status, ["new", "in_progress", "waiting"]);
    const [items, [total]] = await Promise.all([
      db.select({ id: requests.id, status: requests.status, receivedAt: requests.receivedAt }).from(requests).where(where)
        .orderBy(asc(requests.receivedAt), asc(requests.id)).limit(limit),
      db.select({ count: sql<number>`count(*)::int` }).from(requests).where(where),
    ]);
    return { count: total?.count ?? 0, items };
  });
}
