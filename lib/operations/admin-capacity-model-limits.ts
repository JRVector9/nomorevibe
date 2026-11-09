import { db, onPrimary } from "@/lib/db";
import { MODEL_CAPACITY_MODEL_NAME_MAX, type ModelCapacityModelLimit } from "@/lib/llm/capacity-devices";
import { saveModelCapacityModelLimits } from "@/lib/llm/capacity-devices-repository";
import { logger } from "@/lib/observability/logger";
import { capacityDeviceIssueMessage } from "./admin-capacity-devices";
import { DrWriterFencedError } from "./dr/epoch";

/**
 * 장비 안 모델 상한(0170, 운영자 결정 2026-11-09)의 폼 읽기·저장·거절 문장. 서버에서만 import 한다(DB 를 쓴다).
 * 장비 한 대를 서로 다른 서버·모델이 함께 쓸 때(m3-mlx: deepseek 엔진 최대 1 · gpt-oss 엔진 최대 4, 공유 칸 2) 공유 칸과 따로 모델마다 최대 칸을 둔다.
 * 저장은 saveModelCapacityModelLimits 한 번이다(그 안에서 fence → control FOR UPDATE → 장비 행 FOR UPDATE·CAS → 줄 교체 → operations_audit 한 줄).
 * 여기서는 감사 줄을 또 쓰지 않는다.
 */

export type ModelLimitsFormInput = { deviceId: string; expectedVersion: number; limits: ModelCapacityModelLimit[] };
export type ModelLimitsFormParse = { input: ModelLimitsFormInput | null; issues: string[] };
type FormLike = { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] };
const text = (value: FormDataEntryValue | null | undefined) => typeof value === "string" ? value.trim() : "";

/**
 * 폼 칸 이름: deviceId · expectedVersion(장비 행 판, CAS) · model(줄마다 반복; 장부 model 문자열) + max:<model>(빈 값 = 그 모델의 상한을 지운다)
 * + engine:<model>(엔진 실제 최대, 빈 값 = 모름).
 * 범위·중복 검사의 기준은 저장 때의 zod 다 — 여기서는 숫자 모양만 본다.
 */
export function modelLimitsInputFromForm(form: FormLike): ModelLimitsFormParse {
  const issues: string[] = [];
  const deviceId = text(form.get("deviceId"));
  if (!deviceId) issues.push("장비 이름을 읽지 못했습니다. 새로고침해주세요.");
  const versionText = text(form.get("expectedVersion"));
  const expectedVersion = /^\d{1,15}$/.test(versionText) ? Number(versionText) : NaN;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) issues.push("판 번호(version)를 읽지 못했습니다. 새로고침해주세요.");
  const limits: ModelCapacityModelLimit[] = [];
  const seen = new Set<string>();
  for (const raw of form.getAll("model")) {
    const model = text(raw);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const max = text(form.get(`max:${model}`)).replace(/,/g, "");
    if (max === "") continue;
    if (!/^\d{1,3}$/.test(max)) { issues.push(`${model}: 최대 칸은 0~256 의 정수이거나 비워 둡니다.`); continue; }
    const engine = text(form.get(`engine:${model}`)).replace(/,/g, "");
    if (engine !== "" && !/^\d{1,3}$/.test(engine)) { issues.push(`${model}: 엔진 최대는 1~256 의 정수이거나 비워 둡니다(모름).`); continue; }
    limits.push({ model, maxSlots: Number(max), engineMax: engine === "" ? null : Number(engine) });
  }
  return issues.length ? { input: null, issues } : { input: { deviceId, expectedVersion, limits }, issues };
}

export type SaveModelLimitsResult = { ok: true; deviceId: string; version: number; changes: string[]; warnings: string[] } | { ok: false; issues: string[] };
/** 저장소가 행도 감사도 건드리지 않고 던진 거절 — 운영자 문장으로 돌려준다. 그 밖(DB 오류)은 던진다 */
const REFUSAL_PREFIXES = ["model_capacity_model_limit_invalid:", "model_capacity_model_limit_version_mismatch:"];
const REFUSAL_CODES = ["model_capacity_model_limit_device_unconfigured", "model_capacity_device_version_exhausted", "model_capacity_control_missing",
  "model_capacity_replay_unsupported"];
const isRefusal = (code: string) => REFUSAL_PREFIXES.some(prefix => code.startsWith(prefix)) || REFUSAL_CODES.includes(code);

const limitText = (limit: Pick<ModelCapacityModelLimit, "maxSlots" | "engineMax"> | undefined) =>
  limit ? `최대 ${limit.maxSlots}칸${limit.engineMax === null || limit.engineMax === undefined ? "" : ` (엔진 ${limit.engineMax})`}` : "상한 없음";
/** 저장 전·후의 바뀐 줄(「gpt-oss-120b: 상한 없음 → 최대 2칸 (엔진 4)」), model 순 */
export function modelLimitChangeLines(before: readonly ModelCapacityModelLimit[], after: readonly ModelCapacityModelLimit[]): string[] {
  const models = [...new Set([...before, ...after].map(limit => limit.model))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return models.flatMap(model => {
    const was = limitText(before.find(limit => limit.model === model)), now = limitText(after.find(limit => limit.model === model));
    return was === now ? [] : [`${model}: ${was} → ${now}`];
  });
}

/**
 * 장비 한 대의 모델 상한 저장 — 쓰기 TX 하나에서 saveModelCapacityModelLimits(tx, input, actor). 거절 코드는 그대로 돌려준다(문장은 modelLimitIssueMessage).
 * 저장 즉시 다음 입장 판정부터 쓰인다 — 잡힌 칸은 그대로 끝나고 DRAIN 은 없다.
 */
export async function saveAdminModelLimits(input: ModelLimitsFormInput, actor: string): Promise<SaveModelLimitsResult> {
  if (!actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  try {
    const { before, after, warnings } = await onPrimary(() => db.transaction(tx => saveModelCapacityModelLimits(tx, input, actor)));
    const changes = modelLimitChangeLines(before, after.modelLimits ?? []);
    logger.info("model_capacity_model_limit.saved", { actor, deviceId: after.deviceId, version: after.version, lines: after.modelLimits?.length ?? 0, warnings });
    return { ok: true, deviceId: after.deviceId, version: after.version, changes, warnings: [...warnings] };
  } catch (error) {
    if (error instanceof DrWriterFencedError) return { ok: false, issues: [error.reason] };
    const code = error instanceof Error ? error.message : String(error);
    if (!isRefusal(code)) throw error;
    return { ok: false, issues: [code] };
  }
}

// ---------- 거절·경고 코드 → 한국어 ----------
const INVALID_MESSAGES: Record<string, string> = {
  "limits:duplicate_model": "같은 모델이 두 번 있습니다. 새로고침해주세요.",
  limits: "모델 상한은 장비 하나에 64줄까지입니다.",
  deviceId: "장비 이름을 읽지 못했습니다. 새로고침해주세요.",
  expectedVersion: "판 번호(version)를 읽지 못했습니다. 새로고침해주세요.",
  actor: "저장한 사람을 확인하지 못했습니다. 다시 로그인해주세요.",
  root: "모델 상한 입력 모양이 틀립니다(알 수 없는 칸이 있거나 칸이 빠졌습니다). 새로고침해주세요.",
};
/**
 * saveModelCapacityModelLimits·saveAdminModelLimits 의 코드 → 운영자 문장. `limits` 는 보낸 줄(보낸 순서 그대로 — zod 의 limits.<i> 가 그 순서다) — 거절 경로의 limits.<i> 를 모델 이름으로 바꾼다.
 * 모르는 코드는 장비 한도 화면의 문장(capacityDeviceIssueMessage: DR·재생 DB·제어 행·판 상한)으로, 그것도 모르면 그대로 보인다.
 */
export function modelLimitIssueMessage(issue: string, limits: readonly Pick<ModelCapacityModelLimit, "model">[] = []): string {
  if (issue === "model_capacity_model_limit_device_unconfigured")
    return "이 장비는 장비 행이 없거나 꺼져 있어 모델 상한을 둘 수 없습니다 — 장비 한도에서 장비 행을 먼저 저장하거나 켜 주세요.";
  if (issue === "invalid_actor") return INVALID_MESSAGES.actor;
  const mismatch = /^model_capacity_model_limit_version_mismatch:(.+)$/.exec(issue);
  if (mismatch) return `다른 곳(장비 한도·칸 배분)에서 이 장비를 먼저 저장했습니다(지금 판 ${mismatch[1]}). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요.`;
  const prefix = "model_capacity_model_limit_invalid:";
  if (!issue.startsWith(prefix)) return capacityDeviceIssueMessage(issue);
  const detail = issue.slice(prefix.length);
  if (INVALID_MESSAGES[detail]) return INVALID_MESSAGES[detail];
  const line = /^limits\.(\d+)\.(model|maxSlots|engineMax)(?::([a-z_]+))?$/.exec(detail);
  if (line) {
    const limit = limits[Number(line[1])];
    const name = limit ? limit.model : `${Number(line[1]) + 1}번째 줄`;
    if (line[3] === "exceeds_engine") return `${name}: 최대 칸이 엔진 최대보다 많습니다 — 엔진 최대 이하로 적거나, 엔진 최대를 고쳐 주세요.`;
    if (line[2] === "engineMax") return `${name}: 엔진 최대는 1~256 의 정수이거나 비워 둡니다(모름).`;
    if (line[2] === "model") return `${name}: 모델 이름이 1~${MODEL_CAPACITY_MODEL_NAME_MAX}자가 아니거나 앞뒤 공백·제어 문자가 있습니다. 새로고침해주세요.`;
    return `${name}: 최대 칸은 0~256 의 정수입니다(0 = 이 장비에서 이 모델을 뺌).`;
  }
  return `모델 상한이 검사를 통과하지 못했습니다: ${detail}`;
}

/** 저장은 했지만 알릴 것(saveModelCapacityModelLimits warnings) */
export function modelLimitWarningMessage(warning: string): string {
  if (warning === "policy_unreadable") return "용량 정책을 읽지 못해 이 모델들이 이 장비로 오는지 확인하지 못했습니다 — 상한은 저장했습니다.";
  const above = /^max_exceeds_limit:(.+)$/.exec(warning);
  if (above) return `${above[1]}: 최대 칸이 장비 공유 칸 수보다 큽니다 — 상한은 저장했지만 공유 칸 수가 먼저 막습니다.`;
  const unmapped = /^model_unmapped:(.+)$/.exec(warning);
  if (unmapped) return `${unmapped[1]}: 지금 정책에서 이 모델이 이 장비로 오지 않습니다 — 상한은 저장했고, 이 장비로 오면 그때부터 적용됩니다.`;
  return warning;
}
