# Codex handoff

## Current objective

Stabilize and display the completed ranking UI after the user requested the live local screen:

- reuse one PostgreSQL client/pool per Next.js server runtime in production;
- enforce the user's global minimum 13 px font contract across `app/**/*.tsx` and
  `components/**/*.tsx`;
- leave the final production-mode local server running on port 43125 for visual review.

Plan 1 of 3, the privacy-preserving unique-visit collection and ranking transition, is complete and
committed through `845f056`. This follow-up runtime/typography fix is implemented, fully tested,
reviewed clean, and committed as `fix: stabilize production ranking screens`. Only the local
display server is now running from the final production build on `http://localhost:43125`.

No production database, secret store, scheduler, or deployment was accessed. Production migration,
`VISITOR_HASH_SECRET`, first collection time, seven-day readiness, and scheduler execution are all
unverified and remain explicit blockers in `PENDING.md`.

## Completed work

- Reproduced the production-only pool leak: each `db` proxy property access created a fresh
  `postgres(..., { max: 10 })` pool because production skipped the global cache. `lib/db/index.ts`
  now caches the client and Drizzle instance in every environment.
- Raised every explicit sub-13 px Tailwind class (including `text-xs`) in rendered app/components
  to `text-[13px]`. This covers public product/ranking/detail/launch screens and admin screens,
  including trust, builder, status, and stack badges.
- Added production-client lifecycle, trust-badge render, and repository-wide app typography
  regressions. The typography test recursively scans all app/component TSX sources.

- Added nullable product-scoped visitor hashes without rewriting legacy visit events, KST daily
  unique counts, a singleton collection-start row, and finalized unique fields on ranking entries.
- Added `HMAC-SHA256(secret, slug + "\0" + visitorCookie)` before rate limiting or persistence.
  Missing/short secrets fail measurement closed while `/go/<slug>` still redirects. Raw cookies,
  IPs, user agents, and hashes are excluded from logs.
- Added batched seven-day valid-visit and exact distinct-browser metrics, adjacent distinct trend
  windows, warm-up masking, idempotent KST daily rollups, and transaction-safe 35-day pruning.
- Versioned ranking policies. The default and existing snapshots stay on `valid-visits-v1`; the
  separately exported recommendation uses `unique-visitors-v1`, 25% repeat credit, one extra visit
  per unique, and the existing cooldown.
- Updated refresh/finalization to persist exact unique totals and trends. Unique seasons require raw
  retained events and fail explicitly instead of summing daily unique counts; legacy catch-up still
  uses daily valid-visit rollups.
- Preserved public semantics: legacy seasons show `유효 방문`, unique seasons show `고유 유입자`
  with secondary `유효 방문`, and all-time remains `누적 유효 방문`.
- Added an admin readiness gate: unique policies cannot be scheduled until seven complete days from
  the first successful hashed visit and can only apply at a future season boundary. The admin shows
  current valid-visit and proposed unique-first previews from the same policy base.
- Documented the metric definitions, 35-day retention boundary, prohibition on multi-day sums of
  daily unique values, secret generation/separation/rotation effects, and production verification
  procedure in `README.md` and `PENDING.md`.
- Added the generated `0013_snapshot.json`. A fresh repository copy now reports no schema changes
  instead of generating a duplicate 0014 migration.
- Rebuilt the legacy-policy test fixture without unused destructuring; final lint is warning-free.

## Commits and modified files

Implementation commits, in order:

1. `e04de85 feat: store privacy-safe unique visits`
   - `lib/db/schema.ts`
   - `drizzle/0013_unique_visits.sql`
   - `drizzle/meta/_journal.json`
   - `tests/integration/unique-visit-schema.test.ts`
   - `tests/integration/setup.ts`
2. `f589797 docs: clarify visit collection state`
   - `docs/superpowers/plans/2026-08-19-unique-visit-ranking-implementation.md`
3. `bb87d12 feat: anonymize outbound visit identity`
   - `.env.example`
   - `compose.yml`
   - `app/go/[slug]/route.ts`
   - `lib/domain/products/clicks.ts`
   - `lib/domain/products/visitors.ts`
   - `tests/visitor-hash.test.ts`
   - `tests/integration/clicks.test.ts`
4. `7723c2a feat: aggregate unique outbound visitors`
   - `lib/domain/products/clicks.ts`
   - `lib/jobs/products/click-rollup.ts`
   - `tests/integration/clicks.test.ts`
5. `49c152e feat: version unique-first ranking policy`
   - `lib/domain/ranking/policy.ts`
   - `lib/domain/ranking/math.ts`
   - `tests/ranking-policy.test.ts`
   - `tests/ranking-math.test.ts`
6. `02b0a2d feat: refresh unique-first ranking seasons`
   - `lib/domain/ranking/refresh.ts`
   - `tests/integration/ranking-refresh.test.ts`
7. `31f42e5 feat: explain season ranking metrics`
   - `lib/domain/ranking/view.ts`
   - `components/RankingTable.tsx`
   - `components/SeasonPolicy.tsx`
   - `components/DiscoveryBoards.tsx`
   - `app/page.tsx`
   - `app/rankings/[key]/page.tsx`
   - `tests/integration/ranking-view.test.ts`
   - `tests/ranking-components.test.ts`
   - `tests/ranking-season-page.test.ts`
8. `96ee6d9 feat: stage unique ranking transition`
   - `lib/domain/ranking/policies.ts`
   - `lib/domain/ranking/view.ts`
   - `app/admin/ranking/RankingPolicyForm.tsx`
   - `app/admin/ranking/page.tsx`
   - `app/admin/AdminNav.tsx`
   - `components/Panel.tsx`
   - `tests/admin-ranking.test.ts`
   - `tests/integration/ranking-policies.test.ts`
9. `f15b10f fix: complete unique visit migration metadata`
   - `drizzle/meta/0013_snapshot.json`
   - `tests/integration/ranking-refresh.test.ts`
10. `845f056 docs: operate unique visitor rankings`
    - `README.md`
    - `PENDING.md`
    - `docs/CODEX_HANDOFF.md`
11. `fix: stabilize production ranking screens` (current HEAD)
    - production DB singleton reuse, global 13 px typography correction, regressions, and handoff

The follow-up fix currently modifies:

- `lib/db/index.ts`
- `components/{BrowseFilters,MarketStats,ProductCard,Tag,TrustBadges}.tsx`
- `app/layout.tsx`, `app/launch/page.tsx`, and `app/p/[slug]/{page,TakedownForm}.tsx`
- admin typography in `app/admin/**/*.tsx`
- `tests/{db-client,min-font-size,trust-badges}.test.ts`
- `docs/CODEX_HANDOFF.md`

## Key design decisions

- The PostgreSQL pool remains capped at 10 connections, but its client and Drizzle wrapper are now
  cached once per Node/Next runtime regardless of `NODE_ENV`. This preserves dev HMR reuse and fixes
  unbounded production pool creation without changing query behavior.
- The 13 px rule is enforced at source level for rendered TSX, covering explicit px/rem values and
  Tailwind `text-xs`. The change is typography-only; wording, data semantics, colors, and layout
  structure are unchanged.

- `고유 유입자` is a distinct accepted first-party browser identifier observed through NoMoreVibe
  for one product and time window. It is not a verified person or the product's total traffic.
- `유효 방문` is an accepted outbound event after bot/link-preview exclusion and product/browser
  ten-minute repeat filtering.
- The persisted identity is a product-scoped 64-character HMAC only. `VISITOR_HASH_SECRET` must be
  at least 32 characters, separately generated with `openssl rand -hex 32`, and not reused with
  admin, cron, or edit-token secrets.
- A secret rotation changes every derived identity, resets the ten-minute rate-limit identity, and
  can double-count the same browser across a window. Historical hashes cannot be re-keyed because
  raw identifiers are never stored. Routine rotation is therefore not recommended.
- The first request that can derive a hash sets `unique_visitor_started_at` using database time.
  Migration/deployment time never starts the seven-day clock.
- Raw events are retained for 35 days. Daily unique values are exact only for one KST day and must
  never be summed across days. Active/missed unique seasons outside raw retention fail explicitly;
  closed season totals survive in `ranking_entries`.
- The unique-first formula is `unique × 100% + min(extra valid visits, unique × 1) × 25%`, followed
  by the existing cooldown. Facts, maker claims, agents, and skills remain ranking-neutral.
- Existing and missing-scoring policy JSON normalizes to `valid-visits-v1`. Current seasons never
  change formula mid-season, and all-time remains a historical valid-visit aggregation.

## Test commands and results

Follow-up runtime/typography TDD and final verification actually run on 2026-08-19 KST:

```text
npx vitest run tests/db-client.test.ts tests/trust-badges.test.ts
  RED — production db property access created 3 PostgreSQL clients; badges rendered 11/10.5 px
  GREEN — 2 files, 2 tests passed after client caching and badge correction

npx vitest run tests/min-font-size.test.ts
  RED — app/components still contained explicit 10.5–12.5 px and text-xs classes

npx vitest run tests/min-font-size.test.ts tests/trust-badges.test.ts tests/db-client.test.ts
  GREEN — 3 files, 3 tests passed after the global 13 px correction

npm test
  PASS — 22 files, 205 tests

npm run test:integration
  PASS — 23 files, 259 tests; expected negative-path logs and the existing Vite warning appeared

npx tsc --noEmit
  PASS — exit 0, no diagnostics

npm run lint
  PASS — 0 errors, 0 warnings

npm run build
  PASS — Next.js 16.3.1 production build; 12/12 static pages generated

git diff --check
  PASS — exit 0, no output

production-mode local smoke after the final build
  PASS — /, /rankings/2026-W34, and /p/simplehwp returned 200
  PASS — first 40 repeated requests had 0 failures; lazy DB connections settled from 7 to 8
  PASS — second 40 repeated requests had 0 failures; DB connections remained 8 before/after
  PASS — rendered home, ranking, and detail HTML contained 0 sub-13 px class tokens
```

The required `gpt-5.6/high` Codex CLI review was attempted and rejected by the installed ChatGPT
account with HTTP 400. The supported default `gpt-5.6-sol/xhigh` fallback review then ran the unit,
integration, lint, and production-build checks itself and ended with:
`No actionable defects were found.`

Task-level TDD and review verification actually run during implementation:

- Task 1: schema integration `1/1` passed; `npx drizzle-kit check` and `git diff --check` passed.
- Task 2: visitor unit `6/6`, click integration `34/34`, and TypeScript passed.
- Task 3: click integration `43/43`, ranking math `3/3`, TypeScript, and whitespace checks passed.
- Task 4: policy/math targets `25/25`, full unit suite `190/190`, TypeScript, and whitespace checks
  passed.
- Task 5: the new tests first failed in six intended unique cases; after fixes the refresh target
  passed `22/22` twice, followed by TypeScript and whitespace checks.
- Task 6: final component `15/15`, season-page `3/3`, ranking-view integration `13/13`, TypeScript,
  lint, and whitespace checks passed.
- Task 7: final admin `11/11`, policy/view integration `23/23`, refresh integration `22/22`,
  TypeScript, lint (0 errors; two fixture warnings later fixed during final review), and whitespace
  checks passed.

The exact Task 8 release matrix was run sequentially on 2026-08-19 KST:

```text
npx next typegen
  PASS — route types generated successfully

npx tsc --noEmit
  PASS — exit 0, no diagnostics

npm test
  PASS — 19 files, 202 tests
  NOTE — Vite warned that ESM syntax is loaded as CommonJS in vitest.config.ts

npm run test:integration
  PASS — 23 files, 259 tests
  NOTE — expected negative-path error logs were emitted by policy/job/register failure tests
  NOTE — the same Vite config-loader compatibility warning was emitted

npm run lint
  INITIAL PASS — 0 errors, 2 legacy-fixture warnings
  FINAL PASS — 0 errors, 0 warnings after the independent-review fix

npm run build
  PASS — Next.js 16.3.1 production build compiled, typechecked, and generated 12/12 static pages

git diff --check
  PASS — exit 0, no output
```

Focused final-review verification actually run:

```text
# RED, in a temporary copy without 0013_snapshot.json
npx drizzle-kit generate
  GENERATED duplicate 0014 DDL for visit_collection_state, five columns, and the visitor index

# GREEN, in a new temporary copy with generated 0013_snapshot.json
npx drizzle-kit generate
  PASS — No schema changes, nothing to migrate

npx drizzle-kit check
  PASS — Everything's fine

npx vitest run --config vitest.integration.config.ts \
  tests/integration/unique-visit-schema.test.ts \
  tests/integration/ranking-refresh.test.ts
  PASS — 2 files, 23 tests (schema 1 + refresh 22)

npx tsc --noEmit
  PASS — exit 0, no diagnostics

npm run lint
  PASS — 0 errors, 0 warnings

git diff --check
  PASS — exit 0, no output after the documentation correction

git diff --no-index --check /dev/null drizzle/meta/0013_snapshot.json
  PASS — no whitespace diagnostics (the expected no-index difference status was ignored)
```

Migration `0013_unique_visits.sql` was applied repeatedly by the integration-test setup against the
dedicated test database. It has not been applied or inspected in production. No production warm-up
status is known; `PENDING.md` contains the exact verification sequence and forbids claiming it has
started without checking the singleton state after a real hashed request.

## Failed approaches and review findings

- The first local production-screen attempt failed because the development database had not yet
  applied migration 0013. `npx drizzle-kit migrate` was applied only to the local development DB;
  no production database was accessed.
- After migration, the unchanged production server exhausted PostgreSQL connections. `lsof` showed
  roughly 100 connections from one Next process; source tracing found production skipped the global
  cache in `lib/db/index.ts`. Stopping that server released the connections, and the TDD fix keeps
  the count stable.
- The first repeated-request shell probe used zsh's read-only `status` variable and stopped before
  the loop. Renaming it to `response_code` produced the valid 40-request result above.
- The exact `gpt-5.6/high` Codex review command failed with the known ChatGPT-account HTTP 400. The
  supported default `gpt-5.6-sol/xhigh` review completed clean instead; no unsupported-model success
  is claimed.

- The `ak` skill's first Codex review invocation used an option unsupported by the installed CLI.
  After correcting the invocation, the installed ChatGPT-account Codex rejected `gpt-5.6` with
  HTTP 400. Independent reviewer subagents were used for every task instead of claiming the CLI
  review ran.
- Task 1 exposed a plan contradiction over whether collection start could be null. The schema and
  contract require null until a real hashable visit; the plan was corrected in `f589797`.
- Task 2 review found fail-open Compose secret handling and a vacuous privacy/log assertion. RED
  regressions made `.env.example` empty, Compose require the secret, and proved missing/short secrets
  persist no event/rate limit/start state and disclose no visitor/hash/IP/User-Agent.
- Task 3 review found partial KST-day overwrite, pruning after an outage could drop unrolled events,
  slug-array bind limits, a KST-midnight clock flake, and daily upsert parameter limits. RED tests led
  to whole-day boundaries, aggregate-before-delete transactions, one encoded slug array, fixed KST
  fixtures, and 1,000-row write batches.
- Task 5 review found an exact `now - 35d` cutoff disagreed with KST-day pruning, causing legacy
  undercount and false rejection of unique seasons. Two RED boundary cases led to one shared,
  injected KST day-start cutoff.
- Task 6 initially produced three TS2339 errors from discriminated-union narrowing; display values
  were moved into the scoring branch. Review then found four P2 issues: DiscoveryBoards mislabeled
  unique values, unique trend ties used visits, a home heading computed below 13 px, and long mobile
  text could not wrap. RED regressions fixed all four and extended the font correction to discovery.
- Task 7 review found dual previews used different policy bases, scheduled policy handling could
  diverge, proposed-first slicing could hide current top products, and Panel/AdminNav text computed
  to 12.5 px. RED tests produced a shared scheduled/form base with scoring-only variants, a union of
  visible products, and 13 px minimums. Re-review found mapping the union after slicing could still
  omit the opposite list's number 2; a second RED test led to a full lookup plus separate top-slug
  sets.
- Final review found that handwritten migration 0013 had no snapshot. A temporary-copy RED generated
  a duplicate 0014 with the same table, columns, and index. The generated current-schema snapshot was
  added as `drizzle/meta/0013_snapshot.json`; its `prevId` matches the actual 0012 snapshot, and a new
  temporary copy now reports no changes. No 0014 artifact remains in the repository. The correction
  is committed in `f15b10f`.
- Final review also promoted the two ESLint warnings to an actionable P2. The legacy JSON fixture now
  uses key filtering instead of unused destructuring, preserving its missing `scoring` and missing
  unique-trend-default semantics with zero lint warnings. The earlier handoff description that called
  the warnings pre-existing/non-failing was incorrect; `f15b10f` contains the warning-free fixture.
- The first snapshot RED command created the temporary copy but failed to change into it, so Drizzle
  briefly generated 0014 artifacts in the repository. Only those generated SQL/snapshot/journal
  additions were immediately removed with `apply_patch`; the RED was then rerun successfully inside
  the explicit temporary path.
- The Vite config-loader warning remains a non-failing pre-existing warning and was not expanded into
  unrelated configuration work.

## Remaining work

1. Execute `docs/superpowers/plans/2026-08-19-product-evidence-pipeline-implementation.md`.
2. Execute `docs/superpowers/plans/2026-08-19-product-detail-ui-implementation.md` only after plan 2.
3. With explicit production access/approval, complete `PENDING.md` B1/B2: configure the distinct
   secret, deploy/apply migration 0013, verify the first hashed visit starts collection, observe the
   seven-day gate, and verify hourly rollup/refresh scheduling. None is complete yet.

Comments, reply depth, and unified user login remain phase two by design, not unfinished plan-1 work.

## Exact commands for the next agent

```bash
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
git diff --check
npm test
npm run test:integration
npx tsc --noEmit
npm run lint
npm run build

# Local visual review only; do not stop an unrelated server on port 3000.
npm run start -- -p 43125
open http://localhost:43125/rankings/2026-W34

# Continue with plan 2 only after reviewing repository state.
git log --oneline -10
git diff --check
sed -n '1,760p' docs/superpowers/plans/2026-08-19-product-evidence-pipeline-implementation.md
```
