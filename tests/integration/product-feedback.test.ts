import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, onReplica } from "@/lib/db";
import { operationsAudit, products, rateLimits } from "@/lib/db/schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { getFeedback, listMyFeedback, listProductFeedback } from "@/lib/domain/feedback/repository";
import { submitFeedback } from "@/lib/domain/feedback/submit";
import { reviewFeedback } from "@/lib/domain/feedback/review";
import { auditFloor, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(rateLimits).where(sql`${rateLimits.key} like 'feedback:%'`);
});

async function seed() {
  const [product] = await db.insert(products).values({ slug: "feedback-tool", name: "Feedback Tool", url: "https://feedback.example",
    tagline: "Feedback", description: "Feedback", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" }).returning();
  const users = await db.insert(publicUsers).values([{ displayName: "작성자" }, { displayName: "다른 사용자" }]).returning();
  return { product, author: users[0], other: users[1] };
}

function write(change: Record<string, unknown> = {}) {
  return { requestId: randomUUID(), kind: "bug", title: "설치 오류", body: "<script>alert('raw')</script> 설치가 실패합니다.",
    serviceDisclosureConsent: true, sendToGithub: false, githubDisclosureConsent: false, ...change };
}

describe("service-local product feedback", () => {
  it("stores raw text under the server's author and returns accepted public records", async () => {
    const { author } = await seed();
    const payload = write({ authorUserId: 999 });
    const result = await submitFeedback("feedback-tool", author.id, payload);
    expect(result.replayed).toBe(false);
    expect(result.feedback).toMatchObject({ authorUserId: author.id, body: payload.body, reviewState: "accepted", deliveryState: "local_only" });
    expect(await listProductFeedback("feedback-tool")).toHaveLength(1);
    expect(await listMyFeedback(author.id)).toHaveLength(1);
    const [stored] = await db.select().from(productFeedback);
    expect(stored.body).toBe(payload.body);
    expect(stored.githubDeliveryEligible).toBe(false);
  });

  it("serializes concurrent identical requests and counts a replay only once", async () => {
    const { author } = await seed();
    const payload = write();
    const results = await Promise.all([submitFeedback("feedback-tool", author.id, payload), submitFeedback("feedback-tool", author.id, payload)]);
    expect(new Set(results.map((result) => result.feedback.id)).size).toBe(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await db.select().from(productFeedback)).toHaveLength(1);
    expect((await db.select().from(rateLimits).where(sql`${rateLimits.key} like 'feedback:%'`)).map((row) => row.count)).toEqual([1, 1]);
  });

  it("rejects a changed body or product reused under the same author request key", async () => {
    const { author } = await seed();
    const payload = write();
    await submitFeedback("feedback-tool", author.id, payload);
    await expect(submitFeedback("feedback-tool", author.id, { ...payload, body: "다른 내용" })).rejects.toMatchObject({ status: 409 });
    await db.insert(products).values({ slug: "other-product", name: "Other", url: "https://other.example", tagline: "Other", description: "Other",
      category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" });
    await expect(submitFeedback("other-product", author.id, payload)).rejects.toMatchObject({ status: 409 });
  });

  it("keeps held and rejected originals private to their author and admin", async () => {
    const { author, other } = await seed();
    const held = await submitFeedback("feedback-tool", author.id, write({ body: "https://a.test https://b.test http://c.test https://d.test" }));
    expect(held.feedback.reviewState).toBe("held");
    expect(await listProductFeedback("feedback-tool")).toEqual([]);
    expect(await getFeedback(held.feedback.id)).toBeNull();
    expect(await getFeedback(held.feedback.id, { userId: other.id })).toBeNull();
    expect(await getFeedback(held.feedback.id, { userId: author.id })).not.toBeNull();
    expect(await getFeedback(held.feedback.id, { admin: true })).not.toBeNull();
    await reviewFeedback({ id: held.feedback.id, decision: "rejected", reason: "중복 링크", adminLogin: "reviewer" });
    expect(await getFeedback(held.feedback.id, { userId: other.id })).toBeNull();
    expect((await listMyFeedback(author.id))[0].reviewState).toBe("rejected");
  });

  it("holds normalized repeats from the same author and product only during 24 hours", async () => {
    const { author, other } = await seed();
    const original = await submitFeedback("feedback-tool", author.id, write({ body: "ＡＢＣ\n설치    오류" }));
    expect((await submitFeedback("feedback-tool", author.id, write({ body: "ABC 설치 오류" }))).feedback.reviewReason).toBe("repeated_body");
    expect((await submitFeedback("feedback-tool", other.id, write({ body: "ABC 설치 오류" }))).feedback.reviewState).toBe("accepted");
    await db.update(productFeedback).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(productFeedback.authorUserId, author.id));
    expect((await submitFeedback("feedback-tool", author.id, write({ body: "ABC 설치 오류" }))).feedback.reviewState).toBe("accepted");
    expect(original.feedback.body).toBe("ＡＢＣ\n설치    오류");
  });

  it("rejects banned products and malformed or nonconsensual submissions", async () => {
    const { author, product } = await seed();
    await expect(async () => submitFeedback("feedback-tool", author.id, write({ sendToGithub: true }))).rejects.toMatchObject({ status: 400 });
    await db.update(products).set({ status: "banned" }).where(eq(products.id, product.id));
    await expect(submitFeedback("feedback-tool", author.id, write())).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(productFeedback)).toHaveLength(0);
  });

  it("enforces five per hour under concurrent requests without charging exact replays", async () => {
    const { author } = await seed();
    const first = write();
    await submitFeedback("feedback-tool", author.id, first);
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => submitFeedback("feedback-tool", author.id, write({ body: `오류 ${index}` }))));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(attempts.filter((result) => result.status === "rejected").every((result) => result.status === "rejected" && result.reason.status === 429)).toBe(true);
    expect((await submitFeedback("feedback-tool", author.id, first)).replayed).toBe(true);
    expect(await db.select().from(productFeedback)).toHaveLength(5);
  });

  it("also enforces the 20 per day limit when the hourly bucket has reset", async () => {
    const { author } = await seed();
    for (let group = 0; group < 4; group += 1) {
      await db.update(rateLimits).set({ resetAt: new Date(0) }).where(eq(rateLimits.key, `feedback:hour:${author.id}`));
      for (let index = 0; index < 5; index += 1) await submitFeedback("feedback-tool", author.id, write({ body: `오류 ${group}-${index}` }));
    }
    await db.update(rateLimits).set({ resetAt: new Date(0) }).where(eq(rateLimits.key, `feedback:hour:${author.id}`));
    await expect(submitFeedback("feedback-tool", author.id, write())).rejects.toMatchObject({ status: 429 });
    expect(await db.select().from(productFeedback)).toHaveLength(20);
  });

  it("records administrator approval and immutable audit in the same transaction", async () => {
    const { author } = await seed();
    const floor = await auditFloor();
    const held = await submitFeedback("feedback-tool", author.id, write({ body: "https://a.test https://b.test https://c.test https://d.test" }));
    const reviewed = await reviewFeedback({ id: held.feedback.id, decision: "accepted", reason: "관련 문서 링크 확인", adminLogin: "reviewer" });
    expect(reviewed).toMatchObject({ reviewState: "accepted", reviewedBy: "reviewer", reviewReason: "관련 문서 링크 확인", deliveryState: "local_only" });
    expect(reviewed.reviewedAt).not.toBeNull();
    const audit = await db.select().from(operationsAudit).where(and(sql`${operationsAudit.id} > ${floor}`, eq(operationsAudit.action, "feedback.review")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "reviewer", target: held.feedback.id });
    await expect(reviewFeedback({ id: held.feedback.id, decision: "rejected", reason: "다시", adminLogin: "reviewer" })).rejects.toMatchObject({ status: 409 });
  });

  it("waits for the product lock before holding feedback during concurrent invalidation", async () => {
    const { author, product } = await seed();
    const held = await submitFeedback(product.slug, author.id, write({ body: "https://a.test https://b.test https://c.test https://d.test" }));
    let releaseProduct!: () => void;
    let productLocked!: () => void;
    const ready = new Promise<void>((resolve) => { productLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseProduct = resolve; });
    const invalidation = db.transaction(async (tx) => {
      await tx.select({ id: products.id }).from(products).where(eq(products.id, product.id)).for("update");
      productLocked();
      await release;
    });
    await ready;
    const review = reviewFeedback({ id: held.feedback.id, decision: "accepted", reason: "문서 확인", adminLogin: "reviewer" });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query ilike '%products%' and query ilike '%for share%'`);
        if (rows.length) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await expect(db.transaction((tx) => tx.select({ id: productFeedback.id }).from(productFeedback)
        .where(eq(productFeedback.id, held.feedback.id)).for("update", { noWait: true }))).resolves.toHaveLength(1);
    } finally {
      releaseProduct();
      await invalidation;
      await review;
    }
  });

  it("rolls back feedback and quota if the future accepted transaction hook fails", async () => {
    const { author } = await seed();
    await expect(submitFeedback("feedback-tool", author.id, write(), { onAccepted: async () => { throw new Error("outbox_failure"); } })).rejects.toThrow("outbox_failure");
    expect(await db.select().from(productFeedback)).toEqual([]);
    expect(await db.select().from(rateLimits).where(sql`${rateLimits.key} like 'feedback:%'`)).toEqual([]);
  });

  it("reads personal records from primary even inside a replica scope", async () => {
    const { author } = await seed();
    const result = await submitFeedback("feedback-tool", author.id, write());
    expect(await onReplica(() => getFeedback(result.feedback.id, { userId: author.id }))).not.toBeNull();
  });

  it("filters one product before the owner's result limit so older held feedback remains visible", async () => {
    const { author } = await seed();
    const held = await submitFeedback("feedback-tool", author.id, write({ body: "https://a.test,https://b.test,https://c.test,https://d.test" }));
    const [otherProduct] = await db.insert(products).values({ slug: "later-feedback", name: "Other", url: "https://later-feedback.example", tagline: "Other", description: "Other",
      category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" }).returning();
    await db.insert(productFeedback).values(Array.from({ length: 100 }, () => ({ productId: otherProduct.id, authorUserId: author.id, requestId: randomUUID(), requestHash: "a".repeat(64),
      normalizedBodyHash: "b".repeat(64), kind: "bug" as const, title: "새 제품 피드백", body: "본문", serviceDisclosureConsent: true, reviewState: "accepted" as const,
      createdAt: new Date(Date.now() + 1000) })));
    expect(await listMyFeedback(author.id, "feedback-tool")).toEqual([expect.objectContaining({ id: held.feedback.id, reviewState: "held" })]);
  });
});
