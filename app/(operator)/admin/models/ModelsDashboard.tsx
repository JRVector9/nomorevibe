import Link from "next/link";
import type { OpsState } from "@/lib/operations/ops-runner/contract";
import { LLM_OPS_LEVELS, type DashboardView } from "@/lib/operations/llm-ops-view";
import { AdmissionControl } from "./AdmissionControl";
import { LEVEL_WORD, LevelBadge, LevelLegend, ObservedAt } from "./LlmOpsParts";

/**
 * 대시보드(/admin/models) — 「지금 문제없이 돌고 있나? 무엇부터 하나?」(2026-11-07 승인 시안).
 * 판단 띠 → 접수(한 곳) → KPI 4 → 먼저 할 일 · 장비 점유 → 단계별 상태. 숫자는 모두 buildDashboardView 가 기존 읽기에서 만든 것이다.
 */
export function ModelsDashboard({ view, opsStates, readOnly }: { view: DashboardView; opsStates: OpsState[]; readOnly: boolean }) {
  const { banner, admission } = view;
  return <div className="stack llm-ops" data-llm-page="dashboard">
    <div className="llm-top">
      <section className="llm-banner" data-level={banner.level} aria-labelledby="llm-banner-title">
        <span className="llm-banner-shape" aria-hidden="true">{LLM_OPS_LEVELS[banner.level].shape}</span>
        <div className="llm-banner-body">
          <p><LevelBadge level={banner.level}>{LEVEL_WORD[banner.level]}</LevelBadge></p>
          <h2 id="llm-banner-title">{banner.title}</h2>
          {banner.lines.length > 0 && <ul>{banner.lines.map(line => <li key={line}>{line}</li>)}</ul>}
          <p className="llm-banner-meta"><ObservedAt label="장부 관측" at={view.observedAt} /><ObservedAt label="흐름 관측" at={view.flowAt} /></p>
        </div>
      </section>
      <section id="admission" className="llm-card llm-admission" aria-labelledby="llm-admission-title">
        <div className="llm-admission-head"><h2 id="llm-admission-title">접수</h2><LevelBadge level={admission.level}>{admission.text}</LevelBadge></div>
        <p className="llm-admission-detail">{admission.detail}. 모든 공통 모델에 적용됩니다.</p>
        <AdmissionControl mode={admission.mode} opsStates={opsStates} readOnly={readOnly} readable={view.readable} />
      </section>
    </div>

    <section className="llm-kpis" aria-label="핵심 수치">
      {view.kpis.map(kpi => <div key={kpi.id} className="llm-kpi" data-level={kpi.level} data-kpi={kpi.id}>
        <div className="llm-kpi-top"><span>{kpi.label}</span><LevelBadge level={kpi.level}>{LEVEL_WORD[kpi.level]}</LevelBadge></div>
        <div className="llm-kpi-value llm-num">{kpi.value}</div>
        <div className="llm-kpi-foot">{kpi.foot}</div>
      </div>)}
    </section>

    <div className="llm-dash-grid">
      <section className="llm-panel" aria-labelledby="llm-todo-title">
        <div className="llm-panel-head"><h2 id="llm-todo-title">먼저 할 일</h2><Link prefetch={false} className="llm-link" href="/admin/models/history">기록 →</Link></div>
        <div className="llm-panel-body">
          {view.todos.length ? <ol className="llm-todos">{view.todos.map(todo => <li key={todo.id} className="llm-todo" data-todo={todo.id}>
            <div className="llm-todo-main"><p className="llm-todo-title"><LevelBadge level={todo.level}>{todo.level === "idle" ? "확인" : LEVEL_WORD[todo.level]}</LevelBadge>{todo.title}</p>
              <p className="llm-todo-detail">{todo.detail}</p></div>
            <Link prefetch={false} className="button small" href={todo.href}>{todo.action} →</Link>
          </li>)}</ol> : <p className="llm-empty">{view.readable ? "지금 따로 할 일이 없습니다." : "장부를 읽지 못해 할 일을 정하지 못했습니다 — 새로고침하거나 고급 설정에서 원본을 확인하세요."}</p>}
          {view.moreTodos > 0 && <p className="llm-empty">그 밖에 {view.moreTodos}건 — LLM 운영·기록에서 이어서 확인합니다.</p>}
        </div>
      </section>
      <section className="llm-panel" aria-labelledby="llm-devices-title">
        <div className="llm-panel-head"><h2 id="llm-devices-title">장비 점유</h2><Link prefetch={false} className="llm-link" href="/admin/models/llm">LLM 운영 →</Link></div>
        <div className="llm-panel-body">
          {view.devicesNote && <p className="llm-notice">{view.devicesNote}</p>}
          {view.devices.length ? <ul className="llm-devices">{view.devices.map(device => <li key={device.deviceId} className="llm-device" data-device={device.deviceId}>
            <span className="llm-device-name"><b>{device.label}</b>{device.label !== device.deviceId && <small>{device.deviceId}</small>}</span>
            <span className="llm-bar" data-level={device.level} role="img" aria-label={`${device.label} 점유 ${device.held} / ${device.limit ?? "한도 확인 불가"}`}>
              {device.percent !== null && <span style={{ width: `${Math.max(device.held > 0 ? 4 : 0, device.percent)}%` }} />}</span>
            <span className="llm-device-count"><span className="llm-num">{device.held} / {device.limit ?? "확인 불가"}</span>{device.level !== "ok" && <LevelBadge level={device.level}>{device.level === "warn" ? "가득" : "확인 불가"}</LevelBadge>}</span>
            {device.note && <span className="llm-device-note">{device.note}</span>}
          </li>)}</ul> : view.readable && <p className="llm-empty">관측된 장비가 없습니다.</p>}
          <p className="llm-empty">점유 = 예약 + 실행 중. 결과 미확정은 칸을 차지하지 않습니다. 한도는 장비 행(실제 적용 값)입니다.</p>
        </div>
      </section>
    </div>

    <section className="llm-panel" aria-labelledby="llm-stages-title">
      <div className="llm-panel-head"><h2 id="llm-stages-title">단계별 상태</h2><Link prefetch={false} className="llm-link" href="/admin/models/tasks">작업 배정 →</Link></div>
      <div className="llm-panel-body">
        <div className="llm-stages">{view.stages.map(stage => <Link key={stage.id} prefetch={false} href={stage.href} className="llm-stage" data-level={stage.level} data-stage={stage.id}>
          <span className="llm-stage-label">{stage.label}</span>
          <LevelBadge level={stage.level}>{stage.status}</LevelBadge>
          <span className="llm-stage-model">{stage.model ?? "모델 확인 불가"}</span>
          {stage.detail && <span className="llm-stage-detail">{stage.detail}</span>}
        </Link>)}</div>
        <LevelLegend />
      </div>
    </section>
  </div>;
}
