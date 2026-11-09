"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { aiTask, aiTaskSlotLabel } from "@/lib/llm/ai-tasks";
import { aiTaskIssueMessage } from "@/lib/operations/admin-ai-tasks";
import { aiTaskSlotRevision, listAiTaskRows, saveAiTaskRanks } from "@/lib/operations/admin-ai-tasks-repository";
import { cliStageModelEditFromForm, cliStageSettingsPatch, cliTaskModelEdit, cliTaskModelEditFromForm, introStageSource } from "@/lib/operations/cli-task-usage";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type CliTaskSaveState = { ok?: true; message?: string; issues?: string[]; warnings?: string[] } | null;

// 작업 배정 저장(saveAiTaskRanksAction)과 같은 화면들을 새로 읽는다 — 같은 순위 행을 보인다
const PATHS = ["/admin/models/devices", "/admin/models/tasks", "/admin/models", "/admin/models/llm", "/admin/models/contracts", "/admin/flow"];

/**
 * 장비 한도 화면의 CLI 작업 줄 저장 — 한 순위의 모델·추론 강도만 바꾼다. 새 쓰기 경로가 아니다: 지금 저장된 같은 칸의 순위를 읽어 그 순위만 바꾼 입력으로
 * 작업 배정과 같은 saveAiTaskRanks 를 부른다(검증·준비 확인·CLI 계약·판 compare-and-set·감사 ai-task-models-save 가 같다).
 * 화면이 본 판과 지금 판이 다르면(그사이 누가 바꿈) 저장하지 않는다.
 */
export const saveCliTaskModelAction = webWriteAction(async function saveCliTaskModelAction(_previous: CliTaskSaveState, form: FormData): Promise<CliTaskSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: [aiTaskIssueMessage("denied")] };
  const request = cliTaskModelEditFromForm(form);
  if (!request) return { issues: ["저장할 값의 모양이 맞지 않습니다 — 새로 고친 뒤 다시 저장하세요."] };
  let rows;
  try { rows = await listAiTaskRows(); }
  catch { return { issues: ["작업 순위를 읽지 못했습니다 — 잠시 뒤 다시 저장하세요."] }; }
  const edit = cliTaskModelEdit(rows, request, aiTaskSlotRevision);
  if (!edit.ok) return { issues: [aiTaskIssueMessage(edit.issue)] };
  if (!edit.changed) return { ok: true, message: "바뀐 것이 없습니다." };
  const saved = await saveAiTaskRanks(edit.input, admin.login);
  if (!saved.ok) return { issues: saved.issues.map(aiTaskIssueMessage) };
  for (const path of PATHS) revalidatePath(path);
  const task = aiTask(request.task)!;
  const effort = request.reasoningEffort || "기본";
  return { ok: true, warnings: saved.warnings,
    message: `${aiTaskSlotLabel(task, request.slot)} ${request.rank}순위: ${request.model} · 추론 강도 ${effort}로 저장했습니다. 워커는 30초 주기로 다시 읽어 새 작업부터 씁니다.` };
});

const STAGE_PATHS = ["/admin/models/devices", "/admin/models", "/admin/models/advanced", "/admin/models/tasks", "/admin/models/llm", "/admin", "/admin/status", "/admin/flow"];
const STAGE_STALE = "그사이 소개 검수 모델 설정이나 그 출처가 바뀌었습니다 — 새로 고친 뒤 다시 저장하세요.";

/**
 * 소개 검수(Claude CLI) 모델·추론 강도 저장 — 실행 쪽이 읽는 그 자리(settings.stageModelPools["product-intro-check"]·stageModelEfforts)에 쓴다.
 * 단계 풀 저장(saveAdminStageModels)과 같은 검사를 그 단계에만 한다: 등록부 모델·단계 adapter 일치(validateAdminStagePools)·CLI 카탈로그·자원 확인 →
 * saveSettings(설정 판 compare-and-set, 감사 settings-save 에 바뀐 칸). 화면이 본 출처(단계 풀 한 모델 또는 등록부 기본값)와 지금 고른 key 가 같을 때만 쓴다 —
 * 배정 표가 출처가 되었거나 풀이 바뀌었으면 거절한다. 다음 소개 검수 틱(잡 lease)부터 쓰인다.
 */
export const saveCliStageModelAction = webWriteAction(async function saveCliStageModelAction(_previous: CliTaskSaveState, form: FormData): Promise<CliTaskSaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: [aiTaskIssueMessage("denied")] };
  const request = cliStageModelEditFromForm(form);
  if (!request) return { issues: ["저장할 값의 모양이 맞지 않습니다 — 새로 고친 뒤 다시 저장하세요."] };
  const [{ getSettings, saveSettings, settingsFormVersion, settingsUnreadable }, { onPrimary }, { ADMIN_MODEL_STAGES, adminStageAcceptsModel },
    { configuredModelDefinition, modelRequestName, readModelRegistry }, { ensureCliStageCatalogs, validateAdminStagePools },
    { ensureCliStageModelResources }, { buildAiCurrentSlots, readAiCurrentSources }, { readCapacityDevicesControl }] = await Promise.all([
    import("@/lib/crawl/settings"), import("@/lib/db"), import("@/lib/llm/admin-model-stages"), import("@/lib/llm/model-registry"),
    import("@/lib/llm/admin-model-pools"), import("@/lib/operations/admin-ai-tasks-repository"), import("@/lib/operations/admin-ai-task-current"),
    import("@/lib/operations/admin-capacity-devices")]);
  const current = await onPrimary(getSettings).catch(() => null);
  if (!current || settingsUnreadable(current)) return { issues: ["지금 단계별 모델 설정을 읽지 못했습니다 — 새로 고친 뒤 다시 시도하세요."] };
  if (settingsFormVersion(current) !== request.settingsVersion) return { issues: [STAGE_STALE] };
  const stage = ADMIN_MODEL_STAGES.find(row => row.id === request.stage)!;
  let choices: { key: string; model: string }[], policy;
  try {
    choices = readModelRegistry().models.filter(model => model.provider === "claude-cli" && adminStageAcceptsModel(stage, model))
      .map(model => ({ key: model.key, model: modelRequestName(model) }));
    policy = await readCapacityDevicesControl().then(control => control.policy).catch(() => null);
    // 화면이 본 출처가 아직 그대로인가 — 같은 계산(introStageSource)을 지금 값으로 다시 한다
    const sources = await readAiCurrentSources(policy, { includeAgent: false });
    let defaultKey: string | null = null;
    try { defaultKey = configuredModelDefinition("product-intro-check").key; } catch { defaultKey = null; }
    const source = introStageSource({ settings: current, settingsUnknown: sources.settingsUnknown, settingsVersion: request.settingsVersion,
      slot: buildAiCurrentSlots(sources).find(slot => slot.task === "product-intro-check") ?? null, defaultKey, choices });
    if (!source || source.currentKey !== request.currentKey) return { issues: [STAGE_STALE] };
  } catch { return { issues: ["소개 검수의 지금 출처를 확인하지 못했습니다 — 잠시 뒤 다시 저장하세요."] }; }
  const planned = cliStageSettingsPatch(current, request, choices);
  if (!planned.ok) return { issues: [planned.issue] };
  if (!planned.changed) return { ok: true, message: "바뀐 것이 없습니다." };
  if (planned.patch.stageModelPools) {
    const changed = { [request.stage]: planned.patch.stageModelPools[request.stage] };
    try {
      await ensureCliStageCatalogs(changed);
      validateAdminStagePools(changed);
    } catch { return { issues: ["등록되지 않은 모델·지원하지 않는 제공자 조합입니다. 모델 등록부를 확인해주세요."] }; }
    const resources = await ensureCliStageModelResources(changed, admin.login);
    if (!resources.ok) return { issues: resources.issues };
  }
  const result = await saveSettings(planned.patch, admin.login, { expectedFormVersion: request.settingsVersion });
  if (!result.ok) return { issues: result.issues };
  for (const path of STAGE_PATHS) revalidatePath(path);
  const model = choices.find(choice => choice.key === request.key)!.model;
  const warnings = planned.poolChanged && policy && !policy.routes.some(route => route.routeId === "product-intro-check" && route.provider === "claude-cli" && route.model === model)
    ? [`용량 정책에 소개 검수 × Claude CLI × ${model} 경로가 없습니다 — 경로를 더하기 전까지 소개 검수 호출이 미뤄질 수 있습니다.`] : [];
  return { ok: true, warnings,
    message: `소개 검수: ${model} · 추론 강도 ${request.reasoningEffort || "기본(high)"}로 저장했습니다. 다음 소개 검수 틱부터 씁니다.` };
});
