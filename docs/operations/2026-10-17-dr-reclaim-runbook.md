# DR 밖 회수(PR15d) 운영 runbook — 2026-10-17

> 보조 문서: 기본 절차와 PR15f(후속 boot의 ESRCH 관측, migration 0101)는 [`docs/runbooks/dr-stuck-reclaim.md`](../runbooks/dr-stuck-reclaim.md)를 따른다. 이 문서는 그 문서에 없는 증상별 readback SQL(S1–S9), provider 정책 선언 근거, 하지 말 것, 남는 한계를 담는다(#523, 0099까지 migrate한 DB에서 SQL 확인).

[PR519](https://github.com/JRVector9/nomorevibe/pull/519)(PR15d, migration 0099)는 DR 승격과 무관하게 영구히 묶인 모델 슬롯과 crash한 worker의 HTTP hop을 **근거가 있을 때만** 푸는 운영 CLI를 추가했다. 이 문서는 그 CLI를 언제, 어떻게, 무엇을 지키며 쓰는지 정리한다. 실행 기록이나 배포 완료 증거가 아니다.

- 회수는 운영자가 손으로 실행하는 CLI뿐이다. 주기 job·자동 회수는 없다(승인된 정책 저장소가 없어 만들지 않았다, PR519 본문).
- 운영 DB에 대한 모든 실행(읽기 전용 보고 포함)은 사용자 승인 뒤에만 한다. `--apply`는 dry-run 결과를 사용자에게 보여 주고 따로 승인받는다.
- 시간 경과만으로는 아무것도 풀지 않는다. 아래 "하지 말 것"을 먼저 읽는다.

## 1. 무엇을 근거로 풀고, 무엇이 남는가

대상은 `model_capacity_requests`와 `http_origin_hops`에서 `state IN ('dispatched','indeterminate')`인 모든 행이다(`lib/operations/dr/reclaim.ts:101-102`, `:126-127`). 근거는 두 종류뿐이다.

| 근거 kind | 적용 대상 | 성립 조건 | 기한(notBefore) |
| --- | --- | --- | --- |
| `process_group_exit` | 모델 행, HTTP hop | 행 owner(`instance`, `boot`)의 `dr_process_group_events`에 dispatch 전 `owner_opened` 1개, 번호 공백 없는 `spawn_intent`, dispatch 시각까지 의도가 기록된 child마다 `spawned` 1개와 `group_exited` 1개(run_id·pid 일치) | 마지막 `group_exited` 기록 + (provider_bound면 D) + skew |
| `local_call_ended` | 모델 `indeterminate` 행만 | 같은 owner·같은 dispatch binding hash로 남은 `dispatch_local_ended` 사실 1개 | 사실 기록 시각 + (provider_bound면 D) + skew |

- 판정 코드: `lib/operations/dr/call-drain.ts:61-91`(그룹 종료), `:93-99`(로컬 종료), `:106-127`(모델 행 공통 판정, 둘 다 있으면 먼저 오는 기한).
- 그룹 종료 기록은 supervisor가 그룹 SIGKILL 뒤 ESRCH를 직접 본 경우에만 쓴다(`method = 'pgid_esrch_after_sigkill'`, `lib/operations/dr/repository.ts:219-231`).
- 로컬 종료 사실은 `MODEL_CAPACITY_LOCAL_END=1` 프로세스가 자기 게이트웨이 호출의 fetch 종료와 모든 native dispatch 종료 callback을 본 뒤, 같은 프로세스가 그 행을 `indeterminate`로 표시할 때만 남는다(`lib/llm/gateway-local-end.ts:1-9`, `lib/llm/capacity-repository.ts:394-397`, `:401-413`). 사실 자체는 해제가 아니다.
- TTL·heartbeat 부재·owner 재시작·정책 변경은 근거가 아니다(`lib/llm/capacity.ts:852`, `lib/operations/dr/hop-reclaim.ts:4-7`).
- 회수 결과: 모델 행은 `withdrawn`이 되고 `terminal_evidence`와 `dispatch_released` 사건에 근거가 남는다(`lib/llm/capacity-repository.ts:1939-1942`). 과금(dispatch binding의 C)은 그대로이고 settled·사용량 증거를 만들지 않는다(`lib/llm/capacity.ts:858`). HTTP hop은 `released`가 되고 `http_origin_events`(kind `released`)의 `evidence`에 근거가 남는다(`lib/operations/dr/reclaim.ts:151-154`). hop당 근거 사건은 하나다(0099 `http_origin_events_reclaimed_idx`).

### 근거가 생기는 프로세스와 생기지 않는 프로세스

- **기록은 `PROCESS_GROUP_RECORDING=1`일 때만 켜진다(기본 꺼짐, 리뷰 R2·R4 반영).** 꺼진 boot의 행·hop은 `owner_not_opened_before_dispatch`(unproven)로 남는다.
- 생긴다(켜졌을 때): `scripts/role-worker.ts`(운영 다섯 역할)의 child. role-worker는 boot마다 기록기를 만들어 supervisor에 넘긴다(`scripts/role-worker.ts:134-135`, `:187`). 켜진 AI1/AI2 consumer(`PIPELINE_ITEM_CONSUMER_VERSION=1`)의 child도 기록한다(`scripts/worker-supervisor.ts:281-302`). supervisor는 기록한 owner를 child env `PROCESS_GROUP_OWNER_INSTANCE_ID`/`PROCESS_GROUP_OWNER_BOOT_ID`로만 넘긴다(`scripts/worker-supervisor.ts:170-173`, `lib/operations/dr/process-owner-env.ts:9`).
- HTTP hop은 그 프로세스의 `SERVICE_INSTANCE_ID`가 기록 owner instance와 같을 때만 그 boot를 쓴다. 다르면 새 boot라 근거가 없다(`lib/net/origin-permits.ts:14-15`, `lib/operations/dr/process-owner-env.ts:19-22`). consumer의 기록 owner instance는 `PIPELINE_ITEM_CONSUMER_INSTANCE_ID`이므로 두 값이 같아야 한다. 이 일치를 강제할지는 PR519에서 미결이다.
- 생기지 않는다: 웹 프로세스, scheduler, supervisor 직접 실행, role-worker parent 자신의 호출. 이 행·hop은 영구히 `owner_not_opened_before_dispatch`로 남는다.
- 종료가 기록되지 않는 경우(행이 `spawn_not_exited:N`으로 남는다):
  - SIGKILL 뒤 5초 안에 그룹이 사라지지 않았다: `supervisor.group_cleanup_incomplete`(`scripts/worker-supervisor.ts:238-240`).
  - `spawned` 기록에 실패했다: `supervisor.process_group_spawn_unrecorded`(`:175-177`).
  - 종료 기록이 실패하거나 10초 제한을 넘었다: `supervisor.process_group_exit_unrecorded`(`:100`, `:241-244`).
  - supervisor 자신까지 함께 죽었다(컨테이너 전체 종료·OOM·호스트 전원). 종료를 기록하는 경로는 supervisor의 `finish()`뿐이다.

## 2. 언제 쓰는가 — 증상과 readback SQL

증상:

- 모델: provider budget의 활성 행(`reserved`+`dispatched`+`indeterminate`)이 `providerLimits`에 붙어 새 요청이 `waiting`에 머문다. 할당은 이 세 상태를 모두 센다(`lib/llm/capacity-repository.ts:128-143`). 오래된 `dispatched`/`indeterminate` 행의 owner boot가 이미 재시작으로 사라졌다면 회수 후보다.
- HTTP(`HTTP_ORIGIN_PERMITS=1`일 때만 hop이 생긴다): origin당 활성 hop 1개, Oracle host 합계 2개라서(`lib/net/origin-permits.ts:56-59`) 남은 hop 하나가 그 origin의 모든 새 요청을 막는다.

`unproven` 자체는 이상이 아니다. 살아 있는 worker가 지금 처리 중인 행도 그 child가 끝나기 전에는 `spawn_not_exited:N`으로 보인다. 아래 S2·S3의 오래된 dispatch 시각과 owner의 생존 여부를 같이 본다.

아래 SQL은 모두 읽기 전용이다. psql에서 `BEGIN READ ONLY;`로 시작하고 `ROLLBACK;`으로 끝낸다. S4는 psql 변수를 쓴다(`psql -v instance=<instance> -v boot=<boot-uuid>`).

S0 — budget 목록과 한도:

```sql
SELECT key AS provider_budget_id, value::int AS provider_limit
FROM model_capacity_control, jsonb_each_text(policy->'providerLimits')
WHERE id = 1 ORDER BY key;
```

S1 — budget별 점유와 한도:

```sql
SELECT a.provider_budget_id, a.active, (c.policy->'providerLimits'->>a.provider_budget_id)::int AS provider_limit,
       a.dispatched, a.indeterminate
FROM (SELECT provider_budget_id, count(*) AS active,
             count(*) FILTER (WHERE state = 'dispatched') AS dispatched,
             count(*) FILTER (WHERE state = 'indeterminate') AS indeterminate
      FROM model_capacity_requests WHERE state IN ('reserved','dispatched','indeterminate')
      GROUP BY provider_budget_id) a
CROSS JOIN model_capacity_control c
WHERE c.id = 1
ORDER BY a.provider_budget_id;
```

S2 — owner별 남은 모델 행, 그룹 기록·로컬 종료 사실 유무:

```sql
SELECT r.owner_instance_id, r.owner_boot_id, r.provider_budget_id, r.state, count(*) AS rows,
       min(coalesce(r.dispatched_at, (SELECT min(e.created_at) FROM model_capacity_events e
         WHERE e.request_id = r.request_id AND e.kind = 'dispatch_started'))) AS oldest_dispatch_at,
       EXISTS (SELECT 1 FROM dr_process_group_events g WHERE g.owner_instance_id = r.owner_instance_id
         AND g.owner_boot_id = r.owner_boot_id AND g.kind = 'owner_opened') AS owner_recorded,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM model_capacity_events f
         WHERE f.request_id = r.request_id AND f.kind = 'dispatch_local_ended')) AS local_end_facts
FROM model_capacity_requests r
WHERE r.state IN ('dispatched','indeterminate')
GROUP BY r.owner_instance_id, r.owner_boot_id, r.provider_budget_id, r.state
ORDER BY oldest_dispatch_at NULLS FIRST;
```

dispatch 시각은 CLI와 같은 식(`dispatched_at`, 없으면 첫 `dispatch_started` 사건)으로 계산한다(`lib/operations/dr/reclaim.ts:182-184`).

S3 — 남은 HTTP hop과 그룹 기록 유무:

```sql
SELECT h.origin, h.host_id, h.instance_id, h.boot_id, h.state, count(*) AS hops, min(h.dispatched_at) AS oldest_dispatch_at,
       EXISTS (SELECT 1 FROM dr_process_group_events g WHERE g.owner_instance_id = h.instance_id
         AND g.owner_boot_id = h.boot_id AND g.kind = 'owner_opened') AS owner_recorded
FROM http_origin_hops h
WHERE h.state IN ('dispatched','indeterminate')
GROUP BY h.origin, h.host_id, h.instance_id, h.boot_id, h.state
ORDER BY oldest_dispatch_at;
```

S4 — owner 하나의 그룹 기록 전체(보고의 `unproven` 이유를 확인할 때):

```sql
SELECT id, kind, seq, run_id, pid, method, recorded_at
FROM dr_process_group_events
WHERE owner_instance_id = :'instance' AND owner_boot_id = :'boot'::uuid
ORDER BY id;
```

S5 — writer fence(`active`가 아니면 회수 CLI가 거절한다):

```sql
SELECT state, writer_epoch, reason FROM dr_writer_fence WHERE id = 1;
```

## 3. `reclaim-report` 읽는 법

```sh
node --import tsx scripts/ops/dr/promotion.ts reclaim-report \
  [--deadline=<budget>:<ms>]... [--client-bound=<budget>]... [--skew-ms=<ms>] \
  --database-url-stdin < "$DR_DB_URL_FILE"
```

- 코드와 `tsx`가 있는 곳(예: worker 이미지)의 저장소 루트에서 실행한다. `--database-url-stdin`은 필수이고, URL은 stdin 한 줄(최대 4096바이트)로만 받는다. URL을 argv·환경변수·로그에 쓰지 않는다(`scripts/ops/dr/promotion.ts:3`, `:48`, `:55`, `:128-131`). `$DR_DB_URL_FILE`은 쓰기 primary DB URL 한 줄만 담긴 권한 600 파일이다. CLI는 `READ_DATABASE_URL`을 지우고 이 URL 하나만 쓴다(`:137-138`).
- URL 형식: `postgres://` 또는 `postgresql://`, host 하나, 명시 port, 사용자 이름, DB 이름 `[A-Za-z0-9_]+`, query는 `sslmode` 하나만 허용한다(`scripts/ops/dr/promotion.ts:113-125`).
- 옵션은 `--key=value` 형식만 받는다. 모르는 옵션과 중복 옵션(`--deadline`/`--client-bound` 제외)은 거절한다(`:38`, `:49-52`). `reclaim-report`의 허용 옵션은 `deadline`, `client-bound`, `skew-ms`뿐이다(`:35`). `--apply`를 주면 `dr_cli_unknown_option`으로 거절한다.
- `reclaim`에 쓸 정책 옵션을 그대로 주어야 보고가 실제 회수와 같은 판정을 보여 준다. 정책을 주지 않은 budget은 provider_bound·기한 미상으로 판정한다(`lib/operations/dr/call-drain.ts:121`). HTTP hop은 항상 client_bound에 `--skew-ms` 값을 쓴다(`lib/operations/dr/reclaim.ts:128`).
- 보고는 같은 TX를 실행한 뒤 ROLLBACK한다. 행을 잠그지 않고 fence 상태와 무관하게 읽는다. 실제 회수는 lock 아래에서 같은 판정을 다시 한다(`lib/operations/dr/reclaim.ts:174-217`).

출력은 stdout JSON 한 줄이고 exit 0이다(`scripts/ops/dr/promotion.ts:141`, `:174-177`).

```json
{"command":"reclaim-report","dryRun":true,"blocked":false,"result":{"now":"…","siteActive":true,
 "model":{"total":0,"reclaimable":0,"waiting":0,"policyBlocked":0,"unproven":0,"rows":[]},
 "http":{"total":0,"reclaimable":0,"waiting":0,"unproven":0,"rows":[]}}}
```

- `now`는 DB clock이다. `siteActive=false`면 fenced DB라서 `reclaim`은 `dr_writer_site_fenced`로 거절한다.
- 모델 행 필드: `requestId`, `owner{instanceId,bootId}`, `state`, `providerBudgetId`, `dispatchAt`, `status`, `evidence`, `reason`, `notBefore`. hop 행 필드: `hopId`, `owner`, `origin`, `hostId`, `state`, `dispatchAt`, `status`, `reason`, `notBefore`(`lib/operations/dr/reclaim.ts:161-169`).

| status | 뜻 | 다음 행동 |
| --- | --- | --- |
| `reclaimable` | 근거가 있고 정책을 충족하며 DB clock이 `notBefore` 이후다. | dry-run 뒤 `--apply` 대상이다. |
| `waiting` | 근거와 정책은 있지만 `notBefore` 전이다(`reason: "waiting"`). | `notBefore`가 지난 뒤 보고를 다시 실행한다. |
| `policy_blocked`(모델만) | 근거는 있지만 그 budget 정책이 없거나 provider_bound인데 D가 없다(`reason: "provider_deadline_unknown"`). | 근거 있는 정책이 선언되기 전까지 둔다. |
| `unproven` | 근거가 없다. `reason`이 이유다. | 둔다. 원인을 S4로 확인한다. |

`unproven`의 `reason`(`lib/operations/dr/call-drain.ts:61-80`, `:110-120`):

| reason | 뜻 |
| --- | --- |
| `dispatch_time_unknown` | `dispatched_at`도 `dispatch_started` 사건도 없다. |
| `owner_not_opened_before_dispatch` | owner의 `owner_opened`가 없거나 dispatch 뒤다. 기록기 없는 프로세스(웹·scheduler·직접 실행·parent)이거나 hop의 instance가 기록 owner와 다르다. |
| `spawn_sequence_gap` | `spawn_intent` 번호에 공백이 있다(기록 유실). |
| `no_spawn_before_dispatch` | dispatch 시각까지 기록된 의도가 없다. |
| `spawn_not_exited:N` | N번 child의 종료 기록이 없다. 아직 살아 있거나 1절의 "종료가 기록되지 않는 경우"다. |
| `spawned_record_missing:N` | N번 의도에 `spawned` 기록이 정확히 1개가 아니다. |
| `exit_mismatch:N` | N번의 `spawned`/`group_exited` run_id·pid가 의도와 맞지 않는다. |
| `local_end_state_mismatch` / `local_end_owner_mismatch` / `local_end_binding_mismatch` | 로컬 종료 사실이 있지만 행이 `indeterminate`가 아니거나 owner·binding hash가 다르다. |

`reclaim` 출력에만 나오는 이유도 있다. 모델 행이 lock 시점에 이미 활성이 아니면 `not_active`(`lib/operations/dr/reclaim.ts:16-17`), hop owner 모양이 틀리면 `owner_invalid`(`:143-144`)다.

## 4. 절차 — 보고 → dry-run → `--apply`

1. 사용자 승인을 받는다. 운영 DB 접근 자체가 승인 대상이다.
2. 전제를 확인한다. 0099가 적용됐는지 6절 S8로, PR15d 코드가 배포됐는지, fence가 `active`인지 S5로 본다.
3. S0–S3으로 현재 상태를 읽는다.
4. 쓸 정책 그대로 `reclaim-report`를 실행하고 `reclaimable` 행을 확인한다.
5. dry-run을 실행한다(`--apply` 없음):

   ```sh
   node --import tsx scripts/ops/dr/promotion.ts reclaim \
     [--deadline=<budget>:<ms>]... [--client-bound=<budget>]... [--skew-ms=<ms>] \
     --reference=<정책 근거 출처> --operator=<운영자> \
     --database-url-stdin < "$DR_DB_URL_FILE"
   ```

   - `--reference`(1–400자)와 `--operator`(1–120자)는 필수다. 앞뒤 공백과 제어문자는 거절한다(`scripts/ops/dr/promotion.ts:105-108`, `lib/operations/dr/epoch.ts:6-7`). 둘 다 회수된 모든 행의 근거 JSON에 남는다.
   - 모든 쓰기 명령은 기본 dry-run이다. 같은 TX를 실제로 실행한 뒤 ROLLBACK하고 "commit했다면"의 결과를 돌려준다(`scripts/ops/dr/promotion.ts:2`, `lib/operations/dr/repository.ts:19-24`).
   - 출력: `{"command":"reclaim","dryRun":true,"blocked":…,"result":{"model":{"rows":[{"requestId","released","reason"}…]},"http":{"rows":[{"hopId","released","reason"}…]}}}`.
   - exit 코드: 모든 행이 풀리면 0, 하나라도 남으면 `blocked:true`와 exit 3이다(dry-run 포함, `scripts/ops/dr/promotion.ts:141`, `:178-184`). `unproven` 행이 있으면 exit 3은 정상이다. 오류는 stderr `{"code":"…"}`와 exit 1이다(`:192-197`). 예: `dr_writer_site_fenced`, `dr_cli_missing_reference`.
6. dry-run 결과를 사용자에게 보여 주고 `--apply` 승인을 받는다.
7. 같은 옵션에 `--apply`만 더해 실행한다. `--apply`는 값 없이 쓴다(`--apply=yes`는 거절, `scripts/ops/dr/promotion.ts:51`).
   - 모델 장부와 HTTP hop은 각각 짧은 별도 TX이고 모델이 먼저다. 모델 TX가 오류로 끝나면 HTTP는 실행하지 않는다(`scripts/ops/dr/promotion.ts:178-183`).
   - lock 순서: 모델은 fence SHARE → `model_capacity_control` → 요청 행, HTTP는 fence SHARE → `http_origin_control` FOR UPDATE → hop 행이다(`lib/operations/dr/reclaim.ts:91-95`, `:130-139`). HTTP TX 동안 permit 예약·정산은 같은 control 행을 기다린다.
   - apply는 자기 DB 시각으로 다시 판정한다. dry-run 뒤 `waiting`이 풀렸거나 새 행이 생겼을 수 있으므로 apply 출력의 `rows`를 결과로 기록한다.
8. S6·S7과 `reclaim-report`로 다시 읽는다.

S6 — 회수된 모델 행:

```sql
SELECT request_id, provider_budget_id, terminal_evidence->>'kind' AS evidence, terminal_evidence->>'fromState' AS from_state,
       terminal_evidence->>'notBefore' AS not_before, terminal_evidence->>'operator' AS operator, updated_at
FROM model_capacity_requests
WHERE state = 'withdrawn' AND terminal_evidence->>'kind' IN ('process_group_exit','local_call_ended')
ORDER BY updated_at DESC
LIMIT 50;
```

S7 — 회수된 HTTP hop:

```sql
SELECT e.hop_id, h.origin, h.state, e.evidence->>'notBefore' AS not_before, e.evidence->>'operator' AS operator, e.created_at
FROM http_origin_events e
JOIN http_origin_hops h ON h.id = e.hop_id
WHERE e.kind = 'released' AND e.evidence IS NOT NULL
ORDER BY e.id DESC
LIMIT 50;
```

`--reference`는 한 실행의 모든 모델 정책과 HTTP hop 근거에 같은 문자열로 저장된다(`scripts/ops/dr/promotion.ts:105-108`, `:181-182`). 근거 출처가 다르면 실행을 나눈다. 모델 정책 옵션 없이 실행하면 모델 행은 모두 `provider_deadline_unknown`으로 남고 HTTP hop만 풀린다.

같은 CLI의 `process-reclaim-report`/`process-reclaim --instance=<id> --boot=<uuid>`는 owner 하나의 모델 행만 다루고 근거도 그룹 종료만 본다(`scripts/ops/dr/promotion.ts:31-32`, `lib/operations/dr/reclaim.ts:19-52`). DR 밖 전역 회수에는 위 `reclaim`을 쓴다.

## 5. provider 정책 선언에는 근거가 필요하다

| 선언 | 옵션 | 뜻 | 필요한 근거 |
| --- | --- | --- | --- |
| client_bound | `--client-bound=<budget>` | 호출 프로세스가 끝나면 provider 쪽 점유도 끝난다. 기한 = 종료 + skew. | provider가 연결 종료 시 생성을 멈춘다는 문서·계약·실측 |
| provider_bound | `--deadline=<budget>:<ms>` | 연결이 끊겨도 provider가 계속 실행할 수 있다. 기한 = 종료 + D + skew. | provider가 강제하는 hard deadline D의 근거. D는 1–86,400,000ms |

- 정의: `lib/operations/dr/call-drain.ts:10-11`, `:82-99`. 옵션 해석: `scripts/ops/dr/promotion.ts:63-79`. `--deadline`은 마지막 `:`에서 budget과 ms를 나누므로 budget id에 `:`가 있어도 된다. 같은 budget을 두 번 선언하거나 두 방식으로 함께 선언하면 `dr_cli_invalid_deadline`이다.
- 선언하지 않은 budget은 provider_bound·D 미상이라 근거가 있어도 `policy_blocked`다. provider_bound에 D 없이 푸는 경로는 없다(완화 없음, PR519 root 결정).
- `--skew-ms`: 1–600,000ms, 기본 1,000ms이다. 한 실행의 모든 모델 정책과 HTTP hop에 같은 값을 쓴다(`scripts/ops/dr/promotion.ts:61-64`). 종료 기록 시각(DB clock)과 provider 쪽 실제 종료·기한 측정 사이의 오차 여유이므로 근거 없이 줄이지 않는다.
- budget id는 S0의 `provider_budget_id`다.
- 현재 상태(PR519 본문): abcLLM 게이트웨이의 hard deadline 증명이 없다. 그래서 abcllm budget 행은 근거가 있어도 `policy_blocked: provider_deadline_unknown`이다. D 증명은 사용자와 abcLLM의 일정이다. 그 전에 abcllm budget에 `--client-bound`나 추정 `--deadline`을 주지 않는다.

## 6. `MODEL_CAPACITY_LOCAL_END` 켜는 순서

값은 미설정 또는 `0`이면 꺼짐, `1`이면 켜짐이다. 그 밖의 값은 설정 오류다. 예약 게이트웨이 fetch마다 `invalid_model_capacity_local_end`를 던져 그 호출이 실패한다(`lib/llm/gateway-local-end.ts:18-23`, `lib/llm/gateway-local-end-fetch.ts:9-10`). 추적 대상은 `lib/crawl/agent-review-gateway.ts`의 예약 abcLLM 게이트웨이 호출이다.

1. 0099를 적용한다. drain 상태에서 적용한다. 0096처럼 큰 CHECK를 drop/add해 `model_capacity_requests`/`model_capacity_events`를 재검증하고 짧은 ACCESS EXCLUSIVE를 잡는다(PR519 배포 순서). 이 브랜치의 journal에는 0097·0098이 없다. 통합 때 0097 → 0098 → 0099 순서를 지키고 생성기의 "0096 이후 같은 CHECK 미변경" 검사를 다시 실행한다.
2. PR15d 코드를 플래그 꺼진 채 배포한다.
3. S8로 0099를 확인한다. 기대값은 `indexes_0099 = 2`, `hop_evidence_column = t`, `local_end_kind_allowed = t`이다.
4. 웹(M3·mini)과 워커 모두에 `MODEL_CAPACITY_LOCAL_END=1`을 설정한다. 사실은 호출한 프로세스 메모리의 관측으로만 생기므로, 꺼진 프로세스의 호출에는 회수 근거가 생기지 않는다.
5. S9로 사실이 쌓이는지 본다. 사실은 행이 `indeterminate`가 될 때만 생기므로 0건이 곧 실패는 아니다.

0099 전에 켜면 0096의 kind CHECK가 `dispatch_local_ended`를 거절한다. 기록 실패는 호출 결과를 바꾸지 않고 조용히 버려지므로(`lib/llm/capacity-repository.ts:395-397`) 사실은 남지 않고 실패한 쓰기만 생긴다. 끌 때는 `0`이나 미설정으로 되돌린다. 이미 남은 사실은 그대로이고 새 사실만 생기지 않는다. 켜도 abcllm 행은 D가 없어 풀리지 않는다(5절).

S8 — 0099 적용 확인:

```sql
SELECT (SELECT count(*) FROM pg_indexes
          WHERE indexname IN ('model_capacity_events_local_end_idx','http_origin_events_reclaimed_idx')) AS indexes_0099,
       EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'http_origin_events' AND column_name = 'evidence') AS hop_evidence_column,
       (SELECT pg_get_constraintdef(oid) LIKE '%dispatch_local_ended%' FROM pg_constraint
          WHERE conname = 'model_capacity_events_kind_check') AS local_end_kind_allowed;
```

S9 — 로컬 종료 사실 누적:

```sql
SELECT r.provider_budget_id, r.state, count(*) AS facts, max(f.created_at) AS latest_fact_at
FROM model_capacity_events f
JOIN model_capacity_requests r ON r.request_id = f.request_id
WHERE f.kind = 'dispatch_local_ended'
GROUP BY r.provider_budget_id, r.state
ORDER BY r.provider_budget_id, r.state;
```

## 7. 하지 말 것

- 시간만으로 회수하지 않는다. 나이·TTL·heartbeat 부재·owner 재시작은 근거가 아니다. CLI에 TTL 옵션은 없다(`--ttl-ms`는 `dr_cli_unknown_option`).
- 장부 행·hop을 SQL로 직접 UPDATE/DELETE하지 않는다.
- `dr_process_group_events`·`model_capacity_events`에 근거를 손으로 INSERT하지 않는다. append-only 트리거는 UPDATE/DELETE/TRUNCATE만 막고 INSERT는 막지 않는다(`drizzle/0095_dr_writer_fence.sql:96-99`). 손으로 넣은 행은 위조 근거다.
- 근거 없이 정책을 선언하지 않는다. client_bound를 추정하거나, D를 짐작하거나, skew를 줄이지 않는다.
- fenced DB(S5가 `active`가 아님)에서 회수를 시도하지 않는다. CLI도 `dr_writer_site_fenced`로 거절한다.
- 0099 전에 `MODEL_CAPACITY_LOCAL_END`를 켜지 않는다. `0`/`1` 외의 값을 쓰지 않는다.
- DB URL을 argv·환경변수·로그에 쓰지 않는다.
- 사용자 승인 없이 운영 DB에서 보고·dry-run·`--apply`를 실행하지 않는다.

## 8. 남는 한계

- 근거 없는 행과 hop은 남는다. 1절의 기록기 없는 프로세스와 종료 미기록 경우가 그렇다. 지금은 이를 풀 승인된 경로가 없다.
- abcllm budget 행은 D 증명 전까지 `policy_blocked`다.
- consumer instance id(`PIPELINE_ITEM_CONSUMER_INSTANCE_ID`)와 `SERVICE_INSTANCE_ID`의 일치는 강제하지 않는다(PR519 미결).
- `reclaim`은 모델과 HTTP를 별도 TX로 commit하므로 한쪽만 반영될 수 있다. 결과는 출력 `rows`와 S6·S7로 확인한다.
