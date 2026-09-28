# Worker failover P3 implementation plan

**Goal:** Extend the proven single-active primary/standby failover to publisher, maintenance, and text, in that order, and recheck crawler/reviewer behavior.

**Architecture:** Reuse `role_leases`, `role-worker.ts`, the existing supervisor, and the job lease. One primary on M3 owns each role; one mini candidate stays passive until election. Every database write made after a role change must reject the previous job token. A progress alarm must require eligible work and lack of persisted progress; a slow shared provider alone must not move work to another host.

**Tech stack:** TypeScript, Vitest, PostgreSQL 17, Docker Swarm, Dokploy.

## Baseline and shared gates

- [x] Check the current code, running app commands, job queues, DB output, and P2 rollout record.
- [x] Run the existing role unit tests. Result: 3 files, 21 tests passed.
- [x] Run existing role integration tests against the dedicated `localhost:55435/nomorevibe_test` database. Result: 3 files, 14 tests passed.
- [x] Write failing parser/progress/fencing/liveness tests before implementation, then run them green.
- [ ] Before each live transition, check the deployed image commit, release tag, DB pool limits, primary/standby credentials, and the existing crawler/reviewer owners.
- [ ] After each transition, test child death, primary service loss, standby election, late-write rejection, failback, and persisted job output. Leave the service in primary-active/standby-passive state.

## Task 1: Publisher

**Files:** `scripts/role-worker.ts`, `lib/operations/worker-progress-query.ts`, `lib/crawl/publish.ts`, `lib/domain/products/og.ts`, relevant tests, deployment documentation.

- [x] Add parser and real candidate process tests for publisher.
- [x] Add publisher eligible queue and persisted publication progress tests.
- [x] Add late OG write fencing test; the main product result already had job lease fencing.
- [x] Extend role candidate, progress query and OG fencing.
- [x] Run publisher, type and database integration tests.
- [ ] Deploy publisher primary on M3, then same-release passive mini candidate. Verify end-to-end publication from the new owner during controlled failover and return ownership to M3.

## Task 2: Maintenance

**Files:** `scripts/role-worker.ts`, `lib/operations/worker-progress-query.ts`, `lib/domain/products/health.ts`, `lib/jobs/products/uptime.ts`, `lib/jobs/products/search-refresh.ts`, `lib/news/refresh.ts`, `lib/news/repository.ts`, `lib/domain/products/clicks.ts`, `lib/domain/ranking/refresh.ts`, tests, deployment documentation.

- [x] Add parser and real candidate process tests for maintenance.
- [x] Add expired-token tests for ping, search copy, news insertion, click rollup/prune and ranking.
- [x] Thread the job lease through maintenance write transactions.
- [x] Add progress detection based on eligible uptime work and recent persisted ping.
- [x] Run focused tests, full integration suite, typecheck, lint and build.
- [ ] Deploy M3 primary, then same-release mini standby. Run controlled takeover and failback; measure persisted uptime/news/search output.
- [x] Record the capacity shortfall in `PENDING.md`; recent read-only sample: 19,343 websites, about 3,224 checks/hour required versus about 900/hour observed.

## Task 3: Text

**Files:** `scripts/role-worker.ts`, `lib/operations/worker-progress-query.ts`, `lib/crawl/translations.ts`, `lib/crawl/taglines.ts`, `lib/domain/products/search-profiles.ts`, tests, deployment documentation.

- [x] Add parser and real candidate process tests for text.
- [x] Add aggregate progress tests covering translation, tagline, profile generation and verification; use DB time for tagline age and ignore old provider errors.
- [x] Audit text result writes for job token and source CAS; update verification failure timestamp so saved errors count as progress.
- [x] Run focused tests, full integration suite, typecheck, lint and build.
- [ ] Deploy M3 primary and same-release mini standby with model credentials. Test controlled failover, persisted result progress, and return to M3.

## Completion and handoff

- [x] Update README, runbook, `PENDING.md` and `docs/CODEX_HANDOFF.md` with local commands/results and remaining live validation.
- [ ] Check `git diff --check`, review all diffs, pass CI on the latest base, and leave production roles and both existing P2 standbys healthy.
