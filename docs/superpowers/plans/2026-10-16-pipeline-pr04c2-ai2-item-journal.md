# AI2 item journal·권한·coverage·seal Implementation Plan

> root가 승인한 배타 B lane이다. gpt-6.1-sol/xhigh, 이 WT의 AI2/replay source·관련 회귀만 변경한다. Git/handoff/공통 test 설정/0079/HTTP/model capacity/운영 활성화0. 원 메모의 기능1·2를 실제 fixture end-to-end로 완성한다. 별도 재승인 대기 없이 TDD로 진행하되 새 migration 필요성은 먼저 보고한다.

**Goal:** 실제 legacy AI1 뒤 실제 AI2 item lifecycle을 실행하고 actual item 소유권·callId·혼합 journal·commit bounds·준비 coverage·full final을 검증한 strict item artifact를 봉인한다.

**Architecture:** 신규 table0. 기존 capacity_runs JSON 및 append-only changes/transactions/transitions를 재사용한다. legacy v1/handlers-v5를 유지하고 새 item/mixed artifact version2/handlers-v6-item을 명시 지원한다. 기존 item state/combined capture/target predicate와 lifecycle/transport를 재사용한다. caller JSON·callback·Boolean은 인증이 아니며 실제 guarded TX의 원 item row/claim history를 검증한다.

**Tech Stack:** PostgreSQL17, postgres.js, Drizzle, Zod, Vitest. 새 DB는 root가 만든 loopback55521만 사용하고 종료/삭제는 root 담당이다.

## 불변 계약과 파일

- `pipeline-replay-handler-profile.ts`, `pipeline-replay-database.ts`: 고정 v6 item 정책/전용 provision entry. v5 source/item immutable 정책 유지. v6 stage/source/products immutable, AI2 item INSERT/필요 UPDATE만; exact ACL/OID/function/trigger manifest 검증 유지.
- `scripts/sql/pipeline-replay-ledger.sql`: tx-local stage/item OLD/NEW 수집 허용. trigger에서 run/domain 조회·FK/run lock0, 모든 변경에 하나의 global ordinal.
- `pipeline-replay-ledger.ts`, `pipeline-replay-execution.ts`: opaque certified run에 실행종류를 묶고 combined initial/start 재대조·mixed journal flush/validation·call authority event·postflush wall·fence/quiescence를 연결한다. shared4→S3→domain→item→jobs→run flush, seal lifecycle2→exclusive4→run. run lock 뒤 domain 추가 잠금0. native commit 후 ack 실패는 미확인으로 보존.
- `pipeline-replay-item-execution.ts` (새 좁은 통합 모듈): 기존 component schemas/reducers로 mixed packet 검증·재생, 실제 원 item authority 증거 검증, 기존 target assessment에 기반한 item coverage를 연결한다. 기존 predicate/정규화/heartbeat 구현 복제0.
- `second-review-ownership.ts`, `second-review.ts`, `second-review-item-lifecycle.ts`, `second-review-transport.ts`, `review-fixture-transport.ts`: 기존 원 receipt를 actual authentic item run에서만 허용. actual claim→owner/boot/token/epochs/binding→callId를 결합. release는 원 token의 actual OLD/NEW를 등록하고 마지막 flush 뒤 원 expiry/현재 epoch·released 상태를 확인한다. item UUID를 job token으로 치환0.
- `pipeline-replay-final.ts`: 실제 item final branch와 원 call authority 검증. full existing first/AI2/root/fallback gate 재사용, historical first를 다시 live item 요구0. human/reuse/rules/partial/reject/published-first-null final0 유지.
- `pipeline-replay-runner.ts`, `pipeline-replay-artifact.ts`, 필요한 compare 접점: 별도 fixed mixed fixture runner·strict version2 readback/report, 실제 journal coverage. v1 parser/old runner의 item 거절은 유지. scope 밖 모든 item 실행은 원래 generic fencing을 유지한다.
- NEW unit `tests/pipeline-replay-item-execution.test.ts`, NEW integration `tests/integration/pipeline-replay-item-journal.test.ts`, 필요한 기존 replay unit/DB compatibility 회귀만 변경/실행한다. shared 설정/범용 fixture 편집0.

## 순차 TDD

- [x] 1. existing immutable v5/ordinary item control을 가진 실제 fixture 작성. 새 runner entry의 실행가능 초기 adapter를 legacy runner로 연결해 mixed 실행의 정상 목표 assertion이 현재 unsupported 경계에서 실패하는 **새 기능 RED**를 기록한다. import/API/SQL/setup 오류는 RED0. source/driver SHA·원 로그를 보존한다.
- [x] 2. v6 고정 ACL·source guard와 mixed initial/journal을 구현. existing reducer는 global ordinal 검증 후 각 원 변경을 ordinal1 단위로 적용하므로 원 packet 순서를 잃지 않는다. full raw rows/foreign/released/stale owner 포함. legacy v5 regression을 함께 확인한다.
- [x] 3. authentic current TX에서 원 item 소유권·binding을 확인하고 call reservation을 등록한다. dispatch/settle은 기존 fixture budget/state transition 재사용, native/provider guard 유지. forged/wrong owner/cross-TX·scope/expired 원권한을 실제 거절한다.
- [x] 4. item release authority를 writer 마지막에 등록한다. actual run-row holder로 flush 대기 후 expiry가 지났을 때 domain/item/outbox/journal 모두 rollback하는 RED→GREEN. 정상 wall control commit. TTL/transport abort를 외부 종료 증명으로 쓰지 않는다.
- [x] 5. strict version2 artifact에 full initial items·mixed transactions·actual call authority payload를 포함하고 DB readback에서 동일 packet/sequence/hash/owner proof 검증. 기존 domain first readiness + 기존 AI2 target/item expiry/commit bounds로 coverage를 계산한다. unknown은 known/covered로 승격0.
- [x] 6. genuine legacy AI1→item AI2 fixture end-to-end final1·독립 2-slot/historical release·실패 root/fallback·cancel final0·위조 artifact 거절·fence 양 선점/late writer0·rawµs/foreign owner·고정 v6 source/stage guard를 검증한다. explicit gap은 pure mixed reducer에서 unknown을 확인한다. 이 단계에서 새 published/tokenless 실제 item fixture 및 실제 commit-ack loss 주입은 실행하지 않으며, 기존 null-first final 제외·unknown seal 거절 코드는 유지한다.

등록/취소/갱신/결과의 모든 실제 Promise를 추적하고 finally에서 실제 정산→검증된 profile 해제→own exact rows/managed raw 원복을 완료한다. cleanup 예외와 원 예외를 모두 보존한다. DB root metadata를 다시 확인하고 schema/readback·연결0 결과만 보고하며 DB stop/delete는 하지 않는다.

## 검증 명령과 한계

```sh
npx vitest run tests/pipeline-replay-item-execution.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55521/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-replay-item-journal.test.ts
# 구현 변경이 닿은 기존 replay/fixture/handler 회귀만 추가 선택한다.
npx tsc --noEmit --incremental false
npx eslint <이번 변경 source/test 파일의 명시 목록>
```

PR별 전체 unit/전체 DB/build 반복0이다. 독립 consumer 연결/운영 contract 상승/모델·품질·timeout 변경/실 provider·native budget guard 해제0. fixture seal은 provider 종료/전체 caller cap/30분 baseline/2배 인증0이다. implicit first reviewer/README 불명·transient lock/commit 경합은 원 unknown 경계를 유지한다.

최종 실제 명령·RED/GREEN·동결 SHA·복원·미실행 범위는 [검증 기록](2026-10-16-pipeline-pr04c2-ai2-item-journal-validation.md)에 남겼다. CODEX_HANDOFF/Git/DB 종료는 root 소유로 반환한다.
