# 04. 잡 실행기·역할 lease·DB 연결 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


읽은 코드: `저장소 루트` (origin/main `34b5fe32`). 줄 번호는 모두 그 트리에서 확인했다.
근거 파일: `evidence/slow-queries-primary.txt`(이하 slow), `pg-stats-primary.txt`(이하 pg), `pg-stats-replica.txt`, `jobs.txt`.

## 요약 (심각도별 건수, 가장 중요한 5개 한 줄씩)

- P0 0 · P1 3 · P2 8 · P3 2 (총 13건)
- 가장 중요한 5개
  1. **RUN-01 (P1)** 역할 워커 부모가 15초마다 관리자용 진행 판정 `readWorkerProgress` 를 통째로 돈다: 처리량 집계(주석상 1초), 관측 표 전체 읽기, uptime 장부 readback(느린 문장 7,210회/일·4,121초)을 역할 3~5개가 각자 계산한다.
  2. **RUN-02 (P1)** 감시(monitor, DB 풀 1)가 30초마다 같은 판정을 텍스트 진행까지 넣어 돈다. 사유 번역 집계가 감시 계정에서 3,604회/일·16,580초(느린 문장 중 2위)이고, 문장 시간 초과도 875회/일 난다. 실패하면 판정이 통째로 `unknown` 이 된다.
  3. **RUN-03 (P1)** 역할 lease 갱신이 lock/문장 시간 초과(55P03·57014·40P01)를 만나면 lease 를 잃은 것으로 보고 자식을 강제로 멈춘다. DB lease 는 아직 최대 45초 유효하다. 결과로 진행 중인 모델 호출이 끊기고 미확정 칸이 600초 동안 잡힌다. 갱신이 기다리는 `role_leases FOR UPDATE` 는 최대 4.4~4.7초로, lock 한도 5초에 닿아 있다.
  4. **RUN-04 (P2)** scheduler 3벌이 10초마다 잡 58개를 한 TX 안에서 `INSERT … ON CONFLICT DO NOTHING` + `UPDATE` 로 하나씩 돈다(116문장 직렬). 도래한 잡 행의 잠금을 루프가 끝날 때까지 쥔다. 잡 행 경합(약 1초 대기, 합계 약 980초/일)의 주원인이고, 이 대기가 `role_leases` 대기로 이어진다.
  5. **RUN-05 (P2)** 예비(standby) 후보 5개가 5초마다 선출 TX 에서 `role_leases … FOR UPDATE` 를 건다. lease 가 남의 것이라 읽기만 하면 되는 경우에도 그렇다. 그 결과 일하는 역할의 잡 claim(FOR SHARE)과 갱신을 막는다(1,328회/일 0.5초 넘음, 평균 919ms, 최대 4.7초).
- 지시문 질문에 대한 답 — **second-review·console-alerts 성공 기록 조건**: 러너는 ① 완료 틱 중 `degraded` 가 없을 때, ② 미룸 틱이면 `processed ≥ 1` 일 때만 `last_success_at` 을 옮긴다(`lib/jobs/runner.ts:251-256`, `:302`).
  - second-review: AI2 가 items 모드로 넘어간 10-25 뒤로 매 틱 `deferred: stage_blocked`(처리 0)를 돌려준다. 그래서 성공 시각이 고정되어 있다. 설계된 결과이고 job-health 도 이 경우를 경보에서 뺀다(RUN-06).
  - console-alerts: 13:49 뒤로 매 틱 `degraded: console_tasks_unknown` 을 돌려준다. 알림 묶음(멈춤·평소와 다름)의 입력 중 셀 수 없는 것이 있다는 뜻이다(RUN-07).

## 발견

### RUN-01 역할 워커 부모가 15초마다 전체 진행 판정(readWorkerProgress)을 각자 계산한다
- 심각도: P1
- 분류: inefficiency / latency
- 위치: `scripts/role-worker.ts:445-466`(15초 타이머), `:651-665`(checkProgress), `lib/operations/worker-progress-query.ts:455-482`, `lib/operations/uptime-split-repository.ts:70-77`, `lib/operations/throughput.ts:23-34`
  ```ts
  // role-worker.ts:651-655 — primary 역할 부모가 15초마다(445행) 부른다
  checkProgress: async role => {
    if ((role === 'maintenance' || role === 'text') && await hasActiveRoleJob(role)) return false;
    const report = await readWorkerProgress(undefined, { includeText: false });
  // worker-progress-query.ts:470-472 — 2차 병렬 묶음: 처리량 집계 + 관측 표 전체 + 근거 진행 + uptime 장부
    pipelineThroughput(settings, now), db.select().from(operationsObservations).where(and(WITHOUT_JOB_DEFERRALS, WITHOUT_JOB_TALLIES, …
    readUptimeSplitStage(db),
  ```
- 문제:
  - crawler·reviewer·publisher 의 primary 부모는 lease 를 쥔 동안 15초마다 이 판정을 돈다. text·maintenance 도 돌던 잡이 없으면 같다. 이 판정은 관리자 화면·배포 관문용 읽기이고, 한 번에 7개+6개 쿼리를 병렬로 낸다.
  - `now` 를 넘겨 부르므로 처리량 집계의 동시 호출 합치기(`throughput.ts:24`)를 타지 않는다. 주석에 따르면 이 집계는 혼자 돌아도 1초다(`throughput.ts:25`).
  - split 모드가 claims 이면 `readUptimeSplitStage` 가 uptime_claims×products×product_health 전체 조인 readback 을 돈다. 주석도 "역할 워커가 15초마다 부르므로"라고 적어 두었다(`uptime-split-repository.ts:71`).
  - 관측 표(operations_observations, 약 2.5천 행·5MB)도 매번 전체를 읽는다.
  - 결과: 역할 3~5개 × 분당 4회 = 분당 12~20번, 같은 값을 따로 계산한다.
  - 판정 자체도 역할마다 자기 칸(lane·stage)만 본다(`selectUnexplainedStall`). 전체 판정의 대부분은 버려진다.
  - 부모 프로세스의 풀은 역할 풀 전체(reviewer 11)여서, 13개 병렬 쿼리가 15초마다 PgBouncer 에 순간 부하를 준다.
- 실측 근거:
  - slow: `WITH c AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT jsonb_build_object(… uptime_split_control …` 7,210회·4,121초·평균 572ms, 23시간 내내 관측(`nomorevibe` 계정. 감시 계정은 71회뿐 → 역할 워커 쪽이 대부분).
  - pg: `operations_observations` seq_scan 150,934회, seq_tup_read 377,160,793(5.6일). 하루 약 2.7만 회, 분당 약 19회이고, 한 번에 평균 약 2,500행으로 표 전체를 읽는다. 위 호출 빈도와 맞는다.
  - 처리량 집계 비용(1초 × 하루 1.7만~2.9만 회 추정)은 문장 하나하나가 0.5초 미만일 수 있어 slow 에는 보이지 않는다. **추정치**다.
- 수정 방안(추천 순서):
  1. 즉시: 역할 워커 판정을 자기 역할 전용 가벼운 읽기로 바꾼다. `readWorkerProgress({ role, includeText:false, includeUptime: role==='maintenance', includeThroughput: 그 역할 stage 가 있을 때만 })`. 관측은 `service:<role>%` 키만 읽는다.
  2. 구조: 구조 제안 S1. 판정을 한 곳(감시 또는 scheduler 리더)이 15~30초마다 계산해 `progress:report` 관측 한 행(또는 Valkey)에 쓴다. 역할 워커는 그 행만 읽는다(measuredAt 이 2분 넘게 지났으면 지금처럼 직접 계산).
  3. 보조: 간격을 15초에서 30초로 늘린다. 정체 판정은 이미 표본 2개를 요구하므로 탐지가 30초 늦어질 뿐이다.
- 검증: 배포 전후 24시간의 slow 에서 uptime readback 모양의 횟수와 합계, `pg_stat_user_tables` 의 operations_observations seq_scan 증가율(분당 약 19회 → 2회 이하)을 비교한다. `tests/role-worker*.test.ts` 정체 판정 회귀.
- 배포 주의: 일반 배포(역할 워커 재시작). S1 은 생산자를 먼저, 소비자를 뒤에 배포한다.
- 확신도: CONFIRMED(호출 경로·주기). 하루 DB 시간 총량은 PLAUSIBLE(처리량 집계 문장별 시간 실측 필요)
- 규모: M

### RUN-02 감시(monitor, 풀 1)가 30초마다 사유 번역 집계를 포함한 판정을 돌린다 — DB 16,580초/일, 시간 초과 875회/일
- 심각도: P1
- 분류: latency / concurrency
- 위치: `scripts/watch-failover-readiness.ts:206-233`(30초 루프), `lib/operations/failover-monitor.ts:68-74`, `lib/operations/worker-progress-query.ts:456,477`, `lib/operations/text-stage-progress.ts:151-162`, `lib/db/pool.ts:19`(monitor: 1), `:62`(풀 대기 5초)
  ```ts
  // failover-monitor.ts:69 — 네 읽기를 동시에, readWorkerProgress 는 includeText 기본 true
  const [readiness, progress, capacity, mode] = await Promise.allSettled([readFailoverReadiness(), readWorkerProgress(), readModelCapacityUnknowns(), …
  // text-stage-progress.ts:154-162 — 사유 그룹은 10초 제한의 TX 를 쥔다(연결 하나를 그동안 점유)
  const read = (group) => db.transaction(async tx => { … SET LOCAL statement_timeout = '10s' … }, { accessMode: 'read only' });
  const rows = [...await read('reason'), ...await read('other')];
  ```
- 문제:
  - 감시는 30초마다(실행 시간 포함) `readMonitorStatus` 를 돈다. 그 안의 `readWorkerProgress()` 는 텍스트 진행까지 포함하고, 사유 그룹은 모든 모델 사유를 해시로 묶는 `reason_eligible` 집계다(평균 4.6초).
  - 감시 프로세스의 DB 풀은 1개(`ROLE_POOL_MAX.monitor = 1`, 롤아웃 문서 "pool 1")다. 그런데 네 읽기와 그 안의 13개 넘는 쿼리를 한꺼번에 낸다.
  - 사유 TX 가 유일한 연결을 4~9초 쥐는 동안, 줄 선 쿼리는 풀 대기 5초(`DbPoolWaitTimeoutError`)를 넘기기 쉽다.
  - 하위 읽기 하나라도 실패하면 `readWorkerProgress` 의 `Promise.all` 이 통째로 거절된다. 그러면 progress=null → `overall='unknown'`(`failover-monitor.ts:42`)이 되고, 두 번 이어지면 Kuma 에 down 을 보낸다(`watch-failover-readiness.ts:51-54`).
  - 이 값은 5분 단위로 천천히 변하는 적체 지표인데 30초마다 정확하게 다시 센다.
- 실측 근거: slow
  - `WITH reason_eligible AS MATERIALIZED (…` **감시 계정 3,604회·16,580초·평균 4,601ms·최대 9,080ms**. 느린 문장 전체 합계 122,852초의 13.5%로 2위다. 같은 모양이 `nomorevibe` 계정에서도 647회·3,071초 나온다(웹 콘솔·console-alerts).
  - 오류 집계에 `nomorevibe_monitor_20261022 | canceling statement due to statement timeout` 875회. 풀 대기 초과는 클라이언트 쪽 오류라 이 숫자에 들지 않는다.
- 수정 방안:
  1. 감시는 텍스트 진행을 5분에 한 번만 다시 센다. 프로세스 안에 측정 시각과 함께 담아 두고 그 사이에는 지난 값을 쓴다. 더 나은 방식은 text 워커(또는 S1 생산자)가 `progress:text` 관측으로 남기고 감시가 그 행을 읽는 것이다.
  2. 감시의 네 읽기는 풀 1에 맞게 차례로 돌린다(또는 계정 연결 한도 2에 맞춰 풀 2로 하되 무거운 읽기는 직렬). 무거운 사유 TX 는 맨 뒤에 둔다.
  3. 하위 읽기 실패를 판정 전체 실패로 만들지 않는다. 그 stage 만 unknown 으로 둔다(Promise.allSettled + 부분 보고).
  4. `reason_eligible` 쿼리 자체의 비용은 텍스트/번역 구역 담당이다(COMMON "새 문제").
- 검증: 감시 로그 `{"overall":"unknown"}` 비율, 감시 계정 slow 횟수(3,604 → 300 이하), statement timeout(875 → 0 근처), Kuma down 푸시 수. `tests/failover-monitor*.test.ts` 에 부분 실패 케이스를 더한다.
- 배포 주의: 감시 앱만 재배포(autoDeploy=false, Kuma 푸시 연속성 확인).
- 확신도: CONFIRMED(호출 경로·풀 1·주기). unknown 이 나오는 비율은 PLAUSIBLE(감시 로그로 확인)
- 규모: S~M

### RUN-03 역할 lease 갱신의 lock/문장 시간 초과를 lease 상실로 보고 자식을 강제 중단한다
- 심각도: P1
- 분류: logic / concurrency
- 위치: `scripts/role-worker.ts:431-442`, 갱신 TX `lib/jobs/role-leader.ts:96-111`, 한도 `lib/jobs/batch-repository.ts:16-26`, 강제 중단 `scripts/worker-supervisor.ts:287-290`
  ```ts
  }).catch(error => {
    if (ended || lost || renewalsStopped()) return;
    if (replicaFailure(error) === 'down') {          // 끊긴 연결만 재시도
      failed('role.renew_retry', …); return;
    }
    leaseCause = 'renew_failed';
    failed('role.renew_unknown', …); lost = true;
    forceStop.abort('role_lease_lost'); abortActive('role_lease_lost');
  ```
- 문제:
  - 갱신 TX 는 `boundRoleTransaction` 으로 lock 5초·statement 10초를 건 뒤 `role_leases … FOR UPDATE`(role-leader.ts:103)를 기다린다.
  - lock 대기가 5초를 넘으면 55P03 이 나는데, `replicaFailure` 는 연결 끊김 코드만 'down' 으로 본다. 그래서 곧장 `lost=true` → `forceStop` 이 된다. 감독은 자식에 SIGTERM 을 보내 진행 중인 HTTP 를 끊고(cancel 모드), 45초 뒤 SIGKILL 한다.
  - 그러나 DB 의 lease 는 마지막 성공 갱신 + 45초까지 유효하다. 같은 boot 는 다음 선출에서 같은 epoch 를 그대로 다시 받는다(role-leader.ts:63-65). 따라서 이 중단은 순전히 손해다.
  - 손해 내용: 그 역할의 모든 줄(reviewer 15줄)에서 진행 중이던 모델 호출이 취소·미확정이 되고, 미확정은 관리자 설정 시간(기본 600초)만큼 칸을 차지한다(11-10 결정).
  - batch-repository.ts:18-19 주석의 의도("lock 을 기다리는 문장이 모두 실패로 끝나 다음 갱신·선출이 새로 판단한다")와 role-worker 의 실제 동작이 다르다.
  - 안전은 이미 `watchdog`(leaseDeadline = 성공 갱신 + 45초, role-worker.ts:409-412)이 보장한다. 재시도를 넓혀도 DB 만료 뒤에 자식이 살아 있는 일은 없다.
- 실측 근거: slow `select "role" from "role_leases" where role=$n for update` 710회·평균 929ms·**최대 4,408ms**, 선출 쪽 같은 행 FOR UPDATE 최대 4,719ms. 둘 다 lock 한도 5초 바로 아래다. 오류 집계 `canceling statement due to lock timeout` 17회/일(어느 문장인지는 근거에 없다).
- 수정 방안: 갱신 catch 에서 lock·직렬화 계열(`55P03`·`57014`·`40P01`·`40001`)을 'down' 과 같이 `role.renew_retry` 로 처리한다. leaseDeadline 이 남아 있는 한 다음 10초 주기에 다시 갱신한다. 동시에 RUN-04·05 로 대기 원인을 줄인다.
- 검증: `tests/role-worker-resilience.test.ts` 의 "retries a renewal dropped by a terminated connection" 표에 55P03·57014 케이스를 추가한다(같은 child·epoch 유지, 13회 갱신). 운영 로그에서 `role.renew_unknown` 의 code 분포와 `worker-exit:*` 관측의 `leaseCause=renew_failed` 를 7일 동안 센다.
- 배포 주의: 역할 워커 5개 재배포(부모 프로세스 변경). 넘겨주기·격리 규칙은 그대로다.
- 확신도: CONFIRMED(코드 경로). 운영에서 실제로 몇 번 났는지는 PLAUSIBLE(`role.renew_unknown` 로그로 확인)
- 규모: S

### RUN-04 scheduler 정기 요청 TX — 잡 58개 × 2문장 직렬 루프, 3벌이 같은 일, 도래 행 잠금을 루프 끝까지 쥔다
- 심각도: P2
- 분류: concurrency / inefficiency
- 위치: `lib/jobs/control.ts:44-77`, 루프 `:54-72`, 러너 claim `lib/jobs/runner.ts:162`, 주기 `scripts/scheduler.ts:16`(기본 10초)
  ```ts
  return db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return 0;
    const batch = await lockJobBatch(tx);
    for (const job of scheduledJobs(batch)) {               // 58개
      await tx.insert(jobs).values({ name: job.name }).onConflictDoNothing();
      …
      const [due] = await tx.update(jobs).set({ requestedVersion: …, nextScheduledAt: … })
        .where(and(eq(jobs.name, job.name), /* next_scheduled_at <= now() */ …)).returning(…);
  ```
- 문제:
  - scheduler 3벌(M3 2·mini 1)이 각자 10초마다 이 TX 를 연다. 문장은 116개가 넘고 모두 왕복이다.
  - 도래한 잡의 `UPDATE` 는 그 행 잠금을 TX 끝까지(나머지 수십 왕복 동안) 쥔다.
  - 같은 순간 다른 scheduler 의 `INSERT … ON CONFLICT DO NOTHING` 은 그 행을 고친 TX 가 끝날 때까지 기다린다. PostgreSQL 은 충돌 행의 수정자가 진행 중이면 기다린다.
  - 그 사이 같은 행을 건드리는 것들도 모두 기다린다: 워커 줄의 `markWorkerSeen` upsert(5초마다), 돌고 있는 잡의 15초 heartbeat UPDATE, `requestJob`.
  - 러너 claim TX 도 `requestedOnly` 인데 매번 같은 INSERT 를 먼저 낸다(runner.ts:162). 이 claim TX 는 이미 `job_batch_control`·`role_leases` 를 FOR SHARE 로 쥔 상태라, 잡 행 대기가 역할 행 대기(RUN-03·05)로 번진다.
  - 3벌이 같은 일을 하므로 실제 요청을 만드는 것은 한 벌이고, 나머지 두 벌은 잠금만 기다리다 아무것도 안 한다. 중복 발화 자체는 없다(아래 "문제 아님").
- 실측 근거: slow(잡 표 문장, 0.5초 넘은 것)
  - `insert into "jobs" (…) values ($n, default…) on conflict do nothing` 337회·330초·평균 980ms
  - `markWorkerSeen` upsert 193회+82회(평균 941·1,027ms)
  - heartbeat `update "jobs" set "worker_seen_at" = now(), "locked_at" = now()` 160회·평균 846ms
  - `requestJob` upsert 118회
  - `select "name" from "jobs" … for share` 95회
  - scheduler `update … "next_scheduled_at"` 14회
  - 합계 약 980초/일. 평균이 모두 약 1초에 모인다(한 TX 가 약 1초 쥐는 모양).
- 수정 방안(추천):
  1. 잡 행 만들기는 scheduler 부팅 때 한 번만 한다(`INSERT … SELECT unnest($names) ON CONFLICT DO NOTHING`, 틱 TX 밖).
  2. 틱 TX 첫 문장 뒤에 `pg_try_advisory_xact_lock(<고정 키>)` 를 둔다. 못 얻으면 이번 틱을 건너뛴다(0건). 3벌의 대기 복제는 유지하면서 일은 한 벌만 한다. AGENTS.md 의 "scheduler M3 2복제본·mini 1복제본 보존"과 충돌하지 않는다.
  3. 58개 루프를 `UPDATE jobs j SET … FROM (VALUES (name, interval_ms, overridden), …) v WHERE j.name = v.name AND (도래 조건) RETURNING j.name` 한 문장으로 바꾼다. TX 는 fence → batch → UPDATE → ack 4문장이 된다.
  4. `runJob` 은 `requestedOnly` 일 때 INSERT 를 생략한다(직접 호출 CLI 만 유지).
- 검증: `tests/integration/job-interval-override.test.ts`(덮어쓰기 유무 SQL 의미 보존), 3 scheduler 동시 시험(같은 잡이 한 번만 요청되는지). 운영에서 위 잡 표 문장들의 slow 횟수(약 1,000회 → 수십 회)와 `role_leases` FOR UPDATE 대기를 비교한다.
- 배포 주의: scheduler 먼저(새 잡 → scheduler 먼저 관례와 같음), 그다음 역할 워커(러너 INSERT 생략). 마이그레이션 없음.
- 확신도: CONFIRMED(잠금 메커니즘·문장 수). "role_leases 대기로 번진다"는 PLAUSIBLE(`pg_locks` 표본으로 확인)
- 규모: M

### RUN-05 예비 후보가 5초마다 role_leases FOR UPDATE 를 건다 — 남의 lease 를 읽기만 하면 되는데도
- 심각도: P2
- 분류: concurrency
- 위치: `lib/jobs/role-leader.ts:45-67`, 예비 대기 `scripts/role-worker.ts:363-372`, claim 쪽 `lib/jobs/role-leader.ts:205-209`
  ```ts
  await tx.insert(roleLeases).values({ role: candidate.role }).onConflictDoNothing();
  const [current] = await tx.select().from(roleLeases)
    .where(eq(roleLeases.role, candidate.role)).for('update');
  …
  if (current.leaseUntil > now) {
    if (current.ownerInstanceId === candidate.instanceId && …) return { ...candidate, epoch: current.epoch };
    return null;                                    // 남의 lease — 읽기만 하고 끝
  }
  ```
- 문제:
  - mini 의 다섯 역할 예비는 선출에 실패하면 5초마다 이 TX 를 다시 연다. 하루 약 8.6만 번이다. 대부분은 "살아 있는 남의 lease"라 아무것도 쓰지 않고 끝나는데도 행 잠금 FOR UPDATE 를 잡는다.
  - 일하는 역할은 잡 claim 마다 같은 행에 FOR SHARE 를 건다(reviewer 15줄 + crawler·text… 5초 간격). 그래서 예비의 FOR UPDATE 는 진행 중인 claim TX 들이 끝나길 기다린다. 기다리는 동안에는 뒤에 오는 claim 들이 다시 그 뒤에 줄 선다(튜플 잠금 대기열).
  - 결과적으로 예비의 폴링이 일하는 역할의 claim 과 갱신에 약 1초씩 끼어든다.
- 실측 근거: slow `select "role", "owner_instance_id", … "updated_at" from "role_leases" where role=$n for update` 1,328회·1,220초·평균 919ms·최대 4,719ms. 선출 TX 의 모양이다(legacy 운영은 product-site-evidence-refresh runs=0 으로 확인).
- 수정 방안:
  - 선출 TX 앞에 잠그지 않는 확인 한 문장을 둔다: `SELECT owner_*, lease_until > now() AS live, quarantine_until > now() FROM role_leases WHERE role=$1`.
  - live 이고 주인이 내가 아니면, 또는 primary 이면서 격리 중이면 TX 없이 null 을 돌려준다. 만료됐거나 내 것일 때만 지금의 잠금 경로로 간다.
  - 경주가 생겨도 다음 5초 폴링이 처리한다. 예비에게는 원래 20초 유예가 있다.
- 검증: `tests/role-worker*.test.ts`·`tests/integration/role-leader*.test.ts` 의 선출·넘겨주기 시나리오 회귀. 운영에서 위 문장의 slow 횟수(1,328 → 수 회)를 본다.
- 배포 주의: 역할 워커(M3·mini) 재배포. 선출 규칙 변경 없음.
- 확신도: CONFIRMED
- 규모: S

### RUN-06 stage_blocked 미룸이 요청을 남겨 second-review 정비 틱이 poll 마다 반복된다(성공 시각 고정은 설계상 결과)
- 심각도: P2
- 분류: inefficiency / logic
- 위치: `lib/crawl/jobs/second-review.ts:49-65,71-74`, `lib/jobs/runner.ts:242-269`(미룸 → processedVersion 미갱신), `scripts/worker.ts:271-276,295`, `lib/jobs/catalog.ts:73-79`, `lib/operations/job-health.ts:28,34`
  ```ts
  // second-review.ts — 정비(올리기·닫기·정합·재개·재시도)를 먼저 다 하고 나서야 단계를 본다
  const enqueued = await enqueueSecondReviews(settings, undefined, lease);
  const closed = await closeSettledSecondReviews(undefined, lease);
  const reconciled = await reconcileStaleSecondReviews(undefined, lease, …);   // 7초짜리 hint 쿼리
  …
  if (!await canStartLegacySecondReview(lease)) return { done: false, deferred: "stage_blocked" };  // processed 없음
  ```
- 문제:
  - **성공 시각**: AI2 가 items 모드인 동안 모든 틱이 처리 0의 `stage_blocked` 로 끝난다. 러너는 이때 `last_success_at` 을 옮기지 않는다(runner.ts:251-256). 그래서 jobs.txt 의 `second-review` 성공 시각이 10-25 23:41 에 멈춰 있다. job-health 는 `stage_blocked` 를 일부러 미룬 것으로 보아 경보하지 않으므로(job-health.ts:34) 이것 자체는 결함이 아니다.
  - **주기**: 미룸 경로는 lease 만 놓고 `processed_version` 을 올리지 않는다. 그래서 요청이 계속 대기 상태로 남고, 줄은 다음 poll(5초)에 같은 잡을 다시 돈다. 카탈로그 주석(catalog.ts:75)도 이것을 적어 두었다.
  - 즉 1분 일정의 잡이 "5초 + 틱 시간"마다 정비 전체를 되풀이한다. 그 안에는 `staleSecondReviewHintSql` 이 있다: 2.4GB `model_capacity_requests` 의 비종결 행 전체를 MATERIALIZED 로 훑고, `coalesce(state,'') NOT IN (…)` 조건이라 색인을 쓸 수 없다.
  - worker.ts:271-276 은 1초 재실행 특례를 "풀을 눌렀다"는 까닭으로 지웠다. 하지만 5초 poll 도 영구 상태(items 모드)에서는 같은 성질의 낭비다.
  - 같은 패턴: `crawl-agent-review` 도 AI1 이 items 모드가 되면 정비 셋을 먼저 돌고 `stage_blocked` 를 돌려준다(agent-review.ts:65-74).
- 실측 근거:
  - slow `WITH stale_review_protecting_capacity AS MATERIALIZED (…) SELECT DISTINCT s.candidate_id …` 1,417회·**10,292초**·평균 7,263ms·최대 14,013ms. 느린 문장 4위다.
  - pg `model_capacity_requests` seq_tup_read 5,654억(1위).
  - jobs.txt `second-review` runs 208,583 은 `split-tiebreak`(1분, 10-31부터) 28,926 의 7배다.
  - 실제 틱 간격은 `defer:second-review` 관측의 분당 `stage_blocked` 수로 확인해야 한다. 그래서 주기 배수는 PLAUSIBLE 로 둔다.
- 수정 방안:
  1. 러너: 영구 성격의 미룸(`stage_blocked`)은 요청을 인정한다(`processed_version = lease.requestedVersion`, 성공 시각은 그대로). 그러면 다음 실행은 scheduler 의 60초 요청을 기다린다. 일시적 미룸(model_capacity·http_origin_permit·source_buffer)은 지금처럼 남긴다. 구조 제안 S4 참고.
  2. 또는 second-review 에서 단계 확인을 정비 앞에 한 번 하고, items 모드면 정비를 커서의 `maintainedAt` 기준 60초에 한 번만 한다.
  3. hint 쿼리 자체(색인 가능한 조건으로 바꾸기)는 심사 구역에 넘긴다.
- 검증: `tests/integration/review-draining.test.ts`("unapproved jobs cannot opt in")·러너 미룸 시험에 stage_blocked 인정 케이스를 추가한다. 운영에서 `defer:second-review` 분당 횟수, hint 쿼리 slow 합계(10,292초 → 1/4 이하)를 본다.
- 배포 주의: 역할 워커(reviewer) 재배포. 러너 변경은 모든 역할에 들어가므로 `source_buffer`·`batch_blocked` 의 기존 의미를 유지하는지 확인한다.
- 확신도: CONFIRMED(미룸 → 재실행 메커니즘, 성공 조건). 틱 빈도와 절감량은 PLAUSIBLE
- 규모: S

### RUN-07 console-alerts 가 10시간째 성공하지 못한다 — 성공 조건과 원인 후보 둘
- 심각도: P2
- 분류: logic / concurrency
- 위치: `lib/jobs/console-alerts.ts:27-37`, `lib/operations/console-home-read.ts:113-137`(15개 병렬 읽기), `lib/operations/conveyor.ts:47-59`(그 안의 10개 병렬), `lib/operations/console-tasks.ts:425-432,455-541`(notify 묶음의 unknown 조건), `lib/operations/shared-cache.ts:92-94`, `lib/cache/shared.ts:5,128-141`, `lib/db/pool.ts:19`(maintenance 3)
  ```ts
  const home = await readConsoleHome(false);
  const board = buildConsoleTasks(home.inputs);
  …
  const unknown = board.groups.filter(group => group.notify && group.unknown.length).flatMap(group => group.unknown);
  if (unknown.length) return { done: true, cursor: null, degraded: { code: "console_tasks_unknown", detail: `셀 수 없음 · ${…}` } };
  ```
- 문제:
  - **성공 조건**: 알림 묶음(`stop`·`odd`) 중 하나라도 「셀 수 없음」이 있으면 degraded 로 끝나고 `last_success_at` 이 멈춘다. `last_error` 는 비어 있다(던지지 않음 — jobs.txt 와 일치).
  - unknown 은 다음 경우에 생긴다: 읽기 입력이 null(conveyor·jobs·admission·takedown·koreanDiscovery·changeWatch), 또는 대기가 있는 단계의 `doneHour`·`done5m` 이 둘 다 null(console-tasks.ts:431-432).
  - 원인 후보 A(동시성): maintenance 워커의 DB 풀은 3이다. `readConsoleHome` 은 읽기 15개를 한꺼번에 내고, 그중 `readConveyor` 가 다시 10개를 낸다. 각 읽기에는 4초 기한·3초 문장 제한(console-home-read.ts:60-61)이 있고 풀 대기는 5초다.
    - 웹(풀 8 + Valkey 공유 캐시)을 위해 만든 읽기 묶음을 풀 3 프로세스가 직접 센다. 그러면 풀 대기·기한 초과로 일부가 `quiet()` → null → unknown 이 되기 쉽다.
    - shared.ts 주석대로 워커에 Valkey 가 없으면 웹이 채운 캐시도 못 쓴다.
    - 13:49Z(22:49 KST)는 운영자가 관리자 화면을 닫을 만한 시각이다. 웹이 캐시를 채우지 않게 된 뒤부터 실패했을 수 있다.
  - 원인 후보 B(결정적): 어떤 대기 단계에 처리 수 칸이 없어 매 틱 같은 unknown 이 나는 경우다.
  - 부수 문제: `sharedLoader` 의 지난 값 반환 경로(shared-cache.ts:92-94)가 뒤에서 `start(key, load)` 를 돌린다. 이 재계산은 틱·lease·종료 신호와 묶이지 않아 틱이 끝난 뒤에도 같은 풀 3을 쓴다.
- 실측 근거: jobs.txt `console-alerts | 2488 | last_run 23:54:41 | last_success 13:49:44 | last_error None`. 어느 규칙이 unknown 인지는 `operations_observations` `job:console-alerts` 의 `degraded.detail`(첫 4개 이름)·`streak`·`since` 에 있다. 이 근거는 아직 받지 않았다.
- 수정 방안:
  1. 먼저 `job:console-alerts.degraded.detail` 을 읽어 A/B 를 가른다.
  2. A 이면: 알림 잡은 무거운 홈 읽기를 직접 세지 않는다. 웹이 남긴 공유 캐시를 읽도록 maintenance 에 `VALKEY_URL` 을 준다. 또는 읽기를 동시 2개로 묶고(p-limit), 전체 틱 예산 안에서 실패한 읽기만 다음 틱에 다시 센다.
  3. B 이면: 처리 수가 구조적으로 없는 단계는 unknown 이 아니라 "판정 대상 아님"으로 둔다(console-tasks.ts:431).
  4. 워커 쪽 `sharedLoader` 는 지난 값 반환 대신 기다리게 하거나(staleMs 0), 뒤 재계산을 틱 signal 에 묶는다.
- 검증: `tests/console-alerts*.test.ts` 에 풀 3·입력 null 케이스. 운영 `job:console-alerts` 관측의 streak 이 끊기는지 본다.
- 배포 주의: maintenance 재배포(env 를 바꾸면 메모리 "Dokploy env 변경은 plan 전에 재배포까지" 절차를 따른다).
- 확신도: PLAUSIBLE(성공 조건은 CONFIRMED. 원인 A/B 는 관측 detail 로 확인 필요)
- 규모: S

### RUN-08 복제본 풀 대기 초과를 '복제본 다운'으로 보고 30초 동안 공개 읽기 전부를 주 DB 로 돌린다
- 심각도: P2
- 분류: concurrency / latency
- 위치: `lib/db/replica.ts:31-35`(DOWN_CODES 에 `DB_POOL_WAIT_TIMEOUT`), `:97-114`, `:51`(30초), `lib/db/pool.ts:62`(풀 대기 5초), `lib/db/index.ts:38-48`(복제본 풀 기본 4)
  ```ts
  const DOWN_CODES = new Set([ …, "DB_POOL_WAIT_TIMEOUT", "53300", … ]);
  …
  } catch (error) {
    const kind = replicaFailure(error);
    if (kind === "down") downUntil = now() + REPLICA_COOLDOWN_MS;   // 30초간 모든 read() 가 주 DB 로
    return load();
  ```
- 문제:
  - 접속이 몰려 웹 한 대의 복제본 풀(기본 4)이 5초 넘게 차면, 그 요청은 5초를 기다린 뒤 주 DB 로 다시 읽는다. 동시에 그 웹의 모든 공개 읽기가 30초 동안 주 DB 풀(8, 관리자·쓰기와 공유, PgBouncer 경유)로 간다.
  - 복제본은 멀쩡하고 바쁠 뿐인데, 부하가 가장 큰 순간에 부하를 더 작은 주 DB 풀로 옮긴다. 30초 뒤 돌아와 다시 차면 또 넘긴다(톱니).
  - 5,000명 동시 접속 목표(메모리 capacity-2026-10-06)에서 첫 병목이 될 수 있다.
- 실측 근거: 코드 근거만. 복제본 연결은 관측상 `nomorevibe:web-replica idle 46` 으로, 선언(웹 2 × 4 = 8)과 다르다(RUN-10).
- 수정 방안: `DB_POOL_WAIT_TIMEOUT` 은 'busy' 라는 별도 종류로 둔다. 그 요청만 주 DB 로 넘기고 `downUntil` 은 건드리지 않는다. 복제본 풀 대기는 짧게(예: `READ_DB_POOL_WAIT_MS` 500~1,000ms) 따로 둔다. 풀 크기는 측정 뒤 정한다. 연결 오류(08xxx·ECONN*·57P0x)만 30초 쿨다운을 유지한다.
- 검증: `tests/db-replica*.test.ts` 에 풀 대기 초과 → downUntil 불변 케이스. 부하 시험(capacity 문서의 웹 동시 접속 측정)에서 p95 와 주 DB 쿼리 수를 비교한다.
- 배포 주의: 웹 재배포.
- 확신도: CONFIRMED(코드 경로)
- 규모: S

### RUN-09 pgbouncer 모드에서 앱이 시간 제한을 걸지 않고 DB 역할 설정에 기대지만, M3/mini 는 그것을 확인하지 않는다
- 심각도: P2
- 분류: non-standard / concurrency
- 위치: `lib/db/pool.ts:72-88`, `lib/jobs/batch-repository.ts:16-19`, 비교 `lib/runtime/oracle-preflight.ts:31,124-126`
  ```ts
  const connection = config.poolerMode === "pgbouncer"
    ? { application_name: applicationName }                 // statement/lock/idle-in-tx 없음
    : { application_name, statement_timeout: config.statementMs, lock_timeout: config.lockMs,
        idle_in_transaction_session_timeout: Math.max(config.statementMs, 60_000) };
  ```
- 문제:
  - 운영 워커·웹은 PgBouncer(transaction 모드)라 시작 파라미터로 시간 제한을 넘길 수 없다. 그래서 `nomorevibe` DB 역할의 `ALTER ROLE … SET` 에 기댄다. 런북에 적힌 값은 "초기값 120s/5s/120s"뿐이다.
  - 서버 기본값은 셋 다 0이다(pg 설정). 역할 설정이 빠졌거나 새 계정이 생기면 무기한 대기, 그리고 `idle in transaction` 으로 잠금을 쥔 TX 를 막을 장치가 없다.
  - batch-repository.ts:17-19 주석이 실제로 "선출이 끝없이 기다렸다"를 겪었다고 적고 있다.
  - Oracle 은 preflight 에서 `current_setting(...)` 을 확인하지만 M3/mini 의 역할 워커·웹은 확인하지 않는다.
  - PgBouncer 안에서 줄 서는 시간은 statement_timeout 에 들지 않는다. 클라이언트 풀 대기(5초)도 쿼리가 소켓에 쓰인 뒤에는 적용되지 않는다. 잡 heartbeat(RUN-12)처럼 기한 없는 await 는 PgBouncer 의 `query_wait_timeout`(기본 120초)에만 묶인다.
- 실측 근거: pg `statement_timeout 0`·`lock_timeout 0`·`idle_in_transaction_session_timeout 0`(서버 수준), 스냅숏에 `nomorevibe:reviewer | idle in transaction | 1`, 오류 `statement timeout` 10,383회(역할 설정이든 SET LOCAL 이든 무언가 걸고 있다는 뜻이지만 계정별 값은 근거에 없다).
- 수정 방안: pgbouncer 모드 프로세스(역할 워커 부모·자식, 웹, scheduler)는 부팅 때 `SELECT current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('idle_in_transaction_session_timeout')` 를 읽는다. 0 이거나 기대값보다 크면 `service:<role>` 관측에 경고를 싣고, 설정으로 선택하면 시작을 거부한다(oracle-preflight 와 같은 모양). 역할 설정 SQL 은 저장소에 코드로 둔다(배포 도구의 drift 검사 대상).
- 검증: 새 단위 시험(0 이면 거부·경고). 운영 각 앱의 부팅 로그에 실제 값이 찍히는지 본다.
- 배포 주의: 경고 모드로 먼저 배포하고, 값을 확인한 뒤 거부 모드로 바꾼다.
- 확신도: CONFIRMED(코드). 운영 역할 설정 상태는 PLAUSIBLE(`pg_db_role_setting` 확인 필요)
- 규모: S

### RUN-10 DB 연결 예산이 코드로 합산·검증되지 않는다 — 부모 프로세스도 역할 풀 전체, 복제본 연결 46 vs 선언 8
- 심각도: P2
- 분류: concurrency / structure
- 위치: `lib/db/pool.ts:19,61`, `lib/db/host-budget.ts:56-59,61-91`(HOST_DB_BUDGET — M3/mini 비활성, CODEX_HANDOFF), `scripts/role-worker.ts:602-700`(부모가 WORKER_ROLE 그대로 풀을 연다), `lib/db/index.ts:38-48`
- 문제:
  - HOST_DB_BUDGET 이 꺼져 있어 M3/mini 의 실제 최대 연결 수를 묶는 장치가 없다.
  - 역할 컨테이너 하나 = 부모(role-worker) + 자식(worker)이고, 둘 다 `DB_POOL_MAX`(reviewer 11)로 따로 풀을 연다. 부모는 갱신·관측만 하면 되는데, 15초마다 13개 병렬 진행 판정(RUN-01)을 내므로 실제로 최대치까지 연다.
  - 선언 기준 PgBouncer 클라이언트 수(M3 primary 역할 22+12+8+6+6 = 54, mini 예비 부모 약 27, 웹 16, scheduler 3벌 × (부모 2 + 자식 2) = 12, AI2 소비자 약 14, agent-scan 약 7, connect·monitor 2) ≈ **130**이다. PgBouncer `max_client_conn` 기본값 100 을 넘을 수 있다(운영 설정은 저장소에 없다).
  - 서버 연결은 PgBouncer 풀이 묶지만, 직접 연결(복제본·Oracle·감시·migration)은 150 에서 바로 빠진다.
  - 11-15 장애 때 실제로 150 에 닿았다(db-disk-outage 문서).
  - 복제본에는 `nomorevibe:web-replica` 가 46개 있다. 선언(웹 2대 × `READ_DB_POOL_MAX` 기본 4 = 8)과 맞지 않는다. 운영 env 가 더 크거나, 프로세스가 더 많거나, 웹 복제본이 더 있다는 뜻이다. postgres.js `idle_timeout` 이 없어 한 번 연 연결은 30분 수명까지 쉬면서 남는다.
- 실측 근거: pg 연결 표(주 DB 약 31개: PgBouncer 서버 연결 + Oracle 직접 5 + 감시 1), pg-replica `nomorevibe:web-replica | idle | 46`, `max_connections 150`.
- 수정 방안:
  - 연결 예산 표를 코드(`host-budget.ts` 의 processBudgets 를 기본 선언으로)와 배포 검사에 둔다. 앱별 `DB_POOL_MAX` 합 + 직접 연결 ≤ PgBouncer `max_client_conn`, 그리고 PgBouncer 서버 풀 + 직접 연결 + 예약 ≤ 150 을 배포 plan 이 검사한다.
  - 역할 부모는 `ROLE_PARENT_DB_POOL_MAX=2` 처럼 작게 한다(RUN-01 을 고친 뒤).
  - 웹·복제본 풀에 `idle_timeout`(예: 60초)을 준다. 운영 `READ_DB_POOL_MAX`·웹 복제본 수를 확인해 46 의 출처를 밝힌다.
- 검증: `tests/db-pool-options.test.ts` 에 부모 풀·idle_timeout. 운영 `pg_stat_activity` 앱별 연결 수를 배포 전후로 비교하고 PgBouncer `SHOW POOLS`/`SHOW CONFIG` 를 확인한다.
- 배포 주의: env 변경 → Dokploy env 재배포 절차(plan 전에 재배포).
- 확신도: PLAUSIBLE(PgBouncer 설정·운영 env 가 저장소에 없음)
- 규모: M

### RUN-11 줄(lane)마다 5초 poll — 32줄이 seen upsert + pending 2문장을 따로 낸다
- 심각도: P2
- 분류: inefficiency / structure
- 위치: `scripts/worker.ts:230-245`(runLane), `:177-181`(runConsumerLane), `lib/jobs/control.ts:79-83`(markWorkerSeen), `:87-96`(pendingJobNames), `lib/jobs/batch-repository.ts:77-83`
  ```ts
  const snapshot = await readSettings();
  await dependencies.seen(names);                      // jobs upsert(worker_seen_at)
  const pending = new Set(await dependencies.pending()); // job_batch_control select + jobs select
  ```
- 문제:
  - 줄 수는 reviewer 15, text 8, crawler 7, publisher 1, maintenance 1 로 모두 32다(catalog.lanesForRole).
  - 각 줄이 5초마다 자기 잡 행에 `worker_seen_at` upsert 를 하고, batch 행과 jobs 를 따로 읽는다. 약 19 TX/s, 하루 약 166만 TX 로 DB 전체 commit(약 2,240만/일)의 약 7%다.
  - upsert 는 잡 행 잠금을 잡으므로 scheduler TX·heartbeat 와 부딪힌다(RUN-04 의 193+82회).
  - 같은 프로세스의 줄들이 같은 표를 같은 간격으로 각자 읽는다.
- 실측 근거: pg `xact_commit 125,268,523`(5.6일). slow 의 `markWorkerSeen` upsert 275회 0.5초 넘음. 폴링 TX 수는 코드 기준 산술이다.
- 수정 방안: 구조 제안 S3. 프로세스마다 poll 하나가 5초마다 `seen`(모든 줄의 이름, 30초에 한 번) + `pending`(한 문장)을 하고, 줄들은 그 결과를 구독한다. `worker_seen_at` 은 30초 간격이면 충분하다(진행 판정의 신선도 창 확인).
- 검증: `tests/worker*.test.ts`(줄 차례·consumer refill) 회귀. 운영 `xact_commit` 증가율, 잡 표 slow 횟수.
- 배포 주의: 역할 워커 재배포. heartbeat 판독기(`parseRuntimeLanes`) 호환성을 확인한다.
- 확신도: CONFIRMED(호출 수 산술)
- 규모: M

### RUN-12 잡 heartbeat 한 번 실패 = 틱 전체 상실, 기한 없는 await
- 심각도: P3
- 분류: logic / async
- 위치: `lib/jobs/runner.ts:199-208`, `:240-241`, `:355-358`
  ```ts
  renewing = (async () => {
    const [row] = await db.update(jobs).set({ lockedAt: sql`now()`, workerSeenAt: sql`now()` }).where(owned)…;
    if (!row) lost = true;
  })().catch(() => { lost = true; }).finally(() => { renewing = null; });
  …
  const stopHeartbeat = async () => { clearInterval(timer); await renewing; };
  ```
- 문제:
  - 한 번의 일시 오류(lock_timeout 5초, 풀 대기 초과, 연결 재생성)만으로 `lost=true` 가 남은 틱 내내 유지된다. 그러면 `hasBudget()` 이 false 가 되어 일을 멈추고, 끝에서 `JobLeaseLostError` → 실패 경로가 된다. 이때 lease 가 실제로는 아직 내 것이라 `owned` 조건이 맞는다. 그래서 `last_error='job_lease_lost'` 와 30초 유예가 기록되고 이번 틱의 확인 응답(ACK)은 버려진다.
  - 실제 소유권 상실 기준은 lockedAt + 90초(STALE_LOCK_MS)인데 그보다 훨씬 이르게 포기한다. 역할 워커는 같은 문제를 이미 고쳤다(끊긴 연결 재시도, RUN-03).
  - `stopHeartbeat` 는 걸린 heartbeat 를 기한 없이 기다린다. pgbouncer 모드에서 PgBouncer 대기열에 걸리면 틱 종료가 그만큼 늦어진다.
- 실측 근거: 코드 근거만. 현재 jobs.txt 의 모든 잡이 `last_error None` 이라 지금 자주 나지는 않는다.
- 수정 방안: heartbeat 오류는 다음 주기에 재시도한다. `lost` 는 (a) UPDATE 가 0행일 때(토큰이 넘어감), 또는 (b) 마지막 성공 heartbeat 뒤 60초가 지났을 때만 세운다. heartbeat 문장에 `withDbDeadline(now+10초)` 를 걸고, `stopHeartbeat` 는 최대 2초만 기다린다(ACK 는 `owned` 조건이 다시 지켜 준다).
- 검증: 러너 단위 시험(일시 실패 1회 → completed 유지, 0행 → lost).
- 배포 주의: 일반 배포.
- 확신도: CONFIRMED(코드)
- 규모: S

### RUN-13 앱 시계로 쓴 observed_at 을 DB 시계와 견주는 판정
- 심각도: P3
- 분류: concurrency
- 위치: `lib/operations/observations.ts:5-9`(`observedAt = new Date()`), `lib/jobs/role-leader.ts:157-164`(`localtimestamp - observed_at` 이 −5~20초), `scripts/role-worker.ts:638-642`(15초마다 candidate 관측)
- 문제:
  - 관측 시각은 쓰는 호스트(M3·mini — macOS 위 컨테이너 VM)의 시계다. 그런데 예비 넘겨주기 판정은 DB 의 `localtimestamp` 와 견준다.
  - 쓰는 호스트 시계가 DB 보다 5초 넘게 빠르면 age 가 −5 미만이 되어 기다리는 주 후보가 영영 안 보인다. 그러면 넘겨주기가 일어나지 않고 standby_active 가 이어진다. 20초 넘게 느려도 같다.
  - 진행 판정(관측 신선도)도 여러 호스트의 앱 시계를 섞는다.
- 실측 근거: 코드 근거만(메모리: Mac VM·잠자기 관련 장애 이력).
- 수정 방안: `observe()` 가 `observed_at = (clock_timestamp() AT TIME ZONE 'UTC')` 를 SQL 로 쓴다(관측 표는 timestamp without time zone).
- 검증: 관측 단위 시험. 운영에서 candidate 관측 age 분포를 본다.
- 배포 주의: 일반 배포(모든 관측 작성자).
- 확신도: PLAUSIBLE(실제 시계 차 측정 필요)
- 규모: S

## 구조 변경 제안 (리팩토링으로 효율화)

### S1. 진행 판정을 한 곳에서 계산하고 나눠 읽는다
- 지금: `readWorkerProgress` 를 역할 워커 부모 3~5개(15초), 감시(30초, 텍스트 포함), 웹 콘솔(공유 캐시), console-alerts(5분), 배포 관문이 각자 계산한다. 한 번에 13개 넘는 쿼리를 내고, 처리량 집계 약 1초, uptime readback, 텍스트 집계 4.6초가 들어 있다.
- 바꿀 구조: 생산자 하나(감시 프로세스 또는 scheduler 리더 — advisory lock 으로 한 벌만)가 15~30초마다 계산한다. 결과는 `operations_observations` 의 `progress:report`(+`progress:text`, 5분)에 measuredAt 과 함께 쓴다. 역할 워커·감시·웹은 그 행을 읽는다. 행이 2분 넘게 지났으면 소비자가 직접 계산한다(지금 동작이 대체 경로).
- 얻는 것(추정): 판정 계산이 분당 약 20회에서 2~4회로 준다. 처리량 집계 약 1.5만 초/일, uptime readback 약 4,100초/일, 텍스트 집계 약 1.6만 초/일 중 대부분이 없어진다. 느린 문장 합계의 25~30% 수준이다. 관측 표 전체 읽기도 분당 약 19회에서 2회가 된다.
- 옮기는 순서: ① 생산자와 관측 키를 추가하고 소비자는 그대로 → ② 감시가 행 읽기로 바꿈 → ③ 역할 워커 → ④ 웹·console-alerts.
- 위험: 생산자가 죽으면 판정이 낡는다. measuredAt 기한과 대체 계산으로 막는다. 배포 관문은 지금처럼 직접 계산을 유지할 수 있다.

### S2. scheduler 를 집합 연산 한 문장 + 리더 한 벌로
- 지금: 3벌 × 10초 × 잡 58개 × 2문장, 한 TX 안 직렬, 도래 행 잠금을 루프 끝까지 쥔다(RUN-04).
- 바꿀 구조: 부팅 때 잡 행을 한 번 만든다. 틱은 `pg_try_advisory_xact_lock` 을 얻은 한 벌만 돌고, `UPDATE … FROM (VALUES …) … RETURNING` 한 문장으로 끝낸다.
- 얻는 것: 틱당 문장 116개 넘게 → 4개, 3벌 중복 → 1벌. 잡 행 잠금 시간이 문장 하나 길이(수 ms)가 된다. 잡 표 대기(약 980초/일)와 그에 딸린 role_leases 대기가 사라질 것으로 본다.
- 옮기는 순서: SQL 의미 시험(job-interval-override) → scheduler 배포 → 러너 claim INSERT 제거 배포.
- 위험: 덮어쓰기 주기·Oracle ack 경로(`acknowledge`)의 의미 보존. advisory lock 키 충돌을 피하려면 고정 상수를 문서화한다.

### S3. 프로세스당 poll 하나, 줄은 구독
- 지금: 32줄이 각자 5초마다 seen/pending(RUN-11).
- 바꿀 구조: `WorkerPoller` 하나가 5초마다 pending 을 한 번 읽어 줄별 큐에 나눈다. seen 은 30초마다 프로세스의 모든 이름을 한 번에 기록한다. 줄은 자기 이름이 pending 일 때만 깨어난다.
- 얻는 것: 폴링 TX 가 약 19 TX/s 에서 약 2 TX/s 로 85~90% 준다(하루 약 140만 TX). 잡 행 upsert 경합도 준다.
- 옮기는 순서: runWorker 내부만 바꾼다(줄 실행·heartbeat 보고 모양은 유지).
- 위험: 한 poll 의 실패가 모든 줄을 쉬게 한다. 지금도 같은 DB 라 실질 차이는 작다. 줄 연속 실행(continuation 1초)은 줄 쪽에서 즉시 깨우기로 유지한다.

### S4. 러너의 미룸을 "다시 볼 시각"이 있는 값으로
- 지금: 모든 미룸이 요청을 남기고 notBefore 없이 lease 만 놓는다. 그래서 영구적 미룸(stage_blocked)도 일시적 미룸(model_capacity)도 5초 poll 마다 다시 돈다(RUN-06).
- 바꿀 구조: `deferredJob(reason, processed, { retryAfterMs | acknowledge })` 를 둔다. stage_blocked 는 요청을 인정하거나(다음 일정까지), 60초 notBefore 를 건다. 모델 자리 미룸은 짧은 retryAfter 를 쓰고, 모든 줄이 동시에 깨어 장부를 두드리지 않게 지터를 섞는다.
- 얻는 것: items 모드 단계의 정비 틱이 분당 수 회 → 1회. DRAIN 중 모델 줄 공회전도 준다.
- 위험: notBefore 가 사람의 멈춤(PAUSED)과 섞이지 않게 해야 한다(지금 `PAUSED` 판정 유지). job-health 의 의도적 미룸 판정은 그대로다.

### S5. 줄 단위 부드러운 중단 뒤에 프로세스 종료
- 지금: 감독은 줄 하나가 job_timeout 을 넘으면 자식 프로세스 전체를 멈춘다(`worker-supervisor.ts` stalledReason → stop). reviewer 15줄의 진행 중인 모델 호출이 함께 취소된다.
- 바꿀 구조: 줄마다 AbortController 를 두고, 넘긴 줄만 먼저 abort 한다(신호를 받는 호출은 끊긴다). N초 안에 그 줄이 돌아오지 않을 때만 프로세스를 끝낸다.
- 얻는 것: 한 줄의 걸림이 다른 줄의 미확정(600초 칸 점유)을 만들지 않는다.
- 위험: abort 신호를 무시하는 호출(동기 차단 등)에는 효과가 없다. 그때는 지금처럼 프로세스 종료로 간다.

## 확인했지만 문제 아님
- scheduler 3벌의 중복 발화: `next_scheduled_at <= now()` 조건과 행 잠금 뒤 재평가 때문에 한 벌만 다음 시각을 민다. `requestedVersion` 은 처리와 같을 때만 +1 이라 요청이 합쳐진다(`lib/jobs/control.ts:59-70`). 낭비는 있지만(RUN-04) 중복 실행은 없다.
- 역할을 넘겨받은 뒤 옛 실행기가 늦게 쓰는 경우: 선출 TX 가 그 역할 잡의 토큰을 지운다(`role-leader.ts:88-91`). ACK·커서 저장·`withJobLeaseWrite` 는 토큰과 lockedAt 을 다시 확인한다(`runner.ts:194-195,303`, `control.ts:131-139`).
- 배경 consumer 줄의 `open()` 은 모델 장부 control 행을 잠그지 않는다(`lib/llm/capacity-repository.ts:109-111,127-133`, 잠금 없는 한 문장).
- 잠금 순서: fence(share) → batch(share) → role_leases → jobs 가 claim·선출·정기 요청·갱신에서 같다. `completeJobBatchTransitionIn` 의 이름순 잠금(batch-repository.ts:274)은 batch FOR UPDATE 로 다른 TX 를 막은 뒤라 교착이 없다.
- Valkey 장애 폴백: 명령 150ms 제한, offline queue 끔, 준비되지 않으면 client()=null → DB 로 간다(`lib/cache/shared.ts:28,86-87,109`). 프로세스 memo 는 같은 열쇠 동시 호출을 합치고 max 로 크기를 묶는다(`lib/cache/memo.ts:36,44-45`). `sharedLoader` 도 max 4(`lib/operations/shared-cache.ts:50,59`). 무제한으로 자라는 Map 은 찾지 못했다.
- 미룸 관측 쓰기: 잡마다 같은 이유면 1분에 한 번(`lib/jobs/deferral-observation.ts:44-66`). 5초 재실행에도 쓰기는 늘지 않는다.
- second-review 의 성공 시각 고정: job-health 가 `stage_blocked` 를 의도적 미룸으로 보고 경보하지 않는다(`lib/operations/job-health.ts:34,114`). 결함이 아니다(주기 낭비만 RUN-06).
- 예비 → 주 넘겨받기 시간: lease 45초 + 예비 20초 유예 + 5초 poll ≈ 최대 70초. 주석에 적힌 설계다(`role-leader.ts:61-71`, `role-worker.ts:63-69`). 격리는 5분 안 3번 재부팅이면 15분이다(`role-leader.ts:73-79`). 같은 boot 가 lease 를 다시 받는 경로는 primaryBoots 를 늘리지 않는다(`:63-65`).
- 스냅숏의 `idle in transaction` 1건: 여러 문장 TX 의 문장 사이 순간일 수 있다. 오래 지속된다는 근거는 없다(RUN-09 에서 상한 부재만 다룸).
- 웹 생존 관측(`lib/operations/web-observer.ts`)은 pending 플래그로 겹치지 않는다. 15초 1행 upsert 다.
- 러너 실패 기록의 NUL 처리·남의 lease 보호(`runner.ts:349-358`)는 맞다.

## 범위 밖·못 본 것
- **모델 장부 전역 control 행 잠금**: slow 에서 `model_capacity_control … for update` 19,640회·20,254초, `select "id" … for update` 6,546회·6,894초, `… for share` 6,395회·6,467초, `select "id" … for share` 2,560회·2,569초다. 합계 약 3.6만 초/일로 느린 문장 합계의 약 30%이자 최대의 잠금 대기다. 스냅숏에서도 active 약 15 중 잠금 대기 7. 장부 구역 몫이라 여기서는 다루지 않는다.
- `crawl_candidates` 승인 술어 쿼리(11,242회·30,676초, 17시간 관측) — 발행·심사 구역.
- `reason_eligible`(사유 번역 진행) 쿼리 자체의 최적화 — 번역 구역. 여기서는 호출 빈도만 다뤘다(RUN-02).
- `staleSecondReviewHintSql` 의 실행 계획(비종결 장부 전체 MATERIALIZED) — 심사 구역(RUN-06 은 빈도만).
- 저장소에 없는 운영 설정: PgBouncer(pool_mode·default_pool_size·max_client_conn·query_wait_timeout), Dokploy 앱별 env(`DB_POOL_MAX`·`READ_DB_POOL_MAX`·워커의 `VALKEY_URL`·stop grace period), `nomorevibe` 역할의 `pg_db_role_setting`.
- 오류 집계의 `statement timeout` 10,383회(`nomorevibe`)가 어느 문장인지는 근거에 문장이 없어 추적하지 못했다.
- `assertJobLease*` 호출 202곳과 "외부 호출 동안 TX 를 열어 두는 곳"은 전수로 보지 않았다. 표본으로 본 러너·second-review·db-retention·console-alerts 경로에는 없었다.
- 동기 차단 호출: 역할 워커·감독의 건강 파일 `writeFileSync`(5초, 수백 바이트), 로거의 `process.stdout.write`(Linux 파이프는 동기)는 작아서 싣지 않았다. `lib/cache/shared.ts` 의 `v8.serialize` 는 웹 요청 경로에서 큰 값(conveyor)일 때 수 ms 걸릴 수 있으나 측정하지 않았다.
- Oracle scheduler·소비자(`lib/runtime/oracle-*`)의 동시성은 훑기만 했다.
