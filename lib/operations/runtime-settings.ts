import type { RuntimeSettingGroup } from "./runtime-settings-schema";
import type { SettingsApply } from "./settings-apply";

/**
 * runtime_settings 행(0151)의 DB 읽기·저장·감사·적용 확인 — PR 1a WP-A 가 채운다. 서명은 계약으로 고정되어 있다(live-settings-plan §7).
 * 지금은 모두 runtime_settings_not_implemented 를 던진다. 읽기 경로(workers·web)는 이 모듈이 아니라 runtime-settings-store 를 쓴다.
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

const NOT_IMPLEMENTED = "runtime_settings_not_implemented";

/** 한 행(id = 1)의 저장 문서·revision. 행이 없으면(0151 전) 던진다. */
export async function readRuntimeSettingsRow(): Promise<RuntimeSettingsRow> {
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * sparse patch 를 그룹 범위로 저장한다(null 값 = 그 키를 기본값으로). revision CAS(expectedRevision) → zod + 교차 검사(덮어쓴 등록부 기준) → UPDATE →
 * operations_audit(RUNTIME_SETTINGS_AUDIT_ACTION, before/after/changes/revision). 거절은 { ok: false, issues } 로 돌려주고 던지지 않는다.
 */
export async function saveRuntimeSettings(patch: unknown, actor: string, options: SaveRuntimeSettingsOptions): Promise<SaveRuntimeSettingsResult> {
  void patch; void actor; void options;
  throw new Error(NOT_IMPLEMENTED);
}

/** 저장된 판과 각 역할 워커가 heartbeat 로 알린 runtimeSettingsVersion 을 견준다(settings-apply.ts 의 일반화). */
export async function readRuntimeSettingsApply(): Promise<SettingsApply> {
  throw new Error(NOT_IMPLEMENTED);
}
