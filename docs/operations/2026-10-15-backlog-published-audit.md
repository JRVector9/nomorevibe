# 2026-10-15 발행분 재검수·신규 심사 적체 회복

## 범위와 승인

- 사용자는 관리자에 밀린 작업을 자동으로 처리하고 직접 판단이 필요한 경우만 남기도록 지시했다.
- 이 작업의 범위는 `product-audit` 및 fetch/judge/AI1/AI2/publish 잔여 조사이다. 신규 발굴, 모델 변경, 시도 횟수 초기화, 기존 판정의 일괄 승인·삭제, 결과 시각 조작은 하지 않는다.
- 제어는 기존 운영 함수와 CAS/감사 기록을 사용한다. 비밀 환경 변수·토큰·Keychain 원문과 응답 본문은 출력하지 않는다.
- 시간은 별도 표시가 없으면 KST이다. 이 문서는 직접 실행한 관측과 명령만 기록한다. root가 handoff를 통합한다.

## 07:37 초기 실측

`2026-10-14T22:37:20.320Z`의 실제 DB/운영 함수 관측:

| 항목 | 상태 |
| --- | --- |
| 수집/규칙/AI1/AI2/publish 실행 가능 대기 | 모두 0 |
| 수동 주의 | fetch 1, AI1 1 |
| 후보 보류 | 209: second_review_split 181, no_description 13, suspected_spam 9, ambiguous 4, ai_review_exhausted 1, repo_deleted 1 |
| 사람 직접 판단 | 202; agreed 승인 3과 별도 |
| 수집 실패 | 14, 모두 기존 attempts 4; 13은 원본 문서 없음/timeout, 1은 원본 문서 있음 |
| 최신 발행분 감사 | campaign 3, cancelled, 구판 prompt 2026-09-19.3/rules 2026-09-19.2 |
| 구판 감사 미해결 거절 | 1,207 |
| 현재 prompt/rules | 모두 2026-10-06.2 |
| 현재 1차 모델 | abcllm / `[MLX] gpt-oss-120b` |
| 현재 2차 주 모델 | abcllm / `[supa] Qwen3.8-27B-NVFP4` |
| 신규 GitHub/Show HN 발굴 | `not_before` 2100으로 중단 유지 |

구판 감사는 cancelled여서 정기 `product-audit` 잡이 성공 종료했어도 실제 새 검수는 실행하지 않았다. 구판 행이나 버전을 덮어쓰지 않고 현재 기준의 새 감사가 필요한 상태였다.

## 정상 운영 재개

07:40:30에 표준 `startProductAudit({ reauditKept: false })`를 실행했다. 새 **campaign 4**가 현재 prompt/rules `2026-10-06.2`, 기존 제공자/모델 `[MLX] gpt-oss-120b`를 그대로 고정하고 **44,018개**를 포함했다. 기존 campaign 3, 판정, attempts는 보존했다. 같은 제어 흐름에서 `audit-start` 기록과 CAS로 `product-audit`의 정상 요청 version **36826**을 남겼다. 신규 발굴 중단이 유지된 것도 확인했다.

07:40:59에 `requeueResolvedCandidates`를 실행했다. 자동 보류 4개를 검사해 기존 규칙상 resolved인 3개를 CAS로 `new`에 돌리고 `crawl-judge` 정상 요청 및 감사 기록을 남겼다. 07:41:00에 실제 judge 3개 처리가 저장됐다. 다시 보류된 후보가 있으므로 이를 승인·발행 성공으로 계산하지 않는다.

처음 2회의 감사 시작 도구 실행은 Node 모듈의 schema named export 오류로 실패했다. 이후 읽기 전용 확인에서 campaign은 여전히 3/cancelled, 해당 actor의 감사 기록은 0개였다. `schema`의 default export와 `./lib/db/index.ts` 경로를 사용한 뒤 정상 시작했다. 실패한 실행을 성공으로 계산하지 않았다.

## agreed 승인 3개

후보 `287317` (`ludea-ai/gta7`), `289803` (`pipecrew-ai/pipecrew`), `290122` (`Terra0305/Arduino`)는 2차 표가 agreed/approve였지만 후보 상태는 `needs_review/no_description`이고 실제 소개 문장이 비어 있었다. 관리자 정상 입력 검사에서도 `outdated`였으며, `loadSecondReviewInput`은 `ai_approved`의 현재 후보 상태 조건을 충족하지 못했다.

셋의 기존 소개 작업은 원본 page/README를 대상으로 실행한 뒤 빈 문장을 성공 결과로 저장한 상태였다. 같은 원본의 빈 성공 결과는 정상 작업이 자동으로 다시 호출하지 않는다. 모델 합의 표만 보고 관리자 승인하거나 소개를 임의로 채우지 않았다. 이 부분은 text 담당에게 실제 원본 변경·정상 재시도 조건 확인을 전달했다.

## 감사 진행과 시간 제한 조사

- 07:41:39: campaign 4 실제 저장 성공 0, timeout 시도 4. 잡은 `done=false`를 기록했다. terminal failed 집계는 0이지만 실제 실패 시도 4가 있다는 뜻이다.
- 07:44:32: 실제 저장 성공 8, timeout 시도 8. timeout은 23.79~23.92초에서 잘렸다. 같은 모델의 AI1 최근 24시간 성공은 1,183개, 평균 12.71초/최대 23.955초였고 timeout 33개는 평균 24.037초였다.
- 07:45:03에 reviewer의 실제 gateway 모델 목록에서 `[MLX] gpt-oss-120b` 지원을 확인했다. 현재 1차 설정과 감사 모델이 일치하므로 모델 prefix 복구는 필요하지 않았다.
- 기존 timeout 항목 `pi-coding-agent`의 동일 정상 입력을 60초 ceiling으로 단일 진단한 결과 HTTP 200, finish reason `stop`, 계약 검증 성공, 22.254초였다. 요청 모델은 `[MLX] gpt-oss-120b`, 응답 모델 표기는 `gpt-oss-120b`, 사용량은 input 9,496/output 339였다.
- 서로 다른 기존 timeout 항목 `super-dev`의 같은 방식 진단은 19.899초/HTTP 200/검증 성공이었다.
- 이 두 진단은 판정 저장을 하지 않은 읽기 전용 gateway 측정이다. 둘 다 24초 안에 끝났으므로 이 결과만으로 24초 예산의 결함을 실측 확정하지 않았다. 현 동시성 4에서 아직 진단하지 않은 timeout 항목들의 정상 응답 시간을 추가 확인 중이다.

07:48:30부터 실제 pending 입력 중 4개를 현재 동시성 4와 같은 모델로 진단했다. HTTP 200/finish `stop`/계약 검증 성공 응답은 16.982, 17.587, **29.742, 36.328초**였다. 따라서 감사의 24초 제한이 저장 가능한 정상 응답을 잘라내는 문제를 직접 확인했다. gateway의 내부 대기와 생성 시간은 외부 HTTP 응답만으로 분리하지 못했다. 이 진단 4개의 판정을 운영 저장 성공에 포함하지 않는다.

### 승인된 최소 설계와 구현 순서

기존 24초를 유지하며 반복 재시도하는 접근은 동일 원본의 시도 상한을 불필요하게 소진한다. 110초로 늘리는 접근은 충분한 여유가 있지만 같은 reviewer의 신규 후보 대기를 더 늘린다. **감사 내부 65초/워커 70초**를 선택한다. gateway의 기존 60초를 전부 확보하면서 저장 여유 2초까지 남아 있을 때만 새 호출을 시작하며, 원본 조회 후에도 다시 확인한다. 모델·판정 계약·시도 상한·우선 양보·큐 선택은 보존한다.

root는 정상 응답이 24초를 넘는 실측이 확인되면 감사의 유한 예산과 worker 특례를 함께 고치는 것을 승인했다. 위 실측으로 해당 조건을 충족했다. 역할 lease 45초/10초 갱신, job lease 15초 갱신, 결과 저장 CAS, 180초 supervisor 상한을 유지한다. 외부 취소·`hasBudget` 상실 시 호출을 끊고 늦은 응답을 저장하거나 실패 시도로 세지 않는다. product-audit에 새로운 자동 continuation 계약을 추가하지 않으며 기존 정기 요청을 따른다.

- [x] `tests/product-audit-job.test.ts`: 30초 뒤의 정상 판정 저장, full ceiling이 없는 호출 미시작, 원본 조회 후 예산 재확인, 취소·소유권 상실·늦은 성공의 미저장, 신규 후보 우선 양보와 CLI의 작은 ceiling을 fake clock으로 검사했다.
- [x] `tests/worker-runtime.test.ts`: product-audit의 70초 유한 예산 특례를 먼저 검사했다.
- [x] `npm test -- tests/product-audit-job.test.ts tests/worker-runtime.test.ts`를 실행해 기존 코드에서 의도한 **6개 RED/15개 통과**를 확인했다. 최초 RED 도중 mock의 없는 signal 접근 오류도 있어 test fixture를 수정하고 재실행한 뒤, 해당 오류가 없는 의도한 6개 RED를 확인했다.
- [x] `lib/crawl/jobs/product-audit.ts`의 65초 예산, full-call admission, 취소/소유권 감시와 `scripts/worker.ts`의 해당 잡 예산 한 줄을 수정했다.
- [x] 수동 `scripts/run-job.ts`도 워커의 `jobRunOptions`를 쓰도록 root 승인하에 두 줄 수정했다. `tests/manual-job-budget.test.ts`로 실제 수동 entry를 호출해 감사/발행의 70/120초 예산 누락 **2개 RED**와 fetch의 기존 기본 예산 통과를 확인한 뒤 수정했다.
- [x] 관련 6개 파일 **57개 단위 검사** 및 기존 감사 **21개**, 잡 실행 **19개 통합 검사**가 실제 통과했다. 통합 검사는 별도 `pgvector/pgvector:0.8.6-pg17` 컨테이너 `nomorevibe-product-audit-pgvector-test-db-20261015`, localhost **55447**의 `nomorevibe_test`에서 실행했다. 다른 에이전트의 테스트 DB를 사용하지 않았다.
- [x] 변경 후 `npx tsc --noEmit`, scoped eslint, `git diff --check`를 실제 실행했고 성공했다. Vitest는 기존 `configLoader: native` 예정 변경에 관한 Vite 경고를 출력했다. 통합 검사에 의도된 장애 사례의 error 로그가 있지만 test 결과는 통과였다.
- [ ] root에게 검증·diff를 전달하고 배포 후 실제 결과 저장을 새 progress 명령으로 확인한다. 배포와 완료는 그 시점의 실제 증거가 생긴 뒤 기록한다.

### 07:48 및 07:55 진행

07:48:42에는 campaign 4 실제 저장 판정 **20개/거절 4개**, 실패 시도 누계 12, terminal failed 1개였다. 구판 미해결 거절 1,207개 중 새 판정은 approve 2/reject 2/미답 1,203이었다. 구판 기록은 그대로다.

정상 requeue 3개는 `henphonee-eng/oticas-cobranca-`, `bodhiyogarambouillet-alt/yogapp`, `facelessvideokit/facelessvideokit.github.io`였다. judge가 현재 같은 모델·정책의 기존 성공 판정을 재사용해 다시 ambiguous에 두었다. 새 모델 호출 3개나 승인 3개로 계산하지 않는다. 신규 파이프라인은 ready 0, manual fetch 1/AI1 1, 보류 209로 유지됐다.

24초 제한으로 세 번 timeout인 고정 item **33063/apps-by-tim-wu-haotian**은 같은 정상 입력의 60초 진단에서 10.951초에 계약 검증을 통과했다. root가 이 고정 항목의 한 번 회복을 승인했다. 공식 `runJob` lease로 한 번 호출하고, candidate/document/settings/agent-evidence 공유 잠금 및 현재 입력 hash/source 일치 검사를 거쳐 기존 `recordAuditResult`로 새 결과를 추가하는 private 도구를 준비했다. 기존 attempts 3이나 시도 기록을 초기화하지 않는다.

07:55:56 첫 회복 실행은 **skipped/locked**였다. 모델 호출·판정 저장·회복 시도 intent가 모두 0이고 기존 timeout 기록 3개/attempts 3은 그대로다. 그 시각 campaign 4는 실제 저장 판정 41개, 거절 10개, terminal failed 2개였다.

07:56:30에는 정상 job lease를 얻어 새 모델 호출을 실행했다. 6.938초에 계약 검증을 통과한 approve/.97 응답을 받았지만 **판정은 저장하지 못했다**. private 회복 도구에 공개분 감사의 정상 계약에는 없는 신규 발행용 `validUntil` 검사를 추가한 것이 원인이었다. 원본의 `validUntil`은 2026-08-30이지만 현재 정상 audit 입력 hash는 기존 timeout 기록과 동일했다. 정상 `auditPublishedProducts`는 이 24시간 조건을 요구하지 않는다. 과도한 private 검사 때문에 저장이 거부됐으며 기존 attempts 3/timeout 행 3개는 보존됐다. 정기 감사는 이후 정상 tick에서 job 오류를 해소하고 계속 진행했다.

root는 정상 audit 계약에 맞게 해당 private 검사만 제거하고, 정확한 직전 `source_fence_expired_input` intent가 있을 때 한 번 교정하는 것을 승인했다. 07:58:55에 intent **12178**과 실제 미저장을 `audit-recovery-result`의 정확한 실패 사유로 기록했다. 교정 도구는 source hash/source revision/campaign/model/policy/listed/item/정상 job lease 검사를 유지하고 이전 응답을 재사용하지 않는다.

07:59:04 승인된 교정 실행은 **skipped/locked**였다. 새 모델 호출·판정 저장·교정 intent가 모두 0이고 attempts 3/timeout 기록 3개는 그대로다. root의 “guard 실패·다른 입력·lock이면 반복 호출 없이 종료” 지시에 따라 교정 도구를 다시 실행하지 않았다. 그 시각 campaign 4는 실제 저장 판정 **52개/거절 13개**, terminal failed **3개**였다. 이 고정 항목을 회복 성공으로 계산하지 않는다. 허가된 id 외 소진 항목에는 임의로 회복을 적용하지 않는다.

## 실행 명령

비밀을 읽어 출력하지 않는 전용 private 도구를 작성하고 실행했다. 기존 baseline/frozen-work 파일을 덮어쓰지 않았다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-initial
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-inspect
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-start
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-requeue
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-progress1
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-measure
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-measure-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-measure2-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-measure4-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-measure-pending4-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-progress2
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-recover-one-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-recover-one-diagnose
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-recovery-annotate
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-recover-correction-reviewer.py
npm test -- tests/product-audit-job.test.ts tests/manual-job-budget.test.ts tests/worker-runtime.test.ts tests/role-worker.test.ts tests/worker-supervisor.test.ts tests/agent-review-gateway.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55447/nomorevibe_test npm run test:integration -- tests/integration/product-audit.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55447/nomorevibe_test npm run test:integration -- tests/integration/job-runner.test.ts
npx tsc --noEmit
npx eslint lib/crawl/jobs/product-audit.ts scripts/worker.ts scripts/run-job.ts tests/product-audit-job.test.ts tests/manual-job-budget.test.ts tests/worker-runtime.test.ts tests/integration/product-audit.test.ts
git diff --check
```

`run.py`의 기본 crawler 컨텍스트에는 gateway key가 없어 첫 catalog/진단은 `models=null`, `not_configured`였다. reviewer 컨텍스트로 실행한 뒤 실제 지원 목록·응답을 확인했다. 첫 실패를 모델 장애나 운영 reviewer 실패로 해석하지 않았다.

다음 관측은 새로운 progress 파일 이름으로 수행한다. **start/requeue 및 회복/교정 명령은 재관측용으로 다시 실행하지 않는다.** 교정이 locked로 종료됐으므로 추가 실행은 위 제한을 따른다. 신규 테스트 실행과 배포 이후 관측은 위 상태를 따른다. root가 통합 커밋·배포하므로 이 에이전트는 커밋하지 않았다.

## 배포 전 임시 유예와 재개

옛 24초 runtime에서 terminal이 계속 늘어 root가 배포 전 다음 정상 회차만 잠시 유예하도록 승인했다. 08:01:05와 08:02:05에는 lease가 활성이라 idle CAS를 충족하지 못했고 쓰기 0이었다. **08:04:29 KST**에는 lease/lock이 없고 requested=processed=36849, runs=36850인 유휴 상태를 재검증해 **`not_before`만 DB now()+30분, 08:34:29.293 KST로 설정**했다. 같은 트랜잭션에 표준 `adminAuditRow`로 이전 상태와 이유를 기록했다. operations audit **12180**이다. cursor, attempts, campaign, lease와 실행 중 작업은 바꾸지 않았다.

08:06:20 읽기 전용 관측에서 runs=36850, idle pending requested36850/processed36849, 위 not_before가 유지됐다. campaign 4의 실제 저장 판정은 **62개/거절16개**, timeout 시도34개, terminal5개, 미답43956개였다. 구판 거절1207개 중 새 판정은 approve3/reject8/미답1196이다. 감사 전체 완료나 fixed item 회복 성공이 아니다.

| old24초 terminal item | 제품 | 실제 기록 | 각 응답 제한 |
| --- | --- | --- | --- |
| 33063 | apps-by-tim-wu-haotian | timeout 3개/attempts3 | 23.797~23.910초 |
| 33074 | super-dev | timeout 3개/attempts3 | 23.851~23.908초 |
| 33096 | styleseed | timeout 3개/attempts3 | 23.889~23.895초 |
| 33110 | quantstrategylab | timeout 3개/attempts3 | 23.881~23.894초 |
| 33116 | alkemio-safe-smart-spaces-for-collective-action | timeout 3개/attempts3 | 23.876~23.886초 |

공식 `recordAuditResult`는 새 정상 결과를 append하고 attempts3→4를 유지할 수 있지만, 정상 pending selector는 소진 항목을 고르지 않는다. 따라서 배포 뒤 cohort를 다시 읽고 현재 원본 hash/source revision/campaign/model/policy/listed/item 상태를 검사한 뒤, 별도로 승인된 고정 항목만 정상 `runJob` lease와 source CAS를 거쳐 **새 응답**을 추가하는 경로를 사용해야 한다. 구시도 초기화나 구응답 재사용은 하지 않는다. 지금 승인된 교정은 locked로 종료했으므로 새 지시 없이 반복하지 않는다. 이 phase 이후 추가 LLM 호출을 중단했다.

실제 실행한 유예·관측 명령:

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-defer
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-defer2
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-defer3
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-progress3
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-progress4
```

아래 재개 helper는 작성했으며 **아직 실행하지 않았다**. 실제 배포 뒤 runtime의 `jobRunOptions('product-audit', {}).budgetMs === 70000`, audit12180의 정확한 marker, 유휴 상태와 version/runs CAS를 검사한다. 일치할 때만 not_before를 원래 null로 복구하고, pending 요청이 이미 있으면 보존하며 없을 때만 표준 `requestJob(tx)`를 1회 실행한다. 같은 트랜잭션에 `job-temporary-resume` 기록을 남긴다. 배포 전이면 쓰기 없이 `deployed_deadline_not_verified`로 종료한다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-resume
```

### 배포 대기 중 유예 1회 연장

08:28에도 reviewer-m3는 내부24초/외부 예산 특례 없음이었다. 첫 연장 시도는 **쓰기0**으로 종료했다. DB marker `23:34:29.293086` UTC를 JS Date/audit JSON이 `.293`으로 표현해 **86μs**를 잃었고, UPDATE의 정확한 timestamp CAS가 실패한 것이 원인이었다. 읽기 전용 확인에서 lease/lock은 없고 버전·실행 수는 그대로이며, DB marker는 audit12180의 `created_at +30분`과 정확히 일치했다.

DB 원시 timestamp text와 기존 감사 기록의 정확한 시간 관계를 검사하도록 private 도구를 교정한 뒤 **08:30:01에 유예를 1회 연장**했다. 새 감사 기록은 **12181**, 최신 만료는 **2026-10-15 09:04:29.293086 KST**다. runs **36850**, requested **36850**, processed **36849**를 전후 그대로 보존했다. pending 요청·cursor·attempt·history·campaign·lease를 바꾸지 않았으며 쓰기는 not_before/updated_at뿐이다. 08:31:09 읽기 전용 검사에서 최신 raw marker, audit12181의 marker, audit12180의 `created_at +60분`, 이전 marker 체인이 모두 일치했다.

위 기존 resume 명령의 helper도 최신 extension marker를 따라가고 원시 timestamp 정밀도를 보존하도록 갱신했다. 배포된 내부 **65초**와 외부 **70초**, 감사 체인, idle/version/runs/exact timestamp CAS를 모두 검사한다. syntax 검사는 실행해 통과했지만 **실제 resume는 아직 실행하지 않았다**. 이전 helper는 private `published-audit-20261015-resume-before-extension.mjs`로 보존했다. 추가 운영 변경은 보류했다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-defer-extend1-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-defer-precision
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-defer-extend-corrected-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-defer-extension-verify
```

## 출처·저장소 증거 변경의 독립 읽기 전용 검토

root의 요청으로 다른 담당자의 `collect.ts`, `repository.ts`, 새 `source-demand.ts`, `admin.ts`, `worker-progress-query.ts`와 관련 검사를 읽기 전용으로 검토했다. 해당 코드는 직접 수정하지 않았다. review 스킬의 SKILL.md를 읽었으나 참조된 `review/checklist.md`는 알려진 skills 경로를 검색해도 없었다. 외부 스킬 setup·업그레이드 없이 승인된 코드 검토를 진행했다.

- 404 복구는 fresh public metadata의 같은 immutable GitHub ID와 유효한 default-branch head를 확인한 뒤에만 접근 불가 commit/comparison을 큐에서 빼고 제한 coverage를 저장한다. 새 head의 관측만 현재 결과에 넣고 구관측은 이전 immutable 행에 남긴다. private/다른ID/rate-limit/auth/transport에서는 큐와 retry deadline을 보존한다. 이름 재사용의 새ID는 새 스캔으로 분리된다.
- 현재 수요 CTE는 seeded/verified와 visible link만 사용하고 LEFT JOIN으로 미생성 source도 포함한다. hidden/orphan/banned/unverified 이력은 제외하며 canonical URL 교체는 구 URL의 state/error/success를 승계하지 않는다. 미생성 canonical source는 기존 worker due selector와 같이 별도 합산하지 않고 visible repository link의 첫 작업으로 생성되는 기존 경로를 따른다.
- 운영 DB에 동일 공유 CTE만 read-only transaction/`jit=off`/`statement_timeout=3s`로 실행한 **08:07:35 KST** 실측은 **335ms**, targets86832/due50850/stale96/failed1844/oldest69.081h였다. 이는 배포된 새 admin 함수 실행 결과라는 뜻은 아니다. worker-progress의 3초/read-only 경계는 유지된다. admin summary는 기존 pool budget을 사용하고 별도 3초 SET LOCAL은 없지만 이번 실측에서 시간 문제는 발생하지 않았다.
- **재현된 검토 사항:** 같은 SHA의 이전 complete에 새 제한 coverage가 합쳐지면 기존 완료 시각을 보존하는 것은 맞다. 그러나 그 시각이 24시간 안일 때 `createReviewInput`/judge/UI가 `coverage.limited`와 제한 cursor를 보지 않아 현재 불확실성을 `complete`로 전달할 수 있다. 실제 pure Node 재현에서 관측이 빈 limited scan의 summary는 `ai_evidence_not_found`, scanState는 `complete`였고 coverage만 바꿀 경우 inputHash/sourceRevisionHash도 같았다. 저장된 과거 완료·관측을 유지하되 현재 coverage를 partial/unknown으로 전달하거나 적어도 접근 불가 범위를 부재 판정으로 읽지 않게 할 P2 경계로 root에게 전달했다. 수정은 다음 담당자에게 남겼다.

실제 실행 결과는 단위 **35개**, 별도 localhost55447 통합 **24개** 모두 통과다. fixture DB 이외 운영 데이터는 이 검토에서 변경하지 않았다.

```sh
npm test -- tests/agent-evidence-collect.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55447/nomorevibe_test npm run test:integration -- tests/integration/agent-evidence-cursor-recovery.test.ts tests/integration/evidence-admin.test.ts
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/run.py published-audit-20261015-source-demand-review
```

root가 `docs/CODEX_HANDOFF.md`, 통합 full checks, 커밋과 배포를 맡는다. 다음 담당자는 위 resume를 실제 배포 확인 뒤 실행하고, 새 progress 이름으로 저장 성공/partial/terminal/사람 대기를 다시 구분해야 한다. 별도 테스트 컨테이너 `nomorevibe-product-audit-pgvector-test-db-20261015`는 이 종료 시점에 유지했다. 기존 baseline/frozen-work와 사용자 산출물은 보존했다.

## reviewer 배포 후 실제 재개와 고정 timeout 5개 회복

08:48:14에는 배포가 아직 대기 중이어서 승인된 유예를 1회 더 연장했다. audit **12182**, 만료 **09:34:29.293086 KST**였으며, root12180→12181→12182의 DB 원시 timestamp 체인과 runs36850/request36850/processed36849를 보존했다. 이때는 문서 변경이 허용되지 않아 운영 증거만 root에게 전달했다.

reviewer 두 대의 새 배포 후 root가 기존 `run.py ...resume`를 실행했지만 기본 대상이 아직 옛 runtime인 **crawler-m3**여서 `deployed_deadline_not_verified`/budget null/tick24000, **쓰기0**이었다. guard를 낮추지 않고, 같은 resume.mjs를 명시적으로 **reviewer-m3**에서 실행하는 mode600 wrapper를 별도로 만들었다. 기존 실패 JSON은 덮어쓰지 않았다.

**09:08:49 KST** 명시 wrapper 실행에서 실제 내부65000/외부70000과 감사 체인을 확인하고 재개했다. 표준 감사 기록은 **12183**이다. not_before를 null로 복구했고 runs36850/request36850/processed36849와 이미 pending인 요청을 보존했다. 추가 request는 필요하지 않았다. 이로써 위의 “resume 미실행”은 당시 상태이며, 현재는 실제 재개가 완료됐다.

root는 배포 뒤 고정 old24초 terminal **33063/33074/33096/33110/33116**만 각각 새 모델 호출 1회로 회복하도록 추가 승인했다. 모두 현재 원본을 새로 조회하고, campaign/current prompt·rules/model/설정/제품 공개 상태/미판정 item/정상 job lease를 검사했다. 저장 직전에는 candidate/document/settings/저장소 identity/최신 scan·관측의 정상 잠금 안에서 inputHash/sourceRevisionHash/source를 재계산해 대조하고 공식 `recordAuditResult`를 호출했다. 공개분 감사 계약에 없는 신규 발행용 validUntil 조건은 넣지 않았다. 이전 07:56의 미저장 응답도 재사용하지 않았다.

09:11:59 첫 실행은 정기 감사 job과 겹쳐 **locked**, 모델0/intent0/저장0이었다. 읽기 전용으로 유휴를 확인한 뒤 미실행 항목만 진행했다. 모델 동시성은 현재4 이내로 유지하고, 별도 트랜잭션을 쓰는 공식 writer와 source 잠금 구간만 직렬화해 reviewer 기본 DB pool3의 중첩 트랜잭션 대기를 예방했다. 09:14:00에 네 개를 저장했고, full60초 호출 여유가 없는 마지막33116은 모델0/intent0으로 남겼다가 다음 유휴 실행에서만 한 번 처리했다. 앞의 네 개는 DB의 회복 intent로 제외해 재호출하지 않았다.

| item | 새 판정 | 모델 응답 | intent → 저장 감사 기록 | 보존된 이력 |
| --- | --- | --- | --- | --- |
| 33063 | approve/.97 | 20.113초 | 12185 → 12191 | timeout3 + success1, attempts4 |
| 33074 | approve/.96 | 16.306초 | 12188 → 12189 | timeout3 + success1, attempts4 |
| 33096 | approve/.96 | 23.549초 | 12186 → 12192 | timeout3 + success1, attempts4 |
| 33110 | approve/.86 | 18.674초 | 12187 → 12190 | timeout3 + success1, attempts4 |
| 33116 | reject/.96 | 7.552초 | 12193 → 12194 | timeout3 + success1, attempts4 |

**09:14:34에 고정5개 모두 실제 저장 완료**다. 이번 cohort의 새 모델 호출은 총5회이며 구시도·기록·시각을 초기화하거나 덮지 않았다. 다섯 제품의 humanDecision은 null이며, 제품 공개 상태나 사람의 유지·삭제 결정은 변경하지 않았다. reject 판정33116도 자동으로 내리지 않았다.

09:15:10 읽기 전용 확인에서 campaign4는 실제 판정 **90개/거절23개/terminal0/skip1**, not_before null, 정상 job 실행 중/오류 없음이었다. 재개 이후 저장 성공28/실패0이었다. 09:15:35 추가 지연 측정은 저장 성공 **29개/실패0**, 그중 **24초를 넘은 정상 저장2개**, 최대 **26.23328초**였다. 이는 새 deadline이 운영에서 24초 이후의 답도 저장한 직접 증거다. 전체44,018개 감사의 완료를 뜻하지 않는다. 고정 cohort 회복 뒤 추가 수동 모델 호출은 중단하고 정기 처리에 맡겼다.

실제 실행 명령과 독립 proof 파일은 아래와 같다. wrapper의 JSON은 각각 별도 이름으로 mode600 저장했고 baseline/frozen-work를 보존했다.

```sh
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-resume-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-cohort-preflight-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-cohort-recover-reviewer.py 1
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-cohort-idle-watch-reviewer.py 1
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-cohort-idle-watch-reviewer.py 2
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-cohort-recover-reviewer.py 2
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-cohort-idle-watch-reviewer.py 3
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-cohort-recover-reviewer.py 3
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-post-recovery-reviewer.py
python3 /Users/jr/.config/nomorevibe/backlog-recovery/2026-10-14/published-audit-20261015-post-recovery-latency-reviewer.py
```

이 phase에서 코어 코드와 다른 문서는 수정하지 않았고 추가 tests를 실행했다고 주장하지 않는다. root가 handoff·통합 문서의 재개 명령을 명시 reviewer wrapper로 고친다. **resume나 회복 명령은 관측 목적으로 다시 실행하지 않는다.** 후속 관측이 필요하면 새 이름의 읽기 전용 proof를 만든다.
