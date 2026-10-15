# PR01b-4 Atomic Final Implementation Plan

> **For agentic workers:** 기존 승인된 PR01 설계에 따라 execute-plan·TDD로 수행한다. 사용자 요청은 gpt-6.1-sol/xhigh 병렬 구현이며 root가 통합·리뷰한다.

**Goal:** 실제 AI1/AI2 writer와 같은 transaction에 신규 자동 최종 판단과 outbox 전이를 결합한다.

**Architecture:** authentic ReplayRun에 결합된 비공개 scope와 transaction-bound opaque token을 사용한다. 기존 잠금과 검증을 통과한 현재 입력을 캡처하고 결과 저장 뒤 실제 행/기존 AI2 gate/정산된 응답 hash를 검증한다. 일반 운영 writer 동작은 유지하고 격리 runner만 scope를 설치한다.

**Tech Stack:** TypeScript, Drizzle, PostgreSQL17, Vitest, AsyncLocalStorage.

## 파일 소유권 / 공통 계약

- AI1: `lib/crawl/agent-review-repository.ts`, 새 `tests/integration/pipeline-replay-first-final.test.ts`.
- AI2: `lib/crawl/second-review.ts`, `lib/crawl/second-review-input.ts`, 새 `tests/integration/pipeline-replay-second-final.test.ts`.
- ledger: `lib/operations/pipeline-replay-final.ts`, `lib/operations/pipeline-replay-ledger.ts`, `scripts/sql/pipeline-replay-ledger.sql`, provider 감사 문서, 새 final 단위 회귀.
- root: runner/fixture transport/profile 연결, 공통 실제 DB 회귀·문서·handoff·통합 검증·PR. 서로 소유 파일 수정 전 메시지로 인계한다. Git stage/commit은 root만 한다.

```ts
prepareReplayFinalWrite(tx: ProductTransaction, binding: {
  stage: "first" | "second"; candidateId: number; firstAttemptId: number;
  secondReviewId?: number; input: ReviewInput; settings: CrawlSettings;
}): Promise<ReplayFinalWrite | undefined>;
recordReplayFinalWrite(tx: ProductTransaction, token: ReplayFinalWrite | undefined,
  requests: readonly { job: string; requestedVersion: number }[]): Promise<void>;
withReplayFinalScope<T>(run: ReplayRun, load: () => Promise<T>): Promise<T>;
```

prepare는 active scope에서 실제 DB before 행을 캡처하고 private WeakMap으로 tx/scope에 결합한다. 임의 승인 boolean/JSON을 받지 않는다.
AI1은 currentInput/attempt 잠금 뒤 결과 mutation 전 prepare, 기존 outbox 이후 record. AI2는 prefix mutex와 전체 gate 표 잠금 뒤 job UPDATE 이전 prepare, 모든 early return도 가능한 전이 record; 성공 record는 모든 result/outbox 뒤다.
record는 추가 domain 잠금 없이 실제 after 행·설정·입력·first attempt·call 결과를 검증하고 run/event 잠금을 마지막에 획득한다.
final unique `(run_id,candidate_id,input_hash,source_revision_hash,policy_hash)`로 같은 입력 재시도/중복/예비표를 합친다. 후보당 최대1회 비교/재검수 세대 별도 집계는 b5 artifact에서 적용한다.
새 `capacity_finals`는 append-only이며 이벤트 seq, first call, AI2 call/root/slot identities와 결과를 결합한다. run/event의 DBclock을 사용한다. cleanup은 과거 final을 삭제·수정하지 않는다.

## Task 1: 정산 결과 결합과 scope/token

- [x] 기존 실제 runner에서 AI1+AI2 완료 후 final1을 기대하는 DB RED와 정산 응답 hash 단위 RED를 실행한다.
- [x] `capacity_calls.result_ok/result_hash/result_decision_hash`를 정산 시 기록한다. 기존 receipt-only settle은 final 증명이 될 수 없다.
- [x] verified ReplayRun private identity에서만 scope를 만들고 stale/conflicting scope/다른 tx token을 거절한다.
- [x] 새 final SQL/고정 handlers-v3 권한을 최소 열에만 추가한다. 기존 v1/v2를 임의 확장하지 않는다.
- [x] transport는 validateReviewOutcome 이후 settle에 `{ok, outcomeHash, decisionHash}`를 전달한다. runner는 Drizzle scope 안에 final scope를 설치한다.

## Task 2: AI1 writer

- [x] 신규 model reject와 gate 미필수 approve의 실제 final0 RED→final1 GREEN; gate 필수 approve final0 검증.
- [x] 실제 DB 검증: rules/reused succeeded/reusedFromAttemptId running/observe/human/hold/stale/input·설정 변경은 final0.
- [x] currentReviewInput의 잠긴 실제 문맥과 전후 행을 보존하며 prepare/record를 기존 tx에 삽입한다.
- [x] 실제 실패 trigger로 recorder 오류가 candidate/attempt/outbox/event를 모두 rollback함을 확인한다.

## Task 3: AI2 writer와 교착 경계

- [x] 실제 DB 검증: 다중 필수 slot 마지막 성공 뒤만 final1; fallback은 같은 root slot이며 중복 final0.
- [x] replay-only mutex를 모든 AI2 mutation tx의 candidate/row/job 이전에 취득한다. production 경로는 변경하지 않는다.
- [x] current input/source/settings/first attempt 및 gate 전체 row/root를 job UPDATE 이전 고정 순서로 잠근다.
- [x] 기존 `secondReviewApprovalPredicate(settings)`를 실제 writer tx에서 재사용한다. AI2 reject/human/부분표는 final0.
- [x] 두 실제 DB 연결의 barrier/pg_blocking_pids로 cleanup과 writer 양 선점 순서를 검증한다. prefix mutex 제거 RED→복원 GREEN, 이후 cleanup에도 과거 final1 보존.
- [x] 잘못 연결된 외부 candidate first attempt의 불필요 SHARE 잠금을 실제 NOWAIT RED→candidateId 조건→GREEN으로 검증한다.
- [x] firstAttemptId=null 공개분 sample/fallback은 실제 write·전이·outbox를 보존하고 final0임을 active scope에서 검증한다.

## Task 4: root 통합·독립 리뷰·납품

- [x] unit 및 신규 실제 DB targeted 회귀를 실행하고 실패 원인을 수정한다.
- [x] 담당 간 교차 읽기 리뷰 후 root 전체 diff를 목적/원자성/잠금/권한/중복 기준으로 리뷰한다.
- [x] `npm test`, `npm run test:integration`, typegen/tsc/lint/i18n/build 및 diff 체크를 실행하고 실제 결과만 기록한다.
- [ ] 정확한 파일만 commit/push/PR하고 최신 base 필수 CI 성공 뒤 exact-head merge한다. handoff와 PR별 현황 갱신.

## 검증 명령

```sh
npm test -- tests/pipeline-replay-transport.test.ts tests/pipeline-replay-runner.test.ts tests/pipeline-replay-final.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55459/nomorevibe_test npm run test:integration -- tests/integration/pipeline-replay-final.test.ts
npx next typegen
npx tsc --noEmit
npm run lint
npm run check:i18n
npm run build
git diff --check
```

전이 recorder는 `recordReplayFirstReviewTransition`(superseded/failed), `recordReplaySecondReviewTransition`(enqueue/cleanup/retry/hold/reopen/superseded/review_write)이며 job/version만 정규화해 기록한다. 추가 status 등 런타임 반환 필드는 기록하지 않는다.

실모델 admission/coverage 인증/seal/30분 측정/2배 선언/운영 활성화는 이 b4가 완료됐다는 이유로 통과시키지 않는다. b5/b6 및 PR02–17의 별도 단계로 이어간다.
