# Task workload-pool contract (PR1)

This adds configuration and a read-only selection hint. It does not enable any
production pool, change capacity limits, run a migration, or claim a throughput
increase. Existing fallback ranks remain in `ai_task_models`, with rank 1..3.
The initial capability list is review2 + text7. Other tasks reject pool saves
until their actual adapters are connected in later PRs. Ensemble/comparison is
not part of this contract.

## Storage and saves

Migration 0165 creates task/slot execution configuration and independent pool
members (positions 1..4). No configuration rows are inserted. Connection FKs
protect references; members have stable UUIDs and configuration has a CAS
revision. Switching to fallback retains the inactive pool while execution uses
the existing ranks. Neither save changes an in-flight reservation or binding.

The migration also creates the immutable AI2 selection association requested by
PR2. There is one association per existing `second_reviews.id`, no backfill and
no live member/config FK. Its TypeScript schema and actual enqueue/gate wiring
belong to PR2. This association does not create extra votes.

`saveAiTaskExecutionConfig` reuses the existing contract preparation and resource
save functions. New contracts still use the existing endpoint readback/one-token
probe, and the existing compatible-route append. No model requests are issued by
reading configuration or choosing a member. Device limits, role priorities and
provider budgets are not increased by adding members. API model root metadata
identifies endpoint aliases; ambiguous multiple IDs without root evidence are
refused. Identical CLI provider/model across connections is refused because the
existing CLI contract identity cannot distinguish them. CLI catalog IDs do not prove
weight independence; PR2 applies a separate conservative veto to ambiguous
provider/tier aliases rather than declaring them independent AI2 votes.

## Reads and integration APIs

- `ai-task-execution-config.ts`: shared capabilities, strict input and safe types.
- `ensureAiTaskExecutionConfigs()` then `readAiTaskExecutionConfig(task,slot)`:
  server-only runtime snapshot, including decrypted connection credentials in
  memory. Never send runtime members to the browser.
- `readAiTaskExecutionAdminViews()`: two table reads in one primary snapshot for
  every task/slot. No connection credentials. Pages reuse the existing connection
  DTO rather than reading connections once per slot.
- `chooseTaskWorkloadMember(config,candidates,{preferIdentity?,executor?})`:
  returns one candidate plus task/slot/config revision/member ID and observed
  policy generation, or null. The optional existing transaction avoids taking a
  second connection while AI2 enqueue holds domain locks.

No-row becomes fallback only after a successful snapshot read. Initial read
failure throws `assignments_unavailable`; it never becomes an invented fallback.
Refresh failure retains known last-good configuration rows and reports an error.
A missing configuration plus a refresh error also closes admission. Existing
explicit unit fixtures can pin legacy fallback; this exception is test-only.

The selector reads exact route/provider/ledger-model tuples and groups them using
existing policy. It reuses `deviceStateSql`, role fit and helper conditions;
indeterminate is not treated as physical occupancy. Equal observed pressure
rotates among eligible members. This observation is not a reservation: competing
selectors may race, and only existing `requestSlot`/domain claim/dispatch
transactions authorize calls and enforce device limits. It promises neither an
optimal idle assignment nor any speedup. A waiting/resume preference is never
silently moved to another identity; an unavailable preference returns null.

Text integration (`ai-task-resolver.ts`) belongs to PR3. Review resolution,
AI2 enqueue, canonical independence checks and consumer concurrency belong to
PR2. Existing pending AI2 provider/model/vote assignments remain unchanged.
Pool observation metadata is separate from legacy rank counters. The four-member
limit is not a stage concurrency limit.

## Validation and rollout

Per the user's instruction, this PR adds no tests and runs no manual tests,
model probes, production reads/writes or migration. Required repository CI still
runs. Do not record manual validation as passed.

Migration 0165 must be applied through the separate migration procedure before
runtime adapters consuming these new tables are deployed. Creating the tables
can briefly lock the referenced connection/second-review tables; no historical
ledger CHECK, dispatch or terminal rule is rewritten. No pool is activated by
migration. Normal deployment, explicit operator configuration and user validation
remain separate steps.
