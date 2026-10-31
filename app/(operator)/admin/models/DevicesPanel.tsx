import Link from "next/link";
import type { ModelDefinition } from "@/lib/llm/model-registry";
import type { CapacityDevicesAdminView, DeviceView } from "@/lib/operations/admin-capacity-devices";
import { capacityDeviceIssueMessage } from "@/lib/operations/admin-capacity-devices";
import { deviceServer, type ModelRowStatus } from "@/lib/operations/admin-models-view";
import { probeObservationKey, type ProbeObservation } from "@/lib/operations/admin-models-probe";
import { ModelStatusBadge } from "./ModelStageTable";

const num = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("ko-KR");
const TH = "whitespace-nowrap border-b border-line px-2.5 py-1.5 text-[13px] font-semibold text-fg-2";
const TD = "border-b border-line px-2.5 py-1.5 align-top";

/** 장비의 연결 상태 — 그 장비 모델들의 저장된 연결 확인 중 하나라도 오류·목록 없음이면 연결 안 됨, 하나라도 목록 있음이면 연결됨, 기록이 없으면 null. */
export function deviceProbeStatus(deviceId: string, models: readonly ModelDefinition[], probes: Record<string, ProbeObservation>): ModelRowStatus | null {
  const server = deviceServer(deviceId, models).name;
  const mine = models.filter(model => deviceServer(model.equipment, models).name === server).map(model => probes[probeObservationKey({ provider: model.provider, model: model.key })]).filter(Boolean);
  if (!mine.length) return null;
  if (mine.some(probe => probe.listed === false || (probe.error && probe.listed !== true))) return "down";
  return mine.some(probe => probe.listed === true) ? "connected" : null;
}

/**
 * 장비 표(승인 시안, 2열의 왼쪽) — /admin/models/devices 와 같은 로더(readCapacityDevicesAdminView)의 값을 요약한다:
 * 장비 · 서버(이름·엔진 주소) · 한도 · 보조 상한 · 점유 · 보조/상한 · 대기 · 역할 순위 · 물리 한도 · 상태 · 판. 점유는 예약+진행만(미확인은 점유 아님).
 */
export function DevicesPanel({ view, models, probes }: { view: CapacityDevicesAdminView; models: readonly ModelDefinition[]; probes: Record<string, ProbeObservation> }) {
  return <section className="min-w-0 rounded-xl border border-line bg-bg-card scroll-mt-28 md:scroll-mt-16" id="devices" aria-labelledby="devices-heading">
    <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 border-b border-line px-3 py-2.5">
      <h2 id="devices-heading" className="text-[15px] font-semibold">장비 <span className="font-mono tabular-nums">{view.devices.length}</span>대</h2>
      <p className="min-w-0 flex-[1_1_240px] text-[13px] text-fg-2">점유는 예약+진행만(미확인 행은 점유 아님). 보조 상한은 낮은 순위 역할의 평소 상한, 「빌려 쓰는 중」은 우선 역할이 쉬어 상한을 넘은 상태.</p>
      <span className="flex flex-wrap gap-x-3 text-[13px]"><a href="#assign" className="text-accent-ink underline underline-offset-[3px]">배정 표 ↓</a><Link href="/admin/models/devices" prefetch={false} className="text-accent-ink underline underline-offset-[3px]">장비 설정 →</Link></span>
    </div>
    {view.controlError && <p role="alert" className="px-3 pt-2 text-[13px] text-down">용량 제어 행을 읽지 못했습니다({capacityDeviceIssueMessage(view.controlError)}).</p>}
    {view.rowsError && <p role="alert" className="px-3 pt-2 text-[13px] text-down">장비 행을 읽지 못했습니다({capacityDeviceIssueMessage(view.rowsError)}) — 정책 대체값입니다.</p>}
    {view.statesError && <p role="note" className="px-3 pt-2 text-[13px] text-warn">실시간 상태를 읽지 못했습니다({capacityDeviceIssueMessage(view.statesError)}) — 점유·대기 칸이 비어 있습니다.</p>}
    {!view.devices.length ? <p className="px-3 py-3 text-[13px] text-fg-2">장비가 없습니다.</p> : <div className="overflow-x-auto" role="region" aria-label="장비별 한도와 점유 표" tabIndex={0}>
      <table className="w-full min-w-[900px] border-collapse text-left text-[13px] leading-[1.35]">
        <caption className="sr-only">장비별 한도와 점유</caption>
        <thead className="bg-bg-soft"><tr><th scope="col" className={TH}>장비</th><th scope="col" className={TH}>서버</th><th scope="col" className={`${TH} text-right`}>한도</th><th scope="col" className={`${TH} text-right`}>보조 상한</th>
          <th scope="col" className={`${TH} text-right`}>점유</th><th scope="col" className={`${TH} text-right`}>보조 / 상한</th><th scope="col" className={`${TH} text-right`}>대기</th><th scope="col" className={TH}>역할 순위</th>
          <th scope="col" className={`${TH} text-right`}>물리 한도</th><th scope="col" className={TH}>상태</th><th scope="col" className={`${TH} text-right`}>판</th></tr></thead>
        <tbody>{view.devices.map(device => <DeviceRow key={device.deviceId} device={device} models={models} probes={probes} />)}</tbody>
      </table></div>}
  </section>;
}

function DeviceRow({ device, models, probes }: { device: DeviceView; models: readonly ModelDefinition[]; probes: Record<string, ProbeObservation> }) {
  const live = device.live, server = deviceServer(device.deviceId, models), ranked = device.roles.filter(role => role.rank !== null).sort((a, b) => a.rank! - b.rank!);
  const probe = deviceProbeStatus(device.deviceId, models, probes);
  const status: ModelRowStatus | null = probe ?? (live && live.active > 0 ? "busy" : null);
  return <tr data-device={device.deviceId} className={probe === "down" ? "[&>td:first-child]:border-l-[3px] [&>td:first-child]:border-l-down" : ""}>
    <td className={TD}><code className="font-semibold">{device.deviceId}</code>{!device.enabled && <span className="ml-1 rounded border border-warn bg-warn/10 px-1 font-semibold text-warn">꺼짐</span>}
      {device.source !== "table" && <span className="block text-fg-2">{device.source === "policy_fallback" ? "정책 대체" : "미설정"}</span>}
      {device.issues.length > 0 && <span className="block text-down" title={device.issues.join("\n")}>문제 {device.issues.length}</span>}</td>
    <td className={TD}>{server.name}{server.hosts.map(host => <span key={host} className="block break-all font-mono text-fg-2">{host}</span>)}{!server.hosts.length && <span className="block font-mono text-fg-2">주소 없음</span>}</td>
    <td className={`${TD} text-right tabular-nums`}>{num(device.settings.limitSlots)}</td>
    <td className={`${TD} text-right tabular-nums`}>{num(device.settings.secondaryCap)}</td>
    <td className={`${TD} text-right tabular-nums`}>{live ? <><b>{num(live.active)}</b> / {num(live.limitSlots)}{live.active > live.limitSlots && <span className="text-down"> 초과</span>}</> : <span className="text-fg-2">미확인</span>}</td>
    <td className={`${TD} text-right tabular-nums`}>{live ? <>{num(live.secondaryActive)} / {num(live.secondaryBound)}{live.lending && <span className="block text-warn">빌려 쓰는 중</span>}</> : <span className="text-fg-2">—</span>}</td>
    <td className={`${TD} text-right tabular-nums`}>{live ? <>{num(live.waiting)}{live.waitingPrimary > 0 && <span className="block text-fg-2">우선 {num(live.waitingPrimary)}</span>}</> : <span className="text-fg-2">—</span>}</td>
    <td className={TD}>{ranked.length ? <div className="grid gap-px">{ranked.map(role => <span key={role.routeId} className="whitespace-nowrap"><i className="inline-block w-[1.3em] not-italic font-mono text-fg-2">{role.rank}</i>{role.label}{!role.inPolicy && <span className="text-warn"> 정책 밖</span>}</span>)}</div>
      : <span className="text-fg-2">순위 없음</span>}
      {device.roles.some(role => role.rank === null) && <span className="block text-fg-2">순위 없음: {device.roles.filter(role => role.rank === null).map(role => role.routeId).join(", ")}</span>}</td>
    <td className={`${TD} text-right tabular-nums`}>{device.settings.physicalLimit === null ? <span className="text-fg-2">없음</span> : num(device.settings.physicalLimit)}</td>
    <td className={TD}>{status ? <ModelStatusBadge status={status} /> : <span className="text-fg-2">확인 기록 없음</span>}
      {live && <span className="block text-fg-2">{live.primaryBusy ? "우선 역할 바쁨" : "우선 역할 유휴"}</span>}</td>
    <td className={`${TD} text-right font-mono tabular-nums`}>{device.version === null ? "—" : `v${device.version}`}</td>
  </tr>;
}
