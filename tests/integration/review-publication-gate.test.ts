import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, crawlReviewAttempts, jobs, products } from "@/lib/db/schema";
import { getSettings, saveSettings, changeReviewMode } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { runJob } from "@/lib/jobs/runner";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { ensureSchema, resetTables } from "./setup";

const classify = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: classify,
  classifyCategories: async (inputs: unknown[]) => Promise.all(inputs.map(input => classify(input))),
}));
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: async () => null }));

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  classify.mockReset().mockResolvedValue(null);
  await saveSettings({ enabled: true }, "test");
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "verified gate" })).toMatchObject({ ok: true });
});

async function candidate(index: number, approve = false) {
  const repo = `gate/product-${index}`, productUrl = `https://gate-${index}.example`;
  const now = new Date(Date.now() - 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now,
    repoMeta: { description: "A useful application" }, pageStatus: 200,
    pageMeta: { title: `Gate ${index}`, description: "An application for daily work" } }).returning();
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: now, updatedAt: new Date(now.getTime() + index) }).returning();
  const input = await loadReviewInput(row, document, await getSettings());
  const [attempt] = approve ? await db.insert(crawlReviewAttempts).values({ candidateId: row.id,
    kind: "automatic", state: "succeeded", inputHash: input.inputHash, policyHash: input.policyHash,
    sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "test", model: "test-model", attemptNumber: 1,
    outcome: { decision: "approve", reason: "Product description confirmed", evidenceIds: ["product"] },
    validUntil: input.validUntil, startedAt: now, completedAt: now }).returning() : [];
  return { row, document, attempt };
}
const tick = () => runJob("crawl-publish", publishCandidates);

it("filters pending reviews before LIMIT without changing their existing state", async () => {
  await candidate(0, true);
  for (let index = 1; index <= 12; index++) await candidate(index);
  expect(await tick()).toMatchObject({ status: "completed", done: true });
  expect(await db.select().from(products)).toHaveLength(1);
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.state, "approved"))).toHaveLength(12);
  expect(classify).toHaveBeenCalledOnce();
});

it("does not classify or reject an approved rule candidate before AI review", async () => {
  await candidate(0);
  await tick();
  expect(classify).not.toHaveBeenCalled();
  expect(await db.select().from(products)).toHaveLength(0);
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "approved", reason: "passed" }]);
});

it("excludes an approval whose source revision or policy changed", async () => {
  const first = await candidate(0, true);
  await candidate(1, true);
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.id, first.document.id));
  await saveSettings({ judge: { maxStars: 41 } }, "changed policy");
  await tick();
  expect(classify).not.toHaveBeenCalled();
  expect(await db.select().from(products)).toHaveLength(0);
});

it("does not publish an approval whose model never saw the current page body", async () => {
  const { document } = await candidate(0, true);
  await db.update(crawlDocuments).set({ pageMeta: { ...document.pageMeta, textSample: "Gate 0 — an application for daily work" } })
    .where(eq(crawlDocuments.id, document.id));
  await tick();
  expect(await db.select().from(products)).toHaveLength(0);
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "approved" }]);
});

it("rechecks the exact approval in the product insert transaction", async () => {
  const { attempt } = await candidate(0, true);
  classify.mockImplementationOnce(async () => {
    await db.update(crawlReviewAttempts).set({ state: "superseded" }).where(eq(crawlReviewAttempts.id, attempt!.id));
    return "Dev";
  });
  expect(await tick()).toMatchObject({ status: "completed", done: false });
  expect(await db.select().from(products)).toHaveLength(0);
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "approved" }]);
});

it("rejects writes by a publisher whose lease was replaced during classification", async () => {
  await candidate(0, true);
  classify.mockImplementationOnce(async () => {
    await db.update(jobs).set({ leaseToken: "replacement", lockedAt: new Date() }).where(eq(jobs.name, "crawl-publish"));
    return "Dev";
  });
  expect(await tick()).toMatchObject({ status: "failed", error: "job_lease_lost" });
  expect(await db.select().from(products)).toHaveLength(0);
  expect(await db.select().from(jobs)).toMatchObject([{ leaseToken: "replacement" }]);
});

it("does not use an off-mode selection after enforce mode is enabled", async () => {
  await changeReviewMode({ mode: "off", expectedMode: "enforce", actor: "test", reason: "mode race fixture" });
  await candidate(0);
  classify.mockImplementationOnce(async () => {
    await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "rollout complete" });
    return "Dev";
  });
  expect(await tick()).toMatchObject({ status: "completed", done: false });
  expect(await db.select().from(products)).toHaveLength(0);
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "approved" }]);
});
