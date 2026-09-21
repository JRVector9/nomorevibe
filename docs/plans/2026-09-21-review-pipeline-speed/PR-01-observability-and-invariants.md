# PR-01 — 판별 입력 불변 검증과 단계별 계측

제안 브랜치: `perf/review-stage-observability` · 의존성: 없음 · 상태: 코드 구현, 로컬 검증 완료. 운영 기준선 수집 전.

## 문제와 결과

현재 1차 성공 집계에는 이전 결과 재사용이 섞이고, 2차의 createdAt→reviewedAt에는 큐 대기가 포함된다. 작업 시간만으로는 최적화의 효과나 악화를 구분하기 어렵다. **판별 입력과 정책을 고정한 회귀 기준선을 만들고 큐 대기/실제 호출/재사용을 별도로 기록한다.**

## 수정 범위

- 기존: `lib/crawl/jobs/{agent-review,second-review,publish}.ts`, `lib/crawl/agent-review-repository.ts`, `lib/crawl/second-review.ts`, `lib/jobs/{runner,control}.ts`, `scripts/worker.ts`.
- 신규: `lib/observability/review-pipeline.ts`, `scripts/report-review-latency.ts`, `tests/review-pipeline-observability.test.ts`.
- 기존 테스트 보강: `tests/agent-review-contract.test.ts`, `tests/integration/review-publication-gate.test.ts`.
- DB 마이그레이션 없음. 새 카테고리/의미 판별/캐시는 없음.

## 구현 계약

1. 구조화 로그에 다음 이벤트를 추가한다: 실제 모델 호출 start/end, 캐시 재사용, 잡 요청 커밋, 후보 결과 커밋. 이미 있는 job start/end와 연결한다. 재사용에서 모델 호출 이벤트가 발생하면 실패다.
2. 최소 필드: event/version, UTC 시각, job/run correlation, candidateId, firstAttemptId 또는 secondReviewId, 가능한 경우 generationKey/sourceRevisionHash, provider/model, durationMs, success/error code. 요청/응답 본문·API 키·원문·개인정보를 추가하지 않는다.
3. 모델 elapsed는 `performance.now()` 같은 단조 시계로 재고 저장·파싱 시간을 구분한다. 단계 간 시각은 DB 기준/서버 오프셋을 명시한다. 차이가 음수면 0으로 덮지 말고 집계에서 제외하여 시계 문제로 보고한다.
4. 커밋 이벤트는 실제 트랜잭션 성공 뒤에만 출력한다. 롤백된 결과를 committed로 기록하지 않는다. 로그 전달 실패가 심사 결과를 롤백하거나 외부 모델을 재호출하게 하지 않는다. 로그 유실 시 해당 구간을 측정 불가로 표시한다.
5. 원본·정책·모델 응답을 고정한 fixture로 기존 ReviewInput과 발행 결과를 저장한다. 심사/분류 payload 비교에서는 기존 원문·배열 순서·증거 참조를 그대로 비교한다. 시각·DB 일련번호처럼 실행마다 달라지는 항목만 명시적으로 정규화한다.
6. 보고 스크립트는 로그 파일과 명시적인 읽기 전용 DB 경로만 받는다. 결과 재사용/새 호출, 1차/2차, 오류, 빈 틱, 새 수집/재심사, 큐 깊이를 분리한다. 최신 operations observation 한 건을 장기간 p95로 취급하지 않는다.

## 새로 작성하고 실행할 테스트

- 새 호출 1건, 성공 재사용 1건, 실패 1건 → 호출 2건/재사용 1건으로 분리.
- 모델 호출 중 원본 변경·lease 상실 → committed 승인 이벤트 없음.
- 트랜잭션 실패·로그 sink 실패 → 거짓 커밋/심사 추가 호출 없음.
- 2차 queue+run과 model-only를 다른 지표로 출력; 빈 작업을 모델 latency에 포함하지 않음.
- 내용/언어가 다른 fixture에서도 기본 payload 및 기존 판정 정책 불변.

계획된 명령(구현 후 실행):

```sh
npx vitest run tests/review-pipeline-observability.test.ts tests/agent-review-contract.test.ts
npm run test:integration -- tests/integration/review-publication-gate.test.ts
npx tsc --noEmit
git diff --check
```

통합 테스트는 전용 `nomorevibe_test` DB에서만 실행한다. 운영 env를 로드한 셸에서 테스트하지 않는다.

## 배포·검토·롤백

입출력 계약과 설정 버전이 바뀌지 않았는지 먼저 확인한다. 배포 후 최소 30분 및 새 심사 100건을 모두 충족할 때까지 수집하되, 저유입이면 기간을 늘리고 표본 수를 밝힌다. 로그 비용·지연 증가를 확인한다. 이상 시 이 PR의 계측만 되돌린다. 기존 모델/규칙 변경이나 재심사 일괄 실행으로 기준선을 만들지 않는다.

## 현재 실제로 실행한 기준선

2026-09-21 문서 검토 중 아래 테스트 **9개 파일/91개 통과**. 이는 기존 코드의 회귀 기준 확인이며 위의 신규 테스트 완료를 뜻하지 않는다.

```sh
npx vitest run tests/agent-review-contract.test.ts tests/second-review.test.ts tests/worker-runtime.test.ts tests/worker-supervisor.test.ts tests/agent-review-job.test.ts tests/second-review-job.test.ts tests/crawl-publish-evidence.test.ts tests/job-catalog.test.ts tests/translate-reasons-job.test.ts
```

추가로 텍스트·역할·DB 풀 기준선 **5개 파일/41개 통과**. 합계 14개 파일/132개이며 서로 겹치지 않는다.

```sh
npx vitest run tests/crawl-tagline.test.ts tests/translate.test.ts tests/operations-instance.test.ts tests/db-pool-config.test.ts tests/db-pool-options.test.ts
```

Vite 설정의 향후 native loader 호환성 경고가 있었고 테스트 실패는 없었다. PR-04의 새 경합 재현 테스트는 아직 작성·실행하지 않았다.

## 구현 검증 (2026-09-21)

단위 41개 및 발행 관문 통합 17개, 타입 검사 통과. 새 계측 3개 RED→GREEN. 모델 시간은 provider adapter(응답 파싱 포함)이며 순수 서버 추론 시간이 아니다. 보고 도구는 JSONL 파일만 허용하여 운영 DB 접근을 분리했다. 후속 PR에서 원자적 저장의 커밋/요청 이벤트를 추가한다. 운영 전후 속도 판정은 미실시.
