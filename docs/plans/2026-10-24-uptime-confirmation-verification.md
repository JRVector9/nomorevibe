# 연결 실패 내림 전 확인 — 기존 구현 검증·누락 수정

사용자 요청은 `2026-10-23-llm-assist-handoff.md`의 할 일 1번부터 진행하는 것이다.
기준 main은 `2cc4e36c`다. 원 작업 폴더의 `b1fb8dd5`와 사용자 변경은 보존한다.

## 기존 설계와 수정 이유

후보 생산·재접속·Qwen 소비·최종 적용은 이미 병합됐다. 기존
[PR-04](2026-10-23-qwen-first/PR-04-work-uptime-candidates.md),
[PR-05](2026-10-23-qwen-first/PR-05-uptime-confirmation.md),
[서버 정책](2026-10-23-qwen-first/assets/process-prompts.draft.json)을 기준으로 검증한다.
새 큐나 잡을 추가하지 않고 `unclear → collect_evidence / human_review` 정책의 검증 누락을 보완한다.

검증기는 unclear의 delist만 거절하고 retain/independent_review를 허용한다. 완료기는 retain을 done으로
처리하므로 사람·근거 대기에서 사라진다. 검증기가 이 모순을 거절하면 기존 소비자가 human과 오류를 기록한다.

## 실행

- [x] 호출 경로·기존 설계 대조, 관련 unit 55건 실행.
- [x] localhost 모델·전용 DB에서 unclear+retain이 human 대신 done으로 기록되는 실패 재현.
- [x] `tests/llm-assist-contract.test.ts`에 unclear 조치 허용표를 추가하고 수정 전 실패 확인.
  collect_evidence/human_review만 허용하며 retain/delist_candidate/independent_review는 거절한다.
- [x] `lib/domain/llm-assist/contracts.ts`의 uptime 분기에 다음 검증 추가.

```ts
if (state === "unclear" && !["collect_evidence", "human_review"].includes(outcome.action.proposal)) {
  return { ok: false, error: "unclear_requires_review" };
}
```

- [x] legacy ping과 claims 적용기를 실제 DB에서 호출해 confirm 후보 생성과 즉시 내림 0을 검증.
- [x] 관련 unit·격리 PostgreSQL 통합·TypeScript·수정 파일 lint 실행.
- [x] 원 인계에 이미 병합된 구현과 남은 운영 검증을 구분하고 `docs/CODEX_HANDOFF.md` 갱신.

명령:

```sh
npm test -- tests/llm-assist-contract.test.ts tests/uptime-assist-evidence.test.ts tests/llm-assist-capacity-binding.test.ts tests/uptime-gate.test.ts tests/job-catalog.test.ts tests/stage-registry.test.ts tests/operations-work-owners.test.tsx
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55447/nomorevibe_test npm run test:integration -- tests/integration/llm-assist-queue.test.ts tests/integration/llm-assist-dispatch.test.ts tests/integration/uptime-auto-ban.test.ts tests/integration/uptime.test.ts tests/integration/uptime-split-apply.test.ts tests/integration/uptime-split-job.test.ts
npx next typegen
npx tsc --noEmit
npx eslint lib/domain/llm-assist/contracts.ts tests/llm-assist-contract.test.ts tests/integration/llm-assist-dispatch.test.ts tests/integration/llm-assist-queue.test.ts
git diff --check
```

운영 DB·모델 endpoint·설정·배포·차단 해제는 실행하지 않는다. 기존 후속 설계대로 수집 실패는 보류하며
실패횟수·시간 제한을 바꾸지 않는다. 실제 모델 품질·운영 활성화는 별도 증거와 사용자 승인 단계다.
