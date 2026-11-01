"use client";
import { useActionState, useState, type ReactNode } from "react";
import type { SettingField } from "@/lib/operations/admin-runtime-settings";
import type { RuntimeSettingGroup } from "@/lib/operations/runtime-settings-schema";
import { saveRuntimeSettingsGroup, type LimitsSaveState } from "./actions";

/**
 * 실시간 한도 폼의 공통 조각. 칸 이름 규약(value:·initial:·stored:·reset:·auto:·initialAuto:)은
 * lib/operations/admin-runtime-settings.ts runtimeSettingsPatchFromForm 과 짝이다 — 여기만 바꾸면 저장이 조용히 빈 patch 가 된다.
 * 입력은 손대지 않은(uncontrolled) 칸이라 바뀌면 폼에 data-dirty 를 달아 자동 새로고침(live-refresh)이 값을 덮지 않게 한다.
 */
export const INPUT = "w-24 rounded border border-line bg-bg px-2 py-1 text-right tabular-nums";
export const INPUT_WIDE = "w-28 rounded border border-line bg-bg px-2 py-1 text-right tabular-nums";

export function GroupForm({ group, revision, readOnly, children, footer }: { group: RuntimeSettingGroup; revision: number | null; readOnly?: boolean;
  children: ReactNode; footer?: ReactNode }) {
  const [state, action, pending] = useActionState<LimitsSaveState, FormData>(saveRuntimeSettingsGroup, null);
  const [dirty, setDirty] = useState(false);
  return <form action={action} data-dirty={dirty || undefined} onChange={() => setDirty(true)} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <input type="hidden" name="group" value={group} />
    <input type="hidden" name="expectedRevision" value={revision ?? ""} />
    {children}
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending || readOnly || revision === null} className="rounded bg-fg px-3 py-2 text-bg disabled:opacity-50">
        {pending ? "저장 중…" : "이 묶음 저장"}</button>
      {footer}
      {readOnly && <span className="text-[13px] text-fg-3">저장 행을 읽지 못해 읽기 전용입니다.</span>}
    </div>
    <SaveNotice state={state} />
  </form>;
}

export function SaveNotice({ state }: { state: LimitsSaveState }) {
  if (!state) return null;
  return <>
    {state.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">저장 거절 — {text}</p>)}
  </>;
}

/** 덮어씀/기본값 표시 — 색만으로 가르지 않고 글자를 낸다 */
export function OverrideBadge({ overridden }: { overridden: boolean }) {
  return <span className={`rounded-full px-1.5 text-[13px] font-semibold ${overridden ? "bg-amber-100 text-amber-900" : "text-fg-3"}`}>{overridden ? "덮어씀" : "기본값"}</span>;
}

/**
 * 값 한 칸 — 지금 값 입력 + 기본값 + 덮어씀 표시 + 「기본값으로」(덮어쓴 칸에만).
 * ms 칸은 초로 받는다(label 이 "(초)"). 값이 없는 칸(비울 수 있는 호출 상한)은 빈 입력에 placeholder 를 둔다.
 */
export function ValueCell({ field, readOnly, unit }: { field: SettingField; readOnly?: boolean; unit?: string }) {
  const suffix = unit ?? (field.kind === "int" ? "" : "초");
  if (field.readOnly) return <span className="tabular-nums" title={field.note}>{field.input || "—"}{suffix} <span className="text-[13px] text-fg-3">고정</span></span>;
  return <span className="inline-grid gap-0.5">
    <span className="flex items-center gap-1">
      <input name={`value:${field.path}`} defaultValue={field.input} aria-label={field.label} title={field.note ?? field.label} inputMode="decimal"
        placeholder={field.value === null ? "모델 상한" : undefined} disabled={readOnly} className={INPUT} />
      {suffix && <span className="text-[13px] text-fg-3">{suffix}</span>}
      <OverrideBadge overridden={field.overridden} />
    </span>
    <input type="hidden" name={`initial:${field.path}`} value={field.input} />
    <input type="hidden" name={`stored:${field.path}`} value={field.overridden ? "1" : "0"} />
    <span className="flex items-center gap-2 text-[13px] text-fg-3">
      <span>기본 {field.defaultInput === "" ? "없음" : `${field.defaultInput}${suffix}`}</span>
      {field.overridden && <label className="flex items-center gap-1"><input type="checkbox" name={`reset:${field.path}`} disabled={readOnly} /> 기본값으로</label>}
    </span>
  </span>;
}

/**
 * 열거 칸(PR 3b-E) — 선택지(select) + 기본값 + 덮어씀 표시 + 「기본값으로」(덮어쓴 칸에만). 칸 이름 규약은 ValueCell 과 같다(value:·initial:·stored:·reset:).
 * 값은 글자 그대로 보내고 서버(runtimeSettingsPatchFromForm)가 선택지 밖의 값을 거절한다.
 */
export function ChoiceCell({ field, readOnly }: { field: SettingField; readOnly?: boolean }) {
  const options = field.options ?? [];
  const labelOf = (value: string) => options.find(option => option.value === value)?.label ?? value;
  return <span className="inline-grid gap-0.5">
    <span className="flex items-center gap-1">
      <select name={`value:${field.path}`} defaultValue={field.input} aria-label={field.label} title={field.note ?? field.label} disabled={readOnly}
        className="rounded border border-line bg-bg px-2 py-1">
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <OverrideBadge overridden={field.overridden} />
    </span>
    <input type="hidden" name={`initial:${field.path}`} value={field.input} />
    <input type="hidden" name={`stored:${field.path}`} value={field.overridden ? "1" : "0"} />
    <span className="flex items-center gap-2 text-[13px] text-fg-3">
      <span>기본 {field.defaultInput === "" ? "없음" : labelOf(field.defaultInput)}</span>
      {field.overridden && <label className="flex items-center gap-1"><input type="checkbox" name={`reset:${field.path}`} disabled={readOnly} /> 기본값으로</label>}
    </span>
  </span>;
}

export const TH = "py-2 pr-3 text-[13px] font-semibold text-fg-3";
export const TD = "py-2 pr-3 align-top";
