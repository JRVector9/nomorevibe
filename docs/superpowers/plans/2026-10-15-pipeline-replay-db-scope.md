# 검수 replay DB scope Implementation Plan

> **For agentic workers:** execute-plan으로 아래 순서의 실제 RED→GREEN을 실행한다. 기존 승인된 PR00–17 설계의 PR01 후속 단위다.

**Goal:** 기존 `db`, `onPrimary`, `onReplica`가 명시된 검수 전용 DB만 사용하도록 연결하고 scope 종료 뒤 SQL 실행을 거절한다.

**Architecture:** private identity 파일로 새 verified handler 연결을 열고 이 scope만 소유한다. AsyncLocalStorage가 전역·replica보다 먼저 executor를 선택한다. Drizzle의 실제 postgres transaction/statement 경계에서 같은 연결의 identity·권한과 scope 생존을 검증한다. 장시간 외부 대기를 감싸는 transaction은 만들지 않는다.

**Tech Stack:** TypeScript, Node AsyncLocalStorage, Drizzle 0.45, postgres.js 3.4.9, Vitest, PostgreSQL17.

---

## 파일 경계

- `lib/db/replay-scope.ts`: 전용 연결 수명, ALS, guarded statement/transaction/savepoint.
- `lib/db/index.ts`: dedicated scope 우선 선택, primary/replica 우회.
- `lib/operations/pipeline-replay-database.ts`, 신규 profile 모듈: 보호된 고정 권한 profile. 담당 agent가 RED→GREEN 검증한다.
- `tests/db-replay-scope.test.ts`: 전역 연결 poison·scope 격리·닫힌 실행·동일 transaction 검증의 단위 회귀.
- `tests/integration/pipeline-replay-db-scope.test.ts`: 실제 연결/rollback/권한 및 기존 repository readback.

## Task 1: scope와 전역·replica 격리

- [x] 아래 인터페이스로 첫 회귀를 작성하고 `npx vitest run tests/db-replay-scope.test.ts`가 미구현 때문에 실패하는지 확인한다.

```ts
await withReplayDatabaseScope(identityPath, async () => {
  const first = await db.execute(sql`select current_user`);
  expect(await onPrimary(() => onReplica(() => db.execute(sql`select current_user`)))).toEqual(first);
});
```

- [x] `withReplayDatabaseScope(identityPath, load)`는 새 handler handle을 열어 독점 소유하고 `finally`에서 닫는다. 동일 path 중첩만 허용하고 다른 path는 열기 전에 거절한다. 같은 path 동시 root scope도 서로 생존 token을 공유하지 않는다.
- [x] `currentReplayDb()`를 `db` proxy와 `onReplica`에서 먼저 확인한다. 저장된 inactive scope는 `undefined`가 아니라 오류다. scope에서 선택한 함수는 해당 executor에 bind한다.
- [x] 위 명령으로 GREEN, 기존 `tests/db-replica.test.ts`도 실행한다.

## Task 2: 실제 statement·transaction 생존과 검증

- [x] 저장된 builder/method/transaction·child async callback을 scope 종료 뒤 실행하는 회귀, 다른 scope에서 실행하는 회귀를 먼저 작성해 RED를 확인한다.
- [x] Drizzle가 사용하는 `unsafe`는 lazy thenable과 `.values()`를 제공한다. 실제 실행 시 token을 확인한다. 단일 statement도 짧은 transaction 안에서 verifier→statement→verifier 순서로 실행한다.
- [x] explicit `begin`/`savepoint`는 **그 callback의 raw 연결**을 검증하고 wrapped client만 전달한다. callback 종료 뒤 transaction token을 폐기한다. commit 전에 scope와 권한을 다시 검증한다.
- [x] 종료 중 새 실행을 차단하고 진행 transaction을 정리한 뒤 소유 연결을 닫는다. `$client` 원본은 노출하지 않는다. parser 변경은 이 scope의 전용 연결 안에만 한정한다.
- [x] 같은 회귀를 실행해 GREEN을 확인한다.

## Task 3: 실제 DB와 검토

- [x] 전용 loopback55456 DB에서 실제 query/transaction rollback, 설정·입력 읽기와 제한 writer를 검증한다. 제품 쓰기와 종료 뒤 실행은 실패해야 한다.
- [x] 관련 unit/integration, typegen/tsc/lint/i18n/build와 diff 검증을 실행한다. 실행한 결과만 validation/handoff에 기록한다.
- [ ] 고정 profile/ALS/API·기존 운영 경로 영향에 대한 독립 검토 후 명시 파일만 commit/push하고 PR을 만든다. 독립 검토는 완료했고 제출 단계가 남았다.

## 완료 경계

이 PR은 실제 두 handler 실행·fixture transport 연결·atomic final/readiness·seal·실모델·성능2배·운영 활성화를 완료로 표시하지 않는다. 운영 migration은 없고 전용 test DB의 관리자 profile provision만 있다. 기존 운영 consumer는 이 함수를 호출하지 않으므로 그대로 동작한다.
