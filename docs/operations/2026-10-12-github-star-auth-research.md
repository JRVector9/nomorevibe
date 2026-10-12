# GitHub 개인 스타 연동 조사 보고서

조사일: 2026-10-12. GitHub 공식 문서·공식 변경 공지, 동일 증상의 개발자 직접 보고, 현재 저장소 코드와 운영 관측을 대조했다. 사용자 요청에 따라 이 단계는 조사와 보고만 수행한다. 아래 PR은 구현 제안이며 착수하지 않았다.

## 판단

현재 운영에서 개인 스타 변경은 실패한다. GitHub App의 사용자 스타 관리 권한과 유효 토큰을 확인하고, 사용자가 자신의 공개 저장소에 App을 설치한 뒤에도 ManimGX 스타 변경이403으로 거절됐다. 가장 유력한 원인은 **타인 저장소에 대한 GitHub App의 설치·접근 범위 제약**이다. 내 저장소 설치와 대상 제작자의 저장소 접근은 다른 조건이다.

GitHub는 스타 API의 GitHub App user token 지원을 명시한다. 따라서 GitHub App으로 모든 개인 스타가 불가능하다고 단정하지 않는다. 다만 **제작자의 앱 설치 없이 임의의 공개 프로젝트에 일반 사용자가 스타를 남긴다**는 NoMoreVibe 요구사항을 현재 방식으로 충족했다는 증거는 없다. 문서와 실제 실패가 설명하는 제약을 해결해야 한다. [공식 스타 API](https://docs.github.com/en/rest/activity/starring#star-a-repository-for-the-authenticated-user), [사용자 대신 동작하는 App의 접근 제한](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user).

## 실제 확인한 결과

| 항목 | 결과 | 해석 |
|---|---|---|
| 대상 | 공개 `academa-labs/manimgx`, repository ID1406372374 | 단순 이름 변경·비공개 저장소 문제와 구분 |
| 기존 사용자 token check |200, Star App client 일치 | 잘못된 앱 토큰·무효 토큰이 아님을 확인 |
| 등록 App 권한 / GitHub 승인 화면 |metadata read, starring write / 스타 조회·관리 승인 표시 | 승인 누락으로 단정할 근거 없음. 특정 발급 토큰의 권한 승인 시점은 별도 확정하지 않음 |
| 사용자 설치 |설치 ID170548389, `JRVector9/nomorevibe` 하나, selected, suspended false | 설치 수0→1을 UI 및 API로 확인. ManimGX에 설치됐다는 뜻은 아님 |
| 설치 후 ManimGX UI 클릭 |권한 거절 안내, 숫자447 유지 | 성공한 척 숫자를 증가시키지 않음 |
| 운영 영수증 |`star_write_rejected`,403, unstarred, desired null, lease 없음 | 요청이 서버에 도착해 확정 거절됨. 초기502 매핑은 PR390으로403 보존 수정 |
| 앞선 REST / GraphQL 쓰기 |403 / FORBIDDEN, 동일한 integration 접근 거절 | API 형식만 바꿔 해결됐다는 증거 없음 |
| 현재 공개 표시 수 / 앞선 GraphQL 관측 수 |447 /711 | 서로 다른 시점의 수집값과 관측값. 현재 숫자를 완전한 실시간 총합으로 볼 수 없음 |

현재 토큰을 새로 승인받은 동일 범위 토큰과 비교하거나, App이 설치된 다른 저장소에서 성공하는지를 대조하는 검증은 아직 하지 않았다. 제작자 계정의 실제 Star App 설치를 직접 조회해 확정하지도 않았다. 설치 범위 원인은 공식 접근 모델과 같은 증상의 직접 보고에 부합하는 **강한 추론**이며 GitHub가 이 사례를 판정한 결과는 아니다.

## 문서에서 확인한 조건

1. **스타 권한은 사용자 권한과 저장소 권한을 함께 요구한다.** `PUT /user/starred/{owner}/{repo}`는 사용자 starring write와 저장소 metadata read를 요구하고 성공은204다. installation token은 이 개인 스타 쓰기의 지원 토큰 목록에 없으므로 서비스 봇 토큰으로 사용자의 스타를 대체할 수 없다. 현재 transport는 문서가 요구하는 Content-Length0도 이미 전송한다. [스타 API 요구사항](https://docs.github.com/en/rest/activity/starring#star-a-repository-for-the-authenticated-user).

2. **GitHub 로그인 승인과 App 설치는 별개다.** 사용자 승인은 그 사용자 대신 동작하는 권한이고, 설치는 선택한 저장소에 대한 App 접근이다. 둘 중 하나만 할 수도 있다. `Any account`는 설치할 수 있는 계정의 범위이지, 모든 계정의 저장소에 자동 접근을 부여하는 설정이 아니다. 내 계정에서 All repositories를 선택해도 타인 저장소가 추가되는 것은 아니다. [승인과 설치의 차이](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps#difference-between-authorization-and-installation), [두 App 유형의 저장소 접근 비교](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).

3. **공개 저장소 읽기 성공은 쓰기 가능의 증거가 아니다.** GitHub App user token은 공개 리소스에 대한 암묵적 읽기 접근이 있지만, App의 저장소 권한은 설치된 계정의 저장소 범위와 연결된다. GET으로 대상이나 개인 상태를 읽었다고 PUT 성공을 보장할 수 없다. [GitHub App 권한 모델](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

4. **`offline_access`를 잘못 넣어서 스타 쓰기 권한이 줄어든 것은 아니다.** GitHub App에서는 이 값이 만료·refresh token 발급을 요청하며 사용자 권한을 정하지 않는다. `public_repo`를 현재 GitHub App 승인 URL에 추가하는 방식은 지원되지 않는다. [GitHub App user token 발급](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

5. **같은 증상의 직접 보고가 있다.** GitHub Community #59559에서2024-08-28 개발자가 대상 소유자에게 App이 설치되지 않으면 개인 스타가 실패한다고 보고했고,2025-08-06 다른 개발자는 OAuth App으로 해결했다고 보고했다. 이 글은 Closed/Unanswered이며 GitHub 직원의 확정 설명이나2026년 동작 보증은 아니다. 공식 문서와 실제 운영 관측을 보강하는 사례로만 사용한다. [해당 개발자들의 직접 보고](https://github.com/orgs/community/discussions/59559).

6. **최근 stargazer 제한과 개인 스타 쓰기를 혼동하면 안 된다.**2026-06-30 공지는 stargazer/watcher 명단 API·UI 접근을 다룬다. 현재 실패한 개인 스타 PUT의 원인을 이 공지만으로 설명할 수 없다. 최신 스타 문서는 총수 조회와 개인 스타 쓰기를 별도 endpoint로 제공한다. [공식 변경 공지](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/), [스타 API](https://docs.github.com/en/rest/activity/starring).

## 가능한 서비스 방식

| 방식 | 일반 사용자에게 필요한 작업 | 제작자 설치 | 장점 / 제약 |
|---|---|---|---|
| 현재 Star GitHub App |GitHub 사용자 승인 |현재 관측·문서에 따르면 대상 접근 범위를 충족해야 함 |starring만 세밀하게 승인 가능. 미설치 타인 프로젝트 전체 지원은 검증 미충족 |
| 별도 Star OAuth App |GitHub 로그인과 `public_repo` 권한 승인 |GitHub App 저장소 설치 흐름은 없음 |임의 공개 프로젝트 개인 스타에 적합한 대안. 스타 외 공개 저장소 쓰기까지 권한이 넓음 |
| GitHub 페이지로 이동 |GitHub에서 직접 별 클릭 |없음 |서비스에 쓰기 토큰을 맡기지 않지만 서비스 안에서 즉시 반영하는 요구는 충족하지 못함 |

OAuth App에서 공개 저장소 스타에 요구하는 범위는 `public_repo`다. 이 범위는 사용자가 원래 권한을 가진 공개 저장소의 코드·협업자·상태 등 쓰기도 포함한다. private 저장소까지 포함하는 `repo`는 이 스타 목적에 요청할 이유가 없다. GitHub가 문서화한 OAuth scope에는 공개 스타 쓰기만 허용하는 별도 좁은 scope가 없다. **실제 GitHub 승인 범위가 넓다는 사실을 사용자에게 표시하고 선택 동의를 받아야 한다.** 서버 endpoint를 스타 API로 제한하는 것은 추가 통제이지 GitHub token 자체의 범위를 좁히는 방법은 아니다. [OAuth scope 정의](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

OAuth App 역시 조직 정책·사용자 접근 권한·권한 회수에 영향을 받는다. 모든 저장소에서 항상 성공한다고 보장하면 안 된다. 실패는 실제 결과로 안내해야 한다. [조직 OAuth 접근 제한](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions).

## 권장안과 코드 영향

제작자 설치 없이 외부 공개 프로젝트에 서비스 안에서 개인 스타를 남기는 요구를 유지하려면 **별도 Star OAuth App을 평가하는 것이 권장안**이다. 먼저 전용 사용자·합의된 다른 소유자의 공개 저장소에서 실제 추가·조회·취소 결과를 확인한 뒤 전환한다. 현재 조사에서는 OAuth App 자격을 등록하거나 토큰을 발급·사용하지 않았으므로 OAuth 대안이 ManimGX에서 성공했다고 주장하지 않는다.

로그인 자체와 공개 저장소 쓰기 동의를 구분하고, 스타를 사용하려는 사용자에게 필요한 권한과 연결 목적을 설명한다. 서비스 계정 자격 하나로 모든 사용자의 스타를 올리는 방식이 아니라 각 사용자가 승인한 token으로 그 사용자 명의의 스타를 남긴다. GitHub OAuth 로그인 경로의 이메일 코드는 필요하지 않으므로 스타를 위해 Resend 키를 요구할 이유는 없다.

새 OAuth App의 설정 후보는 homepage `https://nomorevibe.com`, callback 기존 `/api/auth/user/github/callback`이다. App 등록과 Client ID/Client Secret이 필요하고, OAuth user token 발급 자체에는 GitHub App ID/private PEM이 필요하지 않다. 기존 Star GitHub App의 키를 그대로 바꿔 넣는 것으로 끝낼 수는 없다. [OAuth App 등록](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

현재 코드의 token parser는 `ghu_`, empty scope, refresh token을 전제로 한다. OAuth의 `gho_`, 실제 승인 scope 검증, 갱신·재연결을 다뤄야 한다. 최신 공식 문서는 OAuth App에도 PKCE와 만료·refresh token을 지원한다. `public_repo`와 `offline_access`를 이용하는 만료 token 경로를 검토할 수 있다. [OAuth 승인과 만료 token](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

기존 `github_user_connections`에는 인증 App 유형·Client ID·scope 구분이 없고, Star GitHub App의 권한 회수 webhook은 GitHub user ID로 active 연결을 무효화한다. 전환 시 옛 App webhook이 새 OAuth 연결을 지우지 않도록 연결 종류를 구분해야 한다. 필요한 최소 DB 변경 여부는 이 이행 방식에서 결정한다. 기존 암호화·nonce·PKCE·CSRF·revision/refresh lease 및 repo 숫자 ID 검증은 재사용할 수 있다.

| 제안 PR | 필요한 변경 | 완료 기준 |
|---|---|---|
| PR-R01 — 연동 정책·실제 capability 확정 |스타 전용 OAuth 등록·권한 동의·타인 공개 repo 파일럿. 기본 App 유지 대조가 필요하면 합의된 설치 repo와 새 동일 권한 token 비교 |OAuth 방식의 PUT204→GET204→DELETE204→GET404 및 사용자 명의 결과. 성공 전 전체 활성화 완료 보고 금지 |
| PR-R02 — 최소 인증·token 이행 |승인 범위 검증, expiring OAuth token 지원, 기존 연결 재승인·회수 및 옛 webhook과의 구분 |기존 계정/로그인 유지, token 혼용·회수 오적용 없음. 보호된 PR 필수 CI와 사용자의 직접 기능 검증 |
| PR-R03 — 상단 스타와 총수 표시 마무리 |필요한 연결/동의 UI, 확정 성공 후 개인 상태와 최신 총수 반영, 거절·수집 시점 표시 |ManimGX 실제 스타 변화와 상단 표시 일치. 현재 수집값±1을 GitHub 실시간 총수라고 표시하지 않음 |

## 피드백 작성자에 대한 별도 확인

현재 피드백은 `lib/domain/feedback/github/deliver.ts`에서 제작자 설치 token으로 Issues POST를 하고, 본문에 서비스 닉네임·원문 링크를 넣는다. 따라서 GitHub 이슈 작성자는 Feedback App 봇이며 `BBBB` GitHub 계정 작성자로 남는 구현이 아니다. 설치 token으로 수행한 활동이 App에 귀속된다는 공식 모델과 같다. [설치 token의 활동 귀속](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

`BBBB` 본인이 GitHub 이슈 작성자로 남아야 한다면 사용자 token을 사용하는 별도 전송 설계가 필요하다. Issues 쓰기 권한·공개 전송 동의·대상 정책과 기존 outbox 중복 방지 조건도 확인해야 한다. 스타 인증 전환만으로 이 기능까지 자동 변경되는 것은 아니다. [사용자 대신 동작할 때의 활동 귀속](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user), [이슈 생성 API](https://docs.github.com/en/rest/issues/issues#create-an-issue).

## 조사 범위와 다음 판단

기존 오류 안내 PR390은 운영에 반영됐고 네 feature flag는 ON이다. 이번 설치 후 직접 클릭도 실패했으므로 플래그 ON이나 CI 성공을 기능 성공으로 해석하지 않는다. 이후 사용자가 문서 조사 우선을 지시하여 추가 외부 쓰기·앱 등록·권한 확대·구현·배포를 진행하지 않았다. 새 테스트도 작성·실행하지 않았다.

공식 지원 문의가 필요하면 승인된 별도 요청에서 endpoint·시각·안전한 request ID·등록 권한·대상 설치 범위를 제출할 수 있다. 이 조사에서는 누구에게도 메시지나 이슈를 보내지 않았다. 현재 최우선 결정은 넓은 `public_repo` 권한을 사용자 선택 동의로 도입할지, 제작자 설치가 필요한 통합 범위를 서비스 조건으로 둘지다.
