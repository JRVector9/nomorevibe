# PR01b Scoped Review Clock Implementation Plan

> **For agentic workers:** Use the available `execute-plan` skill task by task with RED/GREEN checks. Parent approved this design and inline implementation. Do not spawn agents, commit, call production/providers, add ledger hooks, or change v1 capacity artifacts in this subtask.

**Goal:** Let admitted replay work freeze review evidence freshness and require prepared README evidence while preserving real leases, retries, deadlines and durable event timestamps.

**Architecture:** An explicit AsyncLocalStorage scope contains an immutable reference epoch and an inseparable stored-evidence policy. Only semantic freshness checks read it. Production outside that scope retains its existing wall/DB clocks; existing writer `now` arguments continue to mean event time. The parent runner enters the scope only after its isolated DB/provider admission checks.

**Tech Stack:** Node24 AsyncLocalStorage, TypeScript, Drizzle SQL, Vitest; no new dependency or schema.

---

## Ownership and boundaries

Create `lib/crawl/review-replay-context.ts` and `tests/review-replay-context.test.ts`; modify only review freshness in `lib/crawl/{rules,agent-review-contract,agent-review-repository,second-review-input,second-review}.ts` and `lib/crawl/jobs/{agent-review,review-document,second-review}.ts` when necessary. Add `tests/integration/review-replay-clock.test.ts` for actual writer/SQL agreement. Parent owns ledger/final hooks, the new replay artifact, DB admission and submission.

No global Date replacement, environment clock switch, database clock/GUC override, provider adapter, alternate review engine or writer-signature fan-out. `secondApproved` and its exported SQL projection remain byte-for-byte unchanged: they contain configured slot/status/identity predicates and no clock condition.

## Clock inventory

| Location | Frozen semantic time | Real time retained |
| --- | --- | --- |
| `agent-review-contract.ts:createReviewInput` | site/scan freshness, relationship, ruleStop and access mode; unchanged absolute source-derived validUntil | no event timestamps created here |
| `rules.ts:accessFromDocument` | optional explicit now forwarded to judgeStoredDocument/judge | unscoped default remains real |
| `agent-review-repository.ts:loadReviewInput/currentReviewInput` | recomputation; validUntil/document/scan future bounds | assertJobLease and row locking |
| `matchingSource` | document fetchedAt <= reference | identity/source equality unchanged |
| `reviewApprovalPredicate`, `starAutoApprovalPredicate`, `assertReviewApproval` | validUntil and 24h source freshness, JS star proof | lease assertions and gate locking |
| `requeueStaleReviewSources` | document freshness | frontier inactivity/cooldown, nextAttemptAt/updatedAt and requestJob |
| `handOffExhaustedFirstReviews` | document freshness and successful attempt validity | exhaustion count, updatedAt and lease |
| `reviewCandidatePredicate` | document/scan freshness and successful attempt validity | running job lockedAt, failed retryAfter and owner-change completedAt lookback |
| `claimAgentReview` | successful cached attempt validity | input.now/startedAt/completedAt, retryAfter and owner-change lookback |
| `second-review-input.ts` | input validity and input recomputation | current configured identity, actor/source/generation checks unchanged |
| `second-review.ts:enqueueSecondReviews` | first-attempt validity; published sample eligibility lookback | existing now used for holds/resolution and DB-default createdAt |
| `closeSettledSecondReviews` | obsolete first-attempt validUntil cutoff only | resolvedAt, ordinary decided-state cleanup |
| `recordSecondReview`, `retryFailedSecondReviews`, `recentSecondReviewFailures` | input recomputation inherits scope | reviewedAt/resolvedAt, retry windows, diagnostics window and lease |
| AI1 handler | input validity, verdict and access mode | Date.now tick budget, aborts, call durations, retry deadlines and telemetry |
| AI2 handler | inherits scoped input/enqueue/cleanup helpers | tick budget, provider deadlines, Date.now and explicit new Date event arguments |

Publisher-only `requeueInvalidStarApprovals` is not executed by replay. Its local source freshness/proof checks may use the same semantic accessor for consistency, while frontier scheduling and event timestamps remain real. The runner must never dispatch publication, fetch, judge or README-refresh jobs that the existing writers request in the isolated DB.

## Task 1: Scoped context and pure contract

- [ ] Write and run the new unit tests before implementation. Initial missing-module RED is recorded separately from behavioral RED.
- [ ] Implement these exact exports:

```ts
export function withReviewReplayContext<T>(options: { referenceTime: Date }, load: () => Promise<T>): Promise<T>;
export function reviewSemanticNow(wallFallback?: Date): Date;
export function reviewSemanticNowSql(): SQL;
export function storedReviewEvidenceRequired(): boolean;
```

The scope copies a finite Date to epoch milliseconds and freezes its store. Invalid input rejects `invalid_replay_reference_time`. A different nested reference rejects `replay_clock_scope_conflict`; identical references can nest. `reviewSemanticNow` returns a new Date each time and scoped reference time takes priority over the supplied wall fallback. Outside the scope, its explicit fallback retains existing injectable-now behavior. `reviewSemanticNowSql` returns parameterized `referenceISO::timestamp` in scope and the original SQL `now()` otherwise; the schema stores these columns as timestamp without time zone.

```ts
await withReviewReplayContext({ referenceTime }, async () => {
  const input = createReviewInput(candidate, document, settings, evidence);
  expect(input.snapshot.relationship).toBe("same_product");
  expect(Date.now()).toBeGreaterThan(referenceTime.getTime());
});
```

- [ ] Observe behavioral RED for historical fresh input, explicit access-mode time, and AI2 matching while the context exists but callers remain unchanged.
- [ ] Make `createReviewInput` normalize its existing now through the semantic accessor; pass that exact date to `accessFromDocument` and ruleStop. Add an optional now argument to `accessFromDocument` and forward it to both rule branches. Keep the pure rules defaults outside replay unchanged.
- [ ] Verify scope isolation across concurrent promises, nesting/throw cleanup, Date-copy immutability, finite reference validation, parameterized SQL and unchanged unscoped wall time. Verify source freshness boundaries and access-mode rule time without globally faking Date.

Run: `npx vitest run tests/review-replay-context.test.ts tests/agent-review-contract.test.ts`.

## Task 2: Prepared README boundary

- [ ] Add unit regressions using the actual `loadReviewDocument` and mocked repository/network boundary: current-version string and empty string pass; missing/old-version/nonstring samples reject before fetch or save. The unscoped existing fetch behavior remains allowed and tested.
- [ ] Observe behavioral RED, then add the fail-closed branch after the existing prepared-document fast path:

```ts
if (storedReviewEvidenceRequired()) throw new Error("replay_readme_evidence_missing");
```

- [ ] Apply the same prepared-evidence requirement in `loadReviewInput` before any evidence query so direct AI2 input loading cannot silently substitute an old or absent README. Missing documents remain undefined at `loadReviewDocument`; admission/preflight must reject missing frozen cohort documents. No network prohibition is inferred from this one guard: provider/network admission remains parent-owned.
- [ ] Run unit tests with fetch/save spies and verify no request or README mutation occurs in stored-only scope.

## Task 3: Freshness-only JS and SQL changes

- [ ] Add dedicated integration cases before changing the repository freshness predicates. Request the parent's exclusive 55453 DB slot before any DB command; the DB agent currently owns it. No other database is admissible.
- [ ] Change only the semantic predicates in the inventory. Bind reference time with the SQL accessor; retain raw SQL now() in lease/retry/frontier/owner-change predicates and scheduling writes.

```ts
const now = input.now ?? new Date(); // durable wall event time, unchanged
const semanticNow = reviewSemanticNow(now);
const success = same.find(row => row.state === "succeeded" && row.validUntil > semanticNow && row.outcome);
// retryAfter > now and ownerChanges relative to now remain real.
```

AI2 enqueue and settled cleanup keep their existing now parameter for durable events and compute a separate `semanticNow = reviewSemanticNow(now)` for validity/eligibility. AI2 result recording and retries retain event-time arguments. AI1 handler forwards semantic time to input validity, judgeStoredDocument and accessFromDocument. AI2 handler needs no event-time rewrite.

- [ ] Test actual SQL selection, locked claim/record, AI2 enqueue/cleanup/record and exact required-slot gate with old evidence fresh at reference but expired at wall time. Prove a future retry remains blocked, an old real lease remains invalid, and durable event timestamps stay close to actual Date.now. Test expired-at-reference evidence and future-at-reference source data separately.
- [ ] Verify `secondApproved` SQL is unchanged and v1 capacity files are untouched.

## Task 4: Verification and parent handoff

- [ ] Run the focused unit set:

```sh
npx vitest run tests/review-replay-context.test.ts tests/agent-review-contract.test.ts tests/agent-review-job.test.ts tests/second-review-job.test.ts tests/second-review.test.ts tests/crawl-readme.test.ts
```

- [ ] When the exclusive DB slot is granted, run the new integration file and related review writer/publication gate suites against the admitted 55453 test DB. Record actual commands/results; the DB URL is supplied by the parent and never points to a service DB.
- [ ] Run scoped ESLint and `npx tsc --noEmit` after shared generated route types are available. Run `git diff --check` and inspect the exact changed hunks for accidental real-clock substitutions.
- [ ] Update this execution record with actual RED/GREEN/results. Send the parent files, exports, limits and exact remaining checks. Parent owns the shared CODEX_HANDOFF update and commits.

## Parent integration requirements

Frozen source expiry can precede real startedAt/completedAt. V1 artifacts intentionally reject that combination and are not relaxed here. The new replay artifact must bind semantic reference provenance and check source validity against that reference while retaining real run/call/transition timestamps for latency and throughput. Parent must scope snapshot/final-proof recomputation accordingly; no new recording hooks are added by this subtask.

## Execution record

Implemented after parent design approval. The four scoped exports above are available. No change was needed in `jobs/second-review.ts`: its existing event-time arguments stay real while the shared input/enqueue/cleanup helpers inherit semantic time. No ledger hook, v1 capacity artifact, schema, provider or production change belongs to this subtask.

Executed RED/GREEN evidence:

- Initial new unit invocation failed to resolve the intentionally missing context module (0 tests). After the context existed but its callers remained unchanged, the strengthened behavioral suite had 8 failures / 7 passes: old evidence was stale, the optional rule clock was ignored, AI2 rejected the historical generation, and unprepared README paths attempted fetch/query work.
- After the narrow contract/rule/AI2/README edits, `npx vitest run tests/review-replay-context.test.ts tests/agent-review-contract.test.ts` passed 2 files / 30 tests.
- With exclusive ownership of local dedicated port55453, the new integration file initially had 4 failures / 4 passes. Historical SQL selection returned no candidate and locked writers returned `input_changed`; expired/future-source and stale-lease refusal already passed.
- After freshness-only repository and AI2 edits, the new integration file passed 8 tests. The combined command below passed 6 files / 128 tests. It verifies historical SQL/locked-writer agreement, cached success reuse, AI2 enqueue/cleanup/record, every configured gate slot, expired/future sources, real retry readiness and lease expiry, and real durable event timestamps. The expected revoked-publication-lease fixture emitted `job_lease_lost` error logs while its assertions passed.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55453/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/review-replay-clock.test.ts tests/integration/agent-review-records.test.ts tests/integration/review-publication-gate.test.ts tests/integration/review-handoffs.test.ts tests/integration/second-review.test.ts tests/integration/review-document.test.ts
```

- Final focused unit command from Task4 passed 6 files / 99 tests, including current-version nonstring README rejection and the ordinary unscoped fetch path.
- Scoped ESLint over the eight implementation files and two new tests passed. `git diff --check` passed. A literal extraction comparison against HEAD verified `secondApproved` byte-for-byte unchanged; tracked v1 capacity implementation paths are untouched.
- `npx tsc --noEmit` initially found a target-incompatible `1n` fixture literal; changed it to the equivalent `BigInt(1)`. A subsequent type check has no clock-owned errors, but remains red because concurrent DB/ledger work has `pipeline-replay-database.ts:76` host/port type errors and missing `tests/integration/replay-setup.ts` imports. Parent/DB owner were informed; this is not a claimed type-check pass.

The dedicated DB slot was yielded to the parent after the integration checks. Its restricted `pipeline_replay` schema/role remained outside clock fixtures. At the DB owner's request, two separate boundary RED cases were executed while holding the slot: UPDATE(nonce) column privilege and a callable SECURITY DEFINER canary. Both exposed verifier admission gaps; each test's finally cleanup ran, and the DB owner received the results before implementing fixes. These are DB-boundary work, not changes in this clock subtask.

Remaining parent work: finish shared DB/ledger artifacts and hooks, rerun whole-worktree type checks and combined verification, and bind historical semantic reference provenance in the new replay artifact. No live replay, provider call, verified speed result or production deployment was performed. Parent owns the shared `docs/CODEX_HANDOFF.md` update and submission.
