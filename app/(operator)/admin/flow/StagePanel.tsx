import Link from "next/link";
import type { ReactNode } from "react";
import { formatListTime } from "@/lib/format/time";
import { secondsText, type LimitsRow, type LimitsView } from "@/lib/operations/admin-limits-view";
import { CHANGE_VERDICT_LABELS, CHANGE_VERDICT_TONES, type ChangeWatchRow } from "@/lib/operations/change-watch";
import { formatCount, formatKst } from "@/lib/operations/console-tasks";
import type { FlowRankEditor } from "@/lib/operations/flow-rank-editor";
import type { PreviewContext, StagePanel as StagePanelModel } from "@/lib/operations/stage-panel-model";
import { LimitsEditor } from "../models/limits/LimitsEditor";
import { JobControl } from "../status/JobControl";
import { StatusDot } from "../components/StatusDot";
import { StagePanelKeys } from "./StagePanelKeys";
import { StageModels, type StageModelsInitial } from "./StageModels";
import type { PoolHelpContext } from "@/lib/operations/pool-help";
import "../models/limits/limits.css";
import "./stage-panel.css";

export const STAGE_PANEL_CLOSE_HREF = "/admin/flow";

/**
 * 단계 패널(운영 콘솔 개편 조각 2a, 2026-11-12 최종 시안 「화면 2 단계 패널」) — 흐름 표의 줄·할 일의 「단계 열기」가 연다(/admin/flow?stage=<단계>).
 * 오른쪽에 붙는 칸이고 대화상자(dialog)가 아니다 — 열어 둔 동안에도 자동 갱신이 숫자를 새로 읽는다(고치는 중에만 data-dirty 로 멈춘다).
 * 다섯 구역: 머리 · 왜 이런가 · 모델 · 한도 · 최근 바뀐 것. 모델을 쓰지 않는 단계는 같은 틀에 작업(주기·마지막 성공)과 관련 설정이 나온다.
 * 이 칸이 직접 바꾸는 것은 모두 기존 서버 동작이다: 작업 멈춤·재개(JobControl), 순위·실행 방식(StageModels), 실시간 한도(LimitsEditor).
 */
export function StagePanel({ panel, editor, context, limits, limitRows, limitImpact, changes, changesRead, csrf, jobVersions, readOnly, lockReason, now, modelsInitial, poolHelp = null, modelSettings }: {
  panel: StagePanelModel; editor: FlowRankEditor | null; context: PreviewContext;
  limits: LimitsView | null; limitRows: readonly string[]; limitImpact: Record<string, string[]>;
  changes: readonly ChangeWatchRow[]; changesRead: boolean;
  csrf: { token: string; expiresAt: number } | null; jobVersions: Record<string, number> | null;
  readOnly: boolean; lockReason: string | null; now: Date;
  /** 모델 구역의 처음 걸음(시험·화면 확인용) */
  modelsInitial?: StageModelsInitial;
  /** 「동시에」 도움말이 읽은 한도(장비·실시간 한도·수집·판정 설정) */
  poolHelp?: PoolHelpContext | null;
  /** 기존 사람 위임 모델 편집기 — 해당 패널이 열렸을 때만 서버에서 읽는다. */
  modelSettings?: ReactNode;
}) {
  const rows = limits?.groups.flatMap(group => group.rows).filter(row => limitRows.includes(row.id)) ?? [];
  return <>
    <Link prefetch={false} scroll={false} href={STAGE_PANEL_CLOSE_HREF} className="sp-backdrop" aria-label="단계 패널 닫기" tabIndex={-1} />
    <aside className="sp" aria-labelledby="sp-title" data-stage={panel.key}>
      <StagePanelKeys closeHref={STAGE_PANEL_CLOSE_HREF} />
      <section className="sp-sec sp-top">
        <div className="sp-h-row">
          <h2 id="sp-title" tabIndex={-1}>{panel.label}</h2>
          <span className="ch-st" data-tone={panel.tone}><i aria-hidden="true" />{panel.status}</span>
          <Link prefetch={false} scroll={false} href={STAGE_PANEL_CLOSE_HREF} className="sp-close" aria-label="단계 패널 닫기">✕</Link>
        </div>
        <p className="sp-kv">{panel.facts.map(fact => <span key={fact.label}>{fact.label}<b>{fact.value ?? "셀 수 없음"}</b></span>)}</p>
        {panel.spark ? <PanelSpark values={panel.spark} tone={panel.tone} /> : <p className="sp-note">시간별 처리 기록이 없는 단계입니다.</p>}
      </section>

      <section className="sp-sec" aria-labelledby="sp-why">
        <span className="sp-lab" id="sp-why">왜 이런가</span>
        <ul className="sp-cause">{panel.why.map((line, index) => <li key={`${line.label}:${index}`}><span>{line.label}</span><span>{line.text}</span></li>)}
          {!panel.why.length && <li><span>—</span><span>읽은 값에 눈에 띄는 것이 없습니다.</span></li>}</ul>
        {panel.slotsUnknown && <p className="sp-note">장비 칸 사용을 읽지 못해 모델마다 지금 칸은 적지 못했습니다.</p>}
        <div className="sp-acts">
          {panel.links.map((link, index) => <Link key={link.href} prefetch={false} className={`button small${index === 0 ? " primary" : ""}`} href={link.href}>{link.label}</Link>)}
        </div>
      </section>

      <section className="sp-sec" aria-labelledby="sp-jobs">
        <span className="sp-lab" id="sp-jobs">{panel.models ? "작업" : "작업 · 주기 · 마지막 성공"}</span>
        <ul className="sp-jobs">{panel.jobs.map(job => {
          const version = jobVersions?.[job.job];
          return <li key={job.job}>
            <div><b>{job.label}</b><span className="sp-facts">{job.text}</span></div>
            {csrf && !readOnly && version !== undefined && job.paused !== null
              ? <details className="ch-job"><summary className="button small">{job.paused ? "재개" : "잠시 멈춤"}</summary>
                <JobControl name={job.job} paused={job.paused} notBefore={job.notBefore} version={version} csrf={csrf} /></details>
              : <Link prefetch={false} className="button small" href={`/admin/status?tab=jobs&job=${encodeURIComponent(job.job)}`}>작업 상세</Link>}
          </li>;
        })}</ul>
      </section>

      {modelSettings && <section className="sp-sec" id="sp-models" aria-labelledby="sp-models-title">
        <span className="sp-lab" id="sp-models-title">모델 · AI 위임</span>
        {modelSettings}
      </section>}

      {!modelSettings && panel.models && <section className="sp-sec" id="sp-models" aria-labelledby="sp-models-title">
        <span className="sp-lab" id="sp-models-title">모델</span>
        <StageModels lines={panel.models} editor={editor} context={context} lockReason={lockReason} initial={modelsInitial} stageLabel={panel.label} poolHelp={poolHelp} />
      </section>}

      {panel.key === "audit" && <section className="sp-sec" id="sp-models" aria-labelledby="sp-audit-recovery">
        <span className="sp-lab" id="sp-audit-recovery">감사 거절 처리</span>
        <p className="sp-note">이미 공개된 제품의 재검수 결과입니다. 원본·화면과 두 번째 의견을 확인하고,
          기존 감사 화면에서 유지·내리기 또는 표본을 확인한 정책 처리를 합니다.</p>
        <p className="sp-note">유지 결정과 보류 해제는 기존 감사 화면의 검사에 따라 적용하며, 처리 기록을 남깁니다.</p>
        <div className="sp-acts">
          <Link prefetch={false} className="button small" href="/admin/models#tasks">감사 작업 모델 보기</Link>
          <Link prefetch={false} className="button small" href="/admin/audit?tab=history">감사 처리 기록</Link>
        </div>
      </section>}

      {panel.models && <section className="sp-sec" id="sp-limits" aria-labelledby="sp-limits-title">
        <span className="sp-lab" id="sp-limits-title">한도</span>
        {!limits ? <p className="sp-note">실시간 한도를 읽지 못했습니다 — <Link prefetch={false} href="/admin/models/limits">실시간 한도 →</Link></p>
          : !rows.length ? <p className="sp-note">이 단계에 따로 정하는 한도가 없습니다. 동시 실행은 장비 칸이 정합니다.</p>
          : <>
            {rows.map(row => <LimitsSummary key={row.id} row={row} many={rows.length > 1} />)}
            {limits.measuredAt ? <p className="sp-note">실측: 모델 장부 최근 24시간 · {formatListTime(limits.measuredAt, now)} 기준</p>
              : <p className="sp-note">24시간 실측을 읽지 못했습니다.</p>}
            <details className="sp-fold">
              <summary>한도 고치기</summary>
              <div className="lim sp-lim"><LimitsEditor view={limits} scope={{ rowIds: limitRows, impact: limitImpact }} /></div>
            </details>
          </>}
      </section>}

      <section className="sp-sec" aria-labelledby="sp-changes">
        <span className="sp-lab" id="sp-changes">최근 바뀐 것</span>
        {(panel.key === "human" || panel.key === "audit") && <p className="sp-note">이 목록은 작업 제어와 경로별 모델 변경을 보여 줍니다. 위임·감사 설정의 저장 기록은 전체 기록에서 확인할 수 있습니다.</p>}
        {!changesRead ? <p className="sp-note">바뀐 것을 읽지 못했습니다.</p>
          : !changes.length ? <p className="sp-note">{panel.key === "human" || panel.key === "audit"
            ? "최근 24시간에 이 목록이 추적하는 변경은 없습니다."
            : "최근 24시간에 이 단계에 닿은 변경이 없습니다."}</p>
          : <ul className="sp-cause sp-when">{changes.map(row => <li key={row.key}>
            <span className="sp-num">{formatKst(row.at)}</span>
            <span>{row.title} · {row.actor}<small>{row.beforeText ? `${row.beforeText} → ` : ""}{row.afterText}</small>
              <StatusDot state={CHANGE_VERDICT_TONES[row.verdict]} label={CHANGE_VERDICT_LABELS[row.verdict]} title={row.reason ?? undefined} /></span>
          </li>)}</ul>}
        <Link prefetch={false} className="text-button" href="/admin/activity">기록 전체 →</Link>
      </section>
    </aside>
  </>;
}

/** 한도 한 줄 — 호출 상한 · 한 틱 · 동시 호출 · 24시간 실측(상한에서 끊김) */
function LimitsSummary({ row, many }: { row: LimitsRow; many: boolean }) {
  const m = row.measure;
  const cut = m ? m.cutAtCap + m.unknownAtCap : null;
  const tick = row.tick.kind === "field" ? row.tick.field.auto ? `자동(${row.tick.field.initial}초)` : `${row.tick.field.initial}초` : row.tick.text;
  const concurrency = row.concurrency.kind === "field" ? `${row.concurrency.field.initial}${row.concurrency.field.unit}` : row.concurrency.text;
  return <p className="sp-kv" data-row={row.id}>
    {many && <span className="sp-kv-head">{row.label}</span>}
    <span>호출 상한<b>{secondsText(row.capMs)}</b></span>
    <span>상한에서 끊김<b>{m ? `24시간 ${formatCount(m.calls)}건 중 ${formatCount(cut ?? 0)}건` : "셀 수 없음"}</b></span>
    {m && m.tickCut > 0 && <span>틱 끝에서 끊김<b>{formatCount(m.tickCut)}건</b></span>}
    <span>한 틱<b>{tick}</b></span>
    <span>동시 호출<b>{concurrency}</b></span>
  </p>;
}

/** 시간별 처리 선(시안 패널의 320×44) — 마지막 점이 가장 최근 다 찬 시간 */
function PanelSpark({ values, tone }: { values: number[]; tone: string }) {
  if (values.length < 2) return null;
  const width = 320, height = 44, top = Math.max(1, ...values);
  const points = values.map((value, index) => [Math.round((index * (width - 4) / (values.length - 1) + 2) * 10) / 10,
    Math.round((height - 3 - value / top * (height - 6)) * 10) / 10]);
  const [x, y] = points.at(-1)!;
  return <svg className="ch-spark sp-spark" data-tone={tone} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img"
    aria-label={`시간별 처리, 처음 ${formatCount(values[0])} 마지막 ${formatCount(values.at(-1)!)}`}>
    <polyline points={points.map(point => point.join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx={x} cy={y} r="2.2" fill="currentColor" />
  </svg>;
}

/** 패널을 읽는 동안 — 같은 자리에 이름만 */
export function StagePanelLoading({ label }: { label: string }) {
  return <>
    <Link prefetch={false} scroll={false} href={STAGE_PANEL_CLOSE_HREF} className="sp-backdrop" aria-label="단계 패널 닫기" tabIndex={-1} />
    <aside className="sp" aria-labelledby="sp-title" aria-busy="true">
      <section className="sp-sec sp-top"><div className="sp-h-row"><h2 id="sp-title">{label}</h2>
        <Link prefetch={false} scroll={false} href={STAGE_PANEL_CLOSE_HREF} className="sp-close" aria-label="단계 패널 닫기">✕</Link></div>
        <p className="sp-note">단계를 읽는 중…</p></section>
    </aside>
  </>;
}
