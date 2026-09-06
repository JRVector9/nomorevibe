# 남은 작업

코드로 끝낼 수 없어 멈춰 있는 것들. 각 항목은 **막고 있는 것**과 **풀렸을 때 할 일**을
그대로 실행할 수 있게 적는다. 끝나면 이 파일에서 지운다.

---

## P0. 첫 프로덕션 배포 — 아직 어디에도 배포돼 있지 않다

**실측(2026-08-29)**: 프로덕션 Dokploy(`deploy.brut.bot`) 14개 프로젝트에 nomorevibe가 없고,
개발 Dokploy(`dev.ahto.city`)에도 없다. `nomorevibe.app`은 A 레코드가 없다(코드의 User-Agent
문자열만 그 주소를 가리킨다). 아래 B1·B2·D1은 전부 **배포가 있다는 전제**로 적혀 있었다 —
프로덕션 스케줄러 등록도, 백필도, CLI 토큰도 붙일 곳이 없다.

**막고 있는 것**: 결정 네 가지. 코드가 아니라 사람이 정할 일이다.

| 결정 | 선택지 | 실측·참고 |
|---|---|---|
| 형태 | (a) Dokploy **Compose**로 `compose.yml`(db+app+scheduler) 통째로 / (b) **Application**(Dockerfile) + 외부 Postgres + Dokploy 스케줄 | 다른 프로젝트 13개는 (b)형, compose는 1개. (a)는 스케줄러가 같이 올라와 B1이 저절로 풀린다 |
| 서버 | m3-ultra · m4-mini · otd-osaka-a1 · worker-edge | `/prod` 스킬은 M3+mini 동시 배포가 관례. 이 앱은 잠금·한도가 DB에 있어 2인스턴스 가능, **스케줄러는 하나**여야 한다 |
| 도메인 | `nomorevibe.app` 보유 여부 → DNS → `NEXT_PUBLIC_SITE_URL` | 없으면 GitHub OAuth 콜백 URL도 못 정한다 |
| DB | Dokploy 안 postgres 서비스 / 공용 PostgreSQL(배포 스킬의 192.168.139.217) | 미디어가 `bytea`로 들어가므로 백업 범위를 같이 정한다(README "제품 근거 수집 운영") |

**정해지면 순서**: 비밀값 생성(`AUTH_SECRET`·`VISITOR_HASH_SECRET`·`CRON_SECRET`·`ADMIN_TOKEN`
각각 `openssl rand -hex 32`, 서로 재사용 금지) → GitHub OAuth 앱(콜백 `<SITE>/api/auth/github/callback`)
→ `GITHUB_TOKEN`(public repo 읽기) → `CLAUDE_CODE_OAUTH_TOKEN`(`claude setup-token`) → 배포 →
`[migrate] 완료` 로그 확인 → B1(스케줄) → B2(고유 유입자 시작) → D1 확인.

**이미지에 CLI는 이미 넣었다** — Dockerfile, 실측 +495MB(322 → 817MB). 부담이면 그 `RUN` 한 줄을
빼면 분류만 규칙으로 떨어진다.

---

## D1. 카테고리 분류 — 프로덕션에서 `claude` CLI가 돌게 하기

**막고 있는 것**: 프로덕션 이미지에 `claude` CLI가 없고, 컨테이너에 로그인 토큰이 없다.

**지금 상태**: 분류는 API가 아니라 `claude -p`로 돈다(`lib/crawl/classify.ts`). API 키는 쓰지
않는다. 개발 머신에서는 keychain 로그인으로 그대로 돌고 **실측을 마쳤다**(아래). 프로덕션에서는
CLI가 없어 `crawl.classify_disabled { reason: "no_cli" }`가 한 번 남고 키워드 규칙으로 떨어진다.
즉 **아래 두 가지를 넣기 전까지 프로덕션에서 새로 발행되는 제품은 계속 규칙으로 분류된다.**

```
실행      claude -p --output-format json --json-schema <5카테고리> --tools "" --max-turns 1
          --no-session-persistence --model claude-sonnet-5 --effort high --system-prompt <주입 방어 포함>
          (CLAUDE_CODE_OAUTH_TOKEN 이 있으면 --bare 추가 — keychain 대신 토큰으로)
cwd       빈 임시 디렉터리 — 프로젝트 CLAUDE.md 가 프롬프트에 섞이지 않게
timeout   15초, 재시도 0회   (발행 잡의 틱 예산이 25초다)
출력      structured_output 을 zod 로 다시 검증 — 5개 카테고리 중 하나 + 근거 한 줄
실패 시   null → 호출부가 토픽·설명 키워드 규칙으로 되돌아간다
```

### 실측 — 2026-08-29, 개발 DB에 발행된 32건의 원본, sonnet · effort high

| | |
|---|---|
| 성공 | 32/32 — 4병렬 첫 실행에서 1건이 15초에 걸렸고, 단독 재실행은 11.2초에 성공 |
| 소요 | 단독 6.2초 · 4병렬 평균 10.3초, 최대 14.7초. 병렬이면 늘어난다. 발행 잡은 순차라 단독 값이 기준 |
| 출력 토큰 | 473 (생각 288) |
| codex 백필과 일치 | 26/31 (**83%**) — 앞서 codex↔qwen 일치율은 75%였다 |
| RevealUI | **Productivity** — 규칙은 Finance로 틀렸던 그 케이스 |

분포: Productivity 15 · Dev 13 · Finance 2 · Design 1 · Other 1 (codex 백필: 13·11·4·1·3).
불일치 5건은 전부 codex가 Finance/Other로 보낸 것을 CLI가 Productivity/Dev로 본 것이고, 프롬프트의
"결제 기능이 있다는 이유로 Finance를 고르지 않는다"와 맞는 방향이다. **개발 DB에는 CLI 결과를
반영했다.** 되돌릴 값은 이 실측 전 codex 분포뿐이므로 다시 재지 말 것.

응답 처리 경로는 `tests/classify.test.ts`가 붙들고 있다 — 구조화 출력, 허용 밖 카테고리, 로그인
풀림(`auth`)과 그 밖 실패의 구분, JSON 아닌 출력, 타임아웃, CLI 없음(한 번만 알림), 보내는 인자.

### 프로덕션에서 풀려면

1. **이미지에 CLI**: 넣었다(Dockerfile runner 단계). 실측 322MB → 817MB, 컨테이너 안에서
   `claude --version` 2.1.251 확인.
2. **토큰**: 로그인된 개발 머신에서 `claude setup-token` → 배포 비밀 저장소의 `CLAUDE_CODE_OAUTH_TOKEN`.
   값이 있으면 분류기가 `--bare`로 띄운다(keychain 없이 토큰만으로). 값은 로그·문서에 남기지 않는다.
3. **확인**: `crawl-publish` 뒤 로그에 `crawl.classified { repo, category, reason }`가 남고
   `crawl.classify_disabled`가 없는지. `crawl.classify_failed { reason: "auth" }`면 토큰이 풀린 것이다.

**로컬 배포에서 확인한 것(2026-08-29)**: 이미지에 CLI가 들어갔고 컨테이너 안에서
`claude --version` 2.1.251이 돈다. 토큰 없이 발행하면 131건 전부
`crawl.classify_failed { reason: "auth", message: "Not logged in" }`을 남기고 **키워드 규칙으로
떨어져 발행은 그대로 진행된다** — 폴백 경로는 검증됐다. 남은 것은 토큰을 넣었을 때 실제로
분류가 되는지뿐이다.

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
*/1 * * * *   product-evidence-refresh 공식 출처·업데이트·내부 미디어의 due 항목 갱신
*/1 * * * *   agent-evidence-refresh 공개 에이전트 근거의 due 항목·partial 재개
```

표기는 **다섯 칸(분 시 일 월 요일)**이다. 초를 앞에 받는 스케줄러에서는 형식을 변환해야 한다. evidence 잡은 매분 호출하되
출처별 due 시각(일반 저장소/에이전트 완료 스캔 기본 24시간)이 실제 외부 요청을 제한한다.

`ranking-refresh`는 `click-rollup` 뒤에 실행해야 한다. 이유는 정책마다 다르다.

- `valid-visits-v1`(현재 기본): 시즌 점수를 `product_click_daily`에서 읽는다. rollup이 아직
  안 돌았으면 그 시간의 클릭이 빠진 채로 스냅샷이 잡힌다.
- `unique-visitors-v1`: 원천 `click_events`를 직접 읽는다(날짜별 고유 수는 더할 수 없다).
  이쪽은 rollup의 산출물이 아니라 rollup이 함께 하는 **원천 정리**에 걸린다 — 35일이 지난
  원천을 지우는 것도 같은 잡이다.

**정시/5분으로 나눠 등록하는 것은 순서를 보장하지 않는다.** `click-rollup`이 5분을 넘기면
`ranking-refresh`가 한 시간 전 집계를 보고 스냅샷을 잡는다. 치명적이지는 않다 — 다음 시간에
바로잡힌다. 순서를 확실히 하려면 로컬 스케줄러(`scripts/scheduler.sh`)처럼 한 번의 호출에서
`click-rollup`을 기다린 뒤 `ranking-refresh`를 부르는 편이 낫다. 두 잡은 이름이 달라 러너의
잠금이 서로를 막아주지 않는다.

위 프로덕션 스케줄이 없다고 추정하지 말고, 실제 등록 상태를 확인한 뒤 누락된 항목만 등록한다.

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
| `CLAUDE_CODE_OAUTH_TOKEN` + 이미지의 `claude` CLI | 카테고리가 규칙 분류로 떨어진다 (D1 참고) |
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
목록이 그렇게 반영된다. `builder`(추정 AI)·`kind`(신호 종류)·`vibe-coding 토픽` 신호도 같은
길로 들어온다 — 어긋남 표시 "추정 AI"·"검색 신호"가 짚어준다. 빈 행에 적어 저장하면 신호를
더할 수 있다.

**배포 후 백필 두 건 — 마이그레이션은 컬럼만 더한다.** 프로덕션에 이미 쌓인 행에는 "만든 AI"
추정이 비어 있다. 라벨이 기본값 그대로일 때만 아래가 맞고, 운영자가 라벨을 바꿨으면 그 라벨로
맞춘다. 읽기 전용으로 건수를 먼저 확인한 뒤 실행한다.

```sql
-- 프론티어: 앞으로 발행될 후보의 추정 (0018 이후 NULL)
update crawl_frontier set builder = case signal
  when 'Claude 커밋 트레일러' then 'Claude'
  when 'Codex 커밋 트레일러' then 'Codex' end
where builder is null;

-- 이미 발행된 미클레임 제품의 추정
update products p set builder = f.builder, updated_at = now()
from crawl_candidates c join crawl_frontier f on f.repo = c.repo
where c.published_slug = p.slug and p.source = 'crawler' and p.claimed_at is null
  and p.builder is null and f.builder is not null;
```

---

## B2. 프로덕션 고유 유입자 수집 시작 및 전환 확인

**막고 있는 것**: 프로덕션 비밀 저장소·데이터베이스·배포 환경 접근과 배포 승인. 이 작업에서는
코드와 로컬 검증만 했으며, **프로덕션 마이그레이션 적용·비밀키 설정·수집 시작·7일 경과·정책
예약을 확인하지 않았다.**

**지금 상태**: `0013_unique_visits.sql`은 기존 이벤트와 시즌을 유지하는 가산 마이그레이션이다.
`visit_collection_state.unique_visitor_started_at`은 마이그레이션 때 `NULL`로 두고, 유효한
`VISITOR_HASH_SECRET`으로 `/go/<slug>` 요청의 HMAC을 처음 만들 수 있을 때 DB 시각으로 한 번만
채운다. 따라서 코드 배포나 마이그레이션 시각을 수집 시작 시각으로 간주하면 안 된다.

### 로컬 배포에서 이미 확인한 것 — 다시 재지 말 것

2026-08-29, `docker compose`로 띄운 배포 형태(앱+DB+스케줄러)에서 **작동 원리는 전부 밟았다.**
프로덕션에서 남은 것은 아래 "배포 순서"의 환경 고유 단계(비밀값 주입·마이그레이션 적용 확인·
수집 시작 시각 기록·7일 경과)뿐이다.

| 확인한 것 | 결과 |
|---|---|
| `/go/<slug>` 첫 방문이 `unique_visitor_started_at`을 채운다 | 채워짐. 그 전에는 NULL |
| `visitor_hash` 길이 | 64자 |
| 같은 브라우저·같은 제품 10분 재방문 | 기록 안 됨 (중복 제거 동작) |
| 같은 브라우저·**다른 제품** | 기록되며 **해시가 다르다** — 제품별 HMAC이 실제로 분리된다 |
| 다른 브라우저·같은 제품 | 별도 기록 |
| 봇 User-Agent(Slackbot) | 이동은 되고 기록은 안 됨 |
| `click-rollup` | `product_click_daily`에 유효 방문과 **고유 수**가 함께 남는다 (예: 유효 2 / 고유 2) |
| 중복 제거 키 | `rate_limits`의 `visit:<slug>:<hash>` — 제품×방문자마다 하나 |
| `ranking-refresh` | 시즌 스냅샷 갱신. `ranking_entries`는 0 — 검증된 제품만 참가하므로 맞다 |

즉 프로덕션에서 새로 확인할 것은 **"이 환경에서도 같은 일이 일어나는가"**이지 동작 자체가 아니다.

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
