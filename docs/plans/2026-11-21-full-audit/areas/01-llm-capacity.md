# 01. 모델 장부(용량 제어) — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


대상: `저장소 루트` (origin/main `34b5fe32`). 읽기 전용, EXPLAIN·DB 접속 없음 — 계획(plan)은 색인 정의와 쿼리 모양에서 추론했고, 추론인 곳은 확신도에 적었다.

## 요약

- 심각도별: **P1 7건 · P2 6건 · P3 2건** (모두 15건)
- 실측 연결: control 행 잠금 대기는 하루 **35,141번 · 약 36,184초**(FOR UPDATE 전체열 19,640/20,254s, `select id … for update` 6,546/6,894s, FOR SHARE 전체열 6,395/6,467s, `select id … for share` 2,560/2,569s). `model_capacity_requests` seq scan은 5.6일 동안 1,756,826번(하루 약 31만 번), 한 번에 평균 약 32만 행을 읽는다.
- 가장 중요한 5건
  1. **CAP-01** 점유를 줄이기만 하는 전이 24곳(정산 15·취소/거둠 7·미확정 표시·로컬 종료 기록)이 모두 control을 `FOR UPDATE`로 잡아 입장(requestSlot)·dispatch 뒤에 한 줄로 선다. 정산은 정책을 읽지도 않는다(`select id … for update` 6,546번 대기).
  2. **CAP-02** dispatch TX가 control `FOR UPDATE`를 쥔 채로 stage·후보·문서·설정·근거·시도·잡·역할 잠금과 수십 문장을 돈다. 그래서 도메인 행 하나를 기다리는 일이 시스템 전체 정지로 커진다.
  3. **CAP-03** AI1 새 claim이 control `FOR SHARE`와 후보 `FOR UPDATE`를 쥔 채 **두 번째 풀 연결**을 열어 전 장비 상태(CAP-05 스캔 포함)를 계산하고, 그 뒤 `reservation_required`로 되감긴다. 풀이 차면 5초 동안 자기 교착에 빠질 위험도 있다.
  4. **CAP-05** 장비 판정 CTE `busy`의 셋째 가지(`r.updated_at >= now - idle_ms`, 상태 조건 없음)는 어떤 색인으로도 범위가 줄지 않는다. 입장 grant(잠금 아래)와 모든 장비 상태 관측(감시자 15초, 글 작업 고르기 힌트마다)에서 표를 훑는다. seq scan의 유력한 주원인이다.
  5. **CAP-06** crawl-tagline·search-verify의 fence(`logical_work_key = … AND state IN ('dispatched','indeterminate','settled')`)를 받쳐 줄 색인이 없다. 그래서 OR 전체가 seq scan이 되고, 그 스캔이 control `FOR UPDATE` 아래에서 돈다.

## 발견

### CAP-01 점유를 줄이기만 하는 전이(정산·취소·미확정 표시)도 전역 control 행을 FOR UPDATE로 잡는다
- 심각도: P1
- 분류: concurrency
- 위치:
  - 정산 15곳(`settlementTransaction` + mutex): `lib/llm/capacity-repository.ts:604, 1137-1138, 1266-1267, 1326-1327, 1410-1411, 1444-1445, 1553-1554, 1667-1668, 1782-1783, 1897-1898, 2062, 2242, 2496, 2753, 3304`
  - 취소·거둠·표시: `:426`(cancelOwnPendingReasonTranslationRequest), `:488`(cancelOwnPendingProductTextRequest), `:883-884`(cancelReservedModelSlot + expireRequests), `:904`(cancelOwnPendingLocalModelRequest), `:942-943`(markModelDispatchIndeterminate + expireRequests), `:982`(closeModelCapacityUnknownReview), `:1059`(recordModelDispatchLocalEnd), `:3109`(withdrawUndispatchedAi2ItemForFallback), `:3376`(cancelOwnPendingPublicationApiBatch)
  ```ts
  // capacity-repository.ts:1135-1141 (reconcileAi1GatewayTerminal)
  return settlementTransaction("reconcileAi1GatewayTerminal", async tx => {
    // Completion uses the historical dispatch, not today's policy validity.
    const [mutex] = await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl)
      .where(eq(modelCapacityControl.id, 1)).for("update");
    ...
    const [row] = await tx.select().from(modelCapacityRequests)
      .where(eq(modelCapacityRequests.requestId, dispatch.requestId)).for("update");
  ```
- 문제: 칸 상한이 깨질 수 있는 전이는 점유를 **늘리는** waiting→reserved(grant, `grantOne` `:189-207`) 하나뿐이다. 정산(dispatched|indeterminate→settled), 취소(→withdrawn), 미확정 표시(dispatched→indeterminate)는 점유를 그대로 두거나 줄인다. 같은 행끼리는 요청 행 `FOR UPDATE`와 상태 CAS가 이미 막는다. 동시에 도는 grant가 아직 커밋되지 않은 정산을 「점유 중」으로 보면 칸을 덜 줄 뿐 더 주지는 않는다. 그런데도 이 24곳은 grant와 같은 배타 잠금을 잡는다. 정산 주석은 「오늘 정책과 무관하다」고 적어 두고 mutex로만 쓴다. 그 결과 전송이 끝난 호출의 정산이 입장 폴링(CAP-07)·dispatch TX(CAP-02) 뒤에 줄을 선다. 그동안 끝난 호출의 칸이 풀리지 않아 다음 입장도 늦어지는 되먹임이 생긴다. 55P03이면 0.25·1·2초 재시도를 더해 최대 약 23초까지 늘어난다(`capacity-lock-retry.ts:14`). 취소(cancelReservedModelSlot)는 재시도도 없다. 55P03이면 `AggregateError`로 끝나고 예약이 TTL(30초) 동안 칸을 쥔다(`agent-review-model-capacity.ts:209-214`).
- 실측 근거: `slow-queries-primary.txt:7` `select "id" from "model_capacity_control" … for update` 6,546번, 6,894초, 평균 1,053ms, 최대 5,936ms. 정산 쪽 대기가 하루 약 1.9시간이다. 같은 파일 `:73` lock timeout 17건.
- 수정 방안(추천): 잠금 모드를 넷으로 나눈다(구조 제안 S1).
  ① grant를 만드는 TX(requestSlot)는 `FOR NO KEY UPDATE`
  ② 점유 감소 전이 24곳은 `FOR KEY SHARE`. 정책·모드 쓰기와 DR seal만 막으면 된다. 정산은 아예 잠그지 않아도 되지만 DR 승격 스냅숏과의 순서를 지키려면 KEY SHARE가 안전하다.
  ③ 정책·모드·장비 설정 쓰기는 지금처럼 명시적 `SELECT … FOR UPDATE`
  ④ 관측·읽기는 잠금 없음
  KEY SHARE는 NO KEY UPDATE와 충돌하지 않는다. 그래서 정산·취소가 입장·서로와 줄 서지 않고, 정책 쓰기(FOR UPDATE)와만 배타가 된다. markModelDispatchIndeterminate·cancelReservedModelSlot의 `expireRequests` 호출(전역 만료 청소)은 빼서 입장 TX에만 둔다(CAP-08).
- 검증: `tests/integration/model-capacity-control-contention.test.ts`에 사례를 더한다. 「다른 세션이 control `FOR NO KEY UPDATE`(입장)를 쥔 동안 reconcile*·cancel*·markModelDispatchIndeterminate가 lock_timeout 없이 끝난다」, 「`FOR UPDATE`(정책 쓰기)를 쥔 동안에는 기다린다」. 운영 지표는 `slow-queries`의 `select "id" … for update` 횟수, 로그 `model_capacity.settle_lock_retry` 0회.
- 배포 주의: control에 쓰는 모든 경로가 `UPDATE` 전에 명시적 `SELECT … FOR UPDATE`를 잡아야 KEY SHARE 보유자와 배타가 된다. 일반 UPDATE는 NO KEY UPDATE라 KEY SHARE와 충돌하지 않는다. `lib/operations/dr/repository.ts:91`(DR seal의 `UPDATE model_capacity_control`)는 지금 잠금 없이 바로 UPDATE하므로 같은 PR에서 `FOR UPDATE` 선행을 넣어야 한다. permits.ts:70, admin-engine-limits.ts:73, ops-runner/control.ts:56, `control(tx)` 기본값은 이미 FOR UPDATE다. 마이그레이션은 없고 일반 배포다. 잠금 순서(fence→control→행)는 바뀌지 않는다.
- 확신도: CONFIRMED. 24곳의 잠금과 grant만 점유를 늘린다는 점은 읽어서 확인했다(`grantOne` 호출은 `:843` 하나뿐). 운영 대기 가운데 정산 몫이 얼마인지는 `log_lock_waits`(CAP-15)로 확인해야 한다.
- 규모: M

### CAP-02 dispatch TX가 control FOR UPDATE를 쥔 채 도메인 잠금 전체를 돈다 — 도메인 대기가 전역 정지로 증폭된다
- 심각도: P1
- 분류: concurrency
- 위치:
  - `lib/llm/capacity-repository.ts:1076-1102`(lockAi1ModelCapacityDispatch), 같은 모양: `:549, 1210, 1500, 1613, 1728, 1843, 2014, 2190, 2450, 2656, 3264`
  - 호출자 예: `lib/crawl/agent-review-repository.ts:1187-1335`, `lib/crawl/translations.ts:372-391`, `lib/domain/products/search-profiles.ts:425·569`
  ```ts
  // agent-review-repository.ts:1199-1208, 1224 (claimReview, reserved 경로)
  dispatchLock = await lockAi1ModelCapacityDispatch(tx, { reservation: reserved.reservation, ... }); // control FOR UPDATE
  const stages = await lockPipelineInputStages(tx);
  const stage = await readItemStage(tx, stages.ai1);
  const locked = await lockCurrentReviewInput(tx, input);   // 후보 FOR UPDATE·문서·설정·근거·scan·observation
  ...
  const selected = await chooseFirstReviewForCandidate(locked, tx, others, note);
  // → 시도 FOR UPDATE·재시도 집계·근거 성장·jobs FOR SHARE·insert 시도·finish(UPDATE+event)
  ```
- 문제: lock* 함수는 「이 UPDATE 접두가 모든 stage/domain/job 잠금보다 먼저」라는 교착 회피 순서를 위해 TX 맨 앞에서 control을 배타로 잡는다. 그다음 commit까지 도메인 행 잠금 6~10개와 집계·근거 읽기 수십 문장이 이어진다. 그동안 전 시스템의 입장·정산·다른 dispatch가 멈춘다. 다른 TX(발행·판정·관리자)가 후보·잡·역할 행을 잠깐만 쥐어도, dispatch TX가 그 행을 기다리는 시간(최대 lock_timeout 5초, `lib/db/pool.ts:56`)만큼 control이 묶인다. reserved→dispatched는 점유를 바꾸지 않고, 같은 작업 fence 재확인도 자기 reserved 행이 살아 있는 한 다른 입장이 새 행을 못 만들므로 배타 잠금이 필요 없다. 실제로 필요한 것은 「정책·모드가 그 사이 바뀌지 않음」뿐이다.
- 실측 근거:
  - `slow-queries-primary.txt:3` control 전체열 `FOR UPDATE` 19,640번, 20,254초, 평균 1,031ms, 최대 5,013ms(= lock_timeout 5초). 여기에는 requestSlot과 dispatch 접두가 섞여 있다.
  - 하류 증상(정황): `:15`·`:18` `role_leases … for update`(역할 heartbeat) 2,038번 평균 0.92초, `:23` jobs heartbeat UPDATE 160번. dispatch TX가 역할 행(FOR SHARE)과 잡 행을 쥔 채 commit을 늦추면 heartbeat가 그만큼 기다린다.
- 수정 방안(추천): lock* 12곳의 `control(tx)`를 `control(tx, "key share")`로 바꾼다. 교착 회피 순서는 그대로다. 정책 일치·세대 비교·fence 재확인·행 `FOR UPDATE`·finish의 상태/토큰/reserved_until CAS는 그대로 둔다(CAP-01과 같은 4단 모드). 대안으로 도메인 검사를 먼저 하고 control을 맨 끝에 잡는 방법이 있지만, 잠금 순서가 뒤집혀 교착 위험이 생기므로 추천하지 않는다.
- 검증:
  - 통합 시험에 사례를 더한다. 「입장 TX가 control을 쥔 동안 `lockAi1ModelCapacityDispatch`+`finish`가 끝난다」, 「`setModelCapacityMode`가 dispatch TX 끝까지 기다린다」.
  - 기존 `agent-review-capacity-dispatch.test.ts`·`*-capacity-dispatch.test.ts` 전부.
  - 지표: control FOR UPDATE 대기 수, role_leases 대기.
- 배포 주의: CAP-01과 같다(DR seal의 `FOR UPDATE` 선행 필수). 일반 배포.
- 확신도: CONFIRMED(잠금 순서와 잠금 아래 문장은 코드로 확인). 운영 대기 중 dispatch 몫은 측정이 필요하다.
- 규모: M

### CAP-03 AI1 새 claim이 control SHARE + 후보 FOR UPDATE를 쥔 채 두 번째 DB 연결로 전 장비 상태를 계산하고, 그 TX를 되감는다
- 심각도: P1
- 분류: concurrency
- 위치:
  - `lib/crawl/agent-review-repository.ts:1203`(SHARE), `:1208`(후보 FOR UPDATE), `:1224`, `:113-125`(workload 가지), `:1335`(`reservation_required` throw)
  - `lib/crawl/review-task-ranks.ts:266`
  - `lib/llm/ai-task-workload-selector.ts:106, 142-143`
  ```ts
  // review-task-ranks.ts:266 — executor 를 넘기지 않는다
  const chosen = await chooseTaskWorkloadMember(config, candidates, { queueWhenFull: true });
  // ai-task-workload-selector.ts:142-143
  return options.executor ? await load(options.executor)
    : await onPrimary(() => db.transaction(load, { accessMode: "read only", isolationLevel: "repeatable read" }));
  // load 안: readModelCapacityDeviceStates(tx) — 모든 장비 LATERAL deviceStateSql(CAP-05 busy 포함)
  ```
- 문제: 예약이 없는 첫 claim(fresh intent)은 「예약이 필요하다」는 답을 얻으려고 도메인 전체를 잠근 채 돈다.
  - 그 안의 `chooseFirstReviewForCandidate(locked, tx, …)`는 이 후보의 살아 있는 의도가 없으면 「동시에」 가지에서 `chooseReviewWorkloadMember`를 부르고, 이 함수는 **바깥 tx를 무시하고 풀에서 새 연결**을 잡아 모든 장비의 상태 CTE를 계산한다.
  - 그동안 바깥 TX는 control `FOR SHARE`와 후보 `FOR UPDATE`를 쥐고 있다.
  - 끝에서 `ModelCapacityDeferredError("reservation_required")`를 던져 전부 되감는다(`:1335`). 일은 다시 requestSlot과 reserved claim으로 처음부터 돈다.
  - ① SHARE 보유 시간 동안 control FOR UPDATE를 쓰는 입장·정산·dispatch가 멈춘다. PostgreSQL은 SHARE로 잠긴 행에 오는 새 SHARE 요청을 기다리게 하지 않는다(heap_lock_tuple의 share-on-share `require_sleep=false`). 그래서 이런 claim이 겹치면 FOR UPDATE 대기자가 굶는다.
  - ② reviewer 풀(최대 11, 소비자 3)이 이런 TX로 차면 모두 두 번째 연결을 기다린다. `DB_POOL_WAIT_MS` 5초 뒤 `DbPoolWaitTimeoutError`가 나고, catch가 이를 `assignments_unavailable`로 바꾼다. 그 5초 동안 control·후보 잠금이 쥐어진다.
- 실측 근거: `slow-queries-primary.txt:8` control 전체열 `FOR SHARE` 6,395번·평균 1,011ms, `:3` FOR UPDATE 최대 5,013ms. 이 경로를 따로 떼어 낸 수치는 없다(정황).
- 수정 방안(추천):
  ① claim TX 안의 재확인은 `chooseTaskWorkloadMember(..., { executor: tx })`로 같은 연결을 쓰거나, 더 낫게는 이 후보 하나뿐인 재확인에서 장비 상태 계산 자체를 빼고 TX 밖 힌트 결과를 넘겨받는다(`blocked`가 이미 다른 구성원을 모두 막아 후보가 하나다).
  ② fresh-intent claim의 목적(입력이 현재인지, 재사용인지, 예약이 필요한지)을 잠금 없는 읽기로 미리 판정해서, 예약이 필요하면 도메인 잠금 TX를 열지 않고 바로 requestSlot으로 간다.
  ③ SHARE를 KEY SHARE로 바꾼다(CAP-04).
- 검증: 단위 시험 「claimReview 안에서 db.transaction이 새로 열리지 않는다」(db mock 호출 수). 통합 시험 「풀 크기 1에서 fresh claim이 DbPoolWaitTimeoutError 없이 끝난다」. 지표: 로그 `ai_task.workload_hint_selected` 대비 claim 소요, FOR SHARE 대기 수.
- 배포 주의: 일반 배포. 1차 「동시에」 칸 수(F2) 원자성은 requestSlot의 memberCap이 지키므로 바뀌지 않는다.
- 확신도: CONFIRMED(호출 경로를 끝까지 읽음: claimReview→chooseFirstReviewForCandidate→chooseReviewWorkloadMember→chooseTaskWorkloadMember의 executor 없음→새 TX). 운영 빈도는 「동시에」 모드가 켜진 정도에 달렸다.
- 규모: S

### CAP-04 「정책만 읽는」 도메인 TX 12곳 이상이 control을 FOR SHARE로 쥐고 도메인 일을 한다 — FOR UPDATE 쓰기를 굶긴다
- 심각도: P1
- 분류: concurrency
- 위치:
  - `lib/llm/capacity-repository.ts:98-101`(lockModelCapacityCallerControl), `:2088, 2326, 2352, 2517`
  - 호출자: `lib/crawl/agent-review-repository.ts:943·1203`, `lib/crawl/second-review-ownership.ts:306`, `lib/crawl/taglines.ts:285·391·411·433`, `lib/crawl/translations.ts:375`, `lib/domain/products/search-profiles.ts:429·571·639`, `lib/domain/products/korean-taglines.ts:410`, `lib/domain/products/translations.ts:294`, `lib/domain/products/search-query-capacity-repository.ts:96·108`, `lib/operations/publisher-drain-progress.ts:49`
  ```ts
  // capacity-repository.ts:96-101
  /** Policy read for a short domain claim TX, never a permit or dispatch proof. */
  export async function lockModelCapacityCallerControl(tx: ProductTransaction) {
    return callerControlSnapshot(await control(tx, "share"));
  }
  ```
- 문제: 주석대로 이 잠금은 「TX 동안 mode·policy가 바뀌지 않음」만 보장하면 된다. 그런데 FOR SHARE는 NO KEY UPDATE·UPDATE와 모두 충돌하고, 새 SHARE가 큐에 선 FOR UPDATE를 앞지른다. 결과 쓰기 TX(recordReservedCrawlTagline 등), 준비 TX(비예약 가지), 이어 읽기(readSearchVerifyContinuation 등)가 서로 겹치는 동안 입장·정산은 틈을 찾아 기다린다. 2026-10-31에 readback 몇 곳을 잠금 없는 읽기로 옮겼지만(`:103-138` 주석), 도메인 TX들은 그대로다.
- 실측 근거: `slow-queries-primary.txt:8` FOR SHARE 전체열 6,395번·6,467초, `:13` `select id … for share` 2,560번·2,569초. 합계 하루 약 2.5시간 대기. FOR UPDATE 쪽 대기(`:3`·`:7`)의 일부도 이 굶김이다(정황).
- 수정 방안(추천): 호출처를 둘로 나눈다.
  - (a) 정책·모드만 쓰는 곳은 `FOR KEY SHARE`로 바꾼다(정책 쓰기 FOR UPDATE와만 충돌). lockModelCapacityCallerControl, publisher-drain-progress, 비예약 준비 가지, recordReserved* 대부분이 여기에 든다.
  - (b) 「같은 세대에 새 dispatch가 끼지 않음」에 기대는 곳은 control 대신 그 작업 키의 advisory xact lock(`pg_advisory_xact_lock_shared(hashtextextended('cap:key:'||logical_key,0))`)으로 좁힌다. dispatch 쪽은 같은 키를 배타로 잡는다. lockSearchVerifyResultChain(`:2348`)이 그렇다. 결과 작성 중 같은 제품의 새 실행이 dispatch되지 않음을 control SHARE로 보장하고 있다.
  호출처마다 (a)/(b)를 표로 확정한 뒤 바꾼다.
- 검증: contention 시험에 사례를 더한다. 「KEY SHARE 보유 중 입장(NO KEY UPDATE)·정산이 기다리지 않는다」, 「정책 쓰기는 기다린다」, 「search-verify 결과 작성 중 같은 제품의 새 dispatch는 키 잠금으로 기다린다」. 기존 `search-verify-capacity-dispatch.test.ts`, `crawl-tagline-capacity-dispatch.test.ts`.
- 배포 주의: CAP-01의 DR seal `FOR UPDATE` 선행이 먼저다. (b) 키 잠금은 dispatch·결과 작성 양쪽이 같은 릴리스에 들어가야 한다. 옛 코드와 섞이면 보장이 빠진다. 역할 워커를 같은 배포로 바꾼다.
- 확신도: CONFIRMED(share-on-share 동작은 PostgreSQL heap_lock_tuple 동작이고 호출처는 grep으로 확인). 다만 (a)/(b) 분류는 호출처마다 다시 확인해야 한다(PLAUSIBLE).
- 규모: M

### CAP-05 장비 판정 CTE `busy`의 셋째 가지가 색인 범위 없이 표를 훑는다 — 입장 grant와 모든 장비 상태 관측에서
- 심각도: P1
- 분류: latency
- 위치: `lib/llm/capacity-devices.ts:447-456`. 쓰는 곳은 deviceCandidateSql `:546-568`(grantOne, control 잠금 아래)과 deviceStateSql `:640-664`(readModelCapacityDeviceStates: 감시자 `capacity-supervisor/snapshot.ts:250` 15초 주기, `ai-task-workload-selector.ts:106` 고르기 힌트마다, 관리자·model-picker).
  ```sql
  busy AS MATERIALIZED (
    SELECT (EXISTS (
      SELECT 1 FROM model_capacity_requests r JOIN roles ro ON ro.route_id = r.route_id AND ro.role_rank = 1, s
      WHERE r.group_id = ${device} AND NOT ${helperRouteMatchSql("r")} AND (
        (r.state = 'waiting' AND r.epoch = … AND r.queue_until > clock_timestamp())
        OR ${holding}
        OR r.updated_at >= clock_timestamp() - s.idle_ms * interval '1 millisecond')   -- 상태 조건 없음
    ) OR ${helperDemandOnSql()}) AS primary_busy)
  ```
- 문제: 셋째 가지는 모든 상태(settled·withdrawn 포함)의 행을 `updated_at`으로 고른다. `s.idle_ms`를 쓰므로 조인 조건이기도 하다. `model_capacity_requests`에는 `(group_id, …)`나 `updated_at` 일반 색인이 없다(`lib/db/operations-schema.ts:198-206`: 부분 색인은 state별, `job_readback_idx`만 비부분인데 `route_id` 선두). 그래서 OR 전체를 BitmapOr로 풀 수 없다.
  - 접근은 seq scan 아니면 rank-1 경로의 `job_readback_idx` 전 이력 스캔이다. 둘 다 14일치 이력(51만 행)을 읽는다.
  - EXISTS라 첫 일치에서 멈추지만, 일치 행(최근 60초 안 갱신)은 비 HOT 갱신으로 힙 아무 곳에나 놓인다. 평균 절반쯤 읽는 것과 맞는다(실측 평균 32만 행/스캔). 우선 역할이 정말 쉬면 끝까지 읽는다.
  - grantOne은 대기 행이 있는 장비마다 이 쿼리를 돌린다(`capacity-repository.ts:195-206`). 포화 때 폴링(CAP-07)마다 장비 수 × 스캔이 control FOR UPDATE 아래에서 반복된다.
  - 관측 쪽은 잠금은 없지만 글 작업 `runPool` 한 건마다(CAP-10), 감시자 15초마다 장비 수만큼 스캔한다.
- 실측 근거: `pg-stats-primary.txt:8` `model_capacity_requests` seq_scan 1,756,826 · seq_tup_read 565,379,093,415(5.6일; 하루 약 31만 번, 1회 평균 약 32만 행). 표 2,471MB · 살아 있는 51만 · dead 93k. 쿼리와 seq scan의 직접 대응은 EXPLAIN·pg_stat_statements로 확인해야 한다.
- 수정 방안(추천): 셋째 가지를 상태별로 색인을 타는 범위 조건으로 바꾼다. 기준 시각은 스칼라 부분질의로 한 번만 계산한다(InitPlan, `heldUnknownSql`과 같은 방식).
  `(r.state='settled' AND r.settled_at >= cutoff) OR (r.state='withdrawn' AND r.updated_at >= cutoff) OR (r.state='indeterminate' AND r.updated_at >= cutoff) OR (r.state IN ('waiting','reserved','dispatched') AND r.updated_at >= cutoff)`
  각 가지는 `settled_at_idx`·`withdrawn_at_idx`·(새) open 부분 색인을 탄다. 열린 상태 부분 색인 `CREATE INDEX CONCURRENTLY model_capacity_requests_open_group_idx ON model_capacity_requests (group_id, route_id) WHERE state IN ('waiting','reserved','dispatched','indeterminate')`를 더하면 `active`·`waiting`·`helper_active`·`route_use`·`model_use`도 group_id 범위로 읽는다. settled 행은 정산 뒤 갱신이 없어 `settled_at`과 `updated_at`이 사실상 같으므로 의미가 유지된다(확인 필요).
- 검증: replica에서 `EXPLAIN (ANALYZE, BUFFERS)`로 deviceCandidateSql·deviceStateSql을 바꾸기 전과 뒤에 비교한다(Seq Scan on model_capacity_requests 사라짐, shared hit 수). `tests/capacity-devices.test.ts`·`tests/integration/model-capacity-devices-admission.test.ts`(primary_busy 판정 같음). 지표: `pg_stat_user_tables.seq_scan` 증가율.
- 배포 주의: `CREATE INDEX CONCURRENTLY`는 TX 밖에서 돌아야 한다(이 저장소의 migrate 방식 확인. 0172처럼 SHARE 잠금 CREATE INDEX면 장부 쓰기가 만드는 동안 멈추므로 DRAIN 창 안에서). SQL 글자 변경은 일반 배포.
- 확신도: PLAUSIBLE. 색인이 없어 범위가 줄지 않는다는 점은 CONFIRMED지만, seq scan 횟수의 주원인이라는 점은 EXPLAIN·pg_stat_statements로 확인해야 한다.
- 규모: S

### CAP-06 crawl-tagline·search-verify fence의 「같은 단계 이미 보냄」 가지에 색인이 없어 fence 전체가 seq scan이 된다 — control FOR UPDATE 아래에서
- 심각도: P1
- 분류: latency
- 위치: `lib/llm/capacity-repository.ts:1948-1958`(crawlTaglineFence), `:2137-2147`(searchVerifyFence). 호출은 requestSlot `:702-703`(control FOR UPDATE 아래)이고, 순위 넘김(handover)이 있으면 savepoint 안에서 한 번 더 돈다(`:705-706`).
  ```ts
  // lib/llm/capacity-repository.ts:1948-1956 (crawlTaglineFence)
  async function crawlTaglineFence(tx: ProductTransaction, input: CrawlTaglineInput, ownId: string): Promise<boolean> {
    const [blocked] = await tx.select({ id: modelCapacityRequests.requestId }).from(modelCapacityRequests).where(sql`
      (${modelCapacityRequests.requestId} <> ${ownId} AND (
        (${liveStateSql(modelCapacityRequests.state)}
          AND ${modelCapacityRequests.logicalMemberKeys} && ARRAY[${crawlTaglineMemberKeys(input.member)[0]}]::text[])
        OR (${modelCapacityRequests.logicalWorkKey} = ${crawlTaglineLogicalWorkKey(input)}
          AND ${sentStateSql(modelCapacityRequests.state)})))
      OR (${modelCapacityRequests.logicalMemberKeys} IS NULL AND ${modelCapacityRequests.routeId} = 'crawl-tagline'
        AND ${inFlightStateSql(modelCapacityRequests.state)})`).limit(1);
  ```
  - 풀어 쓰면: 가지 ① `state IN (열린 3상태) AND logical_member_keys && ARRAY[k]`, 가지 ② `logical_work_key = L AND state IN (보낸 3상태)` — **받쳐 줄 색인 없음**, 가지 ③ `logical_member_keys IS NULL AND route_id = 'crawl-tagline' AND state = 'dispatched'`.
- 문제: OR을 BitmapOr로 풀려면 모든 가지에 색인 경로가 있어야 한다. `logical_work_key` 색인은 `logical_active_idx`(부분: reserved·dispatched) 하나뿐이고, `state IN (dispatched, indeterminate, settled)`는 그 술어를 함의하지 않는다. `crawl_tagline_phase_idx`·`search_verify_step_idx`는 `dispatch_binding->>'kind'` 조건이 술어에 있는데 fence 가지에는 그 조건이 없어 쓸 수 없다. 그래서 문장 전체가 51만 행 seq scan이 된다. 막힌 행이 없는 흔한 경우에는 끝까지 읽는다. 키워드 검수는 단계마다 새 요청이고 순위 넘김 재시도도 있어서, 한 제품에 이 스캔이 여러 번 돌고 그동안 전역 control이 묶인다.
- 실측 근거: `slow-queries-primary.txt:46` 이 모양 13번 · 평균 527ms(0.5초를 넘은 것만). 넘지 않은 실행은 기록되지 않으므로 보통 0.2~0.5초로 추정한다. 이 시간이 그대로 전역 잠금 보유 시간에 더해진다.
- 수정 방안(추천): `CREATE INDEX CONCURRENTLY model_capacity_requests_logical_key_idx ON model_capacity_requests (logical_work_key) WHERE logical_work_key IS NOT NULL`. 그러면 가지 2가 색인을 타고 문장 전체가 BitmapOr(live_work_idx 전체 + logical_key_idx + active_idx)로 바뀐다. 같은 색인이 ai1Fence·ai2Fence·textProfileFence·cliKeyFence의 `logical_work_key = …` 가지와 `chooseFirstReviewForCandidate`의 의도 질의(`agent-review-repository.ts:96-104`)도 받친다. 대안으로 fence를 EXISTS 셋으로 쪼개면 색인 없이도 짧아지지만, sent 가지는 여전히 색인이 필요하다.
- 검증: replica EXPLAIN으로 두 fence의 Seq Scan이 사라지는지 본다. `tests/integration/model-capacity-crawl-tagline-ledger.test.ts`, `search-verify-capacity-dispatch.test.ts`(fence 판정 같음). 지표: slow log의 해당 모양 0건, seq_scan 증가율.
- 배포 주의: CONCURRENTLY 색인 생성(긴 TX와 겹치면 오래 걸린다). 쓰기 비용은 비 HOT 갱신마다 색인 항목 하나가 더 늘지만, logical key가 있는 행만이다.
- 확신도: CONFIRMED(가지 2를 받칠 색인이 없음을 스키마·마이그레이션 전수에서 확인). 계획은 EXPLAIN으로 최종 확인한다.
- 규모: S

### CAP-07 AI1 예약 대기가 500ms마다 「전체 입장 TX」로 다시 묻고, 풀린 칸은 requestSlot 안에서만 넘겨진다
- 심각도: P1
- 분류: concurrency
- 위치: `lib/crawl/agent-review-model-capacity.ts:125, 156-167`. grant는 `lib/llm/capacity-repository.ts:843`(admitRequest 안 grantOne 호출 하나뿐)에서만 일어나고, 정산 15곳에는 grant가 없다.
  ```ts
  // lib/crawl/agent-review-model-capacity.ts:156-164
      while (ended === null) {
        if (!immediate) {
          if (Date.now() + AI1_RESERVATION_POLL_MS > until) { ended = limit; break; }
          await pause(AI1_RESERVATION_POLL_MS, signal);
          if (stopped()) { ended = 'stopped'; break; }
        }
        immediate = false;
        polls++;
        slot = await requestAi1ModelSlot(request, candidateId);
  ```
  - `requestAi1ModelSlot` 한 번 = control FOR UPDATE + 만료 청소 + fence + 게이트 + 장비마다 grantOne. `AI1_RESERVATION_POLL_MS` 는 500ms.
- 문제: 대기자는 자기 행이 reserved가 됐는지만 알면 되는데, 매번 control 배타 TX를 열어 전역 만료 청소, fence, 도우미·몫·상한 게이트, 모든 장비 grant(CAP-05 스캔 포함)를 다시 돈다.
  - 칸이 모자랄수록 대기자가 늘고 폴링도 늘어난다(대기자 하나당 초당 2 TX, 최대 30초).
  - 칸을 푸는 정산(CAP-01)은 그 폴링 뒤에 줄을 선다. 포화가 스스로를 키우는 구조다.
  - grant가 정산 시점이 아니라 「누군가의 다음 requestSlot」에서만 일어나므로, 폴링하지 않는 글 경로의 대기 행은 남의 폴링이 예약해 준다. 그 주인이 TTL(30초) 안에 돌아오지 않으면 예약이 놀다 만료된다(주석에 적힌 2026-10-29 실측: 미사용 만료 46~54%).
- 실측 근거: `slow-queries-primary.txt:3` control FOR UPDATE 19,640번 대기. 폴링 몫은 로그 `Ai1ReservationWaitEvent.polls`로 셀 수 있다(정황).
- 수정 방안(추천):
  ① 대기 루프는 잠금 없는 한 문장 `SELECT state FROM model_capacity_requests WHERE request_id=$1`로 상태만 본다. reserved이거나 N초(예: 3초)마다 한 번일 때만 requestAi1ModelSlot을 부른다.
  ② 정산 TX가 커밋된 뒤 그 장비에 대기 행이 있으면 장비 하나만 grant하는 짧은 TX를 연다. 구조 S2의 장비 잠금이 들어오면 정산 TX 안에서 해도 된다. `pg_notify('capacity_freed', group_id)`로 대기자를 깨운다.
  ③ grantOne은 요청 자신의 장비만 grant한다(남의 장비는 그 장비의 대기자·정산이 맡는다).
- 검증: `tests/agent-review-reservation-wait.test.ts`(granted 판정과 대기 상한이 같고, 폴링 중 requestAi1ModelSlot 호출 수가 줄어듦). 통합 시험 「정산 직후 대기 행이 다음 폴링 없이 reserved가 된다」. 지표: 로그 polls/waitedMs, `reservation_expired` 이벤트 수.
- 배포 주의: ②의 grant 위치를 바꾸면 처리량과 순서 공정성이 달라진다. scheduler·역할 워커를 같은 릴리스로 맞춘다. NOTIFY는 PgBouncer transaction 모드에서 LISTEN이 안 되므로 쓸 수 없고 폴링만 남는다.
- 확신도: CONFIRMED
- 규모: M

### CAP-08 requestSlot 한 번이 전역 잠금 아래에서 20~30번 왕복한다 — 만료 청소의 행마다 3문장, 비입장 경로의 전역 청소
- 심각도: P2
- 분류: latency
- 위치: `lib/llm/capacity-repository.ts:682-710`(requestSlot), `:777-855`(admitRequest), `:161-179`(expireRequests), `:864, 884, 943`(beginModelDispatch·cancelReservedModelSlot·markModelDispatchIndeterminate의 expireRequests)
  ```ts
  // :169-177 만료 행마다: 같은 조건을 다시 읽는 SELECT + UPDATE + event INSERT
  for (const row of due) {
    const [timing] = await tx.execute(sql`SELECT CASE WHEN … END AS expired FROM … WHERE request_id = …`);
    const kind = row.state === "reserved" ? "reservation_expired" : timing.expired ? "wait_expired" : "policy_changed";
    const [changed] = await tx.update(modelCapacityRequests).set({ state: "withdrawn", … }).returning();
    if (changed) await event(tx, changed, kind, row.state, "withdrawn");
  }
  ```
- 문제: 순서대로 fence 1 + control 1, original, expire(1+3×n), fence, existing, deviceConfigured, unknownHold, helperGates, routeQuota, modelQuota, memberCap, oldActive, duplicateWork, queue count, insert, event, grantOne(DISTINCT 1 + 장비마다 CTE·UPDATE·event), own SELECT. 모두 control 배타 아래에서 한 문장씩 네트워크를 왕복한다(워커는 M3·mini, DB는 Patroni 별도 호스트). 정책 판이 오르면 첫 requestSlot이 옛 세대 대기 행 전부(maxWaiting 최대 4096)를 행마다 3문장으로 거둬 한 TX에서 잠금을 오래 쥔다. 표시·취소처럼 남의 행을 볼 필요가 없는 경로도 전역 만료 청소를 돈다.
- 실측 근거: `slow-queries-primary.txt:3` 평균 1,031ms 대기의 바탕이 되는 보유 시간. 문장 수는 코드 근거다.
- 수정 방안(추천):
  ① expireRequests를 집합 연산 한 문장으로 바꾼다: `WITH due AS (SELECT … FOR UPDATE) UPDATE … RETURNING …, CASE … END AS kind` + `INSERT INTO model_capacity_events SELECT … FROM updated`. timing 재조회는 없앤다.
  ② beginModelDispatch·cancelReservedModelSlot·markModelDispatchIndeterminate에서 expireRequests를 뺀다(자기 행 expireReservation은 둔다).
  ③ deviceConfigured·unknownHold·helperGates·routeQuota·modelQuota를 한 CTE 문장으로 묶는다(이미 같은 CTE 조각을 쓴다).
  ④ 장기적으로는 서버 쪽 함수(구조 S4).
- 검증: 통합 시험 `model-capacity.test.ts`·`model-capacity-devices-admission.test.ts`·`capacity-route-quotas.test.ts`·`capacity-model-limits.test.ts`에서 판정이 같은지. 문장 수는 pg_stat_statements calls로 잰다.
- 배포 주의: 일반 배포. events 트리거 가드(0160)가 INSERT … SELECT에서도 행마다 돈다는 점만 확인한다.
- 확신도: CONFIRMED
- 규모: M

### CAP-09 2차 정체 탐색의 `stale_review_protecting_capacity` CTE가 `coalesce(state,'') NOT IN`으로 장부 전체를 seq scan한다
- 심각도: P2
- 분류: latency
- 위치: `lib/crawl/second-review-stale.ts:179-182`(쓰는 곳 `:190-194`, `:244-260`)
  ```ts
  function protectingCapacityRowsSql(): SQL {
    return sql`SELECT cap.state, cap.reserved_until, cap.logical_work_key, cap.work_key, cap.route_id
      FROM model_capacity_requests cap WHERE coalesce(cap.state, '') NOT IN ('waiting', 'withdrawn', 'settled')`;
  }
  ```
- 문제: `state`는 NOT NULL이고 CHECK로 6값만 허용된다. 그래서 이 조건은 `state IN ('reserved','dispatched','indeterminate')`와 같지만, coalesce와 NOT IN 때문에 어떤 부분 색인도 쓸 수 없다. MATERIALIZED라 호출마다 2.4GB 표를 끝까지 읽는다.
- 실측 근거: `slow-queries-primary.txt:5` 이 문장 1,417번 · 10,292초 · 평균 7,263ms · 최대 14,013ms, `:62` 1번. 7초 가운데 second_reviews 조인 몫은 2차 구역에서 따로 본다.
- 수정 방안(추천): `WHERE cap.state IN ('reserved','dispatched') OR cap.state = 'indeterminate'`로 바꾼다. 두 가지가 각각 `active_idx`·`unknown_hold_idx` 술어를 함의하므로 BitmapOr가 된다. 알 수 없는 상태를 보호하던 방어 가지(`protectingCapacityStateSql` 셋째 가지)는 CHECK가 막고 있어 의미가 같다.
- 검증: EXPLAIN에서 CTE가 Bitmap Heap Scan으로 바뀌는지. 기존 2차 정체 시험(`second-review-stale*` 관련)에서 결과가 같은지. slow log에서 이 모양의 평균을 본다.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED(조건식은 확실하다. 7초 전체가 줄어드는지는 second_reviews 쪽에 달렸다)
- 규모: S

### CAP-10 「동시에」 고르기 힌트가 일 하나마다 새 TX로 전 장비 상태(CAP-05 스캔 포함)를 다시 계산한다
- 심각도: P2
- 분류: inefficiency
- 위치: `lib/llm/ai-task-resolver.ts:442-443`(글 작업 runPool, 일·묶음마다), `lib/crawl/review-task-ranks.ts:266`(AI1 후보마다, TX 밖 힌트와 claim 안 재확인), `lib/llm/ai-task-workload-selector.ts:106`
  ```ts
  const [states, settings] = await Promise.all([readModelCapacityDeviceStates(tx), listModelCapacityDevices(tx)]);
  ```
- 문제: 힌트는 권한이 아니라고 주석이 밝히는데도, 부를 때마다 모든 장비의 deviceStateCte를 LATERAL로 계산한다(helper·active·busy·waiting·quota·model CTE). 그런데 후보 구성원은 1~4개 장비뿐이다. 장비 수(K) × 일 수만큼 busy 스캔(CAP-05)이 생기므로, 잠금은 없어도 seq scan 횟수의 큰 몫일 가능성이 있다. 같은 틱의 연속 선택도 매번 다시 읽는다.
- 실측 근거: `pg-stats-primary.txt:8` seq_scan 수치(정황. 대응은 pg_stat_statements로 확인한다)
- 수정 방안(추천):
  ① 후보 구성원의 장비만 계산한다. readModelCapacityDeviceStates에 장비 id 목록 인자를 더한다.
  ② 프로세스 안에서 1~2초 캐시를 둔다(힌트라서 낡아도 장부가 다시 판정한다).
  ③ CAP-05 색인·식 수정이 들어가면 한 번의 비용 자체가 작아진다.
- 검증: 단위 시험으로 readModelCapacityDeviceStates 호출 인자에 후보 장비만 들어가는지 본다. 지표: seq_scan 증가율, runPool 한 건 소요.
- 배포 주의: 일반 배포
- 확신도: CONFIRMED(호출 경로). 비중은 PLAUSIBLE.
- 규모: S

### CAP-11 (보강, #772) 장부 쓰기 문장 하나가 0.5초를 넘는 일이 하루 1,800번 넘게 일어난다 — 그것도 전역 잠금 아래에서
- 심각도: P2
- 분류: latency
- 위치: 정산 UPDATE `capacity-repository.ts:1153-1155` 외 정산 15곳, dispatch UPDATE `:1116-1119` 외, INSERT `:834-840`, 트리거 가드 `drizzle/0160_ledger_check_rules.sql`(`<표>_zz_check_guard`)
- 문제: 큰 CHECK를 규칙 표와 트리거로 옮긴 비용(#772 보류)이 알려져 있다. 새로 확인된 점은 그 문장들이 모두 control 배타 잠금 아래에서 실행된다는 것이다. 문장 하나 0.5초는 곧 전역 잠금 0.5초다. 거기에 event INSERT(같은 가드)가 전이마다 하나씩 더 붙는다.
- 실측 근거: `slow-queries-primary.txt:16` 정산 UPDATE 1,489번 · 824초 · 평균 554ms. `:22`·`:43` dispatch UPDATE 273번 · 145초. `:45` 13번. `:32` INSERT 49번.
- 수정 방안(추천): #772의 대안 시안(`claude/ledger-check-trigger`)을 다시 연다. 가지를 `dispatch_binding->>'kind'`로 먼저 골라 그 kind의 술어만 평가하면, OR 전체 평가가 kind 하나 평가로 줄어든다. CAP-01·02로 이 문장들이 배타 잠금 밖으로 나가면 시급도는 내려간다.
- 검증: `tests/integration/ledger-check-rules.test.ts`(규칙 동치). 문장 지연은 pg_stat_statements mean_exec_time으로 본다.
- 배포 주의: 마이그레이션(규칙 함수 교체)이다. 메모의 「CHECK 재구성 migrate는 DRAIN 뒤에」 절차를 따른다.
- 확신도: CONFIRMED(실측). 원인 몫이 트리거인지 색인 유지인지는 PLAUSIBLE.
- 규모: M

### CAP-12 상태 IN 목록(열린 4상태·미정산 2상태)은 부분 색인을 못 타 seq scan이 된다 — 그중 둘은 control FOR UPDATE 아래에서
- 심각도: P2
- 분류: inefficiency
- 위치:
  - control 잠금 아래: `lib/llm/capacity-repository.ts:3062-3063`(removeCapacityRoutes)
  - 관리 읽기: `lib/llm/capacity-retire-repository.ts:81`
  - 관측: `lib/operations/model-picker-availability-read.ts:34`, `lib/operations/pipeline-control-status.ts:249`, `lib/operations/pipeline-observation-repository.ts:206-211`
  - DR: `lib/operations/dr/reclaim.ts:109`
  ```sql
  SELECT count(*)::int AS n FROM model_capacity_requests
    WHERE state IN ('waiting','reserved','dispatched','indeterminate') AND (route_id, provider, model) IN (…)
  ```
- 문제: 부분 색인 술어(`live_work_idx` 3상태, `active_idx` 2상태, `unknown_hold_idx` 1상태)는 더 넓은 IN 목록이 함의하지 못한다. 그래서 planner가 BitmapOr로 쪼개지 못하고 seq scan으로 간다. removeCapacityRoutes는 control FOR UPDATE를 쥔 채 이 스캔을 돈다(관리자 저장 한 번에 수백 ms 동안 전역 정지). 관측 쪽은 잠금은 없지만 주기적으로 표를 훑는다.
- 실측 근거: 코드 근거만(관리·관측이라 slow log에서 따로 보이지 않는다)
- 수정 방안(추천): CAP-05의 열린 상태 부분 색인 `(group_id, route_id) WHERE state IN ('waiting','reserved','dispatched','indeterminate')` 하나로 4상태 질의와 그 부분집합(`state='dispatched'` 등) 질의를 모두 받친다. 미정산 2상태 질의도 그 술어를 함의하므로 이 색인을 쓴다. 색인을 더하지 않으려면 `state IN (live) OR state='indeterminate'`로 고쳐 쓴다.
- 검증: replica EXPLAIN. `tests/pipeline-control-status.test.ts`, `tests/integration/capacity-retire.test.ts`.
- 배포 주의: CONCURRENTLY 색인(CAP-05와 한 마이그레이션)
- 확신도: CONFIRMED(부분 색인 함의 규칙). 계획은 EXPLAIN으로 확인한다.
- 규모: S

### CAP-13 전역 회수 `releaseEvidencedDispatches`가 미정산 행 전부를 control FOR UPDATE를 쥔 한 TX 안에서 돈다(자동 회수를 선언하면 매분)
- 심각도: P2
- 분류: concurrency
- 위치: `lib/operations/dr/reclaim.ts:102-112`(행마다 `releaseModelDispatchWithEvidence` → `capacity-repository.ts:2792` control FOR UPDATE, 그다음 근거 읽기 `readProcessGroupEvents`), 호출은 `lib/operations/ops-runner/runner.ts:23-24` ← `lib/jobs/model-capacity-reclaim.ts:43-46`
  ```ts
  const ids = … `SELECT request_id::text FROM model_capacity_requests WHERE ${unsettledDispatchStateSql('state')} …`;
  for (const requestId of ids) rows.push(row(requestId, await releaseModelDispatchWithEvidence(tx, requestId, async candidate => {
    const events = await readProcessGroupEvents(tx, candidate.owner) …
  ```
- 문제: 첫 행에서 잡은 control 배타가 마지막 행까지 유지된다. 대상은 dispatched와 indeterminate 전부다(선언한 budget으로만 거른다). 사람 검토 대기 indeterminate는 쌓이므로 행 수 × (행 잠금 + 시계 + 사실 + 근거 읽기) 동안 전역 입장·정산이 멈춘다. 운영 메모(「미확정 회수는 한 건씩 짧은 TX로」, 2026-11-02)가 수동 절차를 이미 바꿨지만, 자동 회수 코드 경로는 아직 전역 함수를 쓴다. 오늘은 `MODEL_CAPACITY_AUTO_RECLAIM`이 비어 있어 돌지 않는다(docs 기준). 선언하는 순간 매분 이 TX가 돈다.
- 실측 근거: 코드 근거만(자동 회수 미선언)
- 수정 방안(추천): 자동 모드는 후보 목록을 잠금 없이 읽은 뒤, 행마다 별도 짧은 TX(fence SHARE → control KEY SHARE(CAP-01) → 행 FOR UPDATE)로 판정·회수한다. 한 회차 상한(예: 20건)과 job budget 확인을 둔다(markAutomaticOwnerGone과 같은 커서 방식).
- 검증: 통합 시험 「indeterminate 200행이 있을 때 자동 회수 한 회차 동안 requestSlot이 lock_timeout 없이 끝난다」. 기존 `dr-followups.test.ts`·`model-capacity-owner-gone.test.ts`.
- 배포 주의: 자동 회수 선언 전에 반영해야 한다. 일반 배포.
- 확신도: CONFIRMED(코드). 운영 영향은 선언 여부에 달려 있다.
- 규모: S

### CAP-14 HOT 갱신이 구조적으로 0이다 — 비부분 `job_readback_idx`, 기본 autovacuum 비율로 dead 93k
- 심각도: P3
- 분류: inefficiency
- 위치: `lib/db/operations-schema.ts:196-206`(색인 술어와 식에 `state`·`updated_at`·`dispatch_binding`·`settled_at`), `drizzle/0098_oracle_activation_gaps.sql:18`(`job_readback_idx` 비부분), `pg-stats-primary.txt:89`(autovacuum_vacuum_scale_factor 0.2)
- 문제: 모든 전이가 `state`(부분 색인 술어)와 `updated_at`(withdrawn_at_idx·unknown_hold_idx 식)을 바꾼다. PostgreSQL은 술어·식에 쓰인 열이 바뀌면 HOT을 막으므로 fillfactor로는 고칠 수 없다. 요청 하나가 비 HOT 갱신을 3~4번 겪고, 그때마다 술어가 맞는 색인에 새 항목이 들어간다. 그중 `job_readback_idx`(route_id, owner, `dispatch_binding->'job'->>'requestedVersion'`)는 술어가 없어 모든 행·모든 갱신에 항목이 생긴다. 쓰는 곳은 Oracle canary·preflight 둘뿐이다(`lib/runtime/oracle-canary.ts:96`, `oracle-preflight.ts:194`, idx_scan 1,782/5.6일). 51만 행 표에서 기본 비율 0.2면 dead 10만이 쌓여야 청소가 돈다. dead 93k(18%)가 seq scan(CAP-05·06) 비용을 그만큼 키운다.
- 실측 근거: `pg-stats-primary.txt:8` n_tup_upd 652,542 · n_tup_hot_upd 0 · n_dead_tup 93,297. `:49` job_readback_idx 19MB · idx_scan 1,782.
- 수정 방안(추천): `job_readback_idx`를 `WHERE dispatch_binding ? 'job'` 부분 색인으로 다시 만든다(CONCURRENTLY로 만들고 바꾼 뒤 옛 것을 지운다. 질의 쪽에 같은 조건을 더한다). `ALTER TABLE model_capacity_requests SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)`. HOT 0은 받아들이고 문서에 남긴다.
- 검증: `pg_stat_user_tables.n_dead_tup` 추이, 색인 크기, Oracle preflight 시험(`tests/oracle-db-profile.test.ts` 등)
- 배포 주의: 마이그레이션(CONCURRENTLY 색인, reloptions). Oracle 감시자 계정의 열 단위 SELECT 권한(`CAPACITY_REQUEST_READ`)과 질의 글자를 맞춘다.
- 확신도: CONFIRMED
- 규모: S

### CAP-15 control 잠금을 누가 쥐는지 기록하는 수단이 정산 55P03 첫 재시도 한 번뿐이다
- 심각도: P3
- 분류: non-standard
- 위치: `lib/llm/capacity-lock-retry.ts:37`(readControlLockHolders는 정산 55P03 첫 회만), `pg-stats-primary.txt:86-103`(log_lock_waits 미설정, deadlock_timeout 1s)
- 문제: 하루 3.5만 번(0.5초 이상)의 대기가 있는데, 보유자가 requestSlot인지 dispatch TX인지 SHARE 도메인 TX인지는 운영 근거로 가를 수 없다. 이 점검의 CAP-01~04 몫도 추정으로 남는다. 교착 13건(5.6일)도 어느 표 사이인지 모른다.
- 실측 근거: `pg-stats-primary.txt:110` deadlocks 13, `slow-queries-primary.txt:74` deadlock detected 1
- 수정 방안(추천): `log_lock_waits = on`(deadlock_timeout 1초를 넘는 대기마다 보유 pid와 문장이 기록된다)과 `pg_stat_statements` 활성화를 Patroni 설정으로 켠다. 장부 TX에 `SET LOCAL application_name`처럼 경로 표식을 붙이면(예: `nomorevibe:reviewer:cap-dispatch-ai1`) 대기·보유 기록에서 경로를 바로 읽을 수 있다.
- 검증: 바꾼 뒤 하루치 로그에서 「process … still waiting for ShareLock/ExclusiveLock on tuple (…) of relation model_capacity_control」의 보유 경로 분포를 본다.
- 배포 주의: Patroni 설정 변경(pg_stat_statements는 shared_preload_libraries이므로 재시작). log_lock_waits는 reload로 된다. 로그 양이 늘어난다.
- 확신도: CONFIRMED
- 규모: S

## 구조 변경 제안 (리팩토링으로 효율화)

### S1. control 잠금 모드 4단 분리(가장 먼저, 위험 낮음)
- 지금 구조: 장부 쓰기 전부가 `FOR UPDATE`, 정책 읽기 도메인 TX는 `FOR SHARE`. 모두 한 행 위에서 서로 배타이고, SHARE가 UPDATE를 굶긴다.
- 바꿀 구조:
  - 정책·모드·장비·DR 쓰기: `FOR UPDATE`. DR seal에도 명시적으로 추가한다.
  - grant를 만드는 입장(requestSlot): `FOR NO KEY UPDATE`
  - dispatch 12곳, 정산 15곳, 취소·표시 9곳, 정책만 읽는 도메인 TX: `FOR KEY SHARE`
  - 같은 세대 체인을 읽는 곳: 작업 키 advisory lock(CAP-04 (b))
- 얻는 것: 정산 대기(6,546번 · 6,894초/일)와 SHARE 대기(8,955번 · 9,036초/일)는 정책 쓰기 순간을 빼면 거의 0이 된다. FOR UPDATE 대기(19,640번)에서 dispatch 몫이 빠지고 requestSlot끼리만 남는다. 대기 합계 약 3.6만 초/일 가운데 절반 이상이 줄 것으로 추정한다(보유자 분포는 CAP-15로 확인).
- 옮기는 순서: ① DR seal과 모든 control 쓰기에 `FOR UPDATE` 선행을 넣고 시험한다 → ② 정산·취소를 KEY SHARE로 → ③ dispatch를 KEY SHARE로 → ④ requestSlot을 NO KEY UPDATE로 → ⑤ 도메인 SHARE 호출처를 (a)/(b)로 분류해 바꾼다. 단계마다 한 릴리스씩, contention 시험을 넓힌다.
- 위험: 정책 쓰기가 일반 UPDATE만 하는 경로가 하나라도 남으면 KEY SHARE 보유 dispatch와 겹친다(옛 세대 dispatch가 seal 뒤에 커밋될 수 있다). 문법 검사 시험으로 「control UPDATE 앞 FOR UPDATE」를 강제한다.

### S2. 입장 직렬화를 장비 단위로 쪼개기
- 지금 구조: 모든 장비·모든 경로의 입장이 한 control 행에 줄을 서고, grantOne이 매번 모든 장비를 돈다.
- 바꿀 구조:
  - requestSlot은 control `KEY SHARE`(정책 고정)를 잡고, 그 요청의 장비 잠금 `pg_advisory_xact_lock(hashtextextended('cap:dev:'||group_id,0))`과 작업 키 잠금(logical key, 멤버 키들은 정렬해서) `pg_advisory_xact_lock(hashtextextended('cap:key:'||key,0))`을 잡는다.
  - grant는 그 장비만 한다.
  - `maxWaiting`(전역 대기 수)은 장비별 한도로 바꾸거나 느슨한 상한으로 둔다.
  - 1차 「동시에」 칸 수(memberCap)는 구성원이 한 장비에 묶이므로 장비 잠금으로 원자성이 유지된다.
- 얻는 것: 서로 다른 장비(M3·M1·supa·gpu3090·API 계약 등 대략 5~8대)의 입장이 병렬로 돈다. 남은 대기는 같은 장비끼리만 생긴다. 장비마다 CTE를 한 번만 계산한다(지금은 대기 행이 있는 장비 수만큼).
- 옮기는 순서: ① 모든 fence 질의를 작업 키 잠금과 짝지어 놓는다(작업 키가 장비를 건너는 순위 넘김 F1이 핵심 시험) → ② 장비 잠금을 더하되 control은 아직 NO KEY UPDATE로 둔다(이중 잠금, 동작 같음) → ③ control을 KEY SHARE로 내린다 → ④ grantOne을 자기 장비로 좁힌다.
- 위험: 같은 일이 다른 장비의 순위로 동시에 줄 서는 경합이다. 지금은 control이 막고, 바꾼 뒤에는 작업 키 잠금이 막아야 한다. 해시 충돌은 과잉 직렬화일 뿐 정확성 문제는 아니다. 같은 TX에서 키를 여러 개 잡을 때 정렬하지 않으면 교착이 생긴다.

### S3. 폴링이 아니라 사건으로 grant
- 지금 구조: 칸이 풀리면 다음 누군가의 requestSlot만 grant하고, AI1은 500ms마다 배타 TX로 폴링한다.
- 바꿀 구조: 정산·취소가 커밋한 뒤 그 장비의 grant 한 번을 돌리고(S2 장비 잠금), 대기자는 잠금 없는 `SELECT state`로만 확인한다.
- 얻는 것: 포화 때의 입장 TX 수가 「대기자 × 2/초」에서 「정산 1회당 1회」로 준다. 예약이 주인 없이 TTL 동안 노는 시간도 준다.
- 옮기는 순서: ① 대기 루프를 잠금 없는 읽기로 바꾼다(CAP-07 ①, 단독으로 효과) → ② 정산 뒤 장비 grant를 넣는다 → ③ 글 경로 coordinator도 같은 readback을 쓴다.
- 위험: 정산 경로가 grant 실패를 삼키면 대기 행이 남는다. 다음 폴링(3초)이 안전망이다.

### S4. 입장 판정을 서버 쪽 한 문장·함수로
- 지금 구조: requestSlot이 TS에서 20~30문장을 보내고, 그동안 전역 잠금을 쥔다.
- 바꿀 구조: `nmv_capacity_request_slot(identity jsonb, logical text, members text[], gen …)`(plpgsql)가 만료·fence·게이트·insert·grant를 서버 안에서 한 번에 한다. 판정 SQL 조각(deviceStateCte 등)은 이미 SQL이라 그대로 옮길 수 있다.
- 얻는 것: 잠금 보유 시간에서 네트워크 왕복(문장당 0.3~1ms × 25)이 빠지고 실행 시간만 남는다. S1·S2와 곱해진다.
- 옮기는 순서: 읽기 전용 판정부(게이트 묶음)부터 함수로 옮긴 뒤 시험 동치를 맞추고, 그다음 쓰기부를 옮긴다.
- 위험: 판정 로직이 TS와 SQL 두 곳에 갈라질 수 있다. 「SQL만 단일 출처」로 정리하고 TS는 결과 해석만 하게 한다. 마이그레이션 배포 절차(DRAIN 뒤 migrate)를 따라야 한다.

### S5. `capacity-repository.ts`(3,392줄) 분할과 12 kind 공통화
- 지금 구조: 한 파일에 control, 입장, fence 10종, kind 12종의 `lock*/finish*/reconcile*/find*/cancel*`이 거의 같은 모양으로 반복된다(mutex·행 잠금·owned·rowMatches·terminal 비교). 잠금 모드를 하나 바꾸려면 30곳 이상을 고쳐야 하고, 빠뜨리기 쉽다.
- 바꿀 구조:
  - `capacity/admission.ts`(control·expire·grant·게이트)
  - `capacity/fences.ts`(kind별 fence SQL과 필요한 색인 선언)
  - `capacity/dispatch-kinds/*.ts`: kind 설명자 `{ bindingSchema, bindingHash, dispatchSchema, terminalSchema, rowMatches, fence, identity }`
  - `capacity/dispatch.ts`(공통 `lockDispatch(kind)`/`finishDispatch(kind)`/`reconcileTerminal(kind)`)
  - `capacity/readback.ts`(잠금 없는 읽기·이어 읽기)
  - `capacity/operator.ts`(정책·회수·DR hook)
- 얻는 것: 잠금 정책(S1)을 한 곳에서 바꾸고 시험한다. 중복 약 1,500줄을 없앤다. 새 kind를 더하는 비용이 크게 준다. 색인이 필요한 fence가 설명자에 드러나 CAP-06 같은 빈틈이 리뷰에서 보인다.
- 옮기는 순서: ① reconcile 15곳을 공통 함수로 바꾼다(동작이 가장 균일하다) → ② lock/finish → ③ fence → ④ 파일 분할. kind마다 기존 통합 시험을 그대로 통과해야 한다.
- 위험: 각 kind의 미묘한 차이(crawl-tagline·search-verify의 부모 행 잠금, websearch의 settled 재사용 등)를 설명자가 놓칠 수 있다. 차이는 설명자의 훅으로 남긴다.

### S6. 열린 행 색인 세트와 (장기) hot/cold 분리
- 지금 구조: 14일치 이력 51만 행(2.4GB) 위에서 열린 행 수십~수백 개를 찾는다. 열린 행 질의가 부분 색인 술어와 조금만 어긋나도 이력 전체를 훑는다(CAP-05·06·09·12).
- 바꿀 구조: 열린 4상태 부분 색인 `(group_id, route_id)`와 `logical_work_key` 부분 색인 둘을 더한다. 장기적으로는 끝난 행을 일정 시간 뒤 `model_capacity_requests_history`로 옮겨 hot 표를 작게 유지한다. events FK·sent 상태 fence·이어 읽기가 history도 보게 해야 한다.
- 얻는 것: 장부 seq scan이 사실상 0이 되고(하루 약 31만 번 × 평균 32만 행), 남은 스캔도 hot 표 크기로 줄어든다.
- 옮기는 순서: 색인 둘(CAP-05·06) → 질의 글자 정리(CAP-09·12) → EXPLAIN으로 남은 seq scan을 찾는다 → 필요할 때만 hot/cold.
- 위험: hot/cold는 FK(`model_capacity_events_request_fk`), 0187 보관 트리거, Oracle 감시자 권한, sent 상태 fence의 의미를 모두 건드린다. 색인 단계에서 충분하면 하지 않는다.

## 확인했지만 문제 아님

- `readModelCapacityCallerControl`·`readModelCapacityControlObservation`·`findOwnPending*`·`readModelDispatchStates`는 잠금 없이 한 문장으로 읽는다(2026-10-31 정리, `capacity-repository.ts:103-138, 285-294, 332-344`). `tests/integration/model-capacity-control-contention.test.ts`가 지킨다.
- ai1Fence·ai2Fence·textProfileFence·reasonTranslation/productTranslation/productTaglineKo/introCheck/cliKey fence는 모든 가지가 `live_work_idx`(술어 = live 3상태) 전체 또는 `active_idx`로 받쳐진다. BitmapOr가 가능하다(`capacity-repository.ts:651-661, 1177-1187, 1471-1478, 1581-1589, 2610-2629`).
- websearchQueryFence의 settled 가지는 `websearch_query_snapshot_idx`(kind·sent 술어 함의, 둘째 열 `member->cache`)를 탈 수 있다(`:2399-2410`).
- `searchVerifyGeneration`·`readCrawlTaglineContinuation`·`readTextTargetPoolAffinities`의 binding 질의는 kind 부분 색인(`search_verify_step_idx`·`crawl_tagline_phase_idx`)과 `live_work_idx`로 받쳐진다(`:2279-2281, 2090-2092, 3165-3189`).
- 잠금 순서 역전과 교착: 모든 장부 경로가 fence SHARE → control → 요청 행 → 도메인 순서다. control 없이 요청 행만 잠그는 `markProcessExitIndeterminate`(`:1026-1053`)와 `authorizeCliEngineExecution`(`lib/operations/cli-engine-authority.ts:96-99`)은 그 뒤에 control을 잡지 않아 순환이 없다. 같은 TX에서 SHARE를 UPDATE로 올리는 경로도 찾지 못했다.
- 회수와 주인의 동시 쓰기: owner-gone(dispatched→indeterminate)과 주인 정산은 같은 요청 행 잠금으로 줄 서고, 정산은 indeterminate도 받는다. 회수(withdrawn) 뒤 늦은 정산이 거절되는 것은 의도된 규칙이다(`:972-976` 주석).
- 정산 55P03 재시도는 안전하다. ROLLBACK이 확실하고, 행을 FOR UPDATE로 다시 읽어 already_settled로 판정한다(`capacity-lock-retry.ts:9-12`).
- 시계: TTL·대기 기한·미확정 유지 시간은 모두 DB `clock_timestamp()`로 비교한다. 호스트 `Date.now()`는 자기 대기 상한(AI1 until)과 owner 정리 기한(`capacity-overdue.ts`, 유예 120초)에만 쓴다.
- `capacity-overdue` 추적 Map은 2만 개 상한이고, 30초마다 100건을 읽는다. 하루 약 3.6만 요청이면 충분하다.
- 장부 보관 정리(`db-retention.ts` pruneLedgerBatch)는 SKIP LOCKED로 행만 잠그고 control을 잡지 않는다.
- `releaseProcessExitedHops`(매분)는 `http_origin_control`을 잠그고, lock 1초·문장 5초·TX 15초 상한이 있다. 장부 control과 무관하다.
- 잠금 TX 안의 `await import(...)`(`capacity-repository.ts:559, 576`)는 프로세스마다 첫 호출 한 번만 모듈을 읽는다. 경미하다.

## 범위 밖·못 본 것

- EXPLAIN과 pg_stat_statements를 쓰지 못했다(DB 접속 금지). seq scan을 쿼리별로 나눈 몫(CAP-05·06·10·12)은 추정이다. replica에서 `EXPLAIN (ANALYZE, BUFFERS)`로 확정해야 한다.
- slow log의 `statement timeout` 10,383건과 monitor 875건이 어느 문장인지는 근거 파일만으로 가를 수 없다.
- 교착 13건(5.6일)의 상대 표는 모른다. 장부 control 쪽 역전은 찾지 못했고, 도메인 표(후보·시도·잡) 사이일 가능성이 높다 → CAP-15 로그로 확인한다.
- `stale_review_protecting_capacity` 문장의 second_reviews·crawl_candidates 조인 몫(2차 구역), `reason_eligible`(번역 구역), `crawl_candidates` 느린 질의(수집 구역)는 다른 구역이다.
- kind 12종의 lock/finish/reconcile은 대표 4종(AI1·reason-translate·crawl-tagline·search-verify)을 끝까지 읽었다. 나머지는 grep으로 같은 모양임을 확인했다.
- 관리자 저장 경로(`capacity-devices-repository`·`capacity-helpers-repository`·`admin-*`)의 control FOR UPDATE는 드문 운영자 동작이라 보유 시간을 재지 않았다.
- 글 작업 coordinator(handover·재시도 주기)의 requestSlot 호출 빈도는 확인하지 못했다. AI1 대기 루프만 확인했다.
- Oracle 소비자(agent-scan·한국어 탐색)의 장부 사용은 보지 않았다.
