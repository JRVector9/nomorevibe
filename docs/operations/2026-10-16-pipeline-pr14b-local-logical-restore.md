# PR14b: isolated local logical restore rehearsal

This tool performs one explicit local PG17 custom dump/restore comparison. It does not install anything, contact Oracle, start workers, migrate a target, drop an existing database, or enable DR. Every report retains `readiness: "unknown"` and `automaticDrAllowed: false`. A successful data comparison alone cannot establish writer fencing or safe promotion.

## Fixed scope and prerequisites

The source and target must be newly allocated, distinct, root-managed local fixture containers. The caller supplies both root-created metadata files, an absent output directory, and three positive byte limits. Metadata is not a boolean bypass: the tool compares the exact running container ID/name/scope/volume/image/loopback binding/memory against Docker inspect before connecting. It accepts only the pinned PG17 image in `restore_contract.py`, the fixed local database/user `nomorevibe_test` / `nomorevibe`, and the local Unix-socket CLI inside each container. No DSN, password, arbitrary SQL, arbitrary archive input, alternate CLI, container creation, or network endpoint is exposed as an option.

The metadata format is the root allocation record: `id`, `name`, `volume`, `port`, `scope`, `image`, `state: "created"`, `sourceHead`, `memoryBytes`. The file must be a regular, non-symlink file owned by the invoking local account. Here “root-managed” denotes the allocating orchestration owner; it does not mean Unix uid 0 or a cryptographic signature. Metadata and Docker access remain a trusted local operator boundary.

The target must contain only system defaults, the default public schema, and plpgsql. A user relation, function/type/collation, extra schema/default ACL, large object, extension, publication/subscription, event trigger, or foreign server rejects the operation. The empty check runs before dumping and again immediately before restoring. It is not an exclusion lock against arbitrary concurrent operators. Source and target must be quiescent; an additional database client causes rejection. This local fixture constraint is not production fencing and cannot exclude an ABA writer between observations.

Source foreign tables/servers/publications/subscriptions/event triggers, user collations, and unsupported owners fail closed. User collation provider/locale/version equivalence is outside this tool's support. Only an archive produced by this same run from the trusted source can be restored. This is not an untrusted pg_dump sandbox.

## Command

Run from the repository using the explicitly allocated identities and limits:

```sh
python3 scripts/ops/oracle-dr/restore_rehearsal.py run \
  --source-identity /tmp/ROOT-ALLOCATED-SOURCE.json \
  --target-identity /tmp/ROOT-ALLOCATED-TARGET.json \
  --output-directory /tmp/NEW-PRIVATE-REHEARSAL \
  --max-source-bytes SOURCE_CAP \
  --max-archive-bytes ARCHIVE_CAP \
  --minimum-free-bytes MINIMUM_FREE
```

The placeholders are required operator values, not production defaults. The directory must not exist. It is created mode0700, files mode0600 with exclusive/no-follow opens. Existing paths, arbitrary parent symlinks, and overwritten archives are rejected. The macOS system `/tmp` and `/var` aliases are explicitly allowed; caller-created parent symlinks are not. A fully written custom archive is published with a no-overwrite hard link only after child exit0 and a streaming SHA256/byte receipt. Restore inputs are regular, no-follow files; the same receipt is checked before restoring. Failures preserve private evidence/partial files. There is no automatic retention deletion.

Fixed commands are `pg_dump -Fc -b -w`, `pg_restore --list`, and `pg_restore --exit-on-error --single-transaction -w`, with explicit local database/user. No `--create`, `--clean`, `--if-exists`, `--no-owner`, `--no-acl`, parallel restore, retry, DROP, or CASCADE is used. Owners/ACLs stay in the dump. A failed or commit-ack-unknown restore is never “cleaned” into an empty database.

The tool observes source database size, host archive filesystem free bytes, and both Docker data-volume filesystem free bytes separately. Shared Docker free space is not added twice. Unknown, insufficient, or over-limit measurements reject. Passing these explicit limits is not a peak/WAL/growth/retention or production capacity certification.

## Comparison and evidence

`restore_inventory.sql` uses fixed read-only repeatable-read SQL with UTC/ISO/hex settings. Catalog keys use schema/object/column names rather than database-local OIDs. It records relations/partition parents, columns/defaults/generated fields, constraints, indexes, functions, noninternal triggers, user types, policies, extension members/versions, sequence configuration/ownership/current values, raw ACLs, role/settings observations, and unsupported-object counts.

All rows from ordinary physical tables and materialized views are emitted without LIMIT or sampling, ordered by PostgreSQL JSONB text under C collation. Physical partition leaves use ONLY; partition roots are not counted again. Python hashes length-prefixed exact row strings and counts every duplicate, without converting numeric values through float. Empty relations remain represented in catalog. Every sequence records `last_value::text` and `is_called` without nextval/setval. Every LO page, page number, byte payload, OID/owner/ACL is represented; table LO references remain unchanged. A vector extension gets one fixed target operation after a successful strict comparison. An earlier comparison failure does not imply that operation ran.

Private files retain full SQL row frames and summaries, receipt, archive list, CLI versions, free-space observations, per-child bounded stderr, and backend observations. Source before/after must be exact. Target data and catalog must be exact for `local_restore_verified`. Raw ACL or deparse differences are not silently normalized. Database/role global settings are not installed by this tool, and ordinary database pg_dump does not include every cluster/database configuration value. The report cannot replace a complete production DDL/global-role/extension-binary compatibility review.

Both child pipes are concurrently drained with explicit caps. On timeout, interrupt, cap, or local write failure, the child is terminated, killed if needed, then actually waited/drained. Local Docker exit is distinct from PostgreSQL backend termination: unique PGAPPNAME tags are checked afterward. Original failures and cleanup failures are preserved together internally; CLI JSON exposes only fixed error codes/exit status, never stderr/query/DSN/traceback text. No backend is killed to make a result appear clean.

## Development evidence, 2026-10-16

Only the changed Python scope was tested; no full application suite/build or remote/provider/Oracle execution ran.

- Runnable contract baseline: 8 methods, 3 controls passed and 5 methods failed with 13 Assertion failures; no import/setup errors. Preserved under `/tmp/nomorevibe-pr14b-a-contract-red-20261016.log`.
- Child baseline had five Assertion failures plus two unimplemented-stub errors. The two errors are excluded from feature RED evidence. Real local-child draining/caps/timeout/short-write/ENOSPC/error sanitization were then exercised.
- An input symlink was actually accepted before the no-follow fix: one Assertion RED, then the same regression passed.
- Final offline scope: **21 PASS**; changed-file py_compile also ran. These are local unit/child proofs, not database recovery evidence.
- Two fresh root-assigned containers 55553/55554 were verified. Source only received the existing 82 migration entries through 0081, then one complete fixture. Target stayed unmigrated/empty until actual restore. No existing/retired database was accessed.
- First actual dump and restore both exited0 (archive282066bytes, SHA256 `52b684b09599de727b7e549e6d38b6bff1ad5323b8dd86fcd3ebb8d087f45bcb`). **Strict full-application roundtrip did not pass:** 46 catalog differences caused `restore_mismatch`. Source before/after, target full data, sequence configuration/current values, and LO pages matched. One difference was source database `jit=off` absent on target because this command does not restore database settings; 45 were PG17 CHECK/index/trigger deparse strings changed by reparsing cast/AND/OR forms. Apparent equivalence is not a proof. No string normalization, assertion weakening, reseed, or second dump/restore was used to report verified.
- The first negative method stopped at a prerequisite flag and made no guard API call; that failure is not a feature RED. With root approval it was made independent of strict verification using the first actual archive/identity/checkpoint. Its first actual API invocation **passed**: restored nonempty target rejected before any dump/restore, both full checkpoints unchanged, child/backend0.
- The vector operation is after strict comparison and was therefore **not executed** in the failed full-app roundtrip. Source vector data/catalog preservation is a different evidence claim.

The original failed run and its raw deltas are preserved. This PR supplies a fail-closed partial DR verification tool, not a passing full-app restore certificate. Semantic DDL comparison and database/global-setting restore policy need a separate explicit design. Exact data/sequence/LO equality does not erase those remaining failures.

Independent review found a user collation could pass both the empty-target and source-support checks. A fresh, unmigrated root-assigned container on port55556 reproduced both omissions: the same actual two-guard driver produced **2 Assertion failures**, then **2 PASS** after adding collation counts to the two checks. Its empty-database controls passed separately. The existing offline21 also passed after the change; the original roundtrip and negative-test bodies remained unchanged and were not rerun. Root independently confirmed the full raw catalog/ACL/settings checkpoint matched the agent's final checkpoint, with only the deliberately created collation differing from the initial empty baseline. There were no user relations, other database clients, tagged backends, or local children. Root normally stopped and removed only this assigned container/volume. Ports55553,55554,55556 are retired.

Evidence: `/tmp/nomorevibe-pr14b-c-collation-final-report-20261016.md`, `/tmp/nomorevibe-pr14b-collation-root-independent-proof-20261016.json`, and `/tmp/nomorevibe-pr14b-collation-root-db-cleanup-20261016.json`. The guard correction does not change the original strict46 failure. The differences classify as database setting1, CHECK37, partial index7, trigger1; exported SQL reparsing requires its own evidence before structural equivalence can be claimed.

## Scoped validation and return

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p test_oracle_dr_restore.py -k Offline -v
PYTHONPYCACHEPREFIX=/tmp/nomorevibe-pr14b-pycache python3 -m py_compile scripts/ops/oracle-dr/restore_rehearsal.py scripts/ops/oracle-dr/restore_contract.py tests/test_oracle_dr_restore.py
```

The roundtrip test class is skipped unless all three PR14B identity/output environment keys are explicit. Its source fixture requires a newly migrated isolated database, proves its namespace/keys/LO vacancy, and keeps completed source/target for independent root readback. The separate collation class requires `PR14B_COLLATION_IDENTITY` and `PR14B_COLLATION_OUTPUT`, verifies the exact independently prepared collation fixture, and only reads the database. Do not rerun either class against retired resources or reuse historical ports. Root alone owns final container/volume cleanup after readback. No DROP-based rollback exists.

Still unknown: actual Oracle ARM restore, operating scale/space/retention, cluster credentials and roles, replication/DDL/sequence/LO continuity, RPO/RTO, single writer fencing/epoch, external call drain, manual reconciliation and controlled consumer restart. Nothing in this rehearsal changes automatic DR or runtime activation.
