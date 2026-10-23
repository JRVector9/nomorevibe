# PR-01 작업별 근거·출력 계약과 오프라인 평가를 고정한다

상태: **설계 완료 · 구현 전** · 제안 브랜치: `feat/qwen-first-contracts-evaluation` · 설계 기준: `c37ae82f`

선행 PR: 없음. 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

## 문제와 결과

공통 합성 스모크의 질문과 실제 운영 질문이 다르고, 모델별 실제 thinking/schema/문맥 상한도 다르다.

업무별 evidence/prompt/schema/policy 버전과 오프라인 평가를 정의한다. 운영 Qwen v2/shot1을 여기서 즉시 교체하지 않는다.

## 수정 범위

- max_tokens를 입력·출력·이미지·추론을 포함한 C로 간주하지 않는다. GPU와 M1은 자원은 별도지만 같은 Qwen family이므로 독립 표가 아니다.
- PR01이 backend serving 계약·버전·상한 정의를 소유하고 PR02가 실제 HTTP adapter·native binding·종료 장부 구현을 소유한다.
- backend별 endpoint·물리 group·기반 model family·정확한 responseModel·실효 thinking/schema/vision·배포 revision·총 token 상한 C와 단순 max_tokens를 구분한다. 공통 규약을 기존 abcllm 계약으로 위장하지 않는다.

## 포함하지 않는 변경

- 없음.

## 파일과 데이터 변경

기존 파일:

- [lib/crawl/agent-review-contract.ts](../../../lib/crawl/agent-review-contract.ts)
- [lib/crawl/review-model-identity.ts](../../../lib/crawl/review-model-identity.ts)
- [lib/crawl/qwen-direct-review.ts](../../../lib/crawl/qwen-direct-review.ts)
- [lib/crawl/deepseek-review.ts](../../../lib/crawl/deepseek-review.ts)
- [lib/screen-review/vision-review.ts](../../../lib/screen-review/vision-review.ts)
- [lib/domain/products/intro-check.ts](../../../lib/domain/products/intro-check.ts)

신규 제안 파일:

- `lib/llm/local-model-serving-contract.ts` (신규 제안 경로, 구현 시 확정)
- `lib/domain/llm-assist/contracts.ts` (신규 제안 경로, 구현 시 확정)
- `tests/llm-assist-contract.test.ts` (신규 제안 경로, 구현 시 확정)
- `scripts/evaluate-llm-assist.ts` (신규 제안 경로, 구현 시 확정)

Migration: 없음 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- 같은 입력의 hash와 출력 schema/근거 ID·단위 검사가 재현되는지 확인한다.
- unknown backend·잘못된 responseModel·입력 상한 초과·vision/schema 미지원 조합이 닫히는지 확인한다.
- 모델만/프롬프트만/근거만 바꾸는 비교와 개발에 쓰지 않은 holdout을 구분한다.
- 출력 참조의 원문 인용 일치와 의미 정확도를 별도로 평가하며 가격 분모·부정문·기권을 단순 substring 점수로 대체하지 않는다.

완료 조건:

- 기존 운영 wire·판정 기준을 바꾸지 않고 계약·평가 산출물이 고정되어 후속 PR이 사용할 수 있다.

## 적용 전 확인

- 없음.

## 중단과 되돌림

- 새 평가·계약을 비활성으로 두면 기존 운영 경로와 판정은 그대로다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.
