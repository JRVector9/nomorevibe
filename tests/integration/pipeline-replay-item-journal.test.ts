import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, pipelineItemLeases } from "@/lib/db/schema";
import { itemBindingHash, type Ai2ItemBinding, type ItemLease } from "@/lib/jobs/items/types";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { openVerifiedReplayHandlerDatabase } from "@/lib/operations/pipeline-replay-database";
import { ReplayLedger, type ReplayCallRequest } from "@/lib/operations/pipeline-replay-ledger";
import { runCertifiedFixtureReviewReplay, runCertifiedItemFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";
import { replayArtifactFromVerified } from "@/lib/operations/pipeline-replay-artifact";
import { withReplayDatabaseScope, assertReplayDatabaseScopeIdentity } from "@/lib/db/replay-scope";
import { withReplayExecutionScope, replayQuiescenceProof, registerReplayItemFinalAuthority, reserveReplayItemCall } from "@/lib/operations/pipeline-replay-execution";
import { withReplayFinalScope } from "@/lib/operations/pipeline-replay-final";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { withReviewFixtureTransport } from "@/lib/crawl/review-fixture-transport";
import { executeSecondReviewItem } from "@/lib/crawl/second-review-item-lifecycle";
import { claimItemSecondReview, renewSecondReviewOwnership, type SecondReviewItemReceipt } from "@/lib/crawl/second-review-ownership";
import { dispatchSecondReviewTransport } from "@/lib/crawl/second-review-transport";
import { enqueueSecondReviews, pendingSecondReviews, recordSecondReview } from "@/lib/crawl/second-review";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { runJob } from "@/lib/jobs/runner";
import { parseReplayArtifact, replayArtifactContentHash } from "@/lib/operations/pipeline-replay-artifact";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

import { getReplayItemHandlerIdentityPath } from "./replay-item-handler-fixtures";

const reference = new Date("2001-11-01T00:00:00.000Z");
const prefix = `item-journal-${randomUUID().slice(0, 8)}`;
let admin: postgres.Sql;
let release: (() => Promise<void>) | undefined;
let baselineCaptured = false;
let sentinelCreated = false;
let sentinelId: number, sentinelItem: postgres.Row[] | undefined;
let originalForeign: postgres.Row[], originalDocuments: postgres.Row[], originalVotes: postgres.Row[], originalObservations: postgres.Row[], originalItems: postgres.Row[];
let originalSettings: postgres.Row[], originalJobs: postgres.Row[], originalStages: postgres.Row[], foreign: postgres.Row[];
const work = new Set<Promise<unknown>>();
type DiagnosticPhase = "prepare.candidate_insert" | "prepare.document_insert" | "prepare.settings_upsert"
  | "prepare.jobs_delete" | "prepare.job_request_insert" | "prepare.profile_identity"
  | "prepare.handler_database_open" | "prepare.preview_legacy" | "prepare.preview_item"
  | "prepare.preview_database_close" | "run.certified_legacy" | "run.certified_item"
  | "fixture.result_return" | "cleanup.work_settle" | "cleanup.profile_release" | "after_all.admin_end";
let diagnosticSeq = 0;
const diagnosticStarted = Date.now();
function failureSummary(error: unknown): { sqlState: string; operation: string; relations: string[] } {
  try {
    for (let depth = 0; error && typeof error === "object" && depth < 5; depth++) {
      const current = error as { code?: unknown; query?: unknown; cause?: unknown };
      const code = current.code;
      if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) {
        const value = current.query, query = typeof value === "string" ? value : "";
        // Provisioning errors can contain passwords; only fixed labels leave this function.
        const operation = ["CREATE TRIGGER", "DROP TRIGGER", "ALTER TABLE", "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]
          .find(label => new RegExp(`^\\s*${label}\\b`, "i").test(query)) ?? "unknown";
        const relations = operation === "unknown" ? [] : ["crawl_candidates", "crawl_review_attempts", "second_reviews",
          "crawl_frontier", "jobs", "operations_observations", "crawl_settings", "crawl_documents", "products",
          "agent_repository_scans", "agent_repository_observations", "pipeline_stage_modes", "pipeline_item_leases",
          "pipeline_replay.identity", "pipeline_replay.handler_profile", "pipeline_replay.capacity_calls",
          "pipeline_replay.capacity_runs", "pipeline_replay.capacity_finals", "pipeline_replay.capacity_transitions"]
          .filter(name => new RegExp(`\\b(?:ON|INTO|FROM|UPDATE|TABLE)\\s+(?:public\\.)?${name.replaceAll(".", "\\.")}\\b`, "i")
            .test(query.replaceAll('"', "")));
        return { sqlState: code, operation, relations };
      }
      error = current.cause;
    }
  } catch { /* A diagnostic getter must not replace the original rejection. */ }
  return { sqlState: "unknown", operation: "unknown", relations: [] };
}
function emitPhase(seq: number, phase: DiagnosticPhase, state: "begin" | "end" | "reject",
  failure?: ReturnType<typeof failureSummary>): void {
  try {
    process.stderr.write(JSON.stringify({ event: "item_journal_fixture_phase", seq, phase, state,
      elapsedMs: Date.now() - diagnosticStarted, ...(failure ? { failure } : {}) }) + "\n");
  } catch { /* Diagnostic output must not alter fixture work or its original error. */ }
}
function observe<T extends Promise<unknown> | undefined>(phase: DiagnosticPhase, load: () => T): T {
  const seq = ++diagnosticSeq;
  emitPhase(seq, phase, "begin");
  try {
    const pending = load();
    if (pending === undefined) emitPhase(seq, phase, "end");
    else void pending.then(() => emitPhase(seq, phase, "end"), error => emitPhase(seq, phase, "reject", failureSummary(error)));
    return pending;
  } catch (error) {
    emitPhase(seq, phase, "reject", failureSummary(error));
    throw error;
  }
}
type PreviewProjection = Awaited<ReturnType<ReplayLedger["previewInitialState"] | ReplayLedger["previewItemInitialState"]>>["projection"];
function emitPreviewSize(items: boolean, projection: PreviewProjection): void {
  try {
    const started = performance.now();
    const domain = "domain" in projection ? projection.domain : projection;
    const tables = ["crawl_settings", "crawl_candidates", "crawl_documents", "crawl_review_attempts", "second_reviews",
      "agent_repository_scans", "agent_repository_observations", "products", "crawl_frontier", "jobs", "operations_observations", "capacity_calls"] as const;
    const rows = Object.fromEntries(tables.map(name => [name, domain.tables[name].length]));
    const itemRows = "items" in projection ? { stages: projection.items.tables.pipeline_stage_modes.length,
      items: projection.items.tables.pipeline_item_leases.length } : null;
    const jsonBytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
    process.stderr.write(JSON.stringify({ event: "item_journal_preview_size", kind: items ? "item" : "legacy",
      rows, universe: domain.universe.length, itemRows, jsonBytes, measurementMs: Math.round((performance.now() - started) * 1_000) / 1_000 }) + "\n");
  } catch {
    try { process.stderr.write(JSON.stringify({ event: "item_journal_preview_size", kind: items ? "item" : "legacy", unknown: true }) + "\n"); }
    catch { /* Size diagnostics cannot alter the original preview/hash or cleanup. */ }
  }
}
function track<T>(promise: Promise<T>): Promise<T> {
  work.add(promise); void promise.then(() => work.delete(promise), () => work.delete(promise)); return promise;
}
async function settle() { await Promise.allSettled([...work]); }

beforeAll(() => track((async () => {
  ensureSchema();
  admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {} });
  originalSettings = await admin`SELECT to_jsonb(t) AS row FROM crawl_settings t ORDER BY id`;
  originalJobs = await admin`SELECT to_jsonb(t) AS row FROM jobs t WHERE name IN ('crawl-agent-review','second-review','crawl-publish') ORDER BY name`;
  originalStages = await admin`SELECT to_jsonb(t) AS row FROM pipeline_stage_modes t ORDER BY stage`;
  originalDocuments = await admin`SELECT to_jsonb(t) AS row FROM crawl_documents t ORDER BY id`;
  originalVotes = await admin`SELECT to_jsonb(t) AS row FROM second_reviews t ORDER BY id`;
  originalObservations = await admin`SELECT to_jsonb(t) AS row FROM operations_observations t ORDER BY key`;
  originalItems = await admin`SELECT to_jsonb(t) AS row FROM pipeline_item_leases t ORDER BY stage,work_key`;
  originalForeign = await admin`SELECT to_jsonb(t) AS row FROM crawl_candidates t ORDER BY id`;
  foreign = originalForeign;
  baselineCaptured = true;
  await admin.begin(async tx => {
    const [sentinel] = await tx`INSERT INTO crawl_candidates(repo,product_url,state,reason,decided_by,updated_at)
      VALUES(${prefix + '-foreign/sentinel'},'https://foreign.example','needs_review','second_review_split','auto',
        '2000-01-01 00:00:00.123456'::timestamp) RETURNING id`;
    sentinelId = sentinel.id;
    await tx`INSERT INTO crawl_documents(repo,product_url,fetched_at,repo_meta,page_meta) VALUES(${prefix + '-foreign/sentinel'},
      'https://foreign.example','2000-01-01 00:00:00.654321'::timestamp,'{}'::jsonb,'{}'::jsonb)`;
  });
  sentinelCreated = true;
  foreign = await admin`SELECT to_jsonb(t) AS row FROM crawl_candidates t ORDER BY id`;
  // Global legacy handlers must not consume another file's fixture universe.
  await admin`UPDATE crawl_candidates SET decided_by='admin'`;
  await admin`UPDATE second_reviews SET status='resolved',resolution='kept'`;
})()));
let cleanup: Promise<void> | undefined;
function cleanupCase(): Promise<void> {
  if (cleanup) return cleanup;
  const pending = (async () => {
  await observe("cleanup.work_settle", settle);
  if (!baselineCaptured) return;
  await observe("cleanup.profile_release", () => release?.()); release = undefined;
  if (sentinelItem) {
    expect(await admin`SELECT to_jsonb(t) AS row FROM pipeline_item_leases t WHERE stage='ai2' AND work_key=${`ai2:${1_000_000_000 + sentinelId}`}`).toEqual(sentinelItem);
    await admin`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${1_000_000_000 + sentinelId}`}`;
    sentinelItem = undefined;
  }
  await admin`DELETE FROM pipeline_item_leases WHERE binding->>'candidateId' IN (SELECT id::text FROM crawl_candidates WHERE repo LIKE ${prefix + '/%'})`;
  await admin`DELETE FROM second_reviews WHERE candidate_id IN (SELECT id FROM crawl_candidates WHERE repo LIKE ${prefix + '/%'})`;
  await admin`DELETE FROM crawl_review_attempts WHERE candidate_id IN (SELECT id FROM crawl_candidates WHERE repo LIKE ${prefix + '/%'})`;
  await admin`DELETE FROM crawl_candidates WHERE repo LIKE ${prefix + '/%'}`;
  await admin`DELETE FROM crawl_documents WHERE repo LIKE ${prefix + '/%'}`;
  await admin`DELETE FROM jobs WHERE name IN ('crawl-agent-review','second-review','crawl-publish')`;
  await admin`DELETE FROM operations_observations WHERE key IN ('job:crawl-agent-review','job:second-review')`;
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,epoch=r.epoch,
    writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages.map(row => row.row))}::text::jsonb) r WHERE s.stage=r.stage`;
  })();
  cleanup = pending;
  void pending.then(() => { cleanup = undefined; }, () => { cleanup = undefined; });
  return pending;
}
afterEach(cleanupCase);
afterAll(async () => {
  try {
    await settle();
    await cleanup;
    if (!baselineCaptured) return;
    await admin.begin(async tx => {
      await tx`DELETE FROM jobs WHERE name IN ('crawl-agent-review','second-review','crawl-publish')`;
      await tx`DELETE FROM operations_observations WHERE key IN ('job:crawl-agent-review','job:second-review')`;
      const managedObservations = originalObservations.filter(row => ["job:crawl-agent-review","job:second-review"].includes(row.row.key));
      if (managedObservations.length) await tx`INSERT INTO operations_observations SELECT * FROM jsonb_populate_recordset(NULL::operations_observations,
        ${JSON.stringify(managedObservations.map(row => row.row))}::text::jsonb)`;
      if (originalVotes.length) await tx`UPDATE second_reviews s SET status=r.status,resolution=r.resolution
        FROM jsonb_populate_recordset(NULL::second_reviews,${JSON.stringify(originalVotes.map(row => row.row))}::text::jsonb) r WHERE s.id=r.id`;
      if (originalJobs.length) await tx`INSERT INTO jobs SELECT * FROM jsonb_populate_recordset(NULL::jobs,${JSON.stringify(originalJobs.map(row => row.row))}::text::jsonb)`;
      if (originalSettings.some(row => row.row.id === 1)) {
        await tx`UPDATE crawl_settings s SET values=r.values,updated_by=r.updated_by,updated_at=r.updated_at
          FROM jsonb_populate_recordset(NULL::crawl_settings,${JSON.stringify(originalSettings.map(row => row.row))}::text::jsonb) r WHERE s.id=1 AND r.id=1`;
      } else await tx`DELETE FROM crawl_settings WHERE id=1`;
      if (foreign.length) await tx`UPDATE crawl_candidates c SET decided_by=r.decided_by
        FROM jsonb_populate_recordset(NULL::crawl_candidates,${JSON.stringify(foreign.map(row => row.row))}::text::jsonb) r WHERE c.id=r.id`;
      expect(await tx`SELECT to_jsonb(t) AS row FROM crawl_candidates t ORDER BY id`).toEqual(foreign);
      if (sentinelCreated) {
      const [sentinelDocument] = await tx`SELECT fetched_at::text AS fetched FROM crawl_documents WHERE repo=${prefix + '-foreign/sentinel'}`;
      expect(sentinelDocument.fetched).toBe("2000-01-01 00:00:00.654321");
      await tx`DELETE FROM crawl_candidates WHERE id=${sentinelId} AND repo=${prefix + '-foreign/sentinel'}`;
      await tx`DELETE FROM crawl_documents WHERE repo=${prefix + '-foreign/sentinel'}`;
      }
      expect(await tx`SELECT to_jsonb(t) AS row FROM crawl_candidates t ORDER BY id`).toEqual(originalForeign);
      expect(await tx`SELECT to_jsonb(t) AS row FROM crawl_documents t ORDER BY id`).toEqual(originalDocuments);
      expect(await tx`SELECT to_jsonb(t) AS row FROM second_reviews t ORDER BY id`).toEqual(originalVotes);
      expect(await tx`SELECT to_jsonb(t) AS row FROM operations_observations t ORDER BY key`).toEqual(originalObservations);
      expect(await tx`SELECT to_jsonb(t) AS row FROM pipeline_item_leases t ORDER BY stage,work_key`).toEqual(originalItems);
      expect(await tx`SELECT to_jsonb(t) AS row FROM crawl_settings t ORDER BY id`).toEqual(originalSettings);
      expect(await tx`SELECT to_jsonb(t) AS row FROM jobs t WHERE name IN ('crawl-agent-review','second-review','crawl-publish') ORDER BY name`).toEqual(originalJobs);
      expect(await tx`SELECT to_jsonb(t) AS row FROM pipeline_stage_modes t ORDER BY stage`).toEqual(originalStages);
    });
  } finally { await observe("after_all.admin_end", () => admin?.end({ timeout: 3 })); }
});

async function prepare(items: boolean, extra: { voters?: string[]; fallback?: boolean } = {}) {
  const settings = { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce" as const,
    firstReview: { provider: "abcllm" as const, model: "fixture-first" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: (extra.voters ?? ["fixture-second"]).map(model => ({ provider: "abcllm" as const, model })),
      fallbacks: extra.fallback ? [{ provider: "abcllm" as const, model: "fixture-fallback" }] : [], sampleRate: 0 } };
  const repo = `${prefix}/${randomUUID().slice(0, 8)}`;
  // Drizzle queries are lazy thenables: assimilate each once before observing the native Promise.
  const [candidate] = await observe("prepare.candidate_insert", async () => db.insert(crawlCandidates).values({ repo, productUrl: `https://${prefix}.example`,
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: reference, updatedAt: reference }).returning());
  const [document] = await observe("prepare.document_insert", async () => db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl,
    fetchedAt: new Date(+reference - 1_000), pageStatus: 200,
    repoMeta: { description: "An online task tracker", homepage: candidate.productUrl, fork: false, private: false,
      archived: false, owner: { type: "User" }, stargazers_count: 10, pushed_at: new Date(+reference - 10_000).toISOString() },
    pageMeta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create projects and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION } }).returning());
  await observe("prepare.settings_upsert", async () => db.insert(crawlSettings).values({ id: 1, values: settings }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings } }));
  await observe("prepare.jobs_delete", () => admin`DELETE FROM jobs WHERE name IN ('crawl-agent-review','second-review','crawl-publish')`);
  await observe("prepare.job_request_insert", () => admin`INSERT INTO jobs(name,requested_version) VALUES('crawl-agent-review',1)`);
  if (items) {
    await admin`UPDATE pipeline_stage_modes SET mode='items',epoch=2,writer_contract_version=1 WHERE stage='ai2'`;
    // Structural foreign/released history, never an issued authority or live proof.
    const id = 1_000_000_000 + sentinelId;
    const binding: Ai2ItemBinding = { stage: "ai2", secondReviewId: id, candidateId: sentinelId,
      source: { kind: "first_attempt", firstAttemptId: id }, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
      policyHash: "c".repeat(64), promptVersion: "foreign-history", rulesVersion: "foreign-history",
      reviewer: { provider: "abcllm", model: "foreign-model" }, generationKey: "d".repeat(64), vote: id, fallbackForId: null };
    expect(await admin`SELECT 1 FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${id}`}`).toHaveLength(0);
    await db.insert(pipelineItemLeases).values({ stage: "ai2", workKey: `ai2:${id}`, binding, bindingHash: itemBindingHash(binding),
      stageEpoch: 1, itemEpoch: 3, createdAt: reference, updatedAt: reference });
    sentinelItem = [...await admin`SELECT to_jsonb(t) AS row FROM pipeline_item_leases t WHERE stage='ai2' AND work_key=${`ai2:${id}`}`];
  }
  const input = createReviewInput(candidate, document, settings, { scan: null, observations: [] }, reference);
  const model = (value: { provider: "abcllm"; model: string }) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  const manifest: CapacityManifest = { version: 1, runId: randomUUID(), revision: "69512b92", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: input.policyHash, fullReviewPolicyHash: fullReviewPolicyHash(settings), comparisonPolicyHash: comparisonReviewPolicyHash(settings),
    initialStateHash: reviewHash({ candidate, document }), models: { first: model(settings.firstReview), second: settings.secondReview.voters.map(model), fallbacks: settings.secondReview.fallbacks.map(model) },
    inputs: [{ candidateId: candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 120_000, concurrency: 2 } };
  const owned = await observe("prepare.profile_identity", () => items ? getReplayItemHandlerIdentityPath() : getReplayHandlerIdentityPath()); release = owned.release;
  const database = await observe("prepare.handler_database_open", () => openVerifiedReplayHandlerDatabase(owned.identityPath, {})), inputs = [{ candidateId: candidate.id, input }];
  try {
    const preview = await observe(items ? "prepare.preview_item" : "prepare.preview_legacy", () => items ? new ReplayLedger(database).previewItemInitialState(manifest, inputs)
      : new ReplayLedger(database).previewInitialState(manifest, inputs));
    manifest.initialStateHash = preview.initialStateHash;
    emitPreviewSize(items, preview.projection);
  }
  finally { await observe("prepare.preview_database_close", () => database.close()); }
  return { identityPath: owned.identityPath, manifest, inputs, candidate, settings };
}
const fixture = () => observe("fixture.result_return", async () => ({ result: { ok: true as const, outcome: { decision: "approve" as const, confidence: .99,
  reason: "An online task tracker", evidenceIds: ["product"] }, usage: { inputTokens: 8, outputTokens: 2 } },
  receipt: { inputTokens: 8, outputTokens: 2 } }));

it("preserves genuine legacy v1 fixture certification", async () => {
  const value = await prepare(false), result = await track(observe("run.certified_legacy", () => runCertifiedFixtureReviewReplay({ ...value, fixture })));
  expect(result.diagnostics.finalCandidates).toBe(1);
  expect(replayArtifactFromVerified(result.artifact)).toMatchObject({ version: 1, run: { profile: "handlers-v5" } });
});

it("certifies actual AI1 legacy then AI2 item work with persisted owner journal and a strict seal", async () => {
  const value = await prepare(true), result = await track(observe("run.certified_item", () => runCertifiedItemFixtureReviewReplay({ ...value, fixture })));
  const artifact = replayArtifactFromVerified(result.artifact);
  expect(artifact).toMatchObject({ version: 2, run: { profile: "handlers-v6-item" } });
  expect(result.diagnostics.finalCandidates).toBe(1);
  expect(artifact.calls).toHaveLength(2);
  expect(artifact.finals).toHaveLength(1);
  const changes = await admin`SELECT operation,old_row,new_row FROM pipeline_replay.capacity_changes
    WHERE run_id=${value.manifest.runId} AND table_name='pipeline_item_leases' ORDER BY ordinal`;
  expect(changes.some(row => row.new_row?.token && row.new_row.owner_boot_id && row.new_row.item_epoch > 0)).toBe(true);
  expect(changes.some(row => row.old_row?.token && row.new_row?.token === null)).toBe(true);
  expect(await admin`SELECT token,owner_instance_id,owner_boot_id,lease_until FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId'=${String(value.candidate.id)}`)
    .toEqual([{ token: null, owner_instance_id: null, owner_boot_id: null, lease_until: null }]);
});

it("keeps the full independent two-slot gate and historical released owners", async () => {
  const value = await prepare(true, { voters: ["fixture-second", "fixture-third"] });
  const result = await track(observe("run.certified_item", () => runCertifiedItemFixtureReviewReplay({ ...value, fixture })));
  const artifact = replayArtifactFromVerified(result.artifact);
  expect(artifact.calls).toHaveLength(3);
  expect(artifact.finals[0].secondWitnesses).toHaveLength(2);
  expect(result.diagnostics.finalCandidates).toBe(1);
  expect(result.diagnostics.readinessIntervals.length).toBeGreaterThan(0);
  expect(result.diagnostics.budgetEvidence).toBe("unverified");
  expect(artifact.version).toBe(2);
  if (artifact.version !== 2) throw new Error("item_artifact_required");
  const changed = structuredClone(artifact), authority = changed.journal.find(row => row.kind === "item_call_authority")!;
  const payload = authority.payload as { lease: { owner_boot_id: string } };
  payload.lease.owner_boot_id = randomUUID();
  authority.payloadHash = reviewHash(authority.payload);
  const { seal: ignored, ...content } = changed; void ignored;
  changed.seal.contentHash = replayArtifactContentHash(content);
  expect(() => parseReplayArtifact(changed)).toThrow("invalid_replay_artifact");
  const rebound = structuredClone(artifact), original = rebound.journal.find(row => row.kind === "item_call_authority")!;
  const originalPayload = original.payload as { callId: string; txKey: string; lease: { work_key: string; token: string } };
  const laterWall = rebound.journal.find(row => row.kind === "item_final_authority" && row.txKey !== original.txKey
    && row.seq > original.seq && (row.payload as { items: Array<{ work_key: string; token: string; released: boolean }> }).items.some(item =>
      item.work_key === originalPayload.lease.work_key && item.token === originalPayload.lease.token && !item.released));
  expect(laterWall).toBeDefined();
  original.txKey = laterWall!.txKey; originalPayload.txKey = laterWall!.txKey!;
  original.payloadHash = reviewHash(original.payload);
  const { seal: ignoredRebound, ...reboundContent } = rebound; void ignoredRebound;
  rebound.seal.contentHash = replayArtifactContentHash(reboundContent);
  expect(() => parseReplayArtifact(rebound)).toThrow("invalid_replay_artifact");
});

it("settles a cancelled item call without inventing a final", async () => {
  const value = await prepare(true);
  const result = await track(observe("run.certified_item", () => runCertifiedItemFixtureReviewReplay({ ...value, fixture: async call => call.request.stage === "first"
    ? fixture() : { result: { ok: false, error: "cancelled" }, receipt: { inputTokens: 0, outputTokens: 0 } } })));
  const artifact = replayArtifactFromVerified(result.artifact);
  expect(artifact.calls).toHaveLength(2);
  expect(artifact.finals).toHaveLength(0);
  expect(artifact.calls.find(row => row.stage === "second")).toMatchObject({ state: "settled", resultOk: false, failureClass: "cancelled" });
  expect(await admin`SELECT token FROM pipeline_item_leases WHERE binding->>'candidateId'=${String(value.candidate.id)}`).toEqual([{ token: null }]);
});

it("binds an actual failed root and independently claimed fallback to the final", async () => {
  const value = await prepare(true, { fallback: true });
  const result = await track(observe("run.certified_item", () => runCertifiedItemFixtureReviewReplay({ ...value, fixture: async call => call.request.model === "fixture-second"
    ? { result: { ok: false, error: "timeout" }, receipt: { inputTokens: 0, outputTokens: 0 } } : fixture() })));
  const artifact = replayArtifactFromVerified(result.artifact);
  expect(artifact.calls).toHaveLength(3);
  expect(artifact.finals).toHaveLength(1);
  expect(artifact.finals[0].secondWitnesses[0]).toMatchObject({ model: "fixture-fallback", rootCallId: expect.any(String) });
});

async function manual(value: Awaited<ReturnType<typeof prepare>>, action: (run: Parameters<typeof withReplayExecutionScope>[0], ledger: ReplayLedger) => Promise<void | { fenced: true }>) {
  const database = await openVerifiedReplayHandlerDatabase(value.identityPath, {}), ledger = new ReplayLedger(database);
  let run: Awaited<ReturnType<typeof ledger.prepareCertifiedItems>> | undefined;
  let fenced = false;
  try {
    run = await ledger.prepareCertifiedItems(value.manifest, value.inputs, { runner: { jobs: ["crawl-agent-review", "second-review"], budgetMs: 110_000 }, quality: null });
    await ledger.start(run);
    await withReplayExecutionScope(run, () => withReplayDatabaseScope(value.identityPath, async () => {
      assertReplayDatabaseScopeIdentity(database);
      try {
        await withReplayFinalScope(run!, () => withReviewReplayContext({ referenceTime: reference }, () => withReviewFixtureTransport({
          ledger, run: run!, fixture, inputs: value.inputs, tokenUpperBound: 100, fullReviewPolicyHash: value.manifest.fullReviewPolicyHash,
        }, async () => {
          expect((await runJob("crawl-agent-review", reviewCrawlCandidates, { requestedOnly: true, budgetMs: 110_000 })).status).toBe("completed");
          expect((await runJob<null>("second-review", async ctx => {
            if (!ctx.lease) throw new Error("missing_actual_lease");
            await enqueueSecondReviews(value.settings, undefined, ctx.lease); return { done: true };
          }, { requestedOnly: true, budgetMs: 110_000 })).status).toBe("completed");
          fenced = (await action(run!, ledger))?.fenced === true;
        })));
      } finally { await ledger.drain(run!); }
    }));
    if (!fenced) await ledger.fenceWriters(run);
    await ledger.seal(run, replayQuiescenceProof(run));
  } finally { await database.close(); }
}

async function rawWriterState(runId: string) {
  return admin.begin(async tx => ({
    candidate: await tx`SELECT to_jsonb(t) AS row FROM crawl_candidates t WHERE repo LIKE ${prefix + '/%'} ORDER BY id`,
    votes: await tx`SELECT to_jsonb(t) AS row FROM second_reviews t WHERE repo LIKE ${prefix + '/%'} ORDER BY id`,
    items: await tx`SELECT to_jsonb(t) AS row FROM pipeline_item_leases t WHERE binding->>'candidateId' IN
      (SELECT id::text FROM crawl_candidates WHERE repo LIKE ${prefix + '/%'}) ORDER BY stage,work_key`,
    jobs: await tx`SELECT to_jsonb(t) AS row FROM jobs t WHERE name='crawl-publish'`,
    changes: await tx`SELECT to_jsonb(t) AS row FROM pipeline_replay.capacity_changes t WHERE run_id=${runId} ORDER BY tx_key,ordinal`,
    packets: await tx`SELECT to_jsonb(t) AS row FROM pipeline_replay.capacity_transactions t WHERE run_id=${runId} ORDER BY seq`,
    events: await tx`SELECT to_jsonb(t) AS row FROM pipeline_replay.capacity_transitions t WHERE run_id=${runId} ORDER BY seq`,
    run: await tx`SELECT event_seq,current_projection FROM pipeline_replay.capacity_runs WHERE run_id=${runId}`,
  }));
}

it("rolls back item release, domain, outbox and journal when actual run-row wait crosses item expiry", async () => {
  const value = await prepare(true);
  let observed = false;
  await track(manual(value, async run => {
    const [row] = await pendingSecondReviews(1);
    const claim = await claimItemSecondReview(row.id, { instanceId: prefix, bootId: randomUUID() }, 90_000);
    if (claim.kind !== "claimed" || claim.receipt.ownership.kind !== "item") throw new Error("actual_item_claim_required");
    const receipt = claim.receipt as SecondReviewItemReceipt;
    const result = await dispatchSecondReviewTransport({ stage: "second", candidateId: row.candidateId, firstAttemptId: row.firstAttemptId,
      secondReviewId: row.id, generationKey: row.generationKey, vote: row.id, provider: row.provider!, model: row.model! }, claim.input,
    { timeoutMs: 10_000, itemReceipt: receipt });
    expect(result.ok).toBe(true);
    expect(await renewSecondReviewOwnership(receipt, 750)).not.toBeNull();
    const [clock] = await admin`SELECT to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expiry,
      lease_until>clock_timestamp() AS healthy FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`;
    expect(clock.healthy).toBe(true);
    const before = await rawWriterState(run.runId);
    let unlock!: () => void, held!: (pid: number) => void;
    const wait = new Promise<void>(resolve => { unlock = resolve; });
    const ready = new Promise<number>(resolve => { held = resolve; });
    const holding = track(admin.begin(async tx => {
      await tx`SELECT run_id FROM pipeline_replay.capacity_runs WHERE run_id=${run.runId} FOR UPDATE`;
      const [pid] = await tx`SELECT pg_backend_pid() AS pid`; held(pid.pid); await wait;
    }));
    let writer: Promise<unknown> | undefined;
    try {
      const holder = await ready;
      writer = track(recordSecondReview({ receipt, result: { ok: true, decision: "approve", confidence: .99,
        reason: "An online task tracker", model: row.model!, provider: row.provider! } }));
      const caught = writer.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      let blocked = false, healthyAtWait = false;
      for (let i = 0; i < 1_000; i++) {
        const [proof] = await admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${holder}=ANY(pg_blocking_pids(a.pid))
          AND a.query LIKE '%pipeline_replay.capacity_runs%') AS blocked, clock_timestamp()<${clock.expiry}::text::timestamptz AS healthy`;
        if (proof.blocked) { blocked = true; healthyAtWait = proof.healthy; break; }
      }
      expect(blocked).toBe(true); expect(healthyAtWait).toBe(true);
      for (;;) {
        const [expired] = await admin`SELECT clock_timestamp()>=${clock.expiry}::text::timestamptz AS expired`;
        if (expired.expired) break;
      }
      observed = true; unlock(); await holding;
      const answer = await caught;
      expect(answer.value).toBeUndefined(); expect(answer.error).toBeInstanceOf(Error);
      expect((answer.error as Error).message).toBe("job_lease_lost");
      expect(await rawWriterState(run.runId)).toEqual(before);
    } finally { unlock(); await Promise.allSettled([holding, ...(writer ? [writer] : [])]); }
  }));
  expect(observed).toBe(true);
});

it("preserves an actual healthy foreign owner and rejects a forged result token without side effects", async () => {
  const value = await prepare(true);
  await track(manual(value, async run => {
    const [row] = await pendingSecondReviews(1);
    const owner = { instanceId: prefix, bootId: randomUUID() };
    const claimed = await claimItemSecondReview(row.id, owner, 90_000);
    if (claimed.kind !== "claimed" || claimed.receipt.ownership.kind !== "item") throw new Error("actual_item_claim_required");
    const before = await rawWriterState(run.runId);
    expect(await executeSecondReviewItem({ secondReviewId: row.id, owner: { ...owner, bootId: randomUUID() } }))
      .toEqual({ state: "skipped", reason: "running" });
    const observed = await rawWriterState(run.runId);
    for (const key of ["candidate", "votes", "items", "jobs"] as const) expect(observed[key]).toEqual(before[key]);
    const forged: SecondReviewItemReceipt = { ...structuredClone(claimed.receipt), ownership: { kind: "item",
      lease: { ...structuredClone(claimed.receipt.ownership.lease), token: randomUUID() } } };
    const stable = await rawWriterState(run.runId);
    await expect(recordSecondReview({ receipt: forged, result: { ok: true, decision: "approve", confidence: .99,
      reason: "An online task tracker", model: row.model!, provider: row.provider! } })).rejects.toThrow("item_lease_lost");
    expect(await rawWriterState(run.runId)).toEqual(stable);
    expect(await recordSecondReview({ receipt: claimed.receipt, result: { ok: false, error: "cancelled", model: row.model!, provider: row.provider! } }))
      .toEqual({ state: "cancelled" });
  }));
});

it("rejects a fresh item claim after authentic admission closes", async () => {
  const value = await prepare(true);
  await track(manual(value, async (run, ledger) => {
    const [row] = await pendingSecondReviews(1);
    await ledger.closeAdmission(run);
    const before = await rawWriterState(run.runId);
    await expect(claimItemSecondReview(row.id, { instanceId: prefix, bootId: randomUUID() }, 90_000))
      .rejects.toThrow("replay_job_admission_closed");
    expect(await rawWriterState(run.runId)).toEqual(before);
  }));
});

it("rejects a duplicated callId authority masking another terminal cancelled call even with no final", async () => {
  const value = await prepare(true, { voters: ["fixture-second", "fixture-third"] });
  const result = await track(observe("run.certified_item", () => runCertifiedItemFixtureReviewReplay({ ...value, fixture: async call => call.request.stage === "first" ? fixture()
    : { result: { ok: false, error: "cancelled" }, receipt: { inputTokens: 0, outputTokens: 0 } } })));
  const artifact = replayArtifactFromVerified(result.artifact);
  expect(artifact.finals).toHaveLength(0);
  expect(artifact.calls.filter(row => row.stage === "second")).toHaveLength(2);
  if (artifact.version !== 2) throw new Error("item_artifact_required");
  const changed = structuredClone(artifact), proofs = changed.journal.filter(row => row.kind === "item_call_authority");
  expect(proofs).toHaveLength(2);
  (proofs[1].payload as { callId: string }).callId = (proofs[0].payload as { callId: string }).callId;
  proofs[1].payloadHash = reviewHash(proofs[1].payload);
  const { seal: ignored, ...content } = changed; void ignored;
  changed.seal.contentHash = replayArtifactContentHash(content);
  expect(() => parseReplayArtifact(changed)).toThrow("invalid_replay_artifact");
});

it("pins an actual item identity before a caller mutates its lease during the row-lock wait", async () => {
  const value = await prepare(true, { voters: ["fixture-second", "fixture-third"] });
  let expectedKey: string | undefined, observedKey: string | undefined, blocked = false;
  await track(manual(value, async run => {
    const rows = await pendingSecondReviews(2), claims = [];
    for (const row of rows) {
      const claim = await claimItemSecondReview(row.id, { instanceId: prefix, bootId: randomUUID() }, 90_000);
      if (claim.kind !== "claimed" || claim.receipt.ownership.kind !== "item") throw new Error("actual_item_claim_required");
      claims.push(claim.receipt as SecondReviewItemReceipt);
    }
    expect(claims).toHaveLength(2);
    const mutable = structuredClone(claims[0].ownership.lease) as { -readonly [K in keyof ItemLease]: ItemLease[K] };
    expectedKey = mutable.workKey;
    let unlock!: () => void, held!: (pid: number) => void;
    const wait = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<number>(resolve => { held = resolve; });
    const holding = track(admin.begin(async tx => {
      await tx`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${expectedKey!} FOR UPDATE`;
      const [pid] = await tx`SELECT pg_backend_pid() AS pid`; held(pid.pid); await wait;
    }));
    let registering: Promise<unknown> | undefined;
    try {
      const holder = await ready;
      registering = track(db.transaction(tx => registerReplayItemFinalAuthority(tx, mutable)));
      for (let i = 0; i < 1_000; i++) {
        const [proof] = await admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE ${holder}=ANY(pg_blocking_pids(a.pid))
          AND a.query LIKE '%pipeline_item_leases%') AS blocked`;
        if (proof.blocked) { blocked = true; break; }
      }
      expect(blocked).toBe(true);
      Object.assign(mutable, structuredClone(claims[1].ownership.lease));
      unlock(); await holding; await registering;
      const [proof] = await admin`SELECT payload FROM pipeline_replay.capacity_transitions WHERE run_id=${run.runId}
        AND kind='item_final_authority' ORDER BY seq DESC LIMIT 1`;
      observedKey = proof.payload.items[0].work_key;
    } finally { unlock(); await Promise.allSettled([holding, ...(registering ? [registering] : [])]); }
    for (const receipt of claims) expect(await recordSecondReview({ receipt, result: { ok: false, error: "cancelled",
      model: receipt.binding.reviewer.model, provider: "abcllm" } })).toEqual({ state: "cancelled" });
  }));
  expect(blocked).toBe(true);
  expect(observedKey).toBe(expectedKey);
});

it("pins request hash and charged bound before a caller mutates the deferred reservation input", async () => {
  const value = await prepare(true);
  let observed: postgres.Row | undefined;
  const originalHash = "a".repeat(64);
  await track(manual(value, async (run, ledger) => {
    const [row] = await pendingSecondReviews(1);
    const claim = await claimItemSecondReview(row.id, { instanceId: prefix, bootId: randomUUID() }, 90_000);
    if (claim.kind !== "claimed" || claim.receipt.ownership.kind !== "item") throw new Error("actual_item_claim_required");
    const receipt = claim.receipt as SecondReviewItemReceipt;
    const request: ReplayCallRequest = { stage: "second", callId: randomUUID(), candidateId: row.candidateId,
      firstAttemptId: row.firstAttemptId, secondReviewId: row.id, generationKey: row.generationKey, vote: row.fallbackForId ?? row.id,
      inputHash: claim.input.inputHash, sourceRevisionHash: claim.input.sourceRevisionHash, provider: row.provider!, model: row.model!,
      requestHash: originalHash, tokenUpperBound: 100 };
    await db.transaction(async tx => {
      await reserveReplayItemCall(tx, receipt.ownership.lease, request);
      request.requestHash = "b".repeat(64); request.tokenUpperBound = 1;
    });
    [observed] = await admin`SELECT request_hash,token_upper_bound FROM pipeline_replay.capacity_calls
      WHERE run_id=${run.runId} AND call_id=${request.callId}`;
    await ledger.cancelBeforeDispatch(run, request.callId);
    expect(await recordSecondReview({ receipt: claim.receipt, result: { ok: false, error: "cancelled", model: row.model!, provider: row.provider! } }))
      .toEqual({ state: "cancelled" });
  }));
  expect(observed).toEqual({ request_hash: originalHash, token_upper_bound: "100" });
});

it("keeps the item profile source and stage guards immutable and denies non-AI2 writes", async () => {
  const value = await prepare(true), database = await openVerifiedReplayHandlerDatabase(value.identityPath, {});
  const before = await admin`SELECT c.relname,t.oid,t.tgenabled,p.oid AS function_oid,pg_get_functiondef(p.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgname IN ('replay_handler_source_immutable','replay_handler_item_stage') ORDER BY c.relname,t.tgname`;
  try {
    for (const statement of ["UPDATE public.pipeline_stage_modes SET stage=stage WHERE false", "UPDATE public.products SET id=id WHERE false"])
      await expect(database.client.unsafe(statement)).rejects.toMatchObject({ code: "42501", message: "replay_handler_source_immutable" });
    await expect(database.client`DELETE FROM public.pipeline_item_leases WHERE false`).rejects.toMatchObject({ code: "42501" });
    await expect(database.client`TRUNCATE public.pipeline_item_leases`).rejects.toMatchObject({ code: "42501" });
    const binding = { stage: "ai1", candidateId: value.candidate.id, inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64),
      policyHash: "c".repeat(64), promptVersion: "profile", rulesVersion: "profile", reviewer: { provider: "abcllm", model: "fixture-first" } } as const;
    await expect(database.client`INSERT INTO public.pipeline_item_leases(stage,work_key,binding,binding_hash)
      VALUES('ai1',${`ai1:${value.candidate.id}`},${JSON.stringify(binding)}::text::jsonb,${itemBindingHash(binding)})`)
      .rejects.toMatchObject({ code: "42501", message: "replay_handler_item_stage_rejected" });
    expect(await admin`SELECT c.relname,t.oid,t.tgenabled,p.oid AS function_oid,pg_get_functiondef(p.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgname IN ('replay_handler_source_immutable','replay_handler_item_stage') ORDER BY c.relname,t.tgname`).toEqual(before);
  } finally { await database.close(); }
});

async function blockedBy(holder: number, pattern: string) {
  for (let i = 0; i < 1_000; i++) {
    const [row] = await admin`SELECT pid FROM pg_stat_activity WHERE ${holder}=ANY(pg_blocking_pids(pid)) AND query LIKE ${pattern} LIMIT 1`;
    if (row) return Number(row.pid);
  }
  throw new Error("actual_database_lock_wait_not_observed");
}

it("waits for a mixed-run writer's shared fence before closing writers", async () => {
  const value = await prepare(true);
  await track(manual(value, async (run, ledger) => {
    let unlock!: () => void, entered!: (pid: number) => void;
    const wait = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<number>(resolve => { entered = resolve; });
    const writer = track(db.transaction(async tx => {
      await tx.execute(sql`UPDATE crawl_candidates SET signals='{"itemFence":"writer-first"}'::jsonb WHERE id=${value.candidate.id}`);
      const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); entered(row.pid); await wait;
    }));
    let fencing: Promise<void> | undefined;
    try {
      const writerPid = await ready;
      await ledger.closeAdmission(run);
      fencing = track(ledger.fenceWriters(run));
      expect(await blockedBy(writerPid, "%pg_advisory_xact_lock(1485803,4)%")).toBeGreaterThan(0);
      unlock(); await writer; await fencing;
      expect(await admin`SELECT signals FROM crawl_candidates WHERE id=${value.candidate.id}`)
        .toEqual([{ signals: { itemFence: "writer-first" } }]);
    } finally { unlock(); await Promise.allSettled([writer, ...(fencing ? [fencing] : [])]); }
    return { fenced: true };
  }));
});

it("blocks a later mixed-run writer before candidate locking and rejects it after the exclusive fence", async () => {
  const value = await prepare(true);
  await track(manual(value, async (run, ledger) => {
    await ledger.closeAdmission(run);
    let unlock!: () => void, held!: (pid: number) => void;
    const wait = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<number>(resolve => { held = resolve; });
    const holding = track(admin.begin(async tx => {
      await tx`SELECT run_id FROM pipeline_replay.capacity_runs WHERE run_id=${run.runId} FOR UPDATE`;
      const [row] = await tx`SELECT pg_backend_pid() AS pid`; held(row.pid); await wait;
    }));
    let fencing: Promise<void> | undefined, writer: Promise<unknown> | undefined;
    try {
      const holder = await ready;
      fencing = track(ledger.fenceWriters(run));
      const fencePid = await blockedBy(holder, "%capacity_runs%FOR UPDATE%");
      writer = track(db.transaction(tx => tx.execute(sql`UPDATE crawl_candidates SET signals='{"itemFence":"late"}'::jsonb WHERE id=${value.candidate.id}`)));
      const caught = writer.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      expect(await blockedBy(fencePid, "%pg_advisory_xact_lock_shared(1485803, 4)%")).toBeGreaterThan(0);
      await admin.begin(async tx => { await tx`SELECT id FROM crawl_candidates WHERE id=${value.candidate.id} FOR UPDATE NOWAIT`; });
      const before = await rawWriterState(run.runId);
      unlock(); await holding; await fencing;
      const answer = await caught;
      expect(answer.value).toBeUndefined(); expect(answer.error).toMatchObject({ message: "replay_writers_fenced" });
      const after = await rawWriterState(run.runId);
      for (const key of ["candidate", "votes", "items", "jobs", "changes", "packets"] as const) expect(after[key]).toEqual(before[key]);
    } finally { unlock(); await Promise.allSettled([holding, ...(fencing ? [fencing] : []), ...(writer ? [writer] : [])]); }
    return { fenced: true };
  }));
});
