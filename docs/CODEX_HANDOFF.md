# Codex handoff

## C-track implementation verified, release in progress — 2026-09-13 01:35 KST

- C1 production applied318/0 skipped under approved existing policy; 30min observation still due at16:41:36Z.
- C2 production0030 migration successfully applied directly to5432. At16:33:05Z all5995 products backfilled; public eligible bands78/65/61/45, personal23/17/9/15. C4 conditional expansion not triggered: all four default groups already exceed10. Existing12queries/pagesPerTick2 unchanged.
- C3 implementation and final review corrections: optimistic checkbox state, actual evidence anchor, reuse detail public observed facts including stale/relationship qualifiers, repository change-and-return CAS guarded by exact DB updated_at, latest locked repo used when clearing stats.
- Tests executed: full unit116/897 PASS, integration64/587 PASS; expanded focused9/9 PASS (includes public setting/link hiding/old evidence and change-return race); TSC+targetedESLint+diffcheck PASS. New Playwright3/3 PASS with1440/390px screenshots visually inspected. Final browser regression run now includes home-redesign and product-detail.
- Failure fixed in test setup: server-only module needs same vi.mock used by existing detail integration tests. No application workaround.
- Modified files: git status plus app/p/[slug]/page.tsx anchor and lib/domain/products/detail-view.ts shared evidence helper; docs/operations/2026-09-13-popular-projects.md tracks whole requirement review. ProductHero and user design artifacts remain excluded.
- Remaining: commit explicit files/PR/merge, deploywebM3+mini/crawler/publisher/scheduler (web autoDeploy is true, DB already ready), inspect deployments and public https://nomorevibe.brut.bot, run30min receipt observation, update finalreport/handoff. Production migration helper `/tmp/nomorevibe-migrate.py` only transforms the verified existing host's6432→5432 in childenv; no secrets on disk.
- Next commands: `tail -15 /tmp/nomorevibe-popular-e2e-final.log`; `git diff --check`; `python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/observe-stars.ts`. Native Chrome currently user other task; use new browser tab or repository Playwright live smoke, do not alter their tab.

## C-track full implementation in progress — 2026-09-13 01:28 KST

- Objective: user authorized C1 apply, then requested the entire document implemented, deployed and checked on screen, followed by another omission review. No further approval needed for that scope.
- Production C1: maxStars 2000→99999 saved 2026-09-12T16:10:44.910Z. Reviewed 318-row plan applied: 318 changed, 0 skipped. Receipt `.crawl-samples/stars-prod-receipt-20260913.json`. At 16:17:41Z (~6 min): published123, approved112, needs_review15, new19, rejected49. These are actual pipeline states, not AI approval claims. Observe again after16:41:36Z.
- C2/C3 implemented locally: migration0030 stars/stars_at/owner_type/stars_checked_at + latest document backfill + indexes; publisher writes stats; repository URL edits clear stats; bounded crawler refresh job scheduled every5min; home four10-item lists; /popular fifteen-row table; URL-preserved personal filter/tier/page; methodology and responsive13px styles.
- Tests executed: new stars unit3 PASS; new popular integration7 PASS including backfill, failure throttle, quota cursor and repository-edit race. TSC and targeted ESLint PASS before latest test additions. Full unit and new Playwright are currently running; do not claim passed until exit checked.
- Modified files: see git status, C1 files in previous entry plus new stars/popular domain modules, stars refresh job, schema/migration0030, home/popular UI and tests. User preexisting ProductHero.tsx edit and nomorevibe-final artifacts must remain unstaged. No commits/push/deploy yet.
- Decisions: retain existing AI policy. Do not fabricate B-track commit streaks; show actual stats check date and link to evidence. C4 discovery expansion remains conditional on actual C1 band fill and existing source settings.
- Remaining: finish UI QA + visual inspection; repair evidence anchor; review table evidence requirements; full test suite; C4 decision/config; C1 30min observation; final code/requirements review; commit PR merge; direct DB migration0030; deploy both web instances and affected singleton workers; verify live screen/health and record exact outcomes.
- Failed approaches: initial missing-module tests were RED as expected; one test fixture omitted required health.status and was corrected. Artifact HTTP fetch returned shell/Cloudflare, native Chrome CUA successfully read original and mock.
- Production helper `/tmp/nomorevibe-prod-db.py` reads Dokploy keychain and supplies DB URL to child env only. Never print secrets or app env. Relevant IDs: webM3 oipo2OAnIrtcnILBCRoG2, webMini llv4rlABSJOcFauSxaHdx, crawler AFHDBGCCY4zT9XkkcnzGd, publisher AeTaWnZbZKzzv94h7c8Vw, scheduler uAjLU7MslLIGpORD9h6LQ. Deploy API uses direct curl per prod skill.

Exact continuation commands:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
tail -30 /tmp/nomorevibe-popular-e2e.log
tail -10 /tmp/nomorevibe-popular-unit.log
python3 /tmp/nomorevibe-prod-db.py npx tsx .crawl-samples/observe-stars.ts
npm run test:integration
npx tsc --noEmit -p .
```

## C-1 star-band rejudge prepared; production apply awaits review — 2026-09-13

- Current objective: user asked to read and continue the [C-track handoff](https://claude.ai/code/artifact/258acc8e-c763-45cc-9aea-62c360b6ac56).
  The next PR-sized item is C-1: widen star eligibility and requeue automatic `large_oss` rejections. The linked
  document explicitly requires a reviewed dry-run before production application. C-2/C-3/C-4 remain subsequent work.
- Current repository: main at `580c7d1` at start. Production now exists: Dokploy reviewer
  `4RlA9EeKvtKGdR6c6AV4j` returned name `nomorevibe-reviewer-m3`, status `done`, branch `main`.
  Earlier deployment-pending entries below are historical and must not override this observed state.
- Completed: added read-only repeatable-read planning, schema-validated apply/revert, exact candidate/document
  fingerprints with row locks, settings and DB guards, pre-commit durable receipt persistence and conservative
  rollback. CLI defaults to dry-run, refuses conflicting flags and existing output files, and suppresses raw DB errors.
- Modified files: new `lib/crawl/rejudge.ts`, `scripts/rejudge-stars.ts`, `tests/integration/rejudge-stars.test.ts`,
  `docs/superpowers/plans/2026-09-13-rejudge-stars.md`, `docs/operations/2026-09-13-rejudge-stars.md`, this handoff.
  Existing `components/product-detail/ProductHero.tsx`, `nomorevibe-final/`, `nomorevibe_final.html`,
  `nomorevibe_final_source.zip` were not changed. Do not stage/revert them or touch the user's stash.
- Key decisions: existing maxStars is inclusive (`stars > maxStars` rejects), so the document's 100000 would
  admit exactly 100000. Proposed setting is **99999**, preserving the user requirement to exclude 100000+.
  No production setting or rule default changed. An optional user question about stronger evidence at 5000+
  is pending; preparation retains current AI/second-review policy. Application requires proposed settings to
  match the plan; it only changes candidate state and updated_at. Human decisions, published rows and changed
  inputs are preserved. Revert only restores actual applied rows still unchanged/new, including microsecond
  timestamp precision; it does not undo later reviews/publication or restore the global star setting.
- Production dry-run actually executed at `2026-09-12T15:48:17.688Z` (2026-09-13 00:48 KST): **318 candidates**,
  bands 97/84/71/66, personal accounts 35/27/11/20 (93 total). Stored-source rule preview: approved/passed292,
  needs_review/ambiguous16, rejected/not_a_product10. Preview excludes live AI/second review, latest evidence
  and URL duplicate/ban lookup; it is not a claim of publication eligibility or eventual outcomes.
- Artifacts: `.crawl-samples/stars-prod-plan-20260913.json` and human-readable
  `.crawl-samples/stars-prod-review-20260913.md` (318 rows), both local and gitignored. They contain no credentials.
  No receipt exists because no production apply was performed.
- Tests actually run: initial missing-module failure followed by placeholder RED (5/6 expected behavior failures);
  final focused integration **6/6 PASS**; full unit **115 files/894 PASS**; full integration **63 files/580 PASS**
  (178.76s); `npx tsc --noEmit -p .`, targeted ESLint and `git diff --check` PASS. Logs are
  `/tmp/nomorevibe-stars-unit.log` and `/tmp/nomorevibe-stars-integration.log`. CLI help exit0 and conflicting
  apply/revert exit1 verified. No production changes, live rejudge results, deploy or UI implementation claimed.
- Failed approaches: web fetch returned an artifact shell; its frame API returned a Cloudflare challenge.
  CUA browser provider was unavailable, but native Chrome through CUA successfully displayed the full document.
  No anti-bot bypass or account permission change was performed. `lib/crawl/rejudge.ts` was absent before this work;
  the existing `scripts/rejudge.ts` only evaluates local samples and is unchanged.
- Remaining work: obtain review of the concrete 318-row plan and authorization for maxStars2000→99999 plus
  requeue under existing review policy; then change only that setting, apply with a new receipt path, record
  applied/skipped counts, and measure actual rule/AI/second-review states after5/30minutes. If the user chooses
  stricter evidence, define that policy before applying. Code is local, uncommitted; no push or PR was created.

Exact next commands (DB URL must be injected from the secret store, never printed or stored in a file):

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
# Read reviewed input; production mutation below ONLY after user approval and maxStars=99999 in /admin.
cat .crawl-samples/stars-prod-review-20260913.md
DB_POOLER_MODE=pgbouncer npx tsx scripts/rejudge-stars.ts --apply=.crawl-samples/stars-prod-plan-20260913.json --receipt=.crawl-samples/stars-prod-receipt-20260913.json
# If reverting unprocessed applied rows is authorized:
DB_POOLER_MODE=pgbouncer npx tsx scripts/rejudge-stars.ts --revert=.crawl-samples/stars-prod-receipt-20260913.json
```

Production DB access used Python `subprocess.check_output` for macOS keychain account `deploy.brut.bot`,
service `dokploy-api-key`; GET `https://deploy.brut.bot/api/application.one?applicationId=4RlA9EeKvtKGdR6c6AV4j`
with the key in `x-api-key`; extracted only DATABASE_URL from the env field into the child process environment,
with DB_POOLER_MODE=pgbouncer and DB_POOL_MAX=1. Never print the key, app env or raw exception bodies.

## Production multi-instance hardening complete; deployment pending — 2026-09-09 17:47 KST

- Current objective: deploy NoMoreVibe for the first time with two load-balanced web instances, one M3-only
  scheduler/crawler/reviewer/publisher/maintenance set, one persistent M3 connect-agent, and the existing
  catalogue copied into the dedicated production PostgreSQL database.
- Completed work: added explicit PgBouncer transaction-pool mode and per-role connection budgets; separated
  migration from the runtime pool URL; added DB-backed `/api/health`; added per-instance service heartbeats and
  release/RSS/freshness visibility; made partially stale replica groups degraded; gave connect-agent its own
  Docker target and HTTP health check; removed the `AUTH_SECRET` fallback for agent control; configured a stable
  Next deployment ID and BuildKit-only Server Action key; documented M3/mini placement and cutover/rollback.
- Modified files: `.env.example`, `Dockerfile`, `compose.yml`, `next.config.ts`, root `instrumentation.ts`,
  `app/api/health/route.ts`, `app/admin/status/OperationsCenter.tsx`, `lib/db/pool.ts`,
  `lib/operations/{admin,agent-client,health,instance,observations,web-observer}.ts`,
  `scripts/{connect-agent,migrate,worker-supervisor}.ts`, `scripts/migration-config.{mjs,d.mts}`,
  `tests/{db-pool-options,migration-config,next-config,operations-agent-client,operations-health,operations-instance}.test.ts`,
  `.env.example`, `PENDING.md`, and the production operations/design/plan documents.
- Key design decisions: both web replicas use one release SHA, Server Action encryption key and session/visitor
  secrets; only the M3 runs singleton jobs; runtime traffic uses PgBouncer port 6432 while the one-shot migration
  uses direct PostgreSQL port 5432; Redis is not introduced because the current DB lease/job system already
  provides atomic claims and measured load does not require another dependency; each process reports a stable
  `SERVICE_INSTANCE_ID`, so a healthy replica cannot hide a stale one.
- Tests actually executed: full unit suite 95 files/681 tests PASS; full integration suite 50 files/456 tests
  PASS before the final review corrections; focused operations-center integration 1 file/6 tests PASS after
  those corrections; TypeScript/typegen PASS; ESLint PASS with the pre-existing `_ctx` warning in
  `lib/vendor/deppy-aibox/claude.ts:158`; Next production build PASS; runner, worker and connect-agent Docker
  targets PASS; Compose config and `git diff --check` PASS. A runner container returned `status=ok` and `db=ok`
  from `/api/health`. A real connect-agent container reached Docker `healthy`; both smoke observation rows were
  removed. Thirty-two concurrent query/transaction operations through the production PgBouncer endpoint passed.
- Review: `codex review --uncommitted` completed. Its migration-URL and stale-replica findings were fixed and
  covered by regressions. No known code blocker remains for deployment.
- Failed approaches: the first Next build failed because the worktree's `node_modules` symlink pointed outside
  the Turbopack filesystem root; an independent `npm ci` fixed it. The first Dockerfile exposed the Server Action
  key through `ARG`/`ENV`; it was replaced with a required BuildKit secret and rebuilt successfully.
- Remaining work: commit/push/merge this branch; create Dokploy applications on M3 and mini; generate and store
  distinct production secrets; stop and drain local singleton consumers; copy data without the Drizzle migration
  ledger into the already migrated production DB; clear any stale leases; deploy the same release to both web
  nodes and singleton roles only on M3; attach the public domain/load balancer; verify health, row counts, jobs,
  AI connectivity and direct/public routes; then update `PENDING.md`, this handoff and the project journal.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-prod-fix
git diff --check
git status --short
git add .env.example Dockerfile PENDING.md app/api/health app/admin/status/OperationsCenter.tsx compose.yml docs/CODEX_HANDOFF.md docs/operations/independent-workers-runbook.md docs/operations/production-multi-instance.env.example docs/superpowers/plans/2026-09-09-production-multi-instance.md instrumentation.ts lib/db/pool.ts lib/operations/admin.ts lib/operations/agent-client.ts lib/operations/health.ts lib/operations/instance.ts lib/operations/observations.ts lib/operations/web-observer.ts next.config.ts scripts/connect-agent.ts scripts/migrate.mjs scripts/migration-config.d.mts scripts/migration-config.mjs scripts/worker-supervisor.ts tests/db-pool-options.test.ts tests/migration-config.test.ts tests/next-config.test.ts tests/operations-agent-client.test.ts tests/operations-health.test.ts tests/operations-instance.test.ts
git commit -m "fix: harden production multi-instance runtime"
git push -u origin fix/production-multi-instance
```

## Claude stored-token corruption repaired; live greeting and classification verified — 2026-09-09 13:49 KST

- Objective: investigate Claude authentication failure despite credential storage; show an actual hi~ reply.
- Root cause proven: the saved token was 113 characters and ended with the literal footer word `Store`.
  The provider stitched this isolated footer word onto the token as if it were a wrapped token segment.
  Actual CLI returned HTTP 401 `OAuth access token is invalid` both with and without --safe-mode, so safety
  isolation was not the cause and remains enabled. Removing only that diagnosed suffix yielded a real Sonnet
  greeting and structured product classification. Previous blank-line fix alone was insufficient.
- Completed: parser excludes the Store footer and waits for incomplete footer lines. Claude adapter supports
  plain text output for a fixed hi~ probe; default category output remains schema-bound. Probe records contain
  timestamp/model/prompt/reply/result separately from classification. UI displays sent hi~ and actual reply;
  auth errors read `인증 실패 · 재연결 필요`. No raw CLI errors or tokens exposed; reply bounded to 2,000 chars.
- Modified files this phase: `lib/vendor/deppy-aibox/{claude.ts,README.md}`, `lib/operations/{claude,agent,contracts}.ts`,
  `lib/crawl/classify.ts` (export existing failure classifier), `app/admin/status/{AiConnection.tsx,operations.css}`,
  `tests/operations-claude.test.ts`, operations runbook and this handoff. Prior countdown changes still uncommitted.
- Data repair: while connect-agent idle, stopped it, read the encrypted vault via a temporary worker container,
  required exact diagnosed 113-char/Store shape, verified corrected candidate using a real hi~ call, backed up
  encrypted original to `vault.enc.before-footer-repair-20260909`, then atomically stored corrected credential.
  No general-purpose token trimming was added. Temporary env file was mode0600 and removed. Helpers:
  `/tmp/nomorevibe-repair-claude.py` and `/tmp/claude-repair-footer.cjs` (one-time; do not rerun after repair).
- Local deployment: new worker/runner images use existing operations-v2-20260909 tags; only app/connect-agent
  recreated. Both healthy; five independent workers healthy. Existing configVersion=2, generation=2,
  appliedGeneration=2, configReady=true preserved. Primary Spark xhigh, fallback Sonnet high.
- Verification actually executed: three regressions failed before implementation, then 2 files/24 tests PASS;
  full suite 89 files/663 tests PASS (`/tmp/claude-hi-full.log`), TypeScript/targeted ESLint/diff check PASS;
  Docker worker and runner builds PASS. CUA at localhost3200: clicked Claude connection check, saw real
  `Hi! What are you working on?`; clicked selected-model test, saw Spark AND Sonnet `정상 응답 확인`.
  DB observation confirms both connected=true, busy=null, configReady=true and both test results success.
- Failed approaches: toggling --safe-mode produced the same401 and was diagnostic only. Fixture token capture
  from previous phase omitted the isolated Store footer case. No further user OAuth approval is needed now.
- Remaining: no requested implementation outstanding. User can reload localhost3200/admin/status -> AI 연결.
  No new commit/push this phase. Preserve unrelated ProductHero/product-detail test edits and design artifacts.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
npx vitest run tests/operations-claude.test.ts tests/operations-countdown.test.ts tests/operations-agent.test.ts
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select value->>'busy',value->>'claudeConnected',value->>'configReady',value->'verification'->'results' from operations_observations where key='connect-agent'"
```

Do not rerun token-repair helpers: repaired token intentionally no longer matches the corruption guard.


## AI countdown and Claude setup-token compatibility — 2026-09-09 13:38 KST

- Objective: display an actual 35-second model countdown and Claude connection countdown; investigate repeated
  Claude connection failures against `/Users/jr/Desktop/projects/Deppy-aibox` and fix the integration.
- Completed: added server activity IDs/deadlines/current time and a client countdown (model 35s, login 600s,
  code exchange 45s). Countdown survives dialog close/reopen and polling; terminal state clears activity.
  Claude code and Enter are now separate stdin writes, 250ms apart, with cancellation cleanup. Token capture
  now accepts completed blank lines in the real setup-token success layout.
- Root cause evidence: aibox HEAD 814144a2d37cb60359486219393f93f32c7267fc pins Claude 2.1.186; our image uses
  2.1.263. Original combined long `code#state` + CR stalled for 55 seconds. A separate CR immediately yielded
  HTTP 400. With the corrected ConnectAgent, an isolated real CLI run yielded `oauth_rejected` in 713ms and
  drained the busy lock. Installed CLI source confirms a blank line after the token (Ink gap:1); old parser
  failed to capture that layout while the process remained open. No real OAuth secrets were used in diagnostics.
- Modified files: `lib/operations/{agent,contracts,countdown}.ts`, `app/admin/status/{AiConnection,Countdown}.tsx`,
  `app/admin/status/operations.css`, `lib/vendor/deppy-aibox/{claude.ts,README.md}`,
  `tests/operations-{claude,countdown}.test.ts`, `docs/operations/operations-center-runbook.md`, this handoff.
- Actual checks: two new regressions failed before fixes; focused 3 files/23 tests PASS; full Vitest 89 files/
  660 tests PASS (`/tmp/claude-countdown-full-tests.log`); TypeScript, targeted ESLint, git diff --check PASS.
  Docker worker and runner builds PASS. Isolated real CLI check `/tmp/claude-agent-submit-check.cjs` PASS.
  CUA at localhost:3200/admin/status showed 35 -> 29 seconds then real Codex Spark success; Claude showed
  600 -> 595 -> 588 seconds across dialog close/reopen. The diagnostic Claude session was cancelled.
- Local deployment: rebuilt `nomorevibe-{web,worker}:operations-v2-20260909`, recreated app and connect-agent
  only with `/tmp/nomorevibe-operations-deploy.py connect-agent app`. Both healthy; all five worker roles
  healthy. Existing encrypted vault and applied config version 1 preserved; configReady=true, Codex connected
  and probe success, Claude not connected. No production deployment or push performed.
- Failed approaches: testing a short dummy code without #state only exercised CLI local validation and missed
  real exchange; combined long input was the actual failure. Direct dummy token endpoint POST returned 400
  in 373ms, so no evidence for changing proxy/certificate handling. Early Python UI edit had syntax error;
  corrected before tests/build. CUA binding was absent after compaction; recovered existing tab 1/browser 1.
- Remaining: user must approve a fresh Claude OAuth session to verify real account storage and actual Sonnet
  response. Do not claim authenticated Claude success from a fake-code exchange or fixture-token tests.
  Current task uncommitted. Prior commit 605203f contains the operations center. Preserve unrelated existing
  ProductHero.tsx / product-detail-components.test.tsx edits and untracked nomorevibe-final artifacts.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
npx vitest run tests/operations-claude.test.ts tests/operations-countdown.test.ts tests/operations-agent.test.ts
docker ps --filter name=nomorevibe --format '{{.Names}} {{.Status}}'
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select value->>'busy',value->>'connected',value->>'claudeConnected',value->>'configVersion',value->>'configReady',value->'connection'->>'state' from operations_observations where key='connect-agent'"
```

Use the admin UI at http://localhost:3200/admin/status for fresh Claude approval, then Claude connection check,
selected model test and settings apply. Never print credential contents, real authorization codes or vault keys.


## GitHub owner identity and detail-sidebar evidence — 2026-09-08 22:08 KST

- Objective: replace the anonymous creator label on crawler-listed product cards with the public GitHub
  repository owner, and move the useful unclaimed-product identity/repository facts into the existing detail
  sidebar. Audit the current category classifier without expanding its taxonomy in the same change.
- Completed: unclaimed cards backed by a canonical GitHub repository now show a linked `@owner`; claimed maker
  labels remain unchanged. The detail sidebar now includes one compact owner/contact/claim card and renames the
  repository panel to `현재 확인 가능한 정보`, with owner, repository, visibility, dates, stars, forks,
  contributors, activity, languages, service relationship, release and license facts. Invalid or non-GitHub
  repository URLs do not receive an attributed owner.
- Modified files: `components/home/ProjectCard.tsx`, `app/home.css`, `app/p/[slug]/page.tsx`,
  `components/product-detail/{UnclaimedOwnerContact,RepositoryEvidence}.tsx`,
  `lib/domain/products/github-owner.ts`, their focused tests, the accepted standalone concept at
  `docs/designs/2026-09-08-unclaimed-product-contact.html`, and this handoff.
- Key design decisions: call the account `GitHub 저장소 소유자`, since repository ownership does not prove who
  built the deployed service; derive identity only from strict two-segment github.com repository URLs; preserve
  the existing unclaimed badge and takedown flow; keep all observed facts in the existing 340px sidebar; make no
  category/schema migration before agreeing on a richer taxonomy and measuring existing `Other` records.
- Category audit: the schema has only `Productivity`, `Dev`, `Design`, `Finance`, and `Other`. Publication asks
  hard-coded `claude-sonnet-5` for one of those five using name, tagline, URL, repository, language and topics;
  any CLI/auth/timeout/parse failure falls back to ordered topic/description keyword rules. The live local
  publisher currently logs `reason=auth` / `Not logged in`, so its new publications are using that fallback.
  Latest live local public counts were Other 646, Dev 407, Productivity 55, Design 41, Finance 36. Categories are
  stored at publication and there is no automatic reclassification job; a claimed maker can edit the category.
- Actual checks: TDD red run failed for the missing helper/component/link, then focused 3 files/29 tests PASS;
  full unit 81 files/620 tests PASS; nonincremental TypeScript PASS; ESLint PASS; production Next build PASS;
  `git diff --check` PASS. Playwright against the preserved live-data DB returned HTTP 200 for home/detail,
  resolved the owner link to `https://github.com/AISecurity365`, found both new sidebar headings, had no
  console/page errors, and had no horizontal overflow at 1440px or 390px. Screenshots:
  `/tmp/nomorevibe-owner-list.png`, `/tmp/nomorevibe-owner-detail-desktop.png`, and
  `/tmp/nomorevibe-owner-detail-mobile.png`.
- Failed approaches: an existing Next development lock pointed to port 43128 and its isolated DB did not contain
  the selected live product. A production server was therefore started on port 3201 with only DATABASE_URL's
  local forwarded port changed from 55434 to the preserved DB at 55437. The first Playwright accessibility-name
  selector expected `GitHub` in a link whose visible label was only the owner; selecting the exact sidebar href
  fixed the QA script. The temporary script was removed.
- Merge and local deployment: PR64 passed its checks and merged to main as `bb19bc2456daa0c20dc2fa756404ff6fd800a973`;
  post-merge main CI run `34230385038` passed. Port 3200 now runs image
  `nomorevibe-web:github-owner-5431902` against the preserved catalogue DB; only the app was recreated, so all
  independent workers kept running. The container is healthy. Post-deploy Playwright used an exact search query
  because ongoing publication moved the earlier fixture off the first six cards; search and detail returned 200,
  the detail had three owner-profile links, mobile had no horizontal overflow, and browser errors were zero.
- Remaining: category expansion should be a separate measured change: sample and label current `Other` records,
  agree on stable primary categories plus functional tags, restore a long-lived classifier credential, add
  confidence/versioned decisions, then reclassify existing records with review and rollback support.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
npm test
npm run build
git diff --check
open http://127.0.0.1:3200/?q=Automatizaci%C3%B3n
gh run view 34230385038
docker logs --since 2h nomorevibe-publisher-1 2>&1 | rg 'crawl.classif|Not logged|auth' | tail -n 30
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c "select category,count(*) from products where status in ('seeded','verified') group by category order by count(*) desc"
```

## Unclaimed product owner/contact HTML concept — 2026-09-08 21:30 KST

- Objective: produce a reviewable HTML concept that gathers useful public information for crawler-listed,
  unclaimed products and gives visitors a realistic way to contact the repository owner.
- Completed: added `docs/designs/2026-09-08-unclaimed-product-contact.html`, using the current product-detail
  visual language and live `AgentWorkforce/relay` metadata. The design keeps owner identity, available contact
  routes and ownership claim in one section, followed by a compact observed-facts panel and an explanation of
  the unclaimed state.
- Design decisions: label the account as `GitHub 저장소 소유자`, never as the confirmed maker; distinguish
  organization accounts; expose only working routes (GitHub profile, new issue and official website); avoid
  scraped commit email; keep `GitHub에서 확인` and the observation date visible; let verified makers replace
  the unclaimed treatment through the existing claim flow.
- Modified files: the standalone HTML concept above and this handoff only. No production component, schema or
  crawler behavior changed.
- Actual checks: HTML parser PASS; `git diff --check` PASS; Playwright desktop 1440px and mobile 390px rendered
  HTTP 200 with three contact links, the source label and claim CTA; both had zero console/page errors and no
  horizontal overflow. Screenshots: `/tmp/nomorevibe-unclaimed-desktop.png` and
  `/tmp/nomorevibe-unclaimed-mobile.png`.
- Failed approaches: `agbrowse` was unavailable on PATH, so the existing Playwright installation was used. A
  temporary QA module under `/tmp` could not resolve the project dependency; moving it to the repository for the
  run fixed module resolution, and the temporary file was then removed.
- Remaining: collect user feedback on this concept. If accepted, normalize GitHub owner fields into the detail
  view, add the responsive production component, conditionally expose Issues/Discussions/site links, then run
  focused component and browser checks.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
python3 -m http.server 8766 --directory docs/designs
open http://127.0.0.1:8766/2026-09-08-unclaimed-product-contact.html
git diff -- docs/designs/2026-09-08-unclaimed-product-contact.html docs/CODEX_HANDOFF.md
```

## Existing catalogue restored and independent local crawler activated — 2026-09-08 21:06 KST

- Objective: explain why previously crawled products were absent from the redesigned local page, restore them
  without data loss, verify the independent crawler against the existing DB, and fix the catalogue query that
  could hide seeded products again later.
- Root cause: the accepted redesign at port 43201 intentionally used isolated DB
  `nomorevibe_workers_local_deploy` with one synthetic verified product. The original port-3200 DB still held
  1,118 seeded products, 5,336 crawl documents and all candidate history. Its legacy HTTP scheduler was no
  longer crawling: every request returned 403 because its cron secret differed from the web container.
- Recovery: created `/tmp/nomorevibe-before-worker-split-20260908.dump` (151 MiB, SHA-256
  `8bbb4e26f75988fb840c019410925af8f75f0e156a0c888520a830fe99f831ce`), stopped the old web/scheduler,
  applied additive migrations once, then started the current web and one scheduler/crawler/reviewer/publisher/
  maintenance process each against the preserved `nomorevibe` DB. All six services are healthy at port 3200.
  The temporary secret env file was removed; the rollback dump remains on the host.
- Runtime proof: the DB scheduler requested nine due jobs. The crawler discovered two repositories and fetched
  both. A bounded judge tick classified one as `passed` and one as `no_homepage`; a publisher tick added
  `Dark Factory`. Continuous operation then raised the preserved catalogue from 1,118 to 1,146 seeded products.
  The latest DB snapshot has 1,146 published candidates, 260 `needs_review` candidates and 4,168 rule-rejected
  candidates. All job requested/processed versions match and `last_error` is empty. The obsolete isolated
  web/five-worker set was stopped and removed.
- AI state: collection is enabled, but automatic AI review is effectively `off`; no `CRAWL_REVIEW_MODEL` is
  configured and repository agent-evidence collection is disabled in the preserved settings. Publisher category
  classification attempted Claude and received `Not logged in`, then used the existing deterministic fallback.
  Configure a valid long-lived Claude token/model and verify `observe` results before enabling `enforce`.
- Follow-up code: branch `fix/public-catalogue-home` changes the Recent tab and plain search to query both
  `verified` and `seeded` products and uses the same statuses for category/public totals. This prevents seeded
  products disappearing once verified products exceed the unclaimed-fill threshold. The regression tests were
  observed failing first (3 expected failures), then passed after the minimal fix.
- Actual checks for the follow-up: targeted 1 file/13 tests PASS; full unit 80 files/610 tests PASS;
  nonincremental TypeScript, ESLint, Playwright 6 tests and Docker runner build PASS. Production-mode browser QA
  at port 3200 returned 200 for default/recent views, rendered six initial cards, reported
  `최신 100개 · 공개 1119개`, and had no console/page errors.
- Merge result: PR62 merged as `1d0bdd2c816efeeb252a3f422d1bf36bc0907f10`; Git verified implementation
  commit `f72ec909d9ac486d11737849188d28cb4929d071` is its ancestor. PR checks and post-merge main CI run
  `34223497961` passed typegen, TypeScript, lint, unit, integration and build. The live local page at port 3200
  returns HTTP 200 and all six current services are healthy.
- Remaining: AI review and agent evidence remain intentionally inactive until credentials, model and an
  observed sample are accepted. Publisher category classification currently logs Claude authentication failures
  and uses the deterministic fallback; it does not block rule-approved publication.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git diff --check
git status --short
docker compose -p nomorevibe ps
curl -I http://127.0.0.1:3200/
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c "select status,count(*) from products group by status"
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c "select name,requested_version,processed_version,last_error from jobs order by name"
gh run view 34223497961
```

## Port 3200 home redesign applied, verified and merged — 2026-09-08 19:08 KST

- Objective: inspect the home design running on port 3200, apply that design to the clean current-main
  integration without carrying unrelated dirty-worktree changes, verify it locally, and land it after CI.
- Worktree/branch: `/Users/jr/Desktop/projects/nomorevibe-workers`; implementation commit `a4ac7fa` was based
  on `origin/main` at `bc525e9`. Preserve `/Users/jr/Desktop/projects/nomorevibe`; its local main still has
  unrelated uncommitted auth/detail/Compose/design-source files.
- Completed: responsive shared header/footer/mobile navigation, hero, four KST pulse panels and methodology
  dialog, larger project cards, saved-project flow, search/category/builder/repository-link browsing, curated
  AI news, and accurate empty/unclaimed states. The existing worker architecture and product detail remain.
- Accuracy rule: only maker-reported builders reach public view models, cards, builder search/filter options,
  and pulse counts. Crawler guesses remain hidden. Repository URLs are labelled `저장소 있음`, not open source.
  Interest change is exposed only after both completed seven-day windows have been collected; a complete window
  with no rising category is distinguished from collection still in progress.
- Main modified areas: `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `app/home.css`,
  `components/home/*`, `components/BrowseFilters.tsx`,
  `lib/domain/products/{repository,view,home-pulse,labels}.ts`, `lib/domain/ranking/view.ts`, and corresponding
  unit/integration/E2E tests. Full report: `docs/operations/2026-09-08-home-redesign-qa.md`.
- Actual final tests: unit 80 files/608 tests PASS; integration 49/446 PASS; Playwright 6 PASS;
  nonincremental TypeScript, ESLint, diff check, and Docker runner build PASS. Local production browser QA
  passed all 10 flows in 10 consecutive runs with no console/page/request errors; duplicate builder query
  returned HTTP 200. The fast-navigation hydration reproducer also passed 10 consecutive development runs.
- Local deployment: `nomorevibe-workers-local-app` runs `nomorevibe-web:local-home-qa` at
  `http://127.0.0.1:43201` against `nomorevibe_workers_local_deploy`; five independent worker containers are
  healthy. Keep them running. Port 3200 and its dirty source worktree were not changed.
- Findings fixed during QA: misplaced save control, unranked search miss, duplicate-param 500, non-modal dialog,
  broken card fragment, saved/unclaimed mixing, route-invalid skip link, low BETA contrast, guessed-builder
  exposure, a false category-level unique-visitor description, a mislabeled interest-sort tab, a fast-navigation
  header hydration mismatch, premature interest comparison before two full collection windows, a false collection
  message when no category was rising, and non-repeatable admin E2E cleanup.
- Failed check: the first lint attempt overlapped Playwright deleting `test-results` and got ENOENT. A sequential
  standalone lint run passed. Negative-path unit/integration log messages are expected assertions; both suites
  exited 0. The first E2E after adding the interest-copy assertion raced dialog URL cleanup; waiting for dialog
  close and `metric` removal made the full rerun pass. The first hydration diagnostic used unsupported top-level
  await under the CommonJS loader; wrapping its execution exposed the exact header DOM mismatch. An automated
  full-diff `codex review --base origin/main` inspected the large redesign for more than 30 minutes without
  returning a verdict and was stopped; do not represent that run as a clean review. Manual review found and fixed
  the interest collection-window issue, then the full checks above passed.
- Merge result: PR60 merged to main as `db682a3165cef02e382f2803bf5baaa34e9f6e20`; Git verified implementation
  commit `a4ac7fa711c1133e9554f12a085207931cf5ef29` is its ancestor. PR checks passed, and post-merge main CI run
  `34213468456` passed typegen, TypeScript, lint, unit, integration and build. The first `gh pr merge --delete-branch`
  command exited 1 only because another worktree already had local `main` checked out; GitHub had completed the
  merge before the CLI attempted that local switch.
- Remaining work is production-specific: deployment and a 24-hour external-worker observation remain blocked by
  the P0 target/credential decisions in `PENDING.md`. No production mutation occurred.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git fetch origin main
git show --stat --oneline db682a3165cef02e382f2803bf5baaa34e9f6e20
gh run view 34213468456
docker ps --filter name=nomorevibe-workers-local
curl -I http://127.0.0.1:43201/
cat PENDING.md
```

## Local deployment QA and main merge completed — 2026-09-08 17:02 KST

- Objective completed: deployed the stacked worker changes locally, exercised the public/admin/worker paths,
  fixed every blocker found, and merged PR57 and PR58 to remote main after CI succeeded.
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
- Merge result: PR57 merged as `f6a0d88`; PR58 merged as `8b3a99c`. Git verified final feature commit
  `7384fc4` is an ancestor of `origin/main`. The post-merge main CI run `34202033925` passed typegen,
  TypeScript, lint, unit, integration and build. Keep the final local containers running.
- Remaining work is production-specific: P0 server/domain/DB and long-lived Claude credentials in
  `PENDING.md`, followed by the runbook's deployment and 24-hour observation. No production mutation occurred.

Exact next commands:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-workers
git status --short
git fetch origin main
git merge-base --is-ancestor 7384fc49642f4d3beb68443015b675d129fadaf2 origin/main
docker ps --filter name=nomorevibe-workers-local
curl -I http://127.0.0.1:43201/p/local-qa-product
cat PENDING.md
cat docs/operations/independent-workers-runbook.md
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

# 2026-09-09 Publisher category expansion and Codex classifier

## Current objective

Apply the measured category expansion and publisher classifier choice: add Games and a broader product taxonomy,
use `gpt-5.3-codex-spark` xhigh first with a `gpt-5.6-terra` high fallback, preserve the independent Claude review
worker, and integrate the finished change without losing the dirty main worktree.

## Completed work

- Expanded the accepted product taxonomy from 5 to 17 values and added Korean labels. The database column is an
  unconstrained `varchar(40)`, so no migration or stored-value rewrite is required.
- Replaced per-product Claude category calls with Codex batches of at most 10. Spark xhigh has an 8-second deadline,
  Terra high has a 12-second deadline, and complete CLI failure returns nulls for the existing rule fallback.
- Added strict structured output, exact numeric-ID set validation, input-order restoration, output caps, process
  termination on timeout/overflow, isolated Codex configuration, and escaped untrusted product JSON.
- Preserved publication race protection by carrying the pre-classification document/settings/evidence snapshot into
  the insert transaction and comparing it after the model call.
- Expanded the keyword fallback, including explicit playable-game detection, wedding/Lifestyle handling, and the
  game-server/Dev exception.
- Added `scripts/codex-auth.sh`. Publisher authentication prefers `CODEX_ACCESS_TOKEN`, tries `OPENAI_API_KEY` when
  access-token login fails, removes raw secrets before exec, and leaves the worker running for rule fallback if login
  is unavailable. Reviewer continues to receive only `CLAUDE_CODE_OAUTH_TOKEN`.
- Pinned Codex CLI `0.153.4` and Claude Code `2.1.263` in the worker image. Publisher gets a 120-second cooperative
  budget below its 180-second supervisor hard timeout so a 20-second model fallback does not repeatedly classify a
  batch while publishing only its first rows.
- Updated the distributed registration skill and operations documentation to use all 17 accepted categories.

## Modified files

- Runtime/domain: `.env.example`, `Dockerfile`, `compose.yml`, `lib/crawl/classify.ts`,
  `lib/crawl/jobs/publish.ts`, `lib/crawl/publish.ts`, `lib/domain/products/schema.ts`,
  `lib/domain/products/labels.ts`, `scripts/codex-auth.sh`, `scripts/worker.ts`, `skill/SKILL.md`.
- Tests: `tests/classify.test.ts`, `tests/codex-auth.test.ts`, `tests/schema.test.ts`,
  `tests/home-pulse.test.ts`, `tests/skill-contract.test.ts`, `tests/worker-runtime.test.ts`,
  `tests/integration/crawl-publish.test.ts`, `tests/integration/review-publication-gate.test.ts`.
- Documentation: `README.md`, `PENDING.md`, this handoff, `docs/operations/independent-workers-runbook.md`,
  `docs/operations/2026-09-08-independent-workers-implementation-report.md`,
  `docs/operations/2026-09-08-local-deployment-qa.md`, and
  `docs/operations/2026-09-08-publisher-category-classification.md`.

## Key design decisions

- Keep existing English category keys and only add values; Korean labels remain presentation data.
- Use one batch per publication selection because measured CLI startup/context cost dominates the small product input.
- Adopt Spark xhigh because it agreed with Terra xhigh on 21/22 sampled records while the two measured batches were
  roughly twice as fast. Use Terra high as the API-key-capable availability fallback.
- Category classification remains non-blocking. AI review approval remains a separate blocking publication policy.
- Keep all tool access disabled for classification. Inspection of Codex `rust-v0.153.4` confirmed shell tool
  registration requires `Feature::ShellTool`; `features.shell_tool=false` prevents both one-shot and unified exec.

## Test commands and results

```text
npm test
  PASS — 82 files, 623 tests on the final code
npm run test:integration
  PASS — 49 files, 450 tests after repairing the separate review-gate module mock
npx tsc --noEmit
  PASS on the final code
npm run lint
  PASS — 0 errors/warnings on the final code
npm run build
  PASS — Next.js 16.3.1 on the final code
npm test -- tests/codex-auth.test.ts
  RED for CODEX_CLI override, then PASS — 2 tests
  RED for expired access token plus valid API key, then PASS — 2 tests
npm test -- tests/skill-contract.test.ts tests/worker-runtime.test.ts
  RED — stale five-category skill contract and missing publisher budget
  PASS — 2 files, 17 tests after both fixes
npm run test:integration -- tests/integration/review-publication-gate.test.ts
  PASS — 1 file, 6 tests after adding the batch mock
docker compose config --quiet
  PASS
docker compose build publisher
  PASS on final code — image includes Claude Code 2.1.263 and codex-cli 0.153.4
docker run --rm --entrypoint sh nomorevibe-worker:local scripts/codex-auth.sh codex --version
  PASS — codex-cli 0.153.4
node --import tsx -e '<actual classifyCategories smoke>'
  PASS — actual Spark path returned Lifestyle for wedding and Games for playable puzzle
```

Expected Vitest failure-path logs and the existing Vite native-config-loader warning remain non-failing.

## Failed approaches

- The first full integration run failed 4/450 because `review-publication-gate.test.ts` fully mocked the old classifier
  export and omitted `classifyCategories`. The production path was not failing; the mock was updated and the full
  integration suite then passed 450/450.
- A `codex review --uncommitted` run re-executed unit, integration, build, image, and upstream CLI-source checks but
  did not produce a final verdict after an extended investigation, so it was terminated. Its concrete discovery was
  the stale five-category `skill/SKILL.md`; a RED contract test now covers that. Upstream source inspection also
  confirmed the shell isolation flag instead of leaving that as an assumption.
- Per-product Spark calls were rejected after a single sample took 4.275 seconds and 6,889 tokens. Batch calls are the
  adopted path.

## Remaining work

- The feature is committed on local `main`, one commit ahead of `origin/main`. The root worktree was first
  fast-forwarded from `9c84bb9` to `b220e93`, then the feature commit was cherry-picked. The pre-existing local
  design/login work was restored as uncommitted work. Conflicts were older versions of changes already merged into
  upstream, so the newer upstream versions were retained; non-conflicting local files and edits were preserved.
  `stash@{0}` (`pre-category-integration-2026-09-09`) remains as a safety copy.
- Root integration checks: `npm test` PASS — 83 files/628 tests; focused category/auth/detail checks PASS — 8
  files/73 tests; `npx tsc --noEmit --incremental false` PASS; production build PASS. The first build failed because
  macOS created `.next/standalone/node_modules/.DS_Store` while Next was removing that generated directory; moving
  only that metadata file to `/tmp` and rerunning the same build passed. `npm run lint` sees the restored untracked
  standalone concept at `nomorevibe-final/` and fails on its CommonJS fixture; linting the application with
  `--ignore-pattern nomorevibe-final` PASS. `git diff --check` PASS.
- Local runtime applied: built `nomorevibe-web:category-c0d4287` and
  `nomorevibe-worker:category-c0d4287`, stopped/drained only app and publisher, ran the migration command
  successfully, and recreated those two services. Port 3200 returns HTTP 200; app and publisher are healthy with
  restart count 0; the existing scheduler/crawler/reviewer/maintenance stayed up. Rendered HTML contains the new
  Games/Business/Marketing/Data/Security/Sports labels. Every job row has matching requested/processed versions and
  an empty `last_error`. The publisher contains codex-cli 0.153.4 but reports `Not logged in` because neither Codex
  credential is configured, so runtime classification currently uses the deterministic rule fallback.
- Controlled publisher verification requested `crawl-publish` version 60 against the existing local queue. It
  completed version 60 with no `last_error` in 93.163 seconds, published 17 candidates and skipped one missing a
  description. Spark xhigh timed out for batches of 9 and 8, Terra high also timed out for both batches, and the
  deterministic fallback produced 16 `Other` plus one `Security`. This proves the publication loop works but is
  not evidence of a successful Spark classification; inject `CODEX_ACCESS_TOKEN`, recreate publisher, and require a
  `crawl.classified` event naming `gpt-5.3-codex-spark` before claiming Spark is active.
- Production remains blocked by `PENDING.md` P0: target server, domain, PostgreSQL, secret store, publisher Codex
  credential, reviewer Claude credential/model, and a real 24-hour observation are not configured. Existing stored
  products were not bulk-reclassified; the new taxonomy applies when the publisher classifies new candidates.

## Exact commands for the next agent

```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
git log -2 --oneline
git stash list | head -n 3
git diff --check
npm test
npx tsc --noEmit --incremental false
npm run lint -- --ignore-pattern nomorevibe-final
npm run build
docker compose -p nomorevibe ps
curl -I http://127.0.0.1:3200/
docker exec nomorevibe-publisher-1 sh -lc 'codex --version; codex login status 2>&1'
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -c \
  "select name,requested_version,processed_version,last_error from jobs order by name"
cat PENDING.md
```

## Admin operations HTML concept and Deppy-aibox review — 2026-09-09

- Objective: show all real service roles and jobs in an administrator design; review manual Codex reconnect using Deppy-aibox. User approved the proposed concept with `진행해`; this phase delivers the standalone HTML, not production integration.
- Completed: four-tab operating-center concept with seven observed services, ten executable jobs, service/search filters, explicit snapshot timestamps, disconnected Codex status, four-step mock reconnection dialog, and proposed manual category selection. No backend/OAuth/job request is sent by the demo controls.
- Files: `docs/designs/2026-09-09-admin-operations.html`, `docs/superpowers/specs/2026-09-09-admin-operations-design.md`, this handoff.
- Decisions: reuse `/admin/status` and existing jobs/catalog/queue/review data; distinguish liveness, job completion, disabled AI and model success. Job request versions are not item counts. Missing progress denominator means no percentage. AI failure hold/manual category are proposed changes, not existing policy. Container runtime/AI metadata requires central observations. Do not mount Docker socket into the web.
- Aibox review: private repo pinned to `814144a2d37cb60359486219393f93f32c7267fc`, checkout `/private/tmp/deppy-aibox-review.2Ncv9E`. Build → 64 actual tests → typecheck PASS in prior review. No live OAuth/refresh/Spark entitlement validation was performed. The design identifies whole auth.json retention, atomic generation/refresh ownership, webhook replay/schema/provider binding, version pin and real admin session requirements.
- Actual HTML checks: Playwright HTTP200; 1440/1024/768/390 widths across all four tabs without page overflow; role filter/search/empty state; request demo; four reconnect stages and Escape; manual missing-category/selected-category feedback; 0 page errors. Desktop and mobile screenshots visually inspected. Mobile notice changed to a stacked button layout after inspection.
- Failed approaches: port 8767 occupied, used loopback 8879. First manual selection test found malformed option markup; explicit option elements/values repaired, complete interaction rerun passed. Prior Aibox invocation had wrong cwd; test-before-build produced zero tests. Correct build-first results are recorded in the design document.
- Preview server: Python http.server session 30614, loopback port 8879; serves only docs/designs. Screenshots `/tmp/nomorevibe-ops-{1440,1024,768,390}.png`, `/tmp/nomorevibe-ops-connect.png`.
- Remaining: user design feedback, then scoped production implementation plan and integration. Real runtime settings, credentials and fallback publication policy are unchanged. Preserve existing unrelated local edits and stash.

Exact next commands:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short --branch
open http://127.0.0.1:8879/2026-09-09-admin-operations.html
cat docs/superpowers/specs/2026-09-09-admin-operations-design.md
# If preview server has stopped:
python3 -m http.server 8879 --bind 127.0.0.1 --directory docs/designs
```

## Operations concept v2 — worker roles and model configuration

- Objective: expand the existing approved administrator concept with role-first worker names, detailed task progress, and Codex model settings after connection.
- Completed: each of six service cards shows its Korean role above the worker key; database has role/name too. Selected worker panel shows purpose, owned jobs, schedules, activity constraints and dated real result excerpts. Task modal and Korean role/job search work. Codex reconnect demo now leads to primary/fallback model and effort configuration, test success/access denial/timeout scenarios, and guarded apply preview. Duplicate models are rejected; changing settings invalidates verification.
- Files: `docs/designs/2026-09-09-admin-operations.html`, corresponding `docs/superpowers/specs/2026-09-09-admin-operations-design.md`, and this handoff only.
- Decisions: retain explicit historical snapshots, avoid fictitious progress percentages, use only existing Spark/Terra model IDs, separate account connection from model compatibility and worker application. Actual configuration implementation must bind credential generation/config hash and apply only on the next batch. Current fallback publication policy is unchanged.
- Validation executed: Playwright 4 widths × 4 tabs no page overflow; six worker detail switches; job modal; Korean search; pre-auth fieldset disabled and post-auth enabled; denied/duplicate configuration cannot apply; successful configuration applies in demo; effort edits invalidate verification; mobile model section no overflow; zero page errors. Inspected desktop overview and model screen screenshots. No failing checks in this phase.
- Artifacts: `/tmp/nomorevibe-ops-v2-{1440,1024,768,390}.png`, `/tmp/nomorevibe-ops-v2-models.png`, `/tmp/nomorevibe-ops-v2-models-mobile.png`. Existing loopback preview 8879 remains active.
- Remaining: design feedback, then implement data/credential/config endpoints under separate scope. No new production code, runtime settings, credentials, or service processes changed.
- Next commands: `cd /Users/jr/Desktop/projects/nomorevibe`; `git diff --check`; `open http://127.0.0.1:8879/2026-09-09-admin-operations.html`; `git diff --stat`.

## Shared admin layout implementation — in progress

- Objective: implement persistent sidebar and content navigation across all real admin menus.
- Completed: added nested admin layout, client shell, scoped responsive CSS, all-menu active navigation; removed duplicate per-page nav, renamed status heading to 운영센터. Auth remains in pages/actions; login bypasses shell.
- Modified: app/admin/{layout.tsx,AdminShell.tsx,AdminNav.tsx,admin.css}, existing admin pages, tests/admin-navigation.test.tsx. Preserve other dirty work.
- Validation: navigation tests ran RED (3 failures before implementation); after implementation two assertions failed because Next serializes aria-current before href. Adjusted assertions to ignore attribute order; rerun pending.
- Remaining: actual job-role overview, final tests/typecheck/lint/build, local web update and browser navigation verification. OAuth/model settings remain concept only.
- Next commands: `npx vitest run tests/admin-navigation.test.tsx`; `npx tsc --noEmit --incremental false`; `docker compose -p nomorevibe ps`.

## Shared admin layout implementation — completed locally (2026-09-09)

- Objective completed: the real admin sidebar persists across 운영센터, 심사 큐, 제품 관리, 크롤 설정, 근거 설정 and 랭킹; page bodies render in the shared content area. Product detail selects 제품 관리 and now uses client navigation. Mobile navigation collapses after route changes. Login is outside the sidebar; returning to the public site restores its header/footer.
- Files: `app/admin/layout.tsx`, `AdminShell.tsx`, `AdminNav.tsx`, `admin.css`; existing admin pages with duplicate nav removed; `app/admin/products/ProductRow.tsx`; `app/admin/status/{page.tsx,WorkerOverview.tsx,RefreshStatus.tsx}`; `tests/admin-navigation.test.tsx`; this handoff. Earlier unrelated dirty edits remain intact.
- Operations: added five actual job-role cards from JOB_CATALOG and existing jobs query, role before worker name, expandable owned-job state/schedule/last run/last success/retry timestamps, manual refresh and KST snapshot timestamp. Observed DB timestamps explicitly do not claim current container health or successful AI authentication. No extra collector is loaded and no new DB query is needed for these cards. Existing status panels remain.
- Decisions: use a nested layout rather than moving every admin route; keep authorization on server pages/actions; no menu prefetch to avoid loading all admin datasets. Scope public chrome hiding to the mounted admin shell. Long text wraps inside the content column. Existing Codex reconnect/model configuration remains HTML concept only; this phase does not implement credentials or runtime model settings.
- Tests actually run: navigation regression tests RED before changes, then 3/3 PASS after fixing attribute-order-dependent assertions. Full `npm test`: 84 files / 631 tests PASS. `npx tsc --noEmit --incremental false`: PASS. `npm run lint -- --ignore-pattern nomorevibe-final`: PASS (unrelated imported design folder excluded). After final Link/CSS changes: targeted nav tests 3/3 and `npx eslint app/admin` PASS; final Docker production build, including TypeScript, PASS. `git diff --check`: PASS.
- Browser verification on updated localhost:3200: all six client menu transitions preserve the same sidebar DOM; active menu correct; product detail also preserves sidebar; back/reload work; 1024/768/390 widths for six menus plus detail have no page overflow; mobile menu opens/closes and closes on navigation; public header restored on return home; refresh works; zero page errors. Desktop 1440 and mobile screenshots inspected. Auth-disabled temporary instance on loopback3212 redirects unauthenticated status/product-detail/ranking requests to login without sidebar or protected content; temporary container stopped after checks.
- Failed approaches fixed: Next Link HTML emits aria-current before href (test assertion corrected). First browser pass found mobile product URL text extending page to537px at390px; `overflow-wrap:anywhere` fixed it and complete QA rerun passed. First recreate helper copied container PATH into host subprocess and could not find docker; no mutation occurred. Retried with only explicit Compose runtime variables in memory, preserving host PATH and existing credentials.
- Local deployment: `nomorevibe-app-1` on port3200 now uses `nomorevibe-web:admin-sidebar-20260909`; rebuilt/recreated app only with existing app credentials. Existing crawler/reviewer/publisher/maintenance/scheduler and DB were not restarted. Compose reports all seven services healthy. No production deployment, commit or push in this phase.
- Artifacts: `/tmp/nomorevibe-admin-sidebar-desktop.png`, `/tmp/nomorevibe-admin-sidebar-mobile.png`; read-only navigation QA `/tmp/nomorevibe-admin-qa.cjs`.
- Remaining: requested sidebar work is complete. Real Codex reconnect/model settings and broader service runtime telemetry remain separate implementation work described in the existing design specification.

Exact verification commands:
```sh
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
git diff --check
npx vitest run tests/admin-navigation.test.tsx
node /tmp/nomorevibe-admin-qa.cjs
docker compose -p nomorevibe ps
curl -I http://127.0.0.1:3200/admin/status
# Browser: http://localhost:3200/admin/status
```

## Full operations v2 implementation — in progress, current objective supersedes sidebar-only phase

- User explicitly requested ALL functionality in the8879 v2 concept. Implementing overview/jobs/AI/manual tabs, real operations requests, isolated Codex credential owner/model checks, and manual classification holds.
- New code: lib/operations/{contracts,observations,agent-client,credential-vault,agent,categories,admin}.ts; lib/db/operations-schema.ts + schema export; additive drizzle0023 + journal; scripts/connect-agent.ts; supervisor DB observation hook; classifier accepts models and attempt callback; publisher broker calls/holds/manual decisions; publication guard checks category decision revision; real admin/status components/actions/operations.css replacing summary-only presentation. Compose adds internal connect-agent encrypted vault; Dockerfile creates owned vault directory.
- Architecture adjustment: one internal connect-agent owns login+CLI+refresh+encrypted full auth.json; publisher calls bounded authenticated RPC. This avoids shared auth file refresh races and credential webhooks. RPC derives its internal token from existing AUTH_SECRET. Credential actions require an actual allowlisted GitHub session; local bypass is insufficient. No OAuth approval has been started.
- Tests executed: operations-agent + classify + worker-runtime =21 PASS. Full unit suite/typecheck currently in progress. Initial typecheck before latest UI fixes PASS. Lint found plain OAuth API anchor false positive, internal review anchor, Date.now in render, unused ModelConfig. Fixing those now. No local migration/deploy of this full phase yet;3200 still sidebar-only image.
- Important remaining: fix login persist rollback and supervisor DB connection shutdown; final lint/type/tests; isolated DB category/guard/job coalescing integration; build images; preserve current service env secrets in memory while replacing roles; migrate existing local DB only after checks and backup; all-tabs Playwright QA (real OAuth requires operator approval, do not fake it). Existing unrelated dirty work remains.
- Plan: docs/superpowers/plans/2026-09-09-operations-implementation.md. Tests sessions55789,50435; current helpers /tmp/nomorevibe-admin-qa.cjs is previous sidebar QA and needs full-v2 replacement.

## Full operations v2 — final verification/deployment checkpoint

- Full unit suite639/639 PASS (86 files); new category+publication gate integration12/12 PASS. Initial hold cooldown test exposed host/DB timestamp skew; use DB clock_timestamp()/now() for hold writes. One unrelated public-network SSRF test transiently failed then targeted9/9 and whole639/639 passed.
- New runner stores last12 numeric/boolean event summaries atomically with successful completion in operations_observations job:<name>; UI job details shows last run duration/results, no original/model output. Integration12/12 rerun after runner change PASS; whole unit639/639 rerun PASS.
- Production Docker web build initially failed because client ManualClassification imported server product schema (node:net). Extracted pure lib/domain/products/categories.ts and re-exported original schema interface. Next build then passed. Final manual form accessibility edit accidentally left a closing label; replaced component with readable explicit labels; typecheck/lint PASS, final web build session97683 pending/just completed.
- First full-v2 local deployment complete: all8 services healthy; supervisor observations recorded for5 worker roles and connect-agent; actual publisher tick135/135, no last_error,13 classification holds. Existing publisher Codex reported Not logged in before replacement; no usable credential migrated or lost. Backup /var/folders/5g/tm96jknx43n8r04kl5j12kvm0000gn/T/nomorevibe-before-ops-q6nnysgb.dump; additive0023 applied to local55437. Credentials preserved in memory with temporary0600 Compose override removed after use. Helper /tmp/nomorevibe-operations-deploy.py.
- Browser on real3200: all four tabs ×1440/1024/768/390 no page overflow;8 role detail selections;5 crawler jobs, Korean search, empty state; modal Escape; disabled model test before connection; local bypass cannot manage credentials; sidebar navigation; zero page errors. Screenshots /tmp/nomorevibe-ops-live-<width>-<tabIndex>.png inspected desktop/mobile. QA /tmp/nomorevibe-ops-v2-qa.cjs.
- Isolated fixture app3214/agent3213 + test DB55435: fake pinned-CLI contract executable (no network/real account) completed login credential storage, primary+fallback validation, apply; editing effort invalidated verification; actual manual-category and job-request server actions passed. Earlier manual getByLabel exact failed due implicit label/select options; fixed explicit htmlFor. Fixture Docker app stopped; fixture node22331 terminated. No real OpenAI login approval or real model inference tested.
- Latest worker image operations-v2-20260909 includes completion summaries and one-use model apply; built successfully. Need rerun /tmp/nomorevibe-operations-deploy.py after final web build to place final images on real stack; rerun browser QA, verify latest job summaries/health, final docs/check report. No commits/push in this phase. Real OAuth remains operator action, not an implementation stub.

## Full operations v2 — completed locally

- Final web and worker images deployed to3200 under operations-v2-20260909, preserving existing credentials. All8 services verified healthy after full replacement; final web-only rebuild adds explicit missing OAuth configuration notice. Full four-tab responsive/browser QA rerun PASS with zero page errors on deployed stack. Latest source typecheck and status-component ESLint PASS; final web production build PASS; whole lint passed after manual JSX repair. Whole639-unit suite and12 DB integrations passed as recorded above.
- Real runtime now records job:crawl-fetch, job:crawl-agent-review, job:product-evidence-refresh and job:agent-evidence-refresh completion summaries. Final browser spot-check verifies recent job result and OAuth-setup notice. Publisher queue resumes after refresh with category holds instead of fallback publication; no stale human classification can bypass publication guard.
- Operator configuration remaining: local GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are absent (allowlist is configured). The actual UI clearly reports this and does not present an unusable login link. Need configure the GitHub OAuth app, sign in as an allowlisted admin, then explicitly approve Codex device authorization and test/apply models. This is an external configuration/approval requirement; code paths are implemented and tested with isolated fixtures, not real OpenAI inference. No production deployment/commit/push.
- Next verification: `cd /Users/jr/Desktop/projects/nomorevibe`; `git diff --check`; `node /tmp/nomorevibe-ops-v2-qa.cjs`; `docker compose -p nomorevibe ps`. Local web-only redeploy helper: `python3 /tmp/nomorevibe-operations-deploy.py app` (preserves current secrets through a private temporary Compose override).

## Local Codex connection bug fixed — next objective Claude fallback via local Deppy-aibox

- Root cause: actualAdmin required a GitHub session while local UI bypass was enabled and GitHub OAuth client/secret absent. Failed request left the modal in fake code-preparing state.
- Fixed: explicit `localCodexEnabled` requires ADMIN_LOCAL_LOGIN=1 + ADMIN_LOCAL_CODEX=1 + HTTP loopback site URL. Local Compose binds web only127.0.0.1:3200. Server mode retains actual allowlisted session checks. AI tab describes local mode, catches failed requests, has proper retry/failed/cancelled/expired branches, resumes active login with 연결 계속 and prevents overlapping status polls. No prior credentials were used or exposed.
- Files: lib/auth/local-codex.ts, status actions/page/OperationsCenter/AiConnection, compose.yml, .env.example, tests/local-codex.test.ts and operations-actions.test.ts, operations runbook. Existing other dirty work preserved.
- Validation:10 targeted tests passed, typecheck and scoped ESLint passed, production web build passed; deployed web only with existing secrets and loopback port. Actual real Codex CLI device code and official URL generated via browser UI; close/resume worked; cancellation cleared code/wait state; no page errors. QA canceled the actual pending test login; no OpenAI account approval occurred. /tmp/nomorevibe-local-codex-qa.cjs reproduces without logging the code. Last failure/mobile QA session61443 pending result.
- User now asks: use `/Users/jr/Desktop/projects/Deppy-aibox` so Claude is used when Codex fails. New objective includes inspecting that local repo and integrating actual provider/auth/fallback behavior, retaining the above fixed local login capability. Do not revert to GitHub-only requirement. Existing connect-agent is Codex-only and provider fallback still Spark→Terra; Claude fallback NOT implemented yet.

## 2026-09-09 — Deppy-aibox Claude publisher fallback (implemented locally)

### Objective and completed work
User asked to integrate `/Users/jr/Desktop/projects/Deppy-aibox` so the publisher can use Claude when Codex fails. Implemented in the existing private connect-agent, preserving the current publisher/reviewer separation and publication guards. Local app and connect-agent have been rebuilt/recreated; both are healthy at port3200 (web loopback only). Other five worker services remain healthy and unchanged; publisher already delegates classification to the broker.

- Vendored the actual aibox core and Claude provider from commit `814144a2d37cb60359486219393f93f32c7267fc`, with Apache-2.0 license/provenance. Did not edit the sibling repository or add its unrelated server/webhook/Naver components.
- Added Claude `setup-token` PTY login, official OAuth URL, transient authorization-code input, encrypted token storage alongside existing full Codex refresh credential, and credential generation invalidation.
- Added isolated Claude classification adapter consuming the same strict category schema. Default new selection is Spark xhigh → Claude Sonnet high; existing applied configurations are preserved. Explicit preset button selects this policy.
- At least one selected model must pass a real sample probe before config apply; a failed Codex probe does not block a verified Claude fallback. Both failures reject apply. Runtime primary failures (auth/timeout/CLI missing/invalid output and other errors) invoke fallback; both failures retain the established approved/hold policy.
- Actual recent attempt model distinguishes Sonnet from Codex. General observations preserve login provider, not OAuth URL/code/token. Authorization input is omitted from audit.
- Codex cancellation previously killed the wrapper only, leaving a child CLI and a permanent busy login. Both login providers now run in detached groups and cancellation/expiry kills the group; CLI-close drains the lock.

### Files in this phase
`lib/vendor/deppy-aibox/{core.ts,claude.ts,LICENSE,README.md}`; `lib/operations/{claude.ts,agent.ts,contracts.ts}`; `lib/crawl/classify.ts`; `scripts/connect-agent.ts`; `app/admin/status/{AiConnection.tsx,OperationsCenter.tsx,actions.ts}`; `Dockerfile`; `tests/{operations-claude.test.ts,operations-agent.test.ts,operations-actions.test.ts}`; `docs/operations/operations-center-runbook.md`; this handoff. Existing large dirty admin implementation/unrelated work remains uncommitted; do not indiscriminately stage/revert it.

### Decisions and limitations
- No Redis/new service/schema migration was required for this phase. Both credentials use existing AES-GCM vault/volume; no credentials were printed or placed in web env.
- Claude inference receives OAuth token only in that child environment, isolated HOME/config, no ambient API key/proxy/customizations, no tools/MCP/session persistence. Review worker token/model remain separately configured.
- Claude Sonnet is the installed CLI alias, not a promise of a specific dated model. Actual account access requires the in-app model test.
- Local QA generated OAuth URLs/device codes, then cancelled only QA-owned sessions; no user account was approved and no live authenticated Claude inference was claimed. Unit tests use dummy credentials and structured CLI fixtures.
- User must connect Claude under `/admin/status` → AI 연결, enter the official authorization code, select Spark → Claude preset, run model test, then apply. Current automatic fallback capability is deployed but no account/model configuration was authorized by the assistant.

### Verification actually executed
- `npx vitest run`: **88 files / 655 tests passed**, `/tmp/nomorevibe-claude-tests.log`.
- `npx vitest run --config vitest.integration.config.ts tests/integration/operations-center.test.ts tests/integration/review-publication-gate.test.ts`: **2 files / 12 passed**, `/tmp/nomorevibe-claude-integration.log`.
- `npx tsc --noEmit`: passed after final source changes.
- Targeted ESLint for operations/UI/RPC/tests: passed. Vendored original provider has one unused `_ctx` warning when explicitly included, no errors.
- Docker worker and runner builds passed. Final local deployment: `python3 /tmp/nomorevibe-operations-deploy.py connect-agent`, then `... app`. Helper retains existing env without printing secrets; encrypted volume preserved. Live expired old Codex login was observed before broker restart.
- Actual pinned Claude2.1.263 in worker image: official OAuth URL generated, inputRequired=true; cancellation drained entire process group. `/tmp/nomorevibe-claude-cli-qa.cjs` via `docker run --rm -i --init --entrypoint node nomorevibe-worker:operations-v2-20260909 --import tsx - < /tmp/nomorevibe-claude-cli-qa.cjs`.
- `node /tmp/nomorevibe-claude-ui-qa.cjs`: passed real Claude URL/input, invalid-code inline feedback, close/resume/cancel; real Codex device code + cancellation; preset values; 1280/390 widths without overflow; zero browser page errors. Screenshots `/tmp/nomorevibe-claude-{1280,390}.png`.
- `git diff --check`: passed.

### Failed approaches corrected
- Initial aibox PTY startup failed `This account is not available`: worker's passwd shell is nologin. Added explicit isolated `SHELL=/bin/sh`, plus util-linux package for Linux `script`; real startup passed afterwards.
- Initial TS errors from aibox optional capture results/ProcessEnv NODE_ENV contract were corrected.
- First token-redaction assertion expected a string even when provider deliberately omits `.out` after token detection; corrected assertion; capture credential still verified.
- Docker bind mount from host `/tmp` resolved to a directory under this Docker context. Switched diagnostic script transport to stdin; no source/runtime workaround needed.

### Remaining / exact next commands
User account approval and actual model access test remain user-operated in the admin UI; do not automatically approve OAuth or claim live AI output. No commit/push in this phase. Before any broker restart, inspect login state and avoid interrupting an active user approval:
```
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select observed_at,value->>'busy',value->>'connected',value->>'claudeConnected',value->>'configVersion',value->'connection'->>'state' from operations_observations where key='connect-agent'"
docker ps --filter name=nomorevibe --format '{{.Names}} {{.Status}} {{.Ports}}'
npx vitest run tests/operations-agent.test.ts tests/operations-claude.test.ts tests/operations-actions.test.ts
```
Do not run the real-login QA script while the user is authenticating; it intentionally starts/cancels its own login sessions.

## 2026-09-09 — Follow-up: Codex visibility, Claude Enter protocol, readable operations UI

### Objective
User reported at `http://localhost:3200/admin/status`: cannot tell whether Codex connected, cannot set models, Claude still cannot connect, UI unreadable. Asked whether aibox was actually reused. Fixed the integration defects and redesigned the existing AI tab and operations typography, then deployed locally.

### Root causes (observed, not inferred from prior claims)
- Live DB showed `connected=true`, generation1, configVersion0, no model verification. Codex had successfully connected; the user lacked a clear distinction between stored credential and usable/applied model.
- A Claude login held the single CLI lock for10minutes. Frontend disabled the entire model fieldset while any login was pending, with no clear reason; status polling could stop permanently after an error.
- Deppy-aibox USAGE.md lines216/282 use `sendInput(code + '\r')`. Our integration sent LF (`\n`). Actual pinned Claude CLI diagnostic reproduced **LF_error=false / CR_error=true** with a deliberately invalid code: LF did not submit, CR caused a rejection response. This is an integration bug; the previous fixture accepted any stdin and missed it. The regression fixture now requires byte13 and was run failing first (`exchanging` instead of `stored`).
- Core/provider-claude are actual vendored aibox modules. Entire server/client/React SDK were NOT imported. Explained this distinction to the user; preserved existing broker ownership/access control/vault architecture rather than rewriting the project.

### Completed / modified files in this follow-up
- `lib/operations/agent.ts`: CR submission,45s exchange deadline, safe OAuth rejection classification and process cleanup. Rejected/timed-out reconnection preserves existing credentials. Added per-provider stored/checked metadata, `probe(provider)` async real model response check, and computed `configReady` independent of stored credential/verification.
- `lib/operations/contracts.ts`: optional backwards-compatible account metadata, configReady, safe connection error code.
- `scripts/connect-agent.ts`, `app/admin/status/actions.ts`: privileged probe RPC/action, observation carries safe error/provider only; no credential/code content in audit.
- New `app/admin/status/useAgentConnection.ts`: mount/focus/3s visible-tab polling, retry after error, preserve last known state and drafts, reject older overlapping response after mutation. Initial load is scheduled/cleaned with an effect timer (direct async callback initially tripped the React lint rule).
- `app/admin/status/AiConnection.tsx`: account rows with stored state/actual response/time, individual connection check and reconnect buttons; login reason/cancel shown inline; model selection remains editable during login; actual execution remains serialized. Clearly separates model draft, sample verification, application and recent execution. Technical generation/version metadata moved into details. Claude modal shows code entry, exchange progress, safe failure reason and new-session retry; Codex has code copy. Displays transport errors inside dialog too.
- `app/admin/status/operations.css`:14–15px operational body/labels,13px minimum badges/metadata,44px controls, darker muted text, structured account/model/result layout, responsive grids. Desktop/mobile visually inspected.
- `app/admin/status/OperationsCenter.tsx`: alert based on applied config, not just Codex credential; redundant global alert hidden on AI tab.
- `tests/operations-claude.test.ts`: CR-sensitive success, rejected-code preservation, account probe vs apply separation. `tests/operations-actions.test.ts`: probe respects admin gate.
- `docs/operations/operations-center-runbook.md`, this handoff updated.

### Tests actually executed / results
- CR-sensitive regression before fix: FAILED as expected (exchanging instead of stored), `/tmp/claude-enter-regression.log`.
- Actual isolated Docker pinned Claude CLI input comparison: `{"LF_error":false,"CR_error":true}`; `/tmp/claude-enter-diagnostic.cjs`. No real OAuth code/token printed.
- `npx vitest run`: **88 files /657 tests passed**; `/tmp/ops-connect-all-tests.log`.
- `npx tsc --noEmit`, targeted ESLint, `git diff --check`: passed.
- Worker and web Docker builds passed, tags remain `operations-v2-20260909`. Only local app/connect-agent changed. Encrypted vault preserved.
- `node /tmp/ops-connect-current-qa.cjs`: real localhost browser passed stored Codex vs unapplied config, model editing during active Claude login with execution reason, actual Claude invalid-code rejection (CR reaches real CLI), automatic recovery after deliberately aborted status request,4 widths1440/1024/768/390, no page errors. Initial attempt used incorrect getByLabel selector; changed to role=combobox matching the actual accessible name. Initial probe wait matched '미검사' too early; corrected script to match timestamp paragraph. Live DB and final separate test confirmed actual probe success.
- `node /tmp/ops-model-verification-qa.cjs`: **actual Codex Spark sample succeeded**; after broker restart its saved probe result remained visible. Live selected-model verification succeeded for Spark, returned auth-required for unconnected Claude, and **Apply button became enabled**. Config was NOT applied as part of this diagnostic. Desktop/mobile final layout passed with zero page errors. Screenshots `/tmp/ops-connect-final-{1440,390}.png`; earlier four widths `/tmp/ops-connect-after-*.png`.
- Re-ran no publication integration suite this follow-up: publication guard/queue behavior unchanged. Prior12 integration tests remain prior-phase evidence, not newly executed evidence.

### Live state / remaining
Local web `http://localhost:3200/admin/status` and connect-agent healthy. Codex connected with actual Spark response success. Claude still has no stored OAuth token; user must reconnect through official page. Verified config in live broker is Spark xhigh → Sonnet high; results Spark success / Sonnet auth; configReady=false, configVersion0. User can Apply current verified policy, or connect Claude then re-test/apply (reconnection changes generation).
Do not claim Claude account authorization succeeded: only actual CLI submission/rejection plus fixture credential persistence were tested. No user account approval or product publishing was performed in this diagnostic. Latest QA-owned failed session was cleared by broker restart, before final model verification. No active login remained at completion.

No commit/push. Dirty tree includes earlier admin implementation and unrelated files; do not bulk revert/stage. Do not restart broker while user is approving Claude now.

### Exact next commands
```
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
docker exec nomorevibe-db-1 psql -U nomorevibe -d nomorevibe -Atc "select observed_at,value->>'busy',value->>'connected',value->>'claudeConnected',value->>'configReady',value->'accounts',value->'verification'->>'state' from operations_observations where key='connect-agent'"
npx vitest run tests/operations-agent.test.ts tests/operations-claude.test.ts tests/operations-actions.test.ts
```
Real browser scripts initiate login/model probes and must not be rerun during the user's approval session. Local deploy helper remains `/tmp/nomorevibe-operations-deploy.py`; app/connect-agent image builds use Dockerfile runner/worker targets. Preserve existing env/vault when deploying.

## 2026-09-09 10:43 KST — User asked to check Claude again
- Live check: `claudeConnected=false`, previous Sonnet result `auth`; broker healthy. No valid Claude account credential exists, so actual authenticated Sonnet inference remains unverified.
- Re-ran `npx vitest run tests/operations-claude.test.ts`: **15/15 passed** (`/tmp/claude-current-check.log`); includes CR submission, persistence with fixture tokens, rejection handling and fallback. These are not live authenticated model calls.
- Opened the local admin AI tab in the CUA in-app browser and initiated a fresh Claude login. UI visibly shows official Claude OAuth URL and authorization-code field. Live state `provider=claude,state=awaiting_approval` at10:43KST.
- **ACTIVE USER HANDOFF:** Claude connection window shown to user. Do not cancel this session, restart connect-agent, or run login QA while they are approving. Session expires10minutes after start (~10:52KST). Browser `browser` binding ID1, `adminTab` tab1, marked handoff. Mark again if reused in another turn.
- User must approve through the official page and input the resulting code in the local modal. After connection is stored, use the Claude account's `연결 확인` to test actual Sonnet; then selected model test/apply according to user instruction. Do not assume verification from the fixture tests.
- No application code/config changed or model config applied this turn; only this handoff updated. The browser create-tab operation unexpectedly took~12minutes; no service failure was observed.

## 2026-09-09 — Commit preparation requested by user
- Commit scope: persistent admin shell/operations center, jobs/manual classification, private Codex/Claude connect-agent and aibox provider integration, local admin access needed by the tested setup, migrations, documentation and associated tests.
- Existing unrelated ProductHero/product-detail test edits and `nomorevibe-final/`, `nomorevibe_final.html`, `nomorevibe_final_source.zip` remain outside this commit.
- Most recent verification: full unit suite657 passed; Claude-focused15 passed; TypeScript, targeted ESLint, Docker builds and browser checks recorded above. No application code changed after those checks; commit preparation uses staged diff validation.
- No runtime restart, authentication cancellation, model application, push or deployment requested/performed as part of commit preparation. Preserve any active Claude user approval.
