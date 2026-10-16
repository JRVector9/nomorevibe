# PR11b Oracle runtime inspection preflight — 2026-10-16

Oracle용 실행 전 검증 entry가 없어서 현재 배치·후보·업무 완료 근거·역할 권한을 한 경로에서 확인할 수 없었다. 새 `readOracleRuntimePreflight`와 CLI는 기존 배치 classifier/admission 및 실제 연결의 session/catalog 조회를 사용하도록 구성했다. 역할별 기존 job mapping을 사용하고 scheduler는 업무 canary가 없어 unknown을 유지한다.

새 파일은 `lib/runtime/oracle-preflight.ts`, `scripts/worker-oracle-preflight.ts`, `tests/oracle-runtime-preflight.test.ts`다. 기존 2069 tracked 파일은 agent 반환 시 원문과 일치했다. Root가 NEW3 전체 및 기존 classifier/admission/ACK writer를 직접 읽었다. 기존 Python launcher와 공통 runtime/schema/DDL에는 변경이 없다.

## 동작과 범위

입력은 역할 하나만 받는다. 고정 배치·instance/release/host·role lease 환경을 첫 await 전에 snapshot하고, replay·잘못된 입력을 DB 전에 거절한다. Primary transaction에서 기존 batch SHARE를 먼저 잡고 현재 policy/hash를 확인한 뒤 session의 principal·위험 권한·RLS/컬럼별 권한·timeout, exact candidate 및 persisted positive ACK/readback tuple을 읽는다. 현재 lease가 있으면 기존 admission과 마지막 DB wall role 검사를 수행한다. Row lock이 필요하므로 PostgreSQL READ ONLY transaction이라고 주장하지 않는다. 새 claim/renew/producer/worker 시작은 없다.

`workload.ready`는 저장된 canary tuple의 일치만 나타낸다. 실제 Oracle 가동이나 승인된 최소권한 증거는 아니다. 최상위 ready/activationAllowed는 항상 false, CLI는 항상78이다. 고정 오류만 출력하고 기존 pool을 end({timeout:5})로 정리하며 원 검사 오류와 정리 오류를 함께 보존한다. Host metadata/root-owned release/승인된 privilege profile/host aggregate budget/physical model slot은 unknown이다.

## 실제 실행한 범위 검증

| 검증 | 결과 |
| --- | --- |
| Runnable feature scaffold | 1 Assertion RED + control1 → 같은 원16 PASS |
| 원 검사 오류와 pool 정리 오류 보존 | 새1 Assertion RED → 같은1 PASS |
| mapping·model evidence·timeout·역할·CLI controls | 25 PASS |
| 실제 Node+tsx 잘못된 인수 CLI | 새1 PASS/25skip; child exit78, signalnull, DATABASE_URL 없음 |
| Root 발견 종료 대기 P2 | end 인수2 Assertion RED → 단1행 제한 → 같은2 PASS/24skip |
| 최종 source 범위 TypeScript/변경3 ESLint | 실제 exit0/0byte |

26 distinct unit/native control의 union을 검증했으며 최종26 전체를 재실행하지 않았다. Native child는 잘못된 인수의 entry/exit 검증이며 DB pool 종료 SLA나 Oracle 운영 시험이 아니다. 원 RED·log·command·exit·source SHA는 `/tmp/nomorevibe-pr11b-b-{final-report,executed,final-shas,sql-flow}-20261016.*`에 보존했다. Root가 실제 로그 hash와 크기 및 source3/기존2069의 원문을 독립 확인했다.

## 남은 검증

실제 PostgreSQL에서 새 catalog SQL·권한/RLS/row lock·DB wall·rollback은 아직 실행하지 않았다. 실제 Oracle ARM/runtime provenance·최소권한 profile·host 전체 DB/HTTP 예산·번역 physical slot·업무 canary와 scheduler 독립 실행도 남는다. Mock 입력으로 이 gate를 올리지 않는다. 신규 owned DB/운영DB/SSH/배포/provider/activation0, 전체 수동 검증은 모든 PR 개발 뒤다.

## 2026-10-16 CI 타입 오류 후속

PR478 첫 CI38900448343은 통합 세 shard/scope/GitGuardian SUCCESS이나 quality TypeScript에서 TS2769로 실패했다. 실제 raw job log SHA8807be7eb8195e85005e788e63c735cc0e703c46c54c8486ba6cccdcd6533cb3에 새 native CLI test의 env에 Next가 요구하는 NODE_ENV 누락을 확인했다. Root가 실제 Next global 선언을 scoped tsconfig의 files에 직접 포함해 같은 TS2769를 exit2 재현했다. 첫 include 시도는 node_modules exclude 때문에 선언을 로드하지 않아 exit0이었으므로 실패재현으로 집계하지 않는다.

테스트 child에 기존 process.env.NODE_ENV만 전달하는 한 줄을 고쳤다. DB 환경은 여전히 전달하지 않고 원 인수·timeout·출력/exit 기대를 보존했다. 동일 scoped TypeScript exit0, 영향 native CLI1 PASS/25skip(283ms), 해당 ESLint exit0이다. Production2파일과 다른 원본은 unchanged이며 운영/실DB/Oracle/provider/activation0이다. 원 CI 실패/실제 RED를 보존하고 변경된 commit만 push한다. 원로그 `/tmp/nomorevibe-pr478-root-quality116971179965-20261016.log`, 재현/해결 `...root-type-red-with-ambient...log`, `...root-type-green...log`, `...root-native-green...log`를 따른다.
