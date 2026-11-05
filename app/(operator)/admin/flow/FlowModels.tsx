"use client";

import type { StationLlm } from "@/lib/operations/conveyor-llm";

const count = (value: number) => value.toLocaleString("ko-KR");

export function modelCallCount(llm: StationLlm | null): number | null {
  if (!llm || llm.kind === "unknown") return null;
  if (llm.kind === "none") return 0;
  if (llm.tasks.some(task => task.active == null)) return null;
  return llm.tasks.reduce((total, task) => total + (task.active ?? []).filter(row => row.state === "dispatched")
    .reduce((sum, row) => sum + row.count, 0), 0);
}

/** Every current ledger model is rendered; historical use never stands in for a live call. */
export function LiveModelRows({ llm, compact = false }: { llm: StationLlm | null; compact?: boolean }) {
  if (!llm || llm.kind === "unknown") return <span className="flow-model-note">현재 호출 미확인</span>;
  if (llm.kind === "none") return <span className="flow-model-note">LLM 없음 · {llm.short}</span>;
  const active = llm.tasks.flatMap(task => (task.active ?? []).map(row => ({ task, row })));
  const running = active.filter(({ row }) => row.state === "dispatched");
  const reserved = active.filter(({ row }) => row.state === "reserved");
  const uncertain = active.filter(({ row }) => row.state === "indeterminate");
  const unread = llm.tasks.some(task => task.active == null);
  const display = (entries: typeof active, label: string, state: string) => entries.map(({ task, row }, index) =>
    <span className="flow-model-line" data-state={state} key={`${task.task}:${row.where}:${row.model}:${state}:${index}`}>
      <span className="flow-model-state">{label} {count(row.count)}</span>
      <span>{row.where} · <b>{row.model}</b>{!compact && llm.tasks.length > 1 ? ` · ${task.label}` : ""}</span>
    </span>);
  return <span className="flow-model-lines">
    {running.length > 0 ? display(running, "전송 중", "running") : <span className="flow-model-note">{unread ? "현재 호출 일부 미확인" : "장부상 전송 중 호출 없음"}</span>}
    {display(reserved, "예약", "reserved")}
    {display(uncertain, "종료 미확정", "uncertain")}
  </span>;
}

export function RecentModelRows({ llm }: { llm: StationLlm | null }) {
  if (!llm || llm.kind === "unknown") return <span className="flow-model-note">최근 사용 미확인</span>;
  if (llm.kind === "none") return <span>이 단계는 LLM을 호출하지 않습니다.</span>;
  const used = llm.tasks.flatMap(task => (task.used ?? []).map(row => ({ task, row })));
  return <span className="flow-model-lines">{used.map(({ task, row }, index) => <span className="flow-model-line" key={`${task.task}:${row.where}:${row.model}:${index}`}>
    <span>{row.where} · <b>{row.model}</b></span><span className="flow-model-note">{count(row.count)}건 · {task.label}</span>
  </span>)}{!used.length && <span>{llm.tasks.some(task => task.used === null) ? "최근 사용 기록 미확인" : "최근 1시간 완료 호출 없음"}</span>}</span>;
}

/** The saved fallback ranks and pool members each occupy a new row. */
export function ConfiguredModelRows({ llm, compact = false }: { llm: StationLlm | null; compact?: boolean }) {
  if (!llm || llm.kind === "unknown") return <span className="flow-model-note">모델 설정 미확인</span>;
  if (llm.kind === "none") return <span>해당 없음</span>;
  return <span className="flow-model-lines">{llm.tasks.map(task => <span className="flow-model-task" key={task.task}>
    {!compact && <b>{task.label}{task.pool ? " · 작업 분산" : task.legacy ? ` · ${task.legacy.source}` : task.live ? " · 대체 실행" : " · 저장된 순위(실행 미연결)"}</b>}
    {task.legacy ? <>{task.legacy.models.map(row => <span className="flow-model-line" key={row.rank}>
      <span className="flow-model-rank">{row.rank}순위</span><span>{row.where} · {row.model}</span>
    </span>)}{task.legacy.models.length === 0 && <span className="flow-model-note">기존 CLI 설정 미확인</span>}
      {task.legacy.ready === false && <span className="flow-model-note">연결 에이전트가 현재 분류 요청을 받을 수 없습니다.</span>}</> : task.pool ? task.pool.members.map(member => <span className="flow-model-line" key={member.memberId}>
      <span className="flow-model-rank">모델 {member.slot}.{task.pool!.members.indexOf(member) + 1}</span>
      <span>{member.connection} · {member.model}{task.pool!.members.filter(other => (other.connectionId ?? other.connection) === (member.connectionId ?? member.connection) && other.model === member.model).length > 1 ? " · 공유 엔진" : ""}{member.problem ? ` · ${member.problem}` : ""}</span>
    </span>) : task.slots.map(slot => <span className="flow-model-task" key={slot.slot}>
      {slot.label && !compact && <span className="flow-model-note">{slot.label}</span>}
      {slot.ranks.map(rank => <span className="flow-model-line" key={rank.rank}>
        <span className="flow-model-rank">{rank.rank}순위</span><span>{rank.connection} · {rank.model}{rank.problem ? ` · ${rank.problem}` : ""}</span>
      </span>)}
    </span>)}
    {!task.pool && !task.legacy && !task.slots.some(slot => slot.ranks.length) && <span className="flow-model-note">모델 순위 없음</span>}
  </span>)}</span>;
}
