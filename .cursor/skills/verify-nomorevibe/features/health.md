# Health

Health is the liveness document used by operators and this skill's doctor. It checks the database with `select 1` and returns process identity.

## Sub-features

- `health-ok` returns 200 when the database answers.
- `health-down` returns 503 when the database is unavailable.

## How to get to it (user POV)

- Open `/api/health`.
- Compose and Dokploy probe the same path on the web service.

## Driving it with verify-nomorevibe

Preconditions:

- The web process this run started is listening on `$SITE`.

- **Healthy.** Run `curl -sS -D - "$SITE/api/health"`. HTTP 200, `cache-control: no-store`, JSON `status`=`ok`, `db`=`ok`, plus identity fields (`release`, `instance`, or equivalent from `healthIdentity()`), and `dbLatencyMs` is a number.
- **Unhealthy (optional).** Only if this run can stop Postgres without harming other work: stop the DB, curl again, expect HTTP 503 and `db`=`unavailable`, then start Postgres and migrate/doctor again. Skip this sub-feature on a shared host cluster.
- **Proof.** Save the 200 body to `/tmp/nomorevibe-verify-$RUN_ID/evidence/health/ok.json`.

## Gotchas

- 200 with a stale process is possible if an old Next.js still owns the port. Compare identity fields to this run's `SERVICE_INSTANCE_ID` / `RELEASE_TAG`.
- Do not use `/api/health` as proof that a product feature works.
