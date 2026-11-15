# 공개 HTML은 제품 이름·요약만 — 구현 방안 (2026-11-15)

- 기준: main 21128664. 구현 방안만 담은 문서 PR #963이고, 코드 변경은 없다.
- 사람 결정(2026-11-15): 수집기·봇이 볼 수 있는 제품 정보는 **제목(제품 이름)과 요약(한 줄 소개)만** 둔다. 단 사이트 검색·SEO·AEO는 잘 되어야 한다.
- 바뀌는 앞선 결정:
  - 11/14 "README 앞부분은 서버 HTML에 남김"(#956)
  - #957의 부분 혼합(상세에 분야·README 발췌·JSON-LD 저장소 주소)
  - 11/15 대표 추천안 "검증된 봇에게만 전체 HTML"

## 1. 정한 것과 까닭

| # | 정한 것 | 까닭 |
|---|---|---|
| 1 | 서버 HTML과 RSC 데이터에 실리는 제품 값은 **주소(slug)·이름·요약(그 언어의 한 줄 소개)** 셋뿐이다 | 사람 결정 |
| 2 | **모든 요청에 같은 HTML을 준다.** 검증된 봇에게도 더 주지 않는다 | 검색·AI 답변이 보는 것도 이름·요약만이어야 결정과 맞는다. 클로킹 위험이 없고 Cloudflare 캐시를 나누지 않아도 된다. 이름·요약이 HTML에 있으니 JS를 돌리지 않는 AI 답변 봇도 "무엇인지"는 답할 수 있다 |
| 3 | 나머지 칸은 모두 같은 출처 API로만 준다. 화면 JS가 채운다 | 지금 쓰는 LazyCards·/api/product-cards·/api/products/[slug]/details 방식을 넓힌다 |
| 4 | 목록 화면의 **첫 쪽**만 서버 HTML에 이름·요약·링크로 남긴다(홈 구획 HOME_PAGE_SIZE 9, /popular POPULAR_SERVER_ROWS 5 등 지금 크기). 2쪽부터(`?page=`·`?shown=`)는 카드 없이 빈 틀만 주고 API로 채운다(noindex,follow) | 검색 엔진이 제품 페이지로 가는 내부 링크가 필요하다. 2쪽 이상을 서버 HTML로 주면 분류·AI 거르기 목록을 쪽마다 넘겨 소속을 모을 수 있다. publicListMaxPages 기본값이 100쪽이라 막히지 않는다. 제품 발견은 사이트맵이 맡는다 |
| 5 | og:image는 **이름·요약만 그린 카드 그림**으로 바꾼다. 제품 표지 그림은 쓰지 않는다 | 공유 미리보기는 살리고, 표지·스타·분류는 드러내지 않는다. share-card.png 부품을 재사용한다 |
| 6 | API 관문은 2단계로 Turnstile(보이지 않는 확인)과 서명된 세션 쿠키를 더한다 | 무료 요금제에서 위젯 20개, 확인 횟수 무제한이다(Cloudflare 문서). curl·python은 세션을 받지 못한다 |

받지 않은 안: 검증된 봇에게 전체 HTML을 주는 동적 렌더링. 숨긴 칸이 검색 결과와 AI 답변(사용자 요청 대리 수집 포함)으로 다시 나가므로 결정과 어긋난다.

## 2. 칸 분류

| 서버 HTML 허용 | API로만 |
|---|---|
| slug(주소), 이름, 요약(`tagline` / 한국어 `taglineKo` / 그 언어로 번역된 tagline) | @소유자·메이커, 분류, 스타·증가·순위 숫자, AI 단계 배지, 접근 방식(설치형 등), '새 프로젝트' 같은 꼬리표, 표지 그림(ogImage)·미디어, README 발췌·전문, 소개 본문(description), 제품 사이트 주소·저장소 주소, 언어, 활동·업데이트, 근거·출처, 화제(HN 등), 써봤어요 수, 공개 수·분류별 수·AI 수 |

페이지 공통 문구(사이트 소개, 구획 제목, 분류 이름 목록 같은 메뉴)는 제품 값이 아니므로 그대로 둔다.

## 3. 지금 HTML에 나가는 것 (main 21128664 코드)

- 상세 `app/(public)/[locale]/(content)/p/[slug]/page.tsx`
  - 빵부스러기: 분류
  - ProductHero: 소유자·배지·급상승 순위·health·언어·저장소 주소·스타 단추
  - IntroSection: profile과 README 발췌
  - PreviewFigure: 표지·미디어 주소
  - UnclaimedOwnerContact
- 상세 메타: description은 요약(유지), og:image는 표지(`productShareImage(product.ogImage)`)
- JSON-LD `lib/seo/product-json-ld.ts`: 제품 사이트 주소(url), codeRepository·sameAs(저장소), applicationCategory·genre(분류), programmingLanguage, image, 빵부스러기 분류
- 카드 `components/home/compact-item.ts` CompactCardItem: category·accessMode·ogImage·aiLevel·stars 관측·starGrowth·listedAt·repoCreatedAt + `card-item.ts` owner
- 홈: 공개 수·분류별 수·AI 수(`countProducts`·`categoryCounts`·`aiLevelCounts`)
- `app/feed.xml/route.ts`: 항목마다 category
- `lib/me/share.ts` shareCardData: 칩(HN 점수·스타·써봤어요·분류)

## 4. 1단계 — 공개 HTML을 이름·요약으로 (PR A)

### 4.1 공통 부품
- `lib/domain/products/public-teaser.ts`
  - 타입: `PublicTeaser = { slug; name; summary }`. summary는 서버가 그 언어로 고른 한 줄이다. 고르는 규칙은 지금의 `ProductTagline`과 같다.
  - 공개 화면의 서버 부품이 브라우저 부품에 넘기는 제품 값은 이 타입만 허용한다.
- 카드 마크업(ProjectCardMarkup·CompactCardMarkup·PopularRowMarkup)
  - 서버는 이름·요약·링크만 그린다.
  - 나머지 칸(표지·@소유자·분류·배지·스타·꼬리표)은 같은 크기의 빈 자리(aria-busy, 글자 없음)로 둔다. 자리 크기를 미리 잡아 CLS를 막는다.
- `components/cards/CardEnrich.tsx`("use client")
  - 화면에 있는 카드 slug를 모아 **한 번에** `GET /api/product-cards?slugs=a,b,…&locale=` 를 부른다(최대 60개).
  - 받은 값으로 빈 자리를 채운다. 실패하면 빈 자리를 거둔다. 대기 문구는 두지 않는다.
- `/api/product-cards`에 `slugs` 목록 읽기를 추가한다. 돌려주는 값은 CardItem에서 이름·요약을 뺀 칸이다. 공개 API 읽기 관문·no-store는 지금 그대로다.

### 4.2 화면별
| 화면 | 서버 HTML | API로 옮김 |
|---|---|---|
| 홈(기본·`?q=` 검색·분류·AI 거르기·`?new=1`) | 구획 제목 + 각 구획 첫 쪽 카드의 이름·요약·링크(검색 결과는 질의마다 결과라 쪽 넘김도 이름·요약으로 서버가 그림, noindex) | 카드 나머지 칸, 공개 수·분류별 수·AI 수(BrowseFilters 숫자) |
| /popular, /rising, /rankings/[key], /c/[category], /talk | 같음(첫 쪽 이름·요약·링크) | 순위·스타·증가·화제 숫자, 카드 나머지 칸, 뒤쪽 줄(지금 popular-page 방식) |
| 상세 /p/[slug] | h1 이름, p 요약, 빵부스러기 `홈 › 이름`, JSON-LD(4.3) | ProductHero 나머지(소유자·배지·순위·health·언어·저장소·스타·써보기 판), IntroSection(profile·README 발췌), PreviewFigure, UnclaimedOwnerContact, unverified 안내, 사실·정보·활동·같은 분야(지금도 API) |
| /p/[slug]/github, /feedback/[id], not-found | 제품 값은 이름·요약만 | 나머지 |

- 상세 API: `/api/products/[slug]/details`에 `hero`·`intro`·`media` 칸을 더하거나, `/hero` 경로를 새로 둔다. 구현할 때 기존 응답 크기와 캐시 열쇠를 보고 정한다.
- 내부 id는 넘기지 않는다. 지금 `UnclaimedOwnerContact`가 `product.id`를 받는 경로는 API 응답 안에서 같은 조건일 때만 준다.
- 홈 `?q=` 검색: 순위 계산은 지금처럼 서버가 모든 칸(키워드·검색 프로필·의미 검색)을 써서 한다. 출력만 이름·요약으로 줄이므로 **검색 품질은 바뀌지 않는다.** noindex와 guardSearch(IP당 분당 60)는 그대로다.

### 4.3 메타·구조화 데이터·피드
- `<title>`은 `이름 — nomorevibe`, meta description과 og:description은 요약이다. 둘 다 지금과 같다.
- og:image·twitter:image는 share-card 부품의 **칩 없는 판**(이름·요약·사이트 표기)을 쓴다. 1200×630 JPEG로, 주소는 `/p/<slug>/og.jpg`처럼 둔다.
  - 캐시 태그 `p-<slug>`은 그대로 둔다.
  - 공유 카드(ShareKit)의 칩 있는 판은 메이커 화면에서 API로 받을 때만 쓴다. 칩 있는 판이 공개 URL로 남으면 칩도 이름·요약만 남기도록 정리한다.
- JSON-LD(`productJsonLd` 축소)
  - `WebPage`(url = 우리 페이지 정식 주소, inLanguage)의 `mainEntity`를 `{ "@type": "CreativeWork", name, description: 요약 }`로 둔다.
  - `BreadcrumbList`는 홈 › 이름이다.
  - url(제품 사이트)·codeRepository·sameAs·applicationCategory·genre·programmingLanguage·image를 지운다.
- `feed.xml`은 title=이름, description=요약, link만 둔다. category를 지운다.
- 그대로 두는 것:
  - `robots.ts`: `/api/` Disallow, 학습 봇 9개 차단, Content-Signal `search=yes, ai-input=yes, ai-train=no`
  - `llms.txt`: 안내만 있고 제품 내보내기 없음
  - 사이트맵: 주소·lastmod·언어 대체. Cloudflare 규칙 2로 검증된 봇만 받음

## 5. SEO·AEO를 지키는 장치

| 대상 | 무엇을 보나 | 지키는 장치 |
|---|---|---|
| Google·Bing | 서버 HTML 이름·요약. JS를 돌려도 `/api/`가 robots로 막혀 같은 내용 | 페이지마다 고유한 title·description, 언어별 주소와 hreflang(지금 있음), 정식 주소, 사이트맵 lastmod, 목록 첫 쪽 내부 링크, 가벼운 HTML(LCP·CLS) |
| 네이버 Yeti·Daum | JS 없이 서버 HTML만 봐도 이름·요약이 있음 | 서치어드바이저 사이트맵 제출 여부 확인(사람) |
| AI 답변 봇(OAI-SearchBot·ChatGPT-User·Claude-SearchBot·Claude-User·PerplexityBot) | JS를 돌리지 않음 → 서버 HTML의 이름·요약 | JSON-LD name/description, llms.txt 인용 안내, Content-Signal ai-input=yes |
| SNS 미리보기(Slack·X·카카오) | og 태그 | og:title=이름, og:description=요약, og:image=이름·요약 카드 |
| 학습 봇 | 차단 | robots + Cloudflare 규칙(지금 그대로) |

알려진 손실: 상세 HTML이 이름·요약뿐이라 Google이 일부 상세를 '얇은 페이지'로 보고 색인하지 않을 수 있다. 크기는 확인 전이다. 배포 전후 Search Console 색인 수와 검색 유입을 비교해 판단한다(사람 화면).

## 6. 2단계 — API 세션 관문 (PR B)

1. 화면 JS가 처음 API를 부르기 전에 Turnstile 보이지 않는 위젯을 실행한다. 받은 토큰을 `POST /api/session`에 보낸다.
2. 서버는 Cloudflare siteverify로 토큰을 확인한다. 통과하면 서명한 httpOnly·SameSite=Strict 쿠키를 준다.
   - 담는 값: 세션 id·만료 30분·IP /24 해시
   - 서명 키는 env에 두고, 값은 사람이 넣는다.
3. 이름·요약 밖의 칸을 주는 공개 읽기 API(`/api/product-cards`, `/api/products/[slug]/details`·`/readme`·`/media`·`/links`·`/profile`·`/provenance` 등 공개 읽기)는 이 쿠키가 없거나 만료되었으면 401을 준다. 401을 받은 화면은 1로 돌아가 한 번만 다시 시도한다.
4. 세션별 한도를 둔다. 예: 10분에 카드 600개·상세 60개. 처음 수치는 배포 뒤 로그를 보고 정한다. 지금의 봇 UA 403·cross-site 403·IP 한도 429는 그대로 둔다.
5. env 이름(고정): `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `PUBLIC_API_SESSION_SECRET`.
   - 셋이 모두 있을 때만 관문이 켜진다. 하나라도 없으면 지금과 똑같이 동작한다. 그래서 PR B는 키 없이 먼저 배포할 수 있다.
   - 사이트 키는 서버가 실행 중에 env에서 읽어 화면에 넘긴다. 웹 이미지는 CI에서 한 번 만들어 두 웹 앱이 함께 쓰므로 `NEXT_PUBLIC_*` 빌드 시 박기로는 값이 들어가지 않는다.
   - 처음 켜지면 기록만(막을 요청을 세기만 함) 모드다. 막기 모드로 바꾸는 것은 재배포 없이 할 수 있게 한다.
6. 사람이 할 일: [Cloudflare 등 사람 작업 정리](2026-11-15-cloudflare-person-steps.md)
   - Cloudflare에서 Turnstile 위젯을 만든다(호스트 nomorevibe.com, Invisible).
   - 키 두 개와 세션 서명 키를 웹 앱(web-m3·web-mini) env에 넣고 그 앱을 재배포한다.
   - 값은 대화·작업에 넣지 않는다.

한계: 헤드리스 브라우저를 사람 속도로 돌리면 결국 긁힌다. 목표는 대량·고속 수집의 비용을 올리는 것이다. Turnstile 첫 확인에 걸리는 시간은 확인 전이다. 그동안 카드의 이름·요약은 이미 보이고 나머지 칸만 늦게 찬다.

## 7. 시험과 확인

- **허용 목록 시험**(`tests/public-html-payload.test.tsx`를 바꿈)
  - 지금은 금지 칸 목록(FORBIDDEN)을 쓴다. 이를 **허용 목록**으로 뒤집는다.
  - 제품 대역 값의 숨길 칸마다 표식 값을 넣는다. 예: `SENTINEL_MAKER`, 분류 `SENTINEL_CAT`, 스타 987654, `https://sentinel.example/…`, `SENTINEL_README`.
  - 각 화면이 그린 서버 글자와 브라우저 부품 속성(JSON)에 표식이 **0개**이고, 이름·요약은 있음을 본다.
  - 대상: 위 4.2의 모든 화면, generateMetadata 출력, JSON-LD, feed.xml, og 카드 데이터.
- API 시험: `slugs` 읽기(개수 제한·없는 slug·내려간 제품 제외)를 본다. 2단계에서는 쿠키 없음 401, 만료 401, 한도 429, 위조 서명 401을 본다.
- 화면 확인: 로컬 next(시험 DB 55435 방법)에서 Playwright로 찍는다. 첫 HTML에 이름·요약이 있고, JS 뒤 카드·상세 칸이 모두 차며, 레이아웃이 밀리지 않는지 본다.
- 운영 확인(배포 뒤): 일반 브라우저 UA와 봇 이름 UA로 홈·/popular·/c/·상세·검색·feed.xml·og 그림을 curl로 받아, 숨길 칸 패턴(`"category"`, `@` 소유자, `stars`, `github.com/`, `og-cache`, README 문장)이 0개인지 센다.
- 정책: PR마다 바뀐 범위의 시험·타입·린트만 돌리고, 필수 CI `check`를 통과시킨다.

## 8. 단계와 배포

| 단계 | 내용 | 사람 작업 | 배포 |
|---|---|---|---|
| PR A | 4장 전체. 공개 HTML 이름·요약, 카드·상세 API 채우기, og 카드, JSON-LD·피드 축소, 허용 목록 시험 | 없음 | app/·lib/ 변경이라 `npm run deploy -- scope` 결과는 full 18앱일 것(확인은 scope로). 마이그레이션 0 예상 |
| PR B | 6장. Turnstile·세션 쿠키·세션 한도 | Turnstile 위젯과 env 3개 | 웹 env 변경 뒤 배포(env만 바꾼 뒤 릴리스 도구 함정 주의) |
| 측정 | 배포 전후 HTML 패턴 수, API 호출량·429·401 비율, Search Console 색인 수·유입 | Search Console·GA 확인 | — |

API 부하: 지금은 홈 HTML이 Cloudflare 캐시에서 나간다. PR A 뒤에는 방문마다 카드 채우기 호출이 1번 더 생긴다. 서버 memo(publicRead, 같은 열쇠 공유)로 DB 읽기를 묶는다. 늘어나는 양은 배포 뒤 잰다.

## 9. 확인하지 못한 것
- 네이버 Yeti가 JS를 실행하는 범위: 공식 문서를 열지 못했다. 이 방안은 JS 없이도 이름·요약이 HTML에 있으므로 영향이 없다.
- 상세 색인 수 변화, 검색 유입 경로(홈·목록 대 상세)
- Turnstile 보이지 않는 확인의 실제 대기 시간과 통과율
- 원 서버가 Cloudflare를 거쳐서만 열려 있는지(2단계 세션 IP 해시와 지금의 CF-Connecting-IP 신뢰에 영향)

## 출처
- Vercel·MERJ, AI 크롤러 JS 미실행 실측(2024-12-17): https://vercel.com/blog/the-rise-of-the-ai-crawler
- Google JavaScript SEO 기본: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
- Google 동적 렌더링(권장하지 않는 임시 방편): https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering
- Cloudflare Turnstile 요금제: https://developers.cloudflare.com/turnstile/plans/
