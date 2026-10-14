import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ repo: vi.fn(), probe: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/crawl/github", () => ({ getRepo: mocks.repo }));
vi.mock("@/lib/crawl/ai-evidence-gate", () => ({ PROBE_COMMITS: 30, probeAiEvidence: mocks.probe }));
vi.mock("@/lib/net/fetch", () => ({ fetchPage: mocks.page }));

import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema } from "./setup";

const repo = "owner/new-app";
const productUrl = "https://new-app.test";
const metadata = { id: 123, full_name: repo, private: false, fork: false, archived: false,
  stargazers_count: 3, homepage: productUrl };
const tick = () => runJob("crawl-fetch", fetchCrawlDocuments);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  vi.clearAllMocks();
  expect(await saveSettings({ enabled: true, discover: { queries: [{ label: "evidence-test", query: "test",
    enabled: true, requireEvidence: true, priority: 1 }] } }, "test")).toMatchObject({ ok: true });
  await crawl.enqueue([{ repo, signal: "evidence-test" }]);
  mocks.repo.mockResolvedValue({ ok: true, value: metadata });
  mocks.probe.mockResolvedValue({ ok: true, found: [] });
  mocks.page.mockResolvedValue({ status: 200, finalUrl: productUrl, html: "<title>App</title>" });
});

it.each(["admin", "auto"] as const)("preserves a %s decision inserted while the initial evidence probe runs", async decidedBy => {
  mocks.probe.mockImplementationOnce(async () => {
    await crawl.recordJudgement({ repo, productUrl, state: "published", reason: "passed", decidedBy,
      signals: { decisionDuringProbe: true } });
    return { ok: true, found: [] };
  });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(await crawl.getCandidate(repo)).toMatchObject({ state: "published", reason: "passed", decidedBy,
    signals: { decisionDuringProbe: true } });
  expect(await crawl.getDocument(repo)).toBeUndefined();
  expect((await db.select().from(crawlFrontier))[0]).toMatchObject({ state: "pending", attempts: 0 });
});

it.each(["approved", "published"] as const)("preserves a concurrent %s automatic decision and its existing source", async state => {
  let document: Awaited<ReturnType<typeof crawl.getDocument>>;
  mocks.probe.mockImplementationOnce(async () => {
    await crawl.putDocument({ repo, productUrl, repoMeta: metadata, pageStatus: 200,
      pageMeta: { title: "Approved App", textSample: "A deployed application", readmeSample: "Existing README" } });
    document = await crawl.getDocument(repo);
    await crawl.recordJudgement({ repo, productUrl, state, reason: "passed", decidedBy: "auto",
      signals: { agentReviewAttemptId: 123 } });
    return { ok: true, found: [] };
  });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(await crawl.getCandidate(repo)).toMatchObject({ state, reason: "passed", signals: { agentReviewAttemptId: 123 } });
  expect(await crawl.getDocument(repo)).toEqual(document);
});

it("does not apply the initial gate after its settings change during the probe", async () => {
  mocks.probe.mockImplementationOnce(async () => {
    await saveSettings({ discover: { queries: [{ label: "evidence-test", query: "test", enabled: true,
      requireEvidence: false, priority: 1 }] } }, "test");
    return { ok: true, found: [] };
  });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(await crawl.getCandidate(repo)).toBeUndefined();
  expect(await crawl.getDocument(repo)).toBeUndefined();
  expect((await db.select().from(crawlFrontier))[0]).toMatchObject({ state: "pending", attempts: 0 });
  expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-judge") })).toBeUndefined();
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(mocks.page).toHaveBeenCalledOnce();
  expect(await crawl.getDocument(repo)).toMatchObject({ pageStatus: 200 });
});

it("uses the common fresh GitHub star exception before probing for initial evidence", async () => {
  mocks.repo.mockResolvedValue({ ok: true, value: { ...metadata, stargazers_count: 500 } });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(mocks.probe).not.toHaveBeenCalled();
  expect(mocks.page).toHaveBeenCalled();
  expect(await crawl.getCandidate(repo)).toBeUndefined();
  expect(await crawl.getDocument(repo)).toMatchObject({ pageStatus: 200 });
});

it("rolls back initial evidence storage when the worker loses its lease during the probe", async () => {
  mocks.probe.mockImplementationOnce(async () => {
    await db.update(jobs).set({ leaseToken: "replacement-owner" }).where(eq(jobs.name, "crawl-fetch"));
    return { ok: true, found: [] };
  });
  expect(await tick()).toMatchObject({ status: "failed" });
  expect(await crawl.getCandidate(repo)).toBeUndefined();
  expect(await crawl.getDocument(repo)).toBeUndefined();
});

it("keeps Retry-After beyond the frontier backoff and recovers the same claim after it becomes due", async () => {
  mocks.probe.mockResolvedValue({ ok: true, found: ["file:CLAUDE.md"] });
  const retryAt = new Date(Date.now() + 15 * 60_000);
  mocks.page.mockRejectedValueOnce(Object.assign(new Error("HTTP 429"), { retryAt }));
  expect(await tick()).toMatchObject({ status: "completed" });
  const [pending] = await db.select().from(crawlFrontier);
  expect(pending).toMatchObject({ state: "pending", attempts: 1, lastError: expect.stringContaining("HTTP 429") });
  expect(pending.nextAttemptAt.getTime()).toBe(retryAt.getTime());
  expect(await crawl.getDocument(repo)).toBeUndefined();
  expect(await crawl.getCandidate(repo)).toBeUndefined();
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(mocks.page).toHaveBeenCalledTimes(1);
  await db.update(crawlFrontier).set({ nextAttemptAt: sql`now() - interval '1 second'` });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(await crawl.getDocument(repo)).toMatchObject({ pageStatus: 200 });
  expect((await db.select().from(crawlFrontier))[0]).toMatchObject({ state: "done", attempts: 2 });
});

it("does not let a short Retry-After bypass the existing backoff and stops after four failures", async () => {
  mocks.probe.mockResolvedValue({ ok: true, found: ["file:CLAUDE.md"] });
  mocks.page.mockRejectedValue(Object.assign(new Error("HTTP 503"), { retryAt: new Date(Date.now() + 1000) }));
  const before = Date.now();
  expect(await tick()).toMatchObject({ status: "completed" });
  const [pending] = await db.select().from(crawlFrontier);
  expect(pending.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
  for (let attempt = 1; attempt < crawl.MAX_ATTEMPTS; attempt++) {
    await db.update(crawlFrontier).set({ nextAttemptAt: sql`now() - interval '1 second'` });
    expect(await tick()).toMatchObject({ status: "completed" });
  }
  expect((await db.select().from(crawlFrontier))[0]).toMatchObject({ state: "failed", attempts: crawl.MAX_ATTEMPTS,
    lastError: expect.stringContaining("HTTP 503") });
  expect(await crawl.getDocument(repo)).toBeUndefined();
  expect(await crawl.getCandidate(repo)).toBeUndefined();
});

it("preserves a long Retry-After on the terminal fourth failure", async () => {
  mocks.probe.mockResolvedValue({ ok: true, found: ["file:CLAUDE.md"] });
  await db.update(crawlFrontier).set({ attempts: crawl.MAX_ATTEMPTS - 1 });
  const retryAt = new Date(Date.now() + 60 * 60_000);
  mocks.page.mockRejectedValue(Object.assign(new Error("HTTP 429"), { retryAt }));
  expect(await tick()).toMatchObject({ status: "completed" });
  const [failed] = await db.select().from(crawlFrontier);
  expect(failed).toMatchObject({ state: "failed", attempts: crawl.MAX_ATTEMPTS });
  expect(failed.nextAttemptAt.getTime()).toBe(retryAt.getTime());
});
