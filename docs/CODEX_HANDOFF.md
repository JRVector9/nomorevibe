# Codex handoff

## Current objective

Execute plan 3, `docs/superpowers/plans/2026-08-19-product-detail-ui-implementation.md`, and show the
finished white-theme, global minimum-13px product-detail screen in the browser.

Plan 2, `docs/superpowers/plans/2026-08-19-product-evidence-pipeline-implementation.md`, is complete.
Plan 3 Task 1 is committed and Task 2 is complete pending its atomic commit. Continue at Task 3.

## Completed work

Plan 3 commits and completed phases:

1. `6058fa2 test: prepare product detail browser coverage`
2. Task 2, commit message `feat: let makers manage product evidence`:
   authenticated/capped profile, link, media, provenance, maker-update, and refresh resource APIs;
   transactional audit writes; asynchronous external-media declarations; maker-update tombstones;
   per-product-generation and optional trusted-proxy IP rate limits; stale in-flight media response
   rejection through declaration ID/revision checks.

Task 2 does not add comments, login, reactions, follows, or provider I/O in request handlers.
External gallery URLs are declarations only. The evidence job copies validated bytes into internal
content-addressed storage before any image becomes public.

Plan 2 commits:

1. `ca15631 feat: add product evidence storage`
2. `c03b97a feat: validate product evidence declarations`
3. `f4c47d6 feat: collect GitHub product evidence`
4. `5cf6107 feat: normalize external product updates`
5. `d260126 feat: persist immutable product media`
6. `85dbcbe feat: record product build provenance`
7. `481cab4 feat: refresh product evidence`

The committed pipeline separates maker declarations from observed facts; collects bounded
GitHub/store/package/feed/changelog facts; retains last-known-good values; normalizes immutable
updates; copies validated gallery images into content-addressed PostgreSQL storage; stores optional
agent/skill provenance without affecting ranking; records 30-day health; and runs a bounded
six-hour refresh job.

Task 8 now also:

- deletes product-owned profile/link/source/media/update/provenance/audit, health, click, ranking,
  takedown, OG, and product rows in one transaction;
- preserves shared media bytes until the final relationship is deleted;
- bans/unbans without deleting evidence and audits only a real row transition;
- treats reusable slug and numeric product ID as a generation, validating it under
  `product-lifecycle:<slug>` before evidence, update, media, GitHub, health, status, or delete writes;
- prevents an old GitHub post-refresh schedule and an in-flight uptime response from attaching to a
  same-slug replacement;
- uses one public-IP classifier for declarations, preflight DNS, and connection-time DNS; reserved,
  documentation, benchmarking, multicast, loopback, link-local, and private ranges are rejected;
- caps successful GitHub JSON responses at 2 MiB using declared and streamed byte checks;
- treats malformed percent-encoded release URLs without aborting the whole feed batch;
- stops GitHub release pagination when the job budget expires, keeps the product cursor in place,
  and does not record budget exhaustion as provider failure;
- applies shared 6/12/24/48-hour retry to transient GitHub failure while preserving a real provider
  rate-limit reset timestamp;
- logs unexpected per-product refresh failure as safe `slug` plus normalized `errorCode` only;
- documents tokens, schedule, source semantics, retry/stale behavior, network/media limits,
  PostgreSQL `bytea` capacity/backup impact, and one-product force refresh;
- leaves production scheduler/token checks explicitly unverified in `PENDING.md`, requiring an
  operator to inspect existing schedules before adding missing entries.

## Modified files

Plan 3 Task 2 files:

- `app/api/products/[slug]/maker-route.ts`
- `app/api/products/[slug]/{profile,links,media,provenance,refresh}/route.ts`
- `app/api/products/[slug]/updates/route.ts`
- `app/api/products/[slug]/updates/[id]/route.ts`
- `drizzle/0015_product_media_declarations.sql`
- `drizzle/0016_light_boomerang.sql`
- `drizzle/meta/0015_snapshot.json`
- `drizzle/meta/0016_snapshot.json`
- `drizzle/meta/_journal.json`
- `lib/db/product-evidence-schema.ts`
- `lib/domain/evidence/maker.ts`
- `lib/domain/evidence/refresh.ts`
- `lib/domain/evidence/repository.ts`
- `lib/domain/media/repository.ts`
- `lib/domain/products/maker-auth.ts`
- `lib/domain/products/manage.ts`
- `lib/domain/products/repository.ts`
- `lib/rate-limit.ts`
- `tests/integration/maker-evidence-api.test.ts`
- `tests/integration/product-evidence-lifecycle.test.ts`
- `tests/integration/setup.ts`
- `tests/maker-evidence-routes.test.ts`

Task 8 commit files:

- `PENDING.md`
- `README.md`
- `docs/CODEX_HANDOFF.md`
- `lib/crawl/github.ts`
- `lib/domain/evidence/contracts.ts`
- `lib/domain/evidence/providers/github.ts`
- `lib/domain/evidence/refresh.ts`
- `lib/domain/evidence/repository.ts`
- `lib/domain/evidence/updates.ts`
- `lib/domain/media/repository.ts`
- `lib/domain/products/health.ts`
- `lib/domain/products/manage.ts`
- `lib/domain/products/repository.ts`
- `lib/jobs/products/evidence-refresh.ts`
- `lib/jobs/products/uptime.ts`
- `lib/net/fetch.ts`
- `lib/net/ssrf.ts`
- `tests/evidence-contracts.test.ts`
- `tests/github-evidence.test.ts`
- `tests/integration/evidence-refresh.test.ts`
- `tests/integration/github-evidence.test.ts`
- `tests/integration/product-evidence-lifecycle.test.ts` (new)
- `tests/integration/uptime.test.ts`
- `tests/ssrf.test.ts`
- `tests/update-events.test.ts`

## Key design decisions

- Maker mutation order is authorization, rate-limit charge, bounded body read, schema validation,
  then transaction. Authenticated malformed and oversized bodies therefore consume quota.
- Rate-limit product identity is immutable `products.id`, not reusable slug. A newly registered
  same-slug generation never inherits the prior owner's exhausted bucket.
- A raw `X-Forwarded-For` header is used only when `TRUSTED_PROXY_HOPS >= 1`. When no trusted
  client address is available, maker routes skip the IP bucket rather than merging every tenant
  into one global `direct` bucket; the product-generation bucket remains mandatory.
- Media declaration rows carry a monotonically increasing revision. The collector captures
  declaration ID/revision before network I/O and revalidates both after the product-media lock,
  preventing removed or edited declarations from publishing a stale response.
- Maker media replacement and collector publication share lifecycle then product-media lock order.
- Two generated additive migrations are retained: `0015` creates declarations and `0016` adds the
  revision used for in-flight compare-and-swap behavior.

- Slug is reusable and is not identity. Long-running work captures `products.id`, then validates
  `(id, slug)` under the lifecycle advisory lock before any write.
- Lock order is lifecycle, product-media, then sorted asset hashes.
- Full maker-authorized deletion physically removes owned data. Ban only changes public eligibility
  and keeps evidence/audit history.
- Network requests stay outside transactions; each completed observation gets a short generation-
  checked transaction.
- Budget exhaustion is control flow, not provider failure. It leaves the source due and product
  cursor unchanged.
- A GitHub rate-limit timestamp is preserved only when the provider actually supplied one; otherwise
  shared attempt-based backoff applies.
- Production evidence scheduling state is unknown until an operator with production access inspects
  the platform schedule and `/admin/status`; missing entries should be added without duplicating
  existing ones.

Plan 3 local Next.js 16 guidance read before implementation:

- Route Handler mutation methods are uncached, dynamic segment params are promises, and generated
  `RouteContext<"/path/[param]">` types are available only after `next typegen`, dev, or build.
- `cookies()` is asynchronous; cookie mutation is limited to Route Handlers or Server Functions and
  must happen before response streaming starts.
- Direct ORM reads belong in Server Components, but authorization still applies. The detail model
  will use request-scoped `React.cache()` for the identity read, then eagerly start independent DB
  reads and await them with `Promise.all`.
- Gallery rendering will use only the internal media route with stored width/height to prevent
  layout shift. Page rendering must not call external providers.

## Test commands and results

Plan 3 Task 2 RED results actually observed:

- initial route tests failed because the maker helper/routes did not exist;
- initial resource integration tests failed because the APIs were absent;
- declared gallery refresh returned `mediaInserted: 0` until declarations joined the evidence job;
- an already-normalized link payload was parsed as a raw declaration twice and returned 500;
- review regressions failed as expected: invalid bodies created no rate row, same-slug replacement
  inherited a 429, and a removed in-flight gallery response was published;
- first GREEN attempt after revision wiring failed with `ReferenceError: sql is not defined`; the
  paused race test then timed out because collection never reached its start signal. Importing the
  existing Drizzle `sql` helper fixed the root cause.

Plan 3 Task 2 final verification actually run:

```text
npx vitest run tests/maker-evidence-routes.test.ts
  PASS — 1 file, 2 tests
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts
  PASS — 1 file, 7 tests
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts tests/integration/product-evidence-lifecycle.test.ts tests/integration/evidence-refresh.test.ts tests/integration/product-media.test.ts
  PASS — 4 discovered files, 36 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
git diff --check
  PASS
npx drizzle-kit check
  PASS
```

`npx drizzle-kit generate` created `0016_light_boomerang.sql`; `npx drizzle-kit migrate` applied
the declaration revision to the local integration database. No production database was accessed.

RED regressions actually observed during Task 8/review:

- delete left product evidence/health rows; ban did not audit;
- stale delete/status and in-flight generic/GitHub work mutated a same-slug replacement;
- reserved/non-global IPs passed runtime/declaration checks;
- declared and streamed oversized GitHub JSON parsed successfully;
- malformed percent encoding threw `URIError`;
- GitHub release pagination ignored job budget;
- transient/rate-limit-without-reset GitHub failures bypassed shared backoff;
- budget exhaustion was persisted as transport failure and advanced the cursor;
- in-flight uptime wrote replacement health;
- unexpected product refresh failure had no safe diagnostic log.
- a deletion authorized before an admin ban could erase the subsequently banned product;
- repeated status transitions created duplicate audit rows.

Final focused verification actually run:

```text
npx vitest run tests/ssrf.test.ts tests/evidence-contracts.test.ts tests/github-evidence.test.ts tests/update-events.test.ts
  PASS — 4 files, 54 tests
npx vitest run --config vitest.integration.config.ts tests/integration/github-evidence.test.ts tests/integration/evidence-refresh.test.ts tests/integration/uptime.test.ts
  PASS — 3 files, 40 tests
npx vitest run --config vitest.integration.config.ts tests/integration/product-evidence-lifecycle.test.ts
  PASS — 1 file, 8 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
git diff --check
  PASS
```

Final full matrix actually run on the current code:

```text
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm test
  PASS — 31 files, 293 tests
npm run test:integration
  PASS — 31 files, 319 tests
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/p/[slug]` and `/api/media/[hash]` dynamic
sh -n scripts/scheduler.sh
  PASS
git diff --check
  PASS
npx drizzle-kit check
  PASS
```

Expected suite output: the existing Vitest native config-loader warning and intentional error logs
for invalid ranking policy, job failures, and registration rollback. All suites exited zero.

Local development database state:

- Before migration check: evidence tables `0/4`.
- `npx drizzle-kit migrate`: PASS; additive migrations applied successfully.
- After migration: evidence tables `4/4` (`product_profiles`, `product_evidence_sources`,
  `media_assets`, `evidence_settings`).
- No production database was accessed.

## Review and failed approaches

- The first Task 2 review found one P1 and three P2s: a global `direct` IP bucket, invalid-body
  quota bypass, slug-keyed generation collision, and stale in-flight media publication. All four
  were reproduced in RED integration tests and fixed as described above.
- Three bounded read-only Codex re-review attempts did not return a final verdict: the first two
  spent their three-minute windows loading the full review workflow and re-reading/rerunning broad
  checks; the third focused run read the intended files but its final output was not returned by the
  CLI wrapper before process exit. None is claimed as CLEAN. The repository was not modified by
  these review attempts. A manual final diff inspection found no remaining instance of the four
  reproduced regressions.

- The installed gstack `/review` workflow cannot run because
  `.agents/skills/gstack/review/checklist.md` is absent.
- Exact `gpt-5.6` is unsupported by this account; read-only reviews used supported
  `gpt-5.6-sol`.
- Two broad complete-diff reviews exceeded the three-minute bound without verdict and were
  interrupted; they are not claimed as passes. The same full scope was then split into storage/
  contracts, providers/media, provenance/jobs, and lifecycle/docs boundaries.
- Split reviews found all P2s listed in RED history. Each was reproduced before implementation.
  Provider/media and provenance/job re-reviews returned `CLEAN`; focused lifecycle generation
  re-review also returned `CLEAN`. The last lifecycle/docs review then found a P1 ban/delete race,
  a P2 duplicate status audit, and contradictory production-schedule claims; all three were fixed
  after RED reproduction. The final narrow re-review returned `CLEAN`.
- A historical storage review reported missing deletion cleanup, but the current Task 8 lifecycle
  transaction and eight regression cases supersede it. Its hostname-only SSRF concern was refined
  into the real runtime reserved-range gaps and fixed at the shared classifier.
- First force-refresh documentation used top-level await and failed under `tsx -e` CJS transform.
  The promise form succeeded against the test database for a missing slug.
- A real `.env.local` force-refresh probe produced no output and was terminated; no live provider
  success is claimed.
- The first ban/delete regression fixture omitted its referenced `media_assets` row and failed on
  the foreign key before exercising deletion. Adding only the missing fixture row exposed the
  intended `true`-instead-of-`false` deletion failure.
- The first `impeccable` helper lookup used its documented project-local `.Codex/...` path, which is
  absent here. The installed global helper reported `NO_PRODUCT_MD`; `PRODUCT.md` was then derived
  from the already approved detail specification before resuming Plan 3.

## Remaining work

- Execute plan 3 Tasks 3–8: evidence administration, detail read model, public media delivery,
  white-theme detail components/page, `/nomorevibe` commands, then full review/docs/QA. Comments
  remain phase-2 design only; no comment persistence or login integration belongs in phase 1.
- Launch the resulting local screen and perform browser/visual QA at desktop and mobile widths.

External blockers remain in `PENDING.md`: category classification API verification and production
scheduler/provider-token verification. Do not claim either complete without external access.

## Exact commands for the next agent

```sh
git status --short
cat docs/superpowers/plans/2026-08-19-product-detail-ui-implementation.md
npx vitest run tests/admin-evidence.test.ts tests/evidence-admin-components.test.ts
npx vitest run --config vitest.integration.config.ts tests/integration/evidence-admin.test.ts
npx tsc --noEmit
npm run lint
npm run build
```
