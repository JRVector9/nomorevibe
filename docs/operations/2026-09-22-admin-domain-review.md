# 관리자 도메인 리뷰 — 2026-09-22

## 범위

관리자 화면이 사용하는 설정 저장·복원, 운영 현황 집계, 수동 분류, 심사 갈래와 재판정, 제품 근거 관리, 랭킹 정책·시즌·미리보기·점수 계산을 검토했다. 관리자 인증·Server Action 입력 검증과 제품 감사 처리 경합은 병렬 담당자가 검토한다. 운영 데이터 변경, 커밋, 푸시, 배포는 이 검토에서 실행하지 않았다.

읽은 주요 경로: `lib/crawl/settings.ts`, `lib/operations/{admin,categories,pipeline}.ts`, `lib/crawl/{admin-review,admin-review-batch,product-audit,second-review}.ts`, `lib/domain/evidence/{admin,settings-store,refresh}.ts`, `lib/domain/products/{manage,takedown,repository,recheck,claim-invite}.ts`, `lib/domain/ranking/{policy,policies,period,math,refresh,view}.ts`, `lib/news/repository.ts`.

## 재현 후 수정한 문제

### P1 — 기본값 복원이 동시에 바뀐 수집 스위치를 되돌림

- 위치: `lib/crawl/settings.ts:246`, `resetSettings`.
- 기존 구현은 `getSettings()`로 스위치를 읽고 별도 트랜잭션의 `saveSettings()`에 다시 보냈다. 읽기와 저장 사이에 다른 관리자가 수집을 끄면 예전 `enabled=true`를 재적용했다.
- 실제 PostgreSQL 행 잠금으로 복원 요청을 대기시키고 먼저 수집 중지를 커밋하는 테스트를 추가했다. 수정 전 최종 값이 `true`여서 기대값 `false`에 실패했다.
- 기본값 patch에서 `enabled`를 제외한다. 스위치는 `saveSettings`가 행 잠금 안에서 읽은 최신 값으로 보존한다. 기존 `reviewMode` 보호도 그대로 유지한다.

### P2 — 수동 등록이 크롤러 발행 처리량으로 집계되어 병목을 숨김

- 위치: `lib/operations/pipeline.ts:58`, `pipelineFlow`.
- 기존 구현은 최근 생성된 모든 제품을 발행 단계 처리량과 공개 단계 유입으로 사용했다. 수동 등록된 미검증 제품도 처리량을 올렸다.
- 발행 대기 후보 1건, 수동 미검증 제품 1건, 수동 검증 제품 1건만 있는 회귀에서 기존 `publish.left=2`가 확인됐다. 실제 크롤러 발행은 0건이다.
- 발행 처리량은 최근 생성된 `source=crawler` 제품으로, 공개 유입은 최근 생성된 공개 상태(`verified`, `seeded`) 제품으로 분리했다. 크롤러 발행 제품이 생기기 전 병목이 `publish`로 표시되고, 생긴 뒤 해제되는 것까지 검증했다.
- 이 지표는 최근 생성 제품 수이다. 과거 생성 제품의 재공개·검증 전환까지 센 전체 상태 전이 이력 지표로 바꾸지는 않았다.

### P2 — 근거가 완료된 후보의 갈래·재판정 대상이 목록과 다름

- 위치: `lib/crawl/admin-review.ts:257`, `:331`.
- `listAdminReviewEntries`는 근거 강제 설정에서 저장소 스캔과 관측을 판정에 넣었지만, `reviewQueueCauses`와 `requeueResolvedCandidates`는 넣지 않았다. 따라서 목록상 승인 가능한 후보가 갈래에서는 계속 개발 근거 보류로 집계되고 재판정 대상에서 빠졌다.
- 완료된 동일 제품 개발 근거 1건과 미완료 후보 1건을 넣은 테스트에서, 수정 전 완료 후보가 `resolved`에 없었다.
- 두 경로도 기존 `loadAgentJudgeInputs` 배치 조회를 재사용한다. 강제 설정이 꺼져 있을 때는 추가 조회하지 않는다. 완료 후보만 `resolved` 및 재판정 대상으로 들어가고 미완료 후보는 보류로 남는 것을 검증했다.

### P2 — 재판정 요청이 동시에 내려진 관리자 결정을 덮거나 처리량을 과장함

- 위치: `lib/crawl/admin-review.ts`, `requeueResolvedCandidates`의 마지막 UPDATE.
- 처음 읽을 때만 `decidedBy=auto`를 확인하고 실제 UPDATE에서는 `state=needs_review`만 확인했다. 대기 중 다른 관리자 결정이 들어오면 관리자 보류를 `new`로 바꿀 수 있었다. 다른 상태로 바뀌어 실제 UPDATE가 0건이어도 응답과 감사에는 1건 처리됐다고 남고 작업 요청도 생성됐다.
- 실제 후보 행 잠금을 이용해 `needs_review/admin`, `approved/admin` 두 가지 동시 전환을 재현했다. 수정 전 둘 다 `requeued=1` 응답에 실패했다.
- 쓰는 순간에도 자동 판정 및 사람 전용 보류 사유 보호 조건을 확인한다. `RETURNING`의 실제 변경 ID만 응답·사유별 집계·감사에 사용하고, 0건이면 작업 요청도 만들지 않는다.

### P2 — AI 판단 필터와 표에 표시하는 판단이 다름

- 위치: `lib/crawl/admin-review.ts`, `reviewQueueCauses`, `listAdminReviewEntries`.
- AI 필터는 마지막 성공 판단을 사용하지만 행의 `review`와 `ai_reject` 갈래는 마지막 자동 시도(실패 포함)를 사용했다. 승인 다음 재시도가 실패하면 승인 필터 안에서 판단이 공란으로 보이고, 거부 갈래도 사라졌다.
- 수정 전 승인 필터에 들어온 행이 `review.state=failed`, `review.decision=null`이고, 거부 갈래가 1건에서 0건이 되는 회귀 실패를 각각 확인했다.
- 표시 판단과 갈래는 마지막 성공 자동 심사를 사용한다. 별도의 최신 자동 시도 조회와 `latest`는 유지하므로 `currentReviewStatus`가 실패·실행 중·만료를 판정하는 경로는 보존한다. 실패만 있는 항목은 `review=null`이지만 `latest.state=failed`, `status=failed`이고, 승인 뒤 실패한 항목은 마지막 승인과 최신 실패를 함께 보존하는 것을 검증했다.

## 검증

전용 로컬 PostgreSQL만 사용했다: `127.0.0.1:55435/nomorevibe_test`. 통합 테스트는 테이블을 비우므로 운영 연결로 실행하면 안 된다.

1. 수정 전 다음 명령에서 **예상한 3개 회귀 실패 / 기존 4개 통과**를 확인했다.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration -- tests/integration/admin-domain-review.test.ts tests/integration/admin-review-batch.test.ts
```

2. 수정 후 다음 명령에서 **91개 통과 / 1개 실패**를 확인했다. 새 회귀 3개는 모두 통과했다. 유일한 실패는 병렬 작업자가 방금 추가한, 아직 구현 전인 `별 수 필터는 페이지 제한 전에 적용하고 다른 조건과 함께 전체 건수를 센다`(예상 2, 실제 4)였다. 이 실행을 전체 통과로 기록하지 않는다. 부모 에이전트가 별 수 필터 구현 후 전체 통합 검증을 담당한다.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration -- tests/integration/admin-domain-review.test.ts tests/integration/admin-review-batch.test.ts tests/integration/admin-review-causes.test.ts tests/integration/crawl-settings.test.ts tests/integration/settings-drift.test.ts tests/integration/operations-center.test.ts tests/integration/ranking-policies.test.ts tests/integration/ranking-view.test.ts tests/integration/ranking-refresh.test.ts
```

3. 연관 단위 테스트 **6파일 / 38개 통과**.

```sh
npm test -- tests/operations-pipeline.test.ts tests/ranking-policy.test.ts tests/ranking-math.test.ts tests/ranking-period.test.ts tests/crawl-settings-drift.test.ts tests/crawl-agent-settings.test.ts
```

4. 변경한 도메인·회귀 테스트 ESLint **오류 0**, `git diff --check` **통과**.

```sh
npx eslint lib/crawl/settings.ts lib/operations/pipeline.ts lib/crawl/admin-review.ts tests/integration/admin-domain-review.test.ts tests/integration/admin-review-batch.test.ts
git diff --check
```

5. 추가 재판정 경합·AI 판단 표시에 대해 **수정 전 회귀 실패**를 확인한 뒤 아래 연관 통합 **4파일 / 26개 통과**를 확인했다. 부모가 구현한 별 수 필터 회귀도 이때 통과했다. 로그: `/tmp/nmv-admin-domain-followup-tests.log`.

```sh
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55435/nomorevibe_test npm run test:integration -- tests/integration/admin-domain-review.test.ts tests/integration/admin-review-batch.test.ts tests/integration/admin-review-causes.test.ts tests/integration/admin-review-evidence.test.ts
```

6. 추가 수정 후 `npm test -- tests/admin-review.test.ts tests/operations-pipeline.test.ts`: **2파일 / 9개 통과**. 변경 6개 TypeScript 파일 ESLint와 `git diff --check`도 다시 실행해 통과했다.

테스트에서 나타난 Vite 설정 로더 경고는 기존 설정 경고다. 랭킹 통합 테스트의 손상 정책·DB 오류 로그는 의도된 실패 주입 케이스이며 해당 테스트는 통과했다. 1~4 검증 출력은 도구 실행 기록에 있으며 5 검증은 위 로그 파일에도 남겼다.

## 확인된 기존 보호 및 남은 범위

- 랭킹 예약·취소는 같은 advisory lock을 사용한다. 시즌 정책 snapshot 유지, 고유 유입자 수집 시작 후 7일 제한, 원시 방문 보존 경계, 쿨다운과 대량 바인드 처리는 연관 통합 테스트로 확인했다.
- 수동 분류는 후보·문서 잠금과 source hash를 검증하고 작업 요청·감사를 함께 기록한다. 관련 운영센터 통합 테스트가 통과했다.
- 제품 근거 요약의 `due`는 모든 저장 출처에서 기한이 지난 행의 수이다(`lib/domain/evidence/admin.ts:223`). 실제 워커는 공개 제품의 보이는 링크와 미디어를 골라 처리한다(`lib/domain/evidence/refresh.ts:205`). 따라서 UI의 “지금 처리 대상”은 정확한 워커 대기열 규모와 다르다. 부모 에이전트에게 집계 범위를 드러내는 라벨로 수정하도록 전달했다.
- `removeAuditedProduct`의 유지/제거 경합은 병렬 관리자 액션 담당자가 별도 재현·수정 중이므로 이 문서의 수정 수에 포함하지 않았다.
- 실시간 운영 데이터나 모든 관리자 조합의 브라우저 동작까지 이 도메인 검토만으로 보증하지 않는다. 최종 전체 테스트·화면 검증 결과는 부모 에이전트의 인수인계에 기록한다.

## 수정 파일

- `lib/crawl/settings.ts`
- `lib/operations/pipeline.ts`
- `lib/crawl/admin-review.ts`의 `reviewQueueCauses`, `requeueResolvedCandidates`, 최신 성공 판단 조회·표시만 담당(별 수 필터는 부모 담당)
- `tests/integration/admin-domain-review.test.ts` 신규
- `tests/integration/admin-review-batch.test.ts`
- `tests/integration/admin-review-causes.test.ts`의 최신 성공 판단 회귀만 담당(별 수 필터 회귀는 부모 담당)
- 이 문서
