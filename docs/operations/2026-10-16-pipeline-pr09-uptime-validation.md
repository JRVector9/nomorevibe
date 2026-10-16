# PR09 uptime observations — local validation

The new observation mode and negative-action gate default to disabled. No activation API, operational configuration, deployment or external HTTP request was used. The dedicated local database was `127.0.0.1:55522/nomorevibe_test`; root completed normal STOP/removal after independent readback. A separate fresh migration database inside the same owned local container was also used for the final journal integration check; no operational database was accessed.

## Result and scope

- Immutable raw UUID + product ID/exact URL + UTC6h start slot + source host/instance/region/outcome facts are distinct from authoritative health/daily counters.
- A hold retains checkedAt/status/failures/downSince/daily and records reason, next check and recheck request separately. Legacy recordPing cannot bypass an enabled gate.
- Public listing/detail health signals, the operator down preview, ten-failure sweep and final ban commit use the same current generation/revision/evidence gate. Existing thresholds3/10, human unban protection, both audits and CDN invalidation remain.
- `regional-v1` is an inactive conservative candidate policy: two distinct recently successful origins, broad failures, and independent-region corroboration for Oracle/403/transport negatives. Same-time conflicting origin facts cannot be resolved using database row order. It is not a calibrated network classifier or physical host attestation. Current safeFetch null has only unknown provenance and is never called a proven timeout.
- Source hosts are m3, mini and oracle-osaka-smoke; Oracle's region is ap-osaka-1. SERVICE_INSTANCE_ID maps through explicit control sources. This does not verify the OCI surfguide/osaka-smoke deployment or infer M3/mini geography.

## Executed checks

All commands below ran in `/Users/jr/Desktop/projects/nomorevibe-uptime-observations`. Exit codes were0 unless marked RED.

```sh
npx vitest run tests/uptime-observation-policy.test.ts tests/uptime-config.test.ts
```

24 PASS,555ms. Log `/tmp/nomorevibe-pr09-a-unit-final-20261016.log`.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55522/nomorevibe_test npm run test:integration -- tests/integration/uptime-observations.test.ts
```

Final21 PASS,5.12s total/4.34s tests. Log `/tmp/nomorevibe-pr09-a-final-fixture-21-green-20261016.log`. Includes two distinct actual waiting backends, ID/slot duplicates, stale/future/URL/status/time CAS, Oracle raw-only, network/independent evidence hold, hold counter/daily preservation, positive recovery, three-failure listing protection, valid ten failures+one ban/audits/CDN, actual handler raw-only/pre-HTTP source rejection, zero-row immutable UPDATE/DELETE/TRUNCATE, outbox failure rollback, and actual exact-holder pg_blocking_pids + DBclock lease/evidence expiry rollback.

The job-row expiry case intentionally makes runJob report job_lease_lost; the unconfigured-source case intentionally reports uptime_source_unconfigured. Both are asserted negative controls, not unhandled failures. The raw-only handler uses real runJob/record transactions and mocked HTTP/target selection; it does not certify the full production queue selector or physical HTTP settlement. The selector's same-host retry exclusion is separately exercised against real rows.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55522/nomorevibe_test npm run test:integration -- tests/integration/uptime.test.ts tests/integration/uptime-auto-ban.test.ts tests/integration/maintenance-fencing.test.ts tests/integration/pipeline-product-stage-lock.test.ts
```

89 PASS,16.41s. Log `/tmp/nomorevibe-pr09-a-existing-range-20261016.log`.

```sh
npx tsc --noEmit --incremental false
npx eslint lib/db/product-uptime-schema.ts lib/db/schema.ts lib/domain/products/uptime-policy.ts lib/domain/products/uptime-observations.ts lib/domain/products/uptime-negative-gate.ts lib/domain/products/health-record.ts lib/domain/products/health.ts lib/domain/products/uptime-auto-ban.ts lib/domain/products/repository.ts lib/domain/products/detail-view.ts lib/jobs/products/uptime.ts lib/operations/inbox.ts tests/uptime-observation-policy.test.ts tests/integration/uptime-observations.test.ts
```

Both exit0, logs `/tmp/nomorevibe-pr09-a-{tsc,eslint}-frozen-20261016.log`. Root first generated Next types, exit0, `/tmp/nomorevibe-pr09-root-typegen-20261016.log`. No full suite, full DB run, build or bundle was run.

## RED evidence and failed approaches

Before the health/job/auto-ban production changes, the original new4-case driver ran on the real dedicated DB: gated recordPing incremented2→3, the sweep selected old unproven10, and final ban committed without admitted raw evidence. These were3 assertion failures; disabled existing ten-failure audit/CDN control passed. Exit1,859ms, log `/tmp/nomorevibe-pr09-a-existing-red-20261016.log`. The same original4 later passed,500ms, `/tmp/nomorevibe-pr09-a-existing-green-20261016.log`. Original driver/source hashes are in `/tmp/nomorevibe-pr09-a-baseline-hashes-20261016.json`.

Self-review found equal-time success/failure facts from one origin could select success according to SQL row order. The unchanged expectation produced1 assertion failure/16 controls, exit1; `/tmp/nomorevibe-pr09-a-tied-evidence-red-20261016.log`. Minimal tie-negative logic closed it; final policy17 + config7 passed.

These are not feature REDs: an initial wrong hash import, initial PageProps absence, a SQL status-column ambiguity, and an outbox fault trigger that also intercepted the runJob claim. They were corrected without weakening behavioral expectations. A first direct-blocker count saw only the advisory queue head; the final two-backend driver follows transitive pg_blocking_pids and clears the holder stats snapshot. The initial0080 local bootstrap predated the policy_version field; that field was aligned once with ALTER TABLE on55522. Final0080 contains it. Root subsequently integrated0079/0080 in order and ran the final migrator on a separate fresh database in the same owned local container, then reran it: both actual exit0. Fresh readback confirmed81 journal entries, the final0080 SQL hash, disabled HTTP/uptime controls, both ENABLE ALWAYS guards and empty observations/gates. Logs `/tmp/nomorevibe-pr09-root-{fresh-migration,migration-rerun}-20261016.log`; readback `/tmp/nomorevibe-pr09-root-fresh-migration-readback-20261016.json`. This was a migration integration check, not a full test run.

## Cleanup and remaining operational evidence

### Final independent review and targeted corrections

Root reviewed the production changes and A's logs/SHA. B independently read the frozen18 files and found two boundaries: the existing reviewHash canonicalizer treats Date as an empty object, and a holder SQL error before its ready signal could leave the fixture waiting. B fixed only recorder and its DB driver after root assigned those exact files. Payload identity now hashes slot/startedAt/observedAt as ISO strings. Test-local holder waits race the actual holder promise so the original failure reaches finally and settles.

Timestamp-only same-UUID mismatch produced actual1 Assertion RED, then the affected duplicate/timestamp/valid-ten controls3 PASS. An intentional PostgreSQL22012 fixture fault produced actual cleanupReached=false Assertion RED, then the final impacted5 cases PASS/18skip2.74s. tsc/scoped ESLint/diffcheck all exited0. These are targeted follow-ups; A's21/89/24 were not rerun. Logs `/tmp/nomorevibe-pr09-b-{date-hash,holder-cleanup}-red-20261016.log` and `/tmp/nomorevibe-pr09-b-final-focused-green-20261016.log`; independent review `/tmp/nomorevibe-pr09-b-readonly-review-20261016.md`.

Final recorder SHA `adafdf559e33ac7e9015457734f3e39748761be2b8274e5077e6a699cc140efe`, DB driver SHA `e827b8ad5772a98ef173e7c369d3cb851a42c4d3bb0fb668baf3beb6844895d8`; other16 A files were unchanged before this root documentation update. B's final readback retained18 append-only test audit rows and no mutable/raw/gate/fault/other-connection residue. Root completed that fresh migration check and independently matched the final raw-microsecond stage/default-control/guard/count/connection summary to B's readback, then normally stopped the exact owned container (exited0/OOMfalse) and removed only its owned volume. Proof `/tmp/nomorevibe-pr09-root-{final-readback,cleanup}-20261016.json`. Port55522 is retired and must not be reconnected or recreated.

The fixture retains original body/child/setup promises and settles them before cleanup. Raw deletion temporarily disables only the exact UPDATE/DELETE guard in one transaction and restores ENABLE ALWAYS; the TRUNCATE guard stays enabled. Managed control/job/progress rows restore all original raw columns, including timestamp microseconds, only after a successful baseline capture. Other product/health/daily/raw/gate rows compare whole JSON snapshots. The append-only operations audit is intentionally retained, following existing integration-test convention; own mutable rows/purges and temporary fault function/trigger are removed. Root may dispose of this dedicated database.

Final readback exit0: `/tmp/nomorevibe-pr09-a-final-readback-20261016.json`. Raw/gate/own product/health/daily/evidence audit/CDN/fault objects0; control restored disabled with original revision/sources; both raw guards A; other connections0. The readback client was closed. Root completed exact owned container normal STOP/removal after the independent readback above.

Not demonstrated: Oracle raw canary, host identity/clock synchronization, policy calibration including incomplete future evidence, replica activation/readback sequencing, real network outage causality, PR07b shared origin permit behavior, deployed source configuration, throughput, long-term observation retention, or gate activation. Historical metrics remain authoritative history while holds are separate; actual deployment must establish the raw→gate rollout conditions before enabling either mode. PR13 can consume the raw/hold/age/due summary; no new admin UI is included here.
