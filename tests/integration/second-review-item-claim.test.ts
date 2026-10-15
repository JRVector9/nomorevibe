import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews,
  jobs, pipelineItemLeases, pipelineStageModes, products, cdnPurges, operationsObservations } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash, reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { secondReviewGeneration, lockSecondReviewDomain } from "@/lib/crawl/second-review-input";
import { publishedInputHash } from "@/lib/crawl/second-review";
import { markPublished } from "@/lib/crawl/repository";
import { removeProductAndEvidence } from "@/lib/domain/products/repository";
import { admitLegacySecondReview, canStartLegacySecondReview, claimItemSecondReview,
  assertSecondReviewOwnership, finishSecondReviewOwnership, renewSecondReviewOwnership,
  type Ai2ItemLease, type SecondReviewClaim, type SecondReviewReceipt } from "@/lib/crawl/second-review-ownership";
import { lockPipelineInputStages } from "@/lib/crawl/pipeline-stage-context";
import { runJob } from "@/lib/jobs/runner";
import { requestJob, type JobLease } from "@/lib/jobs/control";
import { itemBindingHash } from "@/lib/jobs/items/types";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { ReplayLedger } from "@/lib/operations/pipeline-replay-ledger";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { withReplayFinalScope } from "@/lib/operations/pipeline-replay-final";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

const prefix = "pr04-foundation/", slugPrefix = "pr04-foundation-";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04-foundation-admin", statement_timeout: 8_000 } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04-foundation-observer", statement_timeout: 8_000 } });
const owner = { instanceId: "pr04-foundation-a", bootId: "00000000-0000-4000-8000-000000000041" };
const foreign = { instanceId: "pr04-foundation-b", bootId: "00000000-0000-4000-8000-000000000042" };
const jobNames = ["second-review", "crawl-publish"];
let sequence = 0, initialized = false;
let settingsRows: unknown[] = [], stageRows: Record<string, unknown>[] = [], jobRows: Record<string, unknown>[] = [], observationRows: unknown[] = [];
const sentinelName = `pr04-foundation-unrelated-${randomUUID().slice(0, 8)}`;
let sentinelRow: unknown, foreignRows: unknown;

async function wholeSnapshot() {
  const [snapshot] = await admin`SELECT jsonb_build_object(
    'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM products p),
    'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM crawl_candidates c),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM crawl_documents d),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM crawl_review_attempts a),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM second_reviews s),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s),
    'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY key),'[]'::jsonb) FROM operations_observations o),
    'purges',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM cdn_purges p)) AS value`;
  return snapshot.value;
}

async function restoreManagedRows() {
  // Existing managed rows are updated in place. Only rows this file created
  // from an absent baseline may be deleted. Raw recordsets preserve µs/JSON.
  const absentJobs = jobNames.filter(name => !jobRows.some(row => row.name === name));
  if (absentJobs.length) await db.delete(jobs).where(inArray(jobs.name, absentJobs));
  if (jobRows.length) await admin`UPDATE jobs j SET
    requested_version=r.requested_version, processed_version=r.processed_version,
    locked_at=r.locked_at, lease_token=r.lease_token, not_before=r.not_before,
    cursor=r.cursor, runs=r.runs, last_run_at=r.last_run_at, last_success_at=r.last_success_at,
    last_error=r.last_error, worker_seen_at=r.worker_seen_at, updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::jobs, ${JSON.stringify(jobRows)}::text::jsonb) r WHERE j.name=r.name`;
  if (observationRows.length) await admin`UPDATE operations_observations o SET value=r.value, observed_at=r.observed_at
    FROM jsonb_populate_recordset(NULL::operations_observations, ${JSON.stringify(observationRows)}::text::jsonb) r WHERE o.key=r.key`;
  else await db.delete(operationsObservations).where(eq(operationsObservations.key, "job:second-review"));
  if (settingsRows.length) await admin`UPDATE crawl_settings s SET values=r.values, updated_by=r.updated_by
    FROM jsonb_populate_recordset(NULL::crawl_settings, ${JSON.stringify(settingsRows)}::text::jsonb) r WHERE s.id=r.id`;
  else await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
}

function settings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "second-model" }],
      fallbacks: [{ provider: "abcllm", model: "backup-model" }] } };
}

async function cleanup() {
  await admin`DROP TRIGGER IF EXISTS pr04_foundation_outbox_failure ON jobs`;
  await admin`DROP FUNCTION IF EXISTS pr04_foundation_outbox_failure()`;
  await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr04-foundation/%')`;
  await db.delete(secondReviews).where(like(secondReviews.repo, `${prefix}%`));
  const candidates = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  if (candidates.length) await db.delete(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, candidates.map(row => row.id)));
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
  await db.delete(products).where(like(products.slug, `${slugPrefix}%`));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${slugPrefix}%`));
  await restoreManagedRows();
  for (const row of stageRows) await admin`UPDATE pipeline_stage_modes SET
    mode=${row.mode as string}, draining_from=${row.draining_from as string | null}, epoch=${row.epoch as number},
    writer_contract_version=${row.writer_contract_version as number}
    WHERE stage=${row.stage as string}`;
}

beforeAll(async () => {
  ensureSchema();
  settingsRows = [...await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`].map(row => row.row);
  stageRows = [...await admin`SELECT to_jsonb(s) AS row FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.row);
  jobRows = [...await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=ANY(${jobNames}) ORDER BY name`].map(row => row.row);
  observationRows = [...await admin`SELECT to_jsonb(o) AS row FROM operations_observations o WHERE key='job:second-review'`].map(row => row.row);
  foreignRows = await wholeSnapshot();
  initialized = true;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES (${sentinelName},13,5,'{"marker":"unrelated","page":71}'::jsonb,
      '2101-01-01 00:00:00.654321'::timestamp,'2026-10-16 01:02:03.654321'::timestamp)`;
  [sentinelRow] = [...await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${sentinelName}`].map(row => row.row);
});
beforeEach(async () => {
  await cleanup();
  await db.update(jobs).set({ lockedAt: null, leaseToken: null, notBefore: null }).where(eq(jobs.name, "second-review"));
  await db.update(jobs).set({ requestedVersion: 0 }).where(eq(jobs.name, "crawl-publish"));
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: "pr04-foundation" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: "pr04-foundation" } });
});
afterEach(async () => {
  expect([...await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${sentinelName}`].map(row => row.row)).toEqual([sentinelRow]);
});
afterAll(async () => {
  try {
    if (initialized) {
      await cleanup();
      await db.delete(jobs).where(eq(jobs.name, sentinelName));
      expect([...await admin`SELECT to_jsonb(s) AS row FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.row)).toEqual(stageRows);
      expect([...await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`].map(row => row.row)).toEqual(settingsRows);
      expect([...await admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=ANY(${jobNames}) ORDER BY name`].map(row => row.row)).toEqual(jobRows);
      expect([...await admin`SELECT to_jsonb(o) AS row FROM operations_observations o WHERE key='job:second-review'`].map(row => row.row)).toEqual(observationRows);
      expect(await db.select().from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`))).toEqual([]);
      expect(await db.select().from(pipelineItemLeases).where(like(pipelineItemLeases.ownerInstanceId, "pr04-foundation%"))).toEqual([]);
      expect(await wholeSnapshot()).toEqual(foreignRows);
    }
  } finally { await Promise.all([admin.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

async function fixture(published = false) {
  const policy = settings(), repo = `${prefix}app-${++sequence}`, now = new Date();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://pr04-foundation-${sequence}.test`,
    state: published ? "published" : "approved", publishedSlug: published ? `${slugPrefix}${sequence}` : null,
    reason: "passed", decidedBy: "auto", judgedAt: now, decidedAt: now }).returning();
  const productValues = { slug: `${slugPrefix}${sequence}`, url: candidate.productUrl!, repoUrl: `https://github.com/${repo}`,
    name: "Foundation", tagline: "Manage projects", description: "A deployed task application", category: "Dev",
    status: "seeded" as const, source: "crawler" as const, verifyToken: randomUUID(), editTokenHash: "a".repeat(64) };
  const product = published ? (await db.insert(products).values(productValues).returning())[0] : null;
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl,
    fetchedAt: now, pageStatus: 200, repoMeta: { description: "A project management application", stargazers_count: 12 },
    pageMeta: { title: "Foundation", description: "Create projects and manage tasks", textSample: "Manage tasks online" } }).returning();
  const input = await loadReviewInput(candidate, document, policy);
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "first-model", attemptNumber: 1, leaseToken: randomUUID(),
    outcome: { decision: "approve", confidence: 0.94, reason: "A deployed application", evidenceIds: ["product"] },
    validUntil: input.validUntil, completedAt: now }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: published ? "sample" : "ai_approved",
    publishedSlug: candidate.publishedSlug, firstDecision: "approve", firstConfidence: published ? null : 0.94,
    firstModel: published ? null : first.model, firstAttemptId: published ? null : first.id,
    generationKey: secondReviewGeneration(published ? null : first.id, input, published ? "sample" : "ai_approved"),
    inputHash: published ? publishedInputHash(candidate.publishedSlug!) : input.inputHash,
    provider: "abcllm", model: "second-model" }).returning();
  return { candidate, document, first, row, input, product, productValues };
}

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`actual DB predicate not reached: ${label}`);
}

async function mode(value: "legacy" | "items" | "draining", contract = value === "legacy" ? 0 : 1) {
  await db.update(pipelineStageModes).set({ mode: value, drainingFrom: value === "draining" ? "items" : null,
    writerContractVersion: contract }).where(eq(pipelineStageModes.stage, "ai2"));
}

async function withJob(body: (lease: JobLease) => Promise<void>) {
  const result = await runJob<null>("second-review", async ctx => {
    if (!ctx.lease) throw new Error("actual job lease missing");
    await body(ctx.lease); return { done: true };
  });
  expect(result.status).toBe("completed");
}

function receipt(claim: SecondReviewClaim): SecondReviewReceipt {
  expect(["admitted", "claimed"]).toContain(claim.kind);
  if (claim.kind === "skipped") throw new Error(`claim skipped: ${claim.reason}`);
  return claim.receipt;
}

function itemReceipt(claim: SecondReviewClaim): SecondReviewReceipt & { ownership: { kind: "item"; lease: Ai2ItemLease } } {
  const proof = receipt(claim);
  expect(proof.ownership.kind).toBe("item");
  if (proof.ownership.kind !== "item") throw new Error("expected item");
  return { ...proof, ownership: proof.ownership };
}

async function owned(proof: SecondReviewReceipt, write?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
  return db.transaction(async tx => {
    const guards = await lockPipelineInputStages(tx);
    const current = await lockSecondReviewDomain(tx, proof.binding.secondReviewId);
    const [row] = await tx.select().from(secondReviews).where(eq(secondReviews.id, proof.binding.secondReviewId));
    await assertSecondReviewOwnership(tx, guards.ai2, proof, row);
    if (write) await write(tx);
    await finishSecondReviewOwnership(tx, guards.ai2, proof);
    return current;
  });
}

async function snapshot(id: number) {
  const [value] = await admin`SELECT jsonb_build_object(
    'review',(SELECT to_jsonb(r) FROM second_reviews r WHERE id=${id}),
    'item',(SELECT to_jsonb(i) FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${id}`}),
    'job',(SELECT to_jsonb(j) FROM jobs j WHERE name='crawl-publish')) AS value`;
  return value.value;
}

it("admits a pending legacy vote under the actual live job without creating an item", async () => {
  const { row } = await fixture();
  await withJob(async job => {
    expect(await canStartLegacySecondReview(job)).toBe(true);
    const claim = await admitLegacySecondReview(row.id, job);
    expect(claim.kind).toBe("admitted");
    expect(receipt(claim).ownership).toMatchObject({ kind: "legacy", job, stageEpoch: 1 });
    expect(await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai2:${row.id}`))).toEqual([]);
  });
});

it("claims a real item with exact original binding and renews the same owner", async () => {
  const { row } = await fixture();
  await mode("items");
  const claim = await claimItemSecondReview(row.id, owner, 10_000);
  expect(claim.kind).toBe("claimed");
  const proof = receipt(claim);
  expect(proof.ownership.kind).toBe("item");
  if (proof.ownership.kind !== "item") throw new Error("expected item");
  const [persisted] = await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai2:${row.id}`));
  expect(persisted).toMatchObject({ ownerInstanceId: owner.instanceId, ownerBootId: owner.bootId,
    token: proof.ownership.lease.token, binding: proof.binding, bindingHash: itemBindingHash(proof.binding), itemEpoch: 1 });
  expect(await renewSecondReviewOwnership({ ...proof, ownership: proof.ownership }, 20_000)).toMatchObject({ token: persisted.token, itemEpoch: 1 });
});

it.each(["legacy", "draining"] as const)("keeps the disconnected item adapter inactive in %s mode", async value => {
  const { row } = await fixture();
  await mode(value);
  expect(await claimItemSecondReview(row.id, owner, 10_000)).toEqual({ kind: "skipped", reason: "stage_inactive" });
  expect(await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai2:${row.id}`))).toEqual([]);
});

it("rejects item admission when the writer contract remains zero", async () => {
  const { row } = await fixture();
  await mode("items", 0);
  expect(await claimItemSecondReview(row.id, owner, 10_000)).toEqual({ kind: "skipped", reason: "stage_inactive" });
});

it("preserves a healthy foreign logical owner across a changed input and legacy mode", async () => {
  const { row, document } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, foreign, 10_000));
  await db.update(crawlDocuments).set({ fetchedAt: new Date(+document.fetchedAt + 1) }).where(eq(crawlDocuments.id, document.id));
  await mode("legacy"); // Fixture only: production transitions cannot skip drain.
  const before = await snapshot(row.id);
  await withJob(async job => {
    expect(await admitLegacySecondReview(row.id, job)).toEqual({ kind: "skipped", reason: "running" });
    expect(await snapshot(row.id)).toEqual(before);
  });
  expect(proof.binding.inputHash).toBe(row.inputHash);
});

it("protects a fallback chain's healthy primary owner", async () => {
  const { row } = await fixture();
  await mode("items");
  itemReceipt(await claimItemSecondReview(row.id, foreign, 10_000));
  await db.update(secondReviews).set({ status: "resolved", resolution: "fallback" }).where(eq(secondReviews.id, row.id));
  const [child] = await db.insert(secondReviews).values({ ...row, id: undefined, model: "backup-model", fallbackForId: row.id }).returning();
  const before = await snapshot(row.id);
  expect(await claimItemSecondReview(child.id, owner, 10_000)).toEqual({ kind: "skipped", reason: "running" });
  expect(await snapshot(row.id)).toEqual(before);
  expect(await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai2:${child.id}`))).toEqual([]);
});

it("allows different primary slots to acquire separate item ownership", async () => {
  const { row } = await fixture(), policy = settings();
  policy.secondReview.voters.push({ provider: "abcllm", model: "another-second" });
  await db.update(crawlSettings).set({ values: policy }).where(eq(crawlSettings.id, 1));
  const [other] = await db.insert(secondReviews).values({ ...row, id: undefined, model: "another-second" }).returning();
  await mode("items");
  itemReceipt(await claimItemSecondReview(row.id, owner, 10_000));
  itemReceipt(await claimItemSecondReview(other.id, foreign, 10_000));
  expect((await db.select().from(pipelineItemLeases).where(inArray(pipelineItemLeases.workKey, [`ai2:${row.id}`, `ai2:${other.id}`]))).length).toBe(2);
});

it("closes only the invalid pending legacy row under the actual job", async () => {
  const { row, document } = await fixture();
  await db.update(crawlDocuments).set({ fetchedAt: new Date(+document.fetchedAt + 1) }).where(eq(crawlDocuments.id, document.id));
  await withJob(async job => {
    expect(await admitLegacySecondReview(row.id, job)).toEqual({ kind: "skipped", reason: "input_changed" });
  });
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, row.id))).toMatchObject([{ status: "resolved", resolution: "superseded" }]);
});

it("does not mutate invalid input before acquiring an item", async () => {
  const { row, document } = await fixture();
  await mode("items");
  await db.update(crawlDocuments).set({ fetchedAt: new Date(+document.fetchedAt + 1) }).where(eq(crawlDocuments.id, document.id));
  const before = await snapshot(row.id);
  expect(await claimItemSecondReview(row.id, owner, 10_000)).toEqual({ kind: "skipped", reason: "input_changed" });
  expect(await snapshot(row.id)).toEqual(before);
});

it("rolls back private invalidation when the actual legacy job token changed", async () => {
  const { row, document } = await fixture();
  await db.update(crawlDocuments).set({ fetchedAt: new Date(+document.fetchedAt + 1) }).where(eq(crawlDocuments.id, document.id));
  await withJob(async job => {
    const before = await snapshot(row.id);
    await expect(admitLegacySecondReview(row.id, { ...job, token: randomUUID() })).rejects.toThrow("job_lease_lost");
    expect(await snapshot(row.id)).toEqual(before);
  });
});

it("rejects an original legacy source hash inconsistent with the actual generation", async () => {
  const { row } = await fixture();
  await withJob(async job => {
    const proof = receipt(await admitLegacySecondReview(row.id, job));
    const forged = { ...proof, binding: { ...proof.binding, sourceRevisionHash: "a".repeat(64) } };
    const before = await snapshot(row.id);
    await expect(owned(forged)).rejects.toThrow("invalid_second_review_receipt");
    expect(await snapshot(row.id)).toEqual(before);
  });
});

it.each(["source", "human", "policy"] as const)("renews and settles the original item after a current %s change", async change => {
  const { row, document, candidate } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000));
  if (change === "source") await db.update(crawlDocuments).set({ fetchedAt: new Date(+document.fetchedAt + 1) }).where(eq(crawlDocuments.id, document.id));
  if (change === "human") await db.update(crawlCandidates).set({ state: "needs_review", decidedBy: "admin" }).where(eq(crawlCandidates.id, candidate.id));
  if (change === "policy") {
    const policy = settings(); policy.secondReview.agreeAt = 0.87;
    await db.update(crawlSettings).set({ values: policy }).where(eq(crawlSettings.id, 1));
  }
  expect(await renewSecondReviewOwnership(proof, 20_000)).toMatchObject({ token: proof.ownership.lease.token });
  const current = await owned(proof);
  if (change !== "policy") expect(current).toBeNull();
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, row.id))).toEqual([row]);
  expect(await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai2:${row.id}`)))
    .toMatchObject([{ token: null, ownerInstanceId: null, ownerBootId: null, leaseUntil: null }]);
});

it.each(["token", "instance", "boot", "itemEpoch", "stageEpoch", "binding", "malformedOwner", "row"] as const)("rejects altered %s proof without changing domain or owner", async field => {
  const { row } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000)), forged = { ...structuredClone(proof) };
  const lease = forged.ownership.lease;
  if (field === "token") forged.ownership.lease = { ...lease, token: randomUUID() };
  if (field === "instance") forged.ownership.lease = { ...lease, owner: { ...lease.owner, instanceId: foreign.instanceId } };
  if (field === "boot") forged.ownership.lease = { ...lease, owner: foreign };
  if (field === "itemEpoch") forged.ownership.lease = { ...lease, itemEpoch: lease.itemEpoch + 1 };
  if (field === "stageEpoch") forged.ownership.lease = { ...lease, stageEpoch: lease.stageEpoch + 1 };
  if (field === "binding") {
    forged.binding = { ...forged.binding, policyHash: "a".repeat(64) };
    forged.ownership.lease = { ...lease, binding: forged.binding, bindingHash: itemBindingHash(forged.binding) };
  }
  if (field === "malformedOwner") forged.ownership.lease = { ...lease, owner: { ...lease.owner, bootId: "not-a-uuid" } };
  if (field === "row") forged.binding = { ...forged.binding, secondReviewId: row.id + 1 };
  const before = await snapshot(row.id);
  await expect(owned(forged)).rejects.toThrow();
  expect(await snapshot(row.id)).toEqual(before);
});

it("permits the old expiry observation after heartbeat but rejects a duplicate released owner", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000));
  const renewed = await renewSecondReviewOwnership(proof, 20_000);
  expect(renewed!.leaseUntil > proof.ownership.lease.leaseUntil).toBe(true);
  await owned(proof);
  await expect(owned(proof)).rejects.toThrow("item_lease_lost");
});

it("supports original item completion while draining but rejects a changed stage epoch", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000));
  await mode("draining");
  expect(await renewSecondReviewOwnership(proof, 20_000)).toMatchObject({ token: proof.ownership.lease.token });
  await db.update(pipelineStageModes).set({ epoch: 2 }).where(eq(pipelineStageModes.stage, "ai2"));
  await expect(owned(proof)).rejects.toThrow("item_lease_lost");
  await db.update(pipelineStageModes).set({ epoch: 1 }).where(eq(pipelineStageModes.stage, "ai2"));
  await owned(proof);
});

it("rejects an authentic guard from a different stage", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000)), before = await snapshot(row.id);
  await expect(db.transaction(async tx => {
    const guards = await lockPipelineInputStages(tx);
    await lockSecondReviewDomain(tx, row.id);
    await assertSecondReviewOwnership(tx, guards.ai1, proof, row);
  })).rejects.toThrow("invalid_second_review_stage_guard");
  expect(await snapshot(row.id)).toEqual(before);
});

it("rolls back an owner write when the release CAS has expired", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000)), before = await snapshot(row.id);
  await expect(owned(proof, async tx => {
    await tx.update(secondReviews).set({ secondReason: "must roll back" }).where(eq(secondReviews.id, row.id));
    await tx.update(pipelineItemLeases).set({ leaseUntil: sql`clock_timestamp() - interval '1 millisecond'` })
      .where(eq(pipelineItemLeases.workKey, `ai2:${row.id}`));
  })).rejects.toThrow("item_lease_lost");
  expect(await snapshot(row.id)).toEqual(before);
});

it("holds S3 before touching the actual candidate domain", async () => {
  const { row, candidate } = await fixture();
  await mode("items");
  const locked = barrier<number>(), release = barrier();
  const blocker = admin.begin(async tx => {
    await tx`SELECT stage FROM pipeline_stage_modes WHERE stage='ai2' FOR UPDATE`;
    const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
    locked.resolve(backend.pid);
    await release.promise;
  });
  const holder = await locked.promise;
  const claim = claimItemSecondReview(row.id, owner, 10_000);
  try {
    await until(async () => {
      const [wait] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE ${holder} = ANY(pg_blocking_pids(pid))) AS blocked`;
      return wait.blocked;
    }, "item admission waits on ai2 stage");
    await observer.begin(async tx => { await tx`SELECT id FROM crawl_candidates WHERE id=${candidate.id} FOR UPDATE NOWAIT`; });
  } finally { release.resolve(); await blocker; }
  expect((await claim).kind).toBe("claimed");
});

it("skips an already locked item row without waiting on its owner", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, foreign, 10_000));
  const locked = barrier(), release = barrier();
  const blocker = admin.begin(async tx => {
    await tx`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${proof.ownership.lease.workKey} FOR UPDATE`;
    locked.resolve(); await release.promise;
  });
  await locked.promise;
  try {
    const result = await Promise.race([claimItemSecondReview(row.id, owner, 10_000),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("item claim blocked")), 2_000); timer.unref(); })]);
    expect(result).toEqual({ kind: "skipped", reason: "running" });
  } finally { release.resolve(); await blocker; }
});

it("preserves original published ownership while distinguishing a new product generation", async () => {
  const { row, candidate, product, productValues } = await fixture(true);
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000));
  expect(proof.binding.source).toEqual({ kind: "published", slug: product!.slug, productId: product!.id });
  expect(await removeProductAndEvidence(product!.id, product!.slug)).toBe(true);
  const [replacement] = await db.insert(products).values(productValues).returning();
  await markPublished(candidate.repo, replacement.slug);
  const current = await db.transaction(async tx => {
    await lockPipelineInputStages(tx);
    return lockSecondReviewDomain(tx, row.id);
  });
  expect(current!.publishedProductId).toBe(replacement.id);
  expect(replacement.id).not.toBe(product!.id);
  // The stale generation is not current result authority. It is still the
  // original, persisted owner while its external work settles.
  expect(proof.binding.source).not.toMatchObject({ productId: replacement.id });
  expect(await renewSecondReviewOwnership(proof, 20_000)).toMatchObject({ token: proof.ownership.lease.token });
  await owned(proof);
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, row.id)))[0]).toEqual(row);
});

it("rolls back domain and owner when a downstream outbox write fails", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = itemReceipt(await claimItemSecondReview(row.id, owner, 10_000)), before = await snapshot(row.id);
  await admin`CREATE FUNCTION pr04_foundation_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.name='crawl-publish' THEN RAISE EXCEPTION 'pr04_foundation_outbox_failed'; END IF; RETURN NEW; END $$`;
  await admin`CREATE TRIGGER pr04_foundation_outbox_failure BEFORE INSERT OR UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION pr04_foundation_outbox_failure()`;
  await expect(owned(proof, async tx => {
    await tx.update(secondReviews).set({ secondReason: "must roll back" }).where(eq(secondReviews.id, row.id));
    await requestJob("crawl-publish", tx);
  })).rejects.toMatchObject({ cause: { message: "pr04_foundation_outbox_failed" } });
  expect(await snapshot(row.id)).toEqual(before);
});

it("checks actual job wall time after waiting and rolls every write back", async () => {
  const { row } = await fixture();
  const result = await runJob<null>("second-review", async ctx => {
    if (!ctx.lease) throw new Error("actual job lease missing");
    const proof = receipt(await admitLegacySecondReview(row.id, ctx.lease));
    await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '89 seconds' WHERE name='second-review'`;
    const before = await snapshot(row.id), locked = barrier<number>(), release = barrier(), writer = barrier<number>();
    const blocker = admin.begin(async tx => {
      await tx`SELECT name FROM jobs WHERE name='second-review' FOR UPDATE`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      locked.resolve(backend.pid); await release.promise;
    });
    const holder = await locked.promise;
    const write = owned(proof, async tx => {
      await tx.update(secondReviews).set({ secondReason: "must roll back after wall expiry" }).where(eq(secondReviews.id, row.id));
      await requestJob("crawl-publish", tx);
      const [beforeWait] = await tx.execute<{ pid: number; healthy: boolean }>(sql`SELECT pg_backend_pid() AS pid,
        (SELECT locked_at >= now()-interval '90 seconds' FROM jobs WHERE name='second-review') AS healthy`);
      expect(beforeWait.healthy).toBe(true);
      writer.resolve(beforeWait.pid);
    });
    // Attach the rejection handler immediately, before releasing the blocker.
    const rejected = expect(write).rejects.toThrow("job_lease_lost");
    try {
      const waiter = await writer.promise;
      await until(async () => {
        const [state] = await observer`SELECT ${holder}=ANY(pg_blocking_pids(${waiter})) AS blocked`;
        return state.blocked;
      }, "writer waits on exact job owner");
      await until(async () => {
        const [state] = await observer`SELECT locked_at < clock_timestamp()-interval '90 seconds' AS expired
          FROM jobs WHERE name='second-review'`;
        return state.expired;
      }, "job expired according to DB wall clock");
    } finally { release.resolve(); await blocker; }
    await rejected;
    expect(await snapshot(row.id)).toEqual(before);
    return { done: true };
  });
  expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
});

it("rolls back invalidation when a nondeferred replay recorder wait outlives the actual job", async () => {
  const value = await fixture(), reference = new Date(), policy = settings();
  const reviewer = (model: { provider: "abcllm" | "claude-cli" | "grok-cli"; model: string }) =>
    ({ ...model, canonicalModel: canonicalReviewModel(model.model) });
  const manifest: CapacityManifest = { version: 1, runId: `pr04-foundation-${randomUUID()}`, revision: "614fac5",
    mode: "fixtures", cacheMode: "cold", referenceTime: reference.toISOString(), startedAt: reference.toISOString(),
    endedAt: new Date(+reference + 10_000).toISOString(), inputPolicyHash: reviewPolicyHash(policy),
    fullReviewPolicyHash: fullReviewPolicyHash(policy), comparisonPolicyHash: comparisonReviewPolicyHash(policy),
    initialStateHash: reviewHash({ candidate: value.candidate, document: value.document }),
    models: { first: reviewer(policy.firstReview!), second: policy.secondReview.voters.map(reviewer),
      fallbacks: policy.secondReview.fallbacks!.map(reviewer) },
    inputs: [{ candidateId: value.candidate.id, inputHash: value.input.inputHash, sourceRevisionHash: value.input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 4 } };
  const before = await snapshot(value.row.id);
  const profile = await getReplayHandlerIdentityPath();
  let database: Awaited<ReturnType<typeof openVerifiedReplayHandlerDatabase>> | undefined;
  let ledger: ReplayLedger | undefined;
  const runBlocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04-foundation-run-blocker", statement_timeout: 8_000 } });
  const release = barrier(), locked = barrier<number>();
  let blocking: Promise<unknown> | undefined;
  let admission: PromiseSettledResult<SecondReviewClaim> | undefined;
  let run: Awaited<ReturnType<ReplayLedger["prepare"]>> | undefined;
  try {
    database = await openVerifiedReplayHandlerDatabase(profile.identityPath, {});
    ledger = new ReplayLedger(database);
    run = await ledger.prepare(manifest, [{ candidateId: value.candidate.id, input: value.input }]);
    await ledger.start(run);
    await db.update(crawlCandidates).set({ state: "rejected", decidedBy: "admin" }).where(eq(crawlCandidates.id, value.candidate.id));
    blocking = runBlocker.begin(async tx => {
      await tx`SELECT run_id FROM pipeline_replay.capacity_runs WHERE run_id=${run!.runId} FOR UPDATE`;
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      locked.resolve(backend.pid); await release.promise;
    });
    const holder = await locked.promise;
    const result = await withReplayDatabaseScope(profile.identityPath, () =>
      withReviewReplayContext({ referenceTime: reference }, () => withReplayFinalScope(run!, () =>
        runJob<null>("second-review", async ctx => {
          if (!ctx.lease) throw new Error("actual job lease missing");
          await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '89 seconds' WHERE name='second-review'`;
          const attempt = admitLegacySecondReview(value.row.id, ctx.lease).then(
            answer => ({ status: "fulfilled" as const, value: answer }), reason => ({ status: "rejected" as const, reason }));
          try {
            await until(async () => {
              const [waiting] = await observer`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                WHERE query ILIKE '%capacity_runs%' AND ${holder}=ANY(pg_blocking_pids(pid))) AS blocked`;
              return waiting.blocked;
            }, "actual nondeferred recorder waits for run row");
            await until(async () => {
              const [job] = await observer`SELECT locked_at < clock_timestamp()-interval '90 seconds' AS expired
                FROM jobs WHERE name='second-review'`;
              return job.expired;
            }, "actual job expires during recorder wait");
          } finally { release.resolve(); await blocking; }
          admission = await attempt;
          return { done: true };
        }))));
    expect(result).toMatchObject({ status: "failed", error: "job_lease_lost" });
    expect(admission?.status).toBe("rejected");
    if (admission?.status === "rejected") expect(admission.reason).toHaveProperty("message", "job_lease_lost");
    expect(await snapshot(value.row.id)).toEqual(before);
    expect(await admin`SELECT 1 FROM pipeline_replay.capacity_transitions
      WHERE run_id=${run.runId} AND kind='second_review_superseded'`).toEqual([]);
  } finally {
    release.resolve();
    try { await blocking; if (run && ledger) await ledger.drain(run); }
    finally {
      try { await database?.close(); }
      finally { try { await runBlocker.end({ timeout: 3 }); } finally { await profile.release(); } }
    }
  }
});
