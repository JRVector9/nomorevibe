import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, operationsAudit } from "@/lib/db/schema";
import { ensureSchema, resetTables } from "./setup";
import { enqueue, judgementQueue } from "@/lib/crawl/repository";
import { planReconsideration, applyReconsideration } from "@/lib/crawl/reconsider";

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier); await db.delete(crawlSettings);
});
async function rejected(repo: string, decidedBy: "auto" | "admin" = "auto", stars = 500) {
  await db.insert(crawlDocuments).values({ repo, productUrl: null, repoMeta: { stargazers_count: stars, description: "An editor plugin" }, fetchedAt: new Date(Date.now() - 60000) });
  await db.insert(crawlCandidates).values({ repo, state: "rejected", reason: "no_homepage", decidedBy });
}
it("dry run preserves data; apply audits and waits for fresh source before rejudging", async () => {
  await rejected("maker/plugin"); await rejected("maker/manual", "admin"); await rejected("maker/small", "auto", 499);
  const plan = await planReconsideration();
  expect(plan.entries.map(row => row.repo)).toEqual(["maker/plugin"]);
  expect((await db.select().from(crawlCandidates)).every(row => row.state === "rejected")).toBe(true);
  const result = await applyReconsideration(plan, "test-policy-change");
  expect(result.queued).toEqual(["maker/plugin"]);
  expect(await judgementQueue(10)).toHaveLength(0);
  expect(await db.select().from(crawlFrontier)).toMatchObject([{ repo: "maker/plugin", state: "pending" }]);
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.repo, "maker/plugin"));
  expect((await judgementQueue(10)).map(row => row.document.repo)).toEqual(["maker/plugin"]);
  expect(await db.select().from(operationsAudit).where(eq(operationsAudit.action, "reconsider-installable"))).not.toHaveLength(0);
  expect((await applyReconsideration(plan, "test-policy-change")).queued).toEqual([]);
});

it("requeues old rejected and held popular sources for a fresh GitHub check without changing admin decisions", async () => {
  await rejected("maker/popular", "auto", 100_000);
  await rejected("maker/manual", "admin", 100_000);
  await rejected("maker/small", "auto", 499);
  await db.insert(crawlDocuments).values({ repo: "maker/held", productUrl: null,
    repoMeta: { stargazers_count: 500 }, fetchedAt: new Date(Date.now() - 60_000) });
  await db.insert(crawlCandidates).values({ repo: "maker/held", state: "needs_review", reason: "ambiguous", decidedBy: "auto" });

  const plan = await planReconsideration(1000, { policy: "star-auto" });
  expect(plan.entries.map(row => row.repo)).toEqual(["maker/popular", "maker/held"]);
  expect((await applyReconsideration(plan, "star-policy")).queued).toEqual(["maker/popular", "maker/held"]);
  expect(await judgementQueue(10)).toHaveLength(0);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, "maker/manual")))[0])
    .toMatchObject({ state: "rejected", decidedBy: "admin" });
});
it("package policy refetches small no-homepage rejections so the fetch can look for skill or plugin files", async () => {
  // 작업 로그는 지울 수 없어 실행마다 남는다 — 이번 실행만의 이름을 쓴다
  const skill = `maker/pdf-skill-${Date.now().toString(36)}`;
  await rejected(skill, "auto", 12);
  await rejected("maker/tiny", "auto", 4);
  await rejected("maker/popular", "auto", 600);
  await rejected("maker/manual", "admin", 12);
  await db.insert(crawlDocuments).values({ repo: "maker/fork", productUrl: null, repoMeta: { stargazers_count: 12, fork: true }, fetchedAt: new Date() });
  await db.insert(crawlCandidates).values({ repo: "maker/fork", state: "rejected", reason: "no_homepage", decidedBy: "auto" });
  await db.insert(crawlDocuments).values({ repo: "maker/site", productUrl: "https://site.test", repoMeta: { stargazers_count: 12 }, fetchedAt: new Date() });
  await db.insert(crawlCandidates).values({ repo: "maker/site", state: "rejected", reason: "not_a_product", decidedBy: "auto" });

  await expect(planReconsideration(1000, { policy: "package", includeAdmin: true })).rejects.toThrow("admin_rejections_are_protected");
  const plan = await planReconsideration(1000, { policy: "package" });
  expect(plan.entries.map(row => row.repo)).toEqual([skill]);
  expect((await applyReconsideration(plan, "package-policy")).queued).toEqual([skill]);
  // 새 수집(35~120)보다 뒤에 선다
  expect(await db.select().from(crawlFrontier)).toMatchObject([{ repo: skill, state: "pending", priority: 30,
    signal: "package-policy-reconsideration" }]);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, skill)))[0])
    .toMatchObject({ state: "new", reason: "source_changed", decidedBy: "auto" });
  // 증거가 없어 같은 거절로 돌아와도 다음 묶음은 그것을 다시 집지 않는다
  await db.update(crawlCandidates).set({ state: "rejected", reason: "no_homepage" }).where(eq(crawlCandidates.repo, skill));
  expect((await planReconsideration(1000, { policy: "package" })).entries).toEqual([]);
});
it("rejects a star-auto plan made for a different database", async () => {
  await rejected("maker/popular", "auto", 500);
  const plan = await planReconsideration(1000, { policy: "star-auto" });
  expect(plan.database).toMatch(/^[a-f0-9]{32}$/);
  await expect(applyReconsideration({ ...plan, database: "0".repeat(32) }, "star-policy"))
    .rejects.toThrow("reconsideration_database_changed");
  expect((await db.select().from(crawlCandidates))[0].state).toBe("rejected");
});
it("preserves a decision or source changed after the dry run", async () => {
  await rejected("maker/changed");
  const plan = await planReconsideration();
  await db.update(crawlCandidates).set({ decidedBy: "admin" }).where(eq(crawlCandidates.repo, "maker/changed"));
  expect((await applyReconsideration(plan, "test-policy-change")).queued).toEqual([]);
  expect((await db.select().from(crawlCandidates))[0].decidedBy).toBe("admin");
});

it("does not recreate a frontier case alias during reconsideration", async () => {
  await rejected("Maker/Plugin");
  const plan = await planReconsideration();
  await enqueue([{ repo: "maker/plugin", signal: "existing" }]);
  expect(await applyReconsideration(plan, "test-policy-change")).toEqual({ queued: [], changed: ["Maker/Plugin"] });
  expect(await db.select().from(crawlFrontier)).toHaveLength(1);
});

it("rechecks products registered after the reconsideration preview", async () => {
  await rejected("maker/plugin");
  const plan = await planReconsideration();
  const { insert } = await import("@/lib/domain/products/repository");
  await insert({ slug: "already-added", url: "https://plugin.example", repoUrl: "https://github.com/Maker/Plugin",
    name: "Plugin", tagline: "Plugin", description: "Plugin", category: "Plugin", status: "seeded",
    verifyToken: "verify", editTokenHash: "x".repeat(64) });
  expect(await applyReconsideration(plan, "test-policy-change")).toEqual({ queued: [], changed: ["maker/plugin"] });
  expect(await db.select().from(crawlFrontier)).toHaveLength(0);
});
it("does not mistake PostgreSQL microseconds for a fresh collection", async () => {
  await rejected("maker/precision");
  await db.update(crawlDocuments).set({ fetchedAt: sql`'2026-09-20 00:00:00.123456'::timestamp` }).where(eq(crawlDocuments.repo, "maker/precision"));
  await applyReconsideration(await planReconsideration(), "test-policy-change");
  expect(await judgementQueue(10)).toHaveLength(0);
});

it("reconsiders human rejections only with explicit scope and keeps their previous decision in the audit", async () => {
  await rejected("maker/manual", "admin");
  const plan = await planReconsideration(1000, { includeAdmin: true });
  expect(plan.entries.map(row => row.repo)).toEqual(["maker/manual"]);
  expect((await applyReconsideration(plan, "explicit-reconsideration")).queued).toEqual(["maker/manual"]);
  expect((await db.select().from(crawlCandidates))[0]).toMatchObject({ state: "new", decidedBy: "auto" });
  expect((await db.select().from(operationsAudit).where(eq(operationsAudit.actor, "explicit-reconsideration")))[0].detail)
    .toMatchObject({ previousDecidedBy: "admin", previousState: "rejected", includeAdmin: true });
});
