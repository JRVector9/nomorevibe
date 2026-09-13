# Release visibility and attribution evidence plan

**Goal:** 실제 발행일이 있는 릴리스만 표시하고, AI 개발 탐지 제안의 입증 범위를 실제 원문과 대조한다.
**Architecture:** GitHub 수집기는 유지하고 RepositoryEvidence 렌더링에 날짜 조건·원문 링크를 적용한다. AI 관측을 확정 사용으로 승격하지 않고 앞선 조사 보고서의 실행 권고를 좁힌다.
**Tech Stack:** Next.js 16 / React / Vitest / Playwright / GitHub REST.

- [x] `collect.ts`, `summary.ts`, GitHub provider, UI 및 공식 문서 확인. 운영 표본 커밋3/릴리스6 원문 GET 대조 완료. 커밋표기검증은 사용정확도검증이 아님.
- [x] `tests/repository-release.test.tsx`: 릴리스 없음·날짜 없음·잘못된 날짜에서 행이 없고, 실제 날짜는 출처 링크와 KST 날짜로 표시됨을 검증한다. push/수집일 대체와 unsafe href를 허용하지 않는다.
- [x] `components/product-detail/RepositoryEvidence.tsx`: `releaseDate`를 `publishedAt`에서만 생성, 유한 날짜일 때만 RepoRow 표시. `safeExternalUrl`로 URL/notesUrl 링크 검증. 다른 저장소 지표는 유지한다.
- [x] `npx vitest run tests/repository-release.test.tsx tests/github-evidence.test.ts`; `npx tsc --noEmit`; targeted ESLint; isolated build + detail E2E; independent Codex review.
- [x] `docs/operations/2026-09-14-release-evidence.md`: 원문링크/확인결과/한계, 릴리스API/date기준/표본실측, 제외할AI추론 명시. 기존 AI 조사 문서에 이 기준이 우선함을 표시.
- [ ] own files only commit/push, web2 release env/deploy, both health and live dated/undated detail at1440/390 verification, handoff and journal.

AI 탐지에 대한 이번 범위는 검증·기준 정정이다. 새 PR/Actions 수집기나 자동 발행 정책 변경은 포함하지 않는다. 현재 설정/공동작성자 흔적을 AI 개발 확정값으로 바꾸지 않는다.
