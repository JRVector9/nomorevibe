import { randomUUID } from "node:crypto";
import { executeSecondReviewItem } from "@/lib/crawl/second-review-item-lifecycle";
import { closeSettledSecondReviews, enqueueSecondReviews, pendingSecondReviews, reopenOrphanedGateHolds, retryFailedSecondReviews } from "@/lib/crawl/second-review";
import { reviewHash, reviewPolicyHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { firstReviewer } from "@/lib/crawl/agent-review";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { secondReviewCandidates } from "@/lib/crawl/jobs/second-review";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { getSettings } from "@/lib/crawl/settings";
import { withReviewFixtureTransport, type ReviewFixtureCallback } from "@/lib/crawl/review-fixture-transport";
import { assertReplayDatabaseScopeIdentity, currentReplayDb, withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { runJob, type RunResult } from "@/lib/jobs/runner";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, parseCapacityManifest, type CapacityManifest } from "./pipeline-capacity";
import { assertVerifiedReplayHandlerDatabase, openVerifiedReplayHandlerDatabase,
  verifyReplayDatabaseSession, type VerifiedReplayDatabase } from "./pipeline-replay-database";
import { ReplayLedger } from "./pipeline-replay-ledger";
import { withReplayFinalScope } from "./pipeline-replay-final";
import { replayQuiescenceProof, withReplayExecutionScope } from "./pipeline-replay-execution";
import { loadVerifiedReplayArtifact, reportVerifiedReplayArtifact, type ReplayArtifact } from "./pipeline-replay-artifact";

export type ReplayReviewJobName = "crawl-agent-review" | "second-review";
export type FixtureReviewReplayOptions = {
  identityPath: string;
  manifest: unknown;
  inputs: { candidateId: number; input: ReviewInput }[];
  fixture: ReviewFixtureCallback;
  /** Consume only existing requests, including their actual backoff and continuation state. */
  jobs?: readonly ReplayReviewJobName[];
  budgetMs?: number;
  signal?: AbortSignal;
};

/** This profile certifies only the original legacy fixture path. Stage/item
 * projection and authority are not journaled yet, so other states fail closed. */
async function assertLegacyReplayStages(database: VerifiedReplayDatabase): Promise<void> {
  assertVerifiedReplayHandlerDatabase(database);
  await database.client.begin(async tx => {
    await verifyReplayDatabaseSession(tx, database);
    for (const stage of ["fetch", "ai1", "ai2"]) {
      const [row] = await tx`SELECT mode, draining_from, epoch, writer_contract_version
        FROM public.pipeline_stage_modes WHERE stage=${stage} FOR SHARE`;
      if (!row || row.mode !== "legacy" || row.draining_from !== null || Number(row.epoch) !== 1
        || Number(row.writer_contract_version) !== 0) throw new Error("unsupported_replay_stage_state");
    }
    const items = await tx`SELECT work_key FROM public.pipeline_item_leases LIMIT 1 FOR SHARE`;
    if (items.length) throw new Error("unsupported_replay_stage_state");
  });
}

async function assertReplaySettings(manifest: CapacityManifest): Promise<void> {
  const settings = await getSettings();
  const first = firstReviewer(settings);
  const identity = (value: { provider: string; model: string }) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  if (!first || reviewPolicyHash(settings) !== manifest.inputPolicyHash
    || fullReviewPolicyHash(settings) !== manifest.fullReviewPolicyHash
    || comparisonReviewPolicyHash(settings) !== manifest.comparisonPolicyHash
    || reviewHash({ first: identity(first), second: settings.secondReview.voters.map(identity),
      fallbacks: (settings.secondReview.fallbacks ?? []).map(identity) }) !== reviewHash(manifest.models)) {
    throw new Error("replay_settings_mismatch");
  }
}

/** Fixture-only bounded review ticks. No worker loop, scheduler, publisher or caller handler. */
export async function runFixtureReviewReplay(options: FixtureReviewReplayOptions) {
  if (currentReplayDb()) throw new Error("replay_runner_scope_conflict");
  const manifest = parseCapacityManifest(options.manifest);
  if (manifest.mode !== "fixtures") throw new Error("unsupported_provider_budget");
  const names = [...(options.jobs ?? ["crawl-agent-review", "second-review"])];
  if (names.some(name => name !== "crawl-agent-review" && name !== "second-review")) throw new Error("replay_job_not_allowed");
  const budgetMs = options.budgetMs ?? 110_000;
  if (!names.length || names.length > 100 || !Number.isSafeInteger(budgetMs) || budgetMs <= 0
    || budgetMs > 110_000 || typeof options.fixture !== "function") throw new Error("invalid_replay_runner_options");
  const { identityPath, fixture, signal: callerSignal } = options;
  // Freeze caller-owned values before either connection or ledger admission can yield.
  const inputs = structuredClone(options.inputs);
  // Drizzle mutates parser options; this raw ledger connection is a distinct owned handle.
  const database = await openVerifiedReplayHandlerDatabase(identityPath, {});
  let wallDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await assertLegacyReplayStages(database);
    const ledger = new ReplayLedger(database);
    const run = await ledger.prepare(manifest, inputs);
    const deadline = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    // Begin conservatively before durable start can wait for a connection or lock.
    wallDeadline = setTimeout(() => deadline.abort(), manifest.limits.maxDurationMs);
    wallDeadline.unref();
    await ledger.start(run);
    const jobs: Array<{ name: ReplayReviewJobName; result: RunResult }> = [];
    try {
      await withReplayDatabaseScope(identityPath, async () => {
        assertReplayDatabaseScopeIdentity(database);
        await withReplayFinalScope(run, () => withReviewReplayContext({ referenceTime: new Date(manifest.referenceTime) }, () =>
          withReviewFixtureTransport({ ledger, run, fixture, inputs, fullReviewPolicyHash: manifest.fullReviewPolicyHash,
            tokenUpperBound: manifest.limits.perCallTokenUpperBound }, async () => {
            for (const name of names) {
              // Read through the verified scope before every claim; no transaction spans inference.
              await assertLegacyReplayStages(database);
              await assertReplaySettings(manifest);
              const result = await runJob(name, name === "crawl-agent-review" ? reviewCrawlCandidates : secondReviewCandidates,
                { requestedOnly: true, budgetMs, signal });
              jobs.push({ name, result });
              if (signal.aborted || result.status === "failed" || result.status === "deferred"
                || result.status === "skipped" && result.reason === "stopping") break;
            }
          })));
      });
    } finally {
      // runJob has stopped and awaited its heartbeat before its promise settles.
      // Fixture teardown likewise completes before the handler DB scope closes.
      await ledger.drain(run);
    }
    return { runId: run.runId, jobs, diagnostics: await ledger.inspect(run) };
  } finally {
    try { await database.close(); }
    finally { clearTimeout(wallDeadline); }
  }
}

export type CertifiedFixtureReviewReplayOptions = FixtureReviewReplayOptions & {
  /** Fixed before execution; omission preserves an explicit incomplete quality result. */
  quality?: ReplayArtifact["initial"]["quality"];
};

/** Certified fixture evidence only. Provider admission remains closed. */
export async function runCertifiedFixtureReviewReplay(options: CertifiedFixtureReviewReplayOptions) {
  return runCertifiedReviewReplay(options, false);
}
async function runCertifiedReviewReplay(options: CertifiedFixtureReviewReplayOptions, items: boolean) {
  if (currentReplayDb()) throw new Error("replay_runner_scope_conflict");
  const manifest = parseCapacityManifest(options.manifest);
  if (manifest.mode !== "fixtures") throw new Error("unsupported_provider_budget");
  const names = [...(options.jobs ?? ["crawl-agent-review", "second-review"])];
  if (names.some(name => name !== "crawl-agent-review" && name !== "second-review")) throw new Error("replay_job_not_allowed");
  const budgetMs = options.budgetMs ?? 110_000;
  if (!names.length || names.length > 100 || !Number.isSafeInteger(budgetMs) || budgetMs <= 0
    || budgetMs > 110_000 || typeof options.fixture !== "function") throw new Error("invalid_replay_runner_options");
  const { identityPath, fixture, signal: callerSignal } = options;
  const inputs = structuredClone(options.inputs), quality = structuredClone(options.quality ?? null);
  const database = await openVerifiedReplayHandlerDatabase(identityPath, {});
  let wallDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!items) await assertLegacyReplayStages(database);
    const ledger = new ReplayLedger(database);
    const run = await (items ? ledger.prepareCertifiedItems(manifest, inputs, { runner: { jobs: names, budgetMs }, quality })
      : ledger.prepareCertified(manifest, inputs, { runner: { jobs: names, budgetMs }, quality }));
    const deadline = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal;
    wallDeadline = setTimeout(() => deadline.abort(), manifest.limits.maxDurationMs);
    wallDeadline.unref();
    await ledger.start(run);
    const jobs: Array<{ name: ReplayReviewJobName; result: RunResult }> = [];
    try {
      // Execution outlives the owned DB scope: quiescence cannot be issued before
      // runJob heartbeat, fixture callbacks and every guarded commit have settled.
      await withReplayExecutionScope(run, () => withReplayDatabaseScope(identityPath, async () => {
        assertReplayDatabaseScopeIdentity(database);
        try {
          await withReplayFinalScope(run, () => withReviewReplayContext({ referenceTime: new Date(manifest.referenceTime) }, () =>
            withReviewFixtureTransport({ ledger, run, fixture, inputs, fullReviewPolicyHash: manifest.fullReviewPolicyHash,
              tokenUpperBound: manifest.limits.perCallTokenUpperBound }, async () => {
              for (const name of names) {
                if (signal.aborted) break;
                if (!items) await assertLegacyReplayStages(database);
                await assertReplaySettings(manifest);
                const result = await runJob<null>(name, name === "crawl-agent-review" ? reviewCrawlCandidates
                  : items ? secondReviewItemControllers : secondReviewCandidates,
                  { requestedOnly: true, budgetMs, signal });
                jobs.push({ name, result });
                if (items && name === "second-review" && result.status === "completed" && !signal.aborted) {
                  const owner = { instanceId: `replay:${run.runId}`, bootId: randomUUID() }, visited = new Set<number>();
                  for (;;) {
                    const queue = (await pendingSecondReviews(24)).filter(row => !visited.has(row.id));
                    if (!queue.length || signal.aborted) break;
                    for (const row of queue) {
                      visited.add(row.id);
                      if (signal.aborted) break;
                      await executeSecondReviewItem({ secondReviewId: row.id, owner, signal });
                    }
                  }
                }
                if (signal.aborted || result.status === "failed" || result.status === "deferred"
                  || result.status === "skipped" && result.reason === "stopping") break;
              }
            })));
        } finally { await ledger.drain(run); }
      }));
    } finally {
      // Failure also closes admission and durably fences writers, but cannot
      // manufacture the private quiescence proof needed to seal evidence.
      await ledger.drain(run);
      await ledger.fenceWriters(run);
    }
    if (!items) await assertLegacyReplayStages(database);
    await ledger.seal(run, replayQuiescenceProof(run));
    const artifact = await loadVerifiedReplayArtifact(database, run.runId);
    return { runId: run.runId, jobs, artifact, diagnostics: reportVerifiedReplayArtifact(artifact) };
  } finally {
    try { await database.close(); }
    finally { clearTimeout(wallDeadline); }
  }
}

/** Fixed mixed fixture entry. No scheduler or ordinary item consumer is installed. */
export async function runCertifiedItemFixtureReviewReplay(options: CertifiedFixtureReviewReplayOptions) {
  return runCertifiedReviewReplay(options, true);
}

async function secondReviewItemControllers(ctx: Parameters<typeof secondReviewCandidates>[0]) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.secondReview.enabled) return { done: true };
  if (!ctx.lease) throw new Error("second_review_job_required");
  await enqueueSecondReviews(settings, undefined, ctx.lease);
  await closeSettledSecondReviews(undefined, ctx.lease);
  await reopenOrphanedGateHolds(settings, undefined, ctx.lease);
  await retryFailedSecondReviews(undefined, ctx.lease);
  return { done: true };
}
