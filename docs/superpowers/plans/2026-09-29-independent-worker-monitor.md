# Independent Worker Monitor Implementation Plan

> **For agentic workers:** Execute the checked steps inline. The user has already requested the remaining failover work; keep role deployment sequential and preserve the dirty root checkout.

**Goal:** Detect a missing standby or broken role lease independently of the web and scheduler, and deliver an actionable monitor result.

**Architecture:** A read-only DB query computes candidate and lease freshness with DB time. A pure classifier maps those rows to role readiness. A separate CLI combines readiness with existing progress; an M3 monitor process periodically pushes status to the existing mini Uptime Kuma without owning or restarting jobs.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Vitest, Docker worker image, Dokploy, Uptime Kuma Push.

---

### Task 1: Candidate readiness

**Files:** Create `lib/operations/failover-readiness.ts`, `tests/failover-readiness.test.ts`, `tests/integration/failover-readiness-query.test.ts`.

- [x] Write a unit test whose primary is fresh and active but whose standby observation is absent; expect `standby_missing` and alarm. Run `npx vitest run tests/failover-readiness.test.ts`; confirm it fails because the classifier does not exist.
- [x] Add tests for standby takeover, matching release, expired lease, mismatched release, quarantine, and scheduler 1/2 replicas. Each case asserts role, reason, and alarm rather than implementation calls.
- [x] Implement `classifyFailoverReadiness(snapshot)` with the expected M3/mini instance IDs and a separate `readFailoverReadiness()` that selects only lease and observation fields, calculating ages and lease validity in PostgreSQL time.
- [x] Insert controlled lease and observation rows into the dedicated test DB; verify the real query returns the expected shape and ages. Run `npx vitest run --config vitest.integration.config.ts tests/integration/failover-readiness-query.test.ts`.
- [x] Run `npx vitest run tests/failover-readiness.test.ts` and `npx tsc --noEmit`; fix only observed failures.

### Task 2: Independent CLI and Push loop

**Files:** Create `scripts/check-failover-readiness.ts`, `scripts/watch-failover-readiness.ts`, `scripts/monitor-healthcheck.ts`, `tests/failover-monitor.test.ts`; modify `Dockerfile` with a `monitor` target.

- [x] Write tests for CLI exit 0/1/2, two consecutive abnormal samples, recovery, redacted Push failure, and heartbeat file freshness. Run the target suite and confirm expected failures.
- [x] Implement one-shot CLI output `{measuredAt,overall,readiness,progress}`. DB errors yield `unknown` and exit1, never `ok`.
- [x] Implement a 30-second loop with two-sample down threshold, `MONITOR_PUSH_URL` from environment, URL never logged, bounded HTTP timeout, a JSON local heartbeat, and signal drain. Push every successful cycle so stopped monitor becomes a Kuma timeout.
- [x] Override worker image healthcheck in `Dockerfile` target `monitor`; verify `docker build --target monitor` and target tests, then `npx tsc --noEmit`.

### Task 3: Operational rollout and evidence

**Files:** Update `README.md`, `PENDING.md`, `docs/operations/independent-workers-runbook.md`, `docs/CODEX_HANDOFF.md`; add a dated release report.

- [ ] Run `npm test`, `npm run test:integration`, `npm run lint`, `npm run build`, `git diff --check`, and GitHub required `check`; local gates passed, GitHub check pending.
- [ ] Create one M3 Dokploy monitor app with only read-only DB credentials, pool1, monitor target, autoDeploy false and its Push URL. Verify healthy and normal report before any fault injection.
- [ ] Stop one mini standby briefly, confirm readiness alarm/Push down and then recovery; stop monitor briefly to test Kuma missing heartbeat. Restore all services and verify five M3 active/mini standby pairs.
- [ ] If no alert destination is authorized or the Push monitor cannot be configured safely, leave Push unconfigured and mark external alert receipt unverified. Record exact blocker and follow-up commands.
- [ ] Update the handoff with objective, completed work, files, decisions, commands/results, failed approaches, remaining work, and exact next commands before the final report.
