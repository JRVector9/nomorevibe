# 공개 HTML 대기 문구 제거 — PR #955

작업: https://github.com/JRVector9/nomorevibe/pull/955
브랜치: `fix/public-loading-copy-20261114`, base: main.

## 완료·남은 일

- [x] 최신 origin/main에서 새 브랜치·빈 시작 커밋·Draft PR 확인. 기존 작업 브랜치 보존.
- [x] 공개 대기 화면 조사와 skeleton 구현, 사용하지 않는 다국어 키 제거.
- [x] 고정 회귀 시험 `tests/public-loading-copy.test.tsx` 및 옛 main 실패 비교.
- [x] i18n, typegen, tsc, 변경 파일 eslint, 관련 vitest.
- [x] 시험 DB 55435 로컬 Next 서버에서 홈·상세 JS 켬/끔 1440/390 화면·콘솔 확인.
- [ ] deploy scope만 실행하고 결과 기록.
- [ ] PR ready 및 필수 CI check 성공 확인, 보고함 결과·artifacts 첨부.

## 조사한 대기 화면

- 홈·검색·분야·최근/신규 목록: `HomeScreen` → `FeedSkeleton`의 `home.loading`, `home.searching`.
- 상세 전체: `DetailSkeleton`의 `page.loading` (sr-only 문구도 HTML에서 제거).
- 상세 README: `ReadmeFallback(pending)`의 `readme.loading`. 기존 발췌와 원문 링크는 보존.
- 상세 댓글: `FeedbackList` 초기 SSR의 `feedback.loading`.
- 상세 댓글 작성: `FeedbackForm` 초기 SSR의 `feedback.checkingSession`.
- 공개 로그인: `GithubConnection` 초기 SSR의 `github.loading`.
- 공개 제품 GitHub 설정: Suspense fallback의 `settings.checkingSession`.
- 로그인 없이 열리는 `/me/tried`: `TriedList` 초기 SSR의 `tried.loading`.
- 인기: 별도 fallback은 제목만 출력하며 대기 문구 없음. 다른 공개 loading.tsx 없음.
- 저장 탭: 익명 초기 SSR은 빈 section이며 로딩 문구 없음. 이후 localStorage·사용자 조작에 따른 로딩은 최초 서버 HTML이 아님.
- 관리자와 인증 후에만 열리는 알림 설정은 범위 밖. 오류·빈 상태·실제 작업 대기 안내는 유지.

ko/en/ja/zh-Hans 및 기존 zh-Hant 사전의 사용하지 않는 위 키를 제거한다.
대기 상태는 `aria-busy`, 골격은 `aria-hidden`으로 제공한다. 새 경로 loading.tsx는 만들지 않아 기존 404·스트리밍 경계를 보존한다.

## 검증 기록

- `npx vitest run public-loading-copy`: 기준 main `f8c20f156c0a7fe78401712900f9bf19cd0789b4`의 archive에 동일 시험만 복사해 **65/65 실패**, 수정본 **65/65 통과**. 기존 컴포넌트를 실제 서버 렌더하며 모듈 없음 때문에 실패한 것이 아니다.
- 관련 화면 시험 5파일 135건 통과. 추가 로그인·피드백 시험 묶음 4파일 99건 통과(양쪽에 회귀 65건이 중복되므로 합산하지 않음).
- `npm run check:i18n`, `npx next typegen`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p .`, 변경 TS/TSX와 새 파일 ESLint, `git diff --check` 통과.
- 로컬 Next dev, 시험 DB `localhost:55435/nomorevibe_test`, 관리자 우회 끔(`ADMIN_LOCAL_LOGIN=0`), 공개 인증·피드백·반응 켬. 이 작업의 전용 제품만 추가하며 기존 시험 행은 초기화하지 않음.
- Chromium 156.0.8078.4, Desktop Chrome UA, 1440×1000 / 390×844, JS 켬/끔 × 홈/상세 8화면: HTTP 200, 대기 문구 0, 콘솔 오류 0, 페이지 오류 0. JS 끔은 정상 골격, JS 켬은 본문 전환 확인.
- 별도 요청 지연으로 댓글 골격을 1440/390에서 확인. 댓글 설정 메뉴를 실제 열고 닫았으며 오류 0.
- 14개 로컬 HTML(홈·정렬·검색·신규·카테고리·인기·다국어 홈/상세·익명 써봄): 본문의 대상 문구 0, 제거한 9개 키의 HTML/RSC 잔존 0. 사용자가 검색한 뒤에만 쓰는 공통 검색 상태 키는 유지한다.
- 익명 홈의 기존 카테고리 칩 줄은 390px에서 약 6px 넘침을 관측했으며 기준 main과 비교 중. 변경한 골격과 상세는 넘침 없음.
- 첫 촬영에서 Playwright의 기본 커서 숨김과 hydration이 겹쳐 경고 1건. `caret: initial` 및 본문 전환 대기 후 전체 8화면 오류 0. 최초 결과도 artifacts에 보존.
- 첫 추가 조작 시험은 공유 버튼에 없는 dialog를 기대해 timeout(시험 가정 오류). 실제 댓글 설정 메뉴를 열고 닫는 조작으로 교정해 통과, 최초 로그 보존.
- 화면 파일은 작업 artifacts의 `home/detail-{1440,390}-js-{on,off}.png`, `detail-feedback-pending-{1440,390}.png`, `detail-feedback-menu-{1440,390}.png`에 저장.
- 실기 Safari/Android, 전체 수동 unit·DB 통합은 미실행. 저장소 정책대로 필수 CI로 확인.
병합·배포·운영 설정·운영 DB·Cloudflare 변경 금지.
