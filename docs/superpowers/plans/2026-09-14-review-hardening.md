# Review integrity and pipeline health implementation plan

> Execute inline, task by task, with failing regression tests before each production change. The user accepted the preceding evaluation report's fixes and requested implementation plus a current operational audit.

**Goal:** Preserve review evidence and prevent stale, duplicate or dissenting votes from becoming approval consensus; verify live collection, review, classification and publication.

**Architecture:** Keep the current Claude first reviewer and observe publication policy. Preserve bounded HTTP(S) README destinations and version the cached sample. Bind second review to a specific first attempt and source revision; use transactions and conditional writes at the result boundary. Any explicit dissent or needs_review remains human review. Canonicalize known model aliases before deduplication. Model replacement/shadow experiments are separate from fixing the running pipeline.

**Tech Stack:** TypeScript, Next.js 16.3.1 server libraries, Drizzle/PostgreSQL, Vitest, existing Dokploy deployment.

## Task 1: README evidence
- [x] Add failing cases to `tests/crawl-readme.test.ts`: distinguish `[Live demo](https://demo.example)` from `[Docs](https://docs.example)`; omit executable schemes; preserve existing bounds/NUL/image removal.
- [x] Run `npx vitest run tests/crawl-readme.test.ts` and observe the intended failures.
- [x] Modify `lib/crawl/readme.ts`, `lib/crawl/jobs/review-document.ts`, `lib/crawl/repository.ts`: keep HTTP(S) destinations, version cached README; refresh legacy cached samples without overwriting a concurrently refreshed document.
- [x] Add/execute document refresh integration tests for legacy, already-current and transient-failure cases.

## Task 2: Consensus
- [x] Add failing tests in `tests/second-review.test.ts` for low-confidence opposing first/second verdicts, explicit abstention, alias echo and duplicate voters.
- [x] Run the focused tests RED, then modify `lib/crawl/second-review.ts` and a small model-identity helper.
- [x] Agreement requires no opposing or abstaining distinct reviewer. Low confidence may prevent a supporting vote from counting but never removes dissent. Published products remain human decisions, never automatically removed.
- [x] Use the same rules in row-level status, summary and human bulk-confirmation selection.

## Task 3: Second-review input and attempt consistency
- [x] Add failing job/integration tests: stale source before call, source changes while call runs, first-model/attempt replacement with identical semantic input, resolved row receiving a late result.
- [x] Bind queue rows to first attempt; retain history and invalidate superseded generation. For published sampling, capture source identity when reviewed and guard result storage against change.
- [x] Stop before model calls when pending row no longer describes the current first verdict/input. Recheck under candidate/document/scan/row locks before writing; never overwrite resolved rows.
- [x] Test races in the dedicated local test DB and preserve job lease cancellation behavior.

## Task 4: Model identity and reuse
- [x] Add failing integration tests that a successful/failed prior model cannot satisfy or exhaust another model's claim.
- [x] Scope success reuse/retry budgets to provider and model; scope active-model selection and enforce approval consistently. Keep deterministic rules as their own provider.
- [x] Exclude first-model echoes before enqueue/call and from outstanding pending counts.

## Task 5: Operational audit and completion
- [ ] Read-only snapshots of jobs/heartbeats/queues/recent success and failure counts before and after changes; compare progression across elapsed time.
- [ ] Inspect collection, first/second review, classification, publish, AI evidence scans, media, daily stars and news jobs. Distinguish human backlog, upstream failure and stopped worker.
- [ ] Run related unit and integration suites, typecheck/lint, isolated build and review the final diff. Never run reset fixtures against production.
- [ ] Ship only task files through the existing release workflow once checks pass; verify actual worker release and live job progression. Preserve unrelated Hero/design/news prototype changes.
- [ ] Save report and update `docs/CODEX_HANDOFF.md` with executed tests, exact deployment state and any remaining operational limitations.
