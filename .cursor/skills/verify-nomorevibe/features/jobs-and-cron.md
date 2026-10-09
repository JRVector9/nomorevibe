# Jobs and cron

Jobs are one-tick workers driven from the repo root. The HTTP cron route only enqueues a request; a worker or `npm run job` consumes it.

Verification (2026-09-29 local drive): heartbeat count advanced 1→2; crawl fetch, judge, first review, publish, and seed ran no-work ticks with collection off. Worker-progress and failover probes returned exit 2 with missing local roles. Cron returned 403 without authorization, 400 for authenticated heartbeat, and 202 for click-rollup; the follow-up rollup tick completed. No GitHub crawl, automatic approval, duplicate skip, or exhausted handoff was proven.

## Sub-features

- `job-heartbeat` increments the heartbeat cursor.
- `job-ranking-refresh` creates or refreshes a ranking season snapshot.
- `job-click-rollup` rolls click events when any exist.
- `job-search-health` runs the read-only search-health audit.
- `job-worker-progress` reads worker liveness, stage progress, and manual handoffs.
- `job-failover-readiness` reads five role candidate pairs and scheduler replica readiness.
- `job-crawl-handoff` moves exhausted source refreshes or first reviews into human review.
- `job-star-approval` applies the configured 500-star minimum to fresh verified GitHub metadata.
- `job-repo-identity` skips a second repository path with the same GitHub numeric ID.
- `cron-enqueue` accepts `POST /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET`.
- `cron-unauthorized` returns 403 without the secret.
- `job-github` covers crawl-seed/fetch and is unverified without an environment token or registered collector PAT.
- `job-ai` covers reviewer, publisher, and text model jobs and is unverified without their provider credentials.

## How to get to it (user POV)

- Run `npm run job -- <name>` locally (reads `.env.local`).
- POST `$SITE/api/cron/<job>` as a compatibility enqueue API.
- Watch `/admin/status` for last run / error after a tick.
- Open `/admin/review?stage=human` for crawl handoffs and `/admin/github-accounts` for collector account status.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy and `.env.local` is loaded for `npm run job`.
- `CRON_SECRET` is set for cron tests.
- Do not enable `product-intro-check` (operator hold in `PENDING.md`).

- **Heartbeat.** Run `npm run job -- heartbeat`. Exit 0. Stdout contains `결과:` and is not `failed`. A second run increases the cursor `count`.
- **Ranking refresh.** Run `npm run job -- ranking-refresh`. Exit 0. `/sitemap.xml` or `/admin/ranking` then exposes a season key.
- **Click rollup.** Run `npm run job -- click-rollup`. Exit 0 even on an empty event table. This may request `ranking-refresh`.
- **Search health.** Run `npm run job -- product-search-health`. Exit 0. Admin search-health copy may still say there is no observation on a tiny catalogue; the tick itself is the proof.
- **Worker progress.** Run `node --env-file=.env.local --import tsx scripts/check-worker-progress.ts` and save its JSON and exit code. Inspect `overall`, `stages`, `scheduler`, and `liveness`; exit 0 is ok, 1 unknown, 2 alarm. On a local run without role workers, missing worker observations are expected and must not be called a pass. Compare `manualAttention` with `/admin/status` and `/admin/review?stage=human` only when such candidates exist.
- **Failover readiness.** Run `node --env-file=.env.local --import tsx scripts/check-failover-readiness.ts` and save its JSON and exit code. A one-web local run reports `primary_missing` for the five roles and `replica_missing` for the scheduler, with exit 2. This proves the probe path and the absent topology, not a successful failover.
- **Cron unauthorized.** Run `curl -sS -o /dev/null -w "%{http_code}" -X POST "$SITE/api/cron/heartbeat"`. Expect 403 (heartbeat is also not a requestable cron job). Then `curl -sS -o /dev/null -w "%{http_code}" -X POST "$SITE/api/cron/click-rollup"`. Expect 403.
- **Cron enqueue.** Run `curl -sS -X POST "$SITE/api/cron/click-rollup" -H "Authorization: Bearer $CRON_SECRET"`. HTTP 202. JSON is an enqueue receipt, not a completed rollup. Consume with `npm run job -- click-rollup` if you need completion.
- **GitHub crawl (unverified without token).** `npm run job -- crawl-seed` may exit 0 with no growth when collection is off. With crawl enabled, a missing collector credential can fail the job. Actual frontier growth requires `GITHUB_TOKEN` or an enabled admin PAT plus the matching `GITHUB_COLLECTOR_SECRET` on the crawler. Do not invent seed rows.
- **Crawl decisions (require real source state).** With a crawl-owned local database and a GitHub credential, drive `crawl-seed`, `crawl-fetch`, `crawl-judge`, `crawl-agent-review`, and `crawl-publish` one tick at a time. A 500+ star auto approval requires a fresh public, non-fork, non-archived GitHub response with matching numeric ID/name and must be confirmed in `/admin/review?stage=publish` or `/admin/review?stage=published`, then the public product page. A repeated repository numeric ID under another path should leave the second frontier row skipped with an alias and no second product. Without those source conditions, mark both unverified.
- **Exhausted handoff (requires failed attempts).** `crawl-fetch` moves a terminal failed source refresh to `source_refresh_failed`; `crawl-agent-review` moves a first review with three failed attempts for the same input to `ai_review_exhausted`. Open `/admin/review?stage=human#review-list` and find that candidate and reason, then compare `/admin/status` `직접 확인`. A no-work tick is runner proof only; do not fabricate candidate state or equate an enqueue receipt with a handoff.
- **AI jobs (unverified without provider credentials).** `crawl-agent-review` and `second-review` need their configured reviewer model and credentials; publisher category classification needs the connected Codex agent or CLI credentials. Text jobs including `crawl-tagline`, `product-search-profile`, and `product-search-verify` use the configured gateway (`ABCLLM_API_KEY`). Mark model outcomes unverified when those credentials are absent. Do not stub model output.
- **Proof.** Save each job's stdout to `/tmp/nomorevibe-verify-$RUN_ID/evidence/jobs-and-cron/<name>.log` including the exit code line.

## Gotchas

- `npm run job -- <name>` is required so npm does not swallow the name.
- Cron 202 is not `done: true`. README calls this out explicitly.
- `heartbeat` is not a cron-requestable job (400 if authorized).
- `ranking-refresh` should not be added as a periodic cron; it follows rollup.
- Worker compose roles (`npm run worker -- --role=crawler --once`) are the production consumer. The local proof default is `npm run job`.
- `scripts/check-failover-readiness.ts` assumes five named M3 primary and mini standby candidates plus two scheduler replicas. An ordinary one-web local run cannot prove failover readiness. Use the operations runbook and an isolated topology to test that path.
