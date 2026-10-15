# PR04b-2 — AI2 비결과 controller의 현재 상태·소유권 보호

2026-10-16. PR04b-1 #441/head0536116 뒤 별도 worktree에서 진행한다. 이 파일의 예정 검증은 실행 결과가 아니며 실제 명령·로그는 별도 검증 기록에 남긴다.

## 목표와 유지할 동작

`enqueueSecondReviews`, `closeSettledSecondReviews`, `reopenOrphanedGateHolds`, `retryFailedSecondReviews`의 실제 canonical mutation을 S3·현재 도메인·실제 worker job에 결합한다. 선택 쿼리와 caller settings는 hint이며 잠금 뒤 current first/source/pool/settings/product와 status를 다시 확인한다. 사람의 terminal 판단을 오래된 ID 목록으로 덮지 않는다.

기존 독립 reviewer slot·canonical alias·fallback·50/25 quota·reopen25·cleanup1000·retry5분/1시간/MAX3·품질 gate·완료 이력·no-outbox 의미를 유지한다. `recordSecondReview` 함수는 동결한다. legacy/epoch1/contract0·새 item consumer 비활성, 운영 deploy/DDL/provider inference/발굴 재개0이다.

## root 결정

1. 네 semantic controller는 mode 독립이다. stage를 fetch→ai1→ai2 순서로 잠가 전환과 직렬화하며 **실제 `second-review` JobLease를 필수**로 요구한다. empty/zero-match도 proof를 검증한다. legacy handler의 실행 preflight와 외부 dispatch 허가는 별개다.
2. 잠금 순서는 S3→replay mutex→published lifecycle/product→candidate/document/settings/evidence/current first→root/votes ASC→item keys ASC→DML→jobs→recorder→같은 held job의 DB wall time이다. vote 뒤 새 document/settings/domain lock을 얻는 역순은 허용하지 않는다. invalid input 정리에는 valid result context를 권한으로 쓰지 않는다.
3. 원자 단위는 **candidate와 그 chain/gate**다. 앞선 후보가 commit된 뒤 뒤 후보가 실패할 수 있으며 전체 batch rollback으로 보고하지 않는다. 한 candidate의 slot INSERT·old-generation 정리, orphan root→human과 candidate hold는 각각 같은 atomic 단위에 있다. unrelated candidate를 거대 transaction으로 합치지 않는다.
4. candidate의 어느 generation이든 healthy item owner가 있거나 필요한 item lock을 얻지 못하면 enqueue/retry/reopen/cleanup은 잠시 defer한다. 원 item token/owner/binding/expiry/epoch를 바꾸거나 조기 release/reclaim하지 않는다. 실제 원 작업 정산 후 다음 tick에서 회복한다. TTL은 외부 호출 종료 증명이 아니다. 정책만 바뀐 유효 pending의 동일행 재admission 의미를 보존한다.
5. production caller가 없는 `resolveSecondReviews` export는 제거한다. 기존 공개분 keep/double-decision 회귀는 실제 `decidePublishedSecondReview` 경로로 옮긴다. 인증 action과 기존 제품 lifecycle/needs_human CAS를 유지한다. historical finding의 product generation 증명은 이번 scope 밖이다.
6. missing-candidate production cleanup은 잠금 뒤 실제 부재를 확인해 기존 의미를 유지한다. replay는 candidate membership을 인증할 수 없으므로 기존 `replay_final_binding_mismatch`/원자 rollback으로 fail closed한다. journal/schema/profile 우회나 조용한 성공 처리는 추가하지 않는다.
7. 실제 RED 수용 뒤 A의 같은 source 안 private domain snapshot helper를 승인했다. candidate/document/settings/input/attempts/votes/실제 publishedProductId의 잠긴 사실을 반환하고 candidate 부재와 product hint 변경을 구분한다. 공통 input/ownership source 파일은 확대하지 않는다. item busy는 실제 vote ID workkey와 binding candidateId의 합집합을 확인한다. optional authority/가짜 receipt/새 WeakMap framework는 도입하지 않는다.
8. reopen은 기존 `FOR UPDATE SKIP LOCKED`의 비차단 선택을 유지한다. 첫 후보 또는 앞25개가 잠겨 있어도 뒤의 정상 후보가 진행해야 한다. reopen에만 candidate 비차단 잠금과 updated_at 원본 µs/id keyset hint 보충을 적용한다. actual reopened quota25를 지키며 skip/빈 선택에도 실제 job을 검사한다. 다른 controller의 잠금 의미는 바꾸지 않는다.

## 충돌 없는 병렬 소유권

전원 모델 gpt-6.1-sol/xhigh. 작업 트리는 `/Users/jr/Desktop/projects/nomorevibe-pipeline-ai2-controllers`, branch `codex/pipeline-pr04b-ai2-controllers-20261016`, baseline0536116이다.

| 담당 | 배타적 편집 범위 | 전용 loopback DB |
| --- | --- | --- |
| A | `lib/crawl/second-review.ts` non-result 부분·import/helper, 기존 integration `second-review.test.ts`, `review-publication-gate.test.ts` | 55497 / nomorevibe-pr04b2-controller-db-20261016 |
| B | 신규 integration `second-review-controller-locks.test.ts`, 필요 `second-review-controller-current.test.ts` | 55498 / nomorevibe-pr04b2-independent-db-20261016 |
| C | 신규 integration `second-review-controller-authority.test.ts` | 55499 / nomorevibe-pr04b2-authority-db-20261016 |
| root | 문서·Git·최종 취합/직접 리뷰, 나머지 기존 controller caller fixture 적응·replay negative/control·전체 검증 | 필요 시 55500 / nomorevibe-pr04b2-root-db-20261016 |

모든 DB는 고정 pgvector PG17 image `sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`와 dummy nomorevibe/nomorevibe/nomorevibe_test를 쓴다. 다른 담당 DB·운영·forensic77/실패81 접근0. VM 여유를 확인하고 완료한 자기 test container만 확인 후 정리한다.

## 순서와 합격 증거

1. B는 old retry의 S3 우회와 stale closeDecided의 human terminal overwrite, C는 optional/missing/wrong job의 실제 canonical 변경을 정상 control과 함께 먼저 재현한다. A의 생산 source는 root의 실제 RED 수용 전 편집하지 않는다. SQL/import/API 오류는 행동 RED가 아니다. 원본 실패 로그를 GREEN으로 덮어쓰지 않는다.
2. root 수용 뒤 A가 mandatory job/current state/S3/final wall time과 candidate 원자 단위를 구현한다. 정상 proof는 actual runJob/admit/claim만 사용한다. B/C는 독립 원래 실패와 current-state/owner/rollback 경계를 확인한다.
3. 기존 business와 replay의 실제 job lease 인수를 적응하고 원래 품질·시간·gate·이력 assertion을 유지한다. replay actual missing-candidate는 fail-closed rollback이며 인증 지원 완료로 올리지 않는다.
4. 담당 raw whole-row JSON/µs foreign 복원, 자기 prefix·관리행·stage·타 연결 readback/STOP 뒤 파일 반환과 SHA를 보고한다. root가 실제 source와 실패를 직접 검토하고 교차 리뷰 후 전체 단위/DB/정적/build를 실행한다.
5. 최신 main 통합·필수 CI 성공 뒤 정상 PR 병합/main CI/image를 확인한다. image 성공은 운영 적용 증거가 아니다.

## 후속으로 남는 경계

PR04c item lifecycle, item B5 인증, certified callback 뒤 deferred flush의 최종 job wall time, durable 외부 admission/종료 증명·stage drain, 실제 provider identity/상한/취소/30분 baseline은 이 PR의 S3/controller 검증으로 완료하지 않는다. 2배 처리량·Oracle DR도 별도 검증이다.
