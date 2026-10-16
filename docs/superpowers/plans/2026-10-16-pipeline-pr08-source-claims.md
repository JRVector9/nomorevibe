# PR08 Canonical Source Claims Implementation Plan

> Execute inline using writing-plans and TDD. Root owns Git/shared handoff and journal integration. No new consumer, provider call, operational activation or full-suite/build in this lane.

**Goal:** Let canonical site evidence progress independently of product-wide GitHub quota, with current source/policy/owner CAS and no false product completion.

**Architecture:** Add disabled singleton control and one durable canonical source lease per product generation. The existing evidence job schedules a small fair source lane and retains the existing product/provider/media lane. A fixed collector awaits full bounded HTTP; a short result transaction validates original lease/current input+policy and atomically stores evidence, captured request progress and next request. Product completion remains all-required, never source-only.

**Tech Stack:** Existing Drizzle/PostgreSQL17, Zod, product lifecycle locks, fetchCapped2MiB/parser/cache, job wall checks and product refresh progress.

## Scope and sequential ownership

A owns new source contract/control/schema/0081, canonical claim/collect/finish and scoped tests. Existing domain evidence files may be minimally adjusted. `providers/links.ts` is C-coordinated and remains untouched. C's current PR07c changes to `refresh.ts` and `jobs/products/evidence-refresh.ts` are a prerequisite: A reads but does not edit either file until root provides their frozen feature commit. PR09/0080 is root-owned; migration journal final ordering is root integrated. News/HTTP/runner/OG/register/verify/readme/repo-review/crawl/publish/replay are untouched.

## Fixed inactive contract

- Control defaults disabled, epoch1, scheduling cursor0. No env flag/activation API. Existing normal behavior remains while disabled.
- Canonical work key is product generation ID plus `documentation/canonical_site`, not an input hash. An explicit owner instance/boot, UUID token and monotonic safe epoch identify a lease. TTL90s is logical authority, not proof of external HTTP termination.
- Binding captures actual product ID/slug/URL/product updatedAt raw microseconds, current evidence settings hash+parser policy, current canonical source snapshot and active request version. Caller readiness booleans/validator callbacks are not accepted.
- Control→product lifecycle/product→settings→canonical source/request→source lease→DML→jobs/outbox→last DBwall. No transaction spans HTTP. Healthy foreign/old-epoch owners are preserved. Wrong owner/token/epoch, expired lease, source/input/policy/public-state change reject result storage; no human state overwrite.
- Source collection uses full existing2MiB fetchCapped and the explicit-link parser. Conditional304 requires same source URL, final URL, digest/parser-compatible last-good facts. Cacheless/different-final304 gets an unconditional retry; unresolved304/truncated input never records normal success or request completion. Original bodies are not persisted.
- Fixed admission/settlement lanes cycle admin, normal, admin, catchup; inactive/missing lanes fall through. Admin means captured forced pending refresh; catchup is initial or overdue work. No new admin auth path. A held/partial/typed HTTP defer does not consume source failure/attempt or scheduler cursor. Genuine source failures retain existing bounded backoff.
- Source success updates only its own evidence and captured request key. It does not complete the product request. Existing declared sources/media/partial GitHub checkpoints and current all-required revalidation remain. A newer request version stays pending.
- Existing job's source lane does not stop at GitHub quota. Legacy product refresh skips canonical collection while source mode is enabled but continues remaining providers/media and final required-key checks. No duplicate canonical writer bypass.
- Shared HTTP typed defer is rethrown after local source claim cleanup; no result completion/retry/failure key or legacy cursor is consumed; an accepted pending request may retain its active-version initialization. C's runner/defer contract is reused, not copied.

## Work and actual evidence

- [x] Inventory source/product request bottlenecks and write plan. Request dedicated55524; no other DB.
- [x] Write actual original-provider stale URL/unpublish/policy mutation tests and normal control. Preserve original driver/source/hash/log; distinguish setup/import errors from RED.
- [x] Add strict schema/contract and disabled migration0081. Unit strict owner/binding/hash/lane tests.
- [x] Add actual canonical target demand/claim/renew/finish with owner/input/policy/source CAS. Actual concurrency, expired/foreign/old-epoch protection and actual wall wait regressions.
- [x] Add bounded collector using existing parser/constants; same-URL304/cacheless/different-final/truncation and abort/defer controls. HTTP is mocked, DB/claims are real.
- [x] After C freeze, connect existing job/source-only lane and canonical skip/progress gate. Demonstrate GitHub retry future while canonical completes; other required keys keep product request pending. Admin/normal/catchup fairness controls.
- [x] Check changed evidence/site/request/job tests, scoped lint and necessary tsc. Record actual logs/failed approaches/limits. Settle all fixture work; restore raw microseconds/managed rows/exact guard state and report own readback. Root owns container STOP/Git.

## Remaining deployment conditions

No operational consumer, shared HTTP permits or Oracle runtime is enabled by this PR. Configured instance identity is not physical host attestation. No TTL implies remote termination; PR07 shared permit remains responsible for actual HTTP overlap/unknown. Product/media/GitHub legacy authority is not replaced beyond canonical. PR10/11 host budgets, least-privilege runtime, canary and actual raw/source readback remain separate prerequisites.

## Final scope clarifications

PR07c's seven inherited files (site collector/cancellation, refresh/cancellation, job/continuation and runner) are preserved. The first two legacy site integration mocks were adapted to actual fetch settlement; the separate predecessor patch contains no PR08 CAS changes. Legacy registration may collect an unchanged unverified product; its actual initial status/access/URL/updatedAt and settings are captured before HTTP and checked before saving. Source claims only admit public website products.

The existing repository relationship derivation accepts a transaction for source completion; its original parser/rules are reused inside the source result transaction. Source progress is merged into an older product checkpoint for the current URL, avoiding loss of independently completed evidence. A canonical writer rejection cannot fall through to the generic receipt-less failure writer.

Actual failed same-URL retry deadlines survive policy revisions. A valid forced request can bypass normal freshness, and a replaced URL can acquire a new binding; neither turns an unchanged failed upstream's future retry into ready work. Both hint and post-lock recheck use DB clock predicates.

Migration0081 is assigned to A; this branch starts with0079. Root integrates its separately owned0080 and final journal order and performs the final fresh migration/integration gate.
