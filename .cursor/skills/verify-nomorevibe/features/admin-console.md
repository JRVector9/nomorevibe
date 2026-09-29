# Admin console

The admin console is the operator workspace: operations center, GitHub collector accounts, review queue, products, crawl settings, ranking policy, and related pages. Local verification uses `ADMIN_LOCAL_LOGIN=1` instead of GitHub OAuth.

Verification (2026-09-29 local drive): the hydrated browser opened `/admin/status`, `/admin/github-accounts`, `/admin/review?stage=human`, and `/admin`. The PAT button was disabled without a collector encryption key and enabled with a disposable local key. The review stage link selected `aria-current="page"`; the auto-approval minimum showed 500. No PAT was saved, and no crawl setting was submitted.

## Sub-features

- `admin-status` renders `/admin/status` (운영센터).
- `admin-worker-status` shows stage throughput, worker runtime, and manual handoffs in the operations center.
- `admin-github-accounts` renders `/admin/github-accounts` with account status, quota, and PAT controls.
- `admin-review` renders `/admin/review` (심사 큐) and its stage filters.
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

- **Status.** Open `/admin/status`. The heading is `운영센터`. Navigation `관리자 메뉴` lists `운영센터`, `GitHub 수집 계정`, `심사 큐`, `제품 관리`, `내릴 후보`, `크롤 설정`, `카테고리 기준`, `근거 설정`, `랭킹`, `AI 소식`. Tabs include `전체 현황`, `작업 흐름`, `AI 연결`, `수동 분류`.
- **Worker status.** In `/admin/status`, find `단계별 처리 속도`; inspect `대기`, `5분 평균`, and any `직접 확인` link. Open the crawler or reviewer service detail and read `현재 작업`, `마지막 진행`, `릴리스`, and instance observations. With no workers started, report missing observations as observed, not a healthy runtime. A `직접 확인` link leads to `/admin/review?stage=human#review-list`.
- **GitHub accounts.** Open `/admin/github-accounts` through `관리자 메뉴`. Expect heading `GitHub 수집 계정`, sections `최근 수집 결과` and `등록된 계정`, plus `수집 토큰 등록·교체`. With no registered accounts, expect the empty message; the legacy environment token is not listed. If `GITHUB_COLLECTOR_SECRET` is absent, expect disabled `토큰 확인 후 저장` and `암호화 키 설정 후 사용할 수 있습니다.` Set a 32+ character disposable key in `.env.local` and reload the dev app; the button becomes enabled. Saving, replacing, disabling, and re-enabling an account require a real GitHub PAT. Record these as unverified without one; never put a PAT in proof.
- **Review stages.** Open `/admin/review`. The `심사 구간` navigation has `판정 대기`, `AI 대기`, `2차 대기`, `확정만 하면 됨`, `직접 판단`, `발행 대기`, `발행 완료`, and `거부`. Choose `직접 판단`; the URL is `/admin/review?stage=human#review-list` and the selected link has `aria-current="page"`. Takedown receipts from the takedown feature appear above the stages when present.
- **Products.** Open `/admin/products`. Filter labels include `전체`, `검증됨`, `미클레임`, `검증 대기`, `차단됨`. The fixture slug is listed after register.
- **Settings.** Open `/admin`. Heading `크롤 설정`. Shows `수집 켜짐` or `수집 꺼짐`. Under `판정 기준`, `자동 승인 최소 스타` defaults to 500 on a fresh database; it cannot be set below 500. Do not submit the form unless that is the change under test.
- **Ranking admin.** Open `/admin/ranking`. Heading related to 랭킹 설정. Read-only proof is the page rendering with current/next policy copy.
- **Secondary pages.** Open `/admin/audit`, `/admin/categories`, `/admin/evidence`, `/admin/news`. Each returns HTTP 200 (not `/admin/login`).
- **Login gate.** With `ADMIN_LOCAL_LOGIN=1`, `/admin/status` is HTTP 200 and shows `운영센터` without a GitHub button. `GET /admin/login` may still render the `어드민` login chrome to a raw curl; prove access on `/admin/status`, not a 307 from `/admin/login`.
- **OAuth (unverified by default).** If `ADMIN_LOCAL_LOGIN` is unset, `/admin` redirects to `/admin/login` and the GitHub link is `/api/auth/github`. Do not complete OAuth without app credentials. Mark `admin-oauth` unverified.
- **Proof.** Screenshot `/admin/status` to `/tmp/nomorevibe-verify-$RUN_ID/evidence/admin-console/status.png` showing `운영센터` and the sidebar.

## Gotchas

- Local login bypasses cookies. It is a development switch and must never be set in production.
- Saving crawl settings overwrites stored defaults for that database. Prefer read-only proof.
- A PAT save calls GitHub `/user` and `/rate_limit`; a made-up token cannot prove registration. Replacing a token must resolve to the selected GitHub user ID.
- A stage card filters the queue; an empty local database proves the route and filter, not a crawl decision. `직접 확인` means retries ended and a person must decide, not that a worker stalled.
- `/admin/products/<slug>` can enqueue force refresh. That is not evidence completion.
- Job success is not proven by opening the operations center. Pair with jobs-and-cron.
