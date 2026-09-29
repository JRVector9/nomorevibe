# Role Lease and Fencing Implementation Plan

**Goal:** Let one crawler or reviewer own an entire role while a second process waits; reject old writes after takeover. Keep standby activation disabled until all role write paths and fault tests pass.

**Design:** PostgreSQL stores one lease row per role with an epoch, owner boot, expiry and release. Acquisition uses a row lock and DB time. On takeover, the same transaction revokes every existing job token for that role. A worker can claim a job only while its role lease is valid. Result transactions continue to check the job token, so they serialize against revocation without reversing existing candidate/document/frontier/job lock order. Every crawler/reviewer write path must use its job lease.

**Files:** `lib/db/operations-schema.ts`, `lib/db/schema.ts`, generated `drizzle/0051_*`, `lib/jobs/role-leader.ts`, `lib/jobs/runner.ts`, `lib/jobs/control.ts`, `scripts/role-worker.ts`, `scripts/worker.ts`, crawler/reviewer repositories/jobs, dedicated integration tests, operations docs.

## Tasks

1. Add an additive role lease schema and test simultaneous acquisition, renewal, expiry, takeover, and release mismatch with two DB clients.
2. Gate job claims with role ownership and atomically revoke old job tokens on takeover. Test a paused old result transaction, cursor save, and new owner claim.
3. Wrap the existing supervisor in a primary/standby candidate loop. Test first restart preference, renewal failure, termination and replacement, and two standby contenders.
4. Pass job leases through all crawler/reviewer write paths. Test old owner fetch, judgement, review, second review, audit and cursor writes after takeover; preserve administrator writes.
5. Enable only after isolated crash/restart and rolling release tests. Then deploy scheduler redundancy, crawler standby and reviewer standby in that order.

**Gate:** A green lease test alone does not make standby safe. All writer paths and operational fault cases must pass before enabling a second candidate.
