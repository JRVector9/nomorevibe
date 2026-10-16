# PR05b1 AI2 모델 접수 제어 — 2026-10-16

AI2의 새 root/fallback claim도 AI1과 같은 공통 모델 제어를 확인한다. Primary TX에서 control SHARE를 첫 잠금으로 취한 뒤 기존 S3/domain/chain/실제 job·item 검증을 수행한다. Disabled는 기존 경로를 유지한다. 아직 검증된 provider 계약이 없으므로 open/draining의 새 전송은 typed defer로 정산한다. 잘못된 route·정책·job과 genuine 오류는 정상 업무 실패로 보존한다.

이미 처리 중인 소유권의 갱신·결과 저장·취소·fallback 생성은 기존 경로 그대로다. 새 child의 접수에서만 제어를 확인한다. 모든 lane을 실제 정산하고 genuine 오류를 먼저 전달한다. Active genuine replay는 기존 private brand 경계만 사용하며 새 grants나 공개 우회 옵션을 추가하지 않는다. 양성 permit·물리 provider 종료·claim→dispatch 결합·전체 caller 활성화는 다음 작업이다.

## 실제 기능 검증

- 원 disabled1 control PASS 및 open/draining2 Assertion RED → 동일3 GREEN. Lane의 새3 RED → 기존21을 포함한 unit24 GREEN.
- 최초 전용55539에서 route/job 오류, fresh item rollback, 기존 item의 renew/cancel/reclaim, stale input, in-flight failure/fallback child, 실제 control holder/PID와 S3·domain·job NOWAIT, producer/pause 보존, malformed control, genuine v5/v6, primary context, replacement job, recorder 후 job wall을 좁은 비중복 필터로 검증했다. **15개 distinct case의 분리 GREEN이며 한 번의 최종15 일괄 실행으로 쓰지 않는다.**
- Cleanup guard의 마지막 보강 뒤에는 영향 control1만 다시 통과했다. Unit24+기존 item replay boundary1 및 scoped tsc/eslint0이다. 전체 unit/DB/build/typegen은 실행하지 않았다.
- Root가 생산 두 파일과 unit·integration 전체를 읽었고 C 독립 리뷰의 생산 추가 P1/P2는0이었다. Root의55539 독립 readback은 agent final과 exact/raw89표9행·83journal·타 연결0이며 기존 ACL default 표현 차이를 별도 effective ACL 동등으로 확인했다. 정상 정리 후55539는 retired다.

## Shared fixture·소유권 보완

원 integration의 전역 empty 전제는 nonempty sentinel에서 beforeAll Assertion FAIL로 실제 확인했다. Initial baseline과 selector hold baseline을 나누고 foreign auto candidate는 결정자 한 열, 선택 가능한 vote는 status/resolution만 fullraw CAS로 잠시 제외했다. 마지막에는 바꾼 열만 원 µs로 복원한다. 기존 문서/item/attempt/model 장부를 삭제하지 않는다. 전역0 assertion3곳은 전체 raw baseline exact 비교로 바꿨으며 다른 기능 기대는 유지했다.

고정 job은 기존 idle 행 raw CAS 또는 absent INSERT DO NOTHING/RETURNING1로 준비한다. 원래 없는 관리 관측 key도 같은 TX에서 빈 객체로만 선점한다. 기존 관측행은 덮어쓰지 않으며 placeholder는 성공/readiness 증거가 아니다. Root가 TX commit 전 소유 Set 등록의 P2를 추가 발견하여, 실제 commit resolve 뒤에만 생성 key를 등록하도록 고쳤다. Cleanup은 unknown owner·미등록 absent 행을 거절하고 row lock/fullraw CAS로만 복원하며 commit 뒤에만 등록을 해제한다.

- Nonempty의 disabled/open/draining·replacement/malformed/genuine v5/v6 지정 **7PASS/8skip,21.79초,exit0**, scoped tsc/eslint0. 이 단계 이후 commit 소유 추적 보강은 아래 별도 회귀로 확인했다.
- 새 영구 regression은 자기 고유 probe key만 사용한다. 앞 INSERT 뒤 다음 key 충돌로 전체 TX rollback → 외부 실제 runJob 정상 완료/token=NULL → cleanup의 외부 행 보존 경계다. 원 helper에서 **실제 Assertion RED1+정상 control1PASS**, 최소 보강 뒤 **같은 body2PASS/14skip,1.66초,exit0**. 최종 scoped tsc/eslint도0이다.
- 기존15개 case는 승인한 baseline 표현3곳 외 byte exact이며 마지막 보강 전후 기존15개 영역·새 회귀 본문은 각각 byte exact다. 최종 integration SHA `926276e869aa7f369011e2cee2f9f324f1f11380189c35a156759928e5035508`; 생산 두 파일·기존 unit·capacity repository SHA도 보존했다.

## Root 독립 확인·한계

Root가 반환55542에서 public89표9행/83journal과 agent final을 독립 확인했다. Raw catalog false인 관계16개·DB ACL의 NULL→명시 default 차이는 그대로 보존하고 effective ACL 동등만 별도 조회했다. 최초 relation owner/OID·deadlock timeout의 before/after exact는 수집 한계로 주장하지 않는다. 최종 회귀의 새55544는 root 독립 raw89표9행·83journal·수집 catalog/ACL 전체가 최초 baseline/agent final과 exact이고 타 연결0이었다. 두 DB 모두 정상 STOP/exited0/OOMfalse 후 자기 container/volume만 삭제했다. **55539·55542·55544 retired: 재접속·재생성하지 않는다.**

근거는 `/tmp/nomorevibe-pr05b1-ai2-admission-final-b-20261016.md`, `...pr05b1-fixture-c-final-report...md`, `...pr05b1-commit-c-final-report...md`, `...pr05b1-root-fixture-independent-proof...json`, `...pr05b1-root-commit-independent-proof...json` 및 각 cleanup proof다. Import/FK/관측행 소유 추적/Result prototype/conformance offset 작성 오류는 원 로그와 함께 보존했으며 기능 RED로 세지 않았다.

Genuine v5의 item행0 전제, nonempty event 실제 보존 미실증, unknown managed owner에서 fail-closed, 임의 동시 writer와 모든 키 재사용 조합의 미실증을 유지한다. 선행 PR462 recorder/별도 HTTP CI 실패를 이 결과로 해결했다고 쓰지 않는다. 실제 serving C·고정 identity·단일 attempt·terminal 증명이 없으면 양성 전송은0이다. 운영 활성화·Oracle 가동·처리율2배는 미완료다.

새 전용DB를 배정한 경우에만 `TEST_DATABASE_URL="$OWN_TEST_DATABASE_URL" npx vitest run --config vitest.integration.config.ts tests/integration/second-review-model-capacity.test.ts -t 'does not own probe jobs|keeps disabled AI2'`로 영향 범위를 확인한다. 수동 전체 검증은 모든 PR 개발 뒤 수행한다.
