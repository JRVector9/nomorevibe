# 과다 호출 30분 차단 + 크롤링 금지 안내 (2026-11-16)

PR #977 (`feat/crawl-burst-block-20261116`). 병합·배포·운영 설정·Cloudflare 변경은 하지 않았다.

사람 지시(2026-11-16): "크롤링 봇 초당 호출이 너무 많으면 30분 제한하고 이 사이트는 크롤링을 금지합니다.
법적 조치를 취할 수 있습니다 라고 알려주자." 같은 지시의 1번(워터마크)은 별도 PR이며 이 PR은
`app/api/og-cache`·`app/api/media`를 건드리지 않는다.

## 동작

- **세는 것**: 같은 공인 IP(`publicClientIp`)의 공개 화면 요청(`proxy.ts`, GET/HEAD) + 공개 API 읽기(`guardPublicApiRead`를
  거치는 13개 경로). 한 통(`rate_limits`의 `burst:<ip>` 행)에 센다. 마이그레이션 없음.
- **세지 않는 것**: `/_next/static`·`/_next/image`, 그림·글꼴·아이콘 파일, `/api/og-cache`·`/api/media`(관문을 거치지 않음),
  `/api`의 쓰기·수정 키 GET, `/admin`, `/go`, `/badge`, `robots.txt`·`sitemap`·`feed.xml`·`llms.txt`·`skill.md`·`install.sh`,
  상세 공유 카드(`share-card.png`), POST(서버 액션·폼).
- **기준**: 창 `burstWindowSeconds`(기본 10초) 안에 `burstLimit`(기본 80)을 넘으면 그 키를 `burstBlockSeconds`(기본 1800초 = 30분)
  동안 한도 밖으로 만든다(`blockRateLimitKey`와 같은 방식, count = 10억). 막힌 동안 count는 더 오르지 않는다.
- **면제**: 역방향 DNS + 정방향 확인된 검색 봇만(`verifiedSearchBot`, 기존 규칙). 이름(UA)만 댄 봇은 보통 방문자와 같다.
- **IP를 모르면**(신뢰 프록시 설정 전·사설 주소) 세지 않는다. 한도 표·설정 행이 안 되면 막지 않는다(화면 우선).
- **막힌 동안 응답**: 429 + `Retry-After`(남은 초), `Cache-Control: private, no-store`, `Cloudflare-CDN-Cache-Control: no-store`,
  `X-Robots-Tag: noindex, nofollow`.
  - 화면: 짧은 HTML. 제목 "이 사이트는 크롤링을 금지합니다. 법적 조치를 취할 수 있습니다." + 남은 시간(약 N분, 한국 시각) + 같은 뜻의 영어 문단.
    `/en` 등 한국어가 아닌 화면은 영어 문단을 먼저 둔다. HEAD는 본문 없음.
  - API: `{"error":"crawling_prohibited","message":"이 사이트는 크롤링을 금지합니다. 법적 조치를 취할 수 있습니다. 30분 뒤에 다시 이용할 수 있습니다.","message_en":"…","retryAfterSeconds":1800,"retryAt":"…"}`.
- **순서**: 공개 API는 UA 거절(403) → cross-site 거절(403) → **과다 호출** → 10분 300번 읽기 한도 → 세션 관문. 화면은 관리자 404 → **과다 호출** → 검색 한도.

## 기본값 근거 (실측)

운영과 같은 `next build` standalone 서버 + 시험 DB(55435 방식의 개인 pgvector 컨테이너, e2e 상세 시험 데이터),
Playwright Desktop Chrome, 측정 동안만 창 600초·기준 10000으로 두고 `rate_limits`의 `burst:<ip>` count를 읽었다.

| 장면 | 이 차단이 센 수 | 세지 않은 정적 자원 |
| --- | --- | --- |
| 상세 한 장(보통) | 5 (문서 1 + `/api/session`·`details`·`reactions`·`feedback`) | 29~32 |
| 상세 한 장(README 있는 설치형) | 6 (+ `readme`) | 29 |
| 홈 | 7 (`browse-counts` 2·`session`·`product-cards` 3) | 25 |
| 인기 | 2 | 24 |
| 홈 → 상세 누름(클라이언트 이동, RSC 1) | 11 | 34 |
| 빠른 사람: 상세 5장을 6.8초에 | 26 | — |

`/api/me`는 공개 읽기 관문을 거치지 않아 세지 않는다. 링크 미리 받기(prefetch)는 관측되지 않았다(링크가 `prefetch={false}`).

- 빠른 사람 1명 = 26번(전부 설치형이면 30번). 회사·통신사 공유 IP에서 그런 사람 2명이 같은 10초에 보면 60번 →
  대표 출발점 **10초 50번이면 둘째 사람이 막힌다**. 그래서 **10초 80번**(빠른 두 사람 60 + 다른 화면 여유 20).
  초당 8번 넘게 계속 부르는 수집기는 10초 안에 막힌다.
- 스킬 흐름(스킬 문서 읽기 → 상세 한 번 → 클레임 확인 GET 두 번, 쓰기는 세지 않음) = 3번 — 기준의 1/10 아래(시험에 고정).
  2026-11-15 원칙 "사람이 에이전트에 입력해 쓰는 접근은 허용"이 유지된다.

## 관리자 설정·운영 도구

설정은 `runtime_settings` 행의 `publicApi` 묶음(`mode`와 같은 곳). 웹은 30초마다 다시 읽는다 — 재배포 없음.

| 키 | 기본 | 범위 |
| --- | --- | --- |
| `publicApi.burstLimit` | 80 | 0~10000 (0 = 끔) |
| `publicApi.burstWindowSeconds` | 10 | 1~600 |
| `publicApi.burstBlockSeconds` | 1800 | 60~86400 |

```bash
npx tsx scripts/crawl-burst.ts status                       # 지금 설정, 막힌 IP 수, 창 안에서 세는 IP 수(읽기 전용)
npx tsx scripts/crawl-burst.ts set 80 10 1800 <actor>        # 저장 → operations_audit runtime-settings-save
npx tsx scripts/crawl-burst.ts release <ip> <actor>          # 바로 해제 → operations_audit crawl-burst-release(주소 끝은 가림)
```

관리자 화면 칸은 만들지 않았다. 같은 묶음의 `publicApi.mode`도 화면 없이 CLI(`scripts/public-api-session-mode.ts`)로 바꾼다.

**관측**: 차단마다 웹 로그 한 줄 `anti_scrape.burst_blocked`(`route`, `kind`, `agent`, `limit`, `windowSeconds`, `blockSeconds`, `releaseAt`).
IP는 남기지 않는다(기존 `anti_scrape.*`와 같음). 자동 해제는 시각이 지나면 행이 다시 1부터 세는 것이라 따로 줄이 없다 — `releaseAt`으로 센다.
지금 막힌 IP 수는 `status`. 설정·한도 표가 안 될 때는 `anti_scrape.burst_unavailable`(설정·한도 DB 오류 경고, 막지 않음).

## 한계

- **Cloudflare가 담아 둔 화면은 원 서버에 오지 않는다.** 막힌 IP라도 엣지에 담긴 화면은 계속 받는다. 차단은 원 서버까지 오는 화면·API에만
  걸린다(대량 수집은 대개 담기지 않은 주소·API를 많이 부르므로 여기서 걸린다). 엣지 쪽 속도 제한은 Cloudflare 설정 몫.
- 막힌 응답은 `no-store`라 엣지에 담기지 않는다(다른 방문자에게 번지지 않는다).
- **운영 env `TRUST_CF_CONNECTING_IP=1`이 없으면 방문자 IP를 몰라 아무것도 세지 않는다**(2026-11-14 문서의 운영 env 할 일과 같음).
- 통신사 CGNAT 하나 뒤에 동시에 빠르게 보는 사람이 셋 이상이면 걸릴 수 있다. 오탐은 `release`로 풀고 `set`으로 기준을 올린다.
- 공개 API 읽기와 화면 요청마다 `rate_limits` upsert가 한 번 늘어난다(설정은 30초 캐시).

## 남은 일 목록

- [x] 과다 호출 세기·30분 차단·크롤링 금지 안내(HTML·JSON), 검색 봇 rDNS 면제
- [x] `runtime_settings` `publicApi.burst*`(기준 수·창·차단 시간) + 운영 CLI(status·set·release, 해제 감사)
- [x] 실측으로 기본값(10초 80번·30분) 결정
- [x] `tests/crawl-burst-block.test.ts`(단위), `tests/integration/crawl-burst-block.test.ts`(DB)
- [x] 로컬 next(standalone)에서 막힌 화면·정상 상세 화면 스크린숏
- [ ] (병합·배포 뒤, 사람 승인) 운영 반영 — `deploy scope`는 `full`(18앱, `runtime-settings-schema.ts`를 워커도 읽음), 마이그레이션 0
- [ ] (막힘·사람) 운영 env `TRUST_CF_CONNECTING_IP=1` — 없으면 이 차단도 동작하지 않는다(2026-11-14 문서)
- [ ] (병합 뒤 관측) `anti_scrape.burst_blocked` 빈도와 오탐(사람 신고) — 기준 조정은 `set`
- [ ] (범위 밖) 약관의 법적 문구(#952)·Cloudflare 엣지 속도 제한

## 상세 API 추가 기준 — PR #978 (2026-11-16)

`products.details`·`products.readme`·`products.timeline`만 slug에 관계없이 IP별 합산한다.
스킬 최소 응답 `GET /api/products/<slug>`는 아래 두 통에 넣지 않는다. 공통 300/10분과 화면+API 80/10초는 유지한다.

| 설정(publicApi) | 기본 | 의미 |
| --- | --- | --- |
| `detailReadLimit` | 60 | `detail-read:<ip>`에서 60회 허용, 61번째부터 기존 `rate_limited` 429 + Retry-After |
| `detailReadWindowSeconds` | 600 | 상세 읽기 창, 1~86400초 |
| `detailBurstLimit` | 20 | `detail-burst:<ip>`에서 **19회 허용, 20번째부터 차단** |
| `detailBurstWindowSeconds` | 10 | 상세 과다 호출 창, 1~600초 |

두 limit 범위는 0~10000이며 각각 0이면 해당 한도만 끈다. 상세 burst 차단 시간은 기존 `burstBlockSeconds`(기본 1800초)를 함께 쓴다.
상세 기준에 걸리면 기존 **`burst:<ip>`**를 막아 화면과 다른 공개 API에도 같은 크롤링 금지 429를 준다.
공통 burst 기준만 0으로 해도 상세 burst가 켜져 있으면 이 공유 차단은 유지한다.
역방향·정방향 DNS로 확인된 검색 봇은 면제. IP 모름·설정/한도 DB 오류는 통과한다.
새 로그 `anti_scrape.detail_burst_blocked`·`detail_rate_limited`는 최초 초과 때 한 줄, `detail_limit_unavailable`은 장애 경고다.
IP·DB 오류 객체(쿼리에 주소가 포함될 수 있음)는 기록하지 않는다.

```bash
npx tsx scripts/crawl-burst.ts status  # 공통·상세 설정과 현재 공유 차단 수
npx tsx scripts/crawl-burst.ts set detail 60 600 20 10 <actor>
npx tsx scripts/crawl-burst.ts set detail 0 600 0 10 <actor>  # 새 상세 제한 둘만 끔
npx tsx scripts/crawl-burst.ts release <ip> <actor>  # burst 및 상세 두 창을 함께 지움, 감사 기록
```

기존 `set 80 10 1800 <actor>`는 공통 설정만 바꾼다. 두 set 모두 publicApi 나머지 설정·관문 mode를 보존한다.
수동 해제는 공통 API 읽기/함정 `api-read:<ip>` 차단은 건드리지 않는다. 설정 반영 캐시는 기존 30초다.
기존 rate_limits·runtime_settings를 재사용하므로 DB 마이그레이션은 필요 없다. 이 PR 작업에서 운영 설정은 저장하지 않았다.
