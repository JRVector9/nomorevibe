# DR 밖 묶인 모델 슬롯·HTTP hop 회수 runbook (PR15d)

모델 장부(`model_capacity_requests`)와 HTTP permit(`http_origin_hops`)의 `dispatched`/`indeterminate` 점유는
TTL·owner 죽음·재시작·정책 변경·drain으로 풀리지 않는다. 이 문서는 그중 **근거가 있는 것만** 푸는 운영 CLI
`scripts/ops/dr/promotion.ts`의 `reclaim-report`(읽기 전용)와 `reclaim`(기본 dry-run, `--apply`)을 다룬다.
주기 job은 없고 운영자가 손으로만 실행한다. 이 문서의 운영 단계는 **모두 사용자 승인 뒤** 실행한다.

## 먼저 알아야 할 것

1. **시간 경과는 근거가 아니다.** 근거는 두 가지뿐이다.
   - `process_group_exit`(모델·HTTP): 행 owner(instance, boot)의 `dr_process_group_events`에서 `owner_opened`가 dispatch보다 앞서고,
     spawn 의도 번호에 공백이 없고, dispatch 시각까지 의도가 기록된 모든 child가 `spawned`와 `group_exited`를 가진다.
     `group_exited`는 슈퍼바이저가 그룹 SIGKILL 뒤 ESRCH를 직접 본 경우에만 쓴다. 기준 시각은 마지막 `group_exited`다.
   - `local_call_ended`(모델만, 0099): `indeterminate` 행에 같은 owner·dispatch binding이 남긴 `dispatch_local_ended` 사실. 기준 시각은 그 사실의 기록 시각(DB clock)이다.
2. **근거가 있어도 provider 정책을 따른다.** `notBefore` = 기준 시각 + (provider_bound면 hard deadline D) + skew.
   - `--client-bound=<budget>`: 호출한 프로세스 쪽 연결이 끝나면 provider 점유도 끝나는 budget에만 쓴다.
   - `--deadline=<budget>:<ms>`: provider가 강제하는 hard deadline D가 증명된 budget에만 쓴다. 출처는 `--reference`에 남긴다.
   - 선언하지 않은 budget은 provider_bound·D 미상으로 보고 `policy_blocked`(`provider_deadline_unknown`)로 남긴다.
     게이트웨이 모델은 provider_bound다. abcLLM hard deadline 증명은 아직 없으므로(사용자·abcLLM 일정) 증명 전에는 그 budget을 선언하지 않는다.
   - HTTP hop은 항상 client_bound로 판정한다. `--deadline`·`--client-bound`는 HTTP에 영향이 없고 `--skew-ms`만 쓴다.
3. **회수는 점유만 푼다.** 모델 행은 `withdrawn`이 되고 `terminal_evidence`와 `dispatch_released` event에 같은 근거가 남는다.
   dispatch binding의 청구량(chargedTokens = C)은 그대로이고 `settled`·사용량 증거는 만들지 않는다.
   HTTP hop은 `released`(`settled_at` 기록)가 되고 `http_origin_events`의 `released` 사건 `evidence`에 근거가 남는다. 근거는 append-only이고 행·hop마다 하나다.
4. **group 근거를 남기는 프로세스는 정해져 있다.** role-worker가 띄운 child와 켜진(`PIPELINE_ITEM_CONSUMER_VERSION=1`) AI1/AI2 consumer 슈퍼바이저의 child뿐이다.
   웹처럼 기록기가 없는 프로세스의 행·hop은 group 근거가 없다(`owner_not_opened_before_dispatch`).
   슈퍼바이저가 함께 죽으면(컨테이너 제거·host 정지 등) `group_exited`가 남지 않아 그 boot의 행은 `spawn_not_exited:<seq>`로 계속 남는다.
5. **로컬 종료 사실은 좁다.** `MODEL_CAPACITY_LOCAL_END=1`인 프로세스의 reserved 게이트웨이 호출(`lib/crawl/agent-review-gateway.ts`)이
   `indeterminate`로 표시될 때, fetch가 끝나고 시작된 native dispatch(1개 이상)가 모두 종료 callback(`onResponseEnd`/`onResponseError`)을 냈을 때만 남는다.
   기록 실패는 무시되고 그 행은 근거 없이 점유를 유지한다. `dispatched`로 남은 행에는 생기지 않는다.
   로컬 종료는 provider 쪽 생성 종료가 아니라서 2의 정책 판정을 따로 거친다.
6. **HTTP hop owner는 `SERVICE_INSTANCE_ID`다.** child는 슈퍼바이저가 넘긴 owner instance(`PROCESS_GROUP_OWNER_INSTANCE_ID`)가 자기 `SERVICE_INSTANCE_ID`와 같을 때만
   그 boot를 hop에 쓴다. 다르면 새 boot라 그 hop은 group 근거를 갖지 못한다(아래 열린 결정).

## 실행 환경

- 실행 위치: 운영 DB primary에 쓰기로 접속 가능한 worker 이미지 컨테이너(`scripts`·`tsx` 포함)의 앱 디렉터리.
  보고도 `dr_writer_fence`를 `FOR SHARE`로 읽으므로 복제본 URL은 쓰지 않는다. 앱의 `READ_DATABASE_URL`은 도구가 지운다.
- DB URL은 stdin 한 줄로만 준다(`--database-url-stdin` 필수). 명령 인자·로그에 쓰지 않는다. 아래 예시의 `DR_DATABASE_URL`은 도구가 자동으로 읽는 환경변수가 아니다.
  형식은 단일 host·명시 port·DB 이름의 `postgres(ql)://` URL이고 query는 `sslmode` 하나만 허용한다. PgBouncer(6432) URL이면 `DB_POOLER_MODE=pgbouncer`가 있어야 한다.
- 옵션은 `--key=value`만 받는다. 모르는·중복 옵션은 거절한다. `--deadline`·`--client-bound`만 반복할 수 있고 같은 budget을 두 번 선언하면 `dr_cli_invalid_deadline`이다.
  `--skew-ms`는 기본 1000(1~600000), `--deadline`의 ms는 1~86400000, `--reference`는 400자·`--operator`는 120자 이내(앞뒤 공백·제어문자 불가).
- 출력은 JSON 한 줄 `{command, dryRun, blocked, result}`. exit `0`=완료, `3`=`reclaim`에서 풀리지 않은 행이 하나라도 있음(dry-run 포함), `1`=오류(stderr에 `{"code":...}`만).

## reclaim-report (읽기 전용)

```sh
printf '%s' "$DR_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts reclaim-report --database-url-stdin \
  [--client-bound=<budget>]... [--deadline=<budget>:<ms>]... [--skew-ms=<ms>] > reclaim-report-before.json
```

모든 owner의 `dispatched`/`indeterminate` 모델 행과 HTTP hop을 `reclaim`과 같은 판정 함수로 분류한 뒤 ROLLBACK한다.
행을 잠그지 않고 fence 상태와 무관하게 읽는다. `result.siteActive`가 `false`면 fenced DB이고 `reclaim`은 거절된다.
`--apply`·`--reference`·`--operator`는 받지 않는다.

| status | 의미 | 다음 |
|---|---|---|
| `reclaimable` | 근거 있음, `notBefore` 지남 | `reclaim`으로 풀 수 있다 |
| `waiting` | 근거 있음, `notBefore` 전 | `notBefore` 뒤 다시 본다 |
| `policy_blocked`(모델만) | 근거 있음, budget 미선언 또는 provider_bound인데 D 없음(`provider_deadline_unknown`) | D가 증명되기 전에는 그대로 둔다 |
| `unproven` | 근거 없음 | 이 도구로는 풀리지 않는다 |

모델 행은 `evidence`(`process_group_exit`/`local_call_ended`/`null`)도 보여 준다. 두 근거가 다 있으면 `notBefore`가 먼저 오는 쪽을 쓴다.

| `unproven` reason | 의미 |
|---|---|
| `dispatch_time_unknown` | 모델 행에 `dispatched_at`도 `dispatch_started` event도 없음 |
| `owner_not_opened_before_dispatch` | 그 owner의 `owner_opened`가 없거나 dispatch 뒤(기록기 없는 프로세스) |
| `spawn_sequence_gap` | spawn 의도 번호 공백(기록 유실) |
| `no_spawn_before_dispatch` | dispatch 시각까지 기록된 의도 없음 |
| `spawn_not_exited:<seq>` | 그 child 그룹의 종료 기록 없음(살아 있거나 슈퍼바이저가 기록하지 못함) |
| `spawned_record_missing:<seq>` / `exit_mismatch:<seq>` | spawned·종료 기록이 의도와 맞지 않음 |
| `local_end_state_mismatch` / `local_end_owner_mismatch` / `local_end_binding_mismatch` | 로컬 종료 사실이 `dispatched` 행에 있거나 다른 owner·binding의 것 |

## reclaim (기본 dry-run)

```sh
printf '%s' "$DR_DATABASE_URL" | node --import tsx scripts/ops/dr/promotion.ts reclaim --database-url-stdin \
  [--client-bound=<budget>]... [--deadline=<budget>:<ms>]... [--skew-ms=<ms>] --reference=<정책 출처> --operator=<이름>
# 승인 뒤 같은 명령에 --apply 를 붙여 commit 한다
```

- 모델 장부와 HTTP permit은 각자 짧은 TX다(모델 먼저). 각 TX는 fence SHARE가 첫 lock이고, fenced면 `dr_writer_site_fenced`(exit 1)로 아무것도 바꾸지 않는다.
  모델은 행마다 control → 요청 행을, HTTP는 `http_origin_control` → 대상 hop 전체를 잠근 뒤 근거를 다시 읽어 보고와 같은 판정을 한다.
- dry-run은 같은 TX를 실제로 실행한 뒤 ROLLBACK한다. dry-run 출력의 `released: true`는 commit했다면 풀렸을 행이다.
- `result.model.rows[]`는 `{requestId, released, reason}`, `result.http.rows[]`는 `{hopId, released, reason}`다.
  reason은 보고와 같고(`waiting`·`provider_deadline_unknown`·위 표), 추가로 `not_active`(판정 사이에 이미 다른 상태)·`owner_invalid`(hop owner 모양이 틀림)가 있다.
- 근거 없는 행이 남아 있으면 `--apply`가 성공해도 exit 3이 정상이다.
- 두 TX가 따로라 모델이 commit된 뒤 HTTP TX가 실패할 수 있다(exit 1). 그때는 `reclaim-report`로 남은 상태를 다시 본다.
- `--reference`·`--operator`는 모든 근거 JSON에 남는다. 도구는 reference 내용을 검증하지 않는다.

## 순서

1. `reclaim-report`로 현재 상태를 `reclaim-report-before.json`에 남긴다.
2. 선언할 budget과 그 근거(`--reference`)를 정해 사용자 승인을 받는다. 증명이 없는 budget은 선언하지 않는다.
3. 같은 정책으로 `reclaim` dry-run을 돌려 `released: true` 목록이 보고의 `reclaimable`과 같은지 본다.
4. 승인 뒤 같은 명령에 `--apply`를 붙이고 출력을 보관한다.
5. `reclaim-report`를 다시 돌려 풀린 행이 빠지고 남은 행의 reason이 그대로인지 확인한다.

## 배포 순서

1. **0099 적용(소비자 drain 상태).** 0099는 `model_capacity_requests` CHECK 2개와 `model_capacity_events` kind CHECK를 drop/add하고(ACCESS EXCLUSIVE·표 전체 재검증),
   `http_origin_events`에 nullable `evidence` 열과 CHECK를, 두 events 표에 부분 unique index를 만든다(CONCURRENTLY 아님).
   `scripts/migrate.mjs`는 lock timeout 10초라 쓰는 소비자가 있으면 실패할 수 있다.
   [독립 워커 운영 절차](../operations/independent-workers-runbook.md)의 기존 절차대로 소비자를 drain한 뒤 한 번 실행하고 종료 코드 0을 확인한다.

   ```sql
   -- 2행이면 0099 적용됨
   SELECT indexname FROM pg_indexes
   WHERE indexname IN ('model_capacity_events_local_end_idx', 'http_origin_events_reclaimed_idx');
   ```

2. **코드 배포(`MODEL_CAPACITY_LOCAL_END` 미설정).** 꺼져 있으면 게이트웨이 호출은 원래 undici fetch 그대로이고 로컬 종료 사실을 남기지 않는다. 바뀌는 것은 둘이다.
   - 기록하는 슈퍼바이저의 child env에 `PROCESS_GROUP_OWNER_INSTANCE_ID`·`PROCESS_GROUP_OWNER_BOOT_ID`가 붙고, 같은 instance면 child의 HTTP hop·consumer item(장부) owner가 그 boot를 쓴다.
   - 켜진 AI1/AI2 consumer 슈퍼바이저가 spawn 전에 `dr_process_group_events`에 의도를 기록한다. 기록하지 못하면 child를 띄우지 않고 exit 1이다(`supervisor.spawn_intent_failed` 로그).
     배포 뒤 consumer가 child를 정상으로 띄우는지 확인한다.
3. **회수는 운영자 수동 CLI만.** 위 순서대로, 사용자 승인 뒤에만 실행한다.
4. **`MODEL_CAPACITY_LOCAL_END=1`은 0099를 확인한 뒤 웹과 워커 모두에 켠다.** 게이트웨이 모델 호출은 웹(검색어 번역 등)과 워커 양쪽에서 일어나고, 켠 프로세스의 호출만 사실을 남긴다.
   미설정/`0`=꺼짐, `1`=켜짐이다. 다른 값(`true` 등)이면 게이트웨이 fetch가 요청을 보내기 전에 `invalid_model_capacity_local_end`로 throw하고,
   호출부는 이를 일반 전송 실패(`network`·`gateway_error`)로 받아 그 행을 `indeterminate`로 표시한다. 사실도 남지 않아 호출마다 근거 없는 점유가 쌓이므로 값이 정확히 `1`인지 확인한다.
   0099 전에는 `dispatch_local_ended`가 kind CHECK에 막히고 그 오류는 삼켜져 근거가 생기지 않는다.
   다시 끄면 새 사실만 멈추고, 이미 남은 사실은 append-only로 남아 `reclaim`이 계속 근거로 쓴다.

## 열린 결정

- **AI2 consumer instance id 일치 강제 여부.** AI1 consumer(`scripts/pipeline-first-consumer.ts`)는 `PIPELINE_ITEM_CONSUMER_INSTANCE_ID`가 `SERVICE_INSTANCE_ID`와 다르면
  시작하지 않는다(`invalid_item_consumer_service_instance`). AI2 consumer(`scripts/pipeline-consumer.ts`)는 강제하지 않는다.
  두 값이 다르면 AI2 child의 장부 행은 기록된 boot를 쓰지만 HTTP hop은 새 boot를 받아 group 근거로 회수되지 않는다. 강제할지는 아직 정하지 않았다.

## 이 도구가 증명하지 않는 것

provider 쪽 생성 종료·실제 사용량, 운영자가 선언한 D·client_bound의 사실성(reference는 기록만 한다), 슈퍼바이저가 기록하지 못한 종료, 기록기 없는 프로세스의 호출 종료.
