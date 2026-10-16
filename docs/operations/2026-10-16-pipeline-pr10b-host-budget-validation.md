# PR10b — 순수 host DB 예산 catalog·quota 검증

2026-10-16, gpt-6.1-sol/xhigh. WT `nomorevibe-host-db-budget`, base `6cabb005`. 이번 변경은 신규 source/test/이 문서 3파일뿐이다. 기존 pool/index/role/batch/caller를 수정하거나 연결하지 않았다. DB/실제 PgBouncer/SSH/운영/provider/Git mutation과 전체 suite/build 실행은0이다.

## 납품 계약과 작은 계획

`lib/db/host-budget.ts`는 zod만 import하는 순수 모듈이다. 먼저 실제 importer의 DB 수명(`lib/db/index.ts:19–46`, role-worker/supervisor/worker/scheduler)을 읽고, strict schema→runnable baseline의 실제 assertion RED→같은 driver GREEN→scope 정적검사 순서로 구현했다. root가 앞 단계 설계와 이번 배타 범위를 승인했으므로 별도 운영 변경을 추정하지 않았다.

- `HostDbBudgetSchema`: version1, fixed m3/mini/oracle-osaka-smoke, release, 중복 없는 fixed9role 목록, scheduler/web replicas0..2, web READ, monitor/connect-agent, preflight/migration 동시 수0..1, rolling copies1|2. unknown key/host/role/version/모순 READ 조건을 거절한다. Oracle enum은 물리 host attestation이 아니다.
- `hostDbBudgetCatalog(value)`: 각 process의 declared client quota와 primary/replica/전체 합계를 계산한다. role parent 안의 supervisor/observations/role heartbeat는 같은 pool1개이고 worker child는 별도다. scheduler parent와 child도 별도다. web primary와 READ pool을 따로 더하며, monitor/connect-agent/preflight/migration과 rolling 중첩을 빠뜨리지 않는다.
- `resolveHostDbPoolConfig(original,options?)`: default/disabled는 **원 config 객체 동일성까지 보존**하고 READ override를 주지 않는다(`readMax:undefined`). enabled는 fixed process identity/host/release/replica/copy를 roster에 대조하고 정해진 quota 이하의 명시 override만 받는다. 다른 config 필드는 그대로이며 새 객체를 반환한다. 실제 pool을 만들지 않는다.

고정 quota는 role-parent1, worker crawler4/나머지8role3, scheduler parent1/child2, web primary8+선택 READ4, monitor/connect/preflight/migration 각1이다. parent quota1은 현재 runtime을 바꾼 값이 아니며 후속 연결에서 actual heartbeat/writer 여유를 검증해야 한다. preflight/migration 수는 이미 선언된 동시 CLI 수라 rolling 배수에 다시 곱하지 않는다.

모든 계산/resolve 결과는 항상 `enforcement:'unknown',ready:false,activationAllowed:false`다. config의 `mode:'enabled'`는 순수 quota 계산 분기를 선택하며 실제 소비자/배치/운영 활성화를 켜지 않는다.

## 검증한 예

- Oracle의 새4role parent+child, scheduler1, monitor1, preflight1: declared primary21/read0.
- 모든9role, scheduler2, web1+READ, monitor/connect/preflight/migration 각1: primary55/read4/합59.
- 같은 persistent roster에 rolling copies2: primary108/read8/합116. CLI 각1은 이미 동시 개수다.

이 숫자는 선언된 client ceiling의 산술 결과이며 현재 운영 접속량/DB backend hard cap/CPU/RSS 증거가 아니다. standby worker가 실제 모두 실행 중이라고 추정하지 않지만 failover 가능한 최대 child 수는 catalog에 포함한다. rolling count는 old/new peak 계산이며 서로 다른 release의 실제 동시 admission/종료 증거를 발급하지 않는다.

## 실제 RED → GREEN과 원자료

최초 source scaffold는 strict parse/disabled control을 실행하고 catalog/resolve 행동을 남겼다. 실제 원13case는 **10 Assertion FAIL / 3 control PASS, exit1,164ms**였다. 합계21/55/108이0, parentquota1 대신3, READ 누락, 과다 override/undeclared process 허용이 원 실패다. import/API/setup 오류는 없었다.

- RED 로그 `/tmp/nomorevibe-pr10b-host-budget-c-baseline-red-20261016.log`.
- 원 source `/tmp/nomorevibe-pr10b-host-budget-c-baseline-source-20261016.ts`, SHA `f08cb868e09a5db675ed435a4bd60053a78035dc5a0f57c59e176b9bcff6970d`.
- 원 driver `/tmp/nomorevibe-pr10b-host-budget-c-frozen-driver-20261016.ts`, SHA `ff01f072ad922e410decc37ef7cc486dcf278f6d33f64f4265d9c0829abe68e5`.
- 같은 원13case **13PASS/143ms/exit0**, `/tmp/nomorevibe-pr10b-host-budget-c-same-driver-green-20261016.log`.

후속 읽기에서 disabled의 outer READ override0이 기존 READ 설정을 변경할 수 있음을 확인했다. 추가 한 case가 실제 `expected0 to be undefined` Assertion FAIL(exit1/13skip)을 냈고, disabled의 READ override를 undefined로 바꿨다. 원13case는 바꾸지 않고 이 case만 append했다. 로그 `/tmp/nomorevibe-pr10b-host-budget-c-disabled-read-red-20261016.log`. 최종 원13 byte prefix 동일은 `/tmp/nomorevibe-pr10b-host-budget-c-conformance-20261016.json`에 보존했다.

## 최종 범위 검증

```sh
npx vitest run tests/host-db-budget.test.ts
npx eslint lib/db/host-budget.ts tests/host-db-budget.test.ts
npx tsc --project /tmp/nomorevibe-pr10b-host-budget-c-tsconfig-20261016.json --noEmit --incremental false
```

- 최종 **14PASS/125ms**, 실제 exit0. `/tmp/nomorevibe-pr10b-host-budget-c-final2-green-20261016.log`.
- 두 파일 scoped ESLint actualexit0. `/tmp/nomorevibe-pr10b-host-budget-c-lint-final2-20261016.log`.
- 두 파일과 import된 실제 pool 모듈을 포함한 scoped TypeScript actualexit0. `/tmp/nomorevibe-pr10b-host-budget-c-tsc-final3-20261016.log`. 전체 project typegen/build/whole suite를 실행한 결과가 아니다.
- 첫 임시 scoped tsconfig가 `/tmp`에 있어 Node typeRoots를 찾지 못한 static 설정 실패3건은 `/tmp/nomorevibe-pr10b-host-budget-c-tsc-20261016.log`에 보존했다. 임시 config에 WT의 `node_modules/@types`/node types를 지정한 뒤 통과했으며 source 오류로 세지 않았다.
- 기존 Vite native config loader warning은 남아 있다. 검사하지 않은 경계를 통과로 기록하지 않는다.

source SHA `b74486ec686322b21c917c3f171debad8606c4c1ba0f2be61ca1baaaae0110be`, 최종14 driver SHA `63ae286e4a883519c302c96c7ea4135ea0aa11e6b2f2e63d0c7146d860265535`. 3파일 전체 SHA는 인계 시 `/tmp/nomorevibe-pr10b-host-budget-c-final-shas-20261016.json`으로 반환한다.

## 미실증·다음 연결 단위

이 함수는 실제 동시 process slot을 예약하지 않는다. 두 process가 같은 replica/copy를 선언해도 순수 함수로는 구별하지 못한다. 실제 CPU/RSS/OS unit roster·host mapping·pooler endpoint/user/role/effective privileges·backend/client cap·direct/READ 우회·rolling 종료·heartbeat 진척은 모두 미실증이다. PgBouncer/DB 접속과 실제 두 executor test를 이번 단계의 증거로 주장하지 않는다.

작은 후속은 root 순차 인수 후 기존 `dbPoolConfig/index`와 role-worker/supervisor/scheduler에 process identity와 명시 override를 연결하는 것이다. 현재 base의 `DbRole`은 새4role/preflight/migration을 지원하지 않으므로 이 순수 모듈의 선언을 실제 importer 지원으로 오해하지 않는다. 실제 worker의 READ URL 거절·overrides 전달·disabled READ 보존을 각 caller에서 확인한다. preflight/migration은 실제 entry와 URL을 읽고 별도 경로를 검증한다.

그 다음 root가 승인한 local PgBouncer fixture와 새 전용 DB에서 단일 pooler/fixed host user cap, 두 실제 executors·parent/child/heartbeat/scheduler/preflight 동시 saturation·모든 Promise 정산을 검증한다. 원격 pooler 설정이나 권한을 임의로 바꾸지 않는다. 해당 실제 enforcement와 PR11 roster/PR05 모델 slot/PR08 site-only adapter가 확인되기 전 운영 activation은0이다.

## Root 인수 및 독립 읽기 리뷰

Root는 pure source90행/driver144행/검증문서와 원 RED→GREEN 증거를 직접 읽고 원3파일 manifest를 확인했다. B 독립 읽기 리뷰는 실제 pool 계약까지 대조하여 확정 P1/P2 0을 보고했다: `/tmp/nomorevibe-pr10b-b-readonly-review-20261016.md`. 독립 리뷰의 추가 테스트/DB/Git 실행은 없다.

이 모듈의 importer와 실제 process slot·pooler enforcement는 아직 없다. 선언된 roster/quota와 disabled 원 config 반환만 검증됐으며 enforcement unknown/readyfalse/activationAllowedfalse를 유지한다. 수동 전체 검사는 모든 PR 개발 종료 후 최종 통합 단계에서만 진행한다. 앞 root commit 준비는 manifest array를 dictionary로 잘못 읽어 AttributeError가 발생했고 어떤 파일/Git 쓰기 전 중단했다. 올바른 array3를 확인한 뒤 이 인수 기록만 추가했다.
