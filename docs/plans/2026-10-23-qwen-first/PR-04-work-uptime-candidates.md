# PR-04 보강 작업 큐와 uptime 후보 생산의 첫 경로를 연결한다

상태: **구현 완료 · scoped 검증 통과 · PR-05 실호출 통합 검증 중** · 제안 브랜치: `feat/qwen-first-work-uptime-candidates` · 설계 기준: `c37ae82f`

선행 PR: [PR-01](PR-01-contracts-evaluation.md), [PR-02](PR-02-direct-capacity.md). 이 번호는 설계 순번이며 GitHub PR 번호가 아니다.

03은 M1 route 활성화에만 필요하며 GPU 구현의 선행 조건은 아니다.

## 문제와 결과

장시간 재접속·LLM을 uptime25초/repo50초 tick 안에서 처리할 수 없고 needs_editor는 근거·모델 변경만으로 재진입하지 않는다. 큐만 만드는 기반 PR보다 첫 생산자와 함께 검증할 필요가 있다.

작은 도메인 work/result 기록과 첫 uptime 후보 생산자를 두 자동 내림 경로에 연결한다. 기본 off, shadow에서 관측만 생성하며 실제 비동기 gate·적용은05가 맡는다.

## 수정 범위

- work에는 kind·명확한 대상 참조·source revision/hash·bounded 증거 snapshot 또는 참조/hash·policy/prompt/schema 버전·상태·nextAttemptAt·기존 job/role owner 참조·CAS revision을 둔다.
- result에는 work revision·기반 모델 및 backend/quantization/adapter identity·input/wire/response hash·검증된 상태/이유/근거 ID·model_capacity request 참조를 둔다. 물리 호출 attempt는 기존 ledger를 쓰며 새로 중복 구현하지 않는다.
- 첫 구현에서는 uptime kind만 생산·소비 가능하게 열고 repo/intro/audit/news는 각 업무 PR에서 정확한 typed payload와 domain fence를 추가한다. 임의 JSON 작업 플랫폼은 만들지 않는다.
- 같은 kind/subject는 모델이나 source를 바꿔도 중복 적용되지 않는다. 이전 dispatched/indeterminate를 새 work ID로 우회하지 못하며 새 revision 결과는 최종 CAS로만 적용한다.
- waiting_evidence/waiting_capacity/retryable_transport/human/done/obsolete를 구분한다. work lease 만료는 모델 점유 해제가 아니다.
- off/shadow/confirm를 구분한다. 04 shadow 후보 생산만으로 잘못된 내림이 방지됐다고 보고하지 않는다. 05 confirm 이후 rollback은 자동 적용 중단·후보 보존이며 pending을 옛 즉시 내림으로 되돌리지 않는다.
- 공통 보강 큐에 taskkind=uptime의 후보를 기록하는 단일 entry를 두 호출 경로에 연결한다.
- 제품id·URL·제품 갱신시각·health.checked_at·정책/프롬프트 버전의 입력 지문으로 중복·구식 후보를 구분한다.
- 생산자는 짧은 후보 저장만 하고 재접속·화면·LLM을 기다리지 않는다. queued/skipped/applied를 boolean 자동내림 건수와 구분한다.
- 동일 health observation revision의 완료·대기 후보를 backlog selector에서 제외하고, 새 관측/근거 revision 또는 명시 재처리 때만 재진입시킨다. unique work만 두고 selector가 매 틱 같은 제품을 고르는 현상을 막는다.
- DB의 원시 updatedAt::text/checked_at 등 세대 정밀도를 보존한다. JS millisecond 시각만으로 CAS를 비교하지 않는다.
- off는 현재 경로 그대로, shadow는 적용권 없는 후보 관측만, confirm은05가 구현하고 승인된 뒤 내림 전 비동기 gate를 적용하는 모드다. confirm 이후 dispatch/apply 중단은 legacy 모드로 자동 복귀하지 않는다.
- 공통 큐는 제품 보강의 작은 typed domain queue다. 기존 pipeline_item_leases의 fetch/ai1/ai2 stage를 확대하거나 범용 workflow engine을 새로 만들지 않는다.
- work에 원 업무(originJob/task와 실제 producer control 참조)를 기록하고 공통 소비자는 claim 및 dispatch 확정 때 해당 업무의 pause/control revision을 확인한다. producer만 멈추고 이미 queued인 같은 업무가 계속 새로 dispatch되는 경로를 허용하지 않는다. 이미 원격 실행 중인 호출만 기존 drain 계약으로 마무리한다.

## 포함하지 않는 변경

- 모델 추론·재접속 consumer
- 새 역할/lane 추가
- 401·403·429·999 제외, 실패횟수, 광역 실패 보호, 관리자 해제 보호 완화

## 파일과 데이터 변경

기존 파일:

- [lib/jobs/control.ts](../../../lib/jobs/control.ts)
- [lib/jobs/runner.ts](../../../lib/jobs/runner.ts)
- [lib/jobs/background-consumer.ts](../../../lib/jobs/background-consumer.ts)
- [lib/domain/products/uptime-auto-ban.ts](../../../lib/domain/products/uptime-auto-ban.ts)
- [lib/jobs/products/uptime.ts](../../../lib/jobs/products/uptime.ts)
- [lib/domain/products/uptime-apply.ts](../../../lib/domain/products/uptime-apply.ts)
- [lib/db/schema.ts](../../../lib/db/schema.ts)
- [lib/llm/capacity.ts](../../../lib/llm/capacity.ts)
- [lib/llm/capacity-repository.ts](../../../lib/llm/capacity-repository.ts)
- [lib/db/operations-schema.ts](../../../lib/db/operations-schema.ts)
- [lib/domain/products/uptime-negative-gate.ts](../../../lib/domain/products/uptime-negative-gate.ts)
- [lib/db/product-uptime-schema.ts](../../../lib/db/product-uptime-schema.ts)

신규 제안 파일:

- `lib/db/llm-assist-schema.ts` (신규 제안 경로, 구현 시 확정)
- `lib/domain/llm-assist/work.ts` (신규 제안 경로, 구현 시 확정)
- `lib/domain/llm-assist/repository.ts` (신규 제안 경로, 구현 시 확정)
- `tests/llm-assist-work.test.ts` (신규 제안 경로, 구현 시 확정)
- `tests/integration/llm-assist-work.test.ts` (신규 제안 경로, 구현 시 확정)
- `tests/integration/uptime-assist-candidate.test.ts` (신규 제안 경로, 구현 시 확정)
- `drizzle/<next>_llm_assist_work.sql` (신규 제안 경로, 구현 시 확정)

Migration: additive work/result 표·제한된 kind/상태·고유 인덱스와 02의 assist work binding 분기를 추가한다. 번호는 최신 main에서 구현 시 예약한다. 실제 번호는 구현 시 최신 main의 journal을 확인해 배정한다.

## 검증과 완료 조건

다음은 실행 결과가 아닌 구현 시 검증 항목이다. PR별로 관련 회귀·정적 검사만 수행하고 GitHub 필수 CI를 유지한다.

- 격리 PostgreSQL의 동시 claim에서 subject별 한 처리자만 성공한다. source 변경·사람 수정·lease 상실 후 옛 결과는 적용되지 않는다.
- legacy uptime.ts와 split uptime-apply.ts가 동일 후보 gate를 거치고 기본 off에서 기존 실행·재시도·401/403/429/999·관리자 해제 보호가 유지된다.
- 같은 입력/판/모델 결과는 재사용하고 허용된 증거·버전 변화에만 재진입한다. unclear에 빈 근거로 모델을 반복 호출하지 않는다.
- 새 테이블 제약·옛 제품/intro/news 행 불변·writer 권한·원격 미종료 시 슬롯 유지가 실제 DB에서 확인된다.
- legacy·claims의 신규 실패와 기존 backlog sweep 모두 같은 후보 등록 경계를 통과한다.
- 25초 예산을 유지하고 모델 호출이 생산자·DB 트랜잭션에 없다.
- 동일 후보 중복등록·URL교체·관리자해제·lease상실이 안전하게 처리된다.
- tests/integration/uptime-auto-ban.test.ts
- tests/integration/uptime.test.ts
- tests/integration/uptime-split-apply.test.ts
- tests/integration/uptime-split-job.test.ts
- tests/uptime-gate.test.ts
- 신규: 후보중복·입력세대교체·lease상실·양쪽경로동일분기
- 임계값 실패 제품이 alive/unclear·대기 상태가 된 뒤 동일 observation으로 재선택·큐 상단 독점을 하지 않고 다른 제품이 진행되는 실제 DB 회귀
- 같은 millisecond 안의 서로 다른 DB microsecond 제품/health revision, URL 변경·관리자 수정·양쪽 producer 경합에서 stale 결과 불적용
- 원 업무 pause 뒤 그 업무의 queued work가 claim/dispatch되지 않고, 다른 업무는 진행하며, resume 뒤 중복 없이 이어지는 회귀. 공통 소비자 전체 pause와 원 업무별 pause를 각각 검증한다.

완료 조건:

- 첫 uptime 후보가 두 경로에서 중복 없이 만들어지고 이후 비동기 판정이 필요한 상태로 보존된다. 기본 off/shadow이며 제품 상태 자동 변경과 model 호출은05 이전에 활성화하지 않는다.

## 적용 전 확인

- 실제 실패 후보를 읽기전용으로 추출해 후보 건수·중복·생산자시간·기존건수의미를 shadow 비교한다. 실행허용은05 consumer와등록검증완료후승인한다.

## 중단과 되돌림

- 새 후보 생산·소비를 중단하고 work/result·기존 모델 점유를 보존한다. additive 표는 바로 삭제하지 않으며 과거 후보를 일괄 차단하지 않는다.

공통 정책·실데이터 평가·운영 전환 조건은 [전체 계획](README.md)을 따른다. PR 병합을 운영 쓰기·배포·기능 활성화 승인으로 간주하지 않는다.

## 개발 검증 기록 (2026-10-23)

격리 PostgreSQL(127.0.0.1:55571)에 0119 SQL을 직접 적용하고 신규 큐 4건·기존 uptime 54건, 총 58건을 통과했다. ESLint, Next typegen 후 전체 TypeScript 검사도 통과했다. PR-02의 0118 뒤 journal 등록과 최종 통합 재검증은 남아 있다. 기본값은 off이며 운영 DB 변경·배포·모델 호출은 하지 않았다.

0118 다음 journal 등록 및 0119 전체 신규 migration 실행을 확인했다. native assist target/binding과 같은 트랜잭션의 request ID 연결을 포함하며, raw 원본 지문·원 업무/소비자 pause·owner/lease를 dispatch 직전에 재검증한다. 장비·작업 ID·revision이 달라도 동일 업무 fence를 유지한다. 결과별 input snapshot 컬럼을 포함한다. 최종 scoped DB 58건, binding 단위 5건, ESLint·typegen·tsc가 통과했다. 초기 테스트 DB 별칭은 전용 DB 이름 가드로 거절됐고, 가드를 바꾸지 않고 격리 컨테이너 안의 DB 이름을 맞춰 재실행했다.
