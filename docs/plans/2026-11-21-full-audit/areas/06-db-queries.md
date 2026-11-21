# 06. 스키마·인덱스·쿼리 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


기준 코드: `저장소 루트` (origin/main `34b5fe32`). 운영 DB 접속·EXPLAIN 없이 근거 파일(`evidence/*.txt`)과 코드만으로 추적했다 — 실행 계획에 관한 주장은 모두 「검증」 칸의 EXPLAIN 으로 확인해야 한다.

## 요약

- 건수: **P0 0 · P1 7 · P2 6 · P3 5** (총 18)
- 23시간 느린 문장 합계 122,852초를 모양별로 나누면: 발행 관문 대기열 34,309초(27.9%) · 장부 control 행 잠금 대기 36,317초(29.6%, 원인만 — llm-capacity 몫) · 사유 번역 진행 집계 19,651초(16.0%) · 2차 낡은 표 힌트 10,292초(8.4%) · 판정 대기열 8,871초(7.2%) · uptime 장부 readback 4,160초(3.4%) · 위임 검수 고르기 2,572초(2.1%). 이 7개가 82%다.
- 가장 중요한 5개
  1. **DB-01** 발행 잡의 대기열 문장(평균 2.7초·하루 1.2만 회)이 승인 후보 전부에 무거운 관문 술어를 행마다 돌린다 — 핵심 하위 질의가 쓰는 `second_reviews.first_attempt_id` 에 색인이 아예 없다.
  2. **DB-02** 역할 워커가 15초마다(주 역할마다) 전체 흐름 집계 `readWorkerProgress` 를 주 DB 에서 새로 센다 — crawl_frontier·crawl_documents·second_reviews·crawl_review_attempts 전체 훑기와 uptime readback(평균 572ms×7,210회)이 이 경로다.
  3. **DB-03** 감시·운영 콘솔의 사유 번역 진행 문장(평균 4.6초·하루 4,251회)이 사유 40만 행 전체를 매번 sha256 으로 묶고, 같은 TX 가 `SET LOCAL work_mem='32MB'` 로 낮춰 해시 집계(약 70MB)가 임시 파일로 흘린다 — DB 임시 파일 1,205GB/5.6일과 맞는다.
  4. **DB-04** 2차 낡은 표 힌트(평균 7.3초)가 매번 2.47GB `model_capacity_requests` 를 `coalesce(state,'') NOT IN` 으로 전부 훑고, 후보 행 × 장부 행 쌍마다 LIKE·정규식을 돈다 — 이미 있는 부분 색인(0151 active_idx)로 같은 결과를 낼 수 있다.
  5. **DB-05** 판정 대기열 `judgementQueue` 가 `c.id IS NULL OR c.state='new'` 의 외부 조인이라 큐가 비어도 원본 107만 행을 매 호출 끝까지 훑는다(평균 868ms·하루 1만 회). 같은 술어를 진행 집계·발굴 관문도 센다.

## 발견

### DB-01 발행 대기열 문장이 승인 후보마다 관문 술어를 통째로 평가하고, 그 핵심 하위 질의에 색인이 없다
- 심각도: P1
- 분류: latency
- 위치:
  - `lib/crawl/jobs/publish.ts:115-124` — 틱 안의 `while` 이 묶음마다 대기열을 다시 읽는다.
    ```ts
      while (ctx.hasBudget()) {
        // Filter before LIMIT so pending reviews cannot starve approved products.
        const eligible = pool || process.env.CONNECT_AGENT_URL
          ? and(reviewApprovalPredicate(settings), or(classificationReadyPredicate(), starAutoApprovalPredicate(settings)))
          : reviewApprovalPredicate(settings);
    …
        const candidates = await crawl.listCandidates(["approved"], resume ? BATCH : BATCH * classifyConcurrency,
          and(eligible, resume ? inArray(crawlCandidates.id, [...resume.candidateIds]) : undefined,
            conflicts.size || classificationWaiting.size ? notInArray(crawlCandidates.id, [...conflicts, ...classificationWaiting]) : undefined));
    ```
  - `lib/crawl/repository.ts:896-907` `listCandidates` — `select *` + `state IN (...)` + `ORDER BY updated_at DESC LIMIT`.
  - `lib/crawl/agent-review-repository.ts:432-445` `reviewApprovalPredicate`(CASE 안의 EXISTS → 행마다 SubPlan), `:338-375` `matchingSource`/`currentReviewSource`(시도 행마다 crawl_documents + LATERAL agent_repository_scans + README 비교).
    아래는 agent-review-repository.ts:365-366 이다. 다음 줄(:367)이 `${README_SAMPLE_LIMIT}` 와 공백 문자 집합으로 btrim 을 닫는다.
    ```ts
            AND coalesce(${crawlReviewAttempts.snapshot}->'product'->>'readme', '') = btrim(left(
              CASE WHEN jsonb_typeof(rd.page_meta->'readmeSample') = 'string' THEN rd.page_meta->>'readmeSample' ELSE '' END,
    ```
  - `lib/crawl/second-review-workload.ts:261-284` `secondReviewPoolApprovedSql` — `second_reviews g WHERE g.first_attempt_id = ${attempt.id} AND g.trigger='ai_approved' AND g.status='agreed' …` 와 `NOT EXISTS (… g.first_attempt_id = … AND g.status IN ('pending','failed','needs_human'))`.
  - `lib/db/second-review-schema.ts:76-77` — second_reviews 의 색인은 `(candidate_id,input_hash,model,generation_key)` 유일 색인과 `(status, created_at)` 뿐. `drizzle/*.sql` 전체에도 `first_attempt_id` 색인이 없다(0033 은 칸만 추가).
- 문제: 승인 후보(approved 589건 — `crawl-stats-replica.txt:30,42`)마다 CASE 안 EXISTS 가 SubPlan 으로 돈다. 승인된 시도마다 (a) `currentReviewSource` 가 시도 행의 `snapshot`(jsonb, crawl_review_attempts 평균 5KB/행)과 원본 `page_meta` 를 TOAST 해제해 README 를 문자열 비교하고, (b) 2차 표 관문이 `second_reviews` 를 `first_attempt_id` 로 찾는데 색인이 없어 `status='agreed'` 범위나 표 전체(20만 행)를 훑는다. 후보 몇이 2차 표를 기다리는 동안(승인 589건 중 대부분) LIMIT 을 못 채워 매 호출 589건 전부를 평가한다. 발행 잡은 다른 잡의 `requestJob('crawl-publish')` 로 자주 깨어(14만 회 실행) 틱마다 이 문장을 최소 1회, 분류 묶음마다 다시 낸다. 같은 술어를 `pipelineThroughput`(DB-02)·`discovery-admission.ts:126` 도 센다.
- 실측 근거: `slow-queries-primary.txt:2` 11,242회·30,676초·평균 2,729ms·최대 14,196ms, `:10` 1,135회·3,633초·평균 3,201ms·최대 14,772ms(두 모양 = 23시간 느린 시간의 27.9%). `pg-stats-primary.txt:13` second_reviews seq_scan 1,336,952회·seq_tup_read 1,179억(1회 평균 8.8만 행), idx_scan 38.5억. `:24` second_review_workload_assignments idx_scan 56.6억(2,359행 표 — 행마다 회원 자격 SQL 이 PK 를 찌른다). 최대값이 15초 바로 밑에 모이는 것은 역할 기본 statement_timeout 에 걸려 잘린 호출이 오류 쪽(`:70` 10,383회)으로 빠졌을 가능성을 시사한다(DB-13).
- 수정 방안(추천 순):
  1. 색인 — `lib/` 의 약 45줄(`rg "first_attempt_id\s*=|firstAttemptId, "`)이 같은 열로 찾는다. 제안 DDL(새로 만들 것이라 인용이 아니다): `CREATE INDEX CONCURRENTLY second_reviews_first_attempt_idx ON second_reviews (first_attempt_id, trigger, status) WHERE first_attempt_id IS NOT NULL;`
     크기 약 8~10MB(20만 행). 쓰기 비용: second_reviews 갱신 52,765회/5.6일, 이미 status_idx 때문에 HOT 469 — 추가 비용 미미. 겹치는 색인 없음.
  2. 대기열 문장을 두 단계로: ① `state='approved'` 후보 id 를 `updated_at DESC` 로 싸게 읽고(상태 색인), ② 관문 술어는 `LATERAL`/`IN (…)` 로 그 묶음에만 평가하며, 한 틱에서 이미 「관문 미충족」으로 본 후보는 `classificationWaiting` 처럼 기억해 다음 묶음 문장에서 뺀다(지금은 conflicts·분류 대기만 뺀다).
  3. README 비교는 구조 제안 S2(근거 지문 열)로 등식 비교로 바꾼다.
- 검증: 복제본에서 대기열 문장 `EXPLAIN (ANALYZE, BUFFERS)` — 2차 관문 SubPlan 이 `second_reviews_first_attempt_idx` Index Scan 으로 바뀌고 실행 시간 < 200ms. 배포 뒤 `slow-queries` 같은 모양 평균·횟수, second_reviews seq_scan 증가율. 회귀: `tests/` 의 발행 관문 통합 테스트(`publish`·`second-review` 관련)가 그대로 통과.
- 배포 주의: drizzle 마이그레이터는 밀린 마이그레이션을 한 TX 로 돌려 CONCURRENTLY 불가(0058·0109 주석) → 운영에서 `CREATE INDEX CONCURRENTLY` 를 먼저 손으로 만들고, 마이그레이션 파일은 `CREATE INDEX IF NOT EXISTS …`(이미 있으면 no-op)로 스키마를 기록한다(DB-17).
- 확신도: CONFIRMED(색인 부재·행마다 평가하는 술어 구조는 코드·마이그레이션으로 확인). 2.7초 중 각 하위 질의의 몫은 EXPLAIN 필요.
  - 2차 검증:
    - CONFIRMED — 색인 부재. 운영 실제 색인(`evidence/indexes-primary.txt`)에서 second_reviews 색인은 pkey·`(candidate_id,input_hash,model,generation_key)`·`(status,created_at)` 셋뿐이다. 오케스트레이터 확인(`orchestrator-checks.md` REVIEW-01)과도 같다. 제안 색인은 기존 것과 겹치지 않는다.
    - 승인 589건 = `crawl-stats-replica.txt:30`(581) + `:42`(8).
    - 반증 시도: `listCandidates` 의 `state IN … ORDER BY updated_at DESC LIMIT` 는 `crawl_candidates_state_idx (state, updated_at DESC)` 로 순서대로 걸을 수 있다. 그래도 관문 술어를 못 넘는 행이 많으면 LIMIT 까지 모든 승인 행을 평가하는 것은 같다. 주장을 뒤집지 않는다.
  - 보정 — 「최대값이 15초 바로 밑 = 역할 기본 statement_timeout」. 코드 기본값은 publisher 60초, web 15초다(`lib/db/pool.ts:54`). 운영 env(`DB_STATEMENT_TIMEOUT_MS`)는 저장소에 없다. 그러니 15초 상한 해석은 확인되지 않았다.
- 규모: S(색인) / M(두 단계 재작성)

### DB-02 역할 워커가 15초마다 전체 흐름 집계를 주 DB 에서 새로 센다(진행 감시 = 상시 전체 훑기)
- 심각도: P1
- 분류: structure
- 위치:
  - `scripts/role-worker.ts:445-466` — 주 역할마다 15초 타이머, `:651-664` `checkProgress` 가 `readWorkerProgress(undefined, { includeText: false })` 를 부른다(maintenance·text 는 잡이 돌 때만 건너뜀).
  - `lib/operations/worker-progress-query.ts:455-481` — `pipelineThroughput(settings, now)`·`evidenceProgress`·`readUptimeSplitStage(db)`·`operations_observations` 전체 읽기를 매번 함께 낸다.
  - `lib/operations/throughput.ts:24` — `if (now) return readThroughputSnapshot(settings, now);` : `readWorkerProgress` 는 늘 `now` 를 넘기므로 같은 프로세스 안의 겹침 합치기(inflightThroughput)도 건너뛴다.
  - `lib/operations/throughput.ts:67-135` — 한 문장 안의 CTE 들(2차 검증에서 요약 SQL 을 산문으로 옮김):
    - `fetched`(:67-69) — `crawl_documents` 의 `fetched_at` 5분 창. `fetched_at` 이 선두인 색인이 없다.
    - `fetch_queue`(:70-77) — `FROM crawl_frontier` 에 WHERE 가 없다(107만 행 전체).
    - `judged`(:78-81) — `crawl_candidates` 의 `decided_by='auto' AND judged_at` 5분 창. judged_at 색인이 없다.
    - `judge_queue`(:82-85) — `crawl_documents LEFT JOIN crawl_candidates WHERE judgementQueuePredicate()`(DB-05).
    - `first_done`(:86-97) — `crawl_review_attempts WHERE kind='automatic' AND completed_at` 5분 창. completed_at 색인이 없다.
    - `second_stats`(:102-115) — `FROM second_reviews` 에 WHERE 가 없다(20만 행 전체).
    - `publish_candidates`(:123-130) — `state='approved'` 에 `publishReady` 술어(DB-01)를 건다.
    - 위 「색인 없음」 넷은 모두 운영 실제 색인(`evidence/indexes-primary.txt`)과 맞는다.
  - `lib/operations/uptime-split-repository.ts:24-61,74-77` — claims 모드면 uptime_claims 10.6만 행 ⋈ products ⋈ product_health 전체 집계 + `missingRows`(products NOT EXISTS) + 최근 1시간 GROUP BY 두 번(updated_at·last_applied_at 색인 없음).
- 문제: 주 역할(crawler·reviewer·publisher, 한가한 text·maintenance)이 각자 15초마다 위 집계를 낸다 — 같은 값을 분당 12~20번 센다. 감시(30초)·운영 콘솔·배포 관문도 같은 함수를 부른다. 값 하나하나는 3초 안(`SET LOCAL statement_timeout='3s'`)이지만, 상시 부하로서 주 DB 의 seq scan 대부분이 여기서 나온다. 3초를 넘으면 `role.progress_unknown` 이 되고 그 틱의 감시가 비는 것도 이 경로다.
- 실측 근거: `slow-queries-primary.txt:9` uptime readback 7,210회·4,121초·평균 572ms(역할 워커, 분당 5.2회), `:30` 감시 쪽 71회. `pg-stats-primary.txt:11` crawl_frontier seq_scan 601,976회(분당 75회 — 병렬 작업자가 각자 1회로 세므로 문장 기준 분당 15회 안팎), `:10` crawl_documents 1,056,322회, `:13` second_reviews 1,336,952회, `:14` crawl_review_attempts 628,528회, `:17` uptime_claims 552,150회 — 모두 이 집계의 전체 훑기와 빈도가 맞는다. 다른 출처(DB-05·DB-03)와의 몫은 pg_stat_statements 없이 나눌 수 없다(DB-13).
- 수정 방안:
  1. (추천·구조) 구조 제안 S1: 큐 스냅숏을 한 곳(예: scheduler 또는 maintenance 주 역할)이 30~60초마다 한 번 세어 `operations_observations('pipeline-snapshot')` 에 적고, 역할 워커·감시·콘솔·배포 관문은 그 스냅숏(+나이)을 읽는다. 역할 워커의 정체 판정은 스냅숏 나이가 2주기 넘으면 unknown.
  2. (즉시·좁게) 역할별로 필요한 단계만 센다: crawler 는 fetch/judge, reviewer 는 first/second, publisher 는 publish, uptime readback 은 maintenance 만. `throughput.ts:24` 의 `now` 경로도 inflight 합치기를 타게 한다.
  3. (보조) 남는 전체 훑기를 색인으로: `fetch_queue` 에 `WHERE state IN ('pending','fetching','failed')`(crawl_frontier_dequeue_idx 선두가 state), `second_stats` 를 status_idx 로 셀 수 있게 나누기, `first_done` 용
     `CREATE INDEX CONCURRENTLY crawl_review_attempts_completed_idx ON crawl_review_attempts (completed_at) WHERE kind='automatic';`(약 8MB, 시도 갱신은 이미 HOT 0).
     - 2차 검증: `fetch_queue` 의 모든 FILTER 가 `state` 를 pending·fetching·failed 로 묶는다(`throughput.ts:52,74-75`). 그래서 이 WHERE 를 더해도 결과가 같다. 제안 색인은 운영의 어느 색인과도 겹치지 않는다. operations-admin OPS-03 도 같은 색인을 제안한다.
- 검증: 배포 전후 crawl_frontier·crawl_documents·second_reviews 의 seq_scan 증가율(시간당)과 uptime readback 모양 횟수 비교. `scripts/check-worker-progress.ts` 가 스냅숏 경로로 같은 단계 값을 내는지(감시 판정 테스트 `tests/*worker-progress*`).
- 배포 주의: 스냅숏 생산자를 먼저 배포(scheduler 선배포 규칙과 같은 순서)하고 소비자 전환. 배포 관문(`check-worker-progress`)의 판정 의미가 바뀌므로 운영 문서와 함께.
- 확신도: CONFIRMED(호출 경로·주기·전체 훑기 SQL). seq scan 수치의 귀속은 PLAUSIBLE.
  - 2차 검증:
    - CONFIRMED — 감독이 쓰는 칸이 일부뿐이다. `role-worker.ts:654-664` 를 확인했다. maintenance·text 는 `scheduler.reason` 만 쓰고, 나머지는 제 role 단계만 쓴다.
    - CONFIRMED — 회당 전체 훑기. `crawl_frontier` 하루 22.8G 행 ÷ 107만 ≈ 분당 14.8회 전체 훑기로, 위 빈도와 맞는다.
    - 처리량 문장 자체는 느린 목록(0.5초)에 한 번도 없다. 비용은 빈도다.
    - operations-admin OPS-02·03 과 같은 문제다(중복).
- 규모: M

### DB-03 사유 번역 진행 집계가 40만 사유를 매번 해시로 묶고, `work_mem=32MB` 로 낮춰 임시 파일로 흘린다
- 심각도: P1
- 분류: latency
- 위치:
  - `lib/operations/text-stage-progress.ts:35-43` `reason_eligible AS MATERIALIZED (SELECT encode(sha256(convert_to(body,'UTF8')),'hex') AS hash, max(at) … GROUP BY 1)` + `reason_translations AS MATERIALIZED (SELECT … FROM text_translations WHERE target_lang='ko')`.
  - `lib/operations/text-stage-progress.ts:152-160`
    ```ts
    const read = (group: 'reason' | 'other') => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql`SET LOCAL work_mem = '32MB'`);
    ```
  - `lib/crawl/translations.ts:33-37` `SOURCES`(crawl_review_attempts 의 `coalesce(a.reason, a.outcome->>'reason')` — outcome jsonb TOAST 해제 + second_reviews), `:56-62` 주석: 「해시로만 묶으면 같은 결과가 70MB 안에서 끝난다」(work_mem 64MB·해시 128MB 기준).
  - 호출: `lib/operations/failover-monitor.ts:69` `readWorkerProgress()`(includeText 기본 true, 감시 30초 주기), `lib/operations/console-progress-read.ts:14`(운영 콘솔).
- 문제: 해시 집계 자체가 약 70MB 인데 이 TX 는 work_mem 32MB(해시 한도 64MB)라 HashAgg 가 디스크로 흘리고, 35.9만 행 MATERIALIZED CTE 결과(수십 MB)도 32MB tuplestore 를 넘어 임시 파일이 된다. #970 은 본문 키 집계를 해시 키로 바꿨지만 이 진행 문장에만 work_mem 을 낮춘 설정이 남아 흘림이 계속된다. 매 호출 4~9초라 감시 10초 한도에 자주 걸린다(감시 계정 타임아웃 875회). 같은 집계(UNIQUE_SOURCES)를 잡 쪽 `untriedTranslations`·`retryableTranslations`·`pendingReasonTranslationBatch`·`oldestPendingTranslationMinutes`(text 진행 감시 `text-progress.ts:39`)도 매번 처음부터 계산한다(이 23시간 목록에는 잡 쪽 모양이 없다 — 돌지 않았거나 다른 이유, 확인 필요).
- 실측 근거: `slow-queries-primary.txt:4` 감시 3,604회·16,580초·평균 4,601ms·최대 9,080ms, `:11` nomorevibe 647회·3,071초·평균 4,747ms. `:71` 감시 계정 statement timeout 875회. `pg-stats-primary.txt:110` temp_files 43,727 · **1,205GB**(5.6일 ≈ 하루 215GB) — 하루 4,251회 × 회당 약 50MB 와 크기가 맞는다.
- 수정 방안:
  1. (즉시) `SET LOCAL work_mem='32MB'` 를 없애거나 reason 그룹만 128MB 로. 흘림이 없어지는지 EXPLAIN 으로 확인.
  2. (빈도) 감시·콘솔은 사유 진행을 reason-translate 잡이 틱 끝에 적는 관측값(또는 DB-02 의 스냅숏)으로 읽는다 — 4.6초 집계를 30초마다 낼 이유가 없다.
  3. (구조, 추천) 구조 제안 S3 — `reason_sources(hash PK, first_ref, latest_at, needs_korean)` 를 쓰는 쪽(시도·2차 사유 기록) 또는 AFTER 트리거가 채우고, 진행·대기열·`lockReasonCache` 를 그 표의 색인 조회로 바꾼다. 1회 백필 40만 행.
- 검증: 복제본에서 `SET work_mem='32MB'` 와 `'128MB'` 로 각각 reason 문장 `EXPLAIN (ANALYZE, BUFFERS)` — 앞의 것에 `temp written`·`Disk Usage` 가 보이고 뒤의 것에 없는지. 배포 뒤 `pg_stat_database.temp_bytes` 증가율(하루 215GB → 수 GB 목표), 감시 타임아웃 수.
- 배포 주의: 1·2 는 일반 배포. 3 은 새 표 마이그레이션 + 백필 스크립트(PgBouncer 모드 주의).
- 확신도: CONFIRMED — 오케스트레이터가 복제본 EXPLAIN ANALYZE 로 확인(2026-11-21, `../evidence/orchestrator-checks.md`): work_mem 32MB 에서 HashAggregate 5 batch · 디스크 11.3MB · 6.8초, 64MB 에서 1 batch · 디스크 0 · 6.5초. (1차 판정: PLAUSIBLE — 설정·호출 경로는 CONFIRMED, 흘림 여부는 EXPLAIN 으로 확인 필요(근거: 코드 주석의 70MB 와 temp 카운터의 일치).)
  - 2차 검증:
    - CONFIRMED — 「work_mem=32MB 로 낮춘다」.
      - 설정 위치는 `lib/operations/text-stage-progress.ts:156` 한 곳이다. 저장소 전체에서 work_mem 을 SET 하는 곳은 여기뿐이다.
      - 서버값은 64MB 다(`pg-stats-primary.txt:102` work_mem 65536 kB). 그러니 실제로 낮추는 설정이다.
      - 이 줄은 2026-10-25 커밋 e6bd19b9 에서 들어왔다. 그때 서버값을 알 수 없어, 처음 뜻이 「올리기」였을 가능성은 남는다.
      - 시험 `tests/text-stage-progress-read.test.ts:39` 가 이 값을 고정한다. 고칠 때 그 시험도 함께 바꾼다.
    - 보정 — 「감시 10초 한도에 자주 걸린다(875회)」. 875회가 이 문장 몫인지는 확정되지 않았다. 같은 앞 420자 모양에 'other' text 문장(3초)이 섞여 있어서다(operations-admin OPS-01 2차 보정). DB-13 의 원 로그 재집계로 가린다.
      - 같은 까닭으로 `:4`·`:11` 의 횟수·평균은 사유 문장 혼자의 값이 아닐 수 있다. 감시 루프 상한은 시간당 약 100주기인데 `:4` 는 시간당 157건이다. 그러니 주기당 2건(사유 + 'other')이 섞였을 가능성이 높다.
      - 「하루 4,251회 × 회당 50MB」 임시 파일 대조도 그만큼 느슨해진다.
    - 주의 — 주석의 「70MB」(`lib/crawl/translations.ts:56-58`)는 `UNIQUE_TRANSLATION_SOURCES_SQL`(hash·max(at)·min(ref)) 기준이다. 진행 문장의 `reason_eligible`(`text-stage-progress.ts:38-39`)은 min(ref) 가 없어 조금 작다. 흘림은 여전히 EXPLAIN 으로 확인할 일이다.
- 규모: S(1·2) / M(3)

### DB-04 2차 낡은 표 힌트가 매번 장부 2.47GB 를 전부 훑고, 후보×장부 쌍마다 LIKE·정규식을 돈다
- 심각도: P1
- 분류: latency
- 위치:
  - `lib/crawl/second-review-stale.ts:179-182`
    ```ts
    function protectingCapacityRowsSql(): SQL {
      return sql`SELECT cap.state, cap.reserved_until, cap.logical_work_key, cap.work_key, cap.route_id
        FROM model_capacity_requests cap WHERE coalesce(cap.state, '') NOT IN ('waiting', 'withdrawn', 'settled')`;
    ```
  - `:161-175` `protectingCapacityStateSql`(dispatched 또는 살아 있는 reserved만 보호 — indeterminate 는 보호하지 않음), `staleReviewCapacityIdentitySql`(LIKE `'ai2:'||id||':%'` + `!~` 정규식 두 개), `:244-261` `staleSecondReviewHintSql` 의 `NOT EXISTS (SELECT 1 FROM stale_review_protecting_capacity cap WHERE <LIKE/정규식> AND <상태>)`.
  - 호출: `lib/crawl/second-review.ts:1100-1125` 한 틱에서 `mutations<25 && examined<80` 동안 힌트를 여러 번 낸다.
- 문제: `state` 는 NOT NULL 이고 CHECK 로 6값만 허용(`lib/db/operations-schema.ts:162,183`)이라 `coalesce(state,'') NOT IN (…)` = `state IN ('reserved','dispatched','indeterminate')` 인데, 이 꼴은 어떤 부분 색인과도 맞지 않아 매번 표 전체를 훑는다. 그렇게 모은 613행 중 indeterminate 605행은 상태 술어에서 늘 거절되지만, second_reviews 후보 행마다 613행 각각에 LIKE·정규식을 평가한 뒤에야 거절된다(O(후보×장부)). 바깥 질의도 `status IN (…) OR carriedDemand` 의 OR 때문에 status_idx 를 못 타고 candidate_id 순으로 표를 걷는다. 한 틱이 7초짜리 힌트를 여러 번 낸다.
- 실측 근거: `slow-queries-primary.txt:5` 1,417회·10,292초·평균 7,263ms·최대 14,013ms. `pg-stats-primary.txt:8` model_capacity_requests 2,471MB·seq_scan 1,756,826회·seq_tup_read 5,654억(전 표 1위). `crawl-stats-replica.txt:91-96` 장부 행 상태(indeterminate 605·dispatched 5·reserved 3).
- 수정 방안(추천):
  1. CTE 를 `WHERE cap.state IN ('reserved','dispatched')` 로 — indeterminate 는 `protectingCapacityStateSql`·`capacityBlocksStaleReconcile`(`:150-159`) 둘 다에서 보호하지 않으므로 결과가 같다. 이 술어는 0151 의 `model_capacity_requests_active_idx … WHERE state IN ('reserved','dispatched')` 와 정확히 같아 **새 색인 없이** 그 부분 색인을 탄다(8행). CHECK 로 죽은 갈래(`coalesce(state,'') NOT IN (6값)`)는 지운다.
  2. 보호 후보 id 를 CTE 에서 한 번 뽑는다: `substring(logical_work_key from '^ai2:([1-9][0-9]*):')::int`, route=second-review 일 때 work_key 도 같게, 형식이 깨진 행 여부는 비상관 `EXISTS` 한 번(InitPlan). 바깥은 `s.candidate_id NOT IN (SELECT cid FROM protected)` 해시 반조인 → O(후보+장부).
  3. 바깥 OR 를 `UNION ALL` 두 갈래(status_idx 로 pending/failed · carried demand)로 나눈 뒤 DISTINCT/ORDER/LIMIT.
- 검증: 복제본 EXPLAIN — CTE 가 `Index Scan using model_capacity_requests_active_idx`, NOT EXISTS 가 Hashed SubPlan. 기존 정리 동작 테스트(`tests/*second-review-stale*`)와 「형식이 깨진 키는 모든 AI2 후보를 보호」 경계를 단위 테스트로 고정. 배포 뒤 평균 < 300ms.
- 배포 주의: 일반 배포(색인 추가 없음).
- 확신도: CONFIRMED(CHECK·부분 색인 술어·보호 규칙을 모두 대조함).
  - 2차 검증: CONFIRMED.
    - 반증 시도: `protectingCapacityStateSql`(`second-review-stale.ts:161-165`)의 `inFlightStateSql` 이 indeterminate 를 포함하는지 확인했다. `lib/llm/capacity-states.ts:21,51` 에서 `state = 'dispatched'` 뿐이다. JS 쪽 `capacityBlocksStaleReconcile`(`:150-159`)도 indeterminate 를 보호하지 않는다. 그러니 CTE 를 reserved·dispatched 로 좁혀도 결과가 같다.
    - 오케스트레이터가 복제본에서 EXPLAIN ANALYZE 로 쟀다(`orchestrator-checks.md` REVIEW-04).
      - 현행 꼴: Seq Scan 84,708 버퍼, 357ms, 613행.
      - `state IN ('reserved','dispatched')`: `model_capacity_requests_active_idx` Index Scan 57 버퍼, 0.061ms, 8행.
      - 운영 색인 목록에서도 active_idx 술어가 정확히 그 두 상태다.
    - 7.3초 중 CTE 훑기는 0.36초뿐이다. 나머지는 후보×장부 LIKE·정규식 평가로 보인다. 그래서 수정안 ②(보호 id 를 한 번 뽑기)도 함께 해야 한다.
- 규모: S

### DB-05 판정 대기열이 외부 조인의 OR 술어라 큐가 비어도 원본 107만 행을 끝까지 훑는다
- 심각도: P1
- 분류: inefficiency
- 위치:
  - `lib/crawl/repository.ts:787-811`
    ```ts
    export function judgementQueuePredicate() {
      return sql`${crawlCandidates.id} IS NULL OR (${crawlCandidates.state} = 'new'
        AND (${crawlCandidates.signals}->>'reconsiderAfter' IS NULL OR …))`;
    }
    … db.select().from(crawlDocuments).leftJoin(crawlCandidates, eq(crawlDocuments.repo, crawlCandidates.repo))
        .where(judgementQueuePredicate()).limit(limit);
    ```
  - `lib/crawl/jobs/judge.ts:37-42` — 틱마다 큐가 빌 때까지 부르고, 마지막(빈) 호출이 반드시 전체를 훑는다(2차 검증에서 줄 번호를 고침).
  - 같은 술어로 세는 곳: `lib/operations/throughput.ts:82-85`(DB-02), `lib/crawl/discovery-admission.ts:113-115`.
- 문제: `c.id IS NULL OR c.state='new'` 는 어느 색인으로도 거를 수 없어, LIMIT 10 을 채울 때까지 원본을 훑으며 후보 PK/유일 색인을 행마다 찌른다([2차 검증] 「행마다 찌른다」는 색인 통계로 반증됨 — 실측 근거 보정 참고. 통째로 조인해 끝까지 읽는다는 결론은 같다). 지금 new 후보와 후보 없는 원본은 거의 0(상태 분포에 new 없음 — `crawl-stats-replica.txt:14-50`)이라 매 호출이 끝까지 간다. 큐에 일이 있을 때도 새 원본 위치에 따라 대부분을 걷는다.
- 실측 근거: `slow-queries-primary.txt:6` 10,220회·8,871초·평균 868ms·최대 2,219ms. `pg-stats-primary.txt:9-10` crawl_candidates idx_scan 10.7억(원본마다 찌름), crawl_documents seq_scan 1,056,322회.
  - [2차 검증 — 반증된 부분] 「idx_scan 10.7억 = 원본마다 후보 색인을 찌름」은 운영 색인별 통계(`evidence/indexes-primary.txt`)와 맞지 않는다.
    - crawl_candidates 색인 사용은 거의 `crawl_candidates_published_slug_idx`(9.76억)에서 나온다.
    - 이 조인이 쓸 `crawl_candidates_repo_unique` 는 5.6일 동안 650만 회, `identity_idx` 는 440만 회뿐이다. 하루 1만 회 넘게 107만 원본마다 찔렀다면 수십억 회가 나와야 한다.
    - 그러니 이 문장은 행마다 찌르는 Nested Loop 가 아니라 두 표를 통째로 읽는 Hash/Merge 조인일 가능성이 높다.
    - 「큐가 비어도 끝까지 훑는다」는 결론과 평균 868ms 는 그대로다.
- 수정 방안:
  1. (즉시) 두 갈래로 나눈다 — ① `crawl_candidates c JOIN crawl_documents d … WHERE c.state='new' AND …`(crawl_candidates_state_id_idx), ② 후보 없는 원본은 잡 커서에 「이 id 이하는 모두 후보가 있다」 물높이(W)를 두고 `d.id > W AND NOT EXISTS (…)` 로만 찾는다(원본은 repo 당 한 행이고 다시 받을 때 id 가 유지되므로 후보 없는 원본은 새 id 뿐). 한 시간에 한 번 전체 확인으로 물높이를 검증.
  2. (구조) crawl-fetch 가 원본을 처음 넣는 같은 TX 에서 `state='new'` 후보 행을 함께 만든다 → 대기열은 `state='new'` 하나(색인). `c.id IS NULL` 을 「판정 전」으로 읽는 곳(judge·throughput·admission·관리자 화면)을 함께 바꾼다.
- 검증: 복제본 EXPLAIN — 빈 큐에서 두 갈래 합계 < 5ms. 판정 통합 테스트(`tests/integration/*judge*`), throughput·admission 의 judge 값이 같은지.
- 배포 주의: 1 은 일반 배포. 2 는 1회 백필(후보 없는 원본에 new 행) + crawler 재시작.
- 확신도: CONFIRMED(술어·호출 경로). 실행 계획 종류(Merge/Nested Loop)는 EXPLAIN 으로 확인.
  - 2차 검증:
    - CONFIRMED — 술어·호출 경로·빈 큐. 상태 분포에 `new` 가 없다.
    - 보정 — 계획 종류. 색인 통계로 보아 Nested Loop 가 아니라 통째 조인이다.
    - 수정안 ①의 물높이(W)는 「원본 id 가 재수집에도 유지된다」는 전제에 기댄다.
      - 원본 저장은 `repo` 충돌 upsert 라 행 id 가 남는다(`lib/crawl/repository.ts:714-715` `onConflictDoUpdate({ target: crawlDocuments.repo, … })`).
      - 원본 행을 지우는 곳은 재현 도구 하나뿐이다(`lib/operations/pipeline-replay-fixed-input-repository.ts:204`).
      - 그러니 전제는 대체로 맞다. 다만 `values` 에 id 가 실리지 않는지는 구현 때 확인한다.
- 규모: S(1) / M(2)

### DB-06 장부 `model_capacity_requests` 의 열린 상태 술어 대부분이 쓸 색인이 없어 2.47GB 를 훑는다
- 심각도: P1
- 분류: inefficiency
- 위치:
  - `lib/llm/capacity-states.ts` — `openStateSql`(4상태, 8곳)·`unsettledDispatchStateSql`(dispatched·indeterminate, 10곳)·`IN ('reserved','dispatched','indeterminate')` 꼴(예: 느린 문장 `open_rows` CTE). SQL 원문 `FROM model_capacity_requests` 130곳.
  - 기존 부분 색인(마이그레이션 확인): waiting_idx(waiting), live_work_idx(waiting·reserved·dispatched, 0151), active_idx·logical_active_idx(reserved·dispatched, 0151), unknown_hold_idx(indeterminate, 0172), settled_at·withdrawn_at.
- 문제: `state IN (a,b,c)` 는 ScalarArrayOp 라 플래너가 부분 색인 둘을 BitmapOr 로 합치지 못하고, 집합이 어느 부분 색인의 술어에도 함의되지 않으면(4상태·unsettled 2상태·reserved/dispatched/indeterminate 3상태) 표 전체를 훑는다. 열린 행은 613개뿐인데 51만 행(14일 보관분 + 부풀음)을 읽는다.
- 실측 근거: `pg-stats-primary.txt:8` seq_scan 1,756,826회(하루 31만)·seq_tup_read 5,654억 — 모든 표 중 1위, 1회 평균 32만 행. `slow-queries-primary.txt:42`(open_rows 0.56초).
- 수정 방안:
  - 제안 DDL(새로 만들 것이라 인용이 아니다): `CREATE INDEX CONCURRENTLY model_capacity_requests_open_idx ON model_capacity_requests (route_id, state) WHERE state IN ('waiting','reserved','dispatched','indeterminate');`
  - 크기 < 1MB(열린 행만), 쓰기 비용: 열린 상태로 들어오는 행만 항목 추가(갱신은 이미 HOT 0). 부분집합 술어(`IN (dispatched,indeterminate)` 등)는 이 술어에 함의되어 쓸 수 있다. 함께 `coalesce(state,…)` 꼴(DB-04)을 없앤다. 어떤 문장이 훑는지 확정하려면 pg_stat_statements(DB-13).
- 검증: 배포 뒤 model_capacity_requests seq_scan 시간당 증가량(목표 1/10 이하), 대표 문장 EXPLAIN 이 open_idx 사용.
- 배포 주의: CONCURRENTLY 는 DB-17 경로. 장부 표의 SHARE 잠금을 피하려면 반드시 CONCURRENTLY(일반 CREATE INDEX 는 입장·정산 쓰기를 막는다 — 0172 주석).
- 확신도: PLAUSIBLE — 「맞는 색인이 없다」는 CONFIRMED, 1.76M 회의 주된 출처는 문장 통계로 확인 필요.
  - 2차 검증:
    - 운영 실제 색인(`evidence/indexes-primary.txt`)과 맞는다. model_capacity_requests 의 상태 부분 색인은 다음뿐이다.
      - waiting(waiting_idx)
      - waiting·reserved·dispatched(live_work_idx, `(owner_instance_id, owner_boot_id, work_key)` 유일)
      - reserved·dispatched(active_idx·logical_active_idx)
      - indeterminate(unknown_hold_idx)
      - settled(settled_at_idx)·withdrawn(withdrawn_at_idx)
      - 4상태·`(dispatched,indeterminate)`·`(reserved,dispatched,indeterminate)` 를 함의하는 색인은 없다.
    - 오케스트레이터가 복제본 EXPLAIN 으로 쟀다(`orchestrator-checks.md` REVIEW-04). `IN ('reserved','dispatched','indeterminate')` 는 여전히 (Parallel) Seq Scan 97ms 였다. 「ScalarArrayOp 가 부분 색인 둘의 BitmapOr 로 나뉘지 않는다」와 맞는다.
    - 제안 색인은 기존 색인의 상위 집합 술어라 겹치지 않는다. 선두 칸 `route_id` 는 route 조건이 없는 문장에선 쓸모가 적다. 그런 문장이 많다면 선두를 `state` 로 두는 편이 낫다(문장 통계로 정한다).
- 규모: S

### DB-07 사유 번역 dispatch TX 가 전역 control 행(FOR UPDATE)·역할·잡 행을 쥔 채 사유 전체 훑기를 묶음 원소마다 돈다
- 심각도: P1
- 분류: concurrency
- 위치:
  - `lib/crawl/translations.ts:372-383`
    잠금 순서(2차 검증에서 줄 끝 설명을 빼고 실제 줄로 바꿈):
    - `:373` 예약 경로 control FOR UPDATE(`lib/llm/capacity-repository.ts:1613` `control(tx)`), 아니면 `:375` FOR SHARE.
    - `:381` role_leases FOR SHARE.
    - `:382` 원소마다 SOURCES 전체 EXISTS.
    - `:383` jobs FOR UPDATE.
    ```ts
        const result = await onPrimary(() => db.transaction(async tx => {
          const locked = reserved ? await lockReasonTranslationModelCapacityDispatch(tx, reserved) : null;
    …
          const control = locked?.control ?? await lockModelCapacityCallerControl(tx);
    …
          const role = await lockReasonRole(tx, roleLease);
          const rows = await lockReasonCache(tx, batch, true), members = memberSnapshots(batch, rows);
          await assertJobLeaseAtWallTime(tx, lease, 'update');
    ```
  - `lib/crawl/translations.ts:330-337` `SELECT EXISTS (SELECT 1 FROM (${SOURCES}) src WHERE body = ${item.body} AND ${NEEDS_KOREAN})` — 묶음 원소(최대 4)마다.
  - `lib/llm/capacity-repository.ts:81-85` `control(tx, lock = "update")`, `:1605-1616` 예약 경로가 `control(tx)`(FOR UPDATE) 뒤 요청 행 FOR UPDATE.
- 문제: SOURCES EXISTS 는 crawl_review_attempts(1.8GB, outcome TOAST 해제)와 second_reviews 를 본문 등식으로 훑는 문장이라 회당 0.3~0.57초다. 예약 경로에서는 전역 단일 행 `model_capacity_control` 을 FOR UPDATE 로 쥔 채 이것을 최대 4번 돌아, 그동안 모든 모델 입장·정산·조회(FOR SHARE)가 줄을 선다. 같은 TX 가 role_leases FOR SHARE 를 쥐어 역할 lease 갱신(FOR UPDATE)도 기다린다 — 갱신이 늦으면 lease 상실·격리로 번질 수 있다.
- 실측 근거: `slow-queries-primary.txt:36` 이 EXISTS 27회(0.5초 넘은 것만)·평균 533ms. control 잠금 대기 모양 `:3,:7,:8,:13,:24` 합계 36,317초(평균 1.0초), role_leases FOR UPDATE `:15,:18` 2,038회·평균 0.92초. 이 TX 가 그 대기의 몇 %인지는 log_lock_waits 없이 나눌 수 없다(DB-13).
- 수정 방안:
  1. 원문 존재 확인을 잠금 전으로 옮기거나, 잠금 안에서는 색인 조회로: 대기열이 고른 원소의 `ref`('a<id>'/'s<id>')를 `PendingTranslation` 에 실어 `crawl_review_attempts.id = …`/`second_reviews.id = …` PK 조회 + 본문 등식으로 확인(같은 해시의 다른 행이 사라져도 ref 행이 남아 있으면 충분한지 정책 확인 필요).
  2. 구조 제안 S3 의 `reason_sources` PK 조회로 대체.
  3. control 을 쥐는 구간은 마지막 확인·기록에만 — 잠금 순서(control → role → cache → job)는 유지하되 무거운 읽기를 그 앞 비잠금 단계로.
- 검증: 이 TX 의 실행 시간 로그(잠금 획득~커밋), `pg_locks` 표본에서 control 행 대기자의 차단자 PID 분포. 회귀: `tests/*reason-translation*` capacity 통합 테스트.
- 배포 주의: text 역할 재시작. 장부 경로라 DRAIN 창 권고(memory: OPEN 중 장부 코드 교체 주의).
- 확신도: CONFIRMED(잠금 순서와 그 안의 전체 훑기). 대기 총량 중 몫은 PLAUSIBLE.
  - 2차 검증: CONFIRMED.
    - `lockReasonTranslationModelCapacityDispatch` 는 `control(tx)`(기본 `"update"`, `capacity-repository.ts:81-85`)로 전역 행을 FOR UPDATE 한다. 그 뒤 요청 행을 FOR UPDATE 한다(`:1613-1616`).
    - 비예약 경로의 `lockModelCapacityCallerControl` 은 FOR SHARE 다(`:98-101`).
    - `lockReasonCache` 는 원소를 해시 순으로 돌며 원소마다 SOURCES EXISTS 를 낸다(`translations.ts:330-337`).
    - 반증 시도: 그 EXISTS 를 색인으로 받칠 길이 있는지 찾았다. `crawl_review_attempts` 에 reason/outcome 본문 색인이 없다(운영 색인 목록). 그러니 회당 전체 훑기라는 결론은 뒤집히지 않는다.
- 규모: S

### DB-08 위임 검수 후보 고르기가 사람 큐 전부(수천 id)에 같은 원본 대조를 세 번씩 돈다
- 심각도: P2
- 분류: latency
- 위치: `lib/crawl/human-review-repository.ts:69-90`
  아래는 human-review-repository.ts:74-78, 84-88 이다(2차 검증에서 실제 줄로 바꿈).
  ```ts
    const delegated = sql`${crawlReviewAttempts.candidateId} = ${crawlCandidates.id} AND ${crawlReviewAttempts.kind} = 'delegated'
      AND ${crawlReviewAttempts.provider} = ${DEEPSEEK_REVIEW_PROVIDER} AND ${crawlReviewAttempts.actor} = ${actor}
      AND ${currentReviewSource(settings)}`;
    const rows = await db.select({ repo: crawlCandidates.repo }).from(crawlCandidates).where(and(
      inArray(crawlCandidates.id, ids), eq(crawlCandidates.state, 'needs_review'), eq(crawlCandidates.decidedBy, 'auto'),
  …
      sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${delegated} AND ${crawlReviewAttempts.state} = 'succeeded')`,
      sql`NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${delegated} AND ${crawlReviewAttempts.retryAfter} > clock_timestamp())`,
      sql`(SELECT count(*) FROM ${crawlReviewAttempts} WHERE ${delegated}
        AND NOT (${crawlReviewAttempts.state} = 'superseded' AND ${inArray(crawlReviewAttempts.errorCode, [...UNCOUNTED_DEFERRALS])})) < ${MAX_DELEGATED_ATTEMPTS}`,
    )).orderBy(desc(crawlCandidates.updatedAt), desc(crawlCandidates.id)).limit(Math.max(1, options.limit ?? 50));
  ```
  호출: `lib/crawl/jobs/human-review.ts:56-60` — `humanQueueOverview` 의 사람·일치 id 전부(갈림 보류 4,915 등 약 5천).
- 문제: 후보마다 세 하위 질의가 각자 `currentReviewSource`(원본 조인 + LATERAL 스캔 + README TOAST 비교)를 다시 평가하고, ORDER BY … LIMIT 전에 모든 id 를 평가한다. human-deepseek-review 는 거의 매분 돈다.
- 실측 근거: `slow-queries-primary.txt:12` 1,293회·2,572초·평균 1,989ms(문장 모양 `select "repo" from "crawl_candidates" where id in (…)`).
- 수정 방안: ① 세 조건을 `LEFT JOIN LATERAL (SELECT bool_or(state='succeeded'), bool_or(retry_after>clock_timestamp()), count(*) FILTER (…) FROM crawl_review_attempts a WHERE a.candidate_id=c.id AND a.kind='delegated' AND … AND <currentReviewSource>) d ON true` 하나로(원본 대조 1회), ② id 를 updated_at 순 200개씩 나눠 limit 이 찰 때까지만 평가, ③ S2 지문 열.
- 검증: 복제본 EXPLAIN 실행 시간 < 200ms, 같은 입력에서 고른 repo 목록이 같다(`tests/*human-review*`).
- 배포 주의: 일반 배포(reviewer 역할 재시작).
- 확신도: CONFIRMED
- 규모: S

### DB-09 「할 일 고르기」 문장들이 큐가 거의 비어도 넓은 표 전체를 훑는다(README·소개 검수·한국어 소개·키워드)
- 심각도: P2
- 분류: inefficiency
- 위치:
  - `lib/crawl/repository.ts:517-526` `pendingPublishedReadmes` — `page_meta->'readmeSampleVersion' = 'null'::jsonb AND jsonb_typeof(page_meta->'readmeSample')='string' AND (case … readmeRetryAfter …) <= … ORDER BY id LIMIT` : 원본 107만 행의 page_meta 를 모두 TOAST 해제.
  - `lib/domain/products/intro-checks.ts:48-74` `pendingIntroChecks` — products ⋈ product_intro_checks, 정규식(MAKER_JUNK)·EXISTS(product_maker_members) 술어, `ORDER BY products.id DESC LIMIT`.
  - `lib/domain/products/korean-taglines.ts:170-178` — `NEEDS_KOREAN` 정규식 + 계산식 ORDER BY 로 공개 제품 전체 정렬.
  - `lib/domain/products/search-profiles.ts:236` 부근 키워드 대기열, `lib/domain/evidence/source-claims.ts:58-85` `selectTarget`(공개 제품 ⋈ 근거 ⋈ 요청 ⋈ claim 을 정렬해 **LIMIT 1**, claim 마다 반복).
- 문제: 「대기」는 다른 표와의 비교(소개가 바뀌었나·번역이 지금 소개 것인가)라 색인으로 거를 수 없어, 고를 때마다 공개 제품 11.5만 행(products 1.4GB — 행당 12KB)이나 원본 107만 행을 훑고 정렬한다. 큐가 비면 매 틱 끝까지 간다.
- 실측 근거: `slow-queries-primary.txt:17` README 272회·737초·평균 2,711ms, `:14` 소개 검수 1,431회·1,350초·평균 944ms, `:19` 한국어 소개 746회·396초, `:29` 키워드 74회. `pg-stats-primary.txt:15` products seq_scan 984,928회·seq_tup_read 585억, `:16` product_evidence_sources seq_scan 245,480회(1회 평균 21만 행 = 표 전체).
- 수정 방안: 구조 제안 S4 — 「다시 볼 때」 칸(due_at)을 쓰는 쪽이 채우고 부분 색인 `(due_at) WHERE due_at IS NOT NULL` 로 고른다. README 는 재수집이 발췌를 무효화할 때 `readme_refresh_queue(document_id PK, due_at)` 에 넣는다(page_meta 에 색인을 걸면 page_meta 갱신이 전부 non-HOT 이 되므로 피한다 — crawl_documents HOT 1,309,843/1,850,565). 당장은 README 고르기에 id 키셋 커서를 둬 한 번에 2만 행씩만 본다.
- 검증: 각 고르기 문장 EXPLAIN 실행 시간, products·crawl_documents seq_scan 증가율.
- 배포 주의: 새 표/칸 마이그레이션 + 백필, 해당 역할 재시작.
- 확신도: CONFIRMED(README·소개 검수), PLAUSIBLE(나머지 — 고르기 술어만 읽음).
- 규모: M

### DB-10 2차 표 아이템 점검이 `binding->>'candidateId'` 로 찾아 `pipeline_item_leases` 를 훑는다
- 심각도: P2
- 분류: inefficiency
- 위치: `lib/crawl/second-review.ts:139-151`
  ```ts
    const where = and(eq(pipelineItemLeases.stage, "ai2"), or(
      sql`${pipelineItemLeases.binding}->>'candidateId' = ${String(candidateId)}`,
      keys.length ? inArray(pipelineItemLeases.workKey, keys) : undefined,
    ));
    const locked = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases)
      .where(where).orderBy(pipelineItemLeases.workKey).for("update", { skipLocked: true });
  …
      .from(pipelineItemLeases).where(where);
  ```
  같은 꼴 `second-review.ts:1203`, `lib/crawl/admin-review-rejected-rerun.ts:461`. 색인은 PK(stage, work_key)와 expiry_idx 뿐(`lib/db/operations-schema.ts:98,104`).
- 문제: OR 의 jsonb 갈래 때문에 PK 로 거를 수 없어 ai2 아이템 행 전체를 읽는다. 2차 정리 controllerWrite 가 후보마다 두 번 부른다.
- 실측 근거: `pg-stats-primary.txt:12` pipeline_item_leases(7.8만 행) seq_scan 1,890,239회·seq_tup_read 1,191억(1회 평균 6.3만 행 = 거의 전체).
- 수정 방안:
  - 제안 DDL(새로 만들 것이라 인용이 아니다): `CREATE INDEX CONCURRENTLY pipeline_item_leases_ai2_candidate_idx ON pipeline_item_leases ((binding->>'candidateId')) WHERE stage = 'ai2';`
  - 약 2~3MB, 갱신 121,021회(이미 HOT 0 — expiry_idx 가 lease_until 포함)라 추가 비용 작음. 그러면 OR 가 BitmapOr(PK + 이 색인)가 된다.
- 검증: EXPLAIN 이 BitmapOr, seq_scan 증가율.
- 배포 주의: DB-17 경로(CONCURRENTLY).
- 확신도: PLAUSIBLE — 색인 부재·OR 구조는 확인, 1.89M 회의 주된 출처인지는 문장 통계 필요.
  - 2차 검증:
    - 운영 색인 목록에서 pipeline_item_leases 색인은 pkey `(stage, work_key)`·expiry_idx 둘뿐이다(맞음). 제안 색인과 겹치는 것이 없다.
    - 보정: `stage = 'ai2'` 는 pkey 선두 칸이다. 그래서 「PK 로 거를 수 없다」가 아니라 「PK 로는 ai2 행 범위까지만 좁히고 그 안을 다 읽는다」가 정확하다. ai2 행이 표의 대부분이면 seq scan 과 비슷하다.
- 규모: S

### DB-11 products 표는 갱신이 거의 전부 non-HOT 이고(0.3%), 한 행 갱신이 0.8초 걸린다
- 심각도: P2
- 분류: inefficiency
- 위치: `lib/db/schema.ts:61-240`(색인 15개 + GIN `products_search_idx` 265MB, `search_vector` 생성 열이 이름·소개·설명·search_page_text·search_readme·search_keywords 를 묶음), `lib/domain/products/search-profiles.ts:203` `update products set search_keywords`, og_image 갱신. fillfactor 지정 없음(`rg -i fillfactor drizzle lib/db` 0건).
- 문제: products 는 행당 약 12KB(1.4GB/11.5만)로 페이지가 꽉 차(fillfactor 100) 같은 페이지에 새 판을 둘 자리가 없고, stars·repo_checked_at 등 색인 열 갱신도 잦아 갱신 704,214회 중 HOT 2,202회다. non-HOT 갱신은 GIN 을 포함한 모든 색인에 새 항목을 넣는다 — search_vector 가 큰 행은 GIN 항목 수십~수백 개(fastupdate 대기 목록이 넘치면 그 갱신이 비우기 비용을 떠안는다). 그래서 단일 행 `update … where id=$n` 이 0.8초다. 넓은 행은 DB-09 의 전체 훑기 비용도 키운다.
- 실측 근거: `pg-stats-primary.txt:15` n_tup_upd 704,214·n_tup_hot_upd 2,202. `slow-queries-primary.txt:34` search_keywords 갱신 평균 802ms, `:44` og_image 갱신 평균 816ms.
- 수정 방안: ① `ALTER TABLE products SET (fillfactor = 85)` 후 창에서 재작성(pg_repack 또는 VACUUM FULL — 11-15 창처럼) → 비색인 열(og_image 등) 갱신이 HOT, ② `pgstatginindex('products_search_idx')` 로 대기 목록 크기 확인 후 `gin_pending_list_limit` 조정 또는 자주 바뀌는 열의 갱신을 묶음으로, ③ 구조 제안 S5(검색 본문·저장소 상태 칸 분리). 갱신 출처별 횟수는 pg_stat_statements 로 먼저 잰다.
- 검증: n_tup_hot_upd 비율, 해당 UPDATE 모양 평균.
- 배포 주의: 재작성은 ACCESS EXCLUSIVE(VACUUM FULL) — 창 필요, pg_repack 이면 짧은 잠금.
- 확신도: PLAUSIBLE(0.8초의 몫이 GIN·잠금 대기 중 무엇인지 미확인)
- 규모: M

### DB-12 jobs·role_leases 단일 행에서 0.8~1초 잠금 대기가 반복된다
- 심각도: P2
- 분류: concurrency
- 위치: `lib/jobs/runner.ts:150-179`(claim TX: `insert jobs … on conflict do nothing` 뒤 `update jobs`), `:199-206`(15초 heartbeat `update jobs set locked_at`), `lib/jobs/control.ts:20-29`(requestJob — 호출자 도메인 TX 안에서 jobs 행 UPDATE), `:79-83`(markWorkerSeen), `lib/crawl/taglines.ts:226`(jobs 두 행 FOR UPDATE), `lib/crawl/translations.ts:383`(`assertJobLeaseAtWallTime(tx, lease, 'update')` — control 잠금 TX 안), `lib/jobs/batch-repository.ts:160,202`·`role-leader.ts:103`(role_leases FOR UPDATE).
- 문제: 잡 행은 요청 신호·lease·heartbeat 를 한 행에 모아 도메인 TX 들이 커밋까지 그 행을 갱신·잠근다. 긴 도메인 TX(DB-07 처럼)가 jobs/role_leases 행을 쥐면 같은 잡의 heartbeat·claim·다른 요청자가 줄을 선다. heartbeat 가 lease 넘김 한도(STALE_LOCK) 가까이 밀리면 lease 상실로 이어질 수 있다.
- 실측 근거: `slow-queries-primary.txt:20,21,23,25,27,28,38,39,41` jobs 관련 모양 평균 0.78~1.04초(합계 약 1,000초), `:15,:18` role_leases FOR UPDATE 2,038회·평균 0.92초·최대 4.7초. `:72` lock timeout 17회.
- 수정 방안: ① 먼저 `log_lock_waits = on`(deadlock_timeout 1s 이므로 1초 넘는 대기마다 차단자 PID·문장이 남는다)으로 차단자를 확정, ② lease 확인만 필요한 곳은 `'share'`(현재 `'update'` 쓰는 곳 목록화), ③ requestJob 을 TX 의 마지막 문장으로 고정하거나 요청 신호를 추가 전용 `job_signals` 행으로 분리해 jobs 행 갱신 경합을 없앤다(구조 제안 S1 과 함께).
- 검증: log_lock_waits 기록의 차단자 분포, 해당 모양 평균.
- 배포 주의: ①은 설정 변경(재시작 불요, `ALTER SYSTEM` + reload).
- 확신도: PLAUSIBLE(차단자를 문장 통계로 확정하지 못함)
- 규모: S(①) / M(③)

### DB-13 문장 단위 관측이 없어 하루 1만 건 넘는 statement timeout 을 어느 문장인지 모른다
- 심각도: P2
- 분류: non-standard
- 위치: 운영 설정(`pg-stats-primary.txt:86-103`) — `track_io_timing off`, pg_stat_statements 사용 흔적 없음(근거 파일·코드에 없음), log_lock_waits 미확인. 앱은 역할별 statement_timeout(3·5·10·15·60초)을 곳곳에서 `SET LOCAL` 한다.
- 문제: 오류 집계는 메시지별로만 나와 10,383건(nomorevibe)·875건(감시)의 statement timeout 이 어느 문장인지 모른다. 느린 목록의 최대값이 15초 바로 밑에 몰린 모양(DB-01·DB-04)은 잘린 호출이 오류로 빠졌음을 시사하고, 3초 한도의 진행 집계(DB-02)는 잘려도 느린 목록에 남지 않는다. 이 점검의 귀속 대부분이 PLAUSIBLE 인 까닭이다.
- 실측 근거: `slow-queries-primary.txt:70-71`.
- 수정 방안: `shared_preload_libraries` 에 pg_stat_statements(Patroni 설정 — 재시작 필요), `track_io_timing = on`, `log_lock_waits = on`, 오류 로그에서 `STATEMENT:` 줄까지 모아 timeout 을 모양별로 묶는 수집 스크립트. 복제본에도 동일.
- 검증: `pg_stat_statements` 상위 total_exec_time 표가 이 문서의 귀속과 맞는지 재확인.
- 배포 주의: pg_stat_statements 적재는 Patroni 재시작(전환 창) 필요.
- 확신도: CONFIRMED(근거 파일에 문장별 오류·통계가 없음)
  - 2차 검증 보강: 「어느 문장인지 모른다」는 근거 파일의 한계다. DB 로그 자체의 한계는 아닐 수 있다.
    - PostgreSQL 은 `log_min_error_statement` 기본값(error)에서 ERROR 다음 줄에 `STATEMENT:` 를 남긴다.
    - 근거를 만든 `slowdigest.py` 는 그 단계(STATEMENT)를 읽지만 오류 문장과 짝지어 세지 않는다.
    - 그러니 설정을 바꾸기 전에도 원 로그를 다시 집계하면 timeout 10,383·875건을 모양별로 가를 수 있다. 운영 설정값은 확인하지 못했다.
    - 그 결과로 OPS-01·DB-01·DB-02 의 귀속을 바로 확정할 수 있다.
- 규모: S

### DB-14 쓰이지 않거나 질의와 어긋난 색인이 갱신 비용만 낸다
- 심각도: P3
- 분류: inefficiency
- 위치·실측(`pg-stats-primary.txt:41-63`, 정의는 마이그레이션):
  - `uptime_claims_due_idx` 32MB·0회 — `drizzle/0104_uptime_split.sql:118` `(due_at, product_id) WHERE state <> 'submitted'`. claim 질의(`lib/domain/products/uptime-claims.ts:137-153`)가 `ORDER BY (c.confirm_class is not null) desc, c.due_at` 로 첫 키가 달라 못 탄다. uptime_claims 갱신 3,194,504회(HOT 0)마다 유지.
  - `product_evidence_sources_due_idx` 24MB·0회 — `(state,next_attempt_at,slug)`. 갱신 950,900회 중 HOT 43% — next_attempt_at 이 색인 열이라 HOT 을 막는다.
  - `product_thumbnail_retry_idx` 14MB·0회 — 갱신 54,761회 HOT 0.
  - `agent_scans_due_idx` 13MB·0회, `products_stars_refresh_idx` 5.5MB·0회(0061 `products_repo_check_idx` 가 대신함).
  - `crawl_candidates_state_idx` 87MB·21,350회 — `(state, updated_at desc)` 가 updated_at 을 담아 후보 갱신이 전부 non-HOT(67,072회·HOT 0), 대부분의 상태 질의는 `state_id_idx`(1,325,236회)를 탄다.
- 수정 방안: 위 다섯은 `DROP INDEX CONCURRENTLY`(복제본 사용 여부 확인 뒤 — 모두 워커 전용 표/경로라 주 DB 통계가 대표값). uptime claim 은 색인을 질의 순서에 맞추거나(`((confirm_class is not null) desc, due_at, product_id) WHERE state <> 'submitted'`) 지운다. state_idx 는 21k 회의 사용처(관리자 목록 정렬 추정)를 확인 후 판단. `products_listed_owner_idx`(0회)는 웹(복제본) 경로라 유지.
- 검증: 지운 뒤 7일 해당 질의 평균, HOT 비율 변화.
- 배포 주의: DROP INDEX CONCURRENTLY 도 drizzle TX 밖에서(DB-17).
- 확신도: CONFIRMED(통계·정의), 복제본 사용 여부는 확인 필요
  - 2차 검증: 운영 색인 목록(`evidence/indexes-primary.txt`, 5.6일 누적)의 idx_scan=0 과 맞췄다. 이 목록은 점검 대상 표만 담는다(`product_updates` 등은 없다). 그 밖 표의 0회 색인은 보지 못했다.
    - 위 다섯은 모두 비유일 색인이고 0회다(맞음): `uptime_claims_due_idx` 32MB · `product_evidence_sources_due_idx` 24MB · `product_thumbnail_retry_idx` 14MB · `agent_scans_due_idx` 13MB · `products_stars_refresh_idx` 5.5MB.
    - 같은 목록에서 0회인 비유일 색인이 더 있다. 웹(복제본) 경로라 이 주장에서 빠진 것들이다.
      - `products_listed_owner_idx` 5.4MB
      - `products_search_idx` 265MB(GIN)
      - `products_renamed_owner_idx` 120kB
    - **0회여도 지우면 안 되는 유일·PK 색인** — 제약이 일하는 것이라 스캔 수와 상관이 없다.
      - 장부: `model_capacity_events_terminal_idx` 23MB·`_released_idx`, `model_capacity_requests_ai1_attempt_idx` 7.4MB·`_ai1_item_claim_idx`·`_ai1_cli_item_claim_idx`·`_ai2_claim_idx` 5.9MB·`_ai2_cli_claim_idx` 5.9MB.
      - 감사: `product_audit_one_rolling_idx`·`product_audit_one_running_idx`(한 건만 도는 것을 지키는 유일 색인).
      - PK: `product_audit_attempts_pkey`·`product_audit_second_opinions_pkey`·`product_links_pkey`.
      - 이것들은 DROP 후보로 적지 않는다. 참고로 `_ai2_claim_idx` 는 같은 칸에 더 넓은 술어를 쓰는 `_ai2_cli_claim_idx` 에 유일성이 포함된다(ai1 쌍도 같다). 지울지는 장부 구역이 정할 일이라 여기선 판단하지 않는다.
    - 주의 — `crawl_candidates_state_idx (state, updated_at DESC)`. 발행 대기열 `listCandidates`(`lib/crawl/repository.ts:896-907`, `state IN … ORDER BY updated_at DESC LIMIT`)의 순서와 같다. 그러니 지우기 전에 DB-01 대기열 문장의 계획이 이 색인을 쓰는지 EXPLAIN 으로 본다.
    - 숫자 보정: 21,350회(`pg-stats-primary.txt:53`)는 색인 목록 수집 시점에 21,414회다.
- 규모: S

### DB-15 큰 뜨거운 표에 autovacuum 기본값(scale_factor 0.2)이라 죽은 행이 9~18% 쌓인다
- 심각도: P3
- 분류: inefficiency
- 위치: 운영 설정 `autovacuum_vacuum_scale_factor 0.2`(`pg-stats-primary.txt:89`), 표별 설정 없음(`rg autovacuum drizzle` 0건).
- 문제: 100만 행 표는 죽은 행 20만이 쌓여야 청소가 돈다 — 그사이 전체 훑기(DB-02·05·06)가 죽은 행까지 읽는다.
- 실측 근거: `pg-stats-primary.txt:8-13` 죽은 행 model_capacity_requests 93,297(18%), crawl_candidates 127,809(12%), crawl_documents 113,566(11%), crawl_frontier 97,753(9%), second_reviews 33,405(16%).
- 수정 방안: `ALTER TABLE <표> SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)` — 위 다섯 + product_translations·pipeline_item_leases. SHARE UPDATE EXCLUSIVE 잠금이라 읽기·쓰기를 막지 않는다.
- 검증: n_dead_tup 비율 < 3% 유지, autovacuum 횟수.
- 배포 주의: 마이그레이션 한 줄씩(짧은 잠금), 일반 배포.
- 확신도: CONFIRMED
- 규모: S

### DB-16 시각 칸이 timestamp(154)와 timestamptz(163)로 섞였고, 주 호스트(M3·mini)는 UTC 세션을 강제하지 않는다
- 심각도: P3
- 분류: logic
- 위치: `lib/db/*.ts`(`withTimezone: true` 163곳 / 맨 `timestamp("…")` 154곳). 예: jobs·crawl_*·products·model_capacity_requests 일부는 naive, uptime_claims·pipeline_item_leases 는 timestamptz. 비교 꼴이 섞임 — `now()` 를 naive 칸과 직접 비교(대부분), `(now() AT TIME ZONE 'UTC')`(예: 느린 목록 `:55` 정리 문장), `h.checked_at AT TIME ZONE 'UTC'`(`uptime-split-repository.ts:27`, `uptime-claims.ts:146`), `localtimestamp`(`uptime-split-repository.ts:86`). Oracle 소비자는 프로세스·역할·세션 UTC 를 preflight 로 검사하지만(`deploy/oracle/README.md`, `lib/runtime/oracle-db-profile.ts:135,237`) M3·mini 이미지(`Dockerfile`)·풀(`lib/db/pool.ts:72-87`)에는 TZ 고정이 없다.
- 문제: naive 칸과 `now()`(timestamptz) 비교는 세션 TimeZone 으로 변환되므로, 어느 세션이든 UTC 가 아니면(예: psql 로 붙은 운영자, TZ 가 다른 새 호스트) 기한·재시도·근거 나이 판정이 9시간 어긋난다. 지금 운영 값이 UTC 라 실측 피해는 없다(memory: 로컬 node 로 읽으면 9시간 밀림).
- 실측 근거: 코드 근거만.
- 수정 방안: 주 DB 역할 `ALTER ROLE nomorevibe SET timezone = 'UTC'` + 워커 preflight 에 Oracle 과 같은 timezone 검사 추가(세션 `current_setting('TimeZone')`). 장기적으로 새 칸은 timestamptz 로만(스키마 lint).
- 검증: preflight 테스트, 세션 TimeZone 을 Asia/Seoul 로 바꾼 통합 테스트에서 잡 기한 판정이 같은지.
- 배포 주의: ALTER ROLE 은 새 연결부터 적용.
- 확신도: PLAUSIBLE(현재 피해 없음 — 잠재 위험)
- 규모: S

### DB-17 마이그레이션이 한 TX 로 돌아 큰 표 색인을 CONCURRENTLY 로 만들 수 없다 — 이번 제안 색인들의 적용 경로가 없다
- 심각도: P3
- 분류: non-standard
- 위치: `node_modules/drizzle-orm/pg-core/dialect.js:60-71`(밀린 마이그레이션 전체를 `session.transaction` 하나로), `scripts/migrate.mjs`(`lock_timeout '10s'`), `drizzle/0185_discovery_admission_indexes.sql:3,6`(crawl_candidates 106만 행·crawl_frontier 107만 행에 일반 `CREATE INDEX` — SHARE 잠금으로 빌드 동안 쓰기 정지; crawl-schema.ts 주석이 같은 꼴을 3.4초로 잼). 0058·0109·0110 주석이 이 제약을 이미 적어 둠.
- 문제: 여러 마이그레이션이 밀리면 앞 파일의 잠금이 마지막 파일까지 유지되고, 큰 표 색인은 빌드 시간 내내 쓰기를 막는다. lock_timeout 10초 동안 잠금 줄에 서면 그 뒤의 모든 잠금 요청도 막힌다. DB-01·06·10·14 의 색인은 CONCURRENTLY 가 필요하다.
- 실측 근거: 코드 근거만(배포 창 경험은 memory `migrate-check-rebuild-under-drain`).
- 수정 방안: 「온라인 DDL」 경로를 표준화 — 새 파일 `scripts/ops/online-index.ts`(아직 없음, TX 밖 `CREATE/DROP INDEX CONCURRENTLY`, `lock_timeout` 짧게, 실패 시 INVALID 색인 정리) → 그 뒤 일반 마이그레이션은 `CREATE INDEX IF NOT EXISTS`(no-op)로 스키마 기록. CI 에 「100만 행 넘는 표에 일반 CREATE INDEX 금지」 lint.
- 검증: 스테이징에서 쓰기 부하 중 적용, `pg_index.indisvalid` 확인.
- 배포 주의: 운영 절차 문서(`docs/operations/deployment-fast-path.md`)에 단계 추가.
- 확신도: CONFIRMED
- 규모: S

### DB-18 (복제본) 이야기 화면의 `max(last_seen_at)` 가 social_posts 를 매번 훑는다
- 심각도: P3
- 분류: inefficiency
- 위치: `lib/social/talk.ts:273-276` `select max(last_seen_at) from social_posts`. 색인은 `(source, external_id)`·`(repository_key, posted_at)`·`(posted_at)` 뿐(`drizzle/0103_social_posts.sql:31-35`).
- 문제: 공개 화면 요청마다 5.8만 행 전체 훑기.
- 실측 근거: `pg-stats-replica.txt:5` social_posts seq_scan 24,866회·seq_tup_read 13.1억(복제본).
- 수정 방안: `CREATE INDEX CONCURRENTLY social_posts_last_seen_idx ON social_posts (last_seen_at DESC);`(약 1.5MB, 갱신 54,590회 — HOT 46k 가 일부 non-HOT 이 됨) 또는 수집 잡이 마지막 확인 시각을 관측값으로 적고 화면은 그것을 읽기(추천 — 쓰기 비용 없음).
- 검증: 복제본 social_posts seq_scan 증가율.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED(복제본 seq scan 의 이 질의 몫은 PLAUSIBLE)
- 규모: S

## 구조 변경 제안 (리팩토링으로 효율화)

### S1. 파이프라인 큐 스냅숏 — 한 번 세고 여럿이 읽는다
- 지금: `pipelineThroughput`·`evidenceProgress`·uptime readback·`discovery-admission` 의 단계 수·`textStageProgress` 가 역할 워커(15초×주 역할), 감시(30초), 운영 콘솔, 배포 관문, 발굴 잡 관문에서 각자 같은 전체 집계를 낸다.
- 바꿀 구조: 생산자 하나(scheduler 또는 maintenance 주 역할)가 30~60초마다 한 TX 로 세어 `operations_observations('pipeline-snapshot')`(measuredAt 포함)에 적는다. 소비자는 읽기만 하고 나이가 2주기 넘으면 unknown. 정체 판정용 「최근 완료 수」는 각 잡이 틱 끝에 이미 적는 job-tally 를 쓴다.
- 얻는 것: 진행 집계 문장 수 약 1/20(분당 15~20 → 1~2), uptime readback 4,121초/일 → 약 200초, crawl_frontier·crawl_documents·second_reviews·crawl_review_attempts seq scan 대부분 제거(DB-02).
- 옮기는 순서: ① 생산자 추가(기존 소비자 유지), ② 감시·콘솔 전환, ③ 역할 워커 전환, ④ 배포 관문 전환(관문 의미 문서화), ⑤ 옛 직접 집계 제거.
- 위험: 생산자 정지 = 전원 unknown → 생산자 자신의 생존을 감시가 따로 본다. 스냅숏 지연 30~60초만큼 정체 감지가 늦어진다.

### S2. 근거 지문(fingerprint) 열 — 원본 대조를 jsonb 비교에서 등식으로
- 지금: `currentReviewSource` 가 시도 행 `source`/`snapshot` jsonb 와 현재 원본(page_meta README 발췌·스캔 행 열 9개)을 SQL 로 하나하나 비교해, 발행 관문(DB-01)·위임 검수 고르기(DB-08)·보류 Qwen 등에서 후보×시도마다 TOAST 를 푼다.
- 바꿀 구조: 시도 기록 시 `source_fingerprint = sha256(정규화된 원본 튜플 + README 발췌 해시)` 를 칸으로 저장(색인 `(candidate_id, source_fingerprint)`), 원본 쪽은 수집·스캔 갱신 시 `crawl_documents.review_fingerprint`(또는 별도 작은 표)에 같은 함수로 저장. SQL 은 `a.source_fingerprint = cur.fingerprint`.
- 얻는 것: 관문 SubPlan 의 TOAST 해제 제거 — DB-01(30,676초/일)·DB-08(2,572초/일)의 큰 몫, crawl_review_attempts 1.8GB 읽기 감소.
- 옮기는 순서: ① 함수(TS·SQL 동일 결과) + 새 칸 nullable, ② 새 시도부터 기록, ③ 옛 시도 백필, ④ 술어를 「지문 일치 OR (지문 없음 AND 옛 비교)」로, ⑤ 백필 완료 후 옛 비교 제거.
- 위험: 정규화 규칙(밀리초 절삭·공백 btrim 문자 집합)이 지금 SQL 과 한 글자라도 다르면 발행이 막히거나 잘못 열린다 → 같은 스냅숏에서 두 방식 결과를 전수 대조하는 검증 스크립트 필수.

### S3. 사유 원문 해시 표 `reason_sources`
- 지금: 번역할 사유 = crawl_review_attempts ∪ second_reviews 40만 행을 매번 sha256 으로 묶는다(진행·대기열·dispatch 확인).
- 바꿀 구조: `reason_sources(hash PK, first_ref, latest_at, needs_korean)` 를 시도·2차 사유를 적는 쪽(또는 AFTER INSERT/UPDATE OF reason, outcome, second_reason 트리거)이 upsert. 진행 = `reason_sources LEFT JOIN text_translations` + `latest_at` 색인, dispatch 확인 = PK 조회.
- 얻는 것: 19,651초/일(DB-03) → 수십 초, 임시 파일 하루 약 200GB 제거, control 잠금 안 전체 훑기 제거(DB-07).
- 옮기는 순서: ① 표 + 트리거(새 행부터), ② 백필, ③ 진행 문장 전환, ④ 잡 대기열·dispatch 전환, ⑤ UNIQUE_SOURCES 제거.
- 위험: 사유가 지워지는 경로(보관 삭제·후보 cascade)와의 정합 — 지우면 해시 행도 정리하거나 「원본 있음」 판정을 ref 행으로 재확인.

### S4. 「할 일 고르기」 표준 — due 칸 + 부분 색인
- 지금: README 재수집·소개 검수·한국어 소개·키워드·근거 수집·판정 대기열이 「다른 표와 비교」 술어로 넓은 표를 훑어 고른다(DB-05·DB-09).
- 바꿀 구조: 대기 여부를 바꾸는 쓰기(소개 변경·재수집·실패 재시도)가 같은 TX 에서 해당 단계 행의 `due_at` 을 채우고(없으면 NULL), 고르기는 `WHERE due_at <= now() ORDER BY due_at LIMIT n FOR UPDATE SKIP LOCKED`(부분 색인 `WHERE due_at IS NOT NULL`). 완료 시 NULL.
- 얻는 것: 고르기 문장 O(묶음) — products/crawl_documents 전체 훑기 제거(합계 약 3,000초/일 + seq scan 다수).
- 옮기는 순서: 단계 하나씩(README → 소개 검수 → 한국어 → 키워드), 각 단계는 「옛 술어로 찾은 집합 ⊆ due 집합」 대조 기간을 둔 뒤 전환.
- 위험: due 를 채우지 않는 쓰기 경로를 놓치면 일이 영영 안 잡힌다 → 하루 한 번 옛 술어로 전수 점검하는 안전망 잡 유지.

### S5. products 표 다이어트
- 지금: 공개 목록의 핵심 칸과 검색 본문(search_page_text·search_readme 최대 수 KB)·저장소 상태(stars·repo_checked_at 등 하루 1회 갱신)·search_vector(GIN)가 한 행에 있다 — 행당 12KB, HOT 0.3%.
- 바꿀 구조: `product_search_documents(product_id PK, search_* , search_vector)` + GIN 을 분리, 저장소 상태 칸은 `product_repo_state` 로. products 는 fillfactor 85.
- 얻는 것: products 전체 훑기 비용 수분의 1, 상태 갱신이 GIN 을 건드리지 않음(DB-11), 공개 목록 캐시 효율.
- 옮기는 순서: 새 표 이중 쓰기 → 검색 질의 전환(복제본) → 옛 칸 제거(창).
- 위험: 검색 랭킹 문장 전면 수정, 생성 열 의존(search_vector 가 name·tagline 도 읽음 — 새 표는 트리거로 동기화 필요). 범위가 커서 S1~S4 뒤에.

### S6. 온라인 DDL 경로(DB-17) — 위 제안 색인의 전제

## 확인했지만 문제 아님
- `products_search_idx` 265MB 가 주 DB 에서 0회 — 공개 검색은 복제본(web-replica 연결 46개, `pg-stats-replica.txt:27`)에서 돌고 물리 복제라 지울 수 없다.
- `product_audit_campaigns` seq_scan 1,391만 회(행 0~수 개, 64kB) — `audit-auto-close.ts:160,197` 의 `n JOIN nc` NOT EXISTS 가 행마다 1페이지 표를 읽는 것. 회당 비용이 극히 작고(총 8,300만 행) 비용은 바깥 질의 쪽이다.
- `second_review_workload_assignments` seq_scan 2,066만 회 — PK(second_review_id)가 이미 있다(`second-review-schema.ts:85`). 73페이지 표라 플래너가 섞어 고르는 것. 근본은 회원 자격 SQL 을 행마다 평가하는 바깥 질의(DB-01) 쪽.
- 마이그레이션 번호·journal 순서 — `tests/migration-config.test.ts:18-25`·`tests/migration-production-lock.test.ts:39-46` 가 when 단조 증가·운영 적용분 해시를 지킨다. journal 186개 모두 단조·파일과 1:1(직접 대조).
- `busyMemberKeysSql`(`lib/llm/capacity-busy-targets.ts:58-63`) — `liveStateSql` 술어가 0151 `live_work_idx` 술어와 정확히 같아 부분 색인을 탄다.
- `model_capacity_requests` 무한 증가 — 0187 + db-retention 잡(기본 14일)이 지운다. 2.47GB 는 보관분 + 부풀음이다(DB-15 로 완화).
- CONCURRENTLY 를 마이그레이션에 쓰지 않는 것 — 마이그레이터 제약을 0058·0109·0110 주석이 적어 둔 의도적 선택(대안 경로가 없는 것이 DB-17).
- uptime_claims HOT 0 — 갱신마다 state·due_at·lease(색인·부분 색인 술어 열)가 바뀌는 본질적 non-HOT. 쓰지 않는 due_idx 만 DB-14.
- `pipelineThroughput` 의 JIT 끄기·3초 한도 — 주석(2026-11-10 7.3초 → 156ms)대로 의도된 보호. 문제는 빈도(DB-02).

## 범위 밖·못 본 것
- `model_capacity_control` FOR UPDATE/SHARE 대기(합계 36,317초)의 상세 — llm-capacity 점검자. 여기서는 그 안의 무거운 읽기(DB-07)만 다뤘다.
- 장부 정산 UPDATE 평균 0.55초(`:16,:22,:43`) — 큰 CHECK 비용(#772, 알려진 것)과 색인 15개 유지로 보이며 상세는 llm-capacity.
- statement timeout 10,383건·875건의 문장 귀속 — 근거 파일에 문장이 없다(DB-13).
- `product_links` seq_scan 122,622회 × 10.9만 행(갱신 0) — 훑는 질의를 시간 안에 찾지 못했다.
- `agent_repository_claims`(234k)·`repository_ai_levels`(146k)·`product_evidence_sources`(245k) seq scan — `evidenceProgress`(DB-02)와 근거 고르기(DB-09) 몫으로 추정, 끝까지 추적하지 못했다.
- `text_translations` idx_scan 58.4억(28만 행) — 출처 미확인(진행 문장은 주석상 PK 찌르기를 피함).
- 복제본 products seq_scan 66,580회·53억 행 — 공개 화면 질의(웹 점검자).
- second-review 잡: 실행 208,583회인데 `last_success_at` 이 2026-10-25(`jobs.txt:59`) — 매 틱 성공으로 인정되지 않는 까닭은 파이프라인 점검자 몫(DB-04 힌트 지연이 한 원인일 수 있음).
- 모든 실행 계획 주장은 EXPLAIN 없이 쓴 것 — 수정 전 복제본에서 확인해야 한다.

## 부록 A — 느린 문장 상위 40 지도 (`slow-queries-primary.txt` 2~41행)

| 순위 | 합계 초 | 평균 ms | 만드는 곳 | 부르는 곳·빈도 | 원인 | 처방 |
|---|---|---|---|---|---|---|
| 1 | 30,676 | 2,729 | `crawl/repository.ts:896` listCandidates + `agent-review-repository.ts:432` | crawl-publish 틱·묶음마다(분당 ~11) | 승인 589건×관문 SubPlan, first_attempt_id 색인 없음, README TOAST 비교 | DB-01·S2 |
| 2 | 20,254 | 1,031 | `llm/capacity-repository.ts:81` control FOR UPDATE | 모든 모델 입장·정산 | 전역 단일 행 잠금 대기 | llm-capacity, DB-07 |
| 3 | 16,580 | 4,601 | `operations/text-stage-progress.ts:35` (감시) | failover-monitor 30초 | 40만 사유 해시 집계 + work_mem 32MB 흘림 | DB-03·S3 |
| 4 | 10,292 | 7,263 | `crawl/second-review-stale.ts:244` | second-review 틱마다 여러 번 | 장부 전체 훑기 + 쌍마다 LIKE/정규식 | DB-04 |
| 5 | 8,871 | 868 | `crawl/repository.ts:800` judgementQueue | crawl-judge 틱(분당 ~7) | OR 외부 조인 → 원본 전체 | DB-05 |
| 6 | 6,894 | 1,053 | control `select id … for update` | 장부 쓰기 | 잠금 대기 | llm-capacity |
| 7 | 6,467 | 1,011 | control 전체 칸 FOR SHARE | 장부 읽기 | 잠금 대기(writer 뒤 줄) | llm-capacity |
| 8 | 4,121 | 572 | `operations/uptime-split-repository.ts:65` readback | 역할 워커 progress(분당 ~5) | uptime_claims⋈products⋈health 전체 집계 | DB-02·S1 |
| 9 | 3,633 | 3,201 | 1과 같은 함수(비풀 경로) | crawl-publish | 1과 같음 | DB-01 |
| 10 | 3,071 | 4,747 | 3과 같은 문장(nomorevibe) | 운영 콘솔·배포 확인 | 3과 같음 | DB-03 |
| 11 | 2,572 | 1,989 | `crawl/human-review-repository.ts:77` | human-deepseek-review 매 틱 | 5천 id × 원본 대조 3회 | DB-08 |
| 12 | 2,569 | 1,004 | control `select id … for share` | 장부 읽기 | 잠금 대기 | llm-capacity |
| 13 | 1,350 | 944 | `domain/products/intro-checks.ts:66` | product-intro-check | products 전체 훑기·정규식 | DB-09·S4 |
| 14 | 1,220 | 919 | `jobs/batch-repository.ts:160/202` role_leases FOR UPDATE | 역할 lease 갱신·선출 | 행 잠금 대기(긴 TX 의 FOR SHARE) | DB-12·DB-07 |
| 15 | 824 | 554 | 장부 정산 UPDATE | 모델 호출 종료 | CHECK·색인 유지(알려짐 #772) | llm-capacity |
| 16 | 737 | 2,711 | `crawl/repository.ts:517` pendingPublishedReadmes | product-readme-refresh | 원본 107만 행 page_meta TOAST 해제 | DB-09 |
| 17 | 659 | 929 | `jobs/role-leader.ts:103` 등 role_leases FOR UPDATE | 역할 lease | 잠금 대기 | DB-12 |
| 18 | 396 | 531 | `domain/products/korean-taglines.ts:170` | product-tagline-ko | 공개 제품 전체 정렬 | DB-09 |
| 19 | 330 | 980 | `jobs/runner.ts:162`·`control.ts:55` insert jobs DO NOTHING | 잡 claim·정기 요청 | 진행 중 갱신자 대기 | DB-12 |
| 20 | 182 | 941 | `jobs/control.ts:81` markWorkerSeen | 워커 생존 표시 | jobs 행 경합 | DB-12 |
| 21 | 136 | 529 | 장부 dispatch UPDATE | 모델 전송 | 장부 쓰기 비용 | llm-capacity |
| 22 | 135 | 846 | `jobs/runner.ts:202` heartbeat | 잡마다 15초 | jobs 행 잠금 대기 | DB-12 |
| 23 | 133 | 889 | `SELECT mode FROM model_capacity_control … FOR SHARE` | 1시간에만 | 잠금 대기 | llm-capacity |
| 24 | 115 | 977 | `jobs/control.ts:22` requestJob | 도메인 TX 안 | jobs 행 경합 | DB-12 |
| 25 | 101 | 1,864 | `operations/db-retention.ts:320` | db-retention | 보관 삭제 묶음 | (경미) |
| 26 | 99 | 1,042 | jobs `for share`(assertJobLease) | 도메인 TX 끝 | 잠금 대기 | DB-12 |
| 27 | 84 | 1,027 | markWorkerSeen 여러 행 | scheduler | jobs 행 경합 | DB-12 |
| 28 | 40 | 537 | `domain/products/search-profiles.ts` 대기열 | product-search-profile | products 훑기 | DB-09 |
| 29 | 39 | 550 | 8과 같은 readback(감시) | failover-monitor | 8과 같음 | DB-02 |
| 30 | 34 | 711 | `operations/db-retention.ts:227` | db-retention | 보관 범위 계산 | (경미) |
| 31 | 26 | 536 | 장부 INSERT | 모델 입장 | CHECK·색인 | llm-capacity |
| 32 | 20 | 703 | `pg_advisory_xact_lock(hashtextextended…)` (`evidence/agents/claims.ts:271` 등) | 스캔 큐 채우기 | 권고 잠금 대기 | (경미) |
| 33 | 20 | 802 | `domain/products/search-profiles.ts:203` update products | 키워드 기록 | non-HOT + GIN | DB-11 |
| 34 | 16 | 915 | github_ko_discovery_queries upsert | 한국어 탐색 설정 동기화 | (경미, 12회) | — |
| 35 | 14 | 533 | `crawl/translations.ts:334` lockReasonCache EXISTS | reason dispatch(잠금 안) | SOURCES 전체 훑기 | DB-07·S3 |
| 36 | 14 | 13,681 | `crawl/second-review.ts:560` 공개분 표본 | second-review(1회) | 공개분 ⋈ 원본 ⋈ products 2,000건 | (경미, 1회) |
| 37 | 12 | 855 | `crawl/taglines.ts:226` jobs 두 행 FOR UPDATE | crawl-tagline 기록 | jobs 행 경합 | DB-12 |
| 38 | 12 | 830 | `jobs/control.ts:59` requestDueJobs UPDATE | scheduler | jobs 행 경합 | DB-12 |
| 39 | 11 | 537 | `domain/products/repository.ts:316` 부근 공개+가동 관문 | 목록 계산(주 DB) | product_health NOT EXISTS | (경미) |
| 40 | 11 | 776 | jobs `for update`(assertJobLeaseAtWallTime 'update') | 도메인 TX | 잠금 대기 | DB-12 |

## 검증 기록 (2차)

검증자가 2026-11-21 에 했다. 코드는 `저장소 루트`(34b5fe32)만 읽었다. 운영 실제 색인 목록(`evidence/indexes-primary.txt` — 1차 점검자가 보지 못한 것)과 `orchestrator-checks.md` 로 「색인 없음」 주장을 모두 대조했다. 운영·DB 에는 접속하지 않았다.

**고친 인용: 12건**
- 인용 코드를 실제 줄로 바꿈(5건): DB-01 의 publish.ts 와 README 비교 2건, DB-07(줄 끝 설명 제거), DB-08, DB-10.
- 인용이 아닌 코드 블록을 산문·한 줄 코드로 옮김(4건)
  - DB-02: 요약 SQL 을 CTE 별 줄 번호가 달린 산문으로 옮겼다.
  - DB-01·06·10: 제안 DDL 블록을 「새로 만들 것」이라 밝히고 한 줄 코드로 바꿨다.
- 줄 번호 고침(2건): DB-05 `judge.ts:36-41` → `:37-42`, DB-08 `human-review.ts:57-60` → `:56-60`.
- 없는 파일 1건: DB-17 이 만들자는 것이므로 새 파일 `scripts/ops/online-index.ts` 로 표시했다.

**반증·심각도 변경**
- 제목에 [반증됨] 을 붙인 항목은 없다. 심각도를 바꾼 항목도 없다(P1 7건 모두 실측 비중·기전이 유지됨).
- 근거 일부를 반증·보정한 항목:
  - DB-05: 「crawl_candidates idx_scan 10.7억 = 원본마다 찌름」은 반증됐다.
    - 색인별 통계에서 그 수의 91% 가 `published_slug_idx`(9.76억)에서 나온다. 이 조인이 쓸 `repo_unique` 는 650만 회뿐이다.
    - 그러니 Nested Loop 가 아니라 통째 조인이다. 결론(빈 큐에도 끝까지 읽음)은 그대로다.
  - DB-01: 「최대 15초 = 역할 기본 statement_timeout」은 확인되지 않았다. 코드 기본값은 publisher 60초다(`lib/db/pool.ts:54`).
  - DB-03
    - 「work_mem 을 32MB 로 낮춘다」는 확인했다. 저장소에서 work_mem 을 SET 하는 곳은 `text-stage-progress.ts:156` 한 곳뿐이고, 서버값은 64MB 다. 시험 `tests/text-stage-progress-read.test.ts:39` 가 그 값을 고정한다.
    - 875회 귀속과 `:4` 평균은 'other' 문장이 섞였을 수 있다고 보정했다.
  - DB-10: 「PK 로 거를 수 없다」를 「PK 로 ai2 범위까지만 좁힌다」로 보정했다.
  - DB-14
    - 0회 다섯은 모두 비유일 색인이다(맞음).
    - 0회지만 지우면 안 되는 유일·PK 색인 목록을 더했다(장부 claim 유일 색인 다섯, events terminal·released, 감사 rolling·running, PK 셋).
    - `crawl_candidates_state_idx` 가 발행 대기열 순서와 같다는 주의를 더했다.
- 운영 색인과 맞춘 「색인 없음」 주장 — 모두 맞음:
  - DB-01 second_reviews.first_attempt_id
  - DB-02 fetched_at 선두 · judged_at · completed_at · second_stats
  - DB-06 열린 상태 3·4상태 집합
  - DB-10 binding->>'candidateId'
  - DB-18 social_posts.last_seen_at
- 제안 색인과 기존 색인의 겹침:
  - DB-01·02·10·18 은 겹치는 것이 없다.
  - DB-06 은 기존 부분 색인들의 상위 집합 술어라 중복이 아니다. 선두 칸을 route_id 로 둘지 state 로 둘지는 문장 통계로 정할 것을 적었다.
- DB-04 는 오케스트레이터 EXPLAIN(357ms → 0.061ms, active_idx)과 보호 규칙 대조로 확정했다.

**PLAUSIBLE 로 남은 P1 항목**
- DB-03: 임시 파일 흘림은 EXPLAIN 이 필요하다.
- DB-06: seq scan 1.76M 회의 주된 출처.
- 부분만 PLAUSIBLE 인 것: DB-01(2.7초 중 하위 질의별 몫), DB-02(seq scan 귀속), DB-07(control 대기 총량 중 몫). 핵심 주장은 CONFIRMED 다.

**끝내 확인하지 못한 것**
- statement timeout 10,383·875건의 문장 귀속(DB-13 보강: 원 로그의 `STATEMENT:` 줄 재집계로 가능할 수 있음).
- `indexes-primary.txt` 에 없는 표(product_updates·github_discovery_pages 등)의 색인 사용 수.
- 복제본 쪽 색인 사용 수.
- 모든 실행 계획 주장(EXPLAIN 없음. REVIEW-04 계열만 오케스트레이터가 쟀다).
- DB-05 물높이 안의 전제(재수집에도 원본 행 id 유지): upsert 라 대체로 맞다. `values` 에 id 가 실리는지는 끝까지 보지 않았다.
- operations-admin 과 겹치는 항목: DB-02 ↔ OPS-02·03, DB-03 ↔ OPS-04. 계획 문서에서 하나로 합칠 것.
