# 독립 워커 구현·검증 보고 — 2026-09-08

PR 계획 01~10 범위를 `feat/independent-workers`에 구현했다. 기존 잡·후보 상태·수집기·PostgreSQL을
재사용하고, 실행 주체와 승인 검증 경계를 분리했다. 운영 서버 배포와 24시간 실운영 검증은 아직 완료하지 않았다.

## 1. 구현 결과

| 범위 | 실제 동작 |
|---|---|
| PR 01~02 | DB 요청 버전·실행 소유권·스케줄을 저장한다. scheduler, crawler, reviewer, publisher, maintenance가 웹과 독립 실행된다. |
| PR 03 | GitHub API 대기를 DB로 공유하며 프론티어 적체 시 탐색을 늦춘다. 예산 종료 시 사용하지 않은 claim을 반환한다. |
| PR 04~05 | 메이커 202 접수와 관리자 강제 갱신 범위를 보존한다. 미디어를 포함한 부분 진행을 저장하고 웹/cron은 예약·조회만 한다. |
| PR 06 | 공통 worker 이미지·역할별 실행·재시작·시간/메모리/DB 풀 한도를 추가했다. migration은 release당 한 번 실행한다. |
| PR 07~09 | 입력·정책·원본 버전을 고정한 심사 이력을 저장한다. enforce 모드에서는 현재 유효한 승인만 발행 조회 및 INSERT 직전 검증을 통과한다. |
| PR 10 | 기존 심사 화면에 모드·AI 이력·감사 가능한 관리자 승인·제한된 추가 수집을 추가했다. |

리뷰 AI는 별도 `CRAWL_REVIEW_MODEL`을 요구한다. 실제 접근을 확인한 값은 `claude-sonnet-5`다.
Claude CLI 2.1.263을 worker 이미지에 고정했고, 웹 이미지에는 CLI가 없다. 도구 없는 구조화 호출,
20초 제한, 동시 1건, 동일 입력 최대 3회, 입력/출력·호출 비용 한도를 적용했다.
확정 부적격은 규칙으로 처리하며, 필수 근거 부족은 `needs_review`로 보류한다. 파일 존재만으로 개발 모델을 추정하지 않는다.

역할은 처음에 각각 1개다. crawler 복제본을 늘리는 수평 확장, Redis, 이미지 저장소 이전,
전체 조회 재작성은 추가하지 않았다. PR 11·12는 실측 병목과 기존 홈 작업 통합 이후의 선택 작업이다.

## 2. 병렬 실행과 리뷰에서 수정한 결함

세 서브에이전트가 분리된 worktree에서 런타임·수집/쿼터·갱신/심사 계약을 나누어 작업했고,
주 조정자가 공통 파일·마이그레이션을 순서대로 통합했다. 완료 에이전트를 교차 리뷰와 운영 검증에 재배정했다.
실행 지시는 [프롬프트 문서](../superpowers/plans/2026-09-08-worker-execution-prompts.md)에 남겼다.

- 최초 저장소 스캔이 없을 때 `undefined === undefined` 비교로 null 근거를 읽던 오류를 수정했다.
- 완료 표시가 있어도 추가 파일 탐색 cursor가 남으면 이어 수집하도록 고쳤다.
- 새 SHA 스캔 INSERT 경합과 동일 SHA 재관측을 승인 입력 검증에 반영했다. 저장소 단위 잠금과 scan 시작 시각을 함께 사용한다.
- 실제 AI가 근거 부족을 탈락으로 해석한 사례를 확인했다. 규칙/프롬프트 버전 `.2`에서 부족한 근거는 선행 보류하고 `.1` 결과를 재사용하지 않는다.
- DB 풀 포화 시 만료된 요청이 나중에 쓰기를 실행하지 않도록 했다. postgres 3.4.9의 연결 회전·트랜잭션·pipeline을 실제 DB로 검증했다.
- 강제 갱신 최초 예약의 DB/앱 시계 차이를 제거하고, 일반 갱신과 강제 갱신의 공정성·부분 진행을 보존했다.
- 시작 직후 SIGTERM이 esbuild까지 동시에 종료하던 문제를 수정했다. 먼저 worker에 정상 종료를 요청하고, 종료/유예 초과 시 프로세스 그룹을 정리한다.
- HTTP heartbeat가 소비자 없이 202 접수만 남기지 않도록 생존 관측 전용 이름의 예약을 400으로 거절한다.
- 관리자 판단·근거 추가 요청을 원본 세대와 함께 잠그고, 이후 감사 기록이 이전 AI 결과 표시를 가리지 않게 했다.

## 3. 실제 실행한 검사

중간에는 새 계약·경합에 필요한 검사만 수행했다. A/B 통합 후 전체 검사에서 발견한 실패를 수정했고,
그 이후에는 바뀐 영역만 재검증했다. 아래 수치를 하나의 동일 시점 전체 테스트 수로 합산하지 않는다.

| 검사 | 실행 결과 |
|---|---|
| B 통합 전체 `npm test` | 78개 파일, 589개 통과 |
| B 통합 전체 `npm run test:integration` | 49개 파일, 441개 통과 |
| 최종 근거/승인 수정 후 관련 DB 검사 | 5개 파일, 28개 통과 |
| 최종 collector/계약/review-job 검사 | 3개 파일, 26개 통과 |
| 최종 cron 예약 경계 | 3개 통과, 최신 컨테이너에서도 heartbeat400/crawl-fetch202 확인 |
| 최종 Playwright | 상세 3개 + 관리자 2개, 총 5개 통과 |
| 최종 Next typegen·TypeScript·ESLint | 통과, ESLint 오류/경고 0 |
| 최종 Docker web/worker 이미지 | 두 target 빌드 통과 |
| 실제 관리자 브라우저 조작 | 모드 변경, 승인, 추가 수집, force 예약, 모바일 390px 가로 넘침 없음·JS 오류 없음 |
| 실제 container Claude 인증 | 구조화 응답 성공, 별도 간단 smoke 1,458ms·보고 비용 $0.0070588 |

DB 통합 시험은 `nomorevibe_workers_test` 및 에이전트별 별도 DB에서 실행했다. 수집/부하 시험은
`nomorevibe_workers_acceptance`, 독립 실행 관측은 `nomorevibe_workers_runtime_test`를 사용했다.
기존 로컬 서비스 DB를 비우거나 마이그레이션하지 않았다.

초기 검사 실패도 남겼다. 최소 글자 크기 13px 검사, 최초 force 예약 시각, lease 실패 반환값에 대한
잘못된 테스트 기대를 수정했다. Playwright 최초 빌드는 외부 worktree의 node_modules symlink 때문에
실패하여 검증 worktree에서 `npm ci`를 실행했다. 이후 제품/관리자 5개가 통과했다.

## 4. 공개 저장소 10개 수집

고정한 공개 저장소 10개 모두 제품 페이지 HTTP 200을 수집했다. observe 모드에서 근거·심사를 확인했고,
마지막 `.2` 심사는 전부 규칙 기반 `needs_review`였다. 부족한 개발 근거를 승인/탈락으로 꾸미지 않는 결과다.
AI 승인·발행 성공 10건을 검증했다는 뜻은 아니다. 해당 표본에서 자동 발행한 제품은 0개다.

| 저장소 | 마지막 입력의 근거 수 | 마지막 처리 |
|---|---:|---|
| TradingGoose/TradingGoose-Studio | 2 | 규칙 보류 |
| Zhangdroid/drever | 1 | 규칙 보류 |
| ryanportfolio/lab-demo | 3 | 규칙 보류 |
| motioneso/moss | 7 | 규칙 보류 |
| onlycastle/popdict | 8 | 규칙 보류 |
| malachuk-josh/rilla-dashboard-clone | 0 | 규칙 보류 |
| LEMing/softbox | 1 | 규칙 보류 |
| koshaji/openclaw | 9 | 규칙 보류 |
| SinhyeokKang/bugshot-2 | 6 | 규칙 보류 |
| Orlando-Villanueva/delight | 8 | 규칙 보류 |

실제 호출/재시도 이력의 보고 비용 합계는 **$0.1264348**이다. 별도 인증 smoke 비용은 포함하지 않는다.
시간 초과·CLI 오류는 재시도 이력으로 남았고 후보 탈락으로 바꾸지 않았다. 원본 JSON은
로컬 `/tmp/nomorevibe-workers-acceptance/live-sample.json`, 재현 명령은 `scripts/verify-worker-sample.ts`에 있다.
[최종 표본 요약](evidence/2026-09-08-worker-live-sample.json)에 근거 요약·입력 hash·버전과 마지막 결과를 보존했다.
이 도구는 해당 이름의 로컬 전용 DB만 허용하고 자동 탐색 없이 정해진 10개를 bounded tick으로 처리한다.

## 5. 부하와 독립 실행 관측

웹 없이 5개 역할을 **2026-09-08 15:10:09.786~15:40:10.118 KST**, 실제 **1,800.307초** 관측했다.
31개 표본 모두 healthy, 재시작 0회, DB 연결 최대 5개였다. 관측 종료 후 scheduler부터 중지하고
남은 요청을 처리한 뒤 소비자 4개를 종료했다. 모두 exit0이며 미처리 요청·lease·DB 연결·오류가 0임을 확인했다.

자세한 장애 주입/30분 관측은 [런타임 검증 보고](2026-09-08-worker-runtime-acceptance.md)에 기록한다.
웹 중지와 worker 독립성, scheduler 중지/재개, 정상 종료, heartbeat 손실·실행 정체에 따른 실제 컨테이너 재시작을
각각 구분한다. 유휴 관측은 외부 수집 처리량이나 24시간 운영 성공을 증명하지 않는다.

부하 시험 환경은 Docker VM 4 CPU·7.737 GiB, web 상한 2 CPU·1.5 GiB이고 다른 로컬 컨테이너와 호스트를 공유했다.
격리 DB에 제품 1,000개·원천 클릭 100,000개를 만들었다. 처음에는 시즌이 없어 주간순이 최신순으로 fallback했다.
실제 `click-rollup`과 `ranking-refresh`로 2026-W37·랭킹 1,000개를 만든 뒤 두 경로를 다시 측정했다.
전체 HTML 응답 기준 **20 RPS·120초, 2,400/2,400 HTTP 2xx, 오류/누락 0건**, p50 **22.7ms**,
p95 **33.6ms**, p99 **39.3ms**였다. 두 경로 모두 실제 제품이 표시되고 빈 랭킹/오류 페이지가 아니었으며,
측정한 app 컨테이너 로그에도 오류나 ranking fallback 이벤트가 없었다.
이 측정 이후 공개 페이지를 바꾸지 않는 cron heartbeat 경계만 수정하고 웹 이미지를 다시 빌드했다.
[측정 원본](evidence/2026-09-08-worker-capacity.json)에 조건과 수치를 보존했다.
부하 중 단일 표본은 web CPU46.64%·142.1MiB, PG CPU18.15%·286.7MiB였다. 최대 사용량으로 해석하지 않는다. 404였던 `/ranking` probe와 헤더만 잰 초기 수치는 채택하지 않는다.

현재 Compose 예산은 역할 전체 DB 풀 23개다. 웹을 하나 추가하면 31개이며 migration/관리 연결은 별도 계산한다. 메모리 상한 합계는
web/worker 7.75 GiB + PostgreSQL 4 GiB이므로 OS·여유를 포함한 16 GiB급 호스트를 초기 배치 예산으로 잡는다.
이는 확정 처리량 보장이 아니다. 실제 외부 API/LLM을 동시에 처리하는 용량과 운영 트래픽은 별도 측정해야 한다.
웹/worker를 한 호스트에서 시작해도 별도 컨테이너로 제한하며, 웹 지연·DB 대기·큐 지연을 보고 분리한다.

## 6. 배포 전 남은 외부 조건

운영 대상 서버/도메인과 사용할 DB가 확정되지 않았다. 읽기 전용 Dokploy 프로젝트 조회에서 일치하는
nomorevibe 프로젝트는 찾지 못했다. 이것을 모든 서버에 배포가 없다는 증명으로 취급하지 않는다.
로컬에서는 Keychain에서 얻은 단기 OAuth access token으로 Claude container 호출을 확인했으며,
운영용 장기 `CLAUDE_CODE_OAUTH_TOKEN` 설정은 아직 남아 있다. 이후 카테고리 분류기는 Codex CLI로
분리되어 publisher에는 `CODEX_ACCESS_TOKEN` 또는 `OPENAI_API_KEY`, reviewer에는 Claude OAuth만
전달한다. 두 운영 인증 모두 아직 설정되지 않았다.

서버·도메인·인증이 준비되면 [운영 절차](independent-workers-runbook.md)에 따라 기존 소비자 stop/drain,
migration 1회, 역할당 1개 시작, 웹 접수 확인, observe 비교, 운영자의 enforce 전환 순서로 적용한다.
24시간 동안 실제 수집·심사·발행·API 대기·재시작·메모리·DB 대기를 관측한 뒤 상시 운영 완료를 판단한다.
enforce를 off로 내리는 것은 발행 보호 해제이므로 자동 장애 복구 수단으로 사용하지 않는다.

원래 `/Users/jr/Desktop/projects/nomorevibe`의 홈·인증·디자인 미커밋 작업은 그대로 보존했다.
통합 브랜치 결과를 기존 작업 위에 강제로 덮어쓰지 않는다.
