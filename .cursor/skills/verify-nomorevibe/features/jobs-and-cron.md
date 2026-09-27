# Jobs and cron

Jobs are one-tick workers driven from the repo root. The HTTP cron route only enqueues a request; a worker or `npm run job` consumes it.

## Sub-features

- `job-heartbeat` increments the heartbeat cursor.
- `job-ranking-refresh` creates or refreshes a ranking season snapshot.
- `job-click-rollup` rolls click events when any exist.
- `job-search-health` runs the read-only search-health audit.
- `cron-enqueue` accepts `POST /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET`.
- `cron-unauthorized` returns 403 without the secret.
- `job-github` covers crawl-seed/fetch and is unverified without `GITHUB_TOKEN`.
- `job-ai` covers reviewer/publisher/text model jobs and is unverified without CLI credentials.

## How to get to it (user POV)

- Run `npm run job -- <name>` locally (reads `.env.local`).
- POST `$SITE/api/cron/<job>` as a compatibility enqueue API.
- Watch `/admin/status` for last run / error after a tick.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy and `.env.local` is loaded for `npm run job`.
- `CRON_SECRET` is set for cron tests.
- Do not enable `product-intro-check` (operator hold in `PENDING.md`).

- **Heartbeat.** Run `npm run job -- heartbeat`. Exit 0. Stdout contains `결과:` and is not `failed`. A second run increases the cursor `count`.
- **Ranking refresh.** Run `npm run job -- ranking-refresh`. Exit 0. `/sitemap.xml` or `/admin/ranking` then exposes a season key.
- **Click rollup.** Run `npm run job -- click-rollup`. Exit 0 even on an empty event table. This may request `ranking-refresh`.
- **Search health.** Run `npm run job -- product-search-health`. Exit 0. Admin search-health copy may still say there is no observation on a tiny catalogue; the tick itself is the proof.
- **Cron unauthorized.** Run `curl -sS -o /dev/null -w "%{http_code}" -X POST "$SITE/api/cron/heartbeat"`. Expect 403 (heartbeat is also not a requestable cron job). Then `curl -sS -o /dev/null -w "%{http_code}" -X POST "$SITE/api/cron/click-rollup"`. Expect 403.
- **Cron enqueue.** Run `curl -sS -X POST "$SITE/api/cron/click-rollup" -H "Authorization: Bearer $CRON_SECRET"`. HTTP 202. JSON is an enqueue receipt, not a completed rollup. Consume with `npm run job -- click-rollup` if you need completion.
- **GitHub crawl (unverified without token).** If `GITHUB_TOKEN` is empty, run `npm run job -- crawl-seed` only to capture a failed or skipped tick. Record unverified for actual frontier growth. Do not invent seed rows.
- **AI jobs (unverified without CLIs).** `crawl-agent-review`, `second-review`, `crawl-tagline`, `product-search-profile`, `product-search-verify`, and publisher category classification need Claude/Codex. Mark unverified when those env vars are empty. Do not stub model output.
- **Proof.** Save each job's stdout to `/tmp/nomorevibe-verify-$RUN_ID/evidence/jobs-and-cron/<name>.log` including the exit code line.

## Gotchas

- `npm run job -- <name>` is required so npm does not swallow the name.
- Cron 202 is not `done: true`. README calls this out explicitly.
- `heartbeat` is not a cron-requestable job (400 if authorized).
- `ranking-refresh` should not be added as a periodic cron; it follows rollup.
- Worker compose roles (`npm run worker -- --role=crawler --once`) are the production consumer. The local proof default is `npm run job`.
