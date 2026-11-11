# PR4: 전용 검수·감사·화면·분류 경로의 작업 분산 경계

## 이번 PR의 실제 범위

소스 기준은 PR1 `106d8e37`이며, 공통 미지원 사유 함수는 PR5
`5f717844`를 기반으로 한다. 운영 상태를 조회하거나 모델을 호출한 결과가 아니다.

**PR4의 14개 전용 작업에는 새 작업 분산 런타임을 구현하지 않았다.**
공통 설정에 이름만 추가해 지원한다고 표시하지 않는다. 이번 변경은 기존
`aiTaskWorkloadPoolUnsupportedReason`의 일반 문구를 실제 실행 계약별 사유로
구체화하고, 후속 어댑터의 최소 경계를 기록한다. 지원 목록, 저장 검증,
후보 선정·claim·호출·결과 쓰기, 기존 단계 풀, 용량 정책은 바꾸지 않는다.
필수 CI도 유지한다.

전체 작업 정의 27개 중 PR4는 아래 14개를 다룬다. 1·2차 검수와 text 7개는
PR1/2/3 범위이며, 임베딩 2개·rerank·Grok 세션은 PR5 범위다.
이 숫자는 작업 정의 수이며 동시 호출 수가 아니다.

## 공통 설정과 기존 단계 풀은 다른 실행 계약이다

[admin-model-pools.ts](../../lib/llm/admin-model-pools.ts)의
`withStoredAdminStagePools`는 기존 설정과 배정표를 읽고 **job lease당 하나의
ModelRegistry 선택**을 고정한다. `withAdminModelStage`는 공유 어댑터의 purpose를
그 선택에 연결한다. 이는 `ai_task_execution_configs`의 새 작업 분산 설정을
읽거나, 독립 업무마다 빈 장비를 선택하는 런타임이 아니다. 기존의 8개까지
등록부 키를 받는 단계 풀을 새 최대 4개 연결 구성원과 동일시하지 않는다.

[model-registry.ts](../../lib/llm/model-registry.ts)의 등록부 모델에는 실제
provider·baseUrl·model·purpose·시간/토큰 한도가 있다. 새 `ai_connections` 모델
등록이나 `/models` 목록 확인만으로 이 등록부 선택과 전용 자격증명이 자동으로
연결되지는 않는다. 예를 들어 DeepSeek 위임은 기존 keyless 요청이고, assist는
backend별 전용 키를 읽는다. 연결의 키를 무시하거나 임의 env로 옮기는 방식으로
새 연결을 지원했다고 표시하지 않는다.

[local-model-capacity.ts](../../lib/llm/local-model-capacity.ts)는 실제 wire의
endpoint/model과 검증된 `local-openai-chat-v1` 계약을 맞춘다.
`verifiedLocalModelContract`는 DB readback 계약을 우선하고, env 경로도 검증 hash가
일치해야 한다. `localModelRouteReady`는 기존 route/provider/model/backend/physical
그룹과 물리 상한을 확인한다. 입력 크기·출력 한도·vision·JSON schema·thinking
검증 후 기존 native admission/dispatch/terminal 정산을 수행한다.

[admin-ai-tasks.ts](../../lib/operations/admin-ai-tasks.ts)의 `local-direct`
readiness는 이 기존 정책 경로와 로컬 계약이 정확히 있어야 열리며, 새 예산이나
로컬 계약을 추정해 만들지 않는다. 따라서 일반 API catalog가 성공했다는 이유로
이 경로를 pool capability 목록에 넣을 수 없다.

## 작업별 실제 경로와 후속 최소 경계

| 작업 | 실제 실행 소스와 현재 고정점 | 새 분산을 열기 전에 필요한 최소 연결 |
| --- | --- | --- |
| `human-review` | [jobs/human-review.ts](../../lib/crawl/jobs/human-review.ts) → [human-review-repository.ts](../../lib/crawl/human-review-repository.ts) → [deepseek-review.ts](../../lib/crawl/deepseek-review.ts). claim에 모델·actor·입력 세대가 들어가고 승인 재검사도 기존 단계 풀의 모델 소속을 확인한다. | claim 전에 검증된 연결을 고정하고 claim/결과/승인 유효성 검사의 동일 모델 집합을 함께 이관해야 한다. 현재 DeepSeek slot과 틱당 최대 2건·기존 시도 한도도 유지한다. |
| `split-confirm` | [gate-split-confirm.ts](../../lib/crawl/gate-split-confirm.ts)의 단계 scope → claim → DeepSeek slot → local capacity → `deepseekModel` 결과. 후보·tiebreak·generation을 다시 검사한다. | claim부터 확인 기록까지 같은 선택과 입력 세대를 보존하는 어댑터가 필요하다. 승인/거절 문턱과 선행 갈림 결과를 변경하지 않는다. |
| `split-tiebreak` | [gate-split-tiebreak.ts](../../lib/crawl/gate-split-tiebreak.ts). 대상 및 claim은 `config.model`에 연결되고 이전 1·2차 심사와 같은 모델을 제외한다. 거절에는 별도 확인 단계가 있다. | 대상 선정 전에 선택하고 독립 모델 제외·claim 모델·후속 확인의 일관성을 함께 연결해야 한다. 풀 구성원을 새 투표자로 추가하지 않는다. |
| `held-review-retry` | [held-qwen-retry.ts](../../lib/crawl/held-qwen-retry.ts). `heldQwenCandidates(settings, model, ...)`와 `claimHeldQwen(..., model)`이 모델·입력 세대별 시도를 구분한다. | 선정·claim 전에 선택하고 모델별 기존 재시도/재적용 이력과 최종 source/generation 검사를 보존해야 한다. |
| `audit-review` | [jobs/audit-qwen.ts](../../lib/crawl/jobs/audit-qwen.ts). 캠페인의 현재 reviewer/model로 env를 고정하고, 도중 reviewer 변경 시 새 호출을 중단한다. 기존 bounded worker들이 독립 항목을 처리한다. | 캠페인 모델 전환 계약을 먼저 설계해야 한다. 현재 reviewer와 다른 임의 모델을 항목마다 넣으면 캠페인 불변 조건을 깨뜨리므로 단순 chooser 삽입으로 열지 않는다. |
| `audit-second-opinion` | [audit-second-opinion-auto.ts](../../lib/crawl/audit-second-opinion-auto.ts)의 단계 scope → `qwenDirectConfig` → 모델별 `auditTargets` 및 기존 의견 쓰기/자동 닫기. | 모델 선택과 대상 제외·추가 의견 identity·자동 닫기의 동일 모델 기준을 함께 연결해야 한다. 이전 심사와 같은 모델을 독립 의견으로 세면 안 된다. |
| `published-filter` | 같은 [audit-second-opinion-auto.ts](../../lib/crawl/audit-second-opinion-auto.ts)의 별도 단계 scope와 `publishedTargets(config.model, ...)`를 사용한다. | 감사 두 번째 의견과 설정은 분리하되, 모델별 중복 의견 제외·source/generation·최종 적용 관문은 그대로 유지한다. |
| `screen-review` | [screen-review/job.ts](../../lib/screen-review/job.ts) → [vision-review.ts](../../lib/screen-review/vision-review.ts). renderer 인증, URL·시간·JPEG hash, 모델/prompt별 기록 identity가 있다. local capacity가 vision 계약과 캡처 증거를 검증한다. | claim/선정 전에 실제 vision 가능한 연결과 prompt 기록 identity를 고정하고 동일 캡처 증거를 유지해야 한다. chat 모델명이나 catalog 응답만으로 vision을 지원한다고 간주하지 않는다. |
| `product-audit` | [product-audit.ts](../../lib/crawl/product-audit.ts)의 캠페인 시작에서 reviewer를 저장한다. `switchAuditReviewer`는 이유·현재 reviewer CAS·감사 로그가 있는 명시적 전환이다. [jobs/product-audit.ts](../../lib/crawl/jobs/product-audit.ts)가 이 캠페인을 실행한다. | 캠페인 단위 reviewer 및 명시적 전환을 유지하는 별도 설계가 필요하다. task pool 저장을 캠페인 전환으로 취급하거나 이미 끝난 결과를 다른 모델 결과로 바꾸지 않는다. |
| `assist-review` | [llm-assist-review.ts](../../lib/jobs/products/llm-assist-review.ts) → [config.ts](../../lib/domain/llm-assist/config.ts) → backend/family를 고정한 claim과 prepared input → native capacity. backend별 drain은 이미 `Promise.allSettled`로 병렬이며 보강·소개 수정은 같은 작업 사슬이다. | 공통 route가 없는 작업이므로 실제 backend/task route를 명시해야 한다. backend별 키·JSON schema 계약·claim token/work revision·입력 hash를 선택에 묶고 기존 drain 예산을 재사용해야 한다. |
| `assist-audit` | 같은 assist 실행의 audit lane 및 [audit-runtime.ts](../../lib/domain/llm-assist/audit-runtime.ts). 원판정과 독립 model family 조건, backend/result 계약 hash, terminal 증거를 검증한다. | 일반 assist의 경계에 더해 원판정과 다른 감사 family를 유지해야 한다. 빈 장비라는 이유로 같은 모델 family에 감사를 배정하지 않는다. |
| `product-intro-check` | [intro-check-model-capacity.ts](../../lib/domain/products/intro-check-model-capacity.ts)의 `capturedClaudeCliRun`. 1–10개 묶음 member lock과 model/input hash를 plan/prove 양쪽에서 확인하며 기존 로컬 CLI argv/stdin/parser·인증 계약을 쓴다. | 지원하는 CLI 연결의 실제 실행/인증 계약을 먼저 묶고 같은 묶음의 durable pending을 유지해야 한다. 임의 API나 원격 CLI의 도구/응답 호환성을 추정하지 않는다. |
| `publish-classify` | [publication-classify-capacity.ts](../../lib/crawl/publication-classify-capacity.ts). publisher 역할/잡 lease, payload/member/definitions hash, config generation/version 및 CLI primary/fallback가 하나의 authority로 묶인다. | 기존 분류 CLI/transport·설정 세대·발행 권한을 함께 고정하는 어댑터가 필요하다. pool을 기존 fallback 정책이나 발행 권한의 우회 경로로 쓰지 않는다. |
| `korean-translation-direct`(2026-11-11 없앰 — [작업 ↔ 모델 「2026-11-11」](2026-11-02-ai-task-model-ranks.md)) | [korean-tagline.ts](../../lib/jobs/products/korean-tagline.ts)의 Qwen branch는 `control.mode === "disabled"`에서 기존 스위치가 켜진 경우에만 실행된다. GPT/text7 경로와 별개이며 공통 route가 없다. | 용량 장부 밖의 legacy branch를 다중 호출로 확장하지 않는다. 별도 capped route 및 기존 번역 batch/generation/cache 계약을 먼저 연결해야 한다. 이 PR은 GPT/text7 경로도 수정하지 않는다. |

## 실제 어댑터를 추가할 때 지켜야 하는 선택 순서

1. 업무의 기존 source/generation와 재개 중인 request/claim을 먼저 확인한다.
   waiting/reserved/dispatched 등 기존 durable binding이 있다면 그 원래 연결·모델을
   유지한다. 현재 설정에서 사라졌다는 이유로 다른 모델에 같은 일을 보내지 않는다.
2. 새 독립 업무만 claim보다 앞에서 한 구성원을 선택한다. 새 config의
   connection/model/device와 **실제 전용 어댑터의** 등록부·키·검증 계약이 같아야 한다.
   idle hint는 admission 권한이 아니며 기존 domain claim과 requestSlot이 권한을 갖는다.
3. 한 번 waiting/claim/admission을 시도한 업무는 같은 호출 안에서 다른 구성원으로
   옮기지 않는다. 미뤄짐을 전파하고 다음 독립 업무에서 새 선택을 한다.
4. 모델 종료와 유효한 업무 결과 commit은 별개로 관측한다. 기존 CAS·lease·입력/정책
   hash·generation·반려/공개 조건·중복 방지·재시도 한도를 유지한다.
5. pool 구성원 UUID/revision을 관측한다. 구성원 4를 fallback 4순위나 추가 투표자로
   표기하지 않고, 모델 수만으로 물리 장비 용량이나 실제 처리량이 늘었다고 주장하지 않는다.

fetch 단계에서 model/baseUrl만 바꾸면 이미 잡은 claim, workKey/input hash,
기록된 reviewer 및 terminal/serving contract와 불일치할 수 있다. 이를 작은 변경으로
위장하지 않는다. 이미 병렬인 감사/assist drain을 새 프레임워크로 다시 만들지도 않는다.

## 화면 표시와 검증 범위

`aiTaskWorkloadPoolUnsupportedReason(taskId, slot)`는 문자열만 반환하는 기존 공통
함수다. 위 가족의 사유를 구체화하지만 capability predicate와
`AI_TASK_WORKLOAD_POOL_TASKS`는 그대로다. 기존 UI가 이 함수를 표시하므로
미연결 작업을 설정 저장만으로 실행 가능하다고 안내하지 않는다. 향후 실제 어댑터가
연결되어 지원 목록에 들어가면 함수 첫 분기의 지원 여부 검사가 우선한다.

신규 테스트·수동 기능 테스트·모델 호출·운영 조회/변경·DB migration·배포는
추가하거나 실행하지 않았다. 변경한 순수 source의 정적 lint와 diff 검토만 수행하며,
실제 검사 결과는 PR 설명에 기록한다. 런타임 분산 지원과 사용자 기능 검증이
완료됐다는 뜻이 아니다.
