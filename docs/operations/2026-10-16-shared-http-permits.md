# Shared HTTP permits — inactive PR07b implementation

The default is inactive: unset/`0` `HTTP_ORIGIN_PERMITS` uses the previous transport/local queue and never queries the permit DB. `1` selects the shared per-hop adapter for both `safeFetch` and `fetchCapped`. Any other value fails closed. No deployment or operational setting was changed.

## Authority and lifetime

The operator-controlled policy is exactly `{version:1,instanceHosts:{"example-instance":"m3"}}`. Hosts are only `m3`, `mini`, `oracle-osaka-smoke`; Oracle means **surfguide / ap-osaka-1 / osaka-smoke**. Runtime `SERVICE_INSTANCE_ID` must match this map. The map is configuration, not hardware attestation. Global origin1 and Oracle physical-host total2 are fixed in SQL/code; there is no policy classification array or numerical override. M3/mini have origin1 without an additional host total in this phase.

Migration0079 creates disabled control, hop identities and append-only events. A primary short transaction serializes reservations via the control mutex. Reservation TTL5s applies only before dispatch; `dispatched`/`indeterminate` charges remain across TTL, policy epochs, restarts and drain. There is no public release/ended assertion or force recovery API. Owner instance, process boot UUID, random token, origin, host, epoch/revision and policy hash are all compared for historical settlement.

The private adapter uses the existing undici engine and SSRF Agent. It forwards native handler methods with their original receiver and tracks every actual native dispatch. Release requires the raw fetch Promise, all native `onResponseEnd`/`onResponseError` callbacks, and the owned body/read/cancel to have settled. Synchronous dispatcher throws do not count as native termination. Reader-cancel rejection is sticky indeterminate, even when native response-end was observed. The error is preserved; no later EOF or TTL can free that charge. Plain native connection failure with all native terminals observed can release normally.

Enabled background requests use the shared queue directly. Disabled requests keep the original local queue. Redirects acquire separately after successful cleanup. Existing DNS/SSRF checks, headers, caps, native statuses including999 and HTTP/abort results remain. Test `request` callbacks are rejected while enabled. HTTP local resource termination is not remote model compute termination or a model-capacity release proof.

## Capacity errors and actual callers

`HttpOriginPermitError` propagates from the two public APIs. A rejected acquire/begin dispatches no HTTP **for that hop**; earlier redirect/source operations are not rolled back. Caller audit is also preserved at `/tmp/nomorevibe-pr07b-c-caller-inventory-20261016.txt`.

| Caller | Current classification / boundary |
|---|---|
| `lib/crawl/jobs/fetch.ts` visit catch | Typed permit errors return existing deferred outcome; `deferFrontier` restores the claim without `markFailed`, attempt consumption or source save. Normal done:false request acknowledgment semantics remain. |
| `lib/domain/evidence/refresh.ts` source and media catches | Return incomplete via existing `finish(true)` without source failure, completed-key, retry increment or media6h backoff. Existing successful earlier facts stay committed. |
| `lib/jobs/products/uptime.ts:131` | Initial fetch is outside the body catch; permit rejection reaches runner before `recordPing`/auto-ban. Secondary body/meta-refresh catch retains the already observed initial200 and omits only its optional sample. |
| README `readme.ts`/`readme-refresh.ts` and `jobs/review-document.ts` | Permit errors propagate before new review claim/model dispatch; outer job failure classification is not converted to a new deferred outcome here. |
| `jobs/products/repo-review.ts` | Initial fetch rejection propagates through allSettled before that product's save; a secondary page/meta-refresh catch preserves its already observed response with incomplete evidence. |
| `domain/media/images.ts`, evidence link/feed/site-fingerprint helpers | Raw fetch rejection propagates to the evidence partial catch above; parsing/image-normalization catches occur later. |
| `domain/products/og.ts`, `register.ts`, `verify.ts`, `readme-content.ts`, `thumbnails/resolver.ts` | Existing generic catches can still map a capacity hold to missing image, unreachable/verification failure, unavailable content or thumbnail fetch_error. These are explicit activation blockers for those service roles. |
| `news/refresh.ts:126` and Show HN/backfill scripts | News generic collection catch can count a hold as failed; Show HN/backfill can fail their outer job. No claim of universal waiting-without-failure is made. |

## Activation prerequisites and remaining limits

All participating process instances must use the same DB and opt in consistently; disabled processes do not participate in the shared limit. Verify physical host mapping, policy hash, narrow runtime table privileges, existing work ownership and these caller-specific defer contracts before enabling any role. Operator rollout/mapping and policy updates while work is active are not performed here. Crash/unknown charges are reconciled only by the PR15d operator CLI (`scripts/ops/dr/promotion.ts reclaim`, migration0099, runbook `docs/runbooks/dr-stuck-reclaim.md`): a `dispatched`/`indeterminate` hop becomes `released` only when every child group of its owner (instance, boot) that could have dispatched it was recorded gone by ESRCH after group SIGKILL; the `released` event stores that evidence. Hops of processes without a recorder or with a live group stay charged and are listed with a reason; time expiry is never evidence. The same CLI may release an `indeterminate` model slot from the owner's recorded gateway local end (`local_call_ended`), but a provider_bound budget also needs a proven hard deadline D; this HTTP permit release is still not a model-capacity release proof.

Reserve mutex acquisition uses NOWAIT and signal-aware50ms polling, with each rejected transaction actually rolled back. DNS preflight, lazy module initialization and DB pool/connection waits are not claimed to obey a strict end-to-end100ms deadline. Begin/finish retain ordinary DB bounds. Actual direct runtime pool readback was lock_timeout5s/statement_timeout15s; the raw admin DB defaults were0. `pool.ts` supplies those settings on direct connections. PgBouncer deliberately omits session settings; the runbook's DB-role lock_timeout5s setup must be verified before activation (no remote observation in this task).

Only scoped tests ran: actual loopback18 and changed-range unit103, TypeScript and scoped ESLint. Two host labels were tested with isolated local processes; this is not deployment proof on two physical machines or an Oracle1CPU throughput benchmark. No provider/inference, external HTTP, whole-suite/build, B5 certificate, shared model-slot integration, operational enable, Git mutation or remote process work occurred.

## Actual validation and root review — 2026-10-16

The agent executed these changed-range commands from this worktree:

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55520/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/http-origin-permits.test.ts
npx vitest run tests/http-origin-policy.test.ts tests/net-fetch-settlement.test.ts tests/net-fetch-settlement-adversarial.test.ts tests/net-fetch-deadline.test.ts tests/link-evidence.test.ts tests/net-fetch-conditional.test.ts tests/crawl-fetch-concurrency.test.ts tests/evidence-refresh-cancellation.test.ts
npx tsc --noEmit --incremental false
```

Results: actual DB/loopback **18 PASS in16.75s**, scoped unit **103 PASS in805ms**, TypeScript exit0 and scoped ESLint exit0/no warnings. The103 run preceded the isolated cancel-rejection fix; the final actual18 includes that fix. No manual full-suite/build was run. The stopped test DB must not be reconnected or recreated for repeat checks.

The original implementation allowed same-origin peak2 in two actual API processes (one control PASS/one assertion FAIL). The same initial assertions passed after implementation. Additional actual regressions reproduced nonstandard999 status loss, caller failure consumption, control-lock deadline wait, the redundant local queue and premature release after cancel rejection. Each has a corresponding passing regression. Setup/cleanup JSON binding, mock dispatcher and test-parent self-await failures were kept separately from production feature RED evidence.

Root read the production diff and new modules, migration, full integration/child driver, caller regressions, plan, report and original/final logs. The native-failure/status/deadline/cancel findings were fixed with narrow changes. No unresolved code finding remains in this inactive scope. Final `fetch.ts` SHA is `4d69efc5bf90feb8627df5b4209f92083e69d0cd7e3557b1cda31c3ded176e45`; adapter SHA is `27bc981c1bb3a6e4a552d27a69de5bd2dd9e1522e39e900d0a5cd57b3a7ceb4c`.

Root independently ran read-only baseline/catalog verification:82 public tables matched raw values exactly, stage timestamps/modes remained legacy/epoch1/contract0, control was disabled/null, hops/events and other connections were0, and append-only triggers were ALWAYS. The dedicated55520 container then stopped normally (exit0/OOMfalse). After verifying no foreign volume references, root removed only its exact stopped container and owned volume. Evidence is `/tmp/nomorevibe-pr07b-root-final-readback-20261016.{json,log}` and `/tmp/nomorevibe-pr07b-root-cleanup-20261016.json`. These are cleanup checks, not a full DB test-suite run. Operational activation gates above remain open.
