# 공개 화면 서버 HTML 데이터 줄이기 (2026-11-14, PR #956)

목적: 공개 화면 서버 HTML(안의 RSC 데이터 `self.__next_f`)에 제품 행이 JSON 으로 실려 크롤러가 HTML 한 번으로
구조화된 제품 데이터를 가져가던 것을 막고, HTML 을 줄인다. 상세 README 는 2026-11-15 사람 결정대로
**앞부분 발췌만 서버 HTML 글자로, 전문은 봇 차단·속도 제한이 걸린 같은 출처 API 로** 브라우저가 불러온다.

## 측정 (로컬 next build + 시험 DB 55435 `nomorevibe_slim_b468`, 같은 픽스처)

- 이전: main `f8c20f15`(운영과 같은 커밋) 빌드, 이후: 이 브랜치 빌드. 브라우저 User-Agent 로 한 번씩 받음.
- 잰 명령: `npx tsx scripts/public-payload-report.ts http://localhost:<port> "/,/popular,/c/dev,/?q=fixture,/rising,/p/ggml" "doing so will make your PR more visible"`
- 제품 객체 = RSC 데이터 안에서 `slug` 와 `name` 을 함께 가진 객체. 금지 칸 = id(숫자 값)·repoUrl·status·builderClaim·taglineSource·
  starsPreviousAt·starsPrevious·starsAt·listedAt·makerName·unclaimed·pushedAt·repoRenamedTo·source·createdAt·claimedAt·verifiedAt 이 JSON 키로 나오는지.

| 화면 | HTML 바이트 | RSC 바이트 | 보이는 글자 | 제품 객체 | 금지 칸 |
|---|---|---|---|---|---|
| 홈 / | 142,289 → 140,753 (-1%) | 60,706 → 75,106 (+24%) | 6,567 → 5,134 | 31 → 12 | 13 → 0 |
| /popular | 93,954 → 68,300 (-27%) | 65,444 → 40,562 (-38%) | 1,393 → 1,393 | 8 → 3 | 11 → 0 |
| 목록 /c/dev | 113,225 → 96,533 (-15%) | 71,722 → 55,201 (-23%) | 2,509 → 2,480 | 13 → 8 | 13 → 0 |
| 검색 /?q=fixture | 85,350 → 94,462 (+11%) | 44,470 → 52,760 (+19%) | 2,254 → 2,231 | 14 → 9 | 13 → 0 |
| /rising | 130,390 → 124,600 (-4%) | 76,610 → 68,315 (-11%) | 3,282 → 3,282 | 20 → 15 | 13 → 0 |
| 상세 /p/ggml | 87,524 → 67,570 (-23%) | 44,250 → 38,150 (-14%) | 4,927 → 2,254 | 11 → 1 | 7 → 0 |

- 남은 제품 객체의 칸: 목록·카드는 `slug`·`name` 뿐(저장 단추의 단추 이름), 상세는 `slug`·`name`·`listed`(저장 단추).
- 이전에 실린 칸(합): accessMode, activity(pushedAt 포함), aiLevel, builder, builderClaim, category, createdAt, health, id, listedAt,
  makerName, metrics, name, ogImage, ownerType, rank, repoGone, repoRenamedTo, repoUrl, slug, stack, starGrowth, stars, starsAt,
  starsPrevious, starsPreviousAt, status, tagline, taglineKo, taglineSource, translation, translationName, unclaimed, url.
- 상세 README: 발췌 206자(표시 한도 320자, `shortReadmeExcerpt`), 서버 HTML 에 한 번. 전문(README 뒷부분)은 서버 HTML·RSC 모두 없음.
  로컬에는 GitHub 수집 토큰이 없어 이전 빌드도 README 전문을 불러오지 못했다(이전 측정의 '전문 없음'은 그 때문). 이전 코드가 전문을
  싣는 것은 `tests/public-html-payload.test.tsx`(README 를 대역으로 준 실제 상세 화면)가 main 에서 실패하는 것으로 확인했다.
- 홈 RSC 가 늘어난 까닭: 서버가 그린 카드 나무(글자·속성 포함, 카드당 약 2KB)는 예전 브라우저 부품 속성보다 크다. 제품 행 JSON 은
  없어졌다. 숨은 구간·첫 화면 아래 '새로 나온'·404 경계 카드는 서버 HTML 에서 뺐다. 툴팁·aria 문구를 줄이면 더 줄지만 화면·접근성
  동작을 바꾸므로 하지 않았다. 검색(?q=)도 같은 까닭으로 늘었다(카드 9장).
- 첫 로드 JS(brotli, `node scripts/bundle-size.mjs`, main f8c20f15 빌드 대비): 홈 175.1 → 168.3KB, 상세 191.3 → 185.5KB, /launch 156.4 → 149.5KB.
- 운영 참고(대표 실측 11/14 14:54Z, 운영 f8c20f15): 홈 HTML 175KB·RSC 73KB(제품 객체 약 21), 상세 /p/ggml HTML 120KB·RSC 56KB, /popular 138KB.
  운영 이후 값은 배포 뒤에만 잴 수 있다(미측정).

## 바꾼 것

1. 카드·목록: `components/cards/views.tsx`(훅 없는 카드 조각)·`markup.tsx`(카드·띠·순위 줄 마크업)를 서버 부품이 그린다. 저장 단추만
   브라우저 부품(`SaveToggle`, slug·이름). 홈 격자·지금 뜨는·많이 쓰이는 첫 구간·/popular·/rising·가장 활발한 목록이 서버 글자.
2. 첫 화면 밖 카드는 `GET /api/product-cards`(list=popular|rising|new, 공개 API 읽기 관문)로 열 때 받는다: 많이 쓰이는 다른 구간(숨은 탭),
   홈 '이번 주 새로 나온'(첫 화면 아래, 제목·모두 보기는 HTML 에 남음), 404 경계의 '지금 뜨는'(모든 공개 화면 RSC 에 두 번 실리던 것).
3. 집계 구획(필터·소개 줄·도구·소식)은 브라우저 부품으로 두되 표시 값만: 분야 차례 목록, 알약에 보이는 수, 소개 줄의 두 수.
   집계 창에는 가장 활발한 목록 대신 수(activeCount), 8시간 회차는 실행 번호·실행 상태·닫힌 시각 없이(state).
4. /c/* 404 경계가 목록 사전 전체(약 26KB)를 싣던 것을 서버 부품(CategoryLinks)으로 바꿔 없앴다. /popular 는 목록 사전을 싣지 않고,
   /rising 은 한국어 사전을 JS 조각(BrowseMessages)으로.
5. 상세: 머리(제목·한 줄 소개·분야·별·언어·운영 주체·가동)는 서버 부품. README 발췌는 서버 글자, 전문은 `GET /api/products/[slug]/readme`.
   사실 칸·정보 카드·언어·업데이트·같은 분야 목록은 `GET /api/products/[slug]/details`(표시 칸만)로 브라우저가 받는다. 받는 동안은 글자 없는
   자리(aria-busy). JSON-LD·canonical·메타는 그대로.
6. 운영자 확인 상자는 저장소 주소를 받지 않고(서버에서 가림) 내부 id 는 공개 로그인 기능이 켜졌을 때만 받는다.

## 시험

- `npx vitest run tests/public-html-payload` (DB 없음): 3 파일 22 시험 통과. `tests/public-html-payload.test.tsx` 5 시험은 main(f8c20f15)에서
  5개 모두 실패(금지 칸 `id·repoUrl·status…` 13개, README 전문 표지 글 포함).
- 바뀐 모듈을 읽는 단위 시험 97 파일 1,907 시험 통과, `tsc --noEmit`, 바뀐 파일 ESLint, `npm run check:i18n`, `node scripts/bundle-size.mjs` 통과.
- 전체 unit·DB·종합 시험은 AGENTS.md 정책대로 통합 단계에서 실행(이 PR 에서 실행하지 않음).

## 화면 확인 (Playwright, 로컬 빌드)

- JS 켬: 홈·/popular·상세에서 목록·카드·저장·README(발췌→전문)·사실 칸·정보 카드·업데이트·같은 분야가 보인다. 다른 구간 탭은 누르면 3장을
  받고, 빈 '새로 나온' 띠는 받은 뒤 숨는다, 없는 주소의 지금 뜨는 다섯도 받는다.
  README 전문은 로컬에 GitHub 수집 토큰이 없어 API 응답을 Playwright 가로채기로 실제 ggml README 원문을 넣어 확인했다(가로채지 않으면 '지금 README
  전체를 불러올 수 없습니다' + 발췌 + 원문 링크).
- JS 끔: 공개 화면은 원래부터 Suspense 스트리밍이라 본문이 숨은 블록에 있고 브라우저는 골격만 보인다(main 도 같다). JS 를 실행하지 않는 봇이 읽는
  서버 HTML 글자에는 제목·한 줄 소개·분야·README 발췌가 있다(보고 첨부 `*-p-ggml-server-html-text.txt`).

## 남은 것

- 운영 배포 뒤 같은 명령으로 운영 전후 측정(배포는 사람 허락 뒤 대표).
- `components/product-detail/ReadmeSection.tsx` 는 화면에서 쓰지 않는다(#955 시험이 ReadmeFallback 을 본다). 정리는 다음 PR.
- ~~설치 안내 `repoUrl` 키~~ · ~~홈 `source` 키~~ · ~~홈 RSC 축소~~ · ~~/popular 축소~~ → 2차(PR #957)에서 처리, 아래.
- 홈·검색 RSC 바이트는 카드 나무 때문에 여전히 크다. 더 줄이려면 카드 툴팁·aria 문구 정리(화면 결정 필요).

# 2차 (2026-11-15, PR #957)

대표 지시 「남은 4가지 지휘자한테 맡겨」 — 1차 뒤 운영 실측(11/15)에서 남은 네 가지.

## 운영 실측에서 찾은 원인 (운영 c5d2c2b9, 브라우저 머리로 한 번씩 받음)

- 홈 RSC 의 `"source":` 4건 = 화제 대표 카드 한 줄 소개의 `source:"maker"`(ProductTagline 속성, `showSource={false}` 라 쓰이지 않는 값) 1건 +
  AI 소식 브라우저 부품(NewsList) 속성의 소식 행 `source`(출처 이름) 3건. 소식 행에는 쓰지 않는 `vendor·label·tone` 도 함께 실렸다.
- 상세 `repoUrl` 1건 = 설치 안내 브라우저 부품(InstallPrompt)의 `repoUrl` 속성.
- /popular RSC 의 대부분은 한 쪽 15줄의 서버 나무(줄당 약 2.6KB: 커버 그림 주소 3벌, 원문 툴팁, 별 툴팁·aria).
- 홈 '많이 쓰이는' 첫 구간 판(PopularTierCards 속성 안 카드 3장)이 약 5.3KB. 이 구획은 홈 목록 아래(첫 화면 밖)다.
- 그 밖에 모든 화면 공통: 레이아웃 사전(common·labels) 약 7.3KB, 404 경계 두 벌 약 6.4KB, 목록 골격 약 3.2KB — 이번 범위 밖.

## 바꾼 것

1. 설치 안내: `InstallPrompt` 는 설치 주소(`url`)와 slug 만 받는다(제품 행 칸 `repoUrl` 아님). 복사할 글 전체를 서버에서 만들어 넘기는 안은
   설치형 상세 RSC 가 약 1.3KB 커져(실측 40,686 → 41,971B) 버렸다. 주소는 복사할 글에 들어가야 하므로 RSC 에 값으로는 남는다.
2. 홈 AI 소식(`components/home/NewsList.tsx`)을 서버 부품으로 — 출처·제목·날짜는 서버 HTML 글자로만.
3. 화제 대표(홈 TalkHero·/talk)·순위표·발견 보드·마이페이지 저장 탭의 `ProductTagline` 에 쓰이지 않는 `source` 를 넘기지 않는다.
4. 홈 '많이 쓰이는 프로젝트': 카드를 서버 HTML 에 싣지 않는다. 첫 구간은 구획이 화면 가까이 오면(IntersectionObserver, 600px 앞),
   다른 구간은 탭을 처음 고를 때 `/api/product-cards?list=popular` 로 받는다. 탭·수·모두 보기 링크는 서버 HTML 그대로.
5. /popular: 한 쪽 15줄 가운데 앞 5줄(`POPULAR_SERVER_ROWS`, lib/domain/products/stars.ts)만 서버가 글자로 그린다. 나머지는 같은 `<ol>`(카드 보기는 같은 격자)
   안 자리(`LazyPopularRest`, aria-hidden·aria-busy, 높이 어림)가 화면 가까이 오면 `/api/product-cards?list=popular-page&<같은 조건>` 으로 받아
   같은 마크업(PopularRowMarkup·ProjectCardMarkup)으로 그린다. API 는 공개 API 읽기 관문·화면과 같은 쪽 제한(publicPaginationBlocked)·같은 읽기 열쇠를 쓴다.
   쪽 안내('1–15위 / N')와 쪽 넘기기는 서버 HTML 그대로.

## 측정 (로컬 next build, 이 작업용 시험 DB `nomorevibe_slim2_55e5` = slim_b468 복사 + 2천–5천 구간 20개·소식 3건·설치형 1개)

- 이전: main `c5d2c2b9`(운영과 같은 커밋) 빌드, 이후: 이 브랜치 빌드. 같은 DB·같은 명령(`scripts/public-payload-report.ts`).

| 화면 | HTML 바이트 | RSC 바이트 | 보이는 글자 | 제품 객체 | 금지 칸 |
|---|---|---|---|---|---|
| / | 142,202 → 129,048 (-9%) | 75,519 → 69,242 (-8%) | 5,302 → 4,814 | 12 → 9 | source → 0 |
| /popular | 127,221 → 80,742 (-37%) | 70,323 → 47,062 (-33%) | 3,461 → 1,801 | 15 → 5 | 0 → 0 |
| /popular?view=cards | 128,882 → 81,728 (-37%) | 71,248 → 47,505 (-33%) | 3,508 → 1,809 | 15 → 5 | 0 → 0 |
| /c/dev | 96,583 → 96,583 (+0%) | 55,226 → 55,226 (+0%) | 2,489 → 2,489 | 8 → 8 | 0 → 0 |
| /p/ggml | 73,260 → 73,260 (+0%) | 40,670 → 40,670 (+0%) | 2,501 → 2,501 | 2 → 2 | 0 → 0 |
| /p/fixture-002 | 74,804 → 74,800 (-0%) | 40,686 → 40,682 (-0%) | 3,745 → 3,745 | 2 → 2 | repoUrl → 0 |

- 첫 로드 JS(brotli, `node scripts/bundle-size.mjs`, main c5d2c2b9 빌드 대비): 홈 168.3 → 168.4KB, 상세 185.5 → 185.9KB, /launch 149.5 → 149.7KB(모두 한도 안).
- /c/dev·/p/ggml 은 바뀐 부품이 없어 같다(대조).

## 시험

- 새·바뀐 시험 8개(`tests/public-html-payload*.test.ts(x)`, `tests/popular-page.test.tsx`, `tests/popular-tier-cards.test.tsx`)는 main(c5d2c2b9)에서 8개 모두 실패,
  이 브랜치에서 통과.
- 바뀐 모듈을 읽는 단위 시험 126 파일 2,222 시험 통과, `next typegen`·`tsc --noEmit`(8GB heap), 바뀐 파일 ESLint, `npm run check:i18n`, `node scripts/bundle-size.mjs` 통과.
- 전체 unit·DB·종합 시험은 AGENTS.md 정책대로 통합 단계에서 실행(이 PR 에서 실행하지 않음).

## 화면 확인 (Playwright chrome-headless-shell, 로컬 빌드, 1440×900·390×844)

- /popular 목록·카드 보기: 처음 HTML 5줄 → 스크롤 뒤 15줄, 순위 1–15 이어짐, 자리(aria-busy) 0. 홈 '많이 쓰이는': 스크롤 전 카드 0 → 뒤 3, 둘째 탭 3.
  AI 소식 3줄 표시. 설치형 상세 '복사' → 상태 문구와 클립보드에 주소가 든 설치 안내. 콘솔 오류는 `/api/me` 404 하나로 main 과 같다(로컬 공개 계정 꺼짐).

## 남은 것 (2차 뒤)

- 운영 배포 뒤 운영 전후 측정(배포는 사람 허락 뒤 대표).
- 공통 부분(레이아웃 사전 약 7.3KB, 404 경계 두 벌 약 6.4KB, 목록 골격 약 3.2KB)과 카드 툴팁·aria 문구는 손대지 않았다(화면·접근성 결정 필요).
- HTML 은 Cloudflare 가 저장해 내주므로 실제 봇 차단은 Cloudflare 규칙에 달려 있다.
