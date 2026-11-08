"use client";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_MODEL_STAGES, adminStageAcceptsModel, type AdminModelStage, type AdminStagePools } from "@/lib/llm/admin-model-stages";
import { type ModelDefinition } from "@/lib/llm/model-registry";
import { saveAdminStageModels } from "./stage-model-actions";
import { ModelSaveNotice } from "./ReviewModelsForm";
import type { ModelSaveState } from "./actions";
import { ModelChips, ModelSaveBar } from "./ModelChips";

export function StagePoolFields({ draft, models, defaults, update, stageIds }: {
  draft: AdminStagePools; models: readonly ModelDefinition[]; defaults: Record<string, string>;
  update: (id: keyof AdminStagePools, keys: string[]) => void;
  stageIds?: readonly AdminModelStage[];
}) {
  return <div className="grid min-w-0 gap-3">
    <p className="text-[13px] text-fg-2">선택지 앞의 대괄호는 등록부 장비 표지입니다. 호출은 「서빙 계약·등록부」의 직접 연결 계약이 엽니다.</p>
    <div className="grid min-w-0 gap-3 md:grid-cols-2">{ADMIN_MODEL_STAGES.filter(stage => !stageIds || stageIds.includes(stage.id)).map(stage => {
    const keys = draft[stage.id] ?? [];
    const choices = models.filter(model => adminStageAcceptsModel(stage, model));
    return <div key={stage.id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3">
      <h3 className="text-[14px] font-semibold">{stage.label}</h3>
      <ModelChips displayName={row => { const model = models.find(model => model.key === row.model); return model ? model.cliEngine ? `${model.displayName} · CLI` : `[${model.gatewayLabel ?? model.equipment}] ${model.model}` : "등록부에서 사라진 모델"; }} label={stage.label} max={8} rows={keys.map(key => ({ provider: stage.provider, model: key }))}
        choices={choices.map(model => ({ provider: stage.provider, model: model.key, label: model.cliEngine ? `${model.displayName} · CLI` : `[${model.gatewayLabel ?? model.equipment}] ${model.model}` }))}
        onChange={rows => update(stage.id, rows.map(row => row.model))} />
      {!keys.length ? <span className="w-fit max-w-full break-words rounded-full border border-line bg-bg-soft px-3 py-2 text-[13px]">기본 · {defaults[stage.id] ?? "미확인"}</span>
        : <p className="text-[13px] text-fg-2">모두 빼면 등록부 기본값({defaults[stage.id] ?? "미확인"})으로 돌아갑니다.</p>}
      {!choices.length && <p className="text-[13px] text-fg-2">용도·실행 계약 등록 후 모델을 추가할 수 있습니다.</p>}
    </div>;
  })}</div></div>;
}
export const changedStagePools = (before: AdminStagePools, after: AdminStagePools) => ADMIN_MODEL_STAGES.filter(stage =>
  JSON.stringify(before[stage.id] ?? []) !== JSON.stringify(after[stage.id] ?? [])).map(stage => stage.label);
/** Kept for existing callers; the models page uses one combined CAS form. */
export function StageModelPoolsForm({ pools, models, defaults, version, saveAction = saveAdminStageModels, stageIds, readOnly = false }: {
  pools: AdminStagePools; models: readonly ModelDefinition[]; defaults: Record<string, string>; version: string;
  saveAction?: typeof saveAdminStageModels; probeAction?: unknown;
  stageIds?: readonly AdminModelStage[]; readOnly?: boolean;
}) {
  const router = useRouter(), [draft, setDraft] = useState(pools), [baseline, setBaseline] = useState(pools), [formVersion, setVersion] = useState(version);
  const [state, action, pending] = useActionState<ModelSaveState, FormData>(async (previous, form) => {
    try { const result = await saveAction(previous, form); if (result?.ok && result.version) { setVersion(result.version); setBaseline(draft); router.refresh(); } return result; }
    catch { return { issues: ["저장 결과를 확인하지 못했습니다. 새로고침해 현재 설정을 확인해주세요."] }; }
  }, null);
  return <form action={action} className="flex flex-col gap-4">
    <input type="hidden" name="settingsVersion" value={formVersion} /><input type="hidden" name="stageModelPools" value={JSON.stringify(draft)} />
    <h2 className="text-[18px] font-semibold">{stageIds ? "사람 확인을 돕는 AI 모델" : "단계별 모델 풀"}</h2>
    <fieldset disabled={pending || readOnly}><StagePoolFields draft={draft} models={models} defaults={defaults} stageIds={stageIds} update={(id, keys) => setDraft(current => ({ ...current, [id]: keys }))} /></fieldset>
    <ModelSaveNotice state={state} />{!readOnly && <ModelSaveBar changes={changedStagePools(baseline, draft)} pending={pending} label="단계별 모델 저장" />}
  </form>;
}
