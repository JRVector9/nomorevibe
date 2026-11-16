# 상세 API 한도·출처 — PR #978

브랜치: feat/detail-api-limit-attribution-20261116. 병합·배포·운영 설정 저장은 범위 밖.

- [x] 상세 합산 60/600초, 20번째/10초 burst 30분 차단, 설정·CLI·예외·회귀 시험
- [x] 모든 언어 메타 3종·JSON-LD·noindex follow·소개 API 출처 한 줄, 회귀 시험
- [x] 범위 vitest·typegen 후 tsc·ESLint·i18n 계약 검사
- [x] 로컬 상세 화면 실제 확인·출처 한 번 스크린숏
- [x] 운영 문서·커밋·PR ready·GitHub CI 실패 사유 확인
- [ ] GitHub CI 전체 통과 — 막힘: PRIVATE 저장소의 계정 결제/사용 한도 문제. scope/check 단계 실행 전 실패. 결재함 q-42ef668f-d8a. 공개 범위·결제 설정은 바꾸지 않음.

품질 측정: 저장소 `npm run check:i18n` 계약 검사 전후 결과를 사용. 전체 unit/DB 수동 검사는 통합 단계 정책에 따라 반복하지 않는다.

로컬 브라우저: /p/e2e-rich 200, 소개 출처 표시 1회·API 1회, 메타 3종·JSON-LD 확인. 가로 넘침 false, 브라우저 pageerror 0. artifacts/detail-introduction.png 및 detail-desktop.png.

최종 로컬 검증: 단위 13파일 239개 + 변경된 2파일 14개(고유 240개), DB 통합 4파일 33개 + 변경된 1파일 10개(고유 34개) 통과.
`next typegen` 후 `NODE_OPTIONS=--max-old-space-size=6144 node node_modules/typescript/bin/tsc --noEmit`, 변경 파일 ESLint, git diff --check 통과.
`npm run check:i18n`: 이전 통과 → 지금 통과 (locales 4, namespaces 9, publicPages 19).
실제 CLI set detail/status는 시험 DB에서만 실행. 운영 DB·설정은 변경하지 않음.

초기 검사 실패 기록: 통합 시험의 server-only/Next after request context 모형 보완, 일본어 사전 상속 키 보완 후 통과.
추가 CLI 통합 시험은 저장 감사 로그를 LOG_LEVEL=error로 억제하고 자식 env NODE_ENV=test 타입 보완 후 통과.
TypeScript 재검사 2회가 exit143으로 종료되어 통과로 기록하지 않음. 단독 재실행 및 최종 재실행은 exit0.
GitHub CI 실패 원문: “The job was not started because recent account payments have failed or your spending limit needs to be increased.”
병합·배포하지 않았으며 CI 통과 전 배포 준비 완료로 보지 않는다.
