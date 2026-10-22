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
| `lib/analytics/server.ts` | (PR C) 서버 발신 `trackServer()` — Measurement Protocol, 동의·봇 거르기, 목록 검사, 응답 뒤 1.5초 상한 |
| `lib/analytics/identity.ts` | (PR C) `_ga`·`_ga_<스트림>` 읽기, 일회용 client_id, 가명 user_id(HMAC) |
| `lib/analytics/page-user.ts` | (PR C) 공개 화면 로더에 넘길 가명 user_id(로그인했을 때만) |

## 켜는 법

1. GA4 속성과 웹 데이터 스트림을 만들고 측정 ID(`G-XXXXXXXXXX`)를 받는다. 아래 [GA 관리 화면 설정](#ga-관리-화면-설정)을 먼저 맞춘다.
2. Dokploy 에서 **웹 앱 두 개(M3 웹, mini 웹)** 의 실행 환경(Environment)에 같은 값을 넣는다.
   ```
   GA_MEASUREMENT_ID=G-XXXXXXXXXX
   ```
   - 빌드 비밀(buildSecrets)·`NEXT_PUBLIC_` 변수가 아니다. 웹 이미지는 CI 에서 비밀 없이 굽고, 서버가 요청마다 이 값을 읽어
     브라우저 로더에 넘긴다. 측정 ID 는 비밀이 아니다(페이지 소스에 보인다).
   - 워커·scheduler 에는 넣지 않는다. 서버 발신(PR C)도 모두 웹의 route handler 에서 나간다 — [서버 이벤트](#서버-이벤트pr-c)의
     `GA_API_SECRET`·`ANALYTICS_USER_ID_SECRET`·`GA_PROPERTY_URL` 도 두 웹에만 넣는다.
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
- **user_id**: 계정 번호는 보내지 않는다. `ANALYTICS_USER_ID_SECRET` 이 있으면 로그인한 사람에게 가명 user_id(HMAC)를
  `gtag('config', …, { user_id })` 로 붙인다 — [가명 user_id](#가명-user_id) 참고.
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
| `skill_script_download` | 서버 | /install.sh·/skill.md 를 받아 갔다 | `script` (install_sh·skill_md), `agent_class`? (curl·wget·browser·other) |
| `launch_submitted` | 서버 | 스킬로 등록이 들어왔다 | `product_slug`, `source` (skill·other) |
| `product_claimed` | 서버 | 소유 확인이 끝났다 | `product_slug`, `method` (skill_verify·github·other) |
| `github_connected` | 서버 | GitHub 연결이 끝났다 | `kind` (login·star·app_install) |
| `verify_requested` | 서버 | 소유 확인 요청이 들어왔다(스킬) | `product_slug` |
| `verify_succeeded` | 서버 | 소유 확인이 이번에 통과했다 | `product_slug`, `method` (file·meta) |
| `badge_impression` | 서버 | README 배지를 내줬다(합계·캐시가 빈 때만) | `product_slug`, `badge_style` (verified·listed·tried), `badge_lang` (ko·en) |
| `reaction_add` | 서버 | 써봤어요 평가가 처음 저장됐다 | `product_slug`, `verdict` (good·meh·bad), `reaction_source` (panel·return·sheet·me), `signed_in` (yes·no) |
| `feedback_received` | 서버 | 상세 요청이 저장됐다 | `product_slug`, `feedback_kind` (bug·feature·question) |

서버 이벤트에는 목록 밖의 운반 값이 붙는다: `id_source`(ga_cookie·random·aggregate), 세션을 알 때 `session_id`·`engagement_time_msec`(1),
운영자 표시가 있으면 `traffic_type=internal`, `GA_DEBUG=1` 이면 `debug_mode`. 자세한 것은 [서버 이벤트](#서버-이벤트pr-c).

`surface` 값: home·browse·search·product·talk·popular·rising·rankings·launch·policy·me·login·feedback·header·footer·mobile_nav·related·dialog·other.

`outbound_click`(누름)과 `outbound_visit`(서버가 실제로 보냄)은 따로 센다 — 둘의 차이가 차단기·새 탭 실패 등으로 잃는 몫이다.

## 화면에 단 표시(브라우저 이벤트, PR B)

컴포넌트마다 onClick 에 분석 코드를 흩지 않는다. 화면은 무엇을 보낼지 `data-*` 속성으로 적고(`lib/analytics/attrs.ts`),
런타임이 문서에 단 클릭 듣개 하나(잡기 단계, 막지 않음)가 읽는다(`lib/analytics/dom.ts`). 서버 응답을 받아야 아는 것
(공유 성공·써봤어요 저장·팔로 성공·요청 폼 접수·이메일 로그인 성공)만 컴포넌트가 `track()`/`trackEvents()` 를 직접 부른다.

| 표시 | 뜻 |
| --- | --- |
| `{...trackAttrs(name, params)}` | 누르면 그 이벤트. `surface` 를 빼면 가장 가까운 `data-track-surface` 나 화면 갈래로 채운다 |
| `{...trackViewAttrs(name, params)}` | 화면에 절반 넘게 들어오면 화면마다 한 번(`/launch` 단계) |
| 제품 링크 `/p/<slug>` | 자동 `select_item`. 목록은 위의 `data-track-list`, 없으면 가장 가까운 `id`·`aria-labelledby`. 이름 앞에 화면 갈래를 붙인다 |
| `/go/<slug>` 링크 | 자동 `outbound_click`. `data-track-kind="repo"` 면 저장소, 없으면 사이트 |
| `data-track-nav="header\|footer\|mobile_nav"` | 안의 링크는 `nav_click`(target 은 주소 첫 마디, `/` 는 home, `?metric` 은 metrics, `#` 은 붙인다) |
| `data-track-filter="<이름>"` + `data-track-value` | 안의 링크는 `filter_change` |
| github.com 링크 | 상세 화면이거나 `data-track-product` 가 있으면 `github_click` |
| HN·X·Bluesky·Reddit 링크 | `social_outbound_click`(제품은 `data-track-product` 또는 상세 주소) |
| `/install.sh`·`/skill.md` 링크 | `skill_script_view` |
| `data-track-page-type="not_found"` | 그 화면의 `page_view` 갈래를 주소 대신 이 값으로 |
| `data-track-ignore` | 안의 클릭은 보내지 않는다 |
| `<TrackOnMount name params />` | 그려지면 한 번(검색 결과 수, 404, 오류 경계) |

자주 보게 될 목록 id(`item_list_id`): `home_rising`·`home_new`·`home_project_grid`·`home_unclaimed`·`home_talk`·`home_talk_lead`·
`home_popular_<tier>`·`search_project_grid`·`browse_project_grid`·`rising_star_growth_list`·`popular_popular_list`·`talk_talk_feature`·
`talk_entries`·`rankings_table`·`product_related`·`me_me_saved`·`me_tried`·`me_following_products`.

`/launch` 깔때기: `page_view(launch)` → `launch_step_view`(1 install · 2 how_it_works · 3 verify · 4 no_cli) → `skill_install_copy`
(`install_sh` 첫 화면, `install_sh_verify` 확인 구획) → `launch_command_copy`(launch·verify) → 서버 `skill_script_download` →
서버 `launch_submitted`·`product_claimed`. 스크립트 펼쳐 보기·원문 링크는 `skill_script_view`.

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
| 데이터 스트림 → 태그 설정 → 원치 않는 추천 | 비워 둔다 | GitHub README 에서 오는 방문을 잃지 않게. GitHub 를 거쳐 돌아오는 세 콜백(공개 로그인 `/api/auth/user/github/callback`, 메이커 `/api/auth/maker/github/callback`, 앱 설치 `/api/github/installations/setup`)은 모두 `Referrer-Policy: no-referrer` 로 돌려보낸다(공개 로그인 콜백은 PR C 가 더했다) — 돌아온 첫 화면이 github.com 유입의 새 세션으로 잡히지 않는다 |

맞춤 정의(이벤트 범위)로 등록할 매개변수는 [맞춤 측정기준](#4-맞춤-측정기준)의 표 하나로 모았다(PR A·B·C 이벤트 전부).
경로 탐색·깔때기·BigQuery 는 [방문 여정 분석](#8-방문-여정-분석).

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

## 서버 이벤트(PR C)

브라우저 `track()` 은 "눌렀다"(의도)를, 서버 `trackServer()`(`lib/analytics/server.ts`)는 "실제로 됐다"(사실)를 보낸다.
같은 일을 두 번 세지 않도록 이름을 나눴다. 보내는 곳은 GA4 Measurement Protocol(MP)
`POST https://www.google-analytics.com/mp/collect?measurement_id=…&api_secret=…` 이다.

### 보내는 이벤트

| 이벤트 | 언제(주소) | 매개변수 | 방문자 잇기 |
| --- | --- | --- | --- |
| `outbound_visit` | `GET /go/[slug]` 가 제품으로 302 를 보낼 때. 봇 거르기(`isBotAgent`)를 지난 요청만 | `product_slug`, `link_kind`(설치형·github.com 주소면 repo), `via`?(`/go?via=` 의 `[a-z0-9_-]{1,32}` 만) | 브라우저(`_ga` 필수) |
| `skill_script_download` | `GET /install.sh`(`script=install_sh`), `GET /skill.md`(`skill_md`). 크롤러는 보내지 않는다 | `script`, `agent_class`(curl·wget·browser·other — User-Agent 원문은 보내지 않는다) | 자동 |
| `launch_submitted` | `POST /api/products` 가 201 로 등록을 받았을 때 | `product_slug`, `source`(브라우저 UA 면 other, 아니면 skill) | 자동 |
| `verify_requested` | `POST /api/products/[slug]/verify` — 있는 제품일 때(rate limit 을 지난 뒤) | `product_slug` | 자동 |
| `verify_succeeded` | 같은 요청이 이번에 통과했을 때(이미 확인된 제품의 재요청은 빼고) | `product_slug`, `method`(file·meta) | 자동 |
| `product_claimed` | 위 통과가 주인 없던 제품을 가져간 것일 때(`skill_verify`), `POST /api/maker/claims` 에서 저장소 주인으로 확인된 제품마다(`github`) | `product_slug`, `method` | 자동 / 브라우저 |
| `login` | GitHub 로그인 콜백(`/api/auth/user/github/callback`) — 성공한 로그인마다(가입 포함). 이메일 login 은 브라우저가 보낸다 | `method=github` | 브라우저 + user_id |
| `sign_up` | 새 계정이 생겼을 때 — GitHub 로그인 콜백, 이메일 확인 `POST /api/auth/user/email/verify` | `method`(github·email) | 브라우저 + user_id |
| `github_connected` | 같은 콜백(`kind=login`, 이미 로그인한 사람이 스타 권한을 이으면 `star`), 앱 설치 완료 `/api/github/installations/setup`(`app_install`, 승인 대기 pending 은 빼고) | `kind` | 브라우저 + user_id |
| `reaction_add` | `PUT /api/products/[slug]/reactions` 가 이 사람(계정 또는 이 브라우저)의 **첫** 평가를 저장했을 때. 바꾸기·같은 값은 보내지 않는다 | `product_slug`, `verdict`, `reaction_source`, `signed_in` | 브라우저 + user_id |
| `feedback_received` | `POST /api/products/[slug]/feedback` 가 새 요청을 저장했을 때(재전송 replayed 는 빼고) | `product_slug`, `feedback_kind` | 브라우저 + user_id |
| `badge_impression` | `GET /badge/[slug](.svg)` 가 200 으로 그림을 내줄 때 | `product_slug`, `badge_style`(verified·listed·tried), `badge_lang` | 합계(잇지 않음) |

- **체크인(checkin)은 없다.** 이 서비스에 체크인 기능이 없다 — 가장 가까운 "써봤어요"는 `reaction_add`(서버)·`product_tried`(브라우저)로 센다.
- **로그인·가입**: `login` 은 성공한 로그인마다(가입 포함) — 이메일은 브라우저가 확인 성공 응답에서, GitHub 는 서버가 콜백에서 보낸다.
  `sign_up` 은 새 계정일 때만, 두 수단 모두 서버가 보낸다(새 계정인지는 서버만 안다 — 로그인 결과의 `created`). 새 가입 한 번은 `sign_up` 1 + `login` 1 이다.
- 서버 이벤트는 응답이 정해진 뒤(쓰기가 성공한 뒤)에만 부른다 — 실패한 요청은 세지 않는다.

### 의도(브라우저)와 사실(서버)

| 브라우저 — 눌렀다 | 서버 — 실제로 됐다 | 차이가 말해 주는 것 |
| --- | --- | --- |
| `outbound_click` | `outbound_visit` | 새 탭이 막혔거나, 누르고 떠났거나, 차단기 |
| `github_click`(직접 링크) | — | /go 를 거치지 않아 서버는 모른다 |
| `skill_install_copy`·`skill_script_view` | `skill_script_download` | 복사만 하고 실행하지 않은 몫(쿠키가 이어지지 않는다 — 아래) |
| `claim_start` | `verify_requested`·`verify_succeeded`·`product_claimed` | 확인 파일·메타를 못 올린 몫 |
| `github_connect_start` | `github_connected`, `sign_up`·`login`(github) | GitHub 화면에서 돌아오지 않은 몫 |
| `login_start`(email) | 브라우저의 `login`(email) + 서버의 `sign_up`(email, 새 계정일 때) | 메일 코드를 넣지 않은 몫 |
| `product_tried` | `reaction_add` | 바꾸기(update)는 서버가 세지 않는다 |
| `feedback_submit` | `feedback_received` | 검사·한도에 걸린 몫 |

`outbound_visit` 는 DB 의 '유효 방문'과 다르다 — 10분 중복을 묶지 않고, 분석에 동의한 브라우저(`_ga`)만 센다. 순위·공개 지표의 기준은 여전히 DB(`click_events`)다.

### 방문자 잇기

- **브라우저**(`/go`·로그인 콜백·써봤어요·요청·메이커 확인): `_ga` 쿠키 `GA1.<깊이>.<난수>.<초>` 의 뒤 두 조각을 client_id 로 그대로 쓴다.
  같은 사람의 `page_view` 와 서버 이벤트가 한 흐름(사용자 탐색기·경로 탐색·BigQuery 의 `user_pseudo_id`)에 놓인다.
  `_ga_<측정 ID 에서 G- 뺀 것>` 쿠키가 있으면 session_id 를 꺼내(`GS1.1.<id>.…`·`GS2.1.s<id>$…` 둘 다) `session_id` 와
  `engagement_time_msec: 1` 을 붙인다 — 그 세션의 이벤트로 보인다(참여 시간은 사실상 늘지 않는다).
  **`_ga` 가 없으면 보내지 않는다** — 분석을 껐거나(끄기는 `_ga*` 를 지운다) 동의 전이다. 쿠키 없는 신호도 보내지 않는다(PR A 와 같은 선택).
- **자동**(스킬 API·설치 스크립트): `_ga` 가 있으면 위처럼 잇는다. 없고 User-Agent 가 브라우저면 보내지 않는다. 그 밖(curl·wget·에이전트)이면
  요청마다 새 client_id(`<난수>.<초>`)를 만들고 세션·참여 시간을 붙이지 않는다. **이런 이벤트는 GA 에서 서로 다른 '사용자'로 잡힌다** —
  CLI 설치 한 번(`install.sh` 1 + `skill.md` 2)과 등록·확인 요청이 모두 다른 사람처럼 센다. 사용자 수가 아니라 이벤트 수로 본다.
  `id_source=random` 으로 걸러 낼 수 있다.
- **합계**(배지): 이벤트마다 고정 client_id(`aggregate.badge_impression`) 하나. user_id·세션 없음. 사용자 수를 부풀리지 않는다.
  배지는 브라우저·GitHub 이미지 프록시(github-camo)가 한 시간 들고 있으므로 이 수는 "캐시가 비어 우리에게 온 횟수", 노출의 하한이다.
  배지 링크로 들어온 방문은 상세 주소의 `?via=badge`(page_view 의 `page_location`)로 본다.

### 서버 쪽 동의

브라우저(`lib/analytics/consent.ts`)와 같은 순서로 막는다: `Sec-GPC: 1` → `DNT: 1` → Cloudflare 의 `CF-IPCountry` 가 유럽 경제 지역·영국·스위스
(`CONSENT_DENIED_REGIONS`) → (브라우저·자동) `_ga` 없음. 합계(배지)에도 GPC·DNT·지역을 적용한다. 크롤러(`isBotAgent`)는 어느 경우에도 보내지 않는다.
`CF-IPCountry` 가 없으면(Cloudflare 를 거치지 않은 요청) 지역으로는 막지 않는다 — 브라우저 요청은 `_ga` 가 없으면 어차피 막힌다.

### 가명 user_id

- `HMAC-SHA256(ANALYTICS_USER_ID_SECRET, "user:" + 내부 id)` 의 앞 32글자(hex). 되돌릴 수 없고, 계정 번호는 어디에도 싣지 않는다.
- 서버 이벤트(로그인 콜백·써봤어요·요청·메이커 확인·앱 설치)는 세션의 사람에게 늘 붙인다.
- 브라우저는 공개 화면 틀이 로그인 쿠키(`nmv_user`)가 있을 때만 세션을 읽어 같은 값을 `gtag('config', …, { user_id })` 로 넘긴다
  (`components/analytics/GoogleAnalytics.tsx` → `lib/analytics/page-user.ts`, Suspense 로 따로 흘려 틀을 기다리게 하지 않는다).
  로그인 쿠키가 있는 응답은 Cloudflare 가 저장하지 않으므로(`next.config.ts`) 남의 화면에 섞이지 않는다. 거꾸로 로그인한 사람도
  Cloudflare 가 저장한 익명 사본을 받으면 그 화면에는 user_id 가 없다 — 그 화면의 이벤트는 client_id 로만 잇는다.
- 비밀이 없거나 32자보다 짧으면 user_id 를 붙이지 않고 세션도 읽지 않는다. **두 웹에 같은 값**을 둔다(다르면 같은 사람이 둘이 된다).
  바꾸면 모든 로그인 사용자가 새 사람으로 잡힌다 — 유출 대응 외에는 바꾸지 않는다. `VISITOR_HASH_SECRET`·`AUTH_SECRET` 과 다른 값.
- 정책 화면 `#analytics` 의 `analytics.server`·`analytics.userId` 문단(4개 언어)이 이 동작을 알린다.

### 지연·실패·DR

- `after()` 로 응답을 보낸 뒤 보낸다(요청 밖이면 그 자리에서 띄우고 기다리지 않는다). `AbortSignal.timeout(1.5초)`.
  실패는 debug 로그 한 줄(`analytics.mp_failed`), 2xx 가 아니면 warn(`analytics.mp_rejected`). 주소에 API 비밀이 있으므로 주소는 로그에 남기지 않는다.
- 목록(`lib/analytics/events.ts`)에 없는 이름·브라우저 전용 이름·빠지거나 남는 매개변수·허용 밖 값은 통째로 보내지 않고 warn(`analytics.server_event_refused`).
  값은 PR A 의 `sanitizeParams()` 를 거친다(금지 키·이메일·토큰 지움, 100자).
- 응답 상태·본문·리다이렉트·시간은 바뀌지 않는다(`tests/analytics-server-routes.test.ts`, `tests/integration/go-analytics.test.ts` — GA 가 답하지 않아도 같은 302).
- DR 쓰기 관문: GA 는 우리 DB 가 아니라 관문을 거치지 않는다. 쓰기 이벤트(`sign_up`·`reaction_add`·`feedback_received`·`product_claimed` 등)는
  쓰기가 성공한 뒤에만 부르므로 fenced 웹에서는 나가지 않는다. `outbound_visit`·`skill_script_download`·`badge_impression` 은 응답 자체가 사실이라
  fence 와 상관없이 보낸다(`/go` 의 DB 클릭 기록은 지금처럼 건너뛴다).

### 환경 변수

| 변수 | 넣는 곳 | 비밀 | 없으면 |
| --- | --- | --- | --- |
| `GA_MEASUREMENT_ID` | M3 웹·mini 웹(PR A) | 아님 | 브라우저·서버 모두 꺼짐 |
| `GA_API_SECRET` | M3 웹·mini 웹 | **비밀** | 서버 이벤트만 꺼짐(브라우저는 그대로) |
| `ANALYTICS_USER_ID_SECRET` | M3 웹·mini 웹, 같은 값, 32자 이상(`openssl rand -hex 32`) | **비밀** | user_id 없이 보낸다 |
| `GA_PROPERTY_URL` | M3 웹·mini 웹(운영센터가 웹에 있다) | 아님 | 운영센터 바로가기를 숨긴다 |
| `GA_DEBUG` | 확인하는 동안만 | 아님 | 서버 이벤트에도 `debug_mode` 를 붙인다 |

- 모두 실행 환경(Environment)에만 넣는다(buildSecrets·`NEXT_PUBLIC_` 아님). 비밀은 Dokploy 비밀 설정으로만 — 문서·Git·명령 인자·로그에 남기지 않는다.
- 워커(scheduler·crawler·reviewer·publisher·text·maintenance)에는 넣지 않는다. 서버 이벤트는 모두 웹의 route handler 에서 나간다.
- 넣고 나면 **웹만** 다시 배포한다.

## GA 속성 만들기와 방문 여정(PR C)

사람이 GA 화면에서 한다. 이 작업은 속성을 만들거나 GA 로 무엇을 보내지 않았다.

### 1. 속성과 웹 데이터 스트림

1. [analytics.google.com](https://analytics.google.com) → 관리 → 만들기 → 속성. 이름 `nomorevibe`, 시간대 **대한민국(Asia/Seoul)**, 통화 원(KRW).
   업종·규모는 아무것이나. 비즈니스 목표는 "사용자 행동 파악" 정도.
2. 데이터 스트림 → 웹 → `https://nomorevibe.com`, 이름 `nomorevibe web`. 향상된 측정은 위 [GA 관리 화면 설정](#ga-관리-화면-설정) 표대로.
3. 측정 ID(`G-…`)를 `GA_MEASUREMENT_ID` 로. 속성 화면 주소(`https://analytics.google.com/analytics/web/#/p<속성 번호>/reports/intelligenthome`)를
   `GA_PROPERTY_URL` 로.

### 2. Measurement Protocol API 비밀

관리 → 데이터 스트림 → `nomorevibe web` → **Measurement Protocol API 비밀** → 만들기(별칭 `nomorevibe-web-server`). 값을 `GA_API_SECRET` 로
두 웹에 넣는다. 유출되면 같은 화면에서 지우고 새로 만든다(남이 우리 속성에 가짜 이벤트를 넣을 수 있는 값이다).

### 3. 보관 14개월

관리 → 데이터 수집 및 수정 → 데이터 보관 → 이벤트 데이터 보관 **14개월**, "새 활동 시 사용자 데이터 재설정" 켬. 탐색(경로·깔때기·사용자 탐색기)은
이 기간 안의 데이터만 본다. 그보다 긴 원자료는 [BigQuery](#9-bigquery-내보내기)로 남긴다.

### 4. 맞춤 측정기준

관리 → 데이터 표시 → 맞춤 정의 → 맞춤 측정기준 만들기 → 범위 **이벤트**, 이벤트 매개변수에 아래 이름을 그대로. 표준 속성 한도(이벤트 범위 50개) 안이다.
등록한 날부터 쌓인다(지난 데이터에는 붙지 않는다) — 켜는 날 함께 등록한다.

| 측정기준 이름 | 매개변수 | 어디서 |
| --- | --- | --- |
| 화면 갈래 | `page_type` | page_view·app_error |
| 언어 | `locale` | page_view |
| 화면 경로 | `page_path` | page_view |
| 화면 자리 | `surface` | 클릭 이벤트 대부분 |
| 제품 | `product_slug` | 제품 이벤트, 서버 이벤트 |
| 목록 이름 | `item_list_name` | select_item |
| 목록 ID | `item_list_id` | select_item |
| 링크 갈래 | `link_kind` | outbound_click·outbound_visit |
| 유입 표시 | `via` | outbound_visit(page_view 는 주소의 `?via=`) |
| 출처 | `source` | social_outbound_click·launch_submitted |
| 수단 | `method` | login·sign_up·login_start·share·product_claimed·verify_succeeded |
| 메뉴 대상 | `target` | nav_click |
| 거르기 이름 | `filter_name` | filter_change |
| 거르기 값 | `filter_value` | filter_change |
| 내용 갈래 | `content_type` | select_content·share |
| 내용 ID | `content_id` | select_content |
| 복사 대상 | `copy_target` | copy_text |
| 설치 명령 | `command` | skill_install_copy |
| 명령 갈래 | `command_kind` | launch_command_copy |
| 단계 | `step` | launch_step_view·claim_start |
| 스크립트 | `script` | skill_script_view·skill_script_download |
| 받은 쪽 | `agent_class` | skill_script_download |
| 연결 갈래 | `kind` | github_connect_start·github_connected |
| 동작 | `action` | product_save·product_tried·follow_change·github_star·reaction_change |
| 평가 | `verdict` | product_tried·reaction_add |
| 반응 갈래 | `reaction_kind` | reaction_change |
| 평가 자리 | `reaction_source` | reaction_add |
| 로그인 여부 | `signed_in` | reaction_add |
| 요청 갈래 | `feedback_kind` | feedback_submit·feedback_received |
| 배지 모양 | `badge_style` | badge_impression |
| 배지 언어 | `badge_lang` | badge_impression |
| 오류 코드 | `error_code` | app_error |
| 방문자 출처 | `id_source` | 서버 이벤트 전부(ga_cookie·random·aggregate) |

맞춤 측정항목(선택, 이벤트 범위): `index`(목록 위치), `result_count`(검색 결과 수), `step_index`. `traffic_type`·`session_id`·`engagement_time_msec`·`debug_mode` 는
GA 가 아는 이름이라 등록하지 않는다. user_id 는 내장이다.

### 5. 핵심 이벤트(전환)

관리 → 데이터 표시 → 핵심 이벤트 → 새 핵심 이벤트 → 이름을 그대로(아직 들어온 적 없어도 미리 만들 수 있다).

| 이벤트 | 보내는 곳 | 뜻 |
| --- | --- | --- |
| `outbound_visit` | 서버 | 제품으로 실제로 나갔다 — 이 서비스의 첫째 목표 |
| `github_click` | 브라우저 | GitHub 저장소로 직접 나갔다 |
| `skill_install_copy` | 브라우저 | 스킬 설치 명령을 복사했다 |
| `skill_script_download` | 서버 | 설치 스크립트를 받아 갔다(대부분 CLI — 다른 '사용자') |
| `launch_submitted` | 서버 | 스킬로 등록했다(CLI) |
| `sign_up` | 서버(두 수단 모두) | 가입했다 |
| `reaction_add` | 서버 | 써봤어요를 처음 남겼다 |
| `product_claimed` | 서버 | 메이커가 제품을 가져갔다(요청에 있던 `checkin` 대신 — 체크인 기능이 없다) |

`skill_script_download`·`launch_submitted` 는 CLI 에서 오므로 브라우저 세션의 전환율에는 거의 잡히지 않는다 — 이벤트 수로 본다.

### 6. 내부 트래픽 빼기(IP 없이)

GA 의 기본 내부 트래픽 규칙은 IP 로 가른다. IP 를 쓰지 않는다.

- **운영자 브라우저는 분석을 끈다**: 푸터 '방문 분석 끄기'. 브라우저 이벤트가 멈추고 `_ga*` 가 지워지므로 서버 이벤트도 나가지 않는다(가장 확실).
- **보이되 표시만 하려면**(DebugView 로 확인하는 운영자): 그 브라우저 콘솔에서
  `document.cookie = "nmv_internal=1; Path=/; Max-Age=31536000; Secure; SameSite=Lax"`. 서버 이벤트에 `traffic_type=internal` 이 붙는다.
  관리 → 데이터 수집 및 수정 → 데이터 필터 → `Internal Traffic`(매개변수 값 `internal`)을 **테스트**로 두면 탐색에서 "테스트 데이터 필터 이름"으로 갈라 볼 수 있고,
  **활성**으로 바꾸면 그 뒤로 영구히 빠진다(되돌릴 수 없다). 브라우저 gtag 는 아직 이 쿠키를 읽지 않는다 — 브라우저 이벤트까지 표시하려면
  로더가 이 쿠키를 보고 `gtag('set', { traffic_type: 'internal' })` 하는 후속 작업이 필요하다(PR B 이후).
- `GA_DEBUG=1` 로 보낸 이벤트는 GA 의 '개발자 트래픽' 필터 대상이라 표준 보고서에 섞이지 않는다.
- 관리자 화면(Tailscale origin)에는 로더가 없다.

### 7. 추천 제외

[GA 관리 화면 설정](#ga-관리-화면-설정)의 '원치 않는 추천'은 비워 둔다. `github.com` 을 넣으면 README·배지 링크로 오는 유입이 모두 사라진다.
GitHub 를 거쳐 돌아오는 콜백 셋이 `Referrer-Policy: no-referrer` 로 돌려보내므로, 로그인·앱 설치 뒤 첫 화면은 직접 유입으로 기존 세션을 잇는다.
결제·외부 로그인 같은 다른 중간 도메인은 없다. 관리자 origin 은 GA 를 싣지 않으므로 넣지 않는다.

### 8. 방문 여정 분석

먼저 관리 → 데이터 표시 → 보고 ID 를 **관찰됨(Observed)**(user_id → 기기 순, 모델링 없음)으로 둔다. Google 신호를 껐으므로 기준점(thresholding)에 거의 걸리지 않는다.

**경로 탐색(Path exploration)** — 탐색 → 경로 탐색 → 새로 시작.
- 시작점: 이벤트 이름 `session_start`. 노드 유형은 단계마다 "이벤트 이름"과 "페이지 경로 및 화면 클래스"를 번갈아, 또는 맞춤 측정기준 `화면 갈래`.
  `user_engagement`·`scroll`·`first_visit` 은 "노드 제외"로 뺀다. 측정기준 분석에 `제품` 을 두면 어느 제품에서 갈렸는지 보인다.
- 끝점 거꾸로: 끝 `skill_install_copy`(브라우저 — 앞 단계가 이어진다). **`skill_script_download` 를 끝으로 두면 앞 단계가 거의 비어 있다** —
  대부분 CLI 의 일회용 client_id 라 브라우저 경로와 이어지지 않는다. 그 몫은 아래 BigQuery 3번처럼 날짜별 수로 본다.
- 끝 `outbound_visit` — 무엇을 보고 제품으로 나갔는지(서버 이벤트가 `_ga` 로 브라우저 세션에 붙는다).

**깔때기 — 스킬 설치**: 탐색 → 유입경로 탐색 → 단계
1. `page_view` 이고 `화면 갈래` = `launch`
2. `skill_install_copy`
3. `skill_script_download`
4. `launch_submitted`

**열린 유입경로(open funnel)** 로 만든다. 1→2 는 같은 브라우저라 전환율이 맞다. 3·4 는 CLI(다른 '사용자')라 닫힌 깔때기에서는 거의 0 이 된다 —
열린 깔때기의 각 단계 "진입" 수를 날짜별로 비교한다(시각화 '유입경로 추세'). `id_source` 를 측정기준으로 두면 3·4 단계 중 브라우저에서 이어진 몫이 갈린다.

**깔때기 — 발견**: 닫힌 유입경로, 같은 세션 안("세션 내" 범위)
1. `select_item`(측정기준 분석 `목록 이름`)
2. `page_view` 이고 `화면 갈래` = `product`
3. `outbound_click`
4. `outbound_visit`

3→4 의 빠짐은 새 탭이 막히거나 누르고 떠난 몫이다. 단계 사이 경과 시간을 켜면 상세에서 나가기까지 걸린 시간이 보인다.

**사용자 탐색기(User explorer)**: 탐색 → 사용자 탐색기. 행이 `앱 인스턴스 ID`(= client_id) 또는 `사용자 ID`(= 가명 user_id)다.
한 사람을 열면 브라우저 이벤트와 서버 이벤트(`outbound_visit`·`reaction_add`·`sign_up`…)가 시간순으로 한 줄에 보인다.
`aggregate.badge_impression` 행은 배지 합계라 사람이 아니다. `id_source=random` 인 사람은 CLI 요청 하나다.

### 9. BigQuery 내보내기

사람별 원자료(모든 이벤트, 14개월 넘게)는 무료 일별 내보내기로 남긴다.

1. Google Cloud 프로젝트를 고른다(없으면 만든다). BigQuery API 를 켠다. 결제를 연결하지 않은 BigQuery 샌드박스면 표가 **60일 뒤 지워진다** —
   오래 남기려면 결제를 연결한다(이 규모의 저장·조회는 무료 한도 안팎이다).
2. GA 관리 → 제품 링크 → BigQuery 링크 → 연결 → 프로젝트 → 위치 **서울(asia-northeast3)** → 데이터 스트림 `nomorevibe web` →
   빈도 **매일**(스트리밍은 비용이 든다) → 광고 식별자 포함 끔.
3. 다음 날부터 `PROJECT.analytics_<속성 번호>.events_YYYYMMDD` 가 생긴다. `user_pseudo_id` = client_id, `user_id` = 가명 user_id.

아래 `PROJECT.analytics_PROPERTY` 를 바꿔 쓴다. 날짜는 속성 시간대(KST)다.

```sql
-- 1) 어제 세션마다 이벤트 순서 — 브라우저 page_view 와 서버 이벤트가 한 줄에 놓인다
WITH ev AS (
  SELECT
    user_pseudo_id,
    user_id,
    -- 브라우저는 ga_session_id, MP 로 보낸 서버 이벤트는 session_id 로 들어올 수 있어 둘 다 본다(아래 '확인하지 않은 것')
    COALESCE(
      (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id'),
      (SELECT SAFE_CAST(COALESCE(value.string_value, CAST(value.int_value AS STRING)) AS INT64) FROM UNNEST(event_params) WHERE key = 'session_id')
    ) AS session_id,
    event_timestamp,
    event_name,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_type') AS page_type,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'product_slug') AS product_slug
  FROM `PROJECT.analytics_PROPERTY.events_*`
  WHERE _TABLE_SUFFIX = FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY))
    AND event_name NOT IN ('user_engagement', 'scroll')
)
SELECT
  user_pseudo_id,
  session_id,
  MAX(user_id) AS user_id,
  STRING_AGG(
    CASE
      WHEN event_name = 'page_view' THEN CONCAT('view:', IFNULL(page_type, '?'))
      WHEN product_slug IS NOT NULL THEN CONCAT(event_name, ':', product_slug)
      ELSE event_name
    END, ' > ' ORDER BY event_timestamp) AS path,
  COUNT(*) AS events
FROM ev
WHERE session_id IS NOT NULL
GROUP BY user_pseudo_id, session_id
ORDER BY events DESC
LIMIT 200;
```

```sql
-- 2) 발견 깔때기를 첫 화면 갈래별로 — 최근 28일, 세션 단위(순서는 보지 않고 "도달했나"만)
WITH ev AS (
  SELECT
    user_pseudo_id,
    COALESCE(
      (SELECT value.int_value FROM UNNEST(event_params) WHERE key = 'ga_session_id'),
      (SELECT SAFE_CAST(COALESCE(value.string_value, CAST(value.int_value AS STRING)) AS INT64) FROM UNNEST(event_params) WHERE key = 'session_id')
    ) AS session_id,
    event_timestamp,
    event_name,
    (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_type') AS page_type
  FROM `PROJECT.analytics_PROPERTY.events_*`
  WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 28 DAY))
                          AND FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY))
),
sessions AS (
  SELECT
    user_pseudo_id,
    session_id,
    ARRAY_AGG(IF(event_name = 'page_view', page_type, NULL) IGNORE NULLS ORDER BY event_timestamp LIMIT 1)[SAFE_OFFSET(0)] AS landing_page_type,
    LOGICAL_OR(event_name = 'select_item') AS selected,
    LOGICAL_OR(event_name = 'page_view' AND page_type = 'product') AS viewed_product,
    LOGICAL_OR(event_name = 'outbound_click') AS clicked_out,
    LOGICAL_OR(event_name = 'outbound_visit') AS visited
  FROM ev
  WHERE session_id IS NOT NULL
  GROUP BY user_pseudo_id, session_id
)
SELECT
  IFNULL(landing_page_type, '(none)') AS landing_page_type,
  COUNT(*) AS sessions,
  COUNTIF(selected) AS select_item,
  COUNTIF(viewed_product) AS product_view,
  COUNTIF(clicked_out) AS outbound_click,
  COUNTIF(visited) AS outbound_visit,
  ROUND(100 * SAFE_DIVIDE(COUNTIF(visited), COUNT(*)), 1) AS visit_rate_pct
FROM sessions
GROUP BY landing_page_type
ORDER BY sessions DESC;
```

```sql
-- 3) 스킬 설치 — 의도(브라우저)와 사실(서버, 대부분 CLI)을 날짜별 수로. 사람으로 잇지 않는다
SELECT
  PARSE_DATE('%Y%m%d', event_date) AS day,
  COUNTIF(event_name = 'page_view'
    AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'page_type') = 'launch') AS launch_views,
  COUNTIF(event_name = 'skill_install_copy') AS install_copies,
  COUNTIF(event_name = 'skill_script_download'
    AND (SELECT value.string_value FROM UNNEST(event_params) WHERE key = 'script') = 'install_sh') AS install_sh,
  COUNTIF(event_name = 'launch_submitted') AS launches,
  COUNTIF(event_name = 'verify_succeeded') AS verified,
  COUNTIF(event_name = 'product_claimed') AS claimed
FROM `PROJECT.analytics_PROPERTY.events_*`
WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 28 DAY))
                        AND FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY))
GROUP BY day
ORDER BY day;
```

```sql
-- 4) 로그인한 사람의 여러 기기 여정 — 가명 user_id 하나에 붙은 client_id 와 이벤트 순서(최근 7일)
SELECT
  user_id,
  COUNT(DISTINCT user_pseudo_id) AS browsers,
  STRING_AGG(event_name, ' > ' ORDER BY event_timestamp LIMIT 60) AS path
FROM `PROJECT.analytics_PROPERTY.events_*`
WHERE _TABLE_SUFFIX BETWEEN FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 7 DAY))
                        AND FORMAT_DATE('%Y%m%d', DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY))
  AND user_id IS NOT NULL
  AND event_name NOT IN ('user_engagement', 'scroll')
GROUP BY user_id
ORDER BY browsers DESC, user_id
LIMIT 100;
```

### 10. Looker Studio(선택)

[lookerstudio.google.com](https://lookerstudio.google.com) → 보고서 만들기 → 데이터 소스 "Google 애널리틱스"(속성 `nomorevibe`) 또는 BigQuery(위 2·3번을
"맞춤 쿼리"로). 매일 보는 표 하나면 된다: 날짜별 `outbound_visit`·`skill_install_copy`·`skill_script_download`·`launch_submitted`·`sign_up`,
제품별 `outbound_visit` 상위 20. 공유 권한은 GA 속성 권한과 따로 준다.

### 11. 서버 이벤트 확인

**형식 검사(기록되지 않는다)** — MP 검사 주소 `https://www.google-analytics.com/debug/mp/collect` 는 받은 꼴만 검사하고 기록하지 않는다.
비밀이 화면·셸 기록에 남지 않게 읽어서 쓴다.

```sh
read -rs GA_API_SECRET && export GA_API_SECRET   # 붙여 넣고 Enter(화면에 보이지 않는다)
curl -sS -X POST "https://www.google-analytics.com/debug/mp/collect?measurement_id=G-XXXXXXXXXX&api_secret=${GA_API_SECRET}" \
  -H 'content-type: application/json' \
  -d '{"client_id":"1234567890.1760000000","non_personalized_ads":true,
       "consent":{"ad_user_data":"DENIED","ad_personalization":"DENIED"},
       "events":[{"name":"outbound_visit","params":{"product_slug":"example","link_kind":"site","via":"card","id_source":"ga_cookie"}}]}'
unset GA_API_SECRET
```

기대: `{"validationMessages":[]}`. 메시지가 있으면 그 `fieldPath`·`description` 을 보고 `lib/analytics/events.ts`·`server.ts` 를 고친다.
꼴은 `buildServerEvent()` 가 만드는 것과 같다(`tests/analytics-server.test.ts` 가 고정한다).

**DebugView(켜는 날)** — 두 웹에 `GA_API_SECRET` 과 임시 `GA_DEBUG=1` 을 넣고 웹만 다시 배포한 뒤:

1. 위 [확인](#확인ga-debugview) 2번처럼 분석이 켜진 브라우저로 제품 상세를 열고 '방문하기'를 누른다 → DebugView 의 같은 기기 줄에
   `outbound_click`(브라우저) 다음 `outbound_visit`(서버, `id_source=ga_cookie`, `session_id` 있음)이 이어지는지.
2. 터미널에서 `curl -fsSL https://nomorevibe.com/install.sh >/dev/null` → DebugView 에 새 기기 하나로 `skill_script_download`
   (`agent_class=curl`, `id_source=random`)가 오는지(디버그 기기 목록에서 고른다).
3. 로그인한 브라우저에서 써봤어요를 처음 남긴다 → `reaction_add` 에 user_id 가 붙는지(사용자 속성 패널). 같은 평가를 바꾸면 더 오지 않는지.
4. 푸터 '방문 분석 끄기' 뒤 '방문하기' → `outbound_visit` 가 오지 않는지(쿠키가 지워져 서버도 보내지 않는다).
5. GPC 를 켠 브라우저 → 서버 이벤트도 오지 않는지.
6. README 배지 주소를 새 질의로 연다(`/badge/<slug>.svg?lang=en&x=1`, 캐시를 피하려고) → `badge_impression` 이 `aggregate.badge_impression` 기기로 오는지.
7. 웹 로그에 `analytics.mp_rejected`·`analytics.server_event_refused` 가 없는지(`docker logs … | grep analytics.`).
8. 끝나면 `GA_DEBUG` 를 지우고 웹만 다시 배포한다.

### 12. 아직 확인하지 않은 것(PR C)

- 실제 GA 수신. 이 작업은 GA 로 아무것도 보내지 않았다(시험은 가짜 fetch). MP 검사 주소 응답도 보지 않았다.
- MP 의 `session_id` 매개변수가 BigQuery 에서 `ga_session_id` 로 들어오는지, `session_id` 그대로인지 — SQL 은 둘 다 본다.
- `after()` 가 운영(standalone Node, 두 웹)에서 응답 뒤에 실제로 도는지 — Next 16 문서상 지원(Node·Docker)이고 시험은 요청 밖 경로(바로 띄움)만 본다.
- Cloudflare 가 공개 응답에 `CF-IPCountry` 를 붙여 원 서버로 보내는지(지역 막기). 없으면 서버는 지역으로 막지 않는다.
- 로그인한 사람이 Cloudflare 의 익명 사본을 받는 비율(그만큼 브라우저 쪽 user_id 가 빠진다).
- `/skill.md` 의 `Cache-Control: public, max-age=300` 을 Cloudflare 가 저장하면 그만큼 `skill_md` 내려받기가 덜 센다(기본 설정은 `.md` 를 저장하지 않는다).
