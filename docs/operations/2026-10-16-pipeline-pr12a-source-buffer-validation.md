# PR12a 원본 공급 버퍼 검증 — 2026-10-16

기본 비활성인 count/age 공급 gate를 추가했다. 원본을 아직 수집하지 않은 신규 발견만 후단 적체에 따라 기다리며, 현재 문서·후보가 있는 갱신은 LIMIT 전에 선택한다. 기존 검수·발행은 계속 소비한다. 새 큐·새 consumer·모델·심사 품질·동시성·운영 pause는 변경하지 않았다.

## 구현 경계

- 기존 discovery hysteresis를 재사용한다. 후단은 규칙/AI1/AI2/발행이며 fetch 자체 적체는 제외한다. 측정 불명·불완전 semantic window는 신규 원본 공급을 보류한다.
- 검증된 최종 검수율이 없으므로 R/targetHours/capHours는 null이다. 이 수치는 처리량2배나 지속 가능한 용량 증거가 아니다.
- fetch stage SHARE → 설정 SHARE → singleton control UPDATE → 제한된 후단 읽기 → frontier/item/job 순서다. 기존 readonly3초 telemetry wrapper는 유지하고 같은 semantic reader를 mutable transaction에서 await한다.
- control/read 단계의 한도 오류만 실제 rollback 완료 뒤 typed defer로 돌린다. 뒤의 claim-write SQLSTATE57014, 권한·job wall 오류는 기존 실패로 전달한다. 진행 중 호출을 버리거나 실패 횟수를 소모하지 않는다.
- runner의 대기 반환은 실제 현재 job wall과 token CAS를 확인한다. requested/processed, pause, cursor, success/error 이력을 보존한다.
- 기존 문서/후보 bypass의 OR를 괄호로 묶어 due/state 조건을 유지한다. 완료된 갱신을 다시 고르는 실제 회귀를 재현해 수정했다.
- migration0083은 control singleton만 추가한다. 기존 replay profile/grant는 확장하지 않는다. 설정이 비활성이면 신규 control table을 읽지 않는다. item API는 기존처럼 운영 consumer에 연결하지 않았다.

## 실행한 검증

| 범위 | 실제 결과 |
| --- | --- |
| 원 고정 count 정책22case | 13 AssertionRED/9control → 같은22GREEN, 원 unit byte 동일 |
| 관련 unit/deadline/fetch backpressure | 최종3파일30PASS/551ms |
| 실제 기존 repository/runner 압력 | disabled control1PASS, 예상 deferred/실제 completed1AssertionRED → 구현 뒤 GREEN |
| 기존 후보 refresh 선택·완료 보존 | OR 우선순위 오류를 짧은1AssertionRED로 분리 → 수정 뒤 GREEN |
| 실제 확장10case | 10PASS/4.48초: HTTP0/attempt0, LIMIT전refresh, 실제 규칙 consumer, 동시 producer/pause/cursor/history, control wait, 마지막job wall, item owner, 위조token |
| 후단 claim-write 취소 | 별도1PASS, 원 Drizzle SQLSTATE57014 유지·frontier/control rollback |
| 최종 fixture cleanup-error 합산 보강 | 영향3case만3PASS/8skip, 생산 코드 추가 수정0 |
| 변경 TS 및 실제 전이 의존성 scoped tsc | exit0 |
| 변경10 TS파일 scoped eslint | exit0 |

최종11 actual case를 한 번에 모두 재실행한 것으로 합산하지 않는다. 전체 unit/전체 DB/build/typegen은 사용자 지시에 따라 실행하지 않았다. 앞선 whole tsc1회는 기존 미생성 PageProps6과 신규 union 오류를 보고했고, 신규 오류 수정 후 scoped 검증만 통과했다.

초기 hook 자기 대기143, fixture JSON scalar/bigint 타입, 임시 tsconfig의 없는 next-env 참조는 setup 진단으로 분리했다. 이들을 기능 RED로 세지 않았다.

## root 코드 검토·전용 DB 정리

root는12파일 manifest와 실제 production diff/신규 helper/schema/migration/두 테스트를 직접 읽었다. 기존 readonly wrapper, 새 mutable rollback 경계, LIMIT전 predicate 괄호, runner wall, journal0083을 검토했다. 기존 통합 parent의 비중복26 source/tests SHA도 보존했다.

반환된 loopback 전용55537에서 root가 container ID/name/고정 image/label/mount/768MiB/port를 확인하고 독립 조회했다. 전체90 public table/10행의 저장µs raw, catalog/ACL/database defaults,84journal와0083 SHA,3stage legacy/epoch1/contract0은 baseline 및 agent최종과 정확히 일치했다. 별도 role/defaultACL, 자기 fault함수/trigger0, 타client0을 확인했다. sequence 증가를 원복했다고 주장하지 않는다.

정상STOP → exited0/OOMfalse → 자기 container/volume만 제거했다. **55537은 retired이며 다시 연결하거나 재생성하지 않는다.** 로컬 독립 증거는 `/tmp/nomorevibe-pr12-root-independent-readback-proof-20261016.json`, 정리 증거는 `/tmp/nomorevibe-pr12-root-source-buffer-cleanup-20261016.json`이다. 원 로그·12파일 SHA·실패 접근은 `/tmp/nomorevibe-pr12-a-final-report-20261016.md`에 보존했다.

## 재현 명령과 남은 작업

아래 DB 명령은 새로 배정한 전용 테스트 DB에서만 실행한다. 이전55537을 재사용하지 않는다.

```sh
npx vitest run tests/source-buffer.test.ts tests/discovery-admission-deadline.test.ts tests/crawl-fetch-backpressure.test.ts
TEST_DATABASE_URL="$OWN_TEST_DATABASE_URL" npx vitest run --config vitest.integration.config.ts tests/integration/source-buffer.test.ts
npx tsc -p /tmp/nomorevibe-pr12-a-scoped-tsconfig-20261016.json --noEmit --incremental false
```

고정 입력의 실제 지속 처리율/시간 버퍼, shard claim/TTL/24h 신선도, 독립 소비자, 운영 활성화, 관리자 실제 화면, end-to-end2배 성능은 후속 작업이다. 선행 PR453/460/461/462의 개발·CI·병합·운영 적용을 구분한다. 자동 필수 CI는 유지하며 이 검증 문서가 실패한 선행 CI를 대신하지 않는다.

## 독립 리뷰 후 shared fixture 보완

B의 독립 리뷰에서 생산 코드 추가 P1/P2는 없었고, 전역 selector의 기존 행 유입과 고정 job 소유권 정리에 fixture P2가 있었다. 해당 integration 파일만 보완했다. Foreign frontier/candidate는 selector에 필요한 state 한 열만 fullraw CAS로 잠시 제외하고 마지막에 원 µs로 복원한다. 후보가 없는 기존 문서는 원형을 변경하지 않고, 부재를 확인한 repo에만 자기 rejected placeholder를 만들며 ID/fullraw CAS로 정리한다. 중간 격리 baseline과 원 전체 baseline을 구분한다.

고정 job 준비는 기존 행 fullraw CAS 또는 absent INSERT DO NOTHING/RETURNING1이다. Cleanup은 row lock과 unknown token 검사를 거쳐 fullraw CAS로만 복원한다. Root 추가 리뷰에서 setup 충돌 뒤 외부 job이 정상 완료해 token=NULL이면 행을 삭제할 수 있음을 찾아 보완했다. 실제 INSERT한 이름은 **TX commit resolve 후에만** 소유 Set에 등록하고, 미등록 absent-baseline 행은 token=NULL이어도 DML 전에 거절한다. Cleanup commit 뒤에만 등록을 해제한다. 임의 외부 writer와 모든 키 재사용 조합을 완전히 증명한 것으로 확대하지 않는다.

실제 검증은 다음과 같다. 서로 다른 실행의 중복 case를 합산하지 않는다.

- 원 driver+nonempty sentinel의 disabled1: 실제 getRepo1 기대/2 호출 Assertion RED. 보완 뒤 같은 sentinel의 disabled/pressure/forged 원3개 GREEN.
- 별도 실제 INSERT+runJob이 owner를 유지하는 경쟁: 원 helper의 token 소실 Assertion RED → 같은 body GREEN.
- Setup 충돌 후 외부 runJob 정상 완료/token=NULL 경계: c3fd helper의 외부 idle 행 삭제 Assertion RED → 같은 body GREEN(1.34초).
- 최종 commit 추적 보강 뒤 nonempty 원3개: **3PASS/8skip,1.45초,exit0**. 단일 파일 scoped tsc/eslint도 실제0이다. 전체11/전체unit/전체DB/build/typegen 반복은 하지 않았다.
- 원11개 feature tail은 음성 auth의 고정 forged token을 randomUUID로 바꾼 한 곳 외 byte exact이며 나머지11개 source/test/migration SHA는 동일하다. 최종 fixture SHA `aeaa281dd52d2d593c72d84cd00cccad25289c5ee7af29d8ea438bbdc98bfdd0`.

GitGuardian의 단일 finding은 해당 forged 음성 fixture literal로 확인했다. 실제 token 발급·검증 코드를 읽어 분류했으며 운영 credential로 사용되는 값이 아니다. Literal 제거 후 이전 commit의 보안 check가 자동 해소되는지는 미확정이다. Ignore·보안 설정·check 우회는 하지 않았다.

Root는 두 최종 diff와 실제 원로그·manifest를 직접 읽고55541을 독립 readback했다. Public90표/10행 raw·µs/catalog/OID/ACL/defaults/roles/triggers/84journal/타 연결0은 agent final 및 최초 baseline과 exact다. 정상 STOP/exited0/OOMfalse 후 자기 container/volume만 제거했다. **55541 retired: 재접속·재생성하지 않는다.** 근거는 `/tmp/nomorevibe-pr12-root-fixture-independent-proof-20261016.json`, `...pr12-root-fixture-cleanup...json`, `...pr12-b-fixture-fix-final...md`, `...pr12-b-inserted-key-final-report...md`이다. 초기 import/self-drain 및 patch 작성 오류는 별도 보존했고 기능 RED로 세지 않았다.
