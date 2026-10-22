import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { adminContactRequests } from "@/lib/db/admin-contact-schema";
import { makerReplies, notifications, productMakerMembers } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { createContactRequest, updateContactRequest, contactRequestQueue, contactRequestSummary } from "@/lib/operations/contact-requests";
import { makerReplyQueue, reviewMakerReply } from "@/lib/operations/maker-reply-review";
import { upsertMakerReply } from "@/lib/me/maker";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";
vi.mock("server-only", () => ({}));
beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(adminContactRequests); });
afterEach(() => vi.unstubAllEnvs());

it("수동 문의 접수·상태처리와 감사 로그가 함께 저장되며 캐시 요약과 감사에는 개인정보가 없다", async () => {
  const floor = await auditFloor();
  const input = { senderEmail: "private.person@example.com", subject: "비공개 제목", body: "개인정보 문의 원문", receivedAt: "2026-10-22T09:00:00.000Z" };
  const created = await createContactRequest(input, "admin-one");
  expect(created).toMatchObject({ status: "new", version: 1, createdBy: "admin-one", ...input, receivedAt: new Date(input.receivedAt) });
  const updated = await updateContactRequest({ id: created.id, version: created.version, status: "resolved", handlingNote: "외부 메일함에서 답장 완료" }, "admin-two");
  expect(updated).toMatchObject({ status: "resolved", version: 2, updatedBy: "admin-two" });
  expect(await contactRequestQueue()).toMatchObject({ count: 0, items: [] });
  expect((await contactRequestQueue({ state: "resolved" })).items[0].handlingNote).toBe("외부 메일함에서 답장 완료");
  await updateContactRequest({ id: created.id, version: 2, status: "waiting", handlingNote: "추가 회신 대기" }, "admin-two");
  const summary = await contactRequestSummary();
  expect(summary).toMatchObject({ count: 1, items: [{ id: created.id, status: "waiting" }] });
  const logs = await auditRowsAfter(floor);
  expect(logs).toHaveLength(3);
  for (const text of [JSON.stringify(summary), JSON.stringify(logs)]) {
    for (const sensitive of [input.senderEmail, input.subject, input.body, "추가 회신 대기", "외부 메일함에서 답장 완료"]) expect(text).not.toContain(sensitive);
  }
});
it("관리자 둘의 문의 동시 처리 중 하나만 성공하고 오래된 폼은 메모를 덮지 못한다", async () => {
  const created = await createContactRequest({ senderEmail: "person@example.com", subject: "질문", body: "문의", receivedAt: "2026-10-22T09:00:00Z" }, "admin");
  const calls = await Promise.allSettled(["in_progress", "resolved"].map(status => updateContactRequest({ id: created.id, version: 1, status, handlingNote: status }, "admin")));
  expect(calls.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(calls.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "conflict" } }]);
  expect((await contactRequestQueue({ state: "all" })).items[0].version).toBe(2);
});

async function fixture() {
  const [product] = await db.insert(products).values({ slug: "reply-tool", name: "Reply Tool", url: "https://reply.example", tagline: "Tool", description: "Tool", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e".repeat(64) }).returning();
  const [maker, author] = await db.insert(publicUsers).values([{ displayName: "Maker" }, { displayName: "Author" }]).returning();
  await db.insert(productMakerMembers).values({ productId: product.id, userId: maker.id, role: "owner", method: "admin" });
  const [feedback] = await db.insert(productFeedback).values({ productId: product.id, authorUserId: author.id, requestId: crypto.randomUUID(), kind: "question", title: "Question", body: "Original feedback", normalizedBodyHash: "b".repeat(64), requestHash: "f".repeat(64), serviceDisclosureConsent: true, githubDisclosureConsent: false, sendToGithub: false, reviewState: "accepted" }).returning();
  const input = { targetType: "feedback" as const, targetId: feedback.id, body: "https://a.test https://b.test https://c.test https://d.test" };
  const held = await upsertMakerReply(maker.id, input);
  const [reply] = await db.select().from(makerReplies).where(eq(makerReplies.id, held.id));
  return { product, maker, author, feedback, input, reply };
}
it("보류 답장을 승인하고 숨김·복원해도 수신자 알림은 한 번이며 감사에 본문을 넣지 않는다", async () => {
  const { reply, author } = await fixture();
  const floor = await auditFloor();
  expect((await makerReplyQueue()).items[0]).toMatchObject({ targetBody: "Original feedback", reply: { reviewState: "held", reviewVersion: 1 } });
  const approved = await reviewMakerReply({ id: reply.id, version: 1, expectedState: "held", decision: "accepted" }, "admin");
  expect(approved).toMatchObject({ reviewVersion: 2, reviewState: "accepted", notified: true });
  const hidden = await reviewMakerReply({ id: reply.id, version: 2, expectedState: "accepted", decision: "rejected" }, "admin");
  expect(hidden).toMatchObject({ reviewVersion: 3, reviewRequired: true });
  expect((await db.select().from(notifications))[0].payload).not.toHaveProperty("excerpt");
  expect(await reviewMakerReply({ id: reply.id, version: 3, expectedState: "rejected", decision: "accepted" }, "admin")).toMatchObject({ notified: false });
  const sent = await db.select().from(notifications);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ userId: author.id, dedupeKey: `maker_reply:${reply.id}` });
  expect(JSON.stringify(await auditRowsAfter(floor))).not.toContain(reply.body);
});
it("작성자가 검수 중에 수정·원복해도 오래된 폼을 거절하고 숨김 답장은 여러 번 고쳐도 검수한다", async () => {
  const { maker, input, reply } = await fixture();
  await upsertMakerReply(maker.id, { ...input, body: input.body + " 수정" });
  await upsertMakerReply(maker.id, input);
  await expect(reviewMakerReply({ id: reply.id, version: 1, expectedState: "held", decision: "accepted" }, "admin")).rejects.toMatchObject({ code: "conflict" });
  await reviewMakerReply({ id: reply.id, version: 3, expectedState: "held", decision: "rejected" }, "admin");
  for (const body of ["고쳤어요", "한 번 더 고쳤어요"]) expect(await upsertMakerReply(maker.id, { ...input, body })).toMatchObject({ reviewState: "held", notified: false });
  expect(await db.select().from(notifications)).toHaveLength(0);
});
it("동시에 같은 버전을 승인·거절하면 한 번만 처리되며 숨겨진 원문/내린 제품은 승인하지 않는다", async () => {
  const { reply, feedback, product } = await fixture();
  const floor = await auditFloor();
  const results = await Promise.allSettled(["accepted", "rejected"].map(decision => reviewMakerReply({ id: reply.id, version: 1, expectedState: "held", decision }, "admin")));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await auditRowsAfter(floor, "maker_reply.review")).toHaveLength(1);
  await db.update(makerReplies).set({ reviewState: "held" }).where(eq(makerReplies.id, reply.id));
  await db.update(productFeedback).set({ reviewState: "rejected" }).where(eq(productFeedback.id, feedback.id));
  await expect(reviewMakerReply({ id: reply.id, version: 2, expectedState: "held", decision: "accepted" }, "admin")).rejects.toMatchObject({ code: "not_found" });
  await db.update(productFeedback).set({ reviewState: "accepted" }).where(eq(productFeedback.id, feedback.id));
  await db.update(products).set({ status: "banned" }).where(eq(products.id, product.id));
  await expect(reviewMakerReply({ id: reply.id, version: 2, expectedState: "held", decision: "accepted" }, "admin")).rejects.toMatchObject({ code: "not_found" });
});
it("감사 저장이 실패하면 문의·답장 공개 및 알림도 커밋하지 않는다", async () => {
  const { reply } = await fixture();
  // DB trigger가 감사 행을 거절하는 실제 트랜잭션 실패를 만든다.
  await db.execute(sql`create function test_reject_admin_request_audit() returns trigger language plpgsql as $$begin if new.action in ('maker_reply.review', 'contact_request.create') then raise exception 'test audit unavailable'; end if; return new; end$$`);
  await db.execute(sql`create trigger test_reject_admin_request_audit before insert on operations_audit for each row execute function test_reject_admin_request_audit()`);
  try {
    await expect(reviewMakerReply({ id: reply.id, version: 1, expectedState: "held", decision: "accepted" }, "admin")).rejects.toThrow();
    expect((await db.select().from(makerReplies))[0].reviewState).toBe("held");
    expect(await db.select().from(notifications)).toHaveLength(0);
    await expect(createContactRequest({ senderEmail: "person@example.com", subject: "질문", body: "문의", receivedAt: "2026-10-22T09:00:00Z" }, "admin")).rejects.toThrow();
    expect(await db.select().from(adminContactRequests)).toHaveLength(0);
  } finally {
    await db.execute(sql`drop trigger test_reject_admin_request_audit on operations_audit`);
    await db.execute(sql`drop function test_reject_admin_request_audit()`);
  }
});
