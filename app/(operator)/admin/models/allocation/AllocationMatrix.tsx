"use client";

import Link from "next/link";
import { Fragment, useActionState, useState, type CSSProperties } from "react";
// 형만 가져온다 — 화면 모형 모듈은 서버에서 만든다(클라이언트는 만든 값만 받는다)
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
/** 장비 열 하나의 판 — 판·칸이 있는 경로가 바뀌면(저장·정책 개정) 그 열의 고친 값을 버리고 새 값으로 다시 시작한다 */
const deviceKey = (device: AllocationDevice) => `${device.version}#${device.routes.join(",")}`;
const formIdOf = (device: AllocationDevice, index: number) => `alloc-form-${index}-${device.deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
const initialCell = (cell: AllocationCell): CellDraft => ({ min: cell.minSlots === null ? "" : String(cell.minSlots), max: cell.maxSlots === null ? "" : String(cell.maxSlots) });

/** 화면에 그리는 줄 — 낡은 정책 경로만 남은 줄(stale)은 숨긴다(저장 폼에도 넣지 않는다) */
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

function SlotInput({ kind, value, limit, label, formId, onChange, name }: { kind: "min" | "max"; value: string; limit: number; label: string; formId: string;
  onChange: (value: string) => void; name: string }) {
  return <label className="alloc-field" data-kind={kind}>
    <span aria-hidden="true">{kind === "min" ? "보장" : "상한"}</span>
    <input type="number" inputMode="numeric" min={0} max={limit} step={1} name={name} form={formId} value={value}
      placeholder="없음" aria-label={`${label} ${kind === "min" ? "보장 칸" : "상한 칸"}`}
      onChange={event => onChange(event.target.value)} />
  </label>;
}

function CellView({ row, cell, device, draft, formId, readOnly, onChange }: { row: AllocationRow; cell: AllocationCell; device: AllocationDevice; draft: CellDraft;
  formId: string; readOnly: boolean; onChange: (patch: Partial<CellDraft>) => void }) {
  const issue = cellIssue(draft, device.limitSlots);
  const off = draft.max !== "" && SLOT.test(draft.max) && Number(draft.max) === 0;
  const label = `${row.label} · ${device.name}`;
  const changed = draftText(draft) !== draftText(initialCell(cell));
  return <div className="alloc-cell" data-off={off || undefined} data-changed={changed || undefined}>
    {readOnly ? <span className="alloc-pair alloc-ro">
        <span className="alloc-field" data-kind="min"><span>보장</span><b>{draft.min === "" ? "없음" : draft.min}</b></span>
        <span className="alloc-field" data-kind="max"><span>상한</span><b>{draft.max === "" ? "없음" : draft.max}</b></span></span>
      : <span className="alloc-pair">
        <SlotInput kind="min" name={`min:${row.routeId}`} value={draft.min} limit={device.limitSlots} label={label} formId={formId} onChange={min => onChange({ min })} />
        <SlotInput kind="max" name={`max:${row.routeId}`} value={draft.max} limit={device.limitSlots} label={label} formId={formId} onChange={max => onChange({ max })} />
      </span>}
    <span className="alloc-use" title="지금 이 경로가 이 장비에서 쥔 칸(예약+진행) · 현재 세대 대기 · 최근 1시간 정산">
      지금 {fmt(cell.active)} · 대기 {fmt(cell.waiting)}{cell.held > 0 ? ` · 비워 둠 ${fmt(cell.held)}` : ""}</span>
    <span className="alloc-use">1시간 {fmt(cell.settled1h)}건{cell.failed1h > 0 ? ` · 실패 ${fmt(cell.failed1h)}` : ""}</span>
    {off && <LevelBadge level="idle">이 장비에서 뺌</LevelBadge>}
    {!cell.mapped && <LevelBadge level="warn" title="정책이 이 작업을 이 장비로 보내지 않습니다. 두 칸을 비우고 저장하면 몫이 지워집니다.">정책 경로 없음</LevelBadge>}
    {issue && <span className="alloc-issue" role="alert"><span aria-hidden="true">▲ </span>{issue}</span>}
    {changed && !issue && <span className="alloc-changed">바뀜 · 저장 전</span>}
  </div>;
}

function DeviceFooter({ device, index, view, draft, readOnly, onLend }: { device: AllocationDevice; index: number; view: AllocationView; draft: DeviceDraft; readOnly: boolean;
  onLend: (value: boolean) => void }) {
  const [state, action, pending] = useActionState<RouteQuotaSaveState, FormData>(saveRouteQuotasAction, null);
  const cells = shownRows(view).flatMap(row => { const cell = row.cells[index]; return cell ? [{ row, cell, draft: draft.cells[row.routeId] ?? initialCell(cell) }] : []; });
  const sum = cells.reduce((total, entry) => total + minOf(entry.draft), 0);
  const over = sum > device.limitSlots;
  const invalid = cells.some(entry => cellIssue(entry.draft, device.limitSlots) !== null);
  const changes: FieldChange[] = [
    ...(draft.lendIdle !== device.lendIdle ? [{ label: "빈 칸 빌려 쓰기", before: device.lendIdle ? "켬" : "끔", after: draft.lendIdle ? "켬" : "끔" }] : []),
    ...cells.flatMap(({ row, cell, draft: now }) => { const before = draftText(initialCell(cell)), after = draftText(now);
      return before === after ? [] : [{ label: row.label, before, after }]; }),
  ];
  const percent = device.limitSlots > 0 ? Math.min(100, Math.round(sum / device.limitSlots * 100)) : 0;
  const formId = formIdOf(device, index);
  return <div className="alloc-foot">
    <span className="alloc-sum" data-over={over || undefined}><span className="llm-muted">보장 합</span> <b>{fmt(sum)}</b> / {fmt(device.limitSlots)}</span>
    <span className="llm-bar" data-level={over ? "warn" : undefined} aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
    {over && <span className="alloc-issue" role="alert"><span aria-hidden="true">▲ </span>보장 합이 한도를 넘습니다 — 저장할 수 없습니다</span>}
    {readOnly ? <span className="llm-muted">빈 칸 빌려 쓰기 {device.lendIdle ? "켬" : "끔"}</span>
      : <form id={formId} action={action} className="alloc-form" aria-label={`${device.name} 칸 배분 저장`} data-dirty={changes.length ? "" : undefined}>
        <input type="hidden" name="deviceId" value={device.deviceId} />
        <input type="hidden" name="expectedVersion" value={device.version} />
        {cells.map(({ row }) => <input key={row.routeId} type="hidden" name="route" value={row.routeId} />)}
        <label className="alloc-lend"><input type="checkbox" name="lendIdle" checked={draft.lendIdle} disabled={pending} onChange={event => onLend(event.target.checked)}
          aria-label={`${device.name} 빈 칸 빌려 쓰기`} /><span>빈 칸 빌려 쓰기</span></label>
        {changes.length > 0 && <span className="alloc-changed">저장 안 한 변경 {fmt(changes.length)}칸</span>}
        <ConfirmSubmit label="저장" pending={pending} disabled={over || invalid} changes={changes} savedKey={device.version}
          className="button primary small" summary="다음 입장부터 바로 쓰입니다. 이미 잡힌 칸은 그대로 끝납니다(DRAIN 불필요)." />
      </form>}
    {state?.ok && <div role="status" className="alloc-result"><span>{state.message}</span>
      {state.changes?.length ? <ul>{state.changes.map(line => <li key={line}>{line}</li>)}</ul> : null}</div>}
    {state?.warnings?.map(text => <p key={text} role="note" className="alloc-issue"><span aria-hidden="true">▲ </span>{text}</p>)}
    {state?.issues?.map(text => <p key={text} role="alert" className="alloc-refusal">{text}</p>)}
  </div>;
}

/**
 * 칸 배분표(step 3) — 줄 = 작업 영역(용량 경로), 열 = 장비 행이 있는 장비. 칸마다 보장·상한 입력과 지금 점유·대기·최근 1시간 정산.
 * 열 아래가 그 장비의 저장 폼이다(보장 합 / 한도, 빈 칸 빌려 쓰기, 저장) — 표 안의 입력은 form 속성으로 그 열의 폼에 붙어 그 장비만 보낸다(판 CAS).
 * 고친 값은 장비 열마다 들고 있다가 그 열의 판이 바뀌면(저장·다른 곳의 저장) 새 값으로 다시 시작한다 — 자동 갱신은 고친 값을 덮지 않는다(data-dirty).
 */
export function AllocationMatrix({ view, readOnly }: { view: AllocationView; readOnly: boolean }) {
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(view));
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
  const lines = view.devices.reduce((total, device) => total + device.lines, 0);
  const rows = shownRows(view), hidden = view.rows.filter(row => row.stale);
  const firstHelper = rows.findIndex(row => row.group === "helper");
  return <div className="stack llm-ops alloc" data-llm-page="allocation">
    <div className="llm-toolbar">
      <p className="llm-totals"><span>장비 <b>{fmt(view.devices.length)}</b></span><span>작업 영역 <b>{fmt(rows.length)}</b></span>
        <span>몫을 둔 칸 <b>{fmt(lines)}</b></span></p>
      <ObservedAt label="장부 관측" at={view.observedAt} />
    </div>
    {view.errors.map(error => <p key={error} role="alert" className="llm-notice">{error}</p>)}
    <ul className="alloc-explain" aria-label="칸 배분 읽는 법">
      <li><b data-kind="min">보장 칸</b> 그 작업 영역에 일이 있으면 늘 비워 두는 칸입니다. 장비마다 보장 합은 한도를 넘을 수 없습니다.</li>
      <li><b data-kind="max">상한 칸</b> 한 번에 쓸 수 있는 최대 칸입니다. 비우면 상한이 없고, 0 이면 이 장비에서 뺍니다. 상한에 닿은 일은 기다리지 않고 다음 순위 모델로 넘어갑니다.</li>
      <li><b>빈 칸 빌려 쓰기</b> 켜 두면(기본) 일이 없는 영역의 보장 칸을 다른 영역이 상한까지 빌려 씁니다. 끄면 보장이 있는 영역은 보장 칸까지만 쓰고, 그 칸은 일이 없어도 비워 둡니다.</li>
      <li>두 칸을 모두 비우면 오늘과 같습니다 — 장비 한도 안에서 장비 역할 순서와 먼저 온 순서대로 나눠 씁니다. 저장은 장비마다 따로 하고, 다음 입장부터 바로 쓰입니다(DRAIN 불필요).</li>
    </ul>
    {view.skipped.length > 0 && <p className="llm-empty">장비 행이 없거나 꺼진 장비 {fmt(view.skipped.length)}대(<span title={view.skipped.map(entry => entry.deviceId).join(", ")}>{view.skipped.map(entry => entry.name).join(", ")}</span>)는 칸을 나눌 수 없어 뺐습니다 —{" "}
      <Link prefetch={false} href={`${DEVICES_HREF}#new`} className="llm-link">장비 한도에서 행을 먼저 저장 →</Link></p>}
    {view.orphans.length > 0 && <p className="llm-empty">연결도 쓰임도 없는 장비 {fmt(view.orphans.length)}대({view.orphans.join(", ")})는 뺐습니다 —{" "}
      <Link prefetch={false} href={DEVICES_HREF} className="llm-link">장비 한도에서 보기 →</Link></p>}
    {hidden.length > 0 && <p className="llm-empty" title={hidden.map(row => row.routeId).join(", ")}>지금 연결이 내놓지 않는 모델로만 남은 옛 정책 경로 {fmt(hidden.length)}개를 숨겼습니다({hidden.map(row => row.label).join(", ")}).</p>}
    {view.devices.length === 0 ? <p className="llm-empty">{view.errors.length ? "장비 상태를 읽지 못해 배분표를 그리지 못했습니다." : "칸을 나눌 장비가 없습니다 — 정책 경로가 가는 장비 행이 없습니다."}</p>
      : <section id="allocation" className="alloc-wrap" aria-label="칸 배분표" data-dirty={view.devices.some((device, index) => {
          const draft = draftOf(device, index);
          return draft.lendIdle !== device.lendIdle || rows.some(row => { const cell = row.cells[index]; return !!cell && draftText(draft.cells[row.routeId] ?? initialCell(cell)) !== draftText(initialCell(cell)); });
        }) ? "" : undefined}>
        <table className="alloc-table" style={{ "--alloc-cols": view.devices.length } as CSSProperties}>
          <caption className="admin-vh">작업 영역 × 장비 칸 배분 — 칸마다 보장·상한, 지금 점유·대기와 최근 1시간 정산. 「—」는 정책이 그 작업을 그 장비로 보내지 않는 곳입니다.</caption>
          <thead><tr>
            <th scope="col" className="alloc-area">작업 영역</th>
            {view.devices.map(device => <th key={device.deviceId} scope="col" id={llmAllocationAnchor(device.deviceId)} className="alloc-dev"
              title={device.name !== device.deviceId ? `장비 id ${device.deviceId}` : undefined}>
              <span className="alloc-dev-name">{device.name}</span>
              {device.models.length > 0 && <span className="alloc-dev-label" title={device.models.join("\n")}>{deviceModelsText(device.models)}</span>}
              <span className="alloc-dev-limit">한도 {fmt(device.limitSlots)}</span>
              <span className="alloc-dev-use">지금 {fmt(device.active)} · 대기 {fmt(device.waiting)}</span>
            </th>)}
          </tr></thead>
          <tbody>{rows.map((row, rowIndex) => <Fragment key={row.routeId}>
            {rowIndex === firstHelper && <tr className="alloc-group" data-group="helper"><th scope="rowgroup" colSpan={view.devices.length + 1} className="alloc-area">
              <span className="alloc-area-name">보조 작업</span><span className="alloc-route">LLM 보조(연결 확인·저장소 이동·소개 재검수·판정 감사 등)가 장비마다 쓰는 경로</span></th></tr>}
            <tr data-group={row.group === "helper" ? "helper" : undefined}>
            <th scope="row" className="alloc-area"><span className="alloc-area-name">{row.label}</span>
              {row.label !== row.routeId && <code className="alloc-route">{row.routeId}</code>}</th>
            {view.devices.map((device, index) => { const cell = row.cells[index];
              return <td key={device.deviceId}>{cell
                ? <CellView row={row} cell={cell} device={device} draft={draftOf(device, index).cells[row.routeId] ?? initialCell(cell)} formId={formIdOf(device, index)}
                  readOnly={readOnly} onChange={patch => setCell(device, index, row.routeId, patch)} />
                : <span className="alloc-none" title="정책이 이 작업을 이 장비로 보내지 않습니다">—<span className="admin-vh">이 장비를 쓰지 않음</span></span>}</td>; })}
          </tr></Fragment>)}</tbody>
          <tfoot><tr>
            <th scope="row" className="alloc-area">보장 합 / 한도{!readOnly && <span className="alloc-route">빌려 쓰기 · 저장은 장비마다</span>}</th>
            {view.devices.map((device, index) => <td key={device.deviceId}>
              <DeviceFooter device={device} index={index} view={view} draft={draftOf(device, index)} readOnly={readOnly} onLend={value => setLend(device, index, value)} />
            </td>)}
          </tr></tfoot>
        </table>
      </section>}
    <p className="llm-empty">2차 AI 검수 투표자 1·2·3은 같은 실행 경로(<code>second-review</code>)를 써서 한 줄로 나눕니다. 칸은 정책이 그 작업을 그 장비로 보낼 때만 있고, 「비워 둠」은 일이 있는
      영역의 못 채운 보장 칸입니다. 장비 칸 수·역할 순서는 <Link prefetch={false} href={DEVICES_HREF} className="llm-link">장비 한도</Link>에서, 작업이 어느 모델로 가는지는{" "}
      <Link prefetch={false} href="/admin/models/tasks" className="llm-link">작업 배정</Link>에서 바꿉니다.</p>
  </div>;
}
