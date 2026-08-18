# Codex handoff

## Current objective

The approved click-based seasonal discovery ranking implementation is complete through Task 10.
The local scheduler now refreshes ranking snapshots after click rollup, the operating docs describe
the shipped behavior, and the public/admin flows have been exercised against a migrated development
database. A post-Task-10 clock flake in the popular-ranking integration fixture has also been
stabilized. The remaining work requires external credentials or production-environment access.

Sources of truth:

- `docs/superpowers/specs/2026-08-18-weekly-ranking-design.md`
- `docs/superpowers/plans/2026-08-18-weekly-ranking-implementation.md`
- `PENDING.md`

## Completed work

- Added configurable weekly/monthly KST seasons with a real transition season when cadence changes.
- Ranked verified products by valid clicks multiplied by a transparent soft-cooldown factor. Seeded
  products remain exclusive to the separate newly discovered board.
- Added adjacent-window click percentages, minimum-baseline qualification, four discovery boards,
  all-time ranking, global ranks under filtering, and immutable historical season pages.
- Added immutable applied/scheduled/cancelled ranking policy revisions. `/admin/ranking` previews and
  schedules the next policy without changing the active season snapshot.
- Added transactional `ranking-refresh` rollover/materialization plus large-candidate safeguards,
  KST daily rollups, invalid-policy fallback, and rollback regressions.
- Added `ranking-refresh` to the local scheduler immediately after `click-rollup` in the same hourly
  condition. The production external schedule is intentionally not registered.
- Replaced the README's rolling-seven-day description with season rules, valid-click semantics,
  cooldown recovery, next-season scheduling, the refresh job, history URL, and admin location.
- Updated `PENDING.md` with the required production order: `click-rollup` at minute 0 and
  `ranking-refresh` at minute 5.
- Migrated the local development database through `0012_ranking_seasons.sql`, ran the refresh job,
  and created active season `2026-W34` with two eligible entries.
- Browser-smoked the public home and authenticated ranking admin on desktop and 390 px mobile. A
  draft changed the trend minimum baseline from 5 to 6 only in a scheduled revision; the active
  season key and policy revision were equal, and the policy snapshot passed a deep-equality check.
- Stabilized the popular-ranking integration fixture by letting PostgreSQL assign `occurredAt`, the
  same clock source used by production `recordClick`, instead of inserting JS timestamps that could
  briefly be in the future relative to the database.

Implementation commits before the Task 10 release commit:

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
- `2649352 feat: expose ranking read models`
- `8a578bf fix: enforce ranking board boundaries`
- `09e96b7 feat: manage ranking policy`
- `a085393 feat: show weekly discovery rankings`
- `c2dd272 fix: clarify public ranking states`
- `92972e7 feat: show historical ranking seasons`

## Modified files

Task 10 modifies only:

- `scripts/scheduler.sh`
- `README.md`
- `PENDING.md`
- `docs/CODEX_HANDOFF.md`

The follow-up clock stabilization modifies:

- `tests/integration/clicks.test.ts`
- `docs/CODEX_HANDOFF.md`

The temporary authenticated Playwright script was removed. Screenshots are diagnostic artifacts
outside the repository:

- `/private/tmp/nomorevibe-ranking-home.png`
- `/private/tmp/nomorevibe-ranking-admin-desktop.png`
- `/private/tmp/nomorevibe-ranking-admin-mobile.png`

## Key design decisions

- A valid click is an accepted `/go/<slug>` outbound event: known bots/previews are excluded and the
  same first-party visitor/product pair counts at most once per 10 minutes.
- Main score units are `validClicks * cooldownFactorBasisPoints`; click-change percentage drives
  trending only and does not alter the main season score.
- Weekly seasons start Monday 00:00 KST; monthly seasons start on the first at 00:00 KST.
- Active policy snapshots are immutable. One scheduled revision replaces the previous scheduled
  revision and applies only at an eligible future boundary.
- Closed-season finishes advance cooldown history by seasons, not elapsed days. Overlapping cooldown
  schedules use the strongest active penalty and recover toward 100%.
- Verified products alone compete. Seeded products are never a fallback for competitive boards.
- `click-rollup` must finish before `ranking-refresh`; the documented production separation is five
  minutes, while the local loop calls them sequentially under its hourly condition.
- The long-lived local Next dev process on port 3000 was not killed. It cached a Drizzle relational
  schema before the ranking tables existed, so `db.query.rankingSeasons` is absent only in that stale
  process. A fresh current build served the admin successfully; production starts fresh and is not
  affected. Restart the old dev process before using it for more admin work.

## Test commands and results

Task 10 full verification on 2026-08-19 KST:

```bash
sh -n scripts/scheduler.sh
# passed

git diff --check
# passed, no output

npm test
# 18 files passed, 170 tests passed

npm run test:integration
# 22 files passed, 230 tests passed

npm run lint
# passed, ESLint exit 0

npm run build
# passed, Next.js 16.3.1 compiled and typechecked; /admin/ranking and /rankings/[key] are dynamic

codex review -c 'model_reasoning_effort="high"' --uncommitted
# clean: scheduler order and operating docs match the implementation; reviewer reran sh syntax,
# diff check, and all 170 unit tests
```

The integration suite emitted expected error logs from explicit invalid-policy, transaction rollback,
and job-failure regression cases. The suite result was still 22/22 files and 230/230 tests passed.

Post-Task-10 root recheck and clock-flake stabilization:

```bash
npx vitest run --config vitest.integration.config.ts \
  tests/integration/clicks.test.ts -t "많이 눌린 순으로 목록을 세운다"
# RED before the fixture change: ordered slugs were correct, but metrics was undefined

# The same target was then run five consecutive times after using the DB timestamp default.
# 5/5 runs passed: one target test passed and 30 tests skipped in each run.

npm run test:integration
# 22 files passed, 230 tests passed

npm test
# 18 files passed, 170 tests passed

npm run lint
# passed, ESLint exit 0

npm run build
# passed, Next.js compilation and TypeScript succeeded

git diff --check
# passed, no output

codex review -c 'model_reasoning_effort="high"' --uncommitted
# clean: the fixture now matches the production PostgreSQL timestamp path; reviewer reran the
# target test successfully and confirmed the documentation is accurate
```

Job and HTTP/browser smoke:

```bash
npx drizzle-kit migrate
# migrations applied successfully to the local development DB

npm run job ranking-refresh
# status: completed, createdSeason: true, closedSeasons: 0, entries: 2,
# seasonKey: 2026-W34, durationMs: 34

curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/admin/ranking
# 307, Location: /admin/login

npx --yes playwright screenshot --device="Desktop Chrome" --full-page \
  http://127.0.0.1:3000/ /private/tmp/nomorevibe-ranking-home.png
# screenshot created
```

Visual inspection of the home screenshot confirmed the `2026-W34` header, all four boards, valid
clicks, `신규` change state, cooldown factor, and status columns. The layout was sound at desktop
width.

The authenticated browser smoke used an in-memory session signed from `.env.local`; no cookie,
secret, or configured login was printed. Against a fresh current-build process on port 43124 it
observed:

```json
{"status":"completed","home":{"boards":4,"rankingColumns":3},"admin":{"desktop":true,"mobile":true,"scheduledRevisionChanged":true,"activeSeasonUnchanged":true,"activePolicyUnchanged":true},"browserErrors":0}
```

The desktop admin screenshot showed the active locked policy, all editable policy sections, preview,
and revision history. The mobile screenshot showed the new scheduled-policy diff, stacked controls,
and no document-level horizontal overflow. Browser console errors and page errors were both zero.

## Failed approaches

- The first `npm run job ranking-refresh` failed because the development database had not applied
  migration `0012`. After `npx drizzle-kit migrate`, the same job completed in 34 ms.
- The first temporary TypeScript smoke script used top-level await, but this repository's tsx output
  is CommonJS. Wrapping it in `async main()` fixed the diagnostic script; it was deleted afterward.
- Authenticated `/admin/ranking` returned HTTP 500 on the existing port-3000 dev server. The session
  was valid; the stack was `previewRanking -> db.query.rankingSeasons.findFirst`. That process had
  been alive since before the ranking schema was added, and `globalForDb.db` deliberately survives
  HMR, leaving its relational query registry stale. Fresh tsx processes exposed both ranking query
  objects, and a fresh Next process returned HTTP 200 and passed the full browser smoke. No product
  code change was warranted.
- Starting a second `next dev` from the same directory on port 43124 was rejected by Next 16's
  single-dev-server lock. `next start --port 43124` loaded the already verified current build for the
  fresh-process smoke instead; the temporary server was stopped afterward.
- The installed Python environment did not include Playwright. The planned `npx playwright` CLI and
  its cached Chromium were used without changing project dependencies.
- Root's independent full-matrix rerun exposed a reproducible popular-ranking fixture failure: the
  JS clock was about 45 ms ahead of PostgreSQL, so rows inserted with `occurredAt: new Date()` failed
  the production query's strict `< timezone('UTC', now())` cutoff and returned no metrics. The same
  persisted rows returned correct metrics after the clocks caught up. Production click inserts use
  the database column default, so the test fixture was changed to use that same source instead of
  weakening the production time boundary.

## Remaining work

1. Register the external production scheduler in Dokploy. This remains blocked on production access
   and user authorization; use the exact schedule in `PENDING.md`, with ranking refresh after rollup.
2. Verify the real Anthropic category-classification call when an API key becomes available, as
   described in `PENDING.md` D1.
3. Restart the existing local port-3000 dev process before further authenticated ranking-page work so
   its cached Drizzle relational schema includes the ranking tables.

No implementation-plan task remains. The local development DB intentionally contains the scheduled
smoke-test draft (trend baseline 5 to 6); it does not affect the active `2026-W34` policy.

## Exact commands for the next agent

```bash
cd /Users/jr/Desktop/projects/nomorevibe
git status --short

# If continuing local UI work, stop the old dev process in its owning terminal, then restart:
npm run dev

# Reconfirm the local ranking job and public/admin status after restart:
npm run job ranking-refresh
curl -sS -o /dev/null -w 'status=%{http_code} redirect=%{redirect_url}\n' \
  http://127.0.0.1:3000/admin/ranking

# When production access is explicitly authorized, migrate first and then register the PENDING B1
# cron entries. Confirm both jobs in /admin/status:
npx drizzle-kit migrate
curl -X POST "$SITE/api/cron/click-rollup" -H "Authorization: Bearer $CRON_SECRET"
curl -X POST "$SITE/api/cron/ranking-refresh" -H "Authorization: Bearer $CRON_SECRET"
```

Do not run the production commands without the required access and explicit authorization. Do not
remove either `PENDING.md` item until its live verification is complete.
