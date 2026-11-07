"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 되돌릴 수 있는 저장의 두 단계 확인(2026-11-07 LLM 운영 PR 5) — window.confirm 은 쓰지 않는다.
 * 첫 단추(type="button")를 누르면 그 자리에 「바뀌는 내용」(칸 이름: 이전 → 이후)과 「저장 확인」·「취소」가 펼쳐지고,
 * 「저장 확인」(type="submit")을 눌러야 폼이 나간다. 되돌릴 수 없는 조치(모델 재시작·정식 해제)는 이것이 아니라 사유 입력 대화상자(ModelOpsPanel)다.
 *
 * - 바뀌는 내용은 폼의 보이는 칸(hidden·단추 제외)을 처음 그린 때(또는 savedKey 가 바뀐 때)의 값과 견줘 만든다. 칸 이름은 aria-label → <label> 글 → name.
 *   숨은 칸·상태로 그리는 폼은 changes 로 직접 준다. 「기본값으로」 칸(reset:경로)은 짝 칸(value:경로)의 이름을 쓴다.
 * - Enter 로 폼이 바로 나가는 것(칸이 하나뿐인 폼의 암묵 제출)도 막고 이 확인을 연다 — 폼의 submit 을 이 단추가 보낸 것만 통과시킨다.
 *   그래서 이 단추를 쓰는 폼의 다른 제출 단추도 모두 ConfirmSubmit 이어야 한다.
 * - 「저장 확인」을 누른 그 클릭 안에서는 단추를 지우지 않는다(지우면 브라우저가 제출하지 않는다) — 제출이 나간 뒤에 닫는다.
 */
/** 바뀌는 칸 하나 — before·after 가 없으면 이름만 보인다(예: 단계 풀처럼 이름만 아는 변경) */
export type FieldChange = { label: string; before?: string; after?: string };
type Field = { label: string; value: string };
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const SKIP = new Set(["hidden", "submit", "button", "reset", "image", "file"]);
const clean = (text: string | null | undefined, max = 60) => { const value = (text ?? "").replace(/\s+/g, " ").trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const isControl = (element: Element): element is Control =>
  element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;

function controlLabel(form: HTMLFormElement, control: Control): string {
  if (control.name.startsWith("reset:")) {
    const peer = form.elements.namedItem(`value:${control.name.slice("reset:".length)}`);
    return `${peer instanceof Element && isControl(peer) ? controlLabel(form, peer) : control.name.slice(6)} · 기본값으로`;
  }
  const label = control.labels?.[0];
  return clean(control.getAttribute("aria-label")) || (label ? labelText(label) : "") || control.name;
}

/** <label> 의 글 — 안에 든 칸(선택지 글 등)은 빼고, 이름표 <span> 이 있으면 그것 */
function labelText(label: HTMLLabelElement): string {
  const copy = label.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("select, input, textarea").forEach(node => node.remove());
  return clean(copy.querySelector("span")?.textContent) || clean(copy.textContent);
}

/** 키·비밀번호 칸은 값을 보이지 않는다 — 넣었는지만 */
const secret = (control: Control) => (control instanceof HTMLInputElement && control.type === "password") || /^(api[-_]?key|key|secret|password)$/i.test(control.name);

function controlValue(control: Control): string {
  if (secret(control)) return control.value ? "(새 값 입력함)" : "(비움)";
  if (control instanceof HTMLSelectElement) return clean([...control.selectedOptions].map(option => option.textContent).join(", "), 80) || "(없음)";
  if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")) return control.checked ? "켬" : "끔";
  return clean(control.value, 80) || "(비움)";
}

/** 폼의 보이는 칸 → 이름표·값. 라디오는 이름 하나에 고른 것의 글자. 꺼진(disabled) 칸은 보내지 않으므로 뺀다. */
export function readFormFields(form: HTMLFormElement): Map<string, Field> {
  const fields = new Map<string, Field>();
  [...form.elements].forEach((element, index) => {
    if (!isControl(element) || !element.name || element.disabled || SKIP.has(element.type)) return;
    if (element instanceof HTMLInputElement && element.type === "radio") {
      if (!fields.has(element.name)) fields.set(element.name, { label: element.name, value: "(없음)" });
      if (element.checked) fields.set(element.name, { label: clean(element.closest("fieldset")?.querySelector("legend")?.textContent) || element.name,
        value: (element.labels?.[0] ? labelText(element.labels[0]) : "") || element.value });
      return;
    }
    const key = fields.has(element.name) ? `${element.name}#${index}` : element.name;
    fields.set(key, { label: controlLabel(form, element), value: controlValue(element) });
  });
  return fields;
}

export function diffFormFields(before: ReadonlyMap<string, Field>, after: ReadonlyMap<string, Field>): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const [key, field] of after) {
    const previous = before.get(key);
    if (!previous) { if (!["(비움)", "(없음)", "끔"].includes(field.value)) changes.push({ label: field.label, before: "(없음)", after: field.value }); }
    else if (previous.value !== field.value) changes.push({ label: field.label, before: previous.value, after: field.value });
  }
  for (const [key, field] of before) if (!after.has(key)) changes.push({ label: field.label, before: field.value, after: "(없음)" });
  return changes;
}

const SHOWN = 12;

export function ConfirmSubmit({ label, confirmLabel = "저장 확인", pendingLabel = "저장 중…", pending = false, disabled = false, className = "rounded bg-fg px-3 py-2 text-bg disabled:opacity-50",
  confirmClassName, changes, summary, savedKey, name, value, formAction, title = "바뀌는 내용" }: {
  label: ReactNode; confirmLabel?: string; pendingLabel?: string; pending?: boolean; disabled?: boolean; className?: string; confirmClassName?: string;
  /** 바뀌는 내용을 직접 줄 때(숨은 칸·상태로 그리는 폼, 끄기처럼 칸이 없는 조치는 []). 없으면 폼의 보이는 칸을 견준다 */
  changes?: readonly FieldChange[];
  /** 저장하면 무엇이 일어나는지 한 줄 */
  summary?: ReactNode;
  /** 저장이 받아들여져 새 값이 기준이 될 때 바뀌는 값(판·결과) — 바뀌면 처음 값을 다시 읽는다 */
  savedKey?: unknown;
  /** 「저장 확인」 단추가 함께 보내는 값·다른 서버 동작(한 폼에 단추가 여럿일 때) */
  name?: string; value?: string; formAction?: (form: FormData) => void;
  title?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null), confirmButton = useRef<HTMLButtonElement>(null);
  const baseline = useRef<Map<string, Field>>(new Map());
  const [open, setOpen] = useState<FieldChange[] | null>(null);
  const formOf = useCallback(() => trigger.current?.form ?? confirmButton.current?.form ?? null, []);
  const snapshot = useCallback(() => { const form = formOf(); if (form) baseline.current = readFormFields(form); }, [formOf]);
  const show = useCallback(() => {
    const form = formOf();
    setOpen(changes ? [...changes] : form ? diffFormFields(baseline.current, readFormFields(form)) : []);
  }, [changes, formOf]);
  useEffect(() => { snapshot(); }, [snapshot, savedKey]);
  useEffect(() => { if (open) confirmButton.current?.focus(); }, [open]);
  useEffect(() => {
    const mine = trigger.current, form = mine?.form;
    if (!mine || !form) return;
    const onSubmit = (event: SubmitEvent) => {
      // 「저장 확인」이 보낸 제출만 통과 — 제출이 나간 뒤(다음 틱)에 확인 칸을 닫는다
      if (event.submitter?.hasAttribute("data-confirmed-submit")) { window.setTimeout(() => setOpen(null), 0); return; }
      event.preventDefault();
      // 단추 없이 나가려던 제출(Enter) — 폼의 첫 확인 단추가 확인을 연다
      if (form.querySelector("[data-confirm-trigger]") === mine) show();
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [show]);
  const shown = pending ? null : open;
  const rest = (shown?.length ?? 0) - SHOWN;
  return <>
    <button ref={trigger} type="button" data-confirm-trigger="" hidden={!!shown} disabled={disabled || pending} className={className} onClick={show}>{pending ? pendingLabel : label}</button>
    {shown && <div role="group" aria-label={`${title} 확인`} data-dirty="" data-confirm-open="" className="grid w-full basis-full gap-2 rounded-lg border border-line bg-bg-soft p-3 text-[13px]"
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); setOpen(null); } }}>
      {changes?.length === 0 && summary ? null : <p className="font-semibold">{shown.length ? `${title} ${shown.length}칸` : "바뀐 칸이 없습니다 — 그대로 저장합니다."}</p>}
      {shown.length > 0 && <ul className="grid gap-0.5">{shown.slice(0, SHOWN).map((change, index) => <li key={`${change.label}:${index}`} className="break-words">
        {change.before === undefined && change.after === undefined ? <b>{change.label}</b>
          : <><span className="text-fg-2">{change.label}:</span> <s className="text-fg-3">{change.before ?? "(없음)"}</s> → <b>{change.after ?? "(없음)"}</b></>}</li>)}
        {rest > 0 && <li className="text-fg-3">그 밖에 {rest}칸</li>}</ul>}
      {summary && <p className="text-fg-2">{summary}</p>}
      <div className="flex flex-wrap gap-2">
        <button ref={confirmButton} type="submit" data-confirmed-submit="" name={name} value={value} formAction={formAction} disabled={disabled}
          className={confirmClassName ?? className}>{confirmLabel}</button>
        <button type="button" onClick={() => setOpen(null)} className="rounded border border-line px-3 py-2">취소</button>
      </div>
    </div>}
  </>;
}
