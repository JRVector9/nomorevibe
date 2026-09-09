# 운영센터 및 AI 재연결 설계 시안

2026-09-09. 범위: 승인된 정보 구조의 HTML 시안과 Deppy-aibox 적용 검토. 서비스 구현·인증 시작·발행 정책 변경은 이 단계에 포함하지 않는다.

## 화면

`docs/designs/2026-09-09-admin-operations.html`은 독립 HTML이다. 전체 현황, 작업 목록, AI 연결, 수동 분류 탭을 제공한다. 점검 시점과 데모 표시를 고정하며 자동 갱신처럼 보이는 가짜 시간·진행률을 만들지 않는다. 서비스 7개는 웹, DB, scheduler, crawler, reviewer, publisher, maintenance다. 실행 잡은 10개이며 heartbeat는 scheduler 관측용이다.

데이터의 의미를 분리한다:
- 컨테이너 healthy / DB workerSeenAt / 현재 잡 / 마지막 성공은 서로 다른 관측이다.
- 요청 버전 차이는 미처리 신호이지 후보 개수가 아니다. 스케줄은 신호를 합친다.
- crawl-agent-review는 off 모드에도 회차 완료를 기록한다. 성공 기록으로 AI 활성 여부를 추론하지 않는다.
- jobs.cursor는 재개 위치이며 전체 처리율을 제공하지 않는다.
- workerSeenAt은 poll 시점에 기록된다. 긴 작업 중 오래됐다는 이유만으로 중단으로 판정하면 안 된다.
- 서비스 재시작 횟수는 과거 누적값이다. 원인을 확인하지 않고 장애 횟수로 표현하지 않는다.
- 후보 published 누적은 현재 공개 제품 수와 다르다.

기존 `/admin/status`의 근거 처리 대상·오래된 근거·연결 실패, 랭킹 스냅샷, 응답하지 않는 제품, 검색 신호 수율도 유지한다. 시안은 우선순위가 높은 서비스·잡·AI 정보를 먼저 보여준다. 기존 심사·제품·크롤 설정 링크는 그대로 활용한다.

## 점진적 구현 경계

1. 기존 `/admin/status`, `listJobStates`, `JOB_CATALOG`, 후보/근거/랭킹 조회를 재사용해 역할별 화면으로 재배치한다. 관리자 server action은 기존 requestJob을 호출한다. 브라우저에 CRON_SECRET을 전달하지 않는다. origin/CSRF·관리자 권한 검사 및 중복 요청 억제가 필요하다.
2. 기존 supervisor IPC 상태에서 최소 중앙 관측을 기록한다. 역할, instance/boot ID, release, heartbeat, current job, started/progress 시각만 제한 주기로 upsert하고 수집 실패가 업무 실행을 멈추지 않게 한다. 프로세스 메트릭의 출처를 명시하고 관측 누락은 `확인 불가`로 표시한다. 웹/DB 건강과 worker 건강은 별도다. Docker socket은 웹에 마운트하지 않는다.
3. AI 분류 시도 요약(모델·결과·오류 종류·credential generation·성공 시각)을 영속화한다. 요청 입력·토큰·출력 원문은 상태 테이블에 저장하지 않는다. 실패와 성공이 뒤섞인 로그에서 임의 성공률을 만들지 않는다. 정상조회는 DB 읽기만 수행하고 새 모델 검사는 명시적 조치로 실행한다.
4. connect-agent를 별도 내부 서비스로 추가하고 관리자 재연결 → credential 저장 → 워커 적용 → 실제 Spark 검증 순서를 구현한다.
5. 인증/모델 실패 시 자동 폴백 유지 또는 분류 보류 정책을 명시한다. 추천 정책은 분류 보류 + 관리자 수동 카테고리 지정이다. 현재의 규칙 폴백 정책은 아직 변경하지 않았다.

현재 approved 상태는 유지하고 별도 카테고리 결정 기록을 추가하면 기존 후보 상태 전면 개편이 필요 없다. 수동 결정은 후보 ID·출처 revision·분류 taxonomy version과 관리자/사유에 묶는다. 저장 후 publisher가 기존 publication guard로 현재 출처·심사·차단·중복 조건을 재검증한다. 관리자 카테고리 지정은 AI 심사 승인과 별개다. 제외나 발행 완료 항목을 암묵적으로 다시 발행하지 않는다. 자동 처리 불가 후보를 매 tick 재호출하지 않도록 cooldown 또는 분류 대기 선택 조건을 둔다.

## Deppy-aibox 소스 검토

대상 private repo: https://github.com/JRVector9/Deppy-aibox
검토 커밋: 814144a2d37cb60359486219393f93f32c7267fc (2026-07-10).

재사용 가능:
- `packages/provider-codex/src/index.ts`: `codex login --device-auth`, 격리된 CODEX_HOME, URL/code 추출, auth.json 전달.
- `packages/server/src/engine.ts`: 서명 티켓, 용량 제한, 세션 취소/정리, webhook 저장 이후 connected.
- `packages/server/src/crypto.ts`: 티켓 검증, HMAC webhook 검증.
- `packages/server/src/storage.ts`: webhook 저장 어댑터.
- client/react: start/poll/cancel 연결 화면.

반드시 보완할 부분:
- 제공 Docker 기본 Codex 0.139.0과 현재 publisher 0.153.4 차이가 있다. 같은 버전으로 고정해 실제 device OAuth와 코드 파싱·auth 파일 계약을 검증한다. 현재 CLI help의 --device-auth 지원만 확인했으며 실제 승인/로그인은 수행하지 않았다.
- provider는 auth.json이 비어 있지 않으면 반환한다. JSON 스키마·필수 인증 필드 검증, 원자적 파일 읽기, 잘못된/부분 파일 거절을 추가한다.
- auth.json 전체 계약을 유지한다. access_token만 추출해서 저장하면 refresh 정보가 사라진다. refresh 후 갱신된 credential의 영속화와 세대 비교, 이전 세대 덮어쓰기 방지, 워커 단일 소유/교체 순서를 설계한다. 파일 권한 0600 및 일시적 복호화 위치를 제한한다. CLI 자동 갱신 동작은 별도 실측 대상이다.
- `connected`는 webhook 저장 성공까지이며 Spark 사용 가능 보장이 아니다. 상태를 captured → stored → applied → verified로 분리하고 모델 권한/쿼터/timeout/명시적 인증 거절을 분리한다. 현재 timeout을 무조건 토큰 만료로 표시하지 않는다.
- webhook 서명만으로 충분하지 않다. `verifyWebhook(request, secret)` 기본 wrapper는 replay store를 전달하지 않는다. 수신 측 DB에서 event.id 유일성, 티켓 session/provider/subject/purpose 바인딩, 세대 갱신을 트랜잭션으로 처리한다. schema 검증도 수신 측에 추가한다.
- provider 선택이 티켓 자체에 고정되지 않으므로 관리자 연결 경로는 codex만 허용하고 nonce에 대상 provider와 목적을 저장한다.
- 연결 엔진 세션은 메모리 기반이다. 단일 인스턴스로 시작하고 프로세스 재시작 시 연결을 재시도한다. DB 작업 큐/서비스 전체에 Redis를 도입할 필요는 없다.
- 예제 .env의 HTTP webhook은 기본 sink 설정상 거절된다. HTTPS를 사용하거나 검증된 내부 전송 경계를 명시적으로 설정한다. 인증 원문·에러 detail을 관리자나 로그에 그대로 전달하지 않는다.
- 엔진 기본 Docker는 불필요한 Naver Chromium도 포함한다. Codex 전용 provider 구성과 경량 target을 검토한다. lockfile 고정 설치와 immutable commit 배포를 사용한다. npm 공개 패키지/이미지 사용 가능성은 확인되지 않았다.
- 현재 로컬 ADMIN_LOCAL_LOGIN=1은 모든 방문을 관리자로 취급한다. credential 연결 route에서는 이를 운영 인증으로 인정하지 않고 실제 허용된 관리자 session을 요구한다. 조직·운영 계정 1개에 한정한다.

## 검증 결과와 한계

격리 checkout `/private/tmp/deppy-aibox-review.2Ncv9E`에서 `pnpm build && pnpm test && pnpm typecheck` 성공. 테스트 합계 64개(client10/codex6/claude11/naver12/server25). 실제 OAuth 승인, Spark 사용권한, credential refresh/rotation, 서버 배포는 검증하지 않았다.

첫 명령은 clone 이후 cwd를 바꾸지 않아 NoMoreVibe에서 실행됐으며 pnpm 설치가 lockfile 부재로 실패했다. NoMoreVibe 단위 628개는 통과했지만 aibox 검증 결과가 아니다. 다음 aibox checkout에서 build 없이 test를 실행하면 0개로 끝나고 typecheck도 dist 타입 부재로 실패했다. 빌드 선행 후 위 64개가 실제 실행되었다. 테스트 CI에는 0-test 방지를 추가하는 것이 좋다.

## 완료와 후속 범위

이 HTML은 서비스에 연결되지 않은 시안이다. 필터·탭·연결 단계·수동 선택은 브라우저 안에서만 동작한다. 시안 검토 후 실제 서비스 구현은 위 순서대로 분리한다. 기존 인증 비밀값이나 발행 정책은 수정하지 않는다.

## 시안 v2 — 역할별 상세와 연결 후 모델 설정

사용자 요청에 따라 카드 제목은 웹·관리자 서비스 / 작업 일정 관리 / 프로젝트 수집 / 후보 심사 / 제품 발행 / 지표 집계로 표시하고 실제 프로세스명 app/scheduler/crawler/reviewer/publisher/maintenance는 바로 아래 보조 정보로 배치했다. 데이터베이스도 역할명 아래 db · PostgreSQL을 표시한다.

각 카드 선택 시 하단 상세에서 역할 설명, 담당 잡과 주기, 기능 활성 여부, 확인된 처리 결과, 재개 위치 제공 여부, 대기·제한 사유를 보여준다. 기본 선택은 현재 조치가 필요한 제품 발행이다. 최근 실측 회차와 전체 점검 스냅샷의 시각을 분리한다. 작업 모달과 한글 역할·작업 검색도 제공한다. 현재값을 추가 수집하지 않았으므로 기존 점검 스냅샷임을 유지하며, 누락된 예약 시각 등을 임의 생성하지 않는다.

Codex 재연결 데모 완료 후 모델 설정을 활성화한다:
1. 계정 연결/자격 정보 저장.
2. 우선 모델·추론 강도와 예비 모델·추론 강도 선택. 현재 코드에서 사용하는 Spark/Terra만 노출하며 계정별 접근 권한은 검사 전 확정하지 않는다. 예비 모델 없음도 선택 가능하다.
3. 선택 조합의 실제 분류 계약 검사. 데모에서는 성공/접근 불가/timeout 상태를 체험한다. 우선·예비 동일 모델은 거절한다.
4. 검증한 설정만 적용. 모델/effort/credential 변경 시 검증을 무효화하고 다시 검사한다. 설정 저장은 현재 AI 실패 발행 정책을 암묵적으로 변경하지 않는다.

실제 구현에서는 모델·effort allowlist, 검사 결과와 credential generation/config hash 바인딩, 관리자 CAS 저장, 워커 applied version 확인이 필요하다. 정책 저장 후 현재 실행 중인 배치를 중간 변경하지 않고 다음 배치에서 적용한다. 같은 인증으로 예비 모델도 검증하며 API 키 연결은 별도 계약이다. xhigh/high 선택은 호환성 검증 대상이며 모든 계정에서 사용 가능하다고 보장하지 않는다.

v2 검증: Playwright 1440/1024/768/390 × 4개 탭에서 페이지 넘침 없음. 6개 서비스 상세, 작업 모달, 한글 검색, 연결 전 설정 잠금, 연결 후 활성화, 검사 실패/중복 모델 적용 차단, 성공 적용, 설정 변경 시 검사 무효화 통과. 모델 설정 모바일 넘침 없음, page error 0. 서비스 로직·DB·인증·워커는 변경하지 않았다.

## 실제 구현 반영 — 2026-09-09

사용자의 전체 시안 구현 요청으로 위의 HTML-only 단계가 끝났다. 실제 `/admin/status`에 네 탭과 공통 관리자 사이드바를 연결했다. 세부 운영법은 `docs/operations/operations-center-runbook.md`를 참조한다.

인증 경계는 검토 이후 더 단순하게 조정했다. 별도 connect-agent가 인증뿐 아니라 Codex 분류 실행까지 소유하고, 퍼블리셔는 내부 인증 RPC로 요청한다. 따라서 자격 원문을 웹으로 전달하는 webhook과 두 프로세스의 auth.json 공유가 필요 없다. encrypted vault·격리된 임시 로그인·단일 CLI 실행·전체 refresh credential 보존·설정/인증 세대 검증은 유지했다. 구성 서비스는 기존7개에 connect-agent를 추가해8개다.

managed publisher는 분류 실패를1시간 보류하고 수동 카테고리 결정을 받을 수 있다. 기존 후보 상태는 유지한다. 카테고리 결정은 원본/후보/taxonomy에 묶이며 발행 트랜잭션에서 decision revision을 재검사한다. 실제 관리자 로그인 없이 credential 동작을 수행할 수 없다. 모델·강도 선택은 UI에 연결됐지만 계정의 실제 사용 가능 여부는 운영자가 OAuth 승인 후 검사를 수행해야 확정된다.

검증 시안의 historical snapshot은 실제 화면에서 재사용하지 않는다. 현재 DB 관측/작업/큐를 읽으며, 최근 회차 결과는 작업 종료 트랜잭션에 저장한 제한된 숫자·불리언 이벤트만 보여준다. 현재 화면 조회가 새 모델 호출을 발생시키지 않는다.
