import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { MODEL_CAPACITY_OCCUPYING_STATES_SQL } from "./capacity-states";

/**
 * 장비별 입장 설정(PR 1b) — 1b-A 가 고정한 계약. 1b-B(관리자 화면)와 1b-C(입장 알고리즘)는 이 모듈의 이름만 쓴다.
 *
 * 용어: **장비(device)** = 정책 route 의 `groupId` = `model_capacity_requests.group_id`(엔진 하나의 실제 동시 처리 묶음).
 * **역할(role)** = `routeId`. 장부 행(model_capacity_requests)의 모양은 바뀌지 않는다.
 *
 * 표 두 개(`model_capacity_devices`, `model_capacity_device_roles`, migration 0153)는 정책 세대(epoch·revision·policy_hash)에 들어가지
 * 않는다: 저장은 다음 grant 부터 바로 적용되고(DRAIN 불필요), 이미 잡힌 행은 건드리지 않는다. 입장 판정은 DB 트랜잭션 안에서
 * 이 모듈의 SQL 조각만으로 결정한다 — 프로세스 안 캐시·TTL·polling 이 없다(pr1-plan §3.3).
 *
 * 판정 정의(장비 D, control 행 FOR UPDATE 아래):
 * - S = D 의 enabled 설정 행. 없으면 정책 `groupLimits[D]` 로 대체(limit = cap = 그 값, idle 60000, reserve 0, 순위 없음; source `policy_fallback`).
 *   둘 다 없으면 D 에는 grant 가 없다(`device_unconfigured`, 1b-C).
 * - rank(row) = `model_capacity_device_roles.role_rank`(D, row.route_id), 없으면 UNRANKED_ROLE_RANK(32767).
 * - active(D) = `group_id = D AND state IN ('reserved','dispatched')` 행 수 — 모든 세대. **indeterminate 는 점유가 아니다**(소유자 결정 2026-10-30).
 * - secondaryActive(D) = 그중 rank > 1.
 * - primaryBusy(D) = rank 1 행이 (현재 세대 waiting 이고 queue_until > now) 또는 reserved/dispatched 또는 updated_at ≥ now − idle_ms 중 하나.
 * - secondaryBound(D) = primaryBusy ? secondary_cap : greatest(secondary_cap, limit_slots − reserve_slots).
 * - 대기 행 q 가 **맞는다** ⇔ active(D) < limit_slots AND (rank(q) = 1 OR secondaryActive(D) < secondaryBound(D)).
 * - D 안에서는 (rank, queue_ordinal) 이 가장 작은 맞는 행 하나를 뽑는다(장비마다 pass 당 하나).
 */

/** 점유로 세는 상태 = lib/llm/capacity-states.ts 의 하나(reserved·dispatched). indeterminate 는 사람 검토용 행이며 슬롯을 쥐지 않고 바쁨 신호도 아니다(PR #750). */
const DEVICE_OCCUPYING_STATES_SQL = MODEL_CAPACITY_OCCUPYING_STATES_SQL;

export const MODEL_CAPACITY_DEVICE_ID_MAX = 120;
export const MODEL_CAPACITY_DEVICE_LIMIT_MAX = 256;
export const MODEL_CAPACITY_DEVICE_ROLE_RANK_MAX = 64;
export const MODEL_CAPACITY_DEVICE_IDLE_MS_MAX = 3_600_000;
export const MODEL_CAPACITY_DEVICE_NOTE_MAX = 400;
export const DEFAULT_DEVICE_IDLE_MS = 60_000;
export const DEFAULT_DEVICE_RESERVE_SLOTS = 0;
/** 순위 행이 없는 route 의 순위(가장 낮다). */
export const UNRANKED_ROLE_RANK = 32767;
/** operations_audit 의 action. target 은 device_id. 저장 함수(capacity-devices-repository)가 쓴다 — 감싸는 쪽이 또 쓰지 않는다. */
export const MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION = "model-capacity-device-save";
/** 설정 행이 없을 때 정책 groupLimits 값으로 대체하는 규칙(migration 0153 의 seed 와 같은 패턴). */
export const DEVICE_FALLBACK_LIMIT_PATTERN = /^[1-9][0-9]{0,2}$/;

const identity = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "invalid_identity");
const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const modelCapacityDeviceRoleSchema = z.object({
  routeId: identity(MODEL_CAPACITY_DEVICE_ID_MAX),
  rank: int(1, MODEL_CAPACITY_DEVICE_ROLE_RANK_MAX),
}).strict();
export type ModelCapacityDeviceRole = Readonly<z.infer<typeof modelCapacityDeviceRoleSchema>>;

export const modelCapacityDeviceSettingsSchema = z.object({
  deviceId: identity(MODEL_CAPACITY_DEVICE_ID_MAX),
  /** 장비 칸 수(실제 동시 처리 수). */
  limitSlots: int(1, MODEL_CAPACITY_DEVICE_LIMIT_MAX),
  /** 우선 역할이 바쁠 때 rank > 1 역할 합계 상한. */
  secondaryCap: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX),
  /** 우선 역할 유휴 판정 시간(ms). 0 = 살아 있는 행이 없으면 바로 유휴. */
  idleMs: int(0, MODEL_CAPACITY_DEVICE_IDLE_MS_MAX),
  /** 빌려 쓰는 중에도 우선 역할용으로 비워 둘 칸. */
  reserveSlots: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX - 1),
  /** 운영자가 적은 엔진 실제 동시 처리 수(선택; 저장 검증·경고용). */
  physicalLimit: int(1, MODEL_CAPACITY_DEVICE_LIMIT_MAX).nullable(),
  /** rank 1 = 우선 역할(여러 route 가능). 목록에 없는 route 는 UNRANKED_ROLE_RANK. */
  roles: z.array(modelCapacityDeviceRoleSchema).max(MODEL_CAPACITY_DEVICE_ROLE_RANK_MAX),
  note: z.string().max(MODEL_CAPACITY_DEVICE_NOTE_MAX).nullable(),
}).strict()
  .refine(value => value.secondaryCap <= value.limitSlots, { message: "secondary_cap_exceeds_limit", path: ["secondaryCap"] })
  .refine(value => value.reserveSlots < value.limitSlots, { message: "reserve_exceeds_limit", path: ["reserveSlots"] })
  .refine(value => value.physicalLimit === null || value.limitSlots <= value.physicalLimit, { message: "limit_exceeds_physical", path: ["limitSlots"] })
  .refine(value => new Set(value.roles.map(role => role.routeId)).size === value.roles.length, { message: "duplicate_route", path: ["roles"] });
export type ModelCapacityDeviceSettings = Readonly<Omit<z.infer<typeof modelCapacityDeviceSettingsSchema>, "roles"> & { roles: readonly ModelCapacityDeviceRole[] }>;

/** 저장된 행(roles 포함). version 은 폼 compare-and-set 과 감사 기록의 참조다. */
export type ModelCapacityDeviceRow = ModelCapacityDeviceSettings & Readonly<{
  enabled: boolean; version: number; updatedBy: string; createdAt: string; updatedAt: string;
}>;

/** 장비 하나의 실시간 상태(관리자 화면·status·1b-C 의 관측). 설정 출처 `table` | `policy_fallback`. */
export type ModelCapacityDeviceState = Readonly<{
  deviceId: string; source: "table" | "policy_fallback";
  limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number;
  /** reserved/dispatched 행 수(모든 세대). */
  active: number;
  /** 그중 rank > 1. */
  secondaryActive: number;
  /** 지금 rank > 1 역할이 새로 들어갈 수 있는 합계 상한. */
  secondaryBound: number;
  primaryBusy: boolean;
  /** 우선 역할이 유휴라서 낮은 순위가 평소 상한(secondary_cap)을 넘겨 쓰고 있다. */
  lending: boolean;
  /** 현재 세대의 대기 행(queue_until > now). */
  waiting: number; waitingPrimary: number;
  version: number | null; updatedAt: string | null;
}>;

export type ModelCapacityGeneration = Readonly<{ epoch: number; revision: number; policyHash: string }>;

/** 설정 입력을 검증한다. 거절은 `model_capacity_device_invalid:<path>` 로 던진다(path 는 점으로 이은 첫 issue 의 위치, 없으면 `root`). */
export function parseModelCapacityDeviceSettings(input: unknown): ModelCapacityDeviceSettings {
  const parsed = modelCapacityDeviceSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.map(String).join(".") : "root";
    throw new Error(`model_capacity_device_invalid:${path}`);
  }
  const roles = [...parsed.data.roles].sort((a, b) => a.rank - b.rank || (a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0));
  return Object.freeze({ ...parsed.data, roles: Object.freeze(roles.map(role => Object.freeze(role))) });
}

/** 정책 groupLimits 의 값이 대체 한도로 쓰일 수 있으면 그 수, 아니면 null(설정 행도 없으면 `device_unconfigured`). */
export function deviceFallbackLimit(groupLimits: Readonly<Record<string, unknown>> | null | undefined, deviceId: string): number | null {
  const raw = groupLimits?.[deviceId];
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : null;
  if (text === null || !DEVICE_FALLBACK_LIMIT_PATTERN.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= MODEL_CAPACITY_DEVICE_LIMIT_MAX ? value : null;
}

/** 설정 행이 없을 때의 대체 설정(cap = limit, 순위 없음 → 오늘의 그룹 한도 동작과 같다). */
export function deviceSettingsFromPolicyFallback(deviceId: string, limit: number): ModelCapacityDeviceSettings {
  return Object.freeze({ deviceId, limitSlots: limit, secondaryCap: limit, idleMs: DEFAULT_DEVICE_IDLE_MS, reserveSlots: DEFAULT_DEVICE_RESERVE_SLOTS,
    physicalLimit: null, roles: Object.freeze([]), note: null });
}

/** route 의 순위(없으면 UNRANKED_ROLE_RANK). */
export function deviceRoleRank(roles: readonly ModelCapacityDeviceRole[], routeId: string): number {
  return roles.find(role => role.routeId === routeId)?.rank ?? UNRANKED_ROLE_RANK;
}

/** 낮은 순위 합계 상한: 우선 역할이 바쁘면 secondary_cap, 유휴면 장비 전체에서 reserve 를 뺀 칸(단 cap 보다 작아지지 않는다). */
export function deviceSecondaryBound(settings: Pick<ModelCapacityDeviceSettings, "limitSlots" | "secondaryCap" | "reserveSlots">, primaryBusy: boolean): number {
  return primaryBusy ? settings.secondaryCap : Math.max(settings.secondaryCap, settings.limitSlots - settings.reserveSlots);
}

/** 대기 행 하나가 지금 맞는지(SQL 조건과 같은 식 — 테스트·설명·시뮬레이션용; 실제 판정은 deviceCandidateSql 이 DB 안에서 한다). */
export function deviceFits(value: { active: number; limitSlots: number; rank: number; secondaryActive: number; secondaryBound: number }): boolean {
  return value.active < value.limitSlots && (value.rank === 1 || value.secondaryActive < value.secondaryBound);
}

/** 빌려 쓰는 중 = 우선 역할이 유휴이고 낮은 순위가 평소 상한을 넘겨 점유하고 있다. */
export function deviceLending(value: { primaryBusy: boolean; secondaryActive: number; secondaryCap: number }): boolean {
  return !value.primaryBusy && value.secondaryActive > value.secondaryCap;
}

const deviceRef = (deviceId: SQL | string): SQL => typeof deviceId === "string" ? sql`${deviceId}` : deviceId;
// 상수는 bind 가 아니라 글자로 넣는다 — 렌더된 SQL 이 스스로 읽히고(ORDER BY coalesce(ro.role_rank, 32767)), 계획 캐시 키가 장비마다 같다.
const unranked = sql.raw(String(UNRANKED_ROLE_RANK));
const fallbackIdle = sql.raw(String(DEFAULT_DEVICE_IDLE_MS));
const fallbackReserve = sql.raw(String(DEFAULT_DEVICE_RESERVE_SLOTS));
const limitMax = sql.raw(String(MODEL_CAPACITY_DEVICE_LIMIT_MAX));

/**
 * 장비 D 의 판정 CTE 접두(s·roles·active·busy·counts·waiting). deviceCandidateSql(입장)과 deviceStateSql(관측)이 같은 접두를 쓴다 —
 * 조건의 단일 출처. `deviceId` 는 bind 값(string) 또는 바깥 열 참조(SQL, LATERAL 안에서 d.device_id 등)다.
 * `groupLimitsJson` 은 정책 `groupLimits` 의 JSON 문자열(없으면 "{}") — 설정 행이 없을 때의 대체 한도(policy_fallback).
 */
export function deviceStateCte(deviceId: SQL | string, generation: ModelCapacityGeneration, groupLimitsJson: string): SQL {
  const device = deviceRef(deviceId);
  const occupying = sql.raw(DEVICE_OCCUPYING_STATES_SQL);
  const limitPattern = sql.raw(`'${DEVICE_FALLBACK_LIMIT_PATTERN.source}'`);
  return sql`WITH s AS MATERIALIZED (
      SELECT d.limit_slots, d.secondary_cap, d.idle_ms, d.reserve_slots, 'table'::text AS source, d.version, d.updated_at
      FROM model_capacity_devices d WHERE d.device_id = ${device} AND d.enabled
      UNION ALL
      SELECT (${groupLimitsJson}::jsonb ->> ${device})::int, (${groupLimitsJson}::jsonb ->> ${device})::int,
        ${fallbackIdle}::int, ${fallbackReserve}::int, 'policy_fallback'::text, NULL::bigint, NULL::timestamptz
      WHERE NOT EXISTS (SELECT 1 FROM model_capacity_devices d WHERE d.device_id = ${device} AND d.enabled)
        AND (${groupLimitsJson}::jsonb ->> ${device}) ~ ${limitPattern}
        AND (${groupLimitsJson}::jsonb ->> ${device})::int <= ${limitMax}
    ),
    roles AS MATERIALIZED (SELECT ro.route_id, ro.role_rank FROM model_capacity_device_roles ro WHERE ro.device_id = ${device}),
    active AS MATERIALIZED (
      SELECT coalesce(ro.role_rank, ${unranked}) AS role_rank
      FROM model_capacity_requests r LEFT JOIN roles ro ON ro.route_id = r.route_id
      WHERE r.group_id = ${device} AND r.state IN ${occupying}
    ),
    busy AS MATERIALIZED (
      SELECT EXISTS (
        SELECT 1 FROM model_capacity_requests r JOIN roles ro ON ro.route_id = r.route_id AND ro.role_rank = 1, s
        WHERE r.group_id = ${device} AND (
          (r.state = 'waiting' AND r.epoch = ${generation.epoch} AND r.revision = ${generation.revision}
            AND r.policy_hash = ${generation.policyHash} AND r.queue_until > clock_timestamp())
          OR r.state IN ${occupying}
          OR r.updated_at >= clock_timestamp() - s.idle_ms * interval '1 millisecond')
      ) AS primary_busy
    ),
    counts AS MATERIALIZED (
      SELECT count(*)::int AS total, (count(*) FILTER (WHERE role_rank > 1))::int AS secondary FROM active
    ),
    waiting AS MATERIALIZED (
      SELECT count(*)::int AS waiting, (count(*) FILTER (WHERE coalesce(ro.role_rank, ${unranked}) = 1))::int AS waiting_primary
      FROM model_capacity_requests r LEFT JOIN roles ro ON ro.route_id = r.route_id
      WHERE r.group_id = ${device} AND r.state = 'waiting' AND r.epoch = ${generation.epoch} AND r.revision = ${generation.revision}
        AND r.policy_hash = ${generation.policyHash} AND r.queue_until > clock_timestamp()
    )`;
}

/**
 * 장비 D 에서 지금 입장시킬 대기 행 하나(`request_id`)를 잠근다(`FOR UPDATE OF q`). 1b-C 의 grantOne 이 control 행 FOR UPDATE 아래에서
 * 장비마다 한 번 실행한다. 설정 출처가 없으면(s 가 비면) 행이 나오지 않는다 → 그 장비는 grant 없음.
 */
export function deviceCandidateSql(deviceId: string, generation: ModelCapacityGeneration, groupLimitsJson: string): SQL {
  const device = deviceRef(deviceId);
  return sql`${deviceStateCte(deviceId, generation, groupLimitsJson)}
    SELECT q.request_id FROM model_capacity_requests q
      LEFT JOIN roles ro ON ro.route_id = q.route_id, s, counts c, busy b
    WHERE q.group_id = ${device} AND q.state = 'waiting'
      AND q.epoch = ${generation.epoch} AND q.revision = ${generation.revision} AND q.policy_hash = ${generation.policyHash}
      AND q.queue_until > clock_timestamp()
      AND c.total < s.limit_slots
      AND (coalesce(ro.role_rank, ${unranked}) = 1
        OR c.secondary < CASE WHEN b.primary_busy THEN s.secondary_cap ELSE greatest(s.secondary_cap, s.limit_slots - s.reserve_slots) END)
    ORDER BY coalesce(ro.role_rank, ${unranked}), q.queue_ordinal LIMIT 1 FOR UPDATE OF q`;
}

/** deviceStateSql 이 돌려주는 행(snake_case; 숫자는 int 로 캐스팅돼 있다). */
export type DeviceStateRow = {
  device_id: string; source: "table" | "policy_fallback"; limit_slots: number; secondary_cap: number; idle_ms: number; reserve_slots: number;
  active: number; secondary_active: number; secondary_bound: number; primary_busy: boolean; lending: boolean;
  waiting: number; waiting_primary: number; version: string | number | null; updated_at: Date | string | null;
};

/**
 * 장비 D 의 관측 행 하나(잠그지 않는다). 설정 출처가 없으면 0행. `deviceId` 가 SQL 이면 LATERAL 안에서 바깥 장비 목록에 붙일 수 있다
 * (readModelCapacityDeviceStates 가 그렇게 한 문장으로 모든 장비를 읽는다).
 */
export function deviceStateSql(deviceId: SQL | string, generation: ModelCapacityGeneration, groupLimitsJson: string): SQL {
  const device = deviceRef(deviceId);
  return sql`${deviceStateCte(deviceId, generation, groupLimitsJson)}
    SELECT ${device}::text AS device_id, s.source, s.limit_slots, s.secondary_cap, s.idle_ms, s.reserve_slots, s.version, s.updated_at,
      c.total AS active, c.secondary AS secondary_active, b.primary_busy,
      CASE WHEN b.primary_busy THEN s.secondary_cap ELSE greatest(s.secondary_cap, s.limit_slots - s.reserve_slots) END AS secondary_bound,
      (NOT b.primary_busy AND c.secondary > s.secondary_cap) AS lending,
      w.waiting, w.waiting_primary
    FROM s, counts c, busy b, waiting w`;
}

/** DeviceStateRow → ModelCapacityDeviceState(camelCase, ISO 시각). */
export function deviceStateFromRow(row: DeviceStateRow): ModelCapacityDeviceState {
  const updatedAt = row.updated_at === null ? null : row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString();
  return Object.freeze({
    deviceId: row.device_id, source: row.source, limitSlots: Number(row.limit_slots), secondaryCap: Number(row.secondary_cap),
    idleMs: Number(row.idle_ms), reserveSlots: Number(row.reserve_slots), active: Number(row.active), secondaryActive: Number(row.secondary_active),
    secondaryBound: Number(row.secondary_bound), primaryBusy: Boolean(row.primary_busy), lending: Boolean(row.lending),
    waiting: Number(row.waiting), waitingPrimary: Number(row.waiting_primary),
    version: row.version === null ? null : Number(row.version), updatedAt,
  });
}
