# 공개 목록·검색 깊은 쪽 제한 — PR #951

- PR: https://github.com/JRVector9/nomorevibe/pull/951
- 기준: 최신 origin/main에서 만든 `feat/anti-scrape-deep-page-limit-20261114` (시작 커밋 a3263557).
- #950 파일 목록을 `gh pr diff 950 --repo JRVector9/nomorevibe --name-only`로 확인했다. 공통 PENDING.md 대신 이 파일을 이 구역의 남은 일 목록으로 사용하며 겹치는 파일은 수정하지 않는다.

## 선택과 근거

- `PUBLIC_LIST_MAX_PAGES` 서버 환경 변수, 기본 100쪽. 정상 탐색의 첫 몇 쪽을 보존하면서 무제한 offset 순회를 막는다. 홈·분야·검색은 9개씩 더 보므로 shown=900까지, 신규·인기·상승은 15개/쪽이므로 page=100(1,500개)까지 허용한다. 실제 사람 행동을 측정한 수치가 아닌 화면 단위에 따른 보수적 정책 선택이다.
- 환경 변수가 잘못되면 기본값으로 돌아간다. 배포별 조정 가능하며 운영 설정은 이번 작업에서 변경하지 않는다. 공개 코드 기본값은 비밀값이 아니며 함정 경로는 범위 밖이다.
- 초과·잘못된 숫자(중복 포함)는 목록/검색/집계 조회 전에 noindex·follow 안내를 반환한다. 200 안내이며 첫 쪽으로 돌아갈 때 검색·분야·정렬·snapshot은 유지한다. 정상 쪽의 다음 링크는 그대로이며 경계 다음 요청은 안내로 간다.
- main의 공개 목록 데이터는 서버 컴포넌트가 직접 읽는다. 공개 API `/api/products`는 등록 POST, `/api/product-summaries`는 주어진 slug들의 요약 POST다. 페이지/offset/cursor를 받는 공개 전체 목록 API는 현재 main에 없다. #949/#950에서 새로 만드는 API는 이 브랜치에 가져오거나 수정하지 않았다.
- 상세·sitemap 생성·색인 자격 코드는 수정하지 않는다. 정상 목록 canonical·robots도 유지한다. 안내에만 noindex를 추가한다. sitemap은 ID-range reader를 그대로 쓰므로 깊이 정책과 독립적이다.

## 남은 일

- [x] 독립 브랜치·빈 시작 커밋·Draft PR 생성·head/base 확인
- [x] #950 겹침 확인 및 비중첩 경로 구현
- [x] 신규 pagination 시험 및 변경 영역 기존 단위 시험: 6파일 61/61 통과
- [x] next typegen → tsc --noEmit
- [x] 변경 파일 ESLint·i18n
- [x] 기존 목록·sitemap DB 회귀(55435)
- [x] 시험 DB Next 서버 curl 및 1440/390 브라우저·스크린숏·안내 검수
- [x] 검증 후 의미 단위 커밋·이 브랜치 push
- [x] PR 본문 실제 결과 반영·코드 커밋 필수 check 성공 확인
- [x] 보고함 제출용 보고서·검증 로그·스크린숏 12장 준비(제출 영수증은 최종 보고에 기록)

## 검증 기록

초기 신규 시험은 19/22 통과, 3실패였다. 로컬 canonical origin 기대값 2건과 시험의 한국어 공백 오타 1건을 고쳤으며 최초 실패 로그는 작업 artifacts에 보존한다.
수정 후 `npx vitest run anti-scrape-pagination tests/home-browse.test.ts tests/home-sort.test.ts tests/home-ai-filter.test.ts tests/popular-page.test.tsx`: 61/61 통과(Node 24.18.0).

품질 수치: 기존 Playwright e2e의 `document.documentElement.scrollWidth <= innerWidth` 기준으로 390px에서 main과 변경본을 비교했다. 인기·홈 정상 목록의 scrollWidth는 **396 → 396px**(기존 약 6px 넘침 유지), 새 제한 안내는 **390px**(넘침 0)이다. 1440px은 1440px이다. 비교 명령: `node <작업 scratch>/overflow.cjs`, 확인 명령: `node <작업 scratch>/browser-pagination.cjs`. 조판 일치도 도구는 없어 일치도는 측정 없음이다.

## 실제 추가 검증

- `npx next typegen` 후 `npx tsc --noEmit`: 통과. 첫 타입·i18n 검사는 비한국어 사전 키 추가 누락으로 실패했고, 다섯 언어에 동일 키를 넣은 뒤 재실행해 통과했다. 실패 로그 보존.
- 변경 13개 TS/TSX 파일 ESLint, `npm run check:i18n`: 통과.
- 요구 명령 `npx vitest run anti-scrape-pagination`: 2파일 22/22 통과. 관련 기존 단위 포함 6파일 61/61 통과.
- `TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@localhost:55435/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/popular-projects.test.ts tests/integration/rising-list.test.ts tests/integration/home-rows.test.ts tests/integration/sitemap.test.ts`: 4파일 29/29 통과. 수동 전체 테스트는 실행하지 않았다.
- 실제 Next 16.4.1 서버: 공유 node_modules 심볼릭 링크 + webpack 초기 실행은 모듈 해석 오류로 사용하지 않았다. `.env*`를 제외한 동일 소스 사본을 작업 scratch/runtime에 만들고 `npm ci` 후 Node 24.18.0, 기본 Turbopack dev, `--hostname 0.0.0.0 --port 43151`, 시험 DB 55435로 검증했다. 원래 .env.local은 수정·출력하지 않았다.
- curl 15경로 모두 exit 0, HTTP 200: 정상 첫/다음/경계 쪽, 초과·NaN·중복 page, 홈·검색·신규·분야·상승 제한, 제품 상세, sitemap.xml. 초과는 안내+noindex, 상세는 안내·noindex 없음. 500 없음.
- Chromium 151.0.7922.34 / Linux / headless CSS viewport 1440×1000·390×1000. 인기 첫 15개→다음 15개, 홈 9개→18개, 제한 안내→첫 쪽 복귀를 실제 클릭했다. 두 폭×홈/인기×첫/다음/안내 = 스크린숏 12장. JS pageerror 0, 새 안내의 복귀 링크 48px 이상. 제목·안내·동작 용어 일치, 불필요한 입력칸 없음, 새 안내 잘림·정렬 이상 없음. 실제 iPhone/Android 실기·보조기술 검증은 아니다.
- 브라우저 시험 초기에는 홈 아래 다른 구획 카드까지 세어 실패했고, `#projects`로 범위를 바로잡았다. 이어 기존 6px 넘침에 실패해 main의 같은 값과 대조했으며, 기존 목록에만 이 baseline을 명시 적용했다. 안내는 넘침 0 기준을 유지했다. 첫 screenshot의 caret 숨김이 수화 전 input 스타일을 바꾼 경고는 caret 초기 상태 촬영으로 피했다. 기존 레이아웃 파일은 변경하지 않았다.

병합·배포 안 함. 운영 DB 접근·운영 설정·Cloudflare 변경 없음.


## CI 번들 제한 보완

첫 ready CI [43576110713](https://github.com/JRVector9/nomorevibe/actions/runs/43576110713)의 Next 빌드는 완료됐지만 번들 크기 검사에서 홈이 Brotli 175.2KB로 기존 한도 175.1KB를 초과했다. 기준선은 변경하지 않았다. 안내 문구가 공용 클라이언트 browse 사전에 실리지 않게 다섯 언어 문구를 서버 전용 PaginationNotice로 옮겼다. 따라서 최종 메시지 사전 파일은 main과 동일하다.

수정 뒤 같은 단위 61/61·typegen→tsc·ESLint·i18n을 재실행해 통과했다. scratch/runtime에서 `SKIP_NEXT_TYPECHECK=1 npm run build`(별도 tsc 통과) 및 기존 `node scripts/bundle-size.mjs` 통과: 홈 **175.2 → 175.1KB**, 상세 191.4KB, 등록 156.5KB. 실제 수치이며 반올림 표기다. 생성한 production standalone Next 서버도 시험 DB 55435로 띄워 curl 15경로와 두 폭 브라우저 12개 화면·클릭 검증을 재실행해 통과했다. 최종 첨부 스크린숏은 이 production 서버에서 다시 촬영했다. 운영에는 올리지 않았다.


## 코드 CI 완료 영수증

코드 커밋 `055e91f2a2cd25872ff5aebd0a12c3082c59d92a`의 [CI 43576650245](https://github.com/JRVector9/nomorevibe/actions/runs/43576650245)에서 필수 [check](https://github.com/JRVector9/nomorevibe/actions/runs/43576650245/job/132394577226) **SUCCESS**를 확인했다. typecheck/lint/unit 2묶음/build/DB integration 6묶음/integration-ledger 모두 성공했다. 이미지 publish·refresh-caches는 PR 정책상 skip이며 배포 성공으로 기록하지 않는다.

이 문서 결과 기록 커밋 뒤 최종 head의 check도 확인하고 PR 본문·보고함에 최종 커밋과 함께 남긴다. 개발 구역의 남은 구현·로컬 검증은 없고 막힌 항목도 없다. 운영 반영은 범위 밖이며, 배포된 것은 없다. 별도 병합·배포 절차를 거칠 웹 앱 코드만 준비됐다. 운영 env 설정 변경은 필요 없고, 별도 운영 결정으로 기본값을 조절할 때만 웹 앱 `PUBLIC_LIST_MAX_PAGES`를 설정할 수 있다.

공유 REST API 한도 도달로 2026-11-14 08:36:58 UTC `gh run list`가 HTTP 403(rate limit exceeded)이었다. 추가 REST 폴링을 중단하고 같은 인증의 PR 상태 조회(GraphQL)를 60초 간격으로 사용했다. 인증·접근 권한 변경은 없었다.
