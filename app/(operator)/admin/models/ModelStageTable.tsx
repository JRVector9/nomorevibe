import Link from "next/link";
import type { AdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { elapsedModelTime, kstClock, MODEL_ROW_STATUS, MODEL_TABLE_COLUMNS, modelCardAnchor, modelRecoveryBlocked, modelRowGroups, modelRowStatus, modelTransportLabel,
  probeIdentityOf, type ModelCard, type ModelRowGroup, type ModelRowStatus } from "@/lib/operations/admin-models-view";
import { probeObservationKey, probeResultLabel, probeSourceLabel, type ProbeObservation } from "@/lib/operations/admin-models-probe";
import type { ModelProbeResult } from "./operation-actions";
import type { ModelOpsControls } from "./ModelOpsPanel";
import { buttonSmall } from "../settings/Switch";

export const PROBE_PROVIDERS = ["abcllm", "local-direct"];
export const cardProvider = (card: ModelCard) => card.definition?.provider ?? card.rows[0]?.provider ?? card.requests[0]?.provider ?? "";
const NUMERIC = new Set<string>(["점유 / 한도", "대기", "미확인", "1시간 성공 / 실패"]);
/** 왼쪽 줄(행 첫 칸) — 실선 빨강 = 연결 안 됨, 점선 노랑(models.css) = 확인 못함, 노랑 = 보류, 회색 = 접수 중지 */
const ROW_LINE: Record<ModelRowStatus, string> = { connected: "", busy: "", hold: "border-l-[3px] border-l-warn", paused: "border-l-[3px] border-l-line", down: "border-l-[3px] border-l-down", unknown: "model-row-unknown" };

export function ModelStatusBadge({ status, children, muted }: { status: ModelRowStatus | string; children?: React.ReactNode; muted?: boolean }) {
  const legacy: Record<string, ModelRowStatus> = { 정상: "connected", 연결됨: "connected", 느림: "hold", 보류: "hold", 미확인: "unknown", "확인 못함": "unknown", "접수 중지": "paused", 일시중지: "paused",
    "처리 중": "busy", "연결 안 됨": "down", 내려감: "down" };
  const key = (status in MODEL_ROW_STATUS ? status : legacy[status] ?? "unknown") as ModelRowStatus, spec = MODEL_ROW_STATUS[muted ? "paused" : key];
  return <span data-state={muted ? "paused" : key} className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 py-px text-[13px] font-semibold ${spec.tone}`}>
    <span aria-hidden="true" className="text-[10px] leading-none">{spec.glyph}</span>{children ?? (status in MODEL_ROW_STATUS ? spec.label : status)}</span>;
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
  if (busy) return <div className="grid min-w-[190px] gap-px"><span className="font-semibold text-accent-ink">연결 확인 중…</span></div>;
  if (!probe) return <div className="grid min-w-[190px] gap-px"><span className="font-semibold">확인 기록 없음</span>
    <span className="text-fg-2">{probeable ? "「연결 확인」 버튼 · GET /v1/models" : "CLI 제공자 · 목록 조회 실행기 없음"}</span><span className="text-fg-2">최근 성공 시각으로만 판정</span></div>;
  const result = probeResultLabel(probe), when = probe.observedAt ? `${elapsedModelTime(probe.observedAt, observation.observedAt ?? probe.observedAt)} 전` : "시각 미확인";
  return <div className="grid min-w-[190px] gap-px" role="status">
    <span className="font-semibold" title={probe.observedAt ? `${kstClock(probe.observedAt)} KST` : undefined}>{when}</span>
    <span className="text-fg-2">{probeSourceLabel(probe.source)} · {probe.detail ?? "GET /v1/models"}{shared ? " · 같은 슬롯 · 결과 공유" : ""}</span>
    <span className={result.tone === "bad" ? "text-down" : result.tone === "na" ? "text-fg-2" : ""}>{result.text}</span>
  </div>;
}

/**
 * 단계 × 모델 표(12열, 승인 시안). 모델(카드)마다 단계 행을 그리되, 모델·장비·전송·연결 확인·동작 셀은 묶음(group)의 첫 행에 rowspan 으로 한 번만 — text 7경로는 한 묶음이다.
 * 상태는 색+글자+글리프, 행 왼쪽 줄은 상태색이다. 미확인 수는 사람 검토 목록의 그 요청(#rv-…)으로 간다.
 */
export function ModelStageTable({ cards, observation, controls, probes, localProbes, busy, onProbe, restartModels = [] }: {
  cards: ModelCard[]; observation: AdminModelsObservation; controls: ModelOpsControls; probes: Record<string, ProbeObservation>;
  localProbes: Record<string, ModelProbeResult>; busy: string | null; onProbe: (card: ModelCard) => void; restartModels?: { key: string; label: string; blockedReason?: string }[];
}) {
  return <div className="overflow-x-auto" role="region" aria-label="단계별 모델 상태 표" tabIndex={0}>
    <table className="w-full min-w-[1360px] border-collapse text-left text-[13px] leading-[1.35]">
      <caption className="sr-only">단계별 모델 상태 표 — 단계·경로, 모델, 장비, 전송, 상태, 점유, 대기, 미확인, 1시간 성공·실패, 마지막 성공, 연결 확인, 동작</caption>
      <thead className="bg-bg-soft text-fg-2"><tr>{MODEL_TABLE_COLUMNS.map(column => <th key={column} scope="col" className={`whitespace-nowrap border-b border-line px-2.5 py-1.5 font-semibold ${NUMERIC.has(column) ? "text-right" : ""}`}>{column}</th>)}</tr></thead>
      {cards.map(card => <CardRows key={card.id} card={card} observation={observation} controls={controls} probe={probeViewOf(card, probes, localProbes[card.id])}
        busy={busy === card.id} onProbe={() => onProbe(card)} recovery={restartModels.find(model => model.key === card.id)} />)}
      {!cards.length && <tbody><tr><td colSpan={MODEL_TABLE_COLUMNS.length} className="px-3 py-4">관측된 모델이 없습니다. 설정과 장부 수집 경로를 확인해주세요.</td></tr></tbody>}
    </table>
  </div>;
}

function CardRows({ card, observation, controls, probe, busy, onProbe, recovery }: {
  card: ModelCard; observation: AdminModelsObservation; controls: ModelOpsControls; probe: ProbeView | null; busy: boolean; onProbe: () => void; recovery?: { key: string; blockedReason?: string };
}) {
  const groups = modelRowGroups(card), provider = cardProvider(card), probeable = PROBE_PROVIDERS.includes(provider), label = `[${card.equipment}] ${card.name}`;
  const blocked = !card.definition ? "등록부에서 장비·실행 대상을 확인하지 못했습니다." : recovery ? recovery.blockedReason : modelRecoveryBlocked(card.definition.equipment, card.definition.provider);
  const cell = "border-b border-line px-2.5 py-1.5 align-top", span = `${cell} border-l border-line bg-bg-card`;
  const limitOf = (group: ModelRowGroup) => { const groupsOf = observation.groups.filter(row => group.groupIds.includes(row.groupId));
    return { limit: groupsOf.length && groupsOf.every(row => row.limit !== null) ? groupsOf.reduce((n, row) => n + row.limit!, 0) : null, lending: groupsOf.some(row => row.lending), full: groupsOf.some(row => row.held >= (row.limit ?? Infinity)) }; };
  const totalStageRows = groups.reduce((n, group) => n + group.stages.length, 0);
  return <tbody id={modelCardAnchor(card.id)} className="scroll-mt-28 md:scroll-mt-16" aria-label={label}>
    {groups.map((group, gi) => group.stages.map((stage, si) => {
      const status = modelRowStatus({ unknown: stage.unknown, held: stage.held, waiting: stage.waiting, lastSuccessAt: stage.lastSuccessAt, mode: observation.mode, probe }), spec = MODEL_ROW_STATUS[status];
      const { limit, lending, full } = limitOf(group), first = gi === 0 && si === 0, unknownRequest = stage.requests.find(row => row.state === "indeterminate");
      const releasable = stage.requests.filter(row => row.state === "indeterminate");
      return <tr key={`${group.id}:${stage.stage}`} data-status={status} id={first ? `row-${encodeURIComponent(card.id)}` : undefined}>
        <td className={`${cell} ${ROW_LINE[status]}`}><b className="font-semibold">{stage.label}</b>{stage.routeIds.map(route => <span key={route} className="block break-all font-mono text-fg-2">{route}</span>)}</td>
        {si === 0 && <td rowSpan={group.stages.length} className={`${first ? cell : span} min-w-[200px]`}><strong className="break-words text-[14px] font-bold leading-snug">{card.name}</strong>
          <span className="block break-all font-mono text-fg-2">{card.definition ? card.definition.key : `${provider}:${card.rows[0]?.model ?? card.requests[0]?.model ?? card.name}`}</span>
          {group.shared && <span className="mt-1 block text-fg-2">text 경로 {group.stages.length}개 공통</span>}
          <details className="mt-1 text-fg-2"><summary className="cursor-pointer">내부 ID</summary>
            <div className="mt-1 flex flex-col gap-1 break-all font-mono">{card.definition && <p>{card.definition.displayName}</p>}<p>모델 키 {card.id}</p>
              {card.rows.map(row => <p key={`${row.routeId}:${row.groupId}:${row.providerBudgetId}`}>routeId {row.routeId} · provider {row.provider}<br />groupId {row.groupId} · providerBudgetId {row.providerBudgetId}<br />철회 {row.withdrawn1h} · 미분류 {row.unclassified1h}</p>)}
              {card.requests.map(row => <p key={row.requestId}>requestId {row.requestId}<br />state {row.state} · 상태 경과 {elapsedModelTime(row.stateSince, observation.observedAt)} · 요청 시작 {kstClock(row.dispatchedAt ?? row.queuedAt)} KST{row.localEndRecorded ? " · 로컬 호출 종료 기록 있음" : ""}<br />owner {row.ownerInstanceId} · 예약 기한 {row.reservedUntil ? `${kstClock(row.reservedUntil)} KST` : "없음"}</p>)}
              {card.contracts.map(row => <p key={`${row.routeId}:${row.model}`}>계약 routeId {row.routeId} · {row.transport} · {row.host ?? "주소 없음"}</p>)}</div></details></td>}
        {si === 0 && <td rowSpan={group.stages.length} className={first ? cell : span}><span className="block font-semibold">{card.equipment}</span>
          {card.equipmentSource ? <span className="block text-fg-2">출처 {card.equipmentSource}{card.hosts[0] ? ` · ${card.hosts[0].split(":")[0]}` : ""}</span>
            : <Link href="/admin/models/contracts" prefetch={false} className="block text-accent-ink underline underline-offset-[3px]">등록부에 장비 이름 붙이기 →</Link>}</td>}
        {si === 0 && <td rowSpan={group.stages.length} className={first ? cell : span}><span className="block">{modelTransportLabel(provider, card.contracts)}{provider ? <span className="text-fg-2"> ({provider})</span> : " · 제공자 미확인"}</span>
          {card.hosts.length ? card.hosts.map(host => <code key={host} className="block break-all font-mono text-fg-2">{host}</code>) : <span className="block font-mono text-fg-2">{provider.endsWith("-cli") ? "connect · 로컬 프로세스" : "주소 없음"}</span>}</td>}
        <td className={cell}><ModelStatusBadge status={status}>{status === "unknown" ? `확인 못함 ${stage.unknown}` : spec.label}</ModelStatusBadge>
          {status === "down" && !probe && <span className="mt-0.5 block text-fg-2">최근 성공·연결 확인 기록 없음</span>}
          {status === "hold" && full && <span className="mt-0.5 block text-fg-2">슬롯 상한 도달</span>}</td>
        {group.shared ? (si === 0 && <td rowSpan={group.stages.length} className={`${span} text-right tabular-nums`}><span className="font-semibold">{group.held} / {limit ?? "미확인"}</span> <small className="text-fg-2">공유</small>{lending && <span className="block text-fg-2">빌려 쓰는 중</span>}</td>)
          : <td className={`${cell} whitespace-nowrap text-right tabular-nums`}><span className="font-semibold">{stage.held} / {limit ?? "미확인"}</span>{lending && <span className="block text-fg-2">빌려 쓰는 중</span>}</td>}
        <td className={`${cell} text-right tabular-nums`}>{stage.waiting}</td>
        <td className={`${cell} text-right tabular-nums`}>{stage.unknown ? <a href={unknownRequest ? `#rv-${unknownRequest.requestId}` : "#review"} className="inline-flex items-center gap-1 rounded border border-warn bg-warn/15 px-1.5 font-semibold text-warn">{stage.unknown} ↓</a> : 0}</td>
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
