# 외부 수집 방지 2단계 B — API·IP·속도 제한과 함정 경로 (2026-11-14)

PR #950 (`feat/anti-scrape-api-rate-limit-20261114`). 병합·배포·운영 DB·Cloudflare 설정은 하지 않았다.

사람 확정 정책(2026-11-14): 학습용 AI 봇 차단, 검색 엔진·AI 검색/답변용 봇 허용. SEO·AEO는 유지하고
API·HTML 대량 수집과 봇 크롤링은 막는다. 공개 화면은 Cloudflare가 담아 두므로 화면 속도 제한은 Cloudflare 몫이고,
앱은 엣지에 담기지 않는 API·검색을 맡는다.

## 누가 이 API를 쓰는가 (구현 전 확인)

| 경로 | 호출자 | 처리 |
| --- | --- | --- |
| `GET /api/products/<slug>` | 우리 화면은 부르지 않음(상세는 서버가 그림). `skill/SKILL.md` 3장 클레임 확인이 curl로 부름 | 관문 + 항목 최소화. 스킬은 `-A 'nomorevibe-skill/1'`을 싣도록 문서 수정 |
| `GET /api/products/<slug>/feedback` | 상세 화면 `FeedbackList`(브라우저 fetch) | 관문 + 공개 목록 항목 최소화 |
| `GET /api/products/<slug>/reactions` | 상세 화면 반응 판(`components/feedback/reaction-api.ts`) | 관문(응답은 이미 내부 id 없음) |
| `POST /api/product-summaries` | 로그아웃 마이페이지 카드(브라우저) | 관문(기존 120/10분 한도는 그대로) |
| `?q=` 검색(홈·분야 화면) | 사람 검색 | proxy에서 IP 검색 한도 |
| 쓰기(POST/PUT/PATCH/DELETE), 수정 키가 필요한 GET(profile·links·media·provenance), `/api/health`, `/api/cron`, `/api/ops`, 웹훅, `/api/media`, `/api/og-cache` | 스킬·기계·모니터 | **건드리지 않음** — curl·node 호출자가 있다 |

## 바뀐 것

1. **클라이언트 IP** (`lib/rate-limit.ts`)
   - `TRUST_CF_CONNECTING_IP=1` + `TRUSTED_PROXY_HOPS≥1`일 때만 `CF-Connecting-IP`를 쓴다.
   - 위조 방지: 우리 프록시(Traefik)가 기록한 피어(hop으로 고른 X-Forwarded-For 항목)가 루프백·RFC1918·링크로컬·ULA일 때만
     믿는다(같은 기계/사설망의 cloudflared). 공인 주소에서 Traefik에 바로 들어와 머리를 꾸민 요청은 무시된다. 값이 IP가 아니어도 무시.
   - 읽기 한도·함정 차단은 `publicClientIp()`(공인 IP일 때만)를 쓴다. 설정이 덜 돼 사설 주소로만 판정되면 한도를 걸지 않는다
     (모두가 한 통을 나눠 서로를 막지 않게).
   - 기존 쓰기 한도(`edit:`, `register:`, `verify:`, `takedown:`)도 같은 `clientIp()`를 쓰므로 CF 설정 뒤 방문자별로 정확해진다.
2. **공개 JSON 최소화**
   - 제품: `slug,url,name,tagline,category,status` (+주인 없는 제품만 `claimable,verify`). 내부 `id`, 설명·스택·메이커·저장소·출처·시각 제거.
   - 공개 의견: `id,kind,title,body,authorDisplayName,reviewState,reviewReason(null),deliveryState,createdAt,githubIssueUrl,externalIssueState`.
     내부 `productId`, 작성자 계정 `authorUserId`, `productName`, `slug`, `lastErrorCode` 제거(내 의견은 `/api/me/feedback`이 따로 준다).
   - Origin/Sec-Fetch-Site 검토: 같은 사이트만 받게 하면 스킬(curl)과 Sec-Fetch-Site가 없는 옛 Safari(16.4 미만)가 깨진다.
     그래서 **`Sec-Fetch-Site: cross-site`만 거절**하고 머리가 없으면 받는다(회귀 없음).
3. **읽기 속도 제한** (`lib/http/anti-scrape.ts`, 기존 `rate_limits` 표 재사용)
   - 공개 API 읽기: IP당 300번/10분 공용 통(`api-read:<ip>`) → 429 + `Retry-After`.
   - 검색 `?q=`: IP당 60번/10분(`search:<ip>`) → 429 텍스트 + `Retry-After`, `Cloudflare-CDN-Cache-Control: no-store`.
   - 확인된 검색 봇만 한도를 면한다: 역방향 DNS 이름이 회사 도메인(googlebot.com·google.com·googleusercontent.com, search.msn.com,
     applebot.apple.com, naver.com, daum.net·kakao.com)으로 끝나고 정방향으로 같은 IP가 나와야 한다. 한도를 넘었을 때만 DNS를 부르고
     결과를 메모리에 담는다(확인 24시간, 아님 1시간). **이름만 Googlebot인 요청은 보통 방문자와 같은 한도**를 받는다.
   - 한도 표가 잠시 안 되면 막지 않는다(화면 우선).
4. **UA 거절** (`lib/http/agents.ts`) — 위 공개 API 읽기에만.
   - 403 `automated_client_refused`: 수집 도구(curl, wget, python-requests/urllib/httpx, aiohttp, Scrapy, Go-http-client, okhttp, Java,
     node-fetch, axios, undici, HeadlessChrome, Puppeteer, Playwright, Selenium 등), 학습 봇(GPTBot, ClaudeBot, Claude-Web, anthropic-ai, CCBot,
     Bytespider, meta-externalagent, Diffbot, cohere, Amazonbot, AI2Bot 등), 빈 UA.
   - 허용: 검색·답변 봇(OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User, Googlebot, Bingbot, Yeti,
     Daum, Applebot, DuckDuckBot), 브라우저, `nomorevibe-skill/<버전>`.
   - HTML 화면은 앱에서 UA로 막지 않는다(검색·답변 봇이 본다). 화면 쪽 학습 봇 차단은 Cloudflare 설정 몫.
5. **함정 경로** — `app/api/catalog/[[...path]]/route.ts`(`/api/catalog/export.json` 등). `/api/`는 robots.txt Disallow라 규칙을 지키는 봇은 오지 않는다.
   공통 바닥글(`SiteFooter`)에 화면 밖(left:-10000px)·`aria-hidden`·`tabindex=-1`·`rel=nofollow`인 평범한 `<a>`(prefetch 없음)로만 걸었다.
   부른 IP의 `api-read` 키를 1시간 한도 밖으로 만든다(같은 행이라 추가 조회 없음). 응답은 평범한 404, no-store. HTML은 막지 않는다.
   `app/api/` 아래 `_` 로 시작하는 폴더는 Next 비공개 폴더라 `/api/__trap` 대신 이 이름을 썼다. `app/robots.ts`는 건드리지 않았다.

## 운영 env 할 일 (대표가 설정, 이 PR은 설정하지 않음)

웹 앱(M3 web, mini web) 두 곳 모두:

| env | 값 | 조건 |
| --- | --- | --- |
| `TRUSTED_PROXY_HOPS` | `1` | 웹 앞단이 Traefik 하나(cloudflared → Traefik → 웹). 현재 compose 기본 `0` |
| `TRUST_CF_CONNECTING_IP` | `1` | 원 서버가 **Cloudflare Tunnel로만** 공개될 때. Traefik 80/443이 인터넷에 직접 열려 있으면 켜지 말 것 |

설정 뒤 확인(읽기 전용): 웹 로그 `anti_scrape.*` 이벤트, 그리고 브라우저로 상세 화면의 의견·반응이 뜨는지. 설정 전에는 IP를 몰라
한도·함정 차단이 걸리지 않고(UA 거절과 항목 최소화만 동작), 기존과 같다.

## 남은 일 목록

- [x] 클라이언트 IP CF 신뢰 조건 코드·문서·시험
- [x] 공개 제품·의견 JSON 최소화, 반응 응답 점검(이미 최소), cross-site 거절
- [x] 공개 API·검색 IP 읽기 한도(429 + Retry-After), 확인된 검색 봇 예외
- [x] 수집 도구·학습 봇·빈 UA의 API 거절, 검색·답변 봇·스킬 허용
- [x] 함정 경로 + 숨은 링크 + 1시간 API 차단
- [x] `tests/anti-scrape-api.test.ts`(단위), `tests/integration/anti-scrape-api-limits.test.ts`(55435 DB)
- [x] 로컬 next 서버 curl 확인·브라우저 확인(PR 본문·보고서)
- [ ] (막힘·사람) 운영 env `TRUSTED_PROXY_HOPS=1`, `TRUST_CF_CONNECTING_IP=1` 설정 — 대표
- [ ] (막힘·사람) Cloudflare 화면 쪽 학습 봇 차단·속도 제한 — 사람이 직접 설정
- [ ] (병합 뒤) 이미 설치된 옛 스킬은 `-A`가 없어 클레임 확인 GET이 403(본문에 최신 스킬 안내)이다. 쓰기는 영향 없다. `/skill.md`는 병합·배포 뒤 새 문구로 서빙된다
- [ ] (병합 뒤 관측) 공용 NAT 뒤 사용자가 함정 링크를 부를 일은 없지만, 같은 IP의 수집기가 함정에 걸리면 그 IP의 사람도 1시간 의견·반응 로딩이 막힌다. 로그 `anti_scrape.trap_hit` 빈도를 보고 시간 조정
