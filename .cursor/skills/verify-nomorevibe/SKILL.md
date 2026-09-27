---
name: verify-nomorevibe
description: Drive the NoMoreVibe Next.js web app, maker APIs, admin console, and local job ticks the way a user does. Use when proving a change works, before claiming a fix, or when a Feature Map recipe must be re-run.
---

# Verify NoMoreVibe

NoMoreVibe is an evidence-first catalogue of AI-built products. The primary surface is the public web UI plus maker HTTP APIs. Secondary surfaces are the local-login admin console and one-tick job scripts. This skill is for the next agent: launch the real app, drive a mapped feature, and keep proof. Do not report "fixed" from unit tests or code reading alone.

Read `features/README.md`, then the matching feature file. Drive every entry point that file lists unless a precondition is unmet. An unmet precondition is a skip with evidence, not a pass through another path.

## Launch

Prefer the repo's documented local stack. Node.js 24 and PostgreSQL 17 are required. PostgreSQL 16 cannot apply generated-column migrations (`SET EXPRESSION AS`).

```bash
# From the repo root. Secrets stay in .env.local and are never committed.
test -f .env.local || cp .env.example .env.local
# Required in .env.local for a verification instance:
#   DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55434/nomorevibe
#   NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
#   AUTH_SECRET and VISITOR_HASH_SECRET: openssl rand -hex 32 each (32+ chars)
#   CRON_SECRET and ADMIN_TOKEN: disposable verification values
#   ALLOW_PRIVATE_URLS=1          # local fixture URLs only
#   ADMIN_LOCAL_LOGIN=1           # local admin without GitHub OAuth
```

Start PostgreSQL 17 on port `55434`:

```bash
# Documented path when Docker is available
docker run -d --name nomorevibe-local-db \
  -e POSTGRES_USER=nomorevibe -e POSTGRES_PASSWORD=nomorevibe -e POSTGRES_DB=nomorevibe \
  -p 55434:5432 -v nomorevibe-local-pgdata:/var/lib/postgresql/data postgres:17

# When Docker is missing, a host PostgreSQL 17 cluster on 55434 is equivalent.
# Create role+database nomorevibe/nomorevibe, then:
pg_isready -h 127.0.0.1 -p 55434
```

Migrate and start the web app:

```bash
export PATH="$(dirname "$(nvm which 24 2>/dev/null || true)"):$PATH"
node --env-file=.env.local scripts/migrate.mjs
# Ready when stdout includes: [migrate] 완료
npm run dev
# Ready when GET http://127.0.0.1:3000/api/health returns status=ok and db=ok
# and GET http://127.0.0.1:3000/ HTML contains: AI로 만든 것들, 세상에 나오다.
```

Record the Next.js PID (and any fixture-site PID) under `/tmp/nomorevibe-verify-$RUN_ID/pids`. Teardown is in Cleanup.

Do not use `docker compose` for routine feature proof. Compose is the production-shaped topology on port `3200` / DB `55437` and is a separate operations path (`docs/operations/independent-workers-runbook.md`).

## Doctor

Run this first whenever the instance looks wrong:

```bash
.cursor/skills/verify-nomorevibe/bin/doctor
```

Require all of:

- `DATABASE_URL` points at PostgreSQL 17 (server version starts with `17.`).
- `GET $SITE/api/health` is HTTP 200 with `"status":"ok"` and `"db":"ok"`.
- The health JSON `release` / `instance` fields match this run's env, not a leftover process.
- `GET $SITE/` is HTTP 200 and includes the home heading `AI로 만든 것들, 세상에 나오다.`
- Admin proof additionally requires `ADMIN_LOCAL_LOGIN=1` (otherwise `/admin` redirects to GitHub OAuth).

Refuse to drive an instance this run did not start. Two Next.js processes can share one DB; a shared database is not isolation.

## Drive

There is no `control-*` CLI. Drive with:

1. **HTTP** — `curl -sS` against `$SITE` (default `http://127.0.0.1:3000`). Maker writes use `X-Edit-Token` and, for GET-then-PUT resources, `If-Match` from the `ETag`.
2. **Browser** — Playwright or the session browser tools. Prefer ARIA roles and accessible names from the feature files. Do not click by coordinates.
3. **Jobs** — `npm run job -- <name>` reads `.env.local` and runs one tick. A cron POST only enqueues; it is not completion.

Stable handles (do not invent others):

| Surface | Handle |
|---|---|
| Home heading | `h1` "AI로 만든 것들, 세상에 나오다." |
| Search | `searchbox` "프로젝트 검색" |
| Home brand | `link` "nomorevibe 홈" |
| Launch CTA | `link` "프로젝트 공개" → `/launch` |
| Sort tabs | `tab` "추천" / "최신" / "관심 많은 순" / "저장소 있음" |
| Product visit | `link` "제품 방문하기 ↗" → `/go/<slug>` |
| Admin nav | `navigation` "관리자 메뉴" |

Fixture product URLs must be reachable. Start `.cursor/skills/verify-nomorevibe/bin/fixture-site` before `POST /api/products`. Registration fetches the URL and rejects unreachable hosts.

## Evidence

Store proof at `/tmp/nomorevibe-verify-$RUN_ID/evidence/` (create the directory). Cleanup must not delete this tree.

Proof standards:

- Exercise the real user path. Do not insert rows with ad-hoc SQL and call the UI verified.
- Capture the action and the resulting state (request + response, or before/after screenshot).
- For mutations, add a second read-only view (`GET /api/products/<slug>`, reopen `/p/<slug>`, or a DB `SELECT` of public columns only).
- UI proof includes a screenshot that shows the NoMoreVibe chrome (brand or heading) and an HTML or ARIA excerpt.
- HTTP proof includes the command (redact `X-Edit-Token` and tokens), status code, and a redacted body.
- Job proof includes stdout, exit code, and a follow-up `GET /api/health` or admin status observation when the job claims a side effect.
- Never write edit tokens, `AUTH_SECRET`, `CRON_SECRET`, `ADMIN_TOKEN`, or `VISITOR_HASH_SECRET` into evidence files.

Mocks are allowed only at a production boundary that already isolates the system (no GitHub token → do not fake crawl-seed success).

## Cleanup

Kill only processes this run started, using the PIDs in `/tmp/nomorevibe-verify-$RUN_ID/pids`. Never `pkill node` or `pkill next`.

```bash
# Example: stop the fixture site and the Next.js PID this run recorded
xargs -r kill < /tmp/nomorevibe-verify-$RUN_ID/pids
```

If this run started the README `docker run` database container, `docker stop nomorevibe-local-db` only when no other work needs it. Leave a host PostgreSQL cluster running; do not `pg_ctlcluster ... stop` a shared system service.

Remove fixture products with `DELETE /api/products/<slug>` and `X-Edit-Token`, or leave them in a disposable verification database. Do not delete evidence files.

## Helpers

Both helpers are executable. Invoke them from the repo root.

```bash
.cursor/skills/verify-nomorevibe/bin/doctor
FIXTURE_PORT=4173 FIXTURE_NAME="Verify Fixture" \
  .cursor/skills/verify-nomorevibe/bin/fixture-site
```

`doctor` is read-only. `fixture-site` listens on `FIXTURE_PORT` (default `4173`), serves `/` and `/.well-known/nomorevibe.txt`, and accepts `POST /set-token` with a raw token body so verification can be completed after register returns `verify_token`.

## Isolation

Default ports: web `3000`, fixture `4173`, Postgres `55434`. A second instance needs another `PORT` / `NEXT_PUBLIC_SITE_URL` and a different `DATABASE_URL`. Sharing the verification database between two drivers corrupts click, rate-limit, and product state.

## Maintenance

When the app changes, use `/maintain-verification-skill` (pstack) to re-read source and re-drive each feature file.
