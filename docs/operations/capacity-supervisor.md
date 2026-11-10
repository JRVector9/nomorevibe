# 도우미 장비 감시자(Oracle `capacity-supervisor`) — 동작·계정·켜고 끄기·실패 모드 (PR 2a WP-2a-B)

작성: 2026-10-31 UTC. 설계 근거 `pr2-plan.md` §0(D1·D2)·§3. 표·입장 CTE 는 WP-2a-A(migration 0154, `lib/llm/capacity-helpers.ts`),
관리자 화면 `/admin/models/helpers` 는 WP-2a-C 다. **배포 직후 동작은 바뀌지 않는다**: control `enabled=false`, 배정 행 없음,
consumer 는 `CAPACITY_SUPERVISOR_VERSION=1` 없이는 DB 를 열지 않는다. 운영에서 아직 확인하지 않은 것은 맨 아래 「남은 확인」이다.

## 무엇을 하나

- **측정은 집, 판정은 Oracle, 집행은 Layer A(D2).** 집 잡(main 역할)이 자기 역할 대기를 `model_role_demand` beacon 으로 쓰고, 감시자가 장부·장비·
  도우미 표와 그 beacon 을 읽어 판정을 `model_helper_signals`(배정별 help/shadow_only/hold)·`model_device_signals`(빌려주기 제한)에 쓴다.
  입장 TX(`helperGateCte`)만 그 신호를 읽는다.
- **신호는 선택적 도우미 경로를 열거나 빌려주기를 줄일 뿐, 우선 역할 일을 막지 못한다(D1).** 신호가 없거나·만료·다른 epoch·다른 판·
  다른 계정이면 도우미는 닫힌다. 빌려주기 제한 신호가 신선하지 않으면 무시된다(PR 1b 장부 규칙). 신선도는 언제나 DB `clock_timestamp()` 다.
- 프로세스: Oracle consumer `capacity-supervisor`(부모 역할 `maintenance`, 자식 `scripts/capacity-supervisor-consumer.ts`, pool 1,
  unit `nomorevibe-core-consumer@capacity-supervisor`). 건을 claim 하지 않는다. Python watchdog(DB 자격 없음)과는 다른 프로세스다.
  집 쪽 대기 프로세스는 PR 2 에 없다(lease·epoch 가 나중 추가를 허용한다).

### 순환(`lib/operations/capacity-supervisor/loop.ts`, `control.loop_ms` 기본 15 s)

| 단계 | 내용 | 실패·예외 |
| --- | --- | --- |
| 0 | 시작 때 `current_user`·`session_user` 가 정확히 `nomorevibe_oracle_capacity_supervisor` 인지 본다 | 아니면(main `nomorevibe` 포함) 아무것도 쓰기 전에 `supervisor_principal_mismatch` 로 끝난다 |
| TX-A | DR fence SHARE → `UPDATE model_supervisor_control` lease(owner·boot 가 바뀌면 epoch+1, `lease_until = now + 3×loop_ms`, `loop_seq+1`) | fence 가 active 가 아니면 쓰지 않음(`fenced`). 다른 owner 의 lease 가 살아 있으면 `standby`(쓰지 않음). `signal_principal ≠ current_user` 면 종료 |
| 2 | `enabled=false` 면 신호를 쓰지 않는다 | 남은 신호는 TTL(기본 45 s) 안에 만료 → 도우미 닫힘. 관측 `disabled` |
| 3 | 스냅샷(REPEATABLE READ READ ONLY 한 TX): control·정책 route·`readModelCapacityDeviceStates`·배정·신호·현재 판 정지·beacon·건강 창 장부 행·AI2 대기 나이·섀도/실전 집계 | 읽기 오류 ⇒ 그 순환은 아무것도 쓰지 않음 |
| 4 | `decideHelper`·`decideDeviceDemand`(순수, `decide.ts`) | — |
| TX-B | fence SHARE → lease 재확인(owner·boot·epoch 같고 `lease_until > now`, heartbeat 만 갱신) → 신호 upsert(`observed_at = t`, `valid_until = t + signal_ttl_ms`, `written_by = current_user`) → 정지 insert | 재확인 0 행 ⇒ `lease_lost`, 아무것도 쓰지 않음. 그 사이 꺼졌으면 `disabled`. 배정 version 이 판정 때와 다르면 그 배정 신호는 건너뜀 |
| 6 | 관측 `capacity-supervisor:<instance>`(state·epoch·lease·지연·배정별 `verdict:reason`·장비별 primary_demand) | 관측 실패는 무시(신호와 무관) |

오류가 나면 기록하고 `min(loop_ms, 5 s × 연속 실패)` 뒤 다시 돈다. 긴 기다림은 30 s 조각으로 끊어 감독 진행 기한(90 s) 안에 `idle` 을 보고한다.

### 판정(`decide.ts`) — 앞에서 맞는 것이 이긴다

1. mode `off` → hold/`mode_off`
2. 현재 version 의 정지(effect `stop`) → hold/`auto_stopped`
3. 스냅샷 불완전(도우미 장비 상태·집계 없음) · 주 장비 모름 · 자기 역할 beacon 없음/만료 → hold/`stale_inputs`
4. 건강 위반 → hold + 정지 제안. 미확인: 건강 창 장부 n ≥ 10 이고 비율 > `max_unknown_rate`, 또는 연속 3 → `stop`/`unknown_rate`.
   실패: n ≥ 10 이고 (failed + not_started)/n > `max_failure_rate` → `stop`/`failure_rate`. 실전(mode live)만: AI2 불일치 n ≥ 20 이고
   > `max_live_disagreement`, 또는 rolling 100 섀도 일치율 < `min_agreement − 0.05`(결정 쌍 ≥ 20) → `demote_to_shadow`/`quality_regression`.
   같은 판에 강등 정지가 이미 있으면 강등 위반은 처리된 것으로 보고 건너뛴다(섀도 표본은 계속 쌓인다).
5. 자기 역할 바쁨(장부 `primaryBusy` 또는 beacon backlog > 0) → hold/`helper_own_work` — 즉시, 머무름을 무시
6. 이어지는 `help`(같은 epoch·같은 판·이전 신호 유효) 이고 돕기 가능(mode live, 강등 정지 없음): 주 장비 가득 → help. 아니면 나가기 streak+1,
   streak ≥ `exit_samples` 이고 help 에 `min_help_ms` 이상 있었을 때만 → shadow_only|hold/`primary_not_full`(`last_exit_at = now`)
7. 그 밖: 가득이면 들어가기 streak+1. streak ≥ `enter_samples`, 마지막 나감 뒤 `reenter_cooldown_ms`, 돕기 가능 ⇒ help.
   아니면 shadow_only(mode ∈ {shadow, live} 이고 최근 1시간 섀도 실행 < `shadow_per_hour`) | hold

- **주 장비 가득** = 주 장비가 하나 이상이고 *모두* `active ≥ limit_slots` 이고 대기 ≥ 1. AI2 는 더해서 그 장비의 local-direct `second-review`
  대기 행이 15 s 이상. 주 장비: ai1 = AI1 beacon `model_role_demand['ai1'].metrics.devices`(감시자는 `crawl_settings` 를 못 읽는다, Q9) − 도우미 장비;
  ai2 = 정책 route `second-review`/local-direct 의 groupId − 도우미 장비. 빈 목록은 가득이 아니다.
- **건강 창** = 최근 30 분과 배정 마지막 저장(`updated_at`) 뒤 중 짧은 쪽. 그래서 「자동 정지 해제」(다시 저장 = version+1)는 새 창으로 시작한다.
  장부: settled = 끝남, indeterminate = 미확인, dispatch 뒤 withdrawn = not_started. 장부에는 실패 상태가 없어 failed 는 같은 창의 섀도 실행
  `failed` 수다. 섀도 집계는 현재 `evidence_key` 의 최근 1000 실행, 실전 결과는 현재 version·evidence_key 의 최근 200.
- 새 epoch·새 배정 판·만료된 이전 신호는 streak 를 버리고 7 단계 0 부터 센다. `last_exit_at` 은 이어 온다(재진입 대기를 지키는 쪽).
- 기본값(배정 행에서 바꿈): enter 2 표본(≥ 30 s), exit 4 표본 + help 최소 120 s, 재진입 대기 60 s. TTL 45 s ⇒ 감시자가 죽으면 45 s + 돌던 호출 1건 안에 닫힌다.
- **빌려주기 제한(`decideDeviceDemand`)**: mode 가 `off` 가 아닌 배정의 장비만. `primary_demand = 신선한 beacon backlog > 0`, 신선한 beacon 이 없으면
  false + `metrics.reason` `stale`|`missing`(Layer A 는 장부 규칙으로 돌아간다). 도우미가 모두 꺼진 장비에는 쓰지 않는다(PR 1b 동작 그대로).
- **정지는 append-only, 판(version)별 한 번.** stop 은 stop 이 없을 때, demote 는 정지가 하나도 없을 때만 넣는다. 관리자가 다시 저장할 때까지 유지된다.

신호 `metrics` 키(관리자 표 `HELPER_METRIC_KEYS`): `primaryFull`·`primaryActive`·`primaryLimit`·`primaryWaiting`·`primaryDevices`·`ownBacklog`·
`shadowSamples`·`shadowAgreement`·`shadowWrongApproval`·`shadowWrongRejection`·`shadowUnknownRate`·`shadowFailureRate`(비율 0–1, 분모 0 이면 없음).
그 밖의 키(`ownBusy`·`dispatchN`·`consecutiveUnknowns`·`liveDisagreed` 등)는 진단용이다.

### 집 쪽 beacon(`lib/operations/role-demand.ts`, main 역할)

- `publishRoleDemand(input, ttlMs)`: 자기 TX(fence SHARE)로 upsert, 어떤 오류도 던지지 않는다(false). replay·fenced DB 에는 쓰지 않는다.
  `createRoleDemandPublisher('humanReview'|'ai1')` 는 `ROLE_DEMAND_BEACONS` 의 role·device·TTL 을 채우고 `minIntervalMs`(ai1 15 s)로 줄인다.
- 부르는 곳(WP-2a-C 가 넣는다): `human-deepseek-review` 틱 끝(`human-review`/`m3-deepseek`, backlog = 남은 사람+합의 id, TTL 150 s),
  AI1 consumer page loop(`ai1`/`ai1-pool`, `{backlog, pausedAll, devices}`, 15 s 마다, TTL 45 s).
- beacon 이 없거나 만료되면 감시자는 그 역할을 **바쁨**으로 본다 → 도우미는 쉰다. 쓰기 실패가 일을 막는 일은 없다.

## 계정(`nomorevibe_oracle_capacity_supervisor`, statement_timeout 10 s)

단일 출처는 `lib/runtime/oracle-db-profile.ts` 의 `ORACLE_CONSUMER_DB_PROFILES['capacity-supervisor']` 이고, `deploy/oracle/least-privilege.sql` 의
`-- consumer capacity-supervisor` 절은 `renderOracleDbGrantSql()` 와 바이트가 같다(시험). 계정 기본값: LOGIN NOINHERIT, lock_timeout 5 s,
idle_in_transaction 60 s, timezone UTC.

| 표 | 권한 |
| --- | --- |
| `dr_writer_fence` | SELECT, UPDATE(id) — SHARE fence 용 |
| `model_supervisor_control` | SELECT, UPDATE(owner_instance_id, owner_boot_id, epoch, lease_until, heartbeat_at, loop_seq, release) — `enabled`·`signal_*`·`loop_ms` 는 못 바꾼다 |
| `model_helper_signals` | SELECT, INSERT, UPDATE(assignment_version, supervisor_epoch, verdict, reason, streak, state_since, last_exit_at, metrics, observed_at, valid_until, written_by) |
| `model_device_signals` | SELECT, INSERT, UPDATE(supervisor_epoch, primary_demand, backlog, metrics, observed_at, valid_until, written_by) |
| `model_helper_stops` | SELECT, INSERT (+ `model_helper_stops_id_seq` USAGE) — UPDATE·DELETE 없음 |
| `model_helper_assignments`·`model_role_demand`·`model_capacity_devices`·`model_capacity_device_roles` | SELECT |
| `model_helper_shadow_runs` | SELECT(id, assignment_id, evidence_key, stage, state, primary_decision, helper_decision, agreement, error_code, latency_ms, created_at, completed_at) |
| `model_helper_live_outputs` | SELECT(id, assignment_id, assignment_version, evidence_key, stage, helper_decision, downstream, created_at, downstream_at) |
| `model_capacity_control` | SELECT(id, mode, epoch, revision, policy, policy_hash, updated_at) |
| `model_capacity_requests` | SELECT(request_id, state, class, pool, route_id, provider, model, group_id, epoch, revision, policy_hash, queued_at, queue_until, reserved_until, dispatched_at, settled_at, updated_at) |
| `operations_observations` | SELECT, INSERT, UPDATE(value, observed_at) — 키는 0107 함수 확장이 `capacity-supervisor:`·`service:maintenance:` + `capacity-supervisor-consumer-*` 로 좁힌다(0154) |

**Layer A 쪽 읽기(PR 2a, 0154).** 입장 TX 가 `helperGateCte` 로 `model_supervisor_control`·`model_helper_assignments`·`model_helper_signals`·
`model_helper_stops`·`model_device_signals` 를 읽으므로, 같은 파일의 job 실행 계정 넷(translation·product-health·site-evidence·official-news)에
그 다섯 표 SELECT 가 더해졌다(`LIVE_SETTINGS` 의 `HELPER_GATE_SETTINGS`). 운영에는 그 네 계정이 아직 없다(consumer 들은 main 역할로 붙는다) —
프로필 정합성이고, 계정을 만드는 날 함께 적용된다. 새로 운영자가 만들어야 하는 것은 감시자 계정 하나다.

없는 것: crawl·도메인 표, `jobs`·`role_leases`·`job_batch_*`·`pipeline_item_leases`, `runtime_settings`·`model_serving_contracts`, 장부 쓰기,
`dispatch_binding`·`terminal_evidence`·owner·work key 열, 섀도 `helper_outcome`·`job_token`·입력 hash. `written_by` 가 UPDATE 목록에 있는 것은
쓰는 SQL 이 `current_user` 를 넣기 때문이고(0154 stamp 트리거도 같은 값으로 다시 쓴다), 입장은 `written_by = control.signal_principal` 일 때만 믿는다 —
main 역할 프로세스도 신호를 위조할 수 없다.

### 계정 만들기 SQL(그대로, `least-privilege.sql` 의 같은 절과 바이트가 같다)

`:capacity_supervisor_connections` 는 psql 변수(아래 절차에서 2). 비밀번호는 이 SQL 에 없다.

```sql
BEGIN;
CREATE ROLE nomorevibe_oracle_capacity_supervisor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :capacity_supervisor_connections;
ALTER ROLE nomorevibe_oracle_capacity_supervisor SET statement_timeout = '10s';
ALTER ROLE nomorevibe_oracle_capacity_supervisor SET lock_timeout = '5s';
ALTER ROLE nomorevibe_oracle_capacity_supervisor SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE nomorevibe_oracle_capacity_supervisor SET timezone = 'UTC';
GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT ON TABLE public.dr_writer_fence TO nomorevibe_oracle_capacity_supervisor;
GRANT UPDATE (id) ON TABLE public.dr_writer_fence TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT (id, mode, epoch, revision, policy, policy_hash, updated_at) ON TABLE public.model_capacity_control TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT ON TABLE public.model_capacity_device_roles TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT ON TABLE public.model_capacity_devices TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT (request_id, state, class, pool, route_id, provider, model, group_id, epoch, revision, policy_hash, queued_at, queue_until, reserved_until, dispatched_at, settled_at, updated_at) ON TABLE public.model_capacity_requests TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT, INSERT ON TABLE public.model_device_signals TO nomorevibe_oracle_capacity_supervisor;
GRANT UPDATE (supervisor_epoch, primary_demand, backlog, metrics, observed_at, valid_until, written_by) ON TABLE public.model_device_signals TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT ON TABLE public.model_helper_assignments TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT (id, assignment_id, assignment_version, evidence_key, stage, helper_decision, downstream, created_at, downstream_at) ON TABLE public.model_helper_live_outputs TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT (id, assignment_id, evidence_key, stage, state, primary_decision, helper_decision, agreement, error_code, latency_ms, created_at, completed_at) ON TABLE public.model_helper_shadow_runs TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT, INSERT ON TABLE public.model_helper_signals TO nomorevibe_oracle_capacity_supervisor;
GRANT UPDATE (assignment_version, supervisor_epoch, verdict, reason, streak, state_since, last_exit_at, metrics, observed_at, valid_until, written_by) ON TABLE public.model_helper_signals TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT, INSERT ON TABLE public.model_helper_stops TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT ON TABLE public.model_role_demand TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT ON TABLE public.model_supervisor_control TO nomorevibe_oracle_capacity_supervisor;
GRANT UPDATE (owner_instance_id, owner_boot_id, epoch, lease_until, heartbeat_at, loop_seq, release) ON TABLE public.model_supervisor_control TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT, INSERT ON TABLE public.operations_observations TO nomorevibe_oracle_capacity_supervisor;
GRANT UPDATE (value, observed_at) ON TABLE public.operations_observations TO nomorevibe_oracle_capacity_supervisor;
GRANT SELECT ON TABLE public.runtime_settings TO nomorevibe_oracle_capacity_supervisor;
GRANT USAGE ON SEQUENCE public.model_helper_stops_id_seq TO nomorevibe_oracle_capacity_supervisor;
COMMIT;
```

### 운영자 절차(주 DB 관리자, 명시 승인 뒤)

```sh
# 1) 이 절만 뽑아 적용한다(least-privilege.sql 전체는 이미 있는 계정 때문에 다시 돌릴 수 없다)
sed -n '/^-- consumer capacity-supervisor$/,/^$/p' deploy/oracle/least-privilege.sql > /tmp/capacity-supervisor-principal.sql
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v capacity_supervisor_connections=2 -1 -f /tmp/capacity-supervisor-principal.sql
# 2) 비밀번호는 대화형으로만
psql "$ADMIN_DATABASE_URL" -c '\password nomorevibe_oracle_capacity_supervisor'
```

연결 수 2 = 감독(부모) 1 + 자식 pool 1(host DB 장부 `role-parent` 1 + `worker` 1). 상태 화면용 읽기 전용 monitor 역할에는 따로:

```sql
GRANT SELECT ON TABLE public.model_supervisor_control, public.model_helper_assignments, public.model_helper_signals, public.model_device_signals,
  public.model_role_demand, public.model_helper_stops, public.model_helper_shadow_runs, public.model_helper_live_outputs TO nomorevibe_monitor_20261022;
```

3) Oracle host: `install_units.py --consumer capacity-supervisor` 로 unit·`consumer-capacity-supervisor.env` 자리를 만들고 env 에
`SERVICE_INSTANCE_ID=capacity-supervisor-consumer-oracle`(접미 ≤ 19자), `WORKER_ROLE=maintenance`, `DATABASE_URL`(이 계정), `DB_POOL_MAX=1`,
`HOST_DB_BUDGET`(`policy.consumers` 에 `capacity-supervisor`, `process.consumer=capacity-supervisor`), `DB_POOLER_MODE=direct` 이면
`DB_STATEMENT_TIMEOUT_MS=10000`, `CAPACITY_SUPERVISOR_VERSION=1`. `HOST_BUDGET_ENFORCEMENT`·`EMERGENCY_ADMISSION` 은 두지 않는다(거절한다).
4) `launch.py --consumer=capacity-supervisor` 의 preflight 가 identity·database(정확 일치)·timeouts·timezone·consumer 를 verified 로 보아야 시작한다.
consumer 준비 확인: control 행이 있고 `signal_principal = 이 계정`(꺼져 있어도 verified, 다르면 rejected).

## 켜고 끄기

| 스위치 | 위치 | 효과 |
| --- | --- | --- |
| 전역 kill switch `model_supervisor_control.enabled` | 관리자 「도우미 장비」 감시자 카드(WP-2a-C, `setSupervisorControl`, 감사 `model-supervisor-toggle`) | 끄면 다음 입장 TX 부터 새 도우미 grant 없음(입장이 `sup.enabled` 를 본다), 감시자는 신호를 쓰지 않고 쉰다. 돌고 있는 호출은 끝까지 간다 |
| 배정 mode `off/shadow/live` | 관리자 도우미 표 | `off` ⇒ hold/`mode_off`, 그 장비의 빌려주기 제한 신호도 쓰지 않음 |
| 프로세스 `CAPACITY_SUPERVISOR_VERSION=1` | Oracle env | 없으면 DB 를 열지 않고 `disabled` 로 끝난다 |
| unit | `systemctl stop nomorevibe-core-consumer@capacity-supervisor` | 신호가 TTL 안에 만료 → 도우미 닫힘. 우선 역할 영향 없음 |

켜는 순서(배포 노트): 계정·GRANT → host 장부 → monitor GRANT → DRAIN 창에서 rev14 도우미 route → 배정(mode `off`) → OPEN → 감시자 프로세스 →
마지막에 관리자 `enabled` 켜기. `signal_ttl_ms`(15–300 s)·`loop_ms`(5–60 s, `loop_ms × 2 ≤ ttl`)는 관리자가 바꾼다.

## 실패 모드

| 상황 | 감시자 | 도우미·입장 |
| --- | --- | --- |
| 프로세스 죽음·Oracle 끊김·DB 끊김 | — | 신호 TTL(45 s) 안에 만료 → 닫힘. lease 만료(3×loop_ms) 뒤 다른 boot 가 epoch+1 로 이어받는다. 우선 역할 영향 없음 |
| main 역할/다른 계정으로 연결 | 시작 때 `supervisor_principal_mismatch` 로 종료, 아무것도 쓰지 않음. Oracle 에서는 preflight `database` 가 먼저 닫는다 | 신호 없음 → 닫힘 |
| 관리자가 `signal_principal` 변경 | TX-A/TX-B 가 `principal_ok=false` → 종료 | 기존 신호는 `written_by ≠ signal_principal` 로 즉시 무시 |
| 둘이 동시에 실행 | lease 없는 쪽은 `standby`(쓰지 않음) | 영향 없음 |
| lease 를 잃은 채 TX-B | 재확인 0 행 ⇒ `lease_lost`, 아무것도 안 씀 | 이전 epoch 신호는 무시 |
| DR fence `fenced` | `fenced`, lease·신호 모두 쓰지 않음 | 닫힘 |
| 스냅샷·쓰기 오류(statement timeout 10 s, lock_timeout 5 s 등) | 그 순환 아무것도 안 씀, 관측 `error` + `lastError`, backoff 뒤 재시도 | TTL 안에 닫힘 |
| beacon 없음·만료(집 잡 멈춤) | 해당 배정 hold/`stale_inputs`(ai1 주 장비 모름 포함), 장비 신호 `primary_demand=false`(reason stale/missing) | 도우미 닫힘, 빌려주기는 장부 규칙 |
| 관측 키 거절(0107 확장 전후 키 범위) | 관측만 실패(무시) | 영향 없음 |
| 미확인·실패 급증 | 정지 행(`stop`) 1건 + hold | 두 경로 모두 닫힘, 관리자 재저장까지 |

알려진 남은 위험: lock 용 UPDATE(id) 로 `dr_writer_fence` 행을 FOR UPDATE 로 문장 10 s·idle 60 s 까지 쥘 수 있다(다른 Oracle consumer 와 같다).
TX-B 의 신호 insert 는 FK 검사로 배정 행에 KEY SHARE 를 걸므로, 관리자 저장이 배정 행 FOR UPDATE 를 쥔 채 `model_supervisor_control` 을 잠그면
lock_timeout(5 s)으로 그 순환이 실패한다(다음 순환이 다시 쓴다).

## 시험

- 단위: `tests/capacity-supervisor-decide.test.ts`(우선순위·streak·머무름·재진입·epoch/판/만료 초기화·최소 표본·no flapping·metrics 키),
  `tests/capacity-supervisor-loop.test.ts`(스냅샷 builder·가짜 의존성 순환·main 역할 거절·standby/disabled/fenced 무쓰기·오류 fail-closed),
  `tests/capacity-supervisor-registration.test.ts`(등록 다섯 자리·host 장부·정확한 GRANT·준비 확인·진입점), `tests/role-demand.test.ts`,
  `tests/oracle-db-profile.test.ts`, `tests/test_oracle_activation.py`(`CapacitySupervisorLauncherTests`).
- 통합(DB): `tests/integration/capacity-supervisor.test.ts` — 생성 SQL 로 만든 실제 계정으로 lease·standby·빼앗기·lease 잃은 TX-B·꺼짐·판 이동·
  연속 미확인 정지 1회·입장 CTE 개폐·42501 거절·main 역할 거절. `tests/integration/oracle-consumer-db-roles.test.ts` 가 이 계정의 preflight 전체를 본다.

## 남은 확인(운영 영수증으로만 기록한다)

- 운영 DB 에 계정·GRANT 적용, monitor GRANT, Oracle unit 기동과 preflight `ready` — 아직 하지 않았다.
- 0154 stamp 트리거(`model_signal_stamp`: `written_by := current_user`, `observed_at := clock_timestamp()`)·`model_helper_stops` append-only·0107 관측 키
  확장(`capacity-supervisor-consumer-` 뒤 `{1,19}`, host-slot 키 없음)은 WP-2a-A migration(aef62826)이다. 감시자·beacon 의 INSERT 는 NOT NULL 인
  `written_by`·`observed_at` 에 같은 뜻의 값(current_user·한 `clock_timestamp()` t)을 직접 넣고 `valid_until = t + ttl` 이라 트리거가 다시 쓴 뒤에도
  `valid_until > observed_at` 다. 이 브랜치의 통합 시험은 트리거 없는 0154 골격 위에서 돌았다.
- 45 s fail-close 드릴(감시자를 멈추고 판정 만료·도우미 닫힘 확인), 첫 섀도 표본 — PR 2b 이후.
