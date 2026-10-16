# PR05b3 AI1 예약·검수·물리 호출 정산 검증

신규 AI1 검수가 공통 모델 용량을 기다릴 때 검수 시도나 생산자 요청을 소비하지 않도록 연결했다. 지원되는 고정 경로에서는 현재 원본·심사 정책·작업 소유권을 확인한 같은 transaction에서 검수 시도와 dispatch를 발급하고, commit 확인 뒤에만 native HTTP를 보낸다. 응답의 물리 종료 정산과 제품 판단 저장은 별도로 검증한다.

운영 serving resolver는 여전히 `null`이며 기본 용량 제어는 disabled다. 양성 검증은 명시적인 테스트 전용 loopback 계약이다. 실제 제공자 배포·전체 token 상한·운영 활성화·처리량 2배 합격을 뜻하지 않는다.

## 변경 범위와 결정

- Ledger: `lib/llm/capacity.ts`, `capacity-repository.ts`, `lib/db/operations-schema.ts`, additive `0084_model_capacity_terminal.sql`과 journal. 원 대기열·공정 배분 본문을 공유하며 AI1 후보 논리 키를 대기 INSERT부터 기록한다. 원 owner/boot/input과 현재 policy를 확인하고, 불명 호출은 TTL로 해제하지 않는다.
- Native: `agent-review-gateway.ts`, 새 `agent-review-serving-contract.ts`. 입력·실제 wire·고정 계약을 private capability에 결합한다. 실제 undici POST 1회, redirect manual, retry 0, 완전한 응답 형식과 종료 이유를 확인한 경우만 private terminal을 발급한다. JSON 복사본은 정산 권한이 없다. 기존 wire·모델·prompt·출력 한도·심사 기준은 유지한다.
- Runtime: `agent-review-repository.ts`, `jobs/agent-review.ts`, 새 `agent-review-model-capacity.ts`, `capacity-deferred.ts`. 기존 실제 reviewer role의 instance/boot, 원 job token, 동일 대기 request ID를 사용한다. 규칙·재사용·중단·replay 경로를 보존한다.
- 같은 TX 순서: capacity control UPDATE → 원 request UPDATE → stage/domain/attempt/item → 실제 job 검사 → fresh attempt/dispatch/event → 최종 job DB wall 검사. 외부 HTTP 동안 DB transaction을 유지하지 않는다.
- 유효 native terminal은 원 물리 호출을 정산한다. 이후 취소·현재 입력·작업 기한 검사가 제품 저장을 거절할 수 있다. EOF·abort·불완전 응답은 indeterminate로 남기고 재진입 POST를 막는다. 반환 실패와 정산 실패가 겹치면 두 원 객체를 함께 보존한다.

## 실행한 범위 검증

모든 수동 전체 suite/build/typegen은 사용자 지시에 따라 모든 PR 개발 뒤로 미뤘다. 아래는 변경 범위별 별도 실행 결과다. 최종 전체를 반복 실행한 것으로 합산하지 않는다.

| 범위 | 실제 결과 |
| --- | --- |
| Ledger pure 고정 11 | 새 계약 scaffold 3 Assertion FAIL + 8 controls → 동일 11 PASS |
| Durable terminal 필수 필드 | 실제 PG에서 원 predicate가 누락 finishReason을 허용하는 Assertion RED → 같은 입력을 보강 predicate가 거절하는 GREEN |
| Ledger 실제 DB 8 | 8 PASS, tests 1.34초 / total 1.93초 |
| Ledger native POST count 추가 | assertion 1줄 후 해당 1case만 PASS / 7 skip, total 1.30초 |
| Native gateway | 실행 가능한 scaffold 10 Assertion FAIL + 17 controls → 동일 27 PASS; 추가 실제 abort·await mutation control 포함 최종 29 PASS |
| Runtime original job 5 | 3 Assertion FAIL + 2 controls → 동일 5 PASS |
| Runtime coordinator | 18 PASS, 기존 agent-review-job 30 PASS는 별도 범위 실행 |
| 반환 failure + 정산 throw | 새 2 Assertion FAIL + 성공 control 1 → 동일 3 PASS; 원 failure·cleanup 객체 identity 검사 |
| Runtime 실제 첫 4 | 4 PASS, tests 916ms / total 1.56초 |
| Runtime 추가 경계 첫 실행 | expiry·EOF·abort 3 PASS, late fixture SQL 1 FAIL, tests 6.21초 / total 6.88초 |
| Late fixture 최소 수정 후 | job token 비교 4곳의 uuid cast만 text로 수정, late 1 PASS / 7 skip, tests 2.73초 / total 3.40초 |
| 정적 검사 | A/B/C 각 변경 범위 TypeScript·ESLint 실제 exit 0 |

실제 runtime 8개는 위 분리 실행으로 모두 통과했다. 첫 4개 본문·assertions, 원 unit 5개 본문·assertions, 마지막 추가 테스트 중 production 코드·시간제한 불변 conformance를 보존했다.

## 실제 DB·HTTP에서 확인한 경계

1. Production unsupported에서는 실제 role/runJob을 사용해도 request·attempt·POST·producer ACK가 없다. Disabled 기존 claim/cancellation writer는 유지한다.
2. 실제 fresh attempt와 bound dispatch가 같은 TX에서 저장된 뒤 native POST가 한 번 발생한다. 수신한 wire hash, 고정 C, 원 terminal과 settled event 및 기존 결과 writer를 확인했다.
3. 실제 후보 row lock 대기 중 사람 판단이 바뀌면 원 reservation만 취소하고 attempt·POST는 만들지 않는다.
4. 자연 reservation 만료는 worker의 실제 PG 대기와 `xact_start < reserved_until`을 확인한 뒤 DB clock 경과로 검증했다. Fresh attempt/dispatch/event는 rollback되고 producer 요청은 보존된다.
5. 실제 EOF 및 실제 runJob caller abort 각각에서 원 dispatch/C는 indeterminate로 남는다. 새 실제 tick/새 signal도 원 request를 다시 보내지 않는다.
6. 실제 POST 뒤 테스트 소유 job만 healthy 2초 headroom으로 age시키고 job row를 잠갔다. 물리 정산은 먼저 commit되고, 실제 결과 writer의 PG 대기 중 job 기한이 지난 뒤 제품 판단·outbox·producer 변경은 rollback된다. 원 aged job raw를 확인한 다음 실제 successor no-op job으로 만료 소유권을 정리했다. 물리 terminal 자체가 만료 시각 뒤 도착한 실험은 아니다.

## 독립 readback과 자원 정리

Root가 agent 반환 후 정확 Docker ID/image/scope/loopback/768MiB/단일 소유 volume을 재검사하고 별도로 읽었다. 두 DB 모두 정상 STOP, exited 0, OOM false 확인 후 자기 container와 volume만 삭제했다.

- Ledger 55559: public+drizzle 91표/95행 = 초기 migration baseline = agent final. 연결 0. Catalog 전체 raw는 false이며 14관계의 relpages/reltuples 통계 차이만 원형 보존했다. Event sequence 1(false)→47(true), queue sequence 1(false)→13(true); reset하지 않았다. Root final은 agent의 data/catalog/sequence와 exact다.
- Runtime 55560: public 90표/10행·captured catalog·ACL·roles·functions·85 journal·3 stage의 원 µs가 baseline/agent final과 exact다. 연결 0, no_change/no_truncate ALWAYS, statement/lock 0·deadlock 1s·jit off 유지. 현재 36 sequence가 agent final과 exact다. 초기 sequence current 값은 따로 수집하지 않아 전후 delta를 주장하지 않는다. Captured catalog 밖 pg_catalog까지 baseline과 비교한 것으로 표현하지 않는다.
- Root proof: `/tmp/nomorevibe-pr05b3-a-ledger-root-independent-proof-20261016.json`, `/tmp/nomorevibe-pr05b3-c-root-independent-proof-20261016.json`.
- Cleanup: `/tmp/nomorevibe-pr05b3-a-ledger-root-db-cleanup-20261016.json`, `/tmp/nomorevibe-pr05b3-c-runtime-root-db-cleanup-20261016.json`.

## 보존한 실패와 한계

중간 terminal predicate의 JSON 연산자 우선순위 SQL 22P02, unit fixture의 non-UUID token, snapshot 보조 checker 필드/정렬 오류, late fixture varchar=uuid SQL 42883은 원로그를 보존했다. Setup/SQL 실패를 동작 Assertion RED로 세지 않았다. 마지막 root manifest reader의 list/object 형태 오류도 source/DB를 변경하지 않았으며 형태를 확인한 뒤 corrected guard로 인수했다.

Ledger foreign-TX proof 검증은 순차 실제 두 TX이며 동시 PID 경합 증거가 아니다. Ledger의 후보/job literal fixture와 runtime의 실제 domain/job 증거를 구분한다. DB query-count 미계측 경계는 SQL 전 거절을 계측 수치로 표현하지 않는다.

실제 provider hard C·remote 종료·영속 native artifact·commit ACK 손실/원격 crash 복구·AI2/item/CLI/text 전 호출 연결·30분 동등 품질 성능 비교·운영 배포는 남아 있다. 승인 품질·모델을 변경하거나 불명 charge를 자동 해제하는 것으로 이 공백을 메우지 않는다.

담당 최종 보고: `/tmp/nomorevibe-pr05b3-a-ledger-final-report-20261016.md`, `...b-native-final-report...md`, `...c-final-report...md`. Root 직접 리뷰와 별도로 B runtime 리뷰, A native/runtime 및 추가 fixture hunk 리뷰를 취합한다.
