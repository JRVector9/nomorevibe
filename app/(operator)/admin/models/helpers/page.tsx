import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth/admin";
import { formatListTime } from "@/lib/format/time";
import { modelHelperIssueMessage, readModelHelpersAdminView } from "@/lib/operations/admin-model-helpers";
import { buildHelperRoutesView } from "@/lib/operations/admin-model-helpers-routes";
import { listAiConnections } from "@/lib/operations/admin-ai-tasks-repository";
import { readAdminModelsObservation } from "@/lib/operations/admin-models-repository";
import { deviceDisplayMap } from "@/lib/operations/llm-display";
import { PageStamp } from "../../components/PageStamp";
import { modelsAdvancedEditor } from "../../workspace-navigation";
import { AdvancedEditorLinks, advancedEditorTitle } from "../advanced/AdvancedEditorLinks";
import { HashTarget } from "../advanced/HashTarget";
import { HelperForm } from "./HelperForm";
import { HelperTable } from "./HelperTable";
import { SupervisorCard } from "./SupervisorCard";
import { llmHistoryHref, RECENT_AUDIT_ROWS } from "@/lib/operations/llm-ops-history";
import "./helpers.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: advancedEditorTitle("helpers"), robots: { index: false } };
const EDITOR = modelsAdvancedEditor("helpers");
const ALLOCATION = modelsAdvancedEditor("allocation");
const ROUTE_SHAPE = { ok: "●", warn: "▲", bad: "■", idle: "‖" } as const;

/**
 * 보조 모델(도우미·감시자, 2026-11-09 승인 시안) — 다른 모델 화면과 같은 머리(경로 · 제목 · 한 줄 요약 · 수)와 패널 넷:
 * 감시자(표 한 줄) · 도우미 배정(8열, 줄의 「설정」으로 배정별 폼) · 보조 작업 경로(local-assist-*, 장부 관측) · 자동 정지. 최근 기록은 접는다.
 * 감시자 신호는 도우미 경로를 열 뿐 우선 역할 일을 막지 못한다. 신호가 없거나 만료·다른 epoch·판·계정이면 도우미는 닫힌다(fail-closed).
 * 상태는 readHelperStatusSnapshot 한 번(DB 시계)에서, 보조 작업 경로는 대시보드와 같은 장부 관측(readAdminModelsObservation, 처리량 표본 없이)에서 만든다.
 */
export default async function ModelHelpersPage() {
  if (!await currentAdmin()) redirect("/admin/login");
  const [view, connections, observation] = await Promise.all([readModelHelpersAdminView(), listAiConnections().catch(() => null),
    readAdminModelsObservation({ throughput: false })]);
  // 장비 id → 보이는 이름(그 장비를 쓰는 연결 이름 — llm-display deviceDisplay). 장비 id 는 title 로만 남는다
  const ids = [...view.helpers.map(row => row.deviceId), ...(view.supervisor?.deviceDemand ?? []).map(entry => entry.deviceId),
    ...(view.supervisor?.roleDemand ?? []).map(entry => entry.deviceId)];
  const names: Record<string, string> = Object.fromEntries([...deviceDisplayMap(connections, null, ids)].map(([id, display]) => [id, display.name]));
  const routes = buildHelperRoutesView({ observation, connections });
  const now = new Date(view.nowMs);
  const readOnly = view.snapshotError !== null;
  return <main className="mh-page">
    <PageStamp />
    <HashTarget />
    <header className="mh-head">
      <div>
        <AdvancedEditorLinks next={["devices", "allocation"]} />
        <h1>{EDITOR.label}</h1>
      </div>
      <p className="mh-meta">
        {view.supervisor && <span>감시자 <b>{view.supervisor.badgeLabel}</b></span>}
        <span>배정 <b className="mh-num">{view.helpers.length}</b></span>
        <span>돕는 중 <b className="mh-num">{view.counts.help}</b> · 섀도만 <b className="mh-num">{view.counts.shadowOnly}</b> · 쉬는 중 <b className="mh-num">{view.counts.hold}</b></span>
        {routes.readable && <span>보조 작업 <b className="mh-num">{routes.rows.length}</b>{routes.idle > 0 && <> · 쉼 {routes.idle}</>}</span>}
      </p>
    </header>
    <p className="mh-lede">서버의 자기 일이 쉬면 1·2차 검수를 돕습니다. 감시자 신호가 없으면 돕지 않을 뿐, 자기 일은 막지 않습니다. 섀도 결과는 어떤 판정에도 쓰이지 않습니다.</p>
    {view.snapshotError && <p role="alert" className="mh-alert">도우미 상태를 읽지 못했습니다({modelHelperIssueMessage(view.snapshotError)}). 아래는 비어 있고 저장할 수 없습니다.</p>}
    {view.issues.map(text => <p key={text} role="alert" className="mh-alert mh-warn">{text}</p>)}

    <section id="supervisor" className="mh-panel" aria-labelledby="mh-supervisor-title">
      <div className="mh-panel-head"><h2 id="mh-supervisor-title">감시자</h2><span className="mh-muted">{view.supervisor?.location ?? "Oracle"}</span></div>
      <SupervisorCard supervisor={view.supervisor} readOnly={readOnly} names={names} />
    </section>

    <section id="helpers" className="mh-panel" aria-labelledby="mh-helpers-title">
      <div className="mh-panel-head"><h2 id="mh-helpers-title">도우미 배정<span className="mh-count">{view.helpers.length}</span></h2>
        <span className="mh-muted">「지금」은 신호를 쓸 수 있을 때의 판정, 아니면 「쉬는 중」과 그 이유</span></div>
      <HelperTable helpers={view.helpers} now={now} names={names} form={{ defaults: view.defaults, routeDefaults: view.routeDefaults, readOnly }} />
      <div className="mh-panel-foot">
        <details id="new" className="mh-details">
          <summary>새 배정 +</summary>
          <div className="mh-detail">
            <p className="mh-muted">장비 × 단계마다 하나입니다. 도우미 경로는 그 장비에서 순위 2 이상이고 정책에 먼저 있어야 저장됩니다 — 경로는 DRAIN 없이 정책에 덧붙일 수 있습니다. 새 배정은 꺼짐으로 만드세요.</p>
            <HelperForm helper={null} defaults={view.defaults} routeDefaults={view.routeDefaults} readOnly={readOnly} bare />
          </div>
        </details>
      </div>
    </section>

    <section id="assist-routes" className="mh-panel" aria-labelledby="mh-routes-title">
      <div className="mh-panel-head"><h2 id="mh-routes-title">보조 작업 경로<span className="mh-count">{routes.rows.length}</span></h2>
        <span className="mh-muted">마지막 사용 {routes.lastSuccessAt ? formatListTime(routes.lastSuccessAt, now) : "24시간 안 없음"}
          {" · "}<Link href={ALLOCATION.href} prefetch={false} className="mh-link">{ALLOCATION.label} →</Link></span></div>
      {routes.error ? <p role="alert" className="mh-empty mh-warn">{routes.error}</p>
        : routes.rows.length === 0 ? <p className="mh-empty">정책·장부에 보조 작업 경로(local-assist-*)가 없습니다.</p>
        : <div className="mh-scroll"><table className="mh-table mh-routes">
          <thead><tr><th>작업</th><th>서버</th>
            <th className="r" title="최근 24시간 안 마지막 성공 정산(장부 관측). 더 오래된 사용은 이 화면이 읽지 않습니다.">마지막 사용</th><th>상태</th></tr></thead>
          <tbody>{routes.rows.map(row => <tr key={`${row.routeId}:${row.deviceId}`} data-route={row.routeId}>
            <td title={row.routeId}>{row.label}{!row.inPolicy && <span className="mh-sub">정책에 없음(장부만)</span>}</td>
            <td><span title={[`장비 id ${row.deviceId}`, ...row.models].join("\n")}>{row.server}</span></td>
            <td className="r nowrap">{row.lastSuccessAt ? <span className="mh-num">{formatListTime(row.lastSuccessAt, now)}</span> : <span className="mh-muted">24시간 안 없음</span>}</td>
            <td><span className="mh-lv" data-l={row.level} data-shape={ROUTE_SHAPE[row.level]}>{row.status}</span></td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    <section id="stops" className="mh-panel" aria-labelledby="mh-stops-title">
      <div className="mh-panel-head"><h2 id="mh-stops-title">자동 정지<span className="mh-count">{view.stops.length}</span></h2>
        <span className="mh-muted">배정을 다시 저장하거나 「자동 정지 해제」로 판을 올리면 풀립니다</span></div>
      {view.stops.length === 0 ? <p className="mh-empty">지금 걸린 자동 정지가 없습니다.</p>
        : <div className="mh-scroll"><table className="mh-table mh-stops">
          <thead><tr><th>시각</th><th>배정 · 판</th><th>효과</th><th>이유</th><th>근거</th><th>쓴 계정</th></tr></thead>
          <tbody>{view.stops.map(stop => <tr key={stop.id}>
            <td className="nowrap">{formatListTime(stop.createdAt, now)}</td>
            <td><a href={`#helper-${stop.assignmentId}`} className="mh-link"><code>{stop.assignmentId}</code></a> · <span className="mh-num">{stop.version}</span></td>
            <td className="mh-alert">{stop.effectLabel}</td>
            <td>{stop.reasonLabel}</td>
            <td><code className="whitespace-pre-wrap">{stop.evidence}</code></td>
            <td><code>{stop.writtenBy}</code></td>
          </tr>)}</tbody></table></div>}
    </section>

    <section id="audit" className="mh-panel" aria-labelledby="mh-audit-title">
      <details>
        <summary className="mh-panel-head mh-summary"><h2 id="mh-audit-title">최근 기록<span className="mh-count">{Math.min(view.audit.length, RECENT_AUDIT_ROWS)}</span></h2></summary>
        {view.audit.length === 0 ? <p className="mh-empty">아직 기록이 없습니다.</p>
          : <div className="mh-scroll"><table className="mh-table mh-audit">
            <thead><tr><th>시각</th><th>누가</th><th>무엇</th><th>대상 · 판</th><th>바뀐 값</th></tr></thead>
            <tbody>{view.audit.slice(0, RECENT_AUDIT_ROWS).map(row => <tr key={row.id}>
              <td className="nowrap">{formatListTime(row.at, now)}</td>
              <td>{row.actor}</td>
              <td>{row.actionLabel}{!row.ok && <span className="mh-alert"> 거절</span>}</td>
              <td><code>{row.target}</code>{row.version !== null && <> · <span className="mh-num">{row.version}</span></>}</td>
              <td>{row.ok ? (row.changes.length ? row.changes.map(line => <div key={line}>{line}</div>) : "—")
                : <span className="mh-alert">{row.error ? modelHelperIssueMessage(row.error) : "거절"}</span>}</td>
            </tr>)}</tbody></table></div>}
      </details>
    </section>
    <p><Link href={llmHistoryHref({ kind: "limit" })} prefetch={false} className="mh-link">LLM 운영 › 기록에서 전체 보기 →</Link></p>
  </main>;
}
