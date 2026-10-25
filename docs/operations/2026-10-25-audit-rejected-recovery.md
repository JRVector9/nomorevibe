# 2026-10-25 감사 거절 발행분 복구

## 목표와 범위

관리자에 열린 감사 거절이 쌓이고 자동 화면 검수가 실제 모델을 호출하지 못하는 원인을 확인하고 복구한다. 이미 감사 보류된 제품은 별도 담당자의 범위다. 이 작업은 현재 공개 중이며 보류가 없는 열린 거절만 수동 처리했다. 원 사용자 checkout과 기존 변경사항은 보존했다.

## 운영 증거와 실제 조치

- 06:05:34Z 관리자 기준 열린 거절 4,738, 그 안의 보류 3,112였다. 두 수치는 중첩된다.
- 06:07:42.002Z repeatable-read/read-only 고정 조회에서 캠페인 4의 공개 상태(`seeded`/`verified`), AI 거절, 사람 결정 없음, `audit_hold_at IS NULL`은 정확히 **1,626건**이었다.
- 06:11:01.347Z 같은 1,626건의 원문/메타/추가 의견을 확보했다. 본문 300자 미만 1,154건, 300자 이상 472건이었다. 제목만 수집한 앱·가입형 서비스·공식 앱 스토어를 일괄 거절하지 않았다.
- root가 실제 공개 근거를 검토한 9건 중 8건만 처리했다. 각 근거 파일 SHA256, 현재 source hash·URL·slug·제품 ID·열린 상태·보류 없음 조건을 대조한 뒤 표준 `keepAuditedProduct`/`removeAuditedProduct`를 호출했다. actor는 `codex:jr-audit-recovery-20261025`, 관리자 운영 로그에 근거 SHA256과 이유를 남겼다.
- 06:20:27Z 유지 7건: item 33119 Football Note, 33197 WeaveFox, 33292 SketchSpark, 33294 VibeGraph, 33351 Backblaze, 33381 Plainify, 33615 아끼모 App Store. 제한 로그인만 확인된 33330 Snapper는 내림 1건. 판단 근거가 부족한 33484 Gigang은 그대로 뒀다.
- 06:35:12.669Z 재조회에서 위 7건은 `human_decision=kept`, 공개 `seeded`, 보류 없음, 33330은 `removed`/`banned`, 33484는 사람 결정 없음임을 확인했다. 보류 없는 열린 거절은 **1,618건**으로 8건 줄었다. 전체 열린 거절 4,466, 보류 2,848은 별도 담당자의 보류 처리까지 포함한 동시점 값이다.
- 사용자의 후속 지시에 따라 수동 외부 페이지 조사와 추가 외부 GET은 중단했다. 이후 코드 회귀와 내부 운영 검증만 수행했다.

비밀을 제외한 private 증거는 `/private/tmp/nomorevibe-audit-reject-20261025/`에 있다. `baseline.mjs.result.json`, `enrich.mjs.result.json`, `apply-eight.mjs.result.json`, `recheck.mjs.result.json`이 각 단계의 실제 조회/조치 결과다. root 독립 근거는 `/private/tmp/nomorevibe-admin-recovery-20261025/no-hold-root-nine-decisions.json`이다.

## 자동 화면 검수의 원인

실제 reviewer 로그는 매분 `screen_review.model_deferred reason=reservation_lost`, `asked=0`이었다. 06:22Z 최근 24시간 capacity 장부에서 `local-screen` 509건 전부 `withdrawn`이었고, 동일 항목의 예약이 약 0.3~0.7초 안에 취소됐다. 모델 장애나 shared M3 unknown 점유와 다른, 모델 HTTP 이전의 도메인 검증 실패였다. 화면 큐는 06:22Z 공개 1,000 + 보류 10 = 1,010건이었다.

`proveLocalModelDomain`이 모든 direct 감사 목적에 대해 수집문서의 24시간 `validUntil`을 먼저 검사했다. 현재 페이지를 방금 렌더해도 오래된 canonical crawl 문서 때문에 거절했다. 진단 첫 20건 모두 이 조건에 걸렸으며 첫 항목의 문서는 9월 18일 수집/9월 19일 만료였다. 공개 근거 갱신 저장소와 이 문서는 다르다. 문서 시간을 임의로 갱신해 증거를 새것으로 꾸미지 않았다.

`local-published-filter`는 10월 24일 20:45:11Z에 실제 정산됐고, 별도 담당자가 확인한 audit/published text second opinion remaining은 둘 다 0이다. 그 경로까지 신선도 제한을 없앨 근거가 없어 화면 route만 수정했다.

## 구현과 설계

격리 worktree `/Users/jr/Desktop/projects/nomorevibe-audit-screen-expiry`, branch `codex/audit-screen-expiry-20261025`, base `e71362381e734b9830e339c2d336709b57be7ee2`에서 수정했다.

- 화면 잡이 실제 렌더 요청/수신 시각, 정확한 요청 URL, JPEG SHA256을 capacity wrapper에 전달한다.
- wrapper는 screen 목적에만 이 증거를 요구한다. 수신 60초/요청 120초 이내, 미래 시각 없음, 입력 URL 일치, 실제 모델 wire의 단일 JPEG 바이트 해시 일치를 확인한다. 유효하지 않으면 예약과 HTTP를 시작하지 않는다.
- dispatch TX는 현재 canonical 문서/scan·source revision·input/policy hash·snapshot CAS를 그대로 확인한다. 화면 목적만 archived baseline의 24시간 만료 대신 방금 렌더한 증거의 신선도를 검사한다. 미래 문서/scan 시각은 거절한다.
- 현재 제품 행을 잠근 후 제품 URL과 렌더 URL을 대조하고, item·job·role 잠금 후에도 화면 증거가 아직 신선한지 다시 확인한다. URL이나 원본이 바뀌면 HTTP 이전에 예약을 취소한다.
- proof는 typed transient context로 같은 dispatch 검증까지 전달한다. 기존 `wireHash`가 실제 JPEG를 포함한 전체 모델 요청을 영구 결속한다. DB dispatch/terminal/event JSON과 DDL은 변경하지 않는다.
- candidate, 일반 감사/second opinion, published filter, assist의 기존 신선도와 capacity 계약은 유지한다.

수정 파일은 `lib/llm/{capacity-repository,local-model-capacity-contract,local-model-capacity,local-model-domain}.ts`, `lib/screen-review/job.ts`, `tests/local-model-capacity.test.ts`, `tests/integration/local-model-capacity.test.ts`다.

## 실제 실행한 검증

관련 Next guide를 먼저 읽었으며 다음을 실제 실행했다. 외부 사이트와 모델을 부르지 않는 로컬 fake HTTP/격리 PostgreSQL 회귀다.

```sh
npm test -- tests/local-model-capacity.test.ts tests/local-model-capacity-contract.test.ts tests/local-model-capacity-schema.test.ts tests/local-model-terminal.test.ts tests/llm-assist-capacity-binding.test.ts tests/screen-review-shot2.test.ts tests/screen-review-observation-version.test.ts tests/screen-review-client.test.ts
# 8 files / 45 tests passed

env TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32785/nomorevibe_test npm run test:integration -- tests/integration/local-model-capacity.test.ts tests/integration/screen-review.test.ts tests/integration/audit-screen-review.test.ts tests/integration/local-model-assist-constraint-regression.test.ts
# 4 files / 34 tests passed

npx next typegen
# route types generated successfully
npx tsc --noEmit
# exit 0
npx eslint lib/llm/capacity-repository.ts lib/llm/local-model-capacity-contract.ts lib/llm/local-model-capacity.ts lib/llm/local-model-domain.ts lib/screen-review/job.ts tests/integration/local-model-capacity.test.ts tests/local-model-capacity.test.ts
# exit 0
git diff --check
# exit 0
```

새 회귀는 7일 전 수집문서와 신선한 화면으로 HTTP를 정확히 한 번 보내고 terminal이 settled 됨을 확인한다. source CAS 변경, 현재 제품 URL 변경, 예약 후 만료된 화면 proof는 추가 HTTP 0회다. 화면 외 오래된 감사는 계속 거절되며 후보/assist 기존 회귀도 통과했다.

## 실패한 실험과 남은 작업

- 수정 전 domain을 일시 복원한 올바른 screen 활성 fixture에서 새 회귀는 `reservation_lost`로 실패했다. 수정본 복원 후 GREEN을 확인했다.
- 첫 fixture는 일반 `saveSettings`로 소유권 있는 screen 설정을 바꿀 수 없어 정식 `setQwenAutoStep`으로 수정했다. 잘못된 fixture 결과를 원인 증거로 쓰지 않는다.
- screenProof를 영구 binding에 추가한 안은 기존 exact-key DB CHECK에 거절됐다. 큰 DDL을 피하고 기존 wireHash와 transient 검증으로 좁혔다. 운영 DB DDL 변경은 0, 임시 debug 로그는 제거했다.
- 코드는 아직 운영에 배포하지 않았다. root가 최종 diff/PR/필수 최신 base CI/main 반영과 공통 배포를 맡는다. 별도 담당의 provider boundary 복구 중에는 capacity draining을 존중하며 임의로 open하지 않는다.
- 배포 후 reviewer의 연속 `reservation_lost`가 멈추고 `local-screen` dispatched/settled, `screen_review.ran asked>0`, 실제 대기 감소를 내부 로그/DB에서 확인해야 한다. 외부 페이지 수동 추가 조사는 재개하지 않는다.
- 1,618건을 모두 해결했다고 주장하지 않는다. screen 자동 대상 외 항목과 판단 보류 33484는 남는다.

다음 담당자의 정확한 진입점:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-audit-screen-expiry
git status --short
git diff --check
git diff -- lib/llm/local-model-domain.ts lib/llm/local-model-capacity.ts
# 공통 배포는 root의 provider boundary readback과 최신 main CI 성공 후 조율한다.
# 수동 판단 8건을 다시 적용하지 않는다. 필요한 확인은 read-only:
python3 /private/tmp/nomorevibe-audit-reject-20261025/run.py recheck.mjs
```
