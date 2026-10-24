# 원래 호출자의 durable 종료와 현재 ingress의 물리 종료 분리

목표: 원래 호출자가 이미 교체되어 startTicks/PID namespace 사전 관측이 없는 경우를 거짓 Linux identity로 채우지 않는다. v1을 그대로 두고 version2에 originalOwner(durable_process_group_exit)와 currentIngressOwner(실제 Linux container)를 분리한다. DB 기록의 로컬 종료만으로 provider 회수를 승인하지 않으며 양 gateway와 실제 provider 종료는 계속 필수다.

구현 계획:

1. 원 owner의 owner_opened/dispatch 이전 spawn intent/실제 spawned·group_exited의 exact event id·seq·PID·run UUID text SHA와 dispatch_local_ended의 exact id/PG evidence::text SHA를 plan에 고정한다.
2. 같은 fence→control→request lock의 기존 release hook callback에서 원 DB 기록을 재읽고 evaluateLocalCallEnded를 재사용한다. 현재 ingress는 plan 생성 이전에 존재해야 하고 실제 private-container 종료를 요구한다. gateway/provider는 dispatch 이전 출생 제한을 유지한다.
3. 0129는 기존 v1 validator/trigger prosrc와 public OID, 기존20 CHECK를 보존한다. v2 strict shape branch 및 transition의 same-TX durable-record guard만 추가한다. 기존 0126/27/28 SQL, canonical hash와 정산 의미는 변경하지 않는다.
4. 먼저 RED unit/실제 own PG를 관측하고 정상 v2·wrong owner/binding/run/id·누락/살아 있는 그룹·SQL 위조·stale/control/fence·v1 회귀를 GREEN으로 검증한다. root 소유 common docs/운영 상태에는 쓰지 않는다.

## 구현과 검증 결과

base253d2517의 격리 WT에서 구현했다. 원 owner의 권한은 같은 TX에서 읽은 DB의 process-group 및 local-end 기록으로만 검증한다. container404나 보조 artifact의 SHA가 boot↔container 정체성 또는 물리 종료를 증명한다고 해석하지 않는다. 현재 ingress의 private container 종료와 양 gateway·launchd provider의 실제 종료 관측은 별도로 필요하다. provider 종료는 privileged operator가 검토하는 기존 신뢰 경계이며 native terminal·usage·업무 성공은 생성하지 않는다.

변경 파일은 strict v2 contract/공통 release hook/DB 원본 조회 helper/CLI artifact pin/0129·journal 및 관련 fixtures/tests이다. 기존 v1 본문·hash·birth guard는 유지했다. 새0129는 원 public release와 transition trigger를 OID 그대로 확장하고 이전 두 본문을 `_v1_0128` 함수에 byte 그대로 보관한다. 20 CHECK 정의는 모두 그대로다. common handoff 문서는 root가 최신 운영 기록과 함께 별도 통합한다.

실제로 실행한 결과:

- RED: 기존 v1 schema는 v2 정상 fixture를 거절했다(1실패/1통과). 실제 PG의 129-entry 선행 schema도 동일 v2 evidence를 거절했다. 최종 PG fixture는 migration 직전 false/직후 true를 다시 관측한다.
- GREEN: 새 v2 PG 8/8. forged event/run/PID/local-end hash를 재해시해도 generic callback과 direct SQL이 거절한다. 같은 TX에 추가된 미포함 group, strict null/UUID/crosskind, CAS/INSERT와 terminal 역전도 거절한다. 정상 dry-run은 rollback하고 실제 commit은 exact 한 행만 withdrawn + dispatch_released + operations audit로 끝낸다.
- 기존 Linux·macOS·gateway not-started·constraint 회귀를 포함한 PG 5파일40/40.
- unit 6파일26/26, `next typegen`, `tsc --noEmit --incremental false`, 변경 TS 파일 eslint, `git diff --check` 통과.
- disposable PostgreSQL17에서 nonempty migration 전후 20 CHECK 정의·validation과 기존14 public OID가 동일했다. 변경없는12 함수의 prosrc/definition이 동일하고, 변경된 release/trigger의 원 prosrc는 신규 archive와 동일했다. canonical 함수는 그대로다.

실패한 개발 시도: 첫0129의 PL/pgSQL CASE 비교식 괄호 누락으로 compile 실패했다. nested PostgreSQL 오류를 확인해 괄호만 보완했고 전체 migration을 실제 PG에서 검증했다. 초기 신규 test 두 실패는 숫자뿐 UUID에 대문자 변형을 적용한 무효 반례와 jsonb/raw PostgreSQL 숫자·시각 표현 비교였으며 실제 비교 대상을 정확히 고쳤다. production guard를 완화하지 않았다.

## 다음 실행 명령과 남은 작업

```sh
cd /Users/jr/Desktop/projects/nomorevibe-provider-boundary-historical-owner
npm test -- tests/provider-boundary-historical-owner.test.ts tests/provider-boundary-release.test.ts tests/provider-boundary-launchd.test.ts tests/provider-boundary-cli.test.ts tests/dr-followups.test.ts tests/dr-reclaim-outside.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:32783/nomorevibe_test npm run test:integration -- tests/integration/provider-boundary-historical-owner.test.ts tests/integration/provider-boundary-release.test.ts tests/integration/provider-boundary-launchd.test.ts tests/integration/gateway-not-started-ledger.test.ts tests/integration/local-model-assist-constraint-regression.test.ts
npx next typegen
npx tsc --noEmit --incremental false
```

위 URL은 이 작업 전용 local disposable PG이며 운영 credential이 아니다. 카탈로그 보존은 `BOUNDARY_CATALOG_OUTPUT_DIR=/private/tmp/nomorevibe-llm-activation-20261024/provider-boundary-historical-owner-proof`를 신규 PG test에 지정한다.

남은 작업은 독립 최종 리뷰·PR/CI 및 root가 통제하는 실제0129 migration/새 physical boundary 관측/단건 release/restore/배포다. 이 phase에서 production DB/API mutation·모델 호출·신호·배포는 모두0이다. live source 관측 전후 자료를 혼합하지 않고 새로운 v2 plan/receipt와 원본 artifact를 준비해야 한다. 기존 v1 운영 파일/marker를 재사용하거나 소급해서 채우지 않는다.
