import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs,
  operationsObservations, pipelineItemLeases, pipelineStageModes, products, secondReviews } from "@/lib/db/schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { publishedInputHash, recordSecondReview } from "@/lib/crawl/second-review";
import { markPublished } from "@/lib/crawl/repository";
import { removeProductAndEvidence } from "@/lib/domain/products/repository";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { admitLegacySecondReview, claimItemSecondReview, type SecondReviewClaim,
  type SecondReviewReceipt } from "@/lib/crawl/second-review-ownership";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

const prefix = "pr04b-results/", slugPrefix = "pr04b-results-";
const managedJobs = ["second-review", "crawl-publish"];
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04b-results-admin", statement_timeout: 8_000 } });
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04b-results-blocker", statement_timeout: 8_000 } });
const foreign = { instanceId: "pr04b-results-foreign", bootId: "00000000-0000-4000-8000-000000000094" };
const owner = { instanceId: "pr04b-results-owner", bootId: "00000000-0000-4000-8000-000000000095" };
const sentinelName = `pr04b-results-unrelated-${randomUUID().slice(0, 8)}`;
let sequence = 0, initialized = false;
let originalSettings: unknown[] = [], originalJobs: { name: string }[] = [], originalStages: unknown[] = [];
let originalObservation: unknown[] = [], baseline: unknown, sentinel: unknown;

function policy(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first-model" }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "second-model" }],
      fallbacks: [{ provider: "abcllm", model: "backup-model" }] } };
}

async function wholeSnapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'candidates',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM crawl_candidates c),
    'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM crawl_documents d),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM crawl_review_attempts a),
    'votes',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM second_reviews s),
    'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM products p),
    'purges',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM cdn_purges p),
    'observations',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY key),'[]'::jsonb) FROM operations_observations o)) AS value`;
  return row.value;
}

async function restoreSharedRows() {
  const absent = managedJobs.filter(name => !originalJobs.some(row => row.name === name));
  if (absent.length) await db.delete(jobs).where(inArray(jobs.name, absent));
  if (originalJobs.length) await admin`UPDATE jobs j SET requested_version=r.requested_version,
    processed_version=r.processed_version,next_scheduled_at=r.next_scheduled_at,not_before=r.not_before,
    lease_token=r.lease_token,worker_seen_at=r.worker_seen_at,cursor=r.cursor,locked_at=r.locked_at,
    last_run_at=r.last_run_at,last_success_at=r.last_success_at,last_error=r.last_error,runs=r.runs,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs)}::text::jsonb) r WHERE j.name=r.name`;
  if (originalSettings.length) await admin`UPDATE crawl_settings s SET values=r.values,updated_by=r.updated_by
    FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb) r WHERE s.id=r.id`;
  else await db.delete(crawlSettings).where(eq(crawlSettings.id, 1));
  if (originalObservation.length) await admin`UPDATE operations_observations o SET value=r.value,observed_at=r.observed_at
    FROM jsonb_populate_recordset(NULL::operations_observations,${JSON.stringify(originalObservation)}::text::jsonb) r WHERE o.key=r.key`;
  else await db.delete(operationsObservations).where(eq(operationsObservations.key, "job:second-review"));
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,epoch=r.epoch,
    writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
}

async function cleanup() {
  await admin`DROP TRIGGER IF EXISTS pr04b_results_outbox_failure ON jobs`;
  await admin`DROP FUNCTION IF EXISTS pr04b_results_outbox_failure()`;
  await admin`DROP TRIGGER IF EXISTS pr04b_results_release_failure ON pipeline_item_leases`;
  await admin`DROP FUNCTION IF EXISTS pr04b_results_release_failure()`;
  await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId' IN
    (SELECT id::text FROM crawl_candidates WHERE repo LIKE 'pr04b-results/%')`;
  await db.delete(secondReviews).where(like(secondReviews.repo, `${prefix}%`));
  const ids = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  if (ids.length) await db.delete(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, ids.map(row => row.id)));
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`));
  await db.delete(crawlDocuments).where(like(crawlDocuments.repo, `${prefix}%`));
  await db.delete(products).where(like(products.slug, `${slugPrefix}%`));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${slugPrefix}%`));
}

beforeAll(async () => {
  ensureSchema();
  originalSettings = [...await admin`SELECT to_jsonb(s) AS value FROM crawl_settings s WHERE id=1`].map(row => row.value);
  originalJobs = [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=ANY(${managedJobs}) ORDER BY name`].map(row => row.value);
  originalStages = [...await admin`SELECT to_jsonb(s) AS value FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.value);
  originalObservation = [...await admin`SELECT to_jsonb(o) AS value FROM operations_observations o WHERE key='job:second-review'`].map(row => row.value);
  baseline = await wholeSnapshot();
  initialized = true;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES(${sentinelName},13,5,'{"untouched":true}'::jsonb,'2101-01-01 00:00:00.654321'::timestamp,
      '2001-02-03 04:05:06.123456'::timestamp)`;
  [sentinel] = [...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=${sentinelName}`].map(row => row.value);
});
beforeEach(async () => {
  await cleanup();
  await restoreSharedRows();
  await db.insert(crawlSettings).values({ id: 1, values: policy(), updatedBy: "pr04b-results" })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: policy(), updatedBy: "pr04b-results" } });
  await db.update(jobs).set({ leaseToken: null, lockedAt: null, notBefore: null }).where(eq(jobs.name, "second-review"));
  await mode("legacy");
});
afterEach(async () => {
  expect([...await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name=${sentinelName}`].map(row => row.value)).toEqual([sentinel]);
});
afterAll(async () => {
  try {
    if (initialized) {
      await cleanup();
      await restoreSharedRows();
      await db.delete(jobs).where(eq(jobs.name, sentinelName));
      expect(await wholeSnapshot()).toEqual(baseline);
      expect(await db.select().from(crawlCandidates).where(like(crawlCandidates.repo, `${prefix}%`))).toEqual([]);
      expect(await db.select().from(pipelineItemLeases).where(like(pipelineItemLeases.ownerInstanceId, "pr04b-results%"))).toEqual([]);
    }
  } finally { await Promise.all([admin.end({ timeout: 3 }), blocker.end({ timeout: 3 })]); }
});

async function mode(value: "legacy" | "items") {
  await db.update(pipelineStageModes).set({ mode: value, drainingFrom: null,
    writerContractVersion: value === "items" ? 1 : 0 }).where(eq(pipelineStageModes.stage, "ai2"));
}

async function fixture(published = false) {
  const settings = policy(), repo = `${prefix}app-${++sequence}`, now = new Date(Date.now() - 2_000);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://pr04b-results-${sequence}.test`,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: now, decidedAt: now }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl,
    fetchedAt: now, pageStatus: 200, repoMeta: { description: "A project management application", stargazers_count: 12 },
    pageMeta: { title: "Results", description: "Create projects and manage tasks", textSample: "Manage tasks online" } }).returning();
  const productValues = { slug: `${slugPrefix}${sequence}`, url: candidate.productUrl!, repoUrl: `https://github.com/${repo}`,
    name: "Results", tagline: "Manage projects", description: "A deployed task application", category: "Dev",
    status: "seeded" as const, source: "crawler" as const, verifyToken: randomUUID(), editTokenHash: "a".repeat(64) };
  const product = published ? (await db.insert(products).values(productValues).returning())[0] : null;
  if (product) await markPublished(repo, product.slug);
  const [current] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id));
  const input = await loadReviewInput(current, document, settings);
  // Historical succeeded input is fixture data; AI2 authority is always issued
  // by actual admitLegacySecondReview / claimItemSecondReview below.
  const [first] = published ? [] : await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: "abcllm", model: "first-model", attemptNumber: 1,
    outcome: { decision: "approve", confidence: .94, reason: "Deployed application", evidenceIds: ["product"] },
    validUntil: input.validUntil, completedAt: now }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo,
    publishedSlug: product?.slug ?? null, trigger: published ? "sample" : "ai_approved",
    firstDecision: "approve", firstConfidence: published ? null : .94, firstModel: first?.model ?? null, firstAttemptId: first?.id ?? null,
    generationKey: secondReviewGeneration(first?.id ?? null, input, published ? "sample" : "ai_approved"),
    inputHash: product ? publishedInputHash(product.slug) : input.inputHash,
    provider: "abcllm", model: "second-model" }).returning();
  return { candidate: current, document, first, row, input, product, productValues };
}

function receipt(claim: SecondReviewClaim): SecondReviewReceipt {
  expect(["claimed", "admitted"]).toContain(claim.kind);
  if (claim.kind === "skipped") throw new Error(`actual claim skipped: ${claim.reason}`);
  return claim.receipt;
}
async function withLegacy(body: (lease: JobLease) => Promise<void>, expected: "completed" | "failed" = "completed") {
  let failure: unknown;
  const result = await runJob<null>("second-review", async ctx => {
    if (!ctx.lease) throw new Error("actual job lease missing");
    try { await body(ctx.lease); } catch (error) { failure = error; throw error; }
    return { done: true };
  });
  if (failure) throw failure;
  expect(result.status).toBe(expected);
}
function approval() {
  return { ok: true as const, decision: "approve", confidence: .95, reason: "Verified product",
    model: "second-model", provider: "abcllm" as const, status: "agreed" as const };
}
async function snapshot(id: number) {
  const [row] = await admin`SELECT jsonb_build_object(
    'vote',(SELECT to_jsonb(s) FROM second_reviews s WHERE id=${id}),
    'candidate',(SELECT to_jsonb(c) FROM crawl_candidates c JOIN second_reviews s ON s.candidate_id=c.id WHERE s.id=${id}),
    'item',(SELECT to_jsonb(i) FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${id}`}),
    'publish',(SELECT to_jsonb(j) FROM jobs j WHERE name='crawl-publish'),
    'chain',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM second_reviews s
      WHERE s.id=${id} OR s.fallback_for_id=${id})) AS value`;
  return row.value;
}

it("records the normal legacy control under an actual job admission", async () => {
  const { row } = await fixture();
  await withLegacy(async job => {
    const proof = receipt(await admitLegacySecondReview(row.id, job));
    expect(proof.ownership.kind).toBe("legacy");
    expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "recorded" });
  });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, row.id)))[0]).toMatchObject({ status: "agreed", secondDecision: "approve" });
});

it("rejects the old receipt-less writer without mutating a healthy foreign logical item", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = receipt(await claimItemSecondReview(row.id, foreign, 30_000));
  expect(proof.ownership.kind).toBe("item");
  const [healthy] = await admin`SELECT token,owner_instance_id,lease_until>clock_timestamp() AS live
    FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`;
  expect(healthy).toMatchObject({ owner_instance_id: foreign.instanceId, live: true });
  const before = await snapshot(row.id);
  const call = await Reflect.apply(recordSecondReview, undefined, [row.id, approval()]).then(
    () => ({ rejected: false }), () => ({ rejected: true }));
  const [stillOwned] = await admin`SELECT token,owner_instance_id,lease_until>clock_timestamp() AS live
    FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`;
  expect(stillOwned).toEqual(healthy);
  // This assertion observes the actual committed domain/outbox mutation first;
  // a missing import or SQL/API error cannot stand in for this behavior RED.
  expect(await snapshot(row.id)).toEqual(before);
  expect(call.rejected).toBe(true);
});

async function claim(id: number, ttlMs = 30_000) {
  return receipt(await claimItemSecondReview(id, owner, ttlMs));
}
async function domainSnapshot(id: number) {
  const value = await snapshot(id);
  return { vote: value.vote, candidate: value.candidate, chain: value.chain, publish: value.publish };
}
async function released(proof: SecondReviewReceipt) {
  expect(proof.ownership.kind).toBe("item");
  if (proof.ownership.kind !== "item") throw new Error("actual item receipt required");
  const [item] = await db.select().from(pipelineItemLeases).where(eq(pipelineItemLeases.workKey, `ai2:${proof.binding.secondReviewId}`));
  expect(item).toMatchObject({ token: null, ownerInstanceId: null, ownerBootId: null, leaseUntil: null,
    itemEpoch: proof.ownership.lease.itemEpoch, binding: proof.binding });
}
async function changeAgreement() {
  const changed = policy();
  changed.secondReview.agreeAt = .9;
  await db.update(crawlSettings).set({ values: changed }).where(eq(crawlSettings.id, 1));
}

it("records and releases an actual item once, then rejects the released receipt", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = await claim(row.id);
  expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "recorded" });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, row.id)))[0]).toMatchObject({ status: "agreed", failureCount: 0 });
  await released(proof);
  const before = await snapshot(row.id);
  await expect(recordSecondReview({ receipt: proof, result: approval() })).rejects.toThrow();
  expect(await snapshot(row.id)).toEqual(before);
});

it("keeps a duplicate legacy result under the same actual job as a no-write terminal result", async () => {
  const { row } = await fixture();
  await withLegacy(async job => {
    const proof = receipt(await admitLegacySecondReview(row.id, job));
    expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "recorded" });
    const before = await snapshot(row.id);
    expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "not_pending" });
    expect(await snapshot(row.id)).toEqual(before);
  });
});

it("keeps a policy-only stale item pending and lets a fresh actual claim review the same logical row", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = await claim(row.id), before = await domainSnapshot(row.id);
  await changeAgreement();
  expect(await recordSecondReview({ receipt: proof, result: approval() }))
    .toEqual({ state: "input_changed", reason: "binding_changed" });
  expect(await domainSnapshot(row.id)).toEqual(before);
  await released(proof);
  const current = await claim(row.id);
  expect(current.binding).toMatchObject({ secondReviewId: row.id, generationKey: proof.binding.generationKey,
    inputHash: proof.binding.inputHash, sourceRevisionHash: proof.binding.sourceRevisionHash });
  expect(current.binding.policyHash).not.toBe(proof.binding.policyHash);
  if (current.ownership.kind !== "item" || proof.ownership.kind !== "item") throw new Error("expected actual item claims");
  expect(current.ownership.lease.itemEpoch).toBe(proof.ownership.lease.itemEpoch + 1);
  expect(await recordSecondReview({ receipt: current, result: { ...approval(), confidence: 1 } })).toEqual({ state: "recorded" });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, row.id)))[0]).toMatchObject({ status: "agreed", secondConfidence: 1, failureCount: 0 });
});

it("readmits a policy-only stale legacy result under the same actual job", async () => {
  const { row } = await fixture();
  await withLegacy(async job => {
    const proof = receipt(await admitLegacySecondReview(row.id, job)), before = await domainSnapshot(row.id);
    await changeAgreement();
    expect(await recordSecondReview({ receipt: proof, result: { ok: false, error: "timeout", model: "second-model", provider: "abcllm" } }))
      .toEqual({ state: "input_changed", reason: "binding_changed" });
    expect(await domainSnapshot(row.id)).toEqual(before);
    const current = receipt(await admitLegacySecondReview(row.id, job));
    expect(current.binding.policyHash).not.toBe(proof.binding.policyHash);
    expect(current.binding.generationKey).toBe(proof.binding.generationKey);
    expect(await recordSecondReview({ receipt: current, result: { ...approval(), confidence: 1 } })).toEqual({ state: "recorded" });
  });
});

it.each(["item", "legacy"] as const)("rejects the old published product generation and recovers via a new %s admission", async authority => {
  const f = await fixture(true);
  if (!f.product) throw new Error("published fixture missing product");
  const execute = async (proof: SecondReviewReceipt, readmit: () => Promise<SecondReviewReceipt>) => {
    expect(proof.binding.source).toEqual({ kind: "published", slug: f.product!.slug, productId: f.product!.id });
    expect(proof.binding.inputHash).not.toBe(f.row.inputHash);
    expect(await removeProductAndEvidence(f.product!.id, f.product!.slug)).toBe(true);
    const [replacement] = await db.insert(products).values(f.productValues).returning();
    await markPublished(f.candidate.repo, replacement.slug);
    const before = await domainSnapshot(f.row.id);
    expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "input_changed", reason: "binding_changed" });
    expect(await domainSnapshot(f.row.id)).toEqual(before);
    if (authority === "item") await released(proof);
    const current = await readmit();
    expect(current.binding.source).toEqual({ kind: "published", slug: replacement.slug, productId: replacement.id });
    expect(current.binding.inputHash).toBe(proof.binding.inputHash);
    expect(current.binding.sourceRevisionHash).toBe(proof.binding.sourceRevisionHash);
    expect(current.binding.generationKey).toBe(proof.binding.generationKey);
    expect(await recordSecondReview({ receipt: current, result: approval() })).toEqual({ state: "recorded" });
    expect((await db.select().from(secondReviews).where(eq(secondReviews.id, f.row.id)))[0]).toMatchObject({ status: "agreed", firstAttemptId: null });
  };
  if (authority === "item") {
    await mode("items");
    await execute(await claim(f.row.id), () => claim(f.row.id));
  } else await withLegacy(async job => execute(receipt(await admitLegacySecondReview(f.row.id, job)), async () => receipt(await admitLegacySecondReview(f.row.id, job))));
});

it("supersedes only the original pending vote after actual source invalidation and releases its owner", async () => {
  const { row, document } = await fixture();
  await mode("items");
  const proof = await claim(row.id);
  await db.update(crawlDocuments).set({ pageMeta: { title: "A different application" } }).where(eq(crawlDocuments.id, document.id));
  const before = await snapshot(row.id);
  expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "input_changed", reason: "context_invalid" });
  const after = await snapshot(row.id);
  expect(after.candidate).toEqual(before.candidate);
  expect(after.publish).toEqual(before.publish);
  expect(after.chain).toHaveLength(1);
  expect(after.vote).toMatchObject({ status: "resolved", resolution: "superseded", second_decision: null, failure_count: 0 });
  await released(proof);
});

it("preserves a new human candidate decision when settling a stale item result", async () => {
  const { row, candidate } = await fixture();
  await mode("items");
  const proof = await claim(row.id);
  await db.update(crawlCandidates).set({ state: "rejected", reason: "not_a_product", decidedBy: "admin" }).where(eq(crawlCandidates.id, candidate.id));
  const before = await snapshot(row.id);
  expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "input_changed", reason: "context_invalid" });
  expect((await snapshot(row.id)).candidate).toEqual(before.candidate);
  expect((await snapshot(row.id)).publish).toEqual(before.publish);
  await released(proof);
});

it("settles a valid item receipt without rewriting a terminal human vote", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = await claim(row.id);
  await db.update(secondReviews).set({ status: "resolved", resolution: "kept", resolvedBy: "admin", resolvedAt: new Date() }).where(eq(secondReviews.id, row.id));
  const before = await domainSnapshot(row.id);
  expect(await recordSecondReview({ receipt: proof, result: approval() })).toEqual({ state: "not_pending" });
  expect(await domainSnapshot(row.id)).toEqual(before);
  await released(proof);
});

it("settles cancellation without counting a failure, allocating fallback or requesting work", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = await claim(row.id), before = await domainSnapshot(row.id);
  expect(await recordSecondReview({ receipt: proof, result: { ok: false, error: "cancelled", model: "second-model", provider: "abcllm" } }))
    .toEqual({ state: "cancelled" });
  expect(await domainSnapshot(row.id)).toEqual(before);
  await released(proof);
  expect((await claim(row.id)).binding).toEqual(proof.binding);
});

it.each(["token", "row_identity", "source_generation", "result_model", "result_provider"] as const)("rejects forged %s proof/result without any item or domain side effect", async changed => {
  const { row } = await fixture();
  await mode("items");
  const proof = structuredClone(await claim(row.id)), before = await snapshot(row.id), result = approval();
  if (proof.ownership.kind !== "item") throw new Error("actual item receipt required");
  if (changed === "token") proof.ownership.lease = { ...proof.ownership.lease, token: randomUUID() };
  if (changed === "row_identity") (proof as { rowIdentityHash: string }).rowIdentityHash = "0".repeat(64);
  if (changed === "source_generation") {
    if (proof.binding.source.kind !== "first_attempt") throw new Error("unpublished source required");
    proof.binding.source.firstAttemptId += 1;
  }
  const supplied = changed === "result_model" ? { ...result, model: "other-model" }
    : changed === "result_provider" ? { ...result, provider: "claude-cli" as const } : result;
  await expect(recordSecondReview({ receipt: proof, result: supplied })).rejects.toThrow();
  expect(await snapshot(row.id)).toEqual(before);
});

it("atomically records a primary failure, linked fallback, own release and next request", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = await claim(row.id);
  const [beforeJob] = await db.select().from(jobs).where(eq(jobs.name, "second-review"));
  expect(await recordSecondReview({ receipt: proof, result: { ok: false, error: "timeout", model: "second-model", provider: "abcllm" } })).toEqual({ state: "recorded" });
  await released(proof);
  const chain = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, row.candidateId));
  expect(chain).toHaveLength(2);
  expect(chain.find(item => item.id === row.id)).toMatchObject({ status: "resolved", resolution: "fallback", failureCount: 1, errorCode: "timeout" });
  const child = chain.find(item => item.fallbackForId === row.id)!;
  expect(child).toMatchObject({ model: "backup-model", status: "pending", failureCount: 1, generationKey: row.generationKey, firstAttemptId: row.firstAttemptId });
  expect((await db.select().from(jobs).where(eq(jobs.name, "second-review")))[0].requestedVersion).toBe((beforeJob?.requestedVersion ?? 0) + 1);
  const fallback = await claim(child.id);
  expect(fallback.binding).toMatchObject({ vote: row.id, fallbackForId: row.id });
  expect(await recordSecondReview({ receipt: fallback, result: { ...approval(), model: "backup-model" } })).toEqual({ state: "recorded" });
  await released(fallback);
});

it.each(["approval", "fallback", "hold"] as const)("rolls back result/candidate/child/item when the %s outbox write fails", async kind => {
  const { row } = await fixture();
  await mode("items");
  const proof = await claim(row.id), before = await snapshot(row.id);
  // A dissent normally has no outbox. Its item release trigger below supplies
  // the final failing operation instead, after the candidate hold was written.
  if (kind === "hold") {
    await admin`CREATE FUNCTION pr04b_results_release_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.owner_instance_id='pr04b-results-owner' AND NEW.token IS NULL THEN RAISE EXCEPTION 'pr04b_release_failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER pr04b_results_release_failure BEFORE UPDATE ON pipeline_item_leases FOR EACH ROW EXECUTE FUNCTION pr04b_results_release_failure()`;
  } else {
    await admin`CREATE FUNCTION pr04b_results_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name IN ('crawl-publish','second-review') THEN RAISE EXCEPTION 'pr04b_outbox_failure'; END IF; RETURN NEW; END $$`;
    await admin`CREATE TRIGGER pr04b_results_outbox_failure BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION pr04b_results_outbox_failure()`;
  }
  const result = kind === "fallback" ? { ok: false as const, error: "timeout", model: "second-model", provider: "abcllm" as const }
    : { ...approval(), decision: kind === "hold" ? "reject" : "approve" };
  await expect(recordSecondReview({ receipt: proof, result })).rejects.toThrow();
  expect(await snapshot(row.id)).toEqual(before);
});

function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`actual DB predicate not reached: ${label}`);
}
async function withBlockedPublish(body: (holderPid: number, release: () => void) => Promise<void>) {
  await db.insert(jobs).values({ name: "crawl-publish" }).onConflictDoNothing();
  const locked = barrier<number>(), release = barrier();
  const holding = blocker.begin(async tx => {
    await tx`SELECT name FROM jobs WHERE name='crawl-publish' FOR UPDATE`;
    const [row] = await tx`SELECT pg_backend_pid() AS pid`;
    locked.resolve(row.pid);
    await release.promise;
  });
  const holder = Promise.race([locked.promise, holding.then(() => { throw new Error("publish blocker exited before locking"); })]);
  try { await body(await holder, () => release.resolve()); }
  finally { release.resolve(); await holding; }
}
async function blockedBy(holderPid: number) {
  const [row] = await admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))) AS blocked`;
  return row.blocked;
}

it("rolls the whole item result back when its owner expires during an actual outbox row-lock wait", async () => {
  const { row } = await fixture();
  await mode("items");
  const proof = await claim(row.id, 2_000);
  await withBlockedPublish(async (pid, release) => {
    const before = await snapshot(row.id);
    const writing = recordSecondReview({ receipt: proof, result: approval() }).then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      await until(() => blockedBy(pid), "writer blocked by actual publish row");
      await until(async () => {
        const [item] = await admin`SELECT lease_until<=clock_timestamp() AS expired FROM pipeline_item_leases
          WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`;
        return item.expired;
      }, "owner expires while outbox blocked");
    } finally { release(); await writing; }
    const result = await writing;
    expect(result.ok).toBe(false);
    expect(await snapshot(row.id)).toEqual(before);
  });
});

it("rolls a legacy result back when the actual job expires after its initial lock and during outbox wait", async () => {
  const { row } = await fixture();
  await withLegacy(async job => {
    const proof = receipt(await admitLegacySecondReview(row.id, job));
    await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '89 seconds' WHERE name='second-review'`;
    await withBlockedPublish(async (pid, release) => {
      const before = await snapshot(row.id);
      const writing = recordSecondReview({ receipt: proof, result: approval() }).then(
        value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      try {
        await until(() => blockedBy(pid), "legacy writer blocked by actual publish row");
        await until(async () => {
          const [owned] = await admin`SELECT locked_at<clock_timestamp()-interval '90 seconds' AS expired
            FROM jobs WHERE name='second-review'`;
          return owned.expired;
        }, "job expires while result outbox blocked");
      } finally { release(); await writing; }
      const result = await writing;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toHaveProperty("message", "job_lease_lost");
      expect(await snapshot(row.id)).toEqual(before);
    });
  }, "failed");
});
