"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { buildModelCards, elapsedModelTime, lastModelSuccess, MODEL_DASHBOARD_STAGES, modelCardAnchor, modelRecoveryBlocked, modelStageId,
  modelStageLabel, modelTransportLabel, stageHealth, stageUnknownRows, type ModelCard, type ModelContractLink, type ModelStageAssignment,
  type StageHealth } from "@/lib/operations/admin-models-view";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import { throughputModelKey, type ThroughputWindows } from "@/lib/operations/admin-models-throughput";
import { probeAdminModel, type ModelProbeResult } from "./operation-actions";
import { buttonSmall } from "../settings/Switch";
import { ModelOpsPanel, type ModelOpsControls } from "./ModelOpsPanel";
import type { OpsState } from "@/lib/operations/ops-runner/contract";

const stamp = (at: string | null) => at ? `${at.slice(0, 10)} ${at.slice(11, 19)} UTC` : "기록 없음";
const ago = (at: string | null, now: string | null) => at ? `${elapsedModelTime(at, now)} 전` : "기록 없음";
const sum = (card: ModelCard, key: "succeeded1h" | "failed1h" | "dispatched" | "reserved" | "waiting" | "indeterminate") => card.rows.reduce((n, row) => n + row[key], 0);
const PROBE_PROVIDERS = ["abcllm", "local-direct"];
const cardProvider = (card: ModelCard) => card.definition?.provider ?? card.rows[0]?.provider ?? card.requests[0]?.provider ?? "";
const tone: Record<string, string> = { 정상: "bg-up/10 text-up", 느림: "bg-warn/10 text-warn",
  미확인: "bg-down/10 text-down", "접수 중지": "bg-bg-hover text-fg-2", "처리 중": "bg-accent-soft text-accent-ink",
  보류: "bg-warn/10 text-warn", "연결 안 됨": "bg-bg-hover text-fg-2", 내려감: "bg-down/10 text-down" };
export function ModelStatusBadge({ status, children, muted }: { status: string; children?: React.ReactNode; muted?: boolean }) {
  return <span className={`inline-flex shrink-0 items-center rounded-md px-2 py-1 text-[13px] font-semibold ${muted ? tone["접수 중지"] : tone[status] ?? tone["미확인"]}`}>{children ?? status}</span>;
}
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
/** 모델 목록 표의 열(2026-10-31 사용자 요청: 카드 묶음 → 리스트). 한 줄에 못 들어가는 요청·처리량·내부 ID 는 아래 보조 줄로. */
export const MODEL_LIST_COLUMNS = ["단계", "모델", "장비", "전송", "상태", "점유 / 한도", "1시간 성공 · 실패", "최근 활동", "동작"] as const;
export function LiveModels({ observation, models = [], assignments = [], contracts = [], probeAction = probeAdminModel, opsStates = [], restartModels = [], opsActions }: {
  observation: AdminModelsObservation; models?: readonly ModelDefinition[]; assignments?: ModelStageAssignment[]; contracts?: ModelContractLink[];
  probeAction?: typeof probeAdminModel; opsStates?: OpsState[]; restartModels?: { key: string; label: string; blockedReason?: string }[];
  opsActions?: Pick<React.ComponentProps<typeof ModelOpsPanel>, "submitAction" | "readAction">;
}) {
  const router = useRouter(), [busy, start] = useTransition();
  const [probes, setProbes] = useState<Record<string, ModelProbeResult>>({});
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) router.refresh(); }, 30000);
    return () => clearInterval(timer); }, [router]);
  const cards = buildModelCards(observation, models, assignments, contracts);
  const unknownCount = observation.rows.reduce((n, row) => n + row.indeterminate, 0);
  const runProbe = (card: ModelCard) => start(async () => {
    const row = card.rows[0] ?? { routeId: card.stages[0], provider: card.definition!.provider, model: card.definition!.key };
    try { const next = await probeAction({ routeId: row.routeId, provider: row.provider, model: row.model });
      setProbes(current => ({ ...current, [card.id]: next }));
    } catch { setProbes(current => ({ ...current, [card.id]: { error: "연결 확인 결과를 읽지 못했습니다. 감사 기록을 확인해주세요." } })); }
  });
  return <section className="flex min-w-0 flex-col gap-4" aria-labelledby="live-models-heading">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 id="live-models-heading" className="text-[20px] font-bold">지금 상태</h2>
      <p className="mt-1 text-[13px] text-fg-2">관측 {stamp(observation.observedAt)} · 30초 자동 새로고침</p></div>
      <button type="button" className={buttonSmall} onClick={() => router.refresh()}>수동 새로고침</button></div>
    {observation.error && <StageStatusRibbon observation={observation} cards={cards} />}
    {observation.error ? <p role="alert" className="rounded-lg border border-down/30 bg-down/5 p-4 text-down">{observation.error}</p> : <>
      {unknownCount > 0 && <div role="alert" className="flex flex-col gap-2 rounded-xl border border-down/30 bg-down/5 p-4 text-[13px]">
        <strong className="text-down">확인 못함 {unknownCount}건 · 사람 검토 — 슬롯을 점유하지 않습니다(아래 목록에서 검토 완료)</strong>
        {cards.filter(card => sum(card, "indeterminate") > 0).map(card => { const request = card.requests.find(row => row.state === "indeterminate");
          // 2026-10-30: 미확인은 점유가 아니다 — 슬롯 상태와 섞지 않고 "확인 못함 · 사람 검토"로만 알린다.
          return <div key={card.id} className="flex flex-wrap items-center justify-between gap-2"><p>
            모델 확인 못함 · 사람 검토 · 단계 {card.stages.map(modelStageLabel).join(" · ")} — [{card.equipment}] {card.name} · 미확인 {sum(card, "indeterminate")}건 · {request ? `${elapsedModelTime(request.dispatchedAt ?? request.queuedAt, observation.observedAt)}째` : "시작 시각 미확인"}</p>
            <a className="font-semibold text-down underline underline-offset-4" href={`#${modelCardAnchor(card.id)}`}>표의 행으로 이동 ↓</a></div>;
        })}
      </div>}
      <StageStatusRibbon observation={observation} cards={cards} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-fg-2"><p>접수 <strong>{observation.mode?.toUpperCase()}</strong> · 점유 {observation.groups.reduce((n, row) => n + row.held, 0)} · 장비 {observation.groups.length}개{observation.groups.some(row => row.lending) ? ` · 빌려 쓰는 중 ${observation.groups.filter(row => row.lending).length}개` : ""}{observation.devicesRead ? "" : " · 장비 한도 미확인"} · <Link className="underline underline-offset-4" href="/admin/models/devices">장비 한도·우선순위</Link></p>
        <p>확인 못함 요청은 슬롯을 점유하지 않습니다 · 사람 검토 뒤 검토 완료로 닫습니다 · 자동 회수 기본 꺼짐</p></div>
      {observation.truncated && <p role="alert">열린 요청은 미확인 우선 100건만 표시합니다. 점유·미확인 합계는 전체 장부 기준입니다.</p>}
      <ModelOpsPanel mode={observation.mode} requests={[]} models={[]} initialStates={opsStates} {...opsActions}
        renderControls={controls => <div className="flex min-w-0 flex-col gap-2">
          <p className="text-[13px] text-fg-2 md:hidden">표를 좌우로 밀어 모든 열을 확인하세요.</p>
          <div className="overflow-x-auto rounded-xl border border-line bg-bg-card" role="region" aria-label="모델 목록" tabIndex={0}>
            <table className="w-full min-w-[1120px] border-collapse text-left text-[13px]">
              <thead className="text-fg-2"><tr className="border-b border-line">{MODEL_LIST_COLUMNS.map(column => <th key={column} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{column}</th>)}</tr></thead>
              {cards.map(card => <ModelLiveRow key={card.id} card={card} observation={observation} controls={controls} probe={probes[card.id]}
                busy={busy} onProbe={() => runProbe(card)} recovery={restartModels.find(model => model.key === card.id)} />)}
              {!cards.length && <tbody><tr><td colSpan={MODEL_LIST_COLUMNS.length} className="px-3 py-4">관측된 모델이 없습니다. 설정과 장부 수집 경로를 확인해주세요.</td></tr></tbody>}
            </table>
          </div>
          <p className="text-[13px] leading-relaxed text-fg-2">접수 중지/재개는 모든 공통 모델에 적용됩니다. 연결 확인은 abcllm·local-direct 제공자만 — 다른 제공자의 모델 목록 조회 실행기는 연결되지 않았습니다.
            장비 칸의 작은 글씨는 이름의 출처(주소·등록부·같은 이름 항목·장비 그룹·이름표·주소로 추정·그룹 ID)이며 주소는 host:port 만 보입니다.</p>
        </div>} />
      <details className="rounded-xl border border-line bg-bg-card p-4"><summary className="cursor-pointer text-[14px] font-semibold">단계별 건당 처리량 · 최근 1시간 / 24시간</summary>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{MODEL_DASHBOARD_STAGES.map(stage => <div key={stage.id} className="min-w-0"><h3 className="mb-2 text-[13px] font-semibold">{stage.label}</h3>
          <ThroughputMetrics value={observation.throughput?.byStage[stage.id]} /></div>)}</div>
      </details>
      <p className="text-[13px] leading-relaxed text-fg-2">처리 시간: 장부 접수 → 실제 종료(대기 포함). p90: 90%의 요청이 이 시간 안에 종료. 최근 1시간·24시간의 실제 종료만 집계하며 업무 승인·발행 성공과는 다릅니다. 실패율은 성공·실패 판정이 있는 종료만 분모로 사용합니다. 철회·미확인 요청은 처리량에 넣지 않습니다. 마지막 성공은 최근 24시간 내 기록입니다.</p>
    </>}
  </section>;
}
/** 모델 한 줄(+ 보조 줄). 본 줄은 단계·모델·장비·전송·상태·점유·1시간·최근 활동·동작, 보조 줄은 열린 요청·연결 확인 결과·자세히(처리량·내부 ID). */
function ModelLiveRow({ card, observation, controls, probe, busy, onProbe, recovery }: {
  card: ModelCard; observation: AdminModelsObservation; controls: ModelOpsControls; probe?: ModelProbeResult; busy: boolean; onProbe: () => void;
  recovery?: { key: string; blockedReason?: string };
}) {
  const unknown = sum(card, "indeterminate"), waiting = sum(card, "waiting"), held = sum(card, "reserved") + sum(card, "dispatched");
  const groups = observation.groups.filter(group => card.rows.some(row => row.groupId === group.groupId));
  const limit = groups.length && groups.every(group => group.limit !== null) ? groups.reduce((n, group) => n + group.limit!, 0) : null;
  const blocked = !card.definition ? "등록부에서 장비·실행 대상을 확인하지 못했습니다." : recovery ? recovery.blockedReason : modelRecoveryBlocked(card.definition.equipment, card.definition.provider);
  const status = unknown ? "미확인" : probe?.listed === false ? "내려감" : probe?.error ? "연결 안 됨" : sum(card, "dispatched") + sum(card, "reserved") ? "처리 중" : waiting ? "보류" : lastModelSuccess(card.rows) || probe?.listed ? "정상" : "연결 안 됨";
  const requests = card.requests.filter(row => row.state === "indeterminate" || row.state === "waiting");
  const provider = cardProvider(card), probeable = PROBE_PROVIDERS.includes(provider), label = `[${card.equipment}] ${card.name}`;
  const cell = "px-3 py-3 align-top";
  return <tbody id={modelCardAnchor(card.id)} className={`scroll-mt-28 border-b border-line md:scroll-mt-6 ${unknown ? "bg-down/5" : ""}`} aria-label={label}>
    <tr>
      <td className={cell}>{card.stages.length ? card.stages.map(stage => <span key={stage} className="block whitespace-nowrap">{modelStageLabel(stage)}</span>) : <span className="text-fg-2">사용 단계 미확인</span>}</td>
      <td className={`${cell} min-w-[200px]`}><strong className="break-words text-[14px] font-bold leading-snug">{card.name}</strong>
        {card.definition && <span className="block text-fg-2">{card.definition.displayName}</span>}</td>
      <td className={cell}><span className="block font-semibold">{card.equipment}</span>
        {card.equipmentSource ? <span className="block text-fg-2">{card.equipmentSource}</span>
          : <Link href="/admin/models/contracts" prefetch={false} className="block text-accent-ink underline underline-offset-4">등록부에 장비 이름 붙이기 →</Link>}</td>
      <td className={cell}><span className="block">{provider || "제공자 미확인"}</span><span className="block text-fg-2">{modelTransportLabel(provider, card.contracts)}</span>
        {card.hosts.map(host => <code key={host} className="block break-all text-fg-2">{host}</code>)}</td>
      <td className={cell}><ModelStatusBadge status={status} />
        {status === "연결 안 됨" && !probe && <span className="mt-1 block text-fg-2">최근 성공·연결 확인 기록 없음</span>}</td>
      <td className={`${cell} tabular-nums`}><strong className="text-[14px]">{held} / {limit ?? "미확인"}</strong>{groups.some(group => group.lending) && <span className="block text-fg-2">빌려 쓰는 중</span>}
        <span className="block text-fg-2">대기 {waiting}</span><span className={`block ${unknown ? "font-semibold text-down" : "text-fg-2"}`}>미확인 {unknown}건</span></td>
      <td className={`${cell} tabular-nums`}><strong className="text-[14px] text-up">{sum(card, "succeeded1h")}건</strong><span className="block">실패 {sum(card, "failed1h")}건</span></td>
      <td className={cell} title={stamp(lastModelSuccess(card.rows))}>마지막 성공<strong className="block font-medium">{ago(lastModelSuccess(card.rows), observation.observedAt)}</strong></td>
      <td className={cell}><div className="flex flex-wrap gap-2">
        <button type="button" className={buttonSmall} disabled={busy || !probeable} title={probeable ? undefined : "이 제공자의 모델 목록 조회 실행기가 연결되지 않았습니다."} onClick={onProbe}>연결 확인</button>
        <button type="button" className={buttonSmall} disabled={controls.disabled || !!blocked || !card.definition} title={blocked}
          onClick={() => controls.open("model-restart", card.definition!.key, label)}>모델 재시작</button>
        <AdmissionButton observation={observation} controls={controls} /></div></td>
    </tr>
    <tr><td colSpan={MODEL_LIST_COLUMNS.length} className="px-3 pb-3 pt-0">
      <div className="flex flex-col gap-2">
        {(requests.length > 0 || unknown > 0) && <div className="flex flex-col gap-3 rounded-lg border border-down/25 bg-down/5 p-3">
          {requests.map(request => <div key={request.requestId}><strong className="text-down">{request.state === "indeterminate" ? "확인 못함" : "보류"}</strong>
            <p className="mt-1">요청 시작 {stamp(request.dispatchedAt ?? request.queuedAt)}</p>
            <p>{elapsedModelTime(request.dispatchedAt ?? request.queuedAt, observation.observedAt)}째 · 상태 경과 {elapsedModelTime(request.stateSince, observation.observedAt)}</p>
            <p>{request.state === "indeterminate" ? "슬롯 점유 없음 · 사람 검토 대기" : `막고 있는 단계: ${[...new Set([modelStageLabel(request.routeId), ...card.stages.map(modelStageLabel)])].join(" · ")}${groups.some(group => group.held >= (group.limit ?? Infinity)) ? " · 슬롯 상한 도달" : " · 해당 요청 종료 대기"}`}</p>
            {request.localEndRecorded && <p className="mt-1">로컬 호출 종료 기록 있음 · 제공자 종료 근거는 별도 확인 필요</p>}
            <button type="button" className={`${buttonSmall} mt-2`} disabled={controls.disabled || !!blocked || request.state !== "indeterminate"}
              title={blocked ?? (request.state !== "indeterminate" ? "아직 전송되지 않은 보류 요청은 정식 종료·해제 대상이 아닙니다." : undefined)}
              onClick={() => controls.open("request-release", request.requestId, `${label} · ${modelStageLabel(request.routeId)} 미확인 요청`)}>종료(정식 해제)</button>
            {request.state === "waiting" && <p className="mt-1 text-fg-2">보류 요청은 아직 전송되지 않아 종료·해제 대상이 아닙니다.</p>}
          </div>)}
          {!requests.length && <p>미확인 {unknown}건 · 요청 세부 정보가 표시 범위를 넘었습니다.</p>}
          {blocked && <p className="leading-relaxed text-down">실행 불가: {blocked}</p>}
        </div>}
        {probe && <div role="status" className="leading-relaxed"><p>연결 확인: {probe.listed === undefined ? "목록 미확인" : probe.listed ? "모델 목록에 있음" : "모델 목록에 없음"} · {probe.listMs ?? "—"}ms
          · 시험 호출 {probe.callMs === undefined ? probe.callBlocked : `${probe.callMs}ms`}</p>{probe.error && <p className="text-down">{probe.error}</p>}</div>}
        <details className="text-fg-2"><summary className="cursor-pointer">자세히 · 건당 처리량 · 내부 ID</summary>
          <div className="mt-2 grid gap-3 lg:grid-cols-2"><ThroughputMetrics value={observation.throughput?.byModel[throughputModelKey({ provider: card.definition?.provider ?? card.rows[0]?.provider ?? "", model: card.definition?.key ?? card.rows[0]?.model ?? "" })]} />
            <div className="flex flex-col gap-2 break-all font-mono"><p>모델 키 {card.id}</p>{card.rows.map(row => <p key={`${row.routeId}:${row.groupId}:${row.providerBudgetId}`}>routeId {row.routeId} · provider {row.provider}<br />groupId {row.groupId} · providerBudgetId {row.providerBudgetId}<br />철회 {row.withdrawn1h} · 미분류 {row.unclassified1h}</p>)}
              {card.requests.map(row => <p key={row.requestId}>requestId {row.requestId}<br />state {row.state} · owner {row.ownerInstanceId} · 예약 기한 {stamp(row.reservedUntil)}</p>)}
              {card.contracts.map(row => <p key={`${row.routeId}:${row.model}`}>계약 routeId {row.routeId} · {row.transport} · {row.host ?? "주소 없음"}</p>)}
              {groups.map(group => <p key={group.groupId}>공유 그룹 {group.groupId} · 전체 점유 {group.held}/{group.limit ?? "미확인"}</p>)}</div></div>
        </details>
      </div>
    </td></tr>
  </tbody>;
}
function AdmissionButton({ observation, controls }: { observation: AdminModelsObservation; controls: ModelOpsControls }) {
  return <button type="button" className={buttonSmall} disabled={controls.disabled || !["open", "draining"].includes(observation.mode ?? "")}
    onClick={() => controls.open(observation.mode === "open" ? "admission-pause" : "admission-open", "model-capacity")}>{observation.mode === "draining" ? "접수 재개" : "접수 일시중지"}</button>;
}
