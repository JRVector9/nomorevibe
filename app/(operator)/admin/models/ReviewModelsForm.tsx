"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { applyReviewRoutingPreset } from "@/lib/crawl/review-routing-preset";
import { ModelRows, type ModelOption } from "../settings/ModelRows";
import { buttonDashed, hintClass, SettingsCard } from "../settings/Switch";
import { saveReviewModels, type ModelSaveState } from "./actions";

export function ReviewModelsForm({ settings, version, firstChoices, secondChoices, saveAction = saveReviewModels }: {
  settings: CrawlSettings; version: string; firstChoices: ModelOption[]; secondChoices: ModelOption[];
  saveAction?: typeof saveReviewModels;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(settings);
  const [generation, setGeneration] = useState(0);
  const [formVersion, setFormVersion] = useState(version);
  const [state, action, pending] = useActionState<ModelSaveState, FormData>(async (previous, form) => {
    let result: ModelSaveState;
    try { result = await saveAction(previous, form); }
    catch { return { issues: ["저장 결과를 확인하지 못했습니다. 새로고침해 현재 설정을 확인해주세요."] }; }
    if (result?.ok && result.version) { setFormVersion(result.version); router.refresh(); }
    return result;
  }, null);
  return <form action={action} className="flex flex-col gap-4">
    <input type="hidden" name="settingsVersion" value={formVersion} />
    <SettingsCard id="review-models" title="검수 단계 모델 선택" note="새 설정은 이후 작업에 반영됩니다. 진행 중인 요청은 기존 종료·용량 보호 검증에 따라 처리하며 미확정 요청은 설정 변경만으로 해제되지 않습니다.">
      <button type="button" disabled={pending} className={buttonDashed} onClick={() => {
        setDraft(applyReviewRoutingPreset(settings)); setGeneration(current => current + 1);
      }}>Supa Qwen 1차 → GPU3090 Qwen 2차 구성 불러오기</button>
      <p className={hintClass}>구성을 불러오면 추가 1차 모델과 2차 대체 모델을 비웁니다. 아래 값을 확인하고 저장하세요. 단계의 켜짐·발행 보호·용량 설정은 별도로 유지됩니다.</p>
      <div key={generation} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2"><legend className="text-[14px] font-semibold">1차 검수</legend>
          <ModelRows prefix="primary" initial={draft.firstReview ? [draft.firstReview] : []} max={1} allowDirect={false}
            choices={firstChoices} placeholder="모델 식별자" addLabel="+ 1차 모델 선택" />
          <p className={hintClass}>모델을 비우면 기존 서버 기본값을 사용합니다.</p>
        </fieldset>
        <fieldset className="flex flex-col gap-2"><legend className="text-[14px] font-semibold">추가 1차 모델 · 후보를 나눠 처리</legend>
          <ModelRows prefix="firstAdditional" initial={draft.firstReviewAdditional ?? []} max={2} allowDirect={false}
            choices={firstChoices} placeholder="모델 식별자" addLabel="+ 추가 1차 모델 선택" />
        </fieldset>
        <fieldset className="flex flex-col gap-2"><legend className="text-[14px] font-semibold">2차 검수 · 최대 3개</legend>
          <ModelRows prefix="voter" initial={draft.secondReview.voters} max={3}
            choices={secondChoices} placeholder="모델 식별자" addLabel="+ 2차 모델 선택" />
          <p className={hintClass}>서버·제공자 표기만 다른 동일 모델은 독립된 교차 검수 표로 보지 않습니다. 독립 표가 없으면 사람 확인이 남습니다.</p>
        </fieldset>
        <fieldset className="flex flex-col gap-2"><legend className="text-[14px] font-semibold">2차 대체 모델 · 최대 2개</legend>
          <ModelRows prefix="fallback" initial={draft.secondReview.fallbacks ?? []} max={2}
            choices={secondChoices} placeholder="모델 식별자" addLabel="+ 2차 대체 모델 선택" />
        </fieldset>
      </div>
      <p className={hintClass}>목록은 모델 선택을 돕습니다. 실제 호출은 해당 워커의 연결·실행 계약·용량 검증을 통과해야 합니다.</p>
      <ModelSaveNotice state={pending ? null : state} />
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" disabled={pending}
          className="inline-flex min-h-10 items-center justify-center rounded-[9px] bg-accent-solid px-5 text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-50">{pending ? "저장 중…" : "검수 모델 저장"}</button>
        <p className={hintClass}>모델을 추가·제거한 뒤 저장해야 적용됩니다.</p>
      </div>
    </SettingsCard>
  </form>;
}

export function ModelSaveNotice({ state }: { state: ModelSaveState }) {
  if (state?.issues) return <div role="alert" className="rounded-lg border border-down/30 bg-down/5 p-3 text-[13px] text-down">
    <p className="font-semibold">{state.issues.some(issue => issue.includes("다른 곳에서 설정이 바뀌었습니다")) ? "저장 거절 · 다른 곳에서 설정을 수정했습니다" : "저장하지 못했습니다"}</p>
    <ul>{state.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>
  </div>;
  return state?.ok ? <p role="status" className="rounded-lg border border-up/30 bg-up/5 p-3 text-[13px] text-up">모델 설정을 저장했습니다.</p> : null;
}
