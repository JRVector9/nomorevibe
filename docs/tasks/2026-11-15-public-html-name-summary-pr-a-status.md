# PR A 진행 상태 — 공개 HTML 이름·요약만 (2026-11-15)

- 기준 문서: Draft PR #963 `docs/tasks/2026-11-15-public-html-name-summary.md` 4·5·7장(PR A). Cloudflare 사람 작업 문서는 참고만.
- PR: #964 (`feat/public-html-name-summary-20261115`, base main 21128664). 병합·배포·운영 설정 변경은 하지 않는다.

## 끝낸 것
- [x] `PublicTeaser`(slug·name·summary·lang) — `lib/domain/products/public-teaser.ts`
- [x] 카드: 서버는 이름·요약·링크 + 같은 크기 빈 자리(`teaser-markup.tsx`), `CardEnrich`가 `/api/product-cards?slugs=`(최대 60) 한 번으로 채움. 목록 맥락 값(8시간 증가·순위 줄)은 그 목록 API 한 번(`fillFrom`)
- [x] 다 그린 카드 마크업은 첫 로드 JS 밖(`markup-loader.ts`)
- [x] 홈·분야·검색: 첫 쪽(9장)만 서버 HTML, `?shown=`·`?new=1&page=2+`는 빈 틀 + `list=home`/`list=new-page`, noindex,follow. 검색은 순위 계산 그대로·출력만 이름·요약
- [x] 저장 보기(`?saved=1`): 서버 후보 없음, 브라우저가 저장 slug 로 받음
- [x] 공개 수·분류별 수·AI 수·구간 수: `/api/browse-counts`(기본·`part=method`·`part=popular`·`part=tiers`)
- [x] /popular·/rising: 1쪽 앞줄만 이름·요약, 2쪽부터 빈 틀(noindex,follow)
- [x] /talk·홈 화제·/rankings/[key]·상세 화제 띠: 이름·요약만, 나머지 API(`/api/talk-board`·`/api/products/[slug]/talk`·`/api/rankings/[key]`)
- [x] 상세: h1 이름·요약·빵부스러기 홈›이름·JSON-LD만. 머리 나머지·소개·README 발췌·미리보기·운영자 상자는 `/api/products/[slug]/details`의 `hero·intro·media·aside`. 내부 id 는 로그인 기능이 켜졌을 때 API 응답 안에서만
- [x] /p/[slug]/github: 저장소 이름은 로그인한 사람에게만
- [x] og:image `/p/<slug>/og.jpg`(칩 없는 1200×630 JPEG, 태그 p-<slug>), share-card.png 도 칩 없음
- [x] JSON-LD WebPage+CreativeWork+BreadcrumbList 홈›이름, feed category 제거
- [x] 허용 목록 시험(`tests/public-html-payload.test.tsx`, 표식 값) — main 에서 19개 중 17개 실패 확인
- [x] slugs API 시험(`tests/product-cards-slugs.test.ts`), 새 API 시험들, 기존 화면 시험 갱신
- [x] 로컬 next build + 격리 시험 DB 화면 확인(Playwright, CLS), 전후 측정

## 남은 것 / 막힌 것
- PR B(Turnstile 세션 관문, 문서 6장)는 별도 작업.
- 운영 확인(배포 뒤 curl 패턴 수·Search Console)은 배포 뒤 사람·대표 작업.
- 홈 첫 화면 아래 '이번 주 새로 나온' 띠가 비면 구획째 사라지며 생기는 밀림(CLS)은 main 에도 있던 동작(이번 범위 밖).
