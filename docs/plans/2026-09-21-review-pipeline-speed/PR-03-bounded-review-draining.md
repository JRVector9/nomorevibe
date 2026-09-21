# PR-03 — 제한된 큐 연속 처리와 1차 슬롯 재사용

제안 브랜치: `perf/review-bounded-draining` · 선행: PR-02 · 상태: 미구현.

## 문제와 결과

현재 1차는 한 틱에서 동시성 수만큼 호출한 뒤 끝난다. 운영 값 4에서 모델이 빨라져도 추가 후보를 처리하지 않는다. runner의 `done:false` 역시 다음 틱을 자동 요청하지 않는다. **활성 호출 한도를 유지하면서 작업을 이어 처리하되, 재시도 대기나 사람 확인 후보를 반복해서 집지 않는다.**

## 수정 범위

- `lib/crawl/jobs/agent-review.ts`, 필요 시 `lib/crawl/agent-review-repository.ts`의 후보 선택 옵션.
- `lib/crawl/jobs/second-review.ts`: 실제 즉시 처리 가능한 잔여 큐에만 연속 실행 요청.
- `lib/jobs/runner.ts`: 명시적인 continuation 결과 처리.
- `scripts/worker.ts`: 1차 예산과 기존 역할 순환 공정성.
- `tests/agent-review-job.test.ts`, `tests/worker-runtime.test.ts`, `tests/second-review-job.test.ts`.
- `tests/integration/{job-runner,agent-review-job}.test.ts`, 신규 `tests/integration/review-draining.test.ts`.
- DB 마이그레이션 없음. 대상/정렬/재시도/승인 정책은 변경 없음.

## 시간·동시성 계약

1. 운영 reviewConcurrency=4는 유지한다. 1차 설정 상한 16, 2차 상수 4, provider/model 선택도 유지한다. reviewer 역할 내 잡을 병렬로 실행하지 않는다.
2. 1차 협력 예산은 **40초**, 호출별 ceiling은 gateway **24초**, CLI 기존 **20초**로 명시한다. 새로운 호출은 해당 ceiling + 기록 여유 2초가 남을 때만 시작한다. 남은 예산 때문에 10초 미만으로 잘린 새 호출을 추가하지 않는다. supervisor 180초보다 충분히 짧게 종료한다.
3. 완료한 슬롯은 동일 틱에서 다시 채울 수 있다. claim·최신 원본 검증을 매 후보 수행한다. 준비 중인 후보도 슬롯에 포함하여 DB/README 작업을 무제한 병렬 실행하지 않는다. 느린 준비 후에는 남은 예산을 다시 확인한 뒤 claim한다. claim 직후 취소된 작업을 running으로 방치하지 않고 기존 취소/lease 규약에 맞춰 정리한다.
4. 한 틱의 외부 호출 시작 상한은 16개. 순회/조회도 유한하게 제한한다. 이미 방문한 candidateId/원본 조합은 같은 틱에서 다시 집지 않는다. 건너뛴 running 후보만 목록 앞에 있을 때 무한 재조회하지 않는다.
5. 모든 시작한 작업의 저장/취소 완료를 기다린 뒤 lease를 반환한다. 한 작업 저장 실패/abort/lease 상실 시 새 작업 시작을 멈추고 나머지도 회수한다.
6. 긴 1차 틱은 2차 시작을 지연시킬 수 있다. 40초는 상한이며, 슬롯이 비고 충분한 호출 예산이 없으면 즉시 양보한다. PR-01 지표에서 2차 queue p95 악화가 나타나면 예산/시작 상한을 줄인다. 1차 처리량만으로 성공 판정하지 않는다.

## 다음 틱 계약

- `JobOutcome`에 선택 필드 `continuation: 'ready'`를 추가한다. 승인된 잡 이름 `crawl-agent-review`, `second-review`에서만 처리한다. 기존 `done:false`의 의미를 전체 잡에 대해 바꾸지 않는다.
- 진전이 있고, 동일 상태를 다시 조회한 결과 retryAfter/사람 확인/만료 원본을 제외한 즉시 실행 가능 작업이 남았을 때만 ready. 실패 백오프만 남았거나 전부 skipped/비어 있으면 ready를 반환하지 않는다.
- 성공 완료 트랜잭션에서 현재 요청을 ack하고 요청이 더 없을 때만 다음 requestedVersion 하나를 남긴다. 실행 중 도착한 새 요청은 보존하고 불필요하게 한 번 더 증가시키지 않는다. 수치 상한도 기존처럼 검사한다.
- 한 worker poll에서 같은 잡은 최대 1회. 역할 내 다른 pending 잡을 기존 순환 순서로 방문하고 기본 5초 poll을 유지한다. 요청이 있다는 이유로 현재 while-loop에서 즉시 같은 잡을 재호출하지 않는다.
- 기존 notBefore, 개별 retryAfter, 최대 실패 횟수, shutdown 취소 처리 유지. gateway 장애/429가 반복될 때 연속 신호를 만들어 재시도 시간을 앞당기지 않는다.
- 2차는 기존 108초 틱/110초 budget/60초 gateway/20초 CLI/동시성 4 유지. fallback 우선 정렬 및 소비자의 입력 재검증 유지.

## 필수 테스트

1. 고정 10초 응답 8건/동시성 4: 4건 시작→10초에 다음 4건 시작→20초에 완료, peak=4. 모델 입력·판정 정책 동일.
2. 느린 24초 응답: 남은 16초에 추가 호출 시작 0. 호출 timeout을 잘라 새 실패를 만들지 않음.
3. 후보 목록 반복·동시 claim·동일 후보 재전달: 한 틱 같은 원본 중복 호출 0; 의도적인 다음 generation 재심사는 허용.
4. no-progress/모두 retry 대기/explicit needs_review: continuation 없음; 새 정상 후보가 뒤에 있을 때 기아 없음.
5. 실행 중 새 requestedVersion 도착/완료 경쟁: 요청 유실·무한 증가 없음.
6. 새로운 ready 신호가 있어도 다음 잡/2차/감사를 양보; shutdown/lease 교체 뒤 쓰기 0.
7. 일반 잡 `done:false`는 기존처럼 동작. 1차 실패 재시도 간격과 시도 수, 2차 fallback 한도 불변.

계획된 명령:

```sh
npx vitest run tests/agent-review-job.test.ts tests/second-review-job.test.ts tests/worker-runtime.test.ts tests/worker-supervisor.test.ts
npm run test:integration -- tests/integration/review-draining.test.ts tests/integration/job-runner.test.ts tests/integration/agent-review-job.test.ts tests/integration/review-publication-gate.test.ts
npx tsc --noEmit
git diff --check
```

## 배포·롤백

기존 “한 틱 호출 수=동시성” 단위 테스트를 지워 통과시키지 말고 활성 호출 수/시간/추가 시작 조건 검증으로 바꾼다. 실제 공유 gateway의 동시 최대뿐 아니라 분당 요청 수·429·시간 초과도 확인한다. 부하가 증가해 1·2차 실패율 또는 대기 p95가 악화되면 기존 단일 묶음 실행으로 되돌린다. 기존 승인·실패 이력이나 retry 시각은 수정하지 않는다.
