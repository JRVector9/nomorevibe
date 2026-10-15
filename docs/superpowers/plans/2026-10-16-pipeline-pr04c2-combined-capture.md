# PR04c-2a-2 — domain/item 단일 statement snapshot

사용자 승인 PR별 배타 병렬 개발을 계속한다. root는 실제 행동 RED·직접/교차 리뷰·검증·Git을 취합하고 A/B/C는 고정 파일·DB만 소유한다. 모든 모델은 gpt-6.1-sol/xhigh다. 착수 기준은 item capture feature ee6bc242/선행 PR446 main1fa994d2다. 이후 item capture PR447은 main820f7fe7로 병합됐고 두 main CI/image 모두 성공했다. 이 feature는 최신 main820f7fe7을 정상 통합했다. 운영 배포·DDL·provider inference·새 consumer 활성화는 이 단계에 포함하지 않는다.

## 문제와 고정 API

현재 domain v1 capture는 여러 SELECT를 사용하고 item capture는 단일 SELECT를 사용한다. READ COMMITTED transaction 안에서 두 함수를 차례로 호출해도 그 사이 commit으로 실제 존재하지 않은 domain/item 조합이 생길 수 있다. 새 모듈은 두 상태와 DB frozen universe를 **한 SELECT**에서 읽는다. 기존 v1 helper/ledger/profile/entry/source/권한은 byte변경0으로 유지한다.

신규 production 파일은 `lib/operations/pipeline-replay-combined-capture.ts` 하나다. 공개 API는 다음 함수와 반환 type만이다. 새로운 canonical/hash/reducer/ready export를 이 단계에서 만들지 않는다.

```ts
export type ReplayCombinedState = {
  kind: "pipeline-replay-combined-state"; version: 1;
  domain: ReplayReadinessProjection; items: ReplayItemState;
};
export async function captureReplayCombinedState(
  tx: postgres.TransactionSql, manifest: CapacityManifest
): Promise<{ state: ReplayCombinedState; stateHash: string }>;
```

- 입력 manifest는 기존 `parseCapacityManifest`로 검증한다. caller의 transaction만 사용하고 connection/transaction/env/globalDB/provider/callback/별도 SQL을 받거나 생성하지 않는다. invalid manifest는 SQL 전에 실패한다.
- 한 고정 literal SQL SELECT가 alias `state`로 strict envelope를 반환한다. domain.version=1/referenceTime은 검증한 manifest의 값, universe는 해당 run의 `pipeline_replay.capacity_inputs` 전체 raw frozen 입력에서 만든다. candidateId/inputHash/sourceRevisionHash/frozenInput/frozenHash 및 frozenInput.policyHash를 담고, 정확한 manifest.inputs 구성 및 각 policyHash=manifest.inputPolicyHash를 확인한다. 누락/추가/중복/다른policy·frozenhash는 fail-closed다. caller가 frozen 입력을 대체하는 옵션은 없다.
- domain.tables는 기존 v1 공개11개 테이블 전체와 해당 run의 capacity_calls 전체다. item.tables는 모든 stage/item 행이다. 각 aggregate는 `jsonb_agg(to_jsonb(row))`/empty []로 모든 SQL 열과 외부·과거·released 행을 보존한다. universe와 calls의 run_id 필터 외에 domain/item의 owner/run/universe/expiry/status/limit 필터는 없다. referenceTime/runId 값은 parameter로만 전달한다. dynamicidentifier/unsafe/row·job·run·advisory lock/새 authority는 없다.
- private strict envelope schema는 고정 kind/version과 기존 ReplayReadinessProjectionSchema/ReplayItemStateSchema를 사용한다. 기존 공개 `applyReplayChanges(domain, [])`의 순수 경계로 domain 전체 정규화/복제/frozen 검증을 재사용하고 `canonicalReplayItemState(items)`를 재사용한다. v1 private 함수 복제/기존 export 확장0이다. canonical된 전체 envelope의 `reviewHash`가 stateHash다. output key는 state/stateHash 둘뿐이다.
- Array/exact1 결과를 검사한다. SQL/57014/권한/parse/frozen 오류를 catch하여 성공/empty/default로 바꾸지 않는다. no-row/잘못된 shape는 실패다. 원본 input/manifest/SQL rows를 변경하지 않고 새 nested state를 반환한다.
- 이 함수는 전체 read snapshot이다. 기존 captureReplayReadinessProjection의 현재 source/frozenInput 일치 검사를 대체하지 않으며 현재 logical eligibility·transient lock·ready/live·authority·capturedAt·commitAt·coverage·인증 artifact를 발급하지 않는다. domain frozen의 referenceTime 검증과 실제 반환시점 최신성은 별개다. 기존 v1 artifact/parser/handlers-v5·item 실행 차단은 유지한다.

## 배타 파일·DB

| 담당 | 쓰기 허용 | DB |
| --- | --- | --- |
| A /root/pr01_final_ai1 | NEW lib/operations/pipeline-replay-combined-capture.ts + NEW tests/pipeline-replay-combined-capture.test.ts | 없음 |
| B /root/pr01_final_ai2 | NEW tests/pipeline-replay-combined-capture-adversarial.test.ts | 없음 |
| C /root/provider_contract_evidence | NEW tests/integration/pipeline-replay-combined-capture.test.ts | 새55515 / nomorevibe-pr04c2-combined-db-20261016 |
| root | 이 계획/새validation/handoff/delivery·Git·전체리뷰 | 필요시 별도 |

A는 정상 literal SQL/API/private strict envelope를 가진 runnable scaffold와 실제 자기 unit RED를 먼저 만들고 source/unit을 동결한다. canonical/hash 누락의 행동 RED는 가능하나 import/API/SQL/setup 실패는 RED가 아니다. B/C가 같은 source에서 독립 driver의 actual behavior RED/control을 제시하고 root가 원로그·source·driver·exit를 읽어 수용한 뒤에만 A 구현을 해제한다. 기대값/시간/정책을 바꿔 GREEN으로 만들지 않는다. B/C의 최초 driver bytes를 보존한다.

## 의미 있는 검증

A/B: 전체 domain+item fullrow/각 부분과 envelope hash 결합·정렬/offset/µs·동일값 표현·clone, 한 literal statement와 정확 parameter 경계, malformed manifest 0query, DB universe의 누락/추가/중복/다른hash/policy·frozen tamper, 101+전체범위, SQL/취소 원오류, invalid result fail-closed. 기존 v1/verified artifact로 받아들여지지 않음을 확인한다. SQL mock만으로 MVCC/실제 권한을 증명하지 않는다.

C: pinned PG17 `pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`, loopback55515/dummy 전용 DB만 생성한다. root lsof가 port미사용(exit1/출력0)을 확인했다. repo migration0058의 jitoff를 포함한 기본설정·test20초/hook60초·generic90초를 유지한다. 다른DB/volume/image/cache/forensic/globalprune0이다.

- 실제 ReviewInput/manifest/DB capacity_inputs와 full domain rows·실제 generic item receipt를 사용한다. 독립 raw SQL/readback과 기존 공개 pure normalizer의 재사용 범위를 구분하며 새 query가 한 snapshot이라는 부분을 검증한다. synthetic token을 domain/실행권한의 양성 증거로 쓰지 않는다.
- profile 설치 전 한 실제 bootstrap TX가 domain row와 item row를 함께 바꾸도록 barrier를 둔다. capture는 uncommitted old/old와 commit 뒤 new/new만 반환하고 full state/hash가 각각 일치한다. 단순 두 SELECT 사이에 commit을 넣으면 old/new가 섞이는 대조는 hazard 증거이며 새 implementation의 행동 RED와 구분한다. 실제 query 분할 mutant를 검증하지 않았다면 그 증거를 주장하지 않는다.
- 실제 handlers-v5 제한 session SELECT/control과 기존 ALWAYS immutable/sourceDML·item entry 거절을 유지한다. 새 SELECT 때문에 role/profile 권한을 넓히지 않는다. frozen universe 누락/불일치/외부 run/calls/전체 외부 item과 SQL열을 실제 DB로 대조한다. actual tablelock/정확 자기backend 취소57014를 확인할 수 있다.
- 모든 test/초기화의 실제 Promise를 추적하고 hook에서도 실제 allSettled 뒤에만 registry에서 삭제한다. task·writer/holder가 끝난뒤 verified profile 정상해제→raw복원, 종료오류까지 합산한다. framework timeout이 원async body를 취소한다고 가정하지 않는다. whole rawµs·effective PUBLIC/relation/column ACL·원stage·외부행을 보존하고 ownexactkeys만정리한다. readback/STOP/exited0/OOMfalse를 반환한다.

root는 source1/unit2/integration1 직접리뷰 및 B→A/A→C 교차리뷰·원 driver 동일GREEN·전체unit/정적·관련DB·필수CI를 취합하고 featurecommit/push/PR/정상merge/mainCI를 확인한다. 이 단계로 PR01전체/실30분baseline/2배/OracleDR가 완료되는 것은 아니다. 다음은 target-ID actual claim differential, item journal/coverage, 새version/profile/실authority/finalwall·혼합runner다. queue-wide selector가 현재 없다는 사실을 유지하고 legacy pendingSecondReviews LIMIT를 새 정책으로 복사하지 않는다.
