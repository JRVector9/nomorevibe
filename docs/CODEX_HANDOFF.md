# Codex handoff

## Local deployment QA and merge preparation — 2026-09-08 16:52 KST

- Objective: deploy the completed stacked worker changes locally, exercise the public/admin/worker paths,
  fix every blocker found, then merge PR57 and PR58 to remote main after CI succeeds.
- Worktree: `/Users/jr/Desktop/projects/nomorevibe-workers`, branch `feat/independent-workers`.
  Preserve all unrelated uncommitted files in `/Users/jr/Desktop/projects/nomorevibe`; do not reset or merge
  inside that dirty worktree.
- Completed code changes: stale automatic review sources are requeued to `crawl-fetch` after the terminal
  cooldown; successful refetches that change the product URL reset only automatic unpublished candidates
  to `source_changed/new` and request `crawl-judge`; lock order matches scheduler order and lease loss rolls
  back the transaction. The product detail now conditionally renders one compact development-evidence
  section and keeps team information under objective facts.
- Modified code/tests: `app/p/[slug]/page.tsx`, `components/product-detail/{BuildProvenance,ProductFacts}.tsx`,
  `lib/crawl/{agent-review-repository,repository}.ts`, `lib/crawl/jobs/{agent-review,fetch}.ts`, and the
  corresponding unit/integration/E2E tests including the backpressure mock. Final report:
  `docs/operations/2026-09-08-local-deployment-qa.md`.
- Independent read-only review confirmed the three prior blockers are resolved and found no additional
  correctness/security/concurrency merge blocker.
- Actual final tests: `npm test` 78 files/592 tests PASS; `npm run test:integration` 49/445 PASS;
  targeted unit 2/22 plus backpressure 1/2 PASS; targeted integration 2/16 PASS; `npm run test:e2e`
  5 PASS; Next typegen, full nonincremental TypeScript, ESLint and diff check PASS; final worker and web
  Docker target builds PASS.
- Actual local deployment: `nomorevibe-web:local-merge-qa` plus `nomorevibe-worker:local-merge-qa` run at
  `http://127.0.0.1:43201` against isolated DB `nomorevibe_workers_local_deploy`. Web plus five roles are up;
  workers are healthy; all six restart0/OOM0/error-log0. Browser QA passed 20 public/admin flows with no
  console/page/request errors. Authenticated crawl-fetch returned202 and was consumed; all executable job
  requested/processed versions match with empty last_error. Product force refresh requested1/completed1.
- External collection and Claude were deliberately disabled for final local QA; the earlier bounded real
  CLI/sample evidence remains documented separately. This is not a production deployment or 24h proof.
- Failed approaches: the first final unit run failed one test because its complete repository mock omitted
  the new export; the mock was fixed and the full suite rerun. Integration cleanup removed the fixture and
  the old temporary seed imported crawl tables from the pre-split schema; the temporary import was corrected
  and the production-mode browser run then passed. A diagnostic query guessed `job_controls`; the real table
  is `jobs`, and the corrected query showed complete consumption.
- Remaining sequence: commit and push this diff, wait for PR58 checks, merge PR57, retarget PR58 to main,
  wait for the recalculated checks, then merge PR58 and verify the final commit is contained in origin/main.
  Keep the final local containers running. Production still waits on P0 server/domain/DB and long-lived
  Claude credentials in `PENDING.md`.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git diff --check
git status --short
git add app components lib tests docs/CODEX_HANDOFF.md docs/operations/2026-09-08-local-deployment-qa.md
git commit -m "fix: recover stale review sources before worker merge"
git push origin feat/independent-workers
gh pr checks 58 --watch
gh pr ready 57
gh pr merge 57 --merge
gh pr edit 58 --base main
gh pr checks 58 --watch
gh pr ready 58
gh pr merge 58 --merge
git fetch origin main
git merge-base --is-ancestor HEAD origin/main
```

## Independent worker implementation completed locally — 2026-09-08 15:46 KST

- Latest user authorized parallel implementation, review, fixes and operational verification, with
  essential intermediate tests and comprehensive checks after large phases. PR01–10 code is complete.
- Use `/Users/jr/Desktop/projects/nomorevibe-workers`, branch `feat/independent-workers` for this work.
  Original main's home/auth/UI uncommitted changes are preserved. Do not reset, blanket stage, or merge over them.
- Draft PR58: https://github.com/JRVector9/nomorevibe/pull/58 (new worker implementation).
  Prerequisite draft PR57: https://github.com/JRVector9/nomorevibe/pull/57 (the4existing local commits through9c84bb9).
  PR58 targets review/agent-evidence-foundation; after PR57 lands, retarget58 to main. Neither PR was merged.
- Actual local verification: fullB unit589/integration441; subsequent affected DB28/unit26; finalE2E5,
  cron3 plusrealcontainer400/202, type/lint and web/workerDockerbuilds PASS. Counts are from different phases.
- Real10publicsources allHTTP200; latest .2 allrules needs_review, zero sample publication. CLI authenticated
  structured response succeeded; rules holds are not10AIapprovals. See final report for cost/limits.
- Actual no-web5role30min:1800.307s/31samples allhealthy/restarts0/maxDBconnections5. Externalcollectiondisabled.
  Runtime report integrated070ac57 from agent4865797. Testcontainers exited0; pending/lease/connections/errors0.
- Product1000/click100000/ranking1000, actual recent+weeklyHTML20RPS120s:2400/2400success,p95=33.6ms.
  Not active crawler/LLM capacity or24h assurance. Local acceptanceapp43200 contains testfixtures, not productiondata.
- Reports/runbook/evidence/prompts live under `../nomorevibe-workers/docs/operations/` and its docs/superpowers/plans/.
- Remaining external prerequisites: choose productionserver/domain/DB, configure long-lived ClaudeOAuth,
  deploy with stop/drain→migrationonce→oneofeachrole and observe→enforce, then real24hobservation.
  Read-only Dokploy inventory found no matching project. No production deployment or database reset occurred.
- This handoff update preserves prior entries below. Existing uncommitted original-main files are not in PR58.
- Next agent commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
gh pr checks 58
cat docs/operations/2026-09-08-independent-workers-implementation-report.md
cat docs/operations/independent-workers-runbook.md
# Resolve production target/credentials before deployment. Never enable acceptance fixture publishers.
```

## Independent workers implementation — 2026-09-08 15:42 KST

- Objective: finish approved PR01–10 in parallel through operational readiness. User requests essential
  intermediate checks only, comprehensive verification after large phases, and fixes for discovered failures.
- Integration: `/Users/jr/Desktop/projects/nomorevibe-workers`, `feat/independent-workers`, base9c84bb9.
  Original main worktree has unrelated uncommitted home/auth/UI/Compose changes. Preserve them all.
- Completed PR01–10: DB request versions/leases/schedules; independent 5 roles; GitHub shared cooldown;
  resumable force refresh; queue-only web/cron; role pools and supervised images; immutable review attempts;
  bounded Claude reviewer; current-source publication approval; audited admin mode/decision/recollection.
- Execution prompts: docs/superpowers/plans/2026-09-08-worker-execution-prompts.md.
  Implementation report: docs/operations/2026-09-08-independent-workers-implementation-report.md.
  Runtime acceptance: docs/operations/2026-09-08-worker-runtime-acceptance.md (agent completing).
- Final source fixes through06cfbaa: HTTP rejects scheduler-only heartbeat400 (no consumer), realjobs202; no-first-scan null guard; scan identity advisory lock and scanStartedAt
  source version; completed scan with pending discovery resumes; postgres3.4.9 exact queued cancellation,
  pipeline/BEGIN/connection rotation; graceful leader-only SIGTERM then group cleanup; rules/prompt .2
  deterministically hold missing development evidence before LLM, invalidating mistaken .1 reuse.
- Design: preserve existing handlers/states/SQL queues. Each role singleton; stop/drain before release
  migration and replacement. Web has no CLI. Review off/observe/enforce changes require separate audited
  CAS action and readiness flag. Off removes the gate and is not an automatic rollback. No Redis or
  horizontal worker expansion. Conditional PR11/12 not implemented; no measured need to rewrite home.
- Actual tests: B full unit78files589PASS, full integration49files441PASS; after final evidence/review fixes
  targeted5DBfiles28PASS and3unitfiles26PASS, finalcron3PASS plusactualcontainer400/202. Final Playwright5PASS (product3/admin2), typegen/tsc/lint PASS.
  Final Docker worker+web builds PASS. Do not combine different-stage counts as one final full suite.
  Browser actions: mode changes/admin approval/extra collection/force queue, mobile390 no overflow/JS error.
- Live10: fixed public repos from verify-worker-sample.ts, all pageHTTP200; latest `.2` all rules needs_review,
  zero published sample products, reported historicalAIcost$0.1264348. This is evidence-hold acceptance,
  not 10 successful AI approvals. CLI errors retry rather than reject; actual .1 errors remain history.
  Local container Claude2.1.263/claude-sonnet-5 real auth/structured response passed; smoke1458ms/$0.0070588.
- Capacity: isolated1000products/100000rawclicks; actual click-rollup110ms, ranking-refresh110ms and1000entries
  in2026-W37. Latest Docker web fullresponse20RPS120s:2400/2400HTTP2xx,0errors/skipped,p50=22.7,p95=33.6,
  p99=39.3ms,peakInflight2. Real recent/weeklybody contained fixtures; no rankingfallback/errorpage/logevents.
  VM4CPU7.737GiB,webcap2CPU1.5GiB, other local containers shared. This is not active crawler/LLM capacity.
- Acceptance DB `nomorevibe_workers_acceptance`, no truncation. Root integration DB
  `postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_workers_test` (truncating suites must not overlap).
  Agent separate DBs: runtime_test, agent_resume_test, pool_review_test prefixed nomorevibe_workers_/nomorevibe_.
- Local Docker app43200 `nomorevibe-workers-acceptance-app-1` uses synthetic acceptance data. Original
  app3200/DB55437 and devDB55434 unchanged. Do not start acceptance crawler/publisher: it also contains
  reserved.example browser fixtures, including an admin-approved candidate and force refresh request.
- `/root/implement_runtime`: actual no-web5role observation06:10:09.786Z→06:40:10.118Z,1800.307s,
  31samples allhealthy,restarts0,maxDBconnections5. Cleanup06:40:55Z: all5exit0,pending/lease/connections/errors0. Source image original1901c81, gracefulfix verified
  separately mounted supervisor: earlySIGTERM3/3exit0,steadyexit0; staleheartbeat actualrestart30.34s;
  jobhang+SIGTERM-ignoringCLI actualrestart76.165s with group cleanup. Agent commits report+sanitized evidence JSON; its runtime containers are stopped.
  No24h claim from any local check.
- Final images: docker inspect IDs worker0b5a6690306c4179e75c2ca058eda839ae01aa8acbda0389f49efb88bd181cf7,
  web72ee522e36a2fe9efb630572896310916cac282cd75479eaa479178dfab1dc0c; tags
  nomorevibe-worker:workers-acceptance and nomorevibe-web:workers-acceptance.
- `/root/plan_review` owns README/PENDING/.env.example/runbook docs-only update in pool-review worktree,
  integrated as7719471; root owns plan/handoff/report/sample/capacity/E2E. `/root/plan_runtime` final read-only
  review found no new blocker in recent sourcefixes or verification scripts. No extra tests repeated.
- Failed approaches: initialforceclock skew; CLI detached process group; minfont12; wrong lease test expectation;
  Turbopack node_modules external symlink (own npm ci fixed); browser label selector fixed to selectname;
  nonexistent /ranking404 and missingseason fallback load probes excluded, corrected fullpath numbers above.
- Production: async server/domain question still pending. Read-only Dokploy project.all found no matching
  project. No production mutation. Remote main is4commits behind localbase9c84bb9;
  prepare stacked draftPRs foundationreview/agent-evidence-foundation and feat/independent-workers. Long-lived production Claude credential not configured;
  local token is short-lived Keychain accessToken in private/tmp env files. Never print token/config contents.
- Remaining: cherry-pick final runtime docs commit, final report status/artifacts/handoff,
  commit isolated branch, prepare/push reviewable PR without overwriting dirty main, report exact deployment
  prerequisites and remaining24h observation. No repeating whole tests absent changed behavior/failures.

Exact commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
git log -10 --oneline
# Incorporate only the two agents' docs-only commits; inspect each diff.
git diff --check
# Finished verification logs (all exit0):
tail -n 8 /tmp/nomorevibe-workers-e2e-admin-final.log
cat /tmp/nomorevibe-workers-acceptance/capacity-ranking-20rps.json
# Read-only sample report; never prepare/reset existing acceptance DB:
DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_workers_acceptance node --import tsx scripts/verify-worker-sample.ts report
```

## Minimal worker refactor design re-review — 2026-09-08 KST

- Current objective: correct the worker architecture report against current code and prevent a
  rewrite-sized implementation. User requested documentation changes only.
- Completed: re-read runtime/cron/admin imports, runner/frontier locks, existing maker refresh,
  force media semantics, rule/review/publish paths and their tests. Revised the existing report:
  `docs/superpowers/specs/2026-09-08-independent-workers-and-capacity-design.md`.
- This revision supersedes the earlier generic work_items/schedules/outbox-first proposal. Preserve
  runJob/JobContext/JobOutcome, jobs cursors, frontier, documents, candidate/product statuses,
  evidence collector, publication transaction, public registration/verify and ranking policies.
- Plan A: independent role processes using one worker image/entrypoint and existing handlers;
  add narrow request-version/schedule/owner-token fields to jobs. Role-specific singleton execution
  first; stop/drain on replacement. Runner tokens alone do not fence all domain writes.
- Plan B: crawler-only AI review with bounded input snapshots in crawl_review_attempts and a separate
  reviewMode off/observe/enforce setting. Preserve candidate states and human decisions. Add approval
  filtering before publish LIMIT and validation inside the existing publication guard.
- Plan C: improve measured bottlenecks only. Redis, generalized queues/outbox/DAG, immutable source
  storage, object-storage migration, universal async APIs, ownership/listing policy changes and
  immediate horizontal worker scaling are deferred, not prerequisite work.
- Important corrections: maker refresh already returns 202; queueMakerRefresh does not force recent
  observed media. Preserve admin force scope through a small product_refresh_requests record and
  resumable progress in the existing evidence job. Admin status imports JOB_NAMES from the executable
  registry; split out metadata so removing cron imports actually separates the web graph. Existing
  guard covers publication-time inputs, not a prior AI review snapshot. Agent evidence enforcement
  is conditional, and the code default is false; live DB settings were not inspected.
- Modified files this phase: the design report and docs/CODEX_HANDOFF.md only. Existing home/auth/UI/
  compose edits and untracked artifacts belong to other work; do not revert or stage them.
- Test actually executed:

```sh
npm test -- tests/evidence-worker.test.ts tests/evidence-scheduler.test.ts tests/agent-evidence-refresh-demand.test.ts tests/crawl-publication-guard.test.ts tests/crawl-publish-evidence.test.ts tests/crawl-agent-input.test.ts tests/agent-evidence-summary.test.ts
```

- Result: 7 files, 25 tests passed, exit 0. HTTP/LLM are mocked. Vite printed a future native-config
  loader compatibility warning; no config changes were made. Integration/build/E2E/load/24h tests
  and live crawler/deployment checks were not run. The integration setup truncates tables and must
  use the dedicated TEST_DATABASE_URL when implementation starts.
- Documentation validation executed: git diff --check for this handoff passed; a read-only check of
  the report/current handoff section passed whitespace, code-fence and placeholder checks. All 10
  referenced test paths and key existing source paths were found. Added idle workerSeenAt separately
  from lock/progress timestamps, and an explicit manual-review stop after the AI attempt cap.
- Failed approach: apply_patch rejected a delete+add targeting the same existing report path before
  mutation. Replaced it with a single update patch. No partial service changes occurred.
- Remaining: user reviews the corrected design; implementation begins only upon a subsequent request.
  Initial server sizes and load targets remain assumptions until measured. Plans A/B/C include
  bounded change lists, preservation criteria, migration and rollback limits.
- Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
cat docs/superpowers/specs/2026-09-08-independent-workers-and-capacity-design.md
git diff --check -- docs/CODEX_HANDOFF.md
```

## Compact development-clue design — 2026-09-07 KST

- User feedback: development AI is secondary. Hide the section when there is no evidence; when only
  `AGENTS.md`, `CLAUDE.md` or another instruction artifact exists, show only the observed file facts;
  append tool/model details in that same section only when they are supportable.
- Updated `docs/designs/2026-09-06-product-detail-full-redesign.html`. Removed the large dark AI panel,
  the four repeated unknown fields and the third unknown card in the evidence map. Replaced them with
  one compact `개발 지침 파일` row containing `AGENTS.md`, pinned commit, root scope and a concise
  `AI 사용 미확정` explanation.
- Verification: Playwright rendered desktop 1440px and mobile 390px with no console/page errors or
  horizontal overflow. It also asserted the development-clue section is shorter than the repository
  section. Screenshots: `/private/tmp/nomorevibe-detail-full-redesign-compact-ai-{desktop,mobile}.png`.
- Production components remain unchanged; wait for approval of the revised full-page mockup.

```sh
open http://127.0.0.1:8767/2026-09-06-product-detail-full-redesign.html
git diff --check
```

## Full product-detail redesign proposal — 2026-09-07 KST

- Current objective: explain why Drever's development-AI fields are unknown and redesign the entire
  lower product-detail area as an HTML proposal. Production React components were not changed.
- Drever scan 31 completed at pinned commit `502eff05d9b629370b51ee03cafceb571562e3c2`
  without collection issues. It found root `AGENTS.md`, but that catalog rule has `client=null` and is
  compatible with Codex, Kimi, Grok Build, OpenCode, GitHub Copilot, Cursor and Kiro. The parser
  intentionally does not interpret instruction prose as model configuration. No client-specific
  config, selected model, gateway or commit attribution was observed.
- The AI judge also requires a current product-site link back to exactly one matching repository.
  Drever has a repository-to-site homepage link, while its site fingerprint exposed no repository
  key, so the agent relationship remains `unknown`. `summarizeAgentEvidence` therefore returns
  `ai_evidence_insufficient`; `executionVerified` is intentionally always false for static public
  repository evidence.
- Created `docs/designs/2026-09-06-product-detail-full-redesign.html`. It keeps the approved editorial
  hero and redesigns product story, evidence map, development-AI reasoning, repository/languages,
  updates, and ownership CTA. The mock uses the actual Drever snapshot and labels public-page product
  claims separately from externally confirmed facts.
- Verification: static HTML returned HTTP 200 (29,569 bytes); Playwright found all five section IDs,
  verified anchor navigation, no console/page errors, no external requests, and no horizontal overflow
  at 1440px and 390px. Final screenshots are `/private/tmp/nomorevibe-detail-full-redesign-
  {desktop,mobile}-final.png`.
- Failed approach: the first QA one-liner read browser `location` in the Node context. Replaced it with
  `page.evaluate(() => location.hash)` and the verification passed.
- Remaining work: wait for user approval of this complete lower-page direction before changing the
  production components.

```sh
open http://127.0.0.1:8767/2026-09-06-product-detail-full-redesign.html
git diff --check
```

## Product detail editorial redesign COMPLETE — 2026-09-06 23:52 KST

- Current objective: implement the user's selected A (editorial profile) direction on the real
  product detail page. The local app now uses the new layout at `/p/drever`.
- `ProductHero` now renders the first mirrored media item as a large representative screen. When a
  product has no media row, a safe internal `/api/og-cache/...` copy is rendered at full width; only
  products with neither source receive the explicit empty state. Product description, tagline,
  provenance status, health, rank and actions are all visible beside the image.
- The separate duplicate gallery block was removed from the route. Metrics remain directly below the
  hero. The body now uses an editorial story column and an evidence sidebar; mobile DOM order remains
  product screen, description, factual evidence and updates.
- `ProductIntroduction` has the approved PRODUCT STORY hierarchy. Metrics are denser, and the evidence
  summary is shaped for the sidebar. No product facts or proposal-only mockup copy were invented.
- Modified for the implementation: `app/p/[slug]/page.tsx`, `components/product-detail/{ProductHero,
  ProductIntroduction,ProductMetrics,EvidenceSummary}.tsx`, `tests/{product-detail-components.test.tsx,
  e2e/product-detail.spec.ts}`. Design records: `docs/designs/`, `docs/superpowers/specs/
  2026-09-06-product-detail-editorial-design.md`, and `docs/superpowers/plans/
  2026-09-06-product-detail-editorial-implementation.md`.
- TDD evidence: the first component run failed 3 intended assertions; the OG fallback regression then
  failed 1 intended assertion. Final component run passed 16/16. Full unit suite passed 64 files and
  528 tests. TypeScript and ESLint passed.
- Product E2E rebuilt the standalone app and passed 3/3 after the final change, including contrast,
  keyboard target size, mobile reading order, internal image requests, no external provider requests,
  and no horizontal overflow. The build retains the pre-existing Turbopack whole-project tracing
  warning from `lib/crawl/classify.ts`; it is unrelated to this layout.
- Real Drever browser check: `/api/og-cache/drever` rendered at 747.47px wide on a 1440px viewport;
  desktop and 390px mobile had no page/console errors or horizontal overflow. Screenshots:
  `/private/tmp/nomorevibe-drever-editorial-{desktop,mobile}-final.png`.
- Failed approach fixed during verification: relying only on `detail.media` left Drever's large hero
  empty because it currently has only an internal OG copy. The fallback now promotes that safe copy.
- Remaining work: no code work remains for the chosen design. Remote production deployment remains
  governed by the existing P0 decisions in `PENDING.md`.

```sh
npm test -- tests/product-detail-components.test.tsx
npx tsc --noEmit
npm run test:e2e:product
npm test
npm run lint
open http://localhost:3000/p/drever
```

## Product detail A/B HTML concepts — 2026-09-06 23:36 KST

- Current objective: compare two redesigned product-detail directions before changing production UI.
- Created `docs/designs/2026-09-06-product-detail-ab.html` and copied the current Drever OG image to
  `docs/designs/drever-og.png` so the mockup is self-contained.
- Concept A is an editorial product profile with a large thumbnail, expanded product story, compact
  metrics, and a persistent evidence column. Concept B is a visual showcase with a dark image-led
  hero, expanded introduction, workflow sequence, and a quieter evidence timeline.
- The expanded Korean descriptions are proposal copy. The mockup explicitly says production must
  distinguish maker-provided claims from verified public sources.
- Actual application components were not changed. Wait for the user to choose A, B, or a hybrid
  before writing the production implementation plan and editing `app/p/[slug]` components.
- Verification executed: both static assets returned HTTP 200; Playwright opened both concepts at
  1440px and 390px, switched both tabs, found no console/page errors and no horizontal overflow.
  Screenshots are `/private/tmp/nomorevibe-detail-concept-{a,b}{,-mobile}.png`.
- Local preview server: PID 18009, `http://127.0.0.1:8767/2026-09-06-product-detail-ab.html`.

```sh
curl -I http://127.0.0.1:8767/2026-09-06-product-detail-ab.html
open http://127.0.0.1:8767/2026-09-06-product-detail-ab.html
git diff -- docs/designs docs/CODEX_HANDOFF.md
```

## Local crawler scheduler verified — 2026-09-06 23:05 KST

- The existing Docker scheduler is alive and its traditional crawler calls to the isolated Docker
  app (port 3200 / separate DB) return HTTP 200. It was not driving the development DB.
- The prior tool-session processes on port 3000 did not persist after that turn. Replaced them with
  detached local processes: Next dev PID 28962, evidence worker PID 28963, and full crawler
  scheduler PID 28965. PID files and logs are under `/private/tmp/nomorevibe-*`.
- The local scheduler targets `http://localhost:3000` every 60 seconds. Its first actual tick returned
  200 for crawl-fetch, crawl-judge, crawl-publish, crawl-seed, product-evidence-refresh, and
  agent-evidence-refresh. Development DB job rows show fresh `lastSuccessAt`, `lastError=null`, and
  no locks for all six jobs. TradingGoose returned HTTP 200 after startup.
- Keep in mind that the detached evidence worker and the full scheduler both invoke the two evidence
  jobs. DB leases make overlap safe; this is intentional for the user's explicit worker restart, but
  one of them can be removed later to avoid redundant no-op invocations.


## Local processes restarted — 2026-09-06 22:54 KST

- Restarted the latest local Next development server and evidence worker after terminating process
  groups 43023 and 58634 with SIGTERM.
- Next dev process group 99538, application PID 190, next-server PID 213; port 3000 is listening.
- Evidence worker PID 99541; its first cycle completed both jobs successfully. Agent evidence reached
  `done:true` with no error after resuming the stored cursor.
- Actual probes: `/` HTTP 200 and
  `/p/tradinggoose-visual-workflow-platform-for-llm-trading` HTTP 200.
- Current interactive exec sessions: server 28636 and worker 89957. PID files under `/private/tmp`
  were updated to 99538 and 99541. No remote service or Docker service was changed.

## Follow-up recheck and application COMPLETE — 2026-09-06

User requested another check/fix/apply pass. Parallel agents and root fixed additional concrete bugs,
reviewed them, applied the changes locally, and verified runtime continuation. Report:
`docs/reviews/2026-09-06-agent-followup-result.md`.

- Fixed unsaved pre-SHA budget exhaustion: explicit `budget_exhausted`, pending log and unchanged
  pagination cursor. HTTP timeout stays within the remaining deadline.
- Failed private/404/timeout rechecks now retain historical observations while invalidating the
  prior confirmation. Pure budget deferral does not invalidate a successful previous observation.
- Root reproduced four RED cases and fixed stale/future/invalid site timestamps and failed rechecks
  in `lib/crawl/agent-evidence.ts`. Publication repeats timestamp and last-error validation.
- Automatic judge writes now compare candidate/document/settings snapshots under locks. Concurrent
  admin decisions are preserved; explicit pre-existing admin state:new rejudge requests still work.
- Missing archive/fork/relationship values no longer imply active or connected. Recent failed HTTP
  checks no longer show online merely because the three-failure down threshold has not been reached.
- New changes in this pass: `lib/crawl/{agent-evidence,repository,publication-guard}.ts`, jobs/judge,
  agents/{collect,repository}, jobs/products/agent-evidence-refresh, products/detail-view,
  ProductHero/RepositoryEvidence components and their unit/integration regression suites.
- Runtime metadata audit: all 32 repository sources state=ok. Final browser audit: 32/32 products,
  desktop/mobile, 210 immutable citations matched stored visible observations, no JS errors/overflow.
  Agent collection is still in progress; 32 UI passes do not mean all 32 agent scans are complete.
- Worker75975 gracefully terminated and replaced by **58634** with the same command and log:
  `node --import tsx --env-file=.env.local scripts/evidence-worker.ts`,
  `/private/tmp/nomorevibe-evidence-worker.log`. DB cursor resumed from onlycastle/popdict, later
  advanced to rrzu777/agendita; job runs increased from 11 to 13, both lastError=null.
- Explicitly recollected formerly skipped capsule-zero: scan86 complete, no collection issues.
- Tests executed: unit 64 files/526 PASS; E2E production build +3 PASS (11.7s); type/lint/diff PASS.
  Final full integration: 41 files/405 PASS in 41.22s; log
  `/private/tmp/nomorevibe-recheck-integration-verified.log`.
- Failed approaches: initial read-only SQL template had an extra dollar sign; Drizzle query corrected
  it. Browser snapshot changed during active collection; post-browser DB verification confirmed all
  new citations. No service DB corruption or hidden source exposure was found.
- No new migration, commit or remote deploy. Local dev supervisor43023 remains on port3000.
- Required work is complete. Final integration, runtime process and document/diff checks passed.
  Factual unknowns and partial scans remain explicitly labeled; collection continues.

```sh
tail -n 6 /private/tmp/nomorevibe-recheck-integration-verified.log
git diff --check
ps -o pid,etime,command -p 58634
tail -n 15 /private/tmp/nomorevibe-evidence-worker.log
# Current worker PID is 58634; earlier sections below are historical.
```

## Current objective — implementation and live recrawl COMPLETE, 2026-09-06

The user authorized parallel implementation, independent review, restarting collection, and ten real
product checks. The implementation and live checks are complete locally. No commit or remote deploy
was performed. Read `docs/reviews/2026-09-06-agent-implementation-result.md` for the Korean report.

### Completed work and key decisions

- Added versioned artifact catalog, bounded parsers, and separate client/model developer/declared
  model/gateway/role/scope observations for Grok, Kimi, GLM, DeepSeek, OpenRouter and other clients.
  Files, configuration and commit attribution never establish actual execution. Shared formats,
  unknown/auto/inherit and subproject scopes are retained; maker declarations remain separate.
- Migration 0019 adds scans, observations and multi-signal discovery. Collection pins SHA, rechecks
  public visibility on resume, and stores safe projections without credentials, prompts or logs.
- Added repository link synchronization/backfill with generation, current URL and tombstone checks;
  site fingerprints, primary repository selection, source URLs/dates and stale observation labels.
- Added conservative eligibility and transactional publication guards. New admin decisions, source
  edits and settings changes cannot be overwritten by classification or early failure handling.
- Added durable search page/item/attribution cursors, split/incomplete windows, five provider hints,
  partial-first scheduling, bounded scheduler HTTP calls and a standalone evidence worker.
- Independently reviewed and fixed private collection, missing commit enrichment, same-SHA freshness,
  search budget loss, source selection, publication/backfill races and absent recurring collection.
- Backfilled 32 missing links. Ten real products have complete scans and metadata, with 141 facts
  (138 instruction files, 3 client configs). Two site/repository relations are confirmed, eight are
  unknown. No actual execution model is confirmed; none of these ten qualifies for automatic
  publication under the strict gate. Existing published products are preserved.
- Final browser verification passed for all ten products on desktop and 390px mobile: HTTP 200,
  no JavaScript errors or horizontal overflow, visible citations and accurate unknown labels.

### Modified files

- `lib/domain/evidence/agents/*`, `lib/db/agent-evidence-schema.ts`, schema exports,
  `drizzle/0019_agent_evidence.sql` and metadata, package.json/package-lock.json.
- `lib/crawl/{agent-evidence,publication-guard,search-window,github,rules,publish,settings,settings-schema}.ts`,
  `lib/crawl/jobs/{seed,fetch,judge,publish}.ts`, crawl schema reason types and admin status labels.
- `lib/domain/evidence/{repository-link-sync,repository,refresh}.ts`, providers/{github,site-fingerprint}.ts,
  `lib/domain/products/{repository,detail-view,health,health-freshness}.ts`, job registry/agent refresh.
- Product detail page, TrustBadges and BuildProvenance/EvidenceSummary/ProductHero components.
- `scripts/{scheduler.sh,evidence-worker.ts,backfill-agent-evidence.ts,verify-agent-evidence-live.mjs}`;
  new/updated unit and integration suites, README, PENDING, plan, this handoff and review artifacts.
  `git status --short` is the complete inventory; pre-existing uncommitted documents were preserved.

### Tests actually executed

- `npm test`: 63 files, 517 tests passed.
- `npm run test:integration`: final 41 files, 395 tests passed in 45.63 seconds at 09:25 KST.
  Log: `/private/tmp/nomorevibe-agent-integration-final-pass.log`. Two stale search-default
  expectations were corrected after a RED run, then the full suite passed.
- `npm run test:e2e:product`: production build plus 3 tests passed, final run 10.8 seconds.
- `npx tsc --noEmit`, `npm run lint`, `git diff --check` passed; final doc checks are repeated.
- `node scripts/verify-agent-evidence-live.mjs`: ten live products passed after collection fixes.
  TradingGoose screenshot `/private/tmp/nomorevibe-tradinggoose-agent-mobile.png` was opened and inspected.

### Failed approaches and corrections

- Concurrent TDD briefly exposed incomplete seed/UI types. Final targeted and full checks were rerun.
- Maker API test selected an arbitrary source by slug after adding site sources. Exact repository
  identity and deterministic external fixtures fixed the assertion; GitHub facts were preserved.
- Long-running Next dev cached the old Drizzle schema, causing 500 after the new table was accessed.
  Restarting the project development server resolved it; all ten pages subsequently passed.
- TradingGoose HTML was 1,169,782 bytes. Site fingerprint now reads up to 2MiB without truncating
  source-link analysis. Its explicit GitHub repository link confirms the product relation.
- Opanel's 100-release response was 2,800,798 bytes. The collector now requests 10 items, falling
  back to one while preserving pagination offset. The 2MiB transport cap remains unchanged.
- Both products were actually recollected after fixes. Initial failures are preserved in
  `docs/reviews/2026-09-06-agent-live-10-initial.json`; final rows and browser results have separate files.
- Python Playwright was unavailable; installed Node Playwright was used headlessly instead.

### Runtime and rollout

- Development DB: localhost:55434/nomorevibe, `.env.local`. Backup before migration:
  `/private/tmp/nomorevibe-before-agent-evidence-20260906.dump`. Migration 0019 applied successfully.
- Next development supervisor PID 43023, port 3000; log `/private/tmp/nomorevibe-dev-agent-evidence.log`.
  Only the prior project development parent 52359 was stopped.
- Evidence worker PID 75975, running `node --import tsx --env-file=.env.local scripts/evidence-worker.ts`.
  Log `/private/tmp/nomorevibe-evidence-worker.log`; PID file has the same basename plus `.pid`.
  Both jobs succeeded repeatedly with null lastError and saved DB cursors. Default wait is 60 seconds
  between cycles; the process stops when the Mac shuts down.
- Development flags collection/display/enforcement are all enabled. Five provider hints were explicitly
  merged without resetting user queries. General crawler enabled was already true and was preserved.
  The evidence worker does not run the new-candidate publication pipeline.
- Separate Docker app 3200/DB 55437/scheduler image and remote infrastructure were untouched.
  Destructive integration fixtures use only DB 55435.

### Remaining work and exact commands

Final integration and document checks are complete. No required work remains for the user's
ten-product request. Eight unresolved relationships and actual execution models
need stronger public evidence or maker declarations. Arbitrary monorepo scopes and external referenced
files remain outside coverage. The original plan's 50 representative repos, separate audit CLI,
per-task commits and remote deployment were not performed.

```sh
git status --short
tail -n 8 /private/tmp/nomorevibe-agent-integration-final-pass.log
git diff --check
ps -o pid,etime,rss,%cpu,command -p 75975
tail -n 20 /private/tmp/nomorevibe-evidence-worker.log
node scripts/verify-agent-evidence-live.mjs
# Read-only audit:
npx tsx --env-file=.env.local scripts/backfill-agent-evidence.ts --limit 1000
# Restart only if the old worker is no longer running:
node --import tsx --env-file=.env.local scripts/evidence-worker.ts
```

## Current objective — multi-provider agent evidence plan, 2026-09-06

User requested Grok, Kimi, GLM, DeepSeek, OpenRouter and other agent cases be checked, and a
concrete code modification plan reported. This phase is research and planning only, not execution
or deployment. The earlier audits below remain evidence snapshots, not a fresh production check.

- Completed: reviewed official provider/client documentation and current discovery, storage,
  judgement, publication, evidence refresh and provenance presentation code. Produced a Korean
  source-linked detection matrix/design and an implementation plan with Tasks 0–11, exact target
  paths, contracts, regression cases, future commands and rollout criteria.
- Modified files this phase: `docs/superpowers/specs/2026-09-06-agent-evidence-design.md`,
  `docs/superpowers/plans/2026-09-06-agent-evidence-implementation.md`, this handoff.
  Existing uncommitted `docs/reviews/` and prior handoff sections are preserved.
- Decisions: separate client, declared model ID/model developer, API gateway and evidence kind.
  Instruction/config presence is observed, never proof of execution. AGENTS and skills are shared;
  Claude Code may use GLM/DeepSeek/OpenRouter. Grok Build project config has narrower allowed scope
  than user model config. Kimi old/new documentation and Windsurf/Devin paths need versioned rules.
  Keep unknown/auto/inherit/unpublished settings unresolved. Runtime AI features are separate from
  AI-assisted development. Use bounded deterministic parsing, fixed commit SHA, secret-free facts,
  resumable scans and separate automatic observations rather than system provenance replacement.
- Corrected code understanding: maker replaceProductProvenance deletes only maker_reported rows;
  system authority can replace all rows. Do not describe maker edits as deleting every system row.
- Integration priorities: preserve commit trailers/multiple discovery evidence; repair repoUrl/link
  synchronization; implement missing site_fingerprint repositoryKeys writer and source-derived
  relationship/freshness; add explicit eligibility gate; produce dry-run correction rows and
  backfill without reviving maker-hidden/deleted links. Repo homepage alone is insufficient to
  transfer authorship evidence to a product; detached copies remain review candidates.
- Validation actually executed this phase: Python document inspection confirmed all 5 local links
  across the two new documents exist, code fences pair, and neither document has trailing spaces.
  Ran git diff --check with no diagnostics; final check is repeated after this handoff write.
  No new application tests, migration, build, backfill, DB mutation, deployment or commit ran.
  Earlier targeted PASS counts below belong to the previous review, not a new detector.
- Failed/corrected approaches: broad combined web searches often returned irrelevant/dominant
  results; used primary documentation and targeted opens/finds. Guessed Grok agents-md and Goose
  guide URLs failed; followed Grok's official project-rules link and Goose's official repository.
  Draft language inconsistency was corrected before delivery. Long scope strings were changed to
  a scope hash in the planned unique index. Added missing site-to-repository ingestion to Task 8.
- Remaining: all Tasks 0–11 are proposed and unchecked. No cross-provider live detection precision
  is established; implementation must validate synthetic counterexamples and a manually labelled
  real public-repository sample before changing automatic publication. Server deploy remains a
  separate subsequent phase under the prior infrastructure recommendations.

Exact next commands (read the plan before beginning authorized implementation):

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
cat AGENTS.md
cat docs/superpowers/specs/2026-09-06-agent-evidence-design.md
cat docs/superpowers/plans/2026-09-06-agent-evidence-implementation.md
cat tests/integration/setup.ts
cat node_modules/next/dist/docs/01-app/02-guides/self-hosting.md
git diff --check
```

The new tests/scripts named in the plan do not yet exist. Integration tests must use the separate
55435 test database, never the development database (55434) or local Docker database (55437).

## Current objective — AI eligibility and deployment review, 2026-09-06

User requested a second review of AI-related project detection, a fix list, and an assessment of
web/worker colocation and server sizing before deploying. This supersedes the intervening request
to deploy immediately: report before deployment. Review completed; deployment and fixes remain unperformed.

- Completed: traced discovery → queue → judgement → publication; sampled 100 Claude and 100 Codex
  GitHub search commits; compared canonical sites/repos; replayed 4,652 stored candidates read-only;
  inspected 24h Docker logs, restart/resource settings, database sizes and six resource samples;
  ran targeted unit/integration tests; produced an actionable fix list and deployment recommendation.
- Important findings: judgement has no AI evidence gate. Codex sample has 2/100 results without a
  Codex coauthor line (not an overall false-positive rate). Search evidence SHA/URL is discarded.
  Detached copies of vLLM/Vector pass with zero stars and unrelated canonical homepage. Current
  scheduler only calls the web process; it is not a separate worker. CLI category classification
  failed auth 184 times / 24h, with zero successful classifications. DB restart policy is `no`;
  curl has no total timeout. Uptime 15 targets/10min cannot meet 6h coverage for ~1,006 products;
  measured 479/1,004 checked rows overdue, oldest 11.40h.
- Snapshot: 4,652 candidates / 1,006 published (two new products arrived during the audit).
  Replay flags 12 published items under current rules: 5 placeholder titles, 7 old stored push
  times. These are not 7 confirmed offline sites; fresh metadata/review needed.
- Decisions: retain distinction between AI-made evidence and AI-powered functionality. Unknown
  evidence/relationship should be held for review. Start with same host, separate web/actual worker/
  DB containers; propose 4 vCPU / 8GB / 80GB with external builds and single CLI/image concurrency.
  Sizing is a planning estimate, not a proven capacity. Worker-only API design could be smaller.
- Modified files this phase: `docs/reviews/2026-09-06-ai-crawler-deployment-review.md`,
  `docs/reviews/2026-09-06-ai-crawler-deployment-evidence.json`, this handoff. Prior audit retained.
- Tests executed: unit `crawl-rules`, `classify`, `github-evidence`: 3 files / 64 PASS.
  Dedicated DB 55435 integration `crawl-seed`, `crawl-fetch`, `crawl-judge`, `crawl-publish`,
  `crawl-pipeline`, `crawl-review`: 6 files / 76 PASS. No full suite/build/max-load/reboot test.
- Failed/corrected analysis: initial exact prefix missed `OpenAI Codex`; corrected provider-name
  coauthor-line check yields 98/100. One temporary log-summary JS syntax error corrected and rerun.
- Remaining: implement the report's AI/EV/OP fix list, confirm real provider classification, clean
  existing bad records through review, package actual worker and backfill, then deployment staging
  and reboot/recovery/load validation. No app/dev DB or Docker deployment mutations were made;
  only the explicitly separate integration test DB was reset by existing test fixtures.

Exact next commands:

```sh
git status --short
cat docs/reviews/2026-09-06-ai-crawler-deployment-review.md
cat docs/reviews/2026-09-06-ai-crawler-deployment-evidence.json
cat AGENTS.md
cat node_modules/next/dist/docs/01-app/02-guides/self-hosting.md
npx vitest run tests/crawl-rules.test.ts tests/classify.test.ts tests/github-evidence.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/crawl-seed.test.ts tests/integration/crawl-fetch.test.ts tests/integration/crawl-judge.test.ts tests/integration/crawl-publish.test.ts tests/integration/crawl-pipeline.test.ts tests/integration/crawl-review.test.ts
```

## Earlier review context

## Current objective — 2026-09-06 crawler/evidence audit

User asked whether the crawler is running and requested an overall review to show more confirmed
information, using `/p/tradinggoose-visual-workflow-platform-for-llm-trading` on localhost:3000.
The review is complete; implementation and data backfill have not been performed.

- Completed: compared development and Docker DBs/jobs/logs, reproduced public pages with Playwright,
  queried the actual due-product selector read-only, checked TradingGoose's live GitHub APIs/site,
  traced ingestion/read-model/label/scheduler gaps, and documented prioritized remediation.
- Findings: localhost:3000 uses DB 55434 (crawler last ran Aug 18; evidence job never ran).
  Docker localhost:3200 uses DB 55437 and its scheduler is active. Development has 32 repository
  products but zero evidence links; Docker has 1,004 repository products but only one evidence link.
  Publishing/basic registration writes repo_url without linking product_links. Source success does
  not update the link state used by public badges. Old health checks still render as online.
- Modified files: this handoff and `docs/reviews/2026-09-06-crawler-evidence-audit.md` only.
- Decisions: preserve maker/discovered provenance; distinguish observed repository facts, product
  relationship, and mere URL reachability. Do not convert AI authorship inference into verification.
  Review recommends backfill plus ongoing synchronization, consistent source-derived presentation,
  health freshness, shorter worker ticks, and explicit ingestion coverage metrics.
- Tests: `npx vitest run tests/github-evidence.test.ts tests/evidence-links.test.ts tests/product-detail-components.test.tsx`
  executed 2 existing files / 18 tests, all passed. The evidence-links path does not exist and added
  no coverage. Two public browser pages returned 200 with zero pageerrors. GitHub's five read
  endpoints returned 200; website returned 200 after redirect. No integration/full-suite/build run.
- Failed approaches: agbrowse unavailable; browser wrapper's cli.mjs missing. Used installed
  Playwright successfully. Initial enabled-column SQL failed; corrected to values->>'enabled'.
- Remaining: all remediation in the review is proposed, not implemented. No app/DB/scheduler
  mutation, deployment, or commit was made. Existing dev server remains available at port 3000.

Exact next commands (inspection first; test DB must remain separate for any implementation):

```sh
git status --short
cat docs/reviews/2026-09-06-crawler-evidence-audit.md
cat AGENTS.md
rg --files node_modules/next/dist/docs | head -30
sed -n '175,240p' lib/domain/evidence/refresh.ts
sed -n '75,122p' lib/crawl/publish.ts
sed -n '440,490p' lib/domain/products/detail-view.ts
npx vitest run tests/github-evidence.test.ts tests/product-detail-components.test.tsx
```

The implementation history below is retained as historical context; its completion statements do
not establish end-to-end real-data ingestion, as the Sep 6 audit demonstrated.

## Historical implementation context

## Current objective

Execute plan 3, `docs/superpowers/plans/2026-08-19-product-detail-ui-implementation.md`, and show the
finished white-theme, global minimum-13px product-detail screen in the browser.

Plan 2, `docs/superpowers/plans/2026-08-19-product-evidence-pipeline-implementation.md`, is complete.
Plan 3 Tasks 1–8 are implemented, the exact final matrix is green, and the seeded rich product
screen is open from an isolated standalone server. The evidence-based public product page, global
light-first/13 px UI contract, distributable maker-evidence skill, and desktop/mobile Playwright
release contract are complete. The only local follow-up is retrying the independent diff review
after the Codex usage window resets; the attempted review returned no verdict.

## Completed work

Plan 3 commits and completed phases:

1. `6058fa2 test: prepare product detail browser coverage`
2. `e6eeae4 feat: let makers manage product evidence`:
   authenticated/capped profile, link, media, provenance, maker-update, and refresh resource APIs;
   transactional audit writes; asynchronous external-media declarations; maker-update tombstones;
   per-product-generation and optional trusted-proxy IP rate limits; stale in-flight media response
   rejection through declaration ID/revision checks.
3. `85fdb48 feat: administer product evidence`:
   protected `/admin/evidence` settings and `/admin/products/[slug]` evidence controls; safe
   authenticated Server Actions; immutable settings/update audits; explicit maker-versus-observed
   license conflicts; source freshness, media, update, provenance, and audit views; aggregate
   due/stale/failed evidence status; and a production-supported `server-only` boundary marker.
4. `4817b65 feat: compose product detail read model`:
   one server-only public read contract for safe product identity, stored season rank, seven-day
   valid/unique visits, 30-day health, profile, current visible links and evidence, internally
   mirrored media, visible updates, provenance, license comparison, and freshness states. Public
   identity queries explicitly omit verification/edit credentials and reject banned rows; a final
   generation/status check discards data assembled across a concurrent ban or slug replacement.
5. `66eace7 feat: show evidence-based product details`:
   dynamic `/p/[slug]` composition with current rank, seven-day unique/valid visits, health,
   compact evidence summary, internally mirrored gallery, sanitized structured introduction,
   objective links, repository/license facts, agent/skill provenance, freshness, and filterable
   updates. It keeps one mobile reading order, places the same nodes into a two-column desktop grid,
   preserves claim/takedown notices, and adds no phase-2 comment or login surface.
6. `de5306b style: enforce light 13px interface`:
   makes light tokens unconditional while preserving an explicit future dark override and the
   deliberate `.surface-dark` terminal; enforces the 13 px visible-text floor; reduces ordinary
   section radii to 12 px while preserving the 14 px product hero and 10 px metric cards; sets
   product prose to 15 px and structured/update copy to 14 px; adds global keyboard focus and
   reduced-motion behavior; and tests muted-text contrast across every light surface.
7. `edbcfc8 feat: extend nomorevibe evidence skill`:
   adds profile, links, media, provenance, update, and refresh commands without changing existing
   registration/verification/deletion behavior. Every maker replacement first reads a private,
   authenticated merge baseline, previews additions/changes/kept/deleted values, and requires
   confirmation. GET returns a strong content ETag; PUT requires the matching `If-Match` and rejects
   stale replacement with 412 inside the same lifecycle/resource lock. Credential storage is keyed
   by API origin then slug so an untrusted project file or a second registry cannot redirect or
   overwrite an edit token. Provenance remains explicit opt-in, metadata-only, maker-reported, and
   ranking-neutral; Git commit IDs accept full SHA-1 or SHA-256 while content hashes remain SHA-256.
8. Task 8, `docs: release evidence product profiles`:
   adds serial Playwright coverage for rich, collecting, stale/conflict, and unclaimed profiles at
   1440 px and 390 px; proves light mode, 13 px minimum visible text, WCAG AA text contrast,
   approved 14/12/10 px radii, 15 px prose, 14 px structured/update copy, mobile reading order,
   internal-only media, no provider requests, no horizontal overflow, no timeline connector,
   visible keyboard focus, 44 px controls, and no comment surface. Browser QA found and fixed the
   update filters' 36 px hit target by raising it to 44 px. The E2E server runs the same standalone
   production artifact used by deployment.

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

Plan 3 Task 4 files:

- `lib/domain/products/detail-view.ts`
- `tests/integration/product-detail-view.test.ts`
- `tests/integration/setup.ts`

Plan 3 Task 5 files:

- `app/p/[slug]/page.tsx`
- `app/p/[slug]/TakedownForm.tsx`
- `components/product-detail/*.tsx`
- `components/product-detail/format.ts`
- `tests/product-detail-components.test.tsx`
- `vitest.config.ts`

Plan 3 Task 3 files:

- `app/admin/AdminNav.tsx`
- `app/admin/evidence/page.tsx`
- `app/admin/evidence/EvidenceSettingsForm.tsx`
- `app/admin/evidence/actions.ts`
- `app/admin/products/ProductRow.tsx`
- `app/admin/products/[slug]/page.tsx`
- `app/admin/products/[slug]/EvidenceProductActions.tsx`
- `app/admin/products/[slug]/actions.ts`
- `app/admin/status/page.tsx`
- `lib/domain/evidence/admin.ts`
- `package.json`
- `package-lock.json`
- `tests/admin-evidence.test.ts`
- `tests/evidence-admin-components.test.ts`
- `tests/integration/evidence-admin.test.ts`

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

Plan 3 Task 7 files:

- `README.md`
- `app/api/products/[slug]/{profile,links,media,provenance}/route.ts`
- `app/api/products/[slug]/maker-route.ts`
- `app/install.sh/route.ts`
- `app/skill.md/route.ts`
- `lib/domain/evidence/contracts.ts`
- `lib/domain/evidence/maker.ts`
- `lib/domain/evidence/repository.ts`
- `lib/domain/evidence/resource-version.ts` (new)
- `skill/SKILL.md`
- `tests/evidence-contracts.test.ts`
- `tests/integration/maker-evidence-api.test.ts`
- `tests/skill-contract.test.ts` (new)
- `docs/CODEX_HANDOFF.md`

Plan 3 Task 8 files:

- `.gitignore`
- `components/product-detail/UpdateTimeline.tsx`
- `playwright.config.ts`
- `tests/e2e/product-detail.spec.ts` (new)
- `docs/CODEX_HANDOFF.md`

Plan 2 Task 8 commit files:

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

- Product-detail browser coverage builds once and serves `.next/standalone/server.js`, copying
  `public` and `.next/static` into the standalone directory as the production image does. This
  avoids a second `next dev` process and exercises the deployable SSR artifact.
- Browser tests attach request/error observers before navigation and treat any non-local request as
  a failure. Gallery assertions require `/api/media/<hash>`, so rendering cannot silently regress
  to volatile provider URLs.
- Accessibility checks inspect computed, visible text sizes and composite foreground/background
  contrast rather than relying only on source classes. Interactive share, outbound, and update
  filter controls must render at least 44 px high and expose a keyboard-visible outline.
- Comments and unified end-user authentication remain phase two. Task 8 explicitly verifies that
  no comment surface leaked into phase one.
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
- Maker replacement APIs use a strong SHA-256 content ETag over the exact authenticated GET body.
  A valid PUT requires that ETag in `If-Match`; the writer recomputes it after acquiring lifecycle
  then resource advisory locks and returns 412 before any mutation when it is stale. Missing
  preconditions return 428. System-observed provenance does not invalidate or get deleted by the
  maker-only comparison.
- Edit-token credentials are stored as `origin → slug → token`. Project `.nomorevibe.json` data may
  select an already-bound origin/slug pair but can never supply the authenticated destination.
  Legacy unbound credentials are not sent until the user explicitly trusts and migrates them.

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

Task 3 administrator boundaries:

- Every page and Server Action authenticates before any evidence read, refresh, setting write, or
  visibility mutation. Page protection is not treated as action protection.
- Force refresh returns only bounded counts and a completion flag; provider bodies and thrown
  errors are never serialized to the browser.
- Automatic update visibility changes run under the reusable-slug product-generation lock and
  append a new audit row. Maker updates remain exclusively controlled by the maker API.
- Admin evidence reads expose only normalized fact subsets and safe error codes. Raw provider
  responses are not part of the read model.
- Admin evidence UI is white-theme compatible, uses reduced 10–12 px radii, and contains no text
  utility below 13 px.

Task 4 public read boundaries:

- `PublicProduct` is an allowlisted projection; public detail code never loads `verifyToken`,
  `verifyMethod`, or `editTokenHash`.
- Evidence sources must still match a visible current product link by slug, kind, and normalized
  key. Removed/replaced repository facts cannot remain public merely because the source row exists.
- Failed refresh state takes precedence over age labels while last-known-good normalized facts stay
  available. Disconnected, collecting, delayed, stale, and current remain distinct states.
- Agent and skill rows are read lock-free and in parallel. Public reads do not enter the writer's
  provenance transaction/advisory lock.
- The first identity read is request-cached for metadata/page reuse; the final uncached allowlisted
  identity read must find the same numeric product ID and a non-banned status before returning.
- Rendering reads PostgreSQL only. It never calls an external provider or serves an external media
  URL.

Task 5 presentation boundaries:

- Only gallery rows already mirrored to `/api/media/<hash>` render as images; stored dimensions,
  eager first image, lazy later images, and last-copy missing-source notices are explicit.
- Markdown skips raw HTML, uses GFM plus sanitization, removes all image nodes, and renders only safe
  HTTP(S)/internal links. Maker Markdown cannot cause third-party image requests.
- Both visible site link and primary action use `/go/[slug]`, so every outbound product visit uses
  the same first-party measurement path.
- Unclaimed crawler content says `자동 감지`/`우리 추정`; claimed maker content says
  `메이커 제공·미검증`/`신고값`. A GitHub-confirmed badge requires parsed observed facts, not just
  a pending or failed source row.
- `validVisits` remains independently measurable before unique-browser collection starts; only
  unique values say `집계 중`, and the valid-visit card states this distinction.
- The timeline filter is the only detail client state besides sharing and takedown. There is no
  connecting vertical line, no comment placeholder, and touched detail text never uses <13 px.

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

Plan 3 Task 3 RED/fix history actually observed:

- the first unit and integration runs failed because the new admin pages/domain module did not
  exist;
- after implementation, Vitest could not resolve the documented Next `server-only` marker because
  the package was not installed; `server-only@0.0.1` was added as a production dependency and the
  client component test mocked its Server Action boundary;
- the first evidence-admin integration run had two real failures: audit assertions depended on
  unspecified row order, and a raw Drizzle SQL template bound a JavaScript `Date` where the
  postgres driver required a serialized timestamp. The test now orders audit IDs explicitly and
  the query binds an ISO string cast to `timestamptz`.

Plan 3 Task 3 final verification actually run:

```text
npx vitest run tests/admin-evidence.test.ts tests/evidence-admin-components.test.ts
  PASS — 2 files, 7 tests
npx vitest run --config vitest.integration.config.ts tests/integration/evidence-admin.test.ts
  PASS — 1 file, 4 tests
npx vitest run --config vitest.integration.config.ts tests/integration/evidence-admin.test.ts tests/integration/product-evidence-lifecycle.test.ts tests/integration/product-evidence-repository.test.ts tests/integration/evidence-refresh.test.ts tests/integration/product-evidence-schema.test.ts tests/integration/product-media.test.ts tests/integration/maker-evidence-api.test.ts tests/integration/github-evidence.test.ts
  PASS — 8 files, 62 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/admin/evidence` and `/admin/products/[slug]` dynamic
git diff --check
  PASS
```

Plan 3 Task 4 RED/fix history actually observed:

- the first target run failed because `lib/domain/products/detail-view.ts` did not exist;
- the first implementation passed once, then the immediate rerun hit duplicate `product_health`
  rows because shared `resetTables()` omitted that table; adding it to the common TRUNCATE restored
  isolation;
- first review regressions reproduced five failures: credential-bearing/banned full product rows,
  orphaned evidence winning over the current link, failed sources shown as collecting/stale, and a
  public provenance read blocked on the writer advisory lock;
- the next review found a concurrent-ban/generation race and a timing-based 250 ms lock test that
  could flake. A deterministic mocked first identity read reproduced the race; the implementation
  now does a final uncached same-ID/non-banned projection. The lock test now spies on the initialized
  Drizzle transaction method instead of comparing wall-clock duration;
- the first concurrent-ban test double returned a Promise where Drizzle's `findFirst` signature is
  a thenable query, so runtime tests passed but `tsc` failed. The cast is now isolated at the test
  double boundary and the full target/type checks pass.

Plan 3 Task 4 final verification actually run:

```text
npx vitest run --config vitest.integration.config.ts tests/integration/product-detail-view.test.ts
  PASS — 1 file, 9 tests; repeated in a separate process
npx vitest run --config vitest.integration.config.ts tests/integration/product-detail-view.test.ts tests/integration/clicks.test.ts tests/integration/uptime.test.ts tests/integration/ranking-view.test.ts tests/integration/product-provenance.test.ts tests/integration/product-updates.test.ts
  PASS — 6 files, 84 tests
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
git diff --check
  PASS
```

Plan 3 Task 5 RED/fix history actually observed:

- the component target initially was not discovered because the unit config matched only `.test.ts`;
  the include now supports both `.test.ts` and `.test.tsx`, after which missing components produced
  the intended RED;
- two first assertions were incorrect: a legitimate measured `validVisits: 0` was treated as a
  false zero, and `border-line` was mistaken for a vertical `border-l` utility. The contracts now
  inspect the correct semantics/source pattern;
- first review found five P2s. Four reproduced as RED: crawler content labeled as maker-provided,
  GitHub confirmation on an unobserved source, external Markdown image requests, and the displayed
  site URL bypassing `/go`. The fifth was resolved as a documented domain distinction: valid visits
  predate unique-visitor collection and a real zero remains visible with an explanatory note.

Plan 3 Task 5 final verification actually run:

```text
npx vitest run tests/product-detail-components.test.tsx tests/schema.test.ts
  PASS — 2 files, 20 tests
npx vitest run --config vitest.integration.config.ts tests/integration/product-detail-view.test.ts
  PASS — 1 file, 9 tests
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/p/[slug]` dynamic
git diff --check
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
- Task 3's first read-only `codex review --uncommitted` reran the 7 unit tests, 4 integration tests,
  TypeScript, focused ESLint, and the production build successfully, but spent the rest of its
  three-minute bound reading the broad review workflow and returned no final verdict. A second
  `gpt-5.6-sol` high-effort focused read-only run inspected only the Task 3 boundaries but again
  reached the bound without writing its requested last-message file. Neither attempt is claimed
  as CLEAN, and neither modified the repository.
- Task 4's first focused review returned two P1 and three P2 findings: secret/banned product row
  exposure, orphaned evidence, failed-state precedence, and the locking sequential provenance read.
  All were reproduced before fixes. Re-review found two P2s—the concurrent ban/generation race and
  a 250 ms test oracle—and both were reproduced or replaced with deterministic checks. Final narrow
  re-review returned `CLEAN`; its own target test could not start in the read-only sandbox because
  Vitest could not create a temporary directory, so no reviewer-run test pass is claimed.
- Task 5's first focused review found five P2s. Four were fixed after RED reproduction; the
  collecting-valid-visits concern was reconciled with the independent click-event contract and the
  UI now explains it. Narrow re-review returned `CLEAN`. Both Task 5 review sandboxes were unable to
  create Vitest's temporary SSR directory, so no reviewer-run test pass is claimed.
- Task 6's first review found one P2: unconditional light mode made 13 px muted text only 4.14:1
  on `--bg-soft`. A RED contrast test reproduced it; `--text-3` changed from `#6b7488` to
  `#636d80`, giving at least 4.60:1 across `--bg`, `--bg-soft`, and `--bg-card`. Final review
  returned `No actionable defects were found` and independently reran unit tests, lint, build,
  and diff checks successfully.
- The first Task 6 review invocation tried to combine `--uncommitted` with a positional prompt and
  failed immediately because this CLI rejects that combination. Bare `codex review --uncommitted`
  worked. Its optional browser probe could not launch Chromium in the review sandbox because the
  macOS Mach rendezvous port was denied; browser coverage remains Task 8 and no browser pass is
  claimed here.
- Task 7 review iterations found and fixed: 40-character Git SHA-1 rejection; omitted maker license
  payload; replacement PUTs without a server baseline; unsupported non-GitHub repository proposals;
  project-controlled credential destinations; stale product-generation reads; unserialized
  provenance baselines; maker/system provenance identity collisions; same-slug credentials
  colliding across API origins; and finally GET-to-PUT stale replacement. The final P1 was
  reproduced with all four resources before adding ETag/`If-Match` compare-and-swap.
- The first Task 7 concurrency regression held a PostgreSQL advisory lock but released it after an
  assertion. When that assertion failed, the test process waited indefinitely. Only the matching
  Vitest processes were terminated; the fixture now releases the lock in `finally` before asserting
  the result.
- A Task 7 review-side `npm test -- --runInBand` attempt failed because Vitest does not support that
  Jest option. The reviewer then ran the correct `npm test` command and it passed.
- The post-P1 Task 7 Codex re-review could not start because the CLI account reported its usage
  limit and asked to retry after 12:30 PM. It is not claimed as CLEAN. The corrected diff was
  manually traced across all four GET/PUT bodies and lock boundaries, and the regression plus full
  matrix below passed; Task 8 must run a fresh complete-diff independent review when capacity is
  available.
- Running two integration Vitest processes in parallel against the same database made each process
  truncate the other's fixtures, causing false missing-row/duplicate-singleton failures. Related
  integration tests are intentionally run sequentially from here onward.
- The first Task 3 review command tried to combine this CLI build's `--uncommitted` flag with a
  positional prompt and failed immediately because that combination is rejected despite the help
  usage text. The retry used the supported bare `--uncommitted` form.

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
- Task 8's first Playwright server used `next dev` and failed before tests because the user's
  existing development process already held this repository's Next lock. That process was left
  untouched; the browser suite now builds and serves an isolated standalone artifact on port 43127.
- The first contrast RED came from the test helper compositing opaque ancestor backgrounds in the
  wrong order, not the UI. Correcting the compositor exposed the actual UI RED: update filter
  buttons were 36 px high. They are now 44 px and covered at both viewport sizes.
- A programmatic `.focus()` check did not activate the browser's `:focus-visible` state. The test now
  starts from the document and uses real Tab navigation until the share control receives focus.
- An intermediate E2E server used `next start`, which passed but warned that standalone output must
  use `.next/standalone/server.js`. The final server follows that deployment contract and the full
  three-case browser suite passed again.
- The required final `codex review --uncommitted` reached the CLI but exited immediately because the
  account usage limit had been reached; it requested a retry after 12:30 PM. No Codex verdict or
  reviewer-run test result is claimed. A manual read of the five-file Task 8 diff found no P1/P2,
  but the independent review remains an explicit follow-up rather than being relabelled CLEAN.

## Task 6 verification

```text
npx vitest run tests/ui-contract.test.ts
  RED — 1/5 failed before the contrast fix; #6b7488 on #f7f8fb was 4.415:1
  PASS — 1 file, 5 tests after the fix
npm test
  PASS — 36 files, 316 tests
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; /p/[slug] remains dynamic
git diff --check
  PASS
codex review --uncommitted
  CLEAN — No actionable defects were found
```

## Task 7 verification

RED failures actually observed during Task 7/review:

- missing distributed skill contract and command documentation;
- full Git SHA-1 rejected and maker license absent from the profile proposal;
- merge-ready GET endpoints absent, non-GitHub repository proposal allowed, and replacement capable
  of erasing unknown current fields;
- project-controlled API destination could receive a global edit token;
- replacement-generation reads, provenance read serialization, and stronger retained skill identity
  preservation failed;
- credentials keyed only by slug collided across API origins;
- authenticated GET returned no ETag and a stale second full-replacement PUT overwrote the first.

Final verification actually run on the current Task 7 code:

```text
npx vitest run tests/skill-contract.test.ts tests/evidence-contracts.test.ts
  PASS — 2 files, 39 tests (before the final ETag regression; final skill target: 8/8)
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts tests/integration/product-provenance.test.ts
  PASS — 2 files, 14 tests before the final ETag regression
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts -t 'rejects stale merge-and-replace writes'
  RED — GET ETag missing
  PASS — 1 passed, 11 skipped after the fix
npx vitest run --config vitest.integration.config.ts tests/integration/maker-evidence-api.test.ts
  PASS — 1 file, 13 tests after the fix
npm test
  PASS — 37 files, 324 tests
npm run test:integration
  PASS — 34 files, 345 tests
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm run lint
  PASS — 0 errors, 0 warnings
npx tsx -e 'import("./app/install.sh/route.ts").then(async ({GET}) => { process.stdout.write(await (await GET(new Request("https://registry.example/install.sh"))).text()); })' | sh -n
  PASS
npm run build
  PASS — Next.js 16.3.1; maker evidence routes and `/p/[slug]` remain dynamic
git diff --check
  PASS
```

Expected suite output remains the existing Vite native config-loader warning and intentional
failure-path logs. No test command above is claimed beyond the result actually observed.

## Task 8 verification

Fixtures and screenshots:

- `e2e-rich`: complete objective repository/license facts, seven-day unique/valid visits, internal
  gallery, maker/automatic updates, agent and skill provenance;
- `e2e-collecting`: explicit collecting/empty media and repository states;
- `e2e-stale-conflict`: explicit stale, disconnected, down, and license-conflict states;
- `e2e-unclaimed`: explicit unclaimed and missing maker introduction states;
- desktop screenshot: `/private/tmp/nomorevibe-product-rich-desktop.png` at 1440 px;
- mobile screenshot: `/private/tmp/nomorevibe-product-rich-mobile.png` at 390 px.

Both screenshots were opened and visually inspected after the passing run. The desktop is a white
two-column evidence profile with reduced radii and card-based updates without a left connector. The
mobile page has no horizontal overflow and follows gallery → introduction → facts → repository /
license → provenance → freshness → updates after the hero, metrics, and evidence summary.

After the release commit, an isolated standalone server was started at
`http://127.0.0.1:43128/p/e2e-rich` against the seeded test database. A direct HTTP probe returned
200 and the URL was opened in the user's macOS browser. The user's existing port-3000 development
server was not stopped or modified. The standalone process is a local session, not a durable deploy.

Final matrix actually executed on the Task 8 code:

```text
npx next typegen
  PASS
npx tsc --noEmit
  PASS
npm test
  PASS — 37 files, 324 tests
npm run test:integration
  PASS — 34 files, 345 tests
npm run test:e2e:product
  PASS — 3 tests in 9.1s using the final standalone server
npm run lint
  PASS — 0 errors, 0 warnings
npm run build
  PASS — Next.js 16.3.1; `/p/[slug]` remains dynamic
git diff --check
  PASS after the Task 8 handoff update
```

The E2E assertions cover computed minimum font size, light color scheme, exact radius/type scale,
WCAG AA text contrast, 44 px controls, keyboard focus, descriptive/internal media, update filters,
mobile order, no overflow, no external provider requests, and no console/page errors. The expected
build-time `NO_COLOR`/`FORCE_COLOR` warnings remain non-failing.

## Remaining work

- After the Codex usage window resets, rerun the independent diff review and fix any actionable
  P1/P2 through RED tests; the current attempt returned no verdict.
- Comments and unified end-user authentication remain phase-2 design only; no comment persistence,
  reactions, follows, or login integration belongs in phase 1.

External blockers remain in `PENDING.md`: category classification API verification and production
scheduler/provider-token verification, production `VISITOR_HASH_SECRET` activation, and real-source
smoke checks. Do not claim any complete without external access.

## Exact commands for the next agent

```sh
git status --short
cat docs/superpowers/plans/2026-08-19-product-detail-ui-implementation.md
git diff --check
codex review --uncommitted
# if review finds P1/P2: add a RED regression, fix, and rerun the relevant target plus full matrix
```
