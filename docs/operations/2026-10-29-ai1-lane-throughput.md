# AI1 전용 줄과 틱 안 예약 대기 — 2026-10-29

## 원인(2026-10-29 09:05–09:25 UTC 읽기 전용 진단)

- AI1 시도가 한 번도 없는 승인 후보 약 9,114건. 10-28 05:00 UTC 이후 유입은 시간당 300~540건, AI1 처리는 시간당 95~104건.
- 모델은 빠르다: Supa 평균 4.3초(p95 5.8초), MLX 평균 5.3초(p95 7.6초).
- AI1 슬롯 시간의 46~54%가 쓰이지 않고 만료된 예약이었다(Supa 02–06시 764건 중 215건, MLX 07–09시 277건 중 79건).
- legacy `crawl-agent-review`는 슬롯이 바로 비지 않으면 `model_capacity`로 미루고 틱을 끝냈다. 같은 틱의 둘째 후보가
  `capacity`를 받으면 그 모델을 틱 끝까지 pause 해 틱마다 모델당 1건 안팎만 보냈다. 떠난 사이 줄의 waiting 행은 다른 호출의
  grant 로 reserved(TTL 30초)가 됐고, 다음 틱이 늦으면 만료됐다.
- 틱이 늦은 까닭: reviewer 기본 줄이 crawl-judge → crawl-agent-review → second-review(stage_blocked 여도 약 4.5초) →
  human-deepseek-review(매분 27~29초) → product-audit 를 차례로 돌려 AI1 틱이 6~45초 간격(분당 약 2.2번)으로 왔다.

## 바꾼 것

- `lib/jobs/catalog.ts`: `crawl-agent-review` 를 reviewer 의 전용 줄 `ai1` 에 둔다. 기본 줄의 다른 잡을 기다리지 않는다.
- `scripts/worker.ts`: AI1 틱이 남은 일을 알리면(`completed`, `done:false`) 1초 뒤 다시 돈다. 미룬 틱은 기존 5초 그대로다.
- `lib/crawl/agent-review-model-capacity.ts` `awaitQueuedAi1Reservation`: `capacity` 로 줄에 선 같은 requestId 를 0.5초마다 다시
  묻는다. 줄에 선 행이 없으면(fence·중복 작업) 기다리지 않는다. 상한은 후보당 30초(예약 TTL)와 틱의 시작 가능 시각
  (60초 호출 제한 + 2초 기록 여유 + 3초 claim 여유)이다. 행을 취소하거나 새로 만들지 않는다.
- `lib/crawl/jobs/agent-review.ts`: 모든 물리 칸이 미확인 점유로 막힌 모델(`readBlockedFirstReviewerKeys`)은 기다리지 않는다.
  30초 상한까지 슬롯이 계속 차 있으면 기존처럼 그 모델을 pause 한다. 틱의 시작 가능 시각이 지나 기다림을 그친 후보는
  pause 하지 않고 줄에 남겨 다음 틱이 먼저 다시 본다(PR697 재방문). 진전이 있으면 `continuation: "ready"`, 없으면 요청을 남긴
  `model_capacity` 로 끝내 scheduler 의 다음 요청(최대 1분)을 기다리지 않는다.
- 관측: 틱마다 `crawl.agent_review_tick`(admitted·calls·succeeded·waits·waitGranted·waitPolls·waitMs·waitWindowClosed·waitCapped·
  pausedModels·models 별 calls/waits)과 `crawl.agent_review_wait_window_closed` 를 남긴다.
  `scripts/ops/measure-ai1-throughput.mjs` 가 장부에서 모델별 예약·dispatch·예약 만료·미사용 슬롯 비율을 읽는다(읽기 전용 TX).

## 바꾸지 않은 것

장부 의미(`lib/llm/capacity-repository.ts`: 줄 순서·class 가중치·grant·만료·TTL·정책 세대), owned reservation 재방문과 취소(PR697),
DR fence·역할 lease·stage mode, AI1 추가 pool(PR696), 모델별 물리 한도·capacity 정책 행, `MAX_STARTS`·동시성 설정·호출 제한.
DB schema·migration 은 없다.

## 동시성

- 한 잡은 어느 줄에서든 DB 잡 lease(`jobs.lease_token`) 하나로만 돈다. `lanesForRole` 은 역할의 잡을 겹치지 않게 나눈다.
- reviewer DB pool 은 3(host budget `workerMax.reviewer`) 그대로다. 예전에도 screen·assist·assist-audit 줄이 AI1 과 함께 돌았고,
  이번에는 기본 줄의 잡이 하나 더 겹칠 수 있다. AI1 의 DB 작업은 짧은 TX 이고 모델 전송 중에는 연결을 잡지 않는다.
  대기 중인 줄마다 0.5초에 control 잠금 TX 한 번이다(동시성 4면 최대 초당 8번, 보통 2~4번).
- 배포 뒤 reviewer 로그의 `DbPoolWaitTimeoutError` 와 control 잠금 대기를 함께 본다.

## 배포

- 분류: `lib/jobs/catalog.ts`·공통 lib 변경이라 일반 배포 도구 기준 전체 18앱이다. migration 없음(`--migration-verified` 불필요).
- scheduler 먼저: 새 잡 이름은 없어 `jobs` 행·`next_scheduled_at` 은 이미 있다. 그래도 catalog 변경 규칙대로 scheduler(mini→M3)를
  먼저 올리고 `crawl-agent-review` 행의 `next_scheduled_at` 을 확인한 뒤 나머지를 올린다. 도구의 기본 순서
  (mini text+maintenance → M3 text+maintenance → mini scheduler → M3 scheduler+connect → crawler/reviewer/publisher → 소비자 → 웹 → monitor)와 같다.
- 모델을 보유하는 앱 교체 규칙(`deployment-fast-path.md`)대로 DRAINING 뒤 reserved·dispatched·indeterminate 가 0 이어야 한다.
  남아 있는 미확정 점유는 이 변경으로 풀리지 않으며 별도 단건 복구가 먼저다.
- 실제로 효과가 나는 앱은 M3·mini reviewer 다(AI1 이 legacy 잡으로 돌 때).

## 배포 뒤 측정(한 시간 안)

```bash
# 기존 M3 worker 컨테이너에서, 배포 전 60분과 배포 후 60분을 같은 정의로 비교한다
AI1_WINDOW_MINUTES=60 AI1_BUCKET_MINUTES=10 node scripts/ops/measure-ai1-throughput.mjs
```

- `slots[].dispatchesPerHour` 모델별 시간당 dispatch, `slots[].unusedShare` 미사용 만료·취소 예약 비율, `buckets[].reservation_expired`.
- `attempts` 모델별 성공 수, `backlog.approved_never_attempted` 추세(잡의 정확한 대상 조건이 아닌 근사).
- reviewer 로그 `crawl.agent_review_tick` 의 calls/틱, waits·waitGranted, waitCapped(슬롯이 30초 넘게 찬 횟수), pausedModels.
- 다른 class 와 같은 물리 그룹을 쓰는 text(M3)·AI2(Supa 대체)의 처리량. 공통 장부의 가중치(first 4 : second 2 : background 1)대로
  AI1 이 대기 행을 더 자주 내므로 text 의 M3 몫은 그 가중치 쪽으로 줄 수 있다.

예상(추정, 측정 아님): 건강한 두 모델에서 틱 하나가 16건을 약 40~50초에 보내고 1초 뒤 다음 틱을 돈다. 모델당 시간당 300~600건,
합계 600~1,200건으로 유입(300~540건)을 넘을 것으로 본다. 공유 그룹의 다른 class 호출·미확정 점유가 있으면 그만큼 줄어든다.

## 검증 기록(로컬)

- unit: `tests/agent-review-model-capacity.test.ts`·`tests/agent-review-reservation-wait.test.ts`·`tests/job-catalog.test.ts`·
  `tests/worker-runtime.test.ts` 포함 변경 범위 38파일 580건 통과.
- DB 통합(전용 로컬 Postgres): `tests/integration/ai1-reservation-wait.test.ts`(실제 장부 grant·deadline·fence·측정 SQL·잡 lease)와
  AI1·replay·runner 관련 9파일 103건 통과.
- `next typegen` + `tsc --noEmit`, 변경 파일 eslint 통과. 전체 unit·전체 DB 묶음은 통합 단계 정책대로 PR CI 에 맡긴다.
