# 03. 발굴·수집·규칙 판정 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


기준: `저장소 루트` (origin/main `34b5fe32`). 읽기 전용, EXPLAIN 미실행(운영 접속 금지) — seq scan 출처 귀속은 코드 구조와 근거 파일 수치로 추론한 것이다.

## 요약 (심각도별 건수, 가장 중요한 5개 한 줄씩)

- P0 0건 · P1 3건 · P2 8건 · P3 7건 (총 18건)
- 상위 5건
  1. **CRAWL-01** 발행 승인 술어(reviewApprovalPredicate)가 매 호출 승인 후보 전부(약 589건)에 대해 시도 스냅숏·원본 page_meta 를 풀어 README 를 대조 — 주 DB 느린 문장 1위·9위, 하루 12,377회·34,309초(전체 느린 시간의 28%). (발행 구역과 경계)
  2. **CRAWL-02** 판정 대기열 조회(judgementQueue)가 ORDER BY 없는 `crawl_documents ⟕ crawl_candidates` 전체 조인 + OR 조건 — 느린 문장 5위, 하루 10,220회·8,871초.
  3. **CRAWL-03** 봇 차단 응답 401·403·429·999 를 규칙 판정이 "접속 불가(unreachable)"로 자동 거부 — 같은 코드베이스의 생존·감사 경로는 이 넷을 "blocked(살아 있음)"로 본다. 원본 page_status 403 2,855·401 414·429 179건.
  4. **CRAWL-04** 발굴 입장(readReviewBacklogInTransaction)이 검색 페이지마다 crawl_documents 전체 반조인을 다시 계산 — 기본 상한 1,000,000 과 비교하려고. crawl_documents·crawl_candidates seq scan(각 2,328억·3,370억 행)의 유력한 주 출처.
  5. **CRAWL-05** 일시 오류(HTTP 5xx/429/408·fetch failed·timeout)가 3시간 35분 안에 4회 실패하면 frontier `failed` 로 굳고, 받아 둔 GitHub 메타도 버려 후보조차 남지 않으며 되살리는 경로가 없음 — 1,689건 증발.

## 발견

### CRAWL-01 발행 승인 술어가 매 평가마다 시도 스냅숏·원본 page_meta 를 풀어 README 를 대조한다 (느린 문장 1위)
- 심각도: P1
- 분류: latency
- 위치:
  - `lib/crawl/jobs/publish.ts:115-124` — 발행 루프가 매 회전마다 술어 전체로 승인 후보를 다시 고름
    ```ts
    while (ctx.hasBudget()) {
      const eligible = pool || process.env.CONNECT_AGENT_URL
        ? and(reviewApprovalPredicate(settings), or(classificationReadyPredicate(), starAutoApprovalPredicate(settings)))
        : reviewApprovalPredicate(settings);
      const candidates = await crawl.listCandidates(["approved"], resume ? BATCH : BATCH * classifyConcurrency, and(eligible, ...
    ```
  - `lib/crawl/repository.ts:896-907` `listCandidates` (state IN + 술어, ORDER BY updated_at DESC LIMIT)
  - `lib/crawl/agent-review-repository.ts:432-445` `reviewApprovalPredicate` (CASE → EXISTS crawl_review_attempts …)
  - `lib/crawl/agent-review-repository.ts:350-375` `currentReviewSource` — 시도 행마다 아래를 평가
    ```sql
    AND coalesce(attempt.snapshot->'product'->>'readme', '') = btrim(left(
      CASE WHEN jsonb_typeof(rd.page_meta->'readmeSample') = 'string' THEN rd.page_meta->>'readmeSample' ELSE '' END, 3000), ...)
    LEFT JOIN LATERAL (SELECT s.* FROM agent_repository_scans s WHERE s.repository_key = lower(c.repo) AND s.scope = ''
      ORDER BY s.started_at DESC, s.id DESC LIMIT 1) rs ON true
    ```
- 문제: LIMIT 이 작아도 승인 후보 대부분이 아직 발행 불가(2차 표 대기·분류 대기)라 Postgres 는 `approved` 전부(근거: approved 581+8건)에 대해 CASE 안의 상관 EXISTS 를 끝까지 평가한다. 시도 행마다 (a) `crawl_review_attempts.snapshot`(TOAST, 표 1.8GB) 해제, (b) `crawl_documents.page_meta`(textSample 6,000자·readmeSample·썸네일 힌트 등, TOAST) 해제, (c) agent_repository_scans 최신 1건 LATERAL — 이 표에는 `(repository_key)` 단일 인덱스뿐이라 저장소의 스캔 전부를 읽어 정렬 — (d) 2차 표 EXISTS 가 붙는다. 시나리오: 2차 심사가 밀려 승인 후보 600건이 대기 중이면 crawl-publish 가 요청될 때마다(승인마다 requestJob) 같은 600건×시도 수만큼 큰 jsonb 를 풀고 0~몇 건만 고른다. 최대 14.8초까지 걸려 발행 틱이 통째로 묶인다.
- 실측 근거: `slow-queries-primary.txt` 2행(11,242회·30,676초·평균 2,729ms·최대 14,196ms)과 10행(1,135회·3,633초·평균 3,201ms·최대 14,772ms) — 둘 다 `"state" in ($n) and (CASE WHEN decided_by = '?' OR (... signals->'?' IS NOT NULL) THEN EXISTS (SELECT N FROM crawl_review_attempts ...` 로 `listCandidates(["approved"])`+`reviewApprovalPredicate` 와 일치(2행은 pool 모드의 `and(…, or(…))`, 10행은 단독 술어). 합계 34,309초 = 느린 문장 전체 122,852초의 27.9%.
- 수정 방안(추천 순):
  1. README 대조를 좁은 해시 열로 바꾼다 — `crawl_review_attempts.readme_sha`(시도 생성 시 snapshot.product.readme 의 sha256), `crawl_documents.readme_sha`(saveFetchedDocument·setReadmeSample 이 함께 기록). 술어는 `a.readme_sha = rd.readme_sha` 스칼라 비교. 발행 트랜잭션의 `assertReviewApproval` 이 잠근 행으로 정확히 다시 대조하므로(주석 433-434행) 선필터를 좁혀도 안전성은 그대로다.
  2. `agent_repository_scans (repository_key, scope, started_at DESC, id DESC)` 인덱스 추가 — LATERAL 최신 스캔을 1행 인덱스 탐색으로.
  3. 구조적으로는 "발행 가능 표지"(구조 제안 S4)로 승인·2차 합의·분류 완료 사건에서만 후보를 발행 대기열에 올리고, 매 틱 전체 재평가를 없앤다.
  - 같은 `currentReviewSource` 가 사람 위임 고르기(느린 문장 12행, `human-review-repository.ts:69-90`, 1,293회·평균 1,989ms)에도 쓰여 1번 수정이 두 곳을 함께 줄인다.
- 검증: 복제본에서 같은 문장 `EXPLAIN (ANALYZE, BUFFERS)`로 detoast·LATERAL 비중 확인 → 수정 후 같은 계획에서 shared hit/read 와 실행 시간 비교. 운영 지표: 느린 문장 로그의 이 모양 횟수·합계, `crawl.publish_done` 틱 지속시간. 회귀: `tests/integration/crawl-publish.test.ts`, `tests/crawl-publication-guard.test.ts`.
- 배포 주의: 열 추가 마이그레이션 + 백필(363k·1.07M 행, 배치로). 새 열을 읽는 코드는 백필 완료 뒤 배포(새 칸 마이그레이션은 이전 코드로 DRAIN 하는 기존 절차). 인덱스는 `CREATE INDEX CONCURRENTLY` 권장.
- 확신도: 호출 경로 CONFIRMED(문장 모양·컬럼 순서 일치), 비용 원인(detoast·LATERAL 정렬)은 PLAUSIBLE — EXPLAIN BUFFERS 로 확인 필요.
- 규모: M
- 경계: 발행·1차 심사 점검자와 겹친다. 이 구역에서는 크롤 표(crawl_documents·crawl_candidates) 쪽 원인 추적으로 싣는다.

### CRAWL-02 판정 대기열 조회가 매번 crawl_documents × crawl_candidates 전체 조인을 한다 (느린 문장 5위)
- 심각도: P1
- 분류: latency
- 위치: `lib/crawl/repository.ts:787-811`
  ```ts
  export function judgementQueuePredicate() {
    return sql`${crawlCandidates.id} IS NULL OR (${crawlCandidates.state} = 'new'
      AND (${crawlCandidates.signals}->>'reconsiderAfter' IS NULL OR date_trunc('milliseconds', ${crawlDocuments.fetchedAt}) > ...))`;
  }
  const rows = await db.select().from(crawlDocuments)
    .leftJoin(crawlCandidates, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(judgementQueuePredicate()).limit(limit);
  ```
  호출: `lib/crawl/jobs/judge.ts:37-42`(틱마다 최소 1회, 대기열이 비면 마지막 호출이 반드시 전체를 훑음). 같은 술어를 `lib/operations/throughput.ts:82-85`(관리자 화면)·`lib/crawl/discovery-admission.ts:113-115`(죽은 코드)도 쓴다.
- 문제: 왼쪽 조인 뒤 `c.id IS NULL OR c.state='new'…` 라 어느 인덱스도 못 탄다. ORDER BY 가 없어 일찍 끝날 수도 있지만, 대기열이 비거나 거의 빈 평상시에는 문서 107만 행(3.5GB 표)과 후보 106만 행을 해시 조인으로 끝까지 읽는다. crawl-judge 는 5분 주기지만 원본 저장마다 `requestJob("crawl-judge")`(repository.ts:738)로 깨어나 하루 1만 번 넘게 이 전체 조인을 돈다. 판정할 것이 0건인 틱도 0.87초.
- 실측 근거: `slow-queries-primary.txt` 6행 — `select crawl_documents.id, repo, repo_meta, product_url, page_status, page_meta, fetched_at, crawl_candidates.id, …` 10,220회·8,871초·평균 868ms·최대 2,219ms. `.select().from(crawlDocuments).leftJoin(crawlCandidates)` 는 저장소에서 이 한 곳뿐(rg 확인). `pg-stats-primary.txt` crawl_documents seq_scan 1,056,322·2,328억 행, crawl_candidates 1,403,437·3,370억 행에 기여.
- 수정 방안: 판정 대기 표지를 둔다(구조 제안 S1). 추천: `crawl_documents.judge_pending boolean not null default false` + 부분 인덱스 `(id) WHERE judge_pending`. saveFetchedDocument 가 후보가 없을 때 true, recordAutomaticJudgement 가 후보를 만들 때 false. 대기열은 (A) `crawl_candidates WHERE state='new'`(기존 `crawl_candidates_state_id_idx`) ⨝ documents ON repo(유일 인덱스) UNION ALL (B) `crawl_documents WHERE judge_pending` 두 갈래로 나눈다. 원본 행 삭제는 replay 전용(`pipeline-replay-fixed-input-repository.ts:203-204`)뿐이라 표지 정합성 유지가 쉽다. 대안(스키마 변경 없이 저장 시 placeholder 후보 'new' 삽입)은 "후보 없음"에 기대는 경로(수집 흔적 관문 fetch.ts:262-264, saveFetchedDocument 674행, recordAutomaticJudgement 873-877행)가 많아 비추천.
- 검증: 수정 후 판정 조회 EXPLAIN 이 Index Scan 2갈래로 바뀌는지, 빈 대기열 틱이 수 ms 인지. `tests/integration/crawl-judge.test.ts`, `tests/integration/crawl-pipeline.test.ts` + 표지 백필 정합성 테스트(후보 없는 문서 수 = judge_pending 수).
- 배포 주의: 열 추가 + 백필 `UPDATE … WHERE NOT EXISTS (…)` 를 배치로. 표지를 쓰는 코드(수집·판정)는 같은 릴리스에 묶고, 읽는 쪽 전환은 백필 뒤. 수집·판정 역할 재시작.
- 확신도: CONFIRMED
- 규모: M

### CRAWL-03 봇 차단 응답(401·403·429·999)을 "접속 불가"로 자동 거부한다
- 심각도: P1
- 분류: crawl-error
- 위치: `lib/crawl/rules.ts:586-592`
  ```ts
  if (page.status === null) return hold("ambiguous", "page_status_unknown", ...);
  if (page.status < 200 || page.status >= 400) {
    return reject("unreachable", "배포 URL 응답 정상", page.status === 0 ? "접속 실패" : `HTTP ${page.status}`);
  }
  ```
  반면 같은 저장소의 다른 경로: `lib/domain/products/uptime-delist-review.ts:40-41`(401·403·429·999 와 "just a moment·verify you are human" 본문을 blocked 로), `lib/domain/products/repo-move-evidence.ts:56`, `lib/domain/llm-assist/audit-runtime.ts:44`, `lib/domain/products/intro-assist-runtime.ts:30`. 수집기 UA 는 `NoMoreVibe/1.0 (+https://nomorevibe.app)`(net/fetch.ts:32) — 브라우저가 아니라 Cloudflare 봇 방어·Vercel 보호에 걸리기 쉽다.
- 문제: 수집기(`safeFetch`)는 408·429·5xx 만 다시 시도하고(net/fetch.ts:470-476), 403·401·999 는 그대로 페이지로 저장한다. 규칙은 이를 HTTP 오류로 보아 자동 거부하고, 거부 후보는 AI 심사·재수집 대상이 아니라 영구히 묻힌다. 시나리오: Cloudflare "Bot Fight Mode" 를 켠 실제 제품 사이트가 UA 를 보고 403 을 준다 → 원본 page_status 403 → `rejected/unreachable` → 사람도 AI 도 보지 않는다. 생존 확인 쪽은 같은 응답을 "살아 있음(봇 차단)"으로 세지 않기로 소유자가 이미 정했다(메모리 uptime-streak-bug: "봇 차단 응답 401·403·429·999는 세지 않기로 사용자 결정") — 수집 판정만 그 결정과 반대다. 또 10-14(1fca060b) 이전 문서에는 일시 오류 상태(500 203·503 133·429 179)도 같은 규칙으로 거부돼 남아 있다.
- 실측 근거: `crawl-stats-replica.txt` page_status 403 2,855 · 401 414 · 429 179 · 999(상위 15 밖), 후보 `rejected | unreachable | auto` 20,599(푸시 나이 거부 포함). 규칙 테스트에 403 기대값은 없다(`tests/crawl-rules.test.ts:421,446` 은 404 만).
- 수정 방안: `judge` 에서 401·403·429·999 와 챌린지 본문(uptime-delist-review 의 정규식 재사용)을 `blocked` 로 분류해 거부 대신 보류(`needs_review`, cause `page_blocked`) 또는 "응답 확인 불가 — 저장소 근거로 AI 심사" 갈래로 보낸다(추천: 보류 + AI 1차가 README·저장소 근거로 판정. 화면 판별 렌더러 `lib/screen-review/renderer.ts` 로 한 번 그려 보는 선택지도 있음). 401(Vercel 배포 보호)은 공개 접근 불가라 거부 유지 여부를 소유자가 정한다. 일회성: `reconsider.ts` 에 정책 `blocked-status` 를 더해 page_status ∈ {401,403,429,999,500,502,503,504} 인 자동 거부 후보를 다시 수집 대기열에 올린다(관리자 확인 후 적용, 기존 plan/apply 방식).
- 검증: `tests/crawl-rules.test.ts` 에 403·429·999·챌린지 본문 → 보류 기대값 추가. 운영: 적용 후 하루 `reason='unreachable'` 신규 수와 page_status 분포, 재수집 후보의 승인률.
- 배포 주의: 규칙 판(REVIEW_RULES_VERSION/judgeRevision)에 영향 — 판이 바뀌면 기존 승인의 원본 대조가 달라지는지 확인. 일반 배포(판정은 reviewer 역할).
- 확신도: CONFIRMED
- 규모: S(규칙) + S(재수집 정책)

### CRAWL-04 발굴 입장 계산이 검색 페이지마다 crawl_documents 전체 반조인을 다시 한다
- 심각도: P2
- 분류: inefficiency
- 위치: `lib/crawl/review-backlog.ts:31-53`
  ```sql
  with downstream as materialized (
    select lower(repo) from crawl_candidates where state in ('new','approved','needs_review')
    union
    select lower(d.repo) from crawl_documents d
    where not exists (select 1 from crawl_candidates where repo = d.repo)
      and not exists (select 1 from crawl_candidates where lower(repo) = lower(d.repo))
  ), queued as (...)
  ```
  호출: `lib/crawl/jobs/seed.ts:82`(틱마다 1회) + `lib/crawl/shared-discovery.ts:124`(`enqueueDiscoveryBatch` — 검색 페이지·한국어 적용·GeekNews 글마다 1회, 전역 advisory 잠금과 frontier 신원 잠금을 쥔 채) + `lib/crawl/source-buffer.ts:73`(sourceBuffer 켜면 수집 dequeue 마다).
- 문제: "후보 없는 문서"를 세려고 문서 107만 행 전체를 후보와 반조인한다(11-13 c0e00cba 로 소문자 접기를 줄여 0.59→0.22초(시험 fixture)로 줄었지만 여전히 전체 스캔). seed 는 `pagesPerTick` 기본 10 이라 분당 최대 11회 + ko-apply 분당 1회 — 하루 약 1.5~1.7만 회 × 문서·후보 각 100만 행. 비교 대상은 `maxReviewBacklog` 기본 1,000,000(settings-schema.ts:73,704)이고 실제 대기 저장소는 수천이라 이 비싼 수는 사실상 결정을 바꾸지 않는다(속도 상한은 값싼 recentNew 로 정해진다). 또 `readReviewBacklogInTransaction` 은 3초를 넘으면 `timedOut` 을 돌려주지 않고 던지므로 `shared-discovery.ts:146` 의 `measurement_unknown` 갈래는 죽은 코드이고, 실제로는 seed·ko-apply 잡 전체가 57014 로 실패한다(11-13 운영 문서의 21회/5회 실패가 그 모양).
- 실측 근거: 느린 문장 로그엔 없음(0.5초 미만). `pg-stats-primary.txt` crawl_documents seq_tup_read 2,328억(5.6일), crawl_candidates 3,370억 — 호출 빈도×행 수로 보면 이 읽기가 큰 몫(추정 30~40%)을 차지한다. crawl_candidates idx_scan 10.7억도 반조인의 인덱스 탐침과 맞는다(추론).
- 수정 방안: (1) CRAWL-02 의 `judge_pending` 표지가 생기면 둘째 갈래를 `crawl_documents WHERE judge_pending` 로 바꿔 부분 인덱스만 읽는다(추천). (2) 그 전이라도 페이지마다 다시 재지 말고 seed 틱 시작의 스냅숏을 같은 틱 안에서 재사용하고, 삽입 수만 더해 상한을 지킨다(상한 근처 — 예: 상한의 90% 이상 — 일 때만 트랜잭션 안에서 정확히 다시 잰다). (3) `enqueueDiscoveryBatch` 에서 읽기 기한 초과를 잡아 `blockedBy:'measurement_unknown'`·added 0 으로 돌려주어 잡 실패 대신 미룸으로.
- 검증: `tests/integration/review-backlog.test.ts`(집계값 동일성), `tests/integration/crawl-seed.test.ts`. 운영: crawl-seed·crawl-ko-apply 의 57014 실패 수, pg_stat_user_tables crawl_documents seq_scan 증가율(하루 전후 비교).
- 배포 주의: (2)(3)은 일반 배포(crawler). (1)은 CRAWL-02 마이그레이션 뒤.
- 확신도: 구조 CONFIRMED, seq scan 점유율은 PLAUSIBLE(pg_stat_statements 없음)
- 규모: S~M

### CRAWL-05 일시 오류 4회(약 3시간 35분)면 frontier 가 영구 failed — 원본도 후보도 남지 않고 되살리는 길이 없다
- 심각도: P2
- 분류: crawl-error / logic
- 위치:
  - `lib/crawl/repository.ts:41-43` `BACKOFF_MINUTES = [5, 30, 180]; MAX_ATTEMPTS = 4`
  - `lib/crawl/repository.ts:437-446`
    ```ts
    const exhausted = current.attempts >= MAX_ATTEMPTS;
    ... state: exhausted ? "failed" : "pending",
    ```
  - `lib/crawl/jobs/fetch.ts:356-363` 페이지 실패 시 `markFailed` — 이미 받은 `repoMeta`(GitHub 호출 1~5회분)를 버린다
  - 되살림 없음: `lib/crawl/shared-discovery.ts:126-138`(이미 있는 저장소는 상태와 무관하게 건너뜀), `lib/crawl/repository.ts:581-590` `requeue()` 는 호출처 없음. 후보가 있는 것만 `handOffFailedSourceRefreshes`(308-379)가 사람에게 넘긴다.
- 문제: 새 발견 저장소의 배포 페이지가 503(점검·Render/Fly 콜드)·429(우리 UA 제한)·타임아웃·연결 재설정으로 3시간 35분 동안 네 번 실패하면 frontier 는 `failed` 로 끝나고, crawl_documents·crawl_candidates 어디에도 행이 없다. 판정·관리자 화면·신호별 수율(yieldBySignal 은 후보와 inner join)에 보이지 않으며, 나중에 같은 저장소가 다시 검색돼도 enqueue 가 건너뛴다. 재시도마다 getRepo·흔적 확인·패키지 확인을 다시 써 core 한도도 낭비한다. 모듈 주석(423-426행)이 말한 "일시적 장애와 영구적 실패를 다르게"가 창 4시간 미만에서만 성립한다.
- 실측 근거: `crawl-stats-replica.txt` frontier failed 1,693 — `HTTP N` 964, `fetch failed` 433, timeout 270+22, 모두 max_attempts 4. 후보가 있는 failed 는 `source_refresh_failed` 4건뿐이라 약 1,689건이 후보 없이 사라졌다. (no_homepage 를 뺀 홈페이지 보유 후보의 발행 비율로 어림하면 수백 건의 놓친 제품.)
- 수정 방안(추천): 소진 시에도 원본을 저장한다 — `saveFetchedDocument` 에 `pageStatus`(마지막 HTTP 상태 또는 0)·`pageMeta.fetchError{class, status, attempts, lastAt}` 를 넣어 판정이 사유(`unreachable`/보류)와 흔적을 남기게 하고, 일시 오류 계열(429·503+Retry-After·timeout·ECONNRESET)은 긴 꼬리 재시도(예: 12시간·3일·7일, 구조 제안 S2)를 둔다. 재시도 시에는 저장된 repoMeta 가 24시간 안이면 GitHub 를 다시 부르지 않고 페이지만 다시 받는다. 일회성: 현재 failed·후보 없음 1,689건을 낮은 우선순위로 pending 복귀(관리자 확인 후, `requeue()` 재사용).
- 검증: `tests/integration/crawl-fetch.test.ts:570` "본문 수신 실패도 최대 시도 횟수를 넘기면 failed로 내린다" 를 "원본·실패 흔적을 남기고 판정 대기"로 바꾸는 회귀. 운영: `crawl_frontier WHERE state='failed' AND NOT EXISTS(candidate)` 수가 늘지 않음.
- 배포 주의: 일반 배포(crawler). 일회성 복귀는 수집 대기열 압력(maxNewPerHour)과 따로 — 우선순위를 새 수집보다 낮게.
- 확신도: CONFIRMED
- 규모: M

### CRAWL-06 우리 쪽 네트워크·DNS 장애를 구분하지 못해 대기열 전체가 시도 횟수를 태운다
- 심각도: P2
- 분류: crawl-error
- 위치: `lib/crawl/jobs/fetch.ts:153-194`(lane 루프 — `rate_limited`·`auth_unavailable` 만 묶음을 멈춤), `241-245`(GitHub `transport` 도 `markFailed`), `356-363`(페이지 transport 실패 `markFailed`)
  ```ts
  if (!result.ok && (result.error.kind === "rate_limited" || result.error.kind === "auth_unavailable")) batch.stopped = true;
  ...
  const reason = result.error.kind === "http" ? `GitHub ${result.error.status}` : `GitHub ${result.error.kind}`;
  await crawl.markFailed(entry, reason);
  ```
- 문제: 수집 호스트의 아웃바운드가 막히면(실제 사례: 2026-09-24 M3 가동 49.7일 TIME_WAIT 포트 고갈 — 메모리 mac-uptime-tcp-bug; Docker DNS 장애·업링크 단절) 모든 GitHub 호출이 `transport`, 모든 페이지가 `fetch failed`/timeout 이 된다. 잡은 멈추지 않고 24건씩 계속 꺼내 각 항목의 attempts 를 올리고, 장애가 3~4시간 이어지면 그사이 꺼낸 모든 항목이 CRAWL-05 의 영구 failed 로 간다. 한도 대기(rate_limited)는 시도를 돌려주는데(repository.ts:405-421) 우리 쪽 장애는 그렇지 않다.
- 실측 근거: 코드 근거 + failed 의 `fetch failed` 433·timeout 292. 시각 군집 여부는 확인 못 함 — `SELECT date_trunc('hour', updated_at), count(*) FROM crawl_frontier WHERE state='failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 20` 로 확인 필요.
- 수정 방안: 묶음 안 차단기 — 한 묶음에서 GitHub `transport` 가 나오거나, 서로 다른 origin 3곳 이상이 연속으로 transport/timeout 이면 "우리 쪽 장애"로 보고 남은 항목과 그 항목들을 `deferFrontier`(시도 반환)로 돌리고 `deferredJob("network_unavailable")` 로 끝낸다. 판별 보조로 고정 대상(예: `https://api.github.com/zen` 또는 자체 헬스 URL) 한 번 확인.
- 검증: fetch 단위 테스트 — 모든 요청이 transport 실패일 때 attempts 가 늘지 않고 잡이 미룸으로 끝나는지(`tests/crawl-fetch-concurrency.test.ts` 계열에 추가).
- 배포 주의: 일반 배포.
- 확신도: 메커니즘 CONFIRMED, 실제 피해 규모 PLAUSIBLE
- 규모: S

### CRAWL-07 실패 원인(cause)을 버려 "fetch failed" 433건을 분류할 수 없고, TLS·연결 거부도 일시 오류로 4번 다시 친다
- 심각도: P2
- 분류: crawl-error
- 위치: `lib/crawl/jobs/fetch.ts:387-389`
  ```ts
  function describeError(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  ```
  `lib/net/fetch.ts:54-61`(영구 실패 판정은 ENOTFOUND·URL 오류·사설 IP 만), `463-466`(PageFetchError 메시지에 name·message 만 담음)
- 문제: undici 는 연결 문제를 모두 `TypeError: fetch failed` 로 감싸고 진짜 원인은 `error.cause.code`(ECONNREFUSED·ECONNRESET·UND_ERR_CONNECT_TIMEOUT·CERT_HAS_EXPIRED·ERR_TLS_CERT_ALTNAME_INVALID·UNABLE_TO_VERIFY_LEAF_SIGNATURE…)에 있다. 이를 버리니 운영에서 433건이 무엇인지 알 수 없고, 만료·자가서명 인증서처럼 사실상 영구인 실패도 3시간 35분 동안 4번 GitHub+페이지를 다시 부른 뒤 사라진다. 반대로 진짜 일시적인 ECONNRESET 과 구분해 다르게 다룰 근거도 없다.
- 실측 근거: `crawl-stats-replica.txt` `PageFetchError: TypeError: fetch failed` 433(max_attempts 4).
- 수정 방안: `describeError`·PageFetchError 에 `cause.code`(화이트리스트 문자열)와 TLS 오류 코드를 붙이고, `permanentTransportFailure` 에 인증서 오류 계열을 "영구(접속 불가로 저장, 상태 0 + fetchError.class='tls')"로 추가한다. ECONNREFUSED 는 1~2회 뒤 영구로.
- 검증: 단위 — 가짜 undici 오류(cause.code 별)로 분류 결과 확인. 운영: failed last_error 모양이 cause 별로 나뉘는지.
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED
- 규모: S

### CRAWL-08 README 재수집 대상 고르기가 5분마다 crawl_documents 전체를 jsonb 조건으로 훑는다
- 심각도: P2
- 분류: latency
- 위치: `lib/crawl/repository.ts:517-526`
  ```ts
  return db.select().from(crawlDocuments).where(sql`
    ${crawlDocuments.pageMeta}->'readmeSampleVersion' = 'null'::jsonb
    and jsonb_typeof(${crawlDocuments.pageMeta}->'readmeSample') = 'string'
    and (case when jsonb_typeof(...->'readmeRetryAfter') = 'number' then (...)::numeric else 0 end) <= extract(epoch from now()) * 1000
    and exists(select 1 from crawl_candidates c join products p on p.slug = c.published_slug ...)
  `).orderBy(asc(crawlDocuments.id)).limit(limit);
  ```
  호출: `lib/jobs/products/readme-refresh.ts:10`(2건씩), 주기 5분(`lib/jobs/catalog.ts:240`).
- 문제: 2건을 고르려고 매 틱 문서 107만 행의 page_meta(TOAST)를 풀어 jsonb 조건을 평가한다. 하루 288틱 중 272틱이 0.5초를 넘었고 평균 2.7초 — 거의 매번 전체 스캔이며 3.5GB 표를 캐시로 끌어올려 다른 쿼리의 버퍼를 밀어낸다.
- 실측 근거: `slow-queries-primary.txt` 17행 — 272회·737초·평균 2,711ms·최대 3,087ms, 문장 모양이 이 함수와 일치.
- 수정 방안(추천): 술어와 똑같은 부분 인덱스 `CREATE INDEX CONCURRENTLY crawl_documents_readme_refresh_idx ON crawl_documents (id) WHERE page_meta->'readmeSampleVersion' = 'null'::jsonb AND jsonb_typeof(page_meta->'readmeSample') = 'string'` — 대상(다시 수집돼 README 판이 null 이 된 문서)만 담는다. 대안: 발행분에서 출발(`crawl_candidates_published_slug_idx` → documents)하도록 쿼리를 뒤집기 — 11.5만 행이라 여전히 크다.
- 검증: EXPLAIN 이 부분 인덱스 Index Scan 으로 바뀌는지, 느린 문장 로그에서 이 모양이 사라지는지. `tests/integration/installable-review-readme.test.ts`·README 갱신 관련 통합 테스트.
- 배포 주의: 인덱스만 — CONCURRENTLY 로 무중단(마이그레이션 도구가 트랜잭션 CREATE INDEX 를 쓰면 쓰기 잠금 시간 측정 후 창에서).
- 확신도: CONFIRMED
- 규모: S

### CRAWL-09 다시 발견된 저장소를 다시 보지 않는다 — no_homepage 거부 78.8만 건이 영구 제외
- 심각도: P2
- 분류: logic (수집 재현율)
- 위치: `lib/crawl/shared-discovery.ts:126-138`
  ```ts
  const rows = await tx.select(...).from(crawlFrontier).where(known(crawlFrontier.repo))
    .union(...crawlDocuments...).union(...crawlCandidates...);
  const existing = new Set(rows.map(r => r.repo.toLowerCase()));
  for (const entry of entries) { const key = entry.repo.toLowerCase(); if (!existing.has(key)) { ... accepted.push(entry) } processed++; }
  ```
  `lib/crawl/repository.ts:60-65`(enqueue 주석 "이미 있으면 아무것도 하지 않는다"). 홈페이지 없음 거부: `lib/crawl/rules.ts:400`.
- 문제: 커밋 검색으로 발견된 저장소의 74%가 그 시점에 homepage 가 없어 자동 거부된다. 바이브 코딩 프로젝트는 코드를 먼저 올리고 나중에 배포·homepage 를 다는 일이 흔한데, 이후 새 AI 커밋으로 같은 저장소가 다시 검색돼도 frontier 행이 있으니 건너뛴다. 자동 재검토는 패키지 정책(`reconsider.ts`, 사람이 plan/apply)뿐이다. 시나리오: 10월에 첫 커밋(홈페이지 없음) → no_homepage 거부 → 11월에 Vercel 배포·homepage 설정 후 계속 Claude 트레일러 커밋 → 검색에 매일 나오지만 영영 수집되지 않음.
- 실측 근거: `crawl-stats-replica.txt` `rejected | no_homepage | auto` 787,579(후보의 74%).
- 수정 방안: 재발견 시 재검토 — `enqueueDiscoveryBatch` 에서 기존 행 중 "후보가 auto 거부(no_homepage·unreachable)이고 frontier `done` 이 N일(예: 14일) 이상 지난 것"을 낮은 우선순위로 `pending` 복귀(시도 0). GitHub 비용을 아끼려면 복귀 전에 GraphQL 한 번으로 100개 저장소의 `homepageUrl` 을 묶어 확인(구조 제안 S3)해 생긴 것만 복귀. 재검토 간격·대상 사유는 소유자 결정.
- 검증: 통합 — no_homepage 거부 저장소를 14일 뒤 다시 enqueue 하면 pending 으로 돌아오고, 14일 안이면 그대로인지(`tests/integration/crawl-seed.test.ts`).
- 배포 주의: 일반 배포. 켜는 순간 재검토 물량이 몰리지 않게 시간당 상한을 둔다.
- 확신도: 메커니즘 CONFIRMED, 놓친 제품 수는 PLAUSIBLE(나중에 homepage 를 단 비율 미측정)
- 규모: S~M

### CRAWL-10 근거 갱신 대상 고르기가 매번 제품×근거 출처 전체 조인 — due 인덱스는 한 번도 쓰이지 않음
- 심각도: P2
- 분류: inefficiency
- 위치:
  - `lib/domain/evidence/refresh.ts:282-340` `dueEvidenceProductSlugs` — 4개 조회, 첫째는
    ```ts
    .from(productLinks).innerJoin(products, ...).leftJoin(productEvidenceSources, ...)
    .where(and(eq(productLinks.visible, true), inArray(products.status, [...]), cursor ? gt(productLinks.slug, cursor) : undefined,
      or(isNull(productEvidenceSources.id), lte(productEvidenceSources.nextAttemptAt, input.now))))
    .groupBy(productLinks.slug).orderBy(asc(productLinks.slug)).limit(limit);
    ```
  - `lib/domain/evidence/source-claims.ts:58-86` `selectTarget` — products ⟕ evidence_sources ⟕ refresh_requests ⟕ claims 전체에 OR 조건, `126-130` 에서 레인 3개를 차례로 시도(빈 대기열이면 3번 다 전체 조인), `evidenceSourceControl FOR UPDATE` 를 쥔 채
  - 호출: `lib/jobs/products/evidence-refresh.ts:59-79, 156-172`(product-evidence-refresh, 1분 주기 + continuation)
- 문제: `next_attempt_at <= now` 가 LEFT JOIN 의 `IS NULL OR …` 안이나 `state` 없이 쓰여 `product_evidence_sources_due_idx (state, next_attempt_at, slug)` 를 못 탄다. 할 일이 없을 때도 매 틱 제품(11.5만)·링크·근거 출처(22.7만)를 끝까지 읽는다.
- 실측 근거: `pg-stats-primary.txt` product_evidence_sources seq_scan 245,480·524억 행(행당 거의 전체), product_links 122,622·133억 행, `product_evidence_sources_due_idx` 24MB·idx_scan 0. (products 의 seq scan 98만 회에도 일부 기여 — 추정)
- 수정 방안: due 갈래와 "근거 행 없음" 갈래를 나눈다 — (A) `product_evidence_sources WHERE next_attempt_at <= now ORDER BY next_attempt_at` (인덱스를 `(next_attempt_at, slug)` 로 다시 만들거나 state 조건을 붙여 기존 인덱스 사용) ⨝ products/links, (B) 링크는 있는데 근거 행이 없는 것은 NOT EXISTS + `product_evidence_sources_slug_kind_key_idx` 탐침(작은 집합). `selectTarget` 은 한 번 조회로 레인을 CASE 로 함께 고르고(지금은 레인마다 같은 조인 3번) 후보를 `next_attempt_at` 인덱스에서 출발시킨다.
- 검증: EXPLAIN 에서 due 인덱스 사용, `idx_scan` 증가·seq_scan 감소. `tests/integration/evidence-refresh.test.ts`, `tests/integration/evidence-source-claims.test.ts`.
- 배포 주의: 인덱스 재생성은 CONCURRENTLY. 쿼리 변경은 일반 배포(crawler).
- 확신도: 인덱스 미사용 CONFIRMED(통계 0회 + 술어 형태), seq scan 점유율 PLAUSIBLE
- 규모: M

### CRAWL-11 한국어 언어 판정의 'unknown' 이 상한 없이 15분마다 되돌아온다 — 128KB 넘는 README 는 영영 unknown
- 심각도: P2
- 분류: logic
- 위치: `lib/crawl/korean-discovery/language.ts:33-41`
  ```ts
  try { result = await request(`https://raw.githubusercontent.com/${repo}/HEAD/${path}`, { maxBytes: 128 * 1024, timeoutMs: ... }); }
  catch { unknown = true; continue; }
  if (result.ok && result.status === 200) {
    if (result.truncated) unknown = true;   // allowTruncatedBody 를 안 줘서 truncated 는 절대 오지 않음
    ...
  } else if (!result.ok && result.reason === 'http' && result.status === 404) { /* 없음 */ }
  else { unknown = true; }                  // too_large 도 여기
  ```
  `lib/crawl/korean-discovery/repository.ts:115-127` — `koreanLanguageBatch` 는 `language='unknown' AND due_at<=now() ORDER BY due_at` 5건, `saveKoreanLanguage` 는 unknown 이면 다시 unknown + `due_at=now()+15분`(시도 수·상한 없음).
- 문제: `fetchCapped` 를 `allowTruncatedBody` 없이 불러 128KB 넘는 README 는 `too_large` → unknown. 다시 봐도 같은 결과라 15분마다 영원히 돌아온다. 일시적이지 않은 실패(raw 의 403·451, 매번 3초 넘는 응답)도 같다. Oracle 소비자는 틱(최대 45초 + 15초 쉼)마다 5건만 보므로, 영구 unknown 이 약 150건을 넘으면 그것들만으로 처리량을 다 쓰고 새 후보(`due_at` = 삽입 시각)가 계속 뒤로 밀린다.
- 실측 근거: 코드 근거만. 확인: `SELECT count(*), evidence->>'reason' FROM github_ko_discovery_staging WHERE state='pending' AND language='unknown' GROUP BY 2`, 그리고 같은 repo 의 checked_at 반복 횟수.
- 수정 방안: (1) `allowTruncatedBody: true` 로 앞 128KB 만 읽어 판정(산문 판정에는 충분), (2) unknown 시도 수를 evidence 에 세어 3~5회 뒤 `no`(사유 `document_unavailable_exhausted`)로 닫거나 지수 백오프(15분→1시간→6시간→1일).
- 검증: 단위 — 200KB 한국어 README 가 yes 로, 계속 403 인 저장소가 N회 뒤 닫히는지.
- 배포 주의: Oracle 소비자 이미지 갱신(github-ko-discovery-consumer).
- 확신도: 무한 재시도 CONFIRMED, 굶김 PLAUSIBLE
- 규모: S

### CRAWL-12 메타 리프레시 목적지의 일시 오류가 이미 받은 껍데기 페이지까지 버린다
- 심각도: P3
- 분류: logic
- 위치: `lib/crawl/jobs/fetch.ts:442-451`
  ```ts
  let page = await oneAtATime(url, () => fetchPage(url, "background", { retryTransientErrors: true }));
  const hop = metaRefreshTarget(page.html, page.finalUrl);
  if (hop) {
    const next = await oneAtATime(hop, () => fetchPage(hop, "background", { retryTransientErrors: true }));
    // 목적지가 열리지 않으면 껍데기 쪽을 그대로 쓴다
    if (next) page = next;
  }
  ```
- 문제: 주석의 의도("목적지가 안 열리면 껍데기")는 `null`(영구 실패)에만 맞는다. 목적지가 5xx·429·timeout 이면 `retryTransientErrors` 로 PageFetchError 가 던져져 항목 전체가 실패하고(356-363행), 반복되면 CRAWL-05 의 영구 failed 로 간다. 껍데기(200)는 멀쩡한데도.
- 실측 근거: 코드 근거만(메타 리프레시 껍데기는 표본 509건 중 24건, fetch.ts:434-436 주석).
- 수정 방안: hop 호출을 try/catch 로 감싸 PageFetchError 면 껍데기 page 를 쓰고 `pageMeta.metaRefreshError` 를 남긴다.
- 검증: 단위 — 목적지 503 일 때 껍데기로 저장되는지.
- 배포 주의: 일반 배포. 확신도: CONFIRMED. 규모: S

### CRAWL-13 Location 없는 3xx 응답을 "응답 정상"으로 통과시킨다
- 심각도: P3
- 분류: crawl-error
- 위치: `lib/net/fetch.ts:486-503`(3xx 인데 location 이 없으면 그 응답을 최종 페이지로 반환), `lib/crawl/rules.ts:590`(`status < 200 || status >= 400` 만 거부)
- 문제: Location 없는 301/302/307 은 깨진 응답인데 상태 307 로 저장되고 규칙은 200~399 를 정상으로 보아 다음 규칙으로 넘긴다(본문은 대개 비어 있음). AI 심사·발행까지 갈 수 있다.
- 실측 근거: `crawl-stats-replica.txt` page_status 307 198건(현재 코드에서 307 이 저장되는 경로는 Location 없는 경우뿐; 옛 코드분일 수 있음).
- 수정 방안: 규칙의 정상 범위를 2xx 로 좁히거나(추천), safeFetch 가 Location 없는 3xx 를 `{status}` 실패로 돌려준다.
- 검증: `tests/crawl-rules.test.ts` 에 307·Location 없음 → unreachable. 배포 주의: 규칙 판 영향 확인. 확신도: CONFIRMED(경로), 실제 307 건의 출처는 PLAUSIBLE. 규모: S

### CRAWL-14 수집기 UA 의 연락 주소가 운영 도메인(nomorevibe.com)이 아닌 nomorevibe.app
- 심각도: P3
- 분류: non-standard
- 위치: `lib/net/fetch.ts:31-34`, `lib/crawl/github.ts:197` — `"user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)"`. 다른 UA 는 .com: `lib/social/bluesky-talk.ts:44`, `lib/screen-review/renderer.ts:56`.
- 문제: 사이트 운영자·WAF 가 봇을 확인하려 해도 연락처가 운영 사이트가 아니다. CRAWL-03 의 403 일부를 줄일 여지를 스스로 막는다(봇 설명 페이지·연락처는 허용 목록 등록의 전제).
- 수정 방안: `https://nomorevibe.com/bot`(수집 목적·빈도·차단 방법 설명) 페이지를 두고 UA 를 그 주소로. GitHub API UA 도 같은 상수로 통일.
- 검증: 단위 — 공통 상수 사용. 배포 주의: 일반 배포. 확신도: CONFIRMED. 규모: S

### CRAWL-15 페이지 본문을 charset 무시하고 UTF-8 로만 해독한다
- 심각도: P3
- 분류: crawl-error
- 위치: `lib/net/fetch.ts:545-549` — `html: body.toString("utf-8")`. 저장소 전체에 charset/TextDecoder 처리 없음(rg 확인).
- 문제: `Content-Type: text/html; charset=euc-kr`·`<meta charset="shift_jis">` 페이지는 제목·설명·본문 표본이 깨져 규칙(본문 낱말)·소개 생성에 그대로 들어간다. 한국어 발굴을 Oracle 로 키우는 중이라 오래된 한국 사이트에서 드러날 수 있다(현재 빈도는 낮을 것).
- 수정 방안: 응답 헤더 charset → 본문 앞 2KB 의 meta charset 순으로 판별해 `TextDecoder(label, {fatal:false})` 로 해독(Node 내장 ICU 가 euc-kr·shift_jis 지원).
- 검증: 단위 — EUC-KR 픽스처의 title 추출. 배포 주의: 일반 배포. 확신도: CONFIRMED(처리 없음), 영향 PLAUSIBLE. 규모: S

### CRAWL-16 보조 발굴원의 관문·재시도 상한이 제각각 — Show HN 은 입장 관문 우회, GeekNews 실패 글은 무한 재시도
- 심각도: P3
- 분류: logic
- 위치: `lib/crawl/jobs/hn-show.ts:161-166`(`crawl.enqueue` 직접 — `shared-discovery.ts:106-109` 주석 "Both producers commit through the same admission lock" 과 달리 maxNewPerHour·maxReviewBacklog 를 지나지 않음), `lib/crawl/jobs/gn-show.ts:132-143`(실패 글을 pending 끝으로 옮겨 매 틱 다시 — 시도 수·상한 없음, 커서 jsonb 에 계속 남음)
- 문제: Show HN 은 하루 약 11건이라 실제 피해는 작지만 입장 상한을 낮춰도 이 경로는 막히지 않는다. GeekNews 는 지워진 글(404)이 영원히 요청·`degraded: topic_failed` 를 만들고 커서가 자란다.
- 수정 방안: Show HN 도 `enqueueDiscoveryBatch` 사용. GN 실패 항목에 `attempts` 를 두고 N회(예: 5) 뒤 버리며 로그로 남김.
- 검증: `tests/crawl-hn-show.test.ts`·`tests/crawl-gn-show.test.ts` 에 상한 테스트. 배포 주의: 일반 배포. 확신도: CONFIRMED. 규모: S

### CRAWL-17 crawl-fetch 가 잡 취소 신호를 페이지·GitHub 요청에 넘기지 않는다
- 심각도: P3
- 분류: async
- 위치: `lib/crawl/jobs/fetch.ts:163`(`getRepo(entry.repo)` — signal·deadline 없음), `443`·`448`(`fetchPage(url, "background", { retryTransientErrors: true })` — signal 없음), 흔적·패키지 확인(265, 310)도 같음. `ctx.signal` 은 permit 판단(349행)에만 쓰인다.
- 문제: 워커 정지(SIGTERM, drain 45초)·예산 종료 뒤에도 진행 중 요청이 페이지 10초·GitHub 토큰당 10초까지 계속된다. 12칸이 모두 늦으면 drain 이 길어지고, 정지 직전 받은 결과는 리스 상실로 저장되지 못해 GitHub 호출이 낭비된다. `githubRequest` 는 이미 `{deadlineAt, signal}` 을 받는다(github.ts:62-91).
- 수정 방안: `getRepo`·`probeAiEvidence`·`probePackageManifests` 에 `{ signal: ctx.signal, deadlineAt: ctx.deadlineAt }` 를, `fetchPage` 에 `signal: ctx.signal` 을 전달.
- 검증: `tests/github-cancellation.test.ts` 와 같은 방식으로 fetch 잡 취소 시 요청이 즉시 끊기는지. 배포 주의: 일반 배포. 확신도: CONFIRMED. 규모: S

### CRAWL-18 discovery-admission.ts 의 무거운 읽기 함수가 운영에서 쓰이지 않는 죽은 코드
- 심각도: P3
- 분류: structure
- 위치: `lib/crawl/discovery-admission.ts:73-270` (`readAdmissionRows`·`readDiscoveryAdmission`·`readDiscoveryAdmissionInTransaction`·`discoveryAdmission`) — 운영 코드의 import 는 상수(`FirstReviewStatus.tsx:3`)와 타입(`seed.ts:4`)뿐, 함수 호출은 테스트만(`tests/integration/discovery-admission.test.ts` 등).
- 문제: 판정·1차·발행 대기열을 각각 전체 조인으로 세는 SQL(120~190행)이 남아 있어 술어를 바꿀 때마다 같이 고쳐야 하고(예: `judgementQueuePredicate`, `reviewApprovalPredicate`), 읽는 사람이 실제 입장 경로(review-backlog.ts)와 혼동한다.
- 수정 방안: 상수·타입만 `discovery-contract` 류로 옮기고 함수와 테스트를 지운다.
- 검증: tsc·관련 테스트. 배포 주의: 일반 배포. 확신도: CONFIRMED. 규모: S

## 구조 변경 제안 (리팩토링으로 효율화)

### S1. 판정 대기 표지 하나로 판정·입장·관측 집계를 통일
- 지금: "후보 없는 문서"를 판정(judgementQueue)·발굴 입장(review-backlog)·관리자 처리량(throughput)·죽은 입장(discovery-admission)이 각자 전체 조인/반조인으로 계산.
- 바꿀 구조: `crawl_documents.judge_pending` + 부분 인덱스. 쓰는 곳은 saveFetchedDocument(참)·recordAutomaticJudgement(거짓) 두 곳뿐. 모든 읽기는 `WHERE judge_pending` + `crawl_candidates WHERE state='new'`(기존 인덱스).
- 얻는 것: 느린 문장 5위 하루 8,871초 → 수 초. seed 한 틱당 최대 11회의 100만 행 반조인 제거 — crawl_documents·crawl_candidates seq_tup_read 의 상당 부분(추정 하루 수백억 행) 제거, 3.5GB 표 캐시 오염 감소.
- 옮기는 순서: ① 열·부분 인덱스 추가(CONCURRENTLY) ② 쓰기 코드 배포(표지 유지 시작) ③ 배치 백필 + 정합성 검사(후보 없는 문서 수 = 표지 수) ④ 읽기 코드 전환(judge·review-backlog·throughput) ⑤ discovery-admission 읽기 함수 삭제.
- 위험: 표지와 실제가 어긋나면 판정 누락 — 하루 한 번 정합성 검사(차이를 표지로 고침)를 유지 잡에 둔다.

### S2. 수집 결과 분류표와 긴 꼬리 재시도 (frontier `failed` 블랙홀 제거)
- 지금: 결과가 `done/skipped/failed` 셋이고, 페이지 단계 실패는 원본을 버리며, 재시도는 5·30·180분 고정 4회. 봇 차단(403)은 성공으로 저장돼 규칙이 거부.
- 바꿀 구조: 페이지 결과를 `ok / blocked(401·403·429·999·챌린지) / transient(5xx·408·timeout·ECONNRESET·EAI_AGAIN) / permanent(NXDOMAIN·TLS·ECONNREFUSED 반복·404·410) / ours_down(묶음 차단기)` 로 분류하는 순수 함수 하나(`classifyPageOutcome`)를 net/fetch 에 두고, 수집은 결과와 무관하게 repoMeta + `pageMeta.fetchOutcome` 을 저장, 판정은 분류별 규칙(blocked → 보류, permanent → unreachable, transient → 긴 꼬리 재시도 표지)으로. transient 재시도는 저장된 repoMeta 를 재사용해 페이지만 다시.
- 얻는 것: CRAWL-03·05·06·07·12·13 을 한 구조로 해결. 놓친 1,689건·봇 차단 3,400여 건이 판정·관리자 화면에 보이고, 재시도의 GitHub core 낭비(항목당 1~5회 × 최대 4번) 제거.
- 옮기는 순서: ① 분류 함수 + 단위 테스트 ② 수집이 fetchOutcome 저장(규칙은 아직 그대로) ③ 규칙 분기 + 판 올림 ④ 긴 꼬리 재시도 ⑤ 과거 failed·blocked 일회성 재수집.
- 위험: 규칙 판이 바뀌어 기존 승인의 원본 대조가 흔들릴 수 있다 — 판 변경 영향(재심사 물량)을 미리 센다.

### S3. GitHub core 비용 줄이기 — 커밋 발견의 GraphQL 묶음 선확인 · 조건부 요청 · 요청당 DB 왕복 축소
- 지금: 커밋 검색 결과에는 homepage 가 없어(`discovery-contract.ts:34` 투영이 full_name·description 만 보관) 모든 저장소를 frontier 에 넣고 REST `GET /repos/:r` 로 하나씩 연다 — 그중 74%(787,579)가 no_homepage 로 거부. 재수집의 getRepo 는 ETag 를 쓰지 않는다(`github.ts:362-370`; 근거 provider 는 이미 씀). GitHub 요청마다 토큰 목록 조회(`github-accounts.ts:collectorTokens` — 계정·앱 SELECT)와 쿨다운 SELECT 2회(`github.ts:187-192`)가 직렬 GitHub 줄(fetch.ts:156) 안에서 돈다.
- 바꿀 구조: (a) seed 가 커밋 검색 한 페이지(최대 100 저장소)마다 GraphQL 한 번(`repository(owner,name){homepageUrl isFork isArchived stargazerCount databaseId}` 별칭 묶음 — `githubGraphql` 이미 있음)으로 homepage 를 확인해, 없는 것은 frontier 대신 발굴 집계(discovery progress 의 filtered)로만 남긴다(CRAWL-09 의 재발견 재검토와 결합하면 나중에 생긴 homepage 도 잡음). (b) crawl_documents 에 `repo_etag` 를 저장해 재수집 getRepo 를 `If-None-Match` 로(304 는 1차 한도에 안 셈). (c) 토큰 목록·쿨다운을 프로세스 안에 1~5초 캐시(쿨다운 기록은 지금처럼 DB 로).
- 얻는 것: 발견당 REST core 1회 → GraphQL 1/100 점 수준. 메모리상 "core 버킷 셋 다 한 시간 안에 바닥"(11-01) 상황에서 crawl-fetch 의 core 사용 약 70% 감소 추정 — 근거 스캔·별 갱신 등 다른 잡에 한도가 돌아감. 직렬 GitHub 줄의 요청당 DB 왕복 3~4회 → 0~1회.
- 옮기는 순서: (c) → (b) → (a)(신호별 수율 화면이 frontier 의 no_homepage 수에 기대므로, 집계 위치를 먼저 옮긴 뒤).
- 위험: GraphQL 은 비공개·삭제 저장소를 errors 로 돌려줌 — 그 경우는 지금처럼 REST 경로로 넘긴다. 신호별 no_homepage 통계의 연속성.

### S4. 발행 가능 표지(사건 기반 발행 대기열)
- 지금: 발행·관측·(죽은) 입장이 `reviewApprovalPredicate` 를 매번 승인 후보 전부에 평가(CRAWL-01).
- 바꿀 구조: 1차 승인·2차 합의·분류 완료·원본 변경 사건에서 `crawl_candidates.publish_ready_at`(또는 작은 큐 표)을 갱신하고, 발행 잡은 그 표지가 있는 후보만 잠근 뒤 기존 `assertReviewApproval` 로 정확히 재검증. 술어 자체는 해시 열로 가볍게(CRAWL-01 수정 1).
- 얻는 것: 하루 34,309초(느린 문장의 28%) → 대부분 제거, 발행 틱 14초 대기 해소. 사람 위임 고르기(느린 12행)도 해시 열 혜택.
- 옮기는 순서: 해시 열·백필 → 술어 교체(효과 측정) → 표지 도입 → 매 틱 전체 평가 제거.
- 위험: 표지 갱신 누락 시 발행 지연 — 시간당 한 번 전체 술어로 표지를 보정하는 쓸기 잡을 남긴다.

## 확인했지만 문제 아님

- GitHub 2차 한도 쿨다운 키가 토큰·호스트 공통(`github:quota:secondary:global`) — 의도적 보수 설계, 주석 근거 `lib/crawl/github-quota.ts:17-18`. 실측 피해 근거 없음.
- crawl-fetch 의 GitHub 직렬 줄 — 2차 한도 안내를 따른 의도, `lib/crawl/jobs/fetch.ts:50-55` 주석.
- 1차 한도·인증 대기 때 시도 횟수를 돌려줌(`fetch.ts:164-176`, `repository.ts:405-421`), 다음 꺼냄은 retryAt 뒤 — 헛돎은 1분 주기 1묶음으로 작음(`catalog.ts:64`).
- 저장소 이름 변경: 301 → `/repositories/:id` 같은 origin 만 따라감(`github.ts:227-230`), GitHub id 로 별칭 처리(`repository.ts:679-690`). 빈 저장소 409 처리(`ai-evidence-gate.ts:34`, `fetch.ts:316-317`).
- 검색 1,000건 상한·incomplete_results: 창을 반으로 나눠 다시(`seed.ts:534-546`, `454-459`), 미완 창은 1시간 뒤 재시도 목록(최대 128) — 누락 없이 처리.
- SSRF: 요청 전 DNS 검사 + 연결 시점 DNS 재검사(`lib/net/http-transport.ts:11-27`) + 리다이렉트 hop 마다 재검사(`lib/net/fetch.ts:444-505`). DNS `EAI_AGAIN`/`ETIMEOUT` 은 일시로 분류(`lib/net/ssrf.ts:79-85`).
- 본문 크기: HTML 2MB 에서 잘라 읽기(`net/fetch.ts:509-525`), GitHub 응답은 상한 엄격(`readBodyStrictlyCapped`), 백그라운드 요청은 모든 hop+본문에 10초 하나(`net/fetch.ts:442`).
- 429·503 의 Retry-After 를 다음 시도 시각에 반영(`net/fetch.ts:470-476` → `repository.ts:445`).
- frontier dequeue 는 `crawl_frontier_dequeue_idx` + `FOR UPDATE SKIP LOCKED`(`repository.ts:155-168`), 최근 발견 수는 부분 인덱스(0185)와 술어 일치.
- 한국어 발굴이 저장소 이름을 소문자로 넣는 것 — 입장·중복 확인이 lower() 와 GitHub id 별칭으로 맞춰짐.
- `lib/github/client.ts` — 2차 한도 메시지·Retry-After·x-ratelimit-reset 처리, 전체 기한 타이머 있음.
- 근거 provider 의 GitHub 페이지네이션(Link rel=next·last)·ETag 사용(`lib/domain/evidence/providers/github.ts:236-255, 696-707`).

## 범위 밖·못 본 것

- 느린 문장 12행(`select repo from crawl_candidates where id in (…)`, 1,293회·평균 1,989ms)은 사람 위임 고르기 `lib/crawl/human-review-repository.ts:69-90` — AI 심사 구역. CRAWL-01 과 같은 `currentReviewSource` 비용이 원인일 가능성.
- crawl_frontier seq scan(601,976회·1,278억 행)의 출처를 확정하지 못했다. 수집 구역의 frontier 조회는 모두 인덱스를 탈 수 있는 모양이다. 유력 후보는 AI 심사 쪽의 상관 반조인 `NOT EXISTS (SELECT 1 FROM crawl_frontier WHERE lower(repo)=lower(c.repo) …)` — `agent-review-repository.ts:547-550`(crawl-agent-review 매 틱 `requeueStaleReviewSources`), `held-qwen-retry.ts:180`, `human-review-repository.ts:379` — 후보 수천 건에 해시 반조인이 고르면 frontier 전체 스캔. 해당 점검자가 EXPLAIN 으로 확인 권장. 운영에 `pg_stat_statements` 를 켜면 seq scan 귀속을 실측으로 바꿀 수 있다.
- `lib/operations/throughput.ts:67-85`(관리자 상태 화면)는 crawl_documents(fetched_at 인덱스 없음)·crawl_frontier(WHERE 없는 FILTER 집계)·판정 대기 전체 조인을 화면 열 때마다 한다 — 관리자/운영 구역.
- `lib/http/crawl-burst.ts` 는 공개 요청마다 주 DB rate_limits 쓰기 — 웹·동시성 구역.
- `lib/domain/evidence/agents/*`(제작 근거 스캔 소비자)와 `providers/github.ts` 전체 흐름은 표본만 읽었다.
- 운영 설정값(`discover.maxReviewBacklog`·`pagesPerTick`·`sourceBuffer.enabled`)을 보지 못해 CRAWL-04 의 호출 빈도는 기본값 기준 추정이다.
