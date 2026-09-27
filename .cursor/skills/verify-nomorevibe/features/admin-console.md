# Admin console

The admin console is the operator workspace: operations center, review queue, products, crawl settings, ranking policy, and related pages. Local verification uses `ADMIN_LOCAL_LOGIN=1` instead of GitHub OAuth.

Verification (2026-09-27 local drive): `/admin`, `/admin/status`, `/admin/review`, `/admin/products`, `/admin/ranking`, `/admin/audit`, `/admin/categories`, `/admin/evidence`, and `/admin/news` returned 200 with local login. GitHub OAuth was not driven (no `GITHUB_OAUTH_*`). Settings were not submitted.

## Sub-features

- `admin-status` renders `/admin/status` (운영센터).
- `admin-review` renders `/admin/review` (심사 큐).
- `admin-products` renders `/admin/products`.
- `admin-settings` renders `/admin` (크롤 설정).
- `admin-ranking` renders `/admin/ranking`.
- `admin-secondary` opens `/admin/audit`, `/admin/categories`, `/admin/evidence`, and `/admin/news`.
- `admin-oauth` is the GitHub login path when local login is off.

## How to get to it (user POV)

- Open `/admin` or `/admin/status` while `ADMIN_LOCAL_LOGIN=1` (auto-session as `local`).
- Open `/admin/login` and choose `GitHub으로 로그인` when local login is off.
- Use the `관리자 메뉴` links.

## Driving it with verify-nomorevibe

Preconditions:

- Doctor reports `$SITE` healthy.
- `.env.local` has `ADMIN_LOCAL_LOGIN=1` and `AUTH_SECRET` of 32+ characters.
- Do not change crawl `enabled` or review mode on a database you do not own.

- **Status.** Open `/admin/status`. The heading is `운영센터`. Navigation `관리자 메뉴` lists `운영센터`, `심사 큐`, `제품 관리`, `내릴 후보`, `크롤 설정`, `카테고리 기준`, `근거 설정`, `랭킹`, `AI 소식`. Tabs include `전체 현황`, `작업 흐름`, `AI 연결`, `수동 분류`.
- **Review.** Open `/admin/review`. Title/heading path is 심사 큐. Takedown receipts from the takedown feature appear here.
- **Products.** Open `/admin/products`. Filter labels include `전체`, `검증됨`, `미클레임`, `검증 대기`, `차단됨`. The fixture slug is listed after register.
- **Settings.** Open `/admin`. Heading `크롤 설정`. Shows `수집 켜짐` or `수집 꺼짐`. Do not submit the form unless that is the change under test.
- **Ranking admin.** Open `/admin/ranking`. Heading related to 랭킹 설정. Read-only proof is the page rendering with current/next policy copy.
- **Secondary pages.** Open `/admin/audit`, `/admin/categories`, `/admin/evidence`, `/admin/news`. Each returns HTTP 200 (not `/admin/login`).
- **Login gate.** With `ADMIN_LOCAL_LOGIN=1`, `/admin/status` is HTTP 200 and shows `운영센터` without a GitHub button. `GET /admin/login` may still render the `어드민` login chrome to a raw curl; prove access on `/admin/status`, not a 307 from `/admin/login`.
- **OAuth (unverified by default).** If `ADMIN_LOCAL_LOGIN` is unset, `/admin` redirects to `/admin/login` and the GitHub link is `/api/auth/github`. Do not complete OAuth without app credentials. Mark `admin-oauth` unverified.
- **Proof.** Screenshot `/admin/status` to `/tmp/nomorevibe-verify-$RUN_ID/evidence/admin-console/status.png` showing `운영센터` and the sidebar.

## Gotchas

- Local login bypasses cookies. It is a development switch and must never be set in production.
- Saving crawl settings overwrites stored defaults for that database. Prefer read-only proof.
- `/admin/products/<slug>` can enqueue force refresh. That is not evidence completion.
- Job success is not proven by opening the operations center. Pair with jobs-and-cron.
