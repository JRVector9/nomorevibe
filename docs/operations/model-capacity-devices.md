# 장비별 한도·우선순위·유휴 대여 — 표·불변식·소비 방법 (PR 1b-A)

작성: 2026-10-30 UTC. 범위: 1b-A(표·migration 0153·저장소·고정 인터페이스·Oracle GRANT). 관리자 화면은 1b-B, 입장 알고리즘(grantOne 교체·`device_unconfigured`)은 1b-C 가 이 문서의 계약 위에 만든다. 설계 근거는 `pr1-plan.md` §1–§3·§6 과 `live-settings-plan.md` §"PR 1b"(소유자 결정: indeterminate 는 점유가 아니다).

## 용어

- **장비(device)** = 정책 route 의 `groupId` = `model_capacity_requests.group_id`. 엔진 하나의 실제 동시 처리 묶음(예 `supa`, `gpu3090-qwen`, `m1-qwen`).
- **역할(role)** = `routeId`. 같은 장비를 여러 역할이 쓰면 순위(rank)를 둔다. rank 1 = 우선 역할(여러 route 가능), 순위 행이 없는 route 는 최하위(32767).
- 장부 행(`model_capacity_requests`)의 모양은 바뀌지 않는다. 장비 설정은 정책 세대(epoch·revision·policy_hash)에 **들어가지 않는다**.

## 표 (migration `drizzle/0153_model_capacity_devices.sql`, journal idx 153 / when 1794086401064)

| 표 | 열 | 뜻 · CHECK |
| --- | --- | --- |
| `model_capacity_devices` | `device_id` PK varchar(120) | 공백 없음·제어문자 없음 (`model_capacity_devices_id_check`) |
| | `limit_slots` int | 장비 칸 수 1..256 |
| | `secondary_cap` int | 우선 역할이 바쁠 때 rank>1 합계 상한, 0..limit_slots |
| | `idle_ms` int (기본 60000) | 우선 역할 유휴 판정 시간 0..3600000 |
| | `reserve_slots` int (기본 0) | 빌려 쓰는 중에도 우선 역할용으로 비워 둘 칸, 0..limit_slots−1 (`model_capacity_devices_limits_check`) |
| | `physical_limit` int null | 운영자가 적은 엔진 실제 동시 처리 수; 있으면 limit_slots ≤ physical_limit (`model_capacity_devices_physical_check`) |
| | `enabled` bool (기본 true) | PR 1 에는 끄기 동작이 없다. 꺼진 행은 정책 대체(policy_fallback)로 떨어진다 |
| | `version` bigint (기본 1) | 폼 compare-and-set·감사 참조. 순위 행만 바뀌어도 올라간다 (`model_capacity_devices_version_check`) |
| | `note`, `updated_by`, `created_at`, `updated_at` | |
| `model_capacity_device_roles` | `(device_id, route_id)` PK, FK → devices ON DELETE CASCADE | |
| | `role_rank` int | 1..64 (`model_capacity_device_roles_rank_check`), route_id 공백·제어문자 없음 |

두 표인 이유: 입장 조건이 대기 행마다 rank 를 join 으로 읽어야 하고, jsonb 배열의 CHECK 는 어색하다. 장비 행의 `version` 이 두 표를 함께 덮는다.

### seed 의 뜻

0153 은 `model_capacity_control.policy->'groupLimits'` 의 키마다 행을 만든다: `limit_slots = secondary_cap = 값`, `idle_ms 60000`, `reserve_slots 0`, 순위 행 없음, `updated_by 'migration:0153'`, note 에 epoch·revision. 값은 `^[1-9][0-9]{0,2}$` 이고 1..256 인 것만, 키는 120자 이하·공백·제어문자 없는 것만 심는다(`ON CONFLICT DO NOTHING`). 그래서 **배포 직후 동작은 오늘의 그룹 한도와 같다**(cap = limit 이고 순위가 없으면 `primary_busy` 가 항상 거짓이고 낮은 순위 상한 = limit). 전역·풀 한도가 사라지는 것이 배포 시점의 유일한 동작 변화(1b-C)이고, 우선순위는 운영자가 순위를 저장할 때 시작된다.

## 판정 정의와 불변식 (1b-C 가 구현·검증한다; 표는 이것을 지탱한다)

장비 D, control 행 `FOR UPDATE` 아래에서:

- `S` = D 의 enabled 행. 없으면 정책 `groupLimits[D]` 로 대체(limit = cap = 그 값, idle 60000, reserve 0, 순위 없음; source `policy_fallback`). 둘 다 없으면 D 에는 grant 가 없다(`device_unconfigured`, 대기 행도 만들지 않는다).
- `active(D)` = `group_id = D AND state IN ('reserved','dispatched')` 행 수 — **모든 세대**, `indeterminate` 제외(2026-10-30 소유자 결정; PR #750 `MODEL_CAPACITY_OCCUPYING_STATES`). `secondaryActive(D)` = 그중 rank>1.
- `primaryBusy(D)` = rank 1 행이 하나라도 (현재 세대 `waiting` 이고 `queue_until > now`) 또는 `reserved/dispatched` 또는 `updated_at ≥ now − idle_ms`. indeterminate 는 바쁨 신호도 아니다(최근 `updated_at` 이면 idle_ms 동안만 바쁨으로 본다).
- `secondaryBound(D)` = `primaryBusy ? secondary_cap : greatest(secondary_cap, limit_slots − reserve_slots)`.
- 대기 행 q 가 **맞는다** ⇔ `active(D) < limit_slots AND (rank(q) = 1 OR secondaryActive(D) < secondaryBound(D))`. D 안에서는 `(rank, queue_ordinal)` 최소 하나를 잠근다(`FOR UPDATE OF q`), 장비마다 pass 당 하나.

불변식: ① 새 grant 로 점유가 `limit_slots` 를 넘지 않는다(control lock 아래 장비당 하나). ② 잡힌 행(모든 세대의 reserved/dispatched)은 계속 센다; 아무것도 풀거나 표시하지 않는다. ③ 우선 대기 행이 항상 다음 빈 칸을 먼저 받고, 우선 역할이 대기·실행·최근이면 낮은 순위는 `secondary_cap` 위로 새로 시작하지 않는다. ④ 한도를 점유 아래로 내리면 새 grant 만 막힌다. ⑤ 입장은 같은 TX·같은 control lock 아래에서 설정을 읽고, 저장도 fence → control FOR UPDATE 를 먼저 잡으므로 grant 마다 설정 스냅샷이 하나다(프로세스 캐시 없음). ⑥ 전역·풀·공급자 한도 값과 weights 는 grant 에 영향을 주지 않는다(1b-C). ⑦ fenced DB 에서는 저장도 입장도 하지 않는다.

## 고정 인터페이스 (`lib/llm/capacity-devices.ts`, `lib/llm/capacity-devices-repository.ts`)

```ts
// capacity-devices.ts — 순수(DB 없음). 1b-B·1b-C 가 쓰는 이름.
modelCapacityDeviceRoleSchema, modelCapacityDeviceSettingsSchema          // zod; refine: cap ≤ limit, reserve < limit, limit ≤ physical, routeId 중복 금지
type ModelCapacityDeviceRole, ModelCapacityDeviceSettings, ModelCapacityDeviceRow, ModelCapacityDeviceState, ModelCapacityGeneration, DeviceStateRow
DEFAULT_DEVICE_IDLE_MS = 60_000, DEFAULT_DEVICE_RESERVE_SLOTS = 0, UNRANKED_ROLE_RANK = 32767, MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION = "model-capacity-device-save"
parseModelCapacityDeviceSettings(input): ModelCapacityDeviceSettings      // 거절: Error("model_capacity_device_invalid:<path>")
deviceFallbackLimit(groupLimits, deviceId): number | null                   // 정책 대체 한도(패턴·1..256), 없으면 null → device_unconfigured
deviceSettingsFromPolicyFallback(deviceId, limit), deviceRoleRank(roles, routeId), deviceSecondaryBound(settings, primaryBusy), deviceFits(...), deviceLending(...)
deviceStateCte(deviceId: SQL | string, generation, groupLimitsJson): SQL    // CTE 접두 s·roles·active·busy·counts·waiting — 조건의 단일 출처
deviceCandidateSql(deviceId: string, generation, groupLimitsJson): SQL      // … SELECT q.request_id … ORDER BY coalesce(ro.role_rank, 32767), q.queue_ordinal LIMIT 1 FOR UPDATE OF q
deviceStateSql(deviceId: SQL | string, generation, groupLimitsJson): SQL    // 관측 행 하나(잠그지 않음), deviceStateFromRow(row) 로 camelCase
// capacity-devices-repository.ts
saveModelCapacityDevice(tx, input: unknown, expectedVersion: number | null, actor: string): Promise<{ before: ModelCapacityDeviceRow | null; after: ModelCapacityDeviceRow }>
listModelCapacityDevices(tx?): Promise<ModelCapacityDeviceRow[]>            // device_id 순, enabled 무관
readModelCapacityDevice(deviceId, tx?): Promise<ModelCapacityDeviceRow | null>
readModelCapacityDeviceStates(tx?): Promise<ModelCapacityDeviceState[]>     // enabled 행 ∪ groupLimits 키 ∪ route groupId 중 설정 출처가 있는 장비, 한 문장(LATERAL)
```

`saveModelCapacityDevice` 는 호출자의 TX 안에서: replay 거부 → DR writer fence SHARE(fenced 면 `DrWriterFencedError("site_fenced")`) → `model_capacity_control` id=1 `FOR UPDATE` → zod → 장비 행 `FOR UPDATE` → `expectedVersion` compare-and-set(다르면 `model_capacity_device_version_mismatch:<current|none>`; 새 장비는 `null`) → upsert(`version + 1`, `enabled = true`) → 순위 행 전부 교체 → **`operations_audit` 한 줄**(action `model-capacity-device-save`, target = device_id, detail `{version, expectedVersion, before, after}`). 1b-B 의 `saveAdminCapacityDevice` 는 `onPrimary(() => db.transaction(tx => saveModelCapacityDevice(tx, input, expectedVersion, admin.login)))` 만 하고 감사 줄을 **또 쓰지 않는다**. 장부 행은 건드리지 않는다.

`readModelCapacityDeviceStates` 의 `generation` 은 control 행의 현재 epoch·revision·policy_hash(잠그지 않고 읽음), `groupLimitsJson` 은 `policy->'groupLimits'`(없으면 `{}`). 1b-C 의 grantOne 은 이미 잠근 `state` 에서 같은 값을 `deviceCandidateSql` 에 넘긴다. 설정 출처가 없는 장비(정책 route 에는 있으나 행도 대체값도 없음)는 상태 목록에 없다 — 관리자 화면은 정책 route 의 groupId 와 견줘 "설정 없음(device_unconfigured)" 을 표시한다.

## 1b-C 가 소비하는 방법 (요약)

1. `grantOne(tx, state)`: 현재 세대의 `waiting` 행이 있는 `group_id` 를 `DISTINCT … ORDER BY group_id` 로 모은 뒤 장비마다 `deviceCandidateSql(groupId, {epoch, revision, policyHash}, JSON.stringify(policy.groupLimits ?? {}))` 를 한 번 실행 → 있으면 그 행을 `reserved` 로 바꾸고 `reserved` event. cursor 는 0 으로 둔다.
2. `requestSlot`: route 의 `groupId` 에 enabled 행도 `deviceFallbackLimit(policy.groupLimits, groupId)` 도 없으면 `{ kind: "deferred", reason: "device_unconfigured" }`(대기 행 없음).
3. PR #750 병합 후 `capacity-devices.ts` 의 지역 상태 목록(`// TODO(#750)`)을 `lib/llm/capacity-states.ts` 의 `MODEL_CAPACITY_OCCUPYING_STATES_SQL` 로 바꾼다 — 값은 같다(`('reserved','dispatched')`).

## Oracle GRANT (하드 전제)

입장 TX 는 Oracle 번역 소비자(`nomorevibe_oracle_translation`)에서도 돈다. `lib/runtime/oracle-db-profile.ts` 의 `LIVE_SETTINGS` 에 `model_capacity_devices: read, model_capacity_device_roles: read` 가 들어가 네 잡 principal(translation·product-health·site-evidence·official-news)이 SELECT 를 받는다; `deploy/oracle/least-privilege.sql` 은 `renderOracleDbGrantSql()` 로 다시 만들었다(테스트가 byte 동일을 요구). **운영자는 OPEN 전 유지 창에서 Oracle DB 에 새 GRANT 를 적용해야 한다** — 없으면 Oracle 번역 입장이 지연이 아니라 오류로 끝난다. 읽기 전용 monitor 역할도 상태 화면용 SELECT 가 필요하다.

## 검증 (이 PR 범위)

- 단위 `tests/capacity-devices.test.ts`: zod 거절 경로·기본값·대체 한도·순수 판정 함수·`deviceCandidateSql`/`deviceStateSql` 렌더(생성 필터, `FOR UPDATE OF q`, `policy_fallback` 분기, `greatest(... - s.reserve_slots)`, 정렬, indeterminate 비점유).
- 통합 `tests/integration/capacity-devices.test.ts`(자기 DB 를 만들어 0152 까지 올린 뒤 정책을 두고 0153 을 적용): seed, CHECK 거절, 저장(version·감사·CAS·순위 교체), 상태 읽기(reserved/dispatched 만 점유, indeterminate 제외, policy_fallback, 미설정 장비 제외), 후보 SQL(우선 먼저, 바쁠 때 cap, 유휴 대여, reserve).
- `tests/oracle-db-profile.test.ts`, `tests/migration-config.test.ts` 에 각각 한 케이스.

## 열린 질문 (기본값은 pr1-plan §7)

Q1 정책 대체(policy_fallback)는 PR 1 에서 유지, rev14 가 groupLimits 를 버린 뒤 제거. Q4 indeterminate 는 점유도 바쁨 신호도 아니다(이 PR 반영). Q6 rev13 장비 기본값(`supa` 4/cap 1, `gpu3090-qwen` 4/cap 2, `m3-deepseek` 1/cap 0, `m3-gptoss` 2/cap 2, `m1-qwen` 2/cap 1)은 소유자 확인 뒤 관리자 화면에서 저장한다. Q7 Oracle GRANT 는 유지 창 체크리스트.

## 입장 규칙 — 1b-C 가 구현한 것 (2026-10-31)

`lib/llm/capacity-repository.ts` 의 `grantOne` 이 전역·공급자·그룹·풀 한도 검사와 class 가중치 순환(`modelCapacityClassCycle`, 삭제)을 버리고 장비별 판정으로 바뀌었다.

- **pass** = `requestSlot` 한 번(control 행 `FOR UPDATE` 아래). 현재 세대(epoch·revision·policy_hash)의 살아 있는 `waiting` 행이 있는 `group_id` 를 `DISTINCT … ORDER BY group_id` 로 모은 뒤 **장비마다** `deviceCandidateSql(groupId, generation, JSON.stringify(policy.groupLimits ?? {}))` 를 한 번 실행하고, 나온 행 하나를 `reserved` 로 바꾼다(`reserved` event). 장비마다 pass 당 하나, 장비끼리는 독립이다. `cursor` 는 더 쓰지 않는다(0 유지, control 행을 건드리지 않으므로 budget 수집기의 "구간 중 변경" 판정에도 들지 않는다).
- **판정(DB 안, 장비 D)**: `fits(q) ⇔ active(D) < limit_slots AND (rank(q) = 1 OR secondaryActive(D) < (primaryBusy(D) ? secondary_cap : max(secondary_cap, limit_slots − reserve_slots)))`. `active` = 모든 세대의 `reserved·dispatched`(`MODEL_CAPACITY_OCCUPYING_STATES`; indeterminate 는 점유도 바쁨 신호도 아니다 — 단 rank-1 행의 최근 `updated_at` 은 `idle_ms` 동안 바쁨으로 본다). `primaryBusy` = rank-1 행이 현재 세대 `waiting`(queue_until > now) 이거나 `reserved·dispatched` 이거나 `updated_at ≥ now − idle_ms`. 맞는 행 중 `(coalesce(role_rank, 32767), queue_ordinal)` 최소 하나를 `FOR UPDATE OF q` 로 잠근다.
- **설정 출처**: D 의 enabled 설정 행 → 없으면 정책 `groupLimits[D]`(cap = limit, 순위 없음, source `policy_fallback`) → 둘 다 없으면 `requestSlot` 이 route 조회 직후 `{ kind: "deferred", reason: "device_unconfigured" }` 로 미룬다(대기 행도 event 도 없음; `ModelSlotResult`·`ModelCapacityDeferredReason`·AI1 의 "다른 풀 모델 시도" 목록에 추가). DB 에 deferred reason CHECK 가 없어 migration 은 없다.
- **정책 JSON**(`lib/llm/capacity.ts`): `globalLimit`·`providerLimits`·`groupLimits`·`poolLimits`·`weights` 는 선택 칸이 됐다(`MODEL_CAPACITY_POLICY_IGNORED_FIELDS`). 있으면 모양만 검증하고 값은 입장에 쓰지 않는다. hash 는 정규 JSON 그대로라 저장된 rev12 문서의 `policy_hash` 가 그대로 맞는다(`tests/capacity-policy-optional-limits.test.ts`). `unknown_capacity_group`·`unknown_provider_budget` 은 해당 맵이 있을 때만 본다. `compatiblePredecessor` 는 한도 맵·weights 를 비교하지 않고 "옛 route 전부 그대로(groupId·providerBudgetId 포함) + version·maxWaiting·TTL 동일 + route 추가 하나 이상" 만 요구한다 — 기존 장비에 route 를 더해도 호환이다.
- **DRAIN 과 세대**: 장비 설정은 세대에 들지 않으므로 저장 즉시 다음 grant 부터 적용되고 `policy_changed` 를 만들지 않는다. `policy_changed` 는 여전히 옛 세대의 `reserved·dispatched` 행이 남은 채 정책이 바뀌었을 때만(indeterminate 제외) 난다. 정책(route·groupId 매핑·TTL·maxWaiting) 변경만 DRAIN 이다.
- **읽는 쪽**(WP-C): budget/replay(`pipeline-capacity-budget.ts`: 장비 peak 만 장비 한도와 비교, 선언 한도 = 심사 경로 장비 한도의 합, 구간 중 장비 설정 변경 = `device_settings_changed_since_window_start`), admission-block(scope `device`·`device_cap`·`policy`), runtime-status(`modelGroups[].limit` = 장비 행 → 정책 대체, `models[].limit` 은 null), pipeline-control(스냅숏 `devices`, `capacity policy` 경고 `device_row_missing:<id>`, `capacity mode --to=open` 거절 `device_unconfigured:<id>`, status `[devices]` 표), pipeline-observation(장비 한도로 free/full), first-reviewer-blocks(장비 한도), local-model-capacity(`localModelRouteReady` 는 정책 한도 비교 없이 route 매핑·물리 상한 존재만), llm-assist-readiness(`deviceLimits` readback ≤ 물리 상한), admin-models-observation(`globalLimit` 제거, `groups[].limit·lending·source`, `devices`), DR seal(예산 = 점유 행 ∪ `providerLimits` 키(있을 때) ∪ route 의 `providerBudgetId`).
- **검증**: `tests/integration/model-capacity-devices-admission.test.ts`(자기 DB: 우선 먼저·cap·대여·복귀·reserve·indeterminate·대체·`device_unconfigured`·DRAIN 없는 편집·옛 세대·두 장비 한 pass·동시 요청), `tests/integration/model-capacity.test.ts`(공유 DB, 장비 대체 한도로 재작성 — 전역·공급자·풀 무시 케이스), `tests/capacity-policy-optional-limits.test.ts`, 바뀐 읽기 쪽 단위 테스트. 전역·공급자 한도로 포화를 만들던 장부 fixture 는 같은 뜻을 장비로 옮겼다: 막는 행을 대기 경로와 같은 장비에 두거나(`second-review-capacity-wait-fallback`), 한 칸짜리 계정을 자기 장비로 분리하거나(`model-capacity-cli-ledger`·`review-cli-capacity-dispatch`·`dr-followups`), `globalLimit: 1` 대신 `groupLimits: { engine: 1 }`(텍스트·AI1/AI2 terminal 장부 9개), 관측 fixture 의 장비 g 한도 1(`pipeline-rollout-report`).
