# PR07b — shared per-hop HTTP permit and native settlement

Owner C; WT nomorevibe-shared-http, base69512b92. Root owns Git/handoff and DB55520 lifecycle. Skills: writing-plans + TDD; Next local Vitest guide read. No remote HTTP/provider/operation. Default inactive. This is an implementation plan, not passing evidence.

## Fixed contract

`HTTP_ORIGIN_PERMITS` unset/0 retains the existing transport and makes no capacity DB query; 1 opts in; other values reject. A strict singleton DB policy maps SERVICE_INSTANCE_ID to physical host to a fixed m3/mini/oracle-osaka-smoke host enum. Global origin capacity1 and Oracle physical-host total2 are constants, never configurable increases. Unknown mapping, malformed/hash-mismatched policy, disabled/draining DB mode and replay scope reject before HTTP dispatch with HttpOriginPermitError. Test request callbacks are rejected while enabled.

Migration0079 adds disabled control, per-hop identity/owner boot/token/epoch/policy/bound/reservation rows and append-only events. One control UPDATE mutex serializes short primary TXs. Only un-dispatched reservations expire. Dispatched/indeterminate occupancy counts across policy epochs and never expires automatically. No DB transaction spans network I/O. No public ended flag, release callback or caller-supplied owner/transport verifier. Original owner may settle under drain/current policy change; a stale token cannot close another row.

The same undici engine/SSRF Agent stays in use. A private per-hop Dispatcher forwards the real handler with original receiver and records all native onResponseEnd/onResponseError calls, including any internal sequential dispatches. Capacity closes only after undici fetch settles, every native dispatch ends, and owned reader/read/cancel settles. Cancellation failure is sticky and retains occupancy. Abort requests cancellation, preserves original abort error and waits for actual cancellation/read. Bodyless response still needs native termination. Crash/unknown terminal retains charge; no operational force-release or durable recovery is added. Native HTTP termination proves this local transport ended, not remote model computation.

safeFetch and fetchCapped default paths both use it, every redirect obtains a new permit after successful previous-body cleanup. Existing timeout/DNS/SSRF/headers/body-cap/status semantics remain. Typed pre-dispatch capacity/config errors propagate; crawler visit defers its frontier, evidence source/media returns partial without failure/backoff. Other generic caller failure effects and activation prerequisites are documented.

## Implementation sequence and scoped verification

1. Preserve original fetch source/hash and write actual loopback two-process regression using the actual exported APIs, root55520 only. Add structural0079 schema/journal/default-disabled migration. Baseline existing source must yield same-origin peak2 where expected1; normal disabled/control succeeds. Freeze original driver/log/SHA. Missing import/SQL/setup failures are not feature RED.
2. Implement strict policy + short TX private reservation/begin/indeterminate/settlement and native/body adapter. No standalone ledger-only completion claim.
3. Same frozen driver GREEN. Extend scoped matrix: two executors/two hosts, Oracle sum2 across origins, safe/capped redirect/body hold/cancellation, unknown host/config dispatch0, disabled DB0, native error and stale original owner/epoch retention, append-only and rollback. Actual loopback only, no fake positive authority.
4. Minimal caller defer classification and focused regressions. Preserve PR07a original17 + existing net tests. Run only changed-range unit/integration, tsc and scoped ESLint; no manual whole suite/build.
5. Retain every API/child/setup/hook Promise until allSettled; unblock transport before awaiting. Test owner cleanup only exact own IDs, append-only no_change temporarily disabled in same owner TX, no_truncate remains ALWAYS. Restore original control/raw microsecond rows and ACL. Root owns final readback/STOP/cleanup.

## Files

lib/net/fetch.ts; new lib/net/http-transport.ts, http-origin-policy.ts, origin-permits.ts; new lib/db/http-origin-schema.ts plus schema export; drizzle/0079_http_origin_permits.sql and meta/_journal.json. Scoped new unit/integration + child fixture; minimal lib/crawl/jobs/fetch.ts and lib/domain/evidence/refresh.ts catch classification with corresponding tests. No B AI2/replay source edits or replay role grants.

## Limitations / activation

No environment/DB activation, production deployment, Oracle host discovery, scheduler startup policy, crash reconciliation, fairness queue, model slot transport, B5 item certificate or external model termination proof. Capacity wait uses existing caller AbortSignal; expiry while waiting is typed capacity error rather than a website failure. Remaining unclassified generic catches are activation blockers. Per-PR results are scoped evidence only; final integrated whole suite is root's later step.

Canonical Oracle mapping is oracle-osaka-smoke = surfguide / ap-osaka-1 / osaka-smoke. Oracle sum2 is unconditional for that fixed host; there is no classification array or numerical override. Operator mapping is not hardware attestation; operational verification is an activation gate.
