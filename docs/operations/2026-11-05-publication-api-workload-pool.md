# 발행 분류의 API 작업 분산

`publish-classify`의 `workload_pool`만 AI 연결의 API 모델을 사용한다. 대체 실행(`fallback`)은 기존 ConnectAgent의 Claude/Codex CLI 설정을 그대로 사용한다. API를 대체 순위로 저장하는 요청은 `ai_task_publish_api_pool_only`로 거절하고, 발행 분류의 분산 구성원으로 CLI를 저장하는 요청도 거절한다. OpenCode 발행 분류를 지원한다고 표시하지 않는다.

분산 구성원은 최대 4개다. `jobs.crawl-publish.classifierConcurrency`(기본 1, 범위 1~4)는 별개의 분류 묶음 동시 실행 수다. 한 묶음은 기존과 같이 최대 10개 후보이며 동일 입력을 여러 모델에 보내지 않는다. 기존 용량 정책·물리 장비 한도가 실제 호출을 허용하므로 구성원 수가 호출 수나 처리량 배수를 보장하지 않는다.

## 실행 경계

- `publication-classify-pool.ts`는 실제 구성원의 연결·모델에 해당하는 직접 serving 계약을 기존 `bindApiTaskRank`로 묶는다. 모델명만으로 서버를 고르거나 계약 행의 다른 연결 키를 대신 보내지 않는다.
- 기존 `chooseTaskWorkloadMember`는 선택 힌트만 낸다. 같은 주인의 정확한 waiting/reserved identity가 있으면 우선 복원한다. 슬롯 요청과 dispatch는 기존 control·정책·member fence 아래에서 별도로 승인한다.
- `publication-classify-capacity.ts`의 기존 publisher lease, batch admission, stages, 후보·문서·설정·수동 결정·tagline snapshot, 심사 승인, job wall-time 검사를 CLI와 API가 공유한다. capacity lock 접두는 domain lock보다 먼저이며 HTTP는 열린 TX 밖에서만 실행한다.
- 새 `publication_classify_gateway` binding은 실제 pool `configRevision`/`memberId`, 모든 후보 source hash, 입력/분류 정의 hash, 실제 전송 wire/serving 계약 hash, 원 publisher/job 권한과 C를 보존한다. CLI binding/정산은 바꾸지 않는다.
- 원본 프로세스의 WeakMap terminal 또는 요청 0이 증명된 기존 gateway D5 증인만 정산한다. 응답 단절·불확정은 기존 indeterminate 경로로 남기며 같은 틱에서 다시 전송하지 않는다. 다음 틱의 재접수는 기존 capacity-states 규칙을 따른다. 기존 사람 검토 완료는 같은 요청/주인에 대한 기존 operator-review 검사를 유지한다.
- 시작한 모든 독립 분류 묶음이 종료/정산된 후 기존 발행 루프가 후보별로 순서대로 처리한다. 공개/반려 CAS·중복 제품 방지·OG 복사·인덱스 후처리·재검수 요청의 조건이나 순서는 바꾸지 않는다. 미뤄진 묶음은 해당 틱에서 다시 고르지 않으며 완료 건수를 늘리지 않는다.

## 후처리 연결

이미 구현된 API 분산 작업은 `crawl-tagline`, `reason-translate`, `product-translate`, `product-tagline-ko`, `product-search-profile`, `product-search-verify`, `search-query-translate`다. 기존 TextTaskRanks, 작업별 동시성/묶음 크기, continuation/claim/writer를 재사용하며 이번 변경에서 새 호출 루프를 추가하지 않는다. `product-embedding`, `search-embedding`, `search-rerank`는 연결별 벡터/점수 공간의 동일성 계약이 없어 capability를 열지 않는다.

## 0166 이전

새 typed binding/terminal 검증 함수 2개와 ledger rule 5개(members/logical/dispatch/request-terminal/event-terminal)를 추가한다. 기존 rule의 문자열·ordinal과 기존 CHECK 분기는 유지한다. `generate-publication-api-sql.ts`는 기존 CLI 검증 중 publication source/job/role/handle 검증을 재사용해 생성하며 CLI transport 부분만 별개의 API wire/contract 검증으로 바꾼다. Drizzle journal은 0165 다음 0166으로 증가한다.

운영 이전은 일반 앱 배포와 별도다. 공식 DRAINING 및 reserved/dispatched=0 확인 후 적용한다. `model_capacity_check_rules`에 SHARE ROW EXCLUSIVE 잠금, 5초 lock timeout이 있으며 기존 두 guard 함수 재생성 권한이 필요하다. ledger 전체 표를 재작성하거나 스캔하지 않는다. 사전 baseline 0160 행 수와 새 source 부재, 사후 새 source 각 1개와 정확 predicate hash를 검사해 drift/중복을 거절한다. 새 테이블/계정/GRANT·모델 배정·용량 변경·운영 pool 활성화는 없다.

검증: 사용자 지시에 따라 새 테스트·수동 기능 검사·모델 호출·운영 접근을 하지 않았다. 정적 검사와 필수 CI는 통합 단계에서 수행한다.
