# Worker Progress Detection Implementation Plan

> **For agentic workers:** Use test-driven-development and implement inline in the user-authorized P0 sequence.

**Goal:** Emit a conservative, structured alarm only when scheduled work or an eligible collection/review queue has stopped making stored progress.

**Architecture:** A pure classifier consumes the existing persisted-throughput snapshot, job retry state, service observations, and scheduler due times. A read-only query assembles these inputs. A CLI emits JSON with a nonzero alarm exit code for an external monitor. The classifier never requests a restart; P1 will consume confirmed signals.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM, PostgreSQL 17.

---

## File map

- `tests/worker-progress.test.ts`: pure classification tests for idle, pause, retry, progress, liveness, scheduler due, and unknown data.
- `lib/operations/worker-progress.ts`: pure conservative classifier and output types.
- `lib/operations/worker-progress-query.ts`: read-only collection of current settings, throughput, job rows, and service observations.
- `scripts/check-worker-progress.ts`: JSON CLI for external monitoring.
- `tests/integration/worker-progress-query.test.ts`: isolated DB proof that actual queue and job records reach the classifier.

### Task 1: Classify persisted demand and progress

**Files:** `tests/worker-progress.test.ts`, `lib/operations/worker-progress.ts`

- [x] **Step 1: RED.** Write tests that call `classifyStage(stage, job, observed, now)` with:

```ts
const stage = { key: "fetch", enabled: true, waiting: 4, oldestMinutes: 8,
  completed5m: 0, progress5m: 0, errors5m: 0 } as const;
expect(classifyStage({ ...stage, waiting: 0 }, null, true, now).reason).toBe("no_work");
expect(classifyStage({ ...stage, enabled: false }, null, true, now).reason).toBe("paused");
expect(classifyStage({ ...stage, progress5m: 1 }, null, true, now).reason).toBe("progressing");
expect(classifyStage(stage, { notBefore: new Date(now.getTime() + 60_000) }, true, now).reason).toBe("backoff");
expect(classifyStage(stage, null, false, now).reason).toBe("worker_missing");
expect(classifyStage(stage, null, true, now).reason).toBe("no_progress");
expect(classifyStage({ ...stage, errors5m: 2 }, null, true, now).reason).toBe("upstream_or_job_error");
expect(classifyStage({ ...stage, key: "judge", oldestMinutes: 8 }, null, true, now).reason).toBe("warming_up");
expect(classifyStage({ ...stage, oldestMinutes: null }, null, true, now).reason).toBe("unknown_age");
```

Run `npx vitest run tests/worker-progress.test.ts`; expected failure: missing `classifyStage` export.

- [x] **Step 2: GREEN.** Implement `classifyStage` with ordered guards: disabled → no work → progress → future `notBefore` → recent errors → unknown age → stage threshold (judge 15 minutes; others 5) → missing service → no progress. Return `{role, stage, reason, alarm}`. A missing service with no work remains `no_work`; a recent error is diagnostic and does not cause automatic restart.

- [x] **Step 3: Verify.** Run `npx vitest run tests/worker-progress.test.ts`, then `npx tsc --noEmit` after `npx next typegen` if route types are absent.

### Task 2: Detect overdue scheduling conservatively

**Files:** `tests/worker-progress.test.ts`, `lib/operations/worker-progress.ts`

- [x] **Step 1: RED.** Add a `classifyScheduler(jobs, observed, now)` test using scheduled catalog entries. A job with `nextScheduledAt` more than twice its interval in the past and no fresh scheduler observation must signal `scheduler_missed`; a future due time is `scheduled`; missing due data is `unknown_schedule`; explicit user `notBefore` for `product-intro-check` does not count as demand.
- [x] **Step 2: GREEN.** Use `JOB_CATALOG` intervals, read only `nextScheduledAt` and observation freshness. Do not infer a missed schedule from zero output, because a scheduled tick can find zero new repositories.
- [x] **Step 3: Verify.** Run the targeted unit suite.

### Task 3: Wire read-only evidence and CLI

**Files:** `tests/integration/worker-progress-query.test.ts`, `lib/operations/worker-progress-query.ts`, `scripts/check-worker-progress.ts`

- [x] **Step 1: RED.** In the dedicated test DB, create an old eligible `crawl_frontier` row and a fresh `service:crawler:*` observation. Assert the query's fetch signal is `no_progress`. Set the row to retry in the future; assert `no_work`. A missing DB configuration was checked separately with the CLI and produced `unknown`/exit code1.
- [x] **Step 2: GREEN.** Fetch `getSettings()`, `pipelineThroughput()`, `listJobStates()`, and all service observations read-only. Map fetch→crawler, judge/first/second→reviewer. Emit one JSON report with measured time, stage signals, scheduler signal, and overall `alarm`/`unknown`/`ok`. CLI exit codes: 0 healthy or idle, 2 actionable alarm, 1 query/unknown. Do not send messages or mutate job state.
- [x] **Step 3: Verify.** Run the integration test, related throughput tests, typecheck, and `git diff --check`. Related code committed as `b0375e8`.

### Completed additions within P0

- [x] A separate liveness test and classifier alarm when a role has no fresh observation even with an empty queue.
- [x] Real DB test for four recent boot IDs, three restarts, and ignoring an older process's late observation.
- [x] Admin rendering tests for stored-progress reason, scheduler delay, missing worker, and repeat restarts. Existing status page reuses already loaded throughput, jobs, and observations; it does not run the aggregate query twice.

## Phase gate

Document actual test results and remaining work in `docs/CODEX_HANDOFF.md`. The administrator view and external monitor configuration require separate validation; the CLI output alone is not an active pager. Continue with P1 only after this distinction is recorded.
