# 개인 GitHub 스타·상세 피드백 활성화 준비 — 2026-10-11

## 실제 설정 상태

2026-10-11 **23:11:05 KST**, Dokploy의 `application.one`을 읽기 전용으로 새로 조회했다.
환경값은 메모리에서만 비교했고 비밀값·이메일·개인키를 출력하거나 저장하지 않았다.
아래는 **앱에 저장된 설정**이며 실행 컨테이너, 제공자 계정 또는 기능 동작을 확인한 결과가 아니다.

| 앱 쌍 | `NEXT_PUBLIC_SITE_URL` | 설정 `RELEASE_TAG` | 새 연동 키 |
| --- | --- | --- | --- |
| 웹 mini·M3 | `https://nomorevibe.com` | `8b608b2a7abc89cfacb830d3fdf14825b22d4d13` | 아래 14개 모두 없음/빈 값 |
| publisher mini·M3 | 없음 | `8b608b2a7abc89cfacb830d3fdf14825b22d4d13` | Feedback App ID·private key 없음/빈 값 |
| maintenance mini·M3 | 없음 | `650b341c8889f06b2ec3daa3b99da4e5712fee1a` | Feedback App ID·private key 없음/빈 값 |

6개 앱 모두 `applicationStatus=done`이었다. 네 플래그
`PUBLIC_USER_AUTH_ENABLED`, `GITHUB_STAR_ENABLED`, `PRODUCT_FEEDBACK_ENABLED`,
`GITHUB_FEEDBACK_DELIVERY_ENABLED`는 **설정에 존재하지 않아 유효 값이 모두 `false`**다.
키가 운영 환경에 없다는 사실은 제공자 계정에 App이나 발신 도메인이 존재하지 않는다는 뜻이 아니다.
키 유효성·권한·메일 도착·실제 GitHub 쓰기는 아직 확인하지 않았다.

## 이미 구현된 진입점

`app/p/[slug]/page.tsx`는 플래그가 켜지면 기존 개인 스타 버튼과 피드백 영역을 렌더한다.
`GithubStarButton.tsx`에 로그인/연결·조회·등록/취소·재연결이 있고,
`FeedbackForm.tsx`와 `FeedbackList.tsx`에 오류/기능 제안/질문 제출, 공개 동의,
공개 목록·내 기록·원문 및 GitHub 전송 상태가 있다. 제작자 수신 설정은 `/p/<slug>/github`다.
이메일 로그인만으로 로컬 피드백을 작성하며 개인 스타에는 별도 Star App 승인이 필요하다.
현재 요청의 기능을 노출하기 위해 새 API나 폼을 추가해야 한다는 근거는 확인되지 않았다.
이 기록은 소스 읽기 결과이고 화면·실제 흐름 검증은 아니다.

## 필요한 설정

웹 두 앱에 다음 14개 값을 같은 값으로 주입한다. 관리자 `AUTH_SECRET`이나 수집용
`GITHUB_TOKEN`, 기존 관리자 OAuth 자격 정보를 재사용하지 않는다.

| 용도 | 필요한 이름 |
| --- | --- |
| 일반 로그인 | `PUBLIC_AUTH_SECRET`, `LOGIN_EMAIL_API_KEY`, `LOGIN_EMAIL_FROM` |
| 사용자 토큰 암호화 | `GITHUB_INTEGRATION_SECRET` |
| 개인 Star App | `GITHUB_STAR_APP_ID`, `GITHUB_STAR_APP_CLIENT_ID`, `GITHUB_STAR_APP_CLIENT_SECRET`, `GITHUB_STAR_APP_WEBHOOK_SECRET` |
| Feedback App | `GITHUB_FEEDBACK_APP_ID`, `GITHUB_FEEDBACK_APP_SLUG`, `GITHUB_FEEDBACK_APP_CLIENT_ID`, `GITHUB_FEEDBACK_APP_CLIENT_SECRET`, `GITHUB_FEEDBACK_APP_PRIVATE_KEY`, `GITHUB_FEEDBACK_APP_WEBHOOK_SECRET` |

`PUBLIC_AUTH_SECRET`과 `GITHUB_INTEGRATION_SECRET`은 각각 32자 이상이며 서로 및
관리자 `AUTH_SECRET`과 다르게 준비한다. 두 webhook secret도 각각 32자 이상이고 서로 달라야 한다.
두 GitHub App의 ID·client ID·client secret·webhook secret은 각각 다른 값이어야 한다.
Feedback private key는 해당 App이 발급한 PEM 전체를 보존한다.

publisher·maintenance 네 앱에는 `GITHUB_FEEDBACK_APP_ID`,
`GITHUB_FEEDBACK_APP_PRIVATE_KEY`, `NEXT_PUBLIC_SITE_URL=https://nomorevibe.com`을 주입한다.
전송 플래그는 웹을 포함한 6개 앱에 같은 값으로 명시한다.
웹 두 앱에는 네 플래그를 명시한다. 처음에는 모두 `false`로 저장하고 준비가 끝난 단계만 연다.

메일 발송 구현은 Resend다. `LOGIN_EMAIL_API_KEY`에는 발송 가능한 서버 API key,
`LOGIN_EMAIL_FROM`에는 운영자가 정한 검증 도메인의 발신 주소가 필요하다.
Resend 계정의 발신 도메인 검증 완료 여부를 확인해야 한다.
[Resend 공식 문서](https://resend.com/docs/dashboard/domains/introduction)

## GitHub App 설정값

두 앱의 Homepage URL은 `https://nomorevibe.com`이다.

| 설정 | Star App | Feedback App |
| --- | --- | --- |
| OAuth callback | `https://nomorevibe.com/api/auth/user/github/callback` | `https://nomorevibe.com/api/auth/maker/github/callback` |
| Setup URL | 이 흐름에서 사용하지 않음 | `https://nomorevibe.com/api/github/installations/setup` |
| Webhook URL | `https://nomorevibe.com/api/github/webhooks/star` | `https://nomorevibe.com/api/github/webhooks/feedback` |
| Account permissions | Starring: Read and write | 추가 account 권한 없음 |
| Repository permissions | Metadata: Read | Issues: Read and write, Metadata: Read |

개인 스타의 조회·등록·취소는 GitHub App **user access token**과 Starring 권한을 사용한다.
[GitHub Star API 권한](https://docs.github.com/en/rest/activity/starring#star-a-repository-for-the-authenticated-user)
Feedback은 제작자가 **Only select repositories**로 설치하고 공개·비보관·Issues 활성 저장소를 선택해야 한다.
서버가 발송할 숫자 repository ID 하나로 installation token을 제한한다.
Issues 쓰기 권한은 [GitHub Issue API 문서](https://docs.github.com/en/rest/issues/issues#create-an-issue)를 따른다.

두 앱 모두 **Expire user authorization tokens**를 켜 둔다. 현재 토큰 파서는 만료 시각이 있는
access token과 refresh token 쌍을 요구한다. 다른 제작자 계정·조직에도 설치하게 하려면
**Where can this GitHub App be installed? → Any account**로 설정한다.
Feedback App은 별도 Setup URL을 쓰므로 **Request user authorization (OAuth) during installation**을
끄고 OAuth→설치의 기존 사이트 흐름을 사용한다. Webhook은 Active·SSL verification을 켜고
각각의 secret을 적용한다. Feedback은 Issues 이벤트도 구독한다. 서버는
`github_app_authorization`, `installation`, `installation_repositories`, `issues` 이벤트를 처리한다.
[GitHub App 등록 공식 문서](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

제작자 연결은 일반 로그인, 해당 제품 수정키, 현재 저장소의 GitHub admin 권한 및 설치 확인을
모두 요구한다. 조직 설치 승인 대기는 연결 완료로 처리하지 않는다.

## 활성화 순서와 남은 일

1. 운영자가 두 App의 실제 설정과 Resend 발신 도메인을 확인하고 위 값을 비밀 저장소에서 주입한다.
   이 설정 조사 단계에서는 자격 정보를 생성·회전하거나 제공자 설정을 바꾸지 않았다.
2. 웹·publisher·maintenance의 origin을 맞추고, 각 역할 쌍의 설정과 실행 릴리스를 확인한다.
   maintenance 설정 릴리스는 이번 조회에서 웹/publisher와 달랐다. 공통 배포 스크립트의
   maintenance 검사는 읽기 전용이며 두 앱의 수동 릴리스 절차는 기존 runbook을 따른다.
3. 웹 두 앱에 `PUBLIC_USER_AUTH_ENABLED=true`를 적용한 뒤 사용자가 이메일 로그인을 확인한다.
4. 로컬 피드백은 웹 두 앱에 `PRODUCT_FEEDBACK_ENABLED=true`를 적용한다.
   개인 스타는 유효 Star App 설정이 준비된 뒤 웹 두 앱에 `GITHUB_STAR_ENABLED=true`를 적용한다.
5. GitHub 이슈 전송은 Feedback App 설정·제작자 binding·별도 공개 동의가 준비된 제품부터 연다.
   `GITHUB_FEEDBACK_DELIVERY_ENABLED=true`는 웹·publisher·maintenance 6개 앱에 맞춘다.
   과거 피드백을 자동 일괄 전송하지 않는다.
6. 사용자가 직접 확인한 이메일 로그인·개인 스타·피드백·봇 이슈·웹훅 결과만
   [파일럿 기록](2026-10-11-github-integration-pilot.md)에 실제 증거로 남긴다.

기존 상세 운영 절차는 [GitHub 스타·피드백 runbook](github-stars-feedback-runbook.md)과
[독립 워커 runbook](independent-workers-runbook.md)을 따른다.
이 읽기 전용 설정 조사 단계에서는 테스트를 작성하거나 실행하지 않았고, DB·브라우저·CI·배포·기능 플래그 변경·
실제 메일·스타·이슈 쓰기를 수행하지 않았다. 소개 검수의 중단 상태도 변경하지 않았다.

## 등록 준비 후속 상태

사용자가 GitHub 재인증을 완료했다. @JRVector9 계정에서 `NoMoreVibe Star`와
`NoMoreVibe Feedback` 등록 양식을 위 URL·최소 권한으로 준비했다. 두 앱의 secret은
비어 있으며 Create를 누르지 않았다. 브라우저 도구의 새 보안 권한 생성 확인과
자격증명 입력 인계 절차를 거친 뒤 등록·키 주입을 이어간다. 운영 플래그는 그대로다.

## 화면 변경 운영 반영 — 2026-10-11 23:50 KST

PR #363(정보 패널 축소·도구 섹션 제거), #364(미리보기 확대), #365(README 전문·내부 스크롤)는
각각 최신 main 기준 필수 CI check 성공 후 병합했다. 최종 main CI `38148216532`가
성공했고 private web image가 발행됐다. 두 웹에 같은 릴리스를 함께 배포했다.

- 실행 릴리스: `a91eecf2a3e3ef1e457acce47d9234c685f7c4a6`
- 웹 이미지: `ghcr.io/jrvector9/nomorevibe-runtime-web@sha256:638039d10f6cf75364c814d3c3c2a10659962f89a3f22dea3b97afb2ce67f2bc`
- mini 배포: `jReyg8165rBJSiZRJABFF`, 실행 복제본2개 확인
- M3 배포: `2JMxitPFP1q_9BVvlBc8S`, 실행 복제본4개 확인
- 공개 health에서 `mini-web`·`m3-web` 모두 새 release·status/db ok 확인

기존 웹 설정과 복제본 수를 보존했다. 기능 플래그는 여전히 실효 false이고
App 등록·키 주입·메일 발신 설정·기능 실사용 검증은 미완료다. 사용자에게 요청한
등록 확인과 Resend 발신 정보가 도착하면 해당 설정을 이어간다.

## 사용자 생성 키 연결 — 2026-10-12

두 GitHub App은 등록 완료했고 공개 설치·최소 권한·콜백·웹훅 설정을 확인했다.
사용자가 Client Secret을 `.env.local`에 보관했다고 알려 주어
`GITHUB_STAR_SECRET`을 `GITHUB_STAR_APP_CLIENT_SECRET`으로,
`GITHUB_FEEDBACK_SECRET`을 `GITHUB_FEEDBACK_APP_CLIENT_SECRET`으로 연결했다.
원본 파일은 변경하지 않았다. 이 두 값은 OAuth Client Secret이며 웹훅 secret으로 사용하지 않는다.

사용자가 제공한 Feedback PEM은 비밀값을 출력하지 않고 형식·키 크기를 확인했고,
메모리에서 만든 JWT로 GitHub `GET /app`을 읽어 HTTP 200과 App ID 일치를 확인했다.
이 확인은 개인 스타·OAuth·메일 발송·이슈 작성의 성공을 의미하지 않는다.

저장소 밖 0700 디렉터리의 0600 staging 파일에는 GitHub와 서버 내부 12개 값이 준비됐다.
현재 누락은 **`LOGIN_EMAIL_API_KEY`와 `LOGIN_EMAIL_FROM`**이다.
Root가 사전 점검과 반영 코드를 검토한 뒤 준비된 값을 운영 저장 설정에 반영했다.
**2026-10-12 01:21:47 KST** 재조회에서 두 웹의 12개 값과
publisher·maintenance 네 앱의 Feedback App ID·PEM·origin을 확인했다.
앱 간 값 일치와 비대상 환경값·기존 자격 정보·이미지·source·복제본·릴리스 보존도 확인했다.
네 플래그는 6개 앱 모두 명시적으로 false다. **배포하지 않았으므로 실행 컨테이너 반영은 아직이다.**
메일·스타·이슈 쓰기는 수행하지 않았다. 메일 두 항목을 준비하고 제공자 웹훅 입력을 확인한 뒤
실행 반영과 단계별 활성화를 이어간다.
GitHub General의 웹훅 secret은 staging의 해당 값으로 사용자 직접 입력·Save가 필요하다.


## GitHub 로그인과 메일 의존 정정 — 2026-10-12

앞 기록의 메일 두 항목은 **이메일 로그인에만 필요**하다. 기존 GitHub OAuth는 익명 사용자도
GitHub numeric identity로 일반 계정과 세션을 만들므로 Resend 없이 가입·로그인할 수 있다.
웹 두 앱의 일반 인증·GitHub 스타 플래그와 필요한 Star App/내부 키를 함께 준비하면 된다.
이메일 발송 설정이 없으면 로그인 화면의 이메일 폼을 숨기고 GitHub 로그인을 먼저 표시한다.
배포 검사도 GitHub 로그인만 쓰는 완전한 구성은 허용하고 메일 부분 입력·웹 간 불일치는 거부한다.
이 변경은 로그인 화면·배포 검사 코드 단계이며, 이 기록 시점의 운영 플래그는 여전히 false다.
실제 실행 릴리스 반영·사용자 GitHub 승인·스타/피드백 확인은 별도로 기록한다.
제공자 웹훅 Save 확인과 제작자 Feedback App 설치·수신 조건은 메일 설정과 별개다.


## 로그인 코드 반영 완료 — 2026-10-12 09:07 KST

[PR374](https://github.com/JRVector9/nomorevibe/pull/374)의 최신 base 필수 CI가 성공했고
`58a63a3bc180f3e9cce3670ebb5b52a11cf6c3ef`로 main에 병합했다. GitHub 우선 가입·로그인,
메일 설정이 없을 때 이메일 폼 숨김, GitHub-only 배포 검사 수정이 완료됐다.
독립 gpt-6.1-sol/xhigh 소스 리뷰는 수정 지적이 없었다. 실제 기능 테스트는 사용자 담당이다.

09:07:17 KST Dokploy 저장 설정 재조회에서는 두 웹 `a91eecf`, publisher `8b608b2`,
maintenance `650b341` 릴리스와 6개 앱의 네 플래그 false를 확인했다.
이 작업에서는 운영 배포·DB 적용·플래그 ON·제공자 Save를 하지 않았다.
Resend는 이메일 로그인 선택 시에만 필요하다. 운영 적용은 같은 실행 릴리스·키/origin과
제공자 웹훅 Save를 확인하고 기존 홈 관측 마이그레이션·자료 축적 절차와 함께 진행한다.


## GitHub 웹훅 제공자 설정 — 2026-10-12 10:09 KST

사용자가 GitHub 웹훅 설정을 요청했다. 두 웹의 저장 환경에서 App ID와 각각의
webhook secret이 일치하고 서로 다른 32자 이상 키임을 값 출력 없이 확인했다.
일반 Client Secret을 웹훅 secret으로 재사용하지 않았다.

Feedback App5275280은 사용자 제공 PEM과 저장 PEM이 일치하고 JWT `GET /app`의
ID·slug·owner가 맞으며 Issues write/Issues 구독이 유지됨을 확인했다.
제공자 `GET /app/hook/config`에서는 기존 Secret 미설정 상태였다.
공식 API `PATCH /app/hook/config`로 저장 환경과 동일한 Feedback webhook secret을
적용했고 HTTP200 뒤 fresh GET에서 Secret 설정·JSON·SSL 검증·아래 URL을 확인했다.
General 화면의 Active도 켜져 있었다.

| App | Webhook URL | 10:09 시점 확인 |
| --- | --- | --- |
| Star5275277 | `https://nomorevibe.com/api/github/webhooks/star` | General의 URL·Active·SSL 검증 확인. Secret 입력·Save는 사용자 인계 중 |
| Feedback5275280 | `https://nomorevibe.com/api/github/webhooks/feedback` | 공식 API 저장과 재조회 완료, JSON·SSL 검증·Issues 구독 |

GitHub 재인증 화면은 사용자가 인증을 완료해 General 진입을 확인했다.
Star API 설정에 필요한 개인키는 발견하지 않았고 새 개인키를 만들지 않았다.
브라우저 도구의 인증정보 변경 규칙상 Star의 새 Secret 입력과 최종 저장은 사용자에게
인계했다. Star의 일반 공개 API에서 JRVector9/App5275277과 metadata read/starring write,
명시적 저장소 이벤트 구독 없음도 확인했다. 서비스 코드가 처리하는 승인 철회 이벤트와
저장소 Star 이벤트 구독을 혼동하지 않는다.

이번 작업은 제공자 웹훅 설정이다. 서비스 env·키 회전·플래그 ON·배포·DB 변경·
메일/스타/Issue 쓰기·웹훅 redelivery·기능 테스트는 하지 않았다.
실제 전송·서명 검증 성공은 운영 반영 후 사용자 확인 항목이다.
[GitHub 웹훅 설정 공식 API](https://docs.github.com/en/rest/apps/webhooks#update-a-webhook-configuration-for-an-app)


### 저장 후 재확인 — 2026-10-12 10:32 KST

사용자가 키 파일을 요청해 TextEdit에서 `star-webhook-secret.txt`가 열린 것을
확인했다. 내용은 출력하지 않았다. 클립보드 복사 및 저장 완료 답변 뒤 실제 Star
General을 다시 열고 reload했으나 Secret 입력란과 설정 안내가 남아 있었고
`Change secret` 표시가 없었다. Star Secret 저장 완료로 처리하지 않았으며
올바른 Star 앱에서 입력·저장하도록 다시 인계했다. URL·Active·SSL은 맞았다.
Feedback 공식 GET 재조회에서는 Secret 설정·JSON·SSL·URL·Issues 구독을 다시
확인했다. API는 Secret을 마스킹하므로 원문 일치를 GET만으로 판단하지 않는다.
이때 Star 사용자 저장 후 화면 확인을 기다리며 문서 PR을 보류했다.
문서 `git diff --check`는 실제 exit0. 기능 테스트와 운영 활성화는 하지 않았다.


### 두 웹훅 설정 완료 — 2026-10-12 10:36 KST

사용자가 Star Secret을 다시 입력·저장한 뒤 올바른 `nomorevibe-star` General을
새로고침했다. `Change secret` 표시, Active=1, SSL 검증=1, 정상 URL이 유지돼
Secret 설정 저장을 확인했다. Secret 원문은 읽어 출력하지 않았다.
Feedback은 같은 서버 저장 키로 최종 PATCH를 한 번 더 적용했다.
10:36:05 KST fresh GET은 정상 URL·JSON·SSL 검증·Secret 설정 상태와
Issues 구독을 확인했다. 서버 저장 설정과 제공자 입력에 서로 다른 앱 키를 사용했다.

| App | 최종 설정 확인 |
| --- | --- |
| Star5275277 | 사용자 Secret 저장 후 reload 확인, `/api/github/webhooks/star`, Active·SSL 켜짐 |
| Feedback5275280 | 서버 저장 Secret 최종 API 적용·GET 확인, `/api/github/webhooks/feedback`, JSON·SSL·Issues 구독 |

제공자 웹훅 설정 단계는 완료했다. Secret 마스킹/UI 상태만으로 실제 전송의
HMAC 성공을 주장하지 않는다. 서비스 실행 릴리스 반영·네 기능 플래그 ON·실제
로그인/스타/피드백 검증은 별도 운영 단계이며 이번 작업에서는 수행하지 않았다.
