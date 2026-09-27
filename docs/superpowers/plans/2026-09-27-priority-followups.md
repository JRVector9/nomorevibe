# Priority Followups Implementation Plan

> For agentic workers: execute inline in priority order, one reviewable PR per independent behavior.

**Goal:** Enforce public repository CI and continuously detect search data failures while recovering invalid keyword verification safely.
**Architecture:** Existing job scheduler, lease runner and operations observations; read only snapshot audit; bounded chunk verification retry; protected PR delivery.
**Tech Stack:** TypeScript, Next16.3.3, Drizzle, PostgreSQL17, Vitest, GitHub Actions Node24.

- [x] Enable main protection, required check15368, secret scanning, push protection and Dependabot security updates. Verify using gh API.
- [x] Add failing tests in tests/search-health.test.ts and tests/integration/search-health.test.ts for clean data, expected dirty hashes, unmarked hashes/copy corruption, missing/hidden products, repeated failures, stalled/stale observations. Run npx vitest run tests/search-health.test.ts and npm run test:integration -- tests/integration/search-health.test.ts.
- [x] Create lib/operations/search-health-model.ts for typed counts/status, lib/domain/products/search-health.ts for bounded read-only consistent scan, lib/jobs/products/search-health.ts for periodic logging; register in lib/jobs/catalog.ts and registry.ts. Display cached job observation in app/admin/status using existing operationsData and ActionQueue. No scan on web requests. Green targeted tests, tsc and lint. Commit/push PR then wait actual CI and merge.
- [x] Add failing tests in tests/search-verify.test.ts and tests/search-job-budget.test.ts covering sequential5-keyword retry, all-or-nothing results, duplicate inputs, second chunk failure, shared total timeout, abort and shortened tick budget. Implement verifyKeywordsInChunks in domain verifier and choose it only on previous invalid_output/timeout in job. Run targeted unit and existing integration verification/hash guard tests, then frozen PR CI and merge.
- [ ] Edit .github/workflows/ci.yml for workflow_dispatch, contents read, concurrency and20min timeout with official action SHA pins. Correct PENDING/AGENTS and docs/operations CI runbook. Verify action manifests/Node24, YAML schema and real manual/PR CI; merge and verify main CI.
- [ ] Verify deployments and production health, run monitor once through existing lease runner, confirm cached observation and no false defects. Update docs/CODEX_HANDOFF.md and plan checkboxes with exact executed test counts/results and remaining limitations.

Exact next commands: cd /private/tmp/nmv-priority-followups-20260927; npx vitest run tests/search-health.test.ts; npm run test:integration -- tests/integration/search-health.test.ts; npx next typegen; npx tsc --noEmit; npm run lint; git diff --check. Shared test DB must point only to local55435/nomorevibe_test. Never use production DATABASE_URL for integration tests.

2026-09-27 execution: security #202, monitor #201, strict chunk retry #203, bounded README prefix #204 and README retention/refresh #206 merged with hosted CI. Migrations0049/0050 applied. Missing README cohort12,418 completed:10,630 stored/1,766 missing/21 no usable text/1 HTTP451/0 transient. Final recovered-product audit: blank document0/product0/copy mismatch0. Current read-only health19,354 products/2703ms, unmarked hashes0/copies0;10,265 generation jobs correctly marked after source changes and ordinary workers progressing. See docs/operations/2026-09-27-public-ci-readme-recovery.md for actual test evidence. Final CI/docs PR205 and latest deployment/manual CI remain the post-merge checks.
