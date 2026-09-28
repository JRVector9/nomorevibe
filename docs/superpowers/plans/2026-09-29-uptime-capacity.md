# Uptime capacity ramp

**Goal:** Make six-hour checks feasible for about 19,365 public websites while keeping one request per origin and one DB result writer.

**Evidence:** 2026-09-29 00:41 KST live read-only snapshot: 13,976 older than six hours, 905 checks/hour. Last 15-result tick took 5.626s; 900 recent checks had response latency p50 717ms, p95 2,471ms, max 6,091ms. The code caps one tick at 15 and the scheduler runs once per minute. 19,365/360 = 53.8 checks/minute, so a 60-result cap is the minimum practical headroom.

**Design:** Keep defaults 15/3, add bounded `UPTIME_BATCH_SIZE` (1..60) and `UPTIME_CONCURRENCY` (1..6) for staged maintenance-only rollout. No change to six-hour per-product interval, 25s tick budget, per-origin lane, or serialized DB writes. Raise to 30/4, observe duration/checks/errors, then 60/6 if below budget. A tick that runs out of budget leaves oldest unchecked items for the next tick.

## Steps

1. [x] Add a failing test for parsing defaults/bounds and a real test DB tick with six distinct origins, one shared origin, and serialized writes at override 60/6. Confirmed RED.
2. [x] Implement the small configuration reader in `lib/jobs/products/uptime.ts`; use the values for selection and workers. Updated stale 3,147-product comment with current capacity math. Target tests GREEN.
3. [x] Run `npx next typegen`, `npx tsc --noEmit`, target and full unit/integration tests, lint, build, diff-check. Results: unit 155 files/1,229 pass; integration 96 files/923 pass, TODO1; lint errors0/vendor warning1; build and diff-check pass.
4. [ ] Commit and PR separately from monitor. After required CI, deploy only the paired maintenance primary/standby with the same code. Change only M3 active role settings in a measured ramp; standby must retain a safe matching setting so takeover does not cut capacity. Check one-minute tick results, 5-minute storage rate, p95 latency, budget and DB connections after each stage. Do not claim the six-hour objective until backlog age actually falls over several hours.
