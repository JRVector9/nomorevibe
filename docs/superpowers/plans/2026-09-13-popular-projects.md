# C-2–C-4 인기 프로젝트 Implementation Plan

> **For agentic workers:** 승인된 인계 문서와 목업을 따라 이 세션에서 직접 구현한다.

**Goal:** 스타 정보를 제품에 보관·갱신하고 홈 네 구간과 구간별 목록을 실제 운영 화면에 반영한다.

**Architecture:** products에 stars/stars_at/owner_type와 실패 재시도 간격용 stars_checked_at을 추가한다. 저장 원본으로 backfill하고 crawler의 예산·커서·쿼터를 지키는 잡이 24시간마다 새 값을 받는다. 공개·정상 제품만 스타 내림차순/ID순으로 조회하며 개인 필터·구간·페이지는 URL에 남긴다.

**Tech Stack:** Next.js16, PostgreSQL/Drizzle, TypeScript, Vitest, Playwright.

## 순서

- [x] C-1 승인 적용 및 5분/30분 실측 (318건, 기존 AI 기준 유지).
- [x] 단위/통합 시험을 먼저 작성하고 실패 확인: 네 구간 경계, 정렬·페이지·개인 필터·비공개/다운 제외, GitHub 실패·레포 변경 보존·커서·쿼터 대기.
- [x] `lib/domain/products/stars.ts`, `lib/domain/products/popular.ts`, `lib/jobs/products/stars-refresh.ts`, products 스키마·0030 마이그레이션·발행 시 초기값·저장소 변경 초기화 구현.
- [x] `components/home/PopularTiers.tsx`, `app/popular/page.tsx`, 홈·방법론·CSS 연결. 네 구간별10개, 표15개, URL 필터, 빈 상태,13px 이상, 반응형.
- [x] C-4: C-1 결과를 보고 부족한 구간의 repositories 검색 신호를 추가한다. 기존 커밋 검색에 지원되지 않는 stars 수식어를 넣지 않는다. 기존 예산·정렬·심사 정책을 유지한다.
- [x] 전체 단위·통합·TS·ESLint·프로덕션 빌드 및 실제 브라우저 QA.
- [x] Git diff 검토 → 명시 파일만 커밋/PR/병합 → 운영 migration → publisher/crawler/scheduler/웹2대 배포 → 실제 운영 UI 및 DB 확인.
- [x] 사용자 요청대로 마지막에 원문 C-1–C-4와 코드/배포/화면을 다시 리뷰하고 누락을 수정한다. 인계·보고서에 실행 결과를 남긴다.

## 표시 원칙

스타는 GitHub 관심 표시이며 사용자 수가 아니다. 구간 상한은 제외(2천≤x<5천 … 3만≤x<10만). 관측 실패 때 기존 값·성공 시각 보존. 소유자 유형을 추정하지 않고 미상은 개인 필터에서 제외. AI 근거는 기존 공개·숨김 정책을 따른다. 별도 B 트랙의 커밋 꾸준함은 C 데이터로 만들어 내지 않는다.

완료 기록: `docs/operations/2026-09-13-popular-projects.md`. C-4는 실제 네 구간이 채워져 기존 검색 신호를 유지했다.
