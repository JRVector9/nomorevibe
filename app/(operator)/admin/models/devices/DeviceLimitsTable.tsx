"use client";

import { Fragment, useActionState, useState, type ReactNode } from "react";
// 형만 가져온다 — 화면 모형 모듈은 서버에서 만든다(그 모듈은 DB 를 읽는 모듈을 부른다)
import type { DeviceTableModelLine, DeviceTableRow } from "@/lib/operations/admin-capacity-device-table-view";
import { retireCapacityDeviceAction, saveDeviceRowAction, type DeviceRowSaveState, type DeviceSaveState } from "./actions";

/**
 * 장비 한도 표(2026-11-09 개편 시안 #devices) — 서버 한 대가 한 줄: 서버 · 모델 · 운영 한도(칸) · 엔진 최대치 · 지금·대기 · 함께 쓰는 작업 · 동작.
 * - 모델이 나뉜 장비(M3 = m3-mlx)는 부모 줄이 전체 공유 한도, 아래 모델마다 모델 한도·엔진 최대치 줄. 모델 한도 합이 공유 한도보다 크면 경고 줄.
 *   부모 줄의 「저장」이 공유 한도와 모델 줄을 한 번에 보낸다(saveDeviceRowAction — 엔진 최대치(physicalLimit)는 바꾸지 않는다).
 * - 「저장」은 그 줄에서 값을 바꿨을 때만 보인다. 표 안의 입력은 form 속성으로 그 줄의 동작 칸에 있는 폼에 붙는다(줄마다 판 CAS).
 * - 지우기는 연결이 없는 장비만 — 삭제 → 「정말 삭제」/취소 두 단계(retireCapacityDeviceAction, confirm=yes·고를 때 본 판). 쓰는 장비는 「사용 중」과 꺼진 단추(title 에 이유).
 * - CLI 장비(Claude·Codex)의 작업별 「모델 ▾ · 추론 강도 ▾」 줄은 이 표가 만들지 않는다 — `cliRows[deviceId]` 로 받은 <tr>(7칸)들을 그 장비 줄 바로 아래에 그린다.
 * 고친 값은 줄마다 들고 있다가 그 줄의 판이 바뀌면(저장·다른 곳의 저장) 새 값으로 다시 시작한다 — 자동 갱신은 고친 값을 덮지 않는다(data-dirty).
 */
export type DeviceCliRows = Readonly<Record<string, ReactNode>>;

const COLS = 7;
const SLOT = /^\d{1,3}$/;
const fmt = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("ko-KR");
const asText = (value: number | null) => value === null ? "" : String(value);
const idOf = (prefix: string, index: number, deviceId: string) => `${prefix}-${index}-${deviceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
/** 「카테고리 분류 외 8」 — 첫 이름 + 나머지 수(전체는 title) */
export const shortTaskList = (tasks: readonly string[]) => !tasks.length ? "—" : tasks.length === 1 ? tasks[0] : `${tasks[0]} 외 ${tasks.length - 1}`;

/** 열 머리 ⓘ — 마우스는 title, 낭독기는 aria-label, 키보드로도 닿는다 */
export function Tip({ text }: { text: string }) {
  return <span className="devlim-tip" role="img" tabIndex={0} title={text} aria-label={`도움말: ${text}`}>i</span>;
}

type LineDraft = { max: string; engine: string };
type Draft = { limit: string; lines: Record<string, LineDraft> };
const stampOf = (row: DeviceTableRow) => `${row.version ?? "none"}#${asText(row.limitSlots)}#${row.lines.map(line => `${line.model}=${asText(line.maxSlots)}/${asText(line.engineMax)}`).join(",")}`;
const draftOf = (row: DeviceTableRow): Draft => ({ limit: asText(row.limitSlots),
  lines: Object.fromEntries(row.lines.map(line => [line.model, { max: asText(line.maxSlots), engine: asText(line.engineMax) }])) });
const sameDraft = (a: Draft, b: Draft) => a.limit.trim() === b.limit.trim()
  && Object.keys(b.lines).every(model => a.lines[model]?.max.trim() === b.lines[model].max.trim() && a.lines[model]?.engine.trim() === b.lines[model].engine.trim());

/** 저장 전에 막을 것 — 숫자 모양만(범위·교차 검사의 기준은 저장 때의 zod 다) */
function draftIssues(draft: Draft, row: DeviceTableRow): string[] {
  const issues: string[] = [];
  const limit = draft.limit.trim();
  if (!SLOT.test(limit) || Number(limit) < 1 || Number(limit) > 256) issues.push(`${row.kind === "models" ? "전체 공유 한도" : "운영 한도"}는 1~256 의 정수로 적어주세요.`);
  for (const line of row.lines) {
    const value = draft.lines[line.model] ?? { max: "", engine: "" };
    if (value.max.trim() !== "" && !SLOT.test(value.max.trim())) issues.push(`${line.name}: 모델 한도는 0 이상의 정수이거나 비워 둡니다.`);
    if (value.engine.trim() !== "" && !SLOT.test(value.engine.trim())) issues.push(`${line.name}: 엔진 최대치는 1 이상의 정수이거나 비워 둡니다(모름).`);
    if (value.max.trim() === "" && value.engine.trim() !== "") issues.push(`${line.name}: 모델 한도를 비우면 그 줄이 지워져 엔진 최대치도 저장되지 않습니다.`);
  }
  return issues;
}

function Messages({ state }: { state: DeviceRowSaveState | DeviceSaveState }) {
  if (!state) return null;
  return <>
    {state.ok && state.message && <p role="status">{state.message}</p>}
    {"changes" in state && state.changes?.length ? <p className="devlim-muted">{state.changes.join(" · ")}</p> : null}
    {"warnings" in state && state.warnings?.map(text => <p key={text} role="note" className="devlim-warn"><span aria-hidden="true">▲ </span>{text}</p>)}
    {state.issues?.map(text => <p key={text} role="alert" className="devlim-refusal">{text}</p>)}
  </>;
}

type RetireProps = { asking: boolean; onAsk: () => void; onCancel: () => void; action: (form: FormData) => void; pending: boolean; onSubmit: () => void };

function RetireControl({ row, retire }: { row: DeviceTableRow; retire: RetireProps }) {
  if (!row.retirable) return <>
    {row.kind !== "orphan" && <span className="devlim-why">사용 중</span>}
    <button type="button" className="devlim-btn" disabled title={row.retireReason ?? undefined} aria-label={`${row.name} 삭제 — ${row.retireReason ?? "지울 수 없음"}`}>삭제</button>
  </>;
  if (!retire.asking) return <button type="button" className="devlim-btn devlim-danger" onClick={retire.onAsk} aria-label={`${row.name} 삭제`}>삭제</button>;
  return <form action={retire.action} onSubmit={retire.onSubmit} className="devlim-confirm" role="group" aria-label={`${row.name} 삭제 확인`} data-dirty="">
    <input type="hidden" name="confirm" value="yes" />
    <input type="hidden" name="deviceId" value={row.deviceId} />
    <input type="hidden" name="expectedVersion" value={row.version ?? ""} />
    <span>{row.name} 행을 지웁니다</span>
    <button type="submit" className="devlim-btn devlim-danger devlim-solid" disabled={retire.pending}>{retire.pending ? "지우는 중…" : "정말 삭제"}</button>
    <button type="button" className="devlim-btn" onClick={retire.onCancel} disabled={retire.pending} autoFocus>취소</button>
  </form>;
}

function NumberInput({ value, onChange, label, formId, name, placeholder, changed }: { value: string; onChange: (value: string) => void; label: string; formId: string;
  name: string; placeholder?: string; changed: boolean }) {
  return <input type="text" inputMode="numeric" className="devlim-input" form={formId} name={name} value={value} placeholder={placeholder} aria-label={label}
    data-changed={changed ? "" : undefined} onChange={event => onChange(event.target.value)} autoComplete="off" maxLength={4} />;
}

/** 서버 한 대의 줄들 — 부모 줄, (모델이 나뉘었으면) 모델 줄·경고 줄, 끼워 넣은 CLI 줄, 결과 줄 */
function DeviceRows({ row, index, extra, retire, retireMessage }: { row: DeviceTableRow; index: number; extra?: ReactNode; retire: RetireProps; retireMessage: ReactNode }) {
  const [state, action, pending] = useActionState<DeviceRowSaveState, FormData>(saveDeviceRowAction, null);
  const [draft, setDraft] = useState<Draft>(() => draftOf(row));
  const stamp = stampOf(row);
  const [seen, setSeen] = useState(stamp);
  if (seen !== stamp) { setSeen(stamp); setDraft(draftOf(row)); }
  const initial = draftOf(row);
  const changed = !sameDraft(draft, initial);
  const issues = changed ? draftIssues(draft, row) : [];
  const formId = idOf("devlim-save", index, row.deviceId);
  const models = row.kind === "models";
  const setLine = (model: string, patch: Partial<LineDraft>) => setDraft(previous =>
    ({ ...previous, lines: { ...previous.lines, [model]: { ...(previous.lines[model] ?? { max: "", engine: "" }), ...patch } } }));
  const limitNumber = SLOT.test(draft.limit.trim()) ? Number(draft.limit.trim()) : null;
  const sum = row.lines.reduce((total, line) => { const value = draft.lines[line.model]?.max.trim() ?? ""; return total + (SLOT.test(value) ? Number(value) : 0); }, 0);
  const over = models && limitNumber !== null && sum > limitNumber;
  const limitLabel = models ? `${row.name} 전체 공유 한도` : `${row.name} 운영 한도`;
  return <>
    <tr data-device={row.deviceId} data-kind={row.kind} className={models || row.kind === "cli" ? "devlim-parent" : row.kind === "orphan" ? "devlim-stale" : undefined}
      data-dirty={changed ? "" : undefined}>
      <th scope="row" className="devlim-server" title={row.name !== row.deviceId ? `장비 id ${row.deviceId}` : undefined}>
        <span className="devlim-name">{row.name}</span>{row.sub && <small>{row.sub}</small>}
        {!row.enabled && <small className="devlim-warn">꺼짐</small>}
        {row.issues.length > 0 && <small className="devlim-warn" title={row.issues.join("\n")}>▲ 문제 {row.issues.length}</small>}
      </th>
      <td>{models ? <span className="devlim-muted">모델 {row.lines.length}개가 한 서버를 나눠 씀</span>
        : row.kind === "cli" ? <span className="devlim-muted">아래 작업별</span>
        : row.models.length ? <span title={row.models.join("\n")}>{row.models.length > 2 ? `${row.models.slice(0, 2).join(" · ")} 외 ${row.models.length - 2}` : row.models.join(" · ")}
          {row.modelFixed && <span className="devlim-fixed" title="이 연결이 모델을 정합니다 — 고르는 칸이 없습니다">고정</span>}</span>
        : <span className="devlim-muted">—</span>}</td>
      <td>{row.editable
        ? <span className="devlim-lim"><NumberInput value={draft.limit} onChange={limit => setDraft(previous => ({ ...previous, limit }))} label={limitLabel} formId={formId}
            name="limitSlots" placeholder={row.limitSlots === null ? "필수" : undefined} changed={draft.limit.trim() !== initial.limit} />
          {models && <span className="devlim-tag">전체 공유</span>}</span>
        : <span className="devlim-num" title={row.editReason ?? undefined}>{fmt(row.limitSlots)}</span>}</td>
      <td>{models ? <span className="devlim-muted">모델별</span> : row.kind === "plain" ? (row.engineMax === null ? <span className="devlim-muted">미설정</span> : <span className="devlim-num">{fmt(row.engineMax)}</span>)
        : <span className="devlim-muted">—</span>}</td>
      <td className="devlim-r devlim-num">{row.active === null ? <span className="devlim-muted" title="실시간 상태를 읽지 못했습니다">—</span>
        : <>{fmt(row.active)} · <span className={row.waiting ? "devlim-wait" : undefined}>{fmt(row.waiting)}</span></>}</td>
      <td>{models ? <span className="devlim-muted">아래 모델별</span> : <span title={row.tasks.join(" · ") || undefined}>{shortTaskList(row.tasks)}</span>}</td>
      <td><div className="devlim-acts">
        {row.editable && <form id={formId} action={action}>
          <input type="hidden" name="deviceId" value={row.deviceId} />
          <input type="hidden" name="expectedVersion" value={row.version ?? ""} />
          {models && <><input type="hidden" name="modelLimits" value="1" />{row.lines.map(line => <input key={line.model} type="hidden" name="model" value={line.model} />)}</>}
          <button type="submit" className="devlim-btn devlim-primary" hidden={!changed} disabled={pending || issues.length > 0} aria-label={`${row.name} 저장`}>{pending ? "저장 중…" : "저장"}</button>
        </form>}
        <RetireControl row={row} retire={retire} />
      </div></td>
    </tr>
    {models && row.lines.map(line => <ModelLineRow key={line.model} line={line} row={row} formId={formId} draft={draft.lines[line.model] ?? { max: "", engine: "" }}
      initial={initial.lines[line.model] ?? { max: "", engine: "" }} onChange={patch => setLine(line.model, patch)} />)}
    {over && <tr className="devlim-hint"><td colSpan={COLS}><span aria-hidden="true">▲ </span>모델 한도 합 <b>{fmt(sum)}</b>이 전체 공유 <b>{fmt(limitNumber)}</b>보다 큽니다. 공유 한도가 먼저 막습니다.</td></tr>}
    {extra}
    {(issues.length > 0 || state || retireMessage) && <tr className="devlim-msg"><td colSpan={COLS}>
      {issues.map(text => <p key={text} role="alert" className="devlim-refusal">{text}</p>)}
      <Messages state={state} />
      {retireMessage}
    </td></tr>}
  </>;
}

function ModelLineRow({ line, row, formId, draft, initial, onChange }: { line: DeviceTableModelLine; row: DeviceTableRow; formId: string; draft: LineDraft; initial: LineDraft;
  onChange: (patch: Partial<LineDraft>) => void }) {
  return <tr className="devlim-child" data-parent={row.deviceId} data-model={line.model}>
    <th scope="row" className="devlim-server"><span className="devlim-name">{line.name}</span>{!line.exposed && <small>켜진 연결이 내놓지 않음</small>}</th>
    <td className="devlim-model">{line.model}</td>
    <td>{row.editable
      ? <NumberInput value={draft.max} onChange={max => onChange({ max })} label={`${line.name} ${line.model} 모델 한도`} formId={formId} name={`max:${line.model}`}
          placeholder="없음" changed={draft.max.trim() !== initial.max} />
      : <span className="devlim-num">{line.maxSlots === null ? "없음" : fmt(line.maxSlots)}</span>}</td>
    <td>{row.editable
      ? <NumberInput value={draft.engine} onChange={engine => onChange({ engine })} label={`${line.name} ${line.model} 엔진 최대치`} formId={formId} name={`engine:${line.model}`}
          placeholder="모름" changed={draft.engine.trim() !== initial.engine} />
      : <span className="devlim-num">{line.engineMax === null ? "모름" : fmt(line.engineMax)}</span>}</td>
    <td className="devlim-r devlim-num">{line.active === null ? <span className="devlim-muted">—</span>
      : <>{fmt(line.active)} · <span className={line.waiting ? "devlim-wait" : undefined}>{fmt(line.waiting)}</span></>}</td>
    <td><span title={line.tasks.join(" · ") || undefined}>{shortTaskList(line.tasks)}</span></td>
    <td />
  </tr>;
}

/**
 * 표 하나. `cliRows` — 장비 id → 그 CLI 장비 줄 바로 아래에 그릴 <tr>(7칸)들(작업별 모델·추론 강도 줄, 다른 구성 요소가 만든다).
 * 지우기 결과는 표가 들고 있다 — 지운 장비는 다시 그릴 때 줄이 사라지므로 성공 문장은 표 위에, 거절은 그 장비 줄 아래에 보인다.
 */
export function DeviceLimitsTable({ rows, cliRows }: { rows: readonly DeviceTableRow[]; cliRows?: DeviceCliRows }) {
  const [retireState, retireAction, retirePending] = useActionState<DeviceSaveState, FormData>(retireCapacityDeviceAction, null);
  const [asking, setAsking] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  // 결과가 오면(지움·거절) 확인 칸을 닫는다 — 거절 이유는 그 장비 줄 아래에 남는다
  const [seenRetire, setSeenRetire] = useState(retireState);
  if (seenRetire !== retireState) { setSeenRetire(retireState); setAsking(null); }
  const submittedRow = submitted === null ? null : rows.find(row => row.deviceId === submitted) ?? null;
  return <div className="devlim-wrap">
    {retireState && (!submittedRow || retireState.ok) && <div className="devlim-msg-block"><Messages state={retireState} /></div>}
    <div className="devlim-scroll" role="region" aria-label="서버별 한도 표" tabIndex={0}>
      <table className="devlim-table">
        <caption className="admin-vh">서버별 운영 한도 — 서버 · 모델 · 운영 한도 · 엔진 최대치 · 지금 실행과 대기 · 함께 쓰는 작업 · 동작</caption>
        <thead><tr>
          <th scope="col">서버</th>
          <th scope="col">모델</th>
          <th scope="col">운영 한도 <Tip text="그 서버의 모든 작업이 함께 쓰는 동시 실행 수입니다. 저장하면 다음 입장부터 쓰고, 엔진 최대치를 넘을 수 없습니다." /></th>
          <th scope="col">엔진 최대치 <Tip text="엔진이 실제로 받는 최대 동시 요청 수(서버 설정값). 이 표의 저장은 바꾸지 않습니다 — 세부 설정에서 고칩니다. 모델이 나뉜 서버는 모델마다 적습니다." /></th>
          <th scope="col" className="devlim-r">지금 · 대기 <Tip text="지금 = 예약+진행 중인 호출, 대기 = 칸을 기다리는 요청. 미확인 행은 세지 않습니다." /></th>
          <th scope="col">함께 쓰는 작업</th>
          <th scope="col" className="devlim-r">동작</th>
        </tr></thead>
        <tbody>{rows.map((row, index) => <Fragment key={row.deviceId}>
          <DeviceRows row={row} index={index} extra={cliRows?.[row.deviceId]}
            retire={{ asking: asking === row.deviceId, onAsk: () => setAsking(row.deviceId), onCancel: () => setAsking(null), action: retireAction, pending: retirePending,
              onSubmit: () => setSubmitted(row.deviceId) }}
            retireMessage={submitted === row.deviceId && retireState && !retireState.ok ? <Messages state={retireState} /> : null} />
        </Fragment>)}</tbody>
      </table>
    </div>
  </div>;
}
