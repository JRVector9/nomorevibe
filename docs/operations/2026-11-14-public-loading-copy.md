# 공개 HTML 대기 문구 제거 — PR #955

작업: https://github.com/JRVector9/nomorevibe/pull/955
브랜치: `fix/public-loading-copy-20261114`, base: main.

## 완료·남은 일

- [x] 최신 origin/main에서 새 브랜치·빈 시작 커밋·Draft PR 확인. 기존 작업 브랜치 보존.
- [x] 공개 대기 화면 조사와 skeleton 구현, 사용하지 않는 다국어 키 제거.
- [x] 고정 회귀 시험 `tests/public-loading-copy.test.tsx` 및 옛 main 실패 비교.
- [x] i18n, typegen, tsc, 변경 파일 eslint, 관련 vitest.
- [x] 시험 DB 55435 로컬 Next 서버에서 홈·상세 JS 켬/끔 1440/390 화면·콘솔 확인.
- [x] deploy scope만 실행하고 결과 기록.
- 마지막 외부 확인: 이 문서 커밋을 포함한 PR head를 ready로 바꾸고 필수 CI check를 확인한다. 최종 head·CI·보고 영수증은 PR 본문과 보고함에 기록한다.

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
- 익명 홈의 기존 카테고리 칩 줄은 390px에서 문서 폭 396px·칩 우측 396.40625px. 동일 시험 DB·익명 설정의 기준 main과 수정본이 **396px → 396px**로 동일함을 별도 서버 비교로 확인. 이 작업 밖의 기존 CSS는 변경하지 않음. 변경한 골격과 상세는 넘침 없음.
- 첫 촬영에서 Playwright의 기본 커서 숨김과 hydration이 겹쳐 경고 1건. `caret: initial` 및 본문 전환 대기 후 전체 8화면 오류 0. 최초 결과도 artifacts에 보존.
- 첫 추가 조작 시험은 공유 버튼에 없는 dialog를 기대해 timeout(시험 가정 오류). 실제 댓글 설정 메뉴를 열고 닫는 조작으로 교정해 통과, 최초 로그 보존.
- 화면 파일은 작업 artifacts의 `home/detail-{1440,390}-js-{on,off}.png`, `detail-feedback-pending-{1440,390}.png`, `detail-feedback-menu-{1440,390}.png`에 저장.
- 실기 Safari/Android, 전체 수동 unit·DB 통합은 미실행. 저장소 정책대로 필수 CI로 확인.
병합·배포·운영 설정·운영 DB·Cloudflare 변경 금지.

## 배포 범위와 선택

`npm run deploy -- scope --base f8c20f156c0a7fe78401712900f9bf19cd0789b4 --sha c01748f7ec26e3eec1fb3d95abaf297602bd6bbb`:
`deployment-scope-v2`, trusted=true, exact_ancestor_tree_diff, **full / 18앱**.
TSX·me 사전이 현재 분류기의 좁은 웹 문구 허용 범위 밖이라 전체로 분류된다. scope만 실행했고 plan/run·병합·배포는 실행하지 않았다.
첫 `--sha HEAD` 입력은 `invalid_commit_identity`(trusted=false)였으므로 유효 결과로 쓰지 않고 40자리 SHA로 다시 측정했다. 최초 로그도 보존.

선택: 기존 스트리밍 경계를 두고 공통 텍스트 없는 골격을 사용했다. 상태 표현은 `aria-busy`에 맡겨 로딩 문구가 HTML/RSC로 중복되는 원인을 없애면서 기존 화면을 가장 적게 바꾼다.
저장 탭의 클라이언트 전용 동작, 관리자, 인증 후 알림 설정, 기존 모바일 칩 CSS는 범위를 넓히지 않는다.

## 외부 확인 인계 기록

- PR은 ready for review 상태임을 실제 조회했다. 직전 push·ready 전환 시 이전 head 실행은 취소되고 새 head에는 Draft 실행의 실패 영수증만 남아 있었다. 이 문서 영수증을 ready 상태에서 push하여 synchronize 검사를 새로 실행한다.
- GitHub REST 공유 한도 소진(remaining=0)으로 15:02~15:14:44 UTC까지 조회를 중단하고 reset 뒤 재개했다. 한도 회피나 인증 변경은 하지 않았다.
- 최종 runtime 동일 문서 head `c151dd89706080dc5fbdd95a725bc6450f693bb4`도 정확한 SHA로 scope를 재측정해 trusted=true/full18앱을 확인했다.
- 스크린샷은 관리자 로컬 우회를 끈 익명 상태로 최종 재촬영했다. 시험용 제품 `public-loading-copy-61648196`만 정리했고 기존 시험 행은 초기화하지 않았다. 두 로컬 서버를 종료했으며 대용량 Next 출력은 작업 scratch로 옮겼다.
- 개발 체크리스트의 로컬 항목은 모두 완료했다. 필수 CI의 최종 head/성공 여부와 보고 등록 영수증은 PR 본문·보고함을 최종 근거로 삼는다.

## 남은 일·차단 (2026-11-14 15:16 UTC)

- [ ] **필수 CI check 통과: 계정 청구·사용 한도 때문에 차단.** ready head `da802898282d6291473c6dc41be7441ff77daf84` 실행 https://github.com/JRVector9/nomorevibe/actions/runs/43609206478 의 scope/check는 runner 배정·step 실행 없이 실패했다. scope annotation: “The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings”. 코드 시험 실패가 아니다.
- 계정 소유자의 청구·한도 복구 후 같은 PR의 최신 head CI를 재실행하고 필수 check 성공을 확인해야 한다. 사람 결정 요청을 등록했다. 결제·사용 한도·권한·workflow runner·필수 검사 정책은 변경하지 않았고 우회하지 않는다.
- 구현·로컬 회귀·정적 검사·화면 확인·scope 측정은 완료. CI 통과까지 작업 전체 완료로 기록하지 않는다. PR은 ready로 보존하며 병합·배포하지 않는다.
