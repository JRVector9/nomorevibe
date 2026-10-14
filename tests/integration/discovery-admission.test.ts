import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { createDbClient, dbPoolConfig } from "@/lib/db/pool";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews,
  agentRepositoryObservations, agentRepositoryScans } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { changeReviewMode, getSettings, saveSettings } from "@/lib/crawl/settings";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { loadSecondReviewInput, secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { discoveryAdmission, readDiscoveryAdmission } from "@/lib/crawl/discovery-admission";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  for (const table of [secondReviews, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlFrontier,
    agentRepositoryObservations, agentRepositoryScans, crawlSettings, jobs]) await db.delete(table);
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "first" }, secondReview: {
    enabled: true, voters: [{ provider: "abcllm", model: "second" }], sampleRate: 0,
  } }, "test");
});

it("counts actual new frontier inserts rather than duplicate discoveries and source refreshes", async () => {
  await crawl.enqueue([{ repo: "acme/one", signal: "search" }, { repo: "acme/one", signal: "search" }]);
  await crawl.enqueue([{ repo: "ACME/ONE", signal: "search" }]);
  await crawl.enqueue([{ repo: "acme/refresh", signal: "review-source-refresh" }]);
  await db.insert(crawlFrontier).values({ repo: "acme/alias", signal: "search", aliasOf: "acme/one", state: "skipped" });
  // Keep the fixture inside the window even if the Docker clock is slightly ahead.
  await db.update(crawlFrontier).set({ discoveredAt: new Date(Date.now() - 1_000) });
  expect((await readDiscoveryAdmission(await getSettings())).recentNew).toBe(1);
});

it("excludes delayed and active fetch claims and paused jobs, using the time work became ready", async () => {
  const now = new Date();
  await db.insert(crawlFrontier).values([
    { repo: "acme/ready", signal: "search", discoveredAt: new Date(now.getTime() - 10 * 60_000), nextAttemptAt: new Date(now.getTime() - 60_000) },
    { repo: "acme/delayed", signal: "search", nextAttemptAt: new Date(now.getTime() + 60_000) },
    { repo: "acme/running", signal: "search", state: "fetching", nextAttemptAt: new Date(now.getTime() + 10 * 60_000) },
    { repo: "acme/history", signal: "search", state: "done" },
  ]);
  let snapshot = await readDiscoveryAdmission(await getSettings(), now);
  expect(snapshot.stages.find(stage => stage.key === "fetch")).toMatchObject({ waiting: 1, oldestMinutes: 1 });
  await db.insert(jobs).values({ name: "crawl-fetch", notBefore: new Date(now.getTime() + 60_000) });
  snapshot = await readDiscoveryAdmission(await getSettings(), now);
  expect(snapshot.stages.find(stage => stage.key === "fetch")).toMatchObject({ waiting: 0, oldestMinutes: null });
});

it("uses rule, first-review and publication selectors while excluding exhausted human holds and provider backoff", async () => {
  const priorReady = process.env.CRAWL_REVIEW_READY;
  process.env.CRAWL_REVIEW_READY = "true";
  try { expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "Admission fixture" })).toMatchObject({ ok: true }); }
  finally { if (priorReady === undefined) delete process.env.CRAWL_REVIEW_READY; else process.env.CRAWL_REVIEW_READY = priorReady; }
  const old = new Date(Date.now() - 10 * 60_000);
  for (const repo of ["acme/rules", "acme/first", "acme/human", "acme/publish"]) {
    await crawl.putDocument({ repo, productUrl: `https://${repo.split("/")[1]}.test`, repoMeta: { description: "An app" },
      pageStatus: 200, pageMeta: { title: "App", description: "A deployed application" } });
  }
  await db.update(crawlDocuments).set({ fetchedAt: old });
  await crawl.recordJudgement({ repo: "acme/first", productUrl: "https://first.test", state: "approved", reason: "passed", decidedBy: "auto" });
  await crawl.recordJudgement({ repo: "acme/human", productUrl: "https://human.test", state: "needs_review", reason: "ai_review_exhausted", decidedBy: "auto" });
  await crawl.recordJudgement({ repo: "acme/publish", productUrl: "https://publish.test", state: "approved", reason: "passed", decidedBy: "admin" });
  await db.update(crawlCandidates).set({ updatedAt: old });
  const settings = await getSettings();
  let snapshot = await readDiscoveryAdmission(settings);
  expect(snapshot.stages.find(stage => stage.key === "judge")?.waiting).toBe(1);
  expect(snapshot.stages.find(stage => stage.key === "first")?.waiting).toBe(1);
  expect(snapshot.stages.find(stage => stage.key === "publish")?.waiting).toBe(1);
  const candidate = (await crawl.getCandidate("acme/first"))!;
  const document = (await crawl.getDocument(candidate.repo))!;
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] });
  await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "failed", provider: "abcllm", model: "first",
    attemptNumber: 1, inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    errorCode: "timeout", retryAfter: new Date(Date.now() + 60_000), validUntil: input.validUntil });
  expect((await readDiscoveryAdmission(settings)).stages.find(stage => stage.key === "first")?.waiting).toBe(0);
  await db.update(crawlReviewAttempts).set({ retryAfter: sql`now() - interval '1 minute'` });
  snapshot = await readDiscoveryAdmission(settings);
  expect(snapshot.stages.find(stage => stage.key === "first")).toMatchObject({ waiting: 1, oldestMinutes: expect.closeTo(1, 1) });
  await db.insert(jobs).values({ name: "crawl-publish", notBefore: new Date(Date.now() + 60_000) });
  expect((await readDiscoveryAdmission(settings)).stages.find(stage => stage.key === "publish")?.waiting).toBe(0);
});

async function secondFixture() {
  const repo = "acme/second";
  await crawl.putDocument({ repo, productUrl: "https://second.test", repoMeta: { description: "A deployed product" },
    pageStatus: 200, pageMeta: { title: "Product", description: "An app" } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 1_000) }).where(eq(crawlDocuments.repo, repo));
  await crawl.recordJudgement({ repo, productUrl: "https://second.test", state: "needs_review", reason: "ambiguous", decidedBy: "auto" });
  const candidate = (await crawl.getCandidate(repo))!;
  const document = (await crawl.getDocument(repo))!;
  const settings = await getSettings();
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] });
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    provider: "abcllm", model: "first", attemptNumber: 1, inputHash: input.inputHash, policyHash: input.policyHash,
    sourceRevisionHash: input.sourceRevisionHash, source: input.source, snapshot: input.snapshot,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, validUntil: input.validUntil,
    outcome: { decision: "needs_review", reason: "Uncertain", evidenceIds: ["product"] } }).returning();
  const [vote] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: "ai_held", firstAttemptId: first.id,
    firstDecision: "needs_review", firstModel: "first", inputHash: input.inputHash, generationKey: secondReviewGeneration(first.id, input),
    provider: "abcllm", model: "second", status: "pending", createdAt: sql`now() - interval '10 minutes'` }).returning();
  return { candidate, document, settings, first, vote };
}

it("validates AI2 generations in bulk and excludes stale input, human exhaustion, and retry backoff", async () => {
  const fixture = await secondFixture();
  const ready = async () => (await readDiscoveryAdmission(fixture.settings)).stages.find(stage => stage.key === "second")!;
  expect(await ready()).toMatchObject({ waiting: 1, oldestMinutes: expect.any(Number) });
  await db.update(secondReviews).set({ status: "failed", errorCode: "timeout", failureCount: 1, reviewedAt: sql`now()` });
  expect((await ready()).waiting).toBe(0);
  await db.update(secondReviews).set({ reviewedAt: sql`now() - interval '6 minutes'` });
  expect(await ready()).toMatchObject({ waiting: 1, oldestMinutes: expect.closeTo(1, 1) });
  await db.update(secondReviews).set({ status: "needs_human", failureCount: 3 });
  expect((await ready()).waiting).toBe(0);
  await db.update(secondReviews).set({ status: "pending", errorCode: null, failureCount: 0 });
  await crawl.setReadmeSample(fixture.candidate.repo, "Recovered README changes the actual input", fixture.document);
  expect((await ready()).waiting).toBe(0);
});

it("filters historical policy votes before the bounded window so a current vote remains visible", async () => {
  const count = 1_001, now = new Date(Date.now() - 1_000);
  const documents = await db.insert(crawlDocuments).values(Array.from({ length: count }, (_, id) => ({
    repo: `acme/policy-history-${id}`, productUrl: `https://history-${id}.test`, fetchedAt: now,
    repoMeta: { description: "A deployed product" }, pageStatus: 200, pageMeta: { title: "Product", description: "An app" },
  }))).returning();
  const candidates = await db.insert(crawlCandidates).values(documents.map(document => ({ repo: document.repo,
    productUrl: document.productUrl, state: "needs_review" as const, decidedBy: "auto" as const, reason: "ambiguous" as const, judgedAt: now }))).returning();
  const settings = await getSettings();
  const inputs = candidates.map((candidate, id) => createReviewInput(candidate, documents[id], settings, { scan: null, observations: [] }));
  const firsts = await db.insert(crawlReviewAttempts).values(candidates.map((candidate, id) => ({ candidateId: candidate.id,
    kind: "automatic" as const, state: "succeeded" as const, provider: "abcllm", model: "first", attemptNumber: 1,
    inputHash: inputs[id].inputHash, policyHash: "historical-policy", sourceRevisionHash: inputs[id].sourceRevisionHash,
    source: inputs[id].source, snapshot: inputs[id].snapshot, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    validUntil: inputs[id].validUntil, outcome: { decision: "needs_review" as const, reason: "Uncertain", evidenceIds: ["product"] },
  }))).returning();
  await db.insert(secondReviews).values(candidates.map((candidate, id): typeof secondReviews.$inferInsert => ({ candidateId: candidate.id, repo: candidate.repo,
    trigger: "ai_held", firstAttemptId: firsts[id].id, firstDecision: "needs_review", firstModel: "first", inputHash: inputs[id].inputHash,
    generationKey: secondReviewGeneration(firsts[id].id, inputs[id]), provider: "abcllm", model: "second", status: "pending" as const,
    createdAt: new Date(now.getTime() - 10 * 60_000),
  })));
  const current = await secondFixture();
  expect(await loadSecondReviewInput(current.vote)).not.toBeNull();
  const snapshot = await readDiscoveryAdmission(settings);
  expect(snapshot).toMatchObject({ secondWindowLimited: false, secondVoteWindowLimited: false, secondUnvalidated: 0, timedOut: false });
  expect(snapshot.stages.find(stage => stage.key === "second")?.waiting).toBe(1);
  expect(discoveryAdmission(snapshot, false)).toEqual({ throttled: false, remainingNew: Infinity });
});

async function observedSecondFixture() {
  const fixture = await secondFixture();
  const sha = "a".repeat(40);
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(123), repositoryKey: fixture.candidate.repo,
    commitSha: sha, scopeHash: "root", state: "complete", detectorVersion: fixture.settings.agentEvidence.detectorVersion,
    completedAt: sql`now() - interval '1 second'` }).returning();
  await db.insert(agentRepositoryObservations).values(Array.from({ length: 65 }, (_, id) => ({ scanId: scan.id, observationKey: `evidence-${id}`,
    facts: { kind: "client_config" as const, client: "claude-code", compatibleClients: [], modelDeveloper: null, declaredModelId: null,
      gateway: null, routing: "unknown" as const, role: null, scope: "", keyPath: `setting-${id}`, ruleId: "fixture",
      sourcePath: ".claude/settings.json", commitSha: sha, blobSha: null,
      sourceUrl: `https://github.com/${fixture.candidate.repo}/blob/${sha}/.claude/settings.json` } })));
  const input = await loadReviewInput(fixture.candidate, fixture.document, fixture.settings);
  await db.update(crawlReviewAttempts).set({ inputHash: input.inputHash, policyHash: input.policyHash,
    sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source, validUntil: input.validUntil })
    .where(eq(crawlReviewAttempts.id, fixture.first.id));
  const [vote] = await db.update(secondReviews).set({ inputHash: input.inputHash,
    generationKey: secondReviewGeneration(fixture.first.id, input) }).where(eq(secondReviews.id, fixture.vote.id)).returning();
  return { ...fixture, vote, input, scan };
}

it("reports valid votes omitted by the observation cap as an incomplete lower bound", async () => {
  const fixture = await observedSecondFixture();
  expect(await loadSecondReviewInput(fixture.vote)).not.toBeNull();
  const snapshot = await readDiscoveryAdmission(fixture.settings);
  expect(snapshot).toMatchObject({ secondWindowLimited: true, secondObservationLimited: true, secondUnvalidated: 1,
    secondUnvalidatedOldestMinutes: expect.closeTo(10, 1) });
  expect(snapshot.stages.find(stage => stage.key === "second")?.waiting).toBe(0);
  expect(discoveryAdmission({ ...snapshot, secondUnvalidated: 500 }, false).throttled).toBe(true);
});

it.each(["policy", "prompt", "rules", "document-source", "candidate-source", "scan-source", "readme", "expiry", "voter", "dependent", "decision", "first-model"])(
  "excludes a known %s mismatch before observation-cap uncertainty", async mismatch => {
    const fixture = await observedSecondFixture();
    const firstId = eq(crawlReviewAttempts.id, fixture.first.id), voteId = eq(secondReviews.id, fixture.vote.id);
    if (mismatch === "policy") await db.update(crawlReviewAttempts).set({ policyHash: "old-policy" }).where(firstId);
    if (mismatch === "prompt") await db.update(crawlReviewAttempts).set({ promptVersion: "old-prompt" }).where(firstId);
    if (mismatch === "rules") await db.update(crawlReviewAttempts).set({ rulesVersion: "old-rules" }).where(firstId);
    if (mismatch === "document-source") await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 60_000) })
      .where(eq(crawlDocuments.repo, fixture.candidate.repo));
    if (mismatch === "candidate-source") await db.update(crawlCandidates).set({ judgedAt: new Date(Date.now() - 60_000) })
      .where(eq(crawlCandidates.id, fixture.candidate.id));
    if (mismatch === "scan-source") await db.update(agentRepositoryScans).set({ commitSha: "b".repeat(40) }).where(eq(agentRepositoryScans.id, fixture.scan.id));
    if (mismatch === "readme") await crawl.setReadmeSample(fixture.candidate.repo, "Changed README", fixture.document);
    if (mismatch === "expiry") {
      const old = new Date(Date.now() - 25 * 3600_000);
      await db.update(crawlDocuments).set({ fetchedAt: old }).where(eq(crawlDocuments.repo, fixture.candidate.repo));
      const input = await loadReviewInput(fixture.candidate, { ...fixture.document, fetchedAt: old }, fixture.settings);
      await db.update(crawlReviewAttempts).set({ source: input.source, snapshot: input.snapshot, inputHash: input.inputHash,
        sourceRevisionHash: input.sourceRevisionHash, validUntil: input.validUntil }).where(firstId);
      await db.update(secondReviews).set({ inputHash: input.inputHash,
        generationKey: secondReviewGeneration(fixture.first.id, input) }).where(voteId);
    }
    if (mismatch === "voter") await db.update(secondReviews).set({ model: "removed-model" }).where(voteId);
    if (mismatch === "dependent") {
      await saveSettings({ secondReview: { ...fixture.settings.secondReview, voters: [{ provider: "abcllm", model: "[MLX] FIRST" }] } }, "test");
      await db.update(secondReviews).set({ model: "[MLX] FIRST" }).where(voteId);
    }
    if (mismatch === "decision") await db.update(crawlReviewAttempts).set({ outcome: { decision: "approve", reason: "Approved", evidenceIds: ["product"] } }).where(firstId);
    if (mismatch === "first-model") await db.update(secondReviews).set({ firstModel: "other-first" }).where(voteId);
    const [vote] = await db.select().from(secondReviews).where(voteId);
    expect(await loadSecondReviewInput(vote)).toBeNull();
    const snapshot = await readDiscoveryAdmission(await getSettings());
    expect(snapshot).toMatchObject({ secondWindowLimited: false, secondObservationLimited: false, secondUnvalidated: 0, timedOut: false });
    expect(snapshot.stages.find(stage => stage.key === "second")?.waiting).toBe(0);
  },
);

it.each(["current", "generation", "input", "removed-root-voter", "resolution"])("matches worker fallback metadata before bounding evidence: %s", async mismatch => {
  const fixture = await observedSecondFixture();
  await saveSettings({ secondReview: { ...fixture.settings.secondReview, fallbacks: [{ provider: "abcllm", model: "backup" }] } }, "test");
  await db.update(secondReviews).set({ status: "resolved", resolution: "fallback" }).where(eq(secondReviews.id, fixture.vote.id));
  const [child] = await db.insert(secondReviews).values({ candidateId: fixture.candidate.id, repo: fixture.candidate.repo, trigger: "ai_held",
    firstAttemptId: fixture.first.id, firstModel: "first", firstDecision: "needs_review", generationKey: fixture.vote.generationKey,
    inputHash: fixture.vote.inputHash, fallbackForId: fixture.vote.id, provider: "abcllm", model: "backup", status: "pending",
    createdAt: new Date(Date.now() - 10 * 60_000) }).returning();
  const rootId = eq(secondReviews.id, fixture.vote.id);
  if (mismatch === "generation") await db.update(secondReviews).set({ generationKey: "old-generation" }).where(rootId);
  if (mismatch === "input") await db.update(secondReviews).set({ inputHash: "old-input" }).where(rootId);
  if (mismatch === "removed-root-voter") await db.update(secondReviews).set({ model: "removed-root-model" }).where(rootId);
  if (mismatch === "resolution") await db.update(secondReviews).set({ resolution: "superseded" }).where(rootId);
  expect(Boolean(await loadSecondReviewInput(child))).toBe(mismatch === "current");
  const snapshot = await readDiscoveryAdmission(await getSettings());
  expect(snapshot).toMatchObject({ secondWindowLimited: mismatch === "current", secondObservationLimited: mismatch === "current",
    secondUnvalidated: mismatch === "current" ? 1 : 0, timedOut: false });
});

it("throttles only pressure, retains hysteresis, and preserves one new candidate of exploration", () => {
  const snapshot = (waiting: number, age: number, recentNew = 0) => ({ recentNew, secondWindowLimited: false,
    stages: [{ key: "first" as const, waiting, oldestMinutes: age }] });
  expect(discoveryAdmission(snapshot(10, 60, 10_000), false)).toEqual({ throttled: false, remainingNew: Infinity });
  expect(discoveryAdmission(snapshot(500, 5, 99), false)).toEqual({ throttled: true, remainingNew: 1 });
  expect(discoveryAdmission(snapshot(300, 3, 1_000), true)).toEqual({ throttled: true, remainingNew: 1 });
  expect(discoveryAdmission(snapshot(250, 2), true)).toEqual({ throttled: false, remainingNew: Infinity });
  expect(discoveryAdmission(snapshot(999, 0), false).throttled).toBe(false);
  expect(discoveryAdmission(snapshot(1_000, 0), false).throttled).toBe(true);
});

it("bounds a real locked read and preserves the connection for the next snapshot after rollback", async () => {
  const client = createDbClient(TEST_DATABASE_URL, dbPoolConfig({ DB_POOL_MAX: "1" }));
  let entered!: () => void, release!: () => void;
  const locked = new Promise<void>(resolve => { entered = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let held: Promise<unknown> | undefined;
  try {
    held = client.begin(async tx => {
      await tx.unsafe("lock table crawl_frontier in access exclusive mode");
      entered();
      await released;
    });
    await locked;
    const settings = await getSettings(), started = Date.now();
    const snapshot = await readDiscoveryAdmission(settings);
    expect(snapshot).toMatchObject({ timedOut: true, secondWindowLimited: true });
    expect(discoveryAdmission(snapshot, false)).toEqual({ throttled: true, remainingNew: 1 });
    expect(Date.now() - started).toBeLessThan(3_500);
    release();
    await held;
    expect((await readDiscoveryAdmission(settings)).timedOut).toBe(false);
  } finally { release(); await held?.catch(() => {}); await client.end({ timeout: 2 }); }
});
