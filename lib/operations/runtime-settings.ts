import { and, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit, runtimeSettings as runtimeSettingsTable } from "@/lib/db/schema";
import { overlaidModelDefinitions, type ModelDefinition } from "@/lib/llm/model-registry";
import { ensureServingContracts, servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { logger } from "@/lib/observability/logger";
import { adminAuditRow, settingsChanges } from "./admin-log";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";
import { RUNTIME_SETTING_GROUPS, RUNTIME_SETTINGS_VERSION, resolveRuntimeSettings, runtimeSettingLabel, storedSettingsVersion,
  type RuntimeSettingGroup, type RuntimeSettings } from "./runtime-settings-schema";
import { RUNTIME_SETTINGS_ROLES, readApplyObservations, runtimeSettingsApplyStatus, type SettingsApply } from "./settings-apply";

/**
 * runtime_settings 행(0152)의 DB 읽기·저장·감사·적용 확인 — PR 1a WP-A. 서명은 계약으로 고정되어 있다(live-settings-plan §7).
 * 읽기 경로(workers·web)는 이 모듈이 아니라 runtime-settings-store 를 쓴다(serving-contract-store 의 같은 reload 가 행을 올린다).
 *
 * 저장은 한 트랜잭션이다: DR writer fence → 행 FOR UPDATE → revision compare-and-set(expectedRevision) → sparse patch 를 그룹 범위로 덮기 →
 * 덮어쓴 등록부 기준으로 유효 문서 검증(resolveRuntimeSettings 의 issues 가 비어야 한다) → UPDATE(revision + 1) → operations_audit 한 줄.
 * 거절(stale_form·site_fenced·검증 실패)은 { ok: false, issues } 로 돌려주고 던지지 않는다; 그 외 DB 오류는 던진다.
 */
export type { RuntimeSettingGroup };

/** operations_audit 의 action. target 은 `runtime_settings:<group>` */
export const RUNTIME_SETTINGS_AUDIT_ACTION = "runtime-settings-save";
export const runtimeSettingsAuditTarget = (group: RuntimeSettingGroup) => `runtime_settings:${group}`;
/** 저장 거절 이유(한국어 메시지는 UI 가 붙인다). resolveRuntimeSettings 의 issues 와 같은 꼴 */
export type RuntimeSettingsRefusal = "stale_form" | "site_fenced" | `unknown_route:${string}` | `unknown_job:${string}` | `budget_below_call_timeout:${string}`
  | `budget_below_min_call:${string}` | `min_call_exceeds_timeout:${string}` | "batch_exceeds_source_cap" | "deadline_order_inverted"
  | "model_timeout_ladder_mismatch" | `timeout_below_engine_bound:${string}` | `runtime_settings_invalid:${string}` | (string & {});

export type RuntimeSettingsRow = { values: unknown; revision: number; updatedBy: string; updatedAt: string };
export type SaveRuntimeSettingsOptions = { expectedRevision?: number; group: RuntimeSettingGroup };
export type SaveRuntimeSettingsResult = { ok: true; revision: number; version: string } | { ok: false; issues: string[] };

const ROW_ID = 1;
/** 문서 CHECK(pg_column_size ≤ 65536)보다 앞서 거절하는 텍스트 길이. 실제 문서는 수 KB 다 */
const STORED_DOCUMENT_MAX_CHARS = 60_000;
/** 저장이 쓰는 그룹 — devices 는 PR 1b 의 관계형 표(이 문서에 들어가지 않는다) */
const EDITABLE_GROUPS: readonly RuntimeSettingGroup[] = ["routes", "translation", "jobs", "budgets"];

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** 기한 사다리의 relayMs: null 은 "중계 층 없음"이라는 값이다 — 지우기가 아니다 */
const keepsNull = (path: readonly string[]) => path.length === 4 && path[0] === "routes" && path[1] === "deadlines" && path[3] === "relayMs";

function mergeSparse(base: Record<string, unknown>, patch: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const here = [...path, key];
    if (value === undefined) continue;
    if (value === null && !keepsNull(here)) { delete out[key]; continue; }
    if (isPlainObject(value)) {
      const inner = mergeSparse(isPlainObject(out[key]) ? out[key] : {}, value, here);
      if (Object.keys(inner).length) out[key] = inner; else delete out[key];
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * sparse 저장 문서에 그룹 범위의 patch 를 덮는다(순수). null 값 = 그 키를 지운다(기본값으로); 객체는 한 단계씩 깊이 덮는다; 빈 객체는 남기지 않는다.
 * 다른 그룹의 키는 그대로다. 결과의 유효성은 resolveRuntimeSettings 가 본다 — 여기서는 모양(객체·그룹)만 거절한다.
 */
export function applyRuntimeSettingsPatch(stored: unknown, group: RuntimeSettingGroup, patch: unknown): { stored: Record<string, unknown>; issues: string[] } {
  const base: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
  base.version = RUNTIME_SETTINGS_VERSION;
  if (!EDITABLE_GROUPS.includes(group)) return { stored: base, issues: [`group_not_editable:${group}`] };
  if (!isPlainObject(patch)) return { stored: base, issues: [`runtime_settings_invalid:${group}`] };
  // 관리자 폼(WP-D)은 문서 모양 `{ <group>: {...} }` 으로, CLI·테스트는 그룹 부분 문서로 보낸다 — 그룹 키 하나로만 감싼 패치는 벗겨서 받는다.
  const keys = Object.keys(patch);
  const slice = keys.length === 1 && keys[0] === group && isPlainObject((patch as Record<string, unknown>)[group]) ? (patch as Record<string, unknown>)[group] : patch;
  const merged = mergeSparse(isPlainObject(base[group]) ? base[group] : {}, slice as Record<string, unknown>, [group]);
  if (Object.keys(merged).length) base[group] = merged; else delete base[group];
  return { stored: base, issues: [] };
}

/** 저장 검증이 보는 등록부: 관리자 덮어쓰기(model_registry_overrides)까지 — 그 모델의 purposes 도 아는 경로다. reload 가 실패하면 코드 기본 등록부(거절은 보수적이다). */
async function overlaidRegistryForSave(): Promise<readonly ModelDefinition[]> {
  await ensureServingContracts(0);
  const snapshot = servingContractSnapshot();
  if (!snapshot.runtime && snapshot.loadedAt === 0) logger.warn("runtime_settings.save_without_registry_reload", {});
  return overlaidModelDefinitions(snapshot.registry);
}

const groupSlice = (settings: RuntimeSettings, group: RuntimeSettingGroup): unknown =>
  group === "devices" ? null : settings[group];

/** 한 행(id = 1)의 저장 문서·revision. 행이 없으면(0152 전) 던진다. */
export async function readRuntimeSettingsRow(): Promise<RuntimeSettingsRow> {
  const [row] = await db.select().from(runtimeSettingsTable).where(eq(runtimeSettingsTable.id, ROW_ID));
  if (!row) throw new Error("runtime_settings_row_missing");
  return { values: row.values, revision: Number(row.revision), updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
}

/**
 * sparse patch 를 그룹 범위로 저장한다(null 값 = 그 키를 기본값으로). revision CAS(expectedRevision) → zod + 교차 검사(덮어쓴 등록부 기준) → UPDATE →
 * operations_audit(RUNTIME_SETTINGS_AUDIT_ACTION, before/after/changes/revision). 거절은 { ok: false, issues } 로 돌려주고 던지지 않는다.
 */
export async function saveRuntimeSettings(patch: unknown, actor: string, options: SaveRuntimeSettingsOptions): Promise<SaveRuntimeSettingsResult> {
  const { group, expectedRevision } = options;
  if (!actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  if (!(RUNTIME_SETTING_GROUPS as readonly string[]).includes(group)) return { ok: false, issues: [`unknown_group:${String(group)}`] };
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) return { ok: false, issues: ["stale_form"] };
  const models = await overlaidRegistryForSave();
  const target = runtimeSettingsAuditTarget(group);
  try {
    return await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      // 0152 가 심은 행이 없어도 저장이 스스로 세운다(빈 문서 = 코드 기본값)
      await tx.insert(runtimeSettingsTable).values({ id: ROW_ID, values: { version: RUNTIME_SETTINGS_VERSION }, updatedBy: actor }).onConflictDoNothing();
      const [row] = await tx.select().from(runtimeSettingsTable).where(eq(runtimeSettingsTable.id, ROW_ID)).for("update");
      const current = Number(row.revision);
      const refuse = async (issues: string[], detail: Record<string, unknown>): Promise<SaveRuntimeSettingsResult> => {
        await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: RUNTIME_SETTINGS_AUDIT_ACTION, target,
          detail: { group, revision: current, ...detail }, ok: false, error: issues.join(" · ") }));
        return { ok: false, issues };
      };
      if (expectedRevision !== undefined && current !== expectedRevision) return refuse(["stale_form"], { expectedRevision });

      const before = resolveRuntimeSettings(row.values, { models });
      const applied = applyRuntimeSettingsPatch(row.values, group, patch);
      const after = resolveRuntimeSettings(applied.stored, { models });
      const changes = settingsChanges(before.settings, after.settings).map(change => ({ ...change, label: runtimeSettingLabel(change.path) }));
      const issues = [...new Set([...applied.issues, ...after.issues])];
      if (!issues.length && JSON.stringify(applied.stored).length > STORED_DOCUMENT_MAX_CHARS) issues.push("runtime_settings_too_large");
      if (issues.length) return refuse(issues, { changes });

      const revision = current + 1, version = storedSettingsVersion(applied.stored);
      await tx.update(runtimeSettingsTable).set({ values: applied.stored, revision, updatedBy: actor, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(runtimeSettingsTable.id, ROW_ID), eq(runtimeSettingsTable.revision, current)));
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: RUNTIME_SETTINGS_AUDIT_ACTION, target,
        detail: { group, revision, version, changes, before: groupSlice(before.settings, group), after: groupSlice(after.settings, group) } }));
      // 한도가 바뀌면 틱의 결과가 바뀐다 — "왜 이때부터 달라졌지"를 되짚을 수 있어야 한다
      logger.info("runtime_settings.saved", { actor, group, revision, version, changes: changes.map(change => change.path) });
      return { ok: true, revision, version };
    }));
  } catch (error) {
    if (error instanceof DrWriterFencedError) return { ok: false, issues: [error.reason] };
    throw error;
  }
}

/**
 * 저장된 판과 각 역할 워커가 heartbeat 로 알린 runtimeSettingsVersion 을 견준다 — settings-apply.ts 의 RUNTIME_SETTINGS_APPLY(WP-B):
 * 다섯 역할(maintenance 포함), runtimeSettingsRegistryEnv → registryEnv 배지, 조치 링크 /admin/models/limits#apply.
 * 행이 없으면(0152 전) 워커도 기본값("default")으로 돈다 — 같은 판이다.
 */
export async function readRuntimeSettingsApply(): Promise<SettingsApply> {
  const [saved, observations] = await Promise.all([
    db.select({
      values: runtimeSettingsTable.values,
      // updated_at 은 timestamptz 다 — 경과는 DB 시계로 잰다
      ageSeconds: sql<number>`extract(epoch from (clock_timestamp() - ${runtimeSettingsTable.updatedAt}))::double precision`,
    }).from(runtimeSettingsTable).where(eq(runtimeSettingsTable.id, ROW_ID)),
    readApplyObservations(RUNTIME_SETTINGS_ROLES),
  ]);
  const row = saved[0];
  return runtimeSettingsApplyStatus({
    savedVersion: storedSettingsVersion(row?.values),
    // 심은 행(migration)·운영자 저장 모두 updated_at 이 있다; 행이 없으면 저장한 적이 없다
    savedAgeSeconds: row ? Number(row.ageSeconds) : null,
    observations,
  });
}
