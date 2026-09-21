# PR-02 — 확정 결과의 원자적 다음 단계 요청

제안 브랜치: `perf/review-transactional-handoffs` · 선행: PR-01 · 상태: 구현·로컬 검증 완료, 미배포.

## 문제와 결과

현재 판정→1차, 1차→2차, 2차→발행 연결이 정기 스케줄에 의존한다. 1차 완료는 2차보다 발행을 먼저 요청한다. **결과가 실제 저장된 트랜잭션에서 다음 잡 요청도 함께 저장한다.** 요청을 받았다는 이유로 다음 단계를 통과한 것으로 간주하지 않는다.

## 수정 범위

- `lib/crawl/repository.ts`: `recordAutomaticJudgement`.
- `lib/crawl/agent-review-repository.ts`: `recordAgentReview`.
- `lib/crawl/second-review.ts`: `recordSecondReview`의 성공 및 fallback 생성 경로.
- `lib/crawl/jobs/{judge,agent-review}.ts`: 저장 계층으로 옮긴 중복 요청 정리.
- `lib/jobs/control.ts`: 기존 `requestJob(name, tx)` 재사용, 필요한 경우 요청 합치기만 보강.
- 신규 `tests/integration/review-handoffs.test.ts`; 기존 job-control/agent-review/second-review/publication-gate 회귀 보강.
- DB 마이그레이션·새 큐 테이블 없음.

## 전이별 계약

| 실제 커밋한 결과 | 요청할 잡 | 제한 |
|---|---|---|
| 규칙 판정의 자동 approved 또는 현재 1차 재검토 대상 needs_review | `crawl-agent-review` | review mode off에서는 요청하지 않음; 기존 재검토 사유 집합 사용 |
| 규칙 approved + off/observe 정책에서 발행 가능한 경로 | `crawl-publish` | 현재 정책 유지; enforce의 1차·2차 관문 우회 없음 |
| 현재 원본의 모델 1차 succeeded 저장 | `second-review` | secondReview.enabled일 때; 대상 선정은 기존 enqueueSecondReviews가 재검증 |
| 1차 approve + 현재 정책상 2차 관문 불필요 | `crawl-publish` | 기존 off/observe/설정 동작 유지, 이 PR에서 설정 변경 없음 |
| ai_approved 2차 승인표 agreed 저장 | `crawl-publish` | 필요한 모든 모델의 합의 여부는 기존 발행 predicate가 다시 검사 |
| 실제 fallback 행 생성 | `second-review` | 기존 fallback/시도 한도 유지; 원래 실패 이력 보존 |

반려/보류 의견이 저장된 2차는 발행 요청을 만들지 않는다. `agreed`만 검사하면 양쪽 reject도 포함될 수 있으므로 trigger/secondDecision을 명시적으로 확인한다. 1차 needs_review의 2차 수집 여부도 기존 `includeAiHeld`·선정 정책이 결정한다. 새 대상 조건을 별도로 복제하지 않는다. 소개 생성→발행 연결은 늦은 결과 저장 보호를 먼저 보강하는 PR-04에서 추가한다.

## 구현 상세

1. 저장 함수의 성공 분기 안에서 `requestJob(next, tx)` 호출. 반환 후 `.finally()` 요청으로 원자성을 흉내 내지 않는다. 네트워크/LLM 호출은 트랜잭션 밖에 유지한다.
2. 원본/설정 CAS 실패, superseded, 이미 끝난 표에 대한 재전달은 새 결과 커밋이 아니다. 같은 성공을 반복 저장하는 경로에서는 불필요한 요청 폭주를 막는다. 정상 재사용 결과가 새 후보 상태에 적용된 경우는 해당 기존 상태 전이에 맞춰 요청한다.
3. 잡 요청은 payload 없는 신호다. 후보/원본/표의 최신 조건은 소비자가 다시 확인한다. 호출자가 “2차 승인 완료” 플래그를 만들어 전달하지 않는다.
4. 후보·문서·설정·표의 기존 잠금 순서를 유지하고 잡 요청 행은 마지막에 갱신한다. runner가 보유한 lease와 상충하는 역순 잠금이 없는지 실제 두 세션 경합 테스트로 검토한다.
5. 정기 스케줄은 복구 수단으로 남긴다. 요청을 여러 번 받더라도 기존 후보 claim·표 unique key·발행 identity lock으로 논리 작업의 중복을 막는다. 외부 API 호출까지 exactly-once라고 주장하지 않는다.
6. 요청 대상 잡이 실행 중이면 requestedVersion의 새 요청을 현재 실행의 완료가 지우지 않아야 한다. 기존 processedVersion 계약 유지.

## 필수 테스트와 완료 기준

- 결과 저장 직후 요청 기록 전에 오류 주입 → 결과/요청 둘 다 롤백.
- 커밋 후 프로세스 종료 → 다음 워커가 저장된 요청 소비.
- 동일 완료 이벤트 반복/두 생산자 동시 완료 → 후보·같은 generation 모델표·제품 중복 없음.
- 첫 모델 승인만 있음 / 일부 2차 미응답 / 같은 모델의 재투표 / 반대 표 / 제거된 fallback → 발행 0.
- 실패/fallback 생성은 정상 신호를 만들되 승인으로 취급하지 않음; fallback 최대 시도 유지.
- 재수집/설정 변경/관리자 거절과 경합 → 오래된 완료가 새 상태를 덮거나 발행하지 않음.
- off/observe/enforce, 관리자 예외, includeAiHeld 조합의 이전 계약 유지.
- 빈 워커의 첫 다음 poll에서 진행. busy worker에는 0초 시작을 약속하지 않음.

계획된 명령:

```sh
npx vitest run tests/agent-review-job.test.ts tests/second-review-job.test.ts tests/second-review.test.ts
npm run test:integration -- tests/integration/review-handoffs.test.ts tests/integration/job-control.test.ts tests/integration/agent-review-records.test.ts tests/integration/second-review.test.ts tests/integration/review-publication-gate.test.ts
npx tsc --noEmit
git diff --check
```

## 배포·롤백

단순 작업 요청만 추가하므로 신구 소비자의 기존 큐/lease 계약과 호환되어야 한다. 각 쓰기 경로의 rollback 테스트와 DB 경합 검증 후 배포한다. 처리 대상·승인 결과·모델 설정이 달라지면 병합하지 않는다. 롤백 시 요청 생산 변경만 되돌리고 남은 요청은 기존 소비자가 재검증 후 처리하게 둔다. 결과 행이나 큐 이력을 삭제하지 않는다.

## 실행 결과

신규 통합 9개(8 RED→9 GREEN), 관련 통합 합계 103개 통과. 1차의 재전달, 요청 실패 시 원자적 롤백, off/observe/enforce, 2차 승인/거절 및 fallback 신호 검증. 기존 발행 관문 17개 포함. 2차 self-request는 lease 행 update lock을 사용하여 병렬 결과 저장의 share→update 교착을 피한다. 스케줄러의 job 순서(first→second→publish)를 유지한다.
