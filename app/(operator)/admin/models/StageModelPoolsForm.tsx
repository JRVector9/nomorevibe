"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_MODEL_STAGES, type AdminStagePools } from "@/lib/llm/admin-model-stages";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import { saveAdminStageModels } from "./stage-model-actions";
import { ModelSaveNotice } from "./ReviewModelsForm";
import type { ModelSaveState } from "./actions";
import { buttonDashed, buttonQuiet, hintClass, SettingsCard } from "../settings/Switch";
import { probeAdminModel, type ModelProbeResult } from "./operation-actions";

export function StageModelPoolsForm({ pools, models, defaults, version, saveAction = saveAdminStageModels, probeAction = probeAdminModel }: {
  pools: AdminStagePools; models: readonly ModelDefinition[]; defaults: Record<string, string>; version: string;
  saveAction?: typeof saveAdminStageModels;
  probeAction?: typeof probeAdminModel;
}) {
  const router = useRouter(), [draft, setDraft] = useState(pools), [formVersion, setVersion] = useState(version);
  const [checking, startCheck] = useTransition(), [checks, setChecks] = useState<Record<string, ModelProbeResult>>({});
  const [state, action, pending] = useActionState<ModelSaveState, FormData>(async (previous, form) => {
    try {
      const result = await saveAction(previous, form);
      if (result?.ok && result.version) { setVersion(result.version); router.refresh(); }
      return result;
    } catch { return { issues: ["저장 결과를 확인하지 못했습니다. 새로고침해 현재 설정을 확인해주세요."] }; }
  }, null);
  const update = (id: keyof AdminStagePools, keys: string[]) => setDraft(current => ({ ...current, [id]: keys }));
  return <form action={action}>
    <input type="hidden" name="settingsVersion" value={formVersion} />
    <input type="hidden" name="stageModelPools" value={JSON.stringify(draft)} />
    <SettingsCard title="단계별 모델 풀" note="등록부의 장비 식별자로 선택합니다. 각 새 작업 묶음은 저장된 풀에서 한 모델을 배정받습니다. 이미 전송한 요청·미확인 요청과 기존 업무 기록은 원래 계약에 남습니다.">
      <p className={hintClass}>모두 빼면 그 단계의 배포 기본 모델을 사용합니다. 단계 켜짐·발행 보호·물리 슬롯 상한은 별도입니다. 선택한 모델에 정식 실행 계약이 없으면 워커가 호출을 보류하며 계약이나 상한을 자동 변경하지 않습니다.</p>
      <fieldset disabled={pending || checking} className="grid min-w-0 gap-4 md:grid-cols-2">
        {ADMIN_MODEL_STAGES.map(stage => {
          const keys = draft[stage.id] ?? [];
          const choices = models.filter(model => model.provider === stage.provider && (!(stage.id.startsWith("assist-") || stage.id === "screen-review") || model.purposes.includes(stage.purpose)));
          return <div key={stage.id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3">
            <h3 className="text-[14px] font-semibold">{stage.label}</h3>
            <p className={`${hintClass} break-all`}>기본: {defaults[stage.id] ?? "미확인"}</p>
            {!choices.length && <p className={hintClass}>등록부에 이 용도의 검증 대상 모델이 없습니다. 장비·기능 계약 등록 후 선택할 수 있습니다.</p>}
            {keys.map((key, index) => <div key={`${stage.id}:${index}`} className="flex min-w-0 flex-col gap-2"><div className="flex min-w-0 items-center gap-2">
              <select aria-label={`${stage.label} ${index + 1}번째 모델`} value={key}
                className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-bg-card px-2 text-[13px]"
                onChange={event => update(stage.id, keys.map((value, at) => at === index ? event.target.value : value))}>
                {!choices.some(model => model.key === key) && <option value={key}>등록부에서 사라진 모델 · {key}</option>}
                {choices.map(model => <option key={model.key} value={model.key} disabled={keys.includes(model.key) && model.key !== key}>{model.displayName} · {model.key}</option>)}
              </select>
              <button type="button" className={buttonQuiet} aria-label={`${stage.label} ${index + 1}번째 모델 빼기`} onClick={() => update(stage.id, keys.filter((_, at) => at !== index))}>빼기</button>
            </div><div className="flex flex-wrap items-center gap-2">
              <button type="button" className={buttonQuiet} disabled={!choices.find(model => model.key === key)?.baseUrl} onClick={() => startCheck(async () => {
                try { const result = await probeAction({ routeId: stage.id, provider: stage.provider, model: key }); setChecks(current => ({ ...current, [`${stage.id}:${key}`]: result })); }
                catch { setChecks(current => ({ ...current, [`${stage.id}:${key}`]: { error: "연결 확인 결과를 읽지 못했습니다." } })); }
              })}>연결 확인</button>
              {checks[`${stage.id}:${key}`] && <p role="status" className={hintClass}>
                {checks[`${stage.id}:${key}`].listed === true ? "목록 확인" : checks[`${stage.id}:${key}`].listed === false ? "목록에 없음" : "목록 미확인"} · {checks[`${stage.id}:${key}`].listMs ?? "—"}ms<br />
                {checks[`${stage.id}:${key}`].error}<br />{checks[`${stage.id}:${key}`].callBlocked}
              </p>}
            </div>
            </div>)}
            {keys.length < 8 && choices.some(model => !keys.includes(model.key)) && <button type="button" className={buttonDashed}
              onClick={() => update(stage.id, [...keys, choices.find(model => !keys.includes(model.key))!.key])}>+ {stage.label} 모델 추가</button>}
          </div>;
        })}
      </fieldset>
      <ModelSaveNotice state={pending ? null : state} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" disabled={pending} className="inline-flex min-h-10 items-center justify-center rounded-[9px] bg-accent-solid px-5 text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-50">{pending ? "저장 중…" : "단계별 모델 저장"}</button>
        <p className={hintClass}>저장 후 다음 작업 묶음부터 적용됩니다.</p>
      </div>
    </SettingsCard>
  </form>;
}
