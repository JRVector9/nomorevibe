# 05. 감시·진행 관측·관리자 화면 — 점검 결과

> 2026-11-21 전수 점검의 구역 문서다(점검 기준 origin/main `34b5fe32`, 읽기 전용). 수정 순서와 묶음은 [README](../README.md), 실측은 [evidence](../evidence.md)·`../evidence/`.
> 줄 번호는 그 커밋 기준이다. 「확신도」가 PLAUSIBLE 인 항목은 적힌 확인을 먼저 한다.


대상: `저장소 루트` (origin/main 34b5fe32). 읽기만 했다(테스트·빌드·DB 접속 없음).
관리자 쓰기 경로와 화면 레이턴시는 하위 조사 둘에 맡겼고, 핵심 줄은 본 점검자가 다시 열어 확인했다(각 항목 확신도에 적음).

## 요약

- 건수: P0 0 · P1 3 · P2 12 · P3 8 (총 23) — 2차 검증에서 OPS-01 P0→P1, OPS-03·05·06 P1→P2 로 고쳤다(까닭은 각 항목과 맨 끝 「검증 기록 (2차)」).
  - 처음 건수(1차): P0 1 · P1 5 · P2 9 · P3 8.
- 가장 중요한 5개
  1. **OPS-01 (P1, 1차 P0)** 감시(monitor)는 DB 연결이 1개이고 풀 대기는 5초다. 3초 상한 문장 여러 개와 10초 상한 문장 하나를 한 줄로 기다린다. 그중 하나만 실패해도 진행(progress) 전체가 null 이 되어 그 주기는 `unknown` 이다. 원인은 어디에도 남지 않는다. 실측과 맞춰 보면 감시 계정의 시간 초과 875건은 「약 10시간 동안 매 주기 실패」와 숫자가 맞는다(연속성은 미확인).
  2. **OPS-02 (P1)** 역할 감독(`role-worker` checkProgress)이 역할마다 15초에 한 번 배포 관문용 전체 진행 집계를 부른다. 정작 쓰는 것은 제 단계뿐이다(maintenance·text 는 scheduler 판정 하나만 쓴다).
     - 응답 점검 장부 readback(하루 7,210회, 4,121초)은 이 경로에서 한 번도 쓰이지 않는다.
     - 표별 seq scan 횟수(분당 약 15회)가 이 호출 빈도와 맞는다.
  3. **OPS-03 (P2, 1차 P1)** 처리량 집계(`pipelineThroughput`)가 호출마다 큰 표 넷을 전부 훑는다.
     - 5분 창 조건인데 `crawl_documents.fetched_at`·`crawl_review_attempts.completed_at` 에 색인이 없다.
     - `crawl_frontier`·`second_reviews` 는 거르는 조건 없이 전체를 집계한다.
     - 호출하는 곳이 5곳 넘는데 공유 캐시가 없다.
  4. **OPS-04 (P1)** 사유 번역 진행 집계(`reason_eligible`)는 감시가 40초마다, 웹·maintenance 가 주 DB 에서 다시 센다.
     - 40만 사유 전부에 sha256·정규식을 돌린다.
     - 감시만 하루 16,580초(4.6시간), 웹·워커가 3,071초를 쓴다.
  5. **OPS-05 (P2, 1차 P1)** `console-alerts` 가 10시간째 성공하지 못한 것은 알림이 아예 멈춘 것이 아니다. 틱마다 「알림 묶음 셀 수 없음」(degraded)으로 끝나고 있다.
     - 운영 관측(오케스트레이터 확인): `job:console-alerts` degraded code=console_tasks_unknown, detail 「셀 수 없음 · 바꾼 뒤 처리량」, since 2026-11-20T13:54:49Z, streak 125. 셀 수 없는 규칙은 그 하나뿐이다.
     - 가장 유력한 경로: 진행 읽기 실패 → 바꾼 것 지켜보기(change-watch)가 `waitingUnread` → 「평소와 다름」 묶음을 셀 수 없음.
     - 그동안 그 규칙은 알림을 못 열고, 열린 줄은 닫히지 않는다.

## 발견

### OPS-01 감시 한 주기가 연결 1개로 직렬 실행되어, 문장 하나가 실패하면 진행 전체가 unknown 이 되고 원인이 남지 않는다

- 심각도: P1 (1차 P0 → 2차 검증에서 내림. 까닭: 감시 판정의 신뢰도 문제(오경보·미탐·배포 관문 막힘)이지 서비스 장애·데이터 손상이 아니다. 1차 점검자도 「연속성이 확인되지 않으면 P1」이라 했는데 연속성은 확인되지 않았다)
- 분류: concurrency / logic
- 위치:
  - `lib/db/pool.ts:19` — `monitor: 1`
  - `lib/db/pool.ts:62` — `waitMs: integerSetting(env, "DB_POOL_WAIT_MS", 5_000, …)`
  - `lib/operations/failover-monitor.ts:68-73`
  - `lib/operations/worker-progress-query.ts:470-479`(두 번째 `Promise.all`)
  - `lib/operations/text-stage-progress.ts:151-162`
  - `scripts/watch-failover-readiness.ts:206-227`
  - 아래 인용 순서: failover-monitor.ts:69-70(`allSettled` 가 실패 사유를 버린다) → worker-progress-query.ts:470-473(하나라도 던지면 전체 reject; 근거 TX 3초, text 는 사유 10초 + 그 밖 3초 직렬) → watch-failover-readiness.ts:221-223(로그에는 overall 만).
  ```ts
  const [readiness, progress, capacity, mode] = await Promise.allSettled([readFailoverReadiness(), readWorkerProgress(), readModelCapacityUnknowns(),
    readCapacityModeObservation()]);
  …
  const [throughput, observations, evidence, split, text, publisherDraining] = await Promise.all([
    pipelineThroughput(settings, now), db.select().from(operationsObservations).where(and(WITHOUT_JOB_DEFERRALS, WITHOUT_JOB_TALLIES,
      notLike(operationsObservations.key, "discovery-progress:%"))),
    evidenceProgress(db, settings, now, Number.isFinite(idleUntil) && idleUntil > now.getTime(),
  …
    console.log(JSON.stringify({ measuredAt: status.measuredAt, overall: status.overall,
      badSamples: state.badSamples, ...(status.warnings ? { warnings: status.warnings } : {}),
      ...(status.capacityMode ? { capacityMode: status.capacityMode.mode } : {}) }));
  ```
- 문제:
  - 한 주기에는 대략 45개 문장이 있다. 무거운 것은 처리량 TX(3초 상한), 근거 진행 TX(3초), 사유 집계 TX(10초), 그 밖 text TX(3초), 장부 미확정 TX(3초), 응답 점검 readback 이다. 이것을 **연결 1개**에서 직렬로 돈다.
  - 대기열에서 5초를 넘긴 문장은 `DbPoolWaitTimeoutError` 로 취소된다(`pool.ts` waitDeadline). 예를 들어 사유 TX 가 5~9초 연결을 쥐면, 그 뒤에 줄 선 readback·처리량 BEGIN 이 풀 대기에서 떨어질 수 있다.
    - [2차 검증 보정] 줄 서는 순서를 다시 따라가 보면 사유 TX 의 BEGIN 은 `homeListSlugs()` 3문장이 끝난 뒤에야 줄에 들어간다(`text-stage-progress.ts:153,162`). 처리량 BEGIN·근거 BEGIN·readback 은 대개 그보다 앞에 선다. 그래서 「사유 TX 뒤에서 풀 대기로 떨어짐」은 늘 일어나는 일은 아니고 순서에 따라 가끔 생긴다(PLAUSIBLE). 풀 대기 실패는 클라이언트 쪽 오류라 DB 로그(875건)에는 나오지 않는다.
  - 어느 한 문장이 상한을 넘거나 풀 대기에서 떨어지면 `readWorkerProgress` 전체가 reject 된다. 그러면 `progress=null` → `overall=unknown` 이고, 2회 연속이면 Kuma DOWN 이다.
  - 같은 주기의 하트비트 파일에는 `stageFailures`·`providerFailures` 가 빠진다. 그래서 그 시간 동안 **Oracle watchdog 도 단계 고장을 못 본다**.
  - 원인(어느 조각이 왜 실패했는지)은 `allSettled` 가 버리고 로그에는 `overall` 만 남는다. 역할 감독도 `role.progress_unknown` 에 오류 코드를 싣지 않는다(`scripts/role-worker.ts:464`).
  - 배포 관문(OPS-09)도 같은 코드를 돌리므로 같은 문장 하나가 배포를 막는다.
- 실측 근거:
  - `slow-queries-primary.txt:71`: monitor 계정 `canceling statement due to statement timeout` 875건(23시간).
  - 감시 주기는 30초 대기 + 실행 약 10~15초로 시간당 약 80~85회다. 875건은 「약 10시간 동안 매 주기 1건」과 맞는다.
  - 사유 집계(10초 상한)는 그동안에도 끝까지 돌았다(`:4` hours_seen 23, 최대 9,080ms). 그러니 넘친 쪽은 그 뒤의 3초 상한 문장(그 밖 text·근거·처리량 중 하나)일 가능성이 높다.
    - [2차 검증 보정] 이 추론은 근거가 약하다. 느린 목록에는 **끝까지 돈** 문장만 남고, 잘린 문장은 오류 쪽에만 남는다. 그래서 「최대 9,080ms」는 10초에서 잘린 사유 문장의 꼬리를 배제하지 못한다.
    - 처리량(`WITH fetched AS …`)·근거(`WITH public_products …`) 문장은 23시간 동안 어느 계정에서도 0.5초를 넘지 않았다(느린 목록에 그 모양이 없다). 그러니 3초 상한에 자주 걸린 쪽이 그 둘일 가능성은 낮다.
    - 남는 후보는 둘이다. ① 'other' text 문장(3초). `slowdigest.py` 가 문장 앞 420자로 묶어 'reason'·'other' 가 `:4` 한 줄에 섞이므로 따로 보이지 않는다. ② 사유 문장(10초)의 꼬리.
    - 횟수로 따져 보면 ①이 더 그럴듯하다(PLAUSIBLE).
      - 감시 루프는 30초를 쉬므로 시간당 최대 약 100주기다. 그런데 `:4` 는 23시간에 3,604건(시간당 157)이다. 그러니 'other' 도 대개 0.5초를 넘어 주기당 2건씩 세어졌을 것이다(또는 배포 관문 같은 다른 감시 계정 호출이 섞였다).
      - 사유 문장이 잘리면 'other' 는 돌지 않는다(`text-stage-progress.ts:162` 직렬). 875건 대부분이 ②였다면 주기당 완료 수가 줄고 주기는 40초 넘게 길어진다. 그러면 3,604건과 맞추기 어렵다.
      - 같은 까닭으로 `:4` 의 평균 4,601ms 는 두 문장을 섞은 평균일 수 있다. 사유 문장 혼자는 더 길 수 있다.
    - 가르는 법: 원 DB 로그에서 `canceling statement due to statement timeout` ERROR 바로 다음의 `STATEMENT:` 줄을 모양별로 센다. `log_min_error_statement` 기본값(error)이면 로그에 있다. `slowdigest.py` 는 그 줄을 읽지만 집계하지 않는다. 확인하지 못했다.
  - 같은 10시간 동안 `console-alerts` 도 성공이 없다(`jobs.txt:10`, OPS-05). 관측 detail(「셀 수 없음 · 바꾼 뒤 처리량」, since 13:54:49Z)은 maintenance 쪽 `readWorkerProgress(includeText:true)` 실패와 모순되지 않는다. 다만 그것을 증명하지도 않는다(OPS-05).
    - 역할 감독은 `includeText:false` 라 이 두 증상에 끼지 않는다. 그러니 text 조각(특히 'other' 3초)이 그 시각부터 늘 넘쳤다는 가설이 감시·console-alerts 를 함께 설명한다(PLAUSIBLE).
- 수정 방안(추천 순):
  1. **원인 기록**: `readMonitorStatus` 가 조각별 실패 코드를 모은다(`{progress:'statement_timeout:text-other'}` 처럼 이름·SQLSTATE 만). 이것을 로그 줄과 하트비트에 싣는다. 역할 감독 `role.progress_unknown` 에도 `dbErrorFields` 를 싣는다.
  2. **조각 실패를 전체 실패로 만들지 않기**:
     - text·근거·응답 점검 조각은 실패하면 마지막 성공값을 최대 N분(예: 10분, 단계 경보 문턱 10~30분보다 짧게) 나이와 함께 다시 쓴다.
     - N분이 넘으면 그 단계만 `unknown_age` 로 한다.
     - 처리량·관측·잡 상태처럼 생존·경보 판정의 핵심만 실패 시 전체 unknown 으로 둔다.
  3. **monitor 의 풀 대기**: `DB_POOL_WAIT_MS` 를 30초로 올린다. 문장 상한이 실행 시간을 묶으므로 대기만 늘어난다. monitor 계정 연결 상한이 2이고 관문 스크립트가 하나를 써야 하므로 풀 크기는 1로 둔다.
  4. 비싼 조각의 주기를 낮춘다(OPS-04).
- 검증:
  - 운영: monitor 로그에서 `overall` 의 연속 unknown 비율과 조각별 실패 코드를 본다. 고친 뒤 `nomorevibe_monitor_20261022` statement timeout 이 일 100건 아래로 내려가는지 본다.
  - 단위 시험: 「text 조각이 statement_timeout 을 던져도 직전 성공값이 10분 안이면 overall 이 ok·alarm 으로 판정된다」, 「10분이 넘으면 그 단계만 unknown_age」.
- 배포 주의: monitor 는 `autoDeploy=false` 별도 앱이다. 공통 8앱 배포로 바뀌지 않으므로 digest·명령을 따로 확인한다. env(`DB_POOL_WAIT_MS`)를 바꾸면 Dokploy env 변경 뒤 재배포한다.
- 확신도: CONFIRMED(기전: 호출 경로·풀 코드를 끝까지 읽었다). 「10시간 연속」은 PLAUSIBLE — monitor 로그의 overall 연속값으로 확인한다.
  - 2차 검증:
    - CONFIRMED — 「조각 하나 실패 → progress null → overall unknown, 원인 미기록」. `failover-monitor.ts:42,69-73`, `watch-failover-readiness.ts:221-223`, `role-worker.ts:461-464` 를 다시 읽었다.
    - CONFIRMED — 감시 풀 1개, 계정 연결 상한 2. `pool.ts:19`, `docs/operations/2026-10-22-worker-monitor-rollout.md:47`.
    - PLAUSIBLE — 「풀 대기 5초 초과로 떨어짐」. 줄 순서에 따라 가끔 생긴다. 운영 env 의 `DB_POOL_WAIT_MS` 값은 저장소에 없어 확인하지 못했다.
    - 보정 — 「875건은 3초 상한 문장」. 위 실측 근거의 보정을 따른다.
- 규모: M

### OPS-02 역할 감독이 15초마다 전체 진행 집계를 부르지만 제 단계만 쓴다 — 응답 점검 readback·근거 집계는 대부분 버려진다

- 심각도: P1
- 분류: inefficiency
- 위치:
  - `scripts/role-worker.ts:445-466`(15초 타이머)
  - `scripts/role-worker.ts:651-664`
  - `scripts/role-worker.ts:205-212`(selectUnexplainedStall)
  - `lib/operations/uptime-split-repository.ts:64-77`
  - 아래는 role-worker.ts:655-664. 마지막 줄의 `selectUnexplainedStall` 은 `:209` 에서 `report.stages.filter(stage => stage.role === role)` 로 제 단계만 본다.
  ```ts
        const report = await readWorkerProgress(undefined, { includeText: false });
        if (role === 'maintenance') {
          const uptime = { ...await readMaintenanceUptimeProgress(), schedulerScheduled: report.scheduler.reason === 'scheduled' };
          return maintenanceUptimeStalled(uptime) ? maintenanceStallTrigger(uptime) : false;
        }
        if (role === 'text') {
          const text = { ...await readTextProgress(), schedulerScheduled: report.scheduler.reason === 'scheduled' };
          return textProgressStalled(text) ? textStallTrigger(text.oldestReadyMinutes) : false;
        }
        return selectUnexplainedStall(report, role) ?? false;
  ```
- 문제:
  - M3 의 주(primary) 역할 감독(crawler·reviewer·publisher, 그리고 잡이 쉬는 동안의 maintenance·text)은 각각 15초마다 `readWorkerProgress` 를 통째로 부른다. 그 안에는 처리량 TX, 근거 TX, `operations_observations` 전체 읽기, 응답 점검 readback, 장부 접수 막힘 집계가 들어 있다.
  - maintenance·text 는 `report.scheduler.reason` 하나만 쓴다. 이 값은 jobs 행·관측·batch 모드만 있으면 나온다.
  - crawler·reviewer·publisher 는 자기 role 의 단계만 쓴다.
  - 응답 점검(uptime) 단계의 role 은 maintenance 인데, maintenance 는 이 보고서 대신 `readMaintenanceUptimeProgress` 를 쓴다. 그래서 **readback 은 감독 경로에서 한 번도 쓰이지 않는다**.
  - 근거 3단계(role crawler)도 reviewer·publisher·maintenance·text 에게는 버려진다.
- 실측 근거(근거 파일의 표 통계, 134시간 누적):
  - `slow-queries-primary.txt:9`: `readUptimeSplitReadback` 모양(`WITH c AS MATERIALIZED (SELECT clock_timestamp() AS at) SELECT jsonb_build_object('at' …`)이 `nomorevibe` 계정에서 7,210회, 합계 4,121초다. 이 모양의 운영 호출자는 `readUptimeSplitStage` 하나다(`pipeline-control-status` 는 다른 바깥 문장에 끼워 넣는다).
  - `pg-stats-primary.txt` 의 seq scan 횟수가 모두 분당 약 15회 근거 집계·readback 과 맞는다:
    - `product_links` 122,622회 = 분당 15.2회, 회당 108,780행 ≈ 전체 115k
    - `repository_ai_levels` 145,879회 = 분당 18회, 회당 149k
    - `uptime_claims` 552,150회 = 분당 68회. readback 한 번에 uptime_claims 를 4번 훑으므로 분당 약 17회다.
- 수정 방안:
  1. 역할별 최소 읽기 `readRoleProgress(role)` 를 만든다.
     - maintenance·text: `listJobStates`·관측·batch 모드로 `classifyScheduler` 만 한다.
     - publisher: 처리량 중 publish 칸만.
     - reviewer: judge·first·second 칸.
     - crawler: fetch 칸 + 근거 3단계.
     - 처리량 SQL 은 단계별 CTE 로 이미 나뉘어 있으니 필요한 CTE 만 고르는 인자를 준다.
  2. 감독 주기를 15초에서 60초로 늘린다. 재시작은 연속 2표본 정체가 필요하고 정체 문턱이 5~15분이므로 감지가 30초에서 2분으로 늘 뿐이다.
  3. 배포 관문·감시는 지금 전체 집계를 그대로 쓴다.
- 검증:
  - 고친 뒤 `pg_stat_user_tables` 의 `product_links`·`repository_ai_levels`·`uptime_claims` seq_scan 증가율이 1/5 이하로 준다.
  - 느린 문장 목록에서 readback 모양이 monitor 계정 것만 남는다.
  - `tests/` 의 role-worker 정체 판정 시험(selectUnexplainedStall)이 그대로 통과한다.
- 배포 주의: 역할 워커 이미지 공통 배포다. role-worker 는 부모 프로세스라 역할 재시작이 필요하고, 일반 배포 절차로 된다.
- 확신도: CONFIRMED(쓰는 칸을 끝까지 따라갔다. readback 미사용은 maintenance 분기와 role 필터로 반증되지 않았다)
  - 2차 검증: CONFIRMED.
    - 응답 점검 단계의 역할이 maintenance 다(`worker-progress.ts:106-110` progressStageRole). maintenance 감독은 그 보고서의 `scheduler.reason` 만 쓴다.
    - `uptime-split-repository.ts:70-72` 주석은 legacy 모드면 한 행만 읽게 했다고 적는다. 그러나 느린 목록 `:9`(readback 7,210회)가 claims 모드로 도는 중임을 보여 준다.
    - 근거 단계의 `product_links`·`repository_ai_levels` 전체 읽기는 `lib/domain/evidence/source-demand.ts:8-18`·`worker-progress-query.ts:380-382` 에서 나온다. 회당 읽은 행 수(10.9만 ≈ 표 전체)와 맞는다.
    - 같은 문제를 db-queries DB-02 가 다룬다(중복).
- 규모: M

### OPS-03 처리량 집계가 호출마다 큰 표 넷을 다 훑고, 화면·감시·감독 5개 넘는 경로가 따로 센다

- 심각도: P2 (1차 P1 → 2차 검증에서 내림. 까닭: 이 문장은 23시간 동안 어느 계정에서도 0.5초를 넘지 않았다(느린 목록에 `WITH fetched AS` 모양이 없다). 비용은 회당 지연이 아니라 빈도에서 오고, 빈도는 OPS-02(P1)가 다룬다. db-queries 점검자도 「문제는 빈도(DB-02)」로 본다)
- 분류: latency
- 위치:
  - `lib/operations/throughput.ts:67-69`(fetched), `:70-77`(fetch_queue — WHERE 없음), `:82-85`(judge_queue — 문서×후보 전체 조인), `:86-97`(first_done), `:102-115`(second_stats — WHERE 없음)
  - `:23-34`(같은 프로세스 안에서 겹친 호출만 묶음. `now` 를 주면 그것도 안 함)
  - 아래 인용 순서:
    - `:67-70` fetched — `fetched_at` 이 선두인 색인이 없다.
    - `:77` fetch_queue 의 FROM — WHERE 가 없다.
    - `:96-97` first_done — `completed_at` 색인이 없다.
    - `:115` second_stats 의 FROM — WHERE 가 없다.
  ```ts
    WITH fetched AS (
      SELECT ${counts(sql`${crawlDocuments.fetchedAt}`)} FROM ${crawlDocuments}
      WHERE ${recent(sql`${crawlDocuments.fetchedAt}`, 5)}
    ), fetch_queue AS (
  …
      FROM ${crawlFrontier}
  …
      FROM ${crawlReviewAttempts} WHERE ${crawlReviewAttempts.kind} = 'automatic'
        AND ${recent(sql`${crawlReviewAttempts.completedAt}`, 5)}
  …
      FROM ${secondReviews}
  ```
- 문제:
  - 색인을 찾아봤다. `crawl_documents` 는 `(lower(repo), fetched_at, id)`·`github_id` 색인뿐이다(`lib/db/crawl-schema.ts:94`, drizzle). `crawl_review_attempts` 에는 completed_at 색인이 없다. 그래서 5분 창 집계가 매번 전체를 병렬로 훑는다.
    - [2차 검증] 운영 실제 색인(`evidence/indexes-primary.txt`)과 맞는다.
      - `crawl_documents`: pkey·repo_unique·github_id_idx·repository_birth_lookup_idx `(lower(repo), fetched_at DESC, id DESC)` 넷. fetched_at 은 둘째 칸에만 있다.
      - `crawl_review_attempts`: pkey·approval_idx·input_idx·one_active_idx 넷. completed_at 칸이 없다.
      - `second_reviews`: pkey·candidate_input_model_idx·status_idx 셋. reviewed_at 칸이 없다.
      - `crawl_candidates` 에도 judged_at 색인이 없다(`judged` CTE).
    - 단, fetched_at 은 birth_lookup 색인의 둘째 칸이다. 그래서 플래너가 그 색인(107MB) 전체를 훑는 계획을 고를 수도 있다. 실제 계획은 EXPLAIN 으로 확인해야 한다.
  - `fetch_queue`·`second_stats` 는 거르는 조건 없이 1.07M·204k 행 전체를 센다.
  - `judge_queue` 는 `crawl_documents LEFT JOIN crawl_candidates WHERE c.id IS NULL OR c.state='new' …` 로 두 표 전체를 해시 조인한다.
  - 호출하는 곳은 다음과 같다.
    - 역할 감독: 분당 약 12~16회, OPS-02
    - 감시: 분당 약 1.5회
    - 배포 관문
    - 운영센터 `/admin/status` 의 `loadActionInputs`: 10초마다, 캐시 없음, OPS-06
    - conveyor: 15초 공유
    - 콘솔 진행: 30초 공유
    - 배지 재계산: 30초, OPS-12
    - console-alerts: 5분
  - 공유 캐시는 없다. `readWorkerProgress` 는 `now` 를 넘겨 프로세스 안 묶기도 건너뛴다(`worker-progress-query.ts:471`).
- 실측 근거:
  - 회당 읽은 행 수가 「병렬 전체 스캔」 모양과 맞는다:
    - `crawl_documents`: 1,056,322회 / 232.8G행 → 회당 220k ≈ 1.07M/5(일꾼 4 + 리더)
    - `crawl_frontier`: 회당 212k ≈ 1.07M/5
    - `crawl_review_attempts`: 회당 120k ≈ 363k/3
  - `crawl_frontier` 의 seq scan 행 수(하루 약 22.8G)는 처리량 집계 분당 약 15회 × 1.07M ≈ 하루 23G 와 거의 같다.
  - 그래서 이 문장 하나가 그 표 seq scan 의 대부분을 만든다고 본다. 문장 하나는 0.5초 미만이라 느린 목록에는 안 보인다. 「혼자 1초, 셋 겹치면 2.6초」라는 주석은 `throughput.ts:25-26` 에 있다.
- 수정 방안:
  1. 색인을 만든다(CONCURRENTLY):
     - `crawl_documents (fetched_at)`
     - `crawl_review_attempts (completed_at) WHERE kind = 'automatic'`
     - `second_reviews (reviewed_at)`
  2. 전체 집계를 색인이 쓰이는 조각으로 나눈다.
     - `fetch_queue`: `crawl_frontier_dequeue_idx (state, next_attempt_at, …)` 로 `state='pending' AND next_attempt_at <= at` 와 `state='fetching'` 을 따로 센다. 오류 칸은 `updated_at` 부분 색인을 쓰거나 5분 창을 포기한다.
     - `second_stats`: `status` 색인으로 pending·failed 를 세고, reviewed_at 창은 새 색인으로 센다.
  3. `judge_queue` 는 「후보 없는 문서」를 판정 잡과 같은 기준으로 세되 부분 색인으로 받친다. 또는 판정 잡이 틱마다 남기는 대기 수(job 관측)를 읽는다.
  4. 표시 경로(운영센터·conveyor·콘솔·배지)는 `sharedLoader("admin:throughput", ttl 15s, stale 60s)` 하나로 묶는다. 주 DB 무캐시 읽기는 관문·감시·감독만 쓴다.
- 검증:
  - 복제본에서 `EXPLAIN (ANALYZE, BUFFERS)` 로 바꾸기 전과 뒤를 잰다. 목표는 Seq Scan 이 사라지고 실행 50ms 아래다.
  - 운영: 위 세 표의 seq_scan 증가율.
- 배포 주의:
  - 색인은 `CREATE INDEX CONCURRENTLY` 를 별도 마이그레이션으로 낸다(트랜잭션 밖).
  - `crawl_documents` 는 3.5GB 라 만드는 데 시간이 걸린다. 디스크 여유를 먼저 확인한다(11-15 디스크 장애).
- 확신도: CONFIRMED(색인을 schema·drizzle 에서 찾아봤다). 표별 몫은 추정이다.
  - 2차 검증:
    - CONFIRMED — 색인 부재. 운영 색인 목록과 대조했다.
    - CONFIRMED — 「`crawl_frontier` seq scan 행 수 ≈ 처리량 집계 빈도 × 107만」. 하루 22.8G ÷ 1.07M ≈ 분당 14.8회 전체 훑기로, 처리량 집계를 부르는 빈도와 맞는다.
    - 제안 색인 셋은 운영의 어느 색인과도 겹치지 않는다. 같은 completed_at 부분 색인을 DB-02 도 제안한다.
- 규모: M

### OPS-04 사유 번역 진행 집계를 감시가 40초마다, 웹·maintenance 가 주 DB 에서 다시 센다

- 심각도: P1
- 분류: latency
- 위치:
  - `lib/operations/text-stage-progress.ts:35-40`
  - `lib/operations/text-stage-progress.ts:152-162`
  - `lib/operations/console-progress-read.ts:11-14`
  - `lib/crawl/translations.ts:145-153`(`oldestPendingTranslationMinutes` — text 감독용, 같은 집계)
  - `lib/domain/products/korean-taglines.ts:94-101`(`homeListSlugs` — 캐시 없는 홈 목록 3쿼리, 부를 때마다)
  ```sql
  WITH reason_eligible AS MATERIALIZED (
    SELECT encode(sha256(convert_to(body,'UTF8')),'hex') AS hash, max(at) AS at
    FROM (crawl_review_attempts 전체 UNION ALL second_reviews 전체) source_rows WHERE <한글 비율 정규식> GROUP BY 1)
  ```
- 문제:
  - 사유 40만 행(1.8GB `crawl_review_attempts` + `second_reviews`) 전부에 sha256·정규식을 돌린다. 감시는 주기마다(약 40초) 이것을 다시 한다.
  - 이 단계의 경보 문턱은 10~30분이다(`worker-progress.ts:127,133` — 2차 검증에서 줄 번호를 고침). 40초 해상도는 필요 없다.
  - 웹 콘솔(`readConsoleProgress`)과 console-alerts(maintenance)도 같은 집계를 **주 DB** 에서 다시 센다. 관문만 주 DB 가 필요하다(`worker-progress-query.ts:469` 주석).
  - text 감독(`readTextProgress`)은 같은 원천을 `UNIQUE_TRANSLATION_SOURCES_SQL` 로 또 센다. 다만 text 잡이 거의 늘 돌아 `hasActiveRoleJob` 으로 대개 건너뛴다.
  - `homeListSlugs` 는 부를 때마다 홈 목록 쿼리 3개를 돈다(monitor 의 `products … product_health … uptime_gates` 모양 6회는 0.5초 넘음, `slow-queries-primary.txt:50`).
- 실측 근거:
  - `slow-queries-primary.txt:4`: monitor 3,604회, 평균 4,601ms, 합계 16,580초.
  - `:11`: nomorevibe 647회, 평균 4,747ms, 합계 3,071초.
  - 합쳐서 느린 문장 전체 시간(122,852초)의 16%다.
  - 'reason'·'other' 두 문장은 앞부분(`WITH reason_eligible …`)이 같다. 'other' 는 끝의 `WHERE key<>'reason-translate'` 로 그 CTE 를 실제로는 돌리지 않는다. 그래서 느린 목록의 한 줄에 둘이 섞였을 수 있다(OPS-01 수정안 ①의 문장 꼬리표로 가린다).
- 수정 방안:
  1. **즉시(S)**:
     - 감시 프로세스 안에 사유 조각 결과를 5분 담는다(나이 함께 표시, 단계 판정은 그 값을 쓴다). `homeListSlugs` 도 5분 담는다.
     - 웹 콘솔·console-alerts 의 진행 읽기는 `readReplicaOnly` 로 복제본에서, 사유 조각은 TTL 5분으로 한다.
     - 감시 하루 약 2,000회가 약 290회로 준다.
  2. **근본(L, 구조 제안 S1)**: `reason_translation_sources(hash PK, first_at, last_at, ref)` 를 심사 기록·2차 사유 쓰기 트리거로 유지한다.
     - 진행은 `sources LEFT JOIN text_translations`(둘 다 hash 키) 색인 집계가 된다.
     - 같은 표를 reason-translate 잡의 선택(`untriedTranslations`·`retryableTranslations`)도 쓴다.
- 검증:
  - 감시 계정 `reason_eligible` 문장 수가 하루 300회 아래로 준다.
  - 단위 시험: 「캐시된 사유 조각 나이가 10분 미만이면 다시 읽지 않는다」.
- 배포 주의: ①은 monitor 별도 앱 재배포와 웹 배포다. ②는 마이그레이션(표·트리거) 뒤 백필을 id 범위 짧은 TX 묶음으로 한다. 그다음 읽는 쪽을 바꾼다.
- 확신도: CONFIRMED
  - 2차 검증: CONFIRMED. 감시는 `readWorkerProgress()` 의 includeText 기본값(포함)으로 이 집계를 부른다(`worker-progress-query.ts:477`, `failover-monitor.ts:69`).
  - 같은 TX 의 `SET LOCAL work_mem = '32MB'`(`text-stage-progress.ts:156`)는 서버 기본값 64MB(`pg-stats-primary.txt:102`)보다 낮다. 임시 파일로 흘릴 가능성은 db-queries DB-03 이 다룬다.
  - 「'reason'·'other' 가 한 줄에 섞였을 수 있다」는 맞다. `slowdigest.py` 가 정규화한 문장의 앞 420자로 묶기 때문이다.
    - 감시 루프 상한(시간당 약 100주기)보다 `:4` 가 많다(시간당 157). 그러니 섞였을 가능성이 높다.
    - 그렇다면 「하루 16,580초」는 두 문장의 합이다. 사유 조각만 담아 두는 수정안 ①의 절감은 그보다 작게 잡아야 한다.
- 규모: ① S · ② L

### OPS-05 console-alerts 10시간 무성공 — 알림이 멈춘 것이 아니라 틱마다 「셀 수 없음」(degraded)으로 끝난다

- 심각도: P2 (1차 P1 → 2차 검증에서 내림. 까닭: 운영 관측 detail 이 셀 수 없는 규칙을 「바꾼 뒤 처리량」 하나로만 적는다. 그러니 눈이 먼 것은 알림 묶음 전체가 아니라 「평소와 다름」의 그 규칙 하나와, 그 묶음의 열린 줄 닫기다. 「멈춤」 묶음은 지금도 열고 보낸다. 근본 원인(진행 읽기 실패)은 OPS-01·04 가 다룬다)
- 분류: logic
- 위치:
  - `lib/jobs/console-alerts.ts:27-36`
  - `lib/jobs/runner.ts:301-302`
  - `lib/operations/change-watch.ts:702,605,727`
  - `lib/operations/console-alerts.ts:139-149`
  - 아래 인용 순서:
    - `lib/jobs/console-alerts.ts:36` — 알림 묶음에 셀 수 없는 규칙이 있으면 degraded.
    - `runner.ts:302` — degraded 틱은 lastSuccessAt 을 옮기지 않는다.
    - `change-watch.ts:702` → `:605` → `:727` — 진행을 못 읽으면 `waitingUnread` → 할 일 null → 「평소와 다름」 셀 수 없음.
  ```ts
  if (unknown.length) return { done: true, cursor: null, degraded: { code: "console_tasks_unknown", detail: `셀 수 없음 · ${unknown.slice(0, 4).join(" · ")}` } };
  …
        ...(outcome.degraded ? {} : { lastSuccessAt: sql`now()` }), lastError: null, updatedAt: sql`now()`,
  …
    const progress = await readConsoleProgress().catch(() => null);
  …
      rows: rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(b.key) - Number(a.key)), ...(options.backlog === null ? { waitingUnread: true } : {}) };
  …
    return readChangeWatch(fresh).then(snapshot => snapshot.waitingUnread ? null : changeWatchTasksFrom(snapshot), () => null);
  ```
- 문제:
  - `jobs.txt` 에서 `last_error` 는 None 이고 `last_run_at` 은 최신이다. 그런데 `last_success_at` 은 13:49Z 에 멈춰 있다. 이 조합이 나오는 경로는 runner 의 degraded 완료뿐이다. 알림이 꺼져 있었다면 degraded 없이 성공으로 끝났을 것이므로 알림은 켜져 있다.
  - 알림 잡은 계속 돌고 있다.
    - 「멈춤」 묶음 중 conveyor 로 셀 수 있는 규칙(단계 멈춤·멈춘 작업·접수 중단 등)은 새 줄을 열고 내보낼 수 있다.
    - 셀 수 없는 묶음의 열린 줄은 닫지 않는다(`console-alerts.ts:146` uncertain).
    - 그 규칙 자체는 알림을 못 연다.
  - 가장 유력한 원인: maintenance 안의 `readWorkerProgress(includeText:true)` 실패. OPS-01 과 같은 3·10초 상한 문장이다. 이 실패가 다음 순서로 번진다.
    1. `readConsoleProgress` 실패
    2. change-watch 스냅숏 `waitingUnread`
    3. `changeWatchTasks` null
    4. `unknown("odd","바꾼 뒤 처리량")`
    5. odd 는 notify 묶음이라 degraded
  - 감시 계정 시간 초과가 같은 10시간에 몰린 것(OPS-01)과도 맞는다.
  - 그 밖 후보: 접수 상태(`capacityCache`)·한국어 탐색·내림 요청(inbox) 읽기 실패.
- 실측 근거: `jobs.txt:10` `console-alerts | 2488 | 23:54:41 | 13:49:44 | None`.
  - 2차 검증: 오케스트레이터가 `operations_observations` 를 읽었다(`evidence/orchestrator-checks.md`).
    - `job:console-alerts` degraded code=console_tasks_unknown, detail 「셀 수 없음 · 바꾼 뒤 처리량」, since 2026-11-20T13:54:49Z, streak 125, 틱 7.4초.
    - 「degraded 로 끝난다」와 그 끝점(`console-tasks.ts:541` `inputs.changeWatch === null`)이 확정됐다.
- 수정 방안:
  1. **확인**: `operations_observations` key `job:console-alerts` 의 `value.degraded.detail`(셀 수 없는 규칙 이름 최대 4개)과 `since`(시작 시각)를 읽는다. — 2차 검증 시점에 끝남(위 관측).
     - 남은 확인: `changeWatchTasks` 가 null 이 된 가지를 가린다(`change-watch.ts:726-727`).
       - 가지 하나는 `waitingUnread`(진행 읽기 실패)다. 다른 하나는 `readChangeWatch` 거절(복제본 TX 5초 등)이다. 둘 다 조용히 null 이 된다(`change-watch.ts:702` `.catch(() => null)`, `:727` `() => null`).
       - maintenance 로그의 `console.progress_unavailable`(errorName 포함, `console-home-read.ts:117`)이 13:54Z 무렵부터 틱마다 찍히는지 본다. 찍히면 앞 가지다.
  2. 「바꾼 뒤 처리량」 규칙은 대기 수가 없을 때 판정을 「줄었음 → 모름」으로만 바꾸게 한다. 지금처럼 묶음 전체를 셀 수 없음으로 만들지 않는다. 대기 수는 줄어든 판정(`judgeChange` 의 `flags.waiting`)에서만 쓰기 때문이다.
  3. `waitingUnread` 스냅숏은 담지 않는다(지금은 한 번의 진행 실패가 change-watch 공유 캐시에 60초~15분 남는다).
  4. degraded 가 30분 넘게 이어지면 운영센터 할 일(멈춤 묶음)로 올린다. 지금은 잡 관측에만 남는다.
- 검증:
  - 「진행 읽기 실패 + 변경 없음」 입력에서 `buildConsoleTasks` 의 odd.unknown 이 비는지 보는 시험(`tests/console-tasks.test.ts` 에 추가).
  - 운영: `job:console-alerts` degraded streak 이 끊기는지.
- 배포 주의: 일반 배포다(maintenance·웹).
- 확신도: 「degraded 로 끝난다」는 CONFIRMED(코드와 jobs 행). 「원인이 change-watch」는 PLAUSIBLE — 위 관측 detail 로 확인한다.
  - 2차 검증:
    - CONFIRMED — 「원인 규칙이 change-watch(바꾼 뒤 처리량)」. 관측 detail 이 확인해 준다.
    - PLAUSIBLE — 「그 까닭이 진행 읽기 실패」. 위 남은 확인으로 가린다.
    - 반증 시도: 알림이 꺼져 있었다면 `lib/jobs/console-alerts.ts:15-21` 에서 degraded 없이 끝났을 것이다. 그러니 알림은 켜져 있다. 셀 수 없는 묶음의 열린 줄을 닫지 않는 것은 `lib/operations/console-alerts.ts:146` 이다.
- 규모: S

### OPS-06 운영센터 `/admin/status` 가 10초마다 탭과 상관없이 주 DB 약 40문장을 캐시 없이 다시 읽는다

- 심각도: P2 (1차 P1 → 2차 검증에서 내림. 까닭: 실측에서 이 화면이 내는 문장이 0.5초를 넘은 것은 23시간에 12건뿐이다(`slow-queries-primary.txt:48` 11회, `:65` 1회). 운영자가 창을 열어 둘 때만 드는 비용이라 상시 영향이 확인되지 않았다)
- 분류: latency
- 위치:
  - `app/(operator)/admin/live-refresh.ts:26`(`intervalMs: 10_000, idleMs: 0`)
  - `app/(operator)/admin/status/render-reads.ts:9-15`(「페이지는 탭과 상관없이 모든 조각을 만든다 … 시간 캐시를 걸지 않는다」)
  - `app/(operator)/admin/status/attention.tsx:103-121`(loadActionInputs 병렬 읽기 — 세어 보면 20개)
  - `lib/operations/pipeline.ts:48-61`
  - 아래는 pipeline.ts:51-56 이다. 주 DB 에서 렌더마다 돈다. 운영 색인 목록에 `crawl_documents.fetched_at` 선두 색인·`crawl_candidates.judged_at` 색인은 없다.
  ```ts
    db.select({ state: crawlFrontier.state, count }).from(crawlFrontier).groupBy(crawlFrontier.state),
    db.select({ state: crawlCandidates.state, count }).from(crawlCandidates).groupBy(crawlCandidates.state),
    db.select({ count }).from(products).where(inArray(products.status, ["verified", "seeded"])),
    db.select({ count }).from(crawlFrontier).where(gte(crawlFrontier.discoveredAt, from)),
    db.select({ count }).from(crawlDocuments).where(gte(crawlDocuments.fetchedAt, from)),
    db.select({ count }).from(crawlCandidates).where(gte(crawlCandidates.judgedAt, from)),
  ```
- 문제:
  - `router.refresh()` 는 레이아웃까지 모든 서버 구성 요소를 다시 그린다. 근거: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md:46`.
  - 탭은 `history.replaceState` 로만 바뀐다(`status/OperationsCenter.tsx:49-50,78`). 그래서 보이지 않는 진단·흐름·크롤러 탭도 매번 서버에서 만들어진다.
  - 한 번 그릴 때 읽는 것:
    - `loadActionInputs`: 처리량 집계와 공개 제품×링크×근거 조인 포함
    - `pipelineFlow` 8문장: 1M 행 group by 2개와 색인 없는 24시간 count
    - 진단 패널의 `frontierCounts`·`candidateCounts`: 같은 group by 를 반복
    - `rejectionBreakdown`·`searchLogSummary`·`downProducts`·`manualCandidates`
  - 창 하나가 시간당 약 1.4만 문장을 만든다.
  - `withDeadline` 은 8초 뒤 그 조각만 포기하고 쿼리는 계속 돈다(`lib/operations/deadline.ts`). 그래서 다음 10초 갱신과 겹쳐 웹 풀(8)을 쥘 수 있고, 공개 요청도 같은 풀을 쓴다.
- 실측 근거:
  - `slow-queries-primary.txt:48`: `select "state", count(*)::int from "crawl_candidates" group by …` 11회, 평균 583ms.
  - `:65`: `decided_at` count 525ms.
  - `crawl_candidates` 전체 seq scan 1,403,437회(`pg-stats-primary.txt:9`).
- 수정 방안:
  1. 지금 탭만 서버에서 그리고, 탭을 바꿀 때 `router.refresh()` 한다.
  2. `loadActionInputs` 를 공유 캐시(ttl 10~15초, stale 60초)로 묶는다. conveyor 와 같은 방식이다.
  3. `pipelineFlow`·진단 읽기는 복제본에서 60초 공유 캐시로 한다(`dashboard.ts:144-147` 이 이미 그렇게 하는 까닭을 적어 둠).
  4. `candidateCounts`·`frontierCounts` 는 `pipelineFlow` 결과에서 만든다.
  5. 24시간 count 는 OPS-03 의 색인으로 받치거나 시간별 집계(`hourlyThroughput`)에서 읽는다.
- 검증: 창 하나를 열어 두고 10분 동안 주 DB `pg_stat_statements` 호출 수를 바꾸기 전과 뒤로 잰다(목표 1/5 이하). 또는 웹 풀 대기 경고(`DB_POOL_WAIT_TIMEOUT`) 수를 본다.
- 배포 주의: 웹 전용 변경이다. 관리자 TSX 는 자동 웹 전용 분류가 안 되므로(AGENTS.md) `scope`·`plan` 으로 범위를 확정한다.
- 확신도: CONFIRMED(하위 조사. 갱신 주기·render-reads 주석·pipelineFlow 쿼리는 본 점검자가 다시 읽음)
  - 2차 검증: 코드 기전은 CONFIRMED. `live-refresh.ts:26`, `render-reads.ts:11-13`, `OperationsCenter.tsx:49,78`, `deadline.ts:12-18`(읽기를 끊지 않음)를 확인했다. 「시간당 약 1.4만 문장」·「웹 풀 경합」은 창을 열어 둔 시간에 달려 있어 PLAUSIBLE 이다.
- 규모: M

### OPS-07 단계 처리량을 못 읽으면 「멈춤」 규칙이 셀 수 없음이 아니라 「멈춘 단계 없음」으로 판정한다(알림 미탐)

- 심각도: P2
- 분류: logic
- 위치: `lib/operations/console-tasks.ts:425-427`, `lib/operations/conveyor.ts:53`, `lib/operations/conveyor-model.ts:247,255`(2차 검증: `waiting: stage?.waiting ?? null` 은 255줄)
  ```ts
  if (!inputs.conveyor) unknown("stop", "단계 처리");
  for (const station of inputs.conveyor?.stations ?? []) {
    if (!QUEUE_STATIONS.has(station.key) || !station.waiting) continue;   // waiting === null 도 건너뜀
  ```
- 문제:
  - conveyor 의 `pipelineThroughput(settings).catch(warn)` 가 실패하면 conveyor 는 그대로 만들어진다. 이때 각 칸의 `waiting` 은 `stage?.waiting ?? null` 로 null 이다.
  - 규칙은 `!station.waiting` 으로 null 을 0 처럼 건너뛴다.
  - `inputs.conveyor` 가 null 이 아니므로 「셀 수 없음」도 붙지 않는다. 그래서 처리량 집계가 3초 상한에 걸린 틱(OPS-03)에는 단계가 실제로 멈춰도 알림이 열리지 않고 degraded 도 되지 않는다.
- 실측 근거: 코드 근거만(처리량 집계 3초 상한은 `throughput.ts:62`).
- 수정 방안: `station.waiting === null` 이면 `unknown("stop", \`${station.label} 대기\`)` 한다. `!station.waiting` 은 `station.waiting === 0` 일 때만 건너뛴다.
- 검증: `tests/console-tasks.test.ts` 에 「throughput null → stop.unknown 에 단계 대기」 시험을 넣는다.
- 배포 주의: 일반 배포다.
- 확신도: CONFIRMED(시험에 null 사례가 없음을 확인)
- 규모: S

### OPS-08 워커(maintenance)에서 공유 캐시의 stale-while-revalidate 를 써 알림이 지난 값으로 판정되고, 무거운 읽기가 틱 밖에서 돈다

- 심각도: P2
- 분류: async / non-standard
- 위치:
  - `lib/operations/shared-cache.ts:92-96`
  - `lib/cache/shared.ts:5`(「Valkey 가 없거나(워커·로컬)」)
  - `lib/operations/console-progress-read.ts:11`(ttl 30s·stale 300s)
  - `lib/operations/change-watch.ts:718`(stale 15분)
  - `lib/operations/console-home-read.ts:40-46`(ledger stale 600s 등)
  - `lib/jobs/console-alerts.ts:27`
  ```ts
  if (best && staleMs && best.keepUntil > clock()) {
    if (!pending.has(key)) start(key, load).catch(() => undefined);   // 기다리지 않고 지난 값을 돌려준 뒤 뒤에서 다시 센다
    return best.value;
  }
  ```
- 문제:
  - 워커에는 Valkey 가 없어 캐시가 프로세스 안에만 있다. 5분마다 도는 알림 틱은 직전 틱이 뒤에서 센 값을 받는다. 진행 값은 최대 5.5분, 장부는 10분, change-watch 는 15분까지 지난 값이다. 그러니 판정이 한 틱 늦는다.
  - 다시 세기(사유 집계 TX 5~9초, 처리량·근거 TX, conveyor)는 잡이 `done` 을 돌려준 뒤에도 lease·틱 예산·abort 신호 밖에서 계속 돈다.
  - maintenance 잡은 모두 main 줄 하나로 차례로 돌고(`lanesForRole`, catalog 에 lane 없음) 풀은 3개다. 그래서 뒤이어 도는 `uptime-ping`·`model-capacity-reclaim`(1분)이 연결을 기다리다 5초 풀 대기에 걸릴 수 있다.
- 실측 근거: 코드 근거만.
- 수정 방안: 워커 경로(`readConsoleHome` 을 부르는 console-alerts)는 stale 없이 읽는다. `sharedLoader` 에 `{ allowStale: false }` 호출 옵션을 주거나 워커에서는 `fresh=true` 로 부른다. 다시 세기를 틱 안에서 기다리게 하고, 틱 예산(`ctx.hasBudget`) 안에서 끝나지 않으면 그 규칙을 「셀 수 없음」으로 둔다.
- 검증: `tests/console-alerts.test.ts` 에 「틱이 끝난 뒤 남은 미결 promise 0」 시험을 넣는다(가짜 loader 로 확인).
- 배포 주의: 일반 배포다.
- 확신도: CONFIRMED(캐시 동작). 풀 경합 피해는 PLAUSIBLE — maintenance 로그의 `DB_POOL_WAIT_TIMEOUT` 으로 확인한다.
- 규모: S

### OPS-09 배포 관문이 같은 진행 집계를 한 번 볼 때 두 번 돌리고, 시간 초과를 처리하지 않아 감시 계정 연결 상한(2)을 넘길 수 있다

- 심각도: P2
- 분류: concurrency / inefficiency
- 위치:
  - `scripts/ops/deploy_shared_images.py:742-753`(REMOTE_MONITOR)
  - `:1136-1162`(monitor_gate)
  - `:135`(`MONITOR_POLL_SECONDS = 3`)
  - `:1118-1119`
  ```python
  for name in ('check-failover-readiness.ts','check-worker-progress.ts'):
   result=subprocess.run(['docker','exec',ids[0],'node','--import','tsx','scripts/'+name], capture_output=True,text=True,timeout=35)   # TimeoutExpired 미처리
  ```
- 문제:
  1. `check-failover-readiness.ts` 는 이미 `readMonitorStatus` 로 진행(`progress.overall`)까지 다 센다. 그런데 관문은 이어서 `check-worker-progress.ts` 로 같은 집계를 한 번 더 돈다. 사유 집계 포함이고, 연결 1개라 직렬이다. 관문이 기다리는 동안 이것을 3초 간격으로 되풀이한다.
  2. `subprocess.run(timeout=35)` 의 `TimeoutExpired` 를 잡지 않는다. Python 은 `docker exec` 클라이언트만 죽이고, 컨테이너 안 node 프로세스는 남는다(docker exec 은 클라이언트가 끊겨도 실행 중인 프로세스를 죽이지 않는다).
  3. monitor 계정 연결 상한은 2인데, 상시 감시 프로세스가 연결 1개를 쥐고 있다. 그러니 남은 스크립트와 다음 폴링 스크립트가 겹치면 `too many connections for role` 이 난다. 그 결과 모든 조각이 실패해 unknown 이 되고 관문이 막힌다.
- 실측 근거: 코드 근거만(배포 창의 감시 계정 연결 수·오류 문구로 확인).
- 수정 방안:
  - 관문은 `check-failover-readiness.ts` 하나만 돌려 `readiness` 와 `progress.overall` 을 함께 읽는다.
  - REMOTE_MONITOR 는 `TimeoutExpired` 를 잡아 `{'overall':'unknown','error':'timeout'}` 으로 적는다.
  - 남은 프로세스를 막으려면 `docker exec … timeout 30 node …` 처럼 컨테이너 안에서 시간 상한을 건다.
  - 폴링 간격은 15초로 늘린다.
- 검증: 배포 도구 단위 시험(`scripts/ops` 의 gate_verdict 시험)에서 단일 보고서로 판정하는지 본다. 배포 창에 `pg_stat_activity` 의 monitor 계정 연결이 2를 넘지 않는지 본다.
- 배포 주의: 배포 도구 파일을 바꾼다. 실행 폴더 checkout 권한(umask 022)을 확인한다(plan observer_source_group_writable 함정).
- 확신도: ①은 CONFIRMED. ②·③은 PLAUSIBLE — docker exec 의 남은 프로세스는 배포 창의 `docker top`·연결 수로 확인한다.
- 규모: S

### OPS-10 text 단계 upstream_stalled 오탐 — 재시도 상한이 없는 사유 번역의 「안 되는 한 건」이 5분 무완료 때마다 경보가 된다

- 심각도: P2
- 분류: logic
- 위치:
  - `lib/operations/worker-progress.ts:121-130`
  - `lib/operations/text-stage-progress.ts:52-57,139-142`
  - `lib/crawl/translations.ts:155-158`(「최대 하루」 재시도, 상한 없음)
  ```ts
  const errors = Math.max(stage.providerErrors ?? 0, stage.errors5m ?? 0) + (job?.lastError ? 1 : 0);
  else if (stage.waiting === 0 && !deferred) reason = ... "no_work";
  else if ((stage.progress5m ?? stage.completed5m) > 0) reason = "progressing";
  else if ((stage.providerErrorMinutes ?? stage.oldestMinutes ?? 0) >= 30 && errors > 0) reason = "upstream_stalled";  // deferred 만 남아도 여기 온다
  ...
  else if (stage.waiting === 0 && deferred > 0) reason = "backoff";   // 위에서 먼저 걸려 닿지 않는다
  ```
- 문제:
  - reason-translate 의 실패 행은 `blocked` 가 늘 false 다. 재시도는 상한 없이 최대 하루 간격이다.
  - 대기열이 다 빠지고 늘 실패하는 사유 몇 건(deferred)만 남았다고 하자. 그때 5분 동안 완료가 0이면 `upstream_stalled` 가 된다.
    - `providerErrors` 는 failure_at 이 있고 ready 또는 deferred 인 건수다.
    - `providerErrorMinutes` 는 그 중 가장 오래된 실패 시각부터 잰다.
  - 결과: alarm, 감시 overall alarm, Kuma DOWN, 배포 관문 `progress=alarm`. 하트비트 `providerFailures` 를 거쳐 Oracle 30분 경보까지 간다.
  - 주석(:125)의 의도는 공급자 장애(모든 호출 실패)를 잡는 것이다. 「안 되는 한 건」과 장애를 가르지 못한다.
  - product-translate 는 시도 상한을 넘으면 blocked 로 빠지므로 해당하지 않는다.
- 실측 근거: 코드 근거만(새벽 등 대기열이 빈 시간대의 감시 alarm 기록으로 확인).
- 수정 방안: deferred 만 남은(waiting=0) text 단계는 최근 30분 안에 실패가 있을 때만 `upstream_stalled` 로 한다. 즉 `failure_at > now-30min` 건수를 따로 센다. 장애라면 5·10·20분 재시도가 계속 최근 실패를 만들므로 계속 잡힌다. 또는 사유 번역에도 시도 상한(blocked)을 둔다.
- 검증: `tests/worker-progress*.test.ts` 에 「waiting 0·deferred 1·마지막 실패 3시간 전 → backoff」, 「deferred 20·최근 5분 실패 → upstream_stalled」 시험을 넣는다.
- 배포 주의: 감시(별도 앱)·역할·웹이 같은 함수를 쓴다. 감시 재배포도 잊지 않는다.
- 확신도: PLAUSIBLE(판정 경로는 확인. 실제로 대기열이 비는 시간대가 있는지 운영 기록이 필요)
- 규모: S

### OPS-11 `/admin/models`(15초 갱신)가 한 번 그릴 때 용량 스냅숏을 두 번, 캐시 없이 주 DB 에서 읽는다

- 심각도: P2
- 분류: latency / inefficiency
- 위치: `lib/operations/model-unified-read.ts:26-28`(`readModelConsole()` 이 안에서 `readAdminModelsObservation` 을 또 부름, `model-console-read.ts:70`), `lib/operations/llm-ops-read.ts:101-104`
  ```ts
  const [models, tasks, executions, observation, jobs, ...] = await Promise.all([
    readModelConsole(), readAiTasksAdminView({ readOnly: true }), readAiTaskExecutionAdminViews().catch(() => null),
    readAdminModelsObservation({ throughput: false }).catch(() => unavailableAdminModels()), readJobPauses(now.getTime()), ...
  ```
- 문제:
  - 스냅숏 하나는 repeatable read TX 4~5문장이다(24시간 `model_capacity_requests` + `model_capacity_events` 상관 서브쿼리).
  - 15초마다 두 번 돈다. `readAiTaskExecutionAdminViews`·`listJobStates` 도 겹친다.
  - `/admin/models/dashboard`·`/llm`·`/history`·`/devices`·`/helpers` 도 캐시 없이 부른다. 홈은 같은 읽기를 15초 공유 캐시(`console-home-read.ts:42`)로 쓰고 있다.
- 실측 근거: 코드 근거만(스냅숏 0.2초는 `admin-models-repository.ts:35-36` 주석).
- 수정 방안: 렌더 안에서는 React `cache()` 로 한 번만 읽는다. 화면 사이에서는 홈의 `capacityCache` 같은 15초 공유 캐시를 함께 쓴다.
- 검증: 렌더 한 번에 `readAdminModelsObservation` 이 1회만 불리는지 보는 시험(mock 호출 수).
- 배포 주의: 웹 전용이다(scope·plan 으로 확인).
- 확신도: CONFIRMED(하위 조사. 중복 호출 줄은 본 점검자가 확인)
- 규모: S

### OPS-12 메뉴 배지가 관리자 창 하나만 열려 있어도 30초마다 운영센터 입력 전체(약 28문장)를 다시 세고, `attentionCounts` 는 products 를 8번 훑는다

- 심각도: P2
- 분류: inefficiency
- 위치:
  - `app/(operator)/admin/AdminShell.tsx:49-61`(renderedAt 이 바뀔 때마다 `/admin/nav-badges` fetch)
  - `app/(operator)/admin/status/attention.tsx:803,816-829`(sharedStale ttl 30s → `loadActionInputs` 전체)
  - `lib/operations/dashboard.ts:421-`(`attentionCounts` 의 products 서브쿼리 여러 개)
  ```ts
  const badgeCounts = sharedStale<ActionBadgeCounts>({ namespace: "admin:action-badge", ttlMs: 30_000, staleMs: 5 * 60_000, store: sharedStore });
  ... const inputs = await loadActionInputs(await getSettings());   // 숫자 두 개(critical·hold)를 얻으려고 전체 입력
  ```
- 문제:
  - 어느 관리자 화면이든 `router.refresh` 때마다 레이아웃의 `renderedAt` 이 바뀐다. 그때마다 배지를 fetch 한다.
  - 30초가 지났으면 웹 한 대가 `loadActionInputs` 전체를 다시 센다(처리량 집계 포함, OPS-03).
  - `attentionCounts` 는 복제본에서 공개 제품 조건 서브쿼리를 약 8개 따로 돈다. 호출하는 곳은 운영센터 10초, 배지 30초, inbox 30초다.
- 실측 근거:
  - `pg-stats-replica.txt:4`: 복제본 `products` seq scan 66,580회. 하위 조사의 추정(운영센터 창 하나 × 8 × 360/h)과 같은 크기다.
  - 단, 근거 파일의 통계 기준 시각이 분명하지 않아 PLAUSIBLE 이다.
- 수정 방안:
  - 배지는 critical·hold 수만 세는 전용 읽기로 바꾸거나 TTL 을 2~5분으로 한다.
  - `attentionCounts` 는 products 한 번 훑기의 `count(*) FILTER (…)` 로 합치고 60초 공유 캐시를 둔다.
- 검증: 복제본 `products` seq_scan 증가율, `admin:action-badge` 재계산 로그 빈도.
- 배포 주의: 웹 전용이다.
- 확신도: CONFIRMED(배지 경로는 본 점검자가 확인). 복제본 seq scan 몫은 PLAUSIBLE.
- 규모: S

### OPS-13 공유 캐시 두 개에 stale 이 없어 30초마다 화면이 다시 세기를 기다리고, 웹 두 대가 같은 값을 동시에 다시 셀 수 있다

- 심각도: P2
- 분류: latency
- 위치:
  - `lib/operations/shared-reads.ts:15-16`(`overviewCache` — staleMs 없음)
  - `lib/operations/inbox.ts:293`(`inboxCache` — staleMs 없음)
  - `lib/operations/shared-cache.ts:54-72`(진행 중 표시가 프로세스마다 따로라 함대 전체의 `:computing` 표시가 없음)
- 문제:
  - 사람 확인 대기 개요는 needs_review 전체에 `crawl_review_attempts` DISTINCT ON 을 더한 것이다. inbox 는 16개 병렬 읽기다.
  - 둘 다 만료 때마다 운영센터 첫 그림(`Promise.all`)·흐름 홈·inbox 가 다시 세기를 기다린다.
  - `sharedLoader` 는 `sharedStale` 과 달리 웹들 사이에 「세는 중」 표시가 없다. 그래서 요청이 두 웹에 번갈아 닿으면 무거운 loader(진행 5초 넘음·conveyor·capacity)를 두 대가 동시에 셀 수 있다.
- 실측 근거: 코드 근거만.
- 수정 방안: 두 캐시에 `staleMs` 를 준다(conveyor·change-watch 와 같이). 1초 넘게 걸리는 loader 는 `sharedStale.claim` 같은 Valkey 표시로 한 대만 센다.
- 검증: 운영센터·흐름 첫 그림 시간(서버 timing 로그), Valkey 값의 `measuredAt` 중복 여부.
- 배포 주의: 웹 전용이다.
- 확신도: 앞부분은 CONFIRMED. 「두 웹 동시 재계산」은 PLAUSIBLE.
- 규모: S

### OPS-14 LLM 운영 화면에서 연결의 동시 실행 한도를 저장하면 장비의 엔진 최대치(physicalLimit)가 같은 값으로 덮인다

- 심각도: P2
- 분류: logic
- 위치:
  - `lib/operations/admin-engine-limits.ts:89-91`
  - 진입: `app/(operator)/admin/models/tasks/ConnectionForm.tsx:58` → `models/devices/actions.ts:30`
  - 대조: `lib/operations/admin-capacity-device-row-save.ts:13`
  - 아래는 admin-engine-limits.ts:89-91 이다. `physicalLimit: limitSlots` 가 엔진 최대치를 칸 수로 덮는다.
  ```ts
      const next = { deviceId, limitSlots, physicalLimit: limitSlots,
        secondaryCap: Math.min(current.secondaryCap, limitSlots), reserveSlots: Math.min(current.reserveSlots, limitSlots - 1),
        idleMs: current.idleMs, roles: current.roles, note: current.note };
  ```
- 문제:
  - 11-09 장비 한도 표 개편은 이 동작을 고쳤다. 주석에 「옛 공유 한도 폼은 엔진 최대치도 같은 값으로 덮었다 — M3 는 공유 2, 엔진 최대 합 5 라 그러면 안 된다」고 적혀 있다.
  - 그런데 LLM 운영 화면의 연결 폼 경로는 아직 덮는다. 시나리오:
    1. 장비 한도가 2, 엔진 최대치가 8이다.
    2. 연결 폼에서 3으로 올리면 엔진 최대치가 3이 된다.
    3. 나중에 장비 표에서 4로 올리면 `limit_exceeds_physical` 로 거절된다.
  - 엔진 최대치가 「모름」(null)이던 장비에는 지어낸 값이 들어간다.
- 실측 근거: 코드 근거만.
- 수정 방안: `current.physicalLimit` 을 그대로 두고, `limitSlots > physicalLimit` 이면 거절한다(장비 줄 저장과 같은 규칙).
- 검증: `tests/integration/admin-capacity-devices*` 에 「연결 폼 저장 뒤 physicalLimit 불변」 시험을 넣는다.
- 배포 주의: 웹이다. 운영 중 이미 덮인 장비가 있는지 `model_capacity_devices.physical_limit = limit_slots` 행을 감사 로그(`엔진 최대치:` 변경 줄)와 대조해 되돌릴지 결정한다.
- 확신도: CONFIRMED(하위 조사. 줄은 본 점검자가 확인)
  - 2차 검증: CONFIRMED. 경로를 끝까지 따라갔다.
    - `ConnectionForm.tsx:58` 이 `formMode=shared-limit` 를 싣는다.
    - `devices/actions.ts:25,30` 이 그것을 `saveEngineSharedLimit` 으로 보낸다.
    - 그 함수가 `:89` 에서 덮어쓴다.
    - 장비 줄 저장은 `lib/operations/admin-capacity-device-row-save.ts:78` 에서 `physicalLimit: current.physicalLimit` 를 지킨다.
    - 시나리오 3단계의 거절은 `lib/llm/capacity-devices.ts:108` 의 `limit_exceeds_physical` 이다.
- 규모: S

### OPS-15 운영 콘솔 홈 한 번에 처리량 집계 2번·잡 목록 3번을 세고, 화면용 진행 읽기를 주 DB 에서 한다

- 심각도: P2
- 분류: inefficiency
- 위치:
  - `lib/operations/console-home-read.ts:115-137`
  - `lib/operations/conveyor.ts:48-89`(`pipelineThroughput(settings)` 와 `buildWorkerProgress` 를 스스로 계산)
  - `lib/operations/console-progress-read.ts:14`(`readWorkerProgress(new Date(), …)` — 처리량 다시 계산, 주 DB)
- 문제:
  - 홈은 conveyor(처리량·잡·관측으로 진행을 만듦)와 콘솔 진행(`readWorkerProgress`, 처리량·잡·관측·근거·text 를 다시 셈)을 따로 부른다. 그래서 처리량 집계가 두 번 돈다(`now` 를 넘겨 프로세스 안 묶기도 건너뜀).
  - `listJobStates`(cursor jsonb 포함 전체 잡 행)는 홈·conveyor·진행이 세 번, `getSettings` 도 세 번 읽는다.
  - 화면용 진행은 관문과 달리 복제본으로 충분하다. 그런데 `readWorkerProgress` 가 `db`(주)를 고정으로 쓴다.
- 실측 근거: 코드 근거만(OPS-04 의 nomorevibe 647회 중 일부).
- 수정 방안:
  - `readWorkerProgress` 에 executor·`throughput` 주입 인자를 둔다. 홈은 conveyor 의 처리량을 넘겨 한 번만 센다.
  - 화면 경로는 `readReplicaOnly` 로 부른다.
  - 같은 렌더 안의 `listJobStates`·`getSettings` 는 React `cache()` 로 한 번만 읽는다.
- 검증: 홈 렌더 1회에 처리량 SQL 1회만 도는지 보는 시험(mock 호출 수).
- 배포 주의: 웹·maintenance(console-alerts 가 같은 읽기를 씀)다.
- 확신도: CONFIRMED
- 규모: S

### OPS-16 장비 「새로 만들기」(빈 판)는 버전 확인 없이 같은 id 의 기존 장비를 덮어쓰고 다시 켠다

- 심각도: P3
- 분류: concurrency
- 위치: `lib/llm/capacity-devices-repository.ts:88,95-99`, `lib/operations/admin-capacity-device-row-save.ts:67-80`
  - 아래는 capacity-devices-repository.ts:88, 95-97 이다. `expectedVersion` 이 null 이면 판 확인 없이 upsert 하고 `enabled: true` 로 다시 켠다.
  ```ts
    if (expectedVersion !== null && current !== expectedVersion) fail(`model_capacity_device_version_mismatch:${current ?? "none"}`);
  …
    const [saved] = await tx.insert(modelCapacityDevices).values({ deviceId: settings.deviceId, ...values, enabled: true })
      .onConflictDoUpdate({ target: modelCapacityDevices.deviceId,
        set: { ...values, enabled: true, version: sql`${modelCapacityDevices.version} + 1`, updatedAt: sql`clock_timestamp()` } }).returning();
  ```
- 문제:
  - 새 장비 폼은 자유 입력 deviceId 에 `expectedVersion=""` 를 보낸다. 기존 id 를 적으면 다음이 모두 바뀐다.
    - 역할 줄 전부를 지운다.
    - physicalLimit 을 null 로 만든다.
    - 유휴 시간·예약·메모를 덮는다.
    - 꺼 둔 장비를 다시 켠다.
  - 장비 줄 저장도 잠금 없이 존재를 확인한 뒤 null 로 저장한다. 그래서 순위 저장이 그 사이에 만든 행을 덮을 수 있다.
  - 시험(`tests/integration/admin-capacity-devices.test.ts:152`)은 이것을 의도로 고정해 둔다. 그러나 형제 경로 `admin-ai-tasks-repository.ts:1030-1034` 는 「다른 저장이 만든 행을 덮지 않는다」고 잠근 뒤 다시 확인한다.
- 실측 근거: 코드 근거만.
- 수정 방안: null 은 「없어야 함」으로 해석한다. 행이 있으면 실패시킨다. 덮어쓰기가 정말 필요한 경로는 명시적인 플래그를 따로 둔다.
- 검증: 위 통합 시험을 「빈 판 + 기존 행 → 거절」로 바꾼다.
- 배포 주의: 일반 배포다.
- 확신도: CONFIRMED
- 규모: S

### OPS-17 수집 설정 「기본값으로 되돌리기」가 버전을 비교하지 않고, 공급원 버퍼 스위치를 그 스위치 전용 경로 없이 끈다

- 심각도: P3
- 분류: concurrency / logic
- 위치: `app/(operator)/admin/actions.ts:307-311`, `lib/crawl/settings.ts:658-671`
  - 아래는 lib/crawl/settings.ts:658-670 이다. `saveSettings` 에 `expectedFormVersion` 을 넘기지 않는다. `resetPatch` 는 `enabled`·`discover.feeds` 만 뺀다. 그래서 `discover.sourceBuffer` 는 기본값(`{ enabled: false }`, `lib/crawl/settings-schema.ts:687`) 그대로 패치에 실린다.
  ```ts
  export async function resetSettings(updatedBy: string): Promise<SaveResult> {
    return saveSettings(resetPatch(), updatedBy);
  }
  …
    const defaults: Partial<CrawlSettings> = { ...DEFAULT_CRAWL_SETTINGS };
  …
    delete defaults.enabled;
  …
    const discover: Partial<CrawlSettings["discover"]> = { ...DEFAULT_CRAWL_SETTINGS.discover };
    delete discover.feeds;
    return { ...defaults, discover: discover as CrawlSettings["discover"] };
  ```
- 문제:
  - 확인 창이 보여 주는 「되돌릴 변경」은 화면을 그린 때의 값이다. 그 뒤에 다른 곳에서 바뀐 설정(예: 발행 관문 `agentEvidence.enforceEligibility`)도 보이지 않은 채 되돌려진다.
  - `discover.sourceBuffer` 는 전용 경로(기대값·사유·`source-buffer` 감사)가 있는 스위치다. 그런데 기본값 `{enabled:false}` 로 함께 덮인다.
- 실측 근거: 코드 근거만.
- 수정 방안: 되돌리기 폼에 `settingsFormVersion` 을 실어 `expectedFormVersion` 으로 넘긴다. `discover.sourceBuffer` 는 `enabled` 처럼 `resetPatch` 에서 뺀다.
- 검증: 「렌더 뒤 다른 저장 → 되돌리기 거절」 통합 시험.
- 배포 주의: 웹이다.
- 확신도: CONFIRMED(하위 조사. 줄은 본 점검자가 확인)
- 규모: S

### OPS-18 엔진 연결(`connectAdminEngine`)이 잠그지 않고 읽은 설정으로 `stageModelPools` 전체를 버전 비교 없이 다시 쓴다

- 심각도: P3
- 분류: concurrency
- 위치: `lib/operations/admin-engine-connect.ts:207-231`(`getSettings()` 로 `pools` 를 만든 뒤 별도 TX 를 지나 `saveSettings(patch, actor)`)
- 문제:
  - 주석(:223)에는 「own version check」라고 적혀 있다. 그런데 실제로는 `expectedFormVersion` 을 넘기지 않는다.
  - 그 사이에 들어온 단계 모델 저장은 `applyPatch` 가 `stageModelPools` 를 통째로 바꾸면서 사라진다.
  - 창은 좁다(레지스트리·계약 TX 시간).
- 실측 근거: 코드 근거만.
- 수정 방안: `expectedFormVersion: settingsFormVersion(settings)` 를 넘기고, 오래된 값이면 오류로 보인다.
- 검증: 통합 시험 「연결 중 단계 저장이 끼면 연결 쪽이 stale 오류」.
- 배포 주의: 웹이다.
- 확신도: CONFIRMED(하위 조사)
- 규모: S

### OPS-19 알림 설정 저장이 동시 변경을 TX 밖에서 비교하고, 거절·충돌 실패의 작업 로그 남기기가 경로마다 다르다

- 심각도: P3
- 분류: concurrency
- 위치: `app/(operator)/admin/alerts/actions.ts:24-27`, `lib/operations/console-alerts-store.ts:27-32`
  ```ts
  const current = await readConsoleAlertSettings();
  if ((current.at ?? null) !== (input.basedOn ?? null)) return { error: '그 사이 다른 곳에서 …' };
  ...
  await saveConsoleAlertSettings(current.settings, after, admin.login);   // 잠금·재확인 없이 새 감사 줄 insert
  ```
- 문제:
  - 같은 `basedOn` 에서 출발한 두 탭이 모두 비교를 통과하고 모두 insert 한다. 나중 id 가 이기는데 둘 다 「저장했습니다」를 받는다.
  - 실패 기록도 경로마다 다르다.
    - 실시간 한도·수집 설정은 거절을 `ok=false` 감사 줄로 남긴다.
    - AI 연결·순위·assist·장비·모델 한도·경로 몫은 던지고 되돌려 거절이 작업 로그에 없다.
- 실측 근거: 코드 근거만.
- 수정 방안: 저장 TX 안에서 `pg_advisory_xact_lock(hashtext('console-alert-settings'))` 를 잡고, 마지막 줄을 다시 읽어 비교한 뒤 insert 한다. 거절 감사는 `adminAuditRow(..., ok:false)` 를 공통 래퍼로 맞춘다.
- 검증: 동시 저장 통합 시험.
- 배포 주의: 웹이다.
- 확신도: CONFIRMED(하위 조사. 줄은 본 점검자가 확인)
- 규모: S

### OPS-20 감시·관문 읽기가 쓰지 않는 칸까지 센다 — 응답 점검 readback 의 부가 칸, `operations_observations` 전체

- 심각도: P3
- 분류: inefficiency
- 위치:
  - `lib/operations/uptime-split-repository.ts:44-58`(`missingRows`·`outcomes1h`·`applied1h`·`confirm`)
  - `lib/operations/uptime-split.ts:183-194`(단계 입력은 queue due·submitted·applied5m·control·breakers·maintenanceOwner 만 씀)
  - `lib/operations/worker-progress-query.ts:471-472`(관측 표 전체)
- 문제:
  - readback 한 번에 uptime_claims 를 4번 훑고 products 와 anti-join 을 한다. 그중 단계 판정에 쓰는 것은 queue 하나다.
  - 관측 읽기는 jsonb 2,585행 전체를 매번 가져온다. 실제로 쓰는 것은 `service:`·`candidate:`·`job:`·`agent-scan:` 키 일부다.
- 실측 근거: `pg-stats-primary.txt:17`(uptime_claims seq scan 552,150), `:30`(operations_observations seq scan 150,934, 회당 2,500행).
- 수정 방안: 관문용 `readUptimeSplitStageReadback`(queue·control·breakers·owner 만)을 따로 둔다. 운영 상태 화면은 지금 readback 을 쓴다. 관측 읽기는 쓰는 키 접두어로 거른다(`key LIKE ANY(...)`).
- 검증: EXPLAIN 에서 uptime_claims 스캔 1회.
- 배포 주의: 일반 배포 + monitor 앱이다.
- 확신도: CONFIRMED
- 규모: S

### OPS-21 Oracle watchdog 은 장부 미확정 읽기 「unknown」 한 표본으로 바로 경보다(다른 경보는 2표본)

- 심각도: P3
- 분류: logic
- 위치: `scripts/ops/oracle_watchdog.py:257-273`
  ```python
  observed_unknown = capacity is not None and capacity['status'] == 'unknown'
  ...
  if observed_unknown or capacity_alarm(capacity):
      alarm = True
  ```
- 문제:
  - 감시는 `readModelCapacityUnknowns` 가 3초 상한·풀 대기로 한 번만 실패해도 `unknownCapacityReport()` 를 적는다(`model-capacity-unknowns.ts:115`).
  - watchdog 은 그 한 표본으로 바로 incident(Kuma down)를 민다. 단계 고장·서비스 bad 는 연속 2표본을 요구한다(`:235`, `:252`, `:284` — 2차 검증에서 `samples >= 2`·`bad >= 2` 줄로 고침).
  - Telegram 알림은 unknown 을 빼므로(`incident_notifications.py:375`) 소음은 Kuma 쪽에서 난다.
- 실측 근거: 코드 근거만.
- 수정 방안: capacity unknown 도 2표본 연속일 때만 alarm 으로 한다. 지난 값은 지금처럼 이어 쓴다.
- 검증: `tests` 의 oracle_watchdog 파이썬 시험에 「unknown 1회 → ok, 2회 → alarm」을 넣는다.
- 배포 주의: Oracle 호스트의 watchdog 서비스 갱신(oracle-recovery-runbook)이다.
- 확신도: PLAUSIBLE(의도된 엄격함인지 운영자 확인 필요. 주석은 「지난 값을 지우지 않는다」만 말한다)
- 규모: S

### OPS-22 공개 `/api/health` 가 요청마다 주 DB 에 2문장(캐시 없음)

- 심각도: P3
- 분류: inefficiency
- 위치: `app/api/health/route.ts:21-32`, `lib/operations/health.ts`(`schemaReadiness`: `select max(created_at) from drizzle.__drizzle_migrations`)
- 문제:
  - Cloudflare 를 지나는 공개 요청도 `select 1` 과 마이그레이션 표 조회를 매번 한다. 크롤러·외부 감시가 두드리면 웹 풀(8)을 함께 쓴다.
  - 마이그레이션 상태는 배포 사이에만 바뀐다.
- 실측 근거: 코드 근거만.
- 수정 방안: `schemaReadiness` 의 `'ok'` 결과를 프로세스 안에 60초 담는다(pending·unverified 는 담지 않는다). 공개 요청에는 5초 안의 직전 결과를 준다.
- 검증: 부하 시험에서 health 1,000회당 DB 문장 수.
- 배포 주의: 웹이다. 배포 도구의 직접 요청 판정(`directServerRequest`)은 그대로 둔다.
- 확신도: CONFIRMED
- 규모: S

### OPS-23 심사 큐 `/admin/review` 가 갱신마다 1M 행 표의 전체 count 와 OFFSET 쪽 매김을 한다

- 심각도: P3
- 분류: latency
- 위치: `lib/crawl/admin-review.ts:561-562`(`count(*)`, `?page=N` OFFSET), `app/(operator)/admin/review/page.tsx:54`(사람 큐 개요 직접 계산)
- 문제:
  - `tab=all` 이면 `crawl_candidates` 1M 행을, rejected 도 거의 그만큼을 갱신마다 센다(30~60초).
  - 사람 큐 개요를 직접 세는 것은 「결정 직후 수가 맞아야」 하는 의도다(`shared-reads.ts:12-13`). 그런데 자동 갱신까지 그 비용을 낸다.
- 실측 근거: 코드 근거만.
- 수정 방안: 자동 갱신은 공유 개요를, 결정 직후·수동 새로고침만 직접 읽기를 쓴다. all·rejected 총수는 추정치(`pg_class.reltuples` 비율)나 60초 캐시로 한다.
- 검증: 심사 큐 창 하나를 열어 둔 상태의 주 DB 문장 수.
- 배포 주의: 웹이다.
- 확신도: CONFIRMED(하위 조사. 의도 주석은 본 점검자가 확인)
- 규모: S

## 감시·진행 쿼리의 주기와 비용 (추적 결과)

| 호출자 | 주기 | 계정·DB | 부르는 것 | 비고 |
|---|---|---|---|---|
| 감시 `watch-failover-readiness` | 30초 대기 + 실행(약 40초) | monitor, 주, **연결 1** | readiness 2 · readWorkerProgress(text 포함) · 장부 미확정 TX · 모드 1 · 알림 줄 1 | 사유 집계 4.6초, 하루 약 2,000회(OPS-01·04) |
| 배포 관문 REMOTE_MONITOR | 3초 + 실행, 관문 동안 | monitor, 주 | 위 전체 + readWorkerProgress 한 번 더 | OPS-09 |
| 역할 감독 checkProgress | **15초** × 주 역할(3~5) | nomorevibe, 주 | readWorkerProgress(text 없음) + maintenance: 가동 진행 / text: 번역 진행 | 분당 약 15회. 쓰는 칸은 일부(OPS-02) |
| 웹 콘솔 진행 `readConsoleProgress` | 30초 공유, stale 5분 | nomorevibe, 주 | readWorkerProgress(text 포함) | 복제본 가능(OPS-04·15) |
| 운영센터 `/admin/status` | **10초**, 창마다, 캐시 없음 | 주 + 복제본 | loadActionInputs 19 · pipelineFlow 8 · 진단 | OPS-06 |
| 배지 `/admin/nav-badges` | 30초(함대 한 대) | 주 + 복제본 | loadActionInputs 전체 | OPS-12 |
| conveyor | 15초 공유 | 주 | 처리량·흐름·시간별 등 10개 | 처리량 중복(OPS-15) |
| console-alerts 잡 | 5분(maintenance) | 주 | 홈 읽기 15개 전체(위 셋 포함) | stale 값·틱 밖 재계산(OPS-08) |

## 구조 변경 제안 (리팩토링으로 효율화)

### S1. 사유 번역 원천을 증분 표로 (OPS-04 의 근본)

- 지금: 진행·잡 선택·text 감독이 부를 때마다 사유 40만 행을 sha256 으로 묶는다(4~9초).
- 바꿀 구조:
  - `reason_translation_sources(hash PK, first_at, last_at, ref, needs_korean bool)` 를 `crawl_review_attempts`·`second_reviews` 의 사유 칸 INSERT/UPDATE 트리거로 유지한다.
  - 진행은 `sources ⟕ text_translations` 의 색인 집계가 되고, 잡은 같은 표로 untried·retryable 을 고른다.
- 얻는 것:
  - 감시 하루 16,580초 + 웹 3,071초 → 수십 초.
  - 잡의 untried·retryable 선택도 같은 정도로 준다.
  - 감시 unknown 의 큰 원인 하나가 사라진다.
- 옮기는 순서: 표·트리거 마이그레이션 → id 범위 백필(짧은 TX) → 그림자 비교(옛 집계와 수 일치) → 진행 읽기 전환 → 잡 선택 전환 → 옛 SQL 제거.
- 위험: 트리거가 심사 쓰기 경로에 sha256 비용을 더한다(건당 수 µs). 해시 기준(UTF-8 원문)이 JS `textHash` 와 같아야 한다.

### S2. 진행 판정을 「역할별 최소 읽기」와 「관문 전체 읽기」로 나누기 (OPS-02·03·15)

- 지금: `readWorkerProgress` 하나가 관문·감시·감독·화면을 모두 맡아 매번 모든 단계를 센다.
- 바꿀 구조:
  - 단계별 읽기 함수(`readThroughputStages(keys)`·`readEvidenceStages`·`readUptimeStage`·`readTextStages(group)`)로 나눈다.
  - 관문은 전부, 감독은 자기 단계만, 화면은 복제본 + 공유 캐시로 조합한다.
  - 처리량은 실행기(executor)와 캐시 정책을 인자로 받는다.
- 얻는 것: 감독 분당 약 15회 전체 집계 → 분당 3~4회 부분 집계. `crawl_documents`·`crawl_frontier`·`product_links`·`uptime_claims` seq scan 이 대략 절반 이하로 준다(추정).
- 옮기는 순서: 함수 분리(동작 같음, 시험 고정) → 감독 전환과 60초 주기 → 화면 복제본 전환.
- 위험: 감독 재시작 판정이 바뀌면 크래시 루프·격리(role-lease-quarantine)로 번질 수 있다. 정체 판정 시험을 먼저 고정한다.

### S3. 감시를 두 층으로 (OPS-01)

- 지금: 생존과 적체를 한 주기, 한 연결에서 함께 센다. 조각 하나만 실패해도 전체가 unknown 이다.
- 바꿀 구조:
  - 빠른 층(30초): readiness, 관측, 잡, 장부 모드·미확정.
  - 느린 층(5분): text·근거·응답 점검 적체. 마지막 성공값을 나이와 함께 쓴다.
  - 조각별 실패 코드를 하트비트와 로그에 싣는다.
- 얻는 것: 감시 DB 시간 약 80% 감소(추정). unknown 이 「진짜 못 읽음」만 뜻하게 된다. Oracle 이 단계 고장을 계속 본다.
- 옮기는 순서: 실패 코드 기록(관측만) → 느린 층 캐시 → 판정 전환.
- 위험: 적체 경보가 최대 5분 늦는다(경보 문턱 10~30분이라 허용 범위).

### S4. 감시 SQL 꼬리표

- 지금: 느린 문장 모양만으로는 호출자를 가를 수 없다('reason'·'other' 가 같은 앞부분이고, 감독·웹·console-alerts 가 같은 계정을 쓴다).
- 바꿀 구조: 감시·진행 SQL 앞에 `/* nmv:<caller>:<part> */` 주석을 붙이고 `application_name` 을 역할별로 구분한다(감독은 `nomorevibe:<role>-supervisor`). 운영 DB 의 `pg_stat_statements` 사용 여부도 확인한다.
- 얻는 것: 다음 점검부터 OPS-01~04 의 몫을 실측으로 나눌 수 있다.
- 순서·위험: 주석만 붙이므로 위험이 거의 없다. 정규화된 모양이 바뀌어 옛 집계와 이어 보기는 끊긴다.

### S5. 알림 판정을 감시 판정과 하나로 (OPS-05·08)

- 지금: console-alerts(maintenance)가 홈 읽기 전체로 단계 멈춤을 다시 세고, 감시는 따로 같은 진행을 세어 Kuma·Oracle 로 보낸다. 두 경보 체계의 문턱이 다르고 DB 비용은 두 배다.
- 바꿀 구조: console-alerts 는 conveyor·잡·접수 상태만 주 DB 에서 읽는다. 진행 기반 규칙은 복제본의 공유 결과를 쓰거나 감시 판정과 같은 함수를 쓴다.
- 얻는 것: 알림 틱 DB 비용 절반 이하, 판정 일관성.
- 위험: 알림 규칙 시안(11-12)의 문구·문턱을 유지해야 한다.

## 확인했지만 문제 아님

- 실시간 한도 폼 빈 칸 버그: 렌더 값과 같은 칸을 건너뛰도록 고쳐졌다(`lib/operations/admin-runtime-settings.ts:334-346`).
- 실시간 한도 저장의 동시 편집: fence → FOR UPDATE → revision 비교 → 쓰기 → 감사가 한 TX 다(`lib/operations/runtime-settings.ts:120-161`).
- 수집 설정 폼: `settingsFormVersion` 을 FOR UPDATE 아래에서 비교한다(`lib/crawl/settings.ts:214-225`).
- 잡을 틱 도중 멈추기: runner 가 완료·실패 때도 멈춤 `not_before` 를 유지한다(`lib/jobs/runner.ts:299-300`).
- 서버 액션 CSRF: Next 기본 Origin/Host 확인이 있다(`node_modules/next/dist/server/app-render/action-handler.js:434-446`). DR 쓰기 관문은 `webWriteAction`·`withRoute` 로 감싸져 있다.
- 'other' text 문장이 사유 CTE 를 함께 돌리는지: 바깥 `WHERE key<>'reason-translate'` 가 UNION ALL 가지에 내려가 상수 거짓이 된다. 그래서 그 CTE 의 CteScan 은 실행되지 않는다(`text-stage-progress.ts:34,143`).
- worker healthcheck 가 DB 를 두드리는지: 로컬 파일만 읽는다(`scripts/worker-healthcheck.ts:1`).
- 감시 하트비트 90초 신선도와 주기: 30초 대기 + 문장 상한 합으로 90초를 넘기 어렵다(`scripts/monitor-healthcheck.ts:8`).
- 알림 조용한 시간 KST 계산: 한국은 서머타임이 없어 고정 +9가 맞다(`lib/operations/console-alerts.ts:68`).
- 근거 진행의 `now.toISOString()::timestamp`: 시간대 없는 칸에 UTC 벽시계로 들어가 일관된다(`worker-progress-query.ts:344`).
- 관리자 링크 prefetch·숨은 탭 폴링: `prefetch={false}` 이고, LiveBar 는 `visibilityState` 로 멈춘다(하위 조사).
- `readAdminModelsObservation` 의 계획: 부분 색인이 있다(`drizzle/0144`). 비용은 중복 호출에서 온다(OPS-11).

## 범위 밖·못 본 것

- `model_capacity_requests` 의 분당 218회 병렬 전체 스캔(`pg-stats-primary.txt:8`, 565G 행)과 `model_capacity_control FOR UPDATE` 대기는 장부 구역 몫이다. 다만 감시·감독·화면의 장부 읽기(`readCapacityAdmissionBlocks`·`readModelCapacityUnknowns`)는 부분 색인이 받친다.
- `product_audit_campaigns`(빈 표) seq scan 1,390만 회(`pg-stats-primary.txt:37`, 초당 28회)는 감사 잡의 상관 서브쿼리로 보인다(crawl·audit 구역 몫, `lib/crawl/audit-*.ts`).
- `second-review` 잡의 마지막 성공이 10-25(`jobs.txt:59`)인 것은 2차 심사가 items 소비자로 넘어간 뒤의 legacy 잡 동작인지 심사 구역에서 확인해야 한다.
- 복제본 `nomorevibe:web-replica` 유휴 연결 46개(`pg-stats-replica.txt:27`)는 웹 2대 × 4 를 넘는다. `READ_DB_POOL_MAX` 덮어쓰기나 복제본 웹 수를 확인해야 한다(하위 조사에서도 설명하지 못함).
- `role_leases FOR UPDATE` 0.9초(`slow-queries-primary.txt:15,18`)는 역할 lease·DR 구역 몫이다.
- `scripts/ops/*.py` 는 감시 경로의 판정 로직만 가볍게 봤다(oracle_watchdog·recovery_gateway 의 MONITOR_PROBE·release_monitor 는 일부만). `pipeline-replay*` 는 오프라인 재현 도구라 보지 않았다.
- 관리자 화면 약 300개 파일 중 무거운 화면 10여 개만 하위 조사로 봤다(status·flow·models·review·inbox·sources·alerts·nav-badges).

## 검증 기록 (2차)

검증자가 2026-11-21 에 했다. 코드는 `저장소 루트`(34b5fe32)만 읽었다. 근거는 `evidence/` 의 기존 파일과 `indexes-primary.txt`·`orchestrator-checks.md` 다. 운영·DB 에는 접속하지 않았다.

**고친 인용: 12건**
- 인용 코드를 실제 줄과 글자 그대로 바꿈(8건): OPS-01·02·03·05·06·14·16·17.
  - 1차의 요약 SQL·줄 끝 설명·`...` 생략을 걷어 냈다.
  - 설명은 코드 블록 앞 산문으로 옮겼다.
- 줄 번호 고침(4건):
  - OPS-01 `worker-progress-query.ts:456-479` → `:470-479`
  - OPS-04 `worker-progress.ts:126,132` → `:127,133`
  - OPS-07 `conveyor-model.ts:254` → `:255`
  - OPS-21 `oracle_watchdog.py:233,282` → `:235,284`
- 사실 보정 1건: OPS-06 의 loadActionInputs 병렬 읽기는 19개가 아니라 20개다.

**반증·심각도 변경**
- 제목에 [반증됨] 을 붙인 항목은 없다. P0·P1 여섯 건 모두 핵심 기전이 코드로 다시 확인됐다.
- 심각도를 바꾼 항목(4건):
  - OPS-01: P0 → P1. 감시 판정의 신뢰도(오경보·미탐·배포 관문 막힘) 문제이지 장애·데이터 손상이 아니다. 「10시간 연속」도 확인되지 않았다.
  - OPS-03: P1 → P2. 처리량 문장은 23시간 동안 0.5초를 한 번도 넘지 않았다. 비용은 빈도에서 오고, 빈도는 OPS-02 가 다룬다.
  - OPS-05: P1 → P2. 관측 detail 이 셀 수 없는 규칙을 「바꾼 뒤 처리량」 하나로만 적는다. 「멈춤」 묶음은 정상으로 열고 보낸다.
  - OPS-06: P1 → P2. 이 화면이 낸 0.5초 넘는 문장은 23시간에 12건뿐이다.
- 주장 일부를 고친 항목:
  - OPS-01
    - 「875건 = 3초 상한 문장」의 근거를 보정했다. 느린 목록에는 끝까지 돈 문장만 남는다. 처리량·근거 문장은 느린 목록에 없다. 그래서 후보를 'other' text 문장과 사유 문장 꼬리로 좁혔고, 횟수로 보아 앞의 것이 더 그럴듯하다.
    - 「사유 TX 뒤에서 풀 대기로 떨어짐」은 줄 서는 순서상 가끔만 생긴다고 고쳤다.
  - OPS-04: `:4` 는 'reason'·'other' 두 문장이 섞인 값일 가능성이 높다고 적었다. 감시 루프 상한은 시간당 약 100주기인데 `:4` 는 시간당 157건이다.
- 운영 실측과 맞춘 것:
  - OPS-03 의 「색인 없음」(crawl_documents.fetched_at 선두 · crawl_review_attempts.completed_at · second_reviews.reviewed_at · crawl_candidates.judged_at)은 `indexes-primary.txt` 와 모두 맞는다. 제안 색인은 기존 색인과 겹치지 않는다.
  - OPS-05 의 관측 detail 은 오케스트레이터 기록과 맞는다(code=console_tasks_unknown, 「셀 수 없음 · 바꾼 뒤 처리량」, since 13:54:49Z).
  - OPS-14 는 연결 폼 → `saveEngineSharedLimit` → `physicalLimit: limitSlots` 경로를 끝까지 확인했다.

**PLAUSIBLE 로 남은 P1 부분**
- OPS-01
  - 풀 대기 5초 초과 실패. 운영 env 의 `DB_POOL_WAIT_MS` 를 확인하지 못했고, 클라이언트 쪽 오류라 DB 로그에 남지 않는다.
  - 875건의 문장 귀속.
  - 「10시간 연속 unknown」.
- OPS-02·04 는 CONFIRMED 다.

**끝내 확인하지 못한 것**
- statement timeout 875·10,383건의 문장 귀속.
  - 원 DB 로그의 ERROR 다음 `STATEMENT:` 줄을 모양별로 세면 가를 수 있다. `log_min_error_statement` 기본값이면 그 줄이 있다. `slowdigest.py` 는 그 줄을 집계하지 않는다.
  - 운영 설정값과 원 로그는 보지 못했다.
- OPS-05: `changeWatchTasks` 가 null 이 된 가지(진행 읽기 실패인지, 복제본 TX 실패인지). maintenance 로그의 `console.progress_unavailable` 으로 가린다.
- monitor 의 운영 env(`DB_POOL_MAX`·`DB_POOL_WAIT_MS`·`DB_STATEMENT_TIMEOUT_MS`). 저장소에 없다.
- 실행 계획 주장 전부(EXPLAIN 없음). 단 REVIEW-04 계열은 오케스트레이터가 쟀다.
