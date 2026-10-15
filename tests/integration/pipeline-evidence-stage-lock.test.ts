import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryScans, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings,
  jobs, pipelineItemLeases, pipelineStageModes, products } from "@/lib/db/schema";
import { saveRepositoryAgentScan } from "@/lib/domain/evidence/agents/repository";
import type { CollectResult } from "@/lib/domain/evidence/agents/collect";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { agentReviewBinding } from "@/lib/crawl/agent-review-ownership";
import { itemBindingHash } from "@/lib/jobs/items/types";
import { refreshAgentEvidenceJob, type AgentEvidenceRefreshCursor } from "@/lib/jobs/products/agent-evidence-refresh";
import type { JobLease } from "@/lib/jobs/control";
import type { JobContext } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const spies = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/lib/domain/evidence/agents/repository", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/domain/evidence/agents/repository")>();
  spies.refresh.mockImplementation(original.refreshRepositoryAgentEvidence);
  return { ...original, refreshRepositoryAgentEvidence: spies.refresh };
});
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03c-evidence-stage-blocker", statement_timeout: 8_000 } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03c-evidence-stage-observer", statement_timeout: 8_000 } });
const repo = "pr03c-evidence-stage/app", names = ["agent-evidence-refresh", "crawl-judge"];
let originalSettings: unknown[] = [];
let originalJobs: unknown[] = [];
let originalStages: (typeof pipelineStageModes.$inferSelect)[] = [];
let originalCandidates: (typeof crawlCandidates.$inferSelect)[] = [];
let originalProducts: (typeof products.$inferSelect)[] = [];
let originalCandidateRows: unknown[] = [];
let originalProductRows: unknown[] = [];
let initialized = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("evidence_stage_lock_barrier_timeout");
}
async function clean() {
  await db.delete(pipelineItemLeases).where(eq(pipelineItemLeases.ownerInstanceId, "pr03c-evidence-live-owner"));
  await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  await db.delete(crawlDocuments).where(eq(crawlDocuments.repo, repo));
  await db.delete(agentRepositoryScans).where(eq(agentRepositoryScans.repositoryKey, repo));
  await db.delete(jobs).where(inArray(jobs.name, names));
}
function scanResult(): CollectResult {
  return { repositoryId: "903010", repositoryKey: repo, commitSha: "c".repeat(40), scope: "",
    state: "complete", cursor: null, observations: [], requestCount: 2, fileCount: 0, errorCode: null, retryAt: null };
}
async function lease(): Promise<JobLease> {
  const token = randomUUID();
  const [row] = await db.insert(jobs).values({ name: "agent-evidence-refresh", requestedVersion: 1,
    leaseToken: token, lockedAt: sql`clock_timestamp()` }).returning();
  return { name: row.name, token, requestedVersion: row.requestedVersion };
}
function context(job: JobLease): JobContext<AgentEvidenceRefreshCursor> {
  return { cursor: null, lease: job, hasBudget: () => true, save: async () => {}, log: () => {} };
}
async function pendingCandidate() {
  const [row] = await db.insert(crawlCandidates).values({ repo, state: "needs_review",
    reason: "ai_evidence_pending", decidedBy: "auto" }).returning();
  return row;
}
async function freshScan() {
  return (await saveRepositoryAgentScan(scanResult(), new Date(Date.now() - 1_000)))!;
}
const noNetwork = async (): Promise<never> => { throw new Error("unexpected_evidence_network"); };

beforeAll(async () => {
  ensureSchema();
  originalSettings = [...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(s) AS value FROM crawl_settings s ORDER BY id`)].map(row => row.value);
  originalJobs = [...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(j) AS value FROM jobs j WHERE name IN ('agent-evidence-refresh','crawl-judge') ORDER BY name`)].map(row => row.value);
  originalStages = await db.select().from(pipelineStageModes);
  originalCandidates = await db.select().from(crawlCandidates).orderBy(crawlCandidates.id);
  originalProducts = await db.select().from(products).orderBy(products.id);
  originalCandidateRows = [...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`)].map(row => row.value);
  originalProductRows = [...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(p) AS value FROM products p ORDER BY id`)].map(row => row.value);
  initialized = true;
  // The real collector/recovery sweeps a global universe. Suspend only the
  // pre-existing demand for this file, then restore every original column.
  if (originalCandidates.length) await db.update(crawlCandidates).set({ state: "rejected", decidedBy: "admin" })
    .where(inArray(crawlCandidates.id, originalCandidates.map(row => row.id)));
  if (originalProducts.length) await db.update(products).set({ status: "banned" })
    .where(inArray(products.id, originalProducts.map(row => row.id)));
});
beforeEach(async () => {
  await clean();
  await db.update(pipelineStageModes).set({ mode: "legacy", drainingFrom: null, epoch: 1, writerContractVersion: 0 });
  const values = { ...DEFAULT_CRAWL_SETTINGS, enabled: false,
    agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true } };
  await db.insert(crawlSettings).values({ id: 1, values }).onConflictDoUpdate({ target: crawlSettings.id, set: { values } });
  spies.refresh.mockClear();
});
afterAll(async () => {
  try {
    if (!initialized) return;
    await clean();
    // Native JSON retains PostgreSQL microseconds in pre-existing timestamps.
    if (originalJobs.length) await db.execute(sql`INSERT INTO jobs SELECT * FROM
      jsonb_populate_recordset(NULL::jobs, ${JSON.stringify(originalJobs)}::text::jsonb)`);
    await db.delete(crawlSettings);
    if (originalSettings.length) await db.execute(sql`INSERT INTO crawl_settings SELECT * FROM
      jsonb_populate_recordset(NULL::crawl_settings, ${JSON.stringify(originalSettings)}::text::jsonb)`);
    for (const row of originalStages) await db.update(pipelineStageModes).set(row).where(eq(pipelineStageModes.stage, row.stage));
    for (const row of originalCandidates) await db.update(crawlCandidates).set({ state: row.state, decidedBy: row.decidedBy })
      .where(eq(crawlCandidates.id, row.id));
    // A product's search_vector is generated. Restore only the suspended input
    // column and verify all columns, including generated data and raw timestamps.
    for (const row of originalProducts) await db.update(products).set({ status: row.status }).where(eq(products.id, row.id));
    expect([...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`)].map(row => row.value)).toEqual(originalCandidateRows);
    expect([...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(p) AS value FROM products p ORDER BY id`)].map(row => row.value)).toEqual(originalProductRows);
    expect([...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(j) AS value FROM jobs j WHERE name IN ('agent-evidence-refresh','crawl-judge') ORDER BY name`)].map(row => row.value)).toEqual(originalJobs);
    expect([...await db.execute<{ value: unknown }>(sql`SELECT to_jsonb(s) AS value FROM crawl_settings s ORDER BY id`)].map(row => row.value)).toEqual(originalSettings);
    expect(await db.select().from(agentRepositoryScans).where(like(agentRepositoryScans.repositoryKey, "pr03c-evidence-stage/%"))).toHaveLength(0);
  } finally { await Promise.all([blocker.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

/** The actual controller must block at stage SHARE while its domain remains available. */
async function behindStage(stage: "fetch" | "ai1" | "ai2", action: () => Promise<unknown>, domainAvailable: () => Promise<void>) {
  const locked = deferred<number>(), release = deferred<void>();
  const holding = blocker.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM pipeline_stage_modes WHERE stage=${stage} FOR UPDATE`;
    locked.resolve(row.pid);
    await release.promise;
  });
  let outcome: Promise<{ value: unknown } | { error: unknown }> | undefined;
  try {
    const pid = await locked.promise;
    let settled = false;
    outcome = action().then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    const state = await waitFor(async () => {
      if (settled) return "completed";
      const [wait] = await observer`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND query LIKE '%pipeline_stage_modes%'
          AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
      return wait.blocked ? "blocked" : undefined;
    });
    expect(state).toBe("blocked");
    await domainAvailable();
  } finally {
    release.resolve();
    await holding;
    if (outcome) { const result = await outcome; if ("error" in result) throw result.error; }
  }
}
async function candidateAvailable() {
  await observer.begin(async tx => { await tx`SELECT id FROM crawl_candidates WHERE repo=${repo} FOR UPDATE NOWAIT`; });
}
async function afterJobWaitExpiry(job: JobLease, lockName: string, action: () => Promise<unknown>) {
  await observer`UPDATE jobs SET locked_at=clock_timestamp()-interval '89 seconds' WHERE name=${job.name}`;
  const locked = deferred<number>(), release = deferred<void>();
  const holding = blocker.begin(async tx => {
    const [row] = await tx`SELECT pg_backend_pid() AS pid FROM jobs WHERE name=${lockName} FOR UPDATE`;
    locked.resolve(row.pid);
    await release.promise;
  });
  let outcome: Promise<{ value: unknown } | { error: unknown }> | undefined;
  try {
    const pid = await locked.promise;
    let settled = false;
    outcome = action().then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    const state = await waitFor(async () => {
      if (settled) return "completed";
      const [wait] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
      return wait.blocked ? "blocked" : undefined;
    });
    expect(state).toBe("blocked");
    await waitFor(async () => {
      const [clock] = await observer`SELECT locked_at < clock_timestamp()-interval '90 seconds' AS expired
        FROM jobs WHERE name=${job.name}`;
      return clock.expired ? true : undefined;
    });
  } finally {
    release.resolve();
    await holding;
    if (outcome) await outcome;
  }
  return await outcome!;
}

it.each(["legacy", "items", "draining"] as const)("persists evidence independently of stage mode %s", async mode => {
  await db.update(pipelineStageModes).set({ mode, drainingFrom: mode === "draining" ? "legacy" : null });
  expect(await saveRepositoryAgentScan(scanResult(), new Date(), await lease())).toMatchObject({ repositoryKey: repo, state: "complete" });
});
it.each(["fetch", "ai1", "ai2"] as const)("locks %s before the evidence identity and scan row", async stage => {
  const scan = await freshScan(), job = await lease();
  await behindStage(stage, () => saveRepositoryAgentScan(scanResult(), new Date(), job), async () => {
    await observer.begin(async tx => {
      const [identity] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify(["agent-evidence", repo, ""])},0)) AS free`;
      expect(identity.free).toBe(true);
      await tx`SELECT id FROM agent_repository_scans WHERE id=${scan.id} FOR UPDATE NOWAIT`;
    });
  });
});
it("locks stages before the periodic evidence-pending recovery", async () => {
  await freshScan();
  await pendingCandidate();
  const job = await lease();
  await behindStage("ai1", () => refreshAgentEvidenceJob(context(job), { request: noNetwork }), candidateAvailable);
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo))).toMatchObject([{ state: "new" }]);
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toMatchObject([{ requestedVersion: 1 }]);
});
it("locks stages before a cached completion directly reopens a candidate", async () => {
  const scan = await freshScan();
  await db.update(agentRepositoryScans).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(agentRepositoryScans.id, scan.id));
  await pendingCandidate();
  const job = await lease();
  // Cache may be refreshed by another collector after demand selection. Keep the
  // controller and actual DB writes real while choosing this existing branch.
  spies.refresh.mockResolvedValueOnce({ scan, observations: [], cached: true, errorCode: null, retryAt: scan.nextAttemptAt });
  await behindStage("ai2", () => refreshAgentEvidenceJob(context(job), { request: noNetwork }), candidateAvailable);
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo))).toMatchObject([{ state: "new" }]);
});
it("normally recovers a confirmed pending candidate and requests judgement atomically", async () => {
  await freshScan();
  await pendingCandidate();
  await refreshAgentEvidenceJob(context(await lease()), { request: noNetwork });
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo))).toMatchObject([{ state: "new", decidedBy: "auto" }]);
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toMatchObject([{ requestedVersion: 1 }]);
});
it("requests judgement for the actual rows reopened by a direct completion", async () => {
  const scan = await freshScan();
  await db.update(agentRepositoryScans).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(agentRepositoryScans.id, scan.id));
  await pendingCandidate();
  spies.refresh.mockResolvedValueOnce({ scan, observations: [], cached: true, errorCode: null, retryAt: scan.nextAttemptAt });
  await refreshAgentEvidenceJob(context(await lease()), { request: noNetwork });
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo))).toMatchObject([{ state: "new" }]);
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toMatchObject([{ requestedVersion: 1 }]);
});
it("rolls a direct reopen back when its judgement request fails", async () => {
  const scan = await freshScan();
  await db.update(agentRepositoryScans).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(agentRepositoryScans.id, scan.id));
  await pendingCandidate();
  const job = await lease();
  spies.refresh.mockResolvedValueOnce({ scan, observations: [], cached: true, errorCode: null, retryAt: scan.nextAttemptAt });
  await observer`CREATE FUNCTION public.pr03c_evidence_request_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name='crawl-judge' THEN RAISE EXCEPTION 'pr03c_evidence_request_failed'; END IF; RETURN NEW; END $$`;
  await observer`CREATE TRIGGER pr03c_evidence_request_fail BEFORE INSERT OR UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION public.pr03c_evidence_request_fail()`;
  try {
    // The collector catches a per-repository error and then retries recovery.
    // Either attempt must keep the domain write in the failed request's tx.
    await refreshAgentEvidenceJob(context(job), { request: noNetwork }).catch(error => {
      expect(String(error) + String(error.cause)).toContain("pr03c_evidence_request_failed");
    });
    expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo)))
      .toMatchObject([{ state: "needs_review", reason: "ai_evidence_pending", decidedBy: "auto" }]);
    expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toHaveLength(0);
  } finally {
    await observer`DROP TRIGGER IF EXISTS pr03c_evidence_request_fail ON jobs`;
    await observer`DROP FUNCTION IF EXISTS public.pr03c_evidence_request_fail()`;
  }
});
it("rolls scan persistence back after its collector job lock wait expires", async () => {
  const scan = await freshScan(), job = await lease();
  const outcome = await afterJobWaitExpiry(job, job.name,
    () => saveRepositoryAgentScan({ ...scanResult(), requestCount: 7 }, new Date(), job));
  expect(outcome).toHaveProperty("error");
  expect(String("error" in outcome && outcome.error)).toContain("job_lease_lost");
  expect(await db.select().from(agentRepositoryScans).where(eq(agentRepositoryScans.id, scan.id)))
    .toMatchObject([{ completedAt: scan.completedAt, requestCount: scan.requestCount }]);
});
it("rolls recovery and its request back after the outbox lock wait expires", async () => {
  await freshScan();
  await pendingCandidate();
  const job = await lease();
  await db.insert(jobs).values({ name: "crawl-judge", requestedVersion: 3, processedVersion: 2,
    cursor: { untouched: true }, notBefore: new Date(Date.now() + 60_000) });
  const outcome = await afterJobWaitExpiry(job, "crawl-judge",
    () => refreshAgentEvidenceJob(context(job), { request: noNetwork }));
  expect(outcome).toHaveProperty("error");
  expect(String("error" in outcome && outcome.error)).toContain("job_lease_lost");
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo))).toMatchObject([{ state: "needs_review" }]);
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge")))
    .toMatchObject([{ requestedVersion: 3, processedVersion: 2, cursor: { untouched: true } }]);
});
it("rolls a direct reopen and request back after the outbox lock wait expires", async () => {
  const scan = await freshScan();
  await db.update(agentRepositoryScans).set({ nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(agentRepositoryScans.id, scan.id));
  await pendingCandidate();
  const job = await lease();
  spies.refresh.mockResolvedValueOnce({ scan, observations: [], cached: true, errorCode: null, retryAt: scan.nextAttemptAt });
  await db.insert(jobs).values({ name: "crawl-judge", requestedVersion: 3, processedVersion: 2 });
  const outcome = await afterJobWaitExpiry(job, "crawl-judge",
    () => refreshAgentEvidenceJob(context(job), { request: noNetwork }));
  expect(outcome).toHaveProperty("error");
  expect(String("error" in outcome && outcome.error)).toContain("job_lease_lost");
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo))).toMatchObject([{ state: "needs_review" }]);
  expect(await db.select().from(jobs).where(eq(jobs.name, "crawl-judge"))).toMatchObject([{ requestedVersion: 3, processedVersion: 2 }]);
});
it("keeps a healthy logical item and its running attempt while replacing evidence", async () => {
  const scan = await freshScan(), candidate = await pendingCandidate();
  const [document] = await db.insert(crawlDocuments).values({ repo, repoMeta: {} }).returning();
  const input = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, { scan, observations: [] });
  const token = randomUUID(), reviewer = { provider: "abcllm", model: "fixture-model" };
  const binding = agentReviewBinding(candidate.id, input, reviewer);
  const [attempt] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic",
    state: "running", inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    policyHash: input.policyHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    ...reviewer, attemptNumber: 1, leaseToken: token, validUntil: input.validUntil }).returning();
  const [item] = await db.insert(pipelineItemLeases).values({ stage: "ai1", workKey: `ai1:${candidate.id}`,
    binding, bindingHash: itemBindingHash(binding), ownerInstanceId: "pr03c-evidence-live-owner",
    ownerBootId: randomUUID(), token, stageEpoch: 1, itemEpoch: 1,
    leaseUntil: sql`clock_timestamp()+interval '10 minutes'` }).returning();
  await db.update(pipelineStageModes).set({ mode: "items" }).where(eq(pipelineStageModes.stage, "ai1"));
  await saveRepositoryAgentScan({ ...scanResult(), commitSha: "d".repeat(40) });
  await refreshAgentEvidenceJob(context(await lease()), { request: noNetwork });
  expect(await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, item.workKey))).toEqual([item]);
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, attempt.id))).toEqual([attempt]);
});
