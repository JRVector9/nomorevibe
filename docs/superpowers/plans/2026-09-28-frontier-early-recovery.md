# Frontier Early Recovery Implementation Plan

> **For agentic workers:** Use test-driven-development and execute inline under the user's existing P1 authorization.

**Goal:** Reclaim a `fetching` item from a dead prior `crawl-fetch` run at the next valid job lease, without waiting ten minutes or spending a failure attempt.

**Architecture:** The job table already serializes `crawl-fetch` ownership. Compare each frontier row's DB `updated_at` with the current job's DB `last_run_at`; only older claims can be reclaimed. The update checks the current job token in the same SQL statement and does not lock the job row before frontier rows, preserving the existing frontier→job lock order. Existing attempt and timestamp claim checks reject late prior writes.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL 17, Vitest.

---

## File map

- `tests/integration/crawl-fetch.test.ts`: real DB proof of quick reclaim, current job protection, old claim rejection, and wrong lease no-op.
- `lib/crawl/repository.ts`: guarded `recoverAbandonedFrontier` update.
- `lib/crawl/jobs/fetch.ts`: call recovery once before the first `dequeue` when a job lease exists.
- `docs/superpowers/specs/2026-09-28-worker-failover-design.md`: replace the unconditional schema-token requirement for this single-job path with the tested DB timestamp rule; retain role fencing for cross-role failover.

### Task 1: Recover only prior job claims

- [x] **Step 1: Write failing integration test.** Insert `crawl-fetch` job with a fresh token and `lastRunAt` at `now()`, one frontier row `fetching` with `updatedAt=now()-1 minute`, one `fetching` with `updatedAt=now()+1 second`, both due in ten minutes. Call `recoverAbandonedFrontier(lease)`. Expect exactly one recovered row with `state=pending`, `attempts` reduced by one and immediate DB eligibility. Expect the current row unchanged. Wrong token and another role's token cause zero recoveries. Preserve the old claim and assert its `markFrontier` call does not complete the recovered row after a new `dequeue`.
- [x] **Step 2: Verify RED.** `npm run test:integration -- tests/integration/crawl-fetch.test.ts -t "recovers a prior fetch claim"` failed because the new recovery function was absent.
- [x] **Step 3: GREEN.** Added `recoverAbandonedFrontier(lease: JobLease)` to `lib/crawl/repository.ts`. One `UPDATE` changes only `state='fetching'` rows older than the current `jobs.last_run_at`, provided that `crawl-fetch` token and 90-second lease remain valid. It does not lock the job row before frontier rows.
- [x] **Step 4: Verify GREEN.** Targeted and full `crawl-fetch.test.ts` passed.

### Task 2: Invoke recovery once at the beginning of a fetch job

- [x] **Step 1: RED.** A new run-job integration case left an old `fetching` row and initially saved no source on the next tick.
- [x] **Step 2: GREEN.** `fetchCrawlDocuments` calls `recoverAbandonedFrontier(ctx.lease)` once after checking enabled and budget, before `dequeue`; positive count is logged.
- [x] **Step 3: Verify.** Integration 60/60 and focused unit 7/7, typecheck, targeted lint and `git diff --check` passed; code/tests committed as `6f4aaf2`.

## Safety gate

The early reclaim fixes the ten-minute wait for the **single named fetch job**. It does not constitute role-level fencing. P1 role lease and write-path audit must pass before enabling a standby crawler or reviewer. If lock-order or late-write tests reveal a race, stop this approach and use an explicit frontier claim token migration instead.
