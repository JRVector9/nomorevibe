import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq, inArray, like, sql } from "drizzle-orm";

const transport = vi.hoisted(() => ({ readme: vi.fn(), cli: vi.fn(), gateway: vi.fn(), grok: vi.fn(), github: vi.fn(), page: vi.fn() }));
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
vi.mock("@/lib/crawl/github", async original => ({
  ...await original<typeof import("@/lib/crawl/github")>(), getRepo: transport.github,
}));
vi.mock("@/lib/net/fetch", async original => ({
  ...await original<typeof import("@/lib/net/fetch")>(), fetchPage: transport.page,
}));

import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings,
  jobs, operationsObservations, pipelineItemLeases, pipelineStageModes } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { claimItemAgentReview, loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { requestJob } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03c-blocked-admin" } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr03c-blocked-observer", statement_timeout: 8_000 } });

const prefix = "pr03c-blocked/";
const managedJobs = ["crawl-fetch", "crawl-agent-review", "crawl-judge", "second-review", "crawl-publish"];
const observedKeys = ["job:crawl-fetch", "job:crawl-agent-review"];
const sentinel = { name: "pr03c-blocked-unrelated", requestedVersion: 23, processedVersion: 8,
  cursor: { marker: "unrelated", page: 80 }, notBefore: new Date("2101-01-01T00:00:00.000Z") };
let originalJobs: typeof jobs.$inferSelect[] = [];
let originalSettings: typeof crawlSettings.$inferSelect[] = [];
let originalStages: typeof pipelineStageModes.$inferSelect[] = [];
let originalCandidates: typeof crawlCandidates.$inferSelect[] = [];
let originalFrontier: typeof crawlFrontier.$inferSelect[] = [];
let originalJobRows: unknown[] = [], originalSettingRows: unknown[] = [], originalObservationRows: unknown[] = [];
let originalCandidateRows: unknown[] = [], originalFrontierRows: unknown[] = [];
let inputSentinel: { candidate: typeof crawlCandidates.$inferSelect; document: typeof crawlDocuments.$inferSelect;
  frontier: typeof crawlFrontier.$inferSelect } | undefined;
let initialized = false, sequence = 0;
const stages = [{ stage: "fetch", name: "crawl-fetch", handler: fetchCrawlDocuments },
  { stage: "ai1", name: "crawl-agent-review", handler: reviewCrawlCandidates }] as const;

function settings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "claude-cli", model: "pr03c-blocked-fixture" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } };
}
async function restoreFixtures(final = false) {
  await db.delete(pipelineItemLeases).where(sql`${pipelineItemLeases.stage}='ai1' AND ${pipelineItemLeases.binding}->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr03c-blocked/%')`);
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${prefix}%`));
  await db.delete(jobs).where(inArray(jobs.name, managedJobs));
  if (final && originalJobRows.length) await admin`INSERT INTO jobs SELECT * FROM
    jsonb_populate_recordset(NULL::jobs, ${JSON.stringify(originalJobRows)}::text::jsonb)`;
  await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
  if (final && originalSettingRows.length) await admin`INSERT INTO crawl_settings SELECT * FROM
    jsonb_populate_recordset(NULL::crawl_settings, ${JSON.stringify(originalSettingRows)}::text::jsonb)`;
  await db.delete(operationsObservations).where(inArray(operationsObservations.key, observedKeys));
  if (final && originalObservationRows.length) await admin`INSERT INTO operations_observations SELECT * FROM
    jsonb_populate_recordset(NULL::operations_observations, ${JSON.stringify(originalObservationRows)}::text::jsonb)`;
  for (const stage of originalStages) await db.update(pipelineStageModes).set(final ? stage
    : { mode: "legacy", drainingFrom: null, epoch: 1, writerContractVersion: 0 }).where(eq(pipelineStageModes.stage, stage.stage));
}
beforeAll(async () => {
  ensureSchema();
  const repo = "pr03c-blocked-unrelated/input-sentinel", productUrl = "https://pr03c-unrelated.example";
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: new Date(Date.now() - 2_000),
    pageStatus: 200, repoMeta: {}, pageMeta: { title: "Unrelated queued source" } }).returning();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed", decidedBy: "auto" }).returning();
  const [frontier] = await db.insert(crawlFrontier).values({ repo, signal: "pr03c-unrelated" }).returning();
  inputSentinel = { document, candidate, frontier };
  originalJobs = await db.select().from(jobs).where(inArray(jobs.name, managedJobs)).orderBy(jobs.name);
  originalSettings = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
  originalStages = await db.select().from(pipelineStageModes);
  originalCandidates = await db.select().from(crawlCandidates);
  originalFrontier = await db.select().from(crawlFrontier);
  originalJobRows = [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name = ANY(${managedJobs}) ORDER BY name`].map(row => row.value);
  originalSettingRows = [...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value);
  originalObservationRows = [...await admin`SELECT to_jsonb(o) AS value FROM operations_observations o WHERE key = ANY(${observedKeys}) ORDER BY key`].map(row => row.value);
  originalCandidateRows = [...await admin`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`].map(row => row.value);
  originalFrontierRows = [...await admin`SELECT to_jsonb(f) AS value FROM crawl_frontier f ORDER BY id`].map(row => row.value);
  initialized = true;
  // Actual handlers select globally. Park pre-existing test-file inputs for this
  // suite, then restore only suspended columns and verify every original value.
  if (originalCandidates.length) await db.update(crawlCandidates).set({ state: "rejected", decidedBy: "admin" })
    .where(inArray(crawlCandidates.id, originalCandidates.map(row => row.id)));
  if (originalFrontier.length) await db.update(crawlFrontier).set({ state: "skipped", nextAttemptAt: new Date("2101-01-01T00:00:00.000Z") })
    .where(inArray(crawlFrontier.id, originalFrontier.map(row => row.id)));
  await db.insert(jobs).values(sentinel);
});
beforeEach(async () => {
  await restoreFixtures();
  vi.resetAllMocks();
  for (const mock of Object.values(transport)) mock.mockRejectedValue(new Error("unexpected external dispatch"));
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: "pr03c-blocked" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: "pr03c-blocked" } });
});
afterEach(async () => {
  expect(await db.select().from(jobs).where(eq(jobs.name, sentinel.name))).toMatchObject([sentinel]);
});
afterAll(async () => {
  try {
    if (!initialized) return;
    await restoreFixtures(true);
    for (const row of originalCandidates) await db.update(crawlCandidates).set({ state: row.state, decidedBy: row.decidedBy })
      .where(eq(crawlCandidates.id, row.id));
    if (originalFrontierRows.length) await admin`UPDATE crawl_frontier f SET state=r.state, next_attempt_at=r.next_attempt_at
      FROM jsonb_populate_recordset(NULL::crawl_frontier, ${JSON.stringify(originalFrontierRows)}::text::jsonb) r WHERE f.id=r.id`;
    await db.delete(jobs).where(eq(jobs.name, sentinel.name));
    expect(await db.select().from(jobs).where(inArray(jobs.name, managedJobs)).orderBy(jobs.name)).toEqual(originalJobs);
    expect(await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1))).toEqual(originalSettings);
    expect(await db.select().from(pipelineStageModes)).toEqual(originalStages);
    if (originalCandidates.length) expect(await db.select().from(crawlCandidates)
      .where(inArray(crawlCandidates.id, originalCandidates.map(row => row.id))).orderBy(crawlCandidates.id))
      .toEqual([...originalCandidates].sort((a, b) => a.id - b.id));
    if (originalFrontier.length) expect(await db.select().from(crawlFrontier)
      .where(inArray(crawlFrontier.id, originalFrontier.map(row => row.id))).orderBy(crawlFrontier.id))
      .toEqual([...originalFrontier].sort((a, b) => a.id - b.id));
    if (inputSentinel) expect(await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, inputSentinel.document.id)))
      .toEqual([inputSentinel.document]);
    expect([...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name = ANY(${managedJobs}) ORDER BY name`].map(row => row.value)).toEqual(originalJobRows);
    expect([...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value)).toEqual(originalSettingRows);
    expect([...await admin`SELECT to_jsonb(o) AS value FROM operations_observations o WHERE key = ANY(${observedKeys}) ORDER BY key`].map(row => row.value)).toEqual(originalObservationRows);
    expect([...await admin`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`].map(row => row.value)).toEqual(originalCandidateRows);
    expect([...await admin`SELECT to_jsonb(f) AS value FROM crawl_frontier f ORDER BY id`].map(row => row.value)).toEqual(originalFrontierRows);
  } finally {
    try {
      if (inputSentinel) {
        await db.delete(crawlCandidates).where(eq(crawlCandidates.id, inputSentinel.candidate.id));
        await db.delete(crawlDocuments).where(eq(crawlDocuments.id, inputSentinel.document.id));
        await db.delete(crawlFrontier).where(eq(crawlFrontier.id, inputSentinel.frontier.id));
      }
    } finally { await Promise.all([admin.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
  }
});

async function requestedJob(name: string) {
  const [row] = await db.insert(jobs).values({ name, requestedVersion: 7, processedVersion: 2,
    cursor: { marker: "pending-stage-work", page: 4 }, runs: 5,
    lastSuccessAt: new Date("2020-01-02T03:04:05.000Z"), lastError: "preserved historical error" })
    .onConflictDoUpdate({ target: jobs.name, set: { requestedVersion: 7, processedVersion: 2,
      cursor: { marker: "pending-stage-work", page: 4 }, runs: 5,
      lastSuccessAt: new Date("2020-01-02T03:04:05.000Z"), lastError: "preserved historical error" } }).returning();
  return row;
}
async function queuedSource(stage: "fetch" | "ai1") {
  const repo = `${prefix}app-${++sequence}`;
  if (stage === "fetch") {
    const [frontier] = await db.insert(crawlFrontier).values({ repo, signal: "pr03c-blocked" }).returning();
    return { frontier };
  }
  const fetchedAt = new Date(Date.now() - 2_000), productUrl = `https://pr03c-blocked-${sequence}.example`;
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt, pageStatus: 200,
    pageMeta: { title: "Task tracker", description: "Create projects and manage tasks" },
    repoMeta: { private: false, fork: false, archived: false, pushed_at: fetchedAt.toISOString(), stargazers_count: 3 } }).returning();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt }).returning();
  return { candidate, document };
}
function preservedRequest(row: typeof jobs.$inferSelect) {
  return { requestedVersion: row.requestedVersion, processedVersion: row.processedVersion, cursor: row.cursor,
    notBefore: row.notBefore, lastSuccessAt: row.lastSuccessAt, lastError: row.lastError };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [state] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE ${pid}=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock') AS waiting`;
    if (state.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`blocked request did not enter an actual lock wait behind ${pid}`);
}
async function domainRows(source: Awaited<ReturnType<typeof queuedSource>>) {
  return { frontier: source.frontier ? await db.select().from(crawlFrontier).where(eq(crawlFrontier.id, source.frontier.id)) : [],
    candidate: source.candidate ? await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, source.candidate.id)) : [],
    document: source.document ? await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, source.document.id)) : [],
    attempts: source.candidate ? await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, source.candidate.id)) : [] };
}

for (const { stage, name, handler } of stages) {
  it.each(["items", "draining"] as const)(`${stage} %s preserves its pending request and histories without dispatch or domain/outbox writes`, async mode => {
    const beforeJob = await requestedJob(name), source = await queuedSource(stage), beforeDomain = await domainRows(source);
    const downstream = managedJobs.filter(other => other !== name);
    const beforeRequests = await db.select().from(jobs).where(inArray(jobs.name, downstream));
    await db.update(pipelineStageModes).set({ mode, drainingFrom: mode === "draining" ? "legacy" : null,
      writerContractVersion: 1 }).where(eq(pipelineStageModes.stage, stage));
    expect(await runJob(name, handler, { requestedOnly: true })).toMatchObject({ status: "deferred", reason: "stage_blocked" });
    const [after] = await db.select().from(jobs).where(eq(jobs.name, name));
    expect.soft(preservedRequest(after)).toEqual(preservedRequest(beforeJob));
    expect(after).toMatchObject({ leaseToken: null, lockedAt: null, runs: beforeJob.runs + 1 });
    for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
    expect(await domainRows(source)).toEqual(beforeDomain);
    expect(await db.select().from(jobs).where(inArray(jobs.name, downstream))).toEqual(beforeRequests);
  });

  it(`${stage} normal empty queue keeps its existing ACK and cursor-reset behavior`, async () => {
    const before = await requestedJob(name);
    expect(await runJob(name, handler, { requestedOnly: true })).toMatchObject({ status: "completed", done: true });
    expect(await db.select().from(jobs).where(eq(jobs.name, name)))
      .toMatchObject([{ requestedVersion: before.requestedVersion, processedVersion: before.requestedVersion,
        cursor: null, leaseToken: null, lockedAt: null, lastError: null }]);
    for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
  });

  it(`${stage} deferral preserves a concurrent producer request and pause`, async () => {
    await requestedJob(name);
    await queuedSource(stage);
    await db.update(pipelineStageModes).set({ mode: "items", writerContractVersion: 1 }).where(eq(pipelineStageModes.stage, stage));
    let running: ReturnType<typeof runJob> | undefined, expected: ReturnType<typeof preservedRequest> | undefined;
    try {
      await admin.begin(async blocker => {
        const [{ pid }] = await blocker`SELECT pg_backend_pid() AS pid`;
        await blocker`SELECT stage FROM pipeline_stage_modes WHERE stage=${stage} FOR UPDATE`;
        running = runJob(name, handler, { requestedOnly: true });
        void running.catch(() => {});
        await waitForBlockedBy(pid);
        expect(await requestJob(name)).toMatchObject({ requestedVersion: 8 });
        await observer`UPDATE jobs SET not_before='2101-01-01T00:00:00Z' WHERE name=${name}`;
        expected = preservedRequest((await db.select().from(jobs).where(eq(jobs.name, name)))[0]);
      });
    } finally { if (running) expect(await running).toMatchObject({ status: "deferred", reason: "stage_blocked" }); }
    expect(preservedRequest((await db.select().from(jobs).where(eq(jobs.name, name)))[0])).toEqual(expected);
    for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
  });

  it(`${stage} late deferred cleanup never changes the replacement job owner's row`, async () => {
    await requestedJob(name);
    await db.update(pipelineStageModes).set({ mode: "items", writerContractVersion: 1 }).where(eq(pipelineStageModes.stage, stage));
    const completed = barrier(), finish = barrier();
    let reached = false;
    const running = runJob<null>(name, async ctx => {
      const outcome = await handler(ctx);
      reached = true;
      completed.resolve();
      await finish.promise;
      return outcome;
    }, { requestedOnly: true });
    void running.catch(() => {});
    let replacement: typeof jobs.$inferSelect[] = [];
    try {
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 3_000 });
      await completed.promise;
      await db.update(jobs).set({ leaseToken: randomUUID(), lockedAt: sql`clock_timestamp()`, requestedVersion: 9,
        processedVersion: 3, cursor: { marker: "replacement-owner" }, notBefore: new Date("2101-01-01T00:00:00.000Z") })
        .where(eq(jobs.name, name));
      replacement = await db.select().from(jobs).where(eq(jobs.name, name));
    } finally { finish.resolve(); expect(await running).toMatchObject({ status: "failed", error: "job_lease_lost" }); }
    expect(await db.select().from(jobs).where(eq(jobs.name, name))).toEqual(replacement);
    for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
  });
}

it("keeps normal bounded done:false ACK behavior", async () => {
  const before = await requestedJob("crawl-fetch");
  expect(await runJob("crawl-fetch", async () => ({ done: false }), { requestedOnly: true }))
    .toMatchObject({ status: "completed", done: false });
  expect(await db.select().from(jobs).where(eq(jobs.name, before.name)))
    .toMatchObject([{ requestedVersion: before.requestedVersion, processedVersion: before.requestedVersion,
      cursor: before.cursor, leaseToken: null, lockedAt: null, lastError: null }]);
});

it.each(["items", "draining"] as const)("fetch %s preserves its request even when its budget expires before admission", async mode => {
  const before = await requestedJob("crawl-fetch"), source = await queuedSource("fetch"), domain = await domainRows(source);
  await db.update(pipelineStageModes).set({ mode, drainingFrom: mode === "draining" ? "legacy" : null,
    writerContractVersion: 1 }).where(eq(pipelineStageModes.stage, "fetch"));
  expect(await runJob("crawl-fetch", fetchCrawlDocuments, { requestedOnly: true, budgetMs: 0 }))
    .toMatchObject({ status: "deferred", reason: "stage_blocked" });
  const [after] = await db.select().from(jobs).where(eq(jobs.name, before.name));
  expect(preservedRequest(after)).toEqual(preservedRequest(before));
  expect(after).toMatchObject({ leaseToken: null, lockedAt: null });
  expect(await domainRows(source)).toEqual(domain);
  expect(await db.select().from(jobs).where(inArray(jobs.name, ["crawl-judge", "second-review", "crawl-publish"]))).toEqual([]);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
});

it("keeps legacy fetch budget exhaustion as an ordinary bounded ACK without claiming its pending input", async () => {
  const before = await requestedJob("crawl-fetch"), source = await queuedSource("fetch"), domain = await domainRows(source);
  expect(await runJob("crawl-fetch", fetchCrawlDocuments, { requestedOnly: true, budgetMs: 0 }))
    .toMatchObject({ status: "completed", done: false });
  expect(await db.select().from(jobs).where(eq(jobs.name, before.name)))
    .toMatchObject([{ requestedVersion: before.requestedVersion, processedVersion: before.requestedVersion,
      cursor: before.cursor, leaseToken: null, lockedAt: null, lastError: null }]);
  expect(await domainRows(source)).toEqual(domain);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
});

it("preserves the request when AI1 stage closure during README blocks the actual claim", async () => {
  const before = await requestedJob("crawl-agent-review"), source = await queuedSource("ai1");
  transport.readme.mockImplementation(async () => {
    await db.update(pipelineStageModes).set({ mode: "draining", drainingFrom: "legacy", writerContractVersion: 1 })
      .where(eq(pipelineStageModes.stage, "ai1"));
    return "A deployed task tracker";
  });
  expect(await runJob("crawl-agent-review", reviewCrawlCandidates, { requestedOnly: true }))
    .toMatchObject({ status: "deferred", reason: "stage_blocked" });
  expect(preservedRequest((await db.select().from(jobs).where(eq(jobs.name, before.name)))[0])).toEqual(preservedRequest(before));
  expect(transport.readme).toHaveBeenCalledOnce();
  for (const mock of [transport.cli, transport.gateway, transport.grok]) expect(mock).not.toHaveBeenCalled();
  expect(await domainRows(source)).toMatchObject({ candidate: [source.candidate], attempts: [] });
  expect(await db.select().from(jobs).where(inArray(jobs.name, ["second-review", "crawl-publish"]))).toEqual([]);
});

it("ACKs a normal legacy tick that skips a healthy foreign item without calling it stage-blocked", async () => {
  const before = await requestedJob("crawl-agent-review"), source = await queuedSource("ai1");
  if (!source.candidate || !source.document) throw new Error("AI1 source fixture required");
  await db.update(pipelineStageModes).set({ mode: "items", writerContractVersion: 1 }).where(eq(pipelineStageModes.stage, "ai1"));
  const input = await loadReviewInput(source.candidate, source.document, settings());
  const claim = await claimItemAgentReview({ candidate: source.candidate, document: source.document, settings: settings(), input,
    provider: "claude-cli", model: "pr03c-blocked-fixture", owner: { instanceId: "pr03c-blocked-owner",
      bootId: "00000000-0000-4000-8000-000000000080" }, ttlMs: 60_000 });
  expect(claim.kind).toBe("claimed");
  const items = await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai1:${source.candidate.id}`));
  const domain = await domainRows(source);
  await db.update(pipelineStageModes).set({ mode: "legacy" }).where(eq(pipelineStageModes.stage, "ai1"));
  expect(await runJob("crawl-agent-review", reviewCrawlCandidates, { requestedOnly: true })).toMatchObject({ status: "completed" });
  expect((await db.select().from(jobs).where(eq(jobs.name, before.name)))[0].processedVersion).toBe(before.requestedVersion);
  expect(await domainRows(source)).toEqual(domain);
  expect(await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai1:${source.candidate.id}`))).toEqual(items);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
});
