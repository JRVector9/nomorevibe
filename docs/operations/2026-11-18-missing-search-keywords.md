# 공개 제품 `products.search_keywords` 빈 칸 원인 조사 (2026-11-18)

범위: 읽기만으로 원인을 찾고 고침을 제안한다. 코드 수정·운영 변경·병합·배포는 하지 않았다. 운영 DB에는 접속하지 않았고, 대표가 05:4xZ에 내보낸 자료(`/home/ubuntu/nmv-search-exp-20261118/kw`)와 origin/main(`ebd63092`) 코드만 읽었다.
표기: **[확인]** 자료나 코드에서 직접 본 사실. **[추정]** 자료로 갈라 낼 수 없어 근거에서 이끌어 낸 것.

## 1. 결론

616건은 서로 다른 세 가지 원인이다. 대표가 먼저 본 「프로필 있음 389건」은 B 381과 C 8로 갈린다.

| 분류 | 건수 | 한 줄 원인 | 저절로 풀리나 |
|---|---|---|---|
| A. 프로필 아직 없음 | 227 | 11/18 01:19~05:46Z에 발행된 제품이 아직 키워드 짓기 대기열에 있다 | 대기열이 줄면 풀린다. 아직 줄고 있는지는 운영 읽기 SQL로 확인해야 한다(§5) |
| B. 모델이 키워드 0개를 내고 오류 없이 끝남 | 381 | 0개도 성공으로 저장하고, 같은 글로는 다시 짓지 않는다 | 풀리지 않는다. 글이 바뀌어야만 다시 짓고, 또 0개일 수 있다 |
| C. 검수가 키워드를 전부 뺌 | 8 | 지은 키워드 5~8개씩 두 언어를 검수가 모두 「근거 없음」으로 뺐다 | 풀리지 않는다. 걸린 건수가 작다 |

「검수 대기 중이라 아직 옮겨 적지 않는다」는 원인이 **아니다**. 키워드는 지은 즉시 `products.search_keywords`로 복사되고(`search-profiles.ts:203`), 검수는 나중에 거기서 뺄 것만 뺀다(`search-profiles.ts:284-286`, `:667-669`). 미검증 39,913건은 이 616건과 무관하다.

대표가 잰 분포의 「11월 385건」은 A 227 + B 157 + C 1이다. 11월이라는 점만 보면 한 원인처럼 읽히지만 A는 별개다.

## 2. 코드 경로 (origin/main `ebd63092`)

### 2.1 키워드 짓기 — `product-search-profile` (text 워커)

- 대상 선택 `pendingProfiles`(`lib/domain/products/search-profiles.ts:117-163`). 공개(seeded·verified) 제품 중 `profileGenerationDueSql`(`:71-76`)에 맞는 것이다.
  - 프로필 없음.
  - 오류가 있고 재시도 가능하며 `retry_at`이 지남.
  - 오류가 없고 `needs_refresh=true`이거나 `updated_at`이 30일 지남.
- 순서(`:156-159`): 프로필 없음 → 소개가 한 줄뿐인 것 → `REFRESH_SINCE` → id 큰 것. 한 묶음의 3분의 1은 가장 오래 기다린 것(`READY_SINCE` 오름차순)이다(`:87-88`, `:159`). 묶음 크기는 실시간 한도 `batch`(코드 주석상 12, `lib/jobs/products/search-profile.ts:33-35`·`:67`)이다.
- 같은 글이면 모델을 부르지 않는다(`lib/jobs/products/search-profile.ts:91-96`).
  - 조건: `source_hash`가 같고 `error_code`가 없고 **`!needs_refresh` 이거나 키워드가 1개 이상**.
  - 이때 `reuse`로 `updated_at`만 새로 적는다(`search-profiles.ts:193-195`).
- 결과가 성공이면(`lib/jobs/products/search-profile.ts:124-129`, `search-profiles.ts:196-203`) 한 트랜잭션에서 다음을 한다.
  - 프로필 행을 쓴다: `keywords_en/ko`, `error_code=null`, `verified_at=null`, `attempts+1`, `generated_at=now()`.
  - 같은 트랜잭션에서 `products.search_keywords = keywordText(en, ko)`를 쓴다. 키워드가 없으면 `null`이다(`search-profile.ts:139-142`).
- 실패면(`search-profiles.ts:204-214`) `error_code`·`retry_at`(5분 또는 30분 + 백오프)을 남긴다. 5번(`MAX_PROFILE_ATTEMPTS`, `search-profile-retry.ts:3`)을 넘기면 멈춘다. 공급자 사유는 세지 않는다(`:7-12`).

### 2.2 모델이 0개를 내면 — 실패가 아니라 성공

- 프롬프트가 0개를 허락한다. `Return empty arrays only when nothing says what it is`(`lib/domain/products/search-profile.ts:74`).
- 파서 `parseKeywords`(`:105-136`)는 `keywords_en`·`keywords_ko` 두 배열이 있으면 `ok:true`를 돌려준다. 빈 배열 둘도 정상이다. 키 없는 `{}`나 깨진 JSON만 `invalid_output`이다(`:111-131`).
- `cleanKeywords`(`:82-97`)가 한 번 더 거른다. 다음에 해당하면 버린다.
  - 길이 2 미만 또는 60 초과.
  - 제품 이름과 같은 것.
  - 중복.
  - 한국어 칸이 영어 칸과 같은 말인 것(`:133-135`).
  - 모델이 낸 것이 전부 걸러져도 결과는 `ok:true`, 빈 배열이다.
- 그래서 「0개 성공」은 `error_code` NULL, `attempts` 1, `verified_at` NULL로 남는다. 대표가 본 B 분포와 정확히 일치한다.
- 호출은 `temperature: 0`이다(`search-profile.ts:150`). 같은 글에 같은 모델·프롬프트면 같은 답이 나올 가능성이 높다. **[추정]**

### 2.3 다시 시도되는 때

- 글(이름·URL·갈래·소개·설명·토픽·본문·README)이 바뀌면 DB 트리거가 `needs_refresh=true`, `source_revision+1`, `attempts=0`을 건다(`drizzle/0048_search_profile_freshness.sql`의 `invalidate_product_search_profile`). 그때 키워드가 0개이고 해시가 같아도 다시 짓는다(`search-profile.ts:92`의 `kw>0` 예외).
- 본문만 바뀐 것은 마지막으로 지은 뒤 7일 동안 옮겨 적지 않는다(`lib/jobs/products/search-refresh.ts:43`, `:54-58`).
- **글이 그대로면 30일 주기에서도 다시 짓지 않는다.** 30일이 지나 `due`로 다시 집혀도 `!needs_refresh`이라 `reuse`로 끝난다(`search-profile.ts:91-95`). 0개 프로필은 30일마다 대기열 자리만 쓰고 모델은 부르지 않는다.
- 운영자 복구 `scripts/reconcile-search-profiles.ts --apply --retry-empty`(`search-profiles.ts:338`)가 있다. `repair_version<1`인 빈 프로필을 `needs_refresh=true`로 되돌리고 `repair_version=1`을 적는다. 한 번만이다(`docs/operations/2026-09-26-profile-repair.md:24`).
- 해시는 글만 본다(`search-profile.ts:56-58`). 프롬프트나 모델을 바꿔도 해시는 그대로여서 기존 프로필은 다시 짓지 않는다.

### 2.4 검수 — `product-search-verify`

- 대상(`search-profiles.ts:226-246`): `needs_refresh=false`, 오류 없음, `verified_at` NULL, **`keywords_en+ko > 0`**, `verify_attempts<5`. 키워드가 0개인 프로필은 검수 대상이 아니다. B의 `verified_at`이 영원히 NULL인 이유다.
- 성공이면 `verified_at`을 적고, 모델이 `fits:false`로 고른 키워드를 `removed_keywords`에 적고, `products.search_keywords`를 남은 것으로 다시 쓴다(`:278-286`, `:661-669`). 전부 빼면 `keywordText`가 NULL을 낸다. 원본 `keywords_en/ko`는 그대로 둔다.

### 2.5 `product-search-refresh`·발행(publish)은 이 칸을 쓰지 않는다

- `product-search-refresh`(`lib/jobs/products/search-refresh.ts:47-66`)가 옮겨 적는 것은 `search_topics`·`search_page_text`·`search_readme`·`search_category`뿐이다. `search_keywords`는 건드리지 않는다.
- `lib/`·`app/`·`scripts/`에서 `searchKeywords`를 쓰는 곳은 다음이다.
  - 프로필 성공(`search-profiles.ts:203`).
  - 검수 성공(`:285`, `:668`).
  - 소개 문장을 고칠 때 비우기(`intro-editor.ts:63`, `intro-requests.ts:139`, `intro-checks.ts:132`).
  - `intro-checks.ts:132-134`는 키워드를 비우고 프로필 행도 지운다. 이 제품은 A와 같은 「프로필 없음」으로 돌아가 다시 지어진다.
- 발행(publish.ts)에는 `search_keywords` 쓰기가 없다. 새로 발행된 제품은 프로필이 생길 때까지 NULL이다. 그것이 A다.

### 2.6 NULL일 때 검색이 어떻게 되나

- `search_vector`는 `search_keywords`를 가중치 C로 색인한다(`lib/db/schema.ts:204`). NULL이면 그 몫이 없다.
- 순위용 낱말 수 `namedCoverage`는 `search_keywords IS NULL`이면 본문·README까지 센다(`lib/domain/products/search.ts:148-151`). 키워드가 없는 제품이 본문 매칭 쪽으로 보정되는 설계다.
- 임베딩 문서에는 `nullif(btrim(coalesce(search_keywords,'')),'')`로 들어간다(`embedding.ts:35`). 한·영을 잇는 말이 없다.
- 그래서 NULL 제품은 한·영을 잇는 검색어에서 가장 크게 불리하고, 같은 언어로 본문에 있는 말로는 어느 정도 잡힌다.
- 공개 100,475건 중 616건(0.61%)이다. B만 보면 0.38%다.

## 3. 616건을 가른 결과

집계는 `missing-keywords.json`에서 하위 에이전트가 낸 값을 내가 다시 맞춰 보았다. 전문은 작업 scratch의 `kw-analysis.md`에 있다. 616개 id는 모두 유일하고 `kw_null`은 전부 true다. `page_len`·`readme_len`은 데이터의 최대값이 2000이라 코드의 1500자 절단과 맞지 않는다. 이 길이로 센 thin(`page<100 & readme<200`, `search-profile.ts:51`)은 근사다.

### A. 프로필 없음 — 227건 [확인]

- `has_profile=false`가 227건이고 `totals.json`의 `no_profile`과 일치한다.
- 전부 2026-11-18 01:19:43Z~05:46:15Z에 만들어졌다. 시간대는 01시 58, 02시 84, 03시 82, 04시 0, 05시 3이다. id는 108445~109747이다.
- 글은 풍부하다: thin 1건(0.4%), 중앙 `tagline` 125자, 본문·README 중앙 2000.
- 대표 slug: `kill-your-own-semiconductor-company-simulator`(id 108445, 01:19Z), 그 밖에 id가 가까운 11/18 제품은 jobs/ledger에서 알 수 없어 SQL로 뽑는다(§5 Q3). 전부 11/18 하루라 서로 다른 달 예시는 만들 수 없다.
- 근거 코드: 선택(`search-profiles.ts:71-76`, `:149-163`), 발행이 키워드를 쓰지 않는 점(§2.5).
- **[추정]** 새 제품은 프로필 없음이 우선순위 맨 앞이라(`:156`) 대기열이 건강하면 빠르게 빠진다. 그런데 01시 제품 58건이 4시간 넘게 남아 있다.
  - 04시 생성이 0건인 점은 그 시간에 발행이 멈췄다는 뜻이다.
  - 같은 날 다른 작업(deepseek 표본, 작업 8ba2d371)의 기록으로는 04:10~04:31Z에 `product-search-profile`·`crawl-publish-classify`의 디스패치가 0건이었다. 그 기록 그대로의 이야기이고 이 작업에서 직접 확인하지 못했다.
  - 정지 구간이 끝났어도 227건이 남은 것이 처리량 부족인지 걸림인지는 이 자료로 갈리지 않는다. 걸림 후보는 다음이다.
    - 장부가 그 제품을 쥐고 있음(`capacity-busy-targets.ts`).
    - 쓰기 직전 글이 바뀌어 `recordProfileResult`가 false(`search-profiles.ts:187`). 새 제품은 `product-search-refresh`가 본문·README를 채우면서 해시가 바뀌는 때가 있다.
    - 이 제품만의 미룸으로 틱마다 건너뜀(`lib/jobs/products/search-profile.ts:132-139`).
  - 지난 24시간 장부: `product-search-profile` settled 6,212(시간당 약 259), indeterminate 4, dispatched 1, withdrawn 2. 대기열이 막혔다는 신호는 없다(`ledger-24h.json`). 잡 4개 모두 `last_error` NULL이다(`jobs.json`).

### B. 모델이 키워드 0개를 냈고 오류 없이 끝남 — 381건 [확인]

- 381건 전부 `error_code`·`retry_at`·`verify_*` 없음, `needs_refresh=false`, `verified_at` NULL, `attempts` 1(1건만 2), `removed_n` 0. 코드가 설명하는 「0개 성공」과 일치한다(§2.2).
- 모델: `gpt-oss-120b` 299, `[MLX] gpt-oss-120b` 82. 경계가 깨끗하다. MLX는 `generated_at` 10/03~10/29, 나머지는 10/31 이후다.
- 만든 달(`created_at`): 08월 2, 09월 120, 10월 102, 11월 157.
- **첫 생성이 0개인 것 144건**(`generated_at`이 `prof_created`와 같은 날, `source_revision` 전부 0). **글이 바뀐 뒤 다시 지었는데 또 0개인 것 237건**(`source_revision` 1 이상, 최대 90). 최근 24시간에 만들어진 0개 결과 19건 중 18건이 재생성이다. 지금도 계속 생기고 있다.
- 글이 얇지 않은 것이 다수다: thin 52건(13.6%)뿐이고, 본문이 500자 이상인 것이 249건이다. README가 비어 있는 것 239건(첫 생성 143, 재생성 96). 본문이 2000자인데 0개인 것도 많다. 대표 slug 예시는 다음이다.
  - `tenplant`(id 412, 08/29, `tagline`/`desc`/`readme`/`page`=71/38/48/132, 9/24 생성·11/10 재생성).
  - `julius-broomfield`(id 24534, 10/01, 25/25/49/2000).
  - `ashutosh-rana-product-designer`(id 57087, 11/01, 129/129/0/2000).
  - slug가 사람 이름이나 포트폴리오로 보이는 것이 201건 안팎이다(대략 매칭이며 확정이 아니다). **[추정]** 이름·사이트 소개처럼 「무엇인지」를 말하지 않는 글이면 모델이 규칙(§2.2)대로 0개를 낸다.
- 30일 주기가 모델을 다시 부르지 않는다는 증거 **[확인]**: `prof_updated`가 `generated_at`보다 정확히 약 30일 뒤인 행이 11건이다(전부 MLX. id 3038, 12494, 15731, 16134, 16145, 16304, 18172, 18201, 27835, 46234, 46370). 예: id 3038은 10-15T11:37에 지었고 11-14T11:37에 `reuse`로 손만 탔다. 키워드는 여전히 0개다. 나머지 370건은 `prof_updated`=`generated_at`이다.
- 이미 한 번 복구(`--retry-empty`, `repair_version=1`)한 뒤에도 0개인 것이 27건이다. 한 번 더 시켜도 같은 답이 나온다는 정황이다.
- 근거 코드: 0개 성공 저장(`search-profiles.ts:196-203`), 30일 `reuse`(`lib/jobs/products/search-profile.ts:91-96`), 검수가 0개를 건너뜀(`search-profiles.ts:235-239`), `temperature:0`(`search-profile.ts:150`).
- 건강 점검도 이 코호트를 세지 않는다: `search-health.ts:55-64`는 `products.search_keywords`가 기대값(NULL)과 같으면 일치로 본다. 0개 프로필은 어디에서도 경보가 되지 않는다.
- 가르지 못한 것: 모델이 빈 배열을 낸 것인지, 낸 키워드가 `cleanKeywords`에서 전부 걸러진 것(이름과 같음·너무 짧음)인지. 저장된 것이 결과 배열뿐이라 DB로는 알 수 없다.

### C. 검수가 키워드를 전부 뺌 — 8건 [확인]

- 8건 모두 키워드가 있었다(영어·한국어 각 5~8개). `verified_at` 11/08~11/17에 검수가 끝났고 `removed_n`이 `en_n+ko_n`과 정확히 같다(16, 16, 16, 10, 10, 10, 16, 10). 검수 모델은 `supa` 4건, `qwen3.8-flash-next` 4건이다. 코드상 전부 `fits:false`로 돌려받은 것이다(`search-verify.ts:140-146`).
- 그 결과 `keywordText([],[])`가 NULL이다(`search-profiles.ts:285`). 원본 `keywords_en/ko`는 남아 있다.
- 키워드를 지은 날은 11/10이 7건, 11/01이 1건이다. 대표 slug: `t-tat`(id 908), `verbaly`(1680), `botttle`(4061). 글이 짧은 쪽에 많다(`tagline` 중앙 33.5자).
- **[추정]** 검수 모델이 증거 대비 지은 키워드를 전부 근거 없다고 본 정상 판정일 수 있고, 얇은 글에서 과하게 엄격한 판정일 수도 있다. 가르려면 뺀 키워드와 글을 사람이 본다(§5 Q8).
- 재생성은 글이 바뀔 때만 일어난다. 풀리지 않는다.

## 4. 원인별 판정과 가장 작은 고침

### A (227건)
- 판정: 시간이 풀 가능성이 크지만 **지금은 확정할 수 없다**. 대기열이 줄고 있다면 처리량(시간당 약 259건 중 새 제품 몫)으로 몇 시간 안이다. 줄지 않고 같은 제품이 계속 남아 있다면 걸림이다.
- 확인: §5 Q1~Q3. 같은 제품이 6시간 뒤에도 프로필이 없으면 코드 조사가 필요하다.
- 고침: 지금은 제안 없음. 정체로 확정되면 걸림 원인(§3 A의 후보 셋)을 SQL로 하나로 좁힌 뒤 제안한다.

### B (381건)
- 판정: **저절로 풀리지 않는다.** 글이 그대로면 영원히 0개이고, 글이 바뀌어 다시 지어도 또 0개로 끝나는 일이 62%(237/381)다.
- 먼저 사람이 눈으로 확인한다(§5 Q4~Q6). 다음 중 어느 쪽인지에 따라 고침이 갈린다.
  - ① 정말 키워드를 뽑을 근거가 없는 글(포트폴리오·이름뿐인 사이트): 정상이다. 고칠 것 없다.
  - ② 근거가 있는데 모델이 빈 배열을 냄: 프롬프트·모델 문제.
  - ③ 모델은 냈는데 `cleanKeywords`가 모두 버림: 파서 문제.
- 가장 작은 안 (영향이 작은 순):
  1. **코드 없음, 운영 한 번**: 위 확인 뒤 `reconcile-search-profiles.ts` 기본(읽기 전용)으로 대상 건수를 보고, 필요하면 `--apply --retry-empty`로 `repair_version<1`인 354건을 한 번 다시 짓는다. 모델 호출 354건 안팎이다. 다만 `temperature:0`이라 같은 모델·프롬프트·글이면 같은 답일 가능성이 높다. 이미 한 번 한 27건이 그 정황이다. 시험 삼아 이 방법이 통하는 것은 MLX 모델이 만든 82건(지금과 다른 서빙)이다. **[추정]**
  2. **코드 소폭, 동작 변화 없음**: 0개 결과를 센다. `search-health.ts`에 「키워드 0개 프로필」 수를 더하고, 잡 로그에 「모델 원본이 0개」와 「걸러내고 0개」를 나눠 적는다. 알 수 없는 상태를 눈에 보이게 하는 최소 변경이다. 이게 있어야 ②와 ③을 가를 수 있다.
  - ②로 판명되면 프롬프트·모델을 고치고 `repair_version`을 2로 올려 한 번 더 다시 짓는 게이트를 둔다. 해시가 글만 보기 때문에 그냥 프롬프트만 바꿔서는 기존 프로필이 다시 지어지지 않는다(§2.3). 영향 범위는 B 381건과 이후 새 0개다.
  - ③이면 `cleanKeywords`의 이름 동일·길이 규칙 완화다.
- 건강 점검이 경보를 내게 하지는 말 것을 권한다. 0개는 일부가 정상(①)이라 경보 기준을 만들려면 ①~③ 비율을 먼저 알아야 한다.

### C (8건)
- 판정: 저절로 풀리지 않는다. 걸린 제품이 8건뿐이라 급하지 않다.
- 고침: 안 해도 된다. 검수가 전부 뺀 판정이 옳은지만 §5 Q8로 눈으로 보고, 과하게 엄격하다면 검수 프롬프트 문제로 따로 다룬다.

## 5. 대표가 대신 돌릴 운영 읽기 SQL

모두 읽기 전용이다. `begin read only;`로 시작하고 끝에 `rollback;`을 쓴다. 제품 글은 공개 내용이다.

```sql
begin read only;

-- Q1. 프로필 없는 공개 제품을 만든 시각 분포(지금도 줄고 있나). 이 질의를 20~30분 뒤 한 번 더 돌려 같은 시간대 건수가 줄어드는지 본다
select date_trunc('hour', p.created_at) as hour, count(*)
  from products p left join product_search_profiles s on s.product_id = p.id
 where p.status in ('seeded','verified') and s.product_id is null
 group by 1 order by 1;

-- Q2. 최근 12시간 프로필 경로의 장부 상태(시간대별). 정지 구간이 있었는지
select date_trunc('hour', queued_at) as hour, state, count(*)
  from model_capacity_requests
 where route_id = 'product-search-profile' and queued_at > now() - interval '12 hours'
 group by 1, 2 order by 1, 2;

-- Q3. 프로필 없는 제품 50건의 장부 이력(걸림 여부와 후보 구분)
with missing as (
  select p.id, p.slug, p.created_at from products p
    left join product_search_profiles s on s.product_id = p.id
   where p.status in ('seeded','verified') and s.product_id is null
   order by p.id limit 50)
select m.id, m.slug, m.created_at, r.state, r.queued_at, r.dispatched_at, r.settled_at,
       r.terminal_evidence ->> 'kind' as terminal_kind
  from missing m
  left join model_capacity_requests r on r.logical_work_key = 'text:profile:' || m.id
 order by m.id, r.queued_at;

-- Q4. 0개 프로필 표본 25건 — 사람이 글을 보고 ①정상 ②모델 문제를 가른다
select p.id, p.slug, p.name, p.category, left(p.tagline, 120) as tagline, left(p.description, 200) as description,
       left(p.search_topics, 80) as topics, left(p.search_page_text, 300) as page, left(p.search_readme, 200) as readme,
       s.model, s.source_revision, s.generated_at
  from products p join product_search_profiles s on s.product_id = p.id
 where p.status in ('seeded','verified') and p.search_keywords is null
   and jsonb_array_length(s.keywords_en) + jsonb_array_length(s.keywords_ko) = 0
 order by md5(p.id::text) limit 25;

-- Q5. 최근 7일 새로 지은 결과 중 0개 비율(앞으로도 생기는 양) — 모델별
select s.model,
       count(*) as generated,
       count(*) filter (where jsonb_array_length(s.keywords_en) + jsonb_array_length(s.keywords_ko) = 0) as empty
  from product_search_profiles s
 where s.generated_at > now() - interval '7 days' and s.error_code is null
 group by 1;

-- Q6. 전체 프로필 중 0개 비율과 글이 얇은 정도(코드의 thin 기준: 본문<100 이고 README<200)
select (length(coalesce(p.search_page_text,'')) < 100 and length(coalesce(p.search_readme,'')) < 200) as thin,
       jsonb_array_length(s.keywords_en) + jsonb_array_length(s.keywords_ko) = 0 as empty,
       count(*)
  from products p join product_search_profiles s on s.product_id = p.id
 where p.status in ('seeded','verified') and s.error_code is null and not s.needs_refresh
 group by 1, 2 order by 1, 2;

-- Q7. 장부 terminal evidence에 모델 원문이 남는지(B를 ②와 ③으로 갈 수 있나). 키만 본다, 값은 보지 않는다
select jsonb_object_keys(r.terminal_evidence) as evidence_key, count(*)
  from model_capacity_requests r
 where r.route_id = 'product-search-profile' and r.state = 'settled' and r.terminal_evidence is not null
   and r.settled_at > now() - interval '1 hour'
 group by 1;

-- Q8. 검수가 키워드를 전부 뺀 8건 — 뺀 키워드와 글을 사람이 본다
select p.id, p.slug, left(p.tagline, 100) as tagline, s.keywords_en, s.keywords_ko, s.verify_model, s.verified_at
  from products p join product_search_profiles s on s.product_id = p.id
 where p.id in (908, 1680, 4061, 6179, 6980, 8613, 12404, 58180);

rollback;
```

운영 컨테이너에서 읽기 전용 복구 점검(기본값이 읽기 전용이다. `--apply`를 붙이지 않는다): `node --import tsx scripts/reconcile-search-profiles.ts`. 이 점검은 `source_hash` 불일치와 대기열에 넣을 건수를 보여 준다. 다만 이번 원인 B(0개 성공)의 건수는 §5 Q5·Q6가 더 직접적이다.

## 6. 한계

- A가 풀리는지는 이 자료 한 장면(05:4xZ)만으로는 갈리지 않는다. Q1을 두 번 돌려 줄어드는지 보아야 한다.
- B는 「모델이 빈 배열을 낸 것」과 「걸러서 비게 된 것」, 「근거가 없어 정상인 것」을 갈라 낼 수 없었다. 저장된 것이 결과 배열뿐이다.
- 길이 칼럼이 코드의 절단 길이와 달라(최대 2000) thin 비율은 근사다.
- 643건 → 616건(10여 분 사이 27건 감소)은 A가 프로필을 받았기 때문으로 **추정**하지만 확인하지 못했다.
- 운영 DB·앱·설정, 코드, 병합·배포는 건드리지 않았다.
