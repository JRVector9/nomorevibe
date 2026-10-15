# PR01b Isolated Replay Database Implementation Plan

> **For agentic workers:** Apply the available test-driven-development procedure task by task. Parent coordinates the shared test DB and owns ledger SQL. All agents use gpt-6.1-sol/xhigh. Do not commit or run production/provider calls.

**Goal:** Return a write-capable replay client only after verifying an independently provisioned local test database, restricted role and owner-protected nonce.

**Architecture:** Reuse the pure `scripts/test-database.ts` URL guard, add environment override rejection, and dynamically import postgres only after admission. Bootstrap creates only the fixed `pipeline_replay` schema and identity marker plus a fresh restricted role in the explicitly acknowledged dedicated test cluster. A private bootstrap identity file supplies expected identity; replay artifacts cannot supply it. No singleton DB, environment mutation, migration, scheduler, publisher or public-table grant is part of this boundary.

**Tech Stack:** Node24, TypeScript, postgres3.4.9, PostgreSQL17, Vitest.

## Approved contract and alternatives

The parent approved a branded, frozen `VerifiedReplayDatabase` with `.client: postgres.Sql` and frozen public identity metadata. This keeps parent Drizzle transactions on the same client. A separate shadow domain schema/engine is unnecessary; public-named crawl tables can later be granted explicitly inside the dedicated test DB. Blanket public grants and automatic production migrations are rejected.

```ts
assertReplayDatabaseTarget(url: string, env?: Readonly<Record<string, string | undefined>>): void;
readReplayDatabaseIdentity(path: string): Promise<ReplayDatabaseIdentity>;
openVerifiedReplayDatabase(path: string, env?: Readonly<Record<string, string | undefined>>): Promise<VerifiedReplayDatabase>;
assertVerifiedReplayDatabase(value: unknown): asserts value is VerifiedReplayDatabase;
verifyReplayDatabaseSession(session: postgres.Sql | postgres.TransactionSql, database: VerifiedReplayDatabase): Promise<void>;
bootstrapReplayDatabase(options: { databaseUrl: string; identityPath: string; acknowledgeDedicatedCluster: boolean; env?: Readonly<Record<string, string | undefined>> }): Promise<ReplayDatabaseMetadata>;
```

The runtime brand uses a module-private WeakMap, not a caller-provided flag. The public metadata omits URL, password and nonce. Parent must run `verifyReplayDatabaseSession(tx, database)` first inside every write transaction because a pooled connection can reconnect. Close invalidates the handle.

I/O additionally rejects real ambient PG*/READ_DATABASE_URL/MIGRATION_DATABASE_URL even if a caller supplies an empty pure-test environment. The postgres client receives complete validated host/port/database/user/password options, with password decoding deferred only through a fixed closure; no PG routing fallback is used. The explicit environment argument can therefore accommodate the integration harness's admin DATABASE_URL while the runtime still authenticates only its separately provisioned restricted role.

## Exact bootstrap and verification

1. Require explicit admin `TEST_DATABASE_URL`, `--identity PATH`, and `--acknowledge-dedicated-cluster`. Reject unexpected arguments, remote/wrong DB/multihost/query/socket URLs, all nonempty PG* overrides, replica/migration URLs, and conflicting DATABASE_URL before driver import. Do not read .env files.
2. Reserve an exclusive0600 output file; never overwrite identity or alter a pre-existing replay schema/role. The bootstrap target must be the parent-provisioned dedicated Docker service, never compose.yml's production-mode DB. CREATE ROLE is cluster-wide, so the explicit acknowledgement and out-of-band container proof are part of the trusted operator boundary.
3. Connect with max1 and bounded connection/statement/lock timeouts. Before DDL read back exact database name, current/session user, database owner and admin role. Require unchanged session/current user, a login superuser that owns this dedicated database. Generate a fresh cryptographic role suffix/password/nonce.
4. In one transaction create fixed schema `pipeline_replay`, an owner-protected singleton `identity` table, and a LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS role with no memberships. Record database/schema/role/owner OIDs and nonce. Revoke PUBLIC database CREATE/TEMP and public schema access inside this dedicated DB; grant runtime CONNECT, pipeline_replay USAGE and marker SELECT only. No schema CREATE or public-table rights.
5. Connect as the restricted role and read back DB/session/current role, stored OIDs and nonce, schema/marker ownership, role flags/memberships and effective database/schema/marker privileges. Reject runtime ownership or non-system schema access outside pipeline_replay. Populate the reserved private file only after verification. Failed post-DDL verification never auto-drops or rebinds objects; report a fixed failure and leave cleanup to the parent.
6. Runtime reads a bounded regular file without following symlinks, requires current-user ownership and exact0600 mode, strictly parses fields, validates URL/env before importing postgres, and repeats the same read-only session proof. Any failure closes the client and returns only fixed diagnostic codes.

The nonce authenticates provisioned state within the trusted local bootstrap/file boundary. It does not prove provenance against a privileged operator or authenticate arbitrary exported JSON.

## Files and RED → GREEN tasks

- Create `lib/operations/pipeline-replay-database.ts`: admission, private identity reader, runtime brand/session proof and bootstrap function.
- Create `scripts/bootstrap-pipeline-replay.ts`: strict explicit CLI and fixed error output.
- Create `tests/pipeline-replay-database.test.ts`: URL/env rejection before mocked driver import; private-file/symlink/oversize/unknown-key canaries; forged handle rejection; CLI acknowledgement and secret-safe errors.
- Create `tests/integration/pipeline-replay-database.test.ts`: real restricted connection, same-transaction proof, denied public/marker/DDL privileges, nonce/role drift refusal and exclusive bootstrap preservation. Do not call existing integration migrations/resetters.

- [x] Write the unit and integration assertions first. Run the unit file and record actual RED before implementation.
- [x] Implement only the listed boundary and CLI; parent owns every ledger table/DDL/grant beyond identity.
- [x] Run unit GREEN and initial sequential integration on the parent-authorized DB below.
- [x] Run focused eslint, tsc and diff checks. Send parent the API and DB availability; parent updates shared CODEX_HANDOFF.
- [x] Parent verifies the additional column-grant/SECURITY DEFINER regressions GREEN and the fresh CI cleanup path against a fresh dedicated cluster.
- [x] Close the helper's admin connection on setup/release failure; preserve a provisioned private identity when cleanup fails.

## Integration harness ownership

`tests/integration/replay-setup.ts` exports `getReplayIdentityPath(): Promise<{ identityPath, release }>` using the resolved TEST_DATABASE_URL constant from existing setup, so CI does not require an optional environment variable. Explicit PIPELINE_REPLAY_IDENTITY_FILE reuses a verified endpoint-matched private file and never drops/restores any object. Otherwise each serial test file bootstraps its own fresh temporary identity; release first verifies nonce/database/schema/role OIDs and owners plus absent live runtime sessions, drops only its own schema/role, and restores normalized PUBLIC database/public-schema ACL tuples including original grantor and grant options in the same transaction. Mismatch rolls back cleanup. All runtime clients must be closed first. Admin connections close on setup/release failure; failed cleanup preserves the identity for inspection. No persistent implicit sidecar is used.

Additional meaningful tests are in `tests/pipeline-replay-setup.test.ts`. The private identity from initial authorized local bootstrap remains outside Git at `/var/folders/5g/tm96jknx43n8r04kl5j12kvm0000gn/T/replay-db-integration-ORozQG/identity.json`; parent exclusively coordinates DB access. Do not print its contents. The initial restricted role and identity marker remain for parent ledger integration.

## Authorized integration target and exact commands

Parent provisioned container `nomorevibe-pipeline-pr01b-test-db-20261015`, ID `7b15c26eeadcac76ba4f19c43233c40901016e651c38fddc62415f601653dd92`, pinned `pgvector/pgvector:0.8.6-pg17`, published only on127.0.0.1:55453. This task will not start/stop or migrate that service.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-pr01b
npx vitest run tests/pipeline-replay-database.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55453/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-replay-database.test.ts
npx eslint lib/operations/pipeline-replay-database.ts scripts/bootstrap-pipeline-replay.ts tests/pipeline-replay-database.test.ts tests/integration/pipeline-replay-database.test.ts
npx tsc --noEmit
git diff --check
```

## Actual results and remaining boundary

- Before implementation, the unit file ran RED:9/9 failed missing exports/CLI behavior.
- Initial unit GREEN:9/9; initial real integration:7/7 PASS on55453, with marker/public/DDL denial and nonce/role/schema drift checks.
- Independent review found column UPDATE privileges, callable SECURITY DEFINER routines, and actual ambient PGPORT fallback. The clock agent executed both DB canary RED cases on55453 (each1failed, remaining skipped; verifier unexpectedly resolved); canaries were reverted in finally. A no-DB unit PGPORT regression also ran RED before the fixes.
- Helper unit RED:2/2 before helper implementation. A later connection-leak regression also ran actual RED: initial ACL snapshot failure did not call admin.end(). Setup catch and release finally now close that connection. A second regression verifies failed release retains the private identity and does not reach DDL. Current two new unit files:14/14 PASS.
- Current expanded guard/CLI regression command `npx vitest run tests/pipeline-replay-database.test.ts tests/pipeline-replay-setup.test.ts tests/test-database.test.ts tests/pipeline-capacity-cli.test.ts`:4files33PASS (2026-10-15 17:52 KST).
- Focused ESLint on the six implementation/test files, whole-worktree `npx tsc --noEmit`, and `git diff --check`:exit0. Earlier lint failed on test-local variable name `module`; earlier tsc found two test typing errors plus generated PageProps and concurrent clock work. Those are resolved in the actual final checks above.
- Parent reported actual post-hardening boundary+ledger integration:24PASS on existing55453. Parent also reported fresh55454 boundary+ledger+clock integration:32PASS with no explicit identity override, exercising separate bootstrap/cleanup and PUBLIC ACL restoration. These runs preceded the final helper resource-closure correction; parent owns the full integration rerun. No DB calls were made by this agent during those runs.
- Final static review confirms the runtime uses complete validated connection options, an unforgeable in-process handle, owner-protected expected identity, per-transaction session checks, denied public-schema privileges, and checks for column-level marker mutation and callable SECURITY DEFINER drift. Test cleanup verifies ownership/OIDs/nonce before transactionally dropping only its fresh objects and restores exact normalized PUBLIC ACL tuples. No remaining blocker was found within this boundary's scope. No production/provider calls, production migration, domain grants, ledger tables or commit were made by this task. Real replay remains disabled.
