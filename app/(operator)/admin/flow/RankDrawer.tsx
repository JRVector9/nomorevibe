"use client";

import "./rank-drawer.css";
import "./rank-drawer-rows.css";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AI_RANK_SLOT_NAMES, type AiRankChoice } from "@/lib/operations/admin-ai-tasks";
import {
  flowOptionBlocked, flowRankIssues, needsAcknowledge, rankChainText, rankChanges, rankDeviceImpact, rankForm, rankResaves, rankWarnings, SET_ONLY_TEXT,
  type FlowRankEditor, type FlowRankLine, type RankChange, type RankDeviceLimit, type RankWarning,
} from "@/lib/operations/flow-rank-editor";
import { RankSelects } from "../models/RankSelects";
import { SelectedModelProbe } from "../models/SelectedModelProbe";
import { modelPickerConnectionDevice, modelPickerConnectionLabel, modelPickerModelLabel, modelPickerVisibleText } from "../models/model-picker-display";
import { saveAiTaskRanksAction } from "../models/tasks/actions";
import { aiTaskWorkloadPoolApiOnly } from "@/lib/llm/ai-task-execution-config";
import { aiTaskEditTarget } from "@/lib/operations/ai-task-edit-target";

/**
 * 「바꾸기」 서랍(2026-11-04 5차, 2026-11-07 작업 배정 PR 4) — 작업의 처리 LLM 1·2·3순위를 그 자리에서 바꾸는 단 하나의 순위 편집기.
 * 운영 홈(/admin/flow)의 칸 「바꾸기」와 작업 배정(/admin/models/tasks)의 줄 「바꾸기」가 이 서랍을 연다(예전 작업 화면의 줄마다 펼치던 순위판은 없앴다).
 * 차례: ① 고르기(작업마다 RankSelects — 모델과 추론 강도, 같은 선택 상자·값 열쇠) → ② 확인(전→후, 장비 한도와 함께 쓰는 작업, 경고, 위험하면 확인 칸) → ③ 저장됨(결과 · 되돌리기).
 * 저장은 예전 순위판과 같은 서버 동작(saveAiTaskRanksAction)을 같은 폼 칸으로 부른다 — 새 쓰기 경로가 없다. 작업 로그(ai-task-models-save)에 전·후가 남고
 * 「최근 바뀐 설정」에 보인다. 되돌리기는 직전 순위를 같은 길로 다시 저장한다(확인 단계를 다시 거친다 — 2차 투표자 되돌리기도 재심사를 일으키므로).
 * 순위를 바꾸지 않아도 빠진 계약·경로·장비가 있는 줄(pending)은 「다시 저장」을 골라 같은 길로 다시 저장한다(예전 순위판의 「다시 저장」).
 */
type Step = "edit" | "confirm" | "saving" | "done";
type Result = { key: string; label: string; ok: boolean; text: string; warnings: string[]; issues: string[]; beforeText: string; afterText: string };
type Ranks = readonly (AiRankChoice | null)[];

/** 서버 동작 — 시험·시안은 바꿔 끼운다(기본은 「작업 ↔ AI 모델」 줄 저장) */
export type RankSave = (previous: null, form: FormData) => Promise<{ ok?: true; message?: string; issues?: string[]; warnings?: string[] } | null>;

const STEPS: { key: Step; text: string }[] = [{ key: "edit", text: "모델·추론 강도 고르기" }, { key: "confirm", text: "바뀌는 내용 확인" }, { key: "done", text: "저장됨" }];
/** 운영 홈에서 열었을 때 「모든 작업 보기」 링크(작업 배정 화면 안에서 열면 null) */
const TASKS_FULL_VIEW = "/admin/models/tasks#tasks";
/** 작업 배정 화면의 실행 방식 접힘 안 그 작업 칸(작업 분산 구성원·실행 방식을 바꾸는 곳) */
const modeHref = (line: Pick<FlowRankLine, "task" | "slot">) => `/admin/models/tasks#mode-${line.task}-${line.slot}`;

function lineTag(line: FlowRankLine): { text: string; tone: "lock" | "set" | "live" } {
  if (line.execution?.mode === "workload_pool") return { text: `작업 분산 · 모델 ${line.execution.members.length}개`, tone: "live" };
  if (aiTaskWorkloadPoolApiOnly(line.task)) return { text: "기존 CLI 분류", tone: "live" };
  if (line.lock) return { text: "바꿀 수 없음", tone: "lock" };
  if (!line.live) return { text: "설정값", tone: "set" };
  return { text: "실행이 이 순위를 읽음", tone: "live" };
}

/** Presentation names only; rank validation and form values retain the original connections. */
function displayRankChain(editor: FlowRankEditor, ranks: Ranks): string {
  return rankChainText({ ...editor, connections: editor.connections.map(connection => ({
    ...connection, label: modelPickerConnectionLabel(connection),
  })) }, ranks.map(row => {
    const connection = editor.connections.find(entry => entry.id === row?.provider);
    return row && connection ? { ...row, model: modelPickerModelLabel(connection, row.model) } : row;
  })).replaceAll(" → ", "\n");
}

function WarningList({ warnings }: { warnings: RankWarning[] }) {
  if (!warnings.length) return null;
  return <ul className="fr-warns">{warnings.map((warning) => (
    <li key={`${warning.code}-${warning.line}`} className="fr-warn" data-tone={warning.tone} data-code={warning.code} data-existing={warning.existing ? "yes" : undefined}>
      <span aria-hidden="true">{warning.tone === "bad" ? "■" : "▲"}</span> {warning.text}</li>))}</ul>;
}

/** ① 고르기 — 작업 한 줄 */
function LineEditor({ editor, line, value, onChange, warnings, disabled, resave, onResave, onNavigate }: {
  editor: FlowRankEditor; line: FlowRankLine; value: Ranks; onChange: (value: (AiRankChoice | null)[]) => void; warnings: RankWarning[]; disabled: boolean;
  resave: boolean; onResave: (checked: boolean) => void; onNavigate: () => void;
}) {
  const tag = lineTag(line);
  const pool = line.execution?.mode === "workload_pool" ? line.execution : null;
  const apiOnly = aiTaskWorkloadPoolApiOnly(line.task);
  const nonLiveTarget = !line.live && line.task !== "publish-classify" ? aiTaskEditTarget(line.task) : null;
  const changed = !nonLiveTarget && rankChanges(editor, [line], { [line.key]: value }).length > 0;
  return (
    <section className="fr-line" data-key={line.key} data-tag={tag.tone} aria-labelledby={`fr-line-${line.key}`}>
      <header className="fr-line-h">
        <h4 id={`fr-line-${line.key}`}>{line.label}</h4>
        <span className="fr-tag" data-tone={tag.tone}>{tag.text}</span>
        {changed && <span className="fr-tag" data-tone="changed">바꿈 — 저장 전</span>}
      </header>
      {pool ? <>
        <ul className="fr-note">{pool.members.map(member => {
          const connection = editor.connections.find(row => row.id === member.connectionId);
          return <li key={member.memberId}>모델 {member.position} · {connection ? modelPickerConnectionLabel(connection) : "연결 없음"} · {connection ? modelPickerModelLabel(connection, member.model) : member.model}
            {typeof member.options.reasoningEffort === "string" && ` · 추론 ${member.options.reasoningEffort}`}
            <SelectedModelProbe key={JSON.stringify([member.connectionId, member.model, member.options.reasoningEffort])} choice={{ provider: member.connectionId, model: member.model, ...(typeof member.options.reasoningEffort === "string" ? { reasoningEffort: member.options.reasoningEffort } : {}) }} disabled={disabled || !!line.lock} /></li>;
        })}</ul>
        <p className="fr-note">업무마다 모델 하나를 골라 나눠 처리합니다. 동시 실행 수는 단계·장비 한도를 따릅니다.</p>
        <Link href={modeHref(line)} prefetch={false} className="fr-link" onClick={onNavigate}>분산 모델·실행 방식 변경 →</Link>
      </> : apiOnly ? <>
        <p className="fr-note">기존 CLI 분류를 사용합니다.</p>
        <Link href={modeHref(line)} prefetch={false} className="fr-link" onClick={onNavigate}>API 분산 모델 설정 →</Link>
      </> : nonLiveTarget ? <p className="fr-now"><span className="fr-k">실제 적용 설정</span> <Link href={nonLiveTarget.href} prefetch={false} className="fr-link">{nonLiveTarget.label} →</Link></p>
        : <p className="fr-now"><span className="fr-k">지금</span> {displayRankChain(editor, line.saved)}</p>}
      {line.lock && <p className="fr-lock" role="note">{line.lock}</p>}
      {!pool && !apiOnly && !nonLiveTarget && <RankSelects<AiRankChoice> stage={{ id: `flow-${line.key}`, label: line.label, slots: 3 }} options={line.options} connections={editor.connections} value={value} onChange={onChange}
        slotNames={AI_RANK_SLOT_NAMES} disabled={disabled || !!line.lock}
        showProvider={false} note={null} blocked={(option, index, slots) => flowOptionBlocked(editor, line, index, option, slots)}
        validate={(slots) => changed ? flowRankIssues(editor, line, slots) : []} layout="rows"
        renderAfterSlot={(row) => <SelectedModelProbe key={JSON.stringify([row.provider, row.model, row.reasoningEffort])} choice={row} disabled={disabled || !!line.lock} />} />}
      {!line.live && !line.lock && !apiOnly && !nonLiveTarget && <p className="fr-note">{SET_ONLY_TEXT}</p>}
      {!pool && !apiOnly && !nonLiveTarget && !!line.notes?.length && <ul className="fr-warns" aria-label={`${line.label} 저장된 순위의 막힘·알림`}>{line.notes.map((note) =>
        <li key={`${note.tone}:${note.text}`} className="fr-warn" data-tone={note.tone} data-note="readiness"><span aria-hidden="true">{note.tone === "bad" ? "■" : "▲"}</span> {modelPickerVisibleText(note.text, editor.connections)}</li>)}</ul>}
      {!pool && !apiOnly && !nonLiveTarget && !line.lock && !changed && !!line.pending?.length && line.saved.length > 0 && <div className="fr-resave" data-resave={line.key}>
        <span>빠진 것이 있습니다 — 순위를 그대로 다시 저장하면 만듭니다.</span>
        <ul>{line.pending.map((text) => <li key={text}>{modelPickerVisibleText(text, editor.connections)}</li>)}</ul>
        <label><input type="checkbox" checked={resave} disabled={disabled} onChange={(event) => onResave(event.target.checked)} />바꾸지 않고 다시 저장</label>
      </div>}
      {!pool && <WarningList warnings={warnings} />}
    </section>
  );
}

/** ② 확인 — 전 → 후 표 */
function ChangeTable({ changes }: { changes: RankChange[] }) {
  return (
    <table className="fr-diff">
      <colgroup><col className="fr-c-task" /><col /><col /></colgroup>
      <thead><tr><th scope="col">작업</th><th scope="col">전</th><th scope="col">후</th></tr></thead>
      <tbody>{changes.map((change) => <tr key={change.line.key} data-key={change.line.key}>
        <th scope="row">{change.line.label}</th>
        <td className="fr-before">{change.beforeText}</td>
        <td className="fr-after" data-empty={change.after.some(Boolean) ? undefined : "yes"}>{change.resave ? `다시 저장(순위 그대로)\n${change.afterText}` : change.afterText}</td>
      </tr>)}</tbody>
    </table>
  );
}

/** ② 확인 — 저장 뒤 순위가 가리키는 장비의 한도·점유와, 같은 장비를 나눠 쓰는 다른 작업 */
function DeviceImpact({ editor, changes, devices }: { editor: FlowRankEditor; changes: RankChange[]; devices: readonly RankDeviceLimit[] | null }) {
  const impact = rankDeviceImpact(editor, changes, devices);
  if (!impact.length) return null;
  const visible = (text: string) => modelPickerVisibleText(text, editor.connections);
  return <section className="fr-devices" aria-labelledby="fr-devices-title">
    <h4 id="fr-devices-title">장비 한도 · 함께 쓰는 작업</h4>
    <table className="fr-conn-table fr-device-table">
      <thead><tr><th scope="col">장비</th><th scope="col">한도</th><th scope="col">함께 쓰는 다른 작업</th></tr></thead>
      <tbody>{impact.map((row) => <tr key={row.deviceId} data-device={row.deviceId}>
        <th scope="row">{visible(row.deviceId)}{row.connections.some((name) => name !== row.deviceId)
          && <span className="fr-note"> · {row.connections.filter((name) => name !== row.deviceId).map(visible).join(" · ")}</span>}</th>
        <td>{row.create !== null ? `장비 행 없음 — 저장하면 ${row.create}칸으로 만듭니다` : row.limit !== null ? `${row.held ?? 0} / ${row.limit}칸 사용 중` : "확인 불가"}</td>
        <td>{row.sharing.length ? row.sharing.join(" · ") : "없음"}</td>
      </tr>)}</tbody>
    </table>
    <p className="fr-note">한도는 장비 하나를 모든 작업이 나눠 씁니다. 바꾸려면 <Link href="/admin/models/llm" prefetch={false} className="fr-link">LLM 운영 →</Link></p>
  </section>;
}

export function RankDrawer({ editor, lines, title, secondWaiting, onClose, save = saveAiTaskRanksAction as RankSave, initial, fullViewHref = TASKS_FULL_VIEW,
  devices = null, lockReason = null }: {
  editor: FlowRankEditor; lines: FlowRankLine[]; title: string; secondWaiting: number | null; onClose: () => void; save?: RankSave;
  /** 시험용 — 처음 단계와 고른 값, 다시 저장할 줄 */
  initial?: { step?: Step; drafts?: Record<string, (AiRankChoice | null)[]>; resave?: string[] };
  /** 「작업 배정에서 전체 보기」 링크 — 작업 배정 화면 안에서 열면 null */
  fullViewHref?: string | null;
  /** 장비 한도(장부 관측). null = 모름 — 확인 단계에 장비 이름과 함께 쓰는 작업만 보인다 */
  devices?: readonly RankDeviceLimit[] | null;
  /** 저장할 수 없는 까닭(예: 실행 방식을 읽지 못함) — 있으면 저장 단추를 잠근다 */
  lockReason?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [drafts, setDrafts] = useState<Record<string, (AiRankChoice | null)[]>>(initial?.drafts ?? {});
  const [step, setStep] = useState<Step>(initial?.step ?? "edit");
  const [mode, setMode] = useState<"change" | "undo">("change");
  const [ack, setAck] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [undo, setUndo] = useState<{ key: string; ranks: AiRankChoice[] }[]>([]);
  const [resave, setResave] = useState<ReadonlySet<string>>(() => new Set(initial?.resave ?? []));
  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open && typeof node.showModal === "function") node.showModal();
  }, []);
  const value = (line: FlowRankLine): Ranks => drafts[line.key] ?? line.saved;
  const changes = [...rankChanges(editor, lines, drafts), ...(mode === "change" ? rankResaves(editor, lines, drafts, resave) : [])].map(change => ({ ...change,
    beforeText: displayRankChain(editor, change.before), afterText: displayRankChain(editor, change.after),
  }));
  const warnings = rankWarnings(editor, lines, drafts, { secondWaiting });
  const changedKeys = new Set(changes.map((change) => change.line.key));
  const issues = changes.flatMap((change) => flowRankIssues(editor, change.line, change.after));
  const mustAck = needsAcknowledge(warnings);
  // 확인 단계는 바꾼 줄의 경고와, 바꾸지 않았어도 바꾼 결과로 생기는 경고를 함께 보인다
  const confirmWarnings = warnings.filter((warning) => changedKeys.has(warning.line) || !warning.existing);

  const close = () => { if (step !== "saving") onClose(); };
  const toConfirm = () => { setAck(false); setStep("confirm"); };
  const submit = async () => {
    setStep("saving");
    const done: Result[] = [];
    const saved: { key: string; ranks: AiRankChoice[] }[] = [];
    for (const change of changes) {
      const base = { key: change.line.key, label: change.line.label, beforeText: change.beforeText, afterText: change.afterText };
      let answer: Awaited<ReturnType<RankSave>> = null;
      try {
        answer = await save(null, rankForm(change.line, change.after));
      } catch {
        answer = { issues: ["저장 요청이 서버에 닿지 않았습니다 — 다시 누르기 전에 「최근 바뀐 설정」에서 저장됐는지 보세요."] };
      }
      const ok = !!answer?.ok;
      done.push({ ...base, ok, text: answer?.message ?? "", warnings: answer?.warnings ?? [], issues: answer?.issues ?? (ok ? [] : ["저장하지 못했습니다."]) });
      if (!ok) break;
      if (!change.resave) saved.push({ key: change.line.key, ranks: change.before });
    }
    setResults(done);
    setUndo(mode === "change" ? saved : []);
    setResave(new Set());
    setStep("done");
  };
  const startUndo = () => {
    setDrafts(Object.fromEntries(undo.map((row) => [row.key, row.ranks])));
    setMode("undo"); setAck(false); setStep("confirm");
  };
  const failed = results.some((row) => !row.ok);

  return (
    <dialog ref={dialog} className="fr" aria-labelledby="fr-title" onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="fr-in">
        <header className="fr-h">
          <div>
            <h3 id="fr-title">처리 LLM 바꾸기 — {title}</h3>
            <ol className="fr-steps" aria-label="단계">{STEPS.map((row, index) => (
              <li key={row.key} aria-current={(step === "saving" ? "confirm" : step) === row.key ? "step" : undefined}>{index + 1} {row.text}</li>))}</ol>
          </div>
          <button type="button" className="fr-x" onClick={close} disabled={step === "saving"} aria-label="닫기">✕</button>
        </header>

        {step === "edit" && <div className="fr-body">
          <p className="fr-lead">대체 실행은 우선 모델 하나를 쓰고, 필요한 경우에만 다음 순위로 전환합니다. 작업 분산은 서로 다른 업무를 모델에 나눕니다. 모델을 고르면 옆에서 추론 강도를 정합니다.</p>
          {lockReason && <p className="fr-locked" role="alert">{lockReason}</p>}
          {lines.map((line) => <LineEditor key={line.key} editor={editor} line={line} value={value(line)} disabled={false}
            onChange={(next) => setDrafts((current) => ({ ...current, [line.key]: next }))} warnings={warnings.filter((warning) => warning.line === line.key)}
            resave={resave.has(line.key)} onNavigate={close}
            onResave={(checked) => setResave((current) => { const next = new Set(current); if (checked) next.add(line.key); else next.delete(line.key); return next; })} />)}
          <details className="fr-conns">
            <summary>연결 상태 {editor.states.length}개</summary>
            <table className="fr-conn-table">
              <thead><tr><th scope="col">연결</th><th scope="col">장비</th><th scope="col">최근 상태</th></tr></thead>
              <tbody>{editor.states.map((state) => {
                const connection = editor.connections.find(row => row.id === state.id);
                return <tr key={state.id} data-state={state.state}><th scope="row">{connection ? modelPickerConnectionLabel(connection) : state.label}</th>
                  <td>{connection ? modelPickerConnectionDevice(connection) : state.device}</td><td>{state.text}</td></tr>;
              })}</tbody>
            </table>
          </details>
        </div>}

        {(step === "confirm" || step === "saving") && <div className="fr-body">
          <p className="fr-lead">{mode === "undo" ? "되돌리기 — 직전 순위로 다시 저장합니다. 바뀌는 내용을 확인하세요." : "저장 전에 바뀌는 내용을 확인하세요."}</p>
          {changes.length ? <ChangeTable changes={changes} /> : <p className="fr-note">바뀌는 것이 없습니다.</p>}
          <DeviceImpact editor={editor} changes={changes} devices={devices} />
          <WarningList warnings={confirmWarnings} />
          <p className="fr-note">저장은 작업 배정의 순위 저장과 같은 서버 동작입니다. 작업 로그(ai-task-models-save)에 전·후 값이 남고 「최근 바뀐 설정」에 보입니다.
            없는 장비 행·엔진 직접 계약·용량 경로는 함께 만들고, 만들 수 없으면 저장하지 않고 까닭을 보입니다.</p>
          {lockReason && <p className="fr-locked" role="alert">{lockReason}</p>}
          {mustAck && <label className="fr-ack"><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} disabled={step === "saving"} />
            위 ■ 경고를 읽었습니다 — 그래도 저장합니다</label>}
        </div>}

        {step === "done" && <div className="fr-body" role="status">
          <ul className="fr-results">{results.map((row) => <li key={row.key} data-ok={row.ok ? "yes" : "no"}>
            <b>{row.ok ? "저장함" : "저장 못 함"} · {row.label}</b>
            <span className="fr-result-diff">{row.beforeText} → {row.afterText}</span>
            {row.text && <span>{row.text}</span>}
            {row.warnings.map((text) => <span key={text} className="fr-warn" data-tone="warn">알림 — {text}</span>)}
            {row.issues.map((text) => <span key={text} className="fr-warn" data-tone="bad">{text}</span>)}
          </li>)}</ul>
          {!failed && <p className="fr-note">「최근 바뀐 설정」 칸에 이 저장이 기록됩니다{mode === "change" ? " — 잘못 바꿨으면 아래 「되돌리기」로 직전 순위를 다시 저장합니다." : "."}</p>}
        </div>}

        <footer className="fr-f">
          {step === "edit" && <>
            {fullViewHref && <Link href={fullViewHref} prefetch={false} className="fr-link">작업 배정에서 전체 보기 →</Link>}
            <button type="button" className="fr-btn" onClick={close}>닫기</button>
            <button type="button" className="fr-btn fr-primary" onClick={toConfirm} disabled={!changes.length || issues.length > 0 || !!lockReason}>
              바뀌는 내용 확인{changes.length ? ` (${changes.length})` : ""} →</button>
          </>}
          {(step === "confirm" || step === "saving") && <>
            <button type="button" className="fr-btn" onClick={() => { setStep("edit"); if (mode === "undo") { setMode("change"); setDrafts({}); } }} disabled={step === "saving"}>← 고치기</button>
            <button type="button" className="fr-btn fr-primary" data-danger={mustAck ? "yes" : undefined} onClick={submit}
              disabled={step === "saving" || !changes.length || issues.length > 0 || (mustAck && !ack) || !!lockReason}>
              {step === "saving" ? "저장 중…" : mode === "undo" ? "되돌리기 저장" : "저장"}</button>
          </>}
          {step === "done" && <>
            {failed && <button type="button" className="fr-btn" onClick={() => setStep("edit")}>← 고치기</button>}
            {undo.length > 0 && mode === "change" && <button type="button" className="fr-btn fr-undo" onClick={startUndo}>되돌리기 — 직전 순위로 다시 저장</button>}
            <button type="button" className="fr-btn fr-primary" onClick={close}>닫기</button>
          </>}
        </footer>
      </div>
    </dialog>
  );
}
