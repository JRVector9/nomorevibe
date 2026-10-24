# 연결 실패 자동 내림 전 확인 — 1번 후속 검증

2026-10-24 KST, 기준 main `2cc4e36c`. 사용자 요청은 [10-23 인계](2026-10-23-llm-assist-handoff.md)의 할 일 1번부터 진행하는 것이다.
별도 worktree `/Users/jr/Desktop/projects/nomorevibe-uptime-pre-delist-check`, 브랜치 `codex/uptime-pre-delist-check-20261024`에서 작업했다.
원 작업 폴더의 `b1fb8dd5`와 기존 미커밋 변경은 보존했다.

## 이미 있던 구현과 이번 수정

최신 main에는 기존 [PR-04](../plans/2026-10-23-qwen-first/PR-04-work-uptime-candidates.md)와
[PR-05](../plans/2026-10-23-qwen-first/PR-05-uptime-confirmation.md)의 후보 큐·소비자·최종 적용이 있다.
legacy `lib/jobs/products/uptime.ts`와 claims `lib/domain/products/uptime-apply.ts`는 둘 다
`autoBanUptimeProduct`를 통과한다. confirm이 필수면 상태 변경 대신 후보를 저장하며 dispatch/apply 중단으로 이 gate가 풀리지 않는다.
새 잡·마이그레이션·환경 설정은 추가하지 않았다.

기존 정책은 `unclear → collect_evidence / human_review`다. 그러나 검증기는 `unclear + retain`을 허용했고,
소비자가 이를 `done`으로 저장해 사람·근거 대기에서 사라지게 했다. 단위 테스트와 실제 전용 DB·localhost 모델 응답으로
수정 전 실패를 확인한 뒤 `validateAssistOutcome`의 uptime 분기에 3줄 검증을 추가했다.
이제 이 응답은 실제 모델 종료 원장은 정산하되 제품은 유지하고 `human / unclear_requires_review`로 남긴다.
`unclear + independent_review`도 기존 정책에 맞게 거절한다. 두 정상 제안은 계속 허용한다.

## 실제 실행한 검사

환경: Node `24.18.0`, lockfile 기준 `npm ci --ignore-scripts --no-audit --no-fund`.
테스트 DB는 이번에 만든 `nomorevibe-uptime-confirmation-test-20261024` 컨테이너의 loopback `55447`,
DB 이름 `nomorevibe_test`다. pgvector `0.8.6-pg17`, migration 125개 적용을 실제 조회했다.
모델은 localhost 가짜 HTTP 서버이며 외부 페이지 수집은 mock이다.

| 검사 | 실제 결과 |
|---|---|
| 수정 전 contract unit | 11건 중 2 실패: unclear의 retain/independent_review 허용 |
| 수정 전 native 소비자 1건 | human 기대에 done 저장으로 실패; 나머지 20건은 선택하지 않아 skipped |
| 관련 unit 7파일 | 145 통과 |
| 공통 평가·감사 unit 2파일 | 12 통과 |
| 관련 DB 통합 6파일 | 136 통과 |
| `npx next typegen && npx tsc --noEmit` | exit 0 |
| 수정 TypeScript 4파일 ESLint | exit 0 |
| `git diff --check` | exit 0 |

통합 회귀에는 새 unclear 응답의 사람 대기, legacy/claims 실제 틱 각각의 10번째 실패→후보 1건·즉시 내림/감사/purge 0,
기존 관리자 해제·401/403/429/999·광역 실패·URL/관측 microsecond 변경·pause·원격 종료 불명·중복 방지를 포함한다.
전체 suite·전체 DB·build·GitHub CI는 이번 범위 검사에 포함하지 않았다.
Vite가 CommonJS 설정 파일의 ESM 문법에 대해 출력한 향후 configLoader 경고와 PostgreSQL TRUNCATE CASCADE NOTICE는 보존했으며,
이를 검사 실패로 바꾸거나 운영 로그로 해석하지 않는다.

재현 명령:

```sh
cd /Users/jr/Desktop/projects/nomorevibe-uptime-pre-delist-check
npm test -- tests/llm-assist-contract.test.ts tests/uptime-assist-evidence.test.ts tests/llm-assist-capacity-binding.test.ts tests/uptime-gate.test.ts tests/job-catalog.test.ts tests/stage-registry.test.ts tests/operations-work-owners.test.tsx
npm test -- tests/llm-assist-evaluation.test.ts tests/llm-assist-audit-runtime.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55447/nomorevibe_test npm run test:integration -- tests/integration/llm-assist-queue.test.ts tests/integration/llm-assist-dispatch.test.ts tests/integration/uptime-auto-ban.test.ts tests/integration/uptime.test.ts tests/integration/uptime-split-apply.test.ts tests/integration/uptime-split-job.test.ts
npx next typegen
npx tsc --noEmit
npx eslint lib/domain/llm-assist/contracts.ts tests/llm-assist-contract.test.ts tests/integration/llm-assist-dispatch.test.ts tests/integration/llm-assist-queue.test.ts
git diff --check
```

## 남은 운영 단계와 원 인계와의 차이

이번 작업은 코드 검증·누락 수정이다. 운영 DB·설정·배포 상태는 조회하지 않았고, 운영 쓰기·실제 모델 호출·배포·활성화·12건 복구는 0이다.
코드 기본값은 off라 이 수정만으로 운영의 즉시 내림이 중단됐다고 보고하지 않는다.
실제 품질 비교·전환 증거는 [Qwen 운영 전환 문서](2026-10-23-qwen-first-rollout.md)의 절차가 남아 있다.
현재 근거의 독립 라벨, 실제 backend/readback/native canary·용량, shadow 평가와 사용자 승인을 거쳐 confirm을 검토한다.

이 최초 검증 단계에서는 긴 재접속·Oracle 재확인을 구현하지 않았다. 이후
[긴 재확인 후속 작업](2026-10-24-uptime-long-recheck.md)에서 collector에만 전체 60초 기한을 추가하고
기본 HTTP 10초·uptime-ping 25초·중단/SSRF/origin 정산의 회귀를 검증했다. 다른 네트워크 확인은 별도다.
후속 PR-05의 명시 범위대로 재접속 실패·차단·잘림은 추가 근거/보류이며 네트워크 실패를 모델의 종료 판정으로 바꾸지 않는다.
따라서 최초 제안의 “다시 실패하면 내림”과 현재의 보수적인 적용 정책도 구분한다.
이 최초 단계에서는 실패횟수·시간 제한·보호를 변경하지 않았다. 긴 기한의 로컬 코드 검증과 운영 활성화·실측은 구분한다.

2~5번에도 이미 병합된 구현이 있으므로 다음 차수는 각각의 기존 코드·개발 기록과 운영 설정을 먼저 대조한다.
이번 결과를 다른 항목의 검증 완료로 승계하지 않는다.
