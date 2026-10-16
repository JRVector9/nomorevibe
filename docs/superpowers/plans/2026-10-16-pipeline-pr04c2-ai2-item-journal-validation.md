# AI2 item journal·mixed B5 검증 기록

WT: `/Users/jr/Desktop/projects/nomorevibe-ai2-item-journal`, 시작 source `69512b92`. Git 변경·전체 unit/전체 DB/build·운영/실 provider 호출은 실행하지 않았다. DB는 root 소유 loopback55521만 사용했고 STOP/삭제는 root에게 반환한다.

## 완성된 범위

- 별도 fixed `handlers-v6-item`과 strict artifact version2를 연결했다. 기존 v1 schema/type와 handlers-v5 정책을 유지한다. 새 table/migration0이며 기존 runs JSON/changes/transactions/transitions를 재사용한다.
- 실제 legacy AI1→실제 AI2 item claim/heartbeat/transport/result/release를 기존 executor로 실행한다. 원 owner/boot/token/stage·item epoch/full binding과 물리 callId를 실제 private TX ticket/DB row에 결합한다. item UUID를 job token으로 치환하지 않는다.
- domain/call/item OLD/NEW에 하나의 TX ordinal을 사용하고 원 component reducers를 순서대로 재사용한다. combined initial/start 재대조, commit upper bounds, item µs expiry, 실제 target predicate를 mixed coverage에 연결한다. 경합·gap·unknown은 covered로 올리지 않는다.
- postflush 최종 SQL은 원 expiry·실제 현재 owner/epochs/binding 및 actual release 상태를 검사하고 권한 event를 같은 TX에 남긴다. 그 뒤 추가 domain 잠금/검증 없이 COMMIT한다. 미확인 commit은 quiescence/seal을 만들지 않는다.
- fixed fixture runner만 추가했다. 일반 consumer/registry/scheduler/운영 writer contract는 연결·상향하지 않았다.

## 실제 RED → GREEN

| 경계 | 원 RED | 같은 기대값 GREEN |
| --- | --- | --- |
| 새 item 인증 기능 | 기존 legacy seal1 PASS + item unsupported1 FAIL, exit1, 8.42s | 최종 14-case의 기존 두 정상 control 포함 PASS |
| postflush 원 expiry | 최종 expiry 조건만 임시 제거한 canary에서 실제 run-row 대기→DB expiry 뒤 `{state:"recorded"}`가 반환되어 AssertionError1, exit1 | 조건 즉시 원복 SHA 확인, 같은 실제 expiry/whole rollback 회귀 최종 PASS |
| await 중 lease 교체 / deferred request 변경 | A row lock 대기 중 B identity 등록, 원 requestHash/100 대신 변경 hash/1 charge: 실제 AssertionError2, exit1 | 첫 await 전 clone+strict parse, 같은 2 PASS/10.80s/exit0 |
| authority packet 재결합 | 실제 sealed artifact의 authority txKey를 같은 live owner의 다른 dispatch packet으로 옮겨 strict parse가 허용: AssertionError1, exit1 | 원 capacity_calls INSERT identity/hash/bound와 packet seq/kind/time 결합, 같은 1 PASS/15.51s/exit0 |

첫 RED는 기존 운영 결함 재현이 아니라 **새 item replay 기능 미지원 RED**다. expiry canary는 이 WT의 조건을 한 번 제거한 검증 감도 증거다. caller 객체 변경과 packet 재결합은 구현 중 실제 발견한 경계 결함이다. 원 로그는 덮어쓰지 않았다.

- 초기 RED: `/tmp/nomorevibe-pr04c2-item-journal-b-initial-red-20261016.log`.
- 초기 source/driver 보존: `...-b-baseline-runner-20261016.ts` SHA `e4896dca396d122b1d1907ae256b14a755108be5f66052e67ec14116ad54577a`, `...-b-baseline-driver-20261016.ts` SHA `3c75f9bfc75c42c68319603c3a6899226c3b8310b24ccd9d1749a5eed3bed1e3`.
- expiry RED: `/tmp/nomorevibe-pr04c2-item-journal-postflush-expiry-canary-red-20261016.log`; 원복 당시 execution SHA `f454870821f9891a4c0e071b36804f6b177666c0c09019429ea5134629c0d639`.
- mutable RED/GREEN: `/tmp/nomorevibe-pr04c2-item-journal-mutable-input-{red,green}-20261016.log`; 원 source/driver `/tmp/nomorevibe-pr04c2-item-journal-mutable-input-{source-before,red-driver}-20261016.ts`.
- packet RED/GREEN: `/tmp/nomorevibe-pr04c2-item-journal-packet-binding-{red,green}-20261016.log`.

## 최종 실제 실행

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55521/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/pipeline-replay-item-journal.test.ts
npx vitest run tests/pipeline-replay-item-execution.test.ts tests/pipeline-replay-artifact.test.ts tests/pipeline-replay-final.test.ts tests/pipeline-replay-final-wall.test.ts tests/pipeline-replay-runner.test.ts tests/review-fixture-transport.test.ts tests/second-review-transport.test.ts tests/second-review-item-lifecycle.test.ts
npx tsc --noEmit --incremental false
git diff --check
```

- 신규 통합 **14 PASS/99.70s/exit0**: `/tmp/nomorevibe-pr04c2-item-journal-fourteen-final-20261016.log`.
- 관련 8 unit 파일 **180 PASS/1.16s**: `/tmp/nomorevibe-pr04c2-item-journal-scoped-unit-final-snapshot-20261016.log`.
- whole tsc/명시 변경 source·test 19파일 scoped ESLint/diffcheck actual0. 로그: `/tmp/nomorevibe-pr04c2-item-journal-{static,scoped-lint}-final-snapshot-20261016.log`. root의 선행 `next typegen`을 재사용했고 build는 실행하지 않았다.
- 통합은 legacy v1 seal, full 독립2slot/historical release, root 실패→fallback, cancelled final0, run-row 실제 wait/expiry whole rollback, healthy foreign owner/forged token, admission close, final0 duplicate call authority, caller mutation, source/stage/non-AI2 DML, 양쪽 fence 선점과 candidate NOWAIT/late mutation0을 확인했다.
- pure mixed 회귀는 전역 ordinal/full OLD/입력 불변, 1µs foreign item expiry boundary, explicit gap unknown을 확인했다.

## 실패 접근과 해결

- 초기 구현 SQL42P18(txKey의 jsonb_build_object 형식 미지정), artifact↔mixed import cycle은 구현 연결 오류로 분류했다. 명시 text cast와 기존 timestamp helper의 독립 leaf 이동으로 해결했다. 기능 RED에 합산하지 않았다.
- 독립2slot 회귀가 초기에 기본20s를 넘었다(5 PASS/1 timeout). timeout을 늘리지 않고 상태/expiry 구간별 target 계산 cache 및 strict parse의 중복 coverage 계산 제거로 같은 assertion을 통과시켰다. 최종 해당 case는 20s 아래다. cold/대규모 성능을 입증한 결과는 아니다.
- sentinel document fixture의 repo_meta 누락은 setup23502, fixture RowList/union narrowing은 타입 오류였다. 의도한 기능 RED가 아니다. 실패 fixture가 만든 정확한 candidate27/repo 하나만 ID+repo CAS로 정리했다.
- 초기 fixture가 남긴 자기 job observations2는 후속 raw baseline으로 보존되어 있었다. candidate26 provenance/정확한 원 raw/key를 확인하고 동일 row 조건으로 두 행만 삭제했다. 일반 foreign 행을 삭제하거나 원 permit 종료 증거를 만들지 않았다.

## 동결 SHA와 정리

- execution `91de6660d5fd951cab7b60bb39c0b559c0604a6479c3fae6ba9a02e8baa6b3fd`.
- mixed evidence/coverage `6a766b5ba437dea2dc4fdbf0ce76001b927b91c82d4e8591fa8f0e74eb66c7ff`.
- ledger `8c6028375cae29203f7417169f93e3fac0a173e88bc6d2c191c370322f007b87`.
- 14-case driver `f9db8cef2a5737bff6a845616b8f21d6f9706d5ef32481b8627dac6452e483da`.
- 전체 변경 source/test20개 SHA: `/tmp/nomorevibe-pr04c2-item-journal-final-source-manifest-20261016.json`.
- 최종 raw readback: `/tmp/nomorevibe-pr04c2-item-journal-final-zero-readback-20261016.json`. candidate/doc/attempt/vote/item/settings/jobs/observations/CDN/schema/role/handler trigger/타 연결 모두0, 3stage legacy/epoch1/contract0 및 원 updated_at 유지. foreign candidate/document µs sentinel과 전체 원 row 비교는 실제 afterAll TX에서 통과했다. PUBLIC ACL은 기존 bootstrap helper의 effective ACL 원복 검증을 사용하며 NULL→명시 default 표현을 수동 변경하지 않았다.
- observation 정리 전 raw와 exact 삭제 결과는 각각 `...-final-readback-20261016.json`, `...-owned-observation-cleanup-20261016.json`에 보존했다. root만 DB/container STOP/삭제한다.

## 남은 검증·명확한 제한

Root 최종 직접 검토: production 변경과 신규 mixed reducer/authority validator, 원 driver/최종556행·fixture62행·pure54행, 실제 RED/최종 로그와 20파일 SHA를 대조했다. C 교차 리뷰의 mutable 입력 경계와 B 자체 packet binding 경계는 위 실제 회귀로 닫혔고 추가 production P1/P2는 확인하지 않았다. fixture에서 baseline 수집 중 setup이 실패하면 복원할 원 행 없이 cleanup DML이 실행될 수 있어, 원 baseline을 전부 확보한 뒤에만 cleanup하도록 captured guard4행을 추가했다. 이 보강 뒤 기존 legacy control만 **1PASS/13skip8.24초**, 해당 파일 ESLint와 diffcheck actual0이다(`/tmp/nomorevibe-pr04c2-root-fixture-guard-control-20261016.log`). 앞선14개 전체를 다시 실행한 것으로 집계하지 않는다. 최종 driver SHA는 `6f9be6160da6afcbce4c593c9705d5fcd5641a5419a38f8136e1c056831a10f5`, 다른19개 manifest SHA는 일치한다.

Root 독립 readback은 모든 counts0·원 stage µs·ACL을 담당 최종 JSON과 exact 비교해 통과했다. `/tmp/nomorevibe-pr04c2-root-final-readback-20261016.json`. 타 연결0 뒤 exact55521 container를 정상STOP하여 exited0/OOMfalse를 확인하고 own container/volume만 제거했다(`/tmp/nomorevibe-pr04c2-root-cleanup-20261016.json`). 55521 재접속/재생성 및 다른 자원 prune은 하지 않는다.

새 published/tokenless item 실제 fixture, 실제 wire COMMIT-ack loss 주입, 실 provider/native total-cap/terminal, durable 외부 종료, 모델 슬롯 전 caller 적용, 독립 consumer 운영 활성, 30분 baseline/2배 성능은 이번 실행으로 증명하지 않았다. 기존 provider unsupported guard·모델·quality·TTL·timeout은 완화하지 않았다. v1/v5와 v2/v6은 다른 비교 계약으로 식별되며 성능 합격으로 섞지 않는다. 전체 통합검사는 사용자 지시대로 나머지 PR 개발 종료 후 root가 수행한다. root는 최종 source/driver/원로그 직접 리뷰와 최신 main 정상 통합/Git/handoff 갱신을 담당한다.

## 제출 후 CI import 수정

첫 PR453 CI38833138711 quality에서4suite 수집 실패를 확인했다. readiness→settings→db→replay-scope→execution의 eager item-execution import가 readiness 초기화 전에 schema.extend를 호출하는 실제 순환이었다. B가 동일4suite 로컬 collection4FAIL/0tests→runtime4exports를 필요한 async5지점 dynamic import로 이동→동일521PASS/12.48초를 확인했다. strict artifact/mixed2files42PASS/1.29초, tsc/scopedlint0이다. production execution 한 파일6hunk만 변경, 나머지본문·SQL/권한/정책/기존test는 byte동일이다. 최종 execution SHA `3b384abf1dced84622ba9babddcb0ddd9c9f757bc1aaf8fb09d9a0fce869a817`.

원 CI integration1은 reporter source-map 오류가 원 child 오류를 가려 원인미확정이다. 별도 새55527에서 같은 CLI1case만 실제1PASS/5skip14.97초 확인했고 필수CI 재검증을 기다린다. root는 diff/보고/로그를 직접 읽고 독립82table data/rawµs readback·roles/functions/triggers/schema/columns/settings exact를 확인했다. ACL NULL→명시default 표현차이는 그대로 보존했으며 whole raw exact로 주장하지 않는다. exact own 정상STOP/exited0/OOMfalse/container+volume 제거 완료. report `/tmp/nomorevibe-pr453-b-cycle-fix-final-report-20261016.md`, root `/tmp/nomorevibe-pr453-root-cycle-{readback,cleanup}-20261016.json`. 전체수동suite 반복0/운영활성0.

## 최신 CI timeout 관측을 위한 test-local 진단

CI38836817519는 첫 legacy v1을 포함한 journal6case가20초 timeout이고 같은 파일의 manual/control8개는 성공했다. 새55530의 기존 legacy1 단독은1PASS/13skip8.91초·PG blocker0였으므로 실제CI 최초정지와원인은 미재현이다. root는 agent와독립readback exact/잔류8종0/otherconn0을확인후55530을 정상STOP/exited0/OOMfalse/ownvolume제거했다.

기존fixture await를 고정 stderr begin/end/reject로 관측하는 한파일 최소진단을 추가했다. 쿼리·자격증명·env·오류원문은출력하지않고 SQLSTATE와고정 operation/relation만 허용한다. native API Promise를 그대로 반환하고 Drizzle lazy query3개는 async factory에서1회만 assimilate한다. prepare의 track/lifecycle·SQL·권한·timeout·기대는 바꾸지 않았다. AST 정규화 대조에서 원14test/78expect/82SQL/6runner인자/31imports 동일, scoped ESLint/TypeScript actualexit0이다. root도 전체diff/요약경계/실행정산구조를직접읽었다.

새진단 자체의 DB실행·Vitest·stderr 실제가시성은 이번에 검증하지 않았고 CI 원인해결로기록하지않는다. `/tmp/nomorevibe-pr453-a-permanent-diagnostic-report-20261016.md`, `...diagnostic-conformance...json`, `...permanent-diagnostic-checks...json`에정확결과를보존했다. driver SHA988e188608c952091be7d1ae960ac28f9786e7774098e3746f784da5b25f410f. 수동전체검사는 모든PR개발종료후 최종통합에서만진행한다.
