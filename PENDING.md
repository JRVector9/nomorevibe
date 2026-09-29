# 남은 작업

코드로 끝낼 수 없어 멈춰 있는 것들. 각 항목은 **막고 있는 것**과 **풀렸을 때 할 일**을
그대로 실행할 수 있게 적는다. 끝나면 이 파일에서 지운다.

---

## 현재 남은 운영 검증 — 2026-09-29

첫 배포·운영 DB 연결·역할 워커 시작은 완료됐다. 서비스는 `https://nomorevibe.brut.bot`에서 운영하며,
Dokploy의 M3 7개 앱과 mini 웹·다섯 역할 예비 6개 앱이 main 소스를 배포한다.
scheduler는 M3에서 2복제본이다. 공개 GitHub main은 최신 base의 CI `check` 성공과 PR을 요구한다.
2026-09-29 릴리스 `20208d3`의 13개 앱 배포와 다섯 역할의 주/예비 인계를 확인했다.

남은 항목은 배포 준비가 아니라 아래 직접 검증이다. 실행하지 않은 검증을 완료로 표시하지 않는다.

- **GitHub 수집 계정 풀의 장기 관측**: PR #225 배포 후 서로 다른 실제 GitHub
  계정의 관리자 PAT 등록·교체, 암호화 저장, 수집 코드 조회, 새 계정 quota 관측과
  원본 39건 증가를 확인했다. 실제 한 계정의 primary 한도가 자연 소진될 때
  다른 계정으로 전환되고 양쪽 reset 후 정상 재개되는 운영 경로와 24시간
  API 사용량·저장량 추세는 아직 직접 관측하지 않았다. 토큰 만료 전 관리자
  교체와 네 앱 공통 암호화 키의 보관·재암호화 절차도 장기 운영 항목이다.
  401 응답의 제한 재시도·다른 계정 전환·모든 계정 거부 시 큐 보류는 자동화 시험으로
  확인했으며, 실제 운영 PAT를 만료·폐기해 보는 장애 주입은 하지 않았다.

- **기존 GitHub 저장소 ID 중복 원본 검수**: 2026-09-29 읽기 전용 운영 조회에서
  같은 GitHub 숫자 ID의 중복 원본 299그룹·초과 행 304건을 확인했다. 새 코드 배포 직전
  이름 변경 원본 1건이 더 쌓여 배포 후 기준은 300그룹·초과 행 305건이었다.
  16그룹은 이미 발행된 제품이 둘 이상이므로 자동 삭제·병합 시 공개 제품, 심사 기록,
  사용자 지표가 바뀐다. 신규 중복 저장을 막는 `0054` 변경은 운영에 배포됐고 기존 행을 보존한다.
  발행 제품의 대표 선택과 병합·리다이렉트 정책을 정한 뒤 별도 백업·미리보기·적용 검증으로
  기존 자료를 정리해야 한다. 2026-09-29 03:31 UTC에 새 이름 변경 별칭 1건이
  `skipped/alias_of`로 기록되고 새 원본은 저장되지 않았으며 초과 행은 305건 그대로였다.
  장기 관측과 기존 자료 정리는 계속 필요하다.

- **워커 진행 감시의 외부 실행**: `scripts/check-failover-readiness.ts`는 주·예비 후보,
  lease, scheduler 2복제본과 기존 진행 판정을 함께 내고 별도 monitor 이미지가 30초 간격으로
  Uptime Kuma Push를 보낼 수 있게 구현했다. 운영 monitor 앱·Push 대상·실제 경보 수신은
  아직 배포/검증하지 않았다. mini 전체 장애 시 mini의 Kuma도 사라지는 감시 공백이 남아
  외부 deadman 경로가 필요하다. 운영 예비 중단·감시자 중단·실제 저장 정체·반복 부팅 격리
  주입도 각각 직접 확인해야 한다.
- **publisher 예비의 새 제품 발행**: mini가 epoch 3으로 인계받고 `crawl-publish` 요청·처리를
  완료했지만 당시 적격 승인 후보가 없어 새 제품 저장은 확인하지 못했다. 이후 승인 행 17건은
  발행 정책의 모든 조건을 만족하는 적격 큐가 아니며 실제 발행 잡은 `no_work`였다. 적격 후보가 생길 때
  mini 활성 상태의 신규 발행과 role epoch를 함께 확인한다.
- **실제 정체·반복 부팅 격리 주입**: publisher·maintenance·text의 자식 종료와 다섯 역할의
  주 서비스 중단·예비 선출을 확인했다. crawler 문서·reviewer 1차 심사·maintenance 점검·
  text 검수 저장도 확인했다. 실제 저장
  정체가 2회 판정되어 자동 재시작되는 경로와 3회/5분 반복 부팅 격리는 운영에서 아직 주입하지 않았다.
- **maintenance 처리 용량**: 공개 웹사이트 약 19,343곳 중 약 13,954곳이 6시간 넘게
  점검되지 않았고 최근 처리량은 약 900건/시간이다. 6시간 목표에 필요한 약 3,224건/시간과
  차이가 있으며 예비 대기는 용량 부족을 해결하지 않는다(2026-09-28 읽기 전용 표본).
  2026-09-29 재측정은 19,365곳 중 13,976곳 6시간 초과, 최근 905건/시간이었다.
  `UPTIME_BATCH_SIZE`·`UPTIME_CONCURRENCY`의 60/6을 M3 주·mini 예비에 적용했다.
  5분 저장 300건, 마지막 tick 60건/9.3초, 잡 오류 없음과 6시간 초과 13,628건을
  확인했다. 전체 backlog가 수시간에 걸쳐 6시간 안으로 회복되는지와 장기 CPU·DB 부하 검증은
  아직 남았다([운영 기록](docs/operations/2026-09-29-uptime-capacity-rollout.md)).

- **기존 보관 백업의 복구 가능성**: 운영 DB의 Patroni 주·복제 스트리밍과 WAL 아카이브가
  설정된 것은 읽기 전용으로 확인했다. 2026-09-29 운영 primary에서 새로 생성한 논리 백업을
  로컬 격리 DB에 복원해 주요 행·마이그레이션과 비어 있지 않은 `og_images.data` 바이트를
  대조했다. 운영 DB 설정은 바꾸지 않았고 시험 DB는 삭제했다. 당시 `media_assets`가 0행이어서
  그 테이블의 `web_data`·`thumbnail_data` 복구는 검증할 수 없었다. **이미 보관 중인 과거 백업의
  복원, 보존 기간·볼륨/WAL 여유 및 PgBouncer 용량은 별도 운영 관리 영역의 미검증 항목**이다.
  워커 failover 작업에서 DB 구성을 변경하지 않는다([복원 기록](docs/operations/2026-09-29-db-restore-verification.md)).
- **24시간 연속 관측**: 각 앱의 소스 커밋·재시작·job 성공/대기·API quota·DB 연결·RSS를 기록한다.
  개별 점검과 짧은 로컬 관측으로 24시간 안정성을 보장하지 않는다.
- **랭킹 정책 전환**: 운영 `unique_visitor_started_at`은 2026-08-29 03:56:49 UTC이며,
  2026-09-27 읽기 전용 점검에서 해시가 있는 방문 이벤트 43건을 확인했다. 고유 유입자 수집은 시작됐다.
  실제 정책 예약과 다음 자연 시즌 경계 적용은 아래 B2 절차로 별도 확인해야 한다.
- **소개 검수 중단 유지**: 사용자가 중단한 `product-intro-check`는 허가 없이 재개하지 않는다.
  검색 프로필 생성·키워드 검수·README 재수집과 다른 작업이다.

정확한 배포 명령은 [독립 워커 운영 절차](docs/operations/independent-workers-runbook.md),
최근 실행 결과는 `docs/operations/`의 릴리스 기록과 `docs/CODEX_HANDOFF.md`를 따른다.
과거 준비·로컬 실측과 운영 확인 절차는 아래에 보존한다.

---

## D1. 카테고리·AI 리뷰 — 운영용 Codex·Claude CLI 인증과 모델 확인

**현재 상태(2026-09-27)**: publisher와 reviewer는 실제 운영 중이다. 아래 2026-09-08의 모델·인증 준비 기록은
과거 실측이다. 새 릴리스의 인증 만료·모델 변경은 역할별 로그와 실제 구조화 응답으로 다시 확인한다.
현재 자격 정보가 없다는 과거 상태를 배포 장애로 해석하지 않는다.

**현재 상태(2026-09-08)**: 로컬 로그인으로 실제 Spark 구조화 카테고리 응답과 worker 이미지의
Codex CLI 실행을 확인했다. 앞선 단기 OAuth 시험으로 Claude 구조화 리뷰 응답도 확인했다. 이 결과는
생산 환경의 장기 인증이나 24시간 운영 검증을 대신하지 않는다. 카테고리와 리뷰는 서로 다른 CLI,
모델, 인증을 사용한다.

```text
카테고리  codex exec / structured output / CLI 설정·지침·plugin·shell·web 격리 / 최대 10건 batch
          gpt-5.3-codex-spark / effort xhigh / 8초
          실패 시 gpt-5.6-terra / effort high / 12초, 다시 실패 시 키워드 폴백
리뷰      명시한 CRAWL_REVIEW_MODEL / effort low / safe-mode / 20초 / 한 tick AI 호출 최대 1개
인증      Spark는 CODEX_ACCESS_TOKEN, Terra는 OPENAI_API_KEY, 리뷰는 CLAUDE_CODE_OAUTH_TOKEN
실패      카테고리는 키워드 폴백. 리뷰는 보류·제한 재시도이며 enforce의 승인 조건을 우회하지 않음
```

publisher 시작 스크립트는 Codex 로그인 뒤 원문 토큰을 환경에서 제거한다. 분류 결과는 입력의 숫자
ID 전체 집합이 중복·누락 없이 돌아왔을 때만 채택한다. reviewer의 Claude CLI에서 `--bare`는 OAuth도
건너뛰므로 운영 코드와 동일한 `--safe-mode`로 인증을 확인한다. 토큰 값·Authorization 헤더·인증
응답 본문은 문서와 로그에 남기지 않는다.

### 실측 — 2026-09-08, 개발 DB의 기존 Other 표본 22건

| | Spark xhigh | Terra xhigh |
|---|---:|---:|
| 분류 일치 | 21/22 (95.5%) | 기준 비교 |
| 일반 표본 10건 | 5.119초 · 8,775 tokens | 10.463초 · 10,410 tokens |
| 게임 후보 12건 | 5.276초 · 3,731 tokens | 12.983초 · 10,725 tokens |

불일치 1건은 Craft Football을 Spark가 Social, Terra가 Lifestyle로 분류한 경우다. 실제 구현 경로의
2건 smoke에서는 wedding → Lifestyle, playable puzzle → Games를 반환했다. 이 비교로 1차를 더 빠른
Spark xhigh, 서버 인증·접근 실패 시 2차를 Terra high로 정했다. Spark는 현재 일반 API 모델이 아닌
Codex 연구 프리뷰이므로 서버 access token과 계정 제공 여부를 운영 배포 전에 반드시 확인한다.

### 과거 실측 — 2026-08-29, 개발 DB에 발행된 32건의 원본, sonnet · effort high

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

1. 준비한 worker 이미지 안에서 `codex --version`이 `0.153.4`, `claude --version`이 `2.1.263`인지 확인한다.
2. Spark를 쓸 수 있는 `CODEX_ACCESS_TOKEN` 또는 Terra용 `OPENAI_API_KEY`를 publisher에만 저장한다.
   `claude setup-token`으로 발급한 장기 토큰은 reviewer에만 주입한다. 로컬의 짧은 수명 시험 토큰을
   그대로 운영 인증으로 채택하지 않는다.
3. Spark 사용 가능 여부, Terra 폴백, 명시한 리뷰 모델의 실제 구조화 응답·시간 제한을 격리된 후보로 확인한다.
   카테고리 로그의 `crawl.classified`와 인증 실패 여부를 확인하고, 리뷰 실패를 자동 거절로 처리하지 않는다.
4. 모든 reviewer/publisher에 B 릴리스가 적용된 것을 확인한 뒤 웹 `CRAWL_REVIEW_READY=true`를
   주입한다. `/admin/review`에서 사유와 함께 `off → observe → 판정 비교 → enforce`로 전환한다.
   `off`는 AI 발행 보호 해제이므로 enforce 운영 장애 때 자동으로 낮추지 않는다.

**과거 로컬 검증(2026-08-29)**: 이전 runner 이미지의 CLI `2.1.251`과 카테고리 인증 실패 시
키워드 폴백을 확인했다. 당시 이미지 322 → 817MB 측정은 현재 분리 이미지의 크기나 메모리 예산이 아니다.

---

## B1. 프로덕션 독립 스케줄러·워커 전환과 운영 확인

**현재 상태(2026-09-27)**: 독립 scheduler와 5개 역할 워커(crawler·reviewer·publisher·text·maintenance)가
운영 중이다. 남은 것은 상단의 24시간 연속 관측과 기존 보관 백업의 복구 검증이다.
격리 환경의 웹 없는 5역할 관측을 1,800.307초 동안 완료했다(31표본 모두 healthy, 재시작0). 외부 수집 비활성·빈 DB 조건이며 24시간 관측은 수행하지 않았다.
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
| `GITHUB_TOKEN` | crawler의 기존 GitHub 요청 토큰. 관리자 등록 PAT가 있으면 없어도 수집 가능 |
| `GITHUB_COLLECTOR_SECRET` | 관리자 PAT 암호화·복호화. 웹 2개와 crawler 주·예비에 동일한 32자 이상 키 필요 |
| `CODEX_ACCESS_TOKEN` | publisher의 Spark 분류. 없거나 실패하면 Terra로 진행 |
| `OPENAI_API_KEY` | publisher의 Terra 분류. 없거나 실패하면 키워드 폴백 |
| `CLAUDE_CODE_OAUTH_TOKEN` | reviewer. 리뷰 오류는 보류·제한 재시도 |
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
5. 새 논리 백업의 격리 복원은 [2026-09-29 기록](docs/operations/2026-09-29-db-restore-verification.md)을 따른다.
   기존 보관 백업 복구·보존 기간·용량은 별도 운영 관리에서 확인한다. `media_assets`에 실제 행이
   생기면 `web_data`·`thumbnail_data` 바이트 포함 여부를 그 표본으로 확인한다.
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

**현재 상태(2026-09-27)**: 운영에서 고유 유입자 수집 시작 시각과 해시가 있는 이벤트를 확인했다.
7일 준비 기간은 경과했지만, 현재 정책 예약·자연 시즌 경계 적용은 이 세션에서 확인하지 않았다.
아래 절차는 새 환경 전환이나 정책 변경 시 사용할 검증 절차다.

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
