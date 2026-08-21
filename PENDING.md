# 남은 작업

코드로 끝낼 수 없어 멈춰 있는 것들. 각 항목은 **막고 있는 것**과 **풀렸을 때 할 일**을
그대로 실행할 수 있게 적는다. 끝나면 이 파일에서 지운다.

---

## D1. 카테고리 분류를 실제로 호출해 확인하기

**막고 있는 것**: `ANTHROPIC_API_KEY`. 이 머신에 키도 `ant` 프로필도 없다.

**지금 상태**: 코드는 있고(`lib/crawl/classify.ts`) 키가 없으면 조용히 규칙 분류로 떨어진다.
즉 **키를 넣기 전까지 새로 발행되는 제품은 계속 키워드 규칙으로 분류된다.**

```
모델      claude-sonnet-5
effort    high
max_tokens 4096   (생각한 만큼도 출력 한도에서 나간다 — 작게 두면 답 전에 잘린다)
timeout   12초, 재시도 0회   (발행 잡의 틱 예산이 25초다)
출력      zod 구조화 출력으로 5개 카테고리 중 하나 + 판단 근거 한 줄
실패 시   null → 호출부가 토픽·설명 키워드 규칙으로 되돌아간다
```

### 이미 확인한 것 — 다시 재지 말 것

API 자리에 로컬 서버를 세워 SDK가 실제로 주고받는 경로를 그대로 태웠다. **키가 필요한
것은 모델의 판단뿐이고, 응답을 다루는 쪽은 전부 밟아봤다.** 결과는 `tests/classify.test.ts`가
붙들고 있으니 고치다 무너지면 거기서 잡힌다.

| 들어온 응답 | 결과 | 남는 로그 |
|---|---|---|
| 정상 구조화 출력 | 카테고리 | `crawl.classified` |
| 생각 블록 + 답 | 카테고리 | `crawl.classified` |
| 허용 밖 카테고리 | null | `crawl.classify_failed` |
| 한도에 걸려 잘림 | null | `crawl.classify_failed` |
| 답 블록 없음 | null | `crawl.classify_unparsed` |
| 401 / 429 / 500 | null | `reason: auth` / `rate_limit` / 오류 객체 |
| 12초 초과 | null | 정확히 12,001ms에 끊김, 요청 1건(재시도 없음) |

보내는 요청도 확인했다 — `model`, `max_tokens: 4096`, `output_config.effort: "high"`,
`json_schema` 형식, 시스템 프롬프트의 주입 방어 문장이 그대로 실려 나간다.

**알아둘 것: enum은 서버까지 가지 않는다.** 이 API가 받는 JSON Schema는 부분집합이라
SDK(`transform-json-schema.js`)가 `enum`·`maxLength` 같은 키워드를 `description` 안의
문자열로 옮긴다. 그래서 카테고리를 다섯 개로 묶어두는 것은 **시스템 프롬프트와 응답을 받은
뒤의 zod 검증뿐이다.** 스키마에 제약을 더 걸어도 강제되지 않는다는 뜻이다.

이 과정에서 결함을 하나 고쳤다 — `reason`에 걸려 있던 `.max(200)`이 서버에서 강제되지
않는 탓에, 모델이 두 문장을 쓰면 멀쩡한 카테고리까지 버려지고 키워드 규칙으로 되돌아갔다.
로그용 값이 분류를 무르게 둘 이유가 없어 제약을 걷고 남길 때 자른다.

### 키가 생기면 확인할 것

남은 것은 둘뿐이다. 실제 모델을 불러야만 알 수 있다.

1. **판단 품질** — 아래 codex 결과와 얼마나 겹치는지. 특히 `RevealUI`를 `Productivity`로
   보는지(규칙은 `Finance`로 틀렸다).
2. **effort: high에서 실제 소요 시간과 출력 토큰** — 12초와 4096이 충분한지. 잘리면 위 표의
   "한도에 걸려 잘림"으로 떨어져 분류가 통째로 버려진다.

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local   # .env.local은 gitignore된다

# 후보를 되돌려 재발행 (개발 DB)
#   crawl_candidates를 state='new'로, 해당 products 행을 지운 뒤
npm run job crawl-judge
npm run job crawl-publish

# 로그에서 확인
#   crawl.classified   { repo, category, reason }   ← 성공
#   crawl.classify_failed { reason: auth | rate_limit | ... }
#   crawl.classify_disabled { reason: no_api_key }  ← 키가 없을 때 한 번만
```

### 이미 알고 있는 것 (다시 재지 말 것)

키가 없어 같은 프롬프트를 다른 모델로 태워 **접근이 규칙보다 낫다는 것은 확인했다.**

| | 규칙 | codex (gpt-5.5 high) | qwen3.5-122b |
|---|---|---|---|
| Productivity | 0 | 13 | 11 |
| Dev | 9 | 11 | 7 |
| Finance | 2 | 4 | 2 |
| Design | 2 | 1 | 0 |
| Other | **19** | 3 | 4 |

- 규칙은 `Productivity`를 **한 건도 못 골랐다**. 제품 소개가 `todo`·`note` 같은 키워드를
  쓰지 않아 업무 도구가 전부 `Other`로 떨어졌다.
- 대표적 오분류: `RevealUI` — 소개에 `Payments`가 있다는 이유로 `Finance`가 됐다.
  두 모델 모두 `Productivity`(업무 운영 도구)로 바로잡았다.
- 두 모델의 일치율 75%. qwen은 32건 중 8건에서 JSON 형식을 못 지켰다 — 우리가 구조화
  출력을 강제한 이유가 여기서 드러난다.
- **개발 DB의 seeded 제품 32건은 codex 결과로 이미 백필돼 있다.** 실측 후 비교 대상으로 쓸 것.

---

## B1. 프로덕션 스케줄러 확인 및 필요 시 등록

**막고 있는 것**: 운영 환경(Dokploy) 접근과 변경 승인. 이 작업에서는 프로덕션 스케줄 목록과
실행 이력을 읽지 않았다.

**지금 상태**: cron 진입점(`POST /api/cron/<job>`)과 로컬 배포용 스케줄러
(`scripts/scheduler.sh`, compose의 `scheduler` 서비스)는 있다. 프로덕션 등록 여부는
**확인하지 않았다**. 중복 등록하지 않도록 플랫폼 스케줄과 `/admin/status` 실행 이력을 먼저
읽고, 누락된 작업만 추가해야 한다.

### 확인 후 누락됐으면 등록할 주기

```
*/1  * * * *   crawl-fetch     레포 조회 5000회/시간, 한 틱 30건 남짓
*/5  * * * *   crawl-judge     계산만 한다
*/5  * * * *   crawl-publish   판정 직후에 돌아야 바로 목록에 오른다
*/15 * * * *   crawl-seed      검색 30회/분, 프론티어는 한 번 차면 오래간다
*/10 * * * *   uptime-ping     같은 제품은 6시간에 한 번만 본다
0 * * * *   click-rollup       KST 일별 클릭 집계
5 * * * *   ranking-refresh    시즌 경계·쿨다운·공개 순위 스냅샷
1 */6 * * * * product-evidence-refresh 공식 출처·업데이트·내부 미디어 갱신
```

`ranking-refresh`는 반드시 `click-rollup`이 끝난 뒤 실행해야 한다. 위 프로덕션 스케줄이
없다고 추정하지 말고, 실제 등록 상태를 확인한 뒤 누락된 항목만 등록한다.

각 호출은 이 형태다.

```bash
curl -X POST $SITE/api/cron/<job> -H "Authorization: Bearer $CRON_SECRET"
```

겹쳐 호출해도 안전하다 — 러너가 이름별 잠금을 걸어 중복 실행을 건너뛴다.

### 필요한 환경변수

| 변수 | 없으면 |
|---|---|
| `CRON_SECRET` | cron 진입점이 항상 403 |
| `GITHUB_TOKEN` | 시간당 60회라 seed·fetch가 성립하지 않는다 (`jobs.last_error`에 남는다) |
| `ANTHROPIC_API_KEY` | 카테고리가 규칙 분류로 떨어진다 (D1 참고) |
| `TRUSTED_PROXY_HOPS` | **0이면 rate limit이 전역으로 묶인다.** 프록시 뒤라면 hop 수를 맞출 것 |

### 확인

`/admin/status`의 작업 표에서 마지막 실행·성공 시각이 갱신되는지 본다. "실행 기록 없음"은
스케줄러가 아직 닿지 않았다는 뜻이고, 마지막 성공만 오래됐다면 그 아래 오류를 본다.

`product-evidence-refresh`도 이 작업에서 코드와 로컬 루프에 추가했으며 **프로덕션 등록 여부는
확인하지 않았다.** 기존 등록을 확인하고, 없으면 등록한 뒤 검증된 제품 하나에 공식 GitHub
링크를 선언해 다음을 확인한다.

1. 배포 비밀 저장소의 `GITHUB_TOKEN`으로 GitHub API 인증 요청이 실제 200인지 확인한다. 토큰
   값이나 Authorization 헤더는 출력하지 않는다.
2. 강제 단일 제품 갱신은 README의 `refreshProductEvidence(slug, { force: true })` 명령으로 한 번
   실행하고, `product_evidence_sources.last_success_at`과 `normalized_facts`가 채워지는지 본다.
3. 예약 호출 뒤 `/admin/status`의 `product-evidence-refresh` 마지막 실행·성공 시각이 갱신되고,
   구조화 로그에 출처 종류·slug·소요 시간·성공/실패·변경 수만 남는지 확인한다.
4. 토큰을 제거하거나 폐기하지 말고 별도 시험 환경에서 잘못된 토큰으로 실패 분기를 확인한다.
   마지막 정상 facts가 보존되고 `last_error_code`/`next_attempt_at`만 전진해야 한다.
5. DB 백업과 복구 표본에 `media_assets.web_data`·`thumbnail_data`가 포함되는지, 미디어 증가분을
   감당할 볼륨·WAL·보존 기간인지 확인한다.

### 함께 해야 할 일

**배포 환경의 크롤 설정이 옛 값으로 돌고 있을 수 있다.** 설정은 데이터라 한 번 저장하면
코드 기본값을 덮는다. `/admin`이 어긋난 항목을 짚어주고 "기본값으로 되돌리기" 버튼을 둔다
(수집 스위치는 건드리지 않는다). 조직 계정 제외 해제·Codex 신호·차단 도메인·문서 생성기
목록이 그렇게 반영된다.

---

## B2. 프로덕션 고유 유입자 수집 시작 및 전환 확인

**막고 있는 것**: 프로덕션 비밀 저장소·데이터베이스·배포 환경 접근과 배포 승인. 이 작업에서는
코드와 로컬 검증만 했으며, **프로덕션 마이그레이션 적용·비밀키 설정·수집 시작·7일 경과·정책
예약을 확인하지 않았다.**

**지금 상태**: `0013_unique_visits.sql`은 기존 이벤트와 시즌을 유지하는 가산 마이그레이션이다.
`visit_collection_state.unique_visitor_started_at`은 마이그레이션 때 `NULL`로 두고, 유효한
`VISITOR_HASH_SECRET`으로 `/go/<slug>` 요청의 HMAC을 처음 만들 수 있을 때 DB 시각으로 한 번만
채운다. 따라서 코드 배포나 마이그레이션 시각을 수집 시작 시각으로 간주하면 안 된다.

### 배포 순서

1. 비밀 저장소에서 다른 용도로 재사용하지 않을 값을 생성한다.

   ```bash
   openssl rand -hex 32
   ```

   결과를 프로덕션 `VISITOR_HASH_SECRET`에 넣는다. `ADMIN_SESSION_SECRET`, `CRON_SECRET`,
   수정 토큰용 키와 같은 값을 쓰지 않는다. 평문 값을 문서·로그·명령 기록에 복사하지 않는다.

2. 새 이미지를 배포한다. 컨테이너 `scripts/entrypoint.sh`가 서버 시작 전에 마이그레이션을
   적용하므로 로그에서 `[migrate] 완료` 뒤에 서버가 시작됐는지 확인한다. 운영 DB에서 다음
   구조가 실제로 생겼는지도 읽기 전용으로 확인한다.

   ```sql
   select column_name
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'click_events'
     and column_name = 'visitor_hash';

   select id, unique_visitor_started_at
   from visit_collection_state
   where id = 1;
   ```

   첫 정상 방문 전 두 번째 쿼리의 시각은 `NULL`이어야 한다. 기존 `click_events`의
   `visitor_hash`도 억지로 채우지 않는다.

3. 공개된 실제 제품 하나를 새 1st-party 쿠키로 `/go/<slug>`를 통해 방문한다. 리다이렉트가
   정상인지 확인한 뒤 운영 DB에서 다음을 확인한다. 원본 쿠키, IP, User-Agent, 해시 본문은
   로그에 출력하지 않는다.

   ```sql
   select id, unique_visitor_started_at is not null as started
   from visit_collection_state
   where id = 1;

   select slug, length(visitor_hash) as hash_length
   from click_events
   where visitor_hash is not null
   order by occurred_at desc
   limit 1;
   ```

   `started=true`, `hash_length=64`인지 확인하고 시작 시각을 배포 기록에 남긴다. 이것이 7일
   준비 기간의 기준이다. `/admin/ranking`에서 그 전에는 `집계 중`이고 고유 기준 예약이
   거절되는지, 정확히 7일 뒤 준비 상태로 바뀌는지 확인한다.

4. B1의 프로덕션 스케줄을 실제 등록하고 `/admin/status`에서 `click-rollup`과
   `ranking-refresh`의 마지막 실행·성공 시각이 매시간 갱신되는지 확인한다. `click-rollup`을
   정시에, `ranking-refresh`를 그 뒤(현재 제안은 매시 5분)에 실행한다. 하루가 지난 뒤
   `product_click_daily.unique_visitors`가 채워지는지도 확인하되, 여러 날짜의 값을 합쳐
   여러 날의 고유 유입자로 해석하지 않는다.

5. 수집 시작 후 7일이 모두 지난 다음에만 고유 기준 정책을 예약한다. 예약이 현재 시즌을
   바꾸지 않고 다음 자연 시즌 경계에 적용되는지, 이전 시즌과 전체 기간 보드가 각각
   `유효 방문`·`누적 유효 방문` 표기를 유지하는지 확인한다.

### 비밀키 교체 시 주의

키를 교체하면 같은 브라우저도 새 해시가 되어 교체 전후가 한 집계 구간에 겹칠 때 둘로 셀 수
있고 10분 중복 제거도 초기화된다. 원본 쿠키를 저장하지 않으므로 과거 해시를 새 키로 변환할 수
없다. 유출 대응이 아니라면 일상적으로 교체하지 말고, 불가피하면 교체 시각과 영향을 기록한 뒤
7일 준비 상태와 다음 시즌 예약을 다시 검토한다.
