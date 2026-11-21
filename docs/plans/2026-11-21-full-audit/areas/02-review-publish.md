# 02. AI 심사 → 2차 심사 → 발행 → 후처리 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


대상: `저장소 루트` (origin/main `34b5fe32`). 읽기 전용 점검 — 코드·DB 실행 없음. 실측은 `../evidence/*` 만 사용.

## 요약 (심각도별 건수, 가장 중요한 5개 한 줄씩)

- P0 0 · P1 7 · P2 7 · P3 2 (총 16)
- 가장 중요한 5개
  1. **REVIEW-02** 발행 대기열 쿼리(승인 후보 전체에 관문 술어 재평가)가 2.7초 × 하루 12,377회 = **34,309초(느린 문장 총합의 28%)** — 미룸 틱이 5초마다 다시 돌며 반복.
  2. **REVIEW-01** `second_reviews(first_attempt_id)`·`(fallback_for_id)` 인덱스가 없다 — 발행 관문·AI2 claim/record(장부 control `FOR UPDATE` 를 쥔 채)·정리 쿼리가 2차 심사 표(20만 행)를 통째로 훑는다(seq_tup_read 1,179억).
  3. **REVIEW-03** AI2 가 items 모드인 동안 `second-review` 틱은 늘 `stage_blocked` 미룸으로 끝나 **요청이 인정되지 않고 5초 poll 마다 재실행**(일정 60초의 약 6배) — 마지막 성공 10-25 고정은 이 표시 문제, 무거운 정비 쿼리는 실제로 ~10초마다 돈다.
  4. **REVIEW-07/06** 사유 번역: 원본 해시 집계(`reason_eligible`) 4.6초 × 하루 4,251회 = **19,651초(16%)**, 10초 한도에 근접. 번역 묶음마다 같은 전수 집계를 3번 이상 하고, 본문 동등 비교 seq scan 을 **장부 control 행 `FOR UPDATE` 를 쥔 채** 실행.
  5. **REVIEW-04** 오래된 2차 표 정리(`stale_review_protecting_capacity`) 7.3초 × 1,417회 = 10,292초 — 비-sargable `coalesce(state,'') NOT IN` 이라 2.4GB 장부를 후보마다(틱당 최대 80번) seq scan.

## 발견

### REVIEW-01 `second_reviews` 의 `first_attempt_id`·`fallback_for_id` 에 인덱스가 없어 관문·claim·정리 쿼리가 표 전체를 훑는다
- 심각도: P1
- 분류: latency, concurrency
- 위치:
  - 스키마: `lib/db/second-review-schema.ts:76-77` — 인덱스는 `(candidate_id,input_hash,model,generation_key)` 유일·`(status,created_at)` 둘뿐. `drizzle/*.sql` 전체에 두 칸 인덱스 없음(0035 는 칸만 추가).
  - AI2 claim·record 의 행 잠금: `lib/crawl/second-review-input.ts:112-121`(`lockSecondReviewDomain` → `:193` 에서 항상 호출)
    ```ts
    await tx.select({ id: secondReviews.id }).from(secondReviews).where(or(
      eq(secondReviews.id, row.id),
      row.firstAttemptId ? eq(secondReviews.firstAttemptId, row.firstAttemptId) : undefined,
      row.fallbackForId ? eq(secondReviews.id, row.fallbackForId) : undefined,
      row.firstAttemptId ? sql`${secondReviews.id} IN (SELECT g.fallback_for_id FROM second_reviews g
        WHERE g.first_attempt_id = ${row.firstAttemptId} AND g.fallback_for_id IS NOT NULL)` : undefined,
    )).orderBy(secondReviews.id).for("update");
    ```
  - `chainIsBusy`: `lib/crawl/second-review-ownership.ts:202-204` — `or(id=…, id=vote, fallback_for_id=vote)`
  - 이 둘은 `claimReview`(`second-review-ownership.ts:301-323`) 안에서 `lockAi2ItemModelCapacityDispatch`(→ `capacity-repository.ts:1210` `control(tx)` = control 행 `FOR UPDATE`) 다음에 실행된다.
  - 발행 관문: `lib/crawl/second-review-workload.ts:273-283`, `lib/crawl/agent-review-repository.ts:409-414` — `g.first_attempt_id = ${attempt.id}` 상관 서브쿼리(승인 후보·시도마다).
  - 정리: `lib/crawl/second-review.ts:678-679` — `child.fallback_for_id=${secondReviews.id}` 상관 EXISTS/NOT EXISTS(OR 안이라 semi-join 으로 못 올림).
- 문제: OR 의 한 갈래라도 인덱스가 없으면 BitmapOr 가 불가능해 seq scan 이 된다. AI2 소비자가 표 하나를 claim 할 때마다(그리고 결과를 적을 때마다) 2차 표 20만 행을 읽고, 그동안 **전역 장부 control 행 `FOR UPDATE` 를 쥐고 있다** — 다른 모든 모델 입장·정산이 그 뒤에 줄 선다. 발행 관문은 승인 후보(현재 ~590건)마다 `status='agreed'` 전체를 `status_idx` 로 훑거나 seq scan 한다.
- 실측 근거: `pg-stats-primary.txt` `second_reviews | 212 MB | 204701 | seq_scan 1336952 | seq_tup_read 117931866734`(5.6일, 평균 스캔당 8.8만 행). `slow-queries-primary.txt` 1행(발행 쿼리 2.7초×11,242), 2행 `model_capacity_control … for update` 19,640회 평균 1,031ms(대기의 한 원인).
- 수정 방안: 마이그레이션으로 `CREATE INDEX CONCURRENTLY second_reviews_first_attempt_idx ON second_reviews (first_attempt_id) WHERE first_attempt_id IS NOT NULL;` 와 `CREATE INDEX CONCURRENTLY second_reviews_fallback_for_idx ON second_reviews (fallback_for_id) WHERE fallback_for_id IS NOT NULL;`. 관문용으로는 `(first_attempt_id, trigger, status)` 복합이 더 낫다(EXPLAIN 으로 고름). 추가로 `chainIsBusy`·`lockSecondReviewRows` 는 control 잠금 **앞**(도메인 단계)으로 옮길 수 없으면 최소한 인덱스로 잠금 보유 시간을 줄인다.
- 검증: 복제본에서 `EXPLAIN (ANALYZE, BUFFERS)` — `lockSecondReviewRows` 모양 문장이 `Bitmap Index Scan` 으로 바뀌는지, 발행 쿼리 시간. 배포 후 `pg_stat_user_tables.seq_tup_read(second_reviews)` 증가율, `model_capacity_control for update` 느린 문장 수. 회귀: `tests/integration/second-review-item-claim.test.ts`, `second-review-controller-locks.test.ts`, `crawl-publish.test.ts`.
- 배포 주의: `CREATE INDEX CONCURRENTLY` 는 트랜잭션 밖에서(마이그레이션 도구가 TX 로 감싸면 별도 스크립트). DRAIN 불필요(읽기 경로만 바뀜).
- 확신도: CONFIRMED(인덱스 부재·OR 구조·control 잠금 순서까지 읽음). seq_tup_read 중 이 경로의 비중은 `pg_stat_statements` 로 확인 필요.
- 규모: S

### REVIEW-02 발행 대기열 쿼리가 승인 후보 전체에 무거운 관문 술어를 매번 재평가 — 2.7초 × 하루 12,377회
- 심각도: P1
- 분류: latency, inefficiency
- 위치: `lib/crawl/jobs/publish.ts:115-124, 133-134`, `lib/crawl/agent-review-repository.ts:338-375`(`matchingSource`·`currentReviewSource`), `:432-445`(`reviewApprovalPredicate`), `lib/crawl/repository.ts:896-907`(`listCandidates`)
  ```ts
  while (ctx.hasBudget()) {
    const eligible = pool || process.env.CONNECT_AGENT_URL
      ? and(reviewApprovalPredicate(settings), or(classificationReadyPredicate(), starAutoApprovalPredicate(settings)))
      : reviewApprovalPredicate(settings);
    const candidates = await crawl.listCandidates(["approved"], resume ? BATCH : BATCH * classifyConcurrency, and(eligible, …
    …
    if (candidates.length === 0) {
      if (classificationWaiting.size) return capacityDeferred();
  ```
- 문제: `approved` 후보(현재 589건, 대부분 2차 관문 표 대기) 하나하나에 대해 ① 그 후보의 모든 시도를 `currentReviewSource`(문서 EXISTS + `agent_repository_scans` LATERAL 최신 스캔 + README 앞부분 `btrim(left(…))` 비교 + 커버리지 jsonb 재계산)로 대조하고 ② `secondReviewPoolApprovedSql`(REVIEW-01 의 인덱스 없는 `first_attempt_id` 상관 서브쿼리 2개 + `jsonb_array_elements` 조인)을 평가한 뒤 `ORDER BY updated_at DESC LIMIT` 한다. 즉 **대부분 아직 발행할 수 없는 후보의 판정 비용을 매 반복 전부 치른다**. 분류가 포화되면 `classificationWaiting` 에 넣고 같은 쿼리를 `NOT IN` 만 바꿔 다시 돌리고, 끝에서 `deferred:model_capacity` 로 돌아가 REVIEW-03 의 5초 재실행에 걸린다(카탈로그는 5분 주기인데 하루 12,377회 = 약 7초 간격).
- 실측 근거: `slow-queries-primary.txt` 1행 `11242 | 30676 | 2729 | 14196` + 9행 `1135 | 3633 | 3201 | 14772`(같은 `listCandidates` 모양, 분류 경로에 따라 괄호만 다름). 합계 34,309초/일 = 느린 문장 총 122,852초의 27.9%.
- 수정 방안(추천 순):
  1. REVIEW-01 인덱스(관문 서브쿼리 비용 제거).
  2. 술어 분할: 먼저 값싼 조건만으로 "관문 표가 모두 끝난(=pending/failed/needs_human 표 없음, agreed 표 있음)" 후보 id 를 `second_reviews` 인덱스로 뽑고, 그 소수에만 `currentReviewSource` 를 평가(CTE `MATERIALIZED` 로 순서 고정). 발행 트랜잭션의 `assertReviewApproval` 이 잠근 행으로 다시 재므로 큐 술어는 거친 거르기로 충분하다(주석 `:447` 과 같은 원칙).
  3. 분류 미룸 시 같은 틱에서 쿼리를 다시 돌리지 말고 남은 후보 id 목록을 메모리에서 소진, 미룸 결과에 `notBefore` 백오프(REVIEW-03).
  4. 구조 제안 S3(발행 준비 상태를 유지하는 표/칸).
- 검증: 복제본 `EXPLAIN (ANALYZE, BUFFERS)` 로 현행/개선 쿼리 비교(목표 <100ms). 배포 후 느린 문장 1·9행 모양 소멸, `crawl-publish` 의 `job.deferred` 빈도. 회귀 `tests/integration/crawl-publish.test.ts`, `crawl-publish-deferral.test.ts`, `review-draining.test.ts`.
- 배포 주의: publisher 역할만 재시작. 인덱스(REVIEW-01)를 먼저 배포.
- 확신도: CONFIRMED(호출 경로·술어 구성·반복 구조). 2.7초 중 각 서브쿼리 비중은 EXPLAIN 필요(PLAUSIBLE).
- 규모: M

### REVIEW-03 미룬(deferred) 틱은 요청을 인정하지 않아 5초마다 다시 돈다 — `second-review` 정비(items 모드)·`crawl-publish` 가 일정의 6~40배로 무거운 쿼리를 반복, `second-review` 마지막 성공 10-25 고정의 원인
- 심각도: P1
- 분류: inefficiency, logic(표시)
- 위치:
  - `lib/jobs/runner.ts:242-256` — 미룸은 `processedVersion` 을 올리지 않고 `processed>=1` 일 때만 `lastSuccessAt` 이동
  - `lib/jobs/control.ts:87-95` — `requestedVersion > processedVersion` 이면 pending
  - `scripts/worker.ts:270-275, 295` — 미룸 틱은 다음 poll(기본 5초)에 다시 집는다고 주석에 명시
  - `lib/crawl/jobs/second-review.ts:55-73`
    ```ts
    const enqueued = await enqueueSecondReviews(settings, undefined, lease);
    const closed = await closeSettledSecondReviews(undefined, lease);
    const reconciled = await reconcileStaleSecondReviews(undefined, lease, { … });
    const reopened = await reopenOrphanedGateHolds(settings, undefined, lease);
    await retryFailedSecondReviews(undefined, lease);
    const outcome = await reviewPendingVotes(ctx, lease, startedAt, { enqueued, closed, reopened, reconciled });
    …
    if (!await canStartLegacySecondReview(lease)) {
      return { done: false, deferred: "stage_blocked" };
    ```
- 문제:
  - **second-review**: AI2 는 10-25 이후 items 모드(`docs/CODEX_HANDOFF.md:690` "ai2stage items/epoch2"). 이 잡은 정비(올리기·닫기·정리·되돌리기·재시도)를 실제로 다 한 뒤 `reviewPendingVotes` 첫 줄에서 `stage_blocked` 미룸을 돌려준다. 정비 건수를 `processed` 에 싣지 않으므로 `lastSuccessAt` 이 영영 안 움직이고(=**10-25 고정은 표시 문제**, 정비는 돌고 있다), 요청도 인정되지 않아 **전용 줄이 5초 쉬고 곧바로 다시 돈다**. 틱 자체가 수 초라 사실상 연속 실행이며, 매 틱 REVIEW-04·05 의 무거운 쿼리와 후보당 트랜잭션(최대 80+건)을 반복한다. AI1 기록이 `requestJob("second-review")`(`agent-review-repository.ts:1519`)로 깨우므로 5초 재실행은 지연 단축에도 필요 없다.
  - **crawl-publish**: 분류 포화 시 `capacityDeferred()` → 같은 방식으로 5초 재실행(REVIEW-02).
  - 진행 감시·운영센터가 `second-review` 를 "성공 없음"으로 보지 않도록 별도 예외(ALL_SKIPPED 등)에 기대고 있어, 정말 정비가 멈춰도 구분되지 않는다.
- 실측 근거: `jobs.txt` `second-review | 208583 | 23:54:13 | 2026-10-25 23:41:15`. 10-25~11-20(약 26일)을 일정(60초)대로 돌았다면 약 3.7만 회 — 208,583 회는 이 기간만으로 쳐도 평균 약 11초 간격에 해당. `crawl-publish` 의 2.7초 쿼리 하루 12,377회(5분 일정이면 최대 288회). `second_review_workload_assignments idx_scan 5,659,551,122`(REVIEW-05 의 틱당 전수 평가와 맞물림).
- 수정 방안(추천: 1+2):
  1. `second-review` 를 items 모드에서 "정비 전용 완료 틱"으로 끝낸다: `canStartLegacySecondReview` 가 false 면 `{ done: true }`(degraded 아님)로 돌려 요청을 인정하고 `lastSuccessAt` 을 옮긴다. 또는 `deferredJob("stage_blocked", enqueued+closed+reopened+reconciled)`.
  2. 러너: 미룸 결과에 선택적 `retryAfterMs` 를 받아 `notBefore = now() + retryAfterMs`(멈춤 표시 `PAUSED_AFTER_MS` 보다 짧게)로 적는다. `model_capacity`·`stage_blocked` 는 잡 일정 간격 또는 30~60초. 기존 테스트(`tests/integration/job-runner.test.ts:193,217` 요청 유지)는 그대로 통과하고 재실행 간격만 늘어난다.
- 검증: `jobs.runs` 증가율(second-review 하루 ≤1,500, crawl-publish ≤수백), `job:second-review` 관측의 `lastSuccessAt` 갱신, 느린 문장 3·4행 빈도. 회귀 `tests/integration/job-runner.test.ts`, `review-draining.test.ts`("unapproved jobs cannot opt in").
- 배포 주의: 러너 변경은 모든 역할 재시작(일반 배포). scheduler 선배포 불필요.
- 확신도: CONFIRMED(러너·워커·잡 경로 끝까지 읽음, 주석으로 의도 확인 — 다만 실측 피해가 있어 결함으로 기록).
- 규모: S

### REVIEW-04 오래된 2차 표 정리(hint·probe)가 비-sargable 상태 조건으로 장부 전체를 seq scan, 후보마다 반복
- 심각도: P1
- 분류: latency, inefficiency
- 위치: `lib/crawl/second-review-stale.ts:179-182, 190-194, 244-261`, `lib/crawl/second-review.ts:999, 1100-1125`
  ```ts
  function protectingCapacityRowsSql(): SQL {
    return sql`SELECT cap.state, cap.reserved_until, cap.logical_work_key, cap.work_key, cap.route_id
      FROM model_capacity_requests cap WHERE coalesce(cap.state, '') NOT IN ('waiting', 'withdrawn', 'settled')`;
  }
  ```
- 문제:
  1. `state` 는 `NOT NULL` + CHECK 6값(`lib/db/operations-schema.ts:162, 183`)이라 이 조건은 `state IN ('reserved','dispatched','indeterminate')` 와 같지만, `coalesce(…) NOT IN` 꼴이라 부분 인덱스(`model_capacity_requests_active_idx`·`live_work_idx`·`unknown_hold_idx`)를 못 쓰고 **2.4GB 표를 seq scan** 한다. 게다가 미확정(605행)은 보호하지 않는다(`capacityBlocksStaleReconcile` `:152`, `protectingCapacityStateSql` `:161-165`) — 필요한 건 `reserved`·`dispatched` 몇 행뿐.
  2. 이 CTE 가 hint 쿼리(틱당 최대 4번 — `room = min(25, 80-examined)`)와 **후보마다의 probe**(`second-review.ts:999`, 틱당 최대 80번)에 모두 들어간다.
  3. hint 는 `pending/failed` 표 전체 + `carriedDemandSql`(OR 안의 상관 NOT EXISTS + 양쪽 `regexp_replace`)을 커서부터 끝까지 걷는다. 입력이 그대로인(=current) 표의 후보도 모두 hint 에 나와, 후보마다 무거운 도메인 잠금 TX(`lockControllerDomain`: 후보 `FOR UPDATE`·스캔 `FOR UPDATE`·frontier 잠금/삽입 후 되돌림·`loadReviewInput`)를 연 뒤 "바뀐 것 없음"으로 끝난다. REVIEW-03 때문에 이것이 ~10초마다 돈다.
- 실측 근거: `slow-queries-primary.txt` 4행 `1417 | 10292 | 7263 | 14013`(hint), 61행 probe 1회 559ms. `pg-stats-primary.txt` `model_capacity_requests | 2471 MB | seq_scan 1756826 | seq_tup_read 565379093415`(스캔당 약 32만 행 = 거의 전체). 다른 장부 경로도 섞여 있을 수 있음.
- 수정 방안:
  1. `protectingCapacityRowsSql` 을 `WHERE ${occupyingStateSql(sql\`cap.state\`)}`(= `state IN ('reserved','dispatched')`)로 — 부분 인덱스 `model_capacity_requests_active_idx` 와 술어가 같아 수 행만 읽는다. probe 도 같은 조각.
  2. hint 용 부분 인덱스: `CREATE INDEX CONCURRENTLY second_reviews_ai2_open_idx ON second_reviews (candidate_id) WHERE status IN ('pending','failed') OR (status='resolved' AND resolution='superseded' AND resolved_by='stale-input-reconciler' AND fallback_for_id IS NULL);`
  3. hint SQL 에서 "입력이 그대로일 수 있는" 표를 거르는 값싼 조건(예: `s.first_attempt_id` 의 `crawl_review_attempts.valid_until > now()`·`prompt_version`·`policy_hash` 비교)을 추가해 JS 대조 전 후보 수를 줄인다(최종 판정은 지금처럼 잠근 뒤 JS).
  4. 정리는 REVIEW-03 으로 일정 간격(60초~5분)에만.
- 검증: 복제본 EXPLAIN 에서 CTE 가 `Index Only Scan using model_capacity_requests_active_idx` 인지. `tests/integration/ai2-stale-reconcile.test.ts`(미확정 비보호·reserved 만료 경계 포함) 통과. 배포 후 느린 문장 4행 소멸, `model_capacity_requests.seq_scan` 증가율.
- 배포 주의: 인덱스는 CONCURRENTLY. reviewer 역할 재시작.
- 확신도: CONFIRMED(CHECK·NOT NULL·보호 판정 함수까지 대조). seq scan 비중은 PLAUSIBLE(pg_stat_statements 로 확인).
- 규모: S

### REVIEW-05 `closeSettledSecondReviews` 의 정리 hint 가 LIMIT 없이 2차 표 이력 전체를 매 틱 평가
- 심각도: P1
- 분류: latency, inefficiency
- 위치: `lib/crawl/second-review.ts:664-700`
  ```ts
  const removedPredicate = and(inArray(secondReviews.status, ["pending", "failed", "agreed", "needs_human"]),
      secondReviewHasWorkloadPool() ? sql`NOT (${secondReviewPoolMembershipSql(sql`second_reviews`)})` : …);
  const orphanedPredicate = and(eq(secondReviews.status, "resolved"), eq(secondReviews.resolution, "fallback"), isNull(secondReviews.fallbackForId),
      sql`exists(select 1 from second_reviews child where child.fallback_for_id=${secondReviews.id} and child.resolution='model_removed')`, …
  const cleanupHints = await db.selectDistinct({ candidateId: secondReviews.candidateId }).from(secondReviews)
    .where(or(removedPredicate, orphanedPredicate, obsoletePredicate, legacyPredicate));
  ```
- 문제: `agreed` 에는 끝난 공개분 표본 이력까지 들어 있어 날마다 늘어난다(같은 파일 `:692` 주석이 settledHints 쪽에서만 이를 뺐다). 4 갈래가 OR 라 상관 서브쿼리가 semi-join 으로 올라가지 못하고 **행마다 SubPlan** 으로 돈다 — `secondReviewPoolMembershipSql`(`second-review-workload.ts:139-169`: `assignments × jsonb_array_elements(members)` EXISTS + NOT EXISTS) 를 active 행마다, `orphanedPredicate` 는 resolved/fallback 루트마다 인덱스 없는 `fallback_for_id` 로 표 전체 seq scan(REVIEW-01). 이것이 REVIEW-03 때문에 ~10초마다.
- 실측 근거: `pg-stats-primary.txt` `second_review_workload_assignments | 584 kB | 2359 | seq_scan 20658186 | seq_tup_read 4406017560 | idx_scan 5659551122` — 2,359행 표에 5.6일간 인덱스 탐색 56.6억 회(초당 약 1.2만). `slow-queries-primary.txt` 66행 `select distinct "candidate_id" from "second_reviews" where (("second_reviews"."status" in … NOT (CASE WHEN second_reviews.fallback_for_id IS NULL THEN (EXISTS (SELECT 1 FROM second_review_workload_assignments a, jsonb_array_elements…` — 이 쿼리 그대로(보통 0.5초 미만이라 3회만 기록).
- 수정 방안:
  1. `removedPredicate` 에서 공개분 `agreed`(published_slug IS NOT NULL) 를 제외 — settledHints 와 같은 기준(`:693-694`). 끝난 기록은 모델이 빠져도 닫을 일이 없다(사람 결정 대기만 의미).
  2. 갈래별로 따로 쿼리해 각자 인덱스를 타게 하고(`UNION`), 각각 `LIMIT`/커서.
  3. 회원 판정은 SQL 이 아니라 배정 표를 한 번 읽은 JS Set 으로(풀 구성원 수는 수 개), 또는 `second_review_workload_assignments` 를 `(second_review_id) INCLUDE (task_slot, config_revision, member_id, canonical_model)` 로.
  4. REVIEW-01 의 `fallback_for_id` 인덱스.
- 검증: EXPLAIN 에서 SubPlan 루프 수(`loops=`)가 수만 → 수백. 배포 후 `second_review_workload_assignments.idx_scan` 증가율 100배 이상 감소. 회귀 `tests/integration/second-review-controller-authority.test.ts`, `second-review-published.test.ts`.
- 배포 주의: reviewer 재시작. 공개분 agreed 제외가 운영자 결정(모델 제거 시 공개분 표 처리)과 충돌하지 않는지 확인 필요.
- 확신도: CONFIRMED(쿼리 구조·통계 일치). 공개분 agreed 제외의 정책 적합성은 PLAUSIBLE(운영자 확인).
- 규모: M

### REVIEW-06 사유 번역 dispatch 가 장부 control 행을 잠근 채 원문 본문 동등 비교로 심사 기록 전체를 seq scan
- 심각도: P1
- 분류: concurrency, latency
- 위치: `lib/crawl/translations.ts:330-346`(`lockReasonCache`), `:372-382`(`prepareReasonTranslationDispatch`), `lib/llm/capacity-repository.ts:1613`(reserved 경로 `control(tx)` = `FOR UPDATE`), `:98-101`(비예약 경로 `FOR SHARE`), `lib/crawl/reason-translation-model-capacity.ts:62, 103`(묶음마다 두 번 호출)
  ```ts
  for (const item of [...batch].sort((a, b) => a.hash.localeCompare(b.hash))) {
    if (currentSource) {
      const [source] = await tx.execute<{ present: boolean }>(sql`SELECT EXISTS (
        SELECT 1 FROM (${SOURCES}) src WHERE body = ${item.body} AND ${NEEDS_KOREAN}
      ) AS present`);
  ```
- 문제: `SOURCES` 는 `coalesce(a.reason, a.outcome->>'reason')`·`s.second_reason` 의 UNION 이라 본문 비교에 쓸 인덱스가 없다 → `crawl_review_attempts`(1.8GB)+`second_reviews` seq scan(+`outcome` jsonb detoast). 묶음(최대 4건) × 두 번(비예약 준비 `FOR SHARE`, 예약 준비 `FOR UPDATE`) = 최대 8번, 그중 4번은 **전역 control 행 `FOR UPDATE` 를 쥔 채**. 그동안 모든 다른 작업의 입장·dispatch·정산이 막힌다.
- 실측 근거: `slow-queries-primary.txt` 52행 `27 | 14 | 533 | 571 | … SELECT EXISTS ( SELECT N FROM ( select coalesce(a.reason, a.outcome->>'?') … WHERE body = $n AND length(`(0.5초 넘은 것만 27회 — 대부분은 그 아래로 숨음). 2·6·7·12행 control 잠금 대기 합 약 36,184초/일(이 경로는 원인 중 하나).
- 수정 방안(추천 1):
  1. 원본 존재 확인을 해시로: 구조 제안 S2 의 `reason_translation_sources(hash PK)` 가 있으면 `EXISTS(SELECT 1 FROM reason_translation_sources WHERE hash=$1)` 한 번. 표가 생기기 전 임시책으로 표현식 인덱스 `CREATE INDEX CONCURRENTLY ON crawl_review_attempts (md5(coalesce(reason, outcome->>'reason')))`·`ON second_reviews (md5(second_reason))` 를 만들고 조건을 `md5(body)=md5($1) AND body=$1` 로(md5·coalesce·->> 는 IMMUTABLE).
  2. 원본 확인은 control 잠금 **전**(비예약 준비 단계)에 한 번만 하고, 예약 TX 에서는 캐시 행 `FOR UPDATE` 재대조만 한다(원본이 사라지는 경우는 행 삭제뿐이라 드물다 — 결과 기록 TX 가 다시 잰다).
- 검증: EXPLAIN 이 `Index Scan` 인지. `tests/integration/reason-translation-capacity-dispatch.test.ts`, `reason-translation-capacity-ledger.test.ts`. 배포 후 `model_capacity_control … for update` 대기 평균.
- 배포 주의: 표현식 인덱스는 CONCURRENTLY(1.8GB 표 — 쓰기 부하 낮은 시간). text 역할 재시작.
- 확신도: CONFIRMED(호출 순서·잠금 모드 확인). control 대기 중 이 경로 비중은 PLAUSIBLE.
- 규모: S

### REVIEW-07 사유 번역 대기열·진행률이 매 호출 원본 40만 행을 해시·집계 — 진행률 4.6초 × 4,251회, 10초 한도에 근접
- 심각도: P1
- 분류: latency, structure
- 위치: `lib/crawl/translations.ts:33-37, 61-62`(`UNIQUE_TRANSLATION_SOURCES_SQL`), `:87-98`(`untriedTranslations`), `:107-118`(`retryableTranslations`), `:123-142`(`pendingReasonTranslationBatch` — 해시 4개를 찾으려고 **전체를 집계한 뒤** `u.hash = ANY(…)` 로 거름), `lib/operations/text-stage-progress.ts:35-58, 151-162`
  ```ts
  export const UNIQUE_TRANSLATION_SOURCES_SQL = sql`select encode(sha256(convert_to(body, 'UTF8')), 'hex') as hash, max(at) as at, min(ref) as ref
    from (${SOURCES}) src where ${NEEDS_KOREAN} group by 1`;
  ```
- 문제: #970 으로 임시 파일은 없앴지만 연산량은 그대로다 — 심사 기록·2차 표 전부를 읽고 행마다 sha256 을 계산해 GROUP BY. 번역 잡의 한 반복(묶음 1개)이 `retryable`/`untried`(1~2번) + `pendingReasonTranslationBatch`(재사용 경로) 로 이 집계를 여러 번 돌린다. 감시(monitor)의 진행 읽기는 `reason_translations` CTE 로 `text_translations` ko 전체까지 물질화해 평균 4.6초·최대 9.3초 — `TEXT_PROGRESS_STATEMENT_TIMEOUT.reason = '10s'` 에 바짝 붙어 있어 넘으면 진행이 `unknown` 이 되고 배포 관문이 막힌다(파일 주석의 11-02 사고와 같은 꼴). 원본은 계속 늘어난다.
- 실측 근거: `slow-queries-primary.txt` 3행 `3604 | 16580 | 4601 | 9080 | monitor`, 11행 `647 | 3071 | 4747 | 9355 | nomorevibe`. 합 19,651초/일(16%). 오류 집계 `875 | nomorevibe_monitor_20261022 | canceling statement due to statement timeout`(어느 문장인지는 로그에 없음 — 이 쿼리가 후보).
- 수정 방안: 구조 제안 S2(트리거로 유지하는 `reason_translation_sources`). 임시책: ① 진행률 'reason' 그룹을 감시가 매번 세지 말고 60초 공유 캐시(Valkey, `translationProgress` 와 같은 `createMemo`)에서 읽기, ② `pendingReasonTranslationBatch` 는 해시 4개만 알면 되므로 REVIEW-06 의 md5 인덱스로 ref 를 직접 찾기.
- 검증: 진행률 문장 p95 < 300ms, 감시의 statement timeout 수. `tests/integration/korean-translation-queue.test.ts`, `exaone-reason-translate-pool.test.ts`.
- 배포 주의: 트리거 추가는 마이그레이션 + 백필(40만 행, 배치로). 백필 완료 전에는 옛 경로 유지(기능 플래그).
- 확신도: CONFIRMED(쿼리 구조). 감시 timeout 875건 중 이 쿼리 비중은 PLAUSIBLE.
- 규모: M

### REVIEW-08 AI2(2차 표)는 모델 서버 장애도 실패 3회에 세어 사람·위임으로 넘긴다 — AI1·보류 Qwen 과 규칙이 다르다
- 심각도: P2
- 분류: logic
- 위치: `lib/crawl/second-review.ts:1334, 1366-1382, 1390-1398, 1438-1458`, `lib/crawl/second-review-item-lifecycle.ts:161-164`
  ```ts
  const status = result.ok ? combineVerdicts(…)
    : row.failureCount + 1 >= MAX_SECOND_REVIEW_FAILURES ? "needs_human" : "failed";
  …
  if (row.trigger === "ai_approved" && status === "needs_human") {
    … set({ state: "needs_review", reason: "second_review_split", …
  ```
- 문제: `cancelled` 만 빼고 `timeout`·`gateway_error`·`rate_limited`·`budget`(자체 분류 `SECOND_REVIEW_TRANSIENT_ERRORS`)도 `failureCount` 를 올린다. 일시 오류는 5분 뒤 재시도(`:1440, 1456`)라 **모델 서버가 약 10~15분 내려가면** 그동안 돈 표가 3회를 채워 `needs_human` 이 되고, 관문 표라면 후보가 `second_review_split` 사람 보류로 내려간다. 되돌리는 경로가 없다(`reopenOrphanedGateHolds` 는 `model_removed` 만, `:792`). AI1 은 `candidateRetryCountedFailure`(`lib/llm/provider-circuit-breaker.ts:53-56`)로 공급자 장애를 세지 않고 `reopenProviderExhaustedFirstReviews` 로 되돌리며, 보류 Qwen 은 `COUNTED_FAILURES` 만 센다(`held-qwen-retry.ts:132-133`). 회로 차단기는 기본 비활성(`provider-circuit-breaker.ts:13-20`).
- 실측 근거: 코드 근거만(크롤 통계에 2차 실패 분포 없음). 참고: `crawl-stats-replica.txt` `needs_review | second_review_split | auto | 4915`.
- 수정 방안: `recordSecondReview` 의 실패 셈을 `providerSideFailure(result.error)` 이면 `failureCount` 를 올리지 않고 `failed` + 재시도 시각만(AI1 과 같은 규칙). 소진 표 중 `errorCode ∈ PROVIDER_FAILURE_CODES` 인 것은 공급자 회복 뒤 `pending` 으로 되돌리는 정비(AI1 `reopenProviderExhaustedFirstReviews` 대응)를 추가. 대체 모델 선택(`:1334-1365`)은 지금처럼 유지.
- 검증: 새 통합 시험 — 같은 표에 `gateway_error` 3회 기록 시 `needs_human` 이 되지 않고 후보가 `approved` 로 남는지. 기존 `tests/integration/second-review-item-results.test.ts`, `second-review-capacity-wait-fallback.test.ts`.
- 배포 주의: text/reviewer·AI2 소비자 동시 배포(기록 함수 공유). 기존 소진 행 복구는 별도 운영 스크립트(감사 기록).
- 확신도: CONFIRMED(기록·재시도·되돌리기 경로 모두 확인)
- 규모: S

### REVIEW-09 사람 큐 위임(DeepSeek) 고르기가 매 틱 2차 표 이력 전체를 JS 로 읽고, 수천 개 id 를 IN 목록으로 넘겨 무거운 술어를 전부 평가
- 심각도: P2
- 분류: latency, inefficiency
- 위치: `lib/crawl/jobs/human-review.ts:57-60`, `lib/crawl/review-overview.ts:58-73`, `lib/crawl/second-review.ts:1479-1490`(`secondReviewSummary`: `status IN (pending,agreed,needs_human,failed)` 전체 행 + 그 id 전부로 배정 표 IN 조회), `lib/crawl/admin-review.ts:682-688`(보류 후보 전체의 성공 시도 `DISTINCT ON` — `snapshot->>'adminFirstReviewRerunId'` 로 큰 jsonb detoast), `lib/crawl/human-review-repository.ts:69-90`
  ```ts
  const overview = await humanQueueOverview(settings);
  const ids = [...new Set([...overview.ids.human, ...overview.ids.agreed])];
  const repos = await humanReviewRepos(ids, heldQwenOwnedReasons(settings),
    { settings, limit: HUMAN_REVIEW_MAX_PER_TICK * HUMAN_REVIEW_SCAN_FACTOR });
  ```
- 문제: 40건을 고르려고 ① 사람 큐 전체 개요(화면용 집계)를 계산하고 ② 그 id 수천 개를 `inArray` 로 넘겨, id 마다 `currentReviewSource`(REVIEW-02 와 같은 무거운 EXISTS)·`count(*)` 서브쿼리를 평가한 뒤 `ORDER BY updated_at DESC LIMIT 40`. 정렬 전에 모든 id 의 술어를 계산해야 한다.
- 실측 근거: `slow-queries-primary.txt` 13행 `1293 | 2572 | 1989 | 2545 | select "repo" from "crawl_candidates" where ("crawl_candidates"."id" in ($n,...`(= `humanReviewRepos`, 하루 1,293회 ≈ 1분 틱). `crawl_review_attempts seq_scan 628528`(원인 일부).
- 수정 방안: 잡은 개요를 부르지 말고 사람 큐 술어를 SQL 로 직접(`needs_review` 이고 `decided_by='auto'` … 인덱스 `(state, updated_at DESC)` 로 걷기) 쓰고, 값싼 조건으로 먼저 거른 뒤 `LIMIT 4×` 범위에서만 `currentReviewSource` 를 평가(`LATERAL` + `LIMIT`). `secondReviewSummary` 는 공개분 agreed 를 빼고 읽기.
- 검증: EXPLAIN 시간 <200ms, 느린 문장 13행 소멸. `tests/integration` 의 human-review 관련(`human-review*.test.ts`) 통과, 고르기 순서(최신 우선·끝낸 후보 제외) 유지 확인.
- 배포 주의: reviewer 재시작.
- 확신도: CONFIRMED(호출 경로). 2초의 내부 비중은 EXPLAIN 필요.
- 규모: M

### REVIEW-10 `candidateItemsBusy` 의 jsonb OR 조건이 `pipeline_item_leases` ai2 행 전체를 훑는다 — 정비 TX 마다 두 번, 표는 줄지 않는다
- 심각도: P2
- 분류: latency, concurrency
- 위치: `lib/crawl/second-review.ts:139-151`(호출 `:189`), 같은 꼴 `:1202-1203`, `lib/crawl/admin-review-rejected-rerun.ts:458-461`
  ```ts
  const where = and(eq(pipelineItemLeases.stage, "ai2"), or(
    sql`${pipelineItemLeases.binding}->>'candidateId' = ${String(candidateId)}`,
    keys.length ? inArray(pipelineItemLeases.workKey, keys) : undefined,
  ));
  const locked = await tx.select(…).where(where).orderBy(pipelineItemLeases.workKey).for("update", { skipLocked: true });
  const existing = await tx.select(…).from(pipelineItemLeases).where(where);
  ```
- 문제: 인덱스는 PK `(stage, work_key)`·만료 부분 인덱스뿐(`lib/db/operations-schema.ts:98-104`). `binding->>'candidateId'` 갈래 때문에 `stage='ai2'` 범위 전체(또는 seq scan)를 읽는다. 행은 지워지지 않아(삭제 경로 없음) 계속 커진다. controllerWrite(올리기·닫기·정리·되돌리기·재시도, 후보마다)가 매번 두 번 실행 — REVIEW-03 의 주기와 곱해진다.
- 실측 근거: `pg-stats-primary.txt` `pipeline_item_leases | 74 MB | 78262 | seq_scan 1890239 | seq_tup_read 119066999158`(스캔당 약 6.3만 행).
- 수정 방안: `CREATE INDEX CONCURRENTLY pipeline_item_leases_ai2_candidate_idx ON pipeline_item_leases ((binding->>'candidateId')) WHERE stage='ai2';` → BitmapOr 가능. 장기: 끝난 item 행(토큰 null·오래됨) 보관 정리(db-retention) — 소유권 이력이 필요하면 `evidence ledger` 쪽에 남는지 먼저 확인.
- 검증: EXPLAIN `BitmapOr`. `tests/integration/second-review-controller-locks.test.ts`.
- 배포 주의: 인덱스만이면 일반 배포.
- 확신도: CONFIRMED(쿼리·인덱스). seq scan 전부가 이 경로인지는 PLAUSIBLE(`fetch-ownership`·`agent-review-ownership` 은 PK 등식이라 제외됨).
- 규모: S

### REVIEW-11 README 갱신 대기열이 3.5GB `crawl_documents` 를 jsonb 조건으로 통째 훑는다 (2.7초)
- 심각도: P2
- 분류: latency
- 위치: `lib/crawl/repository.ts:517-526`(`pendingPublishedReadmes`)
  ```ts
  return db.select().from(crawlDocuments).where(sql`
    ${crawlDocuments.pageMeta}->'readmeSampleVersion' = 'null'::jsonb
    and jsonb_typeof(${crawlDocuments.pageMeta}->'readmeSample') = 'string'
    and (case when jsonb_typeof(${crawlDocuments.pageMeta}->'readmeRetryAfter') = 'number' … ) <= extract(epoch from now()) * 1000
    and exists(select 1 from crawl_candidates c join products p on p.slug = c.published_slug …)
  `).orderBy(asc(crawlDocuments.id)).limit(limit);
  ```
- 문제: 대상은 "다시 받아야 하는 발췌" 소수인데 조건이 모두 `page_meta` jsonb 식이라 인덱스가 없고, 106만 행 문서 표를 `ORDER BY id LIMIT` 로 끝까지 걷는다(대상이 적을수록 느리다).
- 실측 근거: `slow-queries-primary.txt` 15행 `272 | 737 | 2711 | 3087 | select "id", "repo", "repo_meta", … from "crawl_documents" where "crawl_documents"."page_meta"->'?' = '?'::jsonb …`.
- 수정 방안: 부분 표현식 인덱스 `CREATE INDEX CONCURRENTLY crawl_documents_readme_refresh_idx ON crawl_documents (id) WHERE page_meta->'readmeSampleVersion' = 'null'::jsonb AND jsonb_typeof(page_meta->'readmeSample') = 'string';`(식이 쿼리와 글자 단위로 같아야 함). 장기: S5(due 칸).
- 검증: EXPLAIN `Index Scan using crawl_documents_readme_refresh_idx`. `tests/integration/readme-refresh.test.ts`.
- 배포 주의: 3.5GB 표 CONCURRENTLY — 디스크 여유 확인(11-15 디스크 장애 이력).
- 확신도: CONFIRMED
- 규모: S

### REVIEW-12 소개 검수 대기열이 1분마다 공개 제품을 id 역순으로 끝까지 걷는다 (0.94초, 넓은 TOAST 칸 포함)
- 심각도: P2
- 분류: latency
- 위치: `lib/domain/products/intro-checks.ts:48-74`, `lib/jobs/products/intro-check.ts:41-46`
  ```ts
  const rows = await db.select({ product: FIELDS, check: productIntroChecks })
    .from(products).leftJoin(productIntroChecks, eq(productIntroChecks.productId, products.id))
    .where(pendingIntroCheckPredicate()).orderBy(sql`${products.id} desc`).limit(limit);
  ```
- 문제: 대기열이 거의 비어 있을 때(평시) `LIMIT 10` 을 못 채워 11.5만 제품 전부를 `hasActiveMaker` 상관 EXISTS·`checked_tagline <> tagline` 비교와 함께 평가한다. `FIELDS` 에 `search_page_text`·`search_readme`·`description` 이 있어 결과 행마다 큰 칸을 읽는다(대기열 판정에는 불필요).
- 실측 근거: `slow-queries-primary.txt` 14행 `1431 | 1350 | 944 | 1108 | select "products"."id", … "products"."search_page_text", "products"."search_readme", "product_intro_checks"…`.
- 수정 방안: ① id 만 고르는 1단계(좁은 칸) → 그 id 로 FIELDS 읽기, ② `products` 에 부분 인덱스 `(id DESC) WHERE status IN ('seeded','verified') AND source='crawler' AND claimed_at IS NULL AND tagline_source IN ('ai_page','ai_readme','ai_both','maker')`, ③ 장기 S5: `products.tagline` 변경 시 검수 필요 표지를 세우는 트리거.
- 검증: EXPLAIN 시간·버퍼. `tests/integration/intro-check.test.ts`.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED(쿼리), 평시 빈 대기열 가정은 PLAUSIBLE(`jobs.txt` 성공이 1분마다 — 처리가 계속되는지 대기 수 확인 필요).
- 규모: S

### REVIEW-13 공식 사이트 근거 claim 이 한 건 고를 때마다 제품×근거×요청×claim 전체 조인을 최대 3번 — 전역 control 행 `FOR UPDATE` 아래
- 심각도: P2
- 분류: latency, concurrency
- 위치: `lib/domain/evidence/source-claims.ts:58-85`(`selectTarget` … `limit 1`), `:122-130`
  ```ts
  const [control] = await tx.select().from(evidenceSourceControl).where(eq(evidenceSourceControl.id, 1)).for("update");
  …
  for (let offset = 0; offset < SOURCE_LANES.length; offset++) {
    lane = SOURCE_LANES[(control.cursor + offset) % SOURCE_LANES.length];
    id = await selectTarget(tx, lane, policyHash, productId); if (id !== undefined) break;
  }
  ```
  호출: `lib/jobs/products/evidence-refresh.ts:66-68`(틱당 최대 4번).
- 문제: `selectTarget` 의 `case … end = ${lane}` 은 CTE 전체를 만든 뒤 거르므로 공개 제품 전부(약 11만)를 4표 LEFT JOIN 해 `next_attempt_at` 정렬 후 1건. 고를 것이 없으면 3 레인을 모두 돌아 3번 전수. 그동안 `evidence_source_control` 단일 행 `FOR UPDATE` 로 다른 claim 이 모두 기다린다. 틱당 4 claim → 최대 12번 전수.
- 실측 근거: `pg-stats-primary.txt` `product_evidence_sources | 534 MB | seq_scan 245480 | seq_tup_read 52431204927`, `product_evidence_sources_due_idx | 24 MB | idx_scan 0`(인덱스가 전혀 안 쓰임).
- 수정 방안: 한 번의 쿼리로 레인별 첫 후보를 함께 고르고(`DISTINCT ON (lane)` 또는 레인 3개 `UNION ALL … LIMIT 1` 각각을 인덱스 친화 조건으로), `next_attempt_at` 이 지난 것만 먼저 인덱스로 좁힌다(`product_evidence_sources (kind, source_key, next_attempt_at)` 부분 인덱스). control `FOR UPDATE` 는 커서 갱신 직전까지 미루거나 `SKIP LOCKED` 후보 잠금으로 대체.
- 검증: EXPLAIN, `tests/integration/evidence-source-claims.test.ts`.
- 배포 주의: crawler 역할 재시작.
- 확신도: PLAUSIBLE(쿼리 구조·통계는 일치, seq scan 의 이 경로 비중은 pg_stat_statements 확인 필요)
- 규모: M

### REVIEW-14 가동 확인 claim 이 due 인덱스를 한 번도 쓰지 않고 `uptime_claims` 를 훑는다
- 심각도: P2
- 분류: latency
- 위치: `lib/domain/products/uptime-claims.ts:137-154`
  ```sql
  from uptime_claims c join products p on p.id = c.product_id left join product_health h on h.slug = p.slug
  where … and (c.state = 'idle' or (c.state = 'claimed' and c.lease_until <= …))
    and c.due_at <= …
    and not exists (select 1 from uptime_claims o where o.state = 'claimed' and o.lease_until > clock_timestamp()
      and o.owner_instance_id <> ${owner.instanceId} and o.origin = ${originOf(sql`p.url`)})
  order by (c.confirm_class is not null) desc, c.due_at, c.product_id limit ${allowance} for update of c skip locked
  ```
- 문제: 정렬 첫 키가 `(confirm_class is not null) desc` 라 `uptime_claims_due_idx (due_at, product_id) WHERE state <> 'submitted'` 순서와 맞지 않고, 제품·건강 표 조인과 `origin` 반조인(인덱스 없음)이 붙어 계획기가 전수 + 정렬을 고른다. 쓰기 갱신이 잦은 표(n_tup_upd 319만)라 매번 전수 비용이 크다.
- 실측 근거: `pg-stats-primary.txt` `uptime_claims | 66 MB | 106608 | seq_scan 552150 | seq_tup_read 42921230649`, `uptime_claims_due_idx | 32 MB | idx_scan 0`.
- 수정 방안: 재확인(confirm) 줄과 일반 줄을 두 쿼리로 나눠 각자 `due_at` 인덱스 순서로 걷기(`… WHERE c.state IN ('idle','claimed') AND c.due_at <= now ORDER BY c.due_at, c.product_id`), 부분 인덱스 `(origin) WHERE state='claimed'` 추가. 쓰지 않는 `uptime_claims_due_idx` 는 새 인덱스로 교체.
- 검증: EXPLAIN 에서 due 인덱스 사용. uptime claim 통합 시험(`tests/integration/uptime*`).
- 배포 주의: uptime 소비자·monitor 재시작 여부 확인.
- 확신도: PLAUSIBLE(계획은 EXPLAIN 으로 확인 필요 — 인덱스 0회 사용과 seq scan 수는 확정)
- 규모: S

### REVIEW-15 `console-alerts` 10시간 무성공은 "알림 묶음을 셀 수 없는 틱 = degraded" 표시 방식 — 실제 원인은 관측 줄에 있다
- 심각도: P3
- 분류: logic(표시)
- 위치: `lib/jobs/console-alerts.ts:27-36`, `lib/jobs/runner.ts:302`, `lib/operations/console-tasks.ts:79-83, 425-541`, `lib/operations/console-home-read.ts:113-137`
  ```ts
  const unknown = board.groups.filter(group => group.notify && group.unknown.length).flatMap(group => group.unknown);
  …
  if (unknown.length) return { done: true, cursor: null, degraded: { code: "console_tasks_unknown", detail: `셀 수 없음 · ${unknown.slice(0, 4).join(" · ")}` } };
  ```
- 문제: 틱은 매번 알림 줄을 열고 닫는 일을 다 한다(`applyConsoleAlertPlan`). 다만 알림 묶음(멈춤·평소와 다름) 입력 중 하나라도 null(읽기 실패·캐시 실패)이면 degraded 로 끝나고 러너가 `lastSuccessAt` 을 옮기지 않는다. 13:49Z 이후 어떤 입력(`conveyor`·단계 처리 수·`jobs`·`admission`·`takedown`·`koreanDiscovery`·`changeWatch`)이 계속 못 읽힌 상태다. 이 구역 관련 후보는 진행 읽기의 사유 번역 그룹(REVIEW-07, 10초 한도 근접)이지만 진행 입력(`progress`)은 비알림 묶음(`pile`)이라 이 경보와는 무관 — **원인은 `operations_observations` 의 `job:console-alerts` → `degraded.detail`(최대 4개 이름)로 바로 확인**해야 한다.
- 실측 근거: `jobs.txt` `console-alerts | 2488 | 23:54:41 | 2026-11-20 13:49:44`.
- 수정 방안: 결함이 아니면 표시만 — 관리자 상태에 degraded detail 을 함께 보이기(이미 관측에 있음). 실제 고칠 대상은 detail 이 가리키는 읽기(운영 구역).
- 검증: `job:console-alerts` 관측의 `degraded.detail` 확인 → 해당 읽기 수정 후 `lastSuccessAt` 갱신.
- 배포 주의: 없음(조사 먼저).
- 확신도: CONFIRMED(메커니즘). 어느 입력인지는 미확인.
- 규모: S

### REVIEW-16 `secondReviewSummary` 의 풀 모드 판정이 행마다 메모 없는 모델 식별 계산을 3번 — 웹·reviewer 이벤트 루프 정지
- 심각도: P3
- 분류: inefficiency, async
- 위치: `lib/crawl/second-review.ts:1496-1521`, `lib/crawl/second-review-workload.ts:77-89, 252-258, 286-291`, `lib/crawl/review-model-identity.ts:24-27, 50-55`
  ```ts
  const outstanding = group.filter((row) => (row.fallbackForId || (pool
    ? secondReviewVoteEligible(row.model, assignments.get(row.id)) : true)) && …
  … model: pool ? secondReviewAssignedVoteCanonical(row.model, assignments.get(row.fallbackForId ?? row.id), !!row.fallbackForId) : row.model }));
  const unverifiedPoolModel = pool && group.some(row => !secondReviewVoteEligible(…));
  ```
- 문제: 11-10 에 `reviewIndependenceKey` 한 경로만 메모했다(`:1496-1504` 주석: 호출당 0.6ms, 후보 수천에 3~5초 정지). 같은 함수를 부르는 `secondReviewAssignedVoteCanonical`·`modelCanonical`(호출마다 `resolveReviewTaskRanks`·`reviewRouteContracts`·`readModelRegistry` 재조회)은 메모 없이 배정 있는 행마다 최대 3번. 웹(관리자 심사 큐)과 사람 큐 위임 틱(REVIEW-09)이 이 동기 루프를 탄다.
- 실측 근거: 코드 근거만(주석의 0.6ms 실측 인용).
- 수정 방안: 같은 함수 안에서 `model→canonical` Map 메모를 두고 `secondReviewVoteEligible`·`secondReviewAssignedVoteCanonical` 에 주입. `secondReviewHasWorkloadPool()`·`secondReviewWorkloadSlots()` 도 한 번만 계산해 넘긴다.
- 검증: 단위 시험으로 같은 결과, 로컬 측정(행 5천)에서 루프 시간 <100ms.
- 배포 주의: 일반 배포.
- 확신도: PLAUSIBLE(정지 시간은 측정 필요)
- 규모: S

## 구조 변경 제안 (리팩토링으로 효율화)

### S1. 2차 심사 정비를 "매 틱 전수 재검사"에서 "바뀐 후보만 처리하는 사건 대기열"로
- 지금: `second-review` 틱마다 올리기(보류·승인 후보 전체 `DISTINCT ON`)·닫기(이력 전체 OR 평가)·정리(대기 표 전체 hint + 후보당 잠금 TX)·되돌리기·재시도를 처음부터 계산(REVIEW-03·04·05). 각 함수가 같은 후보를 따로 잠근다.
- 바꿀 구조: `ai2_controller_dirty(candidate_id PK, reason, queued_at)` 표를 두고, 후보 상태·1차 시도·2차 표·설정(투표자) 변경 지점(AI1 기록, 2차 기록, 발행, 사람 결정, 투표자 저장)이 같은 TX 에서 dirty 행을 upsert. 정비 틱은 `DELETE … RETURNING` 으로 N개를 꺼내 후보당 **한 번** 잠그고 올리기·닫기·정리를 한 함수에서 판정. 전수 재검사는 하루 몇 번의 안전망(커서)으로만.
- 얻는 것(추정): 느린 문장 4행(10,292초/일)·66행·관련 seq/idx scan 대부분 제거 → 주 DB 하루 약 3~4시간 CPU 절감, 장부·후보 행 잠금 경합 감소. 새 후보 enqueue 지연은 사건 즉시.
- 옮기는 순서: ① REVIEW-03(완료 틱·백오프)·REVIEW-04 SQL 수정(위험 낮음) → ② dirty 표 + 쓰기 지점 기록(관찰 모드: 정비는 그대로, dirty 와 전수 결과를 비교 로그) → ③ dirty 기반 정비로 전환, 전수는 시간당 1회 → ④ 비교 로그 1주 무차이 확인 후 전수 주기 축소.
- 위험: 쓰기 지점 누락 시 정리가 늦어짐(안전망 전수가 막음). 잠금 순서(stage→후보→표→item→jobs)를 dirty 표 쓰기가 깨지 않게 dirty 는 TX 마지막에.

### S2. 사유 번역 원본 표(`reason_translation_sources`)를 트리거로 유지
- 지금: 대기열·배치 재구성·원본 존재 확인·진행률이 모두 심사 기록·2차 표 40만 행을 해시해 GROUP BY(REVIEW-06·07).
- 바꿀 구조: `reason_translation_sources(hash text PK, ref text, latest_at timestamp, needs_korean bool)` + `crawl_review_attempts`(INSERT/UPDATE OF reason, outcome)·`second_reviews`(INSERT/UPDATE OF second_reason)에 AFTER ROW 트리거로 upsert(`latest_at = greatest`). 인덱스 `(latest_at DESC) WHERE needs_korean`. 대기열 = 이 표 LEFT JOIN `text_translations`(PK) 의 반조인 `LIMIT`, 진행률 = 두 표 count(또는 유지 카운터).
- 얻는 것: `reason_eligible` 19,651초/일 + 번역 잡의 반복 집계 + control 잠금 아래 seq scan 제거. 진행률 쿼리 수 ms → 배포 관문 `unknown` 위험 해소.
- 옮기는 순서: ① 표·트리거 마이그레이션(새 쓰기만 기록) → ② 배치 백필(40만, 1만씩) → ③ 진행률·대기열 읽기를 새 표로(옛 쿼리와 수 비교 관측) → ④ `lockReasonCache` 원본 확인을 해시 조회로.
- 위험: 트리거 비용(심사 기록 쓰기당 sha256 1회 — 무시 가능), `NEEDS_KOREAN` 규칙 변경 시 재계산 필요(버전 칸 두기).

### S3. 발행 준비 상태를 유지 칸으로 (`crawl_candidates.publish_gate_ready_at` 또는 `publication_queue`)
- 지금: 발행 잡이 승인 후보 전부에 관문 술어(1차 원본 대조 + 2차 승인 + 분류 준비)를 매 반복 재평가(REVIEW-02).
- 바꿀 구조: 2차 관문 표가 `agreed/approve` 로 기록되는 TX(`recordSecondReview` `:1403-1404`, 이미 `requestJob("crawl-publish")` 하는 자리), 별 자동승인 판정, 분류 결정(`categories.ts:52`) 에서 `publication_queue(candidate_id PK, ready_at, gate_hash)` 를 upsert. 발행 잡은 이 표를 `ready_at` 순으로 읽고 발행 TX 의 `assertReviewApproval` 로 최종 확인(지금과 동일), 실패하면 큐 행 삭제.
- 얻는 것: 34,309초/일(28%) 쿼리를 인덱스 조회로. publisher 틱이 짧아져 미룸 재실행도 싸짐.
- 옮기는 순서: REVIEW-01 인덱스 → 큐 표 기록(관찰) → 큐 기반 고르기 + 옛 술어로 교차 검증(1주) → 옛 술어 제거.
- 위험: 승인 근거가 바뀌는 경로(원본 갱신·설정 변경) 누락 시 발행 시도 후 `review_approval_changed` 로 사람에게(현행 안전장치가 받아냄).

### S4. 러너의 미룸 백오프 표준화
- 지금: 모든 미룸이 5초 poll 재실행(REVIEW-03). 잡마다 미룸 이유가 다른데 같은 간격.
- 바꿀 구조: `JobOutcome` 미룸에 `retryAfterMs`(선택). 러너가 `notBefore` 로 적고, 이유별 기본값(model_capacity 30초, stage_blocked=잡 일정, http_origin_permit 은 permit 대기 시간). 사건 요청(`requestJob`)은 `notBefore` 를 지우지 않으므로(현행 `PAUSED` 처리와 구분 필요) 깨우기 경로는 `requestJob` 에 `wake:true` 를 두어 백오프를 무시.
- 얻는 것: 무거운 대기열 쿼리 반복 6~40배 감소, `defer:<job>` 관측 쓰기 감소.
- 위험: 사람이 멈춘 잡(먼 미래 `notBefore`)과 구분 — 기존 `PAUSED_AFTER_MS` 문턱보다 짧은 값만 허용.

### S5. 후처리 due 대기열 패턴 통일 (소개 검수·README 갱신·근거 claim)
- 지금: 각 잡이 "할 일 있음"을 넓은 표의 식으로 매번 계산(REVIEW-11·12·13·14).
- 바꿀 구조: 대상 표마다 `next_due_at`(또는 `needs_*` 표지) 칸 + 부분 인덱스. 원인 변경(제품 소개 변경, 문서 재수집, 정책 해시 변경)이 그 칸을 세움(트리거 또는 쓰기 함수). 잡은 `WHERE next_due_at <= now() ORDER BY next_due_at LIMIT n FOR UPDATE SKIP LOCKED`.
- 얻는 것: 1분 주기 전수 스캔 제거(합계 약 2,100초/일 + seq scan 수십억 행).
- 위험: 표지 누락 시 대상이 빠짐 → 하루 1회 전수 대조를 안전망으로.

## 확인했지만 문제 아님
- `product_audit_campaigns` seq_scan 1,390만: 아주 작은 표를 행마다 참조하는 스칼라 서브쿼리(`lib/crawl/audit-stream.ts:17-22`, `product-audit-hold.ts:214`) 때문 — 5.6일 읽은 행 8,344만으로 비용 미미.
- AI1 공급자 장애 실패는 시도 수에 세지 않고 회복 뒤 되돌림(`lib/llm/provider-circuit-breaker.ts:53-56`, `agent-review-repository.ts:717`) — 정상.
- 보류 Qwen 재심사는 셀 실패 코드만 셈(`lib/crawl/held-qwen-retry.ts:132-133`), 취소는 superseded(`:409`) — 정상.
- `closeSettledSecondReviews` settledHints 의 `LIMIT 1000` 머리 고정: SQL 조건(`second-review.ts:693-697`)이 컨트롤러 `settled` 판정(`:750-753`)과 같아 집힌 행은 닫힌다 — 고정되지 않음.
- 사유 번역 "맨 앞 묶음 고정": 장부가 쥔 글을 `notBusy` 로 건너뜀(`translations.ts:80-82`), 재시도/새 글 번갈아(`jobs/translate-reasons.ts:124-130`) — 해결됨.
- 발행 실패 후보가 approved 에 남아 매 틱 다시 집히는 문제: 실패 사유를 needs_review/rejected 로 옮김(`jobs/publish.ts:267-298`) — 해결됨.
- 사람 큐 위임의 끝낸 후보 머리 고정: SQL 에서 제외(`human-review-repository.ts:57-63, 82-87`) — 해결됨(비용 문제는 REVIEW-09).
- items 모드에서 legacy `second-review` 와 AI2 소비자의 이중 dispatch: legacy 는 `canStartLegacySecondReview`(stage=legacy)일 때만 표를 보고(`second-review-ownership.ts:260-267`), 정비 TX 는 live item 이 있으면 쓰지 않음(`second-review.ts:189`) — 중복 없음.
- 긴 TX 안 외부 호출: 위임 저장소 확인은 TX 밖(`jobs/human-review.ts:97-101`), 발행 분류는 claim TX 밖에서 호출 — 문제 없음.

## 범위 밖·못 본 것
- 모델 장부 내부(control 행 잠금 대기 합 약 36,000초/일의 전체 원인, `model_capacity_requests` 전수 스캔의 다른 경로) — 장부 점검자 몫. 여기서는 호출 쪽 REVIEW-01·04·06 만.
- `crawl-judge` 의 `judgementQueue`(868ms × 10,220, `lib/crawl/repository.ts:800-810`) — 규칙 판정(수집 구역).
- 한국어 소개 대기열(531ms × 746), `product_translations` seq scan(열린 PR #985·#986 이 같은 잡을 고침).
- `nomorevibe` 계정 statement timeout 10,383건/일 — 문장 텍스트가 오류 집계에 없어 귀속 불가(`log_min_error_statement` 또는 pg_stat_statements 필요). 발행 쿼리·2차 hint 최대치가 모두 14초대(웹 기본 15초 한도 근처)인 점은 확인 가치가 있음.
- `crawl_candidates` seq_scan 140만·`crawl_review_attempts` seq_scan 63만의 전체 귀속(REVIEW-07·09 외 경로) — pg_stat_statements 없이 확정 불가.
- EXPLAIN 미실행(규칙상 DB 접속 금지) — 모든 시간 비중 판단은 통계와 쿼리 구조로 추정.
