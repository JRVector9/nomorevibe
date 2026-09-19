import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, crawlReviewAttempts, jobs, products } from "@/lib/db/schema";
import { getSettings, saveSettings, changeReviewMode } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { judgeRevision } from "@/lib/crawl/rules";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { runJob } from "@/lib/jobs/runner";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { enqueueSecondReviews, recordSecondReview } from "@/lib/crawl/second-review";
import { listReviewCandidates } from "@/lib/crawl/agent-review-repository";
import { secondReviews } from "@/lib/db/schema";
import { ensureSchema, resetTables } from "./setup";

const classify = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: classify,
  classifyCategories: async (inputs: unknown[]) => Promise.all(inputs.map(input => classify(input))),
}));
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: async () => null }));

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  classify.mockReset().mockResolvedValue(null);
  await saveSettings({ enabled: true }, "test");
  // 아래 대부분은 1차 승인 자체를 본다. 두 모델 승인 관문은 끝의 테스트들이 2차를 켜고 따로 본다
  await saveSettings({ secondReview: { enabled: false } }, "test");
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  vi.stubEnv("CRAWL_REVIEW_MODEL", "test-model");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "verified gate" })).toMatchObject({ ok: true });
});

async function candidate(index: number, approve = false, confidence?: number) {
  const repo = `gate/product-${index}`, productUrl = `https://gate-${index}.example`;
  const now = new Date(Date.now() - 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now,
    repoMeta: { description: "A useful application" }, pageStatus: 200,
    pageMeta: { title: `Gate ${index}`, description: "An application for daily work" } }).returning();
  // 운영의 판정 잡처럼 판정이 본 원본의 리비전을 남긴다
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: now, updatedAt: new Date(now.getTime() + index),
    signals: { judgedRevision: judgeRevision(document) } }).returning();
  const input = await loadReviewInput(row, document, await getSettings());
  const [attempt] = approve ? await db.insert(crawlReviewAttempts).values({ candidateId: row.id,
    kind: "automatic", state: "succeeded", inputHash: input.inputHash, policyHash: input.policyHash,
    sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "claude-cli", model: "test-model", attemptNumber: 1,
    outcome: { decision: "approve", reason: "Product description confirmed", evidenceIds: ["product"], ...(confidence === undefined ? {} : { confidence }) },
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
  // 본문이 바뀌면 판정이 본 원본이 아니다 — 승인 상태로 멈춰 있지 않고 판정으로 돌아간다.
  // 판정이 다시 보류하면 AI가 새 본문으로 재심사한다 (발행의 judgeRevision 검사)
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "new", reason: "source_changed" }]);
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

/**
 * 두 모델 승인 관문(2026-09-19, 사용자 결정). enforce 에서 1차 AI 가 승인해도 2차 모델이 같은 입력을 승인해야
 * 발행된다. 2차가 반대하면 사람에게 넘기고, AI 심사는 그 후보를 다시 집지 않는다.
 */
async function withGate() {
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "[MLX] second-test" }] } }, "test");
  return getSettings();
}
const vote = (row: { id: number; model: string | null }, decision: "approve" | "reject", reason = "Second model reason") =>
  recordSecondReview(row.id, { ok: true, decision, confidence: 0.9, reason, model: row.model!, provider: "abcllm", status: "agreed" });

it("1차 승인만으로는 발행하지 않고, 2차 모델도 승인하면 발행한다", async () => {
  const settings = await withGate();
  const { row, attempt } = await candidate(0, true, 0.95);
  await tick();
  expect(await db.select().from(products)).toHaveLength(0);

  expect(await enqueueSecondReviews(settings)).toBe(1);
  const [gate] = await db.select().from(secondReviews);
  expect(gate).toMatchObject({ candidateId: row.id, trigger: "ai_approved", firstAttemptId: attempt!.id, model: "[MLX] second-test", status: "pending" });
  await tick();
  expect(await db.select().from(products)).toHaveLength(0);

  await vote(gate, "approve");
  expect(await db.select().from(secondReviews)).toMatchObject([{ status: "agreed", secondDecision: "approve" }]);
  await tick();
  expect(await db.select().from(products)).toHaveLength(1);
});

it("2차 모델이 승인하지 않으면 발행하지 않고 사람에게 넘긴다 — AI 심사는 다시 집지 않는다", async () => {
  const settings = await withGate();
  const { row } = await candidate(0, true, 0.95);
  await enqueueSecondReviews(settings);
  const [gate] = await db.select().from(secondReviews);
  await vote(gate, "reject", "Only a docs page for a CLI");
  await tick();
  expect(await db.select().from(products)).toHaveLength(0);
  const [held] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.id));
  expect(held).toMatchObject({ state: "needs_review", reason: "second_review_split",
    signals: { stoppedAt: { rule: "2차 심사", detail: expect.stringContaining("Only a docs page for a CLI") } } });
  expect(await listReviewCandidates(await getSettings(), 50)).toEqual([]);
});

it("1차 확신이 기준에 못 미치면 2차가 승인해도 사람에게 넘긴다", async () => {
  const settings = await withGate();
  const { row } = await candidate(0, true, 0.4);
  await enqueueSecondReviews(settings);
  const [gate] = await db.select().from(secondReviews);
  await vote(gate, "approve");
  await tick();
  expect(await db.select().from(products)).toHaveLength(0);
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, row.id)))[0]).toMatchObject({ state: "needs_review", reason: "second_review_split" });
});

it("2차 모델이 1차와 같으면 표가 되풀이라 올리지 않고, 관문도 열리지 않는다", async () => {
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: "claude-cli", model: "test-model" }] } }, "test");
  await candidate(0, true, 0.95);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
  await tick();
  expect(await db.select().from(products)).toHaveLength(0);
});

