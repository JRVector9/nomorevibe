import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { buildConsoleFlow, buildConsoleStrip, type ConsoleFlowRow } from "@/lib/operations/console-home-model";
import type { ConsoleHomeRead, ConsoleJobControl } from "@/lib/operations/console-home-read";
import { buildConsoleTasks, CONSOLE_TASK_LIMITS, formatCount, formatKst, type ConsoleAction, type ConsoleTask, type ConsoleTaskBoard } from "@/lib/operations/console-tasks";
import { consoleTaskAnchor } from "@/lib/operations/console-alerts";
import { JobControl } from "../status/JobControl";
import { TaskKeep } from "./TaskKeep";
import "./console-home.css";

const KEEP_DAYS = Math.round(CONSOLE_TASK_LIMITS.keepMs / 86_400_000);

/**
 * 운영 홈(2026-11-12 최종 시안 「화면 1 홈」) — 머리줄 한 줄, 왼쪽 「지금 할 일」 네 묶음, 오른쪽 「흐름」 표.
 * 좁은 화면에서는 할 일이 먼저 온다(같은 순서로 한 줄씩 쌓인다). 할 일은 console-tasks.ts 의 규칙에서만 나온다.
 * 이 화면이 직접 바꾸는 것은 둘이다 — 멈춘 작업의 재개(기존 작업 멈춤·재개 서버 동작, 사유 필수, 작업 로그)와
 * 「사유 남기고 유지」·「그대로 두기」(할 일을 확인했고 그대로 둔다는 표시, 사유 필수, 작업 로그 console-task-keep — 정한 기간 동안 목록에서 내린다).
 * 「단계 열기」와 흐름 표의 줄은 단계 패널(?stage=, 조각 2a)을 연다. 나머지 단추는 지금 있는 화면으로 보낸다.
 */
export function ConsoleHome({ data, csrf, changeWatch, panel }: {
  data: ConsoleHomeRead;
  /** 작업 재개 폼의 CSRF — 없으면(읽기 전용 미리 보기 등) 재개 단추는 작업 상세로 보낸다 */
  csrf: { token: string; expiresAt: number } | null;
  /**
   * 「바꾼 것 지켜보기」 표 자리 — 조각 1c 의 서버 구성 요소(app/(operator)/admin/flow/ChangeWatch.tsx)를 page.tsx 가 여기에 넘긴다.
   * 그 조각이 바꾼 뒤 처리량이 떨어진 것을 찾으면 할 일 입력(changeDrops)으로도 넣는다.
   */
  changeWatch?: ReactNode;
  /** 단계 패널(?stage=, 조각 2a) — page.tsx 가 열린 단계의 서버 구성 요소를 넘긴다 */
  panel?: ReactNode;
}) {
  const board = buildConsoleTasks(data.inputs);
  const strip = buildConsoleStrip({ conveyor: data.conveyor, admission: data.inputs.admission, progress: data.inputs.progress });
  const flow = buildConsoleFlow(data.conveyor, data.inputs.progress, board);
  const shown = board.groups.filter(group => group.tasks.length || group.unknown.length);
  const unknown = board.groups.some(group => group.unknown.length);
  return <div className="console-home">
    <p className="ch-strip" aria-label="지금 상태">{strip.map(item => <span key={item.key}>{item.label}<b>{item.value ?? "셀 수 없음"}</b></span>)}</p>
    <div className="ch-grid">
      <section className="ch-tasks" aria-labelledby="ch-tasks-title">
        <div className="ch-head"><h2 id="ch-tasks-title">지금 할 일</h2><span className="ch-count">{formatCount(board.total)}건{unknown ? " · 일부 셀 수 없음" : ""}</span>
          {board.total > 0 && <span className="ch-checked">마지막 확인 {formatKst(board.checkedAt)}</span>}</div>
        {board.total === 0 && <p className="ch-empty">할 일 없음 · 마지막 확인 {formatKst(board.checkedAt)}</p>}
        {shown.length > 0 && <ul className="ch-list">{shown.map(group => <Fragment key={group.key}>
          <li className="ch-grp" data-group={group.key}>{group.label}{group.key === "pile" && group.tasks.length > 1 ? " · 오래 걸리는 순" : ""}<span>{group.tasks.length}</span></li>
          {group.tasks.map(task => <TaskRow key={task.id} task={task} csrf={csrf} controls={data.jobControls} />)}
          {group.unknown.length > 0 && <li className="ch-unknown">셀 수 없음 · {group.unknown.join(" · ")}</li>}
        </Fragment>)}</ul>}
        <KeptList board={board} />
      </section>
      <section className="ch-flow" aria-labelledby="ch-flow-title">
        <div className="ch-head"><h2 id="ch-flow-title">흐름</h2><span className="ch-count">단계를 누르면 패널</span>
          <Link prefetch={false} className="text-button ch-more" href="/admin/flow?tab=detail">흐름 상세 →</Link></div>
        <div className="ch-scroll" role="region" aria-label="단계별 흐름 표" tabIndex={0}>
          <table className="ch-table">
            <colgroup><col /><col style={{ width: 132 }} /><col style={{ width: 84 }} /><col style={{ width: 96 }} /><col style={{ width: 116 }} /></colgroup>
            <thead><tr><th scope="col">단계</th><th scope="col">상태</th><th scope="col" className="n">대기</th><th scope="col" className="n">최근 처리</th><th scope="col">23시간 추이</th></tr></thead>
            <tbody>
              {flow.main.length ? flow.main.map(row => <FlowRow key={row.key} row={row} />)
                : <tr><td colSpan={5} className="ch-none">흐름을 셀 수 없음 — 다음 자동 갱신에서 다시 읽습니다.</td></tr>}
              <tr className="ch-grp-row"><th scope="rowgroup" colSpan={5}>공개 뒤</th></tr>
              {flow.post.map(row => <FlowRow key={row.key} row={row} />)}
            </tbody>
          </table>
        </div>
        {/* 바꾼 것 지켜보기(조각 1c) — 비어 있으면 아무것도 그리지 않는다 */}
        {changeWatch}
      </section>
    </div>
    {panel}
  </div>;
}

function TaskRow({ task, csrf, controls }: { task: ConsoleTask; csrf: { token: string; expiresAt: number } | null; controls: Record<string, ConsoleJobControl> }) {
  // id — 휴대폰 알림의 주소(/admin/flow#task-…)가 이 줄로 온다(조각 4b)
  return <li className="ch-task" id={consoleTaskAnchor(task.id)} data-tone={task.tone} data-rule={task.rule}>
    <i aria-hidden="true" />
    <div>
      <h3>{task.title}</h3>
      <p className="ch-fact">{task.fact}</p>
      {task.why && <p className="ch-why">{task.why}</p>}
      <div className="ch-acts">{task.actions.map((action, index) => <Action key={`${action.kind}:${action.label}`} action={action} primary={index === 0} csrf={csrf} controls={controls}
        task={task} />)}</div>
    </div>
  </li>;
}

function Action({ action, primary, csrf, controls, task }: { action: ConsoleAction; primary: boolean; csrf: { token: string; expiresAt: number } | null;
  controls: Record<string, ConsoleJobControl>; task: ConsoleTask }) {
  const className = `button small${primary ? " primary" : ""}`;
  if (action.kind === "link") return <Link prefetch={false} className={className} href={action.href}>{action.label}</Link>;
  // 「사유 남기고 유지」·「그대로 두기」 — 새 쓰기라 CSRF 가 없으면(읽기 전용 미리 보기) 단추를 내지 않는다
  if (action.kind === "keep") return csrf ? <details className="ch-job"><summary className={className}>{action.label}</summary>
    <TaskKeep taskId={action.taskId} keepRef={task.keepRef ?? null} title={task.title} label={action.label} days={KEEP_DAYS} csrf={csrf} /></details> : null;
  // 재개 — 운영센터·흐름 상세와 같은 작업 제어 폼(사유 필수, 다른 사람이 먼저 바꿨으면 거절)
  const control = controls[action.job];
  if (!csrf || !control) return <Link prefetch={false} className={className} href={action.fallbackHref}>{action.label}</Link>;
  return <details className="ch-job"><summary className={className}>{action.label}</summary>
    <JobControl name={action.job} paused={control.paused} notBefore={control.notBefore} version={control.version} csrf={csrf} /></details>;
}

/** 그대로 둔 할 일 — 누가·언제까지·사유. 목록에서 내렸어도 보이게 접어 둔다 */
function KeptList({ board }: { board: ConsoleTaskBoard }) {
  if (board.keptUnknown) return <p className="ch-kept-note">그대로 둔 표시를 읽지 못해 모든 할 일을 그대로 보입니다.</p>;
  if (!board.kept.length) return null;
  return <details className="ch-kept"><summary>그대로 둔 것 {formatCount(board.kept.length)}건</summary>
    <ul>{board.kept.map(({ task, keep }) => <li key={task.id}><b>{task.title}</b>
      <span>{keep.actor} · {formatKst(keep.at)} · {formatKst(keep.until)}까지 · {keep.reason}</span></li>)}</ul>
  </details>;
}

function FlowRow({ row }: { row: ConsoleFlowRow }) {
  return <tr>
    <th scope="row">{row.href ? <Link prefetch={false} href={row.href}>{row.label}</Link> : row.label}</th>
    <td><span className="ch-st" data-tone={row.tone}><i aria-hidden="true" />{row.status}</span></td>
    <td className="n">{row.waiting === null ? "—" : formatCount(row.waiting)}</td>
    <td className="n">{row.rate ? <>{formatCount(row.rate.value)}<small>/{row.rate.per}</small></> : "—"}</td>
    <td>{row.spark ? <Spark values={row.spark} tone={row.tone} /> : <span className="ch-none">{row.note ?? "—"}</span>}</td>
  </tr>;
}

/** 시간별 처리 선(시안과 같은 96×22) — 마지막 점이 가장 최근 시간 */
function Spark({ values, tone }: { values: number[]; tone: ConsoleFlowRow["tone"] }) {
  if (values.length < 2) return <span className="ch-none">—</span>;
  const width = 96, height = 22, top = Math.max(1, ...values);
  const points = values.map((value, index) => [Math.round((index * (width - 4) / (values.length - 1) + 2) * 10) / 10,
    Math.round((height - 3 - value / top * (height - 6)) * 10) / 10]);
  const [x, y] = points.at(-1)!;
  return <svg className="ch-spark" data-tone={tone} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img"
    aria-label={`시간별 처리, 처음 ${formatCount(values[0])} 마지막 ${formatCount(values.at(-1)!)}`}>
    <polyline points={points.map(point => point.join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx={x} cy={y} r="2.2" fill="currentColor" />
  </svg>;
}
