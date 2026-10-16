# PR09 Uptime Observations Implementation Plan

> Execute inline with writing-plans and test-driven-development. Root owns Git, AGENTS/handoff and final migration0079/0080 journal integration. Only changed-range tests/static checks run in this lane.

**Goal:** Add disabled-by-default raw uptime observations and a conservative versioned policy that prevents uncertain regional/network failures from changing authoritative counters or causing list hiding/automatic bans.

**Architecture:** A singleton DB control selects raw/gated mode and explicitly configured physical source identities. Immutable raw rows bind UUID, actual product ID, exact URL/hash, UTC6h slot, start/end, host/region and HTTP/transport outcome. A per-generation gate retains machine hold/recheck progress independently of product_health. Existing public3/ban10 thresholds remain; listing, sweep and final commit share the gate predicate. Legacy disabled behavior stays intact.

**Tech:** Drizzle/PostgreSQL17, Zod, existing job/generation/S3 locks and HTTP helpers. No new fetch implementation, consumer, provider/model, deployed configuration or operational C.

## Owned scope

- New `lib/db/product-uptime-schema.ts`, `drizzle/0080_uptime_observations.sql`; minimal schema re-export/journal addition. Do not edit0079 or shared HTTP/evidence files.
- New pure `lib/domain/products/uptime-policy.ts` and writer `uptime-observations.ts`, narrowly shared health write helper as necessary.
- Existing `health.ts`, `uptime-auto-ban.ts`, `repository.ts` negative-list predicate, `jobs/products/uptime.ts`; narrow existing detail/inbox signal integration only if required to close an actual3-failure surface.
- New unit/integration regression files and this plan/validation document. Existing business tests stay meaningful.

## Fixed policy v1 candidate (inactive)

1. DB defaults observations=false, gate=false, sources empty. Gate requires observations. No activation API or runtime operational values are seeded.
2. Configured physical hosts are `m3`, `mini`, `oracle-osaka-smoke`. Each maps an existing SERVICE_INSTANCE_ID to an explicit region. Oracle's region is `ap-osaka-1` and deployment identity remains surfguide/osaka-smoke. M3/mini region is configured, never guessed from names. Unknown/mismatched sources cannot provide policy authority. No caller networkHealthy boolean.
3. Positive HTTP200–399 is distinct from uncertain transport. Negative evidence requires two recent successful independent origins from the observing host; three recent failing origins cause broad-network hold. This is a conservative versioned candidate policy, not an operationally validated network classifier.
4. Oracle regional403 and transport failure without independently configured regional matching negative evidence remain observation_hold. Other Oracle negatives also need independent regional corroboration and healthy evidence; absent/conflicting proof is hold. No extra probe fetches are introduced: network evidence comes only from raw observations already collected.
5. Same-generation/exact-URL, valid start<=end<=DBwall, slot=floor(start/6h), newest observedAt and a true >=6h separation are required. Same UUID replay is no-op; mismatched payload under same UUID throws; another ID in the same host/URL/slot cannot increment. URL/product generation/status/human changes cannot be overwritten.
6. Raw-only Oracle never writes health/daily. Gate-enabled holds preserve checkedAt/status/failures/downSince/daily and create durable hold+next recheck metadata. The first admitted failure cannot inherit an uncertified legacy streak. Accepted failures at6h intervals retain3/10 thresholds. Policy-only/raw evidence is not physical source authentication.
7. While gated, legacy recordPing cannot bypass observations. Negative list predicates, sweep selection and final ban commit require current generation/URL/admitted evidence matching authoritative health; evidence gaps/hold/revision mismatch fail closed. Existing unban protection, audits and CDN trigger remain.

## Execution

- [x] Add inactive schema/migration/control. Write actual existing-API RED: gated evidence gap currently increments recordPing; selects/commits old10-failure ban despite no admitted observation. Include disabled legacy control. Preserve original driver/hash/log before changing those production paths.
- [x] Implement strict raw parsing and pure candidate policy first with unit cases for ID/time/slot/source, Oracle-only403/timeout, broad outage, evidence absence, independent evidence and normal positives.
- [x] Implement transactional raw writer with control SHARE -> product lifecycle/product -> health/gate/raw state -> jobs/outbox -> last wall clock. No network inside transaction. Raw identity collision/slot duplication and stale generation are explicit results. Changes and valid daily totals commit atomically.
- [x] Wire disabled/default legacy and enabled raw/gated job paths; raw due uses slot/host and does not advance authoritative checkedAt on hold. Store a durable recheck due time instead of spinning or clearing counters. Host identity is read from existing service identity and fixed DB mapping.
- [x] Connect listing3, sweep10 and final ban predicate. Recheck gate after writes/waits with DBwall; lease/abort loss rolls back counter/raw/gate/audits/purge. Preserve human decisions.
- [x] Actual DB regressions: duplicate ID/slot/two connections; stale/out-of-order/future/<6h; URL/generation/human; raw Oracle; network/region holds and recovery; valid ten failures/audits/CDN; sweep/final gate race; lease expiry/outbox rollback; default-disabled existing business controls.
- [x] Run changed unit, uptime/relevant integration only, scoped eslint and tsc as applicable. Record actual results/failed attempts/hashes. Root owns dedicated55522 container and final readback/STOP; no other DB access.

## Evidence limits

Local HTTP outcomes are mocked while DB authority/CAS/transactions are real. This is not Oracle deployment, network classifier calibration, shared HTTP permit certification, actual host attestation or throughput/DR proof. PR07b's shared HTTP adapter is independently owned and unchanged here. Further UI rollup belongs to PR13; this PR retains explicit raw hold reason/source/time and recheck metadata for that consumer.
