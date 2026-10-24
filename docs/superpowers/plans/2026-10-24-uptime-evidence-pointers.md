# Uptime 근거 필드 경로 구현 계획

> 이 작업은 상위 작업자가 승인한 최소 수정 설계로 현재 에이전트가 직접 실행한다. 새 서브에이전트를 생성하지 않는다.

**목표:** 상태 값을 근거의 필드 경로로 내보내는 실제 모델 오류를 uptime 출력 계약에서 미리 차단한다.

**구조:** `contracts.ts`의 uptime outcome만 근거 경로 enum을 사용한다. `prompts.ts`의 uptime 안내에 명시적 계약 revision과 올바른 필드 경로 예시를 둔다. 공통 wire 버전·다른 업무 계약·큐는 유지한다.

**도구:** TypeScript, Zod, Vitest.

- [x] `tests/llm-assist-contract.test.ts`에 `/state/closed`의 기존 구조 통과를 잡는 실패 회귀를 추가한다. `assistOutcomeSchemas.uptime.safeParse`가 false이고 emitted Schema의 supports enum이 두 경로뿐이어야 한다.
- [x] `npx vitest run tests/llm-assist-contract.test.ts`를 실행해 RED를 기록한다.
- [x] `evidence.extend({ supports: z.array(z.enum(["/state/page_state", "/state/finding"])).min(1).max(8) })`를 uptime outcome에만 적용하고 uptime prompt에 경로와 값의 예시를 추가한다.
- [x] 같은 회귀를 실행해 GREEN을 확인한 뒤 관련 계약·입력·평가 회귀와 TypeScript·변경 파일 lint를 실행한다.
- [x] 실모델 1회 실패·새 계약 hash·기존 큐 호환·남은 검증을 운영 문서와 `docs/CODEX_HANDOFF.md`에 기록하고 한국어로 커밋한다.
