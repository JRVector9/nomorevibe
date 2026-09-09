# Production Multi-Instance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing NoMoreVibe runtime safe to run as two web replicas with singleton workers and deploy the same release to M3 and mini.

**Architecture:** PostgreSQL remains the shared consistency boundary. Runtime connections use PgBouncer-compatible startup settings, migrations use the direct PostgreSQL port, Next.js build identity is shared, and one private connect-agent owns AI credentials. Instance-scoped observations expose both web replicas and prevent duplicate roles from masking each other.

**Tech Stack:** Next.js 16.3.1, TypeScript, postgres.js 3.4.9, Drizzle ORM, PostgreSQL 17, PgBouncer, Docker, Dokploy.

---

### Task 1: PgBouncer-compatible database client

**Files:**
- Modify: `lib/db/pool.ts`
- Modify: `.env.example`
- Test: `tests/db-pool.test.ts`
- Test: `tests/integration/db-pool-budget.test.ts`

- [ ] Add `poolerMode: "direct" | "pgbouncer"` to the validated pool configuration.
- [ ] In PgBouncer mode, send only `application_name` as a startup parameter; retain the existing timeout parameters for direct connections.
- [ ] Add a pure options assertion proving unsupported parameters are absent in PgBouncer mode.
- [ ] Run the pool unit and integration tests, then run a read-only smoke query through the production 6432 endpoint.

### Task 2: Stable Next.js multi-server build identity

**Files:**
- Modify: `next.config.ts`
- Modify: `.env.example`
- Modify: `compose.yml`
- Test: `tests/next-config.test.ts`

- [ ] Set `deploymentId` from `NEXT_DEPLOYMENT_ID` when provided.
- [ ] Document and pass `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `NEXT_DEPLOYMENT_ID`, and stable instance IDs.
- [ ] Assert the config reads the deployment ID without changing local builds when the variable is absent.

### Task 3: Instance-scoped service observations

**Files:**
- Create: `lib/operations/instance.ts`
- Create: `instrumentation.ts`
- Modify: `lib/operations/observations.ts`
- Modify: `scripts/worker-supervisor.ts`
- Modify: `scripts/connect-agent.ts`
- Modify: `lib/operations/admin.ts`
- Modify: `app/admin/status/OperationsCenter.tsx`
- Test: `tests/operations-observations.test.ts`
- Test: `tests/operations-center.test.ts`

- [ ] Validate `SERVICE_INSTANCE_ID` and build role/instance observation keys.
- [ ] Keep job observation keys unchanged and scope service observations to instances.
- [ ] Start one throttled web heartbeat from the Node instrumentation hook.
- [ ] Group service instances in the administrator read model and render each instance's freshness,
  release, current work, process start, and memory.
- [ ] Verify legacy singleton observations remain readable during a rolling upgrade.

### Task 4: Production configuration and runbook

**Files:**
- Modify: `compose.yml`
- Modify: `PENDING.md`
- Modify: `docs/operations/independent-workers-runbook.md`
- Create: `docs/operations/production-multi-instance.env.example`

- [ ] Separate local-only defaults from the production environment contract.
- [ ] Record M3 singleton roles, mini web replica, private connect-agent routing, one-shot migration,
  common secrets, PgBouncer runtime URL, direct migration URL, proxy hop validation, and rollback.
- [ ] Replace the stale “server/DB undecided” blocker with the remaining domain, load-balancer, backup,
  PgBouncer, and data-cutover checks.

### Task 5: Verification, review, and release

**Files:**
- Modify: `docs/CODEX_HANDOFF.md`
- Create outside repository: Obsidian project journal entry

- [ ] Run focused unit tests while implementing, then the full unit, integration, type, lint, and build checks.
- [ ] Run `codex review --uncommitted`, fix Critical/High findings and relevant Medium findings, and rerun affected checks.
- [ ] Commit and push the production fix branch, merge it to main, and deploy the same release to M3 and mini through the Dokploy API.
- [ ] Apply database role timeout defaults, migrate existing data with writers stopped, run migration once,
  start singleton roles, and validate direct and load-balanced health.
- [ ] Record exact application IDs, release, DB counts, worker progress, tests, failed approaches, and remaining operational risks.

