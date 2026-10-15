# PR02 — 개별 item lease와 stage mode 비활성 기반

승인된 [전체 설계 5절](../specs/2026-10-15-pipeline-two-times-design.md)과 [PR02 로드맵](2026-10-15-pipeline-pr-roadmap.md)을 구현한다.
기본 `legacy`를 유지하고 기존 worker/handler·provider·발행 경로는 연결하지 않는다. PR01b-6 baseline과 PR03/04 writer 통합을 완료하기 전 새 소비자 활성화는 금지한다.

## 공통 계약

1. additive 테이블 두 개를 추가한다. `pipeline_stage_modes`는 `fetch|ai1|ai2`, mode `legacy|draining|items`, `draining_from`, 독립 stage epoch, 통합 계약 버전(기본0), updated_at을 가진다. `pipeline_item_leases`는 고유 `(stage,work_key)`, binding/hash, owner instance/boot, 무작위 token, stage epoch, 매 획득 증가하는 item epoch, lease_until을 가진다. migration은 세 stage 모두 legacy/계약0으로 만든다.
2. 엄격한 stage별 binding에서 work key를 만든다. fetch는 frontier identity와 기존 claim CAS, AI1은 candidate·input/source/policy·prompt/rules·실제 모델, AI2는 vote·candidate·first generation·slot/fallback·실제 모델을 바인딩한다. fetch에 가짜 review hash를 채우지 않는다.
3. 저장소는 개별 소유권만 증명한다. 현재 입력·사람 결정·정책·필수 모델 독립성은 PR03/04의 기존 domain repository가 같은 transaction에서 검증한다. item writer는 명시적 필수 lease를 받으며 optional legacy fallback을 두지 않는다.
4. 잠금은 stage `FOR SHARE`→기존 domain 순서→item→jobs/outbox다. 전환은 stage `FOR UPDATE`를 먼저 얻고 domain을 역으로 재잠그지 않는다. `KEY SHARE`는 mode 변경을 막지 못하므로 쓰지 않는다. 모든 expiry/CAS 판정은 필요한 잠금 획득 뒤 DB wall clock을 사용한다.
5. 새 claim은 items+통합 계약 버전이 준비된 stage에서만 가능하다. 살아 있는 타 instance/boot의 lease는 job token·role 교체와 무관하게 보존한다. 만료 뒤 재할당은 새 token/item epoch를 발급한다. 구 owner의 renew·release·성공·실패·handoff는 모두 거절한다.
6. `legacy/items→draining`은 신규 claim만 막고 stage epoch를 유지한다. items에서 들어온 draining은 기존 owner의 renew·완료를 허용한다. 정상 전환 완료는 live item이 없고 해당 writer 계약이 준비됐을 때 epoch를 증가시킨다. 강제 token fence를 외부 호출 종료 증거로 취급하지 않는다.
7. PR02의 runtime API는 통합 계약 버전을 변경하지 않고 운영 CLI/env 전환 경로를 추가하지 않는다. 기본 계약0에서 nonlegacy 활성화·item claim을 거절한다. 테스트 DB owner가 통합된 fixture를 명시적으로 준비해 상태 머신을 검증한다. 실제 legacy claim과 writer까지 mode를 연결하는 일은 PR03/04이며, 이 column만으로 legacy drain이 입증됐다고 주장하지 않는다.
8. domain 결과·item 완료·다음 요청은 같은 transaction에서 처리할 수 있어야 한다. producer의 기존 `requestJob`·cursor·operator pause를 변경하거나 지우지 않는다. 네트워크/LLM 대기 중 transaction을 유지하지 않는다.

## 병렬 소유권

2026-10-15 실행 계약: work key는 hash가 아니라 stage별 frontier/candidate/second-review의 안정된 ID다. 입력 binding이 바뀌었다는 이유로 살아 있는 같은 작업의 owner를 우회하지 않는다. binding은 strict schema에서 검증하고 hash를 계산한다. `lockItemStage(tx, stage)`는 같은 transaction에만 유효한 stage guard를 반환한다. 이후 caller가 domain을 잠그고 `claimItemLease(tx, guard, binding, owner, ttlMs)`, `assertItemLease`, `renewItemLease`, `releaseItemLease`를 호출한다. assert/release의 stale token은 예외로 전체 결과·handoff를 rollback하며 renew/claim은 획득 실패를 null로 반환한다. 정확한 export 이름은 담당 사이에 한 번 고정하고 root에 보고한다.

아직 item row가 없을 때 unique INSERT가 기다리지 않도록 item 잠금 단계에서 namespace `1485804`의 `pg_try_advisory_xact_lock`을 먼저 사용하고, 그 뒤 `FOR UPDATE SKIP LOCKED`로 row를 잠근다. hash 충돌은 보수적인 skip만 만들고 소유권을 부여하지 않는다. 여러 domain/item을 한 transaction에서 무순서로 반복 claim하는 API는 추가하지 않는다. 전환 API는 `beginStageDrain`과 `completeStageTransition`이며 통합 계약0을 runtime에서 올리는 경로, 강제 fence, 운영 전환 CLI는 이번 PR에 없다.

| 담당 | 단독 수정 범위 |
| --- | --- |
| schema/types | operations-schema, 신규 additive SQL/journal, items/types, binding 단위 테스트 |
| repository | items/repository의 짧은 transaction API, stage/lease 잠금·CAS·원자 handoff |
| 실제 DB 검증 | 신규 item-leases integration, 두 연결·선점 barrier·rollback·기존 role/job 비간섭 회귀 |
| root | API 확정·담당 충돌 관리·전체 코드/교차 리뷰·통합/문서/Git/CI |

실제 담당은 `pr01_final_ai1`(schema/types), `pr01_final_ai2`(repository 및 별도 repository 회귀), `provider_contract_evidence`(독립 integration)다. 격리 DB는 각각 불필요/55466/55467을 사용하며 root의 최종 전체 검증 DB는 별도로 만든다.

schema/journal는 한 담당만 수정한다. repository와 integration은 고정 계약을 먼저 합의한 뒤 작성하고, 각 담당 DB port를 분리한다. PR01b-5 작업 tree와 섞지 않는다.

## 실행 순서

- [x] 최신 main과 PR01b-5 병합 상태 확인 후 이 branch base를 맞추고 migration 번호를 확정한다. PR434→main d95c6c8, 0077 배정, fast-forward 충돌0.
- [x] 기존 frontier CAS·AI1/AI2 identity와 대조해 binding 및 repository API를 고정한다.
- [x] 실제 claim/save/전환 결함을 드러내는 RED부터 작성한다. import·미설치·fixture 오류는 behavioral RED로 세지 않는다. 타입 assertion RED 및 migration 적용 뒤 실행 가능한 repository stub의 미구현 실패를 두 전용 DB에서 확인했다. 동시성 경계 검증은 GREEN/canary에서 별도 확인한다.
- [x] additive schema/types와 repository를 파일별 병렬 구현한다.
- [x] 두 연결 단일 승자·SKIP LOCKED·foreign owner 유지·만료 재할당·늦은 모든 쓰기 거절을 검증한다.
- [x] claim/drain 선후관계·잠금 대기 중 만료·drain renew/완료·epoch fence·결과/요청 rollback을 검증한다.
- [x] 계약0 활성화 금지·기존 role takeover와 job 요청/cursor/pause 보존을 확인한다.
- [x] 담당 종료 보고→root 직접/교차 리뷰→전체 필수 검증→최신 base CI→PR435 정상 병합·main CI/image SUCCESS 확인.

## 완료와 복구 경계

PR02 schema/types/repository와 새 단위6·DB33 회귀 구현은 완료했다. 최종 전체 integration162파일/1,778PASS/기존TODO1과 root 필수 로컬 검증을 완료했다. PR435로 정상 병합하고 최신 base PR CI38756321978·main CI38757351403의 image까지 SUCCESS를 확인했으며 실제 결과는 [검증 기록](../../operations/2026-10-15-pipeline-pr02-item-leases-validation.md)에 남긴다.
성공해도 PR03/04의 domain fencing, PR05 공통 모델 슬롯, PR06 독립 소비자·2배 성능, Oracle/DR 완료를 주장하지 않는다.
repository는 active caller transaction과 PostgreSQL17 잠금 context를 검사한다. 최초 열린 child-owned stage mutex·종료 transaction·item→control 승격은 거절한다. 부모가 이미 가진 동일/강한 mutex는 유지하며 native adapter가 이전 child savepoint를 열어 둔 경우는 보수적으로 거절한다. PG/Drizzle 버전 변경 때 이 경계를 재검증한다.

복구는 신규 claim 중단→drain→token/epoch fence→legacy다. additive 테이블과 실패·handoff 이력을 보존하며 DROP으로 운영 복구하지 않는다.
