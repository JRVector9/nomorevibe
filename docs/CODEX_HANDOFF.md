# Codex handoff

## Current objective

Complete the approved click-based seasonal discovery ranking. Tasks 1-5 of the implementation plan
are complete; the next work is Task 6, which exposes public/admin read models and replaces the old
absolute `delta24h` with a click percentage.

The source of truth is:

- `docs/superpowers/specs/2026-08-18-weekly-ranking-design.md`
- `docs/superpowers/plans/2026-08-18-weekly-ranking-implementation.md`

## Completed work

- Defined and validated the configurable ranking policy and default weekly values.
- Implemented KST weekly/monthly periods, transition seasons, cooldown factors, click percentage,
  deterministic scoring, and ranking tie-breaks.
- Added ranking policy, season, and entry persistence plus KST daily-click rebuild support.
- Implemented immutable applied/scheduled/cancelled policy revisions with advisory locking.
- Implemented a single-transaction ranking refresh that:
  - creates and refreshes active seasons idempotently;
  - ranks only verified products and retains eligible zero-click products;
  - expands the launch window to the smallest whole-day window that reaches the configured minimum,
    capped by the configured maximum;
  - finalizes every crossed season and creates weekly/monthly transition periods;
  - applies only policies scheduled before the relevant boundary;
  - cancels invalid stored scheduled JSON and inherits the known-good active snapshot;
  - uses raw click events inside retention and KST daily rollups for older missed seasons;
  - applies cooldown history and adjacent trend windows;
  - rolls back snapshot changes when aggregation fails.
- Added the `ranking-refresh` job adapter and registry entry after `click-rollup`.
- Made large candidate sets safe by binding slug filters as one PostgreSQL `text[]` parameter and
  writing entries in 1,000-row batches.
- Made admin preview use a current-data window with the next period's duration while preserving the
  actual next-period boundary for cooldown history.

Implementation commits through this checkpoint:

- `9cb2c3b feat: define ranking policy`
- `480daa7 fix: align ranking policy warnings`
- `c80a7fc feat: calculate ranking seasons and scores`
- `1020d1e feat: persist ranking seasons`
- `e7b59b3 fix: align ranking daily cutoff with KST`
- `60bd3bb feat: schedule ranking policies`
- `65b5617 fix: select latest applied ranking policy`
- `7089b26 feat: refresh seasonal rankings`
- `e644f17 fix: harden ranking preview and large refreshes`
- `9a5035a fix: preserve cooldown history in ranking previews`

## Modified files

Core files added or changed in Tasks 1-5:

- `lib/domain/ranking/policy.ts`
- `lib/domain/ranking/period.ts`
- `lib/domain/ranking/math.ts`
- `lib/domain/ranking/policies.ts`
- `lib/domain/ranking/refresh.ts`
- `lib/db/schema.ts`
- `lib/db/fixtures.ts`
- `lib/domain/products/clicks.ts`
- `lib/domain/products/repository.ts`
- `lib/jobs/products/ranking-refresh.ts`
- `lib/jobs/registry.ts`
- `drizzle/0012_ranking_seasons.sql`
- `drizzle/meta/0012_snapshot.json`
- `drizzle/meta/_journal.json`
- ranking unit and integration tests under `tests/` and `tests/integration/`

This handoff file is the only uncommitted change when this checkpoint is first written.

## Key design decisions

- Score units are valid clicks multiplied by the cooldown factor in basis points.
- Weekly seasons start Monday 00:00 KST; monthly seasons start on the first at 00:00 KST.
- Cadence changes create one real transition season and therefore advance cooldown history.
- Verified products alone compete; seeded products remain exclusive to the discovered-new board.
- The default eligibility window is 28 days, expands toward 20 products, and caps at 90 days.
- Active season policy snapshots are locked. Scheduled policies apply only at a later eligible season
  boundary and are revalidated before application.
- Policy and refresh advisory locks are acquired in a consistent policy-then-refresh order, and the
  default policy is ensured inside the refresh transaction rather than through a nested transaction.
- Raw click events are the source inside the 35-day retention window; old complete KST-day ranges use
  `product_click_daily`.
- Preview uses a rolling interval equal to the next season's duration ending at `now`. Cooldown
  history still uses the real next season boundary.
- Large slug sets use one encoded PostgreSQL array bind; entry upserts remain batched.
- Finalized season entries are historical snapshots and are not rewritten outside rollover.

## Test commands and results

Latest root verification after commit `9a5035a`:

```bash
npx vitest run --config vitest.integration.config.ts \
  tests/integration/ranking-refresh.test.ts tests/integration/job-runner.test.ts
# 2 files passed, 25 tests passed

npm test
# 14 files passed, 148 tests passed

npx tsc --noEmit --pretty false
# passed

npm run lint
# passed

git diff HEAD^ HEAD --check
# passed
```

Earlier root verification after the policy work ran the complete integration suite:

```bash
npm run test:integration
# 20 files passed, 204 tests passed at commit 60bd3bb
```

The latest Task 5 commits received independent `codex review` passes. The last review of `9a5035a`
reported no remaining findings.

## Failed approaches

- The original Task 2 sample expected a lower-click product to win an equal score. That contradicted
  the approved tie-break contract, so the test was corrected to score, valid clicks, verification
  time, then slug.
- Policy lookup originally sorted applied rows by creation time. A scheduled-before-default sequence
  returned stale settings; it now sorts by application time.
- Delayed rollover originally applied a policy created after a missed boundary retroactively; the
  scheduled query now requires `createdAt <= boundary`.
- A single large entry upsert and later unbounded slug predicates could exceed PostgreSQL's bind
  limit. Upserts were batched and slug filters now use one `text[]` bind.
- Direct JavaScript array interpolation produced a PostgreSQL record cast rather than an array. A
  `DriverValueEncoder` now emits a correctly escaped array literal as one bound value.
- Preview initially queried the future season and returned zero metrics. The first rolling fix then
  hid recent cooldown history; click-window and cooldown-history boundaries are now separate.
- The aggregation failure regression uses a temporary column rename inside `try/finally` because a
  mock would not prove the real SQL transaction rollback. The column is restored after the test.
- `codex review` with an explicit `gpt-5.6` model name was unsupported by the installed ChatGPT
  account; the default `gpt-5.6-sol` invocation works.

## Remaining work

1. Task 6: ranking read models, global ranks under filtering, corrected click percentages, market
   percentage, and the four discovery-board queries.
2. Task 7: authenticated admin ranking settings, preview, replace/cancel actions, and status panel.
3. Task 8: public home discovery boards and ranking table.
4. Task 9: season history and methodology pages.
5. Task 10: invoke `ranking-refresh` from `scripts/scheduler.sh`, update production scheduler
   instructions/PENDING, run full verification, and document operations.

Production scheduler registration itself still requires user authorization/environment access as
described in `PENDING.md`. The local scheduler and instructions must still be changed in Task 10;
the current registry entry alone does not execute the job.

## Exact commands for the next agent

```bash
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
sed -n '840,1005p' docs/superpowers/plans/2026-08-18-weekly-ranking-implementation.md
sed -n '1,220p' lib/domain/products/clicks.ts
sed -n '1,140p' lib/domain/products/stats.ts
sed -n '1,180p' lib/domain/products/view.ts
sed -n '1,220p' components/ProductCard.tsx
sed -n '1,430p' tests/integration/clicks.test.ts

# Task 6 RED/GREEN verification target
npx vitest run --config vitest.integration.config.ts \
  tests/integration/clicks.test.ts tests/integration/ranking-view.test.ts
npm test
npx tsc --noEmit --pretty false
npm run lint
git diff --check
```

Implement only Task 6, start with its failing tests, and commit with
`feat: expose ranking read models`. Then run an independent commit review before Task 7.
