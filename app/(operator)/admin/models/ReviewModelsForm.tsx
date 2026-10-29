"use client";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { AdminStagePools } from "@/lib/llm/admin-model-stages";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import type { ModelOption } from "../settings/ModelRows";
import { saveReviewModels, type ModelSaveState } from "./actions";
import { ModelChips, ModelSaveBar, type SelectedModel } from "./ModelChips";
import { changedStagePools, StagePoolFields } from "./StageModelPoolsForm";

type ReviewDraft = Record<"primary" | "firstAdditional" | "voter" | "fallback", SelectedModel[]>;
const initialReview = (settings: CrawlSettings): ReviewDraft => ({ primary: settings.firstReview ? [settings.firstReview] : [],
  firstAdditional: settings.firstReviewAdditional ?? [], voter: settings.secondReview.voters, fallback: settings.secondReview.fallbacks ?? [] });
const labels = { primary: "1차 검수", firstAdditional: "추가 1차 모델 · 후보를 나눠 처리", voter: "2차 검수", fallback: "2차 대체 모델" };
export function ReviewModelsForm({ settings, version, firstChoices, secondChoices, models, defaults = {}, saveAction = saveReviewModels }: {
  settings: CrawlSettings; version: string; firstChoices: ModelOption[]; secondChoices: ModelOption[];
  models?: readonly ModelDefinition[]; defaults?: Record<string, string>; saveAction?: typeof saveReviewModels;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(() => initialReview(settings)), [baseline, setBaseline] = useState(() => initialReview(settings));
  const [pools, setPools] = useState<AdminStagePools>(settings.stageModelPools ?? {}), [poolBaseline, setPoolBaseline] = useState<AdminStagePools>(settings.stageModelPools ?? {});
  const [formVersion, setVersion] = useState(version);
  const [state, action, pending] = useActionState<ModelSaveState, FormData>(async (previous, form) => {
    try { const result = await saveAction(previous, form);
      if (result?.ok && result.version) { setVersion(result.version); setBaseline(draft); setPoolBaseline(pools); router.refresh(); }
      return result;
    } catch { return { issues: ["저장 결과를 확인하지 못했습니다. 새로고침해 현재 설정을 확인해주세요."] }; }
  }, null);
  const changes = [...(Object.keys(labels) as (keyof ReviewDraft)[]).filter(key => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])).map(key => labels[key]), ...changedStagePools(poolBaseline, pools)];
  return <form action={action} id="model-settings" className="flex scroll-mt-28 md:scroll-mt-6 flex-col gap-4 pb-28" data-models-dirty={changes.length > 0}>
    <input type="hidden" name="settingsVersion" value={formVersion} />
    {models && <input type="hidden" name="stageModelPools" value={JSON.stringify(pools)} />}
    <div><h2 className="text-[20px] font-bold">설정 바꾸기</h2><p className="mt-2 text-[13px] leading-relaxed text-fg-2">현재 선택한 모델입니다. 모델을 추가·제거한 뒤 저장해야 적용됩니다. 이후 작업 묶음부터 반영하며, 진행 중·미확인 요청과 기존 업무 기록은 원래 계약에 남습니다.</p></div>
    <fieldset disabled={pending} className="grid min-w-0 gap-3 md:grid-cols-2">{(Object.keys(labels) as (keyof ReviewDraft)[]).map(prefix =>
      <div key={prefix} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-4"><h3 className="text-[14px] font-semibold">{labels[prefix]}</h3>
        <ModelChips prefix={prefix} label={labels[prefix]} rows={draft[prefix]} choices={prefix === "primary" || prefix === "firstAdditional" ? firstChoices : secondChoices}
          max={prefix === "primary" ? 1 : prefix === "voter" ? 3 : 2} onChange={rows => setDraft(current => ({ ...current, [prefix]: rows }))} />
        {prefix === "voter" && <p className="text-[12px] text-fg-2">동일 모델은 독립 교차 검수 표로 보지 않습니다. 독립 표가 없으면 사람 확인이 남습니다.</p>}
      </div>)}</fieldset>
    {models && <fieldset disabled={pending}><StagePoolFields draft={pools} models={models} defaults={defaults} update={(id, keys) => setPools(current => ({ ...current, [id]: keys }))} /></fieldset>}
    <p className="text-[12px] leading-relaxed text-fg-2">풀을 비우면 배포 기본 모델을 사용합니다. 단계 켜짐·발행 보호·물리 슬롯 상한은 별도입니다. 선택은 실행 권한을 부여하지 않으며, 실제 호출은 워커의 연결·실행 계약·용량 검증을 통과해야 합니다.</p>
    <ModelSaveNotice state={pending ? null : state} /><ModelSaveBar pending={pending} changes={changes} label={models ? "모델 설정 저장" : "검수 모델 저장"} />
  </form>;
}
export function ModelSaveNotice({ state }: { state: ModelSaveState }) {
  if (state?.issues) return <div role="alert" className="rounded-lg border border-down/30 bg-down/5 p-3 text-[13px] text-down">
    <p className="font-semibold">{state.issues.some(issue => issue.includes("다른 곳에서 설정이 바뀌었습니다")) ? "저장 거절 · 다른 곳에서 설정을 수정했습니다" : "저장하지 못했습니다"}</p>
    <ul>{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
  </div>;
  return state?.ok ? <p role="status" className="rounded-lg border border-up/30 bg-up/5 p-3 text-[13px] text-up">모델 설정을 저장했습니다.</p> : null;
}
