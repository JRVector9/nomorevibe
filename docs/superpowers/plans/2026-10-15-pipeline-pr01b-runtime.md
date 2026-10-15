# PR01b-3 — 기존 두 검수 handler의 fixture 실행

사용자의 병렬 개발·오케스트레이션 지시에 따라 승인된 PR01 handler 계획의 두 번째 절을 구현한다.
기준 main은 `9601e3b` (#431)이다. 모델은 모든 서브에이전트 `gpt-6.1-sol` / `xhigh`다.

## 목적과 완료 경계

기존 `reviewCrawlCandidates` / `secondReviewCandidates`와 실제 claim·결과 writer·AI2 관문을
전용 로컬 DB에서 fixture로 실행한다. 실제 제공자 호출과 일반 worker/scheduler는 열지 않는다.
downstream 요청은 기존 isolated `jobs` outbox에 보존하고 두 검수 job만 실행한다.
최종 전이의 원자 기록·준비 coverage·seal·실모델 baseline은 후속 PR01b-4–6에 남긴다.

## 병렬 소유권

| 담당 | 수정 소유권 | 검증 |
| --- | --- | --- |
| fixture transport agent | 새 검수 fixture ALS, 두 handler의 provider 분기, 세 raw adapter의 차단 | 단위 RED→GREEN, 기존 handler 회귀 |
| replay runner agent | `lib/jobs/runner.ts`, 새 restricted fixture runner | claim 전 허용 job/role 금지, heartbeat 종료, fixture-only admission |
| profile/ledger agent | 고정 DB profile, private DB identity 비교, call identity/SQL, 기존 profile·ledger test helper | 전용55457 DB에서 권한·call binding RED→GREEN |
| root orchestrator | DB scope의 raw ledger identity 결합, 새 실제 handler 통합 회귀, 계획·검증·handoff·PR | 전용55458 DB, 통합·전체 검사·코드 리뷰 |

각 담당은 다른 담당 파일을 수정하기 전에 root에게 요청한다. Git commit/push/PR/병합은 root만 한다.
DB는 각 담당 전용 loopback port를 독점하며 운영 설정·운영 DB를 사용하지 않는다.

## 구현·검증 순서

1. 기존 scope와 별도 raw ledger client의 private target/nonce를 정확히 비교한다.
   없는/닫힌 scope·서로 다른 private identity는 handler claim 전에 실패해야 한다.
2. 허용된 고정 ledger table/column만 profile에 추가한다. source 불변·products 읽기 전용을 유지한다.
   first와 second call을 실제 input/attempt/AI2 row·generation·slot·정확한 provider/model에 결합한다.
3. ALS fixture 경계가 장부 reserve→dispatch→in-flight를 커밋한 뒤에만 fixture callback을 실행한다.
   실제 adapter/fetch/CLI는 replay scope에서 실패하며 usage가 불명확하면 admission을 닫는다.
4. restricted entry는 fixture manifest를 검증하고 별도 소유 raw ledger client를 prepare/start한다.
   Drizzle scope와 DB identity를 비교한 뒤 frozen semantic context·fixture scope 안에서 두 고정 handler만 실행한다.
   일반 job/roleLease는 claim 전에 거절한다. 실제 wall clock lease/backoff와 heartbeat 종료를 유지한다.
5. 실제 DB에서 AI1→AI2 관문·held publication request·source requeue·실패/보류 outbox를 readback한다.
   global DB·fetch를 poison해도 접근0, 제품 변경0, 비검수 claim0을 확인한다.
6. 담당 완료 보고를 root가 코드 리뷰한다. 관련 회귀와 전체 unit/integration·타입·linter·빌드·CI를 실행한다.
   실제 실행한 결과만 기록하며 고정 입력 fixture 결과로 처리량 또는2배 성능을 주장하지 않는다.

## 복구와 후속

이 코드는 일반 운영 경로에서 replay entry를 호출하지 않는다. 새 consumer activation과 운영 migration이 없다.
오류 시 fixture admission을 닫고 handler/heartbeat를 종료한 뒤 소유 연결을 닫으며 장부 비용을 환불하지 않는다.
PR01 합격은 신뢰할 수 있는 측정과 baseline이다. 변경2배 판정은 PR06/17의 별도 합격 조건이다.

## 이번 checkpoint 실제 결과

세 담당 구현·교차 읽기 검토와 root 전체 리뷰를 마쳤다. timeout/result/settings/deadline 지적을 수정했다.
최종 unit273파일/2,762PASS, DB154파일/1,689PASS/기존TODO1이며 새 실제 handler8개를 포함한다.
typegen·tsc·lint·i18n·build·bundle·Python23·diff도 실제 PASS다.
최초 DB 실패와 수정, 한계/후속은 [runtime 검증](../../operations/2026-10-15-pipeline-pr01b-runtime-validation.md)을 따른다.
PR/CI·운영 적용은 [납품 상태](2026-10-15-pipeline-delivery-status.md)에 별도 기록한다.

## 다음 b4 사전 읽기 검토 — 구현하지 않은 항목

PR432 CI 대기 중 두 담당이 기존 AI1/AI2 writer를 읽기만 검토했다. 편집·DB·테스트 실행은 없었다.

- `recordAgentReview`는 기존 candidate 갱신과 모든 `requestJob(..., tx)` 뒤 성공 반환 전에 같은 `tx`의
  private recorder를 호출해야 한다. 반환 `applied`는 enforce 여부라 hold/reuse도 포함한다.
  별도 appliedAttemptId 컬럼은 없으며 `candidate.signals.agentReviewAttemptId`가 실제 적용 연결이다.
- 전환 전 running·automatic·비규칙/비재사용·actor/lease와 현재 input/source/policy/version/유효기간,
  적용 후 auto candidate·실제 settled call을 확인한다. observe/hold/rules/reuse/human/stale/부분표는 신규 final0이다.
- `recordSecondReview`도 같은 transaction에서 표 저장·outbox·후보 hold를 마친 뒤 기록한다.
  현재 한 표의 agreed만으로 부족하며 잠근 first attempt와 전체 current generation/root/fallback 표에
  기존 `secondReviewApprovalPredicate`를 재사용한다. AI2 reject나 ai_decided 일치만으로 자동 거절 final을 만들지 않는다.
- **잠금순서 추가 설계가 필요하다.** AI2 writer가 job UPDATE를 잡은 뒤 recorder에서 형제/root 표를
  잠그면, 표 UPDATE 뒤 job SHARE를 얻는 cleanup과 교착할 수 있다. gate 전체행은 job보다 먼저 정렬해
  취득하고 cleanup과 공통 순서를 입증해야 한다. run/event는 모든 domain/job/outbox 작업 뒤 마지막으로 잠근다.
- cleanup은 하나의 transaction이 아니다. 각 withJobLeaseWrite와 별도 human hold/close transaction에
  전이 recorder를 결합해야 한다. 기존 final 이력은 보존하고 다시 세지 않는다.

이 항목의 구현·원자 rollback/두 연결 교착 회귀는 다음 PR에 남아 있다.
