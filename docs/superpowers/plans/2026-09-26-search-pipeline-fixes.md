# Search pipeline fixes implementation plan

> For agentic workers: execute inline, one isolated branch per PR; never run tests against production. The user approved the fixes from the September 26 audit and requested separate PRs plus real regeneration of mismatched profiles.

**Goal:** Fix evidence comparisons, invalidate corrected introductions, validate search model replies, and keep generated profile hashes aligned with the actual input through automatic regeneration.

**Architecture:** Four independent PRs based on main. Existing bounded worker and lease fencing remain. A profile freshness marker tracks product/evidence changes; successful generation clears it only after rechecking the current evidence. An explicit reconciliation command queues existing mismatches and resets selected exhausted work without rewriting generation hashes.

**Stack:** TypeScript, PostgreSQL17, Drizzle, Vitest, Dokploy.

## PR A — evidence comparison
Files: `lib/domain/evidence/agents/collect.ts`, `tests/agent-evidence-collect.test.ts`.
- [ ] Regression: resume a cursor containing parsed commit observations; normal compare response exceeds body cap while page2 has summary only. Expect complete with one attribution and no error.
- [ ] Red: `npm test -- tests/agent-evidence-collect.test.ts`.
- [ ] Request compare summary using `?per_page=1&page=2`, which omits first-page file patches. Validate ahead/identical/behind/diverged and preserve upstream failure/cursor behavior.
- [ ] Check real public GitHub ahead/identical/behind responses and body sizes; run collector and repository integration regressions.
- [ ] Independent review, commit, push, create PR against main.

## PR B — introduction invalidation
Files: `lib/domain/products/intro-checks.ts`, `tests/integration/intro-check.test.ts`.
- [ ] Add an old `searchKeywords` value to the corrected-introduction fixture; assert it is NULL immediately after correction, source profile removed, original introduction preserved.
- [ ] Red: `npm run test:integration -- tests/integration/intro-check.test.ts`.
- [ ] Include `searchKeywords: null` in the existing introduction correction transaction. Unchanged/claimed/manual products retain keywords.
- [ ] Green, independent review, commit, push, create separate PR.

## PR C — search reply validation
Files: `lib/domain/products/search-profile.ts`, `lib/domain/products/search-verify.ts`, related unit/integration tests.
- [ ] Generation regressions: `{}`, non-array fields and mixed invalid array items fail; valid aliases and explicitly empty arrays remain valid.
- [ ] Verification regressions: checks=[] for nonempty input, omissions, duplicates, unknown keys, non-boolean fits fail; complete keyword coverage succeeds and only explicit false removes a keyword.
- [ ] Red: `npm test -- tests/search-profile.test.ts tests/search-verify.test.ts`.
- [ ] Validate response shape before cleaning generation values; verify one typed verdict for every submitted keyword. Preserve keywords on failure and record invalid_output for retry.
- [ ] Green unit and worker integration; update old partial-response fixtures to the stricter contract. Independent review, commit, push, create separate PR.

## PR D — freshness and real hash reconciliation
Files: schema/migration, `search-profiles.ts`, profile/verification workers and tests, reconciliation script.
- [ ] Regressions: source change becomes pending immediately; unchanged values don't invalidate; note change invalidates; old generation in flight cannot clear a newer dirty marker; failure retains the hash of existing generated keywords; verification never commits against changed evidence.
- [ ] Add a freshness marker with DB invalidation covering product fields used by profileEvidence and AI audit notes. Keep marker visible until generation/reuse checks current input and commits with the lease.
- [ ] Add generation/verification input checks using the latest reviewer note. Respect transient failures/backoff and reset attempt counts when the actual source changes.
- [ ] Reconciliation command supports read-only dry run then apply, rechecks each product while locked, queues only real mismatches; it does not replace source_hash with a hash that was not used to generate keywords.
- [ ] Add bounded retry recovery for the audited six exhausted items and explicit empty-success profiles where appropriate. Do not resume the intentionally paused introduction checker.
- [ ] Unit/integration/typecheck/build and independent review; commit/push/create fourth PR.

## Release and production completion
- [ ] Keep unrelated root changes intact. Review all PR diffs and validation, merge individually, deploy affected workers/web roles, verify actual runtime source and DB schema.
- [ ] Dry-run reconciliation, apply only validated queue changes, let bounded workers generate and verify; monitor first-review latency and backoff.
- [ ] Recount successful profile hash mismatches from current inputs and pending/errors separately; complete only after the requested existing mismatch batch is processed, with unresolved upstream/model failures explicitly accounted for.
- [ ] Update CODEX_HANDOFF and release report with PR URLs, commits, exact tests, production counts and remaining items.
