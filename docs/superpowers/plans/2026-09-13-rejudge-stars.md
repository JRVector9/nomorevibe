# C-1 스타 구간 재판정 Implementation Plan

> **For agentic workers:** 이 세션에서 아래 순서로 직접 실행한다. 사용자 제공 C 트랙 인계 문서의 C-1 설계를 따른다.

**Goal:** 자동으로 large_oss 거부된 2,000–99,999 스타 후보의 읽기 전용 계획과 안전한 적용·되돌리기를 제공한다.

**Architecture:** `lib/crawl/rejudge.ts`가 plan/apply/revert를 맡고 `scripts/rejudge-stars.ts`가 검토용 JSON 및 적용 영수증을 보관한다. 기존 규칙과 심사 큐를 사용하며 사람의 결정과 처리된 결과를 덮지 않는다. 운영 설정·후보 변경은 dry-run 검토 후 승인 대상이다.

**Tech Stack:** TypeScript, Drizzle, PostgreSQL, Zod, Vitest.

---

## 확정한 범위

- C-1만 진행한다. C-2 스타 보관·갱신, C-3 홈과 목록 화면, C-4 발견 확장은 후속 작업이다.
- 실제 규칙은 `stars > maxStars`를 거부한다. 10만 이상 제외를 위한 설정은 `maxStars=99999`다. 기존 상한의 의미·기본값은 바꾸지 않는다.
- 기본 조회는 자동 거부, 사유 large_oss, 미발행, 살아 있는 저장 원본, 정수 스타 2000 이상 100000 미만이다. 미저장·문자열·음수 스타는 제외한다.
- 건별 예상은 **저장된 원본의 규칙 미리보기**다. AI·2차 심사, 등록/차단 URL 확인, 최신 근거 판정 및 실제 발행은 기존 잡이 한다. 미리보기의 approved는 발행 승인이 아니다.
- 적용 전 설정을 99999로 바꿔야 한다. 그 외 심사 설정은 계획과 같아야 한다. 스크립트 자체는 설정을 바꾸지 않는다.
- 후보·원본 전체의 DB 지문을 비교하고 행을 잠근 뒤 state와 updated_at만 바꾼다. 이미 달라진 행은 건너뛴다. DB 시각 원문을 써서 timestamp 정밀도·시간대 손실을 피한다.
- 적용 영수증을 커밋 전에 독점 생성·fsync한다. 파일 쓰기 실패 시 DB를 롤백한다. 되돌리기는 영수증에 기록된 실제 변경분 중 아직 동일한 new 행에만 적용한다. 이미 심사/발행/수동 수정된 것은 보존한다.
- 운영 비밀은 키체인 및 프로세스 환경에만 둔다. 설정 전체·원본 본문·연결 문자열을 계획과 로그에 기록하지 않는다.

## Task 1: 회귀 시험

Files: `tests/integration/rejudge-stars.test.ts`

- [x] 1999/2000/4999/5000/9999/10000/29999/30000/99999/100000, 수동 거부, 발행, 죽은 URL, 잘못된 스타 제외 시험을 작성한다.
- [x] 계획의 읽기 전용 성질, 설정 변경 필수, 경합 건너뛰기, 재실행, 기록 저장 실패 롤백, 안전한 되돌리기를 시험한다.
- [x] `npx vitest run --config vitest.integration.config.ts tests/integration/rejudge-stars.test.ts`로 구현 전 실패를 확인한다.

## Task 2: 구현

Files: `lib/crawl/rejudge.ts`, `scripts/rejudge-stars.ts`

- [x] `planStarRejudge()`는 현재 상한·적용할 설정 지문과 DB 식별 지문, 대상별 before 지문·원본 지문·스타·소유자 종류·예상 규칙 결과를 반환한다.
- [x] `applyStarRejudge(plan, persistReceipt)`는 입력 검증 후 설정을 공유 잠금하고 후보/원본 비교 후 new로 바꾼다. `persistReceipt` 성공 뒤에만 커밋한다.
- [x] `revertStarRejudge(receipt)`는 적용 직후 전체 후보 지문과 원본 지문이 동일할 때만 원래 상태·시각을 복원한다.
- [x] CLI 기본은 dry-run이며 `--out`, `--apply` + `--receipt`, `--revert`는 상호 배타적이다. 파일은 덮어쓰지 않으며 오류에서 DB URL을 노출하지 않는다.

## Task 3: 검증 및 인계

- [x] 위 통합 시험, `npx vitest run`, `npx vitest run --config vitest.integration.config.ts`, `npx tsc --noEmit -p .`, 변경 TS 파일 ESLint와 `git diff --check`를 실제 실행한다.
- [x] 프로드에 읽기 전용 dry-run만 실행하고 현재 구간별 수와 미리보기 결과를 기록한다.
- [x] `docs/operations/2026-09-13-rejudge-stars.md`에 정확한 명령·영수증 한계·승인 대기를 남긴다.
- [x] `docs/CODEX_HANDOFF.md`를 갱신하고 사용자에게 실제 대상 수와 운영 적용 승인 질문을 전달한다.
