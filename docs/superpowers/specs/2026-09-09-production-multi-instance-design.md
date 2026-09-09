# Production Multi-Instance Design

## Objective

Deploy one NoMoreVibe release to the M3 and mini web servers behind the existing load balancer while
keeping PostgreSQL writes, worker ownership, administrator authentication, and AI credentials
consistent. Preserve the current PostgreSQL-backed job design and do not introduce Redis.

## Runtime topology

- Run one web replica on M3 and one on mini from the same image digest.
- Run exactly one scheduler, crawler, reviewer, publisher, maintenance worker, and connect-agent on
  M3. Additional copies may remain idle because jobs are fenced by PostgreSQL leases, but they are
  not part of the initial production topology.
- Send all runtime SQL through PgBouncer on port 6432. Run the one-shot migration against PostgreSQL
  port 5432 before starting the release.
- Keep one encrypted connect-agent vault on M3. Both web replicas and the publisher call it over a
  private Tailscale path authenticated with a dedicated `OPERATIONS_AGENT_SECRET`.

## Database compatibility and concurrency

`postgres` currently sends timeout values as startup parameters. The production PgBouncer rejects
those parameters. Add an explicit `DB_POOLER_MODE=pgbouncer` setting that retains
`application_name` but omits unsupported timeout startup parameters. Keep direct-connection behavior
unchanged. Production sets common timeout defaults on the `nomorevibe` database role so pooled
backend sessions remain bounded.

Existing job leases, row locks, unique indexes, and `SKIP LOCKED` claims remain the concurrency
mechanism. Runtime pools remain bounded per role. The deployment must verify PgBouncer limits before
raising any pool or adding worker replicas.

## Next.js multi-server behavior

Both builds receive the same base64 `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. `next.config.ts` exposes a
deployment ID from `NEXT_DEPLOYMENT_ID`, and both replicas use the same value for a release. The
authentication, visitor hashing, site URL, OAuth, and operations-agent secrets are identical on both
web replicas. All current public pages are dynamic, so no shared application cache is introduced.

## Operations visibility

Every observation includes a stable deployment-provided `SERVICE_INSTANCE_ID`. Worker and
connect-agent observation keys include the instance ID so one replica cannot hide another. The
administrator read model groups observations by logical role and shows all instances. A lightweight
web heartbeat starts with the Node server and records release, instance, process, memory, and boot
time. The existing per-job observations keep their current keys because a job has one active lease.

## Data migration and release

Production currently contains schema only. Stop local writers, take one consistent dump of the
selected source database, restore it into `nomorevibe`, and clear transient leases/worker heartbeat
timestamps before starting production workers. Run migrations once against port 5432. Start the
singleton services, then both web replicas, then enable the load-balancer route after direct health
checks pass.

The deployment uses distinct secrets, never copies credentials from another service, and does not
store them in the repository. The connect-agent port is private. `ADMIN_LOCAL_LOGIN` and
`ADMIN_LOCAL_CODEX` are absent in production.

## Acceptance

- The production PgBouncer connection accepts application queries and transactions.
- Two independent web processes can invoke Server Actions and share administrator sessions.
- Concurrent registration, queue claims, rate limits, review decisions, and publication guards pass
  their existing integration tests.
- The operations center lists both web instances and every singleton service independently.
- Both public web replicas return healthy responses before the load balancer is enabled.
- Existing product data is present after migration, no job lease remains owned by the local runtime,
  and all workers advance requested/processed job versions without persistent errors.

