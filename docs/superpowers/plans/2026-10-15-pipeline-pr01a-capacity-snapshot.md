# PR01a Durable Review Snapshot Implementation Plan

> **For agentic workers:** Use the available `execute-plan` skill task by task. All delegated agents and Codex CLI use `gpt-6.1-sol` / `xhigh`.

**Goal:** Export the current persisted automatic review generations from an explicitly isolated local test DB, using the existing final approval gate.

**Architecture:** Add a read-only repeatable-read repository snapshot. Reuse the publication gate, recompute current input, and retain the candidate's applied attempt binding. Exported snapshots describe current state only; PR01b must add real replay and a durable transition/call ledger before historical capacity can be certified.

**Tech Stack:** Node24, TypeScript, Drizzle/PostgreSQL17, Vitest; no migration or runtime consumer changes.

---

Companion contract: [PR01a contract](2026-10-15-pipeline-pr01a-capacity-contract.md). Root owns the files below. The parallel worker owns the pure contract/report and CLI. Existing production pauses and recovery helpers stay unchanged.

## Task 1: Approval gate projection and snapshot

Files: modify `lib/crawl/agent-review-repository.ts`; create `lib/operations/pipeline-capacity-repository.ts`; test `tests/integration/pipeline-capacity.test.ts`.

- [x] Write a DB regression using actual `claimAgentReview` / `recordAgentReview` / `enqueueSecondReviews` / `recordSecondReview`: configure two independent second voters, save AI1 approval, assert gate false before votes and after first vote, true after second. Assert completion time is the last required slot. Add a fallback flow and wrong current input/settings/admin/reuse regressions.
- [x] Run RED in the dedicated loopback55452 DB only; missing snapshot implementation must fail. Add assertion RED for any later tightening. Never truncate a service/development DB.
- [x] Expose only this wrapper immediately after the existing private `secondApproved`, leaving its SQL unchanged:

```ts
/** Read-only measurement projection of the exact publication approval gate. */
export function secondReviewApprovalPredicate(settings: CrawlSettings): SQL {
  return secondApproved({ id: sql`${crawlReviewAttempts.id}`, model: sql`${crawlReviewAttempts.model}` },
    settings.secondReview.voters, settings.secondReview.fallbacks ?? []);
}
```

- [x] Create this repository implementation. Its hard limits fail rather than silently dropping rows. The max per-slot approving time is computed only after the exact gate passes and each counted vote matches the current input.

```ts
import { asc, eq, inArray } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews,
  type CrawlReviewAttempt, type SecondReview } from "@/lib/db/schema";
import { loadReviewInput, secondGateRequired, secondReviewApprovalPredicate } from "@/lib/crawl/agent-review-repository";
import { firstReviewer } from "@/lib/crawl/agent-review";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewPolicyHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { secondReviewInputMatches } from "@/lib/crawl/second-review-input";
import { canonicalReviewModel, sameReviewModel } from "@/lib/crawl/review-model-identity";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { fullReviewPolicyHash, comparisonReviewPolicyHash, type CapacityManifest, type GenerationRecord } from "./pipeline-capacity";

function gateTime(attempt: CrawlReviewAttempt, votes: SecondReview[], current: {
  candidate: typeof crawlCandidates.$inferSelect; document: typeof crawlDocuments.$inferSelect;
  settings: CrawlSettings; input: ReviewInput;
}, now: Date): string | null {
  const slots = current.settings.secondReview.voters.filter(v => !sameReviewModel(v.model, attempt.model));
  if (!slots.length) return null;
  // Original approval-slot validation precedes publication. Publication alone must
  // not erase that completed gate; published audit rows are still excluded below.
  const candidate = current.candidate.state === "published" && current.candidate.decidedBy === "auto"
    ? { ...current.candidate, state: "approved" as const } : current.candidate;
  const times: number[] = [];
  for (const slot of slots) {
    const matching = votes.filter(vote => {
      const root = vote.fallbackForId ? votes.find(row => row.id === vote.fallbackForId) : undefined;
      return vote.firstAttemptId === attempt.id && vote.trigger === "ai_approved" && !vote.publishedSlug
        && vote.status === "agreed" && vote.secondDecision === "approve" && vote.reviewedAt
        && (root?.provider ?? vote.provider) === slot.provider
        && sameReviewModel(root?.model ?? vote.model, slot.model)
        && secondReviewInputMatches(vote, { ...current, candidate, first: attempt, root }, now);
    }).map(row => row.reviewedAt!.getTime());
    if (!matching.length) return null;
    times.push(Math.min(...matching));
  }
  return new Date(Math.max(...times)).toISOString();
}

export async function snapshotPipelineGenerations(candidateIds: number[], expectedPolicyHash: string,
  expected?: Pick<CapacityManifest, "models" | "inputPolicyHash" | "comparisonPolicyHash">) {
  if (!candidateIds.length || candidateIds.length > 1000 || new Set(candidateIds).size !== candidateIds.length
    || candidateIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error("invalid_snapshot_candidates");
  return onPrimary(() => db.transaction(async tx => {
    const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
    const settings = mergeWithDefaults(saved?.values);
    const policyHash = fullReviewPolicyHash(settings);
    if (policyHash !== expectedPolicyHash) throw new Error("snapshot_policy_mismatch");
    const reviewer = firstReviewer(settings);
    if (expected) {
      if (expected.inputPolicyHash !== reviewPolicyHash(settings)
        || expected.comparisonPolicyHash !== comparisonReviewPolicyHash(settings)) throw new Error("snapshot_policy_mismatch");
      const identity = (row: { provider: string; model: string }) => ({ provider: row.provider, model: row.model,
        canonicalModel: canonicalReviewModel(row.model) });
      const pool = (rows: { provider: string; model: string }[]) => rows.map(identity)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const models = { first: reviewer ? identity(reviewer) : null, second: pool(settings.secondReview.voters),
        fallbacks: pool(settings.secondReview.fallbacks ?? []) };
      const declared = { first: identity(expected.models.first), second: pool(expected.models.second),
        fallbacks: pool(expected.models.fallbacks) };
      if (JSON.stringify(models) !== JSON.stringify(declared)) throw new Error("snapshot_model_mismatch");
    }
    const capturedAt = new Date();
    const candidates = await tx.select().from(crawlCandidates).where(inArray(crawlCandidates.id, candidateIds));
    if (candidates.length !== candidateIds.length) throw new Error("snapshot_candidate_missing");
    const attempts = await tx.select({ attempt: crawlReviewAttempts, gate: secondReviewApprovalPredicate(settings) })
      .from(crawlReviewAttempts).where(inArray(crawlReviewAttempts.candidateId, candidateIds))
      .orderBy(asc(crawlReviewAttempts.id)).limit(10001);
    const votes = await tx.select().from(secondReviews).where(inArray(secondReviews.candidateId, candidateIds)).limit(10001);
    if (attempts.length > 10000 || votes.length > 10000) throw new Error("snapshot_row_limit");
    const documents = await tx.select().from(crawlDocuments).where(inArray(crawlDocuments.repo, candidates.map(c => c.repo)));
    const records: GenerationRecord[] = [];
    for (const candidate of candidates) {
      const document = documents.find(row => row.repo === candidate.repo);
      const input = document ? await loadReviewInput(candidate, document, settings, tx) : null;
      for (const { attempt, gate } of attempts.filter(row => row.attempt.candidateId === candidate.id)) {
        const currentInputMatched = Boolean(input && document && settings.enabled && settings.reviewMode === "enforce"
          && candidate.productUrl === document.productUrl && document.fetchedAt <= capturedAt
          && (!input.source.scanCompletedAt || new Date(input.source.scanCompletedAt) <= capturedAt)
          && input.validUntil > capturedAt && attempt.inputHash === input.inputHash
          && attempt.sourceRevisionHash === input.sourceRevisionHash && attempt.policyHash === input.policyHash
          && attempt.promptVersion === REVIEW_PROMPT_VERSION && attempt.rulesVersion === REVIEW_RULES_VERSION
          && attempt.provider === reviewer?.provider && attempt.model === reviewer?.model);
        const required = attempt.outcome?.decision === "approve" && secondGateRequired(settings);
        const completed = required && gate && input && document && currentInputMatched
          ? gateTime(attempt, votes, { candidate, document, settings, input }, capturedAt) : null;
        const appliedId = candidate.signals?.agentReviewAttemptId;
        records.push({ candidateId: candidate.id, firstAttemptId: attempt.id,
          inputHash: attempt.inputHash, sourceRevisionHash: attempt.sourceRevisionHash, policyHash: attempt.policyHash,
          provider: attempt.provider, model: attempt.model, kind: attempt.kind, state: attempt.state,
          reusedFromAttemptId: attempt.reusedFromAttemptId, decision: attempt.outcome?.decision ?? null,
          startedAt: attempt.startedAt.toISOString(), completedAt: attempt.completedAt?.toISOString() ?? null,
          validUntil: attempt.validUntil.toISOString(), candidateState: candidate.state,
          decidedBy: candidate.decidedBy === "auto" || candidate.decidedBy === "admin" ? candidate.decidedBy : null,
          appliedAttemptId: typeof appliedId === "number" && Number.isSafeInteger(appliedId) ? appliedId : null,
          currentInputMatched, secondGateRequired: required,
          secondGateSatisfied: !required || Boolean(gate && completed), secondGateCompletedAt: completed });
      }
    }
    return { capturedAt: capturedAt.toISOString(), fullReviewPolicyHash: policyHash, generations: records };
  }, { isolationLevel: "repeatable read", accessMode: "read only" }));
}
```

- [x] Run GREEN and related publication-gate/writer integration before committing this task.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55452/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-capacity.test.ts tests/integration/review-publication-gate.test.ts tests/integration/review-handoffs.test.ts
```

## Task 2: Guarded local export CLI

File: create `scripts/export-pipeline-capacity.ts`.

- [x] Add CLI regression: remote DB/mismatched DATABASE_URL/libpq override/invalid manifest must refuse before dynamic DB import; export never calls a model, publisher or discovers inputs.
- [x] Observe RED, then create this CLI. It reads a strict artifact template to retain manifest, readiness/call/quality evidence; replaces generation/source fields with the actual local read-only snapshot. Input artifacts and output exports remain unverified evidence. Exclusive mode0600 output avoids clobbering prior evidence.

```ts
import { open, writeFile } from "node:fs/promises";
import { parseCapacityArtifact, validateReplayPlan } from "../lib/operations/pipeline-capacity";
import { formatCapacityCliError } from "../lib/operations/pipeline-capacity-cli";
async function main() {
  const [templatePath, outputPath, ...extra] = process.argv.slice(2);
  if (!templatePath || !outputPath || extra.length) throw new Error("usage: export-pipeline-capacity TEMPLATE OUTPUT");
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("explicit_TEST_DATABASE_URL_required");
  const file = await open(templatePath, "r");
  let raw: unknown;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    const bytes = await file.readFile();
    if (bytes.length > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
    try { raw = JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error("invalid_artifact_json"); }
  } finally { await file.close(); }
  const template = parseCapacityArtifact(raw);
  validateReplayPlan(template.manifest, url);
  if (process.env.READ_DATABASE_URL) throw new Error("replica_database_rejected");
  process.env.DATABASE_URL = url;
  const { snapshotPipelineGenerations } = await import("../lib/operations/pipeline-capacity-repository");
  try {
    const snapshot = await snapshotPipelineGenerations([...new Set(template.manifest.inputs.map(row => row.candidateId))],
      template.manifest.fullReviewPolicyHash, template.manifest);
    const key = (row: { candidateId: number; inputHash: string; sourceRevisionHash: string }) =>
      JSON.stringify([row.candidateId, row.inputHash, row.sourceRevisionHash]);
    const frozenInputs = new Set(template.manifest.inputs.map(key));
    const generations = snapshot.generations.filter(row => frozenInputs.has(key(row)));
    const artifact = parseCapacityArtifact({ ...template, generations,
      source: { kind: "local-postgres", scope: "as_of_snapshot_only", runId: template.manifest.runId, exportedAt: snapshot.capturedAt,
        fullReviewPolicyHash: snapshot.fullReviewPolicyHash } });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ exported: true, generations: artifact.generations.length, excludedHistoricalGenerations: snapshot.generations.length - generations.length, evidence: "as_of_snapshot_only" }));
  } finally {
    const client = (globalThis as typeof globalThis & { pgClient?: { end(options: { timeout: number }): Promise<void> } }).pgClient;
    await client?.end({ timeout: 5 });
  }
}
void main().catch(error => { console.error(formatCapacityCliError(error)); process.exitCode = 1; });
```

- [x] Run CLI guard tests and actual local export/report smoke with a fixture manifest; no production DB or real model calls.

## Task 3: Review, validation and submission

- [x] Parent self-review against accepted spec: exact AI2 gate, current hash/actor/attempt binding, final required slot time, full settings identity, candidate/window dedup, no production writes, no replay-success claim. No deferred PR01b requirement is marked complete.
- [x] Execute focused tests, typegen/tsc, lint/i18n, full unit, related isolated integration, build/bundle and diff checks. Record only actual results in `docs/operations/2026-10-15-pipeline-pr01a-validation.md` and handoff.
- [ ] Commit explicit paths on isolated branch, push and create PR; latest-base required check gates merge. Root X branch/user untracked remain untouched.

The complete PR01 remains pending until a bounded real-model runner, provider-enforced caps, pre-call reservation ledger, readiness ledger and authoritative final-transition history pass PR01b. No2x claim is possible from PR01a.

## Snapshot limitations confirmed by review

The actual publication cleanup resolves original AI2 rows as `decided_elsewhere`; after that, the current snapshot reports the gate as unavailable/partial rather than inventing its earlier state. The integration test covers approval, publication projection and real cleanup. PR01b needs an immutable transition ledger. `loadReviewInput` uses its normal current clock per candidate; the snapshot is conservative near freshness boundaries and is not a frozen-reference replay. Its exported timestamp is a capture clock, not proof of an instantaneous historical end-state. PR01b must thread the fixed reference clock.

Exact full settings hash binds export. The separate comparison policy hash excludes only `reviewConcurrency`, while explicit manifest concurrency remains bounded and reported. The export checks exact first/second/fallback reviewer pools and both policy fingerprints inside the same read-only transaction. It filters old input/source generations outside the frozen manifest cohort and reports their count separately.

## Final safety review additions

An offline audit reproduced WHATWG URL versus installed postgres.js3.4.9 first-@/multihost parsing disagreement without constructing a DB client. Three malicious URL regressions failed before the fix. Both replay admission and the existing shared test-DB guard now require the raw driver host segment to equal the single validated loopback host, rejecting multiple-@/encoded-comma escapes. The CLI error plan separately covers arbitrary schema/database/filesystem diagnostics. No remote DB was contacted to prove the bug.
