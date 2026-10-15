import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash, reviewPolicyHash,
  type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { secondReviewGeneration } from "@/lib/crawl/second-review-input";
import { claimItemSecondReview, secondReviewPolicyHash, type SecondReviewClaim,
  type SecondReviewItemReceipt } from "@/lib/crawl/second-review-ownership";
import { publishedInputHash, recordSecondReview } from "@/lib/crawl/second-review";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { itemBindingHash, type ItemOwner } from "@/lib/jobs/items/types";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, parseCapacityManifest,
  type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { captureReplayCombinedState, type ReplayCombinedState } from "@/lib/operations/pipeline-replay-combined-capture";
import { assessReplayAi2Target } from "@/lib/operations/pipeline-replay-ai2-target";
import { getReplayIdentityPath } from "./replay-setup";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Frozen first history/bootstrap are test data, not provider/dispatch proof.
// Actual positive authority comes only from ordinary claimItemSecondReview.
const prefix = "pr04c2-ai2-target", suffix = randomUUID().slice(0, 8);
const sentinelJob = `${prefix}-unrelated-${suffix}`, foreignRepo = `${prefix}-foreign/${suffix}`;
const reference = new Date("2001-11-01T00:00:00.000Z");
const owner: ItemOwner = { instanceId: `${prefix}-${suffix}`, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c2-ai2-target-admin" } });
const publicTables = { crawl_settings: schema.crawlSettings, crawl_candidates: schema.crawlCandidates,
  crawl_documents: schema.crawlDocuments, crawl_review_attempts: schema.crawlReviewAttempts,
  second_reviews: schema.secondReviews, agent_repository_scans: schema.agentRepositoryScans,
  agent_repository_observations: schema.agentRepositoryObservations, products: schema.products,
  crawl_frontier: schema.crawlFrontier, jobs: schema.jobs, operations_observations: schema.operationsObservations };
type RawRow = Record<string, unknown>;
type Fixture = { candidate: schema.CrawlCandidate; document: schema.CrawlDocument;
  first: schema.CrawlReviewAttempt; row: schema.SecondReview; input: ReviewInput };
const candidates: number[] = [], documents: number[] = [], itemKeys = new Set<string>();
const candidateRepos: string[] = [];
const productIds: number[] = [], productSlugs: string[] = [], scanIds: number[] = [], extraSettings: number[] = [];
const exercises = new Set<Promise<void>>();
let serial = 0, initialized = false, original: unknown, withSentinel: unknown;
let originalStages: RawRow[] = [], originalSettings: RawRow[] = [];
let bootstrap: Awaited<ReturnType<typeof getReplayIdentityPath>> | undefined;
let fixture: Fixture, manifest: CapacityManifest;
const settings: CrawlSettings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
  firstReview: { provider: "abcllm", model: "target-first" }, secondReview: {
    ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
    voters: [{ provider: "abcllm", model: "target-second" }],
    fallbacks: [{ provider: "abcllm", model: "target-backup" }] } };

async function allSteps(steps: readonly (() => Promise<unknown>)[], priorErrors: readonly unknown[] = []) {
  const errors: unknown[] = [...priorErrors];
  for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "ai2_target_cleanup_failed");
}
function exercise(load: () => Promise<void>) {
  return () => {
    const work = Promise.resolve().then(load); exercises.add(work);
    void work.catch(() => {}); return work;
  };
}
async function settleExercises() {
  const pending = [...exercises], settled = await Promise.allSettled(pending);
  for (const work of pending) exercises.delete(work);
  const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "ai2_target_exercise_failed");
}

async function wholeSnapshot() {
  const rows: Record<string, unknown> = {};
  for (const name of [...Object.keys(publicTables), "pipeline_stage_modes", "pipeline_item_leases", "cdn_purges", "crawl_publication_changes"]) {
    const [row] = await admin.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public.${name} t`);
    rows[name] = row.rows;
  }
  const [rights] = await admin`SELECT jsonb_build_object(
    'database',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type)
      FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database()),
    'public',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type)
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public'),
    'relations',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'acl',
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(c.relacl,
        acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a)) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')),
    'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'acl',a.attacl) ORDER BY c.relname,a.attname),'[]'::jsonb)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attacl IS NOT NULL)) AS value`;
  return { rows, rights: rights.value };
}
async function restoreManaged() {
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,epoch=r.epoch,
    writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
  if (originalSettings.length) await admin`UPDATE crawl_settings s SET values=r.values,updated_by=r.updated_by,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings)}::text::jsonb) r WHERE s.id=r.id`;
  else await admin`DELETE FROM crawl_settings WHERE id=1`;
}
async function cleanup() {
  // No profile is installed. Existing identity-checked bootstrap release comes
  // after actual exercises settle, before raw fixture restoration.
  if (bootstrap) { await bootstrap.release(); bootstrap = undefined; }
  await allSteps([
    async () => {
      if (itemKeys.size) await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND work_key=ANY(${[...itemKeys]})`;
      itemKeys.clear();
    },
    async () => {
      if (candidates.length) {
        await admin`DELETE FROM second_reviews WHERE candidate_id=ANY(${candidates})`;
        await admin`DELETE FROM crawl_review_attempts WHERE candidate_id=ANY(${candidates})`;
        await admin`DELETE FROM crawl_candidates WHERE id=ANY(${candidates})`; candidates.length = 0;
      }
      if (documents.length) { await admin`DELETE FROM crawl_documents WHERE id=ANY(${documents})`; documents.length = 0; }
    },
    async () => {
      if (!candidates.length && candidateRepos.length) {
        await admin`DELETE FROM crawl_publication_changes WHERE repo=ANY(${candidateRepos})`; candidateRepos.length = 0;
      }
      if (productIds.length) { await admin`DELETE FROM products WHERE id=ANY(${productIds})`; productIds.length = 0; }
      if (productSlugs.length) { await admin`DELETE FROM cdn_purges WHERE slug=ANY(${productSlugs})`; productSlugs.length = 0; }
      if (scanIds.length) { await admin`DELETE FROM agent_repository_scans WHERE id=ANY(${scanIds})`; scanIds.length = 0; }
      if (extraSettings.length) { await admin`DELETE FROM crawl_settings WHERE id=ANY(${extraSettings})`; extraSettings.length = 0; }
    }, restoreManaged,
  ]);
}

async function domainFixture(): Promise<Fixture> {
  const repo = `${prefix}/app-${suffix}-${++serial}`, url = `https://target-${suffix}-${serial}.test`;
  // The publication trigger retains rows after candidate deletion. Prove this
  // exact new repository has no foreign history before registering cleanup.
  expect(await admin`SELECT id FROM crawl_publication_changes WHERE repo=${repo}`).toEqual([]);
  candidateRepos.push(repo);
  const [document] = await db.insert(schema.crawlDocuments).values({ repo, productUrl: url,
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "A deployed project tracker", homepage: url, fork: false, private: false,
      archived: false, owner: { type: "User" }, stargazers_count: 10 }, pageMeta: {
      title: "Project tracker", description: "Manage projects and tasks", textSample: "Create projects and manage tasks online.",
      readmeSample: "A deployed online project tracker", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  documents.push(document.id);
  const [candidate] = await db.insert(schema.crawlCandidates).values({ repo, productUrl: url, state: "approved",
    reason: "passed", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning();
  candidates.push(candidate.id);
  const input = await withReviewReplayContext({ referenceTime: reference }, () => loadReviewInput(candidate, document, settings));
  const [first] = await db.insert(schema.crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: settings.firstReview!.provider, model: settings.firstReview!.model, attemptNumber: 1,
    outcome: { decision: "approve", confidence: 0.94, reason: "Fixture history only", evidenceIds: ["product"] },
    validUntil: input.validUntil, completedAt: reference }).returning();
  const [row] = await db.insert(schema.secondReviews).values({ candidateId: candidate.id, repo, trigger: "ai_approved",
    firstDecision: "approve", firstConfidence: 0.94, firstModel: first.model, firstAttemptId: first.id,
    generationKey: secondReviewGeneration(first.id, input, "ai_approved"), inputHash: input.inputHash,
    provider: "abcllm", model: "target-second" }).returning();
  await trackSlot(row.id);
  return { candidate, document, first, row, input };
}
function makeManifest(value: Fixture): CapacityManifest {
  const model = (reviewer: { provider: string; model: string }) => ({ ...reviewer, canonicalModel: reviewer.model });
  return parseCapacityManifest({ version: 1, runId: `${prefix}-${suffix}-${serial}`, revision: "86da89e5",
    mode: "fixtures", cacheMode: "cold", referenceTime: reference.toISOString(), startedAt: reference.toISOString(),
    endedAt: new Date(+reference + 60_000).toISOString(), inputPolicyHash: reviewPolicyHash(settings),
    fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings),
    initialStateHash: "0".repeat(64), models: { first: model(settings.firstReview!),
      second: settings.secondReview.voters.map(model), fallbacks: (settings.secondReview.fallbacks ?? []).map(model) },
    inputs: [{ candidateId: value.candidate.id, inputHash: value.input.inputHash,
      sourceRevisionHash: value.input.sourceRevisionHash, readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 1 } });
}
async function storeUniverse() {
  // Bootstrap data only, outside currentReplayDb; no certified run/dispatch.
  const frozen = JSON.parse(JSON.stringify(fixture.input));
  await admin`INSERT INTO pipeline_replay.capacity_runs(run_id,owner_id,manifest,manifest_hash,state)
    VALUES(${manifest.runId},${randomUUID()},${JSON.stringify(manifest)}::text::jsonb,${reviewHash(manifest)},'prepared')`;
  await admin`INSERT INTO pipeline_replay.capacity_inputs(run_id,candidate_id,input_hash,source_revision_hash,frozen_input,frozen_hash)
    VALUES(${manifest.runId},${fixture.candidate.id},${fixture.input.inputHash},${fixture.input.sourceRevisionHash},
      ${JSON.stringify(frozen)}::text::jsonb,${reviewHash(frozen)})`;
}
async function wall() {
  const [row] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
  return row.at as string;
}
const micros = (text: string) => {
  const match = /^(.*T\d\d:\d\d:\d\d)\.(\d{3}|\d{6})Z$/.exec(text);
  if (!match) throw new Error(`unexpected_wall_format:${text}`);
  return BigInt(Date.parse(`${match[1]}Z`)) * BigInt(1000) + BigInt(match[2].padEnd(6, "0"));
};
async function captureTarget() {
  const lower = await wall();
  const captured = await admin.begin(tx => captureReplayCombinedState(tx, manifest));
  const upper = await wall();
  // begin has resolved: capture owns no locks across the next internal claim TX.
  return { ...captured, lower, upper };
}
function itemReceipt(claim: SecondReviewClaim): SecondReviewItemReceipt {
  expect(claim.kind).toBe("claimed");
  if (claim.kind === "skipped" || claim.receipt.ownership.kind !== "item") throw new Error("actual_item_claim_required");
  return { ...claim.receipt, ownership: claim.receipt.ownership };
}
async function rawItem(id = fixture.row.id) {
  const [row] = await admin`SELECT to_jsonb(i) AS row FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${id}`}`;
  return row?.row as RawRow | undefined;
}
async function trackSlot(id: number) {
  const key = `ai2:${id}`;
  // A future serial ID could coincide with an orphan foreign item. Register
  // cleanup ownership only after proving this exact key was initially absent.
  if (!itemKeys.has(key)) { expect(await rawItem(id)).toBeUndefined(); itemKeys.add(key); }
}
async function actualClaimAndCancel(snapshot: Awaited<ReturnType<typeof captureTarget>>) {
  const before = await wholeSnapshot(), claimBefore = await wall();
  await trackSlot(fixture.row.id);
  const claim = await withReviewReplayContext({ referenceTime: reference }, () => claimItemSecondReview(fixture.row.id, owner, 90_000));
  const proof = itemReceipt(claim);
  let persisted: RawRow | undefined;
  const bodyErrors: unknown[] = [];
  try {
    const claimAfter = await wall(); persisted = await rawItem();
    expect(claim.kind).toBe("claimed");
    if (claim.kind === "skipped") throw new Error("actual_item_claim_required");
    expect(claim.row).toEqual(fixture.row); expect(claim.input).toEqual(fixture.input);
    expect(proof.binding).toEqual({ stage: "ai2", candidateId: fixture.candidate.id, secondReviewId: fixture.row.id,
      source: { kind: "first_attempt", firstAttemptId: fixture.first.id }, inputHash: fixture.input.inputHash,
      sourceRevisionHash: fixture.input.sourceRevisionHash, policyHash: secondReviewPolicyHash(settings),
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, reviewer: { provider: "abcllm", model: "target-second" },
      generationKey: fixture.row.generationKey, vote: fixture.row.id, fallbackForId: null });
    expect(persisted).toMatchObject({ stage: "ai2", work_key: `ai2:${fixture.row.id}`, binding: proof.binding,
      binding_hash: itemBindingHash(proof.binding), token: proof.ownership.lease.token,
      owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId,
      stage_epoch: proof.ownership.lease.stageEpoch, item_epoch: proof.ownership.lease.itemEpoch });
    const exact = await admin`SELECT token FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${proof.ownership.lease.workKey}
      AND lease_until=${proof.ownership.lease.leaseUntil}::timestamptz AND lease_until>clock_timestamp()`;
    expect(exact.map(row => row.token)).toEqual([proof.ownership.lease.token]);
    const bounds = [snapshot.lower, snapshot.upper, claimBefore, claimAfter].map(micros);
    expect(bounds).toEqual([...bounds].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
    for (const row of snapshot.state.items.tables.pipeline_item_leases) if (row.token && row.lease_until) {
      const expiry = micros(row.lease_until);
      expect(expiry < bounds[0] || expiry > bounds[3]).toBe(true);
    }
    console.log("AI2_TARGET_ACTUAL_CLAIM", JSON.stringify({ targetId: fixture.row.id,
      captureBounds: [snapshot.lower, snapshot.upper], claimBounds: [claimBefore, claimAfter],
      token: proof.ownership.lease.token, owner: proof.ownership.lease.owner,
      stageEpoch: proof.ownership.lease.stageEpoch, itemEpoch: proof.ownership.lease.itemEpoch,
      bindingHash: proof.ownership.lease.bindingHash, providerCalls: 0 }));
  } catch (error) { bodyErrors.push(error); } finally {
    await allSteps([async () => {
      expect(await withReviewReplayContext({ referenceTime: reference }, () => recordSecondReview({ receipt: proof,
        result: { ok: false, error: "cancelled", provider: fixture.row.provider!, model: fixture.row.model! } }))).toEqual({ state: "cancelled" });
    }], bodyErrors);
  }
  const released = await rawItem();
  expect(released).toEqual({ ...persisted, owner_instance_id: null, owner_boot_id: null, token: null,
    lease_until: null, updated_at: released!.updated_at });
  const after = await wholeSnapshot();
  const foreignItems = (rows: unknown) => (rows as RawRow[]).filter(row => row.stage !== "ai2" || row.work_key !== `ai2:${fixture.row.id}`);
  expect(foreignItems(after.rows.pipeline_item_leases)).toEqual(foreignItems(before.rows.pipeline_item_leases));
  expect({ ...after, rows: { ...after.rows, pipeline_item_leases: before.rows.pipeline_item_leases } }).toEqual(before);
  return proof;
}

beforeAll(exercise(async () => {
  ensureSchema(); original = await wholeSnapshot();
  originalStages = [...await admin`SELECT to_jsonb(s) AS row FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.row);
  originalSettings = [...await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`].map(row => row.row);
  initialized = true;
  await admin`INSERT INTO crawl_documents(repo,repo_meta,fetched_at) VALUES(${foreignRepo},'{}'::jsonb,'2001-10-31T23:59:59.123456Z')`;
  await admin`INSERT INTO jobs(name,cursor,not_before,updated_at) VALUES(${sentinelJob},'{"unrelated":true}'::jsonb,
    '2101-01-01T00:00:00.654321Z','2001-01-01T00:00:00.123456Z')`;
  withSentinel = await wholeSnapshot();
}));
beforeEach(exercise(async () => {
  await cleanup(); expect(await wholeSnapshot()).toEqual(withSentinel);
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1 WHERE stage='ai2'`;
  await db.insert(schema.crawlSettings).values({ id: 1, values: settings, updatedBy: prefix })
    .onConflictDoUpdate({ target: schema.crawlSettings.id, set: { values: settings, updatedBy: prefix } });
  fixture = await domainFixture(); manifest = makeManifest(fixture);
  bootstrap = await getReplayIdentityPath();
  await admin.unsafe(await readFile("scripts/sql/pipeline-replay-ledger.sql", "utf8"));
  await storeUniverse();
}));
afterEach(async () => { await allSteps([settleExercises, async () => {
  if (initialized) { await cleanup(); expect(await wholeSnapshot()).toEqual(withSentinel); }
}]); });
afterAll(async () => { await allSteps([settleExercises, async () => {
  if (initialized) await allSteps([cleanup,
    async () => { await admin`DELETE FROM crawl_documents WHERE repo=${foreignRepo}`; },
    async () => { await admin`DELETE FROM jobs WHERE name=${sentinelJob}`; },
    async () => { expect(await wholeSnapshot()).toEqual(original); }]);
}, async () => { await admin.end({ timeout: 3 }); }]); });

it("controls ordinary actual claim receipt and cancellation after a closed combined capture transaction", exercise(async () => {
  const before = await wholeSnapshot(), captured = await captureTarget();
  expect(await wholeSnapshot()).toEqual(before);
  expect(captured.state.domain.universe).toContainEqual(expect.objectContaining({ candidateId: fixture.candidate.id,
    inputHash: fixture.input.inputHash, sourceRevisionHash: fixture.input.sourceRevisionHash }));
  expect(captured.stateHash).toBe(reviewHash(captured.state));
  await actualClaimAndCancel(captured);
}));

it("assesses the same current target as eligible with the binding actually claimed and settled", exercise(async () => {
  const captured = await captureTarget(), originalState = structuredClone(captured.state);
  const assessment = assessReplayAi2Target(captured.state, fixture.row.id, captured.upper);
  const proof = await actualClaimAndCancel(captured);
  expect(assessment).toEqual({ kind: "eligible", targetId: fixture.row.id, binding: proof.binding, inputMembership: "included" });
  expect(captured.state).toEqual(originalState);
}));

async function cancelProof(proof: SecondReviewItemReceipt, row: schema.SecondReview) {
  return withReviewReplayContext({ referenceTime: reference }, () => recordSecondReview({ receipt: proof,
    result: { ok: false, error: "cancelled", provider: row.provider!, model: row.model! } }));
}
async function startClaim(id: number, by = owner) {
  await trackSlot(id);
  const claim = await withReviewReplayContext({ referenceTime: reference }, () => claimItemSecondReview(id, by, 90_000));
  return { claim, proof: itemReceipt(claim) };
}
async function withClaimedTarget(id: number, load: (proof: SecondReviewItemReceipt) => Promise<void>, by = owner) {
  const { claim, proof } = await startClaim(id, by), bodyErrors: unknown[] = [];
  try {
    if (claim.kind === "skipped") throw new Error("actual_item_claim_required");
    expect(await rawItem(id)).toMatchObject({ binding: proof.binding, binding_hash: itemBindingHash(proof.binding),
      token: proof.ownership.lease.token, owner_instance_id: by.instanceId, owner_boot_id: by.bootId,
      stage_epoch: proof.ownership.lease.stageEpoch, item_epoch: proof.ownership.lease.itemEpoch });
    await load(proof);
  } catch (error) { bodyErrors.push(error); } finally {
    await allSteps([async () => {
      if (claim.kind === "skipped") throw new Error("actual_item_claim_required");
      expect(await cancelProof(proof, claim.row)).toEqual({ state: "cancelled" });
      expect(await rawItem(id)).toMatchObject({ binding: proof.binding, binding_hash: proof.ownership.lease.bindingHash,
        owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null,
        item_epoch: proof.ownership.lease.itemEpoch, stage_epoch: proof.ownership.lease.stageEpoch });
    }], bodyErrors);
  }
}
function checkBounds(state: ReplayCombinedState, bounds: string[]) {
  const times = bounds.map(micros);
  expect(times).toEqual([...times].sort((a, b) => a < b ? -1 : a > b ? 1 : 0));
  for (const row of state.items.tables.pipeline_item_leases) if (row.token && row.lease_until) {
    const expiry = micros(row.lease_until);
    expect(expiry < times[0] || expiry > times.at(-1)!).toBe(true);
  }
}
async function expectEligible(id = fixture.row.id, membership: "included" | "outside" = "included") {
  const before = await wholeSnapshot(), captured = await captureTarget(), claimBefore = await wall();
  const assessment = assessReplayAi2Target(captured.state, id, captured.upper);
  expect(assessment).toMatchObject({ kind: "eligible", targetId: id, inputMembership: membership });
  await withClaimedTarget(id, async proof => {
    const afterClaim = await wall(); checkBounds(captured.state, [captured.lower, captured.upper, claimBefore, afterClaim]);
    expect(assessment).toEqual({ kind: "eligible", targetId: id, binding: proof.binding, inputMembership: membership });
  });
  const after = await wholeSnapshot(), otherItems = (rows: unknown) => (rows as RawRow[])
    .filter(row => row.stage !== "ai2" || row.work_key !== `ai2:${id}`);
  expect(otherItems(after.rows.pipeline_item_leases)).toEqual(otherItems(before.rows.pipeline_item_leases));
  expect({ ...after, rows: { ...after.rows, pipeline_item_leases: before.rows.pipeline_item_leases } }).toEqual(before);
}
async function expectSkipped(reason: "stage_inactive" | "not_pending" | "input_changed" | "running", id = fixture.row.id, by = owner) {
  const before = await wholeSnapshot(), captured = await captureTarget(), claimBefore = await wall();
  expect(assessReplayAi2Target(captured.state, id, captured.upper)).toEqual({ kind: "ineligible", targetId: id, reason });
  expect(await withReviewReplayContext({ referenceTime: reference }, () => claimItemSecondReview(id, by, 90_000)))
    .toEqual({ kind: "skipped", reason });
  checkBounds(captured.state, [captured.lower, captured.upper, claimBefore, await wall()]);
  expect(await wholeSnapshot()).toEqual(before);
}
async function setPolicy(value: CrawlSettings) {
  await db.update(schema.crawlSettings).set({ values: value }).where(eq(schema.crawlSettings.id, 1));
}
async function addVote(patch: Partial<schema.SecondReview>) {
  const [row] = await db.insert(schema.secondReviews).values({ ...fixture.row, id: undefined, ...patch }).returning();
  await trackSlot(row.id);
  return row;
}
async function addFirst(patch: Partial<schema.CrawlReviewAttempt> = {}) {
  const [row] = await db.insert(schema.crawlReviewAttempts).values({ ...fixture.first, id: undefined,
    attemptNumber: fixture.first.attemptNumber + 1, ...patch }).returning();
  return row;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["legacy", "draining", "contract0"] as const) it(`matches ordinary stage admission in ${mode}`, exercise(async () => {
  await admin`UPDATE pipeline_stage_modes SET mode=${mode === "contract0" ? "items" : mode},
    draining_from=${mode === "draining" ? "items" : null},writer_contract_version=${mode === "contract0" ? 0 : 1} WHERE stage='ai2'`;
  await expectSkipped("stage_inactive");
}));

it("preserves missing and terminal targets without pretending they are runnable", exercise(async () => {
  const missing = 2_147_483_647;
  expect(await admin`SELECT id FROM second_reviews WHERE id=${missing}`).toEqual([]);
  await expectSkipped("not_pending", missing);
  await admin`UPDATE second_reviews SET status='failed' WHERE id=${fixture.row.id}`;
  await expectSkipped("not_pending");
}));

for (const change of ["document", "human", "pool"] as const) it(`matches current invalid ${change} with whole raw preservation`, exercise(async () => {
  if (change === "document") await admin`UPDATE crawl_documents SET page_meta=page_meta||'{"textSample":"Changed source"}'::jsonb WHERE id=${fixture.document.id}`;
  if (change === "human") await admin`UPDATE crawl_candidates SET decided_by='human' WHERE id=${fixture.candidate.id}`;
  if (change === "pool") {
    const next = structuredClone(settings); next.secondReview.voters = [{ provider: "abcllm", model: "removed-current-model" }];
    await setPolicy(next);
  }
  await expectSkipped("input_changed");
}));

for (const sameBoot of [true, false]) it(`preserves a healthy ${sameBoot ? "same" : "foreign"} boot owner until actual cancellation`, exercise(async () => {
  const firstOwner = sameBoot ? owner : { instanceId: owner.instanceId, bootId: randomUUID() };
  await withClaimedTarget(fixture.row.id, async () => { await expectSkipped("running"); }, firstOwner);
  await expectEligible();
  expect((await rawItem())!.item_epoch).toBe(2);
}));

it("keeps a healthy old-epoch owner busy but rejects its original current-epoch settlement", exercise(async () => {
  const { claim, proof } = await startClaim(fixture.row.id);
  let originalItem: RawRow | undefined, fenced = false;
  const bodyErrors: unknown[] = [];
  try {
    originalItem = await rawItem();
    await admin`UPDATE pipeline_stage_modes SET epoch=epoch+1 WHERE stage='ai2'`;
    fenced = true;
    await expectSkipped("running");
    if (claim.kind === "skipped") throw new Error("actual_item_claim_required");
    await expect(cancelProof(proof, claim.row)).rejects.toThrow("item_lease_lost");
    expect(await rawItem()).toEqual(originalItem);
  } catch (error) { bodyErrors.push(error); } finally {
    // No transport was started. This deliberately fenced negative fixture has
    // no valid original release: afterEach performs own exact-key raw cleanup,
    // then restores the original stage. It is not a production drain proof.
    await allSteps([async () => {
      if (!fenced && claim.kind !== "skipped") expect(await cancelProof(proof, claim.row)).toEqual({ state: "cancelled" });
    }], bodyErrors);
  }
}));

it("allows an independent primary slot while another root on the candidate is healthy", exercise(async () => {
  const next = structuredClone(settings); next.secondReview.voters.push({ provider: "abcllm", model: "target-second-other" });
  await setPolicy(next);
  const other = await addVote({ model: "target-second-other" });
  await withClaimedTarget(fixture.row.id, async () => { await expectEligible(other.id); });
}));

it("does not turn controller ANY-generation protection into a target claim gate", exercise(async () => {
  await withClaimedTarget(fixture.row.id, async () => {
    const nextFirst = await addFirst();
    const next = await addVote({ firstAttemptId: nextFirst.id,
      generationKey: secondReviewGeneration(nextFirst.id, fixture.input, "ai_approved") });
    await expectEligible(next.id);
  });
}));

it("protects a fallback root and all sibling children including a same-first reference fallback", exercise(async () => {
  const next = structuredClone(settings); next.secondReview.fallbacks = [
    { provider: "abcllm", model: "target-first" }, { provider: "abcllm", model: "target-backup" }];
  await setPolicy(next);
  // Historical fallback domain fixture, not an assertion of provider failure.
  await admin`UPDATE second_reviews SET status='resolved',resolution='fallback' WHERE id=${fixture.row.id}`;
  const child = await addVote({ fallbackForId: fixture.row.id, model: "target-first" });
  const sibling = await addVote({ fallbackForId: fixture.row.id, model: "target-backup" });
  await withClaimedTarget(child.id, async proof => {
    expect(proof.binding).toMatchObject({ vote: fixture.row.id, fallbackForId: fixture.row.id });
    await expectSkipped("running", sibling.id);
  });
  await expectEligible(sibling.id);
}));

it("reclaims the same pending row under a changed composite policy after original cancellation", exercise(async () => {
  let originalHash = "";
  await withClaimedTarget(fixture.row.id, async proof => {
    originalHash = proof.binding.policyHash;
    const next = structuredClone(settings); next.secondReview.agreeAt = 0.97;
    await setPolicy(next); await expectSkipped("running");
  });
  await expectEligible();
  expect((await rawItem())!.binding).toMatchObject({ policyHash: expect.not.stringMatching(`^${originalHash}$`) });
}));

it("uses the referenced first reviewer identity rather than a different reviewer's newer success", exercise(async () => {
  await addFirst({ provider: "claude-cli", model: "other-first-reviewer" });
  await expectEligible();
  await addFirst({ attemptNumber: fixture.first.attemptNumber + 2 });
  await expectSkipped("input_changed");
}));

it("keeps outside-universe targets eligible and all 101 unrelated candidates in the captured state", exercise(async () => {
  const other = await domainFixture(), before = await captureTarget();
  const inserted = await db.insert(schema.crawlCandidates).values(Array.from({ length: 101 }, (_, index) => ({
    repo: `${prefix}/crowd-${suffix}-${index}`, state: "needs_review" as const, reason: "ambiguous" as const }))).returning({ id: schema.crawlCandidates.id });
  candidates.push(...inserted.map(row => row.id));
  const captured = await captureTarget();
  expect(captured.state.domain.tables.crawl_candidates).toHaveLength(before.state.domain.tables.crawl_candidates.length + 101);
  expect(captured.state.domain.tables.crawl_documents).toContainEqual(expect.objectContaining({ repo: foreignRepo,
    fetched_at: "2001-10-31T23:59:59.123456Z" }));
  await expectEligible(other.row.id, "outside");
}));

it("selects the actual latest repository scan by raw microseconds before the id tie-break", exercise(async () => {
  const insert = async (sha: string, at: string) => {
    const [row] = await admin`INSERT INTO agent_repository_scans(github_repository_id,repository_key,commit_sha,
      detector_version,scope,scope_hash,state,started_at,completed_at)
      VALUES(${fixture.candidate.id},${fixture.candidate.repo.toLowerCase()},${sha},${settings.agentEvidence.detectorVersion},
        '',${reviewHash(sha)},'complete',${at}::text::timestamp,'2001-10-31T23:59:59.000Z') RETURNING id`;
    scanIds.push(row.id); return Number(row.id);
  };
  const latestId = await insert("a".repeat(40), "2001-10-31T23:59:58.000002Z");
  const largerId = await insert("b".repeat(40), "2001-10-31T23:59:58.000001Z");
  expect(largerId).toBeGreaterThan(latestId);
  expect([...await admin`SELECT id,to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SS.US') AS at FROM agent_repository_scans
    WHERE id=ANY(${[latestId, largerId]}) ORDER BY id`]).toEqual([
    { id: latestId, at: "2001-10-31T23:59:58.000002" }, { id: largerId, at: "2001-10-31T23:59:58.000001" }]);
  const input = await withReviewReplayContext({ referenceTime: reference }, () => loadReviewInput(fixture.candidate, fixture.document, settings));
  expect(input.source.scanId).toBe(latestId);
  const first = await addFirst({ inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    policyHash: input.policyHash, snapshot: input.snapshot, source: input.source, validUntil: input.validUntil });
  const vote = await addVote({ firstAttemptId: first.id, inputHash: input.inputHash,
    generationKey: secondReviewGeneration(first.id, input, "ai_approved") });
  await expectEligible(vote.id, "outside");
}));

async function productFixture(slug: string, status: "seeded" | "banned" = "seeded", url = fixture.candidate.productUrl!) {
  const [product] = await db.insert(schema.products).values({ slug, url,
    repoUrl: `https://github.com/${fixture.candidate.repo}`, name: "Target product", tagline: "Manage projects",
    description: "A deployed project tracker", category: "Dev", status, source: "crawler",
    verifyToken: randomUUID(), editTokenHash: "a".repeat(64) }).returning();
  productIds.push(product.id); productSlugs.push(slug); return product;
}
it("binds an actual same-slug product replacement and preserves repository banned priority", exercise(async () => {
  const slug = `ai2-target-${suffix}-${serial}`, first = await productFixture(slug);
  await admin`UPDATE crawl_candidates SET state='published',published_slug=${slug} WHERE id=${fixture.candidate.id}`;
  await admin`UPDATE second_reviews SET trigger='sample',published_slug=${slug},first_attempt_id=NULL,first_model=NULL,
    first_confidence=NULL,input_hash=${publishedInputHash(slug)},generation_key=${secondReviewGeneration(null, fixture.input, "sample")}
    WHERE id=${fixture.row.id}`;
  await expectEligible();
  expect((await rawItem())!.binding).toMatchObject({ source: { kind: "published", slug, productId: first.id } });
  await admin`DELETE FROM products WHERE id=${first.id}`;
  const replacement = await productFixture(slug); expect(replacement.id).not.toBe(first.id);
  await expectEligible();
  expect((await rawItem())!.binding).toMatchObject({ source: { kind: "published", slug, productId: replacement.id } });
  await productFixture(`${slug}-banned`, "banned", `https://banned-${suffix}-${serial}.test`);
  await expectSkipped("input_changed");
}));

it("matches MAX_SAFE refusal only after current context validation", exercise(async () => {
  await withClaimedTarget(fixture.row.id, async () => {});
  await admin`UPDATE pipeline_item_leases SET item_epoch=9007199254740991 WHERE stage='ai2' AND work_key=${`ai2:${fixture.row.id}`}`;
  await expectSkipped("running");
  await admin`UPDATE crawl_documents SET page_meta=page_meta||'{"textSample":"Changed source"}'::jsonb WHERE id=${fixture.document.id}`;
  await expectSkipped("input_changed");
}));

for (const kind of ["item", "advisory"] as const) it(`separates a real ${kind} lock from logical eligibility and recovers after release`, exercise(async () => {
  if (kind === "item") await withClaimedTarget(fixture.row.id, async () => {});
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: `pr04c2-ai2-target-${kind}-holder` } });
  const locked = latch(), finish = latch(), bodyErrors: unknown[] = [];
  let holding: Promise<unknown> | undefined, holderError: unknown;
  try {
    holding = holder.begin(async tx => {
      if (kind === "item") await tx`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${fixture.row.id}`} FOR UPDATE`;
      else await tx`SELECT pg_advisory_xact_lock(1485804,hashtext(${`ai2:ai2:${fixture.row.id}`}))`;
      locked.resolve(); await finish.promise;
    });
    void holding.catch(error => { holderError = error; locked.resolve(); });
    await locked.promise; if (holderError) throw holderError;
    const captured = await captureTarget(), before = await wholeSnapshot();
    expect(assessReplayAi2Target(captured.state, fixture.row.id, captured.upper)).toMatchObject({ kind: "eligible" });
    expect(await withReviewReplayContext({ referenceTime: reference }, () => claimItemSecondReview(fixture.row.id, owner, 90_000)))
      .toEqual({ kind: "skipped", reason: "running" });
    expect(await wholeSnapshot()).toEqual(before);
  } catch (error) { bodyErrors.push(error); } finally {
    finish.resolve();
    await allSteps([async () => { if (holding) await holding; }, async () => { await holder.end({ timeout: 3 }); }], bodyErrors);
  }
  await expectEligible();
}));

for (const reason of ["ambiguous_settings", "implicit_first_reviewer", "missing_stored_readme"] as const)
  it(`reports unsupported ${reason} without claiming runtime ineligibility`, exercise(async () => {
    if (reason === "ambiguous_settings") {
      const id = Number.parseInt(suffix.slice(0, 6), 16) + 1000;
      expect(await admin`SELECT id FROM crawl_settings WHERE id=${id}`).toEqual([]);
      extraSettings.push(id); await db.insert(schema.crawlSettings).values({ id, values: settings });
    }
    if (reason === "implicit_first_reviewer") await admin`UPDATE crawl_settings SET values=values-'firstReview' WHERE id=1`;
    if (reason === "missing_stored_readme") await admin`UPDATE crawl_documents SET page_meta=page_meta-'readmeSample' WHERE id=${fixture.document.id}`;
    const captured = await captureTarget(), before = await wholeSnapshot();
    expect(assessReplayAi2Target(captured.state, fixture.row.id, captured.upper)).toEqual({ kind: "unknown", targetId: fixture.row.id, reason });
    expect(await wholeSnapshot()).toEqual(before);
    // Unknown is outside the stable actual-claim differential domain.
  }));

it("rejects a conflicting ambient semantic reference without changing the actual snapshot", exercise(async () => {
  const captured = await captureTarget(), before = structuredClone(captured.state);
  await expect(withReviewReplayContext({ referenceTime: new Date(+reference + 1) }, async () =>
    assessReplayAi2Target(captured.state, fixture.row.id, captured.upper))).rejects.toThrow("replay_clock_scope_conflict");
  expect(captured.state).toEqual(before);
  await expectEligible();
}));
