"use client";
import type { ReactNode } from "react";
import type { FirstReviewer } from "@/lib/crawl/agent-review";
import { rankOptionKey, validateRanks, type RankStage } from "@/lib/operations/admin-first-review-ranks";
import { modelPickerChoiceKey, presentPickerOptions, type PickerConnection } from "./model-picker-display";
import { modelPickerActivityParts, type ModelPickerActivityPart } from "@/lib/operations/model-picker-availability";
import { refreshModelAvailability, useModelAvailability } from "./use-model-availability";

type RankValue = { provider: string; model: string; reasoningEffort?: string };

/**
 * 단계 × 모델 순위 — 우선순위로 모델 하나를 고르고, 대체가 필요한 경우에만 다음 순위로 전환한다.
 * 선택지는 지금 모든 서버가 실제로 내놓는 모델(엔진 API)과 이 단계가 받는 CLI 모델이며 「장비 · 모델」로 보인다(admin-first-review-ranks.ts rankOptions).
 * 폼 칸 이름은 slotNames 로 받는다 — 1차 AI 검수는 1순위 = primary0, 2·3순위 = firstAdditional0·1(서버 저장 경로 saveReviewModels 그대로).
 * 다른 단계는 같은 구성 요소에 그 단계의 RankStage·slotNames·저장 경로만 넘기면 된다. 「작업 ↔ 모델」(/admin/models/tasks)은 provider 칸에 연결 id 를 두고
 * 검증(validate)·안내(note)를 따로 넘기며 제공자 이름을 덧붙이지 않는다(showProvider false).
 * 선택지에 group(서버 = 연결 이름)이 있으면 서버마다 묶고(optgroup), 모델 이름 옆에 현재 실행·공유 슬롯 관측을 「이름 — 관측」으로 표시한다. 순위 라벨은 항상 별도 줄이다.
 * 고른 선택지는 이름만 보인다 — 닫힌 상자에 「이름 · 미실행 · 미확정 1 · 공유 여유 2/2」가 몰려 읽기 어려웠다(2026-11-08). 고른 모델의 관측은
 * 상자 밑에 조각마다 따로(사람이 볼 것은 경고 색) 보이고, 상자의 aria-describedby 가 그 줄을 가리킨다.
 * blocked 는 그 칸에서 고를 수 없는 선택지를 흐리게 둔다(저장 검증은 validate 가 그대로 한다).
 * rows 는 좁은 서랍에서 1·2·3순위를 가로 줄로 보인다. 기본 current 는 기존 배치 그대로다.
 */
export function RankSelects<T extends RankValue>({ stage, options, value, onChange, slotNames, disabled = false, validate, note, showProvider = true, compact = false, blocked, connections = [], selectionKind = "rank", layout = "current", renderAfterSlot }: {
  stage: Pick<RankStage, "id" | "label" | "slots"> & Partial<Pick<RankStage, "routeId" | "providers">>;
  options: readonly (T & { label: string; group?: string; text?: string; reasoningEfforts?: readonly string[] })[]; value: readonly (T | null)[]; onChange: (value: (T | null)[]) => void;
  slotNames: readonly { provider: string; model: string; reasoningEffort?: string }[]; disabled?: boolean;
  /** 화면 선택지만 제한한다. 실제 catalog·저장된 순위·서버 검증은 그대로 둔다. */
  connections?: readonly PickerConnection[];
  /** 기본 = 1차 AI 검수 규칙(validateRanks) */
  validate?: (slots: readonly (T | null)[]) => string[];
  /** 기본 = 1차 AI 검수의 순위 대체 안내 */
  note?: ReactNode;
  showProvider?: boolean;
  compact?: boolean;
  blocked?: (option: T, index: number, slots: readonly (T | null)[]) => boolean;
  selectionKind?: "rank" | "pool";
  /** rows = 좁은 서랍의 가로 순위 줄. 기본 current 는 기존 배치 그대로다. */
  layout?: "current" | "rows";
  /** 고른 순위의 label 바깥에 붙일 도구(실제 모델 응답 시험 단추는 root 가 연결한다). */
  renderAfterSlot?: (row: T, index: number) => ReactNode;
}) {
  const availability = useModelAvailability();
  const slots = Array.from({ length: stage.slots }, (_, index) => value[index] ?? null);
  const pickerOptions = (index: number) => presentPickerOptions(options, connections, slots[index]);
  // 다시 읽는 중(loading)이어도 글자를 바꾸지 않는다 — 마지막 관측을 그대로 보인다(use-model-availability.ts)
  const activityParts = (choice: RankValue): ModelPickerActivityPart[] => {
    if (!availability.value) return [{ text: availability.failed ? "상태 확인 못함" : "상태 확인 중", tone: availability.failed ? "warn" : null }];
    const connection = availability.value.connections.find(entry => entry.connectionId === choice.provider);
    if (!connection) return [{ text: "슬롯 확인 못함", tone: "warn" }];
    const key = modelPickerChoiceKey(choice, connections);
    const activity = connection.models.filter(row => modelPickerChoiceKey({ provider: choice.provider, model: row.model }, connections) === key);
    return modelPickerActivityParts(connection, activity, availability.value.mode);
  };
  const activityText = (choice: RankValue): string => activityParts(choice).map(part => part.text).join(" · ");

  const issues = validate ? validate(slots) : validateRanks(stage as RankStage, slots as unknown as (FirstReviewer | null)[]);
  const set = (index: number, key: string) => {
    const choice = pickerOptions(index).find(option => rankOptionKey(option) === key) ?? null;
    // 「없음」이 아닌데 선택지에서 못 찾은 값이면 바꾸지 않는다 — 조용히 빈 칸이 되어 저장 한 번에 순위가 지워지지 않게(2026-11-02 NUL 열쇠 사고)
    if (key !== "" && !choice) return;
    // 선택지의 label·saved는 싣지 않는다. 모델이 바뀌면 이전 모델의 추론 설정을 해제한다.
    const previous = slots[index], next = choice ? { provider: choice.provider, model: choice.model } as T : null;
    if (next && slotNames[index]?.reasoningEffort && previous?.reasoningEffort !== undefined)
      next.reasoningEffort = previous.provider === next.provider && previous.model === next.model ? previous.reasoningEffort : "";
    onChange(slots.map((row, at) => at === index ? next : row));
  };
  const itemLabel = (index: number) => selectionKind === "pool" ? `모델 ${index + 1}` : `${index + 1}순위`;
  const isRows = layout === "rows";
  return <div className="flex min-w-0 flex-col gap-2" role="group" aria-label={`${stage.label} ${selectionKind === "pool" ? "분산 모델" : "모델 순위"}`}>
    <div className={isRows ? "fr-rank-rows" : selectionKind === "pool" ? "grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4" : "grid min-w-0 gap-2 sm:grid-cols-3"}>
      {slots.map((row, index) => {
        const key = row ? rankOptionKey(row) : "";
        const choices = pickerOptions(index);
        // 기존 비 DeepSeek 값은 그 칸에만 남겨, 숨겨진 값이 조용히 지워지거나 다른 칸에 새로 선택되지 않게 한다.
        const groups = choices.some(option => option.group) ? [...choices.reduce((map, option) => map.set(option.group ?? "", [...map.get(option.group ?? "") ?? [], option]),
          new Map<string, (typeof options)[number][]>())] : null;
        const effortName = slotNames[index]?.reasoningEffort;
        const efforts = options.find(option => rankOptionKey(option) === key)?.reasoningEfforts ?? [];
        // Reusing a model does not reserve another slot. Runtime admission applies the one shared device limit.
        // 고른 선택지는 이름만(관측은 상자 밑 줄), 나머지는 「이름 — 관측」 — 목록을 열면 다른 모델의 여유를 견줄 수 있다
        const item = (option: (typeof options)[number]) => {
          const off = !!blocked?.(option, index, slots);
          const name = option.group !== undefined ? option.text ?? option.model : `${option.label}${!showProvider || option.provider.endsWith("-cli") ? "" : ` (${option.provider})`}`;
          const status = [rankOptionKey(option) === key ? "" : activityText(option), off ? "이 투표자/모델 조건에서 선택 불가" : ""].filter(Boolean).join(" · ");
          return <option key={rankOptionKey(option)} value={rankOptionKey(option)} disabled={off}>{status ? `${name} — ${status}` : name}</option>;
        };
        // 상자 이름(name)과 같은 뿌리 — 한 화면에서 단계(stage.id)마다 하나라 겹치지 않는다
        const activityId = `${stage.id}-${selectionKind}-${index + 1}-activity`;
        const modelSelect = <select name={`${stage.id}-${selectionKind}-${index + 1}`} aria-label={`${stage.label} ${itemLabel(index)}`} value={key} disabled={disabled}
          aria-describedby={row ? activityId : undefined}
          className={`min-h-9 w-full min-w-0 rounded-lg border border-line bg-bg-card px-2${isRows ? " fr-rank-row-select" : ""}`} onChange={event => set(index, event.target.value)}
          onFocus={() => { void refreshModelAvailability(); }} onPointerDown={() => { void refreshModelAvailability(); }}
          onPointerEnter={() => { void refreshModelAvailability(); }}
          onKeyDown={event => { if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) void refreshModelAvailability(); }}>
          <option value="">없음</option>
          {groups ? groups.map(([name, list]) => <optgroup key={name} label={name}>{list.map(item)}</optgroup>) : choices.map(item)}
        </select>;
        // 묶은 목록에서는 닫힌 드롭다운에 모델 이름만 보이므로, 고른 값의 서버를 밑에 적는다(같은 모델을 두 서버에 둘 때 가린다)
        const selectedServer = groups && row ? <span className={isRows ? "fr-rank-row-server truncate text-[13px] text-fg-2" : "truncate text-[13px] text-fg-2"} data-rank-server="true">{choices.find(option => rankOptionKey(option) === key)?.group ?? ""}</span> : null;
        // 고른 모델의 관측 — 조각마다 작은 꼬리표(사람이 볼 것은 경고 색·테두리). 글자는 선택지와 같은 조각이다
        const selectedActivity = row ? <span id={activityId} className={`${isRows ? "fr-rank-row-activity " : ""}flex flex-wrap gap-1`} data-model-activity="true">
          {activityParts(row).map((part, at) => <span key={`${at}:${part.text}`} data-tone={part.tone ?? undefined}
            className="rounded-full border border-line bg-bg-soft px-1.5 text-[13px] leading-[1.6] text-fg-2 data-[tone=warn]:border-warn/60 data-[tone=warn]:text-warn">{part.text}</span>)}
        </span> : null;
        const effortControl = row && effortName ? <>
          {efforts.length > 0 || row.reasoningEffort ? <select aria-label={`${stage.label} ${itemLabel(index)} 추론 강도`} value={row.reasoningEffort ?? ""}
            disabled={disabled} className={`min-h-9 w-full min-w-0 rounded-lg border border-line bg-bg-card px-2${isRows ? " fr-rank-row-effort-select" : ""}`}
            onChange={event => onChange(slots.map((entry, at) => at === index && entry ? { ...entry, reasoningEffort: event.target.value } : entry))}>
            <option value="">{efforts.length ? "기본값" : "설정 해제"}</option>
            {row.reasoningEffort && !efforts.includes(row.reasoningEffort) && <option value={row.reasoningEffort} disabled>저장된 값: {row.reasoningEffort} (실행 미지원)</option>}
            {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
          </select> : <span className="text-fg-2">이 작업·모델은 설정 미지원</span>}
          <input type="hidden" name={effortName} value={row.reasoningEffort ?? ""} />
        </> : null;
        const effortBlock = row && effortName ? (
          isRows ? <span className="fr-rank-row-effort">
            <span className="fr-rank-row-effort-label text-fg-2">추론 강도</span>
            {effortControl}
          </span> : <>
            <span className="text-fg-2">추론 강도</span>
            {effortControl}
          </>
        ) : null;
        const labelContents = <>
          <span className={isRows ? "fr-rank-row-name font-semibold" : "block font-semibold"} data-compact={compact || undefined}>{itemLabel(index)}</span>
          {isRows ? <span className="fr-rank-row-model">
            <span className="text-fg-2">모델</span>
            {modelSelect}
            {selectedServer}
            {selectedActivity}
          </span> : <>
            {modelSelect}
            {selectedServer}
            {selectedActivity}
          </>}
          {effortBlock}
          {row && <><input type="hidden" name={slotNames[index].provider} value={row.provider} /><input type="hidden" name={slotNames[index].model} value={row.model} /></>}
        </>;
        if (isRows || renderAfterSlot) {
          return <div key={index} className={isRows ? "fr-rank-row" : "min-w-0"}>
            <label className={isRows ? "fr-rank-row-label text-[13px]" : "flex min-w-0 flex-col gap-1 text-[13px]"}
              data-rank-effort={isRows ? (row && effortName ? "yes" : "no") : undefined}>{labelContents}</label>
            {row && renderAfterSlot?.(row, index)}
          </div>;
        }
        return <label key={index} className="flex min-w-0 flex-col gap-1 text-[13px]">{labelContents}</label>;
      })}
    </div>
    <span className="text-[13px] text-fg-2" data-rank-observed="true">{availability.value && <>관측 {new Date(availability.value.observedAt).toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" })} KST
      {availability.failed && " (다시 읽기 실패 — 마지막 관측)"} · </>}
      슬롯은 장비 전체의 공유 여유입니다. 반복 선택해도 한도는 늘지 않으며 실행 시 다시 확인합니다.</span>
    {issues.length > 0 && <ul role="alert" className="text-[13px] text-down">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    {note === undefined
      ? <p className="text-[13px] text-fg-2">{selectionKind === "pool"
        ? "서로 다른 업무를 모델에 나눕니다. 업무마다 모델 하나를 선택하며, 동시 실행 수는 장비 한도를 따릅니다."
        : "우선 모델 하나를 쓰고, 대체가 필요한 경우에만 다음 순위로 전환합니다. 같은 입력을 세 모델이 차례로 검수하지 않습니다. 새 설정은 새 작업부터 반영됩니다."}</p>
      : note}
  </div>;
}
