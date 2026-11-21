import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";

const transport = vi.hoisted(() => ({ cli: vi.fn(), gateway: vi.fn(), grok: vi.fn() }));
vi.mock("@/lib/crawl/agent-review", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: transport.cli,
}));
vi.mock("@/lib/crawl/agent-review-gateway", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: transport.gateway,
}));
vi.mock("@/lib/crawl/agent-review-grok", async original => ({
  ...await original<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: transport.grok,
}));
// 정비 한 단계(닫기)가 던지는 틱을 만들 때만 쓴다 — 평소에는 진짜 함수 그대로다
const controller = vi.hoisted(() => ({ closeFailure: null as Error | null }));
vi.mock("@/lib/crawl/second-review", async original => {
  const actual = await original<typeof import("@/lib/crawl/second-review")>();
  return { ...actual, closeSettledSecondReviews: async (...args: Parameters<typeof actual.closeSettledSecondReviews>) => {
    if (controller.closeFailure) throw controller.closeFailure;
    return actual.closeSettledSecondReviews(...args);
  } };
});

import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { enqueueSecondReviewsFixture as enqueueSecondReviews } from "./second-review-receipt-fixtures";
import { loadSecondReviewInput } from "@/lib/crawl/second-review-input";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash } from "@/lib/crawl/agent-review-contract";
import { claimItemLease, lockItemStage } from "@/lib/jobs/items/repository";
import type { Ai2ItemBinding } from "@/lib/jobs/items/types";
import { runJob } from "@/lib/jobs/runner";
import { pendingJobNames, requestDueJobs, requestJob } from "@/lib/jobs/control";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04-independent-admin" } });
const suffix = randomUUID().slice(0, 8);
const prefix = `pr04-independent-${suffix}/`;
const sentinelName = `pr04-independent-unrelated-${suffix}`;
const jobNames = ["second-review", "crawl-publish"];
type Raw = Record<string, unknown>;
let originalJobs: Raw[] = [], originalSettings: Raw[] = [], originalStages: Raw[] = [];
let originalCandidates: Raw[] = [], originalVotes: Raw[] = [], originalDocuments: Raw[] = [], originalAttempts: Raw[] = [];
let originalObservations: Raw[] = [];
let sentinel: Raw | undefined;
let initialized = false, sequence = 0;

function fixtureSettings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "observe",
    firstReview: { provider: "claude-cli", model: "pr04-independent-first" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "pr04-independent-second" }], fallbacks: [],
      includeAiHeld: false, sampleRate: 0, agreeAt: 0.85 } };
}

async function managedJobRows() {
  return [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=ANY(${jobNames}) ORDER BY name`].map(row => row.value as Raw);
}
async function ownCleanup() {
  await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE ${`${prefix}%`})`;
  await admin`DELETE FROM second_reviews WHERE repo LIKE ${`${prefix}%`}`;
  await admin`DELETE FROM crawl_candidates WHERE repo LIKE ${`${prefix}%`}`;
  await admin`DELETE FROM crawl_documents WHERE repo LIKE ${`${prefix}%`}`;
}
async function restoreManagedJobs() {
  const existingNames = originalJobs.map(row => String(row.name));
  const createdNames = jobNames.filter(name => !existingNames.includes(name));
  if (createdNames.length) await admin`DELETE FROM jobs WHERE name=ANY(${createdNames})`;
  if (originalJobs.length) await admin`UPDATE jobs j SET
    requested_version=r.requested_version,processed_version=r.processed_version,
    next_scheduled_at=r.next_scheduled_at,not_before=r.not_before,lease_token=r.lease_token,
    worker_seen_at=r.worker_seen_at,cursor=r.cursor,locked_at=r.locked_at,last_run_at=r.last_run_at,
    last_success_at=r.last_success_at,last_error=r.last_error,runs=r.runs,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb) r WHERE j.name=r.name`;
}

beforeAll(async () => {
  ensureSchema();
  originalJobs = await managedJobRows();
  originalSettings = [...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value as Raw);
  originalStages = [...await admin`SELECT to_jsonb(s) AS value FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.value as Raw);
  originalCandidates = [...await admin`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`].map(row => row.value as Raw);
  originalVotes = [...await admin`SELECT to_jsonb(s) AS value FROM second_reviews s ORDER BY id`].map(row => row.value as Raw);
  originalDocuments = [...await admin`SELECT to_jsonb(d) AS value FROM crawl_documents d ORDER BY id`].map(row => row.value as Raw);
  originalAttempts = [...await admin`SELECT to_jsonb(a) AS value FROM crawl_review_attempts a ORDER BY id`].map(row => row.value as Raw);
  originalObservations = [...await admin`SELECT to_jsonb(o) AS value FROM operations_observations o WHERE key='job:second-review'`].map(row => row.value as Raw);
  initialized = true;
  // The handler owns a global selector. Suspend only demand columns and restore
  // those exact columns from raw PG JSON, including sub-millisecond timestamps.
  if (originalCandidates.length) await admin`UPDATE crawl_candidates SET decided_by=NULL
    WHERE id=ANY(${originalCandidates.map(row => Number(row.id))}) AND decided_by='auto'`;
  if (originalVotes.length) await admin`UPDATE second_reviews SET status='resolved',resolution='kept'
    WHERE id=ANY(${originalVotes.map(row => Number(row.id))})`;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES(${sentinelName},13,5,'{"marker":"unrelated","page":71}'::jsonb,
      '2101-01-01 00:00:00.123456','2026-01-01 00:00:00.654321')`;
  [sentinel] = [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=${sentinelName}`].map(row => row.value as Raw);
});
beforeEach(async () => {
  await ownCleanup();
  await restoreManagedJobs();
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',draining_from=NULL,writer_contract_version=0 WHERE stage='ai2'`;
  await db.insert(crawlSettings).values({ id: 1, values: fixtureSettings() })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: fixtureSettings() } });
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,lease_token,
    locked_at,last_success_at,last_error,runs,updated_at)
    VALUES('second-review',9,4,'{"marker":"pr04-resume","page":7}'::jsonb,NULL,NULL,NULL,
      '2026-01-01 01:02:03.123456','old fixture error',17,'2026-01-01 01:02:03.654321')
    ON CONFLICT(name) DO UPDATE SET requested_version=9,processed_version=4,
      cursor=EXCLUDED.cursor,not_before=NULL,lease_token=NULL,locked_at=NULL,
      last_success_at=EXCLUDED.last_success_at,last_error=EXCLUDED.last_error,runs=17,updated_at=EXCLUDED.updated_at`;
  vi.resetAllMocks();
  controller.closeFailure = null;
  const answer = { ok: true, outcome: { decision: "reject", confidence: 0.99,
    reason: "The independent fixture is not a qualifying product", evidenceIds: ["product"] },
    usage: { inputTokens: 8, outputTokens: 2 } };
  for (const mock of [transport.cli, transport.gateway, transport.grok]) mock.mockResolvedValue(answer);
});
afterEach(async () => {
  expect([...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=${sentinelName}`].map(row => row.value)).toEqual([sentinel]);
});
afterAll(async () => {
  try {
    if (initialized) {
      await ownCleanup();
      await restoreManagedJobs();
      if (originalSettings.length) await admin`UPDATE crawl_settings s SET values=r.values
        FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb) r WHERE s.id=r.id`;
      else await admin`DELETE FROM crawl_settings WHERE id=1`;
      await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,
        writer_contract_version=r.writer_contract_version FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,
          ${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
      if (originalCandidates.length) await admin`UPDATE crawl_candidates c SET decided_by=r.decided_by
        FROM jsonb_populate_recordset(NULL::crawl_candidates,${JSON.stringify(originalCandidates)}::text::jsonb) r WHERE c.id=r.id`;
      if (originalVotes.length) await admin`UPDATE second_reviews s SET status=r.status,resolution=r.resolution
        FROM jsonb_populate_recordset(NULL::second_reviews,${JSON.stringify(originalVotes)}::text::jsonb) r WHERE s.id=r.id`;
      if (originalObservations.length) await admin`UPDATE operations_observations o SET value=r.value,observed_at=r.observed_at
        FROM jsonb_populate_recordset(NULL::operations_observations,${JSON.stringify(originalObservations)}::text::jsonb) r WHERE o.key=r.key`;
      else await admin`DELETE FROM operations_observations WHERE key='job:second-review'`;
      expect(await managedJobRows()).toEqual(originalJobs);
      expect([...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value)).toEqual(originalSettings);
      expect([...await admin`SELECT to_jsonb(s) AS value FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.value)).toEqual(originalStages);
      expect([...await admin`SELECT to_jsonb(c) AS value FROM crawl_candidates c ORDER BY id`].map(row => row.value)).toEqual(originalCandidates);
      expect([...await admin`SELECT to_jsonb(s) AS value FROM second_reviews s ORDER BY id`].map(row => row.value)).toEqual(originalVotes);
      expect([...await admin`SELECT to_jsonb(d) AS value FROM crawl_documents d ORDER BY id`].map(row => row.value)).toEqual(originalDocuments);
      expect([...await admin`SELECT to_jsonb(a) AS value FROM crawl_review_attempts a ORDER BY id`].map(row => row.value)).toEqual(originalAttempts);
      expect([...await admin`SELECT to_jsonb(o) AS value FROM operations_observations o WHERE key='job:second-review'`].map(row => row.value)).toEqual(originalObservations);
      expect([...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=${sentinelName}`].map(row => row.value)).toEqual([sentinel]);
      await admin`DELETE FROM jobs WHERE name=${sentinelName}`;
    }
  } finally { await admin.end({ timeout: 3 }); }
});

async function source() {
  const repo = `${prefix}app-${++sequence}`;
  const [{ at }] = await admin`SELECT to_char(date_trunc('milliseconds',clock_timestamp())-interval '2 seconds',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  const fetchedAt = new Date(at);
  const productUrl = `https://pr04-${suffix}-${sequence}.example`;
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt, pageStatus: 200,
    repoMeta: { description: "A deployed task tracker", private: false, fork: false, archived: false,
      pushed_at: fetchedAt.toISOString(), stargazers_count: 3, owner: { type: "User" } },
    pageMeta: { title: "Task tracker", textSample: "Create projects and manage tasks online.",
      readmeSample: "A deployed task tracker", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "needs_review", reason: "ambiguous",
    decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt }).returning();
  const settings = fixtureSettings();
  const input = await loadReviewInput(candidate, document, settings);
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    attemptNumber: 1, inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: settings.firstReview!.provider, model: settings.firstReview!.model, startedAt: fetchedAt,
    completedAt: fetchedAt, validUntil: input.validUntil,
    outcome: { decision: "reject", confidence: 0.95, reason: "First fixture rejection", evidenceIds: ["product"] } }).returning();
  await enqueueSecondReviews(settings);
  // The real fixture runner acknowledges its own job. Signal the later handler
  // tick through the same producer API used by live upstream work.
  await requestJob("second-review");
  // Arrange the later handler's diagnostic/cursor sentinels after fixture work.
  // Keep the actual runner's versions and ownership history intact.
  await admin`UPDATE jobs SET cursor='{"marker":"pr04-resume","page":7}'::jsonb,
    last_success_at='2026-01-01 01:02:03.123456',last_error='old fixture error'
    WHERE name='second-review'`;
  const votes = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidate.id));
  expect(votes).toHaveLength(1);
  const vote = votes[0];
  expect(vote).toMatchObject({ firstAttemptId: first.id, status: "pending", provider: "abcllm", model: "pr04-independent-second" });
  expect((await loadSecondReviewInput(vote))?.inputHash).toBe(input.inputHash);
  return { candidate, document, first, settings, input, vote };
}
type Context = Awaited<ReturnType<typeof source>>;
async function domain(context: Context) {
  const [row] = await admin`SELECT jsonb_build_object(
    'candidate',(SELECT to_jsonb(c) FROM crawl_candidates c WHERE id=${context.candidate.id}),
    'document',(SELECT to_jsonb(d) FROM crawl_documents d WHERE id=${context.document.id}),
    'first',(SELECT to_jsonb(a) FROM crawl_review_attempts a WHERE id=${context.first.id}),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM second_reviews s WHERE candidate_id=${context.candidate.id}),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY work_key),'[]'::jsonb) FROM pipeline_item_leases i
      WHERE stage='ai2' AND binding->>'candidateId'=${String(context.candidate.id)}),
    'publish',(SELECT to_jsonb(j) FROM jobs j WHERE name='crawl-publish')) AS value`;
  return row.value;
}
/** stage_blocked 미룸이 보존하는 요청·커서·일정·성공 기록. 던지지 않고 끝난 틱이라 지난 실패 기록은 지운다(lastErrorCleared, runner.ts) */
async function preservedJob() {
  const [row] = await admin`SELECT jsonb_build_object('requested',requested_version,'processed',processed_version,
    'cursor',cursor,'notBefore',not_before,'lastSuccess',last_success_at) AS value
    FROM jobs WHERE name='second-review'`;
  return row.value;
}
async function lastErrorCleared() {
  const [row] = await admin`SELECT last_error FROM jobs WHERE name='second-review'`;
  return row.last_error === null;
}
const tick = (budgetMs = 110_000) => runJob("second-review", secondReviewCandidates, { requestedOnly: true, budgetMs });
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function noModelCalls() {
  expect(transport.gateway).not.toHaveBeenCalled();
  expect(transport.cli).not.toHaveBeenCalled();
  expect(transport.grok).not.toHaveBeenCalled();
}

it("legacy control dispatches and records exactly one current vote", async () => {
  const context = await source();
  const before = await domain(context);
  const result = await tick();
  expect(result.status).toBe("completed");
  expect(transport.gateway).toHaveBeenCalledTimes(1);
  expect(transport.gateway.mock.calls[0][0]).toEqual(context.input);
  expect(transport.cli).not.toHaveBeenCalled();
  expect(transport.grok).not.toHaveBeenCalled();
  const [saved] = await db.select().from(secondReviews).where(eq(secondReviews.id, context.vote.id));
  expect(saved).toMatchObject({ status: "agreed", secondDecision: "reject", secondConfidence: 0.99, failureCount: 0 });
  const after = await domain(context);
  expect({ ...after, votes: before.votes }).toEqual(before);
  const [job] = await admin`SELECT requested_version,processed_version,lease_token,locked_at FROM jobs WHERE name='second-review'`;
  // The fixture's direct runner requests version10; the later producer requests11.
  expect(Number(job.processed_version)).toBe(11);
  expect(Number(job.requested_version)).toBe(11);
  expect(job.lease_token).toBeNull();
  expect(job.locked_at).toBeNull();
});

// items(전환이 끝난 상태)의 정비 틱은 2026-11-21 부터 완료 틱이다 — 아래 "items 모드의 정비 틱" 시험들. 전환 중(draining)은 종전대로 요청을 남긴다
it("legacy handler preserves request while ai2 is draining", async () => {
  const context = await source();
  await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='legacy',writer_contract_version=1 WHERE stage='ai2'`;
  const before = await domain(context), jobBefore = await preservedJob();
  const result = await tick();
  expect(result.status).toBe("deferred");
  expect(result).toMatchObject({ reason: "stage_blocked" });
  noModelCalls();
  expect(await domain(context)).toEqual(before);
  expect(await preservedJob()).toEqual(jobBefore);
  expect(await lastErrorCleared()).toBe(true);
  const [job] = await admin`SELECT lease_token,locked_at FROM jobs WHERE name='second-review'`;
  expect(job.lease_token).toBeNull();
  expect(job.locked_at).toBeNull();
});

it("legacy handler skips a healthy foreign logical vote item", async () => {
  const context = await source();
  await admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai2'`;
  const binding: Ai2ItemBinding = { stage: "ai2", secondReviewId: context.vote.id, candidateId: context.candidate.id,
    source: { kind: "first_attempt", firstAttemptId: context.first.id }, inputHash: context.input.inputHash,
    sourceRevisionHash: context.input.sourceRevisionHash,
    policyHash: reviewHash({ version: 1, base: context.input.policyHash, firstReview: context.settings.firstReview,
      reviewMode: context.settings.reviewMode, secondReview: context.settings.secondReview }),
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    reviewer: { provider: "abcllm", model: "pr04-independent-second" }, generationKey: context.vote.generationKey,
    vote: context.vote.id, fallbackForId: null };
  const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "ai2"), binding,
    { instanceId: `pr04-independent-${suffix}`, bootId: randomUUID() }, 60_000));
  expect(lease).not.toBeNull();
  // Explicit mixed-version fixture: a healthy logical owner survives a legacy
  // mode read. Production transition APIs never force this transition.
  await admin`UPDATE pipeline_stage_modes SET mode='legacy' WHERE stage='ai2'`;
  const before = await domain(context);
  const result = await tick();
  expect(result.status).toBe("completed");
  noModelCalls();
  expect(await domain(context)).toEqual(before);
  const [job] = await admin`SELECT requested_version,processed_version FROM jobs WHERE name='second-review'`;
  expect(Number(job.processed_version)).toBe(Number(job.requested_version));
});

it("preserves an inactive draining request even with zero tick budget", async () => {
  const context = await source();
  await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='legacy',writer_contract_version=1 WHERE stage='ai2'`;
  const before = await domain(context), jobBefore = await preservedJob();
  expect(await tick(0)).toMatchObject({ status: "deferred", reason: "stage_blocked" });
  noModelCalls();
  expect(await domain(context)).toEqual(before);
  expect(await preservedJob()).toEqual(jobBefore);
  expect(await lastErrorCleared()).toBe(true);
});

/**
 * 2026-11-21: AI2 가 items 모드인 동안 이 잡의 일은 정비(올리기·닫기·정리·되돌리기·재시도)뿐이다. 그 틱을 stage_blocked 미룸으로 끝내던 때는
 * 러너가 요청을 인정하지 않아 워커 줄이 poll(5초)마다 무거운 정비 쿼리를 되풀이했고(일정은 60초), 성공 시각도 옮겨지지 않았다.
 * 이제 정비를 마친 틱은 완료 틱이다 — 다음 틱은 scheduler 의 정기 요청과 producer 의 requestJob 이 깨운다.
 */
/** 진짜 scheduler 요청 한 번. 카탈로그의 모든 정기 잡 행을 만들고 밀므로, second-review 밖의 행은 원래대로 돌린다 */
async function scheduledRequest() {
  const others = [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name<>'second-review'`].map(row => row.value as Raw);
  await admin`UPDATE jobs SET next_scheduled_at=clock_timestamp()-interval '1 second' WHERE name='second-review'`;
  try { return await requestDueJobs(undefined, { overrides: new Map() }); }
  finally {
    await admin`DELETE FROM jobs WHERE NOT (name=ANY(${["second-review", ...others.map(row => String(row.name))]}))`;
    if (others.length) await admin`UPDATE jobs j SET requested_version=r.requested_version,next_scheduled_at=r.next_scheduled_at,
      updated_at=r.updated_at FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(others)}::text::jsonb) r WHERE j.name=r.name`;
  }
}
const itemsMode = () => admin`UPDATE pipeline_stage_modes SET mode='items',writer_contract_version=1 WHERE stage='ai2'`;
async function jobRuns() {
  const [row] = await admin`SELECT runs::int AS runs FROM jobs WHERE name='second-review'`;
  return row.runs as number;
}

it("items 모드의 정비 틱은 요청을 인정한다 — 다음 poll 은 다시 집지 않고, 정기 요청이나 producer 의 요청이 오면 다시 돈다", async () => {
  const context = await source();
  await itemsMode();
  const before = await domain(context), jobBefore = await preservedJob();
  expect(await pendingJobNames("reviewer")).toContain("second-review");
  expect(await tick()).toMatchObject({ status: "completed", done: true });
  noModelCalls();
  expect(await domain(context)).toEqual(before);
  // 집은 요청을 인정하고 성공 시각을 옮긴다. 커서는 그대로다
  const acknowledged = await preservedJob();
  expect(acknowledged).toMatchObject({ requested: jobBefore.requested, processed: jobBefore.requested, cursor: jobBefore.cursor, notBefore: null });
  expect(String(acknowledged.lastSuccess) > String(jobBefore.lastSuccess)).toBe(true);
  expect(await lastErrorCleared()).toBe(true);
  const [released] = await admin`SELECT lease_token,locked_at FROM jobs WHERE name='second-review'`;
  expect(released).toEqual({ lease_token: null, locked_at: null });

  // 다음 poll: 대기 목록에 없고, 집으려 해도 요청이 없다 — 정비를 다시 돌리지 않는다
  const runs = await jobRuns();
  expect(await pendingJobNames("reviewer")).not.toContain("second-review");
  expect(await tick()).toEqual({ status: "skipped", reason: "not_requested" });
  expect(await jobRuns()).toBe(runs);

  // scheduler 의 정기 요청(일정이 찼다)이 다시 깨운다
  expect(await scheduledRequest()).toBeGreaterThan(0);
  expect(await pendingJobNames("reviewer")).toContain("second-review");
  expect(await tick()).toMatchObject({ status: "completed", done: true });
  expect(await preservedJob()).toMatchObject({ requested: jobBefore.requested + 1, processed: jobBefore.requested + 1 });
  expect(await pendingJobNames("reviewer")).not.toContain("second-review");

  // 정비할 일이 생기면 producer(1차 기록·표 기록)가 부르는 requestJob 이 정기 요청을 기다리지 않고 깨운다
  await requestJob("second-review");
  expect(await pendingJobNames("reviewer")).toContain("second-review");
  expect(await tick()).toMatchObject({ status: "completed", done: true });
  expect(await jobRuns()).toBe(runs + 2);
  noModelCalls();
  expect(await domain(context)).toEqual(before);
});

it("items 모드의 정비 틱은 틱 예산이 0 이어도 완료 틱이다", async () => {
  const context = await source();
  await itemsMode();
  const before = await domain(context), jobBefore = await preservedJob();
  expect(await tick(0)).toMatchObject({ status: "completed", done: true });
  noModelCalls();
  expect(await domain(context)).toEqual(before);
  expect(await preservedJob()).toMatchObject({ requested: jobBefore.requested, processed: jobBefore.requested, cursor: jobBefore.cursor });
});

it("items 에서 legacy 로 돌아오면 다음 정기 요청의 틱이 밀린 표를 심사한다", async () => {
  const context = await source();
  await itemsMode();
  expect(await tick()).toMatchObject({ status: "completed", done: true });
  noModelCalls();
  await admin`UPDATE pipeline_stage_modes SET mode='legacy',draining_from=NULL,writer_contract_version=0 WHERE stage='ai2'`;
  // 인정된 요청은 남아 있지 않다 — 돌아온 단계를 집는 것은 다음 정기 요청이다(일정 간격 안)
  expect(await pendingJobNames("reviewer")).not.toContain("second-review");
  expect(await scheduledRequest()).toBeGreaterThan(0);
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(transport.gateway).toHaveBeenCalledTimes(1);
  const [saved] = await db.select().from(secondReviews).where(eq(secondReviews.id, context.vote.id));
  expect(saved).toMatchObject({ status: "agreed", secondDecision: "reject" });
});

it("items 모드에서도 정비가 던진 오류는 종전대로 실패로 적는다 — 요청·성공 시각은 그대로 두고 30초 뒤 다시 본다", async () => {
  const context = await source();
  await itemsMode();
  const before = await domain(context), jobBefore = await preservedJob();
  controller.closeFailure = new Error("maintenance close failure");
  expect(await tick()).toMatchObject({ status: "failed", error: expect.stringContaining("maintenance close failure") });
  noModelCalls();
  expect(await domain(context)).toEqual(before);
  const [failed] = await admin`SELECT last_error,lease_token,locked_at,
    not_before > clock_timestamp() + interval '20 seconds' AND not_before < clock_timestamp() + interval '40 seconds' AS retry
    FROM jobs WHERE name='second-review'`;
  expect(failed).toMatchObject({ last_error: expect.stringContaining("maintenance close failure"), lease_token: null, locked_at: null, retry: true });
  // 요청은 인정되지 않았고(다시 돈다) 성공 시각·커서도 그대로다 — 완료 틱이 실패를 가리지 않는다
  expect({ ...await preservedJob(), notBefore: null }).toEqual(jobBefore);
  expect(await tick()).toEqual({ status: "skipped", reason: "backoff" });

  // 정비가 다시 되면 그 요청을 완료 틱이 인정하고 실패 기록을 지운다
  controller.closeFailure = null;
  await admin`UPDATE jobs SET not_before=NULL WHERE name='second-review'`;
  expect(await tick()).toMatchObject({ status: "completed", done: true });
  expect(await lastErrorCleared()).toBe(true);
  expect(await preservedJob()).toMatchObject({ requested: jobBefore.requested, processed: jobBefore.requested });
});

it("keeps a normal exhausted legacy tick acknowledged without dispatch", async () => {
  const context = await source(), before = await domain(context);
  expect(await tick(0)).toMatchObject({ status: "completed" });
  noModelCalls();
  expect(await domain(context)).toEqual(before);
  const [job] = await admin`SELECT requested_version,processed_version FROM jobs WHERE name='second-review'`;
  expect(Number(job.processed_version)).toBe(Number(job.requested_version));
});

it("settles every admitted lane before returning a midtick stage block", async () => {
  const contexts = [];
  for (let i = 0; i < 5; i++) contexts.push(await source());
  const fifthBefore = await domain(contexts[4]), jobBefore = await preservedJob();
  const started = barrier(), finish = barrier();
  const answer = transport.gateway.getMockImplementation()!;
  let active = 0, peak = 0, settled = 0;
  transport.gateway.mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active);
    if (active === 4) started.resolve();
    await finish.promise;
    active--; settled++;
    return answer(...args);
  });
  const running = tick();
  try {
    await started.promise;
    await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='legacy',writer_contract_version=1 WHERE stage='ai2'`;
    finish.resolve();
    expect(await running).toMatchObject({ status: "deferred", reason: "stage_blocked" });
    expect({ peak, active, settled }).toEqual({ peak: 4, active: 0, settled: 4 });
    expect(transport.gateway).toHaveBeenCalledTimes(4);
    const votes = await admin`SELECT status,second_decision FROM second_reviews WHERE candidate_id=ANY(${contexts.slice(0, 4).map(c => c.candidate.id)}) ORDER BY id`;
    expect(votes).toEqual(Array.from({ length: 4 }, () => ({ status: "agreed", second_decision: "reject" })));
    expect(await domain(contexts[4])).toEqual(fifthBefore);
    // 2026-11-01: 투표 4건을 끝낸 뒤의 stage_blocked 미룸은 processed=4 를 실어 last_success_at 만 앞으로 옮긴다(runner.ts). 요청·커서·일정은 그대로.
    const jobAfter = await preservedJob();
    expect({ ...jobAfter, lastSuccess: jobBefore.lastSuccess }).toEqual(jobBefore);
    expect(String(jobAfter.lastSuccess) > String(jobBefore.lastSuccess)).toBe(true);
    expect(await lastErrorCleared()).toBe(true);
  } finally {
    finish.resolve();
    await running;
  }
});

it.each(["draining", "items"] as const)("preserves concurrent producer and pause changes while actual stage admission waits (%s)", async mode => {
  const context = await source(), before = await domain(context);
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  const locked = barrier<number>(), finish = barrier();
  const holding = blocker.begin(async tx => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT stage FROM pipeline_stage_modes WHERE stage='ai2' FOR UPDATE`;
    locked.resolve(Number(pid));
    await finish.promise;
    await tx`UPDATE pipeline_stage_modes SET mode=${mode},draining_from=${mode === "draining" ? "legacy" : null},
      writer_contract_version=1 WHERE stage='ai2'`;
  });
  let running: ReturnType<typeof tick> | undefined;
  try {
    const pid = await locked.promise;
    running = tick();
    await expect.poll(async () => (await admin`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`)[0].count,
    { timeout: 5_000, interval: 10 }).toBeGreaterThan(0);
    await admin`UPDATE jobs SET requested_version=12,cursor='{"producer":"new-request","page":99}'::jsonb,
      not_before='2101-01-01 00:00:00.123456',last_error='producer history' WHERE name='second-review'`;
    const expectedJob = await preservedJob();
    finish.resolve();
    await holding;
    const result = await running;
    noModelCalls();
    expect(await domain(context)).toEqual(before);
    if (mode === "draining") {
      expect(result).toMatchObject({ status: "deferred", reason: "stage_blocked" });
      expect(await preservedJob()).toEqual(expectedJob);
    } else {
      // items 의 정비 틱은 완료 틱이다: 자기가 집은 요청(11)만 인정한다 — 도는 사이 온 요청(12)과 사람의 멈춤은 그대로 남고,
      // 커서는 lease 를 쥔 이 틱의 것으로 적는다
      expect(result).toMatchObject({ status: "completed", done: true });
      const jobAfter = await preservedJob();
      expect(jobAfter).toMatchObject({ requested: 12, processed: 11, notBefore: expectedJob.notBefore,
        cursor: { marker: "pr04-resume", page: 7 } });
      expect(String(jobAfter.lastSuccess) > String(expectedJob.lastSuccess)).toBe(true);
    }
    expect(await lastErrorCleared()).toBe(true);
  } finally {
    finish.resolve();
    await Promise.allSettled([holding, ...(running ? [running] : [])]);
    await blocker.end({ timeout: 3 });
  }
});

it.each(["draining", "items"] as const)("does not unlock or acknowledge a replacement job owner after a stage wait (%s)", async mode => {
  const context = await source(), before = await domain(context);
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  const locked = barrier<number>(), finish = barrier();
  const holding = blocker.begin(async tx => {
    const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT stage FROM pipeline_stage_modes WHERE stage='ai2' FOR UPDATE`;
    locked.resolve(Number(pid));
    await finish.promise;
    await tx`UPDATE pipeline_stage_modes SET mode=${mode},draining_from=${mode === "draining" ? "legacy" : null},
      writer_contract_version=1 WHERE stage='ai2'`;
  });
  let running: ReturnType<typeof tick> | undefined;
  try {
    const pid = await locked.promise;
    running = tick();
    await expect.poll(async () => (await admin`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND ${pid} = ANY(pg_blocking_pids(pid))`)[0].count,
    { timeout: 5_000, interval: 10 }).toBeGreaterThan(0);
    await admin`UPDATE jobs SET lease_token=${randomUUID()},locked_at=clock_timestamp(),requested_version=14,
      cursor='{"owner":"replacement"}'::jsonb WHERE name='second-review'`;
    const expectedJobs = await managedJobRows();
    finish.resolve();
    await holding;
    expect(await running).toMatchObject({ status: "failed" });
    noModelCalls();
    expect(await domain(context)).toEqual(before);
    expect(await managedJobRows()).toEqual(expectedJobs);
  } finally {
    finish.resolve();
    await Promise.allSettled([holding, ...(running ? [running] : [])]);
    await blocker.end({ timeout: 3 });
  }
});

it.each(["cancelled", "late_success"] as const)("settles an awaited %s without a failed vote or outbox", async kind => {
  const context = await source(), before = await domain(context);
  const started = barrier(), finish = barrier(), stopping = new AbortController();
  const answer = transport.gateway.getMockImplementation()!;
  transport.gateway.mockImplementation(async (...args) => {
    started.resolve();
    await finish.promise;
    return kind === "cancelled" ? { ok: false, error: "cancelled" } : answer(...args);
  });
  const running = runJob("second-review", secondReviewCandidates,
    { requestedOnly: true, budgetMs: 110_000, signal: stopping.signal });
  try {
    await started.promise;
    if (kind === "late_success") stopping.abort();
    // An unsettled external call still owns the worker job. No early success or
    // token release is inferred from the cancellation signal.
    expect(await domain(context)).toEqual(before);
    const [owned] = await admin`SELECT lease_token,locked_at FROM jobs WHERE name='second-review'`;
    expect(owned.lease_token).not.toBeNull();
    expect(owned.locked_at).not.toBeNull();
    finish.resolve();
    expect(await running).toMatchObject({ status: "completed", done: true });
    expect(await domain(context)).toEqual(before);
    expect(transport.gateway).toHaveBeenCalledTimes(1);
    const [released] = await admin`SELECT lease_token,locked_at FROM jobs WHERE name='second-review'`;
    expect(released).toEqual({ lease_token: null, locked_at: null });
  } finally {
    finish.resolve();
    await running;
  }
});

it("keeps a policy-changed result pending without counting it and recovers with fresh admission", async () => {
  const context = await source(), before = await domain(context);
  const started = barrier(), finish = barrier();
  const answer = transport.gateway.getMockImplementation()!;
  transport.gateway.mockImplementationOnce(async (...args) => {
    started.resolve();
    await finish.promise;
    return answer(...args);
  });
  const running = tick();
  try {
    await started.promise;
    const current = fixtureSettings();
    current.secondReview.agreeAt = 0.88;
    await db.update(crawlSettings).set({ values: current }).where(eq(crawlSettings.id, 1));
    finish.resolve();
    expect(await running).toMatchObject({ status: "completed", done: true });
    expect(await domain(context)).toEqual(before);
    expect(transport.gateway).toHaveBeenCalledTimes(1);
    expect(await runJob("second-review", secondReviewCandidates, { budgetMs: 110_000 }))
      .toMatchObject({ status: "completed", done: false });
    expect(transport.gateway).toHaveBeenCalledTimes(2);
    const [saved] = await db.select().from(secondReviews).where(eq(secondReviews.id, context.vote.id));
    expect(saved).toMatchObject({ status: "agreed", secondDecision: "reject", failureCount: 0 });
  } finally {
    finish.resolve();
    await running;
  }
});

it("preserves a human decision when an admitted result becomes context-invalid", async () => {
  const context = await source();
  const started = barrier(), finish = barrier();
  const answer = transport.gateway.getMockImplementation()!;
  transport.gateway.mockImplementationOnce(async (...args) => {
    started.resolve();
    await finish.promise;
    return answer(...args);
  });
  const running = tick();
  try {
    await started.promise;
    await admin`UPDATE crawl_candidates SET state='rejected',reason='not_a_product',decided_by='admin',
      updated_at=clock_timestamp() WHERE id=${context.candidate.id}`;
    const humanState = await domain(context);
    finish.resolve();
    expect(await running).toMatchObject({ status: "completed", done: true });
    const after = await domain(context);
    expect({ ...after, votes: humanState.votes }).toEqual(humanState);
    expect(after.votes).toMatchObject([{ status: "resolved", resolution: "superseded", failure_count: 0,
      second_decision: null, second_reason: null }]);
    expect(transport.gateway).toHaveBeenCalledTimes(1);
  } finally {
    finish.resolve();
    await running;
  }
});
