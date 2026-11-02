"use client";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import type { AdminStagePools } from "@/lib/llm/admin-model-stages";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import { AssignmentMovedNotice } from "../settings/AssignmentMovedNotice";
import type { ModelOption } from "../settings/ModelRows";
import { saveReviewModels, type ModelSaveState } from "./actions";
import { ModelChips, ModelSaveBar, type SelectedModel } from "./ModelChips";
import { changedStagePools, StagePoolFields } from "./StageModelPoolsForm";
import { RankSelects } from "./RankSelects";
import { FIRST_REVIEW_RANK_STAGE, rankOptionKey, type RankOption } from "@/lib/operations/admin-first-review-ranks";

type ReviewDraft = Record<"primary" | "firstAdditional" | "voter" | "fallback", SelectedModel[]>;
const initialReview = (settings: CrawlSettings): ReviewDraft => ({ primary: settings.firstReview ? [settings.firstReview] : [],
  firstAdditional: settings.firstReviewAdditional ?? [], voter: settings.secondReview.voters, fallback: settings.secondReview.fallbacks ?? [] });
const labels = { primary: "1차 AI 검수 1순위", firstAdditional: "1차 AI 검수 2·3순위", voter: "2차 검수", fallback: "2차 대체 모델" };
/** 1차 AI 검수 순위 칸의 폼 이름 — 서버 저장(saveReviewModels)이 읽는 예전 이름 그대로다 */
const FIRST_RANK_SLOTS = [{ provider: "primaryProvider0", model: "primaryModel0" },
  { provider: "firstAdditionalProvider0", model: "firstAdditionalModel0" }, { provider: "firstAdditionalProvider1", model: "firstAdditionalModel1" }];
const chipSections = ["voter", "fallback"] as const;
export function ReviewModelsForm({ settings, version, firstChoices, secondChoices, models, defaults = {}, saveAction = saveReviewModels, locked = false, firstRankOptions }: {
  settings: CrawlSettings; version: string; firstChoices: ModelOption[]; secondChoices: ModelOption[];
  /** 1차 AI 검수 순위 선택지(「장비 · 모델」, page 가 엔진 API 응답으로 만든다). 없으면 firstChoices 로 만든다 */
  firstRankOptions?: readonly RankOption[];
  models?: readonly ModelDefinition[]; defaults?: Record<string, string>; saveAction?: typeof saveReviewModels;
  /** 배정 표 플래그가 켜졌으면(PR 3b-D) 이 폼의 칸(1차·추가 1차·2차·2차 대체·단계별 모델 풀)은 모두 배정 표로 옮겨졌다 — 읽기 전용, 저장 바 없음 */
  locked?: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(() => initialReview(settings)), [baseline, setBaseline] = useState(() => initialReview(settings));
  const [pools, setPools] = useState<AdminStagePools>(settings.stageModelPools ?? {}), [poolBaseline, setPoolBaseline] = useState<AdminStagePools>(settings.stageModelPools ?? {});
  const [formVersion, setVersion] = useState(version);
  const [rankSlots, setRankSlots] = useState<(SelectedModel | null)[]>(() => [settings.firstReview ?? null,
    settings.firstReviewAdditional?.[0] ?? null, settings.firstReviewAdditional?.[1] ?? null]);
  const [state, action, pending] = useActionState<ModelSaveState, FormData>(async (previous, form) => {
    try { const result = await saveAction(previous, form);
      if (result?.ok && result.version) { setVersion(result.version); setBaseline(draft); setPoolBaseline(pools); router.refresh(); }
      return result;
    } catch { return { issues: ["저장 결과를 확인하지 못했습니다. 새로고침해 현재 설정을 확인해주세요."] }; }
  }, null);
  const rankChoices = firstRankOptions ?? firstChoices.map(choice => ({ provider: choice.provider as RankOption["provider"], model: choice.model,
    server: choice.provider, label: `${choice.provider} · ${choice.label}` }));
  // 지금 저장된 순위가 선택지에 없어도 지우지 않는다
  const savedRanks = [...draft.primary, ...draft.firstAdditional].filter(row => !rankChoices.some(option => rankOptionKey(option) === rankOptionKey(row)))
    .map(row => ({ provider: row.provider as RankOption["provider"], model: row.model, server: "저장된 값", label: `저장된 값 · ${row.model} (지금 목록에 없음)` }));
  // 칸 그대로(빈 칸 포함) 든다 — 2순위를 비우고 3순위만 고르면 당기지 않고 오류로 보인다(서버도 같은 검증으로 거절한다)
  const ranks = rankSlots;
  const changes = [...(Object.keys(labels) as (keyof ReviewDraft)[]).filter(key => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])).map(key => labels[key]), ...changedStagePools(poolBaseline, pools)];
  return <form action={action} id="model-settings" className="flex scroll-mt-28 md:scroll-mt-6 flex-col gap-4" data-models-dirty={changes.length > 0}>
    <input type="hidden" name="settingsVersion" value={formVersion} />
    {models && <input type="hidden" name="stageModelPools" value={JSON.stringify(pools)} />}
    <div><h2 className="text-[20px] font-bold">설정 바꾸기</h2><p className="mt-2 text-[13px] leading-relaxed text-fg-2">현재 선택한 모델입니다. 모델을 추가·제거한 뒤 저장해야 적용됩니다. 이후 작업 묶음부터 반영하며, 진행 중·미확인 요청과 기존 업무 기록은 원래 계약에 남습니다.</p></div>
    {locked && <AssignmentMovedNotice detail="이 폼의 모델 칸(1차·추가 1차·2차·2차 대체·단계별 모델 풀)은 읽기 전용이고 저장하지 않습니다." />}
    <fieldset disabled={pending || locked} data-readonly={locked || undefined} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-4">
      <h3 className="text-[14px] font-semibold">{FIRST_REVIEW_RANK_STAGE.label} <span className="font-normal text-fg-2">· {FIRST_REVIEW_RANK_STAGE.routeId}</span></h3>
      <RankSelects stage={FIRST_REVIEW_RANK_STAGE} options={[...rankChoices, ...savedRanks]} value={ranks} slotNames={FIRST_RANK_SLOTS} disabled={pending || locked}
        onChange={value => { setRankSlots(value);
          setDraft(current => ({ ...current, primary: value[0] ? [value[0]] : [], firstAdditional: value.slice(1).filter((row): row is SelectedModel => !!row) })); }} />
    </fieldset>
    <fieldset disabled={pending || locked} data-readonly={locked || undefined} className="grid min-w-0 gap-3 md:grid-cols-2">{chipSections.map(prefix =>
      <div key={prefix} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-bg-card p-4"><h3 className="text-[14px] font-semibold">{labels[prefix]}</h3>
        <ModelChips prefix={prefix} label={labels[prefix]} rows={draft[prefix]} choices={secondChoices}
          max={prefix === "voter" ? 3 : 2} onChange={rows => setDraft(current => ({ ...current, [prefix]: rows }))} />
        {prefix === "voter" && <p className="text-[13px] text-fg-2">동일 모델은 독립 교차 검수 표로 보지 않습니다. 독립 표가 없으면 사람 확인이 남습니다.</p>}
      </div>)}</fieldset>
    {models && <fieldset disabled={pending || locked}><StagePoolFields draft={pools} models={models} defaults={defaults} update={(id, keys) => setPools(current => ({ ...current, [id]: keys }))} /></fieldset>}
    <p className="text-[13px] leading-relaxed text-fg-2">풀을 비우면 배포 기본 모델을 사용합니다. 단계 켜짐·발행 보호·물리 슬롯 상한은 별도입니다. 선택은 실행 권한을 부여하지 않으며, 실제 호출은 워커의 연결·실행 계약·용량 검증을 통과해야 합니다.</p>
    <ModelSaveNotice state={pending ? null : state} />{!locked && <ModelSaveBar pending={pending} changes={changes} label={models ? "모델 설정 저장" : "검수 모델 저장"} />}
  </form>;
}
export function ModelSaveNotice({ state }: { state: ModelSaveState }) {
  if (state?.issues) return <div role="alert" className="rounded-lg border border-down/30 bg-down/5 p-3 text-[13px] text-down">
    <p className="font-semibold">{state.issues.some(issue => issue.includes("다른 곳에서 설정이 바뀌었습니다")) ? "저장 거절 · 다른 곳에서 설정을 수정했습니다" : "저장하지 못했습니다"}</p>
    <ul>{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
  </div>;
  if (state?.ok && state.warnings?.length) return <div role="status" className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-[13px]">
    <p className="font-semibold">모델 설정을 저장했습니다 · 아직 쓰일 수 없는 순위가 있습니다(그동안은 다음 순위로 넘어갑니다)</p>
    <ul>{state.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
  </div>;
  return state?.ok ? <p role="status" className="rounded-lg border border-up/30 bg-up/5 p-3 text-[13px] text-up">모델 설정을 저장했습니다.</p> : null;
}
