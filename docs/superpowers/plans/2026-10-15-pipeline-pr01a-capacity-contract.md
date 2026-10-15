# PR01a Capacity Artifact Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The available repository `execute-plan` skill supplies the execution procedure. JR requires `gpt-6.1-sol` with `xhigh` for every delegated agent or Codex CLI. The parent requested this written plan and review before implementation; no commits or live calls are authorized in this subtask.

**Goal:** Ship a runnable offline final-generation report and comparison with strict artifact validation and a fail-closed isolated replay admission check.

**Architecture:** The parent-owned exporter reads the existing local PostgreSQL review writers and exact SQL AI2 gate into an immutable artifact. This pure module validates that artifact, counts unique persisted final decisions, derives latency and quality, and compares fixed conditions. Offline data never authenticates its own provenance; model replay and verified model-budget execution remain explicitly incomplete in PR01a.

**Tech Stack:** TypeScript, Zod 4, Node crypto/fs, Vitest; no new dependency, database schema, transport, production access, or scheduler.

---

## Scope and ownership

Owned files:

- Create `lib/operations/pipeline-capacity.ts`: schemas, stable settings hash, pure report/comparison, local replay-plan admission validation.
- Create `scripts/measure-pipeline-capacity.ts`: offline `report`, `compare`, and `replay-plan` commands; reject `replay` without touching providers.
- Create `tests/pipeline-capacity.test.ts`: generation, consistency, comparison, quality, readiness and admission regressions.
- Modify `scripts/report-review-latency.ts`: add explicit best-effort telemetry/final-throughput-unavailable labels to its existing output.

The parent owns `lib/operations/pipeline-capacity-repository.ts`, `scripts/export-pipeline-capacity.ts`, `tests/integration/pipeline-capacity.test.ts`, the combined execution plan and `docs/CODEX_HANDOFF.md`. The exporter uses a read-only repeatable-read snapshot and its CLI accepts only an explicit guarded local test database. This subtask does not modify those files.

The pure core should stay at or below 400 lines. Use strict Zod objects and small functions; no generic event bus, provider registry, pluggable execution framework or new transport. Plan code below is the intended initial implementation. Parent review can tighten field names before RED/GREEN execution.

## Shared contract with the parent exporter

All dates use canonical UTC ISO strings. All fingerprints are SHA-256 hex. Exported rows can include rules, human work, failed attempts and stale generations so exclusions remain visible. The exporter must derive `currentInputMatched`, candidate binding and AI2 gate fields from locked/consistent DB reads, never request JSON. `secondGateCompletedAt` is the last timestamp of the required successful AI2 slots, including the valid final fallback, rather than an arbitrary second-review event. `appliedAttemptId` comes from candidate signals. `decidedBy` permits null. The source and report explicitly say `as_of_snapshot_only`: later admin/re-review changes prevent snapshots from reconstructing historical transition throughput.

`fullReviewPolicyHash(settings)` hashes the complete normalized `CrawlSettings` object for exact exporter binding. `comparisonReviewPolicyHash(settings)` omits only `reviewConcurrency`; the manifest's separate `comparisonPolicyHash` permits the approved concurrency experiment while all decision settings remain fixed. The existing `reviewPolicyHash` omits reviewer/AI2 configuration and cannot establish complete comparison equality. Parent review approved this exact/comparison split after identifying that a full-settings comparison would reject the intended2→4 experiment.

The manifest pins the offered input distribution, initial DB/cache state, reference clock, models, policy and budgets. It does not contain credentials. An export has a provenance label, not authenticated proof. PR01a can report observed numbers and quality from supplied pinned labels; it cannot certify a real-model throughput improvement or enforced token budget.

### Task 1: Write the failing contract tests

**Files:** Create `tests/pipeline-capacity.test.ts`.

- [x] Add the following focused baseline tests before the module exists; complete additional cases listed in Task 5 before broad checks.

```ts
import { expect, it } from "vitest";
import { compareCapacityRuns, parseCapacityArtifact, reportCapacityRun,
  validateReplayPlan, type CapacityArtifact } from "@/lib/operations/pipeline-capacity";

const hash = "a".repeat(64);
const at = (ms: number) => new Date(Date.UTC(2026, 9, 15) + ms).toISOString();
function artifact(): CapacityArtifact {
  return {
    manifest: { version: 1, runId: "run-a", revision: "8020dca", mode: "fixtures", cacheMode: "cold",
      referenceTime: at(0), startedAt: at(0), endedAt: at(1_800_000), inputPolicyHash: hash,
      fullReviewPolicyHash: hash, comparisonPolicyHash: hash, initialStateHash: hash,
      models: { first: { provider: "abcllm", model: "first", canonicalModel: "first" }, second: [{ provider: "abcllm", model: "second", canonicalModel: "second" }], fallbacks: [] },
      inputs: [{ candidateId: 1, inputHash: hash, sourceRevisionHash: hash, readyAt: at(0), stratum: "new", reReview: false }],
      limits: { maxCalls: 100, maxTokens: 1_000_000, maxDurationMs: 1_800_000, concurrency: 4, perCallTokenUpperBound: 10_000 } },
    source: { kind: "fixture", scope: "as_of_snapshot_only", runId: "run-a", exportedAt: at(1_800_000), fullReviewPolicyHash: hash },
    generations: [{ candidateId: 1, firstAttemptId: 10, inputHash: hash, sourceRevisionHash: hash,
      policyHash: hash, provider: "abcllm", model: "first", kind: "automatic", state: "succeeded",
      reusedFromAttemptId: null, decision: "approve", startedAt: at(0), completedAt: at(1_000), validUntil: at(86_400_000),
      candidateState: "approved", decidedBy: "auto", appliedAttemptId: 10, currentInputMatched: true,
      secondGateRequired: true, secondGateSatisfied: false, secondGateCompletedAt: null }],
    readiness: [{ from: at(0), until: at(1_800_000), ready: 5 }], calls: [], quality: null,
  };
}
it("counts an approval only after its required AI2 gate and uses the final durable time", () => {
  const value = artifact();
  expect(reportCapacityRun(value).finalCandidates).toBe(0);
  Object.assign(value.generations[0], { secondGateSatisfied: true, secondGateCompletedAt: at(5_000) });
  const report = reportCapacityRun(value);
  expect(report.finalCandidates).toBe(1);
  expect(report.endToEndMs.p95).toBe(5_000);
});
it("deduplicates identical rows and counts each candidate once", () => {
  const value = artifact();
  Object.assign(value.generations[0], { secondGateSatisfied: true, secondGateCompletedAt: at(5_000) });
  value.generations.push({ ...value.generations[0] });
  expect(reportCapacityRun(value).finalCandidates).toBe(1);
});
it("never authenticates offline rows or declares fixture speed a verified model result", () => {
  const value = artifact();
  expect(compareCapacityRuns(value, value)).toMatchObject({ performance: "incomplete", overall: "incomplete", budgetEvidence: "unverified" });
});
it("rejects malformed artifacts rather than dropping malformed records", () => {
  expect(() => parseCapacityArtifact({ ...artifact(), calls: [{ callId: "broken" }] })).toThrow();
});
it("validates only a local replay configuration and cannot enable execution", () => {
  expect(validateReplayPlan(artifact().manifest, "postgres://test:test@127.0.0.1:55435/nomorevibe_test", {}))
    .toMatchObject({ configurationValid: true, executionSupported: false, budgetEvidence: "unverified" });
  expect(() => validateReplayPlan(artifact().manifest, "postgres://test:test@service/nomorevibe_test", {})).toThrow("local_test_database_required");
});
```

- [x] Execute RED: `npx vitest run tests/pipeline-capacity.test.ts`. Expected: missing module/import failure because the feature is absent. After the initial interface exists, add each behavior group and verify assertion failures before implementing it. Record actual RED commands and diagnostics, including whether the initial failure was module resolution or assertion failure.

### Task 2: Implement the strict schemas and stable fingerprint

**Files:** Create `lib/operations/pipeline-capacity.ts`.

- [x] Define these schemas and types; keep the public field names stable for the parent exporter.

```ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
const text = z.string().trim().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime().refine(value => new Date(value).toISOString() === value, "canonical_utc_required");
const integer = z.number().int().nonnegative().safe();
const positive = integer.positive();
const identity = z.object({ provider: z.enum(["abcllm", "claude-cli", "grok-cli"]), model: text, canonicalModel: text }).strict();
const input = z.object({ candidateId: positive, inputHash: hash, sourceRevisionHash: hash,
  readyAt: date, stratum: text, reReview: z.boolean() }).strict();
export const capacityManifestSchema = z.object({
  version: z.literal(1), runId: text, revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  mode: z.enum(["fixtures", "model-replay"]), cacheMode: z.enum(["cold", "warm"]),
  referenceTime: date, startedAt: date, endedAt: date,
  inputPolicyHash: hash, fullReviewPolicyHash: hash, comparisonPolicyHash: hash, initialStateHash: hash,
  models: z.object({ first: identity, second: z.array(identity).max(3), fallbacks: z.array(identity).max(2) }).strict(),
  inputs: z.array(input).min(1).max(100_000),
  limits: z.object({ maxCalls: positive.max(1_000_000), maxTokens: positive,
    maxDurationMs: positive.max(86_400_000), concurrency: positive.max(4), perCallTokenUpperBound: positive }).strict(),
}).strict();
export const generationRecordSchema = z.object({
  candidateId: positive, firstAttemptId: positive, inputHash: hash, sourceRevisionHash: hash, policyHash: hash,
  provider: text.nullable(), model: text.nullable(), kind: z.enum(["automatic", "admin_override", "evidence_refresh"]),
  state: z.enum(["running", "succeeded", "failed", "superseded"]), reusedFromAttemptId: positive.nullable(),
  decision: z.enum(["approve", "reject", "needs_review"]).nullable(), startedAt: date,
  completedAt: date.nullable(), validUntil: date, candidateState: z.enum(["new", "approved", "rejected", "needs_review", "published"]),
  decidedBy: z.enum(["auto", "admin"]).nullable(), appliedAttemptId: positive.nullable(), currentInputMatched: z.boolean(),
  secondGateRequired: z.boolean(), secondGateSatisfied: z.boolean(), secondGateCompletedAt: date.nullable(),
}).strict();
const call = z.object({ callId: text, stage: z.enum(["first", "second"]), candidateId: positive,
  firstAttemptId: positive, inputHash: hash, sourceRevisionHash: hash,
  provider: text, model: text, startedAt: date, endedAt: date.nullable(), ok: z.boolean().nullable(),
  error: text.nullable(), inputTokens: integer.nullable(), outputTokens: integer.nullable() }).strict();
const label = z.object({ candidateId: positive, inputHash: hash, expected: z.enum(["approve", "reject"]) }).strict();
export const capacityArtifactSchema = z.object({
  manifest: capacityManifestSchema,
  source: z.object({ kind: z.enum(["fixture", "local-postgres"]), scope: z.literal("as_of_snapshot_only"), runId: text, exportedAt: date, fullReviewPolicyHash: hash }).strict(),
  generations: z.array(generationRecordSchema).max(1_000_000),
  readiness: z.array(z.object({ from: date, until: date, ready: integer }).strict()).max(100_000),
  calls: z.array(call).max(1_000_000),
  quality: z.object({ datasetHash: hash, labels: z.array(label).min(1).max(100_000) }).strict().nullable(),
}).strict();
export type CapacityManifest = z.infer<typeof capacityManifestSchema>;
export type GenerationRecord = z.infer<typeof generationRecordSchema>;
export type CapacityArtifact = z.infer<typeof capacityArtifactSchema>;
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("invalid_hash_input");
}
export function fullReviewPolicyHash(settings: CrawlSettings): string {
  return createHash("sha256").update(canonical(settings)).digest("hex");
}
export function comparisonReviewPolicyHash(settings: CrawlSettings): string {
  const { reviewConcurrency, ...policy } = settings; void reviewConcurrency;
  return createHash("sha256").update(canonical(policy)).digest("hex");
}
```

This schema deliberately has no `verified`, `passed`, `actualCalls` or supplied quality-error totals. Those keys are rejected by strict parsing. Provider and model may be null on historical attempts and then cannot count as model finals.

### Task 3: Implement consistency checks and final counting

**Files:** Append to `lib/operations/pipeline-capacity.ts`.

- [x] Add the following precise consistency rules inside `parseCapacityArtifact(value: unknown): CapacityArtifact`; reject violations with fixed error codes. Parsing precedes every report/compare. Use a local `ensure(condition,code)` throwing `Error(code)`.

```ts
// Implement each invariant as a direct loop/condition, with no lossy filtering:
// 1. start < end, end-start <= maxDurationMs, source runId and full policy hash equal manifest.
// 2. source.exportedAt >= endedAt; unique manifest (candidateId,inputHash,sourceRevisionHash);
//    readyAt <= endedAt; one consistent reReview flag for all inputs of one candidate.
// 3. every generation belongs to a manifest input; a repeated firstAttemptId must be byte-identical;
//    completedAt >= startedAt; validUntil > startedAt; AI2 completion cannot precede first completion;
//    gateSatisfied && gateRequired requires AI2 completion; gateSatisfied is a derived projection,
//    not permission to skip currentInputMatched, candidate binding or any other eligibility check.
// 4. every call belongs to an exact manifest input/source and first-attempt generation, matches the frozen stage provider/model identities,
//    lies within the measurement interval, ends after it starts, and has consistent end/ok/error:
//    endedAt null <=> ok null; successful call has no error; failed call has nonempty error.
//    Duplicate callId must be byte-identical; conflicting duplicates fail the artifact.
// 5. quality label keys (candidateId,inputHash) are unique and belong to manifest inputs.
//    Hash canonical sorted labels with SHA-256 and require exact datasetHash equality.
// Use error codes invalid_window, source_mismatch, duplicate_input, generation_mismatch,
// conflicting_attempt, invalid_generation_time, call_mismatch, conflicting_call, quality_mismatch.
```

The implementation must turn these listed invariants into executable conditions. They are acceptance rules for parent review, not instructions to infer undocumented trust from JSON. Add an actual failing test for each rejection before adding its condition.

- [x] Implement `reportCapacityRun(value: unknown)` with the following exact result contract and selection procedure.

```ts
type Distribution = { samples: number; p50: number | null; p95: number | null };
type CapacityReport = {
  runId: string; evidence: "as_of_snapshot_only"; authenticity: "unverified"; budgetEvidence: "unverified";
  durationMs: number; finalCandidates: number; finalGenerations: number; repeatGenerations: number; reReviewGenerations: number;
  finalPerHour: number; endToEndMs: Distribution;
  exclusions: Record<"rules" | "reuse" | "human" | "partial" | "stale" | "reReview" | "outsideWindow", number>;
  calls: { completed: number; failed: number; unmatched: number; inputTokens: number | null; outputTokens: number | null };
  readiness: "covered" | "missing" | "starved";
  quality: { status: "passed" | "failed" | "incomplete"; wrongApprovals: number; wrongRejections: number; datasetHash: string | null };
};
```

Deduplicate identical `firstAttemptId` rows first. Match manifest input exactly. Exclude in this precedence: rules; reuse; nonautomatic/admin/unbound decision/human hold; failed/running/no final decision or required gate unsatisfied; stale input/policy/model/validity; final outside `(startedAt,endedAt]`; manifest reReview. For approved candidates, allow `approved` or `published` state but never substitute publication time/count. For rejected candidates require `rejected`. Require `decidedBy === "auto"`, `appliedAttemptId === firstAttemptId`, `currentInputMatched`, succeeded, null reusedFromAttemptId, configured first provider/model, and exact manifest policyHash. A row's final time is max(first completedAt, required AI2 completedAt). Require validUntil > final time. Derive logical generation key from candidate/input/source; count each candidate once, selecting earliest qualifying final time, and report additional qualifying generations separately. Identical rows and retries cannot increase either count. ReReview inputs never increase the new-final primary count.

P50/P95 use the existing nearest-rank convention (ceil(p*n)-1) on `finalTime - input.readyAt`, rejecting negative time. Empty distributions remain null. Every distinct completed call counts once; cancelled/deferred calls are separate from technical failure if represented. Any missing token usage makes that aggregate null. Counts from telemetry cannot produce final candidates.

Readiness intervals must start at the exact measurement start, end at its end, and be ordered with no gaps/overlap. A missing/gapped interval gives `missing`; any covered interval with zero ready work gives `starved`. Positive integer queue snapshots alone cannot authenticate real readiness; the report remains offline/unverified.

Quality uses pinned expected labels, not supplied totals: compare each eligible unique candidate final with its matching `(candidateId,inputHash)` label. Empty or incomplete expected-label coverage gives `incomplete`; a disagreement increments wrong approval/rejection and yields `failed`. Quality status never changes performance numbers. Parent-approved implementation can compute comparison quality relative to baseline error counts rather than requiring absolute zero, while never hiding errors.

### Task 4: Comparison, replay admission and runnable CLI

**Files:** Append to core; create CLI; label latency script.

- [x] Implement `compareCapacityRuns(baseline: unknown, candidate: unknown)` returning `{baseline,candidate,ratio,performance,quality,overall,budgetEvidence,reasons}`. Parse and report each first. Compare canonical objects containing all manifest fields except runId/revision/start/end/inputs' actual run-local readyAt, exact fullReviewPolicyHash and limits.concurrency; require same duration, provider+canonical model identities, inputPolicyHash/comparisonPolicyHash, fixed referenceTime/cache/initialState, and exactly equal canonical input identity/source/stratum/reReview sets with their readiness offsets from run start. Each source must still match its own exact fullReviewPolicyHash. Only the existing `[MLX]` alias normalization is recognized, and each configured identity must match its declared canonicalModel. Concurrency is an experimental variable bounded at four and both values are reported; all other limits remain equal. Reject a comparison with fixed `conditions_mismatch` reason if any fixed fields differ. Different revisions are expected.
- [x] Ratios are null for baseline zero. Assess numerical thresholds separately: >=2.0 final/hour; candidate final p95 <= baseline; technical failure rate <= baseline +0.01; null/unknown/unmatched samples are incomplete. Explicitly report `performance: "incomplete"` and reason `model_replay_unverified` in all PR01a results regardless of caller-set manifest mode. Compare quality only when both complete label sets have identical dataset hashes; candidate wrong approval/rejection counts must not exceed baseline. `overall` cannot be passed unless both independently pass, which PR01a cannot establish for real replay.
- [x] Implement local configuration validation with this exact function interface and result; it does not connect to DB or execute providers.

```ts
export function validateReplayPlan(value: unknown, databaseUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env) {
  const manifest = capacityManifestSchema.parse(value);
  let local = false;
  try {
    const url = new URL(databaseUrl);
    local = ["postgres:", "postgresql:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && url.pathname === "/nomorevibe_test" && !url.search && !url.hash;
  } catch { /* Fixed error below; never print credentials. */ }
  if (!local) throw new Error("local_test_database_required");
  if (["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"]
    .some(key => Boolean(env[key]))) throw new Error("database_override_rejected");
  if (env.DATABASE_URL && env.DATABASE_URL !== databaseUrl) throw new Error("database_url_mismatch");
  const bound = manifest.limits.maxCalls * manifest.limits.perCallTokenUpperBound;
  if (!Number.isSafeInteger(bound) || bound > manifest.limits.maxTokens) throw new Error("planned_token_budget_exceeded");
  if (Date.parse(manifest.endedAt) <= Date.parse(manifest.startedAt)
    || Date.parse(manifest.endedAt) - Date.parse(manifest.startedAt) > manifest.limits.maxDurationMs)
    throw new Error("invalid_window");
  return { configurationValid: true, executionSupported: false, budgetEvidence: "unverified",
    reason: "real_model_replay_unimplemented", limits: manifest.limits } as const;
}
```

This verifies arithmetic of the requested reservation contract only. `perCallTokenUpperBound` remains unverified until PR01b checks the actual provider cap/tokenizer/transport and reserves before every call. The output explicitly blocks execution. Unsupported provider budgets cannot become supported through a JSON flag. Negative/NaN/Infinity/zero limits fail strict parsing. All future writes require the parent's stronger DB identity guard as well.

- [x] Create the complete CLI below, adjusting only exported function names if parent review requires it.

```ts
import { readFile } from "node:fs/promises";
import { compareCapacityRuns, reportCapacityRun, validateReplayPlan } from "../lib/operations/pipeline-capacity";
async function read(path: string) {
  const buffer = await readFile(path);
  if (buffer.byteLength > 64 * 1024 * 1024) throw new Error("artifact_size_limit");
  return JSON.parse(buffer.toString("utf8")) as unknown;
}
async function main() {
  const [command, first, second, ...rest] = process.argv.slice(2);
  if (command === "replay") throw new Error("real_model_replay_unimplemented");
  if (rest.length || !first) throw new Error("usage: measure-pipeline-capacity report ARTIFACT | compare BASELINE CANDIDATE | replay-plan MANIFEST");
  let result: unknown;
  if (command === "report" && !second) result = reportCapacityRun(await read(first));
  else if (command === "compare" && second) result = compareCapacityRuns(await read(first), await read(second));
  else if (command === "replay-plan" && !second) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("explicit_TEST_DATABASE_URL_required");
    result = validateReplayPlan(await read(first), url);
  } else throw new Error("invalid_command");
  console.log(JSON.stringify(result, null, 2));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "capacity_report_failed"); process.exitCode = 1; });
```

- [x] Change the latency report's final JSON to include `evidence: "best_effort_model_call_telemetry"`, `authoritativeFinalThroughput: null`, and `productionSpeedup: null`. Retain existing summaries and invalidLines. Logs cannot become final-throughput proof through extra metadata.

### Task 5: Complete focused RED/GREEN regression coverage

**Files:** Extend `tests/pipeline-capacity.test.ts`; parent supplies DB integration separately.

- [x] Add table-driven real-artifact mutations and observe RED before adding each missing behavior: rules, copied cache, running/failed, needs_review, admin/null actor, unbound applied attempt, stale current input, wrong policy/model, expired final, old completion, late AI2 completion, and reReview exclusions.
- [x] Add duplicate attempts with conflicting fields, duplicate call IDs with conflicting results, invalid dates/unknown keys/nonfinite values, unknown manifest input and malformed labels; all must throw without dropping records.
- [x] Add two candidates and two generations of one candidate to prove candidate/window cap, repeat-generation reporting, no inflation from duplicate input retries, and AI2 final-time p95.
- [x] Add equivalent artifact object-key order and changed nested second-review setting tests for `fullReviewPolicyHash`; identical normalized settings hash identically, any settings change invalidates comparison.
- [x] Add fixed-model/policy/input distribution/reference/cache/state mismatches; short window; missing/gapped/overlapped readiness; zero-ready interval; missing/unmatched call; unknown token usage. Every case remains incomplete and exposes the specific reason.
- [x] Add pinned-label agreement, false approval, false rejection, missing label, wrong dataset hash, and candidate-quality regression while numerical ratio >=2. Prove quality does not become passed from throughput.
- [x] Add local URL rejection cases (remote, wrong DB, query host override, fragment, malformed URL), PG* override rejection, conflicting DATABASE_URL, zero/negative/overflow/exceeded token reservation. Valid arithmetic still returns executionSupported false.
- [x] Spawn the offline CLI on temporary synthetic artifacts to check report/compare exit0 and explicit incomplete labels, malformed/oversize/unknown command exit1, and `replay` exit1 with `real_model_replay_unimplemented`. Keep test files private temporary; no credentials or source text in fixtures/output.

Run after GREEN:

```sh
npx vitest run tests/pipeline-capacity.test.ts tests/review-pipeline-observability.test.ts
npx tsc --noEmit
npx eslint lib/operations/pipeline-capacity.ts scripts/measure-pipeline-capacity.ts scripts/report-review-latency.ts tests/pipeline-capacity.test.ts
git diff --check
```

Expected: focused tests/type/lint/diff all exit0; record only executed results. The parent runs relevant DB integration and repository-wide checks after combining changes. No commits, push, production/model call, deployment or environment-file mutation in this subtask.

## Review gates and remaining PR01 work

- [x] Parent confirms the shared fields and counting/exclusion semantics before implementation starts.
- [x] Parent-owned exporter derives AI2 gate and last-required-vote time from the same exact gate used by publication, checks current input/settings and bound candidate attempt, and reads only guarded isolated local DBs.
- [x] PR01a report/CLI implementation and actual RED/GREEN results are reviewable; no real-model speedup or authenticated model-budget success is claimed.
- [ ] PR01b must implement real runner, provider-specific enforced bounds, pre-call reservations, actual ready-queue coverage and isolated durable execution. Until then, original PR01's real-model replay acceptance is incomplete.
- [x] Parent updates the roadmap/handoff with the split, changed files, actual checks and exact next commands. This plan is a design artifact until its boxes are backed by repository state and executed results.

## Owned implementation execution record — 2026-10-15

Parent reviewed the plan and authorized implementation. Implemented the four owned runtime/test files and this plan. The pure core remains below the 400-line boundary. No commits, provider calls, production access, deployment, environment-file change or new transport occurred.

Parent-approved refinements during execution:

- `canonicalModel` is explicit alongside configured `model`; only the existing MLX alias normalization is recognized.
- `source.scope` and report evidence are `as_of_snapshot_only`; authenticity and budget evidence always remain unverified.
- Exact full-settings export binding and comparison policy hashing are separate. Comparison excludes only reviewConcurrency; manifest concurrency is bounded at four and reported for both runs.
- Quality is an explicitly pinned evaluation subset with evaluated/expected sample counts. Unlabeled performance inputs do not change that evaluation set; unfinished labeled inputs make quality incomplete. A numerical2× result with increased wrong decisions still fails quality independently.
- Recorded budget violations are reported from unique call records and token usage; missing usage stays null and unsafe sums fail. These diagnostics never assert enforcement.
- `finalGenerations` includes all qualifying logical generations. `reReviewGenerations` counts explicitly marked re-review generations separately. `repeatGenerations` counts only additional non-reReview generations beyond one qualifying new final per candidate; re-review-only work therefore reports repeat0/reReview1. A mixed-input regression verifies all three counts independently.
- Offline malformed JSON returns a fixed error without echoing evidence. Replay and replay-plan cannot enable any model execution.

Executed RED evidence:

- `npx vitest run tests/pipeline-capacity.test.ts`: initial missing-module suite failed; after the schema/API skeleton, 52 behavior tests failed and2 passed. Missing report/compare/admission behavior and missing consistency checks caused the expected failures.
- New quality-subset/replica/JSON-syntax regressions:3 failing assertions, then GREEN after their minimal fixes.
- New recorded-budget/token-overflow regressions:2 failing assertions, then GREEN.
- `npx vitest run tests/pipeline-capacity.test.ts -t 'separates exact DB settings binding'`: failed because comparisonReviewPolicyHash did not exist, then GREEN after the exact/comparison hash split.
- Parent final metric review: `npx vitest run tests/pipeline-capacity.test.ts -t 're-review generations|mixed new finals'` failed two assertions showing the conflation, then GREEN after separating reReviewGenerations from repeatGenerations.

Latest executed validation:

```sh
npx next typegen
# exit0: route types generated
npx vitest run tests/pipeline-capacity.test.ts tests/review-pipeline-observability.test.ts tests/pipeline-capacity-export.test.ts
# exit0:3 files,69 tests passed after the parent's final metric review
npx tsc --noEmit
# exit0 after type generation and the parent's in-progress type fixes
npx eslint lib/operations/pipeline-capacity.ts scripts/measure-pipeline-capacity.ts scripts/report-review-latency.ts tests/pipeline-capacity.test.ts
# exit0
git diff --check
# exit0
```

The first tsc attempt failed for missing generated PageProps and two parent-owned in-progress test type errors; next typegen and the parent fixes resolved those. Repository-wide CI and actual DB integration remain the parent's verification responsibility. PR01b real-model execution and historical/run-local transition proof remain incomplete.
