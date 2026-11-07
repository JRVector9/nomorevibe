import Link from "next/link";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { CODE_DEFAULT_GATEWAY_NOTE, elapsedModelTime, isCodeDefaultGatewayHost, kstClock, MODEL_ROW_STATUS, MODEL_TABLE_COLUMNS, modelCardAnchor, modelRecoveryBlocked, modelRowGroups, modelRowStatus, modelTransportLabel,
  probeIdentityOf, type ModelCard, type ModelRowGroup, type ModelRowStatus } from "@/lib/operations/admin-models-view";
import { probeObservationKey, probeResultLabel, probeSourceLabel, type ProbeObservation } from "@/lib/operations/admin-models-probe";
import type { ServedContractModels } from "@/lib/operations/admin-engine-connect";
import type { ModelProbeResult } from "./operation-actions";
import type { ModelOpsControls } from "./ModelOpsPanel";
import { buttonSmall } from "../settings/Switch";
import { LLM_RETRY_HREF, llmRetryRowHref } from "@/lib/operations/llm-ops-links";

export const PROBE_PROVIDERS = ["abcllm", "local-direct"];
export const cardProvider = (card: ModelCard) => card.definition?.provider ?? card.rows[0]?.provider ?? card.requests[0]?.provider ?? "";
const NUMERIC = new Set<string>(["점유 / 한도", "1시간 성공 / 실패"]);
/** 왼쪽 줄(행 첫 칸) — 실선 빨강 = 연결 안 됨, 점선 노랑(models.css) = 확인 못함, 노랑 = 보류, 회색 = 접수 중지 */
const ROW_LINE: Record<ModelRowStatus, string> = { connected: "", busy: "", hold: "border-l-[3px] border-l-warn", paused: "border-l-[3px] border-l-line", down: "border-l-[3px] border-l-down", unknown: "model-row-unknown" };

export function ModelStatusBadge({ status, children, muted }: { status: ModelRowStatus | string; children?: React.ReactNode; muted?: boolean }) {
  const legacy: Record<string, ModelRowStatus> = { 정상: "connected", 연결됨: "connected", 느림: "hold", 보류: "hold", 미확인: "unknown", "확인 못함": "unknown", "접수 중지": "paused", 일시중지: "paused",
    "처리 중": "busy", "연결 안 됨": "down", 내려감: "down" };
  const key = (status in MODEL_ROW_STATUS ? status : legacy[status] ?? "unknown") as ModelRowStatus, spec = MODEL_ROW_STATUS[muted ? "paused" : key];
  return <span data-state={muted ? "paused" : key} className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 py-px text-[13px] font-semibold ${spec.tone}`}>
    <span aria-hidden="true" className="model-glyph" data-glyph={spec.glyph} />{children ?? (status in MODEL_ROW_STATUS ? spec.label : status)}</span>;
}

/** 저장된 관측(probes)보다 이 화면에서 방금 받은 결과(local)가 새롭다 — local 은 서버 액션의 응답이다. */
export type ProbeView = { source: "manual" | "auto"; observedAt: string | null; listed: boolean | null; listMs: number | null; callMs: number | null; callBlocked: string | null; error: string | null; detail: string | null };
export function probeViewOf(card: ModelCard, probes: Record<string, ProbeObservation>, local?: ModelProbeResult): ProbeView | null {
  if (local) return { source: local.source ?? "manual", observedAt: local.observedAt ?? null, listed: local.listed ?? null, listMs: local.listMs ?? null, callMs: local.callMs ?? null,
    callBlocked: local.callBlocked ?? null, error: local.error ?? local.saveError ?? null, detail: null };
  const saved = probes[probeObservationKey(probeIdentityOf(card))];
  return saved ? { source: saved.source, observedAt: saved.observedAt, listed: saved.listed, listMs: saved.listMs, callMs: saved.callMs, callBlocked: saved.callBlocked, error: saved.error, detail: saved.detail } : null;
}

function ProbeCell({ probe, observation, probeable, shared, busy }: { probe: ProbeView | null; observation: AdminModelsObservation; probeable: boolean; shared: boolean; busy: boolean }) {
  if (busy) return <div className="grid gap-px"><span className="font-semibold text-accent-ink">연결 확인 중…</span></div>;
  if (!probe) return <div className="grid gap-px"><span className="font-semibold">확인 기록 없음</span>
    <span className="text-fg-2">{probeable ? "「연결 확인」 버튼 · GET /v1/models" : "CLI 제공자 · 목록 조회 실행기 없음"}</span><span className="text-fg-2">최근 성공 시각으로만 판정</span></div>;
  const result = probeResultLabel(probe), when = probe.observedAt ? `${elapsedModelTime(probe.observedAt, observation.observedAt ?? probe.observedAt)} 전` : "시각 미확인";
  return <div className="grid gap-px" role="status">
    <span className="font-semibold" title={probe.observedAt ? `${kstClock(probe.observedAt)} KST` : undefined}>{when}</span>
    <span className="text-fg-2">{probeSourceLabel(probe.source)} · {probe.detail ?? "GET /v1/models"}{shared ? " · 같은 슬롯 · 결과 공유" : ""}</span>
    <span className={result.tone === "bad" ? "text-down" : result.tone === "na" ? "text-fg-2" : ""}>{result.text}</span>
  </div>;
}

/**
 * 단계 × 모델. 넓은 화면은 8열(장비·전송은 모델 칸, 대기·미확인은 상태 칸). 1280px 미만은 모델 카드.
 * 모델·연결 확인·동작 셀은 묶음의 첫 행에 rowspan. 미확인 수는 기록 › 재실행 대기의 그 요청(/admin/models/history#rv-…)으로 간다.
 */
export function ModelStageTable({ cards, observation, controls, probes, localProbes, busy, onProbe, restartModels = [], served = [] }: {
  cards: ModelCard[]; observation: AdminModelsObservation; controls: ModelOpsControls; probes: Record<string, ProbeObservation>;
  localProbes: Record<string, ModelProbeResult>; busy: string | null; onProbe: (card: ModelCard) => void; restartModels?: { key: string; label: string; blockedReason?: string }[];
  served?: readonly ServedContractModels[];
}) {
  const rows = cards.map(card => ({ card, probe: probeViewOf(card, probes, localProbes[card.id]), busy: busy === card.id,
    onProbe: () => onProbe(card), recovery: restartModels.find(model => model.key === card.id), served }));
  return <div role="region" aria-label="단계별 모델 상태 표">
    <div className="models-stage-wide">
    <table className="models-stage-table w-full border-collapse text-left text-[13px] leading-[1.35]">
      <caption className="sr-only">단계별 모델 상태 표 — 단계·경로, 모델·장비·전송, 상태, 점유, 1시간 성공·실패, 마지막 성공, 연결 확인, 동작</caption>
      <thead className="bg-bg-soft text-fg-2"><tr>{MODEL_TABLE_COLUMNS.map(column => <th key={column} scope="col" className={`border-b border-line px-2.5 py-1.5 font-semibold ${NUMERIC.has(column) ? "text-right" : ""}`}>{column}</th>)}</tr></thead>
      {rows.map(row => <CardRows key={row.card.id} observation={observation} controls={controls} {...row} />)}
      {!cards.length && <tbody><tr><td colSpan={MODEL_TABLE_COLUMNS.length} className="px-3 py-4">관측된 모델이 없습니다. 설정과 장부 수집 경로를 확인해주세요.</td></tr></tbody>}
    </table>
    </div>
    <div className="models-stage-cards">
      {rows.map(row => <StageCard key={row.card.id} observation={observation} controls={controls} card={row.card} probe={row.probe} busy={row.busy} onProbe={row.onProbe} recovery={row.recovery} served={served} />)}
      {!cards.length && <p className="px-3 py-4 text-[13px]">관측된 모델이 없습니다. 설정과 장부 수집 경로를 확인해주세요.</p>}
    </div>
  </div>;
}

function servedFor(card: ModelCard, served: readonly ServedContractModels[]) {
  return served.filter(row => card.contracts.some(contract => contract.routeId === row.routeId && contract.model === row.storedModel)
    || card.rows.some(metric => metric.routeId === row.routeId && metric.model === row.storedModel));
}
function ServedNames({ card, served }: { card: ModelCard; served: readonly ServedContractModels[] }) {
  const rows = servedFor(card, served);
  if (!rows.length) return null;
  const ids = [...new Set(rows.flatMap(row => row.servedIds ?? []))];
  const failed = rows.find(row => row.servedIds === null);
  const mismatch = ids.length > 0 && rows.some(row => row.servedIds && !row.servedIds.includes(row.storedModel));
  return <span className="mt-1 block text-fg-2">{ids.length
    ? <>엔진 API · <span className="font-mono">{ids.join(", ")}</span>{mismatch ? " · 저장한 이름과 다름" : ""}</>
    : `엔진 API를 읽지 못함${failed?.reason ? ` · ${failed.reason}` : ""}`}</span>;
}
function CardRows({ card, observation, controls, probe, busy, onProbe, recovery, served = [] }: {
  card: ModelCard; observation: AdminModelsObservation; controls: ModelOpsControls; probe: ProbeView | null; busy: boolean; onProbe: () => void; recovery?: { key: string; blockedReason?: string };
  served?: readonly ServedContractModels[];
}) {
  const groups = modelRowGroups(card), provider = cardProvider(card), probeable = PROBE_PROVIDERS.includes(provider), label = `[${card.equipment}] ${card.name}`;
  const engineHosts = card.hosts.filter(host => !isCodeDefaultGatewayHost(host)), codeDefaultHost = card.hosts.some(isCodeDefaultGatewayHost);
  const blocked = !card.definition ? "등록부에서 장비·실행 대상을 확인하지 못했습니다." : recovery ? recovery.blockedReason : modelRecoveryBlocked(card.definition.equipment, card.definition.provider);
  const cell = "border-b border-line px-2.5 py-1.5 align-top", span = `${cell} border-l border-line bg-bg-card`;
  const limitOf = (group: ModelRowGroup) => {
    const metrics = group.stages.flatMap(stage => stage.rows);
    const identities = new Set(metrics.map(row => JSON.stringify([row.routeId, row.provider, row.model])));
    const currentGroups = new Set((observation.policyVerified ? observation.configuredRoutes ?? [] : [])
      .filter(route => identities.has(JSON.stringify([route.routeId, route.provider, route.model]))).map(route => route.groupId));
    for (const row of metrics) if (row.dispatched || row.reserved || row.waiting) currentGroups.add(row.groupId);
    const groupsOf = observation.groups.filter(row => currentGroups.has(row.groupId));
    return { limit: groupsOf.length && groupsOf.length === currentGroups.size && groupsOf.every(row => row.limit !== null) ? groupsOf.reduce((n, row) => n + row.limit!, 0) : null, lending: groupsOf.some(row => row.lending), full: groupsOf.some(row => row.held >= (row.limit ?? Infinity)) }; };
  const totalStageRows = groups.reduce((n, group) => n + group.stages.length, 0);
  return <tbody id={modelCardAnchor(card.id)} className="scroll-mt-28 md:scroll-mt-16" aria-label={label}>
    {groups.map((group, gi) => group.stages.map((stage, si) => {
      const status = modelRowStatus({ unknown: stage.unknown, held: stage.held, waiting: stage.waiting, lastSuccessAt: stage.lastSuccessAt, mode: observation.mode, probe }), spec = MODEL_ROW_STATUS[status];
      const { limit, lending, full } = limitOf(group), first = gi === 0 && si === 0, unknownRequest = stage.requests.find(row => row.state === "indeterminate");
      const releasable = stage.requests.filter(row => row.state === "indeterminate");
      return <tr key={`${group.id}:${stage.stage}`} data-status={status} id={first ? `row-${encodeURIComponent(card.id)}` : undefined}>
        <td className={`${cell} ${ROW_LINE[status]}`}><b className="font-semibold">{stage.label}</b>{stage.routeIds.map(route => <span key={route} className="block break-all font-mono text-fg-2">{route}</span>)}</td>
        {si === 0 && <td rowSpan={group.stages.length} className={first ? cell : span}><strong className="break-words text-[14px] font-bold leading-snug">{card.name}</strong>
          <ServedNames card={card} served={served} />
          <span className="mt-1 block text-fg-2">{card.equipment}{card.equipmentSource ? ` · 출처 ${card.equipmentSource}` : ""}{engineHosts[0] ? ` · ${engineHosts[0]}` : ""}</span>
          <span className="block text-fg-2">{modelTransportLabel(provider, card.contracts)}{provider && provider !== "abcllm" ? <span> ({provider})</span> : ""}</span>
          {codeDefaultHost && <span className="block text-fg-2">{CODE_DEFAULT_GATEWAY_NOTE}</span>}
          {!engineHosts.length && !codeDefaultHost && !card.equipmentSource && <Link href="/admin/models/contracts" prefetch={false} className="block text-accent-ink underline underline-offset-[3px]">등록부에 장비 이름 붙이기 →</Link>}
          {!engineHosts.length && !codeDefaultHost && <span className="block text-fg-2">{provider.endsWith("-cli") ? "connect · 로컬 프로세스" : card.equipmentSource ? "" : "주소 없음"}</span>}
          {group.shared && <span className="mt-1 block text-fg-2">text 경로 {group.stages.length}개 공통</span>}
          <details className="mt-1 text-fg-2"><summary className="cursor-pointer">내부 ID</summary>
            <div className="mt-1 flex flex-col gap-1 break-all font-mono">{card.definition && <p>{card.definition.displayName}</p>}<p>모델 키 {card.id}</p>
              {card.rows.map(row => <p key={`${row.routeId}:${row.groupId}:${row.providerBudgetId}`}>routeId {row.routeId} · provider {row.provider}<br />groupId {row.groupId} · providerBudgetId {row.providerBudgetId}<br />철회 {row.withdrawn1h} · 미분류 {row.unclassified1h}</p>)}
              {card.requests.map(row => <p key={row.requestId}>requestId {row.requestId}<br />state {row.state} · 상태 경과 {elapsedModelTime(row.stateSince, observation.observedAt)} · 요청 시작 {kstClock(row.dispatchedAt ?? row.queuedAt)} KST{row.localEndRecorded ? " · 로컬 호출 종료 기록 있음" : ""}<br />owner {row.ownerInstanceId} · 예약 기한 {row.reservedUntil ? `${kstClock(row.reservedUntil)} KST` : "없음"}</p>)}
              {card.contracts.map(row => <p key={`${row.routeId}:${row.model}`}>계약 routeId {row.routeId} · {row.transport} · {row.host ?? "주소 없음"}</p>)}</div></details></td>}
        <td className={cell}><ModelStatusBadge status={status}>{status === "unknown" ? `확인 못함 ${stage.unknown}` : spec.label}</ModelStatusBadge>
          <span className="mt-0.5 block text-fg-2">대기 {stage.waiting} · 미확인 {stage.unknown ? <a href={unknownRequest ? llmRetryRowHref(unknownRequest.requestId) : LLM_RETRY_HREF} className="font-semibold text-warn underline underline-offset-[3px]">{stage.unknown} →</a> : 0}</span>
          {status === "down" && !probe && <span className="mt-0.5 block text-fg-2">최근 성공·연결 확인 기록 없음</span>}
          {status === "hold" && full && <span className="mt-0.5 block text-fg-2">슬롯 상한 도달</span>}</td>
        {group.shared ? (si === 0 && <td rowSpan={group.stages.length} className={`${span} text-right tabular-nums`}><span className="font-semibold">{group.held} / {limit ?? "미확인"}</span> <small className="text-fg-2">공유</small>{lending && <span className="block text-fg-2">빌려 쓰는 중</span>}</td>)
          : <td className={`${cell} whitespace-nowrap text-right tabular-nums`}><span className="font-semibold">{stage.held} / {limit ?? "미확인"}</span>{lending && <span className="block text-fg-2">빌려 쓰는 중</span>}</td>}
        <td className={`${cell} whitespace-nowrap text-right tabular-nums`}><span className="text-up">{stage.succeeded1h}</span> / <span className="text-down">{stage.failed1h}</span></td>
        <td className={`${cell} whitespace-nowrap`} title={stage.lastSuccessAt ? `${kstClock(stage.lastSuccessAt)} KST` : undefined}>{stage.lastSuccessAt ? <>{elapsedModelTime(stage.lastSuccessAt, observation.observedAt)} 전<span className="block font-mono text-fg-2">{kstClock(stage.lastSuccessAt)}</span></> : <span className="text-fg-2">기록 없음</span>}</td>
        {si === 0 && <td rowSpan={group.stages.length} className={first ? cell : span}><ProbeCell probe={probe} observation={observation} probeable={probeable} shared={gi > 0} busy={busy} /></td>}
        {si === 0 && <td rowSpan={group.stages.length} className={first ? cell : span}><div className="flex flex-wrap gap-1">
          <button type="button" className={buttonSmall} disabled={busy || !probeable} title={probeable ? undefined : "이 제공자의 모델 목록 조회 실행기가 연결되지 않았습니다."} onClick={onProbe}>연결 확인</button>
          {gi === 0 ? <button type="button" className={buttonSmall} disabled={controls.disabled || !!blocked || !card.definition} title={blocked}
            onClick={() => controls.open("model-restart", card.definition!.key, label)}>모델 재시작</button> : <span className="self-center text-fg-2">재시작은 첫 행에서</span>}
          {group.stages.flatMap(row => row.requests.filter(request => request.state === "indeterminate")).map(request => <button key={request.requestId} type="button" className={`${buttonSmall} border-down text-down`} disabled={controls.disabled || !!blocked}
            title={blocked ?? "접수 중지 → 종료 확인 → 근거 검증 후 정산 → 복원 → 접수 재개"}
            onClick={() => controls.open("request-release", request.requestId, `${label} · ${row(request.routeId, group)} 미확인 요청`)}>종료(정식 해제)</button>)}
        </div>
          {blocked && <span className="mt-1 block text-fg-2">재시작 불가 · {blocked}</span>}
          {group.stages.flatMap(row => row.requests.filter(request => request.state === "indeterminate")).map(request => <span key={request.requestId} className="mt-1 block text-fg-2">
            미확인 <code title={request.requestId}>{request.requestId.slice(0, 8)}</code> · 요청 시작 {kstClock(request.dispatchedAt ?? request.queuedAt)} KST · {elapsedModelTime(request.dispatchedAt ?? request.queuedAt, observation.observedAt)}째{request.localEndRecorded ? " · 로컬 호출 종료 기록 있음" : ""}</span>)}
          {releasable.length > 0 && <span className="mt-1 block text-fg-2">미확인은 슬롯 점유 없음 · 사람 검토 뒤 닫기</span>}
          {gi === 0 && group.shared && <span className="mt-1 block text-fg-2">{group.stages.length}경로 한 번에 적용</span>}
          {totalStageRows > 1 && gi === 0 && !group.shared && <span className="sr-only">이 모델의 다른 단계 행은 아래에 이어진다</span>}</td>}
      </tr>;
    }))}
  </tbody>;
}
const row = (routeId: string, group: ModelRowGroup) => group.stages.find(stage => stage.routeIds.includes(routeId))?.label ?? routeId;

function StageCard({ card, observation, controls, probe, busy, onProbe, recovery, served = [] }: {
  card: ModelCard; observation: AdminModelsObservation; controls: ModelOpsControls; probe: ProbeView | null; busy: boolean; onProbe: () => void; recovery?: { key: string; blockedReason?: string };
  served?: readonly ServedContractModels[];
}) {
  const groups = modelRowGroups(card), provider = cardProvider(card), probeable = PROBE_PROVIDERS.includes(provider);
  const engineHosts = card.hosts.filter(host => !isCodeDefaultGatewayHost(host));
  const blocked = !card.definition ? "등록부에서 장비·실행 대상을 확인하지 못했습니다." : recovery ? recovery.blockedReason : modelRecoveryBlocked(card.definition.equipment, card.definition.provider);
  return <article className="border-t border-line px-3 py-3" aria-label={`[${card.equipment}] ${card.name}`}>
    <h3 className="text-[15px] font-bold">{card.name}</h3>
    <ServedNames card={card} served={served} />
    <p className="text-[13px] text-fg-2">{card.equipment}{engineHosts[0] ? ` · ${engineHosts[0]}` : ""} · {modelTransportLabel(provider, card.contracts)}</p>
    <dl className="mt-2 grid gap-2 sm:grid-cols-2">
      {groups.flatMap(group => group.stages.map(stage => {
        const status = modelRowStatus({ unknown: stage.unknown, held: stage.held, waiting: stage.waiting, lastSuccessAt: stage.lastSuccessAt, mode: observation.mode, probe });
        const unknownRequest = stage.requests.find(row => row.state === "indeterminate");
        return <div key={`${group.id}:${stage.stage}`}>
          <dt className="font-semibold">{stage.label}</dt>
          <dd className="text-fg-2"><ModelStatusBadge status={status} /> · {stage.held} 점유 · 대기 {stage.waiting} · 성공 {stage.succeeded1h} / 실패 {stage.failed1h}
            {stage.unknown ? <> · <a href={unknownRequest ? llmRetryRowHref(unknownRequest.requestId) : LLM_RETRY_HREF} className="font-semibold text-warn">미확인 {stage.unknown}</a></> : null}
            {stage.lastSuccessAt ? ` · ${elapsedModelTime(stage.lastSuccessAt, observation.observedAt)} 전` : ""}</dd>
        </div>;
      }))}
    </dl>
    <div className="mt-2"><ProbeCell probe={probe} observation={observation} probeable={probeable} shared={false} busy={busy} /></div>
    <div className="mt-2 flex flex-wrap gap-1">
      <button type="button" className={buttonSmall} disabled={busy || !probeable} onClick={onProbe}>연결 확인</button>
      <button type="button" className={buttonSmall} disabled={controls.disabled || !!blocked || !card.definition} title={blocked}
        onClick={() => card.definition && controls.open("model-restart", card.definition.key, `[${card.equipment}] ${card.name}`)}>모델 재시작</button>
    </div>
  </article>;
}
