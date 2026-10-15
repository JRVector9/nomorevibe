# PR01b 다음 구현: 기존 검수 handler·writer의 격리 실행

2026-10-15. PR430/main2c7a71c 뒤의 승인된 구현 계획이다. 1절은 #431/main9601e3b에 병합했고,
2절은 [PR01b-3 runtime 계획](2026-10-15-pipeline-pr01b-runtime.md)에 따라 구현·검증 중이다.
3절 final과4절 coverage/seal은 아직 미구현이다. 실제 납품 상태는
[PR별 개발·적용 현황](2026-10-15-pipeline-delivery-status.md)을 따른다.
사용자가 승인한 PR00–17의 PR01 범위다. 실제 provider admission과2배 성능 판정은 계속 별도 선행 조건이다.
모든 agent/codex CLI는 gpt-6.1-sol/xhigh. writing-plans/execute-plan/TDD로 진행한다.

## 목표와 경계

기존 `reviewCrawlCandidates`와 `secondReviewCandidates`, 기존 결과 writer·AI2 gate를 그대로 실행한다.
별도 심사 엔진이나 production singleton의 env/global 교체를 만들지 않는다. 첫 실행은 fixture transport만 허용한다.
실제 모델의 강제 총 토큰/attempts/serving identity는 provider audit의 미확인 항목을 해소한 다음이다.
기존 v1 snapshot의 unverified 판정과 현재 운영 worker 설정을 유지한다.

## 1. 명시 DB scope와 제한 권한 profile

파일: `lib/db/index.ts`, `lib/operations/pipeline-replay-database.ts`, 새 scope 회귀.

- 현재 verified handle은 공개 schema를 모두 거절하므로 handler 실행 권한은 없다.
- dedicated test DB 안의 필요한 기존 table/sequence만 admin이 사전에 허용하는 별도 handler profile을 설계한다.
  profile은 nonce와 owner-protected marker에 결합하고 코드의 고정 allowlist와 실제 object OID/ACL을 확인한다.
  artifact flag나 caller JSON으로 임의 권한을 허용하지 않는다. broad public grants/CREATE/TEMP/ownership은 금지한다.
- 읽기: settings/documents/scans/observations/products. 쓰기: candidates/attempts/second_reviews/frontier/jobs/
  실제 handler가 쓰는 operations observations. 필요한 insert sequence만 허용한다. products는 SELECT만 허용한다.
  정확한 최소 column/sequence 목록은 실제 회귀로 확인하고 추가한다.
- verified dedicated client로 만든 Drizzle executor를 AsyncLocalStorage scope에 넣고 replica/global 선택보다 먼저 사용한다.
  `onPrimary`와 `onReplica`가 scope 밖으로 나가지 않아야 한다. concurrent/nested scope의 다른 DB 결합은 거절한다.
  매 writer transaction의 같은 연결을 다시 검증하는 방법을 먼저 입증한다. 별도 연결로 확인하는 것으로 대체하지 않는다.
- schema 복제는 필수 요건이 아니다. 기존 test DB의 실제 migration과 좁은 권한 profile이 기본이다.
  구체적 충돌이 입증될 때만 대안을 검토한다.

RED: production/global/replica DB를 poison해도 접근0, 다른 scope 교차0, privilege drift 거절,
매 transaction 연결 검증, products INSERT/UPDATE/DELETE 거절.

## 2. 두 handler와 downstream outbox

파일: `lib/jobs/runner.ts`, `lib/crawl/jobs/{agent-review,second-review}.ts`, 새 전용 replay runner.

- 일반 worker·scheduler는 시작하지 않는다. `runJob`은 replay scope에서 claim 전 두 이름만 허용한다:
  `crawl-agent-review`, `second-review`.
- 실제 job claim/heartbeat/lease/budget/continuation을 유지한다. 프로세스가 나간 뒤 잔여 heartbeat도 fence해야 한다.
- 두 provider 분기 직전에 하나의 fixture dispatch 경계를 주입한다. input/stage/attempt/vote/generation/
  exact provider/model/request hash를 결합하고 기존 장부 예약 뒤 ordinary AgentReviewResult를 반환한다.
  fixture scope에서 실제 abcllm/CLI adapter에 도달하면 즉시 실패한다.
- 기존 isolated jobs 행을 요청 outbox로 사용할 수 있다. 아래 요청은 로컬에 기록하되 두 검수 job 외에는 실행하지 않는다.
  AI1 source requeue→crawl-fetch, 결과→second-review 또는 gate off일 때 crawl-publish,
  AI2 fallback→second-review, agreement→crawl-publish. runner의 직접 version continuation과
  operations_observations도 기록 경계에 포함한다.
- spam/exhaustion, AI2 cleanup/orphan reopening/split hold도 실제 로직을 실행하고 준비 상태 전이에 반영한다.
  requeueInvalidStarApprovals는 두-handler path 밖이므로 자동으로 추가 실행하지 않는다.

RED: 실제 handler fixture 실행/실모델 callback0, fetch/judge/publisher claim0,
held publication request와 products 불변, real-time heartbeat/backoff/lease 회귀.

## 3. 실제 writer transaction과 final 기록

파일: `agent-review-repository.ts:recordAgentReview`, `second-review.ts:recordSecondReview`,
`pipeline-replay-ledger.ts`와 isolated SQL의 추가 recorder.

- 지금 장부는 자체 raw transaction을 열기 때문에 writer 완료 뒤 별도 append하는 방식으로는 atomic final을 증명할 수 없다.
  기존 Drizzle writer의 정확히 같은 transaction에 private typed recorder를 결합한다.
- locked DB current-input/policy/settings/actor/appliedAttemptId에서 final을 유도한다.
  arbitrary JSON/boolean으로 승인 여부를 받지 않는다. 실제 secondReviewApprovalPredicate를 재사용한다.
- 적용된 자동 reject는 즉시 final, approve는 필수 다른 모델의 모든 slot이 gate를 만족한 뒤 final이다.
  rules/재사용/초기 완료/사람/hold/미적용/superseded/부분표는 신규 final에서 제외한다.
- candidate/input/source/policy/firstAttempt/실제 call/AI2 root+slot을 결합하고 중복 append를 DB unique로 막는다.
  이후 cleanup이나 사람 변경은 이력을 덮거나 과거 final을 지우지 않고 추가 전이로 기록한다.
- lock 순서는 기존 candidate/job/domain 잠금 후 run/event 잠금이다. requestJob 이벤트를 즉시 append해서
  run 잠금 뒤 다시 job 잠금을 잡는 구조를 만들지 않는다. tx-local buffer를 마지막 recorder 단계에서 flush한다.

RED: writer rollback→result/event0, recorder failure→result/event0,
중복 writer/부분표/fallback/reuse/rules/human/input·설정 변경이 final을 늘리지 않음.

## 4. 준비 coverage·별도 artifact와 seal

파일: claim/record/enqueue/retry/cleanup/hold 전이와 새 ledger artifact/export/compare.

- 초기 고정 input universe와 실제 eligibility를 기록하고 claim/backoff/hold/release에서 준비 상태를 유도한다.
  lease/retry 만료 경계와0-ready 구간도 포함한다. periodic 양수 sample로 전체 coverage를 인증하지 않는다.
- semantic validity는 frozen reference, event/lease/deadline은 실제 clock이다.
  과거 reference의 validUntil이 실제 run 시작보다 이르다고 v1 parser를 완화하지 않는다. 별도 artifact를 만든다.
- admission을 닫고 handler/heartbeat 종료, 모든 call 정산과 writer fencing, sequence/binding/coverage 검증 후 seal한다.
  indeterminate가 있으면 seal·겹치는 새 run을 금지한다. seal은 candidate 잠금을 얻기 위해 run→candidate 순서로 역전하지 않는다.
- 고정 조건의30분 비고갈 baseline/changed, 동일모델/품질/예산, p95/실패/잘못 승인·거절 기준을 실제로 충족해야2배를 판정한다.
  fixture 결과는 구현 회귀용이며 actual throughput 증거가 아니다.

RED: zero supply/restart gap/30분 미달→미판정, cleanup 뒤 final history 유지,
중복 final0, quality labels 불완전→미판정, unresolved call/seal 후 writer 거절.

## 실행과 다음 agent

각 소단계를 RED→GREEN→독립 검토한다. 전용 test container만 켜서 사용하고 체크 뒤 stop한다.
운영 migration·provider 설정 변경·일반 worker 활성화는 이 계획의 자동 작업에 포함하지 않는다.

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-handler-runtime
git fetch origin main
git status --short
# b3 병합 뒤 최신 main에서 b4 전용 worktree/branch를 만든다.
# recorder 첫 RED 전에 기존 writer/mandatory AI2 predicate와 private scope를 다시 확인한다.
```

근거: PR430, `docs/operations/2026-10-15-pipeline-pr01b-{validation,provider-audit}.md`,
독립 read-only handler/writer map. root X branch와 사용자 untracked 파일은 add/push하지 않는다.
