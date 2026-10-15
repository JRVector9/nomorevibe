import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq, inArray, like, sql } from "drizzle-orm";

const transport = vi.hoisted(() => ({ readme: vi.fn(), cli: vi.fn(), gateway: vi.fn(), grok: vi.fn() }));
vi.mock("@/lib/crawl/readme", async original => ({
  ...await original<typeof import("@/lib/crawl/readme")>(), fetchReadmeSample: transport.readme,
}));
vi.mock("@/lib/crawl/agent-review", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: transport.cli,
}));
vi.mock("@/lib/crawl/agent-review-gateway", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: transport.gateway,
}));
vi.mock("@/lib/crawl/agent-review-grok", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: transport.grok,
}));

import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings,
  jobs, pipelineItemLeases, pipelineStageModes } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { claimAgentReview, claimItemAgentReview, loadReviewInput, recordAgentReview,
  handOffExhaustedFirstReviews, requeueStaleReviewSources } from "@/lib/crawl/agent-review-repository";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { claimItemLease, lockItemStage, renewItemLease } from "@/lib/jobs/items/repository";
import { itemBindingHash } from "@/lib/jobs/items/types";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, type ReviewOutcome } from "@/lib/crawl/agent-review-contract";
import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03b-ai1-independent-admin" } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03b-ai1-independent-observer", statement_timeout: 8_000 } });
const prefix = "pr03b-independent/";
const jobNames = ["crawl-fetch", "crawl-agent-review", "second-review", "crawl-publish"];
const sentinel = { name: "pr03b-ai1-independent-unrelated", requestedVersion: 13, processedVersion: 5,
  cursor: { marker: "pr03b-independent-unrelated", page: 71 }, notBefore: new Date("2101-01-01T00:00:00.000Z") };
let originalJobs: typeof jobs.$inferSelect[] = [];
let originalSettings: typeof crawlSettings.$inferSelect[] = [];
let originalStages: typeof pipelineStageModes.$inferSelect[] = [];
let originalCandidates: typeof crawlCandidates.$inferSelect[] = [];
let originalJobRows: unknown[] = [], originalSettingRows: unknown[] = [], originalCandidateRows: unknown[] = [];
let initialized = false, sequence = 0;

function fixtureSettings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce", reviewConcurrency: 1,
    firstReview: { provider: "claude-cli", model: "pr03b-fixture-model" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } };
}

async function restoreFixtures() {
  await admin`DROP TRIGGER IF EXISTS pr03b_ai1_request_failure ON jobs`;
  await admin`DROP FUNCTION IF EXISTS pr03b_ai1_request_failure()`;
  await admin`DROP TRIGGER IF EXISTS pr03b_ai1_semantic_barrier ON crawl_review_attempts`;
  await admin`DROP FUNCTION IF EXISTS pr03b_ai1_semantic_barrier()`;
  await admin`DELETE FROM pipeline_item_leases WHERE stage='ai1' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr03b-independent/%')`;
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${prefix}%`));
  await db.delete(jobs).where(inArray(jobs.name, jobNames));
  await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
  if (originalSettingRows.length) await admin`INSERT INTO crawl_settings SELECT * FROM
    jsonb_populate_recordset(NULL::crawl_settings, ${JSON.stringify(originalSettingRows)}::text::jsonb)`;
  for (const stage of originalStages) await db.update(pipelineStageModes).set(stage).where(eq(pipelineStageModes.stage, stage.stage));
}

beforeAll(async () => {
  ensureSchema();
  originalJobs = await db.select().from(jobs).where(inArray(jobs.name, jobNames)).orderBy(jobs.name);
  originalSettings = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
  originalStages = await db.select().from(pipelineStageModes);
  originalCandidates = await db.select().from(crawlCandidates).orderBy(crawlCandidates.id);
  originalJobRows = [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name = ANY(${jobNames}) ORDER BY name`].map(row => row.value);
  originalSettingRows = [...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value);
  originalCandidateRows = [...await admin`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`].map(row => row.value);
  initialized = true;
  // This file exercises the actual global handler. Keep earlier files' inputs
  // out of its model universe, then restore every row exactly in afterAll.
  if (originalCandidates.length) await db.update(crawlCandidates).set({ decidedBy: "admin" })
    .where(inArray(crawlCandidates.id, originalCandidates.map(row => row.id)));
  await db.insert(jobs).values(sentinel);
});
beforeEach(async () => {
  await restoreFixtures();
  vi.resetAllMocks();
  transport.readme.mockResolvedValue("A deployed task tracker. Create projects and manage tasks online.");
  const answer = { ok: true, outcome: { decision: "approve", confidence: 0.99,
    reason: "A deployed task tracker", evidenceIds: ["product"] }, usage: { inputTokens: 8, outputTokens: 2 } };
  for (const mock of [transport.cli, transport.gateway, transport.grok]) mock.mockResolvedValue(answer);
  await db.insert(crawlSettings).values({ id: 1, values: fixtureSettings(), updatedBy: "pr03b-independent" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: fixtureSettings(), updatedBy: "pr03b-independent" } });
});
afterEach(async () => {
  expect(await db.select().from(jobs).where(eq(jobs.name, sentinel.name))).toMatchObject([sentinel]);
});
afterAll(async () => {
  try {
    if (initialized) {
      await restoreFixtures();
      if (originalJobRows.length) await admin`INSERT INTO jobs SELECT * FROM
        jsonb_populate_recordset(NULL::jobs, ${JSON.stringify(originalJobRows)}::text::jsonb)`;
      for (const candidate of originalCandidates) await db.update(crawlCandidates).set({ decidedBy: candidate.decidedBy })
        .where(eq(crawlCandidates.id, candidate.id));
      await db.delete(jobs).where(eq(jobs.name, sentinel.name));
      expect(await db.select().from(jobs).where(inArray(jobs.name, jobNames)).orderBy(jobs.name)).toEqual(originalJobs);
      expect(await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1))).toEqual(originalSettings);
      expect(await db.select().from(pipelineStageModes)).toEqual(originalStages);
      expect(await db.select().from(crawlCandidates).orderBy(crawlCandidates.id)).toEqual(originalCandidates);
      expect([...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name = ANY(${jobNames}) ORDER BY name`].map(row => row.value)).toEqual(originalJobRows);
      expect([...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value)).toEqual(originalSettingRows);
      expect([...await admin`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`].map(row => row.value)).toEqual(originalCandidateRows);
    }
  } finally { await Promise.all([admin.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

async function source(cachedReadme = true) {
  const repo = `${prefix}app-${++sequence}`;
  const [{ at }] = await admin`SELECT to_char(date_trunc('milliseconds', clock_timestamp())-interval '2 seconds',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  const fetchedAt = new Date(at);
  const productUrl = `https://pr03b-app-${sequence}.example`;
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt, pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", private: false, fork: false, archived: false,
      pushed_at: fetchedAt.toISOString(), stargazers_count: 3, owner: { type: "User" } },
    pageMeta: { title: "Task tracker", description: "Create projects and manage tasks online",
      textSample: "A deployed application for creating projects and managing tasks.",
      ...(cachedReadme ? { readmeSample: "A deployed task tracker", readmeSampleVersion: README_SAMPLE_VERSION } : {}) },
  }).returning();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt }).returning();
  const settings = fixtureSettings();
  return { candidate, document, settings, input: await loadReviewInput(candidate, document, settings),
    provider: "claude-cli", model: "pr03b-fixture-model" };
}
const tick = () => runJob("crawl-agent-review", reviewCrawlCandidates);
const candidateRow = (id: number) => db.select().from(crawlCandidates).where(eq(crawlCandidates.id, id));
const documentRow = (id: number) => db.select().from(crawlDocuments).where(eq(crawlDocuments.id, id));
const attempts = (id: number) => db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, id)).orderBy(crawlReviewAttempts.id);
const nextJobs = () => db.select().from(jobs).where(inArray(jobs.name, ["second-review", "crawl-publish"])).orderBy(jobs.name);
const approve: ReviewOutcome = { decision: "approve", confidence: 0.99, reason: "A deployed task tracker", evidenceIds: ["product"] };
const owner = { instanceId: "pr03b-independent-item", bootId: "00000000-0000-4000-8000-000000000074" };
type Context = Awaited<ReturnType<typeof source>>;
type Receipt = Exclude<Awaited<ReturnType<typeof claimAgentReview>>, { kind: "skipped" }>["receipt"];

async function current(context: Context) {
  const [candidate] = await candidateRow(context.candidate.id);
  const [document] = await documentRow(context.document.id);
  const [saved] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
  const settings = mergeWithDefaults(saved.values);
  return { candidate, document, settings, input: await loadReviewInput(candidate, document, settings),
    provider: settings.firstReview!.provider, model: settings.firstReview!.model };
}
async function claimItem(context: Context, ttlMs = 60_000) {
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai1'`;
  const claim = await claimItemAgentReview({ ...context, owner, ttlMs });
  expect(claim.kind).not.toBe("skipped");
  if (claim.kind === "skipped") throw new Error(claim.reason);
  expect(claim.receipt.ownership.kind).toBe("item");
  return claim;
}
async function itemContext(ttlMs = 60_000) {
  const context = await source();
  return { context, claim: await claimItem(context, ttlMs) };
}
async function legacyJob(): Promise<JobLease> {
  const lease = { name: "crawl-agent-review", token: randomUUID(), requestedVersion: 17 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, requestedVersion: lease.requestedVersion,
    processedVersion: 4, lockedAt: sql`clock_timestamp()`, cursor: { marker: "pr03b-independent-legacy" } })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: lease.token, requestedVersion: lease.requestedVersion,
      processedVersion: 4, lockedAt: sql`clock_timestamp()`, cursor: { marker: "pr03b-independent-legacy" } } });
  return lease;
}
async function exhaustedSource() {
  const context = await source();
  let latest: Awaited<ReturnType<typeof claimItem>> | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    latest = await claimItem(context);
    expect(latest.kind).toBe("claimed");
    expect(await recordAgentReview({ ...context, receipt: latest.receipt, error: "timeout", retryAfter: new Date(0) }))
      .toEqual({ applied: false, state: "failed" });
  }
  if (!latest || latest.receipt.ownership.kind !== "item") throw new Error("actual exhausted item fixture required");
  expect(await attempts(context.candidate.id)).toHaveLength(3);
  return { context, binding: latest.receipt.ownership.lease.binding };
}
async function actualItem(context: Context) {
  return (await db.select().from(pipelineItemLeases).where(sql`${pipelineItemLeases.stage}='ai1'
    AND ${pipelineItemLeases.workKey}=${`ai1:${context.candidate.id}`}`))[0];
}
async function snapshot(context: Context) {
  return { candidate: await candidateRow(context.candidate.id), document: await documentRow(context.document.id),
    attempts: await attempts(context.candidate.id), item: await actualItem(context), jobs: await nextJobs() };
}
async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [state] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`;
    if (state.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`AI1 writer did not enter actual lock wait behind ${pid}`);
}

it("runs a normal legacy control through the actual README, claim, model and result paths", async () => {
  const context = await source(false);
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(transport.readme).toHaveBeenCalledExactlyOnceWith(context.candidate.repo);
  expect(transport.cli).toHaveBeenCalledOnce();
  expect(transport.gateway).not.toHaveBeenCalled();
  expect(transport.grok).not.toHaveBeenCalled();
  expect(await attempts(context.candidate.id)).toMatchObject([{ state: "succeeded", provider: "claude-cli" }]);
  expect(await nextJobs()).toMatchObject([{ name: "crawl-publish", requestedVersion: 1 }]);
});

it.each(["items", "draining"] as const)("legacy admission in %s performs no README HTTP, model or domain writes", async mode => {
  const context = await source(false);
  const beforeJobs = await nextJobs();
  await admin`UPDATE pipeline_stage_modes SET mode=${mode},draining_from=${mode === "draining" ? "legacy" : null},
    writer_contract_version=1 WHERE stage='ai1'`;
  expect(await tick()).toMatchObject({ status: "deferred", reason: "stage_blocked" });
  expect.soft(transport.readme).not.toHaveBeenCalled();
  for (const mock of [transport.cli, transport.gateway, transport.grok]) expect.soft(mock).not.toHaveBeenCalled();
  expect.soft(await candidateRow(context.candidate.id)).toEqual([context.candidate]);
  expect.soft(await documentRow(context.document.id)).toEqual([context.document]);
  expect.soft(await attempts(context.candidate.id)).toEqual([]);
  expect(await nextJobs()).toEqual(beforeJobs);
});

it("preserves a healthy foreign actual item and its running attempt after a legacy job takeover", async () => {
  const context = await source();
  const claim = await claimItem(context);
  const beforeAttempt = await attempts(context.candidate.id);
  const beforeItem = await actualItem(context);
  // A scheduler/job mode change does not grant ownership of a healthy item or
  // prove that the external operation represented by its running row ended.
  await admin`UPDATE pipeline_stage_modes SET mode='legacy' WHERE stage='ai1'`;
  const beforeJobs = await nextJobs();
  expect(await tick()).toMatchObject({ status: "completed" });
  for (const mock of [transport.readme, transport.cli, transport.gateway, transport.grok]) expect.soft(mock).not.toHaveBeenCalled();
  expect.soft(await attempts(context.candidate.id)).toEqual(beforeAttempt);
  expect.soft(await actualItem(context)).toEqual(beforeItem);
  expect(claim.attempt.id).toBe(claim.receipt.attemptId);
  expect.soft(await candidateRow(context.candidate.id)).toEqual([context.candidate]);
  expect(await nextJobs()).toEqual(beforeJobs);
});

it("binds a fresh actual attempt and its input to the item token without requiring a legacy job", async () => {
  const context = await source();
  const beforeJobs = await db.select().from(jobs).where(eq(jobs.name, "crawl-agent-review"));
  expect(beforeJobs).toEqual([]);
  const claim = await claimItem(context);
  expect(claim).toMatchObject({ kind: "claimed", receipt: { attemptId: claim.attempt.id, origin: "fresh", ownership: { kind: "item" } } });
  const item = await actualItem(context);
  expect(item).toMatchObject({ workKey: `ai1:${context.candidate.id}`, ownerInstanceId: owner.instanceId, ownerBootId: owner.bootId,
    binding: { stage: "ai1", candidateId: context.candidate.id, inputHash: context.input.inputHash,
      sourceRevisionHash: context.input.sourceRevisionHash, policyHash: context.input.policyHash,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
      reviewer: { provider: context.provider, model: context.model } } });
  expect(claim.attempt).toMatchObject({ candidateId: context.candidate.id, state: "running", leaseToken: item.token,
    inputHash: context.input.inputHash, sourceRevisionHash: context.input.sourceRevisionHash, policyHash: context.input.policyHash });
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-agent-review"))).toEqual(beforeJobs);
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve })).toEqual({ applied: true, state: "succeeded" });
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null, ownerInstanceId: null });
  expect(await nextJobs()).toMatchObject([{ name: "crawl-publish", requestedVersion: 1 }]);
});

it("gives two independent item owners one actual running attempt and one logical winner", async () => {
  const context = await source();
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai1'`;
  const claims = await Promise.all([owner, { instanceId: "pr03b-independent-competitor",
    bootId: "00000000-0000-4000-8000-000000000075" }].map(claimedBy =>
    claimItemAgentReview({ ...context, owner: claimedBy, ttlMs: 60_000 })));
  expect(claims.filter(claim => claim.kind === "claimed")).toHaveLength(1);
  expect(claims.filter(claim => claim.kind === "skipped")).toHaveLength(1);
  const rows = await attempts(context.candidate.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "running", leaseToken: (await actualItem(context)).token });
  expect(await nextJobs()).toEqual([]);
});

it("preserves the historical token and outcome when directly reusing a successful attempt", async () => {
  const { context, claim } = await itemContext();
  await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve, usage: { inputTokens: 8, outputTokens: 2 } });
  const previous = (await attempts(context.candidate.id))[0], beforeJobs = await nextJobs();
  const next = await current(context), reuse = await claimItem(next);
  expect(reuse).toMatchObject({ kind: "reused", receipt: { origin: "direct_reuse", attemptId: previous.id } });
  expect(reuse.attempt.id).toBe(previous.id);
  expect((await actualItem(context)).token).not.toBe(previous.leaseToken);
  await recordAgentReview({ ...next, receipt: reuse.receipt, outcome: { ...approve, decision: "reject" } });
  expect(await attempts(context.candidate.id)).toEqual([previous]);
  expect(await nextJobs()).toEqual(beforeJobs);
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
});

it("creates a new semantic-reuse attempt and item token without rewriting the successful source history", async () => {
  const { context, claim } = await itemContext();
  await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve });
  const previous = (await attempts(context.candidate.id))[0];
  await db.update(crawlDocuments).set({ fetchedAt: sql`clock_timestamp()-interval '1 second'` })
    .where(eq(crawlDocuments.id, context.document.id));
  const next = await current(context);
  expect(next.input.inputHash).toBe(context.input.inputHash);
  expect(next.input.sourceRevisionHash).not.toBe(context.input.sourceRevisionHash);
  const reuse = await claimItem(next);
  expect(reuse).toMatchObject({ kind: "reused", receipt: { origin: "semantic_reuse", attemptId: reuse.attempt.id },
    attempt: { state: "running", reusedFromAttemptId: previous.id, outcome: approve } });
  expect(reuse.attempt.id).not.toBe(previous.id);
  expect(reuse.attempt.leaseToken).toBe((await actualItem(context)).token);
  expect(reuse.attempt.leaseToken).not.toBe(previous.leaseToken);
  await recordAgentReview({ ...next, receipt: reuse.receipt });
  expect((await attempts(context.candidate.id)).find(row => row.id === previous.id)).toEqual(previous);
  expect((await attempts(context.candidate.id)).find(row => row.id === reuse.attempt.id))
    .toMatchObject({ state: "succeeded", sourceRevisionHash: next.input.sourceRevisionHash, leaseToken: reuse.attempt.leaseToken });
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
});

it("keeps a live logical item busy when its actual source binding changes", async () => {
  const { context } = await itemContext();
  const before = await snapshot(context);
  await db.update(crawlDocuments).set({ pageMeta: { ...context.document.pageMeta, textSample: "A different application and product body" } })
    .where(eq(crawlDocuments.id, context.document.id));
  const next = await current(context);
  expect(next.input.inputHash).not.toBe(context.input.inputHash);
  expect(await claimItemAgentReview({ ...next, owner: { ...owner, bootId: "00000000-0000-4000-8000-000000000075" }, ttlMs: 60_000 }))
    .toMatchObject({ kind: "skipped" });
  expect(await attempts(context.candidate.id)).toEqual(before.attempts);
  expect(await actualItem(context)).toEqual(before.item);
  expect(await nextJobs()).toEqual(before.jobs);
});

it.each(["attempt", "direct_origin", "semantic_origin", "binding", "owner", "token", "stage_epoch", "item_epoch"] as const)(
  "rejects a forged %s receipt and preserves actual result, ownership and outbox rows", async change => {
    const { context, claim } = await itemContext();
    const receipt = claim.receipt;
    if (receipt.ownership.kind !== "item") throw new Error("actual item fixture required");
    const lease = receipt.ownership.lease;
    const badBinding = { ...lease.binding, policyHash: "f".repeat(64) };
    const forged: Receipt = change === "attempt" ? { ...receipt, attemptId: claim.attempt.id + 1_000_000 }
      : change === "direct_origin" ? { ...receipt, origin: "direct_reuse" }
      : change === "semantic_origin" ? { ...receipt, origin: "semantic_reuse" }
      : { ...receipt, ownership: { kind: "item", lease: { ...lease,
        ...(change === "binding" ? { binding: badBinding, bindingHash: itemBindingHash(badBinding) } : {}),
        ...(change === "owner" ? { owner: { ...lease.owner, bootId: "00000000-0000-4000-8000-000000000075" } } : {}),
        ...(change === "token" ? { token: randomUUID() } : {}),
        ...(change === "stage_epoch" ? { stageEpoch: lease.stageEpoch + 1 } : {}),
        ...(change === "item_epoch" ? { itemEpoch: lease.itemEpoch + 1 } : {}),
      } } };
    const before = await snapshot(context);
    await expect(recordAgentReview({ ...context, receipt: forged, outcome: approve })).rejects.toThrow();
    expect(await snapshot(context)).toEqual(before);
  });

it.each(["success", "failure"] as const)("rejects an expired item's %s without result, release or request writes", async kind => {
  const { context, claim } = await itemContext();
  await admin`UPDATE pipeline_item_leases SET lease_until=clock_timestamp()-interval '1 second'
    WHERE stage='ai1' AND work_key=${`ai1:${context.candidate.id}`}`;
  const before = await snapshot(context);
  await expect(recordAgentReview({ ...context, receipt: claim.receipt,
    ...(kind === "success" ? { outcome: approve } : { error: "timeout", retryAfter: new Date(0) }) })).rejects.toThrow();
  expect(await snapshot(context)).toEqual(before);
});

it.each(["source", "human"] as const)("preserves a live token through in-flight %s invalidation and settles only the owned cleanup", async change => {
  const { context, claim } = await itemContext();
  const beforeItem = await actualItem(context), beforeJobs = await nextJobs();
  if (change === "source") await db.update(crawlDocuments).set({ pageMeta: { ...context.document.pageMeta, textSample: "Changed current product body" } })
    .where(eq(crawlDocuments.id, context.document.id));
  else await db.update(crawlCandidates).set({ decidedBy: "admin", state: "rejected", reason: "not_a_product" })
    .where(eq(crawlCandidates.id, context.candidate.id));
  const currentCandidate = await candidateRow(context.candidate.id), currentDocument = await documentRow(context.document.id);
  expect(await actualItem(context)).toEqual(beforeItem);
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve }))
    .toEqual({ applied: false, state: "superseded" });
  expect(await candidateRow(context.candidate.id)).toEqual(currentCandidate);
  expect(await documentRow(context.document.id)).toEqual(currentDocument);
  expect(await attempts(context.candidate.id)).toMatchObject([{ id: claim.attempt.id, state: "superseded", errorCode: "input_changed" }]);
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
  expect(await nextJobs()).toEqual(beforeJobs);
});

it("settles an invalidated policy without applying its old outcome or prematurely reclaiming its live token", async () => {
  const { context, claim } = await itemContext();
  const beforeItem = await actualItem(context), beforeCandidate = await candidateRow(context.candidate.id), beforeJobs = await nextJobs();
  const changed = { ...context.settings, agentEvidence: { ...context.settings.agentEvidence,
    policyVersion: `${context.settings.agentEvidence.policyVersion}-changed` } };
  await db.update(crawlSettings).set({ values: changed }).where(eq(crawlSettings.id, 1));
  expect((await current(context)).input.policyHash).not.toBe(context.input.policyHash);
  expect(await actualItem(context)).toEqual(beforeItem);
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve }))
    .toEqual({ applied: false, state: "superseded" });
  expect(await candidateRow(context.candidate.id)).toEqual(beforeCandidate);
  expect(await attempts(context.candidate.id)).toMatchObject([{ id: claim.attempt.id, state: "superseded", errorCode: "input_changed" }]);
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
  expect(await nextJobs()).toEqual(beforeJobs);
});

it("rejects another candidate's existing attempt ID without touching either actual item", async () => {
  const first = await itemContext(), second = await itemContext();
  const firstBefore = await snapshot(first.context), secondBefore = await snapshot(second.context);
  await expect(recordAgentReview({ ...first.context, receipt: { ...first.claim.receipt, attemptId: second.claim.attempt.id },
    outcome: approve })).rejects.toThrow();
  expect(await snapshot(first.context)).toEqual(firstBefore);
  expect(await snapshot(second.context)).toEqual(secondBefore);
});

it("accepts the original receipt after an actual heartbeat extends the same item token", async () => {
  const { context, claim } = await itemContext();
  if (claim.receipt.ownership.kind !== "item") throw new Error("actual item fixture required");
  const lease = claim.receipt.ownership.lease;
  const renewed = await db.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, "ai1"), lease, 120_000));
  expect(renewed?.token).toBe(lease.token);
  expect(renewed!.leaseUntil.getTime()).toBeGreaterThan(lease.leaseUntil.getTime());
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve })).toEqual({ applied: true, state: "succeeded" });
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
});

it("rolls the actual attempt, candidate and item release back when its downstream outbox request fails", async () => {
  const { context, claim } = await itemContext();
  const before = await snapshot(context);
  await admin`CREATE FUNCTION pr03b_ai1_request_failure() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN IF NEW.name = ''crawl-publish'' THEN RAISE EXCEPTION ''pr03b_ai1_request_failure''; END IF; RETURN NEW; END'`;
  await admin`CREATE TRIGGER pr03b_ai1_request_failure BEFORE INSERT OR UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION pr03b_ai1_request_failure()`;
  await expect(recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve })).rejects.toThrow();
  expect(await snapshot(context)).toEqual(before);
  await admin`DROP TRIGGER pr03b_ai1_request_failure ON jobs`;
  await admin`DROP FUNCTION pr03b_ai1_request_failure()`;
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve })).toEqual({ applied: true, state: "succeeded" });
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
  expect(await nextJobs()).toMatchObject([{ name: "crawl-publish", requestedVersion: 1 }]);
  const committed = await snapshot(context);
  // Rejected duplicate authority and explicit idempotent success are both safe;
  // either contract must leave the already committed domain and outbox exact.
  await Promise.allSettled([recordAgentReview({ ...await current(context), receipt: claim.receipt, outcome: approve })]);
  expect(await snapshot(context)).toEqual(committed);
});

it("rechecks actual item expiry after a downstream job wait and rolls the entire result back", async () => {
  const { context, claim } = await itemContext(1_000);
  if (claim.receipt.ownership.kind !== "item") throw new Error("actual item fixture required");
  const until = claim.receipt.ownership.lease.leaseUntil;
  await db.insert(jobs).values({ name: "crawl-publish", requestedVersion: 11, processedVersion: 4,
    cursor: { marker: "pr03b-item-outbox" }, notBefore: new Date("2101-01-01T00:00:00.000Z") });
  const before = await snapshot(context);
  let settled: Promise<unknown> | undefined;
  try {
    await admin.begin(async blocker => {
      const [{ pid }] = await blocker`SELECT pg_backend_pid() AS pid`;
      await blocker`SELECT name FROM jobs WHERE name='crawl-publish' FOR UPDATE`;
      settled = expect(recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve })).rejects.toThrow();
      void settled.catch(() => {});
      await waitForBlockedBy(pid);
      const deadline = Date.now() + 3_000;
      let expired = false;
      while (Date.now() < deadline) {
        const [clock] = await observer`SELECT clock_timestamp() >= ${until} AS expired`;
        if (clock.expired) { expired = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(expired).toBe(true);
    });
  } finally { if (settled) await settled; }
  expect(await snapshot(context)).toEqual(before);
});

it("keeps the inactive item adapter closed in default legacy and contract-zero item modes", async () => {
  const context = await source(), before = await snapshot(context);
  expect(await claimItemAgentReview({ ...context, owner, ttlMs: 60_000 })).toMatchObject({ kind: "skipped" });
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=0 WHERE stage='ai1'`;
  expect(await claimItemAgentReview({ ...context, owner, ttlMs: 60_000 })).toMatchObject({ kind: "skipped" });
  expect(await snapshot(context)).toEqual(before);
});

it("allows an admitted item to settle during drain while rejecting another claim", async () => {
  const { context, claim } = await itemContext();
  await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items' WHERE stage='ai1'`;
  const before = await snapshot(context);
  expect(await claimItemAgentReview({ ...context, owner, ttlMs: 60_000 })).toMatchObject({ kind: "skipped" });
  expect(await snapshot(context)).toEqual(before);
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve })).toEqual({ applied: true, state: "succeeded" });
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
  expect(await nextJobs()).toMatchObject([{ name: "crawl-publish", requestedVersion: 1 }]);
});

it("rejects an old item receipt after the actual stage epoch changes", async () => {
  const { context, claim } = await itemContext();
  // A fixture-only administrative epoch change represents a completed transition;
  // it cannot turn the previous epoch's result authority into current authority.
  await admin`UPDATE pipeline_stage_modes SET epoch=epoch+1 WHERE stage='ai1'`;
  const before = await snapshot(context);
  await expect(recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve })).rejects.toThrow();
  expect(await snapshot(context)).toEqual(before);
});

it.each(["success", "failure"] as const)("preserves the new item owner when the expired owner's late %s arrives", async kind => {
  const { context, claim } = await itemContext();
  await admin`UPDATE pipeline_item_leases SET lease_until=clock_timestamp()-interval '1 second'
    WHERE stage='ai1' AND work_key=${`ai1:${context.candidate.id}`}`;
  const replacement = await claimItemAgentReview({ ...context, owner: { ...owner,
    bootId: "00000000-0000-4000-8000-000000000075" }, ttlMs: 60_000 });
  expect(replacement.kind).toBe("claimed");
  if (replacement.kind === "skipped") throw new Error(replacement.reason);
  expect(replacement.attempt.id).not.toBe(claim.attempt.id);
  const before = await snapshot(context);
  expect(before.attempts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: claim.attempt.id, state: "superseded", errorCode: "owner_changed" }),
    expect.objectContaining({ id: replacement.attempt.id, state: "running", leaseToken: before.item.token }),
  ]));
  await expect(recordAgentReview({ ...context, receipt: claim.receipt,
    ...(kind === "success" ? { outcome: approve } : { error: "timeout" }) })).rejects.toThrow();
  expect(await snapshot(context)).toEqual(before);
});

it.each(["success", "failure"] as const)("rejects an actual legacy job takeover's late %s without domain or outbox writes", async kind => {
  const context = await source(), lease = await legacyJob();
  const claim = await claimAgentReview({ ...context, lease });
  expect(claim.kind).toBe("claimed");
  if (claim.kind === "skipped") throw new Error(claim.reason);
  expect(claim.receipt).toMatchObject({ origin: "fresh", ownership: { kind: "legacy", job: lease } });
  await db.update(jobs).set({ leaseToken: randomUUID(), lockedAt: sql`clock_timestamp()` }).where(eq(jobs.name, lease.name));
  const before = await snapshot(context), beforeJob = await db.select().from(jobs).where(eq(jobs.name, lease.name));
  await expect(recordAgentReview({ ...context, receipt: claim.receipt,
    ...(kind === "success" ? { outcome: approve } : { error: "timeout" }) })).rejects.toThrow();
  expect(await snapshot(context)).toEqual(before);
  expect(await db.select().from(jobs).where(eq(jobs.name, lease.name))).toEqual(beforeJob);
});

it("settles a semantic-reuse attempt when the actual handler loses budget immediately after claim", async () => {
  const context = await source(), lease = await legacyJob();
  const initial = await claimAgentReview({ ...context, lease });
  if (initial.kind === "skipped") throw new Error(initial.reason);
  await recordAgentReview({ ...context, receipt: initial.receipt, outcome: approve });
  const previous = (await attempts(context.candidate.id))[0], beforeJobs = await nextJobs();
  await db.update(crawlDocuments).set({ fetchedAt: sql`clock_timestamp()-interval '1 second'` })
    .where(eq(crawlDocuments.id, context.document.id));
  const next = await current(context);
  expect(next.input.inputHash).toBe(context.input.inputHash);
  expect(next.input.sourceRevisionHash).not.toBe(context.input.sourceRevisionHash);
  await db.update(jobs).set({ lockedAt: null, leaseToken: null }).where(eq(jobs.name, lease.name));
  await admin.unsafe(`CREATE FUNCTION pr03b_ai1_semantic_barrier() RETURNS trigger LANGUAGE plpgsql AS
    'BEGIN IF NEW.candidate_id = ${context.candidate.id} AND NEW.reused_from_attempt_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(1485805, NEW.candidate_id); END IF; RETURN NEW; END'`);
  await admin`CREATE TRIGGER pr03b_ai1_semantic_barrier BEFORE INSERT ON crawl_review_attempts
    FOR EACH ROW EXECUTE FUNCTION pr03b_ai1_semantic_barrier()`;
  let allowed = true, running: ReturnType<typeof tick> | undefined;
  try {
    await admin.begin(async blocker => {
      const [{ pid }] = await blocker`SELECT pg_backend_pid() AS pid`;
      await blocker`SELECT pg_advisory_xact_lock(1485805, ${context.candidate.id})`;
      running = runJob<null>("crawl-agent-review", ctx => reviewCrawlCandidates({ ...ctx,
        hasBudget: () => allowed && ctx.hasBudget() }));
      void running.catch(() => {});
      await waitForBlockedBy(pid);
      allowed = false;
    });
  } finally { if (running) expect(await running).toMatchObject({ status: "completed" }); }
  const rows = await attempts(context.candidate.id);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.id === previous.id)).toEqual(previous);
  expect(rows.find(row => row.id !== previous.id)).toMatchObject({ state: "failed", errorCode: "cancelled",
    reusedFromAttemptId: previous.id, sourceRevisionHash: next.input.sourceRevisionHash, completedAt: expect.any(Date) });
  for (const mock of [transport.readme, transport.cli, transport.gateway, transport.grok]) expect(mock).not.toHaveBeenCalled();
  expect(await nextJobs()).toEqual(beforeJobs);
});

it("preserves a healthy foreign logical item during exhausted-first-review handoff and hands off only after expiry", async () => {
  const { context, binding } = await exhaustedSource();
  // The actual result APIs produced the exhausted history. A separate generic
  // logical lease fixture represents another admitted operation on that work.
  const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "ai1"), binding, owner, 60_000));
  expect(lease).not.toBeNull();
  await admin`UPDATE pipeline_stage_modes SET mode='legacy' WHERE stage='ai1'`;
  const job = await legacyJob(), before = await snapshot(context);
  expect(await handOffExhaustedFirstReviews(context.settings, job)).toBe(0);
  expect(await snapshot(context)).toEqual(before);
  await admin`UPDATE pipeline_item_leases SET lease_until=clock_timestamp()-interval '1 second'
    WHERE stage='ai1' AND work_key=${`ai1:${context.candidate.id}`}`;
  expect(await handOffExhaustedFirstReviews(context.settings, job)).toBe(1);
  expect(await candidateRow(context.candidate.id)).toMatchObject([{ state: "needs_review", reason: "ai_review_exhausted" }]);
  expect(await attempts(context.candidate.id)).toEqual(before.attempts);
  expect(await nextJobs()).toEqual(before.jobs);
});

it("rolls exhausted-first-review handoff back after the actual job token is replaced", async () => {
  const { context } = await exhaustedSource();
  await admin`UPDATE pipeline_stage_modes SET mode='legacy' WHERE stage='ai1'`;
  const job = await legacyJob();
  await db.update(jobs).set({ leaseToken: randomUUID(), lockedAt: sql`clock_timestamp()` }).where(eq(jobs.name, job.name));
  const before = await snapshot(context), beforeJob = await db.select().from(jobs).where(eq(jobs.name, job.name));
  await expect(handOffExhaustedFirstReviews(context.settings, job)).rejects.toThrow();
  expect(await snapshot(context)).toEqual(before);
  expect(await db.select().from(jobs).where(eq(jobs.name, job.name))).toEqual(beforeJob);
});

it.each(["items", "draining"] as const)("requeues stale source in %s without settling the admitted AI1 operation", async mode => {
  const { context, claim } = await itemContext();
  await admin`UPDATE pipeline_stage_modes SET mode=${mode},draining_from=${mode === "draining" ? "items" : null} WHERE stage='ai1'`;
  await db.update(crawlDocuments).set({ fetchedAt: sql`clock_timestamp()-interval '2 days'` })
    .where(eq(crawlDocuments.id, context.document.id));
  const lease = await legacyJob(), before = await snapshot(context);
  expect(await requeueStaleReviewSources(context.settings, lease)).toBe(1);
  expect(await candidateRow(context.candidate.id)).toEqual(before.candidate);
  expect(await attempts(context.candidate.id)).toEqual(before.attempts);
  expect(await actualItem(context)).toEqual(before.item);
  expect(await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, context.candidate.repo)))
    .toMatchObject([{ state: "pending", signal: "review-source-refresh" }]);
  const fetchRequest = await db.select().from(jobs).where(eq(jobs.name, "crawl-fetch"));
  expect(fetchRequest).toMatchObject([{ requestedVersion: 1 }]);
  // Only delivery of the settled external result consumes this healthy authority.
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve }))
    .toEqual({ applied: false, state: "superseded" });
  expect(await actualItem(context)).toMatchObject({ token: null, leaseUntil: null });
  expect(await nextJobs()).toEqual(before.jobs);
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-fetch"))).toEqual(fetchRequest);
});
