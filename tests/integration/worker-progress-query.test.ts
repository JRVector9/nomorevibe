import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges, crawlSettings, operationsObservations,
  products, productLinks, productEvidenceSources, agentRepositoryScans, repositoryAiLevels, jobs } from "@/lib/db/schema";
import { saveSettings } from "@/lib/crawl/settings";
import { buildWorkerProgress, readWorkerProgress } from "@/lib/operations/worker-progress-query";
import { observeService } from "@/lib/operations/observations";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";
import { AGENT_DETECTOR_VERSION } from "@/lib/domain/evidence/agents/types";
import { AI_LEVEL_RULES_VERSION } from "@/lib/domain/evidence/ai-level-labels";
import { roleHasUnexplainedStall } from "@/scripts/role-worker";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { combineMonitorStatus } from "@/lib/operations/failover-monitor";
import { runMonitorCycle } from "@/scripts/watch-failover-readiness";

beforeAll(ensureSchema);
beforeEach(async () => {
  vi.unstubAllEnvs();
  await resetTables();
  await db.delete(jobs);
  await db.delete(categoryDecisions);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(operationsObservations);
  await saveSettings({ enabled: true }, "test");
});

async function publicProduct(slug: string, now: Date, extra: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({ slug, url: `https://${slug}.example`, name: slug, tagline: "test", description: "test",
    category: "Dev", verifyToken: slug, editTokenHash: "a".repeat(64), status: "seeded",
    createdAt: new Date(now.getTime() - 120 * 60_000), updatedAt: new Date(now.getTime() - 120 * 60_000), ...extra });
}

it("does not invent missing-site demand for products the due selector cannot pick", async () => {
  const now = new Date();
  await publicProduct("no-sources", now);
  await publicProduct("first-link", now);
  await db.insert(productLinks).values({ slug: "first-link", kind: "repository", declarationSource: "maker",
    url: "https://github.com/acme/first", normalizedKey: "acme/first", createdAt: new Date(now.getTime() - 12 * 60_000) });
  await observeService("crawler", { status: "running" });
  expect((await readWorkerProgress(now)).stages.find(row => row.stage === "evidence"))
    .toMatchObject({ waiting: 1, oldestMinutes: 12, completed5m: 0 });
});

it("measures only public current sources, persisted success, and actual due age", async () => {
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  for (const slug of ["visible", "hidden", "private", "fresh"]) await publicProduct(slug, now, slug === "private" ? { status: "unverified" } : {});
  await db.insert(productLinks).values(["visible", "hidden", "private"].map(slug => ({ slug, kind: "repository" as const,
    declarationSource: "maker" as const, url: `https://github.com/acme/${slug}`, normalizedKey: `acme/${slug}`,
    visible: slug !== "hidden", createdAt: ago(120), updatedAt: ago(120) })));
  await db.insert(productEvidenceSources).values([
    ...["visible", "hidden", "private"].map(slug => ({ slug, kind: "repository" as const, provider: "github",
      sourceKey: `acme/${slug}`, sourceUrl: `https://github.com/acme/${slug}`, nextAttemptAt: ago(8), createdAt: ago(120),
      lastSuccessAt: ago(60), state: "ok" as const })),
    { slug: "visible", kind: "repository", provider: "github", sourceKey: "acme/obsolete", sourceUrl: "https://github.com/acme/obsolete",
      nextAttemptAt: ago(120), lastSuccessAt: ago(1) },
    ...["visible", "hidden", "fresh"].map(slug => ({ slug, kind: "documentation" as const, provider: "product_site", sourceKey: "canonical_site",
      sourceUrl: `https://${slug}.example`, state: "ok" as const, lastSuccessAt: slug === "fresh" ? ago(1) : ago(60),
      nextAttemptAt: new Date(now.getTime() + 60_000), createdAt: ago(120) })),
  ]);
  await observeService("crawler", { status: "running" });
  const source = (await readWorkerProgress(now)).stages.find(row => row.stage === "evidence");
  expect(source).toMatchObject({ role: "crawler", job: "product-evidence-refresh", waiting: 1,
    oldestMinutes: 8, completed5m: 1, progress5m: 1, reason: "progressing" });
  await db.update(productEvidenceSources).set({ lastSuccessAt: ago(60) }).where(eq(productEvidenceSources.slug, "fresh"));
  expect((await readWorkerProgress(now)).stages.find(row => row.stage === "evidence"))
    .toMatchObject({ waiting: 1, completed5m: 0, oldestMinutes: 8, reason: "no_progress", restartEligible: true });
});

it("detects changed canonical sites and alerts on old provider failures without restart or lost pause", async () => {
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  await publicProduct("changed", now, { updatedAt: ago(12) });
  await db.insert(productEvidenceSources).values({ slug: "changed", kind: "documentation", provider: "product_site", sourceKey: "canonical_site",
    sourceUrl: "https://old.example", state: "failed", nextAttemptAt: new Date(now.getTime() + 60_000),
    createdAt: ago(120), lastFailureAt: ago(2), lastErrorCode: "forbidden" });
  await observeService("crawler", { status: "running" });
  const evidence = async () => (await readWorkerProgress(now)).stages.find(row => row.stage === "evidence")!;
  // A replaced site's old error/success is not evidence about the current URL.
  expect(await evidence()).toMatchObject({ waiting: 1, oldestMinutes: 12, errors5m: 0, reason: "no_progress" });
  await db.update(productEvidenceSources).set({ sourceUrl: "https://changed.example", createdAt: ago(120), nextAttemptAt: ago(60) })
    .where(eq(productEvidenceSources.slug, "changed"));
  expect(await evidence()).toMatchObject({ reason: "upstream_stalled", alarm: true, restartEligible: false });
  await db.insert(jobs).values({ name: "product-evidence-refresh", notBefore: new Date("2100-01-01") });
  expect(await evidence()).toMatchObject({ reason: "paused", alarm: false, restartEligible: false });
});

it("distinguishes partial agent progress from completed scans and includes unseen current AI-level demand", async () => {
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  await saveSettings({ agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true } }, "test");
  await publicProduct("agent", now, { repoUrl: "https://github.com/acme/agent" });
  await publicProduct("excluded", now, { status: "banned", repoUrl: "https://github.com/acme/excluded" });
  await db.insert(agentRepositoryScans).values([
    { repositoryKey: "acme/agent", githubRepositoryId: BigInt(1), commitSha: "a".repeat(40), detectorVersion: AGENT_DETECTOR_VERSION,
      scope: "", scopeHash: "a".repeat(64), state: "partial", fileCount: 1, startedAt: ago(1), completedAt: ago(60), nextAttemptAt: ago(10) },
    { repositoryKey: "acme/excluded", githubRepositoryId: BigInt(2), commitSha: "b".repeat(40), detectorVersion: AGENT_DETECTOR_VERSION,
      scope: "", scopeHash: "b".repeat(64), state: "complete", fileCount: 1, startedAt: ago(1), completedAt: ago(1), nextAttemptAt: ago(10) },
  ]);
  await db.insert(repositoryAiLevels).values({ repositoryKey: "acme/agent", rulesVersion: "old", checkedAt: ago(1),
    nextCheckAt: new Date(now.getTime() + 60_000), level: 2 });
  await observeService("crawler", { status: "running" });
  const report = await readWorkerProgress(now);
  expect(report.stages.find(row => row.stage === "agent-evidence"))
    .toMatchObject({ waiting: 1, completed5m: 0, progress5m: 1, reason: "progressing" });
  expect(report.stages.find(row => row.stage === "ai-level"))
    .toMatchObject({ waiting: 1, completed5m: 0, oldestMinutes: 120, reason: "no_progress" });
  await db.update(repositoryAiLevels).set({ rulesVersion: AI_LEVEL_RULES_VERSION, checkedAt: ago(1) });
  expect((await readWorkerProgress(now)).stages.find(row => row.stage === "ai-level"))
    .toMatchObject({ waiting: 0, completed5m: 1, progress5m: 1, reason: "no_work" });
});

it("preserves lane polling clocks and scopes active job suppression to the same lane", () => {
  const now = new Date();
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [{ key: "fetch", enabled: true,
    waiting: 1, oldestMinutes: 10, completed5m: 0, progress5m: 0, errors5m: 0 } as never] }, [
    { name: "crawl-fetch", nextScheduledAt: now, notBefore: null },
    { name: "ai-level-refresh", nextScheduledAt: now, notBefore: null, lockedAt: now, leaseToken: "owned" },
  ], [
    { key: "service:scheduler:s", value: { status: "running" }, observedAt: now },
    { key: "service:crawler:c", value: { status: "running", lanes: [
      { name: "crawl-fetch", jobs: ["crawl-fetch"], state: "polling", currentJob: null, startedAt: null,
        pollStartedAt: now.getTime() - 100_000, lastProgressAt: now.getTime() - 100_000 },
      { name: "ai-level-refresh", jobs: ["ai-level-refresh"], state: "running", currentJob: "ai-level-refresh",
        startedAt: now.getTime() - 10_000, pollStartedAt: null, lastProgressAt: now.getTime() - 10_000 },
    ] }, observedAt: now },
  ], now);
  expect(report.lanes).toEqual(expect.arrayContaining([expect.objectContaining({ role: "crawler", reason: "lane_poll_timeout",
    pollAgeMs: 100_000, restartEligible: true })]));
  expect(report.activeJobs).toEqual(["ai-level-refresh"]);
  expect(roleHasUnexplainedStall(report, "crawler")).toBe(true);
});

it("respects public unseen AI idle while candidates and current-version due rows remain selectable", async () => {
  const now = new Date();
  await publicProduct("unseen", now, { repoUrl: "https://github.com/acme/unseen" });
  await db.insert(jobs).values({ name: "ai-level-refresh", nextScheduledAt: now,
    cursor: { unseenIdleUntil: new Date(now.getTime() + 10 * 60_000).toISOString() } });
  await observeService("crawler", { status: "running" });
  const ai = async () => (await readWorkerProgress(now)).stages.find(row => row.stage === "ai-level")!;
  expect(await ai()).toMatchObject({ waiting: 0, reason: "no_work", alarm: false, restartEligible: false });
  await db.insert(crawlCandidates).values({ repo: "acme/unseen", state: "new", updatedAt: new Date(now.getTime() - 20 * 60_000) });
  expect(await ai()).toMatchObject({ waiting: 1, oldestMinutes: 20, reason: "no_progress" });
  await db.delete(crawlCandidates);
  await db.insert(repositoryAiLevels).values({ repositoryKey: "acme/unseen", rulesVersion: AI_LEVEL_RULES_VERSION,
    checkedAt: new Date(now.getTime() - 120 * 60_000), nextCheckAt: new Date(now.getTime() - 20 * 60_000) });
  expect(await ai()).toMatchObject({ waiting: 1, oldestMinutes: 20, reason: "no_progress" });
  await db.delete(repositoryAiLevels);
  await db.update(jobs).set({ cursor: { unseenIdleUntil: new Date(now.getTime() - 1).toISOString() } });
  expect(await ai()).toMatchObject({ waiting: 1, oldestMinutes: 120, reason: "no_progress" });
});

it("keeps healthy leased work out of two external down samples without hiding timeouts or sibling stalls", async () => {
  const started = new Date();
  const stage = { key: "evidence" as const, enabled: true, waiting: 5, oldestMinutes: 120, completed5m: 0, progress5m: 0, errors5m: 0 };
  const reportAt = (ageMs: number, extraLane?: Record<string, unknown>, token: string | null = "owned", legacy = false, errors5m = 0, leaseAgeMs = 0) => {
    const now = new Date(started.getTime() + ageMs);
    const lane = { name: "product-evidence-refresh", jobs: ["product-evidence-refresh"], state: "running",
      currentJob: "product-evidence-refresh", startedAt: started.getTime(), pollStartedAt: null, lastProgressAt: started.getTime() };
    return buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] }, [
      { name: "product-evidence-refresh", nextScheduledAt: now, notBefore: null, lockedAt: new Date(now.getTime() - leaseAgeMs), leaseToken: token },
    ], ["scheduler", "crawler", "reviewer", "publisher", "maintenance", "text"].map(role => ({
      key: `service:${role}:test`, observedAt: now, value: role === "crawler" ? { status: "running", state: "running",
        currentJob: "product-evidence-refresh", jobStartedAt: started.getTime(), ...(legacy ? {} : { lanes: [lane, ...(extraLane ? [extraLane] : [])] }) }
        : { status: "running" },
    })), now, [{ ...stage, errors5m }]);
  };
  const push = vi.fn(), record = vi.fn();
  const ready = { overall: "ok", measuredAt: started.toISOString(), roles: [], release: "test" } as never;
  let state = { badSamples: 0 };
  for (const age of [0, 30_000]) {
    const report = reportAt(age);
    expect(report).toMatchObject({ overall: "ok", stages: [{ reason: "running", alarm: false, restartEligible: false,
      completed5m: 0, progress5m: 0 }] });
    state = await runMonitorCycle(state, combineMonitorStatus(ready, report), { push, record });
  }
  expect(push.mock.calls.some(call => call[0] === "down")).toBe(false);
  expect(reportAt(30_000, undefined, null).stages[0]).toMatchObject({ reason: "no_progress", alarm: true });
  expect(reportAt(30_000, undefined, "owned", false, 0, 90_001).stages[0]).toMatchObject({ reason: "no_progress", alarm: true });
  expect(reportAt(30_000, undefined, "owned", true)).toMatchObject({ overall: "ok", stages: [{ reason: "running" }] });
  expect(reportAt(190_000).lanes).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "job_timeout", alarm: true })]));
  expect(reportAt(100_000, { name: "crawl-fetch", jobs: ["crawl-fetch"], state: "polling", currentJob: null,
    startedAt: null, pollStartedAt: started.getTime(), lastProgressAt: started.getTime() })).toMatchObject({ overall: "alarm" });
  const providerAlarm = reportAt(30_000, undefined, "owned", false, 1);
  expect(providerAlarm.stages[0]).toMatchObject({ reason: "upstream_stalled", alarm: true, restartEligible: false });
});

it("reports publisher, text, and maintenance liveness separately", () => {
  const now = new Date();
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [] }, [], [
    { key: 'service:publisher:pub', value: { status: 'running' }, observedAt: now },
    { key: 'service:text:txt', value: { status: 'running' }, observedAt: now },
    { key: 'service:maintenance:mt', value: { status: 'running' }, observedAt: now },
  ], now);
  expect(report.liveness.filter(row => ['publisher', 'text', 'maintenance'].includes(row.role)))
    .toMatchObject([{ role: 'publisher', reason: 'present' }, { role: 'maintenance', reason: 'present' },
      { role: 'text', reason: 'present' }]);
});

it("counts recent boots and ignores a late observation from an older process", async () => {
  vi.stubEnv("SERVICE_INSTANCE_ID", "audit-crawler");
  const start = Date.now();
  for (let number = 1; number <= 4; number++) {
    await observeService("crawler", { status: "running", bootId: `boot-${number}`, bootedAt: start + number });
  }
  await observeService("crawler", { status: "failed", bootId: "boot-2", bootedAt: start + 2 });
  const [row] = await db.select().from(operationsObservations)
    .where(eq(operationsObservations.key, "service:crawler:audit-crawler"));
  expect(row.value).toMatchObject({ bootId: "boot-4", restartCount5m: 3, status: "running" });
  expect((await readWorkerProgress()).liveness.find(item => item.role === "crawler")?.reason).toBe("restart_loop");
});

it("keeps an hour of boots and counts same-release restarts, not deploys", async () => {
  vi.stubEnv("SERVICE_INSTANCE_ID", "audit-publisher");
  const start = Date.now() - 30 * 60_000;
  await observeService("publisher", { status: "running", bootId: "a", bootedAt: start, release: "r1" });
  await observeService("publisher", { status: "running", bootId: "b", bootedAt: start + 60_000, release: "r2" });
  await observeService("publisher", { status: "running", bootId: "c", bootedAt: start + 20 * 60_000, release: "r2" });
  const [row] = await db.select().from(operationsObservations)
    .where(eq(operationsObservations.key, "service:publisher:audit-publisher"));
  // r1 → r2 는 배포, r2 → r2 는 죽고 다시 뜬 것. 5분 안 재시작은 없다
  expect(row.value).toMatchObject({ bootId: "c", restartCount1h: 1, restartCount5m: 0 });
});

it("ages an expired classification hold from its retry time, not from when it was held", async () => {
  // 같은 샤드의 다른 파일이 남긴 최근 발행이 있으면 "진행 중"으로 읽힌다 — 발행 진행이 없는 상태에서 잰다
  await db.delete(crawlPublicationChanges);
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  // 2026-10-08: 1시간 보류가 막 풀린 후보가 "61분 대기"로 보여 감시가 발행 워커를 재시작했다
  await db.insert(crawlCandidates).values({ repo: "audit/held", state: "approved", reason: "passed", decidedBy: "auto", updatedAt: ago(120) });
  await db.insert(categoryDecisions).values({ repo: "audit/held", sourceHash: "h", category: null, reason: "held",
    actor: "test", retryAt: ago(1), updatedAt: ago(61) });
  await db.insert(operationsObservations).values({ key: "service:publisher:audit", value: { status: "running" }, observedAt: now });
  const publish = async () => (await readWorkerProgress(now)).stages.find(row => row.stage === "publish")!;
  expect(await publish()).toMatchObject({ role: "publisher", reason: "warming_up", alarm: false });
  await db.update(categoryDecisions).set({ retryAt: ago(11) }).where(eq(categoryDecisions.repo, "audit/held"));
  expect(await publish()).toMatchObject({ role: "publisher", reason: "no_progress", alarm: true });
});

it("uses the persisted eligible frontier and worker observation for a no-progress signal", async () => {
  const now = new Date();
  await db.insert(crawlFrontier).values({ repo: "audit/old-ready", signal: "test", state: "pending",
    discoveredAt: new Date(now.getTime() - 10 * 60_000),
    updatedAt: new Date(now.getTime() - 10 * 60_000),
    nextAttemptAt: new Date(now.getTime() - 10 * 60_000) });
  await db.insert(operationsObservations).values({ key: "service:crawler:audit", value: { status: "running" }, observedAt: now });
  const fetch = async () => (await readWorkerProgress(now)).stages.find(row => row.stage === "fetch")!;
  expect(await fetch()).toMatchObject({ role: "crawler", reason: "no_progress", alarm: true });
  await db.update(crawlFrontier).set({ nextAttemptAt: new Date(now.getTime() + 10 * 60_000) })
    .where(eq(crawlFrontier.repo, "audit/old-ready"));
  expect(await fetch()).toMatchObject({ role: "crawler", reason: "no_work", alarm: false });
});

it("emits a machine-readable alarm with exit code 2 for an external monitor", async () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/check-worker-progress.ts"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    encoding: "utf8", timeout: 10_000,
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ overall: "alarm", stages: expect.any(Array),
    scheduler: expect.any(Object), liveness: expect.any(Array) });
});
