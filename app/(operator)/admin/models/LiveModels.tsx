"use client";
import { useState, useTransition } from "react";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { buildModelCards, elapsedModelTime, lastModelSuccess, MODEL_DASHBOARD_STAGES, MODEL_ROW_STATUS, modelCardAnchor, modelStageId, probeIdentityOf,
  stageHealth, stageUnknownRows, type CapacityAlarmSummary, type ModelCard, type ModelContractLink, type ModelStageAssignment, type StageHealth } from "@/lib/operations/admin-models-view";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import type { ProbeObservation } from "@/lib/operations/admin-models-probe";
import { throughputModelKey, type ThroughputWindows } from "@/lib/operations/admin-models-throughput";
import { probeAdminModel, type ModelProbeResult } from "./operation-actions";
import { ModelOpsPanel } from "./ModelOpsPanel";
import type { OpsState } from "@/lib/operations/ops-runner/contract";
import { ModelStageTable, ModelStatusBadge, PROBE_PROVIDERS, cardProvider } from "./ModelStageTable";
import { SummaryTiles, type LeaseTile } from "./SummaryTiles";

export { ModelStatusBadge, PROBE_PROVIDERS };
const ago = (at: string | null, now: string | null) => at ? `${elapsedModelTime(at, now)} 전` : "기록 없음";

/** 장부를 읽지 못했을 때만 쓰는 단계 띠 — 모든 단계가 「미확인」임을 한 줄로 보인다(정상 화면은 단계 × 모델 표가 대신한다). */
export function StageStatusRibbon({ observation, cards }: { observation: AdminModelsObservation; cards: ModelCard[] }) {
  return <div className="grid grid-flow-col auto-cols-[170px] grid-rows-1 sm:grid-rows-2 gap-2 overflow-x-auto pb-2 lg:grid-flow-row lg:auto-cols-auto lg:grid-cols-6 lg:grid-rows-none" aria-label="단계별 지금 상태">
    {MODEL_DASHBOARD_STAGES.map(stage => {
      const rows = observation.rows.filter(row => modelStageId(row.routeId) === stage.id);
      const requests = observation.requests.filter(row => modelStageId(row.routeId) === stage.id);
      const status: StageHealth = stageHealth(observation, rows, requests), unknown = stageUnknownRows(observation, rows).reduce((n, row) => n + row.indeterminate, 0);
      const card = cards.find(card => card.stages.includes(stage.id));
      return <a key={stage.id} href={card ? `#${modelCardAnchor(card.id)}` : "#model-settings"} className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-bg-card p-2.5 hover:border-accent">
        <span className="text-[13px] font-semibold">{stage.label}</span>
        <div className="flex flex-wrap gap-1"><ModelStatusBadge status={status} muted={status === "미확인" && !unknown}>{status === "미확인" && unknown > 0 ? `미확인 ${unknown}건` : status}</ModelStatusBadge>{unknown > 0 && status !== "미확인" && <ModelStatusBadge status="미확인">미확인 {unknown}건</ModelStatusBadge>}</div>
        <span className="text-[13px] text-fg-2">마지막 성공 {ago(lastModelSuccess(rows), observation.observedAt)}</span>
      </a>;
    })}
  </div>;
}
export function ThroughputMetrics({ value }: { value?: ThroughputWindows }) {
  const duration = (ms: number | null | undefined) => ms == null ? "기록 없음" : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}초` : `${(ms / 60000).toFixed(1)}분`;
  return <div className="overflow-x-auto"><table className="w-full text-left text-[13px] tabular-nums" aria-label="건당 처리량">
    <thead className="text-fg-2"><tr><th className="py-1 font-normal">종료 기준</th><th className="font-normal">중앙값</th><th className="font-normal">p90</th><th className="font-normal">건/시간</th><th className="font-normal">실패율</th></tr></thead>
    <tbody>{(["hour", "day"] as const).map(window => { const row = value?.[window]; return <tr key={window} className="border-t border-line">
      <th className="py-2 font-medium">{window === "hour" ? "1시간" : "24시간"}<span className="block text-[13px] font-normal text-fg-2">{row?.count ? `${row.count}건` : "기록 없음"}</span></th>
      <td>{duration(row?.medianMs)}</td><td>{duration(row?.p90Ms)}</td><td>{row?.perHour == null ? "기록 없음" : row.perHour.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}</td>
      <td title={`판정 가능한 종료 ${row?.classified ?? 0}건`}>{row?.failureRate == null ? "기록 없음" : `${(row.failureRate * 100).toFixed(1)}%`}</td>
    </tr>; })}</tbody>
  </table></div>;
}

/**
 * 한 화면의 「요약 타일 4개 + 단계 × 모델 표」(2026-10-31 승인 시안). 접수·재시작·해제 버튼은 ModelOpsPanel 의 확인 대화상자·작업 큐를 그대로 쓴다.
 * 연결 확인 결과는 서버 액션이 관측 표에 남기고(probes), 이 화면에서 방금 받은 결과(localProbes)가 있으면 그것을 먼저 보인다.
 */
export function LiveModels({ observation, models = [], assignments = [], contracts = [], probeAction = probeAdminModel, opsStates = [], restartModels = [], opsActions,
  probes = {}, leases = [], readiness = null, alarms = null }: {
  observation: AdminModelsObservation; models?: readonly ModelDefinition[]; assignments?: ModelStageAssignment[]; contracts?: ModelContractLink[];
  probeAction?: typeof probeAdminModel; opsStates?: OpsState[]; restartModels?: { key: string; label: string; blockedReason?: string }[];
  opsActions?: Pick<React.ComponentProps<typeof ModelOpsPanel>, "submitAction" | "readAction">;
  probes?: Record<string, ProbeObservation>; leases?: LeaseTile[]; readiness?: "ok" | "alarm" | null; alarms?: CapacityAlarmSummary | null;
}) {
  const [, start] = useTransition();
  const [localProbes, setProbes] = useState<Record<string, ModelProbeResult>>({}), [busy, setBusy] = useState<string | null>(null);
  const cards = buildModelCards(observation, models, assignments, contracts);
  const unknownCount = observation.rows.reduce((n, row) => n + row.indeterminate, 0);
  const runProbe = (card: ModelCard) => { setBusy(card.id); start(async () => {
    // 서버 액션은 장부에 있는 식별자(경로·제공자·모델)로 검증한다 — 등록부 키가 아니라 장부 행을 보낸다(없으면 등록부 식별자).
    const row = card.rows[0] ?? { routeId: card.stages[0] ?? "", provider: probeIdentityOf(card).provider, model: probeIdentityOf(card).model };
    try { const next = await probeAction({ routeId: row.routeId, provider: row.provider, model: row.model }); setProbes(current => ({ ...current, [card.id]: next })); }
    catch { setProbes(current => ({ ...current, [card.id]: { error: "연결 확인 결과를 읽지 못했습니다. 감사 기록을 확인해주세요." } })); }
    finally { setBusy(null); }
  }); };
  const slots = new Set(cards.map(card => `${probeIdentityOf(card).provider}:${probeIdentityOf(card).model}`)).size;
  const stageRows = cards.reduce((n, card) => n + Math.max(1, new Set(card.stages).size), 0);
  return <section className="flex min-w-0 flex-col gap-3" aria-labelledby="live-models-heading">
    <h2 id="live-models-heading" className="sr-only">지금 상태</h2>
    {observation.error ? <><StageStatusRibbon observation={observation} cards={cards} /><p role="alert" className="rounded-lg border border-down/30 bg-down/5 p-4 text-down">{observation.error}</p></> : <>
      <ModelOpsPanel mode={observation.mode} requests={[]} models={[]} initialStates={opsStates} {...opsActions}
        renderControls={controls => <div className="flex min-w-0 flex-col gap-3">
          <SummaryTiles observation={observation} cards={cards} controls={controls} probes={probes} leases={leases} readiness={readiness} alarms={alarms} />
          {unknownCount > 0 && <p role="alert" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]"><strong className="text-warn">확인 못함 {unknownCount}건 · 사람 검토</strong> — 슬롯을 점유하지 않습니다. 표의 「미확인」 수를 누르면 <a href="#review" className="underline underline-offset-[3px]">검토 목록</a>의 그 요청으로 갑니다.</p>}
          {observation.truncated && <p role="alert" className="text-[13px]">열린 요청은 미확인 우선 100건만 표시합니다. 점유·미확인 합계는 전체 장부 기준입니다.</p>}
          <section className="min-w-0 rounded-xl border border-line bg-bg-card" aria-labelledby="models-table-heading">
            <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 border-b border-line px-3 py-2.5">
              <h2 id="models-table-heading" className="text-[15px] font-semibold">단계 × 모델</h2>
              <p className="min-w-0 flex-[1_1_240px] text-[13px] text-fg-2">연결 확인: 카테고리·검색·사람 위임 슬롯은 렌더마다 자동, 나머지는 「연결 확인」 버튼(abcllm·local-direct 제공자만). 같은 장비·같은 모델은 하나의 확인 결과를 공유하며 결과는 관측 표에 남아 새로고침 뒤에도 보입니다.</p>
              <span className="text-[13px] text-fg-2 tabular-nums"><span className="font-mono">{stageRows}</span>행 · 모델 슬롯 <span className="font-mono">{slots}</span>개</span>
            </div>
            <p className="px-3 pt-2 text-[13px] text-fg-2 md:hidden">표를 좌우로 밀어 모든 열을 확인하세요.</p>
            <ModelStageTable cards={cards} observation={observation} controls={controls} probes={probes} localProbes={localProbes} busy={busy} onProbe={runProbe} restartModels={restartModels} />
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-line px-3 py-2 text-[13px] text-fg-2" aria-label="범례">
              <span>상태:</span>{(Object.keys(MODEL_ROW_STATUS) as (keyof typeof MODEL_ROW_STATUS)[]).map(key => <ModelStatusBadge key={key} status={key} />)}
              <span>· 왼쪽 줄: 실선 빨강 = 연결 안 됨, 점선 노랑 = 확인 못함, 노랑 = 보류, 회색 = 접수 중지 · 마지막 성공은 최근 24시간 안 기록 · 시각은 KST</span>
            </div>
          </section>
          <p className="text-[13px] leading-relaxed text-fg-2">접수 일시중지/재개는 모든 공통 모델에 적용됩니다. 장비 칸의 작은 글씨는 이름의 출처(주소·등록부·같은 이름 항목·장비 그룹·이름표·주소로 추정·그룹 ID)이며 주소는 host:port 만 보입니다.
            처리 시간은 장부 접수 → 실제 종료(대기 포함). 1시간 성공·실패는 최근 1시간의 실제 종료만 집계하며 철회·미확인 요청은 처리량에 넣지 않습니다.</p>
        </div>} />
      <details className="rounded-xl border border-line bg-bg-card p-4"><summary className="cursor-pointer text-[14px] font-semibold">단계별 건당 처리량 · 최근 1시간 / 24시간</summary>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{MODEL_DASHBOARD_STAGES.map(stage => <div key={stage.id} className="min-w-0"><h3 className="mb-2 text-[13px] font-semibold">{stage.label}</h3>
          <ThroughputMetrics value={observation.throughput?.byStage[stage.id]} /></div>)}
          {cards.filter(card => card.definition).map(card => <div key={card.id} className="min-w-0"><h3 className="mb-2 text-[13px] font-semibold">모델 · [{card.equipment}] {card.name}</h3>
            <ThroughputMetrics value={observation.throughput?.byModel[throughputModelKey({ provider: cardProvider(card), model: card.definition?.key ?? card.rows[0]?.model ?? "" })]} /></div>)}</div>
        <p className="mt-3 text-[13px] leading-relaxed text-fg-2">p90: 90%의 요청이 이 시간 안에 종료. 실패율은 성공·실패 판정이 있는 종료만 분모로 사용합니다. 업무 승인·발행 성공과는 다릅니다.</p>
      </details>
    </>}
  </section>;
}
