# Web, pipeline and Oracle recovery implementation

Goal: restore recoverable web/backend faults automatically, independently observe every pipeline stage from Oracle, notify the administrator, and audit every page for bottlenecks.

Architecture: retain Swarm's unlimited on-failure restart and fenced worker supervisor. Fix reproduced cache, network/parser and lease-acquisition failures. An independent Oracle systemd watchdog polls two constrained SSH gateways; gateways expose only fixed service health and can roll the existing web/readonly monitor service after rechecking a persistent failure. Never alter DB, models, policy holds, replica intent, release or application configuration. Oracle's existing Kuma/Telegram remains the notification transport. Host loss/DB failure is alerted and uses existing standby/failover; infrastructure restoration requires separate verified DR readiness.

- [x] Inspect latest main, current 17-app inventory, existing Oracle receiver and production restart policies. Keep original dirty checkout untouched.
- [x] Parallel backend, web/page and security audits using gpt-6.1-sol/xhigh.
- [ ] Reproduce and fix worker acquisition stall, cache optional-dependency failure, vulnerable HTTP/parser dependencies and monitor redirect/body handling. Run meaningful focused regressions.
- [ ] Add `scripts/ops/recovery_gateway.py` and `tests/test_recovery_gateway.py`: fixed local inventory, no arbitrary commands/URLs, health/semantic-home observation, compare-and-swap version before rolling, local lock/cooldown/daily limits, no stopped/deploying services, bounded output.
- [ ] Add `scripts/ops/oracle_watchdog.py` and `tests/test_oracle_watchdog.py`: persistent consecutive observations, bounded parallel SSH, reserve recovery before dispatch, unknown results consume allowance, stable incident transitions and retries, no secrets in logs, Kuma push with response/time limits.
- [ ] Install constrained keys and independent Oracle systemd service, dry-run existing fleet, verify source hashes, permission denials, live probes and notifications. Exercise isolated fixture failures before production-targeted reversible drills.
- [ ] Record all public/member/admin page routes, safe public latency/cache observations and common query/cache fixes; authenticated/role-specific pages require browser evidence or explicit remaining status.
- [ ] Required type/lint/unit/build/CI checks, independent final review, PR/latest base check, deploy affected runtime through `npm run deploy -- scope|plan|run`, confirm release/source and runtime behavior.
- [ ] Update `docs/CODEX_HANDOFF.md`, runbook and remaining verification without claiming unexecuted tests or full DR success.

Alternatives considered: restart every alarm (reject: healthy standby and provider/policy waits are not process faults); Dokploy redeploy on Oracle (reject: broad credentials and unverified newer code); constrained same-spec recovery (chosen: local recheck, persistent limits, existing release).
