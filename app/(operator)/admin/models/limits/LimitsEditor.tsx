"use client";
import Link from "next/link";
import { useActionState, useMemo, useState, type ReactNode } from "react";
import type { LimitsBudgetField, LimitsField, LimitsLevel, LimitsRow, LimitsTodo, LimitsView } from "@/lib/operations/admin-limits-view";
import { ConfirmSubmit, type FieldChange } from "../ConfirmSubmit";
import { saveRuntimeLimits, type LimitsSaveState } from "./actions";

/**
 * 「실시간 한도」 편집기(2026-11-11 개편, 승인 시안 limits-mock) — 작업 한 줄에 한 번 호출 상한·한 틱 시간·동시 호출과 24시간 실측을 나란히 둔다.
 * 화면 전체가 한 폼이고, 바뀐 칸만 한 번에 저장한다(saveRuntimeLimits → saveRuntimeSettings 한 TX).
 * 칸 이름 규약(value:·initial:·stored:·reset:·auto:·initialAuto:)은 lib/operations/admin-runtime-settings.ts runtimeSettingsPatchFromForm 과 짝이다.
 * 「권장값 넣기」는 칸만 채운다 — 저장은 운영자가 누른다. 고친 값이 있는 동안 자동 새로고침이 멈춘다(data-dirty).
 * scope 가 있으면(운영 홈의 단계 패널, 조각 2a) 그 단계의 작업 줄만 그리고, 저장 전 확인에 「영향을 받는 단계」(바뀐 칸을 쓰는 단계)를 덧붙인다.
 * 저장 동작·칸 이름·검사는 화면 전체와 같다 — 그리지 않은 줄의 칸은 보내지 않으므로 바뀌지 않는다.
 */
export type LimitsScope = { rowIds: readonly string[]; impact: Readonly<Record<string, readonly string[]>> };

type Draft = { values: Record<string, string>; autos: Record<string, boolean>; resets: Record<string, boolean> };
type AnyField = LimitsField | LimitsBudgetField;
const isBudget = (field: AnyField): field is LimitsBudgetField => "autoFrom" in field;
const LEVEL_SHAPE: Readonly<Record<LimitsLevel, string>> = { bad: "■", warn: "▲", info: "●", ok: "●", off: "‖" };
const fmt = (value: number) => value.toLocaleString("ko-KR");

/** "45" → 45000(ms) · "8" → 8(int). 숫자가 아니면 null */
function parsed(field: Pick<LimitsField, "kind">, text: string): number | null {
  const number = Number(text.replace(/,/g, "").trim());
  if (text.trim() === "" || !Number.isFinite(number)) return null;
  return field.kind === "ms" ? Math.round(number * 1000) : number;
}
const sameText = (field: Pick<LimitsField, "kind">, a: string, b: string) => { const x = parsed(field, a), y = parsed(field, b); return x !== null && y !== null ? x === y : a.trim() === b.trim(); };
export function secondsText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = ms / 1000;
  return `${seconds >= 10 ? fmt(Math.round(seconds)) : String(Math.round(seconds * 10) / 10)}초`;
}

/** 화면의 모든 칸(작업 줄·자동 틱 여유·고급 틱 시간) — 경로가 열쇠다 */
function collectFields(view: LimitsView): Map<string, AnyField> {
  const fields = new Map<string, AnyField>();
  const add = (field: AnyField | null | undefined) => { if (field) fields.set(field.path, field); };
  add(view.margin);
  for (const group of view.groups) for (const row of group.rows) {
    if (row.cap.kind === "field") add(row.cap.field);
    if (row.tick.kind === "field") add(row.tick.field);
    if (row.concurrency.kind === "field") add(row.concurrency.field);
    row.details.forEach(add);
  }
  for (const group of view.advanced) for (const row of group.rows) add(row.field);
  return fields;
}
function initialDraft(fields: Map<string, AnyField>): Draft {
  const draft: Draft = { values: {}, autos: {}, resets: {} };
  for (const field of fields.values()) { draft.values[field.path] = field.initial; if (isBudget(field)) draft.autos[field.path] = field.auto; }
  return draft;
}
function fieldChanged(field: AnyField, draft: Draft): boolean {
  if (draft.resets[field.path]) return field.overridden;
  if (isBudget(field) && (draft.autos[field.path] ?? field.auto) !== field.auto) return true;
  if (isBudget(field) && draft.autos[field.path]) return false;
  return !sameText(field, draft.values[field.path] ?? field.initial, field.initial);
}

/** 지금 칸 값으로 다시 센 실제 호출 상한(ms) — 모델 상한으로 자르고 덧붙는 시간을 더한다 */
function liveCeiling(sources: LimitsBudgetField["autoFrom"], draft: Draft, fields: Map<string, AnyField>): number | null {
  const values = sources.map(source => {
    const field = source.path ? fields.get(source.path) : undefined;
    const value = field ? parsed(field, draft.values[field.path] ?? field.initial) : source.fixedMs;
    if (value === null) return source.fixedMs;
    return source.ceilingMs !== null ? Math.min(value, source.ceilingMs) : value;
  }).filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}
function liveAutoBudget(field: LimitsBudgetField, draft: Draft, fields: Map<string, AnyField>, marginPath: string): number | null {
  const ceiling = liveCeiling(field.autoFrom, draft, fields);
  const margin = fields.get(marginPath);
  const marginMs = margin ? parsed(margin, draft.values[marginPath] ?? margin.initial) : null;
  return ceiling === null || marginMs === null ? null : ceiling + field.autoExtraMs + marginMs;
}
function liveBudgetMs(field: LimitsBudgetField, draft: Draft, fields: Map<string, AnyField>, marginPath: string): number | null {
  if (draft.resets[field.path]) return parsed(field, field.defaultInput);
  return draft.autos[field.path] ? liveAutoBudget(field, draft, fields, marginPath) : parsed(field, draft.values[field.path] ?? field.initial);
}
function liveCapMs(row: LimitsRow, draft: Draft, fields: Map<string, AnyField>): number | null {
  if (row.cap.kind === "text") return row.cap.sources ? liveCeiling(row.cap.sources, draft, fields) ?? row.capMs : row.capMs;
  const field = row.cap.field;
  const text = draft.resets[field.path] ? field.defaultInput : draft.values[field.path] ?? field.initial;
  const value = parsed(field, text);
  return value === null ? row.capMs : field.ceilingMs !== null ? Math.min(value, field.ceilingMs) : value;
}

function Pill({ level, children }: { level: LimitsLevel; children: ReactNode }) {
  return <span className="lim-pill" data-level={level}><span aria-hidden="true" className="lim-pill-shape">{LEVEL_SHAPE[level]}</span>{children}</span>;
}

type FieldProps = { field: AnyField; draft: Draft; setDraft: (update: (draft: Draft) => Draft) => void; readOnly: boolean; hint?: ReactNode; compact?: boolean };

/** 숨은 칸 — 저장이 읽는 처음 값·덮어씀·기본값으로·자동 */
function Hidden({ field, draft }: { field: AnyField; draft: Draft }) {
  return <>
    <input type="hidden" name={`initial:${field.path}`} value={field.initial} />
    <input type="hidden" name={`stored:${field.path}`} value={field.overridden ? "1" : "0"} />
    {draft.resets[field.path] && <input type="hidden" name={`reset:${field.path}`} value="on" />}
    {isBudget(field) && <input type="hidden" name={`initialAuto:${field.path}`} value={field.auto ? "1" : "0"} />}
    {isBudget(field) && draft.autos[field.path] && <input type="hidden" name={`auto:${field.path}`} value="on" />}
  </>;
}

/**
 * 덮어쓴 칸의 한 줄 — 「기본 20초에서 바꿈 · 기본값으로」. 누르면 저장 문서에서 그 키를 지운다(reset:). 덮어쓰지 않은 칸은 아무것도 보이지 않는다.
 * 자동 틱의 기본값은 그 잡의 기본(자동이거나 초)이다.
 */
function OverrideLine({ field, draft, setDraft, readOnly }: FieldProps) {
  if (!field.overridden) return null;
  const on = !!draft.resets[field.path];
  const base = field.defaultInput === "" ? "없음" : `${field.defaultInput}${field.unit}`;
  const text = on ? `저장하면 기본값(${base})으로 돌아갑니다` : sameText(field, field.initial, field.defaultInput) ? "저장된 값 · 기본값과 같음" : `기본 ${base}에서 바꿈`;
  return <span className="lim-note lim-override">{text}{!readOnly && <button type="button" className="lim-reset" aria-pressed={on}
    aria-label={`${field.label} ${on ? "기본값으로 돌리기 취소" : "기본값으로 돌리기"}`}
    onClick={() => setDraft(d => ({ ...d, resets: { ...d.resets, [field.path]: !on } }))}>{on ? "취소" : "기본값으로"}</button>}</span>;
}

function NumberInput({ field, draft, setDraft, readOnly, hint, compact }: FieldProps) {
  const reset = !!draft.resets[field.path];
  const value = reset ? field.defaultInput : draft.values[field.path] ?? field.initial;
  const changed = fieldChanged(field, draft);
  const number = parsed(field, value);
  const invalid = value.trim() !== "" && (number === null || (field.kind === "int" && !Number.isInteger(number)));
  const shown = field.kind === "ms" && number !== null ? number / 1000 : number;
  const outOfRange = shown !== null && (shown < field.min || shown > field.max);
  const over = field.kind === "ms" && field.ceilingMs !== null && number !== null && number > field.ceilingMs;
  return <span className="lim-input-wrap">
    <span className="lim-field">
      <input name={`value:${field.path}`} value={value} inputMode={field.kind === "int" ? "numeric" : "decimal"} aria-label={`${field.label}(${field.unit || "값"})`}
        aria-invalid={invalid || outOfRange || undefined} readOnly={reset} disabled={readOnly} data-edited={changed || undefined} data-compact={compact || undefined}
        onChange={event => { const next = event.target.value; setDraft(d => ({ ...d, values: { ...d.values, [field.path]: next } })); }} className="lim-input" />
      {field.unit && <span className="lim-unit">{field.unit}</span>}
      {hint}
    </span>
    <Hidden field={field} draft={draft} />
    {(invalid || outOfRange) && <span className="lim-bad-text">{invalid ? "숫자를 넣어주세요" : `${fmt(field.min)}~${fmt(field.max)}${field.unit} 사이로 넣어주세요`}</span>}
    {over && <span className="lim-note">모델 상한 {secondsText(field.ceilingMs)}보다 길게 적어도 실제 상한은 {secondsText(field.ceilingMs)}입니다</span>}
    <OverrideLine field={field} draft={draft} setDraft={setDraft} readOnly={readOnly} />
  </span>;
}

function BudgetInput({ field, draft, setDraft, readOnly, fields, marginPath }: FieldProps & { field: LimitsBudgetField; fields: Map<string, AnyField>; marginPath: string }) {
  const auto = !!draft.autos[field.path] && !draft.resets[field.path];
  const autoMs = liveAutoBudget(field, draft, fields, marginPath);
  const toggle = field.autoAllowed && !readOnly && <label className="lim-auto">
    <input type="checkbox" checked={auto} disabled={!!draft.resets[field.path]} aria-label={`${field.label} 자동`}
      onChange={event => { const on = event.target.checked; setDraft(d => ({ ...d, autos: { ...d.autos, [field.path]: on },
        values: on || autoMs === null ? d.values : { ...d.values, [field.path]: String(autoMs / 1000) } })); }} /> 자동</label>;
  if (auto) return <span className="lim-input-wrap">
    <span className="lim-field">{toggle}<b className="lim-num" data-edited={fieldChanged(field, draft) || undefined}>{secondsText(autoMs)}</b></span>
    <input type="hidden" name={`value:${field.path}`} value={autoMs === null ? field.initial : String(autoMs / 1000)} />
    <Hidden field={field} draft={draft} />
    <span className="lim-note">= 호출 상한 + {field.autoExtraMs ? `${secondsText(field.autoExtraMs)} + ` : ""}자동 틱 여유</span>
    <OverrideLine field={field} draft={draft} setDraft={setDraft} readOnly={readOnly} />
  </span>;
  return <NumberInput field={field} draft={draft} setDraft={setDraft} readOnly={readOnly} hint={toggle || null} />;
}

/** 호출 시간 막대: 0..상한을 한 줄로, p50(진한 채움)·p99(연한 채움)·최대(세로 눈금) */
function CallBar({ row, capMs }: { row: LimitsRow; capMs: number | null }) {
  const m = row.measure;
  if (!m) return null;
  if (!m.calls) return <span className="lim-barnote">24시간 정산된 호출 없음</span>;
  if (m.calls < 20) return <span className="lim-barnote">24시간 {fmt(m.calls)}건({secondsText(m.p50Ms)}). 판단하기엔 적습니다</span>;
  const pct = (ms: number | null) => capMs && ms !== null ? Math.max(0, Math.min(100, ms / capMs * 100)) : 0;
  const tight = capMs !== null && m.maxMs !== null && m.maxMs >= capMs - 1_000;
  const label = `보통 ${secondsText(m.p50Ms)}, 느린 1% ${secondsText(m.p99Ms)}, 최대 ${secondsText(m.maxMs)}, 상한 ${secondsText(capMs)}`;
  return <>
    {capMs !== null && <span className="lim-bar" data-tight={tight || undefined} role="img" aria-label={label}>
      <span className="lim-bar-p99" style={{ width: `${pct(m.p99Ms)}%` }} /><span className="lim-bar-p50" style={{ width: `${pct(m.p50Ms)}%` }} />
      <span className="lim-bar-max" style={{ left: `${Math.min(99, pct(m.maxMs))}%` }} /></span>}
    <span className="lim-barnote">보통 {secondsText(m.p50Ms)} · 느린 1% {secondsText(m.p99Ms)} · 최대 {secondsText(m.maxMs)}{tight ? " (상한에 닿음)" : ""}</span>
  </>;
}

/** 틱 시간표 — 새 호출을 시작하는 구간과, 늦게 시작한 호출이 상한을 못 채우고 잘리는지 */
function TickLane({ budgetMs, minCallMs, capMs }: { budgetMs: number | null; minCallMs: number | null; capMs: number | null }) {
  if (budgetMs === null || minCallMs === null || capMs === null || budgetMs <= 0) return null;
  const startEnd = Math.max(0, budgetMs - minCallMs), startPct = Math.max(0, Math.min(100, startEnd / budgetMs * 100));
  const cut = minCallMs < capMs;
  const text = `틱 ${secondsText(budgetMs)} — 남은 시간 ${secondsText(minCallMs)} 이상이면 새 호출 시작`;
  return <div className="lim-tick">
    <span className="lim-tick-cap">{text}</span>
    <div className="lim-lane" role="img" aria-label={`${text}. ${cut ? `늦게 시작한 호출은 ${secondsText(minCallMs)}~${secondsText(capMs)} 사이에 잘려 상한을 못 채웁니다` : "시작한 호출은 모두 상한까지 받습니다"}`}>
      <span className="lim-lane-start" style={{ left: 0, width: `${startPct}%` }}>새 호출 시작 (0~{secondsText(startEnd)})</span>
      <span className={cut ? "lim-lane-cut" : "lim-lane-wait"} style={{ left: `${startPct}%`, width: `${100 - startPct}%` }}>
        {cut ? `늦게 시작한 호출은 상한 ${secondsText(capMs)}를 못 채우고 잘림` : `시작한 호출은 모두 ${secondsText(minCallMs)} 이상 받음`}</span>
    </div>
    <div className="lim-scale"><span>0</span><span>{secondsText(startEnd)}</span><span>{secondsText(budgetMs)}</span></div>
  </div>;
}

function MeasureCell({ row }: { row: LimitsRow }) {
  const m = row.measure;
  if (!m) return <span className="lim-muted">측정 없음</span>;
  const cut = m.cutAtCap + m.unknownAtCap;
  return <>
    <span className="lim-stat"><b className="lim-num">{fmt(m.calls)}</b>건</span>
    <span className="lim-stat" data-tone={cut || m.unknown ? "warn" : "zero"}>상한에서 끊김 {fmt(cut)} · 미확정 {fmt(m.unknown)}</span>
    {m.tickCut > 0 && <span className="lim-stat" data-tone="bad">틱 끝에서 끊김 {fmt(m.tickCut)}</span>}
    {m.calls === 0 && m.cancelled > 0 && <span className="lim-stat">보내기 전 취소 {fmt(m.cancelled)}</span>}
  </>;
}

function Row({ row, draft, setDraft, readOnly, fields, marginPath, highlighted }: { row: LimitsRow; draft: Draft; setDraft: FieldProps["setDraft"]; readOnly: boolean;
  fields: Map<string, AnyField>; marginPath: string; highlighted: boolean }) {
  const capMs = liveCapMs(row, draft, fields);
  const changed = [row.cap.kind === "field" ? row.cap.field : null, row.tick.kind === "field" ? row.tick.field : null,
    row.concurrency.kind === "field" ? row.concurrency.field : null, ...row.details].some(field => field && fieldChanged(field, draft));
  const budgetMs = row.tick.kind === "field" ? liveBudgetMs(row.tick.field, draft, fields, marginPath) : null;
  const minCallField = row.minCallPath ? fields.get(row.minCallPath) : undefined;
  const minCallMs = minCallField ? parsed(minCallField, draft.resets[minCallField.path] ? minCallField.defaultInput : draft.values[minCallField.path] ?? minCallField.initial) : null;
  const tickTooShort = budgetMs !== null && capMs !== null && budgetMs < capMs + 2_000;
  const detailsChanged = row.details.some(field => fieldChanged(field, draft));
  return <article id={row.anchor} className="lim-row" data-changed={changed || undefined} data-highlight={highlighted || undefined}>
    <div className="lim-c lim-task"><span className="lim-lbl">작업</span><b>{row.label}</b><span className="lim-sub">{row.sub}</span>
      {row.models && <span className="lim-model">{row.models}</span>}</div>
    <div className="lim-c lim-call"><span className="lim-lbl">한 번 호출 상한</span>
      {row.cap.kind === "field" ? <NumberInput field={row.cap.field} draft={draft} setDraft={setDraft} readOnly={readOnly} />
        : <span className="lim-field"><b className="lim-num">{row.cap.sources ? secondsText(capMs) : row.cap.text}</b><span className="lim-unit">읽기 전용</span></span>}
      {row.cap.note && <span className="lim-note">{row.cap.note}</span>}
      <CallBar row={row} capMs={capMs} /></div>
    <div className="lim-c"><span className="lim-lbl">한 틱 시간</span>
      {row.tick.kind === "field" ? <BudgetInput field={row.tick.field} draft={draft} setDraft={setDraft} readOnly={readOnly} fields={fields} marginPath={marginPath} />
        : <span className="lim-muted">{row.tick.text}</span>}
      {row.tick.kind === "field" && row.tick.field.note && !row.tick.field.declared && <span className="lim-note">{row.tick.field.note}</span>}
      {tickTooShort && <span className="lim-bad-text">틱 시간이 호출 상한 + 2초보다 짧아 저장이 거절됩니다</span>}</div>
    <div className="lim-c"><span className="lim-lbl">동시 호출</span>
      {row.concurrency.kind === "field" ? <NumberInput field={row.concurrency.field} draft={draft} setDraft={setDraft} readOnly={readOnly} compact
        hint={row.slots ? <span className="lim-unit">장비 {row.slots.slots}칸</span> : undefined} />
        : row.concurrency.href ? <Link href={row.concurrency.href} prefetch={false} className="lim-link-muted">{row.concurrency.text}</Link>
          : <span className="lim-muted">{row.concurrency.text}</span>}</div>
    <div className="lim-c"><span className="lim-lbl">24시간</span><MeasureCell row={row} /></div>
    <div className="lim-c"><span className="lim-lbl">상태</span><span><Pill level={row.status.level}>{row.status.text}</Pill></span>
      {row.status.note && <span className="lim-note">{row.status.note}</span>}{row.note && <span className="lim-note">{row.note}</span>}</div>
    {(row.details.length > 0 || row.minCallPath) && <details className="lim-more" open={detailsChanged || highlighted || undefined}>
      <summary>{[row.details.length ? `세부 칸 ${row.details.length}개` : "", row.minCallPath ? "틱 시간표" : ""].filter(Boolean).join(" · ")}
        <span className="lim-muted"> — {row.details.map(field => field.label).join(" · ")}</span></summary>
      <div className="lim-more-grid">
        {row.details.map(field => <div key={field.path} className="lim-f"><span className="lim-f-label">{field.label}</span>
          <NumberInput field={field} draft={draft} setDraft={setDraft} readOnly={readOnly} />
          {field.note && <span className="lim-note">{field.note}</span>}</div>)}
      </div>
      {row.minCallPath && <TickLane budgetMs={budgetMs} minCallMs={minCallMs} capMs={capMs} />}
    </details>}
  </article>;
}

function TodoPanel({ todos, applied, onFill, readOnly, measureError }: { todos: LimitsTodo[]; applied: Set<string>; onFill: (todo: LimitsTodo) => void; readOnly: boolean;
  measureError: string | null }) {
  return <section className="lim-panel" aria-labelledby="todo-title" id="todo">
    <div className="lim-panel-head"><h2 id="todo-title">지금 볼 것</h2><span className="lim-muted">24시간 실측으로 고른 것만 올립니다</span></div>
    {measureError ? <p className="lim-empty" role="note">측정을 읽지 못했습니다 — 실측으로 고르는 항목을 만들 수 없습니다. 아래 칸은 그대로 고치고 저장할 수 있습니다.</p>
      : !todos.length ? <p className="lim-empty">지금 볼 것이 없습니다 — 24시간 실측에서 잘리거나 막힌 호출을 찾지 못했습니다.</p>
        : <div className="lim-todo">{todos.map(todo => <div key={todo.id} className="lim-todo-item">
          <Pill level={todo.level === "info" && todo.tag === "참고" ? "off" : todo.level}>{todo.tag}</Pill>
          <div><b>{todo.task}</b> — {todo.title}</div>
          <div className="lim-todo-act">{todo.fills.length && !readOnly
            ? <button type="button" className={todo.level === "bad" ? "lim-btn lim-btn-primary" : "lim-btn"} onClick={() => onFill(todo)}>{applied.has(todo.id) ? "다시 넣기" : "권장값 넣기"}</button>
            : <a className="lim-link-muted" href={`#row-${todo.rowId}`}>줄 보기</a>}</div>
          <p className="lim-why">{todo.evidence}{applied.has(todo.id) ? " — 칸을 채웠습니다. 아래에서 확인하고 저장을 누르세요." : ""}</p>
        </div>)}</div>}
  </section>;
}

export function LimitsEditor({ view, scope }: { view: LimitsView; scope?: LimitsScope }) {
  const fields = useMemo(() => collectFields(view), [view]);
  const [state, action, pending] = useActionState<LimitsSaveState, FormData>(saveRuntimeLimits, null);
  const [draft, setDraftState] = useState<Draft>(() => initialDraft(fields));
  const [base, setBase] = useState(view.revision);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  // 저장이 받아들여져 판이 바뀌면 그 값이 새 기준이다(새로 그린 칸으로 다시 시작)
  if (base !== view.revision) { setBase(view.revision); setDraftState(initialDraft(fields)); setApplied(new Set()); }
  const setDraft = (update: (draft: Draft) => Draft) => setDraftState(update);
  const readOnly = view.readOnly;
  const marginPath = view.margin.path;
  const changedFields = [...fields.values()].filter(field => fieldChanged(field, draft));
  const changes: FieldChange[] = changedFields.map(field => ({ label: field.label,
    before: isBudget(field) && field.auto ? `자동(${field.initial}초)` : `${field.initial}${field.unit}`,
    after: draft.resets[field.path] ? `기본값(${field.defaultInput}${field.unit})` : isBudget(field) && draft.autos[field.path]
      ? `자동(${secondsText(liveAutoBudget(field, draft, fields, marginPath))})` : `${draft.values[field.path]}${field.unit}` }));
  // 단계 패널: 그 단계의 줄만(빈 묶음은 뺀다), 바뀐 칸을 쓰는 단계
  const groups = scope ? view.groups.map(group => ({ ...group, rows: group.rows.filter(row => scope.rowIds.includes(row.id)) })).filter(group => group.rows.length) : view.groups;
  const todos = scope ? view.todos.filter(todo => scope.rowIds.includes(todo.rowId)) : view.todos;
  const affected = scope ? [...new Set(changedFields.flatMap(field => scope.impact[field.path] ?? []))] : [];
  const fill = (todo: LimitsTodo) => {
    setDraftState(d => {
      const next = { values: { ...d.values }, autos: { ...d.autos }, resets: { ...d.resets } };
      for (const entry of todo.fills) { next.values[entry.path] = entry.value; next.resets[entry.path] = false; if (entry.auto === false) next.autos[entry.path] = false; }
      return next;
    });
    setApplied(previous => new Set(previous).add(todo.id));
    setHighlight(todo.rowId);
    if (typeof document !== "undefined") document.getElementById(`row-${todo.rowId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const reset = () => { setDraftState(initialDraft(fields)); setApplied(new Set()); setHighlight(null); };
  const marginField = view.margin;
  return <form action={action} className="lim-form" data-dirty={changedFields.length > 0 || undefined}>
    <input type="hidden" name="expectedRevision" value={view.revision ?? ""} />
    {groups.flatMap(group => group.rows).some(row => row.cap.kind === "field" && row.cap.field.path === `routes.deadlines.review-gateway.clientMs`) && <>
      <input type="hidden" name="current:routes.deadlines.review-gateway.gatewayMs" value={view.ladder.gatewayMs} />
      <input type="hidden" name="current:routes.deadlines.review-gateway.engineMs" value={view.ladder.engineMs} />
      <input type="hidden" name="current:routes.deadlines.review-gateway.relayMs" value={view.ladder.relayMs} />
    </>}
    {(!scope || todos.length > 0) && <TodoPanel todos={todos} applied={applied} onFill={fill} readOnly={readOnly} measureError={view.measureError} />}
    <section className="lim-panel" aria-labelledby="tasks-title" id="tasks">
      <span id="routes" className="lim-anchor" />
      <div className="lim-panel-head"><h2 id="tasks-title">작업별 한도</h2>
        <span className="lim-muted lim-legend">막대: 0초부터 호출 상한까지 · 진한 색 = 보통(p50) · 연한 색 = 느린 1%(p99) · 세로선 = 24시간 최대</span></div>
      {!scope && <div className="lim-margin">
        <span>「자동」 틱 시간 = 호출 상한 +</span>
        <NumberInput field={marginField} draft={draft} setDraft={setDraft} readOnly={readOnly} compact />
        <span className="lim-muted">(모든 자동 틱이 함께 씁니다)</span>
      </div>}
      <div className="lim-thead" aria-hidden="true"><span>작업 · 지금 모델</span><span>한 번 호출 상한</span><span>한 틱 시간</span><span>동시 호출</span><span>24시간</span><span>상태</span></div>
      {groups.map(group => <div key={group.id} role="group" aria-label={group.label}>
        <div className="lim-group-title">{group.label}</div>
        {group.rows.map(row => <Row key={row.id} row={row} draft={draft} setDraft={setDraft} readOnly={readOnly} fields={fields} marginPath={marginPath} highlighted={highlight === row.id} />)}
      </div>)}
    </section>
    {!scope && <details className="lim-panel lim-fold" id="budgets">
      <summary>AI 밖 작업의 틱 시간 <span className="lim-muted">수집·발행·생존 확인 등 {view.advanced.reduce((sum, group) => sum + group.rows.length, 0)}개 · 고급</span></summary>
      <div className="lim-scroll"><table className="lim-table">
        <thead><tr><th>작업</th><th>한 틱 시간</th><th>지금</th><th>감독 하한</th></tr></thead>
        {view.advanced.map(group => <tbody key={group.role}>
          <tr><th colSpan={4} className="lim-table-group">{group.roleLabel}</th></tr>
          {group.rows.map(row => <tr key={row.job}><td>{row.label}</td>
            <td><BudgetInput field={row.field} draft={draft} setDraft={setDraft} readOnly={readOnly} fields={fields} marginPath={marginPath} /></td>
            <td className="lim-muted">{!row.lane ? "관측 없음" : row.lane.state === "running" ? `도는 중 ${row.lane.ageMs === null ? "" : secondsText(row.lane.ageMs)}` : row.lane.state === "polling" ? "확인 중" : "쉬는 중"}</td>
            <td className="lim-muted">{secondsText(row.supervisorFloorMs)}</td></tr>)}
        </tbody>)}
      </table></div>
    </details>}
    <div className="lim-savebar">
      <div className="lim-savebar-in">
        <span className="lim-save-note" role="status">{readOnly ? "읽기 전용입니다 — 저장할 수 없습니다." : changedFields.length ? `바꾼 값 ${changedFields.length}개 — 저장하면 30초 안에 반영됩니다.` : "바꾼 값이 없습니다."}</span>
        <span className="lim-save-actions">
          {!readOnly && <button type="button" className="lim-btn" onClick={reset} disabled={!changedFields.length || pending}>되돌리기</button>}
          <ConfirmSubmit label="저장" pending={pending} disabled={readOnly || view.revision === null || !changedFields.length} savedKey={view.revision} changes={changes}
            className="lim-btn lim-btn-primary" summary={<>{scope && <>영향을 받는 단계: {affected.length ? affected.join(" · ") : "이 단계"}. </>}저장하면 배포 없이 각 워커가 30초 안에 다음 틱부터 씁니다.</>} />
        </span>
      </div>
      {state?.ok && <p role="status" className="lim-save-ok">{state.message}</p>}
      {state?.issues?.map(text => <p key={text} role="alert" className="lim-bad-text">저장 거절 — {text}</p>)}
    </div>
  </form>;
}
