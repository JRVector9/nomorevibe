import { db, onPrimary } from "@/lib/db";
import { deviceSettingsFromPolicyFallback, type ModelCapacityModelLimit } from "@/lib/llm/capacity-devices";
import { readModelCapacityDevice, saveModelCapacityDevice, saveModelCapacityModelLimits } from "@/lib/llm/capacity-devices-repository";
import { logger } from "@/lib/observability/logger";
import { capacityDeviceIssueMessage } from "./admin-capacity-devices";
import { modelLimitChangeLines, modelLimitIssueMessage, modelLimitsInputFromForm, modelLimitWarningMessage } from "./admin-capacity-model-limits";
import { DrWriterFencedError } from "./dr/epoch";

/**
 * 장비 한도 표(/admin/models/devices, 2026-11-09 개편)의 한 줄 저장 — 서버 한 대의 「운영 한도」(칸 수)와, 모델이 나뉜 장비(M3 = m3-mlx)는 모델 한도 줄까지
 * 한 쓰기 TX 에서 함께 저장한다. 서버에서만 import 한다(DB 를 쓴다).
 *
 * - 운영 한도만 바꾼다: 엔진 최대치(physicalLimit)·역할 순서·유휴 시간·메모는 지금 행 값 그대로다(옛 공유 한도 폼은 엔진 최대치도 같은 값으로 덮었다 —
 *   M3 는 공유 2, 엔진 최대 합 5 라 그러면 안 된다). 낮은 순위 상한이 칸 수와 같았으면(우선순위 없음) 새 칸 수를 따라가고, 아니면 새 칸 수 이하로만 줄인다.
 *   비워 둘 칸은 새 칸 수 − 1 이하로만 줄인다. 행이 없는 장비(정책 대체·미설정)는 정책 대체 설정(cap = limit)으로 첫 행을 만든다.
 * - 칸 수가 그대로면 장비 저장을 건너뛰고(판·감사 줄이 늘지 않는다), 모델 줄이 그대로면 모델 상한 저장을 건너뛴다.
 * - 두 저장 모두 저장소 함수(saveModelCapacityDevice·saveModelCapacityModelLimits)라 fence → control FOR UPDATE → 장비 행 FOR UPDATE·CAS → 감사 한 줄을
 *   각자 한다. 하나라도 거절하면 TX 가 통째로 되돌아간다. 판(version) CAS 는 처음 읽은 행으로 먼저 보고, 두 번째 저장은 첫 저장이 올린 판으로 건다.
 * - 꺼진 장비는 여기서 저장하지 않는다(장비 저장이 enabled 를 켜 버린다) — 세부 설정의 장비 폼에서 다룬다.
 */
export type DeviceRowFormInput = { deviceId: string; expectedVersion: number | null; limitSlots: number;
  /** null = 모델 줄을 보내지 않음(모델이 나뉘지 않은 장비) */
  modelLimits: ModelCapacityModelLimit[] | null };
export type DeviceRowFormParse = { input: DeviceRowFormInput | null; issues: string[] };
type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };
const text = (value: FormDataEntryValue | null | undefined) => typeof value === "string" ? value.trim() : "";
export const DEVICE_ROW_LIMIT_MAX = 256;

/**
 * 폼 칸 이름: deviceId · expectedVersion(빈 값 = 행 없는 장비) · limitSlots(운영 한도) · modelLimits=1 이면 모델 줄
 * (model 반복 + max:<model> + engine:<model> — admin-capacity-model-limits modelLimitsInputFromForm 과 같은 규칙: max 가 비면 그 모델의 줄을 지운다).
 */
export function deviceRowInputFromForm(form: FormLike): DeviceRowFormParse {
  const issues: string[] = [];
  const deviceId = text(form.get("deviceId"));
  if (!deviceId) issues.push("장비 이름을 읽지 못했습니다. 새로고침해주세요.");
  const versionText = text(form.get("expectedVersion"));
  let expectedVersion: number | null = null;
  if (versionText) {
    const parsed = /^\d{1,15}$/.test(versionText) ? Number(versionText) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1) issues.push("판 번호(version)를 읽지 못했습니다. 새로고침해주세요.");
    else expectedVersion = parsed;
  }
  const limitText = text(form.get("limitSlots")).replace(/,/g, "");
  const limitSlots = /^\d{1,3}$/.test(limitText) ? Number(limitText) : NaN;
  if (!(limitSlots >= 1 && limitSlots <= DEVICE_ROW_LIMIT_MAX)) issues.push(`운영 한도는 1~${DEVICE_ROW_LIMIT_MAX} 의 정수입니다.`);
  let modelLimits: ModelCapacityModelLimit[] | null = null;
  if (text(form.get("modelLimits")) === "1") {
    // 줄 읽기 규칙은 모델 상한 폼 하나를 쓴다 — 판은 여기서 이미 읽었으므로(행 없는 장비는 빈 값) 그 검사는 넘긴다
    const lines = modelLimitsInputFromForm({ get: name => name === "expectedVersion" ? "1" : name === "deviceId" ? deviceId || "-" : form.get(name),
      getAll: name => form.getAll(name) });
    issues.push(...lines.issues);
    modelLimits = lines.input?.limits ?? null;
  }
  if (issues.length) return { input: null, issues };
  return { input: { deviceId, expectedVersion, limitSlots, modelLimits }, issues };
}

export type SaveDeviceRowResult = { ok: true; deviceId: string; version: number | null; changes: string[]; warnings: string[] } | { ok: false; issues: string[] };
function fail(code: string): never { throw new Error(code); }

/** 한 줄 저장 — 위 규칙. 거절 코드는 그대로 돌려준다(문장은 deviceRowIssueMessage). DB 오류 등 그 밖은 던진다 */
export async function saveAdminDeviceRow(input: DeviceRowFormInput, actor: string): Promise<SaveDeviceRowResult> {
  if (!actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  try {
    const result = await onPrimary(() => db.transaction(async tx => {
      const before = await readModelCapacityDevice(input.deviceId, tx);
      if ((before?.version ?? null) !== input.expectedVersion) fail(`model_capacity_device_version_mismatch:${before?.version ?? "none"}`);
      if (before && !before.enabled) fail("model_capacity_device_row_disabled");
      let version = before?.version ?? null;
      const changes: string[] = [];
      let warnings: readonly string[] = [];
      if (!before || before.limitSlots !== input.limitSlots) {
        const current = before ?? deviceSettingsFromPolicyFallback(input.deviceId, input.limitSlots);
        const limit = input.limitSlots;
        const next = { deviceId: input.deviceId, limitSlots: limit,
          secondaryCap: current.secondaryCap === current.limitSlots ? limit : Math.min(current.secondaryCap, limit),
          reserveSlots: Math.min(current.reserveSlots, limit - 1), idleMs: current.idleMs, physicalLimit: current.physicalLimit,
          roles: current.roles.map(role => ({ routeId: role.routeId, rank: role.rank })), note: current.note };
        const saved = await saveModelCapacityDevice(tx, next, input.expectedVersion, actor);
        version = saved.after.version;
        changes.push(`운영 한도: ${before ? before.limitSlots : "없음(정책 대체)"} → ${limit}`);
        if (before && before.secondaryCap !== next.secondaryCap) changes.push(`낮은 순위 상한: ${before.secondaryCap} → ${next.secondaryCap}`);
        if (before && before.reserveSlots !== next.reserveSlots) changes.push(`비워 둘 칸: ${before.reserveSlots} → ${next.reserveSlots}`);
      }
      if (input.modelLimits) {
        const lines = modelLimitChangeLines(before?.modelLimits ?? [], input.modelLimits);
        if (lines.length) {
          if (version === null) fail("model_capacity_model_limit_device_unconfigured");
          const saved = await saveModelCapacityModelLimits(tx, { deviceId: input.deviceId, expectedVersion: version, limits: input.modelLimits }, actor);
          version = saved.after.version;
          warnings = saved.warnings;
          changes.push(...lines);
        }
      }
      return { version, changes, warnings: [...warnings] };
    }));
    logger.info("model_capacity_device_row.saved", { actor, deviceId: input.deviceId, version: result.version, changes: result.changes.length });
    return { ok: true, deviceId: input.deviceId, ...result };
  } catch (error) {
    if (error instanceof DrWriterFencedError) return { ok: false, issues: [error.reason] };
    const code = error instanceof Error ? error.message : String(error);
    if (!/^model_capacity_/.test(code)) throw error;
    return { ok: false, issues: [code] };
  }
}

/** 이 표의 거절 문장 — 운영 한도·엔진 최대치 이름으로 말하고, 나머지는 모델 상한·장비 한도 화면의 문장(모르면 코드 그대로) */
export function deviceRowIssueMessage(issue: string, limits: readonly Pick<ModelCapacityModelLimit, "model">[] = []): string {
  if (issue === "model_capacity_device_row_disabled") return "꺼진 장비입니다 — 아래 세부 설정의 장비 폼에서 먼저 켜 주세요.";
  if (issue === "model_capacity_device_invalid:limitSlots" || issue === "model_capacity_device_invalid:limit_exceeds_physical")
    return "운영 한도는 1~256 이고 엔진 최대치를 넘을 수 없습니다 — 엔진 최대치는 세부 설정의 「엔진 실제 동시 처리 수」에서 고칩니다.";
  if (issue === "model_capacity_device_invalid:route_quotas_exceed_limit")
    return "운영 한도를 칸 배분의 보장 합계·상한보다 작게 줄일 수 없습니다 — 칸 배분에서 몫을 먼저 줄여 주세요.";
  if (issue.startsWith("model_capacity_model_limit")) return modelLimitIssueMessage(issue, limits);
  return capacityDeviceIssueMessage(issue);
}
export { modelLimitWarningMessage as deviceRowWarningMessage };
