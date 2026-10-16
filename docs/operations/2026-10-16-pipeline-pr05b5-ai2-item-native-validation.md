# PR05b5 AI2 소비자의 모델 예약·호출·정산 검증

이 변경은 독립 AI2 소비자에 고정 모델 용량 예약, 실제 항목 claim과 원자 dispatch, native 호출, 물리 완료 정산, 기존 결과 writer를 연결한다. 운영 serving resolver는 계속 null이며 운영 활성화나 처리량 2배 달성은 아직 검증하지 않았다.

## 구현과 보호 경계

- `capacity.ts`/`capacity-repository.ts`: 실제 후보와 primary vote를 논리 키로 묶는다. 같은 체인의 waiting/reserved/dispatched/indeterminate 요청은 새 boot나 fallback으로 우회하지 못한다. 과거 체인 식별이 없는 미정산 2차 호출도 새 호출을 막는다.
- `0085_model_capacity_ai2_terminal.sql`/schema/journal: strict JSON binding과 terminal CHECK, 물리 claim 중복 방지 index를 추가한다. 0084 원문과 기존 AI1 분기·권한·append-only ALWAYS trigger는 보존한다.
- Native gateway: 원 input/wire/model/serving contract/C를 private prepared 객체에 묶고, 실제 native POST 한 번만 허용한다. 고정 parser가 확인한 완료만 opaque terminal을 발급한다. EOF·취소·잘못된 완료는 full-C 미정산으로 남긴다.
- Runtime: control UPDATE→request UPDATE→S3/domain→실제 item→최종 예약·항목 DB wall 검사를 같은 TX에 둔다. commit 확인 뒤 호출하고, 호출·정산·진행 중 renewal을 기다린 뒤 기존 business writer를 사용한다. 물리 완료는 현재 사람 판단과 분리해 정산한다.
- 새 양성 경로는 consumer purpose에만 연결한다. 기존 direct item compatibility·legacy·검증된 replay 경계를 보존한다. 기존 회귀 파일 688행은 HEAD와 바이트 동일하게 유지하고 새 통합 8개는 `second-review-item-model-capacity.test.ts`에 둔다.

## 실제 실행한 범위

| 범위 | 실행 결과 | 한계 |
| --- | --- | --- |
| Ledger pure/기존 관련 회귀 | 4파일 58 PASS, tests423ms | repository/native verifier mock |
| Native | 21 PASS, tests69ms/전체685ms | localhost, 실 provider 호출 없음 |
| Runtime unit | 원17+직렬화 회귀1=18 PASS | renewal은 fake timer 검증 |
| Ledger 실제 PG17 | 서로 다른 6개 사례 모두 PASS, 1+1+4 분리 실행 | generic item adapter, 실제 AI2 업무 writer는 runtime 별도 |
| Runtime 실제 PG17 | 서로 다른 8개 사례 모두 PASS, 1+1+6 분리 실행 | 원격 provider·실제15초 renewal 장기 관측 없음 |
| 기존 direct compatibility | 원형 한 사례 Assertion RED→한 조건 수정→같은 사례 PASS | 기존16 전체 실행으로 확대하지 않음 |
| 변경 범위 TypeScript/ESLint | 담당 agent가 실제 exit0 확인 | 수동 전체 tsc/build/test 미실행 |

Root는 ledger 전용55567에서 독립 READ ONLY REPEATABLE READ로 baseline=agent=root 91표96행, migration86개 hash, captured DDL/권한/함수/trigger/default 및 타 연결0을 확인했다. event sequence37·queue13의 정상 증가를 보존했고 reset하지 않았다. 컨테이너는 정상 STOP/exited0/OOMfalse 후 해당 own volume과 함께 제거했다.

Runtime 전용55568도 root가 독립 READ ONLY REPEATABLE READ로 raw91표96행/defaults/journal86 및 agent와 동일한 sequence9 정상 증가·타연결0을 확인한 뒤 정상 정리했다. 전체 catalog 일치는 false다. 첫 comparator 실패를 보존했으며 root 시점9관계의 pages/tuples와 pipeline_item_leases.relfrozenxid753→957 외 captured 정의·권한·roles 등은 동일했다. 그 physical 변화 원인은 직접 관측하지 않았다. `/tmp/nomorevibe-pr05b5-a-root-independent-final-proof-20261016.json` 및 `...a-root-db-cleanup...json`을 따른다. 운영 DB·운영 migration·SSH·실 provider·consumer 활성화는 실행하지 않았다.

## 발견한 문제와 수정

1. Ledger raw BIGINT가 string인 것을 ORM number와 비교한 fixture 두 곳을 고쳤다. 최초 실패와 잔류를 보존하고 정확한 own 행 CAS 복구 뒤 해당 첫 사례만 다시 확인했다. 첫 복구의 Result 배열 prototype guard 실패는 DML 이전이며 별도로 보존했다.
2. Ledger 독립 vote 양성 fixture가 기존 활성 예약을 둔 채 policyHash를 바꾸는 문제를 고쳤다. 같은 정책과 실제 busy 예약 두 개를 사용하며 기존 policy fence와 기대 assertion을 유지한다.
3. Runtime strict parse가 input JSON 키 순서를 재조립해 private full-input identity가 달라졌다. 실제 Assertion RED 직렬화 회귀를 추가하고 검증한 clone의 원 input 순서를 보존해 같은 회귀를 통과시켰다. 최초 native 양성은 fetch 이전 mismatch throw이며 원 server counter는 보존되지 않았다. 수정 후 실제 양성은 POST1과 정산·writer assertions를 통과했다.
4. 새 runtime 통합 파일이 기존 688행을 덮은 coverage 문제를 root가 최종 diff에서 발견했다. 기존 원본을 복원하고 새 468행을 바이트 그대로 별도 파일로 옮겼다. 검토에서 놓친 사실도 기록한다.
5. 새 예약 intent가 direct compatibility까지 확장되는 문제를 기존 원형 실제 사례로 재현했다. consumer purpose 조건 하나만 추가해 같은 사례를 통과시켰다. 원 기대를 완화하지 않았다.

## 원 증거와 남은 확인

- 최종 manifest: `/tmp/nomorevibe-pr05b5-{a-runtime-final-shas,b-native-final-hashes,c-ledger-final-shas}-20261016.json`.
- Root ledger 독립 확인과 정상 정리: `/tmp/nomorevibe-pr05b5-c-root-independent-proof-20261016.json`, `...c-root-db-cleanup...json`.
- 원본 회귀 복원: `/tmp/nomorevibe-pr05b5-root-actual-test-separation-20261016.json`.
- 독립 리뷰: B ledger/runtime 및 최소fix·recovery, C native/compatibility 보고서. Root가 해당 원문과 소스 diff를 직접 읽었다. Coverage와 compatibility 두 문제는 후속 리뷰에서 추가 발견해 수정했다.

실 provider serving identity·hard-C enforcement·원격 종료, 실제15초 renewal 장기 동작, 전 caller/text 연결, 검증된 replay의 새 native 지원, 실제30분 같은 품질2배·서버 전체 예산·Oracle 운영/DR는 남는다. 수동 전체 테스트는 모든 PR 개발이 끝난 뒤 실행한다. CI는 shard1에서 새 native 실제 파일→AI2 소비자→AI1 소비자를 먼저 실행하고 shared3에서 이 세 파일만 제외한다. 설치 Vitest filesOnly 목록과 실제 BaseSequencer로 205파일=3+68/67/67, 모든 기존 파일과 새 파일이 정확히 한 번 포함됨을 확인했다. 원 workflow inverse와 source15+parent12 및 기존688 SHA도 동일하다. 첫 목록 checker에서 기존473 text 파일을 예상 목록에서 빠뜨린 실패는 보존하고 고정 목록·원SHA 검사만 고쳤다. 파일 발견과 checker만 실행했으며 테스트 본문/DB는 실행하지 않았다. `/tmp/nomorevibe-pr05b5-root-ci-coverage-20261016.json`. 필수 새 head CI의 결과는 별도로 확인한다.
