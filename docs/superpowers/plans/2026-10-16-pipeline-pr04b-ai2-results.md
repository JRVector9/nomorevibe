# PR04b-1 — AI2 결과 writer와 기존 legacy handler 연결

PR04a #440(ceb2e6a)는 필수 PR CI38778457336 성공 뒤 main7977089로 병합됐고 main CI38779482314의 quality/통합/check/웹·워커 이미지까지 성공했다. 이 분기는 그 고정 feature commit에서 시작한다. root가 실제 main을 통합한 뒤 이 PR을 제출한다. 서브에이전트 전원 gpt-6.1-sol/xhigh, root가 API·배타적 파일·실제 RED 수용·직접/교차 리뷰·전체 검증·Git/문서를 맡는다.

## 순서와 경계

PR04b를 b-1 결과/handler 원자 전환과 b-2 생산/정리 컨트롤러 보강으로 나눈다. b-1은 mandatory result receipt와 기존 handler admission을 함께 바꾸며, b-2가 남은 enqueue/close/reopen/retry의 current revalidation·S3·worker proof를 닫는다. source가 같은 second-review.ts는 각 단계 한 담당자만 수정한다. PR04c item lifecycle, B5 item 인증·certified deferred flush finalwall·durable 외부 종료는 별도다. b-1만으로 전체 AI2 fencing이나 consumer 활성화를 완료 처리하지 않는다.

기본 legacy/epoch1/계약0, consumer 비활성, 실제 모델/quality gate/동시성4/FETCH24/TICK108초/발굴 중단 유지. 운영 deploy/DDL/provider 호출0. 별도 source 재구성·전체 파일 추출·generic framework 확장0. 다음 이미지는0077 migration 선적용이 필요하다.

## 파일 및 DB 단독 소유권

작업 WT `/Users/jr/Desktop/projects/nomorevibe-pipeline-ai2-writers`, branch `codex/pipeline-pr04b-ai2-writers-20261016`. node_modules는 부모 WT의 고정 dependency 디렉터리 symlink다. 타 WT/DB/파일 편집 또는 Git 실행0, 필요한 추가 파일은 root에게 먼저 경계 재배정을 요청한다.

| 담당 | 편집 파일 | 자기 DB |
| --- | --- | --- |
| A writer | lib/crawl/second-review.ts의 recordSecondReview 및 직접 필요한 import/private helper만; tests/integration/second-review.test.ts; tests/integration/review-handoffs.test.ts | loopback55493 / nomorevibe-pr04b-writer-db-20261016 |
| B 독립 writer 검증 | NEW tests/integration/second-review-item-results.test.ts; tests/integration/pipeline-capacity.test.ts; tests/integration/review-publication-gate.test.ts | loopback55494 / nomorevibe-pr04b-results-db-20261016 |
| C handler | lib/crawl/jobs/second-review.ts; tests/second-review-job.test.ts; tests/review-fixture-handler-dispatch.test.ts; 보존본복원 tests/integration/second-review-item-ownership.test.ts; tests/integration/agent-review-job.test.ts; 필요시 second-review-shutdown.test.ts | loopback55495 / nomorevibe-pr04b-handler-db-20261016 |
| root 공유·취합 | docs/Git/공통 API; tests/integration/review-replay-clock.test.ts, pipeline-replay-second-final.test.ts, pipeline-replay-lifecycle.test.ts | 필요시 loopback55496 / nomorevibe-pr04b-root-db-20261016 |

기존 fixture 적응은 실제 runJob/admit/claim을 사용한다. 정상 receipt를 raw JSON·synthetic token·직접 lease INSERT로 발급하지 않는다. stale-input/human 테스트는 정상 admission을 먼저 얻고 실제 입력을 바꾼 뒤 같은 원 receipt를 전달한다. 기존 business/clock/history assertion·timeout을 약화하지 않는다. B/C의 신규 독립 테스트는 타 수요를 필요한 열만 in-place suspend→raw JSON µs exact 복원하며 unrelated sentinel/whole snapshot/자기행·연결0/STOP까지 확인한다. 기존 legacy tests의 broad reset을 다른 신규 테스트에 복사하지 않는다.

## 고정 public API

```ts
export type SecondReviewResult =
  | { ok: true; decision: string; confidence: number|null; reason: string;
      model: string; provider: SecondReviewProvider; status?: 'agreed'|'needs_human' }
  | { ok: false; error: string; detail?: string; model: string; provider: SecondReviewProvider };
export type SecondReviewWriteResult =
  | { state: 'recorded' }
  | { state: 'input_changed'; reason: 'context_invalid'|'binding_changed' }
  | { state: 'not_pending' }
  | { state: 'cancelled' };
export function recordSecondReview(input: {
  receipt: SecondReviewReceipt; result: SecondReviewResult; now?: Date;
}): Promise<SecondReviewWriteResult>;
```

id-only/optional job fallback0。target ID는 receipt.binding.secondReviewId 하나다. caller status는 기존 fixture 적응 폭을 줄이는 무시되는 optional data이며 actual verdict/full gate는 잠근 현재 settings로 재계산한다. result provider/model은 original receipt 및 실제 row와 exact 일치해야 한다. now는 semantic/기록 시각이고 권한은 DB clock이다. original proof 위조·상실·만료·missing row는 throw/전체 rollback으로 구분한다.

## 분기와 원자성

- pending+ctx유효+current binding exact: 기존 success/failure/fallback/hold/outbox와 own item 정산1회를 같은 TX로 저장한다. 임계값/독립성/실패상한3/기존5분·1시간 retry/full gate를 유지한다.
- pending+ctx유효+binding만 변경: result/failure/fallback/candidate/outbox0, pending 유지, own item만 정산하고 input_changed/binding_changed 반환. actual UNIQUE(candidate,input,model,generation)와 status 무관 enqueue count 때문에 무조건 superseded하면 재검수가 영구히 막힐 수 있다. 같은 actual job readmit 또는 새 item claim이 current binding으로 다시 처리하는 실제 회귀를 먼저 확보한다.
- ctx=null: 원 pending만 CAS superseded, 사람/terminal/candidate/result/failure/fallback/outbox 변경0, original owner 정산. 기존 private stale 의미를 유지한다.
- terminal: original ownership 먼저 검증, valid original owner 정산만/not_pending. 같은 live legacy job duplicate는 no-write, 이미 release된 item receipt는 lease_lost로 거절·변경0, foreign owner 보존.
- cancelled: 실제 awaited caller 정산 뒤 mandatory receipt 경로로 failure/fallback/outbox0 및 own item 정산1회. 외부 종료의 독립 증거로 주장하지 않는다.

공통 잠금은 S3→replay mutex(legacy replay만)→published lifecycle/product→candidate/document/settings/evidence/first→root/votes→chain/item→DML→jobs/outbox→recorder→최종wall/release다. legacy는 첫 request 전에 actual second-review job UPDATE lock+DBwall로 기존 직렬화를 유지해 SHARE→UPDATE 교착을 피한다. recorder 뒤 같은 이미 잠근 job을 최종 재검사한다. item은 jobs proof 없이 모든 DML/outbox/recorder(no-op) 뒤 own release 정확히1회. job 뒤 새 domain/형제 item lock0, 외부 호출 중 TX0.

기존 full AI2 publication gate, root/child 독립fallback, history/final·human/maker 결정·current signals 보존. cancelled/terminal/binding mismatch는 모델 committed/requested telemetry0. 결과/child/hold/request/ownrelease/recorder 실패 중 어느 하나라도 전체 rollback한다. item replay는 mutation 전 explicit unsupported, profile/legacy 인증 확대0. certified callback 뒤 deferred flush의 최종clock gap은 이 함수의 callback check로 닫혔다고 주장하지 않는다.

## handler 연결

실제 ctx.lease 필수. controller와budget검사보다 먼저 canStartLegacySecondReview; 차단은 요청/cursor/pause/이력을 유지하는 deferred stage_blocked. 각 queued hint는 admitLegacySecondReview의 actual row/input/receipt로 교체하고 nullable reviewer default를 dispatch authority로 사용하지 않는다. mode midtick 차단은 새 호출을 중지하고 이미 시작한 네 lanes의 allSettled를 기다린 뒤 deferred. healthy foreign running은 개별 skip이며 정상 empty ACK와 구분한다.

admission 뒤 signal/budget/remaining timeout을 다시 확인한다. input_changed admission을 id-only writer에 재전달하지 않는다. normal success/failure는 mandatory receipt로 저장하고 writer state를 모델 결과 집계와 구분한다. 같은 tick visited를 유지해 binding 변경 시 재호출 spin0. 세 transport/provider routing/timeout·fixture 실제 dispatch/기존 bounded continuation 유지. 현재 controller 상세 보강은 b-2에 남기며 여기서 다른 section을 임의 수정하지 않는다.

## 실제 검증 순서

1. B가 실제 healthy foreign ai2 claim 아래 기존 no-receipt result 호출의 변경을 actual RED/정상 legacy control로 먼저 확인한다. old signature는 negative test에서 Reflect.apply 등으로만 호출해 새 API type 계약을 우회하는 허용 경로를 production에 남기지 않는다. API/import/SQL 오류를 행동 RED로 세지 않는다. root가 그 실제 로그를 수용한 뒤 A writer를 수정한다.
2. C는 보존4case SHA a5dadc044c913c30ccf7d869c48700f73869a157730c51e4a0a44225e0d208c8를 새WT에 복원해 같은 actual control1/3RED부터 확인한 뒤 handler를 연결한다. A와 정확 API만 공유하고 서로 source 파일을 수정하지 않는다.
3. B actual item/legacy current policy-only 및 제품 재등록 old result 거절→pending 유지→새claim/readmit 회복, stale/human/terminal/cancel·forged ownership·outbox/release/jobclock rollback을 검증한다. actual every-slot/fallback gate와 published no-first/placeholder semantics를 보존한다.
4. 각자 소유 기존 fixtures를 실제 권한 계약으로 적응하고 focused PASS·whole tsc/scopedlint·raw 복원/readback/STOP handback. temporary type errors는 행동 RED로 세지 않는다. root 직접/B·C 교차 리뷰→전체unit/DB/static/build→최신 main 통합/필수CI→정상 병합/main images.

아직 구현·실행 합격을 주장하는 계획이 아니다. 참고 읽기 inventory: /tmp/nomorevibe-pr04b-ai2-writer-caller-inventory-20261016.md, /tmp/nomorevibe-pr04b-handler-inventory-20261016.md, /tmp/nomorevibe-pr04b-writer-contract-20261016.md. 다음 b-2가 완료되기 전 전체 AI2 writer/controller migration 완료 또는 consumer 활성화를 보고하지 않는다.

## 취합 중 확인한 replay 제품 잠금 보강

root 실제 replay3files 실행에서 2FAIL/29PASS를 확인했다. 공개 표본 fixture에 실제 product를 추가하자 새 domain loader의 `lockProductGeneration`이 restricted replay role의 products SELECT-only와 충돌했다. SELECT FOR UPDATE는 UPDATE 열 권한이 필요하다. plain SELECT/advisory만으로 줄이면 실제 advisory 없이 삭제하는 경로를 보호하지 못하므로 생산 잠금을 바꾸지 않는다.

root는 이 actual42501을 근거로 초기 profile 변경0 경계를 다음 세 파일에 한해 명시 확대했다. C만 `lib/operations/pipeline-replay-handler-profile.ts`, `tests/integration/pipeline-replay-handler-profile.test.ts`, `tests/integration/replay-handler-setup.ts`를 편집한다. 기존 source/stage/item과 같은 products `update:['id'], immutable:true`만 적용한다. SECURITY INVOKER ALWAYS BEFORE UPDATE statement trigger, 정확 manifest/ACL/trigger OID/function definition 검증과 정리를 함께 유지해야 하며 일반 UPDATE/INSERT/DELETE·SECURITY DEFINER/owner 우회는 허용하지 않는다. 잠금 성공과 no-op/0-row UPDATE 차단, 나머지 제품 쓰기 거절 및 trigger-disable drift 거절을 실제 DB로 먼저 검증한다. 정책 hash 변경으로 기존 profile 재사용은 검증 단계에서 거절돼야 한다. 정상 legacy 소비자·item consumer·생산 product source/DDL 변경0이다.

다른 실패는 기존 테스트가 dispatch 중 모델 값을 바꾼 뒤 원 receipt 결과도 저장된다고 가정한 부분이었다. root는 cleanup barrier를 같은 live job의 finally 안에서 기다리고 원 receipt가 `invalid_second_review_receipt`로 거절되는지 검증하도록 fixture를 적응했다. 기존 actual blocker/mutex query·final0/model_removed assertions는 유지한다. focused1PASS를 실제 확인했으며 공개 표본과 전체 검증은 별도다.
