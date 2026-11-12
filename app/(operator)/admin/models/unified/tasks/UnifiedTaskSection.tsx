"use client";

import { Fragment, useRef, useState } from "react";
import { aiTaskPoolCappedLanes } from "@/lib/llm/ai-task-execution-config";
import { aiModelDisplayName } from "@/lib/operations/admin-ai-tasks";
import type { FlowRankEditor, RankDeviceLimit } from "@/lib/operations/flow-rank-editor";
import { ledgerModelText, type TaskAssignChoice, type TaskAssignRow, type TaskAssignView } from "@/lib/operations/llm-task-assign-view";
import { UNIFIED_TASK_GROUPS, unifiedTaskDuplicate, unifiedTaskIsExternal, unifiedTaskNeedsAttention, unifiedTaskRows,
  type UnifiedTaskFilter, type UnifiedTaskGroup } from "@/lib/operations/model-unified-task-view";
import type { PoolHelpContext } from "@/lib/operations/pool-help";
import { modelPickerOptionName, modelPickerVisibleText } from "../../model-picker-display";
import { UnifiedTaskEditor } from "./UnifiedTaskEditor";
import "./unified-tasks.css";

const fmt = (value: number) => value.toLocaleString("ko-KR");

export type UnifiedTaskSectionProps = {
  view: TaskAssignView; editor: FlowRankEditor; devices: readonly RankDeviceLimit[] | null;
  lockReason: string | null; poolHelp: PoolHelpContext | null;
  modelScope?: string | null; onModelScopeClear?: () => void; onModelOpen?: (connectionId: string) => void;
  onTaskOpen?: (taskKey: string) => void;
  filter?: UnifiedTaskFilter; onFilterChange?: (filter: UnifiedTaskFilter) => void;
};

function choiceName(choice: TaskAssignChoice, editor: FlowRankEditor) {
  const connection = editor.connections.find(entry => entry.id === choice.connectionId);
  return connection ? modelPickerOptionName(connection, choice.model) : `${modelPickerVisibleText(choice.connection, editor.connections)} · ${ledgerModelText(choice.model)}`;
}

function ModelChain({ row, editor, onModelOpen }: { row: TaskAssignRow; editor: FlowRankEditor; onModelOpen?: (id: string) => void }) {
  return <>
    <div className="ut-model-chain">{row.choices.length ? row.choices.map((choice, index) => <Fragment key={`${choice.position}:${choice.connectionId}:${choice.model}`}>
      {index > 0 && <span className="ut-chain-arrow" aria-hidden="true">{row.mode === "fallback" ? "→" : "+"}</span>}
      <button type="button" className="ut-model-chip" disabled={!choice.connectionId || !onModelOpen}
        onClick={() => { if (choice.connectionId) onModelOpen?.(choice.connectionId); }} data-off={choice.off ? "true" : undefined}
        title={[choice.off, choice.effort ? `추론 ${choice.effort}` : null].filter(Boolean).join(" · ") || undefined}>
        {row.mode === "fallback" && <span className="ut-rank-number">{choice.position}</span>}{choiceName(choice, editor)}
        {choice.effort && <small className="ut-choice-effort">{choice.effort}</small>}
        {choice.off && <small className="ut-choice-off">{choice.off}</small>}
      </button>
    </Fragment>) : <span className="ut-muted">{row.mode === "workload_pool" ? "함께 쓰는 모델 없음" : "모델 설정 없음"}</span>}</div>
    {row.archived.length > 0 && <details className="ut-archived"><summary>보관된 순위 {row.archived.length}개</summary>
      <p>{row.archived.map(choice => `${choice.position}순위 ${choiceName(choice, editor)}`).join(" → ")}</p></details>}
    {row.source && row.mode === "effective" && <span className="ut-task-subtitle">출처: {modelPickerVisibleText(row.source, editor.connections)}</span>}
  </>;
}

export function UnifiedTaskActual({ row, editor, onModelOpen }: { row: TaskAssignRow; editor: FlowRankEditor; onModelOpen?: (id: string) => void }) {
  const { actual } = row;
  return <div className="ut-actual">
    {actual.calls.map(call => {
      const connection = editor.connections.find(entry => entry.id === call.connectionId);
      const name = connection ? modelPickerOptionName(connection, call.model) : ledgerModelText(call.model);
      return <div className="ut-actual-call" key={call.key}>
        {connection && onModelOpen ? <button type="button" className="ut-actual-model" onClick={() => onModelOpen(connection.id)}>{name}</button> : <span>{name}</span>}
        {" "}<b className="ut-num">{fmt(call.settled)}건</b>{call.failed > 0 && <small className="ut-failed">실패 {fmt(call.failed)}건 포함</small>}
      </div>;
    })}
    {actual.empty && <span className="ut-muted">{actual.empty}</span>}
    {!actual.calls.length && !actual.empty && <span className="ut-muted">{actual.settled === null ? "관측 불가" : `${fmt(actual.settled)}건`}</span>}
    {actual.note && <small>{actual.note}</small>}
    {actual.shared && actual.tracked && actual.readable && actual.calls.length > 0 && <small>투표자 구분 없이 작업 전체 장부</small>}
    {actual.warnings.map(warning => <small key={warning} className="ut-actual-warning">설정과 다름 · {warning}</small>)}
  </div>;
}

/** One real snapshot supplies configured choices, one-hour calls, and status. Only drafts live in the browser. */
export function UnifiedTaskSection({ view, editor, devices, lockReason, poolHelp, modelScope = null, onModelScopeClear, onModelOpen,
  onTaskOpen, filter: controlledFilter, onFilterChange }: UnifiedTaskSectionProps) {
  const [localFilter, setLocalFilter] = useState<UnifiedTaskFilter>("all");
  const filter = controlledFilter ?? localFilter;
  const [group, setGroup] = useState<UnifiedTaskGroup>("all");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const scope = modelScope;
  const scopeConnection = editor.connections.find(entry => entry.id === scope);
  const { filtered, visible, hasFilter } = unifiedTaskRows(view.rows, { filter, group, search, modelScope: scope, showAll,
    nameOf: choice => choiceName(choice, editor) });
  const changeFilter = (next: UnifiedTaskFilter) => { setLocalFilter(next); onFilterChange?.(next); setShowAll(false); };
  const clearScope = () => { onModelScopeClear?.(); };
  const reset = () => { changeFilter("all"); setGroup("all"); setSearch(""); clearScope(); };
  const open = onTaskOpen ?? setChanging;

  return <section id="tasks" className="unified-tasks" aria-labelledby="tasks-title">
    <div className="ut-section-head ut-tasks-head"><div><h2 id="tasks-title">작업별 적용 현황 <span className="ut-head-meta">{fmt(view.rows.length)}개</span></h2>
      <p>설정한 모델과 실제 호출을 함께 봅니다. 배정과 실행 방식은 작업 상세에서 바꿉니다.</p></div>
      <div className="ut-grow"><span className="ut-pill">최근 1시간 기준</span></div></div>
    {view.errors.map(error => <p className="ut-callout ut-warn" role="alert" key={error}>{error}</p>)}
    <div className="ut-tools">
      <div className="ut-filters" role="group" aria-label="작업 상태 필터">
        {([{ value: "all", label: "전체 작업", count: view.rows.length },
          { value: "attention", label: "확인 필요", count: view.rows.filter(unifiedTaskNeedsAttention).length },
          { value: "duplicate", label: "반복 배정", count: view.rows.filter(unifiedTaskDuplicate).length }] as const).map(item =>
          <button type="button" key={item.value} className="ut-filter" aria-pressed={filter === item.value} onClick={() => changeFilter(item.value)}>
            {item.label} <span>{fmt(item.count)}</span></button>)}
      </div>
      {scope && <span className="ut-model-scope"><span>{scopeConnection ? aiModelDisplayName(scopeConnection) : "지워진 모델"} 사용</span>
        {onModelScopeClear && <button type="button" aria-label="모델 필터 해제" onClick={clearScope}>×</button>}</span>}
      <label className="ut-task-search"><span aria-hidden="true">⌕</span><input ref={searchInput} type="search" placeholder="작업·모델 검색" aria-label="작업·모델 검색"
        value={search} onChange={event => setSearch(event.target.value)} />
        {search && <button type="button" aria-label="검색 지우기" onClick={() => { setSearch(""); searchInput.current?.focus(); }}>×</button>}</label>
      <select className="ut-group-select" aria-label="작업 구분" value={group} onChange={event => setGroup(event.target.value as UnifiedTaskGroup)}>
        <option value="all">모든 작업</option>{Object.entries(UNIFIED_TASK_GROUPS).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
      </select>
    </div>
    <div className="ut-table-wrap" role="region" aria-label="작업별 설정 모델과 실제 호출" tabIndex={0}>
      <table className="ut-task-table" aria-label="작업별 설정 모델과 실제 호출">
        <colgroup><col style={{ width: 188 }} /><col style={{ width: 112 }} /><col /><col style={{ width: 195 }} /><col style={{ width: 155 }} /><col style={{ width: 90 }} /></colgroup>
        <thead><tr><th scope="col">작업</th><th scope="col">실행 방식</th><th scope="col">설정한 모델</th><th scope="col">실제 호출 · 1시간</th><th scope="col">상태</th>
          <th scope="col"><span className="admin-vh">작업 상세</span></th></tr></thead>
        <tbody>{visible.map(row => {
          const duplicate = unifiedTaskDuplicate(row);
          const execution = editor.lines.find(line => line.key === row.key)?.execution;
          const capped = execution ? aiTaskPoolCappedLanes(execution) : null;
          return <tr key={row.key} id={row.anchor} data-task={row.key}>
            <th scope="row">{row.label}<div className="ut-task-subtitle">{UNIFIED_TASK_GROUPS[row.group]}</div></th>
            <td><span className={`ut-pill${row.mode === "workload_pool" ? " ut-ok" : ""}`}>{row.mode === "workload_pool" ? "동시에" : row.mode === "fallback" ? "순위대로" : row.mode === "classifier" ? "기존 CLI 분류" : row.mode === "effective" ? "실제 적용 설정" : "관측 불가"}</span>
              {row.mode === "workload_pool" && <div className="ut-task-subtitle">모델 {row.choices.length}개{capped !== null ? ` · 최대 ${fmt(capped)}건` : ""}</div>}</td>
            <td><ModelChain row={row} editor={editor} onModelOpen={onModelOpen} /></td>
            <td><UnifiedTaskActual row={row} editor={editor} onModelOpen={onModelOpen} /></td>
            <td><div className="ut-task-status"><span className="ut-dot" data-tone={duplicate ? "warn" : row.status.level} title={row.status.detail ?? undefined}>
              {duplicate ? "반복 배정" : row.status.text}</span><small>{duplicate ? "앞 순위와 같은 모델" : row.status.reason ? modelPickerVisibleText(row.status.reason, editor.connections) : null}</small>
              {duplicate && row.status.level !== "ok" && <small>{row.status.text}{row.status.reason ? ` · ${modelPickerVisibleText(row.status.reason, editor.connections)}` : ""}</small>}</div></td>
            <td className="ut-right"><button type="button" className="ut-task-action" aria-label={`${row.label} ${unifiedTaskIsExternal(row) ? "설정 보기" : "배정 변경"}`}
              onClick={() => open(row.key)}>{unifiedTaskIsExternal(row) ? "설정 보기" : "배정 변경"} →</button></td>
          </tr>;
        })}
        {!visible.length && <tr><td colSpan={6} className="ut-empty">조건에 맞는 작업이 없습니다. <button type="button" className="ut-text-btn" onClick={reset}>필터 초기화</button></td></tr>}
        </tbody>
      </table>
      <div className="ut-list-footer"><span>{hasFilter ? `${fmt(filtered.length)}개 작업` : `${fmt(visible.length)} / ${fmt(view.rows.length)}개 작업 표시`}</span>
        {!hasFilter && view.rows.length > 8 && <button type="button" className="ut-text-btn" onClick={() => setShowAll(value => !value)}>
          {showAll ? "주요 작업만 보기 ↑" : `전체 ${fmt(view.rows.length)}개 펼치기 ↓`}</button>}</div>
    </div>
    <div className="ut-table-note"><span>순위대로: 필요한 경우에 다음 모델로 전환 · 동시에: 서로 다른 업무를 여러 모델에 분산</span>
      <span>호출 없음·의도적 중지·관측 불가를 구분합니다.</span></div>
    {changing && <UnifiedTaskEditor key={changing} taskKey={changing} editor={editor} devices={devices} lockReason={lockReason} poolHelp={poolHelp}
      row={view.rows.find(row => row.key === changing) ?? null} onClose={() => setChanging(null)} onModelOpen={onModelOpen} />}
  </section>;
}
