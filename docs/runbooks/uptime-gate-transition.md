# uptime raw→gate 2단계 전환 runbook (PR09b)

PR09의 제품 연결 관측은 `uptime_control` 한 행으로 세 상태를 오간다.

| 상태 | observations_enabled | gate_enabled | 의미 |
|---|---|---|---|
| disabled | false | false | 기존 `recordPing` 경로. raw 기록 없음 |
| raw-only | true | false | raw 관측을 남긴다. M3/mini 관측은 기존처럼 health에 반영, Oracle 관측은 `raw_only`(health 미반영) |
| gate | true | true | `regional-v1` 판정. 불확실한 실패는 `observation_hold`, 목록 숨김(3회)·자동 내림(10회)은 인증된 관측만 |

전환은 `scripts/ops/uptime-gate.ts`로만 한다. 이 문서의 운영 단계는 **모두 사용자 승인 뒤** 실행한다.

## 먼저 알아야 할 것

1. **observations를 켜면 sources에 없는 실행자의 uptime-ping은 즉시 실패한다**(`uptime_source_unconfigured`).
   maintenance·product-health 역할 후보(`operations_observations`의 `candidate:<역할>:<인스턴스>`, 최근 24h)를 모두 sources에 넣어야 한다.
   도구가 이를 확인하고, 빠지면 거절한다(`uptime_runner_unconfigured:<id>`).
2. **raw-only에서 Oracle 관측은 health를 쓰지 않는다.** Oracle이 유일한 uptime 실행자이면 그동안 권위 health(`checked_at`·연속 실패)가 멈춘다.
   raw-only 동안 M3/mini가 uptime-ping을 실제로 돌리는지 확인한다(`job_batch_control`이 versioned면 product-health 선출 순서는 oracle→m3→mini다).
3. **uptime-ping은 job lease로 한 번에 한 실행자만 돈다.** 다른 지역 관측이 30분(`UPTIME_EVIDENCE_MS`) 안에 같은 제품을 볼 일이 드물다.
   그래서 Oracle 실패·403·transport 실패에 필요한 독립 지역 확증이 거의 성립하지 않고, 이들은 사실상 계속 hold된다.
4. **`regional-v1`의 `broad_network_failure`는 30분 안 한 host의 실패 origin 3개 이상이다.** 운영 규모(분당 150건 → 30분 약 4,500건, 응답 없음 약 1.6% — 코드 주석의 593/약 36,000 기준 추정)에서는 이 조건이 거의 항상 성립해 실패 대부분이 hold된다.
   `plan gate`의 shadow 판정이 이 비율을 재고, 50%를 넘으면 거절한다. 정책 보정은 별도 결정 사항이다(이 도구는 정책 값을 바꾸지 않는다).
5. **gate를 켜면 revision이 오른다.** 기존 health 연속 실패는 새 revision으로 인증되지 않으므로, 지금 목록에서 숨겨진 제품이 **즉시 다시 보인다**(`status`의 `impact.hiddenNow`).
   10회 자동 내림은 gate 아래에서 새로 인정된 실패 10회(6시간 간격, 60시간 이상) 뒤에야 가능하다.
6. revision은 **되돌리지 않고 항상 올린다**(rollback 포함). 옛 gate 인증이 같은 번호로 다시 살아나지 않게 하기 위해서다.
7. 한 지역 관측만 실패하고 다른 지역이 같은 주소를 30분 안에 열었다면(`regional_conflict`) gate는 그 실패를 제품 실패로 세지 않는다(PR09b 보정).

## 실행 환경

- 실행 위치: 운영 DB primary에 쓰기로 접속 가능한 maintenance 계열 컨테이너. 예: `node --import tsx scripts/ops/uptime-gate.ts <명령>`
- DB URL은 `UPTIME_GATE_DATABASE_URL` 환경변수로만 준다. 앱의 `DATABASE_URL`로 대체하지 않는다. 복제본 URL은 쓰지 않는다.
  `PGHOST`·`PGHOSTADDR`·`PGPORT`·`PGSERVICE`·`PGSERVICEFILE`·`PGOPTIONS`가 있으면 거절한다. URL을 명령 인자로 주면 거절한다.
- 출력은 JSON 한 줄. exit `0`=완료, `3`=근거 부족으로 거절(아무것도 쓰지 않음), `1`=오류(stderr에 고정 code만).
- 쓰기 명령(`apply`·`rollback`)은 기본 dry-run이다. 같은 트랜잭션(잠금·CAS·감사 기록)을 실제로 실행한 뒤 ROLLBACK한다. `--apply`가 있어야 commit한다.
- 모든 쓰기는 `--expect-revision=<status의 control.revision>`이 현재 값과 같을 때만, 판정한 control 행(플래그·sources)과 정확히 같을 때만 바뀐다. 아니면 `uptime_control_revision_conflict`.
- 성공한 전환은 `operations_audit`(`uptime-control-transition`/`uptime-control-rollback`, target `uptime_control`)에 before/after와 판정 근거를 남긴다.

## 순서

### 0. 현재 상태 기록

```sh
node --import tsx scripts/ops/uptime-gate.ts status > uptime-gate-status-before.json
```

`control`(disabled, revision `R0`), `runners`, `impact`를 기록한다.

### 1. sources 파일 작성

호스트당 하나, 최대 3개. `instanceId`는 각 실행자의 `SERVICE_INSTANCE_ID`, `region`은 운영자가 정한 식별자다(이름에서 추론하지 않는다). Oracle은 `ap-osaka-1`만 허용된다.

```json
[
  { "host": "m3", "instanceId": "<M3 maintenance SERVICE_INSTANCE_ID>", "region": "<M3/mini 지역 식별자>" },
  { "host": "mini", "instanceId": "<mini maintenance standby SERVICE_INSTANCE_ID>", "region": "<M3/mini 지역 식별자>" },
  { "host": "oracle-osaka-smoke", "instanceId": "<Oracle product-health SERVICE_INSTANCE_ID>", "region": "ap-osaka-1" }
]
```

### 2. raw-only 판정과 전환

```sh
node --import tsx scripts/ops/uptime-gate.ts plan raw-only --sources=sources.json
node --import tsx scripts/ops/uptime-gate.ts apply raw-only --sources=sources.json --expect-revision=R0 --operator=<이름>
node --import tsx scripts/ops/uptime-gate.ts apply raw-only --sources=sources.json --expect-revision=R0 --operator=<이름> --apply
```

거절 code: `uptime_sources_missing`·`uptime_sources_invalid`·`uptime_authoritative_source_missing`(Oracle만)·`uptime_runner_unconfigured:<id>`·`uptime_no_change`·`uptime_rollback_required`(gate 상태).
`--apply` 출력의 `before`/`after`를 보관한다. 이제 revision은 `R1 = R0 + 1`.

### 3. raw canary 관측(최소 24시간)

- 현재 revision으로 24시간 이상, 현재 slot 앞 UTC 6h slot 4개가 모두 관측돼야 한다.
- 지역 2개 이상이 관측돼야 한다. Oracle 관측은 Oracle이 uptime-ping을 맡는 구간(역할 선출) 또는 Oracle canary tick(`lib/runtime/oracle-canary-cli.ts canary --role=product-health --job=uptime-ping`, 별도 승인)으로만 생긴다.
- 아래 확인 쿼리와 중단 조건을 1시간마다 본다.

### 4. gate 판정

```sh
node --import tsx scripts/ops/uptime-gate.ts plan gate > uptime-gate-plan.json
```

거절 code와 근거:

| code | 의미 |
|---|---|
| `uptime_gate_requires_raw_only` | raw-only가 아니다 |
| `uptime_canary_missing` / `uptime_canary_too_short` | 현재 revision raw 관측 없음 / 첫 관측이 24시간 미만 |
| `uptime_canary_slot_gap` | 현재 slot 앞 6h slot 4개 중 빈 slot |
| `uptime_observations_stale` | 마지막 관측이 30분보다 오래됨 |
| `uptime_region_coverage_insufficient` | 설정된 source 중 관측이 있는 지역이 2개 미만 |
| `uptime_shadow_evidence_insufficient` | 최근 6시간 실패 관측(최대 1,000건)이 100건 미만 |
| `uptime_shadow_hold_ratio_exceeded` | regional-v1을 그 실패들에 다시 돌리면 50% 넘게 hold |
| `uptime_runner_unconfigured:<id>` | 최근 역할 후보가 sources에 없음 |
| `uptime_gate_sources_frozen` | gate 전환에서 sources를 바꾸려 함(canary를 다시 시작해야 함) |

허용돼도 `snapshot.shadow.reasons`, `snapshot.impact.hiddenNow`(즉시 다시 보일 숨김 수), `banEligibleNow`를 사용자에게 보고하고 승인받는다.
shadow는 근사다. 기록 당시 health 상태(최소 간격)는 재현하지 않고, 판정 정책만 같은 raw 사실에 다시 적용한다.

### 5. gate 전환

```sh
node --import tsx scripts/ops/uptime-gate.ts apply gate --expect-revision=R1 --operator=<이름>
node --import tsx scripts/ops/uptime-gate.ts apply gate --expect-revision=R1 --operator=<이름> --apply
```

전환 직전 같은 판정을 다시 하고 막히면 쓰지 않는다. 이제 revision은 `R2 = R1 + 1`.

### 6. gate 모니터

전환 직후 15분, 이후 1시간마다 확인 쿼리를 본다. gate 첫 30분은 새 revision의 증거가 쌓이는 중이라 실패 대부분이 `network_evidence_missing`으로 hold되는 것이 정상이다.

### 7. rollback

안전 방향 한 단계만 간다: gate→raw-only, raw-only→disabled. 근거 없이 허용되며 sources는 유지한다.

```sh
node --import tsx scripts/ops/uptime-gate.ts status            # control.revision 확인
node --import tsx scripts/ops/uptime-gate.ts rollback --expect-revision=<현재> --operator=<이름>
node --import tsx scripts/ops/uptime-gate.ts rollback --expect-revision=<현재> --operator=<이름> --apply
```

- gate→raw-only: 판정이 기존 의미로 돌아간다. hold는 health 카운터를 바꾸지 않았으므로 기존 3회 숨김·10회 내림이 즉시 다시 적용된다.
- raw-only→disabled: raw 기록을 멈추고 `recordPing` 경로로 돌아간다. 이미 남은 raw 관측은 append-only로 보존된다.
- disabled에서 rollback하면 `uptime_already_disabled`로 거절된다.

## 확인 쿼리(읽기 전용)

```sql
-- control
SELECT observations_enabled, gate_enabled, revision, sources FROM uptime_control WHERE id = 1;

-- 최근 1시간 host별 결과·처리 분포(현재 revision)
SELECT host, instance_id, region, disposition, count(*) AS rows,
       count(*) FILTER (WHERE kind = 'http' AND status BETWEEN 200 AND 399) AS positive,
       max(observed_at) AS last_observed
FROM uptime_observations
WHERE revision = (SELECT revision FROM uptime_control WHERE id = 1) AND observed_at > clock_timestamp() - interval '1 hour'
GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 4;

-- hold 사유(현재 revision, 최근 6시간)
SELECT reason, count(*) FROM uptime_observations
WHERE revision = (SELECT revision FROM uptime_control WHERE id = 1) AND disposition = 'observation_hold'
  AND observed_at > clock_timestamp() - interval '6 hours'
GROUP BY 1 ORDER BY 2 DESC;

-- 권위 health 진행(product_health.checked_at은 UTC 벽시계)
SELECT max(checked_at) AS latest,
       count(*) FILTER (WHERE checked_at > (now() AT TIME ZONE 'utc') - interval '1 hour') AS last_hour
FROM product_health;

-- uptime-ping 잡 상태
SELECT locked_at, not_before, last_run_at, last_success_at, last_error, requested_version, processed_version
FROM jobs WHERE name = 'uptime-ping';

-- gate 행
SELECT state, reason, count(*), min(last_observed_at) AS oldest
FROM uptime_gates GROUP BY 1, 2 ORDER BY 3 DESC;

-- 전환 이력
SELECT id, actor, action, created_at, detail->'before' AS before, detail->'after' AS after
FROM operations_audit WHERE action LIKE 'uptime-control-%' ORDER BY id DESC LIMIT 10;
```

`status` 명령도 같은 값을 한 번에 보여 준다(`hosts`, `holdReasons`, `gates`, `impact`, `shadow`).

## 중단 조건(즉시 rollback)

raw-only:

- `jobs.last_error`에 `uptime_source_unconfigured`가 보이거나 uptime-ping이 연속 실패한다 → disabled로 rollback, sources를 고친 뒤 처음부터.
- 권위 health `last_hour`가 전환 전보다 크게 줄거나 0이다(Oracle만 실행 중) → disabled로 rollback.
- `minimum_interval` hold가 계속 늘어난다(실행자 교대로 같은 제품을 다시 엶) → 원인 확인 전 진행 중단.
- uptime 쓰기 lock timeout·지연이 생긴다 → rollback.

gate:

- `impact.hiddenNow` 이상으로 숨김이 풀리거나, 사용자 승인 범위를 넘는 공개 변화가 보인다 → raw-only로 rollback.
- 실제 hold 비율이 plan 때 shadow 비율보다 20%p 넘게 높다 → raw-only로 rollback.
- `jobs.requested_version`이 hold 재확인 요청으로 급증하거나 uptime-ping이 연속 실패한다 → raw-only로 rollback.
- 잘못된 자동 내림이 하나라도 확인된다 → raw-only로 rollback 후 사람이 복구한다(기존 unban 절차).

## 이 도구가 증명하지 않는 것

host 신원·시계 동기화, 실제 망 장애 원인, 장기 관측 보존·용량, 배포된 sources의 정확성, 정책의 운영 보정.
