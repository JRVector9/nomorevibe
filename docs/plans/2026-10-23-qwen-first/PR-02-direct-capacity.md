# PR-02 기존 직접 호출을 공통 모델 슬롯과 종료 장부에 연결한다

상태: **구현 및 격리 회귀 완료 · 운영 global readiness 미확인** · 브랜치: `feat/qwen-first-direct-capacity` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

## 문제와 결과

Qwen secondary slot은 reviewer 프로세스 메모리이며 screen은 별도 lane이다. 새 text/maintenance 호출을 더하면 전역 한도가 보장되지 않는다. 현재 DB CHECK도 abcllm/CLI typed binding만 받는다.

기존 audit/candidate/screen의 direct 호출부터 기존 capacity 상태기와 원격 종료 증명에 연결한다. 새 assist work binding은 04에서 추가하여 의존 순환을 피한다.

## 수정 범위

- 기존 audit/candidate/screen의 실제 잠긴 행·job/role lease·owner/boot/input revision으로 domain proof를 만든다. 단순 schema 모양 검증은 실행 권한이 아니다.
- direct와 abcllm을 통해 동일 GPU로 전달되는 route는 같은 physical group에 넣는다. 모든 미계량 입구를 연결하기 전에는 전체 물리 cap 완료로 보고하지 않는다.
- terminal은 원래 adapter만 발급하는 한 번 쓰는 불투명 증인이다. 모델·배포 revision·응답 종료 근거가 실제 서버 계약과 맞아야 한다.
- JSON이 잘못되어도 원격 추론 종료가 입증되면 물리 호출은 정산할 수 있지만 업무 판정은 적용하지 않는다. JSON이 맞아도 원격 종료가 불명확하면 점유를 유지한다.
- local abort·socket EOF·SSH 종료·job/role lease 만료를 provider 종료로 보지 않는다. indeterminate와 기존 PR15 hard deadline/client_bound 회수 규칙을 재사용한다. 증명되지 않은 endpoint는 readiness=false다.
- GPU 동시6은 설정 상한이며 측정 처리량이 아니다. 이 PR에서 동시성을 확대하지 않는다. M1을 쓰는 모든 모델 route는 합계1을 목표로 한다.
- global control의 disabled/draining/open 의미를 바꾸지 않는다. disabled에서 새 local 작업이 무계량 direct fallback을 실행하지 않게 readiness를 닫는다. 전역 open 준비는 실제 활성 caller 전체의 typed 계약·dispatch 경로·종료 처리·alias/group inventory로 판정한다.

## 포함하지 않는 변경

- 없음.

## 파일과 데이터 변경

기존 파일:

- [lib/llm/capacity.ts](../../../lib/llm/capacity.ts)
- [lib/llm/capacity-repository.ts](../../../lib/llm/capacity-repository.ts)
- [lib/llm/gateway-local-end.ts](../../../lib/llm/gateway-local-end.ts)
- [lib/llm/gateway-local-end-fetch.ts](../../../lib/llm/gateway-local-end-fetch.ts)
- [lib/llm/capacity-unsettled.ts](../../../lib/llm/capacity-unsettled.ts)
- [lib/db/operations-schema.ts](../../../lib/db/operations-schema.ts)
- [lib/operations/dr/reclaim.ts](../../../lib/operations/dr/reclaim.ts)
- [lib/crawl/qwen-direct-review.ts](../../../lib/crawl/qwen-direct-review.ts)
- [lib/crawl/deepseek-review.ts](../../../lib/crawl/deepseek-review.ts)
- [lib/crawl/qwen-endpoint-backoff.ts](../../../lib/crawl/qwen-endpoint-backoff.ts)
- [lib/crawl/jobs/product-audit.ts](../../../lib/crawl/jobs/product-audit.ts)
- [lib/crawl/audit-second-opinion-auto.ts](../../../lib/crawl/audit-second-opinion-auto.ts)
- [lib/crawl/gate-split-tiebreak.ts](../../../lib/crawl/gate-split-tiebreak.ts)
- [lib/crawl/held-qwen-retry.ts](../../../lib/crawl/held-qwen-retry.ts)
- [lib/crawl/jobs/human-review.ts](../../../lib/crawl/jobs/human-review.ts)
- [lib/crawl/gate-split-confirm.ts](../../../lib/crawl/gate-split-confirm.ts)
- [lib/screen-review/job.ts](../../../lib/screen-review/job.ts)

신규 제안 파일:

- `lib/llm/local-model-adapter.ts` (신규 제안 경로, 구현 시 확정)
- `lib/llm/local-model-capacity.ts` (신규 제안 경로, 구현 시 확정)
- `lib/llm/local-model-terminal.ts` (신규 제안 경로, 구현 시 확정)
- `tests/local-model-terminal.test.ts` (신규 제안 경로, 구현 시 확정)
- `tests/integration/local-model-capacity.test.ts` (신규 제안 경로, 구현 시 확정)
- `drizzle/<next>_local_model_capacity_terminal.sql` (신규 제안 경로, 구현 시 확정)

Migration: dispatch_binding/terminal_evidence/logical CHECK에 정확한 direct 분기와 필요한 고유 인덱스를 추가한다. 기존 분기를 보존하고 schema/DDL 일치를 확인한다. 새 capacity 테이블은 만들지 않는다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- 격리 PostgreSQL과 별도 프로세스로 reviewer/text/maintenance 경합 시 같은 physical group의 상한을 넘지 않는지 확인한다.
- 기존 abcllm/CLI binding·terminal 양성 검사를 보존하고 위조·재전송·잘못된 owner/model/도메인 attempt 충돌을 거절한다.
- 가짜 원격 서버가 생성을 계속하는 동안 client abort/반쪽 응답이 나면 점유가 indeterminate로 남고 새 호출이 한도를 우회하지 못하는지 검증한다.
- localEnd만으로 회수 불가, 유효한 원격 종료 증거로만 회수 가능함을 확인한다. DB 커밋 응답 분실·draining·재시작에서도 중복 dispatch가 없어야 한다.
- 기존 soft failure 3회와 짧아진 tick timeout 구분을 회귀 확인한다.
- global open 전환 회귀에서 기존 번역·검색·CLI 등의 정상 작업이 unmapped/provider_contract_unavailable로 멈추지 않음을 확인한다. 미연결 입구가 남으면 운영 활성화 불가이며 필요한 caller 연결을 별도 후속 범위로 드러낸다.

완료 조건:

- 기존 직접 호출 목록과 실제 연결이 일치하고, 포함된 endpoint에는 미계량 우회가 없다. 종료 계약이 미검증이면 비활성·미확인으로 남긴다.
- direct 및 gateway 경유의 실제 동일 GPU 호출이 동일 물리 group에 들어가고 누락 caller가 없어야 한다. 이 조건 전에는 전역 제한 완료·운영 open 준비로 표시하지 않는다.

## 적용 전 확인

- 없음.

## 중단과 되돌림

- 신규 admission을 중단하고 draining한다. dispatched/indeterminate는 증거로 정산할 때까지 보존한다. 옛 직접 경로 복귀는 새 호출 완전 drain 뒤에만 허용한다.

## 권장 내부 커밋 경계

- typed direct 계약·binding과 additive DDL
- native 호출·불투명 종료 증인·localEnd/unknown 연결
- 기존 direct caller의 domain coordinator 연결
- 실제 다중 프로세스 경합·abort·재시작·정산 회귀

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.

실제 연결한 8개 목적, 0118 DDL, 단위 103개와 격리 DB/HTTP 검증, 첫 fixture 실패 및 수정, 아직 globalReady=false인 이유는
[구현 검증 기록](../../operations/2026-10-23-local-model-capacity-validation.md)에 남겼다. 실제 모델 처리량이나 운영 readback을 검증한 것으로 해석하지 않는다.
