# Worker Review Recovery Implementation Plan

> **For agentic workers:** Implement these steps in order with the test-driven-development skill. This task is executed inline because the user already asked to proceed in priority order.

**Goal:** A worker owner change must not spend the model failure budget, while repeated infrastructure interruptions remain bounded and visible.

**Architecture:** Keep immutable review attempt history. Count model failures and `owner_changed` interruptions separately for the current source, policy, provider, and model. The ready queue and claim transaction must enforce the same limits.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, PostgreSQL 17.

---

## File map

- `tests/integration/agent-review-records.test.ts`: real DB regression for owner changes, independent limits, and queue eligibility.
- `lib/crawl/agent-review-repository.ts`: shared review candidate predicate and atomic claim decision.
- `docs/CODEX_HANDOFF.md`: verified behavior and test evidence after the phase.

### Task 1: Separate the owner change budget

**Files:**
- Modify: `tests/integration/agent-review-records.test.ts`
- Modify: `lib/crawl/agent-review-repository.ts`

- [x] **Step 1: Write a failing integration test.** Add this `it` in the existing test file (its imports already contain the named helpers):

```ts
it("separates owner changes from model failures and retries after the interruption window", async () => {
  const base = await fixture("enforce");
  await saveSettings({ firstReview: { provider: base.provider, model: base.model } }, "test");
  const settings = await getSettings();
  const context = { ...base, settings,
    input: await loadReviewInput(base.candidate, base.document, settings) };
  const lease = { ...context.lease };
  const claim = () => claimAgentReview({ ...context, lease });
  for (let number = 1; number <= 3; number++) {
    lease.token = `owner-${number}`;
    await db.update(jobs).set({ leaseToken: lease.token, lockedAt: new Date() })
      .where(eq(jobs.name, lease.name));
    expect(await claim()).toMatchObject({ kind: "claimed", attempt: { attemptNumber: number } });
  }
  lease.token = "owner-4";
  await db.update(jobs).set({ leaseToken: lease.token, lockedAt: new Date() })
    .where(eq(jobs.name, lease.name));
  expect(await claim()).toEqual({ kind: "skipped", reason: "infrastructure_interruptions_exhausted" });
  expect((await db.select().from(crawlReviewAttempts)).map(row => [row.state, row.errorCode, row.outcome]))
    .toEqual(Array.from({ length: 3 }, () => ["superseded", "owner_changed", null]));
  const ready = () => db.select({ id: crawlCandidates.id }).from(crawlCandidates)
    .where(reviewCandidatePredicate(settings, { readyOnly: true }));
  expect(await ready()).toEqual([]);
  await db.update(crawlReviewAttempts).set({ completedAt: new Date(Date.now() - 25 * 60 * 60_000) });
  expect((await ready()).map(row => row.id)).toEqual([context.candidate.id]);
  expect(await claim()).toMatchObject({ kind: "claimed", attempt: { attemptNumber: 4 } });
});
```

- [x] **Step 2: Verify RED.** Run `npm run test:integration -- tests/integration/agent-review-records.test.ts -t "separates owner changes"`. Expected: assertion failure showing `attempts_exhausted` instead of `infrastructure_interruptions_exhausted`.

- [x] **Step 3: Implement the minimal split in `lib/crawl/agent-review-repository.ts`.** Replace the old predicate count with these two conditions:

```ts
sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
  AND ${crawlReviewAttempts.state} IN ('failed','superseded')
  AND ${crawlReviewAttempts.errorCode} IS DISTINCT FROM 'owner_changed') < ${MAX_REVIEW_ATTEMPTS}`,
sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${matchingSource(settings)}
  AND ${crawlReviewAttempts.state} = 'superseded'
  AND ${crawlReviewAttempts.errorCode} = 'owner_changed'
  AND ${crawlReviewAttempts.completedAt} > now() - interval '24 hours') < 3`,
```

After `same` is assembled in `claimAgentReview`, replace its `same.length` limit with:

```ts
const modelFailures = same.filter(row => (row.state === "failed" || row.state === "superseded")
  && row.errorCode !== "owner_changed").length;
const ownerChanges = same.filter(row => row.state === "superseded" && row.errorCode === "owner_changed"
  && row.completedAt !== null && row.completedAt.getTime() > now.getTime() - 24 * 60 * 60_000).length;
if (ownerChanges >= 3) return { kind: "skipped", reason: "infrastructure_interruptions_exhausted" };
if (input.provider !== "rules" && modelFailures >= MAX_REVIEW_ATTEMPTS)
  return { kind: "skipped", reason: "attempts_exhausted" };
```

Keep `attemptNumber = same.length + 1` for immutable audit order. This is a separate sequence from the model failure budget.

- [x] **Step 4: Verify GREEN and existing behavior.** Run `npm run test:integration -- tests/integration/agent-review-records.test.ts`. Expected: all tests pass, including the existing three timeout failures and model identity tests.

- [x] **Step 5: Inspect the diff and commit this phase.** Run `git diff --check`; stage only the two listed code/test files; commit `1aab591 fix: separate reviewer owner changes from model retry budget`.

## Phase handoff

Record test output, modified files, failed approaches, and next commands in `docs/CODEX_HANDOFF.md`. The next plan implements P0 demand-aware detection and alerting; then P1 frontier recovery and role fencing; then P2 and P3 deployment stages from the design specification.
