"use client";
import type { ReactNode } from "react";
import type { FirstReviewer } from "@/lib/crawl/agent-review";
import { rankOptionKey, validateRanks, type RankStage } from "@/lib/operations/admin-first-review-ranks";

type RankValue = { provider: string; model: string };

/**
 * 단계 × 모델 순위 — 한 단계 행에 1순위·2순위·3순위 드롭다운(각각 「없음」 포함). 실행은 1 → 2 → 3 순으로, 그 틱에 쓸 수 있는 가장 높은 순위를 쓴다.
 * 선택지는 지금 모든 서버가 실제로 내놓는 모델(엔진 API)과 이 단계가 받는 CLI 모델이며 「장비 · 모델」로 보인다(admin-first-review-ranks.ts rankOptions).
 * 폼 칸 이름은 slotNames 로 받는다 — 1차 AI 검수는 1순위 = primary0, 2·3순위 = firstAdditional0·1(서버 저장 경로 saveReviewModels 그대로).
 * 다른 단계는 같은 구성 요소에 그 단계의 RankStage·slotNames·저장 경로만 넘기면 된다. 「작업 ↔ 모델」(/admin/models/tasks)은 provider 칸에 연결 id 를 두고
 * 검증(validate)·안내(note)를 따로 넘기며 제공자 이름을 덧붙이지 않는다(showProvider false).
 * 선택지에 group(서버 = 연결 이름)이 있으면 서버마다 묶어(optgroup) 그 안에 text(모델 이름)만 보인다. compact 는 넓은 화면에서 칸 위 「N순위」 글을 숨긴다(표 머리에 있다).
 * blocked 는 그 칸에서 고를 수 없는 선택지를 흐리게 둔다(저장 검증은 validate 가 그대로 한다).
 */
export function RankSelects<T extends RankValue>({ stage, options, value, onChange, slotNames, disabled = false, validate, note, showProvider = true, compact = false, blocked }: {
  stage: Pick<RankStage, "id" | "label" | "slots"> & Partial<Pick<RankStage, "routeId" | "providers">>;
  options: readonly (T & { label: string; group?: string; text?: string })[]; value: readonly (T | null)[]; onChange: (value: (T | null)[]) => void;
  slotNames: readonly { provider: string; model: string }[]; disabled?: boolean;
  /** 기본 = 1차 AI 검수 규칙(validateRanks) */
  validate?: (slots: readonly (T | null)[]) => string[];
  /** 기본 = 1차 AI 검수의 순위 대체 안내 */
  note?: ReactNode;
  showProvider?: boolean;
  compact?: boolean;
  blocked?: (option: T, index: number, slots: readonly (T | null)[]) => boolean;
}) {
  const slots = Array.from({ length: stage.slots }, (_, index) => value[index] ?? null);
  const issues = validate ? validate(slots) : validateRanks(stage as RankStage, slots as unknown as (FirstReviewer | null)[]);
  const set = (index: number, key: string) => {
    const choice = options.find(option => rankOptionKey(option) === key) ?? null;
    // 「없음」이 아닌데 선택지에서 못 찾은 값이면 바꾸지 않는다 — 조용히 빈 칸이 되어 저장 한 번에 순위가 지워지지 않게(2026-11-02 NUL 열쇠 사고)
    if (key !== "" && !choice) return;
    // 값은 { provider, model } 두 칸뿐이다(선택지의 label·saved 를 싣지 않는다)
    onChange(slots.map((row, at) => at === index ? (choice ? { provider: choice.provider, model: choice.model } as T : null) : row));
  };
  // 서버(group)마다 묶기 — 처음 나온 순서 그대로(선택지를 만든 쪽이 정한 순서)
  const groups = options.some(option => option.group) ? [...options.reduce((map, option) => map.set(option.group ?? "", [...map.get(option.group ?? "") ?? [], option]),
    new Map<string, (typeof options)[number][]>())] : null;
  return <div className="flex min-w-0 flex-col gap-2" role="group" aria-label={`${stage.label} 모델 순위`}>
    <div className="grid min-w-0 gap-2 sm:grid-cols-3">
      {slots.map((row, index) => {
        const key = row ? rankOptionKey(row) : "";
        // 다른 칸에서 이미 고른 모델은 이 칸에서 고를 수 없다(중복 방지). 지금 이 칸의 값은 남긴다
        const taken = new Set(slots.filter((other, at) => other && at !== index).map(other => rankOptionKey(other!)));
        const item = (option: (typeof options)[number]) => <option key={rankOptionKey(option)} value={rankOptionKey(option)}
          disabled={taken.has(rankOptionKey(option)) || !!blocked?.(option, index, slots)}>
          {option.group !== undefined ? option.text ?? option.model : `${option.label}${!showProvider || option.provider.endsWith("-cli") ? "" : ` (${option.provider})`}`}</option>;
        return <label key={index} className="flex min-w-0 flex-col gap-1 text-[13px]">
          <span className={compact ? "font-semibold sm:sr-only" : "font-semibold"}>{index + 1}순위</span>
          <select name={`${stage.id}-rank-${index + 1}`} aria-label={`${stage.label} ${index + 1}순위`} value={key} disabled={disabled}
            className="min-h-9 w-full min-w-0 rounded-lg border border-line bg-bg-card px-2" onChange={event => set(index, event.target.value)}>
            <option value="">없음</option>
            {groups ? groups.map(([name, list]) => <optgroup key={name} label={name}>{list.map(item)}</optgroup>) : options.map(item)}
          </select>
          {/* 묶은 목록에서는 닫힌 드롭다운에 모델 이름만 보이므로, 고른 값의 서버를 밑에 적는다(같은 모델을 두 서버에 둘 때 가린다) */}
          {groups && row && <span className="truncate text-[13px] text-fg-3" data-rank-server="true">{options.find(option => rankOptionKey(option) === key)?.group ?? ""}</span>}
          {row && <><input type="hidden" name={slotNames[index].provider} value={row.provider} /><input type="hidden" name={slotNames[index].model} value={row.model} /></>}
        </label>;
      })}
    </div>
    {issues.length > 0 && <ul role="alert" className="text-[13px] text-down">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    {note === undefined
      ? <p className="text-[13px] text-fg-2">1순위를 이 틱에 쓸 수 없으면(멈춤·장비 미설정·연결 계약 닫힘·경로 없음·엔진 내려감) 2순위, 그다음 3순위로 넘어갑니다. 저장하면 다음 틱부터 적용됩니다.</p>
      : note}
  </div>;
}
