# 수집→검수 설계 재검토 — 2026-10-14

## 범위와 판단

사용자가 기존 구현을 설계와 다시 대조하도록 요청해 PR00~07을 세 서브에이전트로 병렬 재검토했다. 모든 서브에이전트와 root 직접 Codex CLI는 `gpt-6.1-sol / xhigh`다. 시작 브랜치는 `feat/pipeline-review-recovery-20261014`, HEAD는 `1a2ae0e`다. [이전 구현 보고서](2026-10-14-pipeline-recovery-implementation.md)의 전체 검사 결과는 이전 단계의 기록으로 보존한다.

유입 제어·수집 결정·오류 복구·실행 감시·모델 경로·소개 품질 횟수에는 재현 가능한 추가 설계 차이가 발견되지 않았다. 근거 갱신의 취소/시간 경계 여섯 개를 재현·수정하고, 최종 검사와 root 직접 리뷰를 통과했다. 운영 배포·migration0076·지속 처리량·외부 알림 수신은 이번 코드 검토로 증명하지 않는다. 사용자가 중단한 소개 검수는 유지한다.

## 병렬 설계 대조 결과

| 담당 | 대조 범위 | 발견 및 실제 검사 |
| --- | --- | --- |
| collection | PR00 유입 제어, PR01 결정 무결성, PR02 오류 복구, PR07 AI1/AI2 | 추가 차이 없음. 실행 가능 selector, snapshot 전체3초, 현재 이력의 LIMIT 전 제외, AI2 bounded lower bound, hysteresis·중복·cursor, 설정/결정 fence, 네 번 retry·Retry-After·사람 인계 확인. 안전 unit14파일156통과, SSRF선택6통과/6skip. |
| evidence | PR03 부분 수집·선택, PR04 조건부 cache | 초기 선택/canonical await 뒤 cutoff와 site 최종 저장 callback 경계 P2 두 개 발견. cache64KiB/endpoint24KiB, release cursor 전환, site-only unknown, generation·lease·checkpoint 규칙 대조. root 직접 리뷰와 후속 대조에서 GitHub freshness/caller 경계 네 개 추가 발견. |
| runtime | PR05 sources lane, PR06 진행/출력 감시, PR07 소개 품질 횟수 | 추가 차이 없음. 기존 crawler 역할·lease·pool 공유, lane55초, 실제 poll/progress·hang 감시, pause/backoff 보호, 현재 due/오류 relevance, 품질/network 횟수 분리 확인. 안전 unit8파일79통과. |

각 agent가 실행하지 않은 운영/DB 검사를 통과로 표기하지 않는다. 최종 회귀 통합은 아래 전용 테스트 DB 기록으로 판단한다.

## 추가 취소 경계와 수정 계약

| 경계 | 이전 동작 | 수정 계약 |
| --- | --- | --- |
| generation/settings/initial selection/canonical 선택 await | 기다리는 동안 취소되어도 새 조회를 시작하거나 빈 결과를 완료로 반환 | 각 경계의 예산·signal·deadline 확인, 중단은 complete:false. 제한된 부분 checkpoint flush는 유지. |
| site provider 최종 transaction callback | pool/lease 대기 중 취소된 뒤 성공/실패 mutation 시작 | callback에서 첫 mutation 전 hard stop 확인. 이미 시작한 DB 작업은 안전하게 완료/정리. |
| GitHub provider 최종 저장 반환 → freshness transaction | 이미 시작한 provider 저장 완료를 이유로 취소 뒤 새 generation/source/freshness 작업 시작 | provider 반환 직후와 transaction 진입에 명시 signal/deadline 검사. 중단이면 null sentinel과 incomplete 반환, 이미 저장된 release 수 보존. |
| freshness source SELECT → 성공/retry UPDATE | SELECT 대기 중 hard cutoff 뒤 새 UPDATE 시작 | SELECT 반환 직후 hard stop 확인. 소프트 hasBudget 소진에 따른 core 성공과 이미 시작한 쓰기의 lease fence를 보존. |
| 이미 시작한 retry UPDATE 완료 → caller의 retry-state SELECT | 취소 중이던 쓰기와 필요한 lease assertion 완료 뒤 새 retry 조회 시작 | hard cutoff 뒤 새 조회 금지. 알고 있는 retry 시각·저장된 개수를 checkpoint에 보존. |
| collector 예외 → caller의 markSourceFailure | cutoff 뒤 provider 예외를 실패로 기록하려고 새 transaction 시작 | hard cutoff 뒤 새 실패 저장 금지. generation/lease 오류는 계속 전파하며 중단 bookkeeping은 허용. |

GitHub freshness와 caller의 후속 경계는 협력 `hasBudget`만 소진된 optional activity와 명시 signal/deadline의 hard stop을 구별한다. 쓰기를 detach하거나 취소한 뒤 저장 성공을 주장하지 않는다.

생산 수정은 `lib/domain/evidence/refresh.ts`, `lib/domain/evidence/providers/site-fingerprint.ts` 두 파일이다. 신규 단위 회귀는 `tests/evidence-refresh-cancellation.test.ts`, `tests/site-fingerprint-cancellation.test.ts`; 통합 fixture의 협력 예산 두 곳은 새 검사 호출 횟수 대신 실제 source 진행으로 제한하며 원래 재개 검증을 유지한다.

## 실제 검증 기록

초기 P2 두 개는 RED24→GREEN25와 추가 finish RED3→GREEN3로 검증했다. root 첫 직접 리뷰가 발견한 provider 반환 경계는 RED4→GREEN25로 검증했다. 두 번째 직접 리뷰가 발견한 SELECT 경계는 abort/deadline × updated/deferred 네 경우를 RED4/기존25통과→GREEN29통과로 검증했다.

네 번째 경계까지 관련 unit10파일92, 전용 통합3파일134, 타입·scoped lint는 실제 통과했다. 테스트 전용55436 컨테이너는 정지하고 exited 상태를 확인했다.

네 번째 경계 수정까지 고정한 root 전체 검사도 실제 실행했다: `env -u DATABASE_URL -u READ_DATABASE_URL -u GITHUB_COLLECTOR_SECRET -u GITHUB_TOKEN -u X_BEARER_TOKEN npm test`는254파일2,407통과/exit0/6.96초, 타입 exit0, 전체 lint exit0(기존 vendor `_ctx` warning1). 이는 다섯 번째 경계 수정 전의 결과이며 최종 소스 검사로 혼동하지 않는다.

caller의 추가 두 경계는 RED6실패/기존35통과→GREEN41통과로 검증했다. 명시/기본 retry 시각, abort/deadline, 필요한 lease assertion·checkpoint 완료, CAS 실패·generation/lease loss 전파 호환성을 함께 확인한다. 새 DB 통합 두 경우는 실제 재시도 시각과 active-version CAS checkpoint·lease fence 보존을 검증한다. 기존 RSS/media verifier·upsert 내부는 이번 GitHub/site caller 수정 범위에 포함하지 않는다.

최종 소스에서 실제 검사 결과:

| 검사 | 결과 |
| --- | --- |
| evidence 관련 단위10파일 | 104통과 |
| evidence 관련 통합3파일 | 136통과 |
| root 전체 단위254파일 | 2,433통과/exit0/7.49초 |
| `npx tsc --noEmit --incremental false` | exit0 |
| `npm run lint` | exit0, 기존 vendor `_ctx` warning1 |

새 통합 fixture의 `actor` 누락 때문에 병렬 typecheck 한 번이 exit2였다. 담당자가 필수 actor를 넣은 뒤 최종 전체 타입 검사는 exit0이다. 새 DB spy는 lazy Proxy의 own property가 아니라 실패했고 이를 제거했다. 새 읽기 금지는 실제 단위 재현으로 검증하며, DB 통합은 checkpoint/CAS/lease 영속성을 검증한다. 수정 후 통합136개를 다시 실행했고 테스트 컨테이너는 정지/상태 exited 확인했다. UI·Next route 수정이 없어 이번에는 빌드를 다시 실행하지 않았으며 이전 빌드 기록과 구별한다.

통합 DB는 `localhost:55436/nomorevibe_test`의 이번 작업용 단독 컨테이너다. 운영 URL을 주입하거나 다른 agent와 같은 fixture DB를 병렬로 쓰지 않는다.

```sh
env -u DATABASE_URL -u READ_DATABASE_URL -u GITHUB_COLLECTOR_SECRET -u GITHUB_TOKEN npm test -- tests/evidence-refresh-cancellation.test.ts tests/site-fingerprint-cancellation.test.ts tests/github-evidence.test.ts tests/github-cancellation.test.ts tests/github-collector-accounts.test.ts tests/github-apps.test.ts tests/product-refresh-progress.test.ts tests/site-fingerprint.test.ts tests/net-fetch-conditional.test.ts tests/net-fetch-deadline.test.ts

env -u DATABASE_URL -u READ_DATABASE_URL -u GITHUB_COLLECTOR_SECRET -u GITHUB_TOKEN TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55436/nomorevibe_test node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/github-evidence.test.ts tests/integration/evidence-refresh.test.ts tests/integration/site-fingerprint.test.ts

npx tsc --noEmit --incremental false
```

## root 직접 리뷰와 사용량

root가 read-only CLI를 직접 실행하고 최종 문구를 읽는다. 프로세스 exit0을 CLEAN으로 해석하지 않는다.

| 리뷰 | 실제 결과 |
| --- | --- |
| design_reaudit | exit0, GitHub provider 반환 뒤 새 freshness 작업 P2 발견. transient503 재연결2회 후 리뷰 완료. |
| design_reaudit_round2 | exit0, source SELECT를 기다리는 동안 hard cutoff 뒤 UPDATE 시작 P2 발견. |
| design_reaudit_round3 | exit0, 취소 중이던 deferred UPDATE가 완료된 뒤 caller의 새 retry SELECT P2 발견. |
| design_reaudit_round4 | exit0/351.69초, 실제 No findings / CONCLUSION: OK. 별도55개 in-memory 검사에서 cutoff·in-flight write/lease·checkpoint 실패·저장된 개수·soft budget 완료 확인. |

마지막 직접 리뷰는 두 구현 범위 모두 CLEAN으로 완료했다. evidence 코드는 `df39c40`, X 파일럿 코드는 `5c791dc`에 로컬 커밋했다. 문서 커밋은 `git log`로 확인한다. push·PR·merge·운영 배포는 하지 않았다. private 원본은 `/private/tmp/nomorevibe-x-policy-review-20261014`이며 토큰/env 파일이나 실제 API 응답을 리뷰 입력에 넣지 않는다.

이번 단계의 직접 CLI7회 실제 receipt 합계는 입력 **4,823,413**(그중 캐시 **4,214,784**)·출력 **72,750**토큰이다. 캐시는 입력에 포함되며 다시 더하지 않는다. 모두 지정 모델/effort와 exit0이 확인됐고, 최초 evidence/X 리뷰의 transient503 재연결3회 뒤 최종 결과를 받았다. 다섯 번은 실제 지적사항이 있었으며, 마지막 evidence/X 두 리뷰만 CLEAN이다. native 서브에이전트의 별도 사용량은 노출되지 않아 추정하지 않는다. 이전 단계의 CLI17회 사용량과 이번7회를 혼동하지 않는다.

## X 정책과 남은 운영 작업

별도 [X 정책·파일럿 보고서](2026-10-14-x-api-policy-and-pilot.md)에 공식 인터페이스·목적 승인·삭제·표시·비용 조건을 정리했다. 기존 가능성 보고서의 작성자 ID 저장·독립 작성자 지표도 승인된 최소 식별/보존 설계가 있을 때만 사용하는 조건으로 바로잡았다. 현재 acceptance 파일럿에는 작성자 ID를 저장하지 않는다.

사용자 제공 Bearer는 로컬 private env에 저장했지만 **이번 작업에서 프로젝트 발굴·공개 HOT 목적을 신청서에 제출하거나 변경 승인을 받은 적은 없다.** 기존 등록의 승인 범위도 미확인이다. 실제 X API는 목적 확인까지 실행하지 않는다. 기본 dry-run과 목적 gate를 검증한 것은 인증·검색·요금 검증과 다르다.

남은 운영 단계는 최신 base/CI·PR·배포·migration0076, 실제 갱신 처리량·304/쿼터·신규 수집 starvation, 외부 monitor 수신이다. X는 목적 확인 후 소량 실제 acceptance를 통과해야 독립 social 역할·DB·HOT filter·일일 예산을 구현한다.
