# 방문 분석(Google Analytics 4) — 켜기·이벤트·동의·확인

2026-10-22. 공개 화면의 방문·클릭·스킬 설치 흐름·GitHub 연결·방문자 경로를 GA4 로 본다.
코드는 들어가 있지만 **측정 ID 를 넣기 전에는 꺼져 있고 아무것도 불러오지 않는다.**

- PR A(기반): 이벤트 목록·`track()`·동의 모드·공개 화면 로더·정책 화면 `#analytics`·끄기 단추
- PR B(브라우저 이벤트): 카드·상세·`/launch`·검색·메뉴·오류 경계에 `track()` 을 붙인다
- PR C(서버 이벤트): `/go`·설치 스크립트·등록·소유 확인·GitHub 연결을 Measurement Protocol 로 보내고, 가명 user_id 와
  GA 속성 설정(탐색·경로 분석)을 이 문서에 더한다

코드 위치

| 파일 | 하는 일 |
| --- | --- |
| `lib/analytics/events.ts` | 이벤트 이름·매개변수 목록(브라우저·서버 모두). 새 이름은 끝에 덧붙인다 |
| `lib/analytics/config.ts` | `GA_MEASUREMENT_ID`·`GA_DEBUG` 를 실행 중에 읽는다 |
| `lib/analytics/client.ts` | `track()`·`trackPageView()`·끄기/다시 켜기·대기열 — 첫 로드 JS 에 들어가므로 작게 |
| `lib/analytics/runtime.tsx` | gtag 준비·동의·값 정리·보내기·쿠키 삭제·gtag.js 태그. 로더가 GA 가 켜진 화면에서만 `import()` 로 받는다 |
| `lib/analytics/consent.ts` | 동의 모드 기본값, 끄기·GPC·DNT·지역 판단 |
| `lib/analytics/sanitize.ts` | 질의 허용 목록, 금지 키, 검색어 정리 |
| `lib/analytics/routes.ts` | 보내지 않는 주소, `page_type` 갈래 |
| `components/analytics/*` | 서버 자리(`GoogleAnalytics`), 브라우저 로더, 끄기 단추 |

## 켜는 법

1. GA4 속성과 웹 데이터 스트림을 만들고 측정 ID(`G-XXXXXXXXXX`)를 받는다. 아래 [GA 관리 화면 설정](#ga-관리-화면-설정)을 먼저 맞춘다.
2. Dokploy 에서 **웹 앱 두 개(M3 웹, mini 웹)** 의 실행 환경(Environment)에 같은 값을 넣는다.
   ```
   GA_MEASUREMENT_ID=G-XXXXXXXXXX
   ```
   - 빌드 비밀(buildSecrets)·`NEXT_PUBLIC_` 변수가 아니다. 웹 이미지는 CI 에서 비밀 없이 굽고, 서버가 요청마다 이 값을 읽어
     브라우저 로더에 넘긴다. 측정 ID 는 비밀이 아니다(페이지 소스에 보인다).
   - 워커·scheduler 에는 넣지 않는다(PR C 의 서버 발신이 웹 밖에서 돌게 되면 그때 PR C 문서를 따른다).
3. **웹만** 다시 배포한다(이미지는 그대로, 환경만 바뀐다). 워커는 건드리지 않는다.
4. Cloudflare 가 공개 HTML 을 60초(목록)~10분(정책·등록 안내) 저장한다. 공통 이미지 배포 스크립트는 웹 교체 뒤 `html` 태그를
   지우지만, Dokploy 화면에서 웹만 다시 띄웠다면 그만큼 기다리거나 `html` 태그를 지운다.
5. [확인](#확인ga-debugview)을 한다.

끄려면 두 웹에서 `GA_MEASUREMENT_ID` 를 지우고 웹만 다시 배포한다.

## 동작

- **어디서**: 공개 화면 틀(`components/home/PublicShell.tsx`)에서만 불러온다. 관리자(`app/(operator)`), `/api/**`, `/go/**`,
  `/badge/**`, 피드·사이트맵·`/install.sh`·`/skill.md`, 로그인 콜백(`/api/auth/**`·`/oauth`·`/webhooks`)에는 없다.
  공개 틀을 쓰는 404 화면이라도 이런 주소면 불러오지 않는다(`isAnalyticsExcludedPath`).
- **언제**: `next/script` `afterInteractive`. gtag 를 부르기 전에 동의 기본값 → `gtag('js')` → `gtag('config', …)` 순서로 넣는다.
  실제 일을 하는 `runtime.tsx` 는 로더가 따로 받는다 — GA 가 꺼진 동안 공개 화면의 첫 로드 JS 에는 `track()` 과 대기열만 들어간다.
- **화면 보기**: `send_page_view: false`. 첫 화면과 App Router 이동마다 `page_view` 를 직접 보낸다. 새 제목(metadata)이 늦게
  들어오면 최대 1초 기다린다. 같은 주소·같은 갈래를 잇달아 보내지 않는다.
- **매 이벤트**: 정리한 `page_location` 과 `transport_type: "beacon"` 을 붙인다(화면을 떠나는 클릭도 잃지 않는다).
- **광고 신호**: `allow_google_signals: false`, `allow_ad_personalization_signals: false`, `ads_data_redaction: true`,
  `url_passthrough: false`.
- **IP**: GA4 는 IP 를 기록·저장하지 않는다(대략의 위치를 정하는 데만 쓰고 버린다). UA 시절의 `anonymize_ip` 는 GA4 에서
  의미가 없어 넣지 않았다.
- **user_id**: 로그인해도 붙이지 않는다. 가명 user_id 는 PR C 가 정한다.
- **실패**: `track()` 은 꺼져 있으면 아무것도 하지 않고, 어떤 경우에도 던지지 않는다. 로더보다 먼저 온 이벤트는 20개까지 모았다가
  켜지면 보내고 꺼지면 버린다.

### page_type

| 주소 | `page_type` |
| --- | --- |
| `/` | `home` (검색어 `q` 가 있으면 `search`, `category`·`sort`·`builder`·`observedTool`·`ai`·`saved`·`new`·`metric` 이 있으면 `browse`) |
| `/c/[category]` | `browse` |
| `/p/[slug]` | `product` |
| `/p/[slug]/github` | `product_settings` |
| `/talk`·`/popular`·`/rising`·`/launch`·`/policy`·`/login` | 같은 이름 |
| `/rankings/[key]` | `rankings` |
| `/me`·`/me/*` | `me` |
| `/feedback/[id]` | `feedback` |
| 그 밖 | `other` |

`locale` 은 주소 접두(`/en`·`/zh-Hans`·`/zh-Hant`, 없으면 `ko`)에서 정한다.

## 이벤트 목록

`lib/analytics/events.ts` 와 같다. `?` 는 생략 가능, 괄호는 허용 값. 값은 문자열·숫자·참거짓만, 제품은 slug 로만 가리킨다.

| 이벤트 | 보내는 곳 | 뜻 | 매개변수 |
| --- | --- | --- | --- |
| `page_view` | 브라우저 | 화면을 열었다(첫 화면과 앱 안 이동마다) | `page_location`, `page_path`, `page_title`, `page_referrer`?, `locale` (ko·en·zh-Hans·zh-Hant), `page_type` |
| `select_item` | 브라우저 | 목록의 제품 카드를 눌렀다 | `item_list_id`, `item_list_name`, `index`, `item_id` (+ GA 상품 보고서용 `items` 자동) |
| `search` | 브라우저 | 검색했다(검색어는 정리·길이 제한) | `search_term`, `result_count`?, `surface`? |
| `select_content` | 브라우저 | 탭·구획을 골라 봤다 | `content_type`, `content_id`, `surface`? |
| `filter_change` | 브라우저 | 거르기·정렬을 바꿨다 | `filter_name`, `filter_value`, `surface` |
| `share` | 브라우저 | 공유했다(수단별) | `method`, `content_type` (product·profile·ranking·page), `item_id` |
| `outbound_click` | 브라우저 | 제품 방문하기·저장소 열기(/go)를 눌렀다 | `link_kind` (site·repo), `product_slug`, `surface` |
| `github_click` | 브라우저 | GitHub 직접 링크를 눌렀다 | `product_slug`, `surface` |
| `social_outbound_click` | 브라우저 | 화제 글 원문(HN·X·Bluesky)으로 나갔다 | `source` (hn·x·bluesky·reddit·other), `surface`, `product_slug`? |
| `product_save` | 브라우저 | 제품을 저장·저장 취소했다 | `product_slug`, `action` (save·unsave), `surface` |
| `reaction_change` | 브라우저 | 반응을 남기거나 지웠다 | `product_slug`, `reaction_kind`, `action` (add·remove) |
| `product_tried` | 브라우저 | 써봤어요를 남기거나 바꾸거나 지웠다 | `product_slug`, `action` (add·update·remove), `verdict`? |
| `follow_change` | 브라우저 | 제품을 팔로·팔로 취소했다 | `product_slug`, `action` (follow·unfollow), `surface` |
| `github_star` | 브라우저 | 우리 앱으로 GitHub 스타를 누르거나 뺐다 | `product_slug`, `action` (star·unstar) |
| `github_connect_start` | 브라우저 | GitHub 연결을 시작했다 | `kind` (login·star·app_install·claim), `surface`, `product_slug`? |
| `claim_start` | 브라우저 | 소유 확인을 시작했다 | `product_slug`, `step` (claim·verify) |
| `copy_text` | 브라우저 | 복사 단추를 눌렀다(대상 코드만) | `copy_target`, `surface`, `product_slug`? |
| `feedback_submit` | 브라우저 | 상세 요청 폼을 보냈다(종류만) | `product_slug`, `feedback_kind` |
| `skill_install_copy` | 브라우저 | 스킬 설치 명령을 복사했다 | `surface`, `command` |
| `skill_script_view` | 브라우저 | 설치 스크립트를 열어 봤다 | `script` (install_sh·skill_md), `surface` |
| `launch_command_copy` | 브라우저 | 등록·확인 명령을 복사했다 | `command_kind` (launch·verify·install·other), `surface` |
| `launch_step_view` | 브라우저 | /launch 의 단계 구획까지 봤다 | `step`, `step_index` |
| `nav_click` | 브라우저 | 헤더·푸터·모바일 메뉴를 눌렀다 | `target`, `surface` |
| `login_start` | 브라우저 | 로그인 단추를 눌렀다 | `method` (github·email), `surface` |
| `login` | 둘 다 | 로그인했다(이메일은 브라우저, GitHub 는 서버) | `method` (github·email) |
| `sign_up` | 서버 | 처음 가입했다(새 계정은 서버만 안다 — 두 수단 모두 서버) | `method` (github·email) |
| `app_error` | 브라우저 | 화면 오류 경계에 걸렸다(코드만) | `error_code`, `page_type` |
| `outbound_visit` | 서버 | /go 가 제품 사이트·저장소로 보냈다 | `product_slug`, `link_kind` (site·repo), `via`? |
| `skill_script_download` | 서버 | /install.sh·/skill.md 를 받아 갔다 | `script` (install_sh·skill_md) |
| `launch_submitted` | 서버 | 스킬로 등록이 들어왔다 | `product_slug`, `source` (skill·other) |
| `product_claimed` | 서버 | 소유 확인이 끝났다 | `product_slug`, `method` (skill_verify·github·other) |
| `github_connected` | 서버 | GitHub 연결이 끝났다 | `kind` (login·star·app_install) |

`surface` 값: home·browse·search·product·talk·popular·rising·rankings·launch·policy·me·login·feedback·header·footer·mobile_nav·related·dialog·other.

`outbound_click`(누름)과 `outbound_visit`(서버가 실제로 보냄)은 따로 센다 — 둘의 차이가 차단기·새 탭 실패 등으로 잃는 몫이다.

## 동의(Consent Mode v2)

| 신호 | `ad_*` 셋 | `analytics_storage` | gtag 를 부르나 |
| --- | --- | --- | --- |
| 아무 신호 없음 | 거부 | 허용 | 부른다 |
| 이 브라우저에서 끔(`localStorage nmv-analytics-opt-out=1`) | 거부 | — | 부르지 않는다 |
| Global Privacy Control(`navigator.globalPrivacyControl`) | 거부 | — | 부르지 않는다 |
| Do Not Track = 1 | 거부 | — | 부르지 않는다 |
| 브라우저 시간대가 유럽(`Europe/*`, 대서양 섬, EU 최외곽 지역, 옛 별칭) | 거부 | — | 부르지 않는다 |
| 시간대로 못 거른 유럽 경제 지역·영국·스위스 방문자(Google 이 IP 로 판단) | 거부 | 거부(region 기본값) | 부른다 — 쿠키 없는 신호만 |

- `ad_storage`·`ad_user_data`·`ad_personalization` 은 어디서나 거부다. 광고 기능을 쓰지 않는다.
- **더 안전한 쪽을 골랐다**: 거부된 방문자에게는 쿠키 없는 신호(cookieless ping)도 보내지 않도록 gtag 를 아예 부르지 않는다.
  브라우저가 아는 신호(끄기·GPC·DNT·시간대)는 이렇게 지킨다.
- 지역은 브라우저가 모른다. 공개 HTML 은 Cloudflare 에 나라 구분 없이 저장되므로(`next.config.ts`) 서버가 나라 머리글로 가를 수도
  없다. 그래서 시간대로 먼저 넓게 거르고(러시아·터키 같은 유럽 시간대도 끈다), 남는 방문자는 gtag 의 지역별 기본값
  (`region`: EU 27 + IS·LI·NO + GB·CH)으로 `analytics_storage` 를 거부한다. 이 경우만 GA4 가 쿠키·클라이언트 ID 없는 신호를 받는다.
- 끄기 단추: 정책 화면 `#analytics` 와 푸터. 누르면 그 자리에서 `consent update analytics_storage=denied`, `ga-disable-<ID>=true`,
  GA 쿠키(`_ga`, `_ga_*`, `_gid`) 삭제. 다시 켜기는 다른 이유(GPC·DNT·지역)가 없을 때만 켠다. GPC·DNT·지역으로 꺼진 사람에게
  켜기 단추는 없다.
- **쿠키 배너를 두지 않는다**: 광고 기능을 모두 끄고, 개인을 가리키는 값을 보내지 않고, 동의가 필요한 지역(유럽 경제 지역·영국·
  스위스)에서는 분석 쿠키를 쓰지 않으며, GPC·DNT 를 따르고, 언제든 끌 수 있게 했다. 한국 개인정보보호법은 처리방침에 알리는
  것으로 충분하다(정책 화면에 처리자·항목·목적·보관·거부 방법을 적었다). 미국 주법(CCPA 등)은 판매·공유가 아니면 동의를 요구하지
  않고 GPC 를 따른다. 유럽 방문자에게 분석 쿠키가 필요해지면 그때 동의 배너를 따로 만든다.

## 개인정보

- 보내지 않는 것: 이메일, 이름·닉네임, 계정 번호, IP, 토큰·비밀번호·CSRF, 요청 폼의 내용, 비밀이 든 주소.
  `sanitizeParams()` 가 금지 키(`FORBIDDEN_PARAM_KEYS`)를 지우고 값 속 이메일·토큰을 지우고 100자로 자른다.
- 주소: 질의는 `via`·`utm_*`·`tab`·`sort`·`new` 만 남기고 `#` 뒤는 버린다. `q`(검색어)·`returnTo`·`category`·`pending` 등은
  주소에서 빠진다. 바깥 주소(앞 화면)는 origin+경로만.
- 검색어: `search` 이벤트로만. 소문자·공백 정리·64자, 이메일·7자리 이상 숫자(전화·코드)·토큰 같은 조각은 지운다.
- 제품은 slug 로만 가리킨다. 제품 이름은 보내지 않는다.
- 정책 화면 `#analytics`(4개 언어)에 처리자(Google, GA4)·모으는 것·목적·쿠키·보관 14개월·끄는 법·광고 기능 없음을 적었다.
  보내는 이벤트나 보관 기간을 바꾸면 정책 문구도 같이 고친다.

## GA 관리 화면 설정

속성을 만들 때(사람이 한다 — 이 작업은 속성을 만들지 않는다).

| 위치 | 값 | 까닭 |
| --- | --- | --- |
| 데이터 수집 및 수정 → 데이터 보관 → 이벤트 데이터 보관 | **14개월** | 정책 화면에 적은 값. 기본값(2개월)이면 정책과 어긋난다 |
| 데이터 수집 → Google 신호 데이터 수집 | 끔 | 정책: Google 신호 쓰지 않음 |
| 데이터 수집 → 광고 맞춤설정 | 모든 지역 끔 | 정책: 광고 맞춤 쓰지 않음 |
| 데이터 수집 → 세분화된 위치 및 기기 데이터 수집 | 켜도 된다(도시까지). 유럽만 끄는 것도 가능 | |
| 데이터 스트림 → 향상된 측정 → 페이지 조회 → 고급 설정 → **브라우저 기록 이벤트 기반 페이지 변경** | **끔** | 우리가 `page_view` 를 직접 보낸다. 켜 두면 두 번 센다 |
| 향상된 측정 → 사이트 검색 | 끔 | 검색은 `search` 이벤트로. 주소에 `q` 가 없다 |
| 향상된 측정 → 이탈 클릭(outbound clicks) | 끔 | `outbound_click`·`github_click`·`social_outbound_click` 으로 센다 |
| 향상된 측정 → 양식 상호작용 | 끔 | 폼 이름·내용을 보내지 않는다 |
| 향상된 측정 → 스크롤·파일 다운로드 | 켜도 된다 | |
| 데이터 스트림 → 태그 설정 → 원치 않는 추천 | 비워 둔다 | GitHub README 에서 오는 방문을 잃지 않게. 다만 공개 로그인 콜백(`/api/auth/user/github/callback`)은 메이커 콜백과 달리 `Referrer-Policy: no-referrer` 가 없어, GitHub 로그인 뒤 첫 화면이 github.com 유입의 새 세션으로 잡힐 수 있다 — PR C 가 머리글을 더하거나 다르게 정한다 |

맞춤 정의(이벤트 범위)로 등록할 매개변수: `page_type`, `locale`, `page_path`, `surface`, `product_slug`, `link_kind`, `method`,
`source`, `target`, `filter_name`, `filter_value`, `content_type`, `copy_target`, `command_kind`, `step`. 경로 탐색·유입 경로
보고서 구성은 PR C 가 이 문서에 더한다.

## 확인(GA DebugView)

로컬

1. `GA_MEASUREMENT_ID` 없이 `GA_DEBUG=1 npm run dev` — 브라우저 콘솔에 `[analytics] page_view {…}` 가 찍힌다(개발 전용, 운영에서는 찍지 않는다).
2. 화면을 옮겨 다니며 `page_location` 에 `q`·`returnTo` 가 없는지, `page_type`·`locale` 이 맞는지 본다.

운영(켜는 날)

1. 두 웹에 `GA_MEASUREMENT_ID` 와 **임시로** `GA_DEBUG=1` 을 넣고 웹만 다시 배포한다.
2. GPC·DNT 가 꺼진 브라우저, 유럽이 아닌 시간대에서 https://nomorevibe.com 을 연다. 개발자 도구 Network 에서
   `googletagmanager.com/gtag/js?id=G-…` 와 `…google-analytics.com/g/collect` 요청을 본다.
3. GA → 관리 → DebugView 에서 `page_view`(매개변수 `page_type`·`locale`·`page_location`)가 들어오는지, 화면을 옮기면 새
   `page_view` 가 한 번씩만 오는지 본다.
4. `/?q=test` → `page_location` 이 `/` 이고 `page_type` 이 `search` 인지. `/login?returnTo=%2Fme` → `returnTo` 가 없는지.
5. 푸터 '방문 분석 끄기' → 이후 DebugView 에 아무것도 오지 않는지, 쿠키 `_ga*` 가 지워졌는지. '다시 켜기'로 돌아오는지.
6. `/admin`(Tailscale) 화면에서 `googletagmanager` 요청이 없는지.
7. GPC 를 켠 브라우저(Brave, Firefox 의 GPC 설정)에서 `googletagmanager` 요청이 없는지.
8. 끝나면 `GA_DEBUG` 를 지우고 웹만 다시 배포한다(디버그 이벤트는 표준 보고서에 섞이지 않지만 오래 두지 않는다).

## CSP·보안 머리글

2026-10-22 확인: 저장소(`next.config.ts` 의 `headers()` 는 `Cache-Tag`·`Cloudflare-CDN-Cache-Control` 만, `proxy.ts` 는 언어·관리자
관문만)와 운영 응답(`curl -I https://nomorevibe.com/`) 모두 Content-Security-Policy 가 없다. 그래서 이 작업은 CSP 를 더하지 않았다.
나중에 CSP 를 넣으면 다음을 허용한다.

```
script-src  https://www.googletagmanager.com
connect-src https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com
img-src     https://*.google-analytics.com https://*.googletagmanager.com
```

로더의 동의·설정 명령은 인라인 스크립트가 아니라 번들 JS 에서 넣으므로 `unsafe-inline`·nonce 가 필요 없다.
