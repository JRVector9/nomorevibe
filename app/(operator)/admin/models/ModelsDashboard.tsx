import Link from "next/link";
import type { OpsState } from "@/lib/operations/ops-runner/contract";
import { deviceModelsText } from "@/lib/operations/llm-display";
import { LLM_RETRY_HREF, type DashboardView } from "@/lib/operations/llm-ops-view";
import { AdmissionControl } from "./AdmissionControl";
import { LEVEL_WORD, LevelBadge, ObservedAt } from "./LlmOpsParts";
import { RequeueButton } from "./history/RetryActions";

const OCCUPANCY_NOTE = "점유 = 예약 + 실행 중. 결과 미확정은 칸을 차지하지 않습니다. 한도는 장비 행(실제 적용 값)입니다.";

/**
 * 대시보드(/admin/models) — 「지금 문제없이 돌고 있나? 무엇부터 하나?」(2026-11-07 승인 시안, 2026-11-09 압축 시안).
 * 판단 띠(배지 하나 + 한 덩어리, 의도적 중지는 자기 배지 한 줄) → 숫자 띠 한 줄(접수 + KPI 4) → 먼저 할 일 · 서버 점유 표 → 단계별 상태 표.
 * 한 메시지에 모양은 한 번만 쓴다(배지 = 모양 + 글자). 숫자는 모두 buildDashboardView 가 기존 읽기에서 만든 것이다.
 */
export function ModelsDashboard({ view, opsStates, readOnly }: { view: DashboardView; opsStates: OpsState[]; readOnly: boolean }) {
  const { banner, admission } = view;
  const retryWaiting = view.kpis.some(kpi => kpi.id === "retry" && kpi.level === "warn");
  return <div className="stack llm-ops md-dash" data-llm-page="dashboard">
    <p className="md-stamps"><ObservedAt label="장부 관측" at={view.observedAt} /><ObservedAt label="흐름 관측" at={view.flowAt} /></p>

    <section className="md-banner" data-level={banner.level} aria-labelledby="llm-banner-title">
      <div className="md-banner-main">
        <h2 id="llm-banner-title" className="md-banner-title"><LevelBadge level={banner.level}>{LEVEL_WORD[banner.level]}</LevelBadge>{banner.title}</h2>
        {banner.notes.map(line => <p key={line} className="md-banner-sub">{line}</p>)}
        {banner.paused.length > 0 && <p className="md-banner-sub" data-paused=""><LevelBadge level="idle">{LEVEL_WORD.idle}</LevelBadge>{banner.paused.join(" · ")}(잡 일시중지)</p>}
      </div>
      {retryWaiting && <div className="md-banner-side"><Link prefetch={false} className="md-link" href={LLM_RETRY_HREF}>재실행 보기 →</Link></div>}
    </section>

    <section className="md-stats" aria-label="핵심 수치">
      <div id="admission" className="md-stat md-admission" data-level={admission.level}>
        <span className="md-k">접수</span>
        <span className="md-v" data-mode={admission.mode ?? "unknown"}>{admission.text}</span>
        <span className="md-foot">{admission.detail} · 모든 공통 모델에 적용</span>
        <AdmissionControl mode={admission.mode} opsStates={opsStates} readOnly={readOnly} readable={view.readable} />
      </div>
      {view.kpis.map(kpi => <div key={kpi.id} className="md-stat" data-level={kpi.level} data-kpi={kpi.id}>
        <span className="md-k">{kpi.label}{kpi.level !== "ok" && <span className="admin-vh"> ({LEVEL_WORD[kpi.level]})</span>}</span>
        <span className="md-v llm-num">{kpi.value}</span>
        <span className="md-foot">{kpi.foot}</span>
      </div>)}
    </section>

    <div className="md-grid">
      <section className="md-panel" aria-labelledby="llm-todo-title">
        <div className="md-panel-head"><h2 id="llm-todo-title">먼저 할 일</h2><Link prefetch={false} className="md-link" href="/admin/models/history">기록 →</Link></div>
        {view.todos.length ? <div className="md-scroll"><table className="md-table md-todos"><tbody>{view.todos.map(todo => <tr key={todo.id} data-todo={todo.id}>
          <td className="md-todo-level"><LevelBadge level={todo.level}>{todo.level === "idle" ? "확인" : LEVEL_WORD[todo.level]}</LevelBadge></td>
          <td><span className="md-t">{todo.title}</span><span className="md-d">{todo.detail}</span></td>
          <td className="md-todo-acts"><div className="md-acts">
            {todo.retry?.map(retry => <RequeueButton key={retry.routeId} routeId={retry.routeId} label={retry.label} count={retry.count} named readOnly={readOnly} historyLink />)}
            <Link prefetch={false} className="md-link" href={todo.href}>{todo.action} →</Link>
          </div></td>
        </tr>)}</tbody></table></div>
          : <p className="md-empty">{view.readable ? "지금 따로 할 일이 없습니다." : "장부를 읽지 못해 할 일을 정하지 못했습니다 — 새로고침하거나 고급 설정에서 원본을 확인하세요."}</p>}
        {view.moreTodos > 0 && <p className="md-empty">그 밖에 {view.moreTodos}건 — LLM 운영·기록에서 이어서 확인합니다.</p>}
      </section>
      <section className="md-panel" aria-labelledby="llm-devices-title">
        <div className="md-panel-head"><h2 id="llm-devices-title">서버 점유</h2>
          <span className="md-acts"><Link prefetch={false} className="md-link" href="/admin/models/devices">장비 한도 →</Link><Link prefetch={false} className="md-link" href="/admin/models/llm">LLM 운영 →</Link></span></div>
        {view.devicesNote && <p className="llm-notice md-notice">{view.devicesNote}</p>}
        {view.devices.length ? <div className="md-scroll"><table className="md-table md-occ">
          <thead><tr><th>서버</th><th className="md-occ-bar">점유 <span className="md-tip" role="img" aria-label={OCCUPANCY_NOTE} title={OCCUPANCY_NOTE}>i</span></th>
            <th className="r">지금 / 한도</th></tr></thead>
          <tbody>{view.devices.map(device => <tr key={device.deviceId} data-device={device.deviceId}>
            <td><b title={device.label !== device.deviceId ? `장비 id ${device.deviceId}` : undefined}>{device.label}</b>
              {device.models.length > 0 && <span className="md-muted" title={device.models.join("\n")}> ({deviceModelsText(device.models)})</span>}
              {device.note && <span className="md-d">{device.note}</span>}</td>
            <td><span className="llm-bar" data-level={device.level} role="img" aria-label={`${device.label} 점유 ${device.held} / ${device.limit ?? "한도 확인 불가"}`}>
              {device.percent !== null && <span style={{ width: `${Math.max(device.held > 0 ? 4 : 0, device.percent)}%` }} />}</span></td>
            <td className="r nowrap"><span className="llm-num">{device.held} / {device.limit ?? "확인 불가"}</span>
              {device.level !== "ok" && <> <LevelBadge level={device.level}>{device.level === "warn" ? "가득" : "확인 불가"}</LevelBadge></>}</td>
          </tr>)}</tbody>
        </table></div> : view.readable && <p className="md-empty">관측된 장비가 없습니다.</p>}
      </section>
    </div>

    <section className="md-panel" aria-labelledby="llm-stages-title">
      <div className="md-panel-head"><h2 id="llm-stages-title">단계별 상태</h2><Link prefetch={false} className="md-link" href="/admin/models#tasks">작업 배정 →</Link></div>
      <div className="md-scroll"><table className="md-table md-stages">
        <thead><tr><th>단계</th><th>상태</th><th>모델</th><th>메모</th></tr></thead>
        <tbody>{view.stages.map(stage => <tr key={stage.id} data-stage={stage.id} data-level={stage.level}>
          <td className="nowrap"><Link prefetch={false} href={stage.href} className="md-stage-link">{stage.label}</Link></td>
          <td><LevelBadge level={stage.level}>{stage.status}</LevelBadge></td>
          <td className="md-wrap">{stage.model ?? "모델 확인 불가"}</td>
          <td className={stage.detail ? "md-wrap" : "md-muted"}>{stage.detail ?? "—"}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
  </div>;
}
