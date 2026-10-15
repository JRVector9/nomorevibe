# PR04c-1b — 비활성 AI2 한 item 실행 관리

> Agentic workers: root가 배타 파일·DB, 단계별 RED 수용·코드리뷰·Git을 관리한다. 사용자가 병렬 실행을 지정했다. 이 환경의 collaboration API로 A/B/C를 실행하며 제공되지 않은 skill namespace는 호출하지 않는다.

**Goal:** 기존 실제 item claim·renew·transport·결과 writer로 한 건을 실행하고, 외부 Promise 정산 전에는 소유권을 반납하지 않는다.

**Architecture:** 원래 receipt를 내부에 보관한다. 짧은 DB transaction 밖에서 기존 adapter Promise를 await하고, 진행 중에는 고정90초 lease를15초 간격의 비중첩 loop로 연장한다. transport와 진행 중 renew가 정산된 뒤 기존 결과 writer를 최대1회 호출한다. registry/consumer와 연결하지 않는다.

**Tech Stack:** TypeScript, AbortController, PostgreSQL17/Drizzle, Vitest. 기존 lease/schema/품질/provider timeout을 유지한다.

## 기준과 범위

base `af4df25a09a056937d9ddc5c9c5d82b9a2268795`는 c1a PR443의 동결 feature다. PR443 필수CI 성공·정상 main 병합 뒤 actual main을 확인·통합하고 이 PR을 제출한다. WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-ai2-item-lifecycle`, branch `codex/pipeline-pr04c-ai2-item-lifecycle-20261016`. root만 Git/docs를 편집한다. 전원 gpt-6.1-sol / xhigh.

기본 legacy/epoch1/contract0, 새 consumer 비활성, 현재 모델/품질/발굴 중단을 유지한다. 운영 deploy/DDL/provider inference/발굴 재개0. migration/profile/grants/evidence version/registry/worker/CLI/input loader/result writer/generic item 저장소는 변경0. c2 item B5와 PR05/07 durable physical-call admission·종료는 별도다.

## 고정 공개 계약

```ts
import type { ItemOwner } from "@/lib/jobs/items/types";
import type { SecondReviewWriteResult } from "./second-review";
export type SecondReviewItemOutcome =
  | { state: "skipped"; reason: "stage_inactive" | "not_pending" | "input_changed" | "running" | "aborted" }
  | SecondReviewWriteResult;
export function executeSecondReviewItem(input: {
  secondReviewId: number; owner: ItemOwner; signal?: AbortSignal;
}): Promise<SecondReviewItemOutcome>;
```

- entry에서 id를 positive safe integer, owner를 기존 itemOwnerSchema로 parse하여 snapshot한다. caller receipt/model/result/TTL/interval/ready/validator callback/env를 추가하지 않는다. pre-aborted는 claim/transport0, skipped/aborted다.
- actual claimItemSecondReview(id,owner,STALE_LOCK_MS=90000), claimed+item receipt만 실행한다. skipped는 그대로 반환한다. 공용 타입의 admitted/non-item은 invariant 오류다. 원 token/owner/boot/epochs/binding은 내부 고정, renew 결과로 교체하지 않는다.
- caller abort와 owner-loss signal을 transport에 전달한다. caller abort는 heartbeat stop이 아니다. abort를 무시하는 실제 transport가 남아 있으면 정상 owner renew를 계속한다.
- heartbeat는 cancellable15초 delay→실제 renew await→다음15초 delay다. 한 renew만 존재하고 지연된 tick을 몰아 실행하지 않는다. renew null은 loss를 latch·internal abort·추가 renew0, 실제 transport 정산까지 기다린다.
- transport가 resolve/reject한 뒤 동기 stopping→delay취소→현재 renew/loop await를 끝내고 writer에 진입한다. writer 중/반환 뒤 background renew0. 독립 Promise.race나 early release0.
- 예상 밖 transport reject는 정확한 원예외를 보존하고 writer/release/failure/fallback/request0. 예상 밖 renew throw는 abort요청→transport 실제정산→loopdrain 뒤 원 renew예외, writer/release/failure0. 둘 다면 transport 원예외 우선이다. 구조화된 adapter error/timeout과 합치지 않는다.
- 구조화 result가 있고 unexpected renew오류가 없으면 기존 writer를 최대1회 호출한다. caller abort/ownerloss/adapter cancelled면 cancelled로 정산하되 실제 stale writer의 거절을 성공으로 숨기지 않는다. 나머지 success/failure projection은 기존 handler와 같다. writer 오류는 원예외, finally 별도 release/cleanup/claim0.
- 기존 writer의 recorded/input_changed/not_pending/cancelled를 그대로 반환한다. cancelled가 current-invalid보다 먼저라 input변경 뒤 취소는 pending 유지+ownrelease이며 superseded라고 보고하지 않는다. mode-independent controller 자체는 존재하지만 현 legacy handler가 items에서 controller 전에 종료하므로 자동 cleanup loop가 이미 실행된다고 주장하지 않는다. PR06 후속 연결이 필요하다.

## transport 최소 추출

NEW `lib/crawl/second-review-transport.ts`에 다음 고정 API만 추가한다.

```ts
import type { ReviewInput } from "./agent-review-contract";
import type { AgentReviewResult } from "./agent-review";
import type { ReviewFixtureCallBinding } from "./review-fixture-transport";
export type SecondReviewTransportBinding = Extract<ReviewFixtureCallBinding, { stage: "second" }>;
export function secondReviewTransportTimeoutMs(provider: SecondReviewTransportBinding["provider"]): number;
export function dispatchSecondReviewTransport(binding: SecondReviewTransportBinding, input: ReviewInput,
  options: { timeoutMs: number; signal?: AbortSignal }): Promise<AgentReviewResult>;
```

fixture call을 먼저 await하고 undefined만 기존 provider adapter로 보낸다. timeout은 원 상수 gateway60000/grok90000/CLI20000을 재사용한다. 새 catch/race/adapter주입/authority를 추가하지 않는다. 원 adapter3·fixture module·prompt/CLI argv/model/reasoning/usage/validation/transport timeout은 byte 변경0. legacy handler는 import·timeout선택·기존 measureReviewCall 내부 표현식의3영역만 변경한다. admission/controller/budget/telemetry/cancelwriter/counters/continuation/4lane108초FETCH24는 보존한다.

binding은 actual row의 stage=second,candidateId,nullable firstAttemptId,secondReviewId,generationKey,vote=fallbackForId??id,provider,model과 actual input이다. null을0으로 바꾸지 않는다. caller receipt는 transport 밖에 둔다.

## dispatch 전 고정 관찰

A에게 `lib/crawl/second-review-ownership.ts`의 export item receipt type와 **observeSecondReviewItemDispatch(receipt)** 추가만 허용한다. 기존 claim/renew/assert/finish/body는 보존한다.

```ts
export type SecondReviewItemReceipt = SecondReviewReceipt & {
  ownership: { kind: "item"; lease: Ai2ItemLease };
};
export type SecondReviewItemDispatchObservation =
  | { kind: "current"; row: SecondReview; input: ReviewInput }
  | { kind: "stopped"; reason: "stage_inactive" | "not_pending" | "input_changed" };
export function observeSecondReviewItemDispatch(receipt: SecondReviewItemReceipt): Promise<SecondReviewItemDispatchObservation>;
```

기존 strict receipt/rejectItemReplay와 lockPipelineInputStages→lockSecondReviewDomain→actual row→assertSecondReviewOwnership/secondReviewBinding을 재사용하는 짧은 자체 TX다. S3→published lifecycle/product→candidate/document/settings/evidence/first→root/votes→original item의 기존 순서를 지킨다. DML/새 receipt/새 binding0. original identity/actual owner가 다르면 throw, current null/binding차이/not_pending/items계약 외는 stopped다. draining-from-items는 기존 owner renew/settle은 허용하고 새 dispatch는 stopped다. stopped 뒤 실제 cancelwriter로 원 owner만 정산하고 writer 실제 state를 반환한다.

관찰 성공과 network 호출 사이 race는 남는다. durable permit/외부 종료 proof가 아니며 network를 DB transaction에 넣지 않는다. renew가 current null을 무시하는 기존 의미는 변경하지 않는다.

## 배타적 담당

| 담당 | 편집 가능 파일 | 자기 전용 DB |
| --- | --- | --- |
| A /root/pr01_final_ai1 | NEW lib/crawl/second-review-item-lifecycle.ts; lib/crawl/second-review-ownership.ts의 위 observer/type만; NEW tests/second-review-item-lifecycle.test.ts | 55505 / nomorevibe-pr04c1b-source-db-20261016 |
| B /root/pr01_final_ai2 | NEW lib/crawl/second-review-transport.ts; lib/crawl/jobs/second-review.ts의3영역; NEW tests/second-review-transport.test.ts | 55506 / nomorevibe-pr04c1b-transport-db-20261016 |
| C /root/provider_contract_evidence | NEW tests/integration/second-review-item-lifecycle.test.ts만 | 55507 / nomorevibe-pr04c1b-lifecycle-db-20261016 |
| root | docs4·필요한 기존fixture적응·Git·최종gate | 필요시55508 / nomorevibe-pr04c1b-root-db-20261016 |

각자 pinned PG17 `pgvector/pgvector@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`, loopback/dummy nomorevibe:nomorevibe/nomorevibe_test만 사용한다. 현재 port는 미사용임을 root가 확인했다. own prefix/관리행 raw µs 복원·roles/schema/다른 connection0 readback 뒤 STOP한다. forensic77/failed81·타 사용자DB55445–55450/운영/다른 image/cache 접근·변경0, broad prune0. Docker 여유 경고는 즉시 root에게 보고한다.

## 실행 순서와 RED gate

- [x] B: 기존 transport 회귀를 읽고 newmodule의 route/fixture우선/동일options·input·throw전파 테스트를 먼저 준비한다. 실행 가능한 최소 경계에서 기대 행동 FAIL을 확인하고 최소 추출→같은 테스트·기존 handler/fixture GREEN을 확인한다. import/setup 오류는 행동 RED가 아니다.
- [x] A: unit 선행으로 API/skip/observer/정산을 검증하고 **heartbeat0 실행 가능한 최소 scaffold**(actualclaim→observer→같은transportawait→기존writer)까지만 구현·동작확인→source 동결을 root에 보고한다. 아직 heartbeat를 구현하지 않는다.
- [x] C: scaffold/helper 동결 뒤 짧은 actual control과 **original 90-second expiry** 단일 case를 실행한다. 실제 DBclock이 원 claim90초 expiry를 넘길 때까지 기다려 oldscaffold가 recorded를 달성하지 못하는 행동을 관측한다. transport경계만 barrier, authority/claim/renew/writer mock0/실제provider0/TTL단축·DBclock변경0이다. 해당 case만 test120초, 기존default20초/DB/transporttimeout 변경0. barrier는 finally에서 해제하고 실제 execution drain 뒤 cleanup한다.
- [x] root가 원driver/log/exit에서 짧은 control PASS·actualbehaviorRED를 수용할 때까지 A heartbeat 동결. C는 actualclaimtoken/owner/boot/epochs/binding/원leaseUntil·실제transport도달·DBclock>원expiry를 남긴다. API부재/SQL/권한/ENOSPC/fixtureassertion 실패는 RED에서 제외한다.
- [x] 수용 뒤 A가 고정90/15·비중첩·stop/currentrenewawait만 추가하고 C는 **동일 longdriver** GREEN을 확인한다. 같은token/owner/binding의 actualrenew증가·원expiry뒤 actual병렬claim running·settle전release0·settle뒤recorded/ownrelease/outbox를 검증한다.
- [x] C actual 짧은 행렬: abort무시transport중owner보존, terminal/human/current source/policy/product generation, drain, 동일item병렬dispatch1, actualtakeover뒤oldwriter거절, unexpectedreject writer0, outboxfailure 원자rollback/별도release0. 진행 중 renew blocker는 실제 pg_blocking_pids와 drain순서를 증명한다. 비중첩은 unit우선, 추가30초 actual이 필요한 반례는 root에 먼저 보고한다.
- [x] A/B/C: whole tsc/scopedlint·필요한 회귀를 실제 실행하고 로그/SHA/미해결문제/실패접근·readback/STOP으로 반환한다. source변경과 test실행시점을 구분하고 미실행을 PASS로 적지 않는다.
- [ ] root: 전체diff직접리뷰, B가A/A가C 읽기교차리뷰, 관련 legacyhandler/itemwriter/replay/B5·전체unit/DB/type/lint/i18n/Python/build/bundle 검증. 코드 변경 뒤 필요한 gate만 다시 실행한다. readback/STOP→최신main통합→commit/push/PR/필수CI/정상merge/mainCI를 확인한다.

## 구체적 검증 명령

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-ai2-item-lifecycle
npx vitest run tests/second-review-transport.test.ts tests/second-review-job.test.ts tests/review-fixture-handler-dispatch.test.ts
npx vitest run tests/second-review-item-lifecycle.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55507/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/second-review-item-lifecycle.test.ts -t 'original 90-second expiry'
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55507/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/second-review-item-lifecycle.test.ts
npx tsc --noEmit --incremental false
npx eslint lib/crawl/second-review-item-lifecycle.ts lib/crawl/second-review-ownership.ts lib/crawl/second-review-transport.ts lib/crawl/jobs/second-review.ts tests/second-review-item-lifecycle.test.ts tests/second-review-transport.test.ts tests/integration/second-review-item-lifecycle.test.ts
git diff --check
```

이 문서는 실행 계약이며 새 PASS가 아니다. A source/B transport/C test 읽기노트에서 root가 취합했다. 충돌하는 이전 제안(renew throw 뒤 cancelwriter, setInterval)보다 이 고정 계약을 우선한다. 물리provider종료·itemB5·실제30분baseline/2배/OracleDR을 이 단위테스트로 완료 처리하지 않는다.

## 구현 checkpoint

고정source4개와unit2개·C통합test582행 동결. 원90초 actual1RED/control1PASS→같은2PASS91.31초를 root가 수용했고 heartbeat 구현을 해제·검증했다. A95unit/B48unit·25DB 회귀 및 양쪽 whole tsc/scopedlint0, 서로 읽기교차리뷰 추가P1/P2 0. C짧은행렬19PASS/원long1skip, 최종whole20·A읽기리뷰와 root전체gate는 진행 중이다. rootwholeunit2,985PASS/whole tsc·linter·i18n0. 실제 로그·실패 접근·제한은 validation 문서에 기록한다. 이 checkpoint는 전체DB/CI/운영 적용·itemB5·2배/DR 완료가 아니다.

최종 root wholeDB181파일2,132PASS/기존TODO1·611.49초 actualexit0, unit2,985·정적/i18n/Python23/build/bundle0을 확인했다. C최종7e56 short순서관찰은 A/root읽기리뷰0 및 독립 awaitheartbeat삭제 mutant1FAIL→원본1PASS로 감도를확인했다. 원20PASS와마지막short검증은별개다. 담당DB readback/STOP 반환 완료, root 최신main통합/최종fixture·readback/STOP/Git·CI는이어간다.
