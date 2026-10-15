# PR01b 실제 모델 replay — 착수 전 확인

2026-10-15, PR01a [#429](https://github.com/JRVector9/nomorevibe/pull/429) 이후의 구현 경계다.
두 서브에이전트가 기존 코드·설계를 병렬로 읽고 부모가 통합했다. 이 문서는 조사 결과이며,
PR01b 전체·실모델 실행이 완료됐다는 뜻이 아니다. 최초 조사 뒤 격리 DB·시계·fixture 호출 장부를 구현했으며, [실제 검증 기록](2026-10-15-pipeline-pr01b-validation.md)에 현재 범위와 남은 작업을 구분한다.

## 현재 확인한 사실

- 기존 설정 모델은 AI1 `[MLX] gpt-oss-120b`, AI2 `[supa] Qwen3.8-27B-NVFP4`다.
  속도를 위해 다른 모델·낮은 품질 기준으로 바꾸지 않는다.
- `lib/crawl/agent-review-gateway.ts`는 `max_tokens:3000`, raw context, thinking 비활성 요청을 보낸다.
  저장소에는 tokenizer/chat-template/schema overhead, 추론 토큰 포함 여부, serving revision,
  숨은 서버 재시도와 원격 취소를 보증하는 계약이 없다. 출력 요청 상한만으로 전체 토큰 상한을 인증하지 않는다.
- 부모는 인증된 읽기 전용 API로 `/openapi.json`과 `/api/v1/models`를 확인했다. 두 이름 모두
  `backend:vllm`로 보고됐다. 모델 이름의 MLX/supa 접두사가 실제 backend 보증은 아니다.
  OpenAPI에는 별도 tokenize/capability 경로가 없고 completion 요청은 상세 토큰 계약이 없는 schema다.
  metadata용 `/api/v1/models/show`는 두 이름 모두502였다. 이 응답을 추론 실패나 모델 고장으로 해석하지 않는다.
  `/v1/models`는 각각 `context_length:8192`, `32768`을 보고했다. 이는 관측된 metadata이며,
  전체 토큰 강제 상한·추론 포함 범위·내부 retry 수까지 검증한 증거로 승격하지 않는다.
  이 조사에서 chat completion/모델 추론·pull/preload/설정 변경은 실행하지 않았다.
- Claude의 두 턴·출력 환경변수·달러 cap도 전체 토큰/실제 HTTP 수 보증이 아니다.
  Grok adapter에는 입증된 출력 토큰 cap이 없고 usage parser의 reasoning 토큰 누락도 별도 확인이 필요하다.

## 기존 코드에 연결할 지점

| 경계 | 기존 함수·파일 | 필요한 변경 |
| --- | --- | --- |
| 실행 | `lib/jobs/runner.ts`의 `runJob`, `lib/crawl/jobs/agent-review.ts`의 `reviewCrawlCandidates`, `lib/crawl/jobs/second-review.ts`의 `secondReviewCandidates` | 기존 handler만 격리 실행. 전체 worker·publisher는 시작하지 않음. 별도 심사 엔진을 만들지 않음. |
| 입력 | `agent-review-contract.ts`의 `createReviewInput` | 이미 now 인자를 받음. 원문·정책·모델·기준 시각을 고정하고 hash 검증. |
| 시계 | `agent-review-repository.ts`의 `loadReviewInput/currentReviewInput/reviewCandidatePredicate`, `second-review-input.ts`의 입력·matching | 신선도 semantic clock만 고정. 실제 lease/backoff/deadline/경과 시간은 real clock 유지. 전역 Date mocking 금지. |
| 숨은 I/O | `lib/crawl/jobs/review-document.ts`의 `loadReviewDocument` | 현재 버전 README sample을 미리 고정하고 GitHub 원문 fallback fetch를 거절. |
| 외부 호출 | `agent-review-gateway.ts`의 정확한 POST 직전 | 검증된 제공자 상한으로 먼저 영속 예약 commit. 요청 digest·모델·세대 결합. redirect/암묵 retry 금지. 외부 대기 중 DB transaction 유지 금지. |
| 최종 결과 | `agent-review-repository.ts`의 `recordAgentReview`, `second-review.ts`의 `recordSecondReview` | 실제 결과와 같은 transaction에서 장부 기록. 현재 actor/applied attempt/input/policy와 `secondReviewApprovalPredicate` 재사용. |

기존 writer는 singleton DB를 쓰고 다음 job을 요청한다. 명시적으로 격리된 connection/recorder와
실행되지 않는 downstream outbox 경계 없이 replay에서 직접 부르지 않는다.
loopback URL만으로 DB의 실제 정체를 보증할 수 없으므로 사전에 만든 DB/role identity와 제한 권한을
연결 readback으로 확인해야 한다. 기대 identity를 artifact가 스스로 선언하게 하지 않는다.

## 최소 장부와 상태 전이

별도 범용 framework 없이 run-local recorder/repository와 네 종류의 기록을 둔다.
운영 스키마 migration에 자동 포함시키지 않고 격리 설치·권한 경계를 먼저 검증한다.

- `capacity_runs`: immutable manifest/hash/revision·정책/모델·기준 시각·초기 상태/cache·실제 시작/deadline,
  owner boot/fence, 상태, 누적 예약 call/token, event high-water와 seal digest.
- `capacity_inputs`: run/candidate/input/source의 고정 identity, evidence bytes와 digest,
  stratum·명시 reReview·준비 offset. 중복 공급을 막는 composite unique.
- `capacity_calls`: 고유 예약 ID, run/input/attempt/stage/AI2 root/retry, provider/model/request digest,
  검증된 input/output 상한, dispatch 상태·시각, terminal receipt와 nullable 실제 usage.
- `capacity_transitions`: append-only run 순서의 ready/claim/backoff/hold/final 전이.
  실제 writer transaction에 결합하고 필수 AI2 vote/root 등 최종 근거를 보존.

Run은 `prepared → running → draining → sealed`다. deadline/종료 요청·미상 usage·불명 dispatch는
새 admission을 닫는다. sealed run을 재개하지 않는다.
Call은 `reserved → dispatching → in_flight → settled`, 불명 종료는 `indeterminate`다.
run 행을 잠근 짧은 transaction에서 **외부 호출 전에 call1과 입증된 토큰 최댓값 전체를 차감**한다.
첫 구현에서는 보내지 않은 예약도 환불하지 않는다. 모든 retry/fallback은 새 예약이다.

dispatching commit과 실제 전송 사이 crash는 구별할 수 없으므로 자동 재전송하지 않는다.
timeout·자식 종료·lease 만료·HTTP 응답 유실이 원격 inference 종료 증거는 아니다.
불명 호출은 권위 있는 request-bound 제공자 증거가 없으면 정상 seal과 겹치는 새 replay를 막는다.
admission 종료·writer fencing·모든 호출 정산·구간 coverage·binding 검증 후 seal한다.
digest는 신뢰된 runner/DB 안의 일관성 증거이며, JSON hash 자체가 출처를 인증하지 않는다.
기존 v1 snapshot을 verified로 승격하지 않고 별도 ledger artifact를 둔다.

## 구현 전 RED와 합격 조건

1. AI1/AI2 마지막 슬롯 동시 경합에서 호출·토큰 초과0. 예약 commit 실패 시 transport0.
2. 전송 전/후 crash, timeout, missing usage, fallback에서 예약을 돌려주지 않음.
3. 상한 계약 없음, 모델/정책/입력/cache/기준 시각 변경, redirect·README fetch는 호출 전에 거절.
4. 필수 AI2 일부 표·중복 writer 호출·복사 reuse·사람 판단은 신규 final을 늘리지 않음.
   결과 transaction rollback이면 final event도0. 사람/입력 변경은 기존 gate가 보호.
5. real time이 흘러도 고정 입력 hash는 유지하고 lease/backoff는 실제 시간에 따라 작동.
6. readiness는 실제 선택/준비/보류/재개 전이에서 유도. 양수 periodic sample만으로 coverage를 인증하지 않음.
   restart gap, 대기 고갈,30분 미달은 성능 미판정. 품질 합격은 별도 gate.

격리 DB/시계/제공자 계약을 입증하기 전 실제 replay는 계속 거절한다.
장부 존재만으로 원래 PR01을 완료하거나 PR02 소비자를 활성화하지 않는다.
다음 구현 담당자는 roadmap·PR01a validation·이 조사에서 상세 코드 계획을 만든 뒤 회귀부터 실행한다.


## 2026-10-15 후속 검증

동일 AI1의 `/api/v1/models` catalog는32768, 반복 `/v1/models`는32768→8192를 보고했다.
AI2는32768이었다. 추천 prompt 길이는 각각16384/24576이다. 이 값은 강제 total-token 상한이 아니다.
listing created가 읽기 시각에 따라 바뀌며 실제 serving revision은 확인하지 못했다.
OpenAPI는 max_tokens/max_completion_tokens를 nullable integer로 선언할 뿐 강제 상한·reasoning 포함 범위·
retry/fallback/취소 계약을 선언하지 않는다. 관리 metadata GET은401이며 더 접근하거나 설정을 바꾸지 않았다.
GET 진단만으로 모델의 정상/비정상 추론 품질을 단정하지 않는다. 실모델 요청은0회다.

구현된 fixture 장부는 실제 provider 모드를 `unsupported_provider_budget`으로 계속 거절한다.
서버가 보장하는 전체 context 상한 C와 최대 upstream attempts가 입증된다면 C×attempts를 미리 예약하는
보수적 방식이 가능하다. 정확한 serving deployment/model과 무단 clipping 거절에 결합되어야 한다.
manifest boolean이나 context metadata를 capability 인증으로 받지 않는다.

로컬 gateway 소스를 찾은 후 확인한 retry·추정 usage·routing 한계는 [후속 source audit](2026-10-15-pipeline-pr01b-provider-audit.md)에 별도로 기록했다. 실제 배포 identity는 여전히 미확인이다.
