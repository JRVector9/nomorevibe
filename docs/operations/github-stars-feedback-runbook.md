# GitHub 개인 스타와 제품 피드백 운영

이 문서는 일반 사용자 로그인, 개인 GitHub 스타, 서비스 피드백, 앱 봇 이슈 전송의 릴리스와 파일럿 절차를 다룬다. 기존 운영자 GitHub OAuth와 읽기용 `GITHUB_TOKEN`은 별도 인증이다. 현재 운영 구조와 공통 이미지 배포 절차는 [독립 워커 runbook](independent-workers-runbook.md)을 따른다.

운영 `SITE`와 `NEXT_PUBLIC_SITE_URL`은 `https://nomorevibe.com`이다. 앱 Homepage도 이 주소를 사용한다. 기능 활성화 전에 웹 2개·publisher 주/예비·maintenance 주/예비의 origin을 동일하게 맞춘다. 2026-10-11 도메인 전환에서는 웹 2개만 실제 설정·배포했고, 기능이 꺼진 워커의 origin/키 설정은 활성화 절차에서 검증한다. 이전 호스트의 세션 쿠키는 새 호스트로 옮겨지지 않으므로 다시 로그인한다.

## 설정과 권한

기능 플래그는 아래 네 값이며, 코드와 배포 검사는 누락한 값을 기본 `false`로 취급한다. 명시한 값은 정확한 `true` 또는 `false`만 허용하고 중복 설정은 거절한다. 역할 쌍의 유효 값은 일치해야 한다. 운영 설정에는 값을 명시하고 첫 코드 릴리스에서는 모두 `false`로 둔다.

| 플래그 | 활성화 전 확인 |
| --- | --- |
| `PUBLIC_USER_AUTH_ENABLED` | 일반 계정 세션 키와 로그인 수단. GitHub 로그인은 Star App 승인, 이메일 로그인은 선택적으로 Resend 발신 설정·메일 도착 확인 |
| `GITHUB_STAR_ENABLED` | 일반 인증, Star App 승인, 개인 계정의 스타 조회·등록·취소 |
| `PRODUCT_FEEDBACK_ENABLED` | 일반 인증, 서비스 공개 동의·작성 한도·검토·원문 조회 |
| `GITHUB_FEEDBACK_DELIVERY_ENABLED` | 로컬 피드백, Feedback App, 제작자 설치·수신 설정, publisher·maintenance 주/예비 릴리스 |

`PUBLIC_AUTH_SECRET`과 `GITHUB_INTEGRATION_SECRET`은 각각 32자 이상이며 서로 및 관리자 `AUTH_SECRET`과 다르게 생성한다. 키는 비밀 저장소에서 주입한다. 이슈·로그·파일럿 기록·공유한 명령 출력에 이메일, 토큰, 개인키, OTP, 수정키를 넣지 않는다.

| 역할 | 활성 기능에 필요한 값 |
| --- | --- |
| 웹 2개 | 네 플래그, `NEXT_PUBLIC_SITE_URL`; 일반 인증의 `PUBLIC_AUTH_SECRET`; 이메일 로그인 사용 시 `LOGIN_EMAIL_API_KEY`·`LOGIN_EMAIL_FROM`; GitHub 연동의 `GITHUB_INTEGRATION_SECRET`; Star App ID·client ID·client secret·webhook secret; Feedback App ID·slug·client ID·client secret·private key·webhook secret |
| publisher 주/예비 | `GITHUB_FEEDBACK_DELIVERY_ENABLED`, `NEXT_PUBLIC_SITE_URL`, Feedback App ID·private key |
| maintenance 주/예비 | `WORKER_ROLE=maintenance`, `GITHUB_FEEDBACK_DELIVERY_ENABLED`, `NEXT_PUBLIC_SITE_URL`, Feedback App ID·private key |

GitHub 로그인만 사용할 때는 웹 두 앱의 `PUBLIC_USER_AUTH_ENABLED=true`와
`GITHUB_STAR_ENABLED=true`를 함께 적용하고 Star App·세션·암호화 키를 준비한다.
Resend 없이 가입·로그인할 수 있으며 `LOGIN_EMAIL_API_KEY`와 `LOGIN_EMAIL_FROM`은
두 웹 모두 비워 둔다. 메일 값이 하나라도 입력되면 두 항목 모두 존재하고 웹 간 값이
일치해야 한다. `/login`은 GitHub 로그인을 먼저 표시하고, 완전한 메일 설정이 있을 때만
이메일 폼을 표시한다. 익명 OAuth의 nonce GET은 이메일을 발송하지 않는다.
피드백 작성은 별도로 `PRODUCT_FEEDBACK_ENABLED=true`가 필요하며, 외부 이슈 전송은
아래 제작자 설치·공개 동의 조건을 그대로 따른다.

비활성 기능의 제공자 키는 초기 배포에서 비워 둘 수 있다. 기능을 껐더라도 이미 발송한 요청의 결과를 확인할 키는 확인 작업이 끝날 때까지 유지한다. maintenance는 설치 및 이슈를 15분마다 확인하며 개인 스타 토큰을 선제적으로 갱신하지 않는다. Star App client secret과 사용자 토큰 복호화용 `GITHUB_INTEGRATION_SECRET`은 웹에만 제공한다. 배포 검사는 여러 줄 또는 escaped newline으로 저장한 quoted PEM의 전체 값을 비교하며 개인키를 출력하지 않는다.

제작자 설치 인증의 임시 사용자 토큰은10분 후 사용할 수 없다. 만료된 암호문은 기능 플래그가 꺼져 있어도 다음 maintenance 실행에서 폐기한다(정상 실행 주기 기준 최대15분 추가). 주기적 설치·이슈 조회는 제공자가 확정한 Retry-After/reset 시각까지 기다린다.

Star App과 Feedback App은 다른 App ID·client ID·client secret·webhook secret을 사용한다. Star App은 계정 Starring read/write, Feedback App은 선택 저장소의 Issues write와 Metadata read를 사용한다. Feedback 설치 토큰은 발송할 숫자 repository ID 한 개로 제한한다. 제작자 승인에는 일반 로그인과 해당 제품 수정키, 현재 저장소의 GitHub 관리 권한이 함께 필요하다.

| App | 설정 URL (`SITE`는 정확한 공개 origin) |
| --- | --- |
| Star App OAuth callback | `SITE/api/auth/user/github/callback` |
| Star App webhook | `SITE/api/github/webhooks/star` |
| Feedback App OAuth callback | `SITE/api/auth/maker/github/callback` |
| Feedback App setup | `SITE/api/github/installations/setup` |
| Feedback App webhook | `SITE/api/github/webhooks/feedback` |

조직의 설치 승인 대기는 binding 완료로 처리하지 않는다. Callback의 installation ID만으로 수신을 켜지 않는다. 저장소 변경·제품 차단·설치 삭제·정지·저장소 제외는 binding revision을 바꾸고 새 전송을 중지한다.

## 검증과 릴리스

1. 전용 staging DB에 migrations 0066~0072를 순서대로 적용하고 schema와 journal을 확인한다. 운영 DB에 테스트 초기화 함수를 실행하지 않는다. 새 플래그는 모두 `false`로 유지한다.
2. 단위·통합·브라우저 검사와 공통 CI를 실행한다. 브라우저 검사는 DB 세션과 제공자 결과 fixture를 사용하므로 실제 메일, OAuth 승인, 설치, 외부 이슈 생성의 증거와 따로 기록한다.
3. 릴리스 SHA와 web/worker digest를 확정한다. 기존 스크립트의 `plan`으로 8개 대상의 상태와 새 환경 설정을 읽기 전용으로 확인한다. GitHub 기능 환경 검사는 웹 쌍·publisher 쌍·maintenance 쌍 및 공통 키의 일치를 검사하고 값은 출력하지 않는다.
4. maintenance는 아래 별도 준비 절차로 mini 예비→M3 주 순서로 릴리스한다. 두 앱의 실제 source type·autoDeploy 설정을 먼저 읽고 기록한다. 기존 8개 앱과 같은 immutable Docker 설정이라고 가정하지 않는다.
5. 기존 `run` 절차로 publisher→reviewer→crawler의 mini 예비→M3 주, 마지막으로 mini→M3 웹을 릴리스한다. 각 역할 쌍의 failover 및 진행 검사를 통과해야 다음으로 이동한다.
6. 웹 2개, publisher 주/예비, maintenance 주/예비의 실제 실행 릴리스와 역할을 확인한 후 단계별 파일럿을 진행한다. 이 절차는 소개 검수의 중단 상태를 바꾸지 않는다.

```sh
npx next typegen
npx tsc --noEmit
npm run lint
npm test
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:integration
python3 -m unittest tests.test_deploy_shared_images
npm run build
PUBLIC_USER_AUTH_ENABLED=true PRODUCT_FEEDBACK_ENABLED=true GITHUB_STAR_ENABLED=true \
  GITHUB_FEEDBACK_DELIVERY_ENABLED=true TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  npx playwright test tests/e2e/github-integration-flow.spec.ts
```

`TEST_DATABASE_URL`는 이름이 `nomorevibe_test`인 전용 PostgreSQL/pgvector DB를 가리킨다. 통합/E2E가 같은 DB를 초기화하므로 동시에 실행하지 않는다. 공개 읽기 replica 지연과 별개로 세션, 개인 작업 상태, 피드백 쓰기·조회, outbox는 primary DB를 사용한다.

기존 공통 배포 스크립트의 쓰기 대상은 8개 그대로다. maintenance 두 앱은 새 preflight의 **읽기 전용 검사 대상**이며 자동 `run`/`restore`에 추가하지 않는다.

| maintenance 앱 | Dokploy application ID |
| --- | --- |
| `nomorevibe-maintenance-standby-mini` | `T6ATm-paaE03hfSsQX8-S` |
| `nomorevibe-maintenance-m3` | `7OlFqQdacbyQseQM72E7b` |

maintenance 수동 릴리스 전에 현재 설정을 비공개 0600 기록으로 보관한다. 현재 source가 Docker면 검증한 worker digest를, GitHub build면 검증한 동일 main SHA의 worker 빌드 결과를 지정하고 기존 command·역할·DB 설정을 유지한다. source 전환이나 자동 배포 정책 변경을 이 절차에 묶지 않는다. mini 예비 앱부터 새 deployment ID·done·실행 release·worker health·DB 역할 lease를 확인한 후 M3 주 앱을 적용한다. 두 후보의 설정과 실행 코드가 맞고 기존 `check-failover-readiness.ts` 및 `check-worker-progress.ts`가 통과한 상태를 기록한다. 수동 maintenance 복구도 보관한 설정과 릴리스로 두 후보를 맞춘 후 검증한다.

```sh
python3 scripts/ops/deploy_shared_images.py plan \
  --sha "$RELEASE_SHA" --worker-image "$WORKER_IMAGE" --web-image "$WEB_IMAGE" \
  --migration-verified
python3 scripts/ops/deploy_shared_images.py run \
  --sha "$RELEASE_SHA" --worker-image "$WORKER_IMAGE" --web-image "$WEB_IMAGE" \
  --migration-verified --snapshot "/private/tmp/nomorevibe-release-${RELEASE_SHA:0:7}.json"
```

위 명령은 배포 권한과 대상 환경이 확정된 운영자가 실행한다. `plan`의 maintenance 정보는 설정과 Dokploy 상태 확인이며 실제 컨테이너의 새 코드 릴리스를 보장하지 않는다. 수동 릴리스 증거를 별도로 남긴다. 0600 스냅샷은 환경 비밀값을 포함하므로 Git과 공유 문서에 넣지 않는다.

## 단계별 파일럿

허가된 테스트 사용자 2명, 제작자 1명, 공개 개인 repo 1개와 조직 repo 1개를 준비한다. 실험 범위를 확인하고 [파일럿 기록](2026-10-11-github-integration-pilot.md)의 각 행에 실제 증거를 기록한다.

1. 일반 인증을 웹 2개에 연다. GitHub 로그인만 쓰면 개인 스타도 함께 열고 동일 GitHub 계정의 가입·재로그인·승인 취소·만료·로그아웃·CSRF/Origin 거절을 확인한다. 이메일 설정을 추가했다면 이메일 로그인도 확인한다. 두 웹의 `/api/me`가 같은 사용자와 `private, no-store`를 반환해야 한다.
2. 개인 스타를 열고 연결 승인·조회·등록·취소·재연결을 확인한다. GitHub 개인 starred 상태와 사이트 표시가 같아야 한다. 공개 별 수에 클릭으로 임의 가감이 생기지 않아야 한다.
3. 서비스 피드백을 열고 GitHub 로그인 사용자의 제출·원문·내 기록·중복 요청을 확인한다. 이메일 로그인을 켰다면 GitHub 미연결 이메일 사용자도 확인한다. URL 4개 또는 정규화 본문 반복은 held이고 작성자·관리자만 원문을 볼 수 있어야 한다.
4. 지정한 두 제품만 제작자 binding을 활성화한 뒤 GitHub 전송 플래그를 웹·publisher·maintenance의 주/예비에 맞춘다. 별도 동의가 있는 새 accepted 글 하나가 봇 이슈 하나와 연결되는지 확인한다. 활성화 전 과거 글을 자동 일괄 전송하지 않는다.
5. 정상 큐 대기가 없는 상태에서 접수 시각과 검증된 GitHub 201/사이트 delivered 시각을 기록한다. 목표는 90초 이내이며 보장 SLA가 아니다.
6. 허가된 실패·재조회·설치 철회와 publisher 주 후보 중단→예비 후보 복구를 확인한다. 중단 범위와 재시작 결과를 기록하며 소개 검수는 재개하지 않는다.

## 전송 상태와 복구

| 상태 | 의미와 운영 처리 |
| --- | --- |
| `local_only` | 서비스 접수만 완료. 외부 전송 완료를 뜻하지 않는다. |
| `queued` | 원문·대상 repository ID·binding revision·payload가 저장됨. |
| `sending` | DB에 attempt를 먼저 기록했고 외부 요청 결과를 확인하는 중. |
| `delivered` | 숫자 repo ID와 이슈 ID·number·URL을 검증한 결과. GitHub 이슈 링크로 확인한다. |
| `retry_wait` | 확정 rate limit 또는 발송 전 일시적 실패. Retry-After/reset과 저장된 available_at 이후만 처리한다. |
| `uncertain` | 전송 후 timeout/5xx/worker 종료 또는 저장 실패. 자동 POST를 반복하지 않는다. |
| `blocked` | 권한·정책·원문·binding 변경으로 전송 중지. 원문과 마지막 안전한 오류 코드는 유지한다. |
| `cancelled` | 아직 발송하지 않은 대기 요청을 취소함. 이미 발송한 결과 확인은 계속한다. |

publisher 틱은 60초 간격, 예산 20초, 동시 1개, 최대 5건이며 repo별 24시간 전송 한도는 20건이다. DB lease는 늦은 저장 결과를 차단한다. 외부에 이미 보낸 POST를 취소하지는 못한다.

uncertain 재조회는 해당 숫자 저장소의 이슈 목록을 `state=all`로 페이지 순회하며 피드백 UUID와 dispatch ID marker를 찾는다. HTTP 예산에서 DB 체크포인트 시간을 예약해 다음 페이지와 후보를 저장한다. 부분 순회는 부재 증거가 아니다. marker 1개는 현재 저장소의 개별 이슈를 다시 검증한 뒤 복구하고, 0개 또는 2개 이상이면 운영 확인을 유지한다. 제공자의 rate limit 시각 이후에 재조회한다. 검색 인덱스 결과로 성공·부재를 판정하지 않는다. unknown 요청을 자동으로 다시 보내지 않는다.

관리자의 피드백 재조회와 명시적인 1회 재전송은 별도 작업이다. marker 0개·2개 이상인 결과를 검토한 뒤에도 재전송에는 중복 위험 동의, 현재 저장소·설치 권한·binding revision·동의·원문 및 payload hash 재검증이 필요하다. 관리자·사유·이전 dispatch와 멱등 request ID를 감사 기록에 남기고 새로운 dispatch marker 하나를 만든다. 재조회나 lease 만료가 재전송을 자동 허용하지 않는다.

개인 Star 변경의 unknown 상태는 사용자 GET으로 GitHub의 현재 상태를 다시 표시하더라도 추가 변경 잠금이 풀리지 않는다. 원래 불명확한 쓰기가 끝났다는 증거가 아니기 때문이다. 현재 자동 복구나 운영자 복구 API는 없으므로 이 제한을 파일럿에서 확인하고 unknown 기록을 보존한다. lease 만료나 단순 GET 결과로 원래 외부 요청의 완료를 판정하지 않는다.

`external_issue_state=closed`는 GitHub 이슈가 닫혔다는 뜻이다. 사용자 문제가 해결되거나 제품이 배포됐다고 자동 표시하지 않는다. 본문·댓글 양방향 동기화는 이 릴리스에 없다.

장애 시 관련 쓰기 플래그를 먼저 `false`로 맞추고 원문·migration·outbox·시도 기록은 보존한다. 일반 인증을 끄면 개인 스타/피드백도 함께 끈다. 기존 in-flight 결과 확인을 유지하고 설정 및 릴리스 쌍을 복구한다. 기능 플래그를 끄는 것만으로 발송된 요청을 회수할 수 없다.
