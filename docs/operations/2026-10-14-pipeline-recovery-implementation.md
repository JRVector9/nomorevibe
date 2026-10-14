# 수집→검수 개선 구현·검증 — 2026-10-14

## 범위와 현재 상태

[처리량 실측 보고서](2026-10-14-pipeline-capacity-measurement.md)의 후속 PR00~07을 세 서브에이전트로 병렬 구현했다. 브랜치는 `feat/pipeline-review-recovery-20261014`다. 모든 서브에이전트와 루트가 직접 호출한 Codex CLI의 모델은 `gpt-6.1-sol`, reasoning effort는 `xhigh`다.

유입 제어·수집 복구·실행 감시의 독립 리뷰를 완료했다. 근거·캐시의 네 번째 리뷰에서 확인한 cutoff·release 재개 커서 경계 2개도 수정했다. 테스트 시계 두 곳은 원인을 확인해 수정했고 별도 리뷰 CLEAN을 확인했다. 최종 전체 통합 1,543개와 단위 2,318개, 타입·lint·빌드가 통과했고 모든 구현 범위의 마지막 독립 리뷰도 CLEAN으로 마쳤다. 운영 배포·실제 처리량 재측정은 실행하지 않았다. 신규 자동 승인 기준, 공개 제품 정의, 8시간 스타 관측, 사용자가 중단한 소개 검수는 유지한다. 기존 후보·제품·심사표를 대량 재판정하거나 재발행하지 않았다.

## 구현한 변경

| 단위 | 변경과 기대 동작 | 주요 파일 |
| --- | --- | --- |
| PR00 유입 제어 | 새로 삽입된 후보와 실행 가능한 fetch·규칙·AI1·AI2·발행 대기를 한 번의 읽기 전용 snapshot으로 본다. 대기가 오래 쌓이면 신규 접수를 제한하고 최소 탐색·cursor·hysteresis를 유지한다. | `lib/crawl/discovery-admission.ts`, `lib/crawl/jobs/seed.ts` |
| PR01 수집 결정 무결성 | 처음 근거 gate의 거절은 결정이 없는 후보에만 같은 저장 트랜잭션에서 기록한다. 관리자·AI 결정이나 설정·lease가 probe 중 바뀌면 원본·결정을 덮지 않는다. 일반 후보와 500star 예외에 같은 정책을 적용한다. | `lib/crawl/jobs/fetch.ts`, `lib/crawl/repository.ts` |
| PR02 오류 복구·사람 인계 | timeout·일시 DNS/transport·408/429/5xx는 최대 네 번의 frontier 재시도와 Retry-After를 따른다. 영구 URL·SSRF 실패는 제외한다. 같은 현재 입력의 AI1 실패가 소진되면 이유와 이전 신호를 보존해 사람 인계로 표시한다. | `lib/net/fetch.ts`, `lib/net/ssrf.ts`, `lib/crawl/agent-review-repository.ts` |
| PR03 부분 수집·출처 선택 | GitHub 내부 endpoint·release 페이지 진행을 저장하고 재개한다. 부분 제품 뒤의 제품도 순회하며 선택적 activity 실패는 완료한 핵심 facts를 취소하지 않는다. canonical site의 due·실패 retry는 저장소와 독립적으로 선택한다. | `lib/domain/evidence/providers/github.ts`, `lib/domain/evidence/refresh.ts`, `lib/jobs/products/evidence-refresh.ts` |
| PR04 조건부 요청·캐시 | endpoint별 validator와 마지막 정상 소비 값을 제한된 내부 cache에 저장한다. 304는 cache를 쓰고 cache가 없으면 본문을 다시 받는다. 사이트 parser version·digest도 재사용하며 cache만 달라진 경우 사실 변경으로 세지 않는다. | GitHub·site-fingerprint provider, `lib/net/fetch.ts` |
| PR05 갱신 실행 시간 | 기존 crawler에 `sources` lane을 추가하고 공개 근거 job에 55초 협력 예산을 준다. 제품은 직렬로 처리하고 기존 job·role lease·DB pool·쿼터를 사용한다. | `lib/jobs/catalog.ts`, `scripts/worker.ts`, `lib/jobs/runner.ts` |
| PR06 출력·lane 감시 | lane별 poll·진행 시각을 worker→supervisor→role 상태로 전달한다. 현재 공개 출처 due와 저장된 출력도 관측한다. 장기 provider 오류는 알림과 재시작을 구분한다. | `lib/operations/worker-progress*.ts`, worker·supervisor·role-worker |
| PR07 지원 설정·품질 횟수 | Grok의 90초 호출을 수용하는 AI1 예산과 현행 provider/model이 일치하는 AI2 경로를 연결한다. 한국어 소개 품질 거절 횟수를 네트워크 실패와 분리한다. | agent-review·second-review, `lib/domain/products/korean-taglines.ts`, migration0076 |

### 유입 제어의 해석

초기 압력 기준은 한 단계의 대기 500개이면서 최장 대기 5분 이상, 또는 대기 1,000개다. 제한 중에는 250개/2분 회복 구간을 사용해 경계에서 반복 전환하지 않는다. 제한 시 최소 한 페이지를 탐색하고 최근 5분의 실제 신규 후보를 기준으로 `max(1, 100 - 신규 수)`의 삽입 여유를 둔다. snapshot 시간 초과나 1,000개 심사표 창 잘림은 한 페이지·신규 한 건만 허용한다. 중복 발굴은 신규 삽입 수를 소모하지 않는다. 정상 대기에서는 설정된 페이지 예산을 유지한다.

이 값은 초기 안전 기준이다. 최적 페이지 수나 실제 처리량 증가를 입증한 측정값이 아니다. AI2는 최대 1,000개 심사표 창과 scan당 최대 64개 관측을 일괄 검증해 얻는 **실행 가능 대기의 하한**이다. 관측 수 제한에 걸린 표는 미검증 수·나이·제한 flag로 별도 표시하고 유입 압력에는 잠재 대기로 반영한다. 해당 표가 실제 유효하다고 단정하지 않는다. 최초 검수 대기 나이는 저장된 원본·후보·backoff 시각으로 추정하며 README 변경 시각까지 완전히 복원하지 못한다.

snapshot 전체에 하나의 3초 deadline을 적용한다. pool 대기와 각 읽기의 남은 statement/lock 예산, 입력 검증 사이의 예산 확인을 함께 사용한다. 현재 정책·출처·심사자·유효기간이 맞지 않는 기록은 제한 창에 들어가기 전에 제외한다. 이미 전송한 읽기는 바깥 응답 후 정리·rollback될 수 있지만 만료 뒤 다음 애플리케이션 조회를 시작하지 않으며 쓰기를 방치하는 경로는 없다. 실제 PostgreSQL의 배타 테이블 잠금으로 제한 응답과 다음 snapshot의 정상 복구를 검증했다.

### 저장·캐시와 마이그레이션

부분 진행과 cache는 기존 source의 `normalizedFacts` 내부 영역을 사용한다. 전체 64KiB, endpoint cache 24KiB 상한을 두고 raw 원문·토큰을 공유 문서나 로그에 저장하지 않는다. 예산 유예는 provider 실패와 구분하며 runner가 만든 공통 deadline을 provider에 전달한다.

수집 재개 커서는 페이지 크기·읽은 페이지 수·전환한 절대 위치·완료 상태를 함께 검증한다. 비정상 cursor는 유효 cache와 마지막 정상 facts를 보존하고 처음 페이지부터 재수집한다. 새 응답의 next 링크도 한 페이지씩 같은 크기로 전진해야 한다.

핵심 수집의 각 await 뒤 예산·취소를 확인해 후속 관계 조회나 성공 저장을 시작하지 않는다. 부분 재개에 필요한 제한된 checkpoint 저장은 유지한다. 핵심 facts와 관계가 준비된 뒤 선택적 activity의 협력 예산만 소진되면 핵심 성공은 완료한다. 명시적 취소·deadline은 중단하며, 다음 회차의 완성된 core 재개에서는 optional activity를 건너뛰어 핵심 성공이 계속 밀리지 않게 한다. 다음 일반 갱신 주기에는 activity를 다시 시도한다.

`0076_korean_tagline_quality_rejections.sql`은 기존 테이블에 `quality_rejections`만 추가한다. 과거 마지막 오류가 `rejected:*`인 행은 `min(attempts, 4)`, 그 외는 0으로 보수적으로 채운다. 과거 혼합 실패의 정확한 품질 횟수는 복원할 수 없다. 기존 retry 시각과 사용자 중단을 초기화하지 않는다. 같은 입력의 성공은 누적 이력을 보존하고 오류·retry를 해제하며, 입력 변경은 새 품질 횟수로 시작한다.

## 실제 검증과 독립 리뷰

리뷰는 루트가 read-only Codex CLI를 직접 실행했다. 프로세스 exit0과 리뷰의 `CLEAN`을 구분한다. 검토 중 발견한 재현 가능한 문제는 담당 에이전트가 회귀 테스트로 재현한 뒤 수정하고 다시 리뷰한다.

| 검토 범위 | 첫 리뷰 결과 | 현재 후속 상태 |
| --- | --- | --- |
| 수집·재시도 | P1 1개/P2 3개, 확신 9~10/10: 동시 결정·설정 fence·README 입력별 소진·마지막 Retry-After | 네 문제 수정 후 두 번째 리뷰 CLEAN |
| 근거·캐시 | P1 2개/P2 6개, 확신 9~10/10: 전체 await deadline·lease 저장 fence·관계 보존·304 URL 변경·README host·release 정렬·core cache·payload 검증 | 첫 수정 후 두 번째 리뷰에서 취소 뒤 요청·README cache 경계 P2 4개 발견. 두 번째 수정 RED12/GREEN 후 세 번째 리뷰에서 추가 P2 3개(취소 뒤 source 읽기·site-only host·partial schema) 확인. 추가 RED24(본20·complete1·progress3) 재현·수정, 집중 통합120·단위125·요청5 통과. 네 번째 리뷰에서 generation lock 뒤 조회·core cutoff·release 커서 P2 2개를 확인. 실제 RED20+새 응답 cursor RED4 후 집중 통합164·단위125 통과. 다섯 번째 리뷰 CLEAN, `1167d5e` 커밋 |
| 한국어 품질 횟수 | P2 1개, 확신 95%: 홈 추가 재시도 뒤 네트워크 실패로 일반 품질 한도 우회 | 회귀 재현·수정 후 두 번째 리뷰 CLEAN, `5424c35` 커밋 |
| 실행·감시 | P1 2개/P2 1개, 확신 9~10/10: AI-level 정상 유예·scan 생성 전 오류·예산 내 실행의 경보 | 두 번째 리뷰의 오래된 repository 오류 고정 P2를 RED 6개로 재현·수정. 세 번째 리뷰 CLEAN, `d1c9083` 커밋 |
| 유입 제어·Grok | P2 2개, 확신 10/10: snapshot 전체 시간 제한·AI2 관측 한도에 따른 누락 표시 | 두 번째 리뷰 CLEAN. 추가 조사로 과거 무효 표의 창 점유와 fallback 계약을 DB RED 17개로 재현·수정. 세 번째 리뷰 CLEAN, `af5f55b` 커밋. Grok 경로의 지적은 없음 |
| HOT 가능성 보고 | 첫 리뷰 CLEAN | 기능은 구현하지 않음 |

마지막 근거 provider와 테스트까지 소스를 고정한 뒤 다음 전체 검사를 **실제로 실행**했다.

| 검사 | 실제 결과 |
| --- | --- |
| `npx tsc --noEmit --incremental false` | exit0, 16.76초 |
| `npm run lint` | exit0, 17.08초. 기존 vendor `_ctx` 미사용 warning 1개 |
| `npm test` | 251파일·2,318테스트 통과, exit0, 8.62초 |
| PostgreSQL integration shard1 | 48파일·461테스트 통과, exit0, 71.54초 |
| PostgreSQL integration shard2 | 48파일·444테스트 통과, exit0, 60.38초 |
| PostgreSQL integration shard3 | 47파일·638테스트 통과·기존 todo 1개, exit0, 116.49초 |
| `npm run build` | exit0, 11.51초. 운영 DB 대신 사용하지 않는 localhost build URL 주입 |
| `node scripts/bundle-size.mjs` | exit0, home148.6/detail158.9/launch136.1KB(br), 세 경로 모두 10% 한도 안 |

통합 검사는 각기 독립된 pgvector0.8.6/PG17 테스트 DB를 사용했고 총 **143파일·1,543테스트 통과, 기존 todo 1개**다. 이전 전체 검사도 실행했으며 그 결과를 최종 횟수에 중복 합산하지 않는다.

관련 변경이 없는 부가 검사는 앞선 실행 결과를 사용한다. `npx next typegen` exit0; `npm run check:i18n`은 4locale·8namespace·11공개 페이지 확인/exit0; Python deploy tests 23개와 node ci-scope tests 4개도 실제 통과했다.

감시 query의 집중 성능 검증은 합성 데이터 44,000개 공개 제품·88,000개 출처를 테스트 DB에 넣어 다섯 번 읽었다. 987/975/985/974/983ms였고 3초 statement limit을 유지했다. 실제 운영의 오래된 이력·동시 갱신·API 경쟁을 포함한 검증은 아니다.

첫 수정 뒤 전체 검증에서 기존 테스트 fixture 두 곳이 실패했다. 단위 cursor의 정확한 예상값에 새 provider 오류 기록을 추가하고, 설정 적용 fixture가 구형 역할 key도 초기화하도록 고쳤다. 원인과 RED→GREEN을 확인했으며 생산 설정 코드는 바꾸지 않았다. 단위 재실행은 250파일·2,309테스트, 타입·lint도 exit0이었다. 이어 전체 통합에서 host와 DB 시각 차이로 재시도·즉시 검수 진입 fixture 두 곳이 실패했다. DB 시각의 양쪽 경계·정확한 5분 backoff·4회 한도와 실제 스캔 완료·기존 후보 ID를 유지하도록 교정했다. 단독 RED로 원인을 입증했고 별도 직접 리뷰 CLEAN 뒤 `2b0d993`으로 커밋했다. 마지막 provider 수정까지 반영한 전체 검사의 최종 결과는 위 표다.

검사 원본·실제 CLI usage receipt는 `/private/tmp/nomorevibe-pipeline-implementation-20261014`(디렉터리0700/파일0600)에 보관했다. 오래된 `.next/dev/types`가 삭제된 route32개를 참조한 문제는 해당 생성물만 private 디렉터리로 이동하고 typegen을 재실행해 해결했다. 앱 route나 tsconfig를 바꾸지 않았다.

## 로컬 커밋과 CLI 사용량

| 커밋 | 내용 |
| --- | --- |
| `1fca060` | 수집 결정 보호·일시 오류 복구·현재 입력 사람 인계 |
| `5424c35` | 한국어 품질 거절 횟수·migration0076 |
| `d1c9083` | sources lane·출력·lane 진행 감시 |
| `af5f55b` | 실제 유입 제어·Grok/AI2 경로 |
| `2b0d993` | DB 시각 기준의 재시도·스캔 완료 fixture |
| `1167d5e` | 부분 근거 재개·cache·독립 사이트 선택·취소 경계 |

직접 CLI 리뷰 17회 전체의 실제 receipt 합계는 입력 **29,249,292**(그중 캐시 **26,870,272**)·출력 **238,586**토큰이다. 캐시는 입력에 포함되며 다시 더하지 않는다. 마지막 근거 리뷰는 exit0/460.01초, 입력897,605(캐시802,432)·출력12,675이며 실제 최종 문구는 `No findings / CONCLUSION: OK`다. native 서브에이전트의 별도 사용량은 노출되지 않아 추정하지 않는다.

검사가 끝난 뒤 이번 작업용 테스트 DB 컨테이너 세 개만 정지했다. 기존 사용자 컨테이너나 데이터는 삭제하지 않았다. 문서·운영 후속을 포함한 최종 docs 커밋은 브랜치의 `git log`로 확인한다. push·PR·merge·운영 배포는 실행하지 않았다.

## 배포 후 남는 운영 검증

1. 최신 base의 CI `check`를 통과한 PR을 main에 반영하고, 기존 절차에 따라 migration0076을 한 번 적용한 뒤 같은 SHA의 worker·web을 배포한다. 지금 이 작업은 실행하지 않았다.
2. 신규 수집·규칙·AI·발행 대기, source 성공·실패·partial·due·최장 지연, 실제 HTTP/304 비율과 GitHub 계정별 쿼터를 다시 관측한다. 유지 하한 3,453source/h와 catch-up 목표 5,500source/h는 아직 달성했다고 주장하지 않는다.
3. 기존 근거 갱신 캐시의 최초 구축 비용을 포함해 55초 lane의 지속 처리량과 신규 수집 starvation 여부를 확인한다. 목표 미달 시 병목을 다시 측정한 뒤 제한 병렬화를 검토한다. 별도 상시 evidence worker나 pool 확대는 하지 않았다.
4. 초기 gate 문제의 과거 후보는 새 원본으로 재수집→규칙 판정해야 한다. 이 코드만으로 과거 거절을 자동 승인하거나 기존 source를 임의 재발행하지 않는다.
5. 외부 monitor의 실제 설치·Push/deadman 수신과 운영 장애 검증 창은 별도로 확인한다. 합성 테스트나 내부 상태 집계로 외부 알림 수신을 대신하지 않는다.

## HOT 추가 수집기

[X·Threads HOT 가능성 보고서](2026-10-14-social-hot-crawler-feasibility.md)에 공식 API·요금·권한·독립 프로세스 계약을 정리했다. X 공개 GitHub 링크→기존 심사→공개 제품만 HOT 표시하는 작은 MVP가 우선이다. Threads는 공개 검색 승인과 타인 게시물 반응 수 제한이 있어 같은 반응 점수로 합칠 수 없다. 별도 앱에 기존 `--role=crawler`를 쓰면 같은 lease를 경쟁하므로 실제 독립 crawler는 새 역할이 필요하다. HOT crawler·DB·필터 자체는 이번 요청의 조사 범위를 넘어 구현하지 않았다.
