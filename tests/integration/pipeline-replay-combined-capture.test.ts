import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { getTableColumns } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { reviewHash, reviewPolicyHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { claimItemLease, lockItemStage } from "@/lib/jobs/items/repository";
import { itemWorkKey, type ItemBinding, type ItemLease, type ItemOwner } from "@/lib/jobs/items/types";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, parseCapacityManifest,
  type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { applyReplayChanges, type ReplayReadinessProjection } from "@/lib/operations/pipeline-replay-readiness";
import { canonicalReplayItemState, type ReplayItemState } from "@/lib/operations/pipeline-replay-item-state";
import { captureReplayCombinedState, type ReplayCombinedState } from "@/lib/operations/pipeline-replay-combined-capture";
import { type VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";
import { removeReplayHandlerTestProfile } from "./replay-handler-setup";
import { getReplayIdentityPath } from "./replay-setup";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Read snapshots only: actual generic leases below establish row provenance,
// not AI2/domain admission, current eligibility, external calls or certification.
const prefix = "pr04c2-combined", suffix = randomUUID().slice(0, 8);
const sentinelName = `${prefix}-unrelated-${suffix}`, foreignRepo = `${prefix}-foreign/${suffix}`;
const reference = new Date("2001-11-01T00:00:00.000Z");
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c2-combined-admin" } });
const owner: ItemOwner = { instanceId: `${prefix}-owner`, bootId: randomUUID() };
const foreign: ItemOwner = { instanceId: `${prefix}-foreign`, bootId: randomUUID() };
const publicTables = { crawl_settings: schema.crawlSettings, crawl_candidates: schema.crawlCandidates,
  crawl_documents: schema.crawlDocuments, crawl_review_attempts: schema.crawlReviewAttempts,
  second_reviews: schema.secondReviews, agent_repository_scans: schema.agentRepositoryScans,
  agent_repository_observations: schema.agentRepositoryObservations, products: schema.products,
  crawl_frontier: schema.crawlFrontier, jobs: schema.jobs, operations_observations: schema.operationsObservations };
type RawRow = Record<string, unknown>;
type ItemKey = { stage: ItemBinding["stage"]; work_key: string };
type Fixture = { candidate: schema.CrawlCandidate; document: schema.CrawlDocument; input: ReviewInput };
const keys: ItemKey[] = [], sentinelKeys: ItemKey[] = [], candidates: number[] = [], documents: number[] = [];
const exercises = new Set<Promise<void>>();
let original: unknown, withSentinel: unknown, originalStages: RawRow[] = [], originalSettings: RawRow[] = [];
let initialized = false, serial = 0, fixture: Fixture, manifest: CapacityManifest, lease: ItemLease;
let bootstrap: Awaited<ReturnType<typeof getReplayIdentityPath>> | undefined;
let verified: VerifiedReplayDatabase | undefined, profileInstalled = false;
const settings: CrawlSettings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
  firstReview: { provider: "abcllm", model: "combined-first" }, secondReview: {
    ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } };

async function allSteps(steps: readonly (() => Promise<unknown>)[], priorErrors: readonly unknown[] = []) {
  const errors: unknown[] = [...priorErrors];
  for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "combined_capture_cleanup_failed");
}
function exercise(load: () => Promise<void>) {
  return () => {
    const work = Promise.resolve().then(load); exercises.add(work);
    void work.catch(() => {}); return work;
  };
}
async function settleExercises() {
  const pending = [...exercises], results = await Promise.allSettled(pending);
  for (const work of pending) exercises.delete(work);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "combined_capture_exercise_failed");
}
async function wholeSnapshot() {
  const rows: Record<string, unknown> = {};
  for (const name of [...Object.keys(publicTables), "pipeline_stage_modes", "pipeline_item_leases", "cdn_purges"]) {
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
async function deleteKeys(values: readonly ItemKey[]) {
  if (values.length) await admin`DELETE FROM pipeline_item_leases i USING
    jsonb_to_recordset(${JSON.stringify(values)}::text::jsonb) AS k(stage text,work_key text)
    WHERE i.stage=k.stage AND i.work_key=k.work_key`;
}
async function closeReplay() {
  if (verified) { await verified.close(); verified = undefined; }
  if (profileInstalled) { await removeReplayHandlerTestProfile(bootstrap!.identityPath); profileInstalled = false; }
  if (bootstrap) { await bootstrap.release(); bootstrap = undefined; }
}
async function cleanup() {
  // Await all original work first; verified normal release precedes raw writes.
  await closeReplay();
  await allSteps([
    async () => { await deleteKeys(keys); keys.length = 0; },
    async () => {
      if (candidates.length) {
        await admin`DELETE FROM second_reviews WHERE candidate_id=ANY(${candidates})`;
        await admin`DELETE FROM crawl_review_attempts WHERE candidate_id=ANY(${candidates})`;
        await admin`DELETE FROM crawl_candidates WHERE id=ANY(${candidates})`; candidates.length = 0;
      }
      if (documents.length) { await admin`DELETE FROM crawl_documents WHERE id=ANY(${documents})`; documents.length = 0; }
    }, restoreManaged,
  ]);
}
async function activate() {
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1`;
}
async function realLease(binding: ItemBinding, by = owner, sentinel = false) {
  const key = { stage: binding.stage, work_key: itemWorkKey(binding) };
  const [prior] = await admin`SELECT count(*)::int AS count FROM pipeline_item_leases WHERE stage=${key.stage} AND work_key=${key.work_key}`;
  expect(prior.count).toBe(0); (sentinel ? sentinelKeys : keys).push(key);
  const claimed = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, binding.stage), binding, by, 90_000));
  expect(claimed).not.toBeNull(); return claimed!;
}
async function domainFixture(): Promise<Fixture> {
  const repo = `${prefix}/app-${suffix}-${++serial}`, url = `https://combined-${suffix}-${serial}.test`;
  const [document] = await db.insert(schema.crawlDocuments).values({ repo, productUrl: url,
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "A deployed project tracker", homepage: url, fork: false, private: false, archived: false,
      owner: { type: "User" }, stargazers_count: 10 }, pageMeta: { title: "Project tracker", description: "Manage tasks in your browser",
      textSample: "Create projects and manage tasks.", readmeSample: "An online tracker", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  documents.push(document.id);
  const [candidate] = await db.insert(schema.crawlCandidates).values({ repo, productUrl: url, state: "approved",
    reason: "passed", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning();
  candidates.push(candidate.id);
  const input = await withReviewReplayContext({ referenceTime: reference }, () => loadReviewInput(candidate, document, settings));
  return { candidate, document, input };
}
function makeManifest(inputs: readonly Fixture[], runId = `${prefix}-${suffix}-${serial}`): CapacityManifest {
  return parseCapacityManifest({ version: 1, runId, revision: "ee6bc24", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 60_000).toISOString(),
    inputPolicyHash: reviewPolicyHash(settings), fullReviewPolicyHash: fullReviewPolicyHash(settings),
    comparisonPolicyHash: comparisonReviewPolicyHash(settings), initialStateHash: "0".repeat(64),
    models: { first: { ...settings.firstReview!, canonicalModel: settings.firstReview!.model }, second: [], fallbacks: [] },
    inputs: inputs.map(value => ({ candidateId: value.candidate.id, inputHash: value.input.inputHash,
      sourceRevisionHash: value.input.sourceRevisionHash, readyAt: reference.toISOString(), stratum: "new", reReview: false })),
    limits: { maxCalls: 200, maxTokens: 20_000, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 1 } });
}
async function storeUniverse(value: CapacityManifest, fixtures: readonly Fixture[]) {
  // Prepared capture data only; no ReplayRun, execution scope or call authority.
  await admin`INSERT INTO pipeline_replay.capacity_runs(run_id,owner_id,manifest,manifest_hash,state)
    VALUES(${value.runId},${randomUUID()},${JSON.stringify(value)}::text::jsonb,${reviewHash(value)},'prepared')`;
  for (const item of fixtures) {
    const frozen = JSON.parse(JSON.stringify(item.input));
    await admin`INSERT INTO pipeline_replay.capacity_inputs(run_id,candidate_id,input_hash,source_revision_hash,frozen_input,frozen_hash)
      VALUES(${value.runId},${item.candidate.id},${item.input.inputHash},${item.input.sourceRevisionHash},${JSON.stringify(frozen)}::text::jsonb,${reviewHash(frozen)})`;
  }
}
async function rawState(value = manifest): Promise<ReplayCombinedState> {
  // Independent full SQL reads are used only while writers are quiescent, or
  // wholly before/after the paired writer's commit barrier. They certify no MVCC.
  const tables: Record<string, unknown[]> = {};
  for (const name of Object.keys(publicTables)) {
    const rows = await admin.unsafe(`SELECT to_jsonb(t) AS row FROM public.${name} t ORDER BY to_jsonb(t)::text DESC`);
    tables[name] = rows.map(row => row.row);
  }
  tables.capacity_calls = [...await admin`SELECT to_jsonb(t) AS row FROM pipeline_replay.capacity_calls t WHERE run_id=${value.runId} ORDER BY call_id DESC`].map(row => row.row);
  const inputs = await admin`SELECT candidate_id,input_hash,source_revision_hash,frozen_input,frozen_hash FROM pipeline_replay.capacity_inputs WHERE run_id=${value.runId} ORDER BY candidate_id DESC`;
  const [items] = await admin`SELECT jsonb_build_object('kind','pipeline-replay-item-state','version',1,'tables',jsonb_build_object(
    'pipeline_stage_modes',(SELECT jsonb_agg(to_jsonb(s) ORDER BY stage DESC) FROM pipeline_stage_modes s),
    'pipeline_item_leases',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage DESC,work_key DESC),'[]'::jsonb) FROM pipeline_item_leases i))) AS value`;
  return { kind: "pipeline-replay-combined-state", version: 1,
    domain: { version: 1, referenceTime: value.referenceTime, universe: inputs.map(row => ({ candidateId: Number(row.candidate_id),
      inputHash: row.input_hash, sourceRevisionHash: row.source_revision_hash, policyHash: row.frozen_input.policyHash,
      frozenInput: row.frozen_input, frozenHash: row.frozen_hash })), tables } as ReplayReadinessProjection,
    items: items.value as ReplayItemState };
}
async function expected(value = manifest) {
  const raw = await rawState(value);
  // Deliberately reuse only these existing public pure normalizers; SQL row
  // completeness and the paired actual commit observation are separate evidence.
  const state: ReplayCombinedState = { ...raw, domain: applyReplayChanges(raw.domain, []), items: canonicalReplayItemState(raw.items) };
  return { state, stateHash: reviewHash(state) };
}
const capture = (value = manifest) => admin.begin(tx => captureReplayCombinedState(tx, value));

beforeAll(exercise(async () => {
  ensureSchema(); original = await wholeSnapshot();
  originalStages = [...await admin`SELECT to_jsonb(s) AS row FROM pipeline_stage_modes s ORDER BY stage`].map(row => row.row);
  originalSettings = [...await admin`SELECT to_jsonb(s) AS row FROM crawl_settings s WHERE id=1`].map(row => row.row);
  initialized = true;
  await admin`INSERT INTO crawl_documents(repo,repo_meta,fetched_at) VALUES(${foreignRepo},'{}'::jsonb,'2001-10-31T23:59:59.123456Z')`;
  await admin`INSERT INTO jobs(name,cursor,not_before,updated_at) VALUES(${sentinelName},'{"unrelated":true}'::jsonb,'2101-01-01T00:00:00.654321Z','2001-01-01T00:00:00.123456Z')`;
  try {
    await activate(); const id = Number.parseInt(suffix, 16);
    await realLease({ stage: "fetch", frontierId: id, repo: foreignRepo,
      claim: { attempts: 1, nextAttemptAt: reference.toISOString() } }, foreign, true);
  } finally { await restoreManaged(); }
  withSentinel = await wholeSnapshot();
}));
beforeEach(exercise(async () => {
  await cleanup(); expect(await wholeSnapshot()).toEqual(withSentinel);
  await activate();
  await db.insert(schema.crawlSettings).values({ id: 1, values: settings, updatedBy: prefix })
    .onConflictDoUpdate({ target: schema.crawlSettings.id, set: { values: settings, updatedBy: prefix } });
  fixture = await domainFixture(); manifest = makeManifest([fixture]);
  bootstrap = await getReplayIdentityPath();
  await admin.unsafe(await readFile("scripts/sql/pipeline-replay-ledger.sql", "utf8"));
  await storeUniverse(manifest, [fixture]);
  lease = await realLease({ stage: "ai1", candidateId: fixture.candidate.id, inputHash: fixture.input.inputHash,
    sourceRevisionHash: fixture.input.sourceRevisionHash, policyHash: fixture.input.policyHash,
    promptVersion: fixture.input.snapshot.policy.promptVersion, rulesVersion: fixture.input.snapshot.policy.rulesVersion, reviewer: settings.firstReview! });
}));
afterEach(async () => { await allSteps([settleExercises, async () => {
  if (initialized) { await cleanup(); expect(await wholeSnapshot()).toEqual(withSentinel); }
}]); });
afterAll(async () => { await allSteps([settleExercises, async () => {
  await closeReplay();
  if (initialized) await allSteps([cleanup, async () => { await deleteKeys(sentinelKeys); },
    async () => { await admin`DELETE FROM crawl_documents WHERE repo=${foreignRepo}`; },
    async () => { await admin`DELETE FROM jobs WHERE name=${sentinelName}`; },
    async () => { expect(await wholeSnapshot()).toEqual(original); }]);
}, async () => { await admin.end({ timeout: 3 }); }]); });

it("reads actual full SQL domain/item rows and the stored frozen universe", exercise(async () => {
  const result = await capture(), raw = await rawState();
  for (const [name, table] of Object.entries(publicTables)) {
    const columns = Object.values(getTableColumns(table)).map(column => column.name).sort();
    const actual = await admin`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${name} ORDER BY column_name`;
    expect(actual.map(row => row.column_name)).toEqual(columns);
    for (const row of result.state.domain.tables[name as keyof typeof publicTables]) expect(Object.keys(row).sort()).toEqual(columns);
    expect(result.state.domain.tables[name as keyof typeof publicTables]).toHaveLength(raw.domain.tables[name as keyof typeof publicTables].length);
  }
  expect(result.state.domain.universe).toEqual(raw.domain.universe);
  expect(result.state.domain.tables.crawl_documents).toHaveLength(raw.domain.tables.crawl_documents.length);
  expect(result.state.domain.tables.crawl_documents).toContainEqual(expect.objectContaining({ id: fixture.document.id, repo: fixture.document.repo }));
  expect(result.state.domain.tables.crawl_documents).toContainEqual(expect.objectContaining({ repo: foreignRepo }));
  expect(result.state.items.tables.pipeline_item_leases).toHaveLength(raw.items.tables.pipeline_item_leases.length);
  for (const key of sentinelKeys) expect(result.state.items.tables.pipeline_item_leases).toContainEqual(expect.objectContaining(key));
  expect(result.state.items.tables.pipeline_item_leases).toContainEqual(expect.objectContaining({ token: lease.token,
    owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId, binding: lease.binding,
    binding_hash: lease.bindingHash, stage_epoch: lease.stageEpoch, item_epoch: lease.itemEpoch }));
  expect(Object.keys(result).sort()).toEqual(["state", "stateHash"]);
  expect(Object.keys(result.state).sort()).toEqual(["domain", "items", "kind", "version"]);
}));

it("returns the complete canonical SQL envelope and binds its full payload hash", exercise(async () => {
  const before = await rawState(), wanted = await expected(), result = await capture();
  expect(result).toEqual(wanted);
  expect(await rawState()).toEqual(before);
}));

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function ownItem(state: ReplayCombinedState) {
  const row = state.items.tables.pipeline_item_leases.find(row => row.stage === lease.stage && row.work_key === lease.workKey);
  expect(row).toBeDefined(); return row!;
}
async function expectFull(value = manifest) {
  const wanted = await expected(value), result = await capture(value);
  expect(result).toEqual(wanted); return result;
}

it("observes old-old then committed new-new across an actual paired domain/item transaction", exercise(async () => {
  const { releaseItemLease } = await import("@/lib/jobs/items/repository");
  await db.transaction(async tx => releaseItemLease(tx, await lockItemStage(tx, lease.stage), lease));
  const before = await expectFull(), oldDomainRead = (await rawState()).domain;
  const changed = latch(), finish = latch();
  const writer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04c2-combined-paired-writer" } });
  let writing: Promise<unknown> | undefined, writerError: unknown;
  const bodyErrors: unknown[] = [];
  try {
    writing = writer.begin(async tx => {
      await tx`UPDATE crawl_candidates SET signals=jsonb_build_object('combinedPair','new') WHERE id=${fixture.candidate.id}`;
      // This released historical row is raw state, never replacement authority.
      await tx`UPDATE pipeline_item_leases SET item_epoch=item_epoch+1,updated_at=clock_timestamp()
        WHERE stage=${lease.stage} AND work_key=${lease.workKey}`;
      changed.resolve(); await finish.promise;
    });
    void writing.catch(error => { writerError = error; changed.resolve(); });
    await changed.promise; if (writerError) throw writerError;
    const pending = await capture(); expect(pending).toEqual(before);
    expect(ownItem(pending.state).item_epoch).toBe(lease.itemEpoch);
    finish.resolve(); await writing;
    const committed = await expectFull();
    expect(committed.state.domain.tables.crawl_candidates.find(row => row.id === fixture.candidate.id)?.signals).toEqual({ combinedPair: "new" });
    expect(ownItem(committed.state).item_epoch).toBe(lease.itemEpoch + 1);
    expect(committed.stateHash).not.toBe(before.stateHash);
    // Two separate reads straddling that same commit really mix old domain and
    // new items. This is the stitching hazard control, not a split-query mutant.
    const newItemsRead = (await rawState()).items;
    const mixedRaw = { ...before.state, domain: oldDomainRead, items: newItemsRead };
    const mixed = { ...mixedRaw, domain: applyReplayChanges(mixedRaw.domain, []), items: canonicalReplayItemState(mixedRaw.items) };
    expect(mixed).not.toEqual(before.state); expect(mixed).not.toEqual(committed.state);
    expect(ownItem(mixed).item_epoch).toBe(lease.itemEpoch + 1);
    expect(mixed.domain.tables.crawl_candidates.find(row => row.id === fixture.candidate.id)?.signals).not.toEqual({ combinedPair: "new" });
  } catch (error) { bodyErrors.push(error); } finally {
    finish.resolve();
    await allSteps([async () => { if (writing) await writing; }, async () => { await writer.end({ timeout: 3 }); }], bodyErrors);
  }
}));

it("captures 137 actual frozen inputs and generic leases without filtering any foreign rows", exercise(async () => {
  const fixtures = [fixture], before = await rawState(), issued: ItemLease[] = [lease];
  for (let i = 1; i < 137; i++) {
    const value = await domainFixture(); fixtures.push(value);
    issued.push(await realLease({ stage: "ai1", candidateId: value.candidate.id, inputHash: value.input.inputHash,
      sourceRevisionHash: value.input.sourceRevisionHash, policyHash: value.input.policyHash,
      promptVersion: value.input.snapshot.policy.promptVersion, rulesVersion: value.input.snapshot.policy.rulesVersion,
      reviewer: settings.firstReview! }));
  }
  manifest = makeManifest(fixtures, `${manifest.runId}-137`); await storeUniverse(manifest, fixtures);
  const result = await expectFull();
  expect(result.state.domain.universe).toHaveLength(137);
  expect(result.state.domain.tables.crawl_candidates).toHaveLength(before.domain.tables.crawl_candidates.length + 136);
  expect(result.state.domain.tables.crawl_documents).toHaveLength(before.domain.tables.crawl_documents.length + 136);
  expect(result.state.items.tables.pipeline_item_leases).toHaveLength(before.items.tables.pipeline_item_leases.length + 136);
  for (const value of issued) expect(result.state.items.tables.pipeline_item_leases).toContainEqual(expect.objectContaining({
    stage: value.stage, work_key: value.workKey, token: value.token, binding_hash: value.bindingHash }));
  for (const value of before.items.tables.pipeline_item_leases) expect(result.state.items.tables.pipeline_item_leases)
    .toContainEqual(expect.objectContaining({ stage: value.stage, work_key: value.work_key, token: value.token, binding: value.binding }));
  expect(result.state.domain.tables.crawl_documents).toContainEqual(expect.objectContaining({ repo: foreignRepo,
    fetched_at: "2001-10-31T23:59:59.123456Z" }));
}));

async function storedCall(value: CapacityManifest, source: Fixture, callId: string) {
  // Historical domain row plus reserved capture metadata, not a dispatched call
  // or settled result proof. No provider runs and no call authority is inferred.
  const [attempt] = await db.insert(schema.crawlReviewAttempts).values({ candidateId: source.candidate.id,
    kind: "automatic", state: "failed", inputHash: source.input.inputHash, policyHash: source.input.policyHash,
    sourceRevisionHash: source.input.sourceRevisionHash, snapshot: source.input.snapshot, source: source.input.source,
    promptVersion: source.input.snapshot.policy.promptVersion, rulesVersion: source.input.snapshot.policy.rulesVersion,
    provider: "abcllm", model: "combined-first", attemptNumber: 1, validUntil: source.input.validUntil, errorCode: "capture_only" }).returning();
  await admin`INSERT INTO pipeline_replay.capacity_calls(run_id,call_id,candidate_id,first_attempt_id,input_hash,
    source_revision_hash,stage,provider,model,request_hash,token_upper_bound,state)
    VALUES(${value.runId},${callId},${source.candidate.id},${attempt.id},${source.input.inputHash},${source.input.sourceRevisionHash},
      'first','abcllm','combined-first',${reviewHash({ callId })},100,'reserved')`;
}

it("selects only the manifest run's complete frozen inputs and calls while retaining all public domain rows", exercise(async () => {
  const other = await domainFixture(), otherManifest = makeManifest([other], `${manifest.runId}-outside`);
  await storeUniverse(otherManifest, [other]);
  await storedCall(manifest, fixture, "own-call"); await storedCall(otherManifest, other, "outside-call");
  const before = await expectFull();
  expect(before.state.domain.universe).toHaveLength(1);
  expect(before.state.domain.tables.capacity_calls).toHaveLength(1);
  expect(before.state.domain.tables.capacity_calls[0].call_id).toBe("own-call");
  const columns = await admin`SELECT column_name FROM information_schema.columns WHERE table_schema='pipeline_replay'
    AND table_name='capacity_calls' ORDER BY column_name`;
  expect(Object.keys(before.state.domain.tables.capacity_calls[0]).sort()).toEqual(columns.map(row => row.column_name));
  expect(before.state.domain.tables.crawl_candidates).toContainEqual(expect.objectContaining({ id: other.candidate.id }));
  await admin`UPDATE pipeline_replay.capacity_calls SET request_hash=${"a".repeat(64)} WHERE run_id=${otherManifest.runId}`;
  expect(await capture()).toEqual(before);
  await admin`UPDATE pipeline_replay.capacity_calls SET request_hash=${"b".repeat(64)} WHERE run_id=${manifest.runId}`;
  const after = await expectFull(); expect(after.stateHash).not.toBe(before.stateHash);
}));

it.each(["missing", "hash", "policy", "extra"] as const)("rejects an actual %s DB frozen universe and preserves its original rows on rollback", kind => exercise(async () => {
  const extra = kind === "extra" ? await domainFixture() : undefined;
  const before = await expectFull(), rollback = new Error("own_combined_universe_rollback");
  let captureError: unknown;
  const transaction = admin.begin(async tx => {
    if (kind === "missing") await tx`DELETE FROM pipeline_replay.capacity_inputs WHERE run_id=${manifest.runId}`;
    else if (kind === "hash") await tx`UPDATE pipeline_replay.capacity_inputs SET frozen_hash=${"0".repeat(64)} WHERE run_id=${manifest.runId}`;
    else if (kind === "policy") await tx`UPDATE pipeline_replay.capacity_inputs
      SET frozen_input=jsonb_set(frozen_input,'{policyHash}',to_jsonb(${"0".repeat(64)}::text)) WHERE run_id=${manifest.runId}`;
    else {
      const frozen = JSON.parse(JSON.stringify(extra!.input));
      await tx`INSERT INTO pipeline_replay.capacity_inputs(run_id,candidate_id,input_hash,source_revision_hash,frozen_input,frozen_hash)
        VALUES(${manifest.runId},${extra!.candidate.id},${extra!.input.inputHash},${extra!.input.sourceRevisionHash},${JSON.stringify(frozen)}::text::jsonb,${reviewHash(frozen)})`;
    }
    try { await captureReplayCombinedState(tx, manifest); } catch (error) { captureError = error; }
    throw rollback;
  });
  await expect(transaction).rejects.toBe(rollback);
  expect(captureError).toBeInstanceOf(Error);
  expect((captureError as Error).message).toMatch(/^replay_(combined_capture_universe|readiness_frozen)_mismatch$/);
  expect(await capture()).toEqual(before);
})());

it.each([['domain', 'extra'], ['domain', 'missing'], ['items', 'extra'], ['items', 'missing']] as const)(
  "fails closed on actual %s %s SQL columns with exact transactional DDL rollback", (part, kind) => exercise(async () => {
    const table = part === "domain" ? "crawl_candidates" : "pipeline_item_leases";
    const before = await expectFull(), rollback = new Error("own_combined_columns_rollback");
    const columns = await admin`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} ORDER BY column_name`;
    let strictError: unknown;
    const transaction = admin.begin(async tx => {
      // Fixed test-owned identifiers only, never production/caller SQL.
      if (part === "domain" && kind === "extra") await tx`ALTER TABLE public.crawl_candidates ADD COLUMN pr04c2_combined_extra boolean`;
      else if (part === "domain") await tx`ALTER TABLE public.crawl_candidates DROP COLUMN updated_at`;
      else if (kind === "extra") await tx`ALTER TABLE public.pipeline_item_leases ADD COLUMN pr04c2_combined_extra boolean`;
      else await tx`ALTER TABLE public.pipeline_item_leases DROP COLUMN updated_at`;
      try { await captureReplayCombinedState(tx, manifest); } catch (error) { strictError = error; }
      throw rollback;
    });
    await expect(transaction).rejects.toBe(rollback); expect(strictError).toMatchObject({ name: "ZodError" });
    expect(await admin`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${table} ORDER BY column_name`).toEqual(columns);
    expect(await capture()).toEqual(before);
  })());

it("propagates actual SQLSTATE57014 after its own blocked statement backend is cancelled", exercise(async () => {
  const before = await rawState(), locked = latch(), entered = latch(), finish = latch();
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04c2-combined-table-holder" } });
  const reader = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04c2-combined-cancel-reader" } });
  let holding: Promise<unknown> | undefined, reading: Promise<unknown> | undefined;
  let holderPid: number | undefined, readerPid: number | undefined, holderError: unknown;
  const bodyErrors: unknown[] = [];
  try {
    holding = holder.begin(async tx => {
      const [row] = await tx`SELECT pg_backend_pid() AS pid`; holderPid = row.pid;
      await tx`LOCK TABLE public.crawl_documents IN ACCESS EXCLUSIVE MODE`;
      locked.resolve(); await finish.promise;
    });
    void holding.catch(error => { holderError = error; locked.resolve(); });
    await locked.promise; if (holderError) throw holderError;
    reading = reader.begin(async tx => {
      try {
        const [row] = await tx`SELECT pg_backend_pid() AS pid`; readerPid = row.pid;
        entered.resolve(); return await captureReplayCombinedState(tx, manifest);
      } finally { entered.resolve(); }
    }).then(value => ({ value }), error => ({ error }));
    await entered.promise; expect(readerPid).toBeDefined();
    await expect.poll(async () => {
      const [row] = await admin`SELECT ${holderPid!}::int=ANY(pg_blocking_pids(${readerPid!}::int)) AS blocked`;
      return row.blocked;
    }).toBe(true);
    const [cancelled] = await admin`SELECT pg_cancel_backend(${readerPid!}::int) AS cancelled`;
    expect(cancelled.cancelled).toBe(true);
    expect(await reading).toMatchObject({ error: { code: "57014" } });
  } catch (error) { bodyErrors.push(error); } finally {
    finish.resolve();
    await allSteps([async () => { if (holding) await holding; }, async () => { if (reading) await reading; },
      async () => { await reader.end({ timeout: 3 }); }, async () => { await holder.end({ timeout: 3 }); }], bodyErrors);
  }
  expect(await rawState()).toEqual(before);
}));

it("captures from a genuine v5 session with source DML and item execution still rejected", exercise(async () => {
  const { provisionReplayHandlerProfile, openVerifiedReplayHandlerDatabase, verifyReplayDatabaseSession } =
    await import("@/lib/operations/pipeline-replay-database");
  const { withReplayDatabaseScope } = await import("@/lib/db/replay-scope");
  const { claimItemSecondReview } = await import("@/lib/crawl/second-review-ownership");
  const before = await rawState(), wanted = await expectFull();
  await provisionReplayHandlerProfile({ databaseUrl: TEST_DATABASE_URL, identityPath: bootstrap!.identityPath,
    acknowledgeDedicatedCluster: true, env: {} }); profileInstalled = true;
  verified = await openVerifiedReplayHandlerDatabase(bootstrap!.identityPath, {});
  const database = verified;
  const result = await database.client.begin(async tx => {
    await verifyReplayDatabaseSession(tx, database);
    const [role] = await tx`SELECT current_user AS role,session_user AS session,
      has_table_privilege(current_user,'pipeline_replay.capacity_inputs','SELECT') AS input_select,
      has_table_privilege(current_user,'public.pipeline_item_leases','INSERT,DELETE') AS item_dml`;
    expect(role).toEqual({ role: database.identity.roleName, session: database.identity.roleName, input_select: true, item_dml: false });
    return captureReplayCombinedState(tx, manifest);
  });
  expect(result).toEqual(wanted);
  await expect(database.client`UPDATE crawl_documents SET id=id WHERE id=${fixture.document.id}`)
    .rejects.toMatchObject({ code: "42501", message: "replay_handler_source_immutable" });
  await expect(database.client`UPDATE pipeline_item_leases SET work_key=work_key WHERE stage=${lease.stage} AND work_key=${lease.workKey}`)
    .rejects.toMatchObject({ code: "42501", message: "replay_handler_source_immutable" });
  await expect(database.client`DELETE FROM pipeline_item_leases WHERE stage=${lease.stage} AND work_key=${lease.workKey}`)
    .rejects.toMatchObject({ code: "42501" });
  await expect(admin`UPDATE pipeline_stage_modes SET stage=stage WHERE stage='ai2'`)
    .rejects.toMatchObject({ code: "42501", message: "replay_handler_source_immutable" });
  await expect(withReplayDatabaseScope(bootstrap!.identityPath, () => claimItemSecondReview(fixture.candidate.id, owner, 90_000)))
    .rejects.toThrow("replay_item_execution_unsupported");
  expect(await rawState()).toEqual(before);
  expect(await database.client.begin(tx => captureReplayCombinedState(tx, manifest))).toEqual(wanted);
  // Hooks retain the original Promise, then close the real verified client,
  // normally remove the profile/release bootstrap and only then restore source.
}));
