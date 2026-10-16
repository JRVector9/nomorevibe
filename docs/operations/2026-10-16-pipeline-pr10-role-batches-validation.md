# PR10 비활성 job 배치·3 host 선출 검증

2026-10-16, gpt-6.1-sol/xhigh. 작업 WT `nomorevibe-role-batches`, base `37f0542b`. 운영/SSH/provider/추론/배포/활성화/Git mutation은 수행하지 않았다. 사용자 지시에 따라 변경 범위 회귀와 필요한 정적검사만 실행했다.

## 구현된 경계

기본 catalog의 5 legacy 역할과 producer/scheduler는 유지한다. additive 0082는 `legacy/epoch1/contract0`을 설치한다. 고정 version1 policy는 instance→m3/mini/oracle-osaka-smoke와 release만 설정하며 job 목록이나 선호 순위를 재정의할 수 없다. Oracle 명칭은 surfguide/ap-osaka-1/osaka-smoke를 뜻한다.

versioned에서는 번역 3종을 translation으로, uptime-ping을 product-health로, news-refresh를 official-news로 옮긴다. site-evidence는 PR08 canonical-only adapter가 이 base에 없어 빈 배치다. 기존 product-evidence-refresh 전체를 옮기지 않는다. translation은 worker 직렬 lane과 같은 role admission mutex 아래 다른 번역 job의 건강한 실행을 확인한다. 모델 공통 슬롯을 대신하지 않는다.

일반 runner는 batch control SHARE→role→job 순서로 같은 claim TX에서 mode/epoch/role membership을 검사한다. drain은 새 job claim을 막고 기존 token을 보존한다. complete는 role/job 잠금 대기 뒤 DB wall로 건강한 role/job/item이 없음을 확인한 뒤 epoch를 올린다. 새 versioned role 선출·release는 job/item token을 초기화하지 않는다. 기존 legacy 기본 takeover/release 의미는 유지한다. batch mode는 item stage admission이나 외부 호출 종료 증거가 아니다.

선출은 설치·heartbeat와 capability·actual result를 구분한다. 성공 ACK에서 DB 시각과 처리량을 instance별 observation으로 남긴다. 같은 host/release/job/requestedVersion의 operator-managed domain readback hash와 DB principal/effective privilege hash, 필요한 HTTP/model evidence가 없으면 ready0이다. capability/readback은 candidate heartbeat가 작성하지 않는다. fixture evidence는 실제 provider 품질·운영 권한에 대한 인증이 아니다.

기존 fixed replay 예외는 `currentReplayDb`가 private scope와 verified dedicated DB를 재검증하는 경우만 허용한다. allowed legacy job만 실행하며 role proof/new job은 거절한다. 새 batch table 권한은 추가하지 않았다. 실제 v5 profile을 검증했으며 v6 item mode와 job-batch legacy를 같은 것으로 취급하지 않는다. 이 base에 없는 v6 actual 회귀는 미실행이다.

## 실제 RED와 실패 분리

| 원로그(`/tmp/` 아래) | 실제 결과 | 의미 |
| --- | --- | --- |
| `nomorevibe-pr10-policy-red-20261016.log` | 2 Assertion FAIL / 2 control PASS | 고정 번역 배치와 Oracle 우선순위 누락. 초기 셸의 마지막 출력 명령 exit0을 vitest 성공으로 세지 않았다. |
| `nomorevibe-pr10-actual-claim-behavior-red-20261016.log` | 2 Assertion FAIL / 1 control PASS, exit1 | draining/versioned에서 실제 runner가 handler를 호출하는 우회. |
| `nomorevibe-pr10-translation-overlap-red-20261016.log` | 1 Assertion FAIL / 6 skip | 건강한 다른 번역 job과 중복 실행. |
| `nomorevibe-pr10-per-host-canary-red-20261016.log` | 1 Assertion FAIL / 7 skip | singleton observation 덮어쓰기로 먼저 처리한 host의 canary 소실. |
| `nomorevibe-pr10-actual-claim-red-20261016.log` | 초기 fixture cleanup SQL 오류 포함 | JSON populate 인자의 이중 인코딩. 기능 RED 근거에서 제외하고 text→jsonb cast 및 exact own fixture 복구 뒤 다시 실행했다. |
| `nomorevibe-pr10-readback-clock-fixture-failure-20261016.log` | 6 FAIL / 11 PASS | fixture의 host Date가 DB ACK 시각보다 앞섬. operator readback fixture 시각을 actual DB clock으로 변경했다. 생산 실패로 세지 않았다. |

원 actual 3case driver는 `nomorevibe-pr10-frozen-actual-claim-red-driver-20261016.ts`에 보존했다. 최종 파일의 첫 3개 it 본문과 assertions는 byte 동일이다. 비교 결과는 `nomorevibe-pr10-original-driver-conformance-20261016.json`이다. 전체 파일/prefix 동일을 주장하지 않으며 정산·정리 helper와 추가 fixture는 확장했다.

## 최종 실행

```sh
npx vitest run tests/job-batches.test.ts tests/job-catalog.test.ts tests/role-worker.test.ts tests/worker-runtime.test.ts tests/worker-supervisor.test.ts tests/scheduler-runtime.test.ts tests/failover-readiness.test.ts tests/db-pool-config.test.ts tests/db-pool-options.test.ts tests/pipeline-replay-job-runner.test.ts tests/worker-progress.test.ts tests/operations-instance.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55525/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/job-batches.test.ts
npx tsc --noEmit --incremental false
```

- scoped unit: 12files, **108PASS**, 676ms, exit0. 로그 `nomorevibe-pr10-scoped-final-unit2-20261016.log`.
- actual DB: 1file, **17PASS**, 2.05s, exit0. 로그 `nomorevibe-pr10-actual-final17-green-20261016.log`.
- whole TypeScript: exit0, `nomorevibe-pr10-tsc-final2-20261016.log`.
- scoped ESLint: exit0, `nomorevibe-pr10-lint-final2-20261016.log`. 대상은 변경 TS source/test 18개이며 문서/SQL은 별도 읽기 검토했다.
- 기존 Vite native config loader warning은 남아 있으며 테스트 실패가 아니다. 전체 unit/전체 DB/build는 실행하지 않았다.

actual 17case는 정상 legacy ACK, contract0 차단, drain/direct·old role 차단, 정상 versioned claim·wrong job 거절, 미확정 capability 차단, 번역 서로 다른 job 중복0, 두 host canary 보존·고정 순위, drain/claim 실제 두 connection 대기, live job/item/role 보존과 epoch 전환, expiry fallback·old role proof 거절, producer/pause/cursor/µs history 보존, concurrent acquire 단일 owner, Mini fallback 비선점, missing role/host ready0, genuine v5 replay 제한을 검증한다. generic item은 실제 generic claim이 발급한 90초 receipt이며 domain/provider authority 증거가 아니다.

## 전용 DB 원복·반환

root가 준비한 loopback55525 `nomorevibe-pr10-role-batches-c-20261016`만 사용했다. source fixture는 정산 대상 Promise를 retain하고 actual allSettled 후 exact own key를 정리한다. 원 관리행은 raw JSON으로 같은 행에 복원하며 바깥 행/µs를 보존한다. 별도 runtime 권한이나 profile manifest를 열지 않았다.

readback script: `/tmp/nomorevibe-pr10-c-db-readback-20261016.mjs`.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55525/nomorevibe_test node /tmp/nomorevibe-pr10-c-db-readback-20261016.mjs readback
```

실제 exit0: 84 public table raw, constraints/triggers/functions, roles, table/column/schema/database/default ACL, DB 설정이 저장 baseline과 exact 동일. 다른 연결0. batch legacy/epoch1/contract0, candidates0, 3 stages legacy/epoch1/contract0. jit=off(source database, migration0058), lock_timeout=0, statement_timeout=0, idle_in_transaction_session_timeout=0, deadlock_timeout=1000 유지. 로그 `nomorevibe-pr10-c-whole-readback-20261016.log`; 원 JSON은 `nomorevibe-pr10-c-whole-{baseline,readback}-20261016.json`이다.

전체 catalog 기준은 첫 verified replay bootstrap 정상 teardown 이후에 캡처했다. 따라서 그 이전 bootstrap이 NULL ACL을 owner-default로 표현 정규화했는지에 대한 byte attestation은 하지 않는다. 테스트 전 원 데이터 기준은 `nomorevibe-pr10-actual-baseline-20261016.json`에 별도 보존했다. DB는 root에게 반환하며 STOP/cleanup은 root가 수행한다.

## 운영 활성화까지 남은 것

PR08 canonical-only handler 순차 연결, 실제 3host 등록·DB effective privilege 검증·domain canary/모델 hard bound·HTTP 상한·Oracle CPU/RSS/host aggregate DB pool·독립 scheduler/최소 runtime·관리자/배포 전환은 미확인이다. role별 pool3은 전체 host pool 예산이 아니다. 새 소비자 활성화, 실제 Oracle1CPU 처리량, 30분 비교, 2배·DR·remote 종료를 증명하지 않는다. 기본 legacy/contract0은 그대로다.

## Root 인수·두 경계 보강·v6 읽기 검토

Root는 production 경로와 actual DB17 driver를 직접 읽고 C22파일 manifest 및 B4파일 override를 검증했다. B가 발견한 versioned crawler lane 직렬화와 publisher model-bound readiness 누락은 actual4AssertionRED+3controlPASS→동일7GREEN, 영향 두 unit파일30PASS(481ms), TypeScript exit0, ESLint 오류0/기존 unused _hash 경고1로 최소 수정했다. helper는 기존 lane∩versioned job만 보존하고 source continuation을 유지한다. 원23 test body·새7 body byte동일, 원DB17/unit108 반복0이다. 보고 `/tmp/nomorevibe-pr10-b-two-boundary-fix-20261016.md`.

A의 v6 호환 읽기는 verified private replay DB가 job-batch 조회를 생략하고 새 table권한을 요구하지 않는 경로에 확정P1/P2 0을 보고했다(`/tmp/nomorevibe-pr10-a-v6-compatibility-review-20261016.md`). 이는 실제 v6 통합 PASS가 아니며, 선행 PR453/455/456 통합 뒤 지정 단일case와 0080→0081→0082 fresh migration 확인이 남았다. 기존 55525는 root whole raw84table/catalog exact 확인 후 정상정리했다. 새 consumer·Oracle 업무·실제 host전체 pool/CPU·model bound evidence는 미활성/미검증이다. 수동 전체 검사는 모든 PR 개발 후 최종 통합에서만 실행한다.

## Integrated source/runner migration and one v6 case

Root normally integrated PR08 (0081), PR453 and main971fa17 into source head cc43a1d9b95825346c45ed8de03e3b1ac933ea96. The journal is contiguous0..82 with0080→0081→0082 and83entries. Original source/driver hashes remain unchanged. A new owned loopback55531 database migrated once and reran the same migrator with exit0; all83 persisted hashes/timestamps, final three SQL hashes, disabled controls and legacy epoch1/contract0 were checked.

Only the original test `certifies actual AI1 legacy then AI2 item work with persisted owner journal and a strict seal` was executed once: **1 PASS/13 SKIP/exit0,13.44s**. Its existing20s timeout, SQL, grants, bodies and expectations were preserved. Fixed stderr was actually visible:30events/15begin→end operations, no reject; certified_item11.702s and cleanup settle/release/admin.end completed. This proves the specified v6 path under the integrated runner, not all v6 paths or resolution of the earlier CI timeout. No original17-case/whole suite/build or repeated statics ran.

Root independently captured raw90tables/92rows, migrations and catalog and matched the agent's final snapshot exactly; original raw table rows and stage timestamps were exact, managed/replay residue and other clients were0. Whole before/after snapshot remains **false**: one database datacl and16relation relacl values changed from NULL to explicit owner/default arrays. Raw differences are preserved; no normalization DML or claim of separately proven effective privilege equality. Root then normally stopped the exact owned container (exit0/OOMfalse) and removed only its container/volume.55515–31 are retired; never reconnect.

Reports: `/tmp/nomorevibe-pr10-a-integrated-v6-report-20261016.md`, `...pr10-root-integrated-readback-proof-20261016.json`, `...pr10-root-integrated-cleanup-20261016.json`. Manual whole tests remain deferred until all PR development is complete. PR10 still depends on PR453/PR456; site-only adapter and actual host aggregate budget are separate follow-ups.
