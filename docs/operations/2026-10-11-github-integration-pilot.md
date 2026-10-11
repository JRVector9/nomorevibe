# GitHub 스타·피드백 파일럿 기록 — 2026-10-11

## 현재 상태

PR01~09 코드를 구현하고 최종 로컬 자동 검증을 실행했다. 결과를 9개 논리 커밋으로 정리한다. 실제 제공자 키, 허가된 파일럿 계정·저장소, 운영 활성화는 이 작업에서 설정하거나 실행하지 않았다. 아래 외부 연동과 릴리스 항목은 **미검증**이며 mock/fixture 결과로 완료 처리하지 않는다. 운영 절차는 [GitHub runbook](github-stars-feedback-runbook.md)을 따른다.

## 실제 실행한 로컬 검증

공유 격리 worktree `/private/tmp/nomorevibe-github-integration-20261011`, 전용 DB `nomorevibe_test`(초기 localhost:55442, 최종 연결 회귀 localhost:55443)에서 다음을 실행했다. 테스트 DB와 브라우저 DB를 동시에 초기화하지 않는다.

| 명령 | 실제 결과 |
| --- | --- |
| `npx vitest run tests/product-feedback.test.ts` | 23 passed |
| `TEST_DATABASE_URL=… npm run test:integration -- tests/integration/product-feedback.test.ts` | 13 passed |
| `npx vitest run tests/github-feedback-delivery.test.ts tests/github-feedback-job.test.ts tests/job-catalog.test.ts tests/db-pool-config.test.ts tests/db-pool-options.test.ts` | 27 passed (9+4+8+2+4) |
| `TEST_DATABASE_URL=… npm run test:integration -- tests/integration/github-feedback-outbox.test.ts tests/integration/db-pool-budget.test.ts` | 33 passed (25+8) |
| `npx vitest run tests/github-feedback-database.test.ts tests/product-feedback.test.ts tests/github-feedback-delivery.test.ts tests/github-feedback-job.test.ts tests/job-catalog.test.ts tests/db-pool-config.test.ts tests/db-pool-options.test.ts` | 최종 53 passed; 제품 피드백 24개 포함 |
| `TEST_DATABASE_URL=… npm run test:integration -- tests/integration/github-feedback-outbox.test.ts tests/integration/product-feedback.test.ts tests/integration/db-pool-budget.test.ts` | 최종 61 passed (40+13+8), 종료 코드 0 |
| `python3 -m unittest tests.test_deploy_shared_images` | 최종 23 tests, OK |
| `npx playwright test tests/e2e/github-integration-flow.spec.ts --list` | 4 cases discovered; 브라우저 실행 완료를 뜻하지 않음 |

피드백 통합 검사는 primary DB, 원문 보존·비공개 검토·동시 멱등 요청·한도·검토 감사·제품 먼저 잠금을 확인했다. outbox 검사는 트랜잭션 원자성, 두 worker claim, HTTP 전 sending 저장·SQL lock 해제, 403/429 rate limit 시각, 변경된 원문/권한/flag/binding, 늦은 201 lease fence, 실제 DB 제약 위반에 의한 성공 기록 실패, unknown 자동 재POST 금지와 marker 1/0/2개를 확인했다. 저장소 이름이 바뀐 후 기존 후보의 개별 이슈 재검증과 DB 대기·누적 SQL 예산·rollback도 확인했다. 제공자 경계는 주입한 응답을 사용했다.

최종 연결 회귀는 accepted 제출·held 개별 승인에서 기본 outbox와 queued 응답이 같은 트랜잭션으로 저장됨, 활성화 전 생성 글의 제외, safe 이슈 링크·외부 상태·오류 projection과 원문 권한, binding 변경 때 pending만 취소함을 확인했다. 느린 페이지 순회는 두 틱에서 커서가 진행하며 token·후보 GET 만료 뒤에도 체크포인트와 lease 해제가 저장된다. credential·metadata·list rate limit의 retryAt을 유지하고, 검증된 201 뒤 DB 예산이 끝나면 sending을 남겨 다음 틱의 uncertain으로 복구한다. 마지막 job lease 조회가 늦게 반환되는 경우의 COMMIT 거절은 별도 단위 회귀로 확인했다.

TDD에서 URL 검수·제품별 내 기록의 회귀는 단위 RED 2 failed/21 passed 뒤 23 passed였다. 승인 잠금 순서는 실제 PostgreSQL NOWAIT 오류 `55P03`를 확인한 뒤 13 passed, 전송 잠금 순서는 1 failed/18 passed 뒤 19 passed였다. 배포 preflight는 함수 미구현 RED 후 18 passed, 최소 worker 키 범위 회귀 RED 후 19 passed였다. 기존 DB 테스트의 동기 예외 검증 오류는 async callback으로 수정했다.

전송 리뷰의 사전 rate limit 및 저장소 이름 변경 회귀는 실제 통합 RED 4 failed/19 passed 뒤 23 passed였다. scoped pool deadline은 RED 2 failed/6 passed 뒤 8 passed이며 만료한 대기 쓰기가 연결 해제 뒤 실행되지 않음을 확인했다. PostgreSQL 17 `transaction_timeout`으로 누적 시간을 제한하는 시도는 postgres 3.4.9가 세션 종료 뒤 `socket=null` 예외를 발생시켰다. 당시 32개 assertion은 통과했지만 unhandled error와 종료 코드 1이 있어 성공으로 기록하지 않는다. 이 방식은 제거하고 매 SQL 전에 남은 시간으로 `SET LOCAL statement_timeout/lock_timeout`을 갱신하고 rollback을 끝까지 기다리는 방식으로 바꿨다. 최종 33개 통합 테스트는 unhandled error 없이 종료 코드 0이었다.

후속 재조회 예산·rate limit 회귀는 실제 DB RED 5 failed/25 passed 뒤 31 passed였다. 기본 hook·projection 회귀 RED 4 failed/32 passed, 이슈 링크·닫힘 UI RED 1 failed/23 passed, 마지막 lease deadline RED 1 failed, binding 취소 hook RED 3 failed 뒤 최종 단위 53개·통합 61개가 통과했다. binding 테스트의 초기 maker fixture는 필수 PKCE 값을 누락해 실패했으므로 fixture를 고친 뒤 세 hook 모두 실제 취소 누락으로 RED를 확인했다. 배포 검사 회귀는 RED 1 failure/4 errors 뒤 Python 23개가 통과했다. 누락 플래그의 false 기본값·중복/오타 거절, 같은 PEM 헤더의 서로 다른 본문, escaped newline과 quoted multiline 동등성, worker에 복호화 키를 요구하지 않음과 비밀 출력 없음이 포함된다.

아래는 PR08 동결 후 오케스트레이터가 최종 소스에서 직접 실행한 결과다. 로컬 공통 검사는 원격 GitHub CI check와 별개다.

| 추가 검증 | 결과/증거 |
| --- | --- |
| `npx next typegen`, `npx tsc --noEmit`, `npm run lint` | 모두 exit 0; lint 오류0·기존 vendor 경고1 |
| `npm test` | 246파일·2,256개 통과, exit 0 |
| `TEST_DATABASE_URL=…55444/nomorevibe_test npm run test:integration` | 140파일·1,370개 통과·기존 TODO1, exit 0 |
| 빈 DB 전체 migration / production build / bundle gate | 모두 exit 0; build는 Playwright webServer에서 실행 |
| CI-scope Node 검사 / `docker compose config --quiet` | 각각 4개 통과 / exit 0 |
| 공개 인증3·GitHub 연결3·개인 스타4·서비스 피드백4 브라우저 검사 | 14개 통과, exit 0; 로컬 테스트 쿠키와 응답 fixture |
| `github-integration-flow.spec.ts` 브라우저 실행 | 4개 통과, exit 0; 세션·binding·외부 결과를 DB fixture로 구성 |
| 기능 플래그 false 기존 화면 전체 E2E | 최종 30개 통과·신규 비활성18개 skip, exit 0 |

브라우저18개는 실제 메일 수신·GitHub OAuth 승인·앱 설치·publisher 외부 POST·웹훅·운영 failover를 실행하지 않았다. 이 제공자/운영 항목은 아래 별도 미검증 상태로 유지한다. 기존 화면 E2E 첫 실행은8failed/20passed/18skipped/2notrun, 두번째는2failed/27passed/18skipped/1notrun이었다. 관련 기존 생산 코드는 기준main과 동일함을 확인하고 테스트 fixture와 현행UI 선택자를 보완했다. 최종 전체 재실행은30개 통과·18개 skip·exit0이다. 기존 관리자 fallback 저장 후 dirty 표시가 남는 UI 결함은 PENDING에 미해결로 남겼다. 최종 저장 검사는 성공 HTTP 상태뿐 아니라 exactDB·새 hidden form version·표시 저장판·reload를 확인한다.

## 릴리스와 외부 제공자 확인

| 항목 | 상태 | 기록할 증거 |
| --- | --- | --- |
| Resend 발신 도메인·허가된 수신자 | 미검증 | 발신 도메인 확인 시각, 수신 성공 시각(이메일/OTP 원문 제외) |
| Star App 별도 ID·승인·callback·webhook | 미검증 | App 식별자, 승인 권한, callback 성공/웹훅 delivery ID |
| Feedback App 선택 저장소·Issues/Metadata·callback·setup·webhook | 미검증 | App/설치/repository 숫자 ID, 승인 권한, 성공 callback/웹훅 ID |
| staging migrations 0066~0072 | 미검증 | 적용 journal·최종 migration·schema 확인 |
| 웹 2개 | 미검증 | 동일 SHA/digest, 공개 health의 두 instance ID, 개인 작업 즉시 조회 |
| publisher 주/예비 | 미검증 | 동일 SHA/digest·환경 일치·lease/health/진행 결과 |
| maintenance 주/예비 수동 릴리스 | 미검증 | 실제 source/autoDeploy 상태, mini→M3 deployment ID·실행 SHA·역할·lease |
| 기능 플래그 단계별 활성화 | 미실행 | 인증→스타→로컬 피드백→지정 binding 외부 전송의 각 확인 시각 |

maintenance 읽기 전용 식별자는 M3 `7OlFqQdacbyQseQM72E7b`, mini `T6ATm-paaE03hfSsQX8-S`이다. 기존 배포 스크립트의 8개 쓰기 대상은 유지한다. maintenance가 같은 Docker immutable/autoDeploy=false 정책이라고 가정하지 않으며 실제 설정과 수동 릴리스 결과를 따로 확인한다.

## 파일럿 시나리오와 결과

참여자: 허가된 일반 사용자 A/B, 제작자 C. 저장소: 허가된 공개 개인 repo P, 공개 조직 repo O. 아직 실제 대상을 지정하지 않았다.

| 시나리오 | 상태 | 필수 증거 |
| --- | --- | --- |
| 사용자 A/B 이메일 로그인·만료·로그아웃·Origin/CSRF | 미검증 | 두 웹 개인 세션 일치, 거절 status, 수신 확인 시각 |
| 사용자 A 개인 스타 등록·취소·이미 스타됨·재연결 | 미검증 | GitHub starred 상태와 사이트 상태, upstream status/확인 시각 |
| 사용자 B GitHub 미연결 피드백·검토 비공개·멱등 재요청 | 미검증 | feedback UUID, review/delivery state, 두 웹 조회 결과 |
| 제작자 C 개인/조직 repo binding·조직 승인 대기 거절 | 미검증 | 현재 repo ID·installation ID·binding revision·완료/거절 |
| 새 accepted 글 → 봇 이슈 1개 → 원문 링크 | 미검증 | feedback/outbox/dispatch ID, 검증된 201, issue ID/number/URL, DB state, 두 웹 UI |
| 정상 큐 전송 지연 목표 90초 | 미측정 | 접수·201·사이트 delivered 시각과 초 단위 차이; 보장 SLA 아님 |
| timeout/5xx → uncertain → 목록 marker 재조회 | 미검증 | 안전한 오류 코드, `state=all` 조회 결과, 자동 POST 반복 없음 |
| 설치 철회·저장소 제외·제품 차단·repo 변경 | 미검증 | binding revision/중지, pending 취소, in-flight 결과 확인 |
| 이슈 closed/reopened authoritative 재조회 | 미검증 | GitHub 현재 state, DB external_issue_state, 해결/배포로 표시하지 않는 UI |
| publisher 주 중단 → 예비 lease 인계 → 복구 | 미검증 | 허가된 중단 시각, 후보/lease/처리 증거, 중복 이슈 증가 없음, 주 재시작 |
| 플래그 비활성화와 기록 보존 | 미검증 | 새 쓰기 중단, 원문/outbox 보존, 발송된 결과 계속 확인 |

실제 성공·실패를 기록할 때 토큰, 개인키, OTP, 이메일, 제품 수정키와 비공개 본문을 붙이지 않는다. 제공자 응답은 status·안전한 코드·request/delivery ID·숫자 대상 ID·공개 이슈 URL을 기록한다. 키 또는 권한이 준비되지 않은 항목은 미검증 상태로 유지한다.
