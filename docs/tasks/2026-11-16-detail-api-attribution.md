# 상세 API 한도·출처 — PR #978

브랜치: feat/detail-api-limit-attribution-20261116. 병합·배포·운영 설정 저장은 범위 밖.

- [x] 상세 합산 60/600초, 20번째/10초 burst 30분 차단, 설정·CLI·예외·회귀 시험
- [ ] 모든 언어 메타 3종·JSON-LD·noindex follow·소개 API 출처 한 줄, 회귀 시험
- [ ] 범위 vitest·typegen 후 tsc·ESLint·i18n 계약 검사
- [ ] 로컬 상세 화면 실제 확인·출처 한 번 스크린숏
- [ ] 운영 문서·커밋·PR ready·GitHub CI 결과 확인

품질 측정: 저장소 `npm run check:i18n` 계약 검사 전후 결과를 사용. 전체 unit/DB 수동 검사는 통합 단계 정책에 따라 반복하지 않는다.
