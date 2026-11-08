import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { MODEL_CAPACITY_OCCUPYING_STATES_SQL } from "./capacity-states";
import { helperCandidateExclusionSql, helperDemandOnSql, helperGateCte, helperGateStatesFromJson, helperRouteMatchSql,
  type HelperGateState } from "./capacity-helpers";

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
 *
 * 도우미(PR 2a Layer B, lib/llm/capacity-helpers.ts): 행의 (route, provider, model) 이 D 의 도우미 배정 live·shadow 경로와 같으면 **도우미 행**이다.
 * - 도우미 행의 rank = greatest(rank, 2) — 순위 행이 1 이어도 우선 역할 우회(cap 무시)가 없고, primaryBusy·waitingPrimary 에 들지 않으며 낮은 순위 점유로 센다.
 * - 후보 정렬은 (도우미 여부, rank, queue_ordinal): 도우미 행은 장비 자기 역할의 모든 대기 행 뒤에 선다.
 * - 도우미 행은 helper_gate.ok(신선한 감시자 신호·mode·판정·자동 정지)이고 배정 점유 < max_slots 일 때만 맞는다(닫히면 맞지 않는다, fail-closed).
 * - primaryBusy 는 신선한 primary_demand 신호(model_device_signals)로도 참이 된다 — 빌려주기를 끝낼 뿐, 신선하지 않으면 무시한다.
 * 도우미 상태는 도우미가 아닌 행의 rank 1 판정을 바꾸지 않는다: 우선 역할 일은 어떤 신호로도 막히지 않는다.
 *
 * 경로 몫(step 2, 운영자 결정 2026-11-08; 0169 model_capacity_devices.route_quotas·lend_idle). 몫 줄이 없는 경로·장비는 위 판정 그대로다.
 * - quota(D, R) = (min_slots 보장, max_slots 상한|NULL). routeActive(R) = D 에서 route R 의 reserved/dispatched 행 수(모든 세대).
 * - demand(R) = R 의 행이 점유 중이거나, 현재 세대 대기 중이거나, idle_ms 안에 settled/withdrawn 됐다(우선 역할 바쁨과 같은 「최근」 창).
 * - cap(R) = 빌려주기 켜짐: max_slots / 꺼짐: min_slots > 0 이면 min_slots, 아니면 max_slots(NULL = 상한 없음).
 * - held(R) = (빌려주기 꺼짐 OR demand(R)) 이면 greatest(min_slots − routeActive(R), 0), 아니면 0 — 다른 경로가 비워 둬야 하는 R 의 못 채운 보장.
 * - under(q) = routeActive(route(q)) < min_slots(route(q)) — 보장 아래의 행.
 * - 대기 행 q 는 위 조건에 더해 **(cap 이 없거나 routeActive < cap) AND (under(q) OR active(D) + Σ_{R ≠ route(q)} held(R) < limit_slots)** 일 때만 맞는다.
 *   under(q) 이고 도우미가 아닌 행은 rank 1 처럼 낮은 순위 합계 상한(secondaryBound)을 넘을 수 있다 — 보장 칸이 순위 규칙에 막혀 놀지 않게(보장은 운영자가 명시한 것).
 * - 새 요청은 routeActive + (앞선 현재 세대 대기 행) ≥ cap 이면 대기 행 없이 바로 `route_quota` 로 미룬다(deviceRouteQuotaGateSql) — 호출자는 다음 순위로 넘긴다.
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
/** operations_audit 의 action(경로 몫 저장, step 2). target 은 device_id. saveModelCapacityRouteQuotas 가 쓴다. */
export const MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION = "model-capacity-route-quota-save";
/** 장비 하나의 경로 몫 줄 수 상한(0169 의 DB 검사와 같다). */
export const MODEL_CAPACITY_ROUTE_QUOTAS_MAX = 64;
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

/** 저장된 행(roles 포함). version 은 폼 compare-and-set 과 감사 기록의 참조다. lendIdle·routeQuotas 는 경로 몫(0169) — 장비 저장이 아니라
 * saveModelCapacityRouteQuotas 가 바꾼다(저장소가 읽은 행에는 늘 있다; 테스트 조립 행에는 없을 수 있다). */
export type ModelCapacityDeviceRow = ModelCapacityDeviceSettings & Readonly<{
  enabled: boolean; version: number; updatedBy: string; createdAt: string; updatedAt: string;
  lendIdle?: boolean; routeQuotas?: readonly ModelCapacityRouteQuota[];
}>;

/** 경로 몫 한 줄(step 2). minSlots = 수요가 있을 때 비워 두는 보장, maxSlots = 한 번에 쥘 수 있는 상한(null = 없음, 0 = 이 장비에서 뺌). */
export const modelCapacityRouteQuotaSchema = z.object({
  routeId: identity(MODEL_CAPACITY_DEVICE_ID_MAX),
  minSlots: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX),
  maxSlots: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX).nullable(),
}).strict().refine(value => value.maxSlots === null || value.minSlots <= value.maxSlots, { message: "min_exceeds_max", path: ["maxSlots"] });
export type ModelCapacityRouteQuota = Readonly<z.infer<typeof modelCapacityRouteQuotaSchema>>;
/** DB(model_capacity_devices.route_quotas) 의 원소 — snake_case, route_id 순. 모양은 0169 model_capacity_route_quotas_ok 가 다시 본다. */
export type ModelCapacityRouteQuotaRecord = { route_id: string; min_slots: number; max_slots: number | null };

/** 경로 몫 저장 입력(saveModelCapacityRouteQuotas). expectedVersion = 장비 행의 version(몫 저장도 장비 version 을 올린다). */
export const modelCapacityRouteQuotasInputSchema = z.object({
  deviceId: identity(MODEL_CAPACITY_DEVICE_ID_MAX),
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  lendIdle: z.boolean(),
  quotas: z.array(modelCapacityRouteQuotaSchema).max(MODEL_CAPACITY_ROUTE_QUOTAS_MAX),
}).strict().refine(value => new Set(value.quotas.map(quota => quota.routeId)).size === value.quotas.length, { message: "duplicate_route", path: ["quotas"] });
export type ModelCapacityRouteQuotasInput = Readonly<{ deviceId: string; expectedVersion: number; lendIdle: boolean; quotas: readonly ModelCapacityRouteQuota[] }>;

/** 경로 몫 입력을 검증한다. 거절은 `model_capacity_route_quota_invalid:<path>`(첫 issue 의 경로; refine 은 그 message). 줄은 routeId 순으로 고정한다. */
export function parseModelCapacityRouteQuotasInput(input: unknown): ModelCapacityRouteQuotasInput {
  const parsed = modelCapacityRouteQuotasInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const refined = issue?.code === "custom" && typeof issue.message === "string" && /^[a-z_]+$/.test(issue.message) ? issue.message : null;
    const path = issue?.path.length ? issue.path.map(String).join(".") : "root";
    throw new Error(`model_capacity_route_quota_invalid:${refined ? `${path}:${refined}` : path}`);
  }
  const quotas = [...parsed.data.quotas].sort((a, b) => a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0);
  return Object.freeze({ ...parsed.data, quotas: Object.freeze(quotas.map(quota => Object.freeze({ ...quota }))) });
}

/**
 * 장비 칸 수와 견준 몫 검사(저장 TX 안에서 잠근 장비 행으로): 줄마다 min ≤ 칸·max ≤ 칸, 보장 합계 ≤ 칸. 맞으면 null, 아니면 거절 경로
 * (`quotas.<i>.minSlots:exceeds_limit` · `quotas.<i>.maxSlots:exceeds_limit` · `quotas:min_sum_exceeds_limit`). 0169 의 DB 검사와 같은 규칙이다.
 */
export function routeQuotasLimitIssue(quotas: readonly Pick<ModelCapacityRouteQuota, "minSlots" | "maxSlots">[], limitSlots: number): string | null {
  for (const [index, quota] of quotas.entries()) {
    if (quota.minSlots > limitSlots) return `quotas.${index}.minSlots:exceeds_limit`;
    if (quota.maxSlots !== null && quota.maxSlots > limitSlots) return `quotas.${index}.maxSlots:exceeds_limit`;
  }
  return quotas.reduce((sum, quota) => sum + quota.minSlots, 0) > limitSlots ? "quotas:min_sum_exceeds_limit" : null;
}

export const routeQuotasToRecords = (quotas: readonly ModelCapacityRouteQuota[]): ModelCapacityRouteQuotaRecord[] =>
  [...quotas].sort((a, b) => a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0)
    .map(quota => ({ route_id: quota.routeId, min_slots: quota.minSlots, max_slots: quota.maxSlots }));

/** 저장된 jsonb → 몫 줄(routeId 순). DB 검사를 지난 값이므로 모양이 틀리면 던진다(조용히 몫을 지우지 않는다). */
export function routeQuotasFromRecords(value: unknown): readonly ModelCapacityRouteQuota[] {
  const rows = typeof value === "string" ? JSON.parse(value) as unknown : value ?? [];
  if (!Array.isArray(rows)) throw new Error("model_capacity_route_quotas_unreadable");
  return Object.freeze(rows.map(row => {
    const record = row as Partial<ModelCapacityRouteQuotaRecord>;
    const parsed = modelCapacityRouteQuotaSchema.safeParse({ routeId: record.route_id, minSlots: record.min_slots, maxSlots: record.max_slots ?? null });
    if (!parsed.success) throw new Error("model_capacity_route_quotas_unreadable");
    return Object.freeze(parsed.data);
  }).sort((a, b) => a.routeId < b.routeId ? -1 : a.routeId > b.routeId ? 1 : 0));
}

/** 경로가 한 번에 쥘 수 있는 칸(SQL quota_state.cap 과 같은 식). 빌려주기 켜짐: max / 꺼짐: 보장이 있으면 보장, 없으면 max. null = 상한 없음. */
export function routeQuotaCap(quota: Pick<ModelCapacityRouteQuota, "minSlots" | "maxSlots">, lendIdle: boolean): number | null {
  if (lendIdle) return quota.maxSlots;
  return quota.minSlots > 0 ? quota.minSlots : quota.maxSlots;
}

/** ModelCapacityRouteState 의 zod(스냅숏을 strict 로 다시 읽는 곳 — pipeline-control 의 controlSnapshotSchema). */
export const modelCapacityRouteStateSchema = z.object({
  routeId: identity(MODEL_CAPACITY_DEVICE_ID_MAX), active: int(0, 65_535), waiting: int(0, 65_535),
  minSlots: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX).nullable(), maxSlots: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX).nullable(),
  cap: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX).nullable(), demand: z.boolean(), held: int(0, MODEL_CAPACITY_DEVICE_LIMIT_MAX),
}).strict();

/** 장비 안 경로 하나의 실시간 몫 상태(deviceStateSql 의 routes). 몫 줄이 없는 경로는 minSlots·maxSlots·cap 이 null 이고 held 0 이다. */
export type ModelCapacityRouteState = Readonly<{
  routeId: string;
  /** reserved/dispatched(모든 세대). */
  active: number;
  /** 현재 세대 대기(queue_until > now). */
  waiting: number;
  minSlots: number | null; maxSlots: number | null;
  /** 지금 적용되는 상한(빌려주기에 따라). null = 상한 없음. */
  cap: number | null;
  /** 점유·대기 중이거나 idle_ms 안에 끝났다. */
  demand: boolean;
  /** 다른 경로가 비워 둬야 하는 이 경로의 못 채운 보장. */
  held: number;
}>;

/** 장비 하나의 실시간 상태(관리자 화면·status·1b-C 의 관측). 설정 출처 `table` | `policy_fallback`. `helpers` 는 이 장비의 도우미 경로 상태(PR 2a). */
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
  /** 도우미 경로 상태(helper_gate + helper_active, assignment_id·kind 순). deviceStateFromRow 는 언제나 채운다(배정이 없으면 []). */
  helpers?: readonly HelperGateState[];
  /** 경로 몫(0169): 유휴 보장 칸 빌려주기(대체 설정은 true). deviceStateSql 행에는 늘 있다. */
  lendIdle?: boolean;
  /** 경로 몫(0169): 이 장비의 경로마다 점유·대기·몫(몫 줄 ∪ 살아 있는 행이 있는 경로, route 순). deviceStateSql 행에는 늘 있다. */
  routes?: readonly ModelCapacityRouteState[];
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

/**
 * 경로 R 의 **새** 요청 하나가 지금 몫에 맞는가(deviceRouteQuotaGateSql·deviceCandidateSql 과 같은 식 — 선택 힌트·테스트용; 판정은 DB 안에서 한다).
 * atCap = routeActive + 현재 세대 대기 ≥ cap(요청은 대기 행 없이 route_quota). underGuarantee = routeActive < minSlots(rank 1 처럼 낮은 순위 상한을 넘는다).
 * fits = !atCap AND (underGuarantee ? active < limit : active + Σ 다른 경로 held < limit). routes 가 없는 상태(옛 읽기)는 몫이 없는 것으로 본다.
 */
export function deviceRouteQuotaFits(state: Pick<ModelCapacityDeviceState, "active" | "limitSlots" | "routes">, routeId: string):
  { fits: boolean; atCap: boolean; underGuarantee: boolean } {
  const routes = state.routes ?? [];
  const route = routes.find(row => row.routeId === routeId);
  const atCap = route !== undefined && route.cap !== null && route.active + route.waiting >= route.cap;
  const underGuarantee = route !== undefined && route.minSlots !== null && route.active < route.minSlots;
  const heldByOthers = routes.reduce((sum, row) => row.routeId === routeId ? sum : sum + row.held, 0);
  const fits = !atCap && (underGuarantee ? state.active < state.limitSlots : state.active + heldByOthers < state.limitSlots);
  return { fits, atCap, underGuarantee };
}

const deviceRef = (deviceId: SQL | string): SQL => typeof deviceId === "string" ? sql`${deviceId}` : deviceId;
// 상수는 bind 가 아니라 글자로 넣는다 — 렌더된 SQL 이 스스로 읽히고(ORDER BY coalesce(ro.role_rank, 32767)), 계획 캐시 키가 장비마다 같다.
const unranked = sql.raw(String(UNRANKED_ROLE_RANK));
const fallbackIdle = sql.raw(String(DEFAULT_DEVICE_IDLE_MS));
const fallbackReserve = sql.raw(String(DEFAULT_DEVICE_RESERVE_SLOTS));
const limitMax = sql.raw(String(MODEL_CAPACITY_DEVICE_LIMIT_MAX));

/** 장부 행 `alias`(roles 를 `ro` 로 LEFT JOIN 한 행)의 순위: 도우미 행은 greatest(rank, 2), 아니면 rank(없으면 UNRANKED_ROLE_RANK). */
const effectiveRank = (alias: string): SQL => sql`CASE WHEN ${helperRouteMatchSql(alias)}
        THEN greatest(coalesce(ro.role_rank, ${unranked}), 2) ELSE coalesce(ro.role_rank, ${unranked}) END`;

/**
 * 장비 D 의 판정 CTE 접두(도우미 sup·helper_gate·helper_active·demand, 그리고 s·roles·active·busy·counts·waiting, 경로 몫 quota·route_use·recent·quota_state).
 * deviceCandidateSql(입장)·deviceRouteQuotaGateSql(입장 사전 거절)과
 * deviceStateSql(관측)이 같은 접두를 쓴다 — 조건의 단일 출처. `deviceId` 는 bind 값(string) 또는 바깥 열 참조(SQL, LATERAL 안에서 d.device_id 등)다.
 * `groupLimitsJson` 은 정책 `groupLimits` 의 JSON 문자열(없으면 "{}") — 설정 행이 없을 때의 대체 한도(policy_fallback).
 * 도우미 조각(helperGateCte)은 자기 안에서만 참조하므로 맨 앞에 두고, `busy` 가 그 `demand` 를 읽는다.
 */
export function deviceStateCte(deviceId: SQL | string, generation: ModelCapacityGeneration, groupLimitsJson: string): SQL {
  const device = deviceRef(deviceId);
  const occupying = sql.raw(DEVICE_OCCUPYING_STATES_SQL);
  const limitPattern = sql.raw(`'${DEVICE_FALLBACK_LIMIT_PATTERN.source}'`);
  return sql`WITH ${helperGateCte(device)},
    s AS MATERIALIZED (
      SELECT d.limit_slots, d.secondary_cap, d.idle_ms, d.reserve_slots, 'table'::text AS source, d.version, d.updated_at, d.lend_idle
      FROM model_capacity_devices d WHERE d.device_id = ${device} AND d.enabled
      UNION ALL
      SELECT (${groupLimitsJson}::jsonb ->> ${device})::int, (${groupLimitsJson}::jsonb ->> ${device})::int,
        ${fallbackIdle}::int, ${fallbackReserve}::int, 'policy_fallback'::text, NULL::bigint, NULL::timestamptz, true
      WHERE NOT EXISTS (SELECT 1 FROM model_capacity_devices d WHERE d.device_id = ${device} AND d.enabled)
        AND (${groupLimitsJson}::jsonb ->> ${device}) ~ ${limitPattern}
        AND (${groupLimitsJson}::jsonb ->> ${device})::int <= ${limitMax}
    ),
    roles AS MATERIALIZED (SELECT ro.route_id, ro.role_rank FROM model_capacity_device_roles ro WHERE ro.device_id = ${device}),
    active AS MATERIALIZED (
      SELECT ${effectiveRank("r")} AS role_rank
      FROM model_capacity_requests r LEFT JOIN roles ro ON ro.route_id = r.route_id
      WHERE r.group_id = ${device} AND r.state IN ${occupying}
    ),
    busy AS MATERIALIZED (
      SELECT (EXISTS (
        SELECT 1 FROM model_capacity_requests r JOIN roles ro ON ro.route_id = r.route_id AND ro.role_rank = 1, s
        WHERE r.group_id = ${device} AND NOT ${helperRouteMatchSql("r")} AND (
          (r.state = 'waiting' AND r.epoch = ${generation.epoch} AND r.revision = ${generation.revision}
            AND r.policy_hash = ${generation.policyHash} AND r.queue_until > clock_timestamp())
          OR r.state IN ${occupying}
          OR r.updated_at >= clock_timestamp() - s.idle_ms * interval '1 millisecond')
      ) OR ${helperDemandOnSql()}) AS primary_busy
    ),
    counts AS MATERIALIZED (
      SELECT count(*)::int AS total, (count(*) FILTER (WHERE role_rank > 1))::int AS secondary FROM active
    ),
    waiting AS MATERIALIZED (
      SELECT count(*)::int AS waiting, (count(*) FILTER (WHERE ${effectiveRank("r")} = 1))::int AS waiting_primary
      FROM model_capacity_requests r LEFT JOIN roles ro ON ro.route_id = r.route_id
      WHERE r.group_id = ${device} AND r.state = 'waiting' AND r.epoch = ${generation.epoch} AND r.revision = ${generation.revision}
        AND r.policy_hash = ${generation.policyHash} AND r.queue_until > clock_timestamp()
    ),
    ${routeQuotaCte(device, generation)}`;
}

/**
 * 경로 몫 CTE(step 2, 0169) — deviceStateCte 의 끝에 붙는다(s 를 읽는다). 몫 줄이 없는 장비는 quota·quota_state 가 비어 입장이 오늘과 같다.
 * - quota: enabled 장비 행의 route_quotas 줄.
 * - route_use: 경로별 점유(reserved/dispatched, 모든 세대)·현재 세대 대기 — active·waiting CTE 와 같은 거르기(같은 부분 색인)를 경로로 나눈 것.
 * - recent: 보장이 있는 경로 중 idle_ms 안에 settled·withdrawn 된 행이 있는 것(부분 색인 settled_at·withdrawn_at 으로 읽는다; 기준 시각은 한 번 계산한다).
 * - quota_state: 몫 줄마다 active·waiting·demand·cap·held(정의는 이 파일 머리 주석).
 * 열은 감시자 계정의 열 단위 SELECT(lib/runtime/oracle-db-profile.ts CAPACITY_REQUEST_READ) 안의 것만 쓴다 — queue_ordinal 은 쓰지 않는다.
 */
function routeQuotaCte(device: SQL, generation: ModelCapacityGeneration): SQL {
  const occupying = sql.raw(DEVICE_OCCUPYING_STATES_SQL);
  const cutoff = sql`(SELECT clock_timestamp() - s.idle_ms * interval '1 millisecond' FROM s)`;
  const recentDemand = sql`EXISTS (SELECT 1 FROM recent rc WHERE rc.route_id = qu.route_id)`;
  return sql`quota AS MATERIALIZED (
      SELECT x.route_id, x.min_slots, x.max_slots
      FROM model_capacity_devices d CROSS JOIN LATERAL jsonb_to_recordset(d.route_quotas) AS x(route_id text, min_slots int, max_slots int)
      WHERE d.device_id = ${device} AND d.enabled
    ),
    route_use AS MATERIALIZED (
      SELECT u.route_id, sum(u.active)::int AS active, sum(u.waiting)::int AS waiting FROM (
        SELECT r.route_id, count(*) AS active, 0::bigint AS waiting FROM model_capacity_requests r
        WHERE r.group_id = ${device} AND r.state IN ${occupying} GROUP BY r.route_id
        UNION ALL
        SELECT r.route_id, 0::bigint, count(*) FROM model_capacity_requests r
        WHERE r.group_id = ${device} AND r.state = 'waiting' AND r.epoch = ${generation.epoch} AND r.revision = ${generation.revision}
          AND r.policy_hash = ${generation.policyHash} AND r.queue_until > clock_timestamp() GROUP BY r.route_id
      ) u GROUP BY u.route_id
    ),
    recent AS MATERIALIZED (
      SELECT DISTINCT r.route_id FROM model_capacity_requests r
      WHERE r.group_id = ${device} AND r.route_id IN (SELECT qr.route_id FROM quota qr WHERE qr.min_slots > 0)
        AND ((r.state = 'settled' AND r.settled_at >= ${cutoff}) OR (r.state = 'withdrawn' AND r.updated_at >= ${cutoff}))
    ),
    quota_state AS MATERIALIZED (
      SELECT qu.route_id, qu.min_slots, qu.max_slots, coalesce(u.active, 0) AS active, coalesce(u.waiting, 0) AS waiting,
        (coalesce(u.active, 0) > 0 OR coalesce(u.waiting, 0) > 0 OR ${recentDemand}) AS demand,
        CASE WHEN s.lend_idle THEN qu.max_slots WHEN qu.min_slots > 0 THEN qu.min_slots ELSE qu.max_slots END AS cap,
        CASE WHEN NOT s.lend_idle OR coalesce(u.active, 0) > 0 OR coalesce(u.waiting, 0) > 0 OR ${recentDemand}
          THEN greatest(qu.min_slots - coalesce(u.active, 0), 0) ELSE 0 END AS held
      FROM quota qu CROSS JOIN s LEFT JOIN route_use u ON u.route_id = qu.route_id
    )`;
}

/**
 * 장비 D 에서 지금 입장시킬 대기 행 하나(`request_id`)를 잠근다(`FOR UPDATE OF q`). 1b-C 의 grantOne 이 control 행 FOR UPDATE 아래에서
 * 장비마다 한 번 실행한다. 설정 출처가 없으면(s 가 비면) 행이 나오지 않는다 → 그 장비는 grant 없음.
 * 도우미 행(h.helper)은 rank 1 우회가 없고, 열린 경로·max_slots 안에서만 맞으며(helperCandidateExclusionSql), 자기 역할 행 뒤에 정렬된다.
 */
export function deviceCandidateSql(deviceId: string, generation: ModelCapacityGeneration, groupLimitsJson: string): SQL {
  const device = deviceRef(deviceId);
  // 경로 몫(step 2): 보장 아래의 행(under)은 다른 경로의 held 를 보지 않고 rank 1 처럼 낮은 순위 상한을 넘는다(도우미 행 제외).
  // 몫 줄이 없으면 qs 가 NULL 이라 cap 조건은 참, under 는 거짓, held 합은 0 — 조건이 오늘의 `c.total < s.limit_slots` 와 같아진다.
  const under = sql`coalesce(qs.active < qs.min_slots, false)`;
  return sql`${deviceStateCte(deviceId, generation, groupLimitsJson)}
    SELECT q.request_id FROM model_capacity_requests q
      LEFT JOIN roles ro ON ro.route_id = q.route_id
      LEFT JOIN quota_state qs ON qs.route_id = q.route_id
      CROSS JOIN LATERAL (SELECT ${helperRouteMatchSql("q")} AS helper) h, s, counts c, busy b
    WHERE q.group_id = ${device} AND q.state = 'waiting'
      AND q.epoch = ${generation.epoch} AND q.revision = ${generation.revision} AND q.policy_hash = ${generation.policyHash}
      AND q.queue_until > clock_timestamp()
      AND c.total < s.limit_slots
      AND ((NOT h.helper AND coalesce(ro.role_rank, ${unranked}) = 1) OR (NOT h.helper AND ${under})
        OR c.secondary < CASE WHEN b.primary_busy THEN s.secondary_cap ELSE greatest(s.secondary_cap, s.limit_slots - s.reserve_slots) END)
      AND ${helperCandidateExclusionSql("q")}
      AND (qs.cap IS NULL OR qs.active < qs.cap)
      AND (${under} OR c.total + (SELECT coalesce(sum(o.held), 0) FROM quota_state o WHERE o.route_id <> q.route_id) < s.limit_slots)
    ORDER BY h.helper, coalesce(ro.role_rank, ${unranked}), q.queue_ordinal LIMIT 1 FOR UPDATE OF q`;
}

/**
 * requestSlot 의 경로 몫 사전 거절(step 2) — 장비 D 에서 route R 의 몫 상태 한 줄(몫 줄이 없으면 0 행). `ahead` = R 의 현재 세대 대기 행 중
 * 이 요청보다 앞선 것(새 요청은 전부). routeActive + ahead ≥ cap 이면 그 요청은 상한에 닿았다 — 대기 행 없이(있던 자기 대기 행은 거두고) route_quota.
 * control 행 FOR UPDATE 아래 입장 TX 에서만 부른다(queue_ordinal 을 읽는다 — 감시자 관측 경로에서는 쓰지 않는다).
 */
export function deviceRouteQuotaGateSql(deviceId: string, generation: ModelCapacityGeneration, groupLimitsJson: string, routeId: string,
  ownRequestId: string | null): SQL {
  const device = deviceRef(deviceId);
  const behindOwn = ownRequestId === null ? sql`true`
    : sql`w.request_id <> ${ownRequestId}::uuid AND w.queue_ordinal < (SELECT o.queue_ordinal FROM model_capacity_requests o WHERE o.request_id = ${ownRequestId}::uuid)`;
  return sql`${deviceStateCte(deviceId, generation, groupLimitsJson)}
    SELECT qs.cap, qs.active, qs.min_slots, (SELECT count(*)::int FROM model_capacity_requests w
        WHERE w.group_id = ${device} AND w.route_id = ${routeId} AND w.state = 'waiting'
          AND w.epoch = ${generation.epoch} AND w.revision = ${generation.revision} AND w.policy_hash = ${generation.policyHash}
          AND w.queue_until > clock_timestamp() AND ${behindOwn}) AS ahead
    FROM quota_state qs WHERE qs.route_id = ${routeId}`;
}

/** deviceRouteQuotaGateSql 의 행. */
export type DeviceRouteQuotaGateRow = { cap: number | null; active: number; min_slots: number; ahead: number };
/** 상한에 닿았나(cap 이 없으면 아니다). */
export const routeQuotaGateCapped = (row: DeviceRouteQuotaGateRow | undefined): boolean =>
  row !== undefined && row.cap !== null && Number(row.active) + Number(row.ahead) >= Number(row.cap);

/** deviceStateSql 이 돌려주는 행(snake_case; 숫자는 int 로 캐스팅돼 있다). */
export type DeviceStateRow = {
  device_id: string; source: "table" | "policy_fallback"; limit_slots: number; secondary_cap: number; idle_ms: number; reserve_slots: number;
  active: number; secondary_active: number; secondary_bound: number; primary_busy: boolean; lending: boolean;
  waiting: number; waiting_primary: number; version: string | number | null; updated_at: Date | string | null;
  /** jsonb 배열(HelperGateStateRow 모양). 이 열이 없는 옛 행 모양도 받는다. */
  helpers?: unknown;
  /** 경로 몫(0169). 이 열들이 없는 옛 행 모양도 받는다(그때는 상태에 싣지 않는다). */
  lend_idle?: boolean;
  /** jsonb 배열 [{route_id, active, waiting, min_slots, max_slots, cap, demand, held}]. */
  routes?: unknown;
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
      w.waiting, w.waiting_primary,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('assignment_id', g.assignment_id, 'kind', g.kind, 'route_id', g.route_id,
          'provider', g.provider, 'model', g.model, 'ok', g.ok, 'active', coalesce(a.n, 0), 'max_slots', g.max_slots)
          ORDER BY g.assignment_id, g.kind), '[]'::jsonb)
        FROM helper_gate g LEFT JOIN helper_active a ON a.assignment_id = g.assignment_id) AS helpers,
      s.lend_idle,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('route_id', x.route_id, 'active', x.active, 'waiting', x.waiting, 'min_slots', x.min_slots,
          'max_slots', x.max_slots, 'cap', x.cap, 'demand', x.demand, 'held', x.held) ORDER BY x.route_id), '[]'::jsonb)
        FROM (SELECT coalesce(qs.route_id, u.route_id) AS route_id, coalesce(u.active, 0) AS active, coalesce(u.waiting, 0) AS waiting,
            qs.min_slots, qs.max_slots, qs.cap, coalesce(qs.demand, false) AS demand, coalesce(qs.held, 0) AS held
          FROM quota_state qs FULL JOIN route_use u ON u.route_id = qs.route_id) x) AS routes
    FROM s, counts c, busy b, waiting w`;
}

/** deviceStateSql 의 `routes` jsonb → 경로 몫 상태(route 순). 배열이 아니면 빈 목록. */
export function routeStatesFromJson(value: unknown): readonly ModelCapacityRouteState[] {
  const rows = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(rows)) return Object.freeze([]);
  const num = (raw: unknown) => raw === null || raw === undefined ? null : Number(raw);
  return Object.freeze(rows.map(raw => {
    const row = raw as Record<string, unknown>;
    return Object.freeze({ routeId: String(row.route_id), active: Number(row.active ?? 0), waiting: Number(row.waiting ?? 0),
      minSlots: num(row.min_slots), maxSlots: num(row.max_slots), cap: num(row.cap), demand: row.demand === true, held: Number(row.held ?? 0) });
  }));
}

/** DeviceStateRow → ModelCapacityDeviceState(camelCase, ISO 시각). */
export function deviceStateFromRow(row: DeviceStateRow): ModelCapacityDeviceState {
  const updatedAt = row.updated_at === null ? null : row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString();
  return Object.freeze({
    deviceId: row.device_id, source: row.source, limitSlots: Number(row.limit_slots), secondaryCap: Number(row.secondary_cap),
    idleMs: Number(row.idle_ms), reserveSlots: Number(row.reserve_slots), active: Number(row.active), secondaryActive: Number(row.secondary_active),
    secondaryBound: Number(row.secondary_bound), primaryBusy: Boolean(row.primary_busy), lending: Boolean(row.lending),
    waiting: Number(row.waiting), waitingPrimary: Number(row.waiting_primary),
    version: row.version === null ? null : Number(row.version), updatedAt, helpers: helperGateStatesFromJson(row.helpers),
    ...(row.lend_idle === undefined ? {} : { lendIdle: row.lend_idle !== false }),
    ...(row.routes === undefined ? {} : { routes: routeStatesFromJson(row.routes) }),
  });
}
