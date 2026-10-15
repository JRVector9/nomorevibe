# PR01b isolated replay ledger implementation plan

**Goal:** Add a durable, isolated call-reservation ledger before connecting real review consumers. No provider inference or production mutation is part of the first executable checkpoint.

**Architecture:** A verified restricted database handle owns `pipeline_replay` tables. Short transactions verify the session, lock the run, charge the whole call/token reservation, and commit before a transport callback can run. No refunds. Unknown dispatch/usage closes admission. Existing v1 snapshots remain unverified; this ledger does not certify performance or accept caller-declared final decisions.

**Stack:** Existing postgres.js, Node crypto, strict Zod, Vitest, dedicated PostgreSQL17 test container. No production migration or dependency.

The user approved the overall PR roadmap and explicitly requested continued implementation. `writing-plans`, `execute-plan` and TDD apply. All agents use gpt-6.1-sol/xhigh. DB bootstrap and semantic-clock subplans have separate owners. This first checkpoint does not complete original PR01 or enable PR02 consumers.

## Files and responsibilities

- `scripts/sql/pipeline-replay-ledger.sql`: four isolated tables; no public-schema object or grant. Bootstrap administrator installs DDL explicitly after protected identity marker exists. Runtime receives only required table/column privileges.
- `lib/operations/pipeline-replay-ledger.ts`: strict frozen input/manifest binding; prepare/start/reserve/dispatch/settle/cancel/drain/read diagnostics; verified-handle transactions only. Never imports the production singleton DB.
- `lib/operations/pipeline-replay-transport.ts`: fixture-only transport harness, which records before callback and records uncertainty after callback failure. Real-model mode rejects `unsupported_provider_budget` before callback. No network implementation or hidden retries.
- `tests/integration/pipeline-replay-ledger.test.ts`: real DB transaction/concurrency/crash/binding/permissions checks in the dedicated local cluster.
- `tests/pipeline-replay-transport.test.ts`: callback ordering/failure and provider admission tests.
- Companion agent files: isolated DB bootstrap/marker API and scoped semantic reference clock. Parent integrates after independent review.

## Storage contract

`capacity_runs`: primary run ID, immutable manifest jsonb + SHA256, opaque owner UUID, state prepared/running/draining/sealed, wall started/deadline, charged calls/tokens, monotonic event sequence. Planned manifest dates are not rewritten into durable wall timestamps.

`capacity_inputs`: `(run_id,candidate_id,input_hash,source_revision_hash)` primary key, immutable frozen review input jsonb and SHA256. Freeze requires policy hash equality, recomputation of source and semantic input hashes using existing reviewHash, and freshness against manifest.referenceTime. Evidence bytes are bounded by existing review input limit.

`capacity_calls`: `(run_id,call_id)` primary key plus bound input, firstAttemptId, stage, provider/model, request SHA256 and whole-token bound. States reserved/dispatching/in_flight/settled/cancelled_before_dispatch/indeterminate. Store wall dispatch/settlement times and nullable actual token usage. Unique call IDs are never replayed or reassigned.

`capacity_transitions`: `(run_id,seq)` primary key, append-only event payload and database wall time. Initial checkpoint records lifecycle/call evidence only. Final-generation events will be added only by actual writer hooks deriving the existing gate, never from arbitrary caller booleans or JSON.

## Task 1 — actual RED, schema and fixture setup

- [x] Write integration tests using a fresh verified identity and a frozen createReviewInput fixture. Initial whole-ledger implementation was not executed RED first; actual later behavioral REDs for drain/unknown-write/lock-wait/alias/plan-budget were observed before their fixes. Transport missing-module RED is separate.
- [x] Add exact isolated DDL. The runtime can insert immutable inputs/calls/events and update only mutable run/call columns; it cannot update the identity marker or immutable manifest/input/request bindings, delete events, or access public product tables.
- [x] Parent/admin installs the DDL only in container `nomorevibe-pipeline-pr01b-test-db-20261015` at loopback55453. No production drizzle migration.

## Task 2 — reserve and dispatch with real transaction tests

- [x] Prepare validates strict manifest and frozen inputs, creates prepared run + immutable input records atomically. Start under a schema-wide advisory transaction lock refuses another running/draining or indeterminate run.
- [x] Every mutation opens a transaction on the verified raw client, re-verifies that transaction session, locks its owned run and uses DB wall time. Unknown owner/state is fixed-code rejection.
- [x] Reserve requires running, before deadline, a known frozen input, exact configured model for its stage, valid attempt/request identity, unique call ID, safe positive token bound within manifest per-call bound, remaining call/token budget and shared AI1+AI2 concurrency <=4. Commit one call and entire bound; every retry/fallback is another call ID/reservation. Reject before model/network work.
- [x] Persist draining on elapsed deadline/uncertain work; do not throw inside a transaction if its safety state must commit. Budget/concurrency waiting has no candidate failure side effect.
- [x] Dispatch transitions are CAS reserved→dispatching→in_flight with no automatic retry. Cancel-before-dispatch changes only reserved state; it releases the active slot but never refunds charged counters. A competing later dispatch must fail.
- [x] Settle only an in-flight call with known safe integer usage <= reserved total. Missing/invalid/excess usage or callback failure becomes indeterminate and run draining, retaining all budget. Duplicate/late receipts cannot replace stored outcomes.
- [x] Drain stops new reservations; sealing is deliberately unavailable in this checkpoint because actual writer/readiness coverage has not yet been instrumented. Diagnostics explicitly say fixture/call-ledger-only, not verified final throughput.

## Task 3 — fixture transport and provider refusal

- [x] Write assertion RED tests: DB reservation rejection calls callback zero times; callback sees already-committed in-flight reservation; successful usage settles; thrown/unknown usage closes admission; real-model mode always rejects before callback.
- [x] Harness accepts verified fixture run and injected callback only. It has no gateway URL, credential lookup, fetch, CLI spawn, production handler, publisher or generic provider registry. Native actual-model integration remains pending audited capability contract.
- [x] No bare manifest flag, context_length metadata, or user-provided perCallUpperBound can admit a real provider. Keep `replay` CLI disabled until complete isolation, clock, supply/final hooks and provider enforcement are verified together.

## Task 4 — review, validation and continuation

- [x] Run relevant unit + dedicated integration and inspect RED/GREEN results. Then typegen/tsc/lint/i18n/full unit/related DB/build/bundle/deploy-helper tests and independent diff review.
- [x] Record exact code/files/tests/failures, restricted DB identity proof, provider capability gap and remaining actual consumer/final/readiness work in validation and CODEX_HANDOFF. No2x or complete-PR01 claim.
- [ ] Explicit commit/push/PR from latest main; latest-base required CI before merge (submission and CI remain pending at this local validation checkpoint). No runtime rollout is needed for unused fixture tooling; production remains8020dca until a runtime activation PR passes its gates.

Test commands use only `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55453/nomorevibe_test`. The DB-boundary agent initially owns this container's tests; the parent waits until ownership is handed back. Never run integration with the default shared55435 or production/development DB.


## Local execution evidence (2026-10-15)

Final unit267files/2669PASS. Full integration151files/1657PASS/1existingTODO before last planned-budget case;
final fresh boundary+ledger+clock3files/35PASS after that case. Typegen/tsc/lint/i18n/build/bundle/Python23/diffPASS.
Independent read-only review identified and parent reproduced/fixed unknown-write, row-lock clock and exact-model issues.
The max1 runtime client serializes calls within an owner; independent verified clients prove global run-start exclusion.
No final/ready ledger, actual handler, provider inference, seal, production mutation or throughput certification is implemented.
Detailed evidence: docs/operations/2026-10-15-pipeline-pr01b-validation.md.
