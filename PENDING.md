# 남은 작업

코드로 끝낼 수 없어 멈춰 있는 것들. 각 항목은 **막고 있는 것**과 **풀렸을 때 할 일**을
그대로 실행할 수 있게 적는다. 끝나면 이 파일에서 지운다.

---

## P0. 첫 프로덕션 배포 — 운영 대상 미확정

**현재 상태(2026-09-08)**: 운영 서버·도메인·DB 구성이 확정되지 않아 이번 독립 워커 릴리스를
생산 환경에 배포하지 않았다. 로컬 Compose 검증과 운영 배포를 구분한다. 2026-08-29의
Dokploy 프로젝트 수·DNS 조회 결과는 과거 기록이며 현재 배포 유무의 증거로 재사용하지 않는다.

**막고 있는 것**: 아래 환경 결정과 운영 비밀값 설정.

| 결정 | 확인할 내용 |
|---|---|
| 형태 | 현재 Compose의 웹·scheduler·crawler·reviewer·publisher·maintenance 및 일회성 migrate. 외부 DB를 쓰더라도 각 소비 역할은 필요함 |
| 서버 | 역할당 워커 1개로 시작할 호스트, CPU/RAM·DB·백업 여유. 웹 복제본 추가 시 DB pool 예산을 함께 계산 |
| 도메인 | 보유 도메인·DNS·프록시·`NEXT_PUBLIC_SITE_URL`·GitHub OAuth 콜백 |
| DB | 운영 PostgreSQL 연결·접근 제어·미디어 bytea를 포함한 백업과 복구 |

**정해지면 순서**: 환경별 비밀값 생성 → GitHub OAuth/수집 자격 정보·장기 CLI OAuth 토큰 설정
→ 이미지 빌드 → 기존 소비자 stop/drain → migration 종료 코드 0 확인 → 웹·역할별 워커 시작
→ B1(독립 운영 확인) → B2(고유 유입자 시작) → D1(운영 CLI 확인).
정확한 명령은 [독립 워커 운영 절차](docs/operations/independent-workers-runbook.md)를 따른다.
`AUTH_SECRET`·`VISITOR_HASH_SECRET`·`CRON_SECRET`·`ADMIN_TOKEN`은 서로 다른 값을 사용한다.

CLI `2.1.263`은 Dockerfile **worker target**에 들어 있으며 웹 runner에는 없다.
CLI 제거는 카테고리 폴백뿐 아니라 신규 AI 리뷰 실행에도 영향을 주므로 운영 장애 대응으로 제거하지 않는다.

---

## D1. 카테고리·AI 리뷰 — 운영용 Claude CLI 인증과 모델 확인

**막고 있는 것**: 운영 대상과 장기 `CLAUDE_CODE_OAUTH_TOKEN`이 아직 설정되지 않았다.

**현재 상태(2026-09-08)**: 로컬의 짧은 수명 OAuth 토큰으로 worker 이미지 안의 실제 CLI 인증과
구조화 심사 응답을 확인했다. 이 결과는 생산 환경의 장기 인증이나 24시간 운영 검증을 대신하지 않는다.
카테고리 분류는 `lib/crawl/classify.ts`의 `claude-sonnet-5`, 신규 리뷰는 기본값 없는
`CRAWL_REVIEW_MODEL`을 사용한다. 리뷰 모델은 운영 자격 정보의 접근 가능 여부를 확인한 뒤 명시한다.

```text
카테고리  claude -p / structured output / tools 비활성 / max-turns 1
          claude-sonnet-5 / effort high / safe-mode / 15초 / 재시도 0회
리뷰      명시한 CRAWL_REVIEW_MODEL / effort low / safe-mode / 20초 / 한 tick AI 호출 최대 1개
인증      개발 keychain 로그인 또는 주입한 CLAUDE_CODE_OAUTH_TOKEN
실패      카테고리는 키워드 폴백. 리뷰는 보류·제한 재시도이며 enforce의 승인 조건을 우회하지 않음
```

현재 CLI에서 `--bare`는 OAuth도 건너뛴다. 운영 코드와 동일한 `--safe-mode`로 인증을 확인한다.
토큰 값·Authorization 헤더·인증 응답 본문은 문서와 로그에 남기지 않는다.

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

1. 준비한 worker 이미지 안에서 `claude --version`이 고정 버전 `2.1.263`인지 확인한다.
2. `claude setup-token`으로 발급한 장기 토큰을 운영 비밀 저장소에 저장하고 reviewer/publisher에만
   주입한다. 로컬의 짧은 수명 시험 토큰을 그대로 운영 인증으로 채택하지 않는다.
3. 카테고리 분류와 명시한 리뷰 모델의 실제 구조화 응답·시간 제한을 격리된 후보로 확인한다.
   카테고리 로그의 `crawl.classified`와 인증 실패 여부를 확인하고, 리뷰 실패를 자동 거절로 처리하지 않는다.
4. 모든 reviewer/publisher에 B 릴리스가 적용된 것을 확인한 뒤 웹 `CRAWL_REVIEW_READY=true`를
   주입한다. `/admin/review`에서 사유와 함께 `off → observe → 판정 비교 → enforce`로 전환한다.
   `off`는 AI 발행 보호 해제이므로 enforce 운영 장애 때 자동으로 낮추지 않는다.

**과거 로컬 검증(2026-08-29)**: 이전 runner 이미지의 CLI `2.1.251`과 카테고리 인증 실패 시
키워드 폴백을 확인했다. 당시 이미지 322 → 817MB 측정은 현재 분리 이미지의 크기나 메모리 예산이 아니다.

---

## B1. 프로덕션 독립 스케줄러·워커 전환과 운영 확인

**막고 있는 것**: P0의 운영 대상·DB·비밀값 확정. 로컬 구현과 검증은 생산 배포 완료가 아니다.
문서 갱신 시점에는 웹 중지 30분 관측이 진행 중이며 24시간 관측은 수행하지 않았다.
완료 기록은 [운영 절차](docs/operations/independent-workers-runbook.md)와 릴리스 보고서에 별도로 남긴다.

### 전환할 실행 구성

- DB scheduler는 10초마다 `lib/jobs/catalog.ts`의 예정 시각을 확인해 요청을 접수한다.
- crawler·reviewer·publisher·maintenance는 역할당 1개씩, 기본 5초 poll로 접수된 작업을 소비한다.
- 기존 HTTP 스케줄·evidence wrapper·수동 루프는 stop/drain 후 교체한다. 웹 컨테이너와
  HTTP 스케줄만 배포하면 요청을 처리할 소비자가 없으므로 충분하지 않다.
- `crawl-fetch`, 두 evidence 잡, `crawl-agent-review`는 1분, judge/publish는 5분,
  seed는 15분, uptime은 10분, click-rollup은 1시간 요청 주기다. 완료 시각을 보장하지 않는다.
- `ranking-refresh`는 독립 주기가 없다. `click-rollup`의 `done=true` 성공 완료 트랜잭션에서만
  후속 정기 요청을 생성한다. 예전 매시 5분 HTTP 등록은 제거한다.
- 두 evidence 잡은 출처 due/쿨다운을 확인하며, 일반 저장소·에이전트 완료 스캔의 기본 간격은 24시간이다.

기존 실행 프로세스를 확인한 뒤 운영 절차의 **stop/drain → migration → 역할 시작**을 수행한다.
`POST /api/cron/<job>`는 인증된 호환 접수 API이며 HTTP 202는 실행 완료를 뜻하지 않는다.
독립 scheduler는 `CRON_SECRET`이나 웹 접근을 필요로 하지 않는다.

### 필요한 환경변수

| 변수 | 사용하는 역할과 미설정 영향 |
|---|---|
| `DATABASE_URL` | 웹·모든 워커·migration에 필요 |
| `CRON_SECRET` | 웹의 호환 cron 접수 인증. 미설정이면 403 |
| `GITHUB_TOKEN` | crawler의 GitHub 요청. 없으면 seed·fetch 실패 |
| `CLAUDE_CODE_OAUTH_TOKEN` | reviewer/publisher. 카테고리는 폴백, 리뷰 오류는 보류·제한 재시도 |
| `CRAWL_REVIEW_MODEL` | reviewer의 명시적 모델. 기본값 없음 |
| `CRAWL_REVIEW_READY` | 웹 모드 변경 준비 플래그. true여야 observe/enforce 전환 가능 |
| `TRUSTED_PROXY_HOPS` | 웹 프록시 환경의 클라이언트 IP 판별. 실제 hop 수에 맞춤 |

### 확인

`/admin/status`에서 scheduler·worker 생존과 요청/처리 버전·성공/실패·다음 대기를 함께 본다.
실행 기록이 없으면 접수 누락인지, 소비자 중단인지, 설정 비활성인지 구분한다.

1. crawler 자격 정보의 GitHub 응답을 확인하고 토큰 값이나 Authorization 헤더는 출력하지 않는다.
2. `/admin/products/<slug>`의 강제 갱신으로 접수한 요청 버전과 최종 완료 상태를 비교한다.
   `product_evidence_sources.last_success_at`과 `normalized_facts` 갱신, 최근 미디어 재확인도 점검한다.
3. 예약된 evidence 작업과 집계 작업의 실행·성공 시각 및 진행점을 확인한다. heartbeat만 늘어난 것을
   실제 수집 성공으로 세지 않는다. 웹 중지와 scheduler 중지를 별도로 관측한다.
4. 인증 실패는 별도 시험 환경에서 확인한다. 마지막 정상 facts가 보존되고 오류/재시도 시각만
   바뀌는지 확인하며, 운영 토큰을 의도적으로 폐기하지 않는다.
5. DB 백업·복구 표본에 `media_assets.web_data`·`thumbnail_data`가 포함되고 볼륨·WAL·보존 기간에
   여유가 있는지 확인한다.
6. 24시간 동안 모드·모델·재시작·잡 진행·API 대기·RSS·DB 연결을 기록한다. 운영 관측을 완료하기 전
   24시간 안정성이 검증됐다고 보고하지 않는다.

### 함께 해야 할 일

저장된 크롤 설정은 코드 기본값을 덮으므로 `/admin`의 차이 표시를 보고 의도한 정책인지 확인한다.
설정 초기화는 현재 수집 스위치와 리뷰 모드를 보존한다. 리뷰 모드는 별도 사유·현재 값 비교로 변경한다.

이전 문서의 검색 신호 → `crawl_frontier.builder` → `products.builder` 일괄 백필 SQL은 제거했다.
검색어·토픽·발견 라벨은 제작 도구나 모델의 사용 증명이 아니므로 그 값으로 빈 제작 AI를 채우지 않는다.
필요한 근거는 공개 저장소 수집 결과로 확인하며 메이커 신고·숨김·삭제 의도를 보존한다.

---

## B2. 프로덕션 고유 유입자 수집 시작 및 전환 확인

**막고 있는 것**: P0의 운영 대상·데이터베이스·비밀값 확정과 적용. 이 작업에서는
코드와 로컬 검증만 했으며, **프로덕션 마이그레이션 적용·비밀키 설정·수집 시작·7일 경과·정책
예약을 확인하지 않았다.**

**지금 상태**: `0013_unique_visits.sql`은 기존 이벤트와 시즌을 유지하는 가산 마이그레이션이다.
`visit_collection_state.unique_visitor_started_at`은 마이그레이션 때 `NULL`로 두고, 유효한
`VISITOR_HASH_SECRET`으로 `/go/<slug>` 요청의 HMAC을 처음 만들 수 있을 때 DB 시각으로 한 번만
채운다. 따라서 코드 배포나 마이그레이션 시각을 수집 시작 시각으로 간주하면 안 된다.

### 과거 로컬 배포 검증 — 2026-08-29

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

   결과를 프로덕션 `VISITOR_HASH_SECRET`에 넣는다. `AUTH_SECRET`, `CRON_SECRET`,
   수정 토큰용 키와 같은 값을 쓰지 않는다. 평문 값을 문서·로그·명령 기록에 복사하지 않는다.

2. 운영 절차대로 기존 소비자를 stop/drain한 뒤 별도 `migrate` 서비스를 한 번 실행한다.
   종료 코드 0을 확인하고 새 웹·워커를 시작한다. entrypoint는 마이그레이션을 실행하지 않는다.
   운영 DB에서 다음 구조가 실제로 생겼는지도 읽기 전용으로 확인한다.

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

4. B1의 독립 scheduler와 maintenance를 운영하고 `/admin/status`에서 `click-rollup`의
   완료 뒤 `ranking-refresh` 요청·실행이 이어지는지 확인한다. ranking은 별도 정기 등록하지 않는다.
   하루가 지난 뒤 `product_click_daily.unique_visitors`가 채워지는지도 확인하되, 여러 날짜의 값을 합쳐
   여러 날의 고유 유입자로 해석하지 않는다.

5. 수집 시작 후 7일이 모두 지난 다음에만 고유 기준 정책을 예약한다. 예약이 현재 시즌을
   바꾸지 않고 다음 자연 시즌 경계에 적용되는지, 이전 시즌과 전체 기간 보드가 각각
   `유효 방문`·`누적 유효 방문` 표기를 유지하는지 확인한다.

### 비밀키 교체 시 주의

키를 교체하면 같은 브라우저도 새 해시가 되어 교체 전후가 한 집계 구간에 겹칠 때 둘로 셀 수
있고 10분 중복 제거도 초기화된다. 원본 쿠키를 저장하지 않으므로 과거 해시를 새 키로 변환할 수
없다. 유출 대응이 아니라면 일상적으로 교체하지 말고, 불가피하면 교체 시각과 영향을 기록한 뒤
7일 준비 상태와 다음 시즌 예약을 다시 검토한다.
