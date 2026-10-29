"use client";
import type { ModelOption } from "../settings/ModelRows";
export type SelectedModel = { provider: string; model: string };
const identity = (row: SelectedModel) => JSON.stringify([row.provider, row.model]);
export function ModelChips({ label, rows, choices, max, onChange, prefix, displayName }: {
  label: string; rows: SelectedModel[]; choices: readonly ModelOption[]; max: number; onChange: (rows: SelectedModel[]) => void; prefix?: string; displayName?: (row: SelectedModel) => string;
}) {
  const available = choices.filter(choice => !rows.some(row => identity(row) === identity(choice)));
  return <div className="flex flex-wrap items-center gap-2">
    {rows.map((row, index) => <span key={`${identity(row)}:${index}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-bg-soft py-1 pl-3 pr-1 text-[13px]">
      {prefix && <><input type="hidden" name={`${prefix}Provider${index}`} value={row.provider} /><input type="hidden" name={`${prefix}Model${index}`} value={row.model} /></>}
      <span className="min-w-0 break-words">{displayName?.(row) ?? row.model}</span><button type="button" aria-label={`${label} ${index + 1}번째 모델 빼기`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-[20px] text-fg-2 hover:bg-bg-hover hover:text-down"
        onClick={() => onChange(rows.filter((_, at) => at !== index))}>×</button>
    </span>)}
    {!rows.length && <span className="text-[13px] text-fg-2">배포 기본값 사용</span>}
    {rows.length < max && available.length > 0 && <label className="relative inline-flex min-h-9 items-center rounded-full border border-dashed border-line px-3 text-[13px] font-semibold text-accent-ink">
      + 모델 추가<select value="" aria-label={`${label} 모델 추가`} className="absolute inset-0 w-full cursor-pointer opacity-0"
        onChange={event => { const choice = available.find(row => identity(row) === event.target.value); if (choice) onChange([...rows, { provider: choice.provider, model: choice.model }]); }}>
        <option value="" disabled>추가할 모델 선택</option>{available.map(row => <option key={identity(row)} value={identity(row)}>{row.label}</option>)}
      </select>
    </label>}
  </div>;
}
export function ModelSaveBar({ pending = false, changes, label = "검수 모델 저장" }: { pending?: boolean; changes: string[]; label?: string }) {
  return <div className="models-save-bar flex flex-wrap items-center justify-between gap-3 border-t border-line bg-bg-card px-5 py-3 shadow-lg" role="region" aria-label="모델 설정 저장">
    <div className="min-w-0 text-[13px]"><p className="font-semibold">{changes.length ? `${changes.length}개 항목 변경 · 아직 적용 전` : "저장된 설정과 같습니다"}</p>
      <p className="mt-1 break-words text-fg-2">{changes.length ? changes.join(" · ") : "모델을 추가·제거한 뒤 저장해야 적용됩니다."}</p></div>
    <button type="submit" disabled={pending || !changes.length} className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-[9px] bg-accent-solid px-5 text-[14px] font-semibold text-white hover:brightness-110 disabled:opacity-50">{pending ? "저장 중…" : label}</button>
  </div>;
}
