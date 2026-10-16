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
