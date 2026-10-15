# PR01b-2 — 검수 DB scope·handler 권한 profile 검증

2026-10-15. base main `2c7a71c12e5c67fdccf53a3257a3cbac112fb516`,
branch `codex/pipeline-pr01b-handlers-20261015`, worktree
`/Users/jr/Desktop/projects/nomorevibe-pipeline-handlers`.

## 결과와 완료 경계

기존 검수 repository/writer가 전역 DB·복제본 대신 검증된 전용 DB에서 실행되도록 연결했다.
실제 AI1 claim/result와 다음 단계 job 요청을 기존 코드로 실행하고,
동일 연결의 rollback·권한 변경·늦은 query를 검증했다. 결과는 격리 테스트의 고정 응답이며 실제 provider 호출이 아니다.

일반 worker는 새 scope를 호출하지 않는다. 운영 migration·provider 설정 변경·운영 배포/활성화는 없다.
두 실제 handler runner/fixture dispatch·atomic final/readiness/artifact/seal은 후속 PR이며,
이번 결과로 PR01 전체 완료·처리량2배·Oracle 상시 업무/DR을 표시하지 않는다.

## 파일과 설계 결정

- `lib/db/replay-scope.ts`, `lib/db/index.ts`: 전역/replica보다 먼저 명시 scope를 선택한다.
  새 private verified 연결을 독점 소유하고 닫는다. Drizzle parser 변경은 이 연결에만 머문다.
  environment/global singleton을 바꾸지 않는다. `$client` 원본은 노출하지 않는다.
- `lib/operations/pipeline-replay-database.ts`, `pipeline-replay-handler-profile.ts`:
  trusted owner가 전용 test DB에만 고정 table/column/sequence profile을 설치한다.
  nonce·policy hash·object OID/ACL·column/default·trigger/function·search path 결합을 실제 transaction에서 검증한다.
  products는 SELECT만 가능하다. source의 `FOR SHARE`에 필요한 `UPDATE(id)`는 ALWAYS statement trigger로 실제 변경을 거절한다.
  baseline profile의 public schema 거절은 그대로 유지한다. profile 설치 실패는 transaction rollback이다.
- 단일 statement도 짧은 검증 transaction으로 실행한다. explicit transaction/savepoint는
  **callback의 실제 raw 연결**을 전후 검증한다. callback 완료 시 admission을 닫아 final verifier 대기 중 늦은 쓰기도 막는다.
  부모/자식 token·미완료 작업 집계로 unawaited child를 취소하고 실제 native rollback을 기다린다.
- `tests/integration/replay-handler-setup.ts`: 전용 테스트 소유권 확인 뒤 profile만 제거하고
  기존 bootstrap helper가 원래 PUBLIC ACL·개인 role/schema를 복구한다. 일반 운영 제거 API를 추가하지 않는다.
- 두 agent가 실제 handler grant map과 구현을 독립 읽기 검토했다. PR01b 이후 profile에서
  호출 장부를 연결하려면 capacity table 권한도 별도 고정 revision으로 추가해야 하며 임의 GRANT로 우회하지 않는다.

## 실제 실행한 검증

| 명령 | 결과 |
| --- | --- |
| `npm test` | 최종 268파일 / 2,679 PASS |
| `npx vitest run tests/db-replay-scope.test.ts tests/db-replica.test.ts` | 2파일 / 19 PASS |
| 전용55456의 `npm run test:integration` | 최종 153파일 / 1,675 PASS / 기존 TODO1. 새 scope8·profile8 포함, 253.59초 |
| agent 전용55455의 database/ledger/profile3파일 | 35 PASS; 마지막 profile 재실행8 PASS |
| `npx next typegen`, `npx tsc --noEmit`, `npm run lint`, `npm run check:i18n` | PASS. 기존 vendor `_ctx` lint warning1 유지 |
| `DATABASE_URL=postgres://build:build@localhost:5432/build npm run build`, `node scripts/bundle-size.mjs` | 최종 PASS, 세 공개 경로 bundle 한도 이내 |
| `python3 -m unittest tests/test_deploy_shared_images.py` | 23 PASS |

두 전용 DB는 pinned `pgvector/pgvector:0.8.6-pg17`, loopback55455/55456이다.
55455는 agent 검증 종료 뒤 stop했다. 55456도 전체 검증 뒤 stop했다.
전체 suite 종료 뒤 전용 DB에서 `pipeline_replay` schema 없음·runtime role0을 직접 확인했다.
원격 CI/PR 상태는 제출 시점에 별도로 기록한다.

## 실제 RED와 실패한 접근

- scope/profile API 미구현으로 최초 test import/기능 확인 실패를 실행했다.
- 닫힌 scope의 `onPrimary` callback이 실행되어 1을 반환한 회귀를 재현한 뒤 callback 진입 전 guard를 추가했다.
- unawaited callback이 끝없이 기다리면 scope drain이 멈추는 회귀(`drain_hung`)를 재현해 native rollback을 유발하는 revoke를 추가했다.
- unawaited nested transaction인데 parent가 commit하는 회귀(`committed`)를 재현해
  ancestor token·transaction별 자식 집계/취소·commit 전 callback admission 종료를 추가했다.
- PostgreSQL probe에서 `UPDATE(ctid/tableoid)`는 `FOR SHARE` 권한을 충족하지 않았다.
  기존 gate/lock을 바꾸지 않고 `UPDATE(id)`와 검증된 deny trigger로 해결했다.
- 기존 PUBLIC SELECT가 effective 권한과 같아 통과한 회귀를 재현해 PUBLIC ACL/grant option을 명시 거절했다.
  사전 CREATE 권한 오류가 profile commit 뒤 발견되는 회귀도 재현해 설치 transaction 내부에서 거절하도록 수정했다.
- Drizzle가 에러를 `cause`에 감싼다는 이유로 실패한 초기 assertion은 실제 cause를 검사하도록 바로잡았다.
  불변 source profile 뒤 fixture를 넣은 초기 test는 fixture seeding을 profile 설치 전으로 옮겼다.
- initial TypeScript는 생성된 `PageProps`가 없어 실패했다. `next typegen` 뒤 최종 tsc는 실제 PASS다.

## 재현 명령

```sh
cd /Users/jr/Desktop/projects/nomorevibe-pipeline-handlers
# 이 branch에서 만든 전용 DB만 다시 시작한다. 운영/개발 DB에 통합 테스트 금지.
docker start nomorevibe-pipeline-handlers-test-db-20261015
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55456/nomorevibe_test npm run test:integration
npm test
npx tsc --noEmit
git diff --check
docker stop nomorevibe-pipeline-handlers-test-db-20261015
```
