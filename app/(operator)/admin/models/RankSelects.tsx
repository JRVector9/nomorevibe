"use client";
import type { FirstReviewer } from "@/lib/crawl/agent-review";
import { rankOptionKey, validateRanks, type RankOption, type RankStage } from "@/lib/operations/admin-first-review-ranks";
import type { SelectedModel } from "./ModelChips";

/**
 * 단계 × 모델 순위 — 한 단계 행에 1순위·2순위·3순위 드롭다운(각각 「없음」 포함). 실행은 1 → 2 → 3 순으로, 그 틱에 쓸 수 있는 가장 높은 순위를 쓴다.
 * 선택지는 지금 모든 서버가 실제로 내놓는 모델(엔진 API)과 이 단계가 받는 CLI 모델이며 「장비 · 모델」로 보인다(admin-first-review-ranks.ts rankOptions).
 * 폼 칸 이름은 slotNames 로 받는다 — 1차 AI 검수는 1순위 = primary0, 2·3순위 = firstAdditional0·1(서버 저장 경로 saveReviewModels 그대로).
 * 다른 단계는 같은 구성 요소에 그 단계의 RankStage·slotNames·저장 경로만 넘기면 된다.
 */
export function RankSelects({ stage, options, value, onChange, slotNames, disabled = false }: {
  stage: RankStage; options: readonly RankOption[]; value: readonly (SelectedModel | null)[]; onChange: (value: (SelectedModel | null)[]) => void;
  slotNames: readonly { provider: string; model: string }[]; disabled?: boolean;
}) {
  const slots = Array.from({ length: stage.slots }, (_, index) => value[index] ?? null);
  const issues = validateRanks(stage, slots as (FirstReviewer | null)[]);
  const set = (index: number, key: string) => {
    const choice = options.find(option => rankOptionKey(option) === key) ?? null;
    onChange(slots.map((row, at) => at === index ? (choice ? { provider: choice.provider, model: choice.model } : null) : row));
  };
  return <div className="flex min-w-0 flex-col gap-2" role="group" aria-label={`${stage.label} 모델 순위`}>
    <div className="grid min-w-0 gap-2 sm:grid-cols-3">
      {slots.map((row, index) => {
        const key = row ? rankOptionKey(row) : "";
        // 다른 칸에서 이미 고른 모델은 이 칸에서 고를 수 없다(중복 방지). 지금 이 칸의 값은 남긴다
        const taken = new Set(slots.filter((other, at) => other && at !== index).map(other => rankOptionKey(other!)));
        return <label key={index} className="flex min-w-0 flex-col gap-1 text-[13px]">
          <span className="font-semibold">{index + 1}순위</span>
          <select name={`${stage.id}-rank-${index + 1}`} aria-label={`${stage.label} ${index + 1}순위`} value={key} disabled={disabled}
            className="min-h-9 w-full min-w-0 rounded-lg border border-line bg-bg-card px-2" onChange={event => set(index, event.target.value)}>
            <option value="">없음</option>
            {options.map(option => <option key={rankOptionKey(option)} value={rankOptionKey(option)} disabled={taken.has(rankOptionKey(option))}>
              {option.label}{option.provider.endsWith("-cli") ? "" : ` (${option.provider})`}</option>)}
          </select>
          {row && <><input type="hidden" name={slotNames[index].provider} value={row.provider} /><input type="hidden" name={slotNames[index].model} value={row.model} /></>}
        </label>;
      })}
    </div>
    {issues.length > 0 && <ul role="alert" className="text-[13px] text-down">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    <p className="text-[13px] text-fg-2">1순위를 이 틱에 쓸 수 없으면(멈춤·장비 미설정·연결 계약 닫힘·경로 없음·엔진 내려감) 2순위, 그다음 3순위로 넘어갑니다. 저장하면 다음 틱부터 적용됩니다.</p>
  </div>;
}
