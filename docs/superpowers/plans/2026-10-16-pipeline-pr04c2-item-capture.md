# PR04c-2a-1 — 전체 stage/item의 단일 statement capture

사용자가 승인한 PR별 배타 병렬 개발을 잇는다. gpt-6.1-sol/xhigh A/B/C와 root가 아래 파일/DB만 소유한다. root는 실제 행동 RED·직접/교차 코드리뷰·전체 gate·Git을 관리한다.

## 현재 기준과 고정 범위

선행 pure state PR445/head `28ab994084c2749397fef4cc8e42279290b5269b`, PR CI38800981283 필수check 전체SUCCESS 뒤 actualmain e11fa51c675924b54b0490512c10f43c8102c34f로 정상병합했다. source item-state SHA01d06f0daf4a284aa68e320e0da51ec92e5dfe438e22566c68f11c8fe23221f2를 동결한다. 새 WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-item-capture`, branch `codex/pipeline-pr04c2-item-capture-20261016`, base28ab9940. actualmain 정상통합 HEADcf863f7c를 확인했다. 원본X branch push금지/최신handoff만동기화.

이번에는 production 신규1파일 `lib/operations/pipeline-replay-item-capture.ts`에 다음 API 하나만 추가한다.

```ts
export async function captureReplayItemState(tx: postgres.TransactionSql):
  Promise<{ state: ReplayItemState; stateHash: string }>;
```

입력은 caller가 소유한 실제transaction 하나다. connection/transaction/env/global DB/provider/owner·run·universe filter/ready flag/임의callback/validator를 새로 만들거나 받지 않는다. 한 literal SQL SELECT statement에 `public.pipeline_stage_modes`, `public.pipeline_item_leases`의 **전체** `to_jsonb(row)`를 두 scalar aggregate로 담아 고정 kind/version/tables payload를 만든다. empty item aggregate는 []다. LIMIT/WHERE/DISTINCT/owner별 부분집합0, dynamicidentifier/unsafe callerSQL0, item/domain/job/advisory/run rowlock0. PostgreSQL SELECT relation lock은 정상적으로 따른다.

기존 `canonicalReplayItemState`와 `replayItemStateHash`만 재사용하여 `{state,stateHash}`를 반환한다. unknown/missing SQL열·binding·owner·stage구조는 기존 strict모델에서 fail-closed한다. rawtimestamp to_jsonb문자열을Date로 hydrate하지 않고 µs가능 텍스트를 그대로 정규화한다. 실제 stage/item은 precision3이다. SQL/취소/권한/strictparse 원오류를 catch하여 empty/default/success로 바꾸지 않는다. no-row/잘못된result는 정상state가아니므로fail-closed한다.

두 aggregate는 같은 statement의 MVCC snapshot이다. capturedAt/commitAt/live/ready/verified handle/실행receipt/authority/coverage/성능을 반환하지 않는다. 반환시점 현재값·commit확인·기존v1 domain projection과 원자적인 combinedsnapshot을 증명하는 API도 아니다. 기존 v1/readiness/artifact/profile/ledger/entry/SQL/공개migration/genericitem/domain/result/provider/registry/consumer 모두 byte변경0이다. 특히 v5 immutable과 itemreplay 차단을 유지한다.

## 배타 파일·DB

| 담당 | 쓰기 허용 파일 | DB |
| --- | --- | --- |
| A /root/pr01_final_ai1 | NEW lib/operations/pipeline-replay-item-capture.ts + NEW tests/pipeline-replay-item-capture.test.ts | 없음 |
| B /root/pr01_final_ai2 | NEW tests/pipeline-replay-item-capture-adversarial.test.ts만 | 없음 |
| C /root/provider_contract_evidence | NEW tests/integration/pipeline-replay-item-capture.test.ts만 | 55511 / nomorevibe-pr04c2-capture-db-20261016 |
| root | handoff/delivery/이계획/새validation docs4·Git·전체리뷰 | 필요시별도55512 |

A는 API가 있는 실행가능 최소scaffold와 자신의 실제unit RED를 먼저 만들고 **source/unit동결**을 통보한다. B/C는 같은baseline에서 누락된 canonical/hash/fullrow/오류전파 등을 실제expected/received 행동으로 검출한다. import/API/SQL/setup실패를 기능RED로세지 않는다. root가 원driver/log/exit를 수용한 뒤 A의 두파일만 동결해제한다. B/C 독립기대값은 수정하지 않는다. 정상 literal SQL/원rawparser를 갖고 canonical/hash가 빠진scaffold는 가능하나, 의도적인SQL오류나API부재를RED로대체하지 않는다.

## 검증 계약

A: raw fullpayload→동일canonical/hash, emptyitems, output/input 독립성을 단위에서 검증하고 같은driverGREEN, whole tsc/scopedlint·SHA를 반환한다. B는 한statement execute·전체row보존·순서/offset·hash결합·입력복제·불완전/알수없는열·SQL/취소원오류전파·invalidDBresult fail-closed를 독립검증한다. 단순SQL문자열 snapshot만으로 MVCC를 증명하지 않는다.

C는 pinnedPG17 `pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`, loopback55511/dummy nomorevibe:nomorevibe/nomorevibe_test만 생성한다. root가 lsof exit1/출력없음으로 포트미사용을 확인했다. 기존DB/forensic/image/cache/전역prune0, test20초/hook60초 기본값 유지. genericclaim은90초, capture범위에서 새heartbeat/TTL성능실험0이다.

- actualSQL stage6/item12열 전체·실제genericclaim/renew/원receipt release·외부/과거released 행을 독립SQL UTC/`COLLATE C` 결과와 비교한다. SQL known열추가/누락은strictfail이다. 101개 이상을 직접capture하여uncapped를검증한다.
- 실제 `handlers-v5` 제한connection의 SELECT 성공 및 원role/profile/ALWAYS immutable·sourceDML거절 control을 확인한다. owner SELECT만으로 profile권한을증명하지 않는다. v5에서는item DML을열지않는다. 기존지원하지않는itementry는그대로거절이다.
- profile 설치 **전** paired stage/item 변경을 한bootstrap TX에서 수행하고, 미commit oldpair/commit뒤 newpair를capture해 실제MVCC control을둔다. fullrow 및hash를 대조한다. transient row/advisory lock 상태를 ready로판정하지않는다. profile설치뒤owner도immutable을우회해쓰지않는다.
- 실제 SELECT가 owned tablelock에 대기함을 pg_blocking_pids로 확인하고 정확자기backend 취소→원SQLSTATE57014/실패전파를검증할수있다. 잠금holder/promise는finally release·drain한다. SQL오류를fallback으로숨기지않는다.
- role/profile teardown은 실제작업 Promise 정산 뒤 verified release→raw복원 순서다. 원stage/관리행/권한/외부행 whole rawµs snapshot을 보존하고 ownexactkeys만정리한다. 모든stage raw·relation/column/PUBLIC ACL/defaulttimeout·schema/role/trigger/함수/잔류/타연결0 readback→STOP/exited0/OOMfalse를 반환한다. root별gate 잔류는출처/전체snapshot사전검증 뒤 정확키로만정리한다.

historical expired/stale raw행은 읽는상태 대조이며 그런 임의token을 actualAI2/domain/호출권한의 양성증거로사용하지않는다. 실제claim/renew/release 양성control의token/owner는genericAPI로만발급한다.

root는 production1/단위2/통합1 직접리뷰+B→A/A→C 읽기교차리뷰, 기존trackedsource/v1 byte0, 전체unit/관련DB/정적·필수CIwhole검증을취합하고 featurecommit/push/PR/normalmerge/mainCI를실제확인한다. 운영deploy/DDL/inference/발굴재개는 이번범위0, 기본legacy/epoch1/contract0·새consumer비활성이다.

## 선행 CI와 이후 범위

PR444 mainbcf4396e 첫CI38799565167는 기존thumbnail5초timeout1 및 기존certifiedwall healthy20초timeout→cleanupguard잔류147FAIL을기록했고, 같은SHA 실패job 재실행중이다. timeout/config/source완화0. `/tmp/nomorevibe-pr04c1b-ci-timeout-diagnosis-20261016.md`는 test-local 원exercise Promise 정산후profile release/fixture복원 순서의 잔여문제를기록한다. 재시도성공과 최초지연원인확정을혼동하지않는다.

후속은 uncapped 실제domain+item combinedsnapshot/actualclaim selector differential→journal/coverage→불변version/profile→actualauthority/finalwall→고정AI1legacy+AI2itemrunner다. 아직없는itemconsumer의정책을pendingSecondReviews LIMIT에서추정하지않고, snapshot만으로순간SKIPLOCKED경합을ready인증하지않는다. itemB5/provider실30분baseline/2배/OracleDR는미완료, 소단위완료로전체goal을종료하지않는다.

## 실행 중 조정 — 독립 baseline 보존

B는 반복CI실패정산을 별도WT에서먼저담당했다. root가 A/C의actualbehaviorRED를수용한뒤A구현을해제했다. B검증은원d924sourcebytes를보존한별도detachedWT `/Users/jr/Desktop/projects/nomorevibe-pipeline-item-capture-baseline`/actualmaine11에서진행한다. B동결driverbytes를같은경로에복사하여baselineRED→현재captureGREEN을비교하며현재source를stub으로교체하지않는다. BRED가먼저실행됐다고소급기록하지않는다.
