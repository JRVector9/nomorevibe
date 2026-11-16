# 상세 요약 아래 출처 — PR #979

브랜치: feat/detail-source-line-20261117. 기준 main: 0b7ae636. 병합·배포 금지.

- [x] 빈 시작 커밋·전용 브랜치 push·Draft PR 생성과 head/base 확인
- [x] main의 지정 공개 HTML/API 시험 실제 실행: 2파일 38개 통과, 기대값 수정 불필요
- [x] 서버 요약 아래 5개 언어 출처, 화면 소개의 끝 출처 중복 제거
- [x] tests/detail-source-line.test.tsx 및 관련 상세 회귀 시험
- [x] 시험 DB 55435 next dev, 소개 유/무 브라우저 화면과 스크린숏 검수
- [x] typegen → tsc, 변경 파일 ESLint, check:i18n
- [ ] 커밋·push·PR ready·GitHub CI 전체 확인

선택: 서버 ProductHero에 기존 intro.siteSource 번역을 전달한다. 소개 화면만 API text 끝의 같은 출처를 제거하므로 API·DB를 건드리지 않고 화면 1회를 보장한다.
품질 기준: 저장소 npm run check:i18n 계약 검사. 이전 통과(locales 4, namespaces 9, publicPages 19).

실제 로컬 검증: 지정 두 파일은 main에서 38개 통과. 구현 후 범위 vitest 9파일 150개(새 시험 15개) 통과. next typegen → NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit, 변경 TS/TSX 5파일 ESLint, git diff --check 통과.
품질 수치: npm run check:i18n 이전 통과 → 지금 통과(locales 4, namespaces 9, publicPages 19).

시험 DB 55435에 작업 전용 fixture 2개만 추가(기존 행 보존). next dev 43177 + Playwright Desktop Chrome UA로 소개 있음/없음 각각 HTTP 200, 서버 본문 출처 1회, 브라우저 출처 1회, API 소개 끝 출처 유지(빈 소개는 null). 1440px/390px 각각 가로 넘침 없음, pageerror 0. 출처는 요약 바로 아래 실제 보이는 회색 글자(rgb 110,110,115), computed font-size 11px(기존 전역 조판 변환 적용), 잘림·어긋남 없음. 스크린숏 4장과 browser-results.json은 작업 artifacts에 보관, 개발 보고에 첨부. 새 메뉴·창 없음.

초기 검증 기록: 기존 소개 부품 단독 시험 1개가 출처 위치 변경으로 실패해 서버 머리와 함께 1회로 기대를 갱신한 후 통과. 브라우저 첫 실행은 chrome-linux/headless_shell 경로가 없어 실패했고 실제 설치된 chrome-headless-shell-linux64/chrome-headless-shell로 실행해 검증 완료.
착수 Draft CI의 check 실패는 저장소의 Draft 정책(“draft PR — CI not run; mark ready for review”), 결제 차단 아님.
