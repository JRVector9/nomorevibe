# PR05a 공통 모델 슬롯 비활성 기반 구현 계획

> **For agentic workers:** 저장소의 `execute-plan` 절차로 작업한다. 사용자가 지정한 병렬 담당은 모두 `gpt-6.1-sol` / `xhigh`를 유지한다. root가 계약·파일 소유권·migration 번호·검증·Git을 조정한다.

**Goal:** 실제 호출자 연결 없이 DB 기반 공통 모델 예약·공정 배분·전송 시작 장부를 추가한다.

**Architecture:** 기존 PostgreSQL의 singleton control 행을 짧게 잠근 뒤 request 상태 전이와 append-only event를 같은 transaction에 기록한다. 기본 disabled이며 정책 변경·활성화·실제 provider 호출 API를 추가하지 않는다. 예약 만료만 회수하고 이미 전송된 호출의 불명 점유는 보존한다.

**Tech Stack:** TypeScript, Zod, PostgreSQL17, Drizzle, Vitest. 외부 큐 서비스·새 의존성 없음.

## 현재 근거와 범위

선행 PR449는 main `40cca23d244224e1123f013b09153c82984a2a21`에 병합됐다. PR CI38812876045의 필수 quality·통합3구간·check SUCCESS를 root가 직접 확인했다. main CI38813727290의 필수check와 웹·워커 image 전체SUCCESS도 root가 직접 확인했다. 이 worktree는 해당 main을 정상 merge한 `5f65a50a`다.

PR01 실 provider identity·전체 비용/취소 계약·30분 baseline과 PR04 item 인증·혼합 runner는 미완료다. 이 PR은 독립적인 비활성 기반이며 PR05 전체 완료·새 consumer 활성화·2배 성능·DR 검증을 뜻하지 않는다. 마지막 확인 운영 release8020dca, stage legacy/epoch1/contract0를 변경하지 않는다. 운영 migration·배포·실모델 요청·발굴 재개0.

## 파일 소유권

| 담당 | 배타 수정 파일 |
| --- | --- |
| A `/root/pr01_final_ai1` | NEW `lib/llm/capacity.ts`, NEW `tests/model-capacity.test.ts`, `lib/db/operations-schema.ts`, NEW `drizzle/0078_model_capacity.sql`, `drizzle/meta/_journal.json` |
| B `/root/pr01_final_ai2` | NEW `lib/llm/capacity-repository.ts`, NEW `tests/integration/model-capacity.test.ts` |
| C `/root/provider_contract_evidence` | NEW `tests/model-capacity-adversarial.test.ts`, NEW `tests/integration/model-capacity-adversarial.test.ts` |
| root | plan·validation·handoff·delivery 기록, worktree·검증 취합·교차 리뷰·Git. 기존 caller/설정/권한 파일은 이번 범위 밖 |

`schema.ts`는 operations-schema를 이미 re-export하므로 변경하지 않는다. 기존 migration snapshot은0052까지이며0077도 수동 SQL+journal 방식을 따른다. 0078은 root가 단독 배정한다. 별도 스키마 생성 명령으로 무관 diff를 만들지 않는다. 쓰기 소유권을 반환하기 전 다른 담당 파일은 읽기만 한다.

## 고정된 공개 계약

```ts
type ModelCapacityOwner = Readonly<{ instanceId: string; bootId: string }>;
type ModelCapacityRequest = Readonly<{
  requestId: string; workKey: string; owner: ModelCapacityOwner;
  class: 'first' | 'second' | 'background'; pool: 'reviewer' | 'text';
  routeId: string; provider: string; model: string;
}>;
type ModelCapacityPolicy = Readonly<{
  version: 1; globalLimit: number;
  providerLimits: Record<string, number>; groupLimits: Record<string, number>;
  poolLimits: { reviewer: number; text: number };
  weights: { first: number; second: number; background: number };
  maxWaiting: number; queueTtlMs: number; reservationTtlMs: number;
  routes: readonly {
    routeId: string; provider: string; model: string;
    providerBudgetId: string; groupId: string;
  }[];
}>;
// Reservation/Dispatch는 서로 다른 unique-symbol brand의 readonly handle이다.
// handle 필드: requestId, owner, token, epoch, revision, policyHash.
// 타입은 권한 증거가 아니다. DB의 실제 행·전체 handle CAS가 권한이다.
type ModelSlotResult =
  | { kind: 'granted'; reservation: ModelCapacityReservation }
  | { kind: 'deferred'; reason: 'disabled' | 'draining' | 'unmapped' |
      'capacity' | 'queue_full' | 'policy_changed' | 'withdrawn' | 'dispatched' };
// capacity.ts: schemas와 parseModelCapacityPolicy(value),
// modelCapacityPolicyHash(policy), modelCapacityClassCycle(policy),
// 위 type 및 DB state/event type만 공개. DB import/외부 IO/현재 시각 읽기0.
async function requestModelSlot(value: ModelCapacityRequest): Promise<ModelSlotResult>;
async function beginModelDispatch(value: ModelCapacityReservation): Promise<
  { kind: 'dispatched'; dispatch: ModelCapacityDispatch } | { kind: 'ownership_lost' }>;
async function cancelReservedModelSlot(value: ModelCapacityReservation): Promise<boolean>;
async function markModelDispatchIndeterminate(value: ModelCapacityDispatch,
  reason: 'transport_unknown' | 'local_abort' | 'process_exit' | 'commit_unknown'): Promise<boolean>;
```

- Zod strict object. UUID requestId/boot/token, nonempty trimmed instanceId<=120, workKey<=160, 내부 route/budget/group 식별자<=120, provider<=60, model<=200. limit1..256, weights1..32, maxWaiting1..4096, TTL1..3600000, routes1..128, limit maps1..64. 중복 exact `(routeId,provider,model)`, 참조 대상 누락, unknown key, NaN/unsafe/noninteger를 거절한다. credential/URL/prompt를 저장하지 않는다.
- first/second는 reviewer pool, background는 두 pool을 허용한다. A가 정확한 schema export명을 B/C에 먼저 공유한다. 이 기반의 명시 provider 문자열을 검증하며 기존 provider enum을 바꾸지 않는다.
- hash는 strict parsed policy를 canonical화한 SHA256이다. map key/route 순서만 다른 같은 정책은 같은 hash다. 모델명 trim/lower/[MLX] 제거로 alias를 추정하지 않고 exact route+provider+model을 명시 budget/group으로 해석한다.
- trusted repository caller의 내부 API이고 외부 HTTP 입구0이다. caller는 물리 호출별 randomUUID requestId를 만든다. 기존 ID는 owner/boot/work/class/pool/route/provider/model 전체 identity가 같을 때만 재관측한다. 별도 credential 발급 기반0, trusted raw SQL/DB owner 방어 주장0.

## additive DB 계약

1. `model_capacity_control`: id=1, mode disabled/open/draining(defaultdisabled), epoch/revision default1과 안전 정수 CHECK, nullable policy json/policyHash, cursor default0, DBupdatedAt. policy가 없으면 disabled만 허용한다. 미확인 활성 정책 seed0, 기존 stage/item/role 변경0.
2. `model_capacity_requests`: UUIDrequestId PK, DBbigserial queueOrdinal(unique), workKey/owner/boot/class/pool/route/provider/model, 정책에서 해석한 providerBudgetId/groupId, epoch/revision/hash, state waiting/reserved/dispatched/indeterminate/withdrawn, nullabletoken/reservedUntil, DBqueuedAt/queueUntil/updatedAt. active={reserved,dispatched,indeterminate}. 상태 CHECK와 owner+boot+workKey의 waiting/active partial UNIQUE로 같은 물리 호출의 복수ID 대기를 막는다. settled는 실제 외부 종료 adapter가 결정되는 후속에서 추가한다.
3. `model_capacity_events`: DBbigserial id, requestId FK, 고정 kind queued/reserved/dispatch_started/reservation_cancelled/reservation_expired/wait_expired/policy_changed/dispatch_indeterminate, originalepoch/revision/hash, nullablefromState/toState, 고정 nullable reason, DBcreatedAt. 원문/자유JSON/usage0추정0. 전용 trigger가 UPDATE/DELETE/TRUNCATE를 거절한다. runtime 추가 권한은 caller 연결 PR에서 정하므로 기존 role 권한 변경0.

모든 API는 currentReplayDb가 있으면 DB 접근 전에 `model_capacity_replay_unsupported`를 throw한다. onPrimary 안에서 자체 짧은 transaction만 사용하며 callback/client/transaction을 받거나 돌려주지 않는다. 모든 정상 API는 control UPDATE를 첫 lock으로 잡는다. 이 단일 mutex 아래 기존 request 여러 행을 정리할 때 queueOrdinal로 정렬한 뒤 event를 append한다. 새 INSERT/own 조회/foreign grant까지 모든 lock 획득이 전역 오름차순이라는 주장은 하지 않는다. 외부 call/wait/sleep/dispatcher0. DBclock은 control lock을 기다린 뒤 취득한다.

## admission과 상태 전이

- control 누락/strict policy/hash 오류는 throw한다. disabled/draining/unmapped는 새 waiting을 만들지 않는다.
- control을 잠근 뒤 reservedUntil<=DBnow인 reserved만 withdrawn+expired event로 회수한다. 만료 waiting도 withdrawn+event. dispatched가 먼저 commit하면 회수하지 않는다.
- active의 epoch/revision/hash가 현재 control과 다른 행이 하나라도 있으면 새 admission은 policy_changed다. 새 group명/revision으로 옛 점유를 숨겨 한도를 우회하지 않는다. dispatched/indeterminate는 disabled/epoch변경/TTL/owner죽음으로 free하지 않는다.
- 같은 request poll은 전체 identity를 대조한다. reserved는 유효한 원 handle만 반환, dispatched/indeterminate는 deferred dispatched, withdrawn은 deferred withdrawn. 새 요청은 currentpolicy/DB기한으로 waiting+queued event. 동일 owner/boot/work의 waiting/active가 있으면 deferred capacity이며 DB unique 오류로 transaction을 깨뜨린 뒤 예외를 숨기지 않는다. maxWaiting이 차면 queue_full이다.
- active 전체를 global/providerBudget/group/pool로 센다. 모든 limit을 만족하는 후보만 선택한다. 고정3class expanded weighted cycle의 cursor에서 최대1주기를 돌며 각 class의 capacity-fit 최초 queueOrdinal을 SQL LIMIT1로 선택한다. 포화 group 선두가 무관한 group을 막지 않게 한다. grant 성공에만 cursor를 다음 위치로 옮기며 1poll당 최대1grant다. 빈/불가 class의 몫은 빌린다.
- foreign waiting을 예약해도 그 token을 반환하지 않는다. 마지막에 원 request의 전체 identity로 재조회하여 자신의 reservation만 돌려준다. foreign을 선택한 poll은 deferred capacity가 될 수 있다. 무한 wait/provider 호출0.
- begin은 원 request/token/owner/boot/epoch/revision/hash, reserved, 유효 reservedUntil, 현재 control의 동일 epoch/revision/hash와 modeopen을 CAS한다. commit을 await한 뒤에만 dispatch handle을 돌려준다. 중복 begin은 ownership_lost. commit 불명 예외이면 전송 허가0이며 DB reserved/dispatched 점유를 보수적으로 남긴다.
- cancel은 같은 handle의 reserved만 withdrawn+event. dispatch 뒤 cancel은 false다. markIndeterminate는 원 dispatch handle을 실제 dispatched 행과 대조해 indeterminate+event1회. 같은 handle의 중복 mark는 true/event증가0. control 변경 후에도 원 dispatch 불명을 기록할 수 있으며 점유 감소0이다.
- 첫 PR은 dispatch 후 release, force reset, policy변경/enable, usage/cost 추정, transport/caller 연결을 포함하지 않는다.

## 구현·독립 회귀 순서

- [x] A가 위 API/type/schema의 컴파일 가능한 contract skeleton을 먼저 공유한다. schema/migration은 초기화할 수 있지만 API의 동작 구현은 RED 기록 뒤 진행한다.
- [x] B/C는 같은 공개 계약에 독립 driver를 작성한다. root가 실행 가능한 scaffold에서 assertion RED와 control PASS를 확인한 뒤 본 구현을 해제한다. import/형/SQLsetup 오류를 기능 RED로 세지 않는다.
- [x] A는 strictpolicy/canonicalhash/cycle/schema, B는 짧은 자체TX/primary/replay/실제 CAS/admission, C는 독립 adversarial/2연결 실제 경합/점유/appendonly/foreign 보존을 담당한다.
- [x] root가 모든 source와 원로그를 읽고 A→B, B→C 교차 review를 수행한다. 기존 caller/운영 설정 diff0을 확인한다.

실제 DB 필수 사례: defaultdisabled0행, unmapped0행, global/provider/group/pool 각각의 한도, provider/alias가 다른 같은 group, 동일 request/work의 여러ID·foreignowner/boot, foreignpoll token 비노출, background 몫/idle대여/HOL회피, 두 연결 동시 예약 상한, expiredreserved의 latebegin 거절, begin/cancel 경합·중복begin, dispatched/indeterminate의 기한초과·control변경 후 점유 지속, revision/group변경 차단, commit/rollback의 원자 event, append-only UPDATE/DELETE/TRUNCATE 거절, 외부IO0·replay 선거절·primary scope다.

실제 수용 예이며 완전한 driver는 담당 테스트 파일에 둔다:

```ts
const [left, right] = await Promise.all([requestModelSlot(first), requestModelSlot(second)]);
expect([left, right].filter(x => x.kind === 'granted')).toHaveLength(1);
expect(await sql`select count(*)::int n from model_capacity_requests
  where state in ('reserved','dispatched','indeterminate')`).toEqual([{ n: 1 }]);
const begun = await beginModelDispatch(reservation);
expect(begun.kind).toBe('dispatched');
expect(await beginModelDispatch(reservation)).toEqual({kind:'ownership_lost'});
expect(await cancelReservedModelSlot(reservation)).toBe(false);
```

## 테스트 DB와 cleanup 경계

root가 loopback 포트의 빈 상태를 확인한 뒤 B에55518, C에55519를 나눠 배정한다. 소유명은 `nomorevibe-pr05a-model-capacity-{b,c}-20261016`이다. 이전55517/15/16은 삭제돼 재접속하지 않는다. root 확인 전 새container/role/DB생성0, 사용자DB/volume변경0, provider/HTTP/CLI inference0.

모든 fixture Promise와 독립 holder를 finally에서 정산하고 연결0을 확인한다. DB owner의 testteardown에서만 control UPDATE/해당 table ACCESS EXCLUSIVE 뒤 원 fixture ID+owner를 재검증하고, 전용 `events_no_change` trigger만 같은 TX에서 disable→exactown event/request ID만 삭제→원 trigger enable→원 control 전열 rawµs 복원한다. 원 trigger/함수/ACL/foreignrows를 비교한다. 실패는 rollback하고 body/cleanup/end 오류를 AggregateError로 보존한다. TRUNCATE/전체prefix삭제/session_replication_role/전체triggerdisable/운영force-release0이다. 이 정리를 외부 종료 증거로 세지 않는다. 신규 sequence의 단조 증가를 보존하며 reset하지 않는다. resetTables0.

root가 최종 readback과 정확한 소유 containerID/단독volume/loopback을 확인하고 정상STOP→해당 container/미참조ownvolume만 제거한다. image/cache/volume prune0.

## 검증 명령과 완료 보고

```sh
npx next typegen
npx vitest run tests/model-capacity.test.ts tests/model-capacity-adversarial.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55518/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/model-capacity.test.ts
TEST_DATABASE_URL=postgres://nomorevibe:nomorevibe@127.0.0.1:55519/nomorevibe_test npx vitest run --config vitest.integration.config.ts tests/integration/model-capacity-adversarial.test.ts
npx tsc --noEmit --incremental false
npm run lint
npm test
npm run check:i18n
python3 -m unittest tests/test_deploy_shared_images.py
DATABASE_URL=postgres://build:build@localhost:5432/build npm run build
node scripts/bundle-size.mjs
git diff --check
```

검사를 실제로 실행하고 변경 후 영향 범위만 재실행한다. 미실행을 PASS로 세지 않는다. root는 실제 결과/실패/수정/hash/P1·P2/caller·설정diff0을 validation과 handoff에 기록한다. 최신main 필수check 성공 뒤 정상 head일치 squashmerge만 수행한다. PR/mainCI/image와 운영 migration/배포를 나눠 보고한다.
