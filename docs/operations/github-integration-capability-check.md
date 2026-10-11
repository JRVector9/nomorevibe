# GitHub 스타·봇 피드백 최소 권한 검증

기준일: 2026-10-11. PR-01은 전송 경계와 JWT 재사용을 구현한다. **실제 App 권한 검증은 미실행이며 완료되지 않았다.** 전용 Star App·Feedback App, 승인된 테스트 사용자와 공개 테스트 저장소가 준비되어야 아래 외부 쓰기 절차를 실행할 수 있다. 기존 관리자 OAuth, 수집 PAT, 읽기 전용 Collector App의 자격은 사용하지 않는다.

## App 등록 설정

`SITE_ORIGIN`은 검증 대상 환경의 승인된 HTTPS origin이다. 운영 origin은 `https://nomorevibe.brut.bot`이고 staging은 별도 승인된 주소를 사용한다. callback과 webhook은 실제 구현이 배포된 환경에 등록한다. callback wildcard matching은 끈다. GitHub의 [callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)과 [setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)은 서로 다른 흐름이다.

| 설정 | Star App | Feedback App |
|---|---|---|
| 인증 주체 | 사용자가 승인한 GitHub App user access token | 제작자가 설치한 App의 installation access token |
| User permissions | Starring: read and write | 추가 user permission 없음 |
| Repository permissions | Metadata: read | Issues: read and write, Metadata: read |
| 사용자 승인 callback | `SITE_ORIGIN/api/auth/user/github/callback` | `SITE_ORIGIN/api/auth/maker/github/callback` |
| 설치 후 setup URL | 설정하지 않음. 개인 스타에 Feedback App 설치를 요구하지 않음 | `SITE_ORIGIN/api/github/installations/setup` |
| webhook URL | `SITE_ORIGIN/api/github/webhooks/star` | `SITE_ORIGIN/api/github/webhooks/feedback` |
| webhook secret | Star 전용 임의 비밀값 | Feedback 전용 다른 임의 비밀값 |
| 이벤트 | `github_app_authorization` 권한 회수 | `installation`, `installation_repositories`, `issues`; 관련 user 승인 회수 |
| 저장소 선택 | 사용자 승인과 스타 권한을 검증. 대상 App 설치 조건은 아래 실검증으로 확인 | Only select repositories. 승인된 공개 테스트 repo 하나만 선택 |
| user token 만료 | expiring user token 활성화. 승인 요청에 `scope=offline_access`, PKCE S256, 일회성 state | 제작자 관리 확인에만 임시 user token 사용하고 완료·만료 시 폐기 |

GitHub App은 등록된 fine-grained permissions로 권한을 정하며 OAuth App의 `public_repo`를 추가하는 방식으로 확장하지 않는다. `offline_access`는 만료·refresh token을 요청하는 값이다. [user token 발급과 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [스타에 필요한 권한](https://docs.github.com/en/rest/activity/starring#star-a-repository-for-the-authenticated-user), [이슈 생성 권한](https://docs.github.com/en/rest/issues/issues#create-an-issue).

setup callback의 `installation_id`는 신뢰하지 않는다. 같은 일회성 flow에 묶인 공개 사용자 세션·제품 수정 권한과 GitHub user token을 확인하고, 그 사용자의 installation 목록과 해당 설치의 repository 숫자 ID를 대조한다. 제품 수정키는 서버 요청 헤더·본문에서만 사용하며 URL, OAuth state, 브라우저 저장소에 넣지 않는다.

## 서버 환경값

다음 이름은 별도 연동 App을 위한 계약이다. 이 문서와 `.env.example`에는 비밀값을 쓰지 않는다. callback은 고정 경로와 승인된 site origin에서 계산한다.

| 환경값 | 용도 / 소비 역할 |
|---|---|
| `GITHUB_STAR_APP_ID`, `GITHUB_STAR_APP_SLUG` | Star App 숫자 ID·슬러그. 등록 자격·이벤트 검증 |
| `GITHUB_STAR_APP_CLIENT_ID`, `GITHUB_STAR_APP_CLIENT_SECRET` | 일반 사용자 승인·토큰 교환/갱신. 웹 서버 전용 |
| `GITHUB_STAR_APP_PRIVATE_KEY` | Star App JWT가 필요한 서버의 자격 확인용. Collector 키와 별개 |
| `GITHUB_STAR_APP_WEBHOOK_SECRET` | Star webhook HMAC 검증. 웹 서버 전용 |
| `GITHUB_FEEDBACK_APP_ID`, `GITHUB_FEEDBACK_APP_SLUG` | Feedback App 숫자 ID·슬러그와 봇 식별 |
| `GITHUB_FEEDBACK_APP_CLIENT_ID`, `GITHUB_FEEDBACK_APP_CLIENT_SECRET` | 제작자 승인·관리 권한 확인. 웹 서버 전용 |
| `GITHUB_FEEDBACK_APP_PRIVATE_KEY` | repo로 제한한 installation token 서명. 관련 웹·publisher·maintenance 서버 |
| `GITHUB_FEEDBACK_APP_WEBHOOK_SECRET` | Feedback webhook HMAC 검증. 웹 서버 전용 |
| `GITHUB_INTEGRATION_SECRET` | 연동 access/refresh credential 암호화. 관련 웹·worker에서 같은 값 |
| `PUBLIC_USER_AUTH_ENABLED`, `GITHUB_STAR_ENABLED`, `PRODUCT_FEEDBACK_ENABLED`, `GITHUB_FEEDBACK_DELIVERY_ENABLED` | 초기에는 모두 `false`. 파일럿 활성화는 별도 단계 |

키·토큰·refresh token·인증 code·개인 이메일을 명령 인자, 셸 기록, 저장소 파일, 로그, CI artifact에 남기지 않는다. 실제 값은 서버 비밀 저장소에서 주입한다. App 간 private key, client secret, webhook secret을 공유하지 않는다.

## 전송 계약

`lib/github/client.ts`의 `githubRequest<T>({ path, token, auth?, method?, body?, timeoutMs? })`는 API origin을 `https://api.github.com`으로 고정하고 버전 `2026-03-10`, `cache: no-store`, `redirect: manual`을 보낸다. 임의 요청 헤더·호스트·HTTP 메서드는 받을 수 없다. `auth` 기본값은 `user`이고 JWT 요청은 `app`, 봇 호출은 `installation`을 지정한다. 이 값은 호출 정책이며 토큰의 실제 권한은 GitHub가 확인한다. [REST API 버전](https://docs.github.com/en/rest/about-the-rest-api/api-versions).

| 결과 | 의미 / 후속 처리 |
|---|---|
| `confirmed_success` | 해당 endpoint의 예상 상태(200/201/204)와 제한 내 JSON을 받음. `data`의 숫자 ID·대상·권한은 도메인에서 추가 검사 |
| `confirmed_rejection` | 전송 전 입력 거절 또는 확정 4xx. `status`, 안전한 `github_*` code, `retryAt`으로 재연결·보류·rate limit 처리 |
| `unknown` | 요청 후 네트워크/timeout/5xx 또는 사용할 수 없는 성공 응답. 이슈 POST를 자동 반복하지 않고 같은 repo의 marker 재조회 |

전체 요청과 응답 읽기를 최대 10초로 제한한다. 응답은 Content-Length와 실제 스트림 둘 다 2 MiB 한도로 검사하고, body 초과·중단 시 스트림을 취소한다. 실패에는 GitHub의 원문 메시지·URL·토큰을 반환하지 않는다. 허용한 응답 metadata는 숫자 상태, 검증한 request ID, 재시도 UTC millisecond뿐이다. rate limit은 Retry-After와 primary reset 중 더 늦은 시각을 존중하며 secondary 응답에 시각이 없으면 60초 뒤로 미룬다. [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

스타는 user token의 GET/PUT/DELETE만 허용한다. 이슈 POST는 installation token과 `{ title, body }`만 허용한다. installation token 발급은 app JWT와 양의 safe integer `repository_ids`, `permissions: { issues: "write", metadata?: "read" }`만 허용한다. 이슈 목록은 검증한 `state=open|closed|all`, `page>=1`, `1<=per_page<=100`으로 페이지를 순회한다. installation/repository 목록도 같은 페이지 제한을 사용한다. [설치 토큰과 repository 제한](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

redirect는 같은 API origin이어도 따라가지 않는다. 이름 변경은 저장된 repository 숫자 ID로 `GET /repositories/{id}`를 명시적으로 호출하여 현재 공개 repo 이름을 확인한 뒤 별도 요청한다. `parseGithubRepositoryResponse(data, expectedId)`가 ID 불일치·잘못된 URL·metadata 타입을 거절한다. 삭제 후 같은 이름에 생긴 다른 repo로 이전 작업을 보내지 않는다. 처음 보는 old-name URL이 301이면 알려진 숫자 ID를 별도로 확보·검증하기 전 쓰기를 보류한다. 스타 조회 404는 metadata에서 같은 공개 숫자 ID가 확인된 뒤에만 “스타 안 됨”으로 해석한다.

## 실제 검증 절차

이 절차는 **승인된 전용 계정과 테스트 repo에서만** 수행한다. 아래 status·URL·숫자 ID·수행자·시각·설정 권한을 기록하고, token이나 OAuth 응답 원문은 기록하지 않는다. 새 기능이 배포되기 전에는 등록 callback 동작이 완료된 것으로 표시하지 않는다.

1. 별도 Star/Feedback App 등록과 각각의 최소 권한을 확인한다. 테스트 사용자, 다른 소유자의 공개 스타 테스트 repo, 제작자가 관리하는 별도 공개 이슈 테스트 repo를 정한다. 각 repo의 숫자 ID를 확인하고 테스트 허가를 기록한다. 실제 테스트 사용자에게 새 권한을 직접 승인받는다.
2. Star App 사용자 승인 흐름에서 일회성 state·브라우저 nonce·PKCE S256·고정 callback과 `offline_access`를 확인한다. 발급받은 user token으로 `GET /user`의 숫자 user ID가 승인한 테스트 계정인지 검증한다. 승인 화면에 Issues 쓰기가 없어야 한다.
3. 스타 대상은 테스트 사용자에게 관리 권한이 없고, Star App과 Feedback App이 설치되지 않은 공개 repo를 고른다. user token으로 `GET /repos/{owner}/{repo}`를 요청해 공개 여부·현재 이름·숫자 ID를 확인한다. 기존 스타를 훼손하지 않도록 `GET /user/starred/{owner}/{repo}`가 404인 새 테스트 대상을 사용한다.
4. 같은 user token으로 `PUT /user/starred/{owner}/{repo}` → 204, GET → 204를 확인한다. GitHub 사용자 starred 화면과 repo 페이지에서 실제 사용자 스타가 확인되는지 기록한다. 다시 PUT 후 GET도 204여야 하며 중복 스타가 생기지 않아야 한다.
5. `DELETE /user/starred/{owner}/{repo}` → 204, GET → 404를 확인하고 GitHub 화면에서도 취소되었는지 확인한다. 404 앞뒤로 같은 repository 숫자 ID가 유지되는지 확인한다. 이 단계가 실패하면 “설치 없는 공개 repo 개인 스타 가능” 완료 기준은 미충족이다. 넓은 OAuth 권한으로 대체하거나 Feedback App 설치를 강요하지 않는다.
6. 제작자에게 Feedback App의 선택 저장소 설치와 GitHub 공개 전송 동의를 받는다. 제작자 관리 확인용 user token으로 repo의 `permissions.admin=true`와 해당 사용자의 installation repo 숫자 ID를 검증한다. 조직 repo이면 승인 대기/관리자 승인까지 별도로 확인한다.
7. Feedback App JWT로 `GET /app`, `GET /app/installations/{installationId}`를 확인한다. App ID·설치 ID·suspended 여부·Issues 쓰기와 Metadata 읽기를 확인한 뒤 `POST /app/installations/{installationId}/access_tokens`에 테스트 repo ID와 최소 permissions를 넣는다. 발급 응답의 repo/permission 제한과 만료를 확인한다.
8. installation token으로 테스트 repo metadata를 다시 확인한다. 합의한 테스트 제목·본문·고유 marker로 `POST /repos/{owner}/{repo}/issues`를 **한 번** 호출한다. 201과 issue 숫자 ID·number·repository URL·html URL의 대상 일치를 확인하고 작성자가 `{feedback-app-slug}[bot]`인지 GitHub 화면에서 확인한다. 결과 URL과 marker를 기록한다. 정리는 테스트 repo 관리자가 승인된 방식으로 진행한다.
9. 승인 거절·user 권한 회수·설치 repo 제외·Issues 비활성·보관된 repo를 전용 테스트에서 확인한다. 실패가 성공으로 표시되거나 대상이 다른 repo로 바뀌면 검증 실패다. timeout/5xx는 같은 POST를 반복하지 않고 `state=all` 이슈 목록의 모든 필요한 페이지에서 marker를 조회하여 결과를 확인한다.

## 증거와 현재 결과

| 검증 | 현재 상태 | 필요한 증거 |
|---|---|---|
| 최소 권한 Star App 등록·사용자 승인 | 미실행 | 승인된 App ID/권한·테스트 user 숫자 ID |
| App 미설치 타인 공개 repo 스타→조회→취소 | 미실행 | repo ID, 각 204/404, GitHub 실제 결과와 수행 시각 |
| repo로 제한한 Feedback installation token | 미실행 | App/설치/repo ID, 제한 permissions·만료 확인 |
| 앱 봇 이슈 1건 생성 | 미실행 | 201, 검증된 issue ID/number·URL·봇 작성자 |
| 권한 회수·실패·재조회 실제 결과 | 미실행 | 차단/보류 상태·대상 ID·marker 재조회 증거 |

2026-10-11 로컬 PR-01 검증:

- 최초 계약 RED: `npx vitest run tests/github-integration-client.test.ts tests/github-apps.test.ts` — 신규 계약 2개 실패, 기존 3개 통과.
- transport/security RED: 같은 명령 — 66개 실패 / 28개 통과. 순수 JWT 추출 RED: `npx vitest run tests/github-apps.test.ts` — 1개 실패 / 3개 통과.
- 추가 회귀 RED: URL 정규화 traversal·403 진단 body 중단 2개 실패 후 수정. malformed runtime options RED: null/undefined 2개 실패 후 수정.
- 최신 GREEN: `npx vitest run tests/github-integration-client.test.ts tests/github-apps.test.ts` — 2개 파일, **102개 테스트 통과**. 외부 GitHub 호출은 Response/stream 어댑터로 격리했다. 실제 권한 검증의 증거로 사용하지 않는다.
- 변경 파일 ESLint: `npx eslint lib/github/client.ts lib/github/repositories.ts lib/github/app-jwt.ts lib/crawl/github-apps.ts tests/github-integration-client.test.ts tests/github-apps.test.ts` — 마지막 코드 변경 뒤 재실행, 종료 0, 오류·경고 없음.
- `git diff --check` — 종료 0.
- `npx tsc --noEmit --incremental false` — 종료 2. Next `PageProps` 타입 생성 누락과 병렬 구현 중인 계정·피드백 모듈 때문에 전체 실패; PR-01 파일 진단은 없었다. 공통 CI는 root 통합 검증에서 수행한다.

실제 capability 완료는 위 외부 증거가 모두 채워진 뒤에만 기록한다. 현재 외부 쓰기·App 등록·운영 플래그 활성화는 수행하지 않았다.
