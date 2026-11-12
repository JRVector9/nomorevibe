"use client";

import Link from "next/link";
import { Fragment, useActionState, useState, type CSSProperties, type ReactNode } from "react";
// 형만 가져온다 — 화면 모형은 서버에서 만든다(클라이언트는 만든 값만 받는다). 갈래 이름표는 import 없는 상수 모듈에서
import { ALLOCATION_SECTIONS } from "@/lib/operations/capacity-allocation-sections";
import type { AllocationCell, AllocationDevice, AllocationRow, AllocationView } from "@/lib/operations/capacity-allocation-view";
import { deviceModelsText } from "@/lib/operations/llm-display";
import { llmAllocationAnchor } from "@/lib/operations/llm-ops-links";
import { ConfirmSubmit, type FieldChange } from "../ConfirmSubmit";
import { LevelBadge, ObservedAt } from "../LlmOpsParts";
import { saveRouteQuotasAction, type RouteQuotaSaveState } from "./actions";

type CellDraft = { min: string; max: string };
type DeviceDraft = { key: string; lendIdle: boolean; cells: Record<string, CellDraft> };
type Drafts = Record<string, DeviceDraft>;

const fmt = (value: number) => value.toLocaleString("ko-KR");
/** 칸 수 글자 — 세 자리 정수(저장 폼 routeQuotasInputFromForm 과 같은 규칙) */
const SLOT = /^\d{1,3}$/;
const DEVICES_HREF = "/admin/models/devices";
/** 장비 열 하나의 판 — 판·칸이 있는 경로가 바뀌면(저장·정책 개정) 그 장비의 고친 값을 버리고 새 값으로 다시 시작한다 */
const deviceKey = (device: AllocationDevice) => `${device.version}#${device.routes.join(",")}`;
const formIdOf = (device: AllocationDevice, index: number) => `alloc-form-${index}-${device.deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
const initialCell = (cell: AllocationCell): CellDraft => ({ min: cell.minSlots === null ? "" : String(cell.minSlots), max: cell.maxSlots === null ? "" : String(cell.maxSlots) });
/** 장비 하나가 차지하는 열 수(연결마다 가른 장비는 연결 수) */
const spanOf = (device: AllocationDevice) => Math.max(1, device.columns.length);

/** 화면에 그리는 줄 — 낡은 정책 경로만 남은 줄(stale)은 「숨긴 옛 경로」로 접는다(저장 폼에는 넣지 않는다) */
const shownRows = (view: AllocationView) => view.rows.filter(row => !row.stale);

function deviceDraft(view: AllocationView, index: number): DeviceDraft {
  const device = view.devices[index];
  const cells: Record<string, CellDraft> = {};
  for (const row of shownRows(view)) { const cell = row.cells[index]; if (cell) cells[row.routeId] = initialCell(cell); }
  return { key: deviceKey(device), lendIdle: device.lendIdle, cells };
}
const draftsOf = (view: AllocationView): Drafts => Object.fromEntries(view.devices.map((device, index) => [device.deviceId, deviceDraft(view, index)]));

/** 칸 하나의 문제(저장 전에 막는다) — 숫자 모양·장비 칸 수·보장 ≤ 상한. 범위·합계의 기준은 저장(zod + 잠근 장비 행)이다 */
function cellIssue(draft: CellDraft, limit: number): string | null {
  if (draft.min !== "" && !SLOT.test(draft.min)) return "보장은 0 이상의 정수로 적어주세요";
  if (draft.max !== "" && !SLOT.test(draft.max)) return "상한은 0 이상의 정수로 적어주세요";
  const min = draft.min === "" ? 0 : Number(draft.min), max = draft.max === "" ? null : Number(draft.max);
  if (min > limit) return `보장이 한도 ${fmt(limit)}칸보다 많습니다`;
  if (max !== null && max > limit) return `상한이 한도 ${fmt(limit)}칸보다 많습니다`;
  if (max !== null && min > max) return "보장이 상한보다 많습니다";
  return null;
}
const minOf = (draft: CellDraft) => SLOT.test(draft.min) ? Number(draft.min) : 0;
/** 줄 하나의 글(저장 결과·감사와 같은 말 — capacity-allocation-view routeQuotaText). 보장 0·상한 없음 = 「없음」(오늘과 같음) */
function draftText(draft: CellDraft): string {
  const min = draft.min === "" ? "0" : draft.min, max = draft.max;
  if (min === "0" && max === "") return "없음";
  return `보장 ${min} · 상한 ${max === "" ? "없음" : max === "0" ? "0(뺌)" : max}`;
}
/** 칸의 열 이름(입력 이름표) — 갈린 장비는 그 연결 이름, 아니면 장비 이름 */
const columnName = (device: AllocationDevice, place: number | null) => place !== null && device.columns[place] ? device.columns[place].name : device.groupName ?? device.name;

function SlotInput({ kind, value, limit, label, formId, invalid, onChange, name }: { kind: "min" | "max"; value: string; limit: number; label: string; formId: string;
  invalid: boolean; onChange: (value: string) => void; name: string }) {
  return <label className="alloc-field" data-kind={kind}>
    <span aria-hidden="true">{kind === "min" ? "보" : "상"}</span>
    <input type="number" inputMode="numeric" min={0} max={limit} step={1} name={name} form={formId} value={value}
      placeholder="–" aria-label={`${label} ${kind === "min" ? "보장 칸" : "상한 칸"}`} aria-invalid={invalid || undefined}
      onChange={event => onChange(event.target.value)} />
  </label>;
}

function CellView({ row, cell, device, place, draft, formId, readOnly, onChange }: { row: AllocationRow; cell: AllocationCell; device: AllocationDevice; place: number | null;
  draft: CellDraft; formId: string; readOnly: boolean; onChange: (patch: Partial<CellDraft>) => void }) {
  const issue = readOnly ? null : cellIssue(draft, device.limitSlots);
  const off = draft.max !== "" && SLOT.test(draft.max) && Number(draft.max) === 0;
  const label = `${row.label} · ${columnName(device, place)}`;
  const changed = draftText(draft) !== draftText(initialCell(cell));
  return <div className="alloc-cell" data-off={off || undefined}
    title={`최근 1시간 ${fmt(cell.settled1h)}건${cell.failed1h > 0 ? ` · 실패 ${fmt(cell.failed1h)}` : ""}${cell.cap !== null ? ` · 지금 상한 ${fmt(cell.cap)}` : ""}`}>
    {readOnly ? <span className="alloc-pair alloc-ro">
        <span className="alloc-field" data-kind="min"><span aria-hidden="true">보</span><span className="admin-vh">보장</span><b>{draft.min === "" ? "–" : draft.min}</b></span>
        <span className="alloc-field" data-kind="max"><span aria-hidden="true">상</span><span className="admin-vh">상한</span><b>{draft.max === "" ? "–" : draft.max}</b></span></span>
      : <span className="alloc-pair">
        <SlotInput kind="min" name={`min:${row.routeId}`} value={draft.min} limit={device.limitSlots} label={label} formId={formId} invalid={!!issue} onChange={min => onChange({ min })} />
        <SlotInput kind="max" name={`max:${row.routeId}`} value={draft.max} limit={device.limitSlots} label={label} formId={formId} invalid={!!issue} onChange={max => onChange({ max })} />
        {issue && <span className="alloc-issue" title={issue}><span aria-hidden="true">▲</span><span className="admin-vh">{issue}</span></span>}
      </span>}
    {(off || !cell.mapped) && <span className="alloc-tags">
      {off && <LevelBadge level="idle">이 장비에서 뺌</LevelBadge>}
      {!cell.mapped && <LevelBadge level="warn" title="정책이 이 작업을 이 장비로 보내지 않습니다. 두 칸을 비우고 저장하면 몫이 지워집니다.">정책 경로 없음</LevelBadge>}
    </span>}
    {changed && <span className="admin-vh">바뀜 · 저장 전</span>}
    <span className="alloc-use">지금 {fmt(cell.active)} · <span data-waiting={cell.waiting > 0 || undefined}>대기 {fmt(cell.waiting)}</span>
      {cell.held > 0 ? ` · 비워 둠 ${fmt(cell.held)}` : ""}</span>
  </div>;
}

function DeviceFooter({ device, index, view, draft, readOnly, onLend }: { device: AllocationDevice; index: number; view: AllocationView; draft: DeviceDraft; readOnly: boolean;
  onLend: (value: boolean) => void }) {
  const [state, action, pending] = useActionState<RouteQuotaSaveState, FormData>(saveRouteQuotasAction, null);
  const cells = shownRows(view).flatMap(row => { const cell = row.cells[index]; return cell ? [{ row, cell, draft: draft.cells[row.routeId] ?? initialCell(cell) }] : []; });
  const sum = cells.reduce((total, entry) => total + minOf(entry.draft), 0);
  const over = sum > device.limitSlots;
  const firstIssue = cells.map(entry => ({ row: entry.row, issue: cellIssue(entry.draft, device.limitSlots) })).find(entry => entry.issue !== null);
  const changes: FieldChange[] = [
    ...(draft.lendIdle !== device.lendIdle ? [{ label: "빈 칸 빌려 쓰기", before: device.lendIdle ? "켬" : "끔", after: draft.lendIdle ? "켬" : "끔" }] : []),
    ...cells.flatMap(({ row, cell, draft: now }) => { const before = draftText(initialCell(cell)), after = draftText(now);
      return before === after ? [] : [{ label: row.label, before, after }]; }),
  ];
  const formId = formIdOf(device, index);
  return <div className="alloc-foot">
    <span className="alloc-sum" data-over={over || undefined}>보장 합 <b>{fmt(sum)}</b> / {fmt(device.limitSlots)}</span>
    {readOnly ? <span className="llm-muted">빈 칸 빌려 쓰기 {device.lendIdle ? "켬" : "끔"}</span>
      : <form id={formId} action={action} className="alloc-form" aria-label={`${device.groupName ?? device.name} 칸 배분 저장`} data-dirty={changes.length ? "" : undefined}>
        <input type="hidden" name="deviceId" value={device.deviceId} />
        <input type="hidden" name="expectedVersion" value={device.version} />
        {cells.map(({ row }) => <input key={row.routeId} type="hidden" name="route" value={row.routeId} />)}
        <label className="alloc-lend" title="빈 칸 빌려 쓰기 — 켜 두면 일이 없는 작업의 보장 칸을 다른 작업이 상한까지 빌려 씁니다. 끄면 보장 칸은 일이 없어도 비워 둡니다.">
          <input type="checkbox" name="lendIdle" checked={draft.lendIdle} disabled={pending} onChange={event => onLend(event.target.checked)}
            aria-label={`${device.name} 빈 칸 빌려 쓰기`} /><span>빌려 쓰기</span></label>
        {over ? <span className="alloc-issue" role="alert"><span aria-hidden="true">▲ </span>보장 합이 한도를 넘습니다</span>
          : firstIssue ? <span className="alloc-issue" role="alert"><span aria-hidden="true">▲ </span>{firstIssue.row.label}: {firstIssue.issue}</span>
          : changes.length > 0 ? <span className="alloc-changed">바뀜 {fmt(changes.length)}칸</span> : null}
        <ConfirmSubmit label="저장" pending={pending} disabled={over || !!firstIssue || changes.length === 0} changes={changes} savedKey={device.version}
          className="button primary small" summary="다음 입장부터 바로 쓰입니다. 이미 잡힌 칸은 그대로 끝납니다(DRAIN 불필요)." />
      </form>}
    {state?.ok && <div role="status" className="alloc-result"><span>{state.message}</span>
      {state.changes?.length ? <ul>{state.changes.map(line => <li key={line}>{line}</li>)}</ul> : null}</div>}
    {state?.warnings?.map(text => <p key={text} role="note" className="alloc-issue"><span aria-hidden="true">▲ </span>{text}</p>)}
    {state?.issues?.map(text => <p key={text} role="alert" className="alloc-refusal">{text}</p>)}
  </div>;
}

/** 장비 열 머리 — 한 열이면 이름·모델·한도·지금·대기, 연결마다 가른 장비는 「묶음 이름 · 공유 한도 N」(아래 줄에 연결 열 머리) */
function DeviceHead({ device, rowSpan }: { device: AllocationDevice; rowSpan: number }) {
  const title = [device.name !== device.deviceId ? `장비 id ${device.deviceId}` : "", device.modelLimits].filter(Boolean).join("\n") || undefined;
  const use = <span className="alloc-dev-use">지금 <b>{fmt(device.active)}</b> · 대기 <b>{fmt(device.waiting)}</b></span>;
  if (device.columns.length) return <th scope="colgroup" colSpan={device.columns.length} id={llmAllocationAnchor(device.deviceId)} className="alloc-dev alloc-dev-group" title={title}>
    <span><span className="alloc-dev-name">{device.groupName}</span> · 공유 한도 <b>{fmt(device.limitSlots)}</b></span>{use}
  </th>;
  return <th scope="col" rowSpan={rowSpan > 1 ? rowSpan : undefined} id={llmAllocationAnchor(device.deviceId)} className="alloc-dev" title={title}>
    <span className="alloc-dev-name">{device.name}</span>
    {device.models.length > 0 && <span className="alloc-dev-label" title={device.models.join("\n")}>{deviceModelsText(device.models, 2)}</span>}
    <span className="alloc-dev-use">한도 <b>{fmt(device.limitSlots)}</b></span>{use}
  </th>;
}

function NoneCell({ title }: { title: string }) {
  return <td className="alloc-na" title={title}><span aria-hidden="true">·</span><span className="admin-vh">{title}</span></td>;
}

/**
 * 칸 배분표(step 3, 2026-11-09 승인 시안 #alloc) — 줄 = 작업 영역(용량 경로, 갈래별), 열 = 서버(연결 이름 + 모델). 연결마다 가른 장비(M3)는 「M3 · 공유 한도 N」
 * 묶음 아래 연결 열들이고 저장은 하나다. 칸은 한 줄 「보 / 상」 입력 둘, 지금·대기는 「칸마다 지금·대기 보기」를 켰을 때만 보인다.
 * 열 아래가 그 장비의 저장 폼이다(보장 합 / 한도, 빌려 쓰기, 바뀐 칸 수, 저장) — 표 안의 입력은 form 속성으로 그 장비의 폼에 붙어 그 장비만 보낸다(판 CAS).
 * 접힌 보조 작업 줄도 폼에 붙어 있다(숨겨도 값은 보낸다). 고친 값은 장비마다 들고 있다가 그 장비의 판이 바뀌면(저장·다른 곳의 저장) 새 값으로 다시 시작한다 —
 * 자동 갱신은 고친 값을 덮지 않는다(data-dirty).
 */
export function AllocationMatrix({ view, readOnly }: { view: AllocationView; readOnly: boolean }) {
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(view));
  const [showUse, setShowUse] = useState(false);
  const [showStale, setShowStale] = useState(false);
  const [helperOpen, setHelperOpen] = useState(false);
  const stamp = view.devices.map(device => `${device.deviceId}#${deviceKey(device)}`).join("|");
  const [seen, setSeen] = useState(stamp);
  if (seen !== stamp) {
    setSeen(stamp);
    setDrafts(previous => Object.fromEntries(view.devices.map((device, index) => {
      const kept = previous[device.deviceId];
      return [device.deviceId, kept && kept.key === deviceKey(device) ? kept : deviceDraft(view, index)];
    })));
  }
  const draftOf = (device: AllocationDevice, index: number) => drafts[device.deviceId] ?? deviceDraft(view, index);
  const setCell = (device: AllocationDevice, index: number, routeId: string, patch: Partial<CellDraft>) => setDrafts(previous => {
    const current = previous[device.deviceId] ?? deviceDraft(view, index);
    const cell = current.cells[routeId] ?? { min: "", max: "" };
    return { ...previous, [device.deviceId]: { ...current, cells: { ...current.cells, [routeId]: { ...cell, ...patch } } } };
  });
  const setLend = (device: AllocationDevice, index: number, lendIdle: boolean) => setDrafts(previous =>
    ({ ...previous, [device.deviceId]: { ...(previous[device.deviceId] ?? deviceDraft(view, index)), lendIdle } }));
  const cellDraft = (row: AllocationRow, index: number, cell: AllocationCell) => draftOf(view.devices[index], index).cells[row.routeId] ?? initialCell(cell);
  const cellChanged = (row: AllocationRow, index: number, cell: AllocationCell) => draftText(cellDraft(row, index, cell)) !== draftText(initialCell(cell));
  const rowChanged = (row: AllocationRow) => row.cells.some((cell, index) => !!cell && cellChanged(row, index, cell));
  const rowIssue = (row: AllocationRow) => row.cells.some((cell, index) => !!cell && cellIssue(cellDraft(row, index, cell), view.devices[index].limitSlots) !== null);

  const lines = view.devices.reduce((total, device) => total + device.lines, 0);
  const rows = shownRows(view), hidden = view.rows.filter(row => row.stale);
  const sections = ALLOCATION_SECTIONS.map(section => ({ ...section, rows: rows.filter(row => row.section === section.id) })).filter(section => section.rows.length > 0);
  const split = view.devices.some(device => device.columns.length > 0);
  const columnCount = view.devices.reduce((total, device) => total + spanOf(device), 0);
  const helperRows = rows.filter(row => row.section === "helper");
  const helperChanged = helperRows.filter(rowChanged).length, helperBad = helperRows.some(rowIssue);
  // 보조 작업 줄에 고칠 칸이 있으면 접지 않는다 — 저장 단추가 왜 잠겼는지 보여야 한다
  const helperShown = helperOpen || helperBad;

  const cellsOf = (row: AllocationRow, stale: boolean): ReactNode[] => view.devices.flatMap((device, index) => {
    const cell = row.cells[index], place = row.place[index] ?? null, span = spanOf(device);
    const none = (column: number) => <NoneCell key={`${device.deviceId}#${column}`}
      title={device.columns.length ? `이 작업을 ${device.columns[column].name}(으)로 보내지 않음` : "이 장비를 쓰지 않음"} />;
    if (!cell) return Array.from({ length: span }, (_, column) => none(column));
    const changed = !stale && cellChanged(row, index, cell);
    const content = <CellView row={row} cell={cell} device={device} place={place} draft={stale ? initialCell(cell) : cellDraft(row, index, cell)} formId={formIdOf(device, index)}
      readOnly={readOnly || stale} onChange={patch => setCell(device, index, row.routeId, patch)} />;
    if (place === null || !device.columns.length) return [<td key={device.deviceId} colSpan={span > 1 ? span : undefined} data-changed={changed || undefined}>{content}</td>];
    return Array.from({ length: span }, (_, column) => column === place
      ? <td key={`${device.deviceId}#${column}`} data-changed={changed || undefined}>{content}</td> : none(column));
  });
  const rowView = (row: AllocationRow, section: string, stale = false, rowHidden = false) =>
    <tr key={row.routeId} data-group={section} hidden={rowHidden || undefined}>
      <th scope="row" className="alloc-area" title={row.routeId}>
        <span className="alloc-area-in"><span className="alloc-area-name">{section === "helper" ? row.label.replace(/^보조 · /, "") : row.label}</span>
          {row.calls1h > 0 && <span className="alloc-calls" title={`최근 1시간 정산 ${fmt(row.calls1h)}건${row.failed1h ? ` · 실패 ${fmt(row.failed1h)}건` : ""}`}>{fmt(row.calls1h)}
            {row.failed1h > 0 && <span className="alloc-failed"> · 실패 {fmt(row.failed1h)}</span>}</span>}</span>
      </th>
      {cellsOf(row, stale)}
    </tr>;

  return <div className="stack llm-ops alloc" data-llm-page="allocation">
    <div className="alloc-top">
      <p className="llm-totals"><span>서버 <b>{fmt(view.devices.length)}</b></span><span>작업 <b>{fmt(rows.length)}</b></span><span>몫을 둔 칸 <b>{fmt(lines)}</b></span>
        <ObservedAt label="장부 관측" at={view.observedAt} /></p>
      <p className="alloc-legend"><span className="alloc-key" data-kind="min" aria-hidden="true">보</span> 보장: 일이 있으면 늘 남겨 두는 칸 ·{" "}
        <span className="alloc-key" data-kind="max" aria-hidden="true">상</span> 상한: 한 번에 쓰는 최대(비우면 없음, 0이면 뺌) · 둘 다 비우면 오늘과 같고, 저장하면 다음 입장부터 씁니다.</p>
    </div>
    {view.errors.map(error => <p key={error} role="alert" className="llm-notice">{error}</p>)}
    {view.skipped.length > 0 && <p className="llm-empty">장비 행이 없거나 꺼진 장비 {fmt(view.skipped.length)}대(<span title={view.skipped.map(entry => entry.deviceId).join(", ")}>{view.skipped.map(entry => entry.name).join(", ")}</span>)는 칸을 나눌 수 없어 뺐습니다 —{" "}
      <Link prefetch={false} href={`${DEVICES_HREF}#new`} className="llm-link">장비 한도에서 행을 먼저 저장 →</Link></p>}
    {view.orphans.length > 0 && <p className="llm-empty">연결도 쓰임도 없는 장비 {fmt(view.orphans.length)}대({view.orphans.join(", ")})는 뺐습니다 —{" "}
      <Link prefetch={false} href={DEVICES_HREF} className="llm-link">장비 한도에서 보기 →</Link></p>}
    {view.devices.length === 0 ? <p className="llm-empty">{view.errors.length ? "장비 상태를 읽지 못해 배분표를 그리지 못했습니다." : "칸을 나눌 장비가 없습니다 — 정책 경로가 가는 장비 행이 없습니다."}</p>
      : <>
        <div className="alloc-tools">
          <label><input type="checkbox" checked={showUse} onChange={event => setShowUse(event.target.checked)} /> 칸마다 지금·대기 보기</label>
          {hidden.length > 0 && <label title={hidden.map(row => `${row.label} (${row.routeId})`).join("\n")}>
            <input type="checkbox" checked={showStale} onChange={event => setShowStale(event.target.checked)} /> 숨긴 옛 경로 {fmt(hidden.length)}개 보기</label>}
        </div>
        <section id="allocation" className="alloc-wrap" aria-label="칸 배분표" data-dirty={view.devices.some((device, index) => draftOf(device, index).lendIdle !== device.lendIdle)
          || rows.some(rowChanged) ? "" : undefined}>
          <table className="alloc-table" data-show-use={showUse || undefined} style={{ "--alloc-cols": columnCount } as CSSProperties}>
            <caption className="admin-vh">작업 × 서버 칸 배분 — 칸마다 보장(보)·상한(상). 「·」은 정책이 그 작업을 그 서버로 보내지 않는 칸입니다. 저장은 서버마다 열 아래에서 합니다.</caption>
            <colgroup><col className="alloc-col-area" />{Array.from({ length: columnCount }, (_, column) => <col key={column} className="alloc-col-dev" />)}</colgroup>
            <thead>
              <tr>
                <th scope="col" rowSpan={split ? 2 : undefined} className="alloc-area">작업<span className="alloc-area-sub">1시간 호출</span></th>
                {view.devices.map(device => <DeviceHead key={device.deviceId} device={device} rowSpan={split ? 2 : 1} />)}
              </tr>
              {split && <tr>{view.devices.flatMap(device => device.columns.map(column => <th key={`${device.deviceId}#${column.connectionId}`} scope="col"
                className="alloc-dev alloc-dev-sub" title={column.models.join("\n") || undefined}>
                <span className="alloc-dev-name">{column.name}</span>
                {column.models.length > 0 && <span className="alloc-dev-label">{deviceModelsText(column.models, 2)}</span>}
                <span className="alloc-dev-use">모델 한도 <b>{column.modelLimit === null ? "없음" : fmt(column.modelLimit)}</b></span>
                {column.active !== null && <span className="alloc-dev-use">지금 <b>{fmt(column.active)}</b> · 대기 <b>{fmt(column.waiting ?? 0)}</b></span>}
              </th>))}</tr>}
            </thead>
            <tbody>
              {sections.map(section => <Fragment key={section.id}>
                <tr className="alloc-group" data-group={section.id}><th scope="rowgroup" colSpan={columnCount + 1}>
                  {section.id === "helper"
                    ? <span className="alloc-group-in"><button type="button" className="alloc-fold" aria-expanded={helperShown} onClick={() => setHelperOpen(open => !open)}>
                        <span className="alloc-chev" aria-hidden="true">▶</span>{section.label} {fmt(section.rows.length)}</button>
                      <span className="alloc-group-note">{helperBad ? "▲ 고칠 칸이 있어 펼쳐 둡니다" : "연결 확인·저장소 이동·소개 재검수·판정 감사 등 LLM 보조 경로"}</span>
                      {helperChanged > 0 && <span className="alloc-changed">바뀜 {fmt(helperChanged)}줄</span>}</span>
                    : <span className="alloc-group-in">{section.label}</span>}
                </th></tr>
                {section.rows.map(row => rowView(row, section.id, false, section.id === "helper" && !helperShown))}
              </Fragment>)}
              {hidden.length > 0 && showStale && <>
                <tr className="alloc-group" data-group="stale"><th scope="rowgroup" colSpan={columnCount + 1}><span className="alloc-group-in">옛 경로
                  <span className="alloc-group-note">지금 연결이 내놓지 않는 모델로만 남은 정책 경로 — 몫·호출이 없고 저장하지 않습니다</span></span></th></tr>
                {hidden.map(row => rowView(row, "stale", true))}
              </>}
            </tbody>
            <tfoot><tr>
              <th scope="row" className="alloc-area">보장 합 / 한도<span className="alloc-area-sub">저장은 서버마다</span></th>
              {view.devices.map((device, index) => <td key={device.deviceId} colSpan={spanOf(device) > 1 ? spanOf(device) : undefined}>
                <DeviceFooter device={device} index={index} view={view} draft={draftOf(device, index)} readOnly={readOnly} onLend={value => setLend(device, index, value)} />
              </td>)}
            </tr></tfoot>
          </table>
        </section></>}
    <p className="llm-empty">2차 AI 검수 투표자 1·2·3은 한 경로(<code>second-review</code>)라 한 줄입니다. 장비 칸 수·모델 한도는{" "}
      <Link prefetch={false} href={DEVICES_HREF} className="llm-link">장비 한도</Link>, 작업이 어느 모델로 가는지는{" "}
      <Link prefetch={false} href="/admin/models#tasks" className="llm-link">작업 배정</Link>에서 바꿉니다.</p>
  </div>;
}
