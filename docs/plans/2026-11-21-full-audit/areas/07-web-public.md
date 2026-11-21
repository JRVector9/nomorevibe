# 07. 공개 웹·공개 API — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


기준: `저장소 루트` (origin/main `34b5fe32`). 읽기 전용, 코드·근거 파일만 봄.
2차 검증(2026-11-21): 모든 `경로:줄` 인용을 실제 파일에서 다시 확인해 고쳤고, P1 이상은 진입점부터 다시 읽어 반증을 시도했다. 맨 끝 「검증 기록 (2차)」 참조.

## 요약 (심각도별 건수, 가장 중요한 5개 한 줄씩)

- P0 0 · P1 1 · P2 7 · P3 7 (총 15) — 2차 검증에서 WEB-01 을 P1→P2 로 낮춤
- WEB-02 (P1) 공개 화면·공개 API 요청이 처리 전에 주 DB 에 rate-limit UPSERT(와 설정 SELECT)를 직렬로 1~6번 보낸다(기한 없음). 상세 한 번 보기에 주 DB 문장이 10~23개다. 공개 읽기 경로가 가장 붐비는 주 DB 에 묶여 있다.
- WEB-01 (P2) 상세 화면이 엣지에 없을 때 렌더마다 익명 GET 이 주 DB 에서 `products` 행 `FOR UPDATE` 트랜잭션을 연다(GitHub 바인딩 확인). 잠금을 못 얻으면 잘못된 화면이 엣지에 4~5분 남는다.
- WEB-03 (P2) 홈 집계(home pulse)를 웹 프로세스마다 1분에 한 번씩 따로 계산한다(Valkey 공유 없음). 제품마다 lateral 조회를 두 번 하는데, 복제본의 crawl_candidates·crawl_documents idx_scan 이 각각 약 39.5억으로 거의 같은 값인 것과 맞아떨어진다.
- WEB-04 (P2) 공개 개수(분야·결과 수·AI 단계)를 30초마다 전체 표로 훑고, 행마다 product_health 를 조회한다. Valkey 로 웹끼리 나눠 쓰지만 만료 시각이 모든 웹에서 같아 만료 순간에 겹친 웹들이 한꺼번에 다시 계산한다. 복제본 product_health idx_scan 이 144억이다.
- WEB-05 (P2) 복제본 풀 대기 초과(`DB_POOL_WAIT_TIMEOUT`)를 「복제본 다운」으로 본다. 그러면 30초 동안 모든 공개 읽기가 주 DB 로 가고, 실패한 읽기는 주 DB 에서 처음부터 다시 돈다(연쇄 위험).
- sitemap 403(지시 4번): 원 서버 코드는 어떤 UA 에도 200 을 준다. 403(5.3KB, cf-cache-status 없음)은 Cloudflare 가 경로 단위 규칙으로 낸 응답이다. 검색 봇이 예외인지는 Cloudflare 설정에서 확인해야 한다 → WEB-07.

## 발견

### WEB-01 상세 렌더가 익명 GET 마다 주 DB 에서 `products` 행 FOR UPDATE 트랜잭션을 연다
- 심각도: P2 (2차 검증에서 P1→P2: 경로는 맞지만 영향 크기 근거가 없다 — 웹 FOR UPDATE 는 느린 문장 목록에 없고, 잘못된 폼은 잠금 대기가 날 때만, fence 밖 쓰기는 켜진 바인딩의 제품이 차단·저장소 변경된 때만 생긴다. 요청당 비용도 WEB-02 의 일부(4왕복)다)
- 분류: concurrency
- 위치: `app/(public)/[locale]/(content)/p/[slug]/page.tsx:114-115`(진입 `:86-100·108-115`, `export const dynamic = "force-dynamic"` `:42`), `lib/domain/github-installations/bindings.ts:11-23`

`app/(public)/[locale]/(content)/p/[slug]/page.tsx:114-115`:
```ts
  const githubDeliveryAvailable = githubFeedbackDeliveryEnabled()
    && Boolean((await getProductGithubBinding(identity.id).catch(() => null))?.enabled);
```
`lib/domain/github-installations/bindings.ts:13-15·19`:
```ts
  return onPrimary(() => db.transaction(async tx => {
    const [product] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
    const [binding] = await tx.select().from(githubProductBindings).where(eq(githubProductBindings.productId, productId)).for("update");
…
    const [disabled] = await tx.update(githubProductBindings).set({ enabled: false, revision: binding.revision + 1, blockedReason: reason, updatedAt: new Date() }).where(eq(githubProductBindings.productId, productId)).returning();
```
- 문제: 웹 두 앱에는 `GITHUB_FEEDBACK_DELIVERY_ENABLED=true` 가 켜져 있다(`docs/operations/2026-10-12-github-feature-activation.md:16` 웹 mini·M3 `true`, `docs/operations/2026-10-13-comments-production-rollout.md:27` 「기존 true를 유지」). 그래서 상세 HTML 이 엣지 캐시에 없을 때마다 다음이 일어난다. 긴 꼬리 상세나 봇 크롤링은 대부분 엣지에 없다(11-11 실측 「상세 거의 MISS」 — 운영 메모 근거, 저장소 문서 아님).
  1. 주 DB(PgBouncer)에 BEGIN, `SELECT * FROM products … FOR UPDATE`, 바인딩 FOR UPDATE, COMMIT 으로 4번 왕복한다. 바인딩이 없는 제품도 products 행 잠금은 먼저 돈다(`bindings.ts:14·16`). 행 잠금 표시 때문에 products 힙 페이지가 더러워지고 WAL 이 생긴다(체크포인트 뒤 그 페이지의 첫 잠금이면 전체 페이지 이미지). 읽기 요청이 쓰기를 만드는 것이다.
  2. 워커가 같은 제품 행을 쥐고 있으면 본문이 lock_timeout 까지 멈춘다. 웹의 주 DB 연결은 pgbouncer 모드라서 역할 기본값 5초가 적용된다(`docs/operations/independent-workers-runbook.md:394-398`).
  3. 그 오류는 `.catch(() => null)` 이 삼켜 `githubDeliveryAvailable=false` 로 그려진다. 이 HTML 이 엣지에 240+60초 남으므로(`next.config.ts:87·98`), 일시적인 잠금 대기 하나 때문에 4~5분 동안 피드백 폼에서 「GitHub 로 전달」 선택지가 사라진다(로직 오류).
  4. GET 이 바인딩을 끄고 outbox 를 취소하는 쓰기를 하는데, `runWebWrite`(DR fence prelude, `lib/operations/dr/web-gate.ts:59-62`) 밖에서 한다. fenced DB 에도 쓸 수 있다.
  - 시나리오: 검색 봇이 처음 보는 상세를 초당 5개 가져온다 → 초당 5번 FOR UPDATE 트랜잭션과 WAL 이 생긴다. 같은 순간 publisher 의 `lockProductGeneration` 이 그 제품을 쥐고 있으면 그 렌더는 수 초를 기다린 뒤 잘못된 폼을 엣지에 남긴다.
- 실측 근거: slow-queries-primary.txt 에서 제품 행 잠금 경합이 실제로 보인다.
  - `select "id" from "products" where (id=$n and slug=$n) for update`: 4회, 평균 1,712ms, 최대 4,248ms(:47)
  - `update "products" set "search_keywords"`: 25회, 평균 802ms(:34)
  - `update "products" set "og_image"`: 11회, 평균 816ms(:44)
  - 웹의 FOR UPDATE 자체는 0.5초 미만이라 목록에 없다. 이 경로의 빈도는 직접 근거가 없다.
- 수정 방안: 렌더 쪽 판정을 읽기 전용으로 바꾼다.
  - `select b.enabled, b.product_repo_url, p.status, p.repo_url from github_product_bindings b join products p …` 를 `publicRead("detail", ["github-binding", id])` 로 읽는다(복제본, 30초). 화면에서는 `enabled && status!=='banned' && repo_url===product_repo_url` 로 계산한다.
  - 자동 끄기(바인딩 disable과 outbox 취소)는 쓰기 경로로 옮긴다. 저장소가 바뀌거나 차단될 때다(`lib/domain/github-installations/authorization.ts:40` 이 이미 쓰기 흐름에서 같은 함수를 부른다). 또는 maintenance 잡으로 옮긴다.
  - 읽기에 실패하면 false 로 단정하지 말고 그 응답을 no-store 로 낸다.
- 검증:
  - 단위 시험: `ProductDetail` 렌더에서 transaction 과 `.for("update")` 호출이 0회인지 본다.
  - 통합 시험: 다른 트랜잭션이 products 행을 잠근 동안 상세 렌더가 지연 없이 끝나는지 본다.
  - 운영: pg_stat_statements 의 `github_product_bindings … for update` 호출 수가 0 이 되는지 본다.
- 배포 주의: 일반 배포(웹). 자동 끄기를 잡으로 옮기면 그 역할도 배포한다.
- 확신도: CONFIRMED — 2차: 진입점(ProductPage → Suspense → ProductDetail, force-dynamic)부터 다시 읽었다. memo·React cache·조건(번역 수요 등)이 없고, 바인딩 유무와 상관없이 렌더마다 돈다(피드백 구획을 그리지 않아도 계산한다, `:158-164`). 조건은 플래그와 엣지 MISS(쿠키 `nmv_user` 등이 있으면 늘 MISS, `next.config.ts:84-86`)뿐이다. 운영 플래그 값은 10-12·10-13 문서 근거이고 현재 env 는 직접 확인하지 않았다.
- 규모: S

### WEB-02 공개 요청마다 주 DB 에 rate-limit UPSERT(와 설정 SELECT)를 기한 없이 직렬로 1~6번 보낸다
- 심각도: P1 (2차: 유지 — 지금 실측 피해는 없지만, 모든 공개 요청이 주 DB 쓰기에 직렬로 묶인 구조라 동시 접속 목표의 상한이 된다)
- 분류: latency / concurrency
- 위치: `proxy.ts:38-42·44-48`, `lib/http/crawl-burst.ts:89-93·109-137·154-171`, `lib/http/anti-scrape.ts:59-79·106-124`, `lib/anti-scrape/gate.ts:15·32`, `lib/anti-scrape/control.ts:8-12`, `lib/db/pool.ts:72-81`

`lib/http/anti-scrape.ts:72-78`(공개 API 한 번 — 차례로 burst·detail-burst UPSERT, api-read UPSERT, detail-read UPSERT, 설정 SELECT + api-session UPSERT):
```ts
  const burst = await guardCrawlBurst(request, "api", route);
  if (burst) return burst;
  const limited = await limitByIp(request, route, apiReadKey, API_READ_LIMIT, API_READ_WINDOW_MS);
  if (limited) return limited;
  const detailLimited = await guardDetailApiRead(request, route);
  if (detailLimited) return detailLimited;
  return route === "session" ? null : guardApiSession(request, route, onSessionRequired);
```
`lib/db/pool.ts:74-75`(pgbouncer 모드는 연결에 statement/lock timeout 을 싣지 않는다 — direct 쪽만 `:76-81` 에서 싣는다):
```ts
  const connection = config.poolerMode === "pgbouncer"
    ? { application_name: applicationName }
```
- 문제: 문장이 몇 개 나가는지(2차 재계수, 엣지에 담기는 응답과 아닌 응답을 나눔):
  - 엣지에 담기는 공개 화면(`next.config.ts:89-103`): 엣지 HIT 이면 0. MISS 이면 proxy 에서 burst UPSERT 1개(`proxy.ts:38-42`, 설정 SELECT 는 프로세스당 30초에 한 번 `lib/http/crawl-burst.ts:35-53`).
  - 검색 화면(`?q=`, 엣지에 담지 않음 `next.config.ts:85·123`): proxy 에서 burst + search UPSERT 2개(`proxy.ts:44-48`).
  - 공개 API(모두 no-store, 엣지에 담기지 않음): 상세 세 경로(details·readme·timeline, `lib/http/crawl-burst-policy.ts:30`)는 burst·detail-burst·api-read·detail-read UPSERT 4개, 그 밖(카드·개수·반응·피드백 등)은 2개. 세션 관문 env 가 있으면 설정 SELECT 1개 + 세션 쿠키가 있을 때 api-session UPSERT 1개가 더 붙는다(`lib/anti-scrape/gate.ts:12-15·32`). `/api/session` GET 은 2~3개다(`app/api/session/route.ts:19·24`).
  - 상세 한 번 보기: session(2~3) + details(4~6) + reactions(2~4) + feedback(2~4), 설치형이면 readme(4~6)까지. 합쳐서 **주 DB 10~23문장**이다(HTML 이 MISS 면 +1). 화면이 부르는 API 수는 `lib/http/crawl-burst-policy.ts:9-10` 의 실측(상세 5·설치형 6·홈 7요청)과 같다.
  - 홈 한 번 보기: 문서 MISS 1 + API 6개 × 2~4 로 약 12~25문장이다.

  위험이 커지는 이유:
  - 모두 처리 전에 await 하는 직렬 왕복이다. 주 DB 는 이미 경합 중이다(아래 실측). 풀이 꽉 차면 5초(`DB_POOL_WAIT_MS`, `lib/db/pool.ts:62`)를 기다린 뒤에야 「열어 둠」으로 넘어간다. 세션 관문은 설정·한도 읽기가 실패하면 열지 않고 503 을 낸다(`lib/anti-scrape/gate.ts:16·39`, enforce 모드).
  - 웹의 주 DB 는 pgbouncer 모드다(운영 env 예시 `docs/operations/` 의 `production-multi-instance.env.example` 3행 `DB_POOLER_MODE=pgbouncer` — 확장자가 길어 인용 검사기가 못 읽어 이렇게 적는다). 그래서 pool.ts 의 웹 15초 상한(`lib/db/pool.ts:54`)이 연결에 실리지 않고, 역할 기본값 `statement_timeout=120s` 가 적용된다(`docs/operations/independent-workers-runbook.md:394-398`). GET 은 `withRoute` 에서 기한 없이 그대로 돈다(`lib/http/handler.ts:42`, `withDbDeadline` 을 쓰는 공개 경로 없음). PgBouncer 일시정지나 주 DB 정체 때 공개 요청이 최대 수십 초 매달린다. 복제본·Valkey 만으로도 낼 수 있는 화면이 주 DB 건강에 묶여 있는 것이다.
  - `publicApiMode()` 는 같은 runtime_settings 행을 요청마다 캐시 없이 읽는다(`lib/anti-scrape/control.ts:10`). crawl-burst 쪽은 같은 행을 30초 캐시한다(`lib/http/crawl-burst.ts:35-53`). 세션 관문 env 가 있을 때만 해당한다(`lib/anti-scrape/session.ts:12-17`).
  - 규모 추정: 목표(동시 5,000명, 30초에 한 화면)면 화면 약 167개/초 × 약 15문장 = **주 DB 쓰기 약 2,500문장/초**다. 지금 주 DB 전체 평균은 259 TPS다.
- 실측 근거:
  - pg-stats-primary.txt: `xact_commit 125,268,523`(5.6일, 평균 약 259 TPS), `locks waiting 7 / 357`.
  - slow-queries 오류: `canceling statement due to statement timeout` 10,383건(slow-queries-primary.txt:70).
  - rate_limits UPSERT 자체는 느린 문장 목록에 없다. 지금은 빠르고, 위험은 결합도와 부하 증가 쪽에 있다.
- 수정 방안:
  - 추천: Valkey 로 옮긴다. `CrawlBurstStore` 인터페이스가 이미 있다(`lib/http/crawl-burst.ts:27-33`).
    - Lua 한 번으로 burst·api-read·detail-burst·detail-read·api-session 키에 `INCRBY` + `PEXPIRE NX` 를 하고 결과를 한꺼번에 돌려준다. 왕복 1번, 기존 150ms 명령 기한(`lib/cache/shared.ts:28`), 실패하면 열어 둔다.
    - 키 접두는 `nmv:rl:` 로 한다(계정 ACL 이 nmv:* 만 허용, `lib/cache/shared.ts:2`). Valkey 가 없을 때만 DB 를 쓴다.
  - 작은 대안:
    - 한 요청의 키를 `insert … values (k1),(k2),(k3) on conflict … returning key,count` 한 문장으로 합친다.
    - `withDbDeadline(Date.now()+300)` 과 Promise.race 로 감싸 기한을 넘기면 열어 둔다(`withDbDeadline` 은 풀 대기만 끊는다 — `lib/db/pool.ts:7`).
    - `publicApiMode` 는 crawl-burst 의 30초 설정 캐시를 같이 쓴다.
    - 웹 전용 DB 역할을 두고 `statement_timeout=5s`·`lock_timeout=1s` 를 건다(구조 제안 S5).
- 검증:
  - `tests/anti-scrape-api*`, `tests/integration/anti-scrape-api-*` 를 Valkey 가짜 저장소로 돌린다.
  - 운영: 「상세 1회당 주 DB 문장 수」(pg_stat_statements 의 rate_limits calls ÷ http.request 수)가 0 에 가까워지는지, http.request durationMs p95 가 어떻게 바뀌는지 본다.
- 배포 주의: 일반 배포(웹). 저장소를 전환하는 순간 카운트가 한 창만큼 비는 것은 허용한다.
- 확신도: CONFIRMED — 2차: proxy 와 공개 API 관문을 끝까지 다시 읽고 문장 수를 다시 셌다(위). 가드는 모두 DB 오류에 열어 두지만(세션 관문 제외) 기한은 없다. 부하 영향(2,500문장/초)은 추정이고, 운영의 세션 관문 env 설정 여부는 미확인이다.
- 규모: M

### WEB-03 홈 집계(home pulse)를 웹 프로세스마다 1분에 한 번 따로 계산한다 — 제품마다 lateral 두 번
- 심각도: P2
- 분류: inefficiency
- 위치: `lib/domain/products/home-pulse.ts:98-100·112-143`(프로세스 변수 `cachedPulse`), `:172-174`(bornOf), `:177-184`(categoryRows)

`lib/domain/products/home-pulse.ts:100`(프로세스 변수 — sharedStore 를 쓰지 않는다):
```ts
let cachedPulse: PulseEntry | null = null;
```
`lib/domain/products/home-pulse.ts:172-174`:
```ts
  const bornOf = sql`
    left join lateral (select c.repo from ${crawlCandidates} c where c.published_slug = p.slug order by c.id desc limit 1) c on true
    left join lateral (select (d.repo_meta->>'created_at')::timestamptz as born_at from ${crawlDocuments} d where d.repo = c.repo offset 0) b on true`;
```
`lib/domain/products/home-pulse.ts:182-183`:
```ts
        from ${products} p ${bornOf}
       where p.status in ('verified', 'seeded') and coalesce(p.verified_at, p.created_at) < ${asOfAt} and ${listedByDefaultAs("p")} and ${notAuditHeldAs("p")}
```
- 문제:
  - pulse 는 프로세스 변수에만 담는다. 웹 여러 대(`lib/domain/products/public-reads.ts:10` 주석 「웹 6대」)가 각자 요청이 들어온 분마다 다시 계산한다. 홈 렌더(`app/(public)/[locale]/(content)/page.tsx:481`) 말고도 카드·개수 API 가 같은 함수를 부른다(`app/api/product-cards/route.ts:134`, `app/api/browse-counts/route.ts:41`).
  - 한 번 계산할 때 공개 제품(약 10만) 하나마다 crawl_candidates(published_slug) 1번, crawl_documents(repo) 1번 조회한다. 여기에 업데이트·활발·도구 집계 3개가 더 붙는다.
  - KST 0시나 배포 직후에는 키가 바뀐다. 그러면 SWR 이 아니라 각 웹의 첫 요청이 전체 계산을 기다린다(`:125-128`, 주석 `:105-107` 이 인정).
  - 창은 하루 단위라 결과는 하루에 거의 바뀌지 않는다. 실제로 바뀌는 것은 상태 거르기뿐이다.
- 실측 근거: pg-stats-replica.txt
  - `crawl_candidates idx_scan 3,953,659,573`(:6) 과 `crawl_documents idx_scan 3,951,694,528`(:20) 은 차이가 0.05% 뿐이다. 「후보 한 번 → 문서 한 번」 짝 조회가 복제본 읽기의 대부분이라는 뜻이다. 공개 경로에서 전체 제품에 그 모양을 도는 것은 bornOf 뿐이다(repoOf `:165-167` 는 활발 상위 몇 행에만 붙는다).
  - 제품 10만 기준이면 약 4만 번 계산한 셈이다. 통계 창을 5.6일로 보면 분당 약 5회로, 웹 6대 × 분당 1회와 맞는다.
  - (2차 정정) 1차에 적은 「복제본 web-replica 연결 46 ≈ 8×6」 은 근거가 없다 — 복제본 풀은 기본 4개다(`lib/db/pool.ts:46`, `lib/db/host-budget.ts:84`). 46 은 웹 대수·운영 풀 값을 몰라 풀 수 없다.
- 수정 방안:
  - 추천 1: products 에 `repo_born_at timestamptz` 칸을 둔다. 발행 때와 stars-refresh 의 저장소 확인 때 채운다. 그러면 bornOf 의 lateral 두 번이 사라지고 categoryRows 는 products 한 표만 훑는다. 같은 칸을 `repositoryBornAt`(`lib/domain/products/repository.ts:419-426`, 신규 띠)도 쓸 수 있다.
  - 추천 2: pulse 를 scheduler 잡이 1분에 한 번 `home_pulse_snapshots` 한 행으로 쓴다. 웹은 그 한 행을 publicRead 로 읽는다.
  - 최소안: sharedStore 에 SWR 로 공유하고 `SET NX` 로 한 대만 계산하게 한다.
- 검증:
  - categoryRows 를 칸 추가 전후로 `EXPLAIN (ANALYZE, BUFFERS)` 해서 비교한다.
  - 복제본 `pg_stat_user_tables` 의 crawl_candidates·crawl_documents idx_scan 하루 증가량을 비교한다.
  - KST 0시 직후 홈 첫 요청 시간을 잰다.
- 배포 주의:
  - 칸 추가는 null 허용 마이그레이션으로 하고, 백필은 배치로 한다. 웹은 칸이 비어 있으면 기존 식을 쓴다.
  - 잡을 추가하면 scheduler 를 먼저 배포한다.
- 확신도: CONFIRMED(코드 경로 — 2차: getHomePulse 의 세 호출자 모두 같은 프로세스 변수만 거치고 Valkey 층이 없음을 확인). 39.5억의 귀속은 PLAUSIBLE 이다(관리자 대시보드의 복제본 읽기가 일부 섞일 수 있고, 복제본 통계 창을 모른다).
- 규모: M

### WEB-04 공개 개수를 30초마다 전체 표 훑기로 다시 센다(Valkey 로 나눠 쓰나 만료가 모든 웹에서 동시) — 행마다 product_health 조회
- 심각도: P2
- 분류: inefficiency / concurrency
- 위치: `lib/domain/products/repository.ts:314-319·335`(notDown 상관 서브쿼리), `:526-530`(countProducts), `:597-606`(categoryCounts), `:670-679`(aiLevelCounts), `app/api/browse-counts/route.ts:71-77`, `lib/cache/memo.ts:47-56`, `lib/cache/shared.ts:49-56·62-74`

`lib/domain/products/repository.ts:314-319`(행마다):
```ts
const notFailingHealth = sql`not exists (
  select 1 from product_health h
  where h.slug = ${products.slug} and h.failures >= ${DOWN_THRESHOLD}
    and ${uptimeNegativeAllowed({ id: products.id, url: products.url, updatedAt: products.updatedAt,
      checkedAt: sql`h.checked_at`, failures: sql`h.failures`, status: sql`h.status` })}
)`;
```
`lib/cache/memo.ts:47-48·52`(다른 웹이 넣은 값의 만료 시각을 그대로 받는다 → 모든 웹이 같은 순간 만료):
```ts
        const remote = shared ? await shared.store.get<T>(`${shared.namespace}:${key}`) : null;
        if (remote && remote.expiresAt > now()) {
…
        const value = await load();
```
- 문제:
  - 기본 홈 한 번(서버와 /api/browse-counts)에 개수 열쇠가 셋 필요하다: `categories`, `browse-categories-v2`, `matching`(`app/api/browse-counts/route.ts:72-75`). 셋 모두 공개 상태 제품 전체를 훑고, 행마다 product_health 를 조회한다.
  - 30초 TTL 이고 지난 값은 내지 않는다(SWR 없음 — `lib/cache/memo.ts:7-8` 주석의 의도된 원칙). 그래서 만료 직후 첫 요청은 전체 계산을 기다린다.
  - Valkey 값의 만료 시각이 모든 웹에 그대로 퍼진다(`lib/cache/memo.ts:10-11·48-49`). 평소에는 한 대가 센 값을 나머지가 쓰지만, 만료 순간 계산이 끝나기 전에 요청을 받은 웹은 모두 각자 다시 센다(최대 웹 수만큼, 스탬피드). 같은 프로세스 안의 single-flight(`lib/cache/memo.ts:44-45`)만으로는 막지 못한다.
  - /popular 의 구간·facet 개수도 같은 구조다(`app/api/browse-counts/route.ts:55-58`).
- 실측 근거: pg-stats-replica.txt
  - `product_health idx_scan 14,430,248,932`(:10): 공개 제품 10만 기준 약 14만 번의 전체 훑기다.
  - `products seq_scan 66,580 / seq_tup_read 5,299,395,975`(:4): 회당 평균 79,600행으로, 거의 전체 표다.
- 수정 방안:
  - 추천: 「목록에 실림」을 칸으로 만든다.
    - `products.listed boolean`(notDown ∧ listedByDefault ∧ notAuditHeld)을 둔다. product_health 를 쓰는 잡, 상태·감사 보류·저장소 확인 변경 때 갱신한다.
    - 부분 색인 `(category, ai_level) WHERE listed` 를 둔다.
    - 그러면 개수가 색인만 훑고, 행마다의 조회가 없어진다.
  - 단기안:
    - memo 에 refresh-ahead 를 넣는다. 만료 5초 전에 Valkey `SET NX` 를 잡은 한 대만 다시 읽는다. 지난 값을 내지 않으므로 30초 원칙은 지켜진다.
    - 만료 시각에 지터를 준다.
- 검증:
  - categoryCounts 의 EXPLAIN 을 전후로 비교한다.
  - 복제본 product_health idx_scan 증가율을 본다.
  - /api/browse-counts http.request p95 를 본다.
- 배포 주의:
  - 칸 방식: 마이그레이션(칸 추가, `CREATE INDEX CONCURRENTLY`) → 갱신 경로 배포와 백필 → 웹 전환 순서로 한다.
  - listed 정의가 `uptimeNegativeAllowed`(uptime 관문)까지 지금 식과 같은지 시험으로 고정해야 한다.
- 확신도: CONFIRMED(쿼리 모양·동시 만료). 2차: Valkey 공유(`lib/domain/products/public-reads.ts:13-23`)가 평소 재계산을 한 대로 줄이므로 1차 제목의 「웹마다」는 만료 순간 겹친 요청에만 맞다 — 제목·문장을 고쳤다. 144억의 귀속은 PLAUSIBLE 이다(복제본 통계 창을 모르고, 열쇠 종류 수와 목록·검색 쿼리의 notDown 몫을 나누지 못했다).
- 규모: L(칸 방식) / S(refresh-ahead)

### WEB-05 복제본 풀 대기 초과를 「복제본 다운」으로 본다 — 30초간 모든 공개 읽기가 주 DB 로 가고, 실패한 읽기는 주 DB 에서 다시 돈다
- 심각도: P2
- 분류: concurrency
- 위치: `lib/db/replica.ts:31-35·97-114`, `lib/domain/products/detail-view.ts:744-763`, `tests/db-replica.test.ts:94`(이 동작을 시험이 고정함)

`lib/db/replica.ts:31·34-35`:
```ts
const DOWN_CODES = new Set([
…
  "DB_POOL_WAIT_TIMEOUT", "53300", "57P01", "57P02", "57P03",
]);
```
`lib/db/replica.ts:107-112`(`REPLICA_COOLDOWN_MS = 30_000`, `:51`):
```ts
      } catch (error) {
        const kind = replicaFailure(error);
        if (!kind) throw error;
        if (kind === "down") downUntil = now() + REPLICA_COOLDOWN_MS;
        deps.warn(kind === "readonly" ? "db.replica_write_attempt" : "db.replica_fallback", { kind, error });
        return load();
```
- 문제:
  - 상세 부가 자료가 캐시에 없으면 한 번에 약 17개 쿼리를 동시에 낸다(getProductDetail 의 Promise.all, details API 의 `publicRead` 안 — `app/api/products/[slug]/details/route.ts:28`). 웹 한 대의 복제본 풀은 기본 4개다(`lib/db/pool.ts:46` `READ_DB_POOL_MAX ?? "4"`, host-budget 선언도 4 `lib/db/host-budget.ts:84`; 운영 값은 미확인). (2차 정정: 1차의 「8개(운영 READ_DB_POOL_MAX=8)」는 근거가 없다.)
  - 몇 개의 상세가 동시에 캐시를 놓치거나 복제본이 잠깐 느려지면(개수·pulse 같은 수백 ms 집계가 연결을 쥐고 있을 때), 대기가 5초(`lib/db/pool.ts:62`)를 넘어 `DB_POOL_WAIT_TIMEOUT` 이 난다.
  - 그러면 그 웹은 30초 동안 모든 공개 읽기를 주 DB 로 보낸다. 개수 전체 훑기, pulse, 검색도 포함된다. 주 DB 쪽 풀은 6개이고(운영 env 예시 `docs/operations/` 의 `production-multi-instance.env.example` 4행 `DB_POOL_MAX=6`; 실제 운영 값은 미확인), rate-limit UPSERT(WEB-02)와 FOR UPDATE(WEB-01)가 같은 풀을 쓴다.
  - 주 DB 풀도 차면 proxy 의 UPSERT 가 5초씩 기다리고, 모든 화면에 +5초가 붙는다.
  - 실패한 읽기는 주 DB 에서 다시 돈다. 그동안 복제본에 보낸 나머지 쿼리는 버려진 채로 계속 돈다(이중 작업).
  - 결국 「웹 쪽 연결 수 부족」이 「주 DB 부하」로 바뀐다. 설계 의도(`lib/db/replica.ts:1-2` 「주 DB 는 워커와 같이 쓴다」)와 반대다.
- 실측 근거: 복제본에 `nomorevibe:web-replica` idle 연결이 46개다(pg-stats-replica.txt:27). 웹들이 풀을 거의 다 연 적이 있다는 뜻으로 보이나, 웹 대수·운영 풀 값을 몰라 확정하지 못한다. 대기 초과가 실제로 몇 번 났는지는 웹 로그(`db.replica_fallback`)가 없어 미확인이다.
- 수정 방안:
  - `DB_POOL_WAIT_TIMEOUT` 은 「busy」로 따로 분류한다. 쿨다운을 걸지 않고 그 요청만 실패시킨다. 화면에는 이미 `RenderReadRecovery` 가 있다(`app/(public)/[locale]/(content)/page.tsx:672`). 주 DB 로 넘길 때는 동시 2개 상한(세마포어)을 둔다.
  - getProductDetail 의 병렬 조회는 `p-limit(4)` 로 묶거나 몇 개를 한 문장으로 합친다.
  - 시험 `tests/db-replica.test.ts:94` 를 함께 바꾼다.
- 검증:
  - 단위 시험: 풀 대기 초과에서 downUntil 이 바뀌지 않는지 본다.
  - 부하 시험: 원 서버에 직접 상세 MISS 동시 50 → 주 DB 동시 사용 수(`pg_stat_activity`)를 전후로 비교한다.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED(분류·재실행 코드, 시험이 고정 — 2차: 읽기 풀도 같은 대기 어댑터를 쓰는 것을 확인 `lib/db/index.ts:38-47`, `lib/db/pool.ts:197-205`). 발생 빈도는 PLAUSIBLE 이다(`db.replica_fallback` 로그와 운영 `READ_DB_POOL_MAX` 확인 필요).
- 규모: S

### WEB-06 README 전문 API 가 요청 때마다 수집용 GitHub 토큰으로 API 를 두 번 부르고 최대 8초 기다린다
- 심각도: P2
- 분류: latency / structure
- 위치: `app/api/products/[slug]/readme/route.ts:20-37`, `lib/domain/products/readme-content.ts:13·29-32·93-106`, `lib/crawl/github.ts:114-115`

`lib/domain/products/readme-content.ts:13`:
```ts
const README_TIMEOUT_MS = 8_000;
```
`lib/domain/products/readme-content.ts:29-30`:
```ts
const contents = createMemo<ReadmeContent>({ ttlMs: 5 * 60_000, max: 64,
  shared: { store: sharedStore, namespace: "readme-content" } });
```
`lib/domain/products/readme-content.ts:99-100`(readWithinBudget → githubRequest → `collectorTokens()`, `lib/crawl/github.ts:114`):
```ts
      // Collector quota/cooldown writes must stay on the primary even inside a public read scope.
      return await contents.get(key, () => onPrimary(() => readWithinBudget(repository)));
```
- 문제:
  - 설치형 상세를 열 때마다 브라우저가 이 API 를 부른다. 캐시는 프로세스당 64개, Valkey 5분뿐이라 긴 꼬리 제품은 거의 매번 새로 받는다.
  - 새로 받을 때 GitHub core 요청이 2번(메타데이터, /readme — `readme-content.ts:54·61-62`) 나가고, raw 다운로드가 1번 더 있다(`:72`). 토큰은 **수집기와 같은 버킷**(`collectorTokens()`)을 쓴다. 토큰마다 쿨다운 행도 주 DB 에서 읽는다.
  - 사람은 README 를 최대 8초 기다린다. 버킷이 바닥나면 공개 화면에 「불러올 수 없음」이 뜬다.
  - 반대 방향도 있다. 이 API 를 IP당 10분 60번까지 긁는 수집기가 크롤러의 GitHub 한도를 깎는다. 11-01 운영 기록에 「core 버킷 셋이 한 시간 안에 바닥」이 있다(운영 메모 근거, 저장소 문서 아님).
- 실측 근거: 코드 근거만(+11-01 운영 기록)
- 수정 방안:
  - 추천: 수집·근거 갱신 잡이 README 원문(256KB 상한)을 ETag 와 함께 저장한다. og 이미지와 같은 MinIO 나 DB 다. 공개 API 는 복제본이나 버킷에서만 읽는다.
  - 단기안: 공개 읽기 전용 GitHub App 설치 토큰을 따로 둬서 수집 버킷과 분리한다. contents 캐시는 6~24시간으로 늘리고 ETag 조건부 요청을 쓴다(304 는 한도를 쓰지 않는다).
- 검증: readme 요청 수 대비 `github.request` 의 core 호출 수, 수집 잡의 rate_limited 빈도를 본다.
- 배포 주의: 저장 방식이면 워커(갱신 잡) → 웹 순서로 배포한다.
- 확신도: CONFIRMED
- 규모: M

### WEB-07 sitemap.xml 403 은 원 서버가 아니라 Cloudflare 가 낸 응답이다 — 검색 봇 예외 확인 필요
- 심각도: P2
- 분류: logic (SEO)
- 위치: `app/sitemap.xml/route.ts:4-10`, `proxy.ts:38·44·56-57`, `lib/i18n/routing.ts:48-53`, `lib/http/crawl-burst-policy.ts:47-54`, `lib/domain/products/sitemap.ts:29-56`, `app/sitemaps/[locale]/[file]/route.ts:11`

`lib/i18n/routing.ts:52`(sitemap.xml·sitemaps/ 는 기계 경로: proxy 가 그대로 통과, 과다 호출 집계 제외):
```ts
    || /^\/(?:api|admin|_next|go|badge|webhooks|oauth|feed\.xml|sitemap(?:\.xml|s)?|robots\.txt|llms\.txt|manifest\.webmanifest|install\.sh|skill\.md)(?:\/|$)/.test(pathname);
```
`app/sitemap.xml/route.ts:6-10`(UA 검사 없음, 항상 200):
```ts
export async function GET() {
  return new Response(sitemapIndexXml(await ranges.get("product-id-ranges", productSitemapRanges)), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" },
  });
}
```
- 문제:
  - 원 서버 코드에는 sitemap 을 거절할 길이 없다. proxy 는 통과시키고, 과다 호출 집계도 빠지고, 라우트에 UA 검사가 없다.
  - 그런데 측정에서는 403 이 나왔다. 크기가 5,363B·5,384B 로 요청마다 다르고, `cf-cache-status` 머리가 없다. 같은 curl 로 `/` 와 `/api/health` 는 200 이었다.
  - 그러니 Cloudflare 가 경로 단위 규칙(WAF 사용자 규칙이나 봇 설정)으로 만든 응답으로 보인다. Cloudflare 가 직접 만든 차단·챌린지 페이지에는 Ray ID 가 들어가 크기가 조금씩 다르고, cf-cache-status 가 없다.
  - 그 규칙이 검증된 검색 봇(Googlebot·bingbot·Yeti)을 예외로 두지 않았다면, 4개 언어의 sitemap index 를 검색 엔진이 받지 못한다. 그러면 새 제품 발견이 링크에만 기댄다.
  - 덧붙여: 언어별 product sitemap 파일은 memo 가 없어서(`app/sitemaps/[locale]/[file]/route.ts:11`), 가져올 때마다 최대 1만 제품과 번역 IN 목록을 복제본에서 다시 읽는다. next.config 의 엣지 시간(`next.config.ts:110-111`)도 캐시 규칙이 .xml 을 덮을 때만 효과가 있다.
- 실측 근거: web-timing.txt:24-25(403, 5,363·5,384B, cf-cache "-"), :2-3·:18-19(같은 클라이언트의 `/`·`/api/health` 200)
- 수정 방안:
  - 사람 작업: Cloudflare Security Events 에서 `/sitemap*` 403 의 규칙 ID 를 확인한다. `/robots.txt`·`/sitemap.xml`·`/sitemaps/*` 는 공개 자료이므로 그 규칙을 건너뛰게 한다. 최소한 `cf.client.bot` 은 예외로 둔다. Search Console·네이버 서치어드바이저에서 sitemap 상태를 확인한다.
  - 코드: `productSitemapEntries` 에 파일별 10분 memo 를 붙인다.
- 검증: Search Console 「가져오기 성공」, Cloudflare 이벤트에서 verified bot 차단 0건을 확인한다. Googlebot 이름만 단 curl 은 계속 막혀도 된다.
- 배포 주의: Cloudflare 설정은 사람이 한다. memo 는 일반 배포.
- 확신도: 원 서버 코드가 원인이 아니라는 것은 CONFIRMED. 검색 봇까지 막히는지는 PLAUSIBLE(Cloudflare 설정 확인 필요).
- 규모: S

### WEB-08 IPv6 주소를 /128 단위로 세어 IP 한도가 세션 관문(/64)보다 약하다
- 심각도: P2
- 분류: logic
- 위치: `lib/rate-limit.ts:159-163`, `lib/http/crawl-burst.ts:110·119·130·156·161`, `lib/http/anti-scrape.ts:109-113`, 비교 대상 `lib/anti-scrape/session.ts:22-32`(세션은 /64 로 묶음)

`lib/rate-limit.ts:159-163`(IPv6 전체 주소 그대로 → burst:<ip>, api-read:<ip>, detail-*:<ip>, search:<ip>, go:<ip>):
```ts
export function publicClientIp(req: WithHeaders): string | null {
  const value = trustedClientIp(req);
  if (!value || isIP(value) === 0 || isPrivateAddress(value)) return null;
  return value;
}
```
- 문제: IP 한도의 열쇠가 IPv6 전체 주소다. 세션 관문(`lib/anti-scrape/session.ts`)은 /64 로 묶는데 과다 호출·API 읽기·검색·/go 한도는 그렇지 않아 기준이 어긋난다. 구체적 영향은 공개 저장소라 싣지 않았다(비공개 메모).
- 실측 근거: 코드 근거만
- 수정 방안:
  - 한도 열쇠용 `limitKeyIp(ip)` 를 둔다. IPv4 는 그대로, IPv6 는 /64 로 접는다(`session.ts network()` 를 재사용). 열쇠를 만드는 다섯 곳에 같은 함수를 쓴다.
  - 차단 로그 `anti_scrape.*_blocked` 에 열쇠 종류(v4/v6-64)를 더해 CGNAT 오탐을 관측한다.
- 검증: 단위 시험으로 `2001:db8::1` 과 `2001:db8::2` 가 같은 열쇠인지 확인한다. 통합 시험으로 두 주소가 같은 burst 카운트를 쓰는지 확인한다.
- 배포 주의: 일반 배포. 전환하는 순간 기존 /128 열쇠의 카운트는 버려진다(허용).
- 확신도: CONFIRMED
- 규모: S

### WEB-09 복제본으로 갈 수 있는 공개 읽기가 주 DB 로 간다(검색어 해석·홈 소식·시즌 줄·/go·피드·미디어·설정)
- 심각도: P3
- 분류: latency / inefficiency
- 위치:
  - `app/(public)/[locale]/(content)/page.tsx:499` → `lib/domain/products/admin-models-search.ts:11-15` → `lib/domain/products/search-translation.ts:95-111·262-300`: 검색마다 `text_translations` 와 `select lexeme from unnest(to_tsvector(...))` 를 (원문 + 번역 표현 수)만큼.
  - `app/(public)/[locale]/(content)/page.tsx:481` → `lib/news/repository.ts:41-58`: listHomeNews. 홈·분야·검색 렌더마다 캐시 없이 주 DB.
  - `app/(public)/[locale]/(content)/@seasonfooter/page.tsx:23`: getCurrentSeason·getSeasonHistory. React cache 만 있다(`lib/domain/ranking/view.ts:113`, getSeasonHistory 는 그것도 없음 `:263-269`).
  - `app/go/[slug]/route.ts:64` → `lib/domain/products/repository.ts:67-69`: findBySlug 가 `select *`(search_vector·본문 2,000자·README 2,000자 포함).
  - `app/feed.xml/route.ts:44` → `lib/domain/products/repository.ts:567-574`: `select *` 20행, memo 없음.
  - `lib/domain/media/postgres-storage.ts:26`: 미디어 바이트.
  - `getCrawlSettings()` 캐시 없음: `app/(public)/[locale]/(content)/page.tsx:445`, `components/home/home-list.ts:84` — 둘 다 `?observedTool=` 이 있을 때만 돈다. (2차 정정: 1차에 함께 적은 `lib/domain/products/detail-view.ts:762` 는 틀렸다 — getProductDetail 은 details API 의 `publicRead` 안이라 복제본·30초 memo 로 읽는다, `app/api/products/[slug]/details/route.ts:28`.)

`app/(public)/[locale]/(content)/page.tsx:481·499`(listHomeNews 와 resolveSearchQuery 는 onReplica·publicRead 밖):
```ts
  const asideLoad = Promise.allSettled([getHomePulse(now), listHomeNews()]);
…
  const searchLoad = resolveSearchQuery(query, { waitForTranslation: requestedSort !== "relevance", mode: searchMode });
```
- 문제:
  - `db` 의 기본값은 주 DB 다(`lib/db/index.ts:59-68`). onReplica 나 publicRead 밖에서 부르면 주 DB 로 간다.
  - 검색은 엣지에 담기지 않는다(q). 그래서 검색 한 번에 주 DB 읽기 2~4개가 붙고, WEB-02 의 UPSERT 2개도 더해진다.
  - 하나하나는 작다. 하지만 공개 읽기는 복제본에서 한다는 기존 원칙(`lib/db/replica.ts:1-2`)에서 벗어나 있고, 주 DB 정체가 그대로 화면 시간에 들어온다.
- 실측 근거: 코드 근거만
- 수정 방안:
  - resolveSearchQuery 의 캐시 조회와 lexemesOf 를 onReplica 로 감싼다. 쓰기(번역 기록·장부)는 이미 onPrimary 로 따로 있다(`lib/domain/products/search-translation.ts:193`).
  - listHomeNews 와 시즌 두 쿼리는 `publicRead("list"/"count", …)` 로 감싼다.
  - findBySlug 대신 /go 에는 `slug,url,status,access_mode` 만 고르는 함수를 쓴다.
  - feed 는 5분 memo 를 둔다.
  - crawl_settings 는 30초 memo 를 둔다. `risingFreshDays` 가 이미 같은 방식이다(`lib/domain/products/repository.ts:269-272`).
- 검증: 홈·검색 렌더 1회당 주 DB 문장 수(로컬 쿼리 로그), 단위 시험에서 onReplica 범위를 확인한다.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED(위 정정 한 줄 제외)
- 규모: S

### WEB-10 외국어 화면의 번역 읽기가 캐시 없이 한 요청 안에서 여러 번 돈다 + 번역이 영영 실패한 제품은 렌더마다 주 DB 수요 트랜잭션
- 심각도: P3
- 분류: inefficiency / logic
- 위치: `lib/i18n/products.ts:26-53·61-69·72-91`, `lib/domain/products/translation-policy.ts:96-103`, `lib/domain/products/translations.ts:57-71·91-125`, `app/(public)/[locale]/(content)/p/[slug]/page.tsx:58-65·112`, `app/(public)/[locale]/(content)/page.tsx:623-626`

`lib/domain/products/translation-policy.ts:102-103`(ready 가 아니면(실패·시도 소진 포함) 늘 pending — 읽기는 ready·reviewed 행만 가져온다 `translations.ts:65`):
```ts
  const ready = !text.trim() || sourceLocale === locale;
  return { text, lang: sourceLocale ?? undefined, translated: false, ready, pending: !ready, sourceHash, sourceLocale };
```
`lib/domain/products/translations.ts:101-102·115·118`(그 pending 마다 응답 뒤 주 DB TX):
```ts
    const sources = await tx.select({ ...sourceColumns, sourceOrigin: products.taglineSource })
      .from(products).where(and(inArray(products.id, ids), eligible)).orderBy(products.id).for("share");
…
    const inserted = await tx.insert(t).values(values).onConflictDoUpdate({ target: [t.productId, t.locale, t.field],
…
      setWhere: sql`${t.sourceHash} <> excluded.source_hash or ${t.errorCode} in ('ineligible', 'stale_source')`,
```
- 문제:
  - (a) `readTranslationsForProducts` 는 onReplica 로 바로 읽고 memo 가 없다. 같은 제품의 번역을 한 렌더 안에서 여러 번 읽는다.
    - 상세: generateMetadata(번역 + readiness)에서 한 번, 본문 `localizeProductList` 에서 또 한 번.
    - details API 에서 또 읽는다(`app/api/products/[slug]/details/route.ts:30-33`).
    - 홈: 목록, 주인 기다리는 목록, 띠, 화제가 쿼리 3~4개로 따로 나간다.
  - (b) 시도가 소진된 failed 행도 「pending」이다. 그래서 외국어 렌더나 details API 마다 `after()` 에서 주 DB 트랜잭션이 돈다(`lib/i18n/products.ts:37-52`).
    - products 행 `FOR SHARE` 와 `INSERT … ON CONFLICT DO UPDATE WHERE …` 이다.
    - WHERE 가 거짓이라 아무것도 바꾸지 않는데도, PostgreSQL 은 충돌한 행을 잠근다(PG INSERT 문서: 「all rows will be locked when the ON CONFLICT DO UPDATE action is taken」).
    - 화면에는 「번역 대기」가 영원히 남는다.
- 실측 근거: 코드 근거만(product_translations 상태 분포는 근거 파일에 없음)
- 수정 방안:
  - 번역 읽기를 `publicRead("detail", ["translations", locale, ids…])` 나 요청 단위 React cache 로 감싼다.
  - 시도가 소진된 failed 행도 함께 읽어, 고를 때 `pending=false`(「번역 안 됨」)로 둔다.
  - 수요 쓰기는 없는 행만 `on conflict do nothing` 으로 넣고, 원문이 바뀐 경우는 따로 update 한다.
- 검증: 단위 시험에서 같은 요청의 두 번째 localizeProductList 가 DB 를 부르지 않는지 본다. 통합 시험에서 소진된 failed 행이 수요 트랜잭션을 만들지 않는지 본다.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED
- 규모: S

### WEB-11 외국어 화면은 browse 사전 전체를 RSC 데이터로 매번 실어 HTML 이 약 25% 크다
- 심각도: P3
- 분류: latency (payload)
- 위치: `lib/i18n/dictionary.ts:73-75`, `app/(public)/[locale]/(content)/page.tsx:432·671`

`lib/i18n/dictionary.ts:73-75`(ko 만 JS 조각, 나머지는 HTML/RSC 에 실음):
```ts
export async function bundledOrDictionary<N extends "detail" | "browse">(locale: Locale, namespace: N): Promise<Dictionary[N] | null> {
  return locale === "ko" ? null : getDictionary(locale, namespace);
}
```
- 문제: 한국어는 사전이 정적 JS 조각(내용 해시 이름, 장기 캐시)에 들어 있다. en·ja·zh-Hans 는 화면마다 browse 사전을 RSC 페이로드로 다시 보낸다. 엣지 MISS 마다 원 서버가 만들고 내보내는 바이트가 그만큼 늘고, 느린 회선(한국 → SEA/LAX)에서는 첫 바이트 뒤 전송 시간도 는다.
- 실측 근거: web-timing.txt:2-3(`/` 100,250B)과 :6-7(`/en` 124,987B), 약 +24.7KB. 언어마다 본문 길이 차이도 섞여 있어서 사전의 몫은 추정이다.
- 수정 방안: lib/i18n/bundled 처럼 언어별 사전을 정적 조각으로 만든다(동적 import 로 언어별 청크). HTML 에는 사전을 싣지 않는다.
- 검증: /en·/ja HTML 바이트를 재고, RSC 데이터에 사전 키가 없는지 확인한다.
- 배포 주의: 일반 배포
- 확신도: PLAUSIBLE(차이의 원인 비중)
- 규모: S

### WEB-12 /go 이동이 응답 전에 주 DB 문장 5개를 차례로 기다린다 — 수집 시작 표시 UPSERT 가 클릭마다 같은 행을 잠근다
- 심각도: P3
- 분류: latency / logic
- 위치: `app/go/[slug]/route.ts:56-90`, `lib/domain/products/clicks.ts:71-102`

`lib/domain/products/clicks.ts:99-100`(주석은 「줄을 서지 않는다」고 하지만 PG 는 WHERE 가 거짓이어도 충돌 행을 잠근다):
```ts
      // 이미 시작했으면 쓰지 않는다 — 클릭마다 같은 행을 다시 쓰면 그 행에서 클릭끼리 줄을 선다
      setWhere: isNull(visitCollectionState.uniqueVisitorStartedAt),
```
- 문제:
  - 302 를 내기 전에 다음을 차례로 기다린다: guardGoRedirect UPSERT → findBySlug `select *` → webWritable → markUniqueCollectionStarted → 방문 중복 제거 UPSERT → click_events INSERT(`app/go/[slug]/route.ts:57·64·89`, `lib/domain/products/clicks.ts:74·80-83`).
  - markUniqueCollectionStarted 는 클릭마다 `visit_collection_state` id=1 행 하나를 잠근다. 그 순간 모든 클릭이 한 행에서 직렬화되고, 행 잠금 표시로 페이지가 더러워진다. 주석이 말한 의도와 실제 PostgreSQL 동작이 다르다.
- 실측 근거: 코드 근거만(PG 문서 INSERT 의 ON CONFLICT condition 설명)
- 수정 방안:
  - 한 번 시작한 것이 확인되면 프로세스 변수에 기억하고, 다시 부르지 않는다. 또는 `on conflict do nothing` 을 쓴다.
  - 클릭 기록은 `after()` 로 옮긴다(이동은 먼저).
  - findBySlug 는 필요한 칸만 고른다.
- 검증: 단위 시험에서 첫 성공 뒤 markUniqueCollectionStarted 가 호출되지 않는지 본다. /go 응답 시간을 잰다.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED
- 규모: S

### WEB-13 검색의 임베딩·재정렬 호출에 전역 동시 상한도 차단기(circuit breaker)도 없다
- 심각도: P3
- 분류: concurrency
- 위치: `lib/domain/products/hybrid-search.ts:32-34·113-146·152-236`, `app/(public)/[locale]/(content)/page.tsx:545-553`

`lib/domain/products/hybrid-search.ts:32-34`:
```ts
const EMBED_TIMEOUT_MS = 500;
/** 재정렬 30쌍 — 평소 0.3초, 붐비면 0.5초 남짓. 넘기면 섞은 순서로 낸다 */
const RERANK_TIMEOUT_MS = 1_500;
```
- 문제:
  - 고유 질의마다(publicRead "list" 30초, Valkey 공유 — `app/(public)/[locale]/(content)/page.tsx:545-553`; 2차 정정: 1차의 「웹마다 30초 memo」가 아니다) embed → nearest, rerank 30쌍을 부른다. 다국어는 embed 2 + rerank 2 다.
  - M3 모델 서버가 죽거나 느리면 고유 검색마다 시간 한도(약 2초)를 다 기다린 뒤에야 대체 순서로 넘어간다. 차단기가 없어서 서버가 쓰러진 동안 모든 고유 검색이 계속 2초를 낸다.
  - 이 서버들이 소리 없이 꺼진 적이 있다(10-22).
  - 고유 질의를 퍼뜨리는 수집기(IP당 10분 60번)가 모델 서버에 동시 요청을 쌓을 수 있다.
- 실측 근거: 코드 근거만
- 수정 방안:
  - 프로세스별 세마포어를 둔다. 예: rerank 동시 4개, 넘치면 바로 rerank 를 건너뛴다.
  - 단계별 차단기를 둔다. 30초 안에 시간 초과 N번이면 60초 동안 그 단계를 건너뛴다. `modelWork.fallback` 에 이유를 남긴다.
- 검증: 느린 가짜 rerank 로 단위 시험을 한다. 모델 서버를 끈 상태에서 검색 p95 를 잰다.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED(코드). 영향은 PLAUSIBLE(검색량 미확인).
- 규모: S

### WEB-14 홈 집계의 지난 값 재사용(SWR)이 「내린 제품은 두 번째 지우기 뒤 다시 채우지 않는다」 원칙을 깬다
- 심각도: P3
- 분류: logic
- 위치: `lib/domain/products/home-pulse.ts:112-143`, `lib/jobs/products/cdn-purge.ts:15`(`CONFIRM_AFTER_SECONDS = 60`), 원칙 `lib/domain/products/public-reads.ts:5-9`, HTML 에 싣는 곳 `app/(public)/[locale]/(content)/page.tsx:777`

`lib/domain/products/home-pulse.ts:116-118`(만료 뒤에도 지난 값을 먼저 돌려준다):
```ts
    if (now.getTime() >= current.expiresAt && !current.refreshing) refreshPulse(current, now, load);
    try {
      return await current.value;
```
- 문제:
  - 공개 읽기 캐시는 Cloudflare 의 두 번째 지우기(60초 뒤)보다 짧고, 지난 값을 내지 않게 만들어져 있다.
  - pulse 만 SWR 이다. 웹이 여러 대라 대마다 트래픽이 적다. 차단과 두 번째 지우기 사이에 요청을 하나도 받지 않은 웹이 있으면, 지우기 뒤 첫 요청에 차단 전 pulse 를 그린다.
  - 그 결과 「이번 주 가장 활발한」 다섯(이름·slug)에 내린 제품이 남은 HTML 이 엣지에 60초(+SWR 60초) 다시 저장되고, 그 뒤에는 지우는 일이 없다. `list=active` API 도 같다(`app/api/product-cards/route.ts:133-136`).
- 실측 근거: 코드 근거만(드문 경우)
- 수정 방안: 그릴 때 pulse.active 를 지금 상태로 다시 거른다(publicRead identity 나 차단 slug 집합). 또는 구조 제안 S3 의 「내림 세대」를 열쇠에 넣는다.
- 검증: 단위 시험 — 차단 뒤 pulse 의 지난 값으로도 active 에 그 slug 가 없어야 한다.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED(동작 방식)
- 규모: S

### WEB-15 공유 카드 PNG 를 요청 때 Satori + resvg(wasm)로 웹 이벤트 루프에서 그린다 — 과다 호출 집계에서도 빠진다
- 심각도: P3
- 분류: concurrency
- 위치: `app/(public)/[locale]/(content)/p/[slug]/share-card.png/route.ts:9-28`, `lib/me/share-card.tsx:179-211`, `lib/http/crawl-burst-policy.ts:52`, `node_modules/next/dist/compiled/@vercel/og/`(resvg.wasm)

`lib/http/crawl-burst-policy.ts:52`(집계 제외):
```ts
  if (logical.startsWith("/.") || logical.endsWith("/share-card.png")) return false;
```
`lib/me/share-card.tsx:210`(요청 안에서 그림을 그린다):
```ts
  return new ImageResponse(element, { width: 1200, height: 630, fonts: satoriFonts }).arrayBuffer();
```
- 문제:
  - 카드는 (언어 4 × 제품 약 11.5만)마다 하나씩, 고유 주소로 있다. og:image 와 JSON-LD image 에 실려 있어 SNS·검색 봇이 가져간다.
  - 처음 가져갈 때 원 서버가 Satori 배치와 resvg 렌더를 메인 스레드에서 동기로 돌린다. 그동안 같은 웹 프로세스의 다른 모든 요청이 멈춘다.
  - 집계에서 빠지고 엣지 캐시는 첫 요청 뒤에야 효과가 있다. 그래서 처음 보는 카드를 빠르게 훑으면 CPU 급등이 그대로 화면 지연이 된다.
- 실측 근거: 코드 근거만(렌더 시간 미측정)
- 수정 방안:
  - 발행·수정 때 워커가 PNG 를 만들어 MinIO 에 둔다(og_images 와 같은 저장소). 라우트는 버킷만 읽는다.
  - 또는 worker_threads 풀(동시 1~2개)로 옮기고, 이 경로도 과다 호출 집계에 넣는다.
- 검증: 처음 보는 slug 100개를 동시에 요청할 때 같은 웹의 `/api/health` 지연을 잰다.
- 배포 주의: 저장 방식이면 워커 → 웹 순서
- 확신도: PLAUSIBLE
- 규모: M

## 구조 변경 제안 (리팩토링으로 효율화)

### S1 공개 rate-limit 를 주 DB 에서 Valkey 로(또는 엣지로)
- 지금: proxy·공개 API 가 rate_limits 표에 직렬 UPSERT 를 보낸다(WEB-02). 화면 한 번에 주 DB 문장 10~25개다.
- 바꿀 구조: `CrawlBurstStore`·`limitByIp`·세션 한도를 Lua 한 번(INCRBY + PEXPIRE NX, 키 여러 개)으로 처리하는 Valkey 저장소로 바꾼다. 화면 과다 호출은 Cloudflare WAF Rate Limiting 으로 앞에서 막는 방안도 함께 검토한다.
- 얻는 것: 주 DB 쓰기가 화면당 0 이 된다. 동시 500명(30초에 한 화면)이면 약 250문장/초가 주 DB 에서 빠지는데, 이것은 지금 주 DB 평균 TPS(259)와 맞먹는다. 공개 화면이 주 DB 정체와 분리된다.
- 순서: ① Valkey 저장소를 구현하고 시험한다(가짜 client). ② observe(두 곳에 같이 세고 결과는 DB 로) 1일. ③ Valkey 로 전환. ④ rate_limits 에는 GitHub 키만 남긴다.
- 위험: Valkey 장애 때 열어 둠(지금 DB 장애 때와 같다). 웹 여러 대가 같은 Valkey 라 한도는 하나로 유지된다.

### S2 공개 집계를 스냅숏으로(웹은 한 행만 읽음)
- 지금: home pulse, 분야·AI·인기 개수, 결과 수를 30~60초마다 전체 표를 훑어 다시 센다(pulse 는 웹마다, 개수는 Valkey 공유 — WEB-03·04).
- 바꿀 구조: scheduler 잡(30~60초)이 `public_aggregate_snapshots(key, value jsonb, computed_at)` 에 쓴다. `products.listed`·`products.repo_born_at` 칸을 두면 목록·개수 쿼리가 색인만 쓴다.
- 얻는 것: 복제본 index probe 약 40억(crawl_candidates·documents) + 144억(product_health)을 거의 0 으로 줄인다. 홈 첫 요청이 집계를 기다리는 일이 없어진다. 복제본 지연 → 주 DB 넘김(10초 넘게 밀릴 때)의 위험도 줄어든다.
- 순서: ① 칸 추가와 백필(마이그레이션). ② 갱신 경로(상태·health·감사 보류·저장소 확인). ③ 스냅숏 잡(scheduler 선배포). ④ 웹 읽기 전환.
- 위험: listed 정의가 지금 식과 어긋나면 목록이 달라진다 → 전환 전에 두 식의 결과를 하루 비교한다.

### S3 공개 읽기 캐시에 「내림 세대」 열쇠
- 지금: 내린 제품을 빨리 숨기려고 모든 공개 읽기를 30초 TTL·SWR 없음·지난 값 없음으로 둔다. 그래서 30초마다 요청이 DB 왕복을 기다리고, 웹마다 동시에 만료된다.
- 바꿀 구조: 제품 차단·숨김·감사 보류 때(트리거 0057 경로) Valkey `INCR nmv:gen:products` 를 한다. memo 열쇠에 세대를 넣고 TTL 은 2~5분으로 늘린다. SWR, refresh-ahead, Valkey `SET NX` 로 여러 대를 가로지르는 single-flight 를 쓴다.
- 얻는 것: 내림 반영이 30초 → 즉시(세대가 바뀌면 열쇠가 바뀜)로 오히려 빨라진다. 공개 읽기 DB 일이 열쇠당 1/4~1/10 로 준다. 원 서버 p95 의 재계산 대기가 사라진다.
- 순서: ① 세대 읽기(5초 프로세스 캐시)와 열쇠 반영. ② 내림 경로에 INCR(cdn_purges 를 쓰는 곳과 같은 트랜잭션 뒤). ③ TTL 상향.
- 위험: Valkey 장애 때 세대를 못 읽으면 지금 방식(30초)으로 돌아가야 한다.

### S4 모두에게 같은 공개 API 응답은 엣지에 담기
- 지금: 11-14/15 공개 HTML 줄이기 이후 카드 채우기, 개수, 상세 본문(사실·소개·README·미디어)이 no-store API 로 갔다. 홈 한 번에 원 서버 API 약 6번, 상세 한 번에 4~5번이 나간다. 엣지 캐시가 화면 비용을 줄이던 효과(10-06 설계)가 크게 줄었다. 상세 소개(모바일 LCP 요소, 11-11 실측)는 HTML → JS → /api/session → /api/products/…/details 의 태평양 왕복 2~3번 뒤에야 그려진다.
- 바꿀 구조: 응답이 방문자와 무관한 `product-cards?slugs=`·`browse-counts`·`details`·`timeline` 은 `Cloudflare-CDN-Cache-Control: max-age=30` 로 엣지에 담는다. 수집 방어는 원 서버 DB 카운터가 아니라 Cloudflare 에서 한다(Turnstile pre-clearance 쿠키 조건의 WAF 규칙과 Rate Limiting 규칙). 세션 관문은 엣지 앞으로 옮긴다.
- 얻는 것: 화면당 원 서버 요청이 약 7 → 1~2 로 줄고, 10-06 용량 추정(엣지 캐시 전제)이 다시 맞게 된다. 상세 LCP 에서 원 서버 왕복이 빠진다.
- 순서: ① 실제 방문자 LCP·API 호출 수를 잰다(지금 장치 없음). ② 대상 API 의 응답에서 개인값(signedIn·csrf 등)을 분리한다. ③ Cloudflare 규칙 → 엣지 저장 순서.
- 위험: 사람이 정한 수집 방어 결정(11-15)과 충돌할 수 있다 → 사람 결정이 필요하다. 엣지에 담긴 응답은 IP 한도를 거치지 않는다.

### S5 웹 전용 DB 역할과 짧은 기한
- 지금: 웹의 주 DB 연결은 pgbouncer 모드라 pool.ts 의 15초가 실리지 않고, 역할 기본값 120초가 적용된다(WEB-02).
- 바꿀 구조: `nomorevibe_web` 역할(공개 쓰기 표에만 권한)에 `statement_timeout=5s`·`lock_timeout=1s`·`idle_in_transaction_session_timeout=10s` 를 건다. 공개 경로의 주 DB 접근은 `withDbDeadline` 을 기본으로 한다.
- 얻는 것: 주 DB 정체가 공개 화면을 수십 초 붙잡는 일이 없어진다. 웹이 할 수 있는 쓰기 범위도 줄어든다(보안).
- 순서: ① 역할과 권한 생성(사람). ② 웹 DATABASE_URL 교체(env 바꾸고 재배포 — 메모리 규칙상 plan 전에). ③ 기한 넘김 관측.
- 위험: 관리자 화면도 같은 웹 앱이다 → 관리자 쓰기에 필요한 권한·기한을 따로 확인해야 한다.

## 확인했지만 문제 아님

- web-timing 의 308(`/ko`, `/ko/popular` 등): 한국어 정식 주소에서 접두를 떼는 정상 동작이다(`proxy.ts:64-68`). `/ko/search?q=` 는 없는 경로라서(검색은 `/?q=`) 측정 주소의 문제다. 이 파일에는 검색·상세 응답 시간이 사실상 없다.
- `/api/products?limit=20` 405: 이 경로는 등록 POST 만 있다(정상). `/api/products/…/timeline` 403(189B): curl UA 를 `refusedApiAgent` 가 거절한 것이다(`lib/http/agents.ts:23·38-42`, `lib/http/anti-scrape.ts:63-66`, 정상).
- 주 DB 의 `products_search_idx idx_scan 0`: 공개 검색은 복제본에서 돈다(`lib/domain/products/public-reads.ts:22-24` → onReplica). 주 DB 통계로 「안 쓰임」인 것이 정상이다. 지우면 안 된다(복제본이 같은 색인을 쓴다).
- 관련도순 결과의 순서: `getPublicListBySlugs` 가 slug 순서를 다시 맞춘다(`lib/domain/products/view.ts:145-150`). 지표 붙이기는 일괄 처리라 N+1 이 아니다(`lib/domain/products/view.ts:164-184`).
- 상세의 없는 제품 404: 스트리밍 전에 identity 를 먼저 읽어 상태 코드가 정확하다(`app/(public)/[locale]/(content)/p/[slug]/page.tsx:86-90`).
- memo: 같은 프로세스의 동시 요청은 한 번만 읽고, 실패는 담지 않는다(`lib/cache/memo.ts:41-60`). Valkey 장애·지연(150ms) 때는 DB 로 간다(`lib/cache/shared.ts:28·57-60·87`).
- 홈 렌더의 집계·소식·시즌·개수는 병렬로 시작한다(`app/(public)/[locale]/(content)/page.tsx:474-507`). 폭포 없음.
- proxy 에서 DB 를 import 하는 것: Next 16 의 Proxy 는 기본이 Node.js 런타임이다(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:253-255`).
- 언어 머리 위조: matcher 가 정적 파일 밖의 모든 경로를 proxy 에 통과시키고(`proxy.ts:110-113`), proxy 가 넘기는 모든 요청에 `x-nmv-public-locale` 을 덮어쓴다(`proxy.ts:72-74·86-94`).
- 검색 봇 확인 DNS: 한도를 넘었을 때만 부르고, 결과를 하루/한 시간 캐시한다(`lib/http/search-bot-verify.ts:7-12·44-66`).
- og-cache 변환(sharp): libuv 스레드풀이라 이벤트 루프를 막지 않는다. 엣지 하루, 프로세스 캐시도 있다(`app/api/og-cache/[slug]/route.ts:18·63-98`).
- crawl-burst 설정 읽기: 30초 캐시와 single-flight 가 있다(`lib/http/crawl-burst.ts:35-53`).
- 상세 과다 호출 시 사이트 전체 30분 차단: 의도된 결정이다(`lib/http/crawl-burst.ts:13·116` 주석, 11-16 사람 지시). CGNAT 오탐은 관측만 권한다(WEB-08).
- 공개 `/api/health`: `select 1` 과 마이그레이션 표 max 1행이라 작다(`app/api/health/route.ts:22·33`, `lib/operations/health.ts:60`).

## 범위 밖·못 본 것

- `/`·`/en` 이 같은 클라이언트에서 두 번 연속 `cf-cache-status: MISS` 였다(web-timing.txt:2-3·6-7). 원인을 확인하지 못했다. 응답 머리(실제 `Cloudflare-CDN-Cache-Control`, `set-cookie` 유무, cf-ray colo, Smart Tiered Cache)를 확인해야 한다. 엣지 적중률이 낮으면 WEB-01·02·04 의 빈도가 그만큼 커진다.
- 운영 웹 로그(`http.request` durationMs, `db.replica_fallback`, `anti_scrape.*`, `search.vector_read_on_primary`)는 수집하지 않았다. WEB-05·13 의 빈도를 모른다.
- 복제본 pgvector 설치 여부: 없으면 의미 검색마다 주 DB 에서 벡터를 전수 계산한다(`lib/domain/products/relevance.ts:49` `withPrimaryFallback`). 위 로그로 확인해야 한다.
- 운영의 세션 관문 env(`TURNSTILE_*`·`PUBLIC_API_SESSION_SECRET`) 설정 여부: WEB-02 의 문장 수(세션 2개)가 이것에 달렸다.
- Cloudflare 캐시 규칙의 범위(.xml, `/c/*`, `/rising`, 언어 접두 경로)와 WAF·봇 설정(WEB-07).
- 복제본 통계 창(stats_reset)을 모른다. WEB-03·04 의 귀속은 창과 무관한 비교(1:1 짝, 행 수/회)만 확정이다.
- 관리자·내부 API, 워커 쿼리(주 DB 느린 문장 상위 — crawl_candidates 판정, 장부 control 잠금)는 다른 구역이다. 더 보기 전체 수와 공개 API 세션은 #1000 이 다룬다.

## 검증 기록 (2차)

검증자가 2026-11-21 에 `저장소 루트`(34b5fe32)를 `sed -n`·`cat -n` 으로 그대로 읽어 다시 확인했다. 코드·git·운영에는 손대지 않았고 테스트·빌드는 돌리지 않았다.

- 인용 고침
  - 줄 번호 47곳을 고쳤다. 크게 틀린 것(1차 번호 → 실제): `proxy.ts` 168–178 → 38–42·44–48, 186–187 → 56–57, 194–198 → 64–68, 216–224·240–243 → 72–74·86–94·110–113. `crawl-burst.ts` 231–235 → 89–93, 251–279 → 109–137, 177–195 → 35–53, 169–175 → 27–33, 252·261·272 → 110·119·130·156·161, 258 → 13·116. `browse-counts/route.ts` 227–233 → 71–77. `shared.ts` 164–176 → 49–56·62–74, 130·151–163 → 28·57–60·87. `sitemap.ts` 90–117 → 29–56. `session.ts` 63–73 → 22–32. `dictionary.ts` 173–175 → 73–75. `agents.ts` 246–250 → 23·38–42. `search-bot-verify.ts` 153–156·186–208 → 7–12·44–66. `hybrid-search.ts` 122–150·160–247 → 113–146·152–236. 그 밖에 `home-pulse.ts`(112–143, 125–128, 182–183), `detail-view.ts` 744–763, `replica.ts` 1–2, `control.ts` 8–12, `pool.ts` 72–81, `share-card.png/route.ts` 9–28, `share-card.tsx` 179–211, `go/[slug]/route.ts` 56–90, 러너북 394–398 등 한두 줄 어긋남을 고쳤다.
  - 짧게 적힌 경로(예: `repository.ts`, `page.tsx`, `runbook`) 약 20곳을 저장소 기준 전체 경로로 바꿨다.
  - 코드 블록 13개(WEB-01~11·14·15)를 파일 원문 그대로의 줄로 바꿨다. 1차 블록은 여러 파일을 섞거나 `(...)`·`{...}` 로 줄이고 끝에 주석을 덧붙인 의역이었다. 파일마다 블록을 나누고 생략은 `…` 줄로만 했다.
  - Next.js 문서 인용은 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:253-255` 로 실제 있는 것을 확인했다.
- 반증·심각도 변경
  - WEB-01 P1→P2: 주장(렌더마다, 조건 없이 FOR UPDATE TX)은 반증되지 않았다(force-dynamic, memo·React cache 없음, 바인딩이 없어도 products 잠금). 다만 영향 크기 근거가 없어 낮췄다(위 심각도 줄).
  - WEB-02 P1 유지: 문장 수를 엣지 HIT/MISS·검색·API 종류별로 다시 셌고 1차 수(상세 10~23)가 맞았다. 홈은 12~30 → 12~25 로 고쳤고, UPSERT 최대 5개 + 설정 SELECT 1개임을 밝혔다. 세션 관문은 실패 시 열지 않고 503 이라는 점을 더했다.
  - WEB-03: Valkey 공유가 없음을 확인(주장 유지). 「web-replica 46 ≈ 8×6」 근거는 틀려서 지웠다(복제본 풀 기본 4).
  - WEB-04: Valkey 가 개수를 웹끼리 나눠 쓰므로 「30초마다 웹마다」는 과장 — 만료 순간 겹친 요청만 웹마다 다시 센다. 제목·요약·문장을 고쳤다(심각도 P2 유지).
  - WEB-05: 「복제본 풀 8개(운영 READ_DB_POOL_MAX=8)」는 근거 없음 → 기본 4개로 고쳤다. 풀이 더 작으므로 주장(대기 초과 → 30초 주 DB 전환)은 오히려 쉬워진다. P2 유지.
  - WEB-09: 하위 항목 `detail-view.ts:762` 의 getCrawlSettings 는 복제본·30초 memo 안이라 틀림으로 표시했다. 나머지 하위 항목은 맞다.
  - WEB-13: 「웹마다 30초 memo」 → publicRead(Valkey 공유)로 고쳤다.
  - `[반증됨]` 을 붙일 만큼 통째로 틀린 항목은 없다.
- 끝내 확인 못 한 것
  - 운영 웹의 `GITHUB_FEEDBACK_DELIVERY_ENABLED`·세션 관문 env·`READ_DB_POOL_MAX`·웹 대수의 현재 값(문서 근거만, WEB-01·02·05).
  - 역할 기본 timeout(120s/5s)이 지금도 그 값인지(러너북 초기값 근거).
  - WEB-03·04 의 복제본 idx_scan 귀속(복제본 stats_reset 모름), WEB-05·13 의 운영 발생 빈도(웹 로그 없음).
  - 11-01 GitHub 버킷 고갈, 11-11 「상세 거의 MISS」 는 저장소 문서가 아니라 운영 메모 근거다.
