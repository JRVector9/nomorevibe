# PR-04 — 늦은 텍스트 결과의 원본·수동 작성·lease 보호

제안 브랜치: `fix/fence-text-job-results` · 선행: PR-02, 병합 순서는 PR-03 후 · 상태: 구현·로컬 검증 완료, 미배포.

## 재검토에서 발견한 선행 문제

현재 `pendingTaglines`는 수동 작성된 소개를 선택하지 않지만, **선택 이후 사람이 작성한 경우**까지 저장 함수가 보호하지 않는다. `recordTagline`의 upsert에 `writtenBy` 조건이 없어 늦은 AI 결과가 수동 문구를 덮을 수 있다. `recordTaglineFailure`, `touchTagline`도 현재 원본/작성자와의 저장 시점 비교가 없다. `releaseForPublish`는 후보 상태만 비교하고 생성에 사용한 원본과 연결되어 있지 않다.

또한 텍스트 job의 결과 저장 함수는 worker lease를 받지 않는다. job lease가 서로 다른 worker의 동시 시작을 막는 것과, 이미 시작한 오래된 호출의 결과 저장을 막는 것은 별개다. 따라서 역할 분리에 앞서 저장 보호를 보강한다.

이는 **정적 코드 검토로 확인한 보호 누락**이다. 이번 문서 작업에서 운영 덮어쓰기 사고를 확인한 것은 아니며, 아래 회귀를 먼저 재현해야 한다.

## 수정 범위

- `lib/crawl/taglines.ts`: 자동 성공/실패/touch 저장 및 release.
- `lib/crawl/jobs/tagline.ts`: 원본·후보·기존 소개 스냅샷과 lease 전달.
- `lib/crawl/translations.ts`, `lib/crawl/jobs/translate-reasons.ts`: worker 결과 저장의 lease 검증.
- `lib/crawl/translate.ts`, `lib/crawl/tagline.ts`: 필요한 경우 선택적 AbortSignal 전달. 기본 모델·프롬프트·timeout 유지.
- 기존 검색어 번역 호출자 `lib/domain/products/search-translation.ts`의 비-worker 경로 호환성 확인.
- `tests/integration/crawl-tagline.test.ts`, `tests/integration/translations.test.ts`, 신규 `tests/integration/text-result-fencing.test.ts`.
- DB 마이그레이션 없음. 기존 행의 원본 hash/시각/writtenBy와 트랜잭션·조건부 쓰기를 사용.

## 저장 계약

1. 자동 소개 저장은 후보/문서/기존 소개의 예상 상태를 받아 트랜잭션에서 재검증한다. 대상 원본이 바뀌었거나, 관리자가 후보/소개를 변경했거나, lease가 만료/교체됐으면 저장하지 않는다. 원본이 같은지 모델에게 묻지 않는다.
2. 수동 소개가 조회 뒤 삽입되는 absent-row race도 막는다. upsert의 충돌 분기에 `written_by IS NULL`과 예상 리비전 조건을 둔다. 후보 잠금만으로 수동 소개 insert가 직렬화된다고 가정하지 않는다. 수동 작성 경로와 잠금 순서를 맞추거나 조건부 쓰기로 검증한다.
3. 성공, 실패, 원본 시각 touch 모두 같은 보호를 적용한다. 버려진 늦은 결과가 attempts/retryAt/수동 작성 표기까지 바꾸면 안 된다. 모델 실패 이력과 취소/원본 교체로 인한 discard를 구분한다.
4. 자동 소개 저장 + 해당 후보의 release + 발행 job 요청을 동일 트랜잭션으로 묶는다. 이미 저장된 소개를 재사용할 때도 현재 원본·수동 수정 여부를 재확인한다. 빈 소개/실패 결과는 release하지 않는다. 기존 심사 승인표는 새로 만들지 않는다.
5. release는 기존 자동 `needs_review/no_description` 조건을 유지하고 기대한 후보 상태/원본에만 적용한다. 유효한 1차 승인이 만료됐으면 기존 심사 큐가 재검증한다. 발행 요청은 승인 우회가 아니다.
6. worker 번역 저장에는 `assertJobLease(tx, lease)`를 적용한다. 원문 hash+targetLang identity와 완료값을 실패로 덮지 않는 기존 규칙 유지. 모델 호출은 tx 밖, 결과 쓰기와 lease 검사는 같은 tx 안이다.
7. 검색어 번역 등 HTTP 경로에는 가짜 worker lease를 요구하지 않는다. worker 전용 저장 wrapper 또는 명시적인 context 타입으로 구분한다. 운영 worker가 context 누락으로 검증을 우회하면 테스트 실패.
8. abort/lease 상실 뒤 새로운 모델 호출·새 텍스트 저장·release를 하지 않는다. 취소를 자동 심사의 거절이나 후보 부적격으로 바꾸지 않는다.

## 필수 테스트

- AI 호출을 대기시킨 뒤 사람이 소개 작성 → 늦은 AI 성공/실패가 문구와 writtenBy를 변경하지 않음.
- 호출 중 README/page 원본 교체 → 이전 hash로 저장/touch/release/발행 신호 없음.
- 소개 행이 없던 두 경로의 동시 수동 insert/자동 upsert → 수동 문구 보존.
- lease 교체/정상 shutdown → 이전 worker의 번역·소개 저장 및 release 차단.
- 성공 소개 저장 후 release 전 오류 → 결과·상태·job 신호 모두 롤백.
- 최신 원본 정상 처리/캐시 재사용/빈 소개/재시도는 기존 정책대로 동작.
- ko 사유 번역 및 en 검색어 번역의 hash/targetLang 분리와 비-worker 경로 유지.

계획된 명령:

```sh
npx vitest run tests/crawl-tagline.test.ts tests/translate.test.ts tests/translate-reasons-job.test.ts
npm run test:integration -- tests/integration/text-result-fencing.test.ts tests/integration/crawl-tagline.test.ts tests/integration/translations.test.ts tests/integration/review-publication-gate.test.ts
npx tsc --noEmit
git diff --check
```

## 배포·롤백

먼저 회귀 테스트 실패를 재현한 뒤 보호 코드를 작성한다. 이 PR 통과 전에는 text worker 분리를 배포하지 않는다. 정책/생성 내용을 바꾸는 변경을 섞지 않는다. 보호 코드에 문제가 있으면 자동 텍스트 worker를 멈추고 후보는 현재 상태로 남긴다. 이미 수동 작성된 문구나 과거 발행 데이터를 자동으로 고치지 않는다. PR-05 이후에는 역할 분리를 먼저 되돌린 뒤 이 PR의 롤백 여부를 판단한다.

## 실행 결과

새 경합 테스트6개 모두 기존 코드에서 실패 재현 후 통과. 추가 원본 CAS3개와 번역 lease/HTTP호환1개 포함 신규10개, 기존 소개10개 합계20개 통과. 관련 발행/번역 통합56개 통과, 단위35개 통과. 초기에 timestamp를 SQL 조각에 Date로 전달한 재시도2개 실패를 ISO timestamp/밀리초 비교로 수정 후 모두 통과. 자동 소개 API를 mandatory task+lease 단일 저장 함수로 교체해 성공/실패/재사용·release·발행요청을 원자화했다. 검색 번역의 비-worker API는 유지.
