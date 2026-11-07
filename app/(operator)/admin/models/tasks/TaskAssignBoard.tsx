"use client";

import { useEffect, useState } from "react";
import { aiTask } from "@/lib/llm/ai-tasks";
import type { FlowRankEditor, RankDeviceLimit } from "@/lib/operations/flow-rank-editor";
import { ledgerModelText, type TaskAssignChoice, type TaskAssignRow, type TaskAssignView } from "@/lib/operations/llm-task-assign-view";
import { RankDrawer } from "../../flow/RankDrawer";
import { LevelBadge, LevelLegend, ObservedAt } from "../LlmOpsParts";
import { modelPickerConnectionLabel, modelPickerModelLabel, modelPickerVisibleText } from "../model-picker-display";

const fmt = (value: number) => value.toLocaleString("ko-KR");
const RANKS = [1, 2, 3] as const;

/** 주소의 #id 가 접힌 칸(실행 방식 등) 안이면 펼치고 내려간다 — 표는 Suspense 뒤에 들어와 Next 의 해시 스크롤이 놓친다. */
function useOpenHash() {
  useEffect(() => {
    const open = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const target = id ? document.getElementById(id) : null;
      if (!target) return;
      for (let node = target.parentElement; node; node = node.parentElement) if (node instanceof HTMLDetailsElement) node.open = true;
      if (target instanceof HTMLDetailsElement) target.open = true;
      target.scrollIntoView({ block: "start" });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
}

function Choice({ choice, editor, prefix }: { choice: TaskAssignChoice; editor: FlowRankEditor; prefix?: string }) {
  const connection = choice.connectionId ? editor.connections.find(row => row.id === choice.connectionId) : undefined;
  const name = connection ? modelPickerConnectionLabel(connection) : modelPickerVisibleText(choice.connection, editor.connections);
  const model = connection ? modelPickerModelLabel(connection, choice.model) : choice.model;
  return <span className="tk-choice" data-off={choice.off ? "true" : undefined}>
    {prefix && <span className="tk-pos">{prefix}</span>}
    <span className="tk-conn">{name}</span>
    <code className="tk-model">{model}</code>
    {choice.effort && <span className="tk-effort">추론 {choice.effort}</span>}
    {choice.off && <span className="tk-off"><span aria-hidden="true">‖ </span>{choice.off}</span>}
  </span>;
}

function SettingCells({ row, editor }: { row: TaskAssignRow; editor: FlowRankEditor }) {
  if (row.merged) return <td colSpan={3} className="tk-merged" data-label={row.mode === "workload_pool" ? "분산 모델" : "실제 적용 설정"}>
    {row.choices.length ? <span className="tk-merged-list">{row.choices.map(choice =>
      <Choice key={`${choice.position}:${choice.connection}:${choice.model}`} choice={choice} editor={editor} prefix={row.mode === "workload_pool" ? `모델 ${choice.position}` : `${choice.position}.`} />)}</span>
      : <span className="tk-none">{row.mode === "workload_pool" ? "분산 모델 없음" : "모델 설정 없음"}</span>}
    {row.source && <span className="tk-source">출처: {modelPickerVisibleText(row.source, editor.connections)}</span>}
    {row.archived.length > 0 && <span className="tk-source" data-archived="true">보관된 대체 순위(지금은 쓰지 않음): {row.archived.map(choice => {
      const connection = choice.connectionId ? editor.connections.find(entry => entry.id === choice.connectionId) : undefined;
      return `${choice.position}순위 ${connection ? modelPickerConnectionLabel(connection) : choice.connection} · ${connection ? modelPickerModelLabel(connection, choice.model) : choice.model}`;
    }).join(" → ")}</span>}
  </td>;
  return <>{RANKS.map(rank => {
    const choice = row.choices.find(entry => entry.position === rank);
    return <td key={rank} className="tk-rank" data-label={`${rank}순위`} data-empty={choice ? undefined : "true"}>{choice ? <Choice choice={choice} editor={editor} /> : <span className="tk-none" aria-label="비어 있음">—</span>}</td>;
  })}</>;
}

function ActualCell({ row, editor }: { row: TaskAssignRow; editor: FlowRankEditor }) {
  const { actual } = row;
  const label = (position: number | null) => position === null ? actual.compared ? "설정 밖" : "모델" : row.mode === "fallback" ? `${position}순위` : row.mode === "workload_pool" ? `모델 ${position}` : `${position}.`;
  return <td className="tk-actual" data-label="지금 실제 (1시간)">
    {actual.calls.length > 0 && <ul className="tk-calls">{actual.calls.map(call => {
      const connection = call.connectionId ? editor.connections.find(entry => entry.id === call.connectionId) : undefined;
      return <li key={call.key} data-position={call.position ?? (actual.compared ? "none" : "unknown")} data-zero={call.settled === 0 ? "true" : undefined}>
        <span className="tk-pos">{label(call.position)}</span>
        <code className="tk-model">{connection ? modelPickerModelLabel(connection, call.model) : ledgerModelText(call.model)}</code>
        <b className="llm-num">{fmt(call.settled)}</b>{call.failed > 0 && <span className="tk-fail">실패 {fmt(call.failed)}</span>}
      </li>;
    })}</ul>}
    {actual.empty && <span className="tk-empty">{actual.empty}</span>}
    {actual.warnings.length > 0 && <span className="tk-mismatch"><LevelBadge level="warn">설정과 다름</LevelBadge>
      <ul>{actual.warnings.map(text => <li key={text}>{text}</li>)}</ul></span>}
    {actual.shared && actual.tracked && actual.readable && <span className="tk-source">투표자 구분 없이 작업 전체 장부</span>}
  </td>;
}

/**
 * 작업 배정 표 — 작업 × 칸마다 설정(1·2·3순위 · 분산 · 실제 적용)과 장부의 최근 1시간 실제 호출, 상태와 까닭. 「바꾸기」는 운영 홈과 같은 서랍(RankDrawer)을 연다.
 * 저장은 서랍 안의 기존 순위 저장(saveAiTaskRanksAction)뿐이다 — 이 표는 쓰지 않는다.
 */
export function TaskAssignBoard({ view, editor, devices, lockReason }: { view: TaskAssignView; editor: FlowRankEditor; devices: readonly RankDeviceLimit[] | null;
  lockReason: string | null }) {
  const [changing, setChanging] = useState<string | null>(null);
  useOpenHash();
  const groups = [...new Set(view.rows.map(row => row.group))];
  const lines = changing ? editor.lines.filter(line => line.task === changing) : [];
  return <div className="stack llm-ops tk" data-llm-page="tasks">
    <div className="llm-toolbar">
      <p className="llm-totals"><span>작업 <b>{fmt(view.rows.length)}</b></span>
        {(["bad", "warn", "idle", "unknown"] as const).filter(level => view.counts[level] > 0).map(level =>
          <span key={level} data-count={level}><LevelBadge level={level}>{level === "bad" ? "멈춤" : level === "warn" ? "주의" : level === "idle" ? "중지·쉼" : "확인 불가"} {fmt(view.counts[level])}</LevelBadge></span>)}
        <span data-count="ok"><LevelBadge level="ok">정상 {fmt(view.counts.ok)}</LevelBadge></span></p>
      <ObservedAt label="장부 관측" at={view.observedAt} />
    </div>
    {view.errors.map(error => <p key={error} role="alert" className="llm-notice">{error}</p>)}
    <div className="tk-wrap">
      <table className="tk-table">
        <caption className="admin-vh">작업별 설정 순위와 최근 1시간 실제 호출</caption>
        <thead><tr><th scope="col">작업</th><th scope="col">1순위</th><th scope="col">2순위</th><th scope="col">3순위</th>
          <th scope="col">지금 실제 (1시간)</th><th scope="col">상태</th><th scope="col"><span className="admin-vh">바꾸기</span></th></tr></thead>
        {groups.map(group => <tbody key={group}>
          <tr className="tk-group"><th colSpan={7} scope="colgroup">{view.rows.find(row => row.group === group)?.groupLabel}</th></tr>
          {view.rows.filter(row => row.group === group).map(row => <tr key={row.key} id={row.anchor} className="tk-row" data-task={row.key} data-level={row.status.level}>
            <th scope="row" className="tk-task" data-label="작업">
              <span className="tk-task-name">{row.label}</span>
              <span className="tk-mode" data-mode={row.mode ?? "unknown"}>{row.modeText}</span>
            </th>
            <SettingCells row={row} editor={editor} />
            <ActualCell row={row} editor={editor} />
            <td className="tk-status" data-label="상태" title={row.status.detail ?? undefined}>
              <LevelBadge level={row.status.level}>{row.status.text}</LevelBadge>
              {row.status.reason && <span className="tk-reason">{modelPickerVisibleText(row.status.reason, editor.connections)}</span>}
            </td>
            <td className="tk-act">
              <button type="button" className="button small" aria-label={`${row.label} 모델 바꾸기`} onClick={() => setChanging(row.task)}>바꾸기</button>
            </td>
          </tr>)}
        </tbody>)}
      </table>
    </div>
    <LevelLegend />
    <p className="llm-empty">「지금 실제」는 장부의 최근 1시간 정산(성공·실패·판정 없음)을 모델별로 센 것입니다. 1순위가 0건인데 다른 모델이 처리했거나, 1순위가 아닌 모델이 절반 이상을 처리했거나,
      순위에 없는 모델이 불렸으면 「설정과 다름」으로 알립니다. 상태 옆 회색 글자가 까닭입니다.</p>
    {changing && <RankDrawer key={changing} editor={editor} lines={lines} title={aiTask(changing)?.label ?? changing} secondWaiting={null}
      onClose={() => setChanging(null)} fullViewHref={null} devices={devices} lockReason={lockReason} />}
  </div>;
}
