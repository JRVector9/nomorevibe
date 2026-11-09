import { formatListTime } from "@/lib/format/time";
import { deviceSourceLabel, secondsLabel, type DeviceView } from "@/lib/operations/admin-capacity-devices";

const TH = "py-2 pr-3 text-[13px] font-semibold text-fg-3";
const TD = "py-2 pr-3 align-top";
const num = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("ko-KR");

/** 장비 id → 보이는 이름(그 장비를 쓰는 연결 이름 — llm-display deviceDisplay)과 연결이 있는가(null = 연결을 못 읽음) */
export type DeviceNames = Readonly<Record<string, Readonly<{ name: string; connected: boolean | null }>>>;
/** 장비 이름 — 연결 이름을 먼저, 정책 groupId(장비 id)는 다를 때만 옆에 작게. 연결이 없는 장비는 「연결 없음」 */
export function DeviceName({ deviceId, names }: { deviceId: string; names?: DeviceNames }) {
  const entry = names?.[deviceId];
  const name = entry?.name ?? deviceId;
  return <><span className="font-semibold">{name}</span>{name !== deviceId && <code className="ml-1 text-fg-3" title="장비 id(정책 groupId)">{deviceId}</code>}
    {entry?.connected === false && <span className="ml-1 rounded-full bg-amber-100 px-1.5 font-semibold text-amber-900" title="이 장비를 쓰는 AI 연결이 없습니다">연결 없음</span>}</>;
}

/**
 * 장비 목록 한 표 — 설정값(칸 수·낮은 순위 상한·유휴·비워 둘 칸·엔진 실제)·판·마지막 저장과 실시간 상태(점유·우선 역할·낮은 순위 n/상한·빌려 쓰는 중·대기).
 * 색만으로 가르지 않고 글자를 낸다(빌려 쓰는 중·바쁨·유휴·정책 대체·미설정). 점유는 예약+진행만이다.
 */
export function DeviceTable({ devices, now, names }: { devices: DeviceView[]; now: Date; names?: DeviceNames }) {
  if (!devices.length) return <p className="text-[13px] text-fg-3">장비가 없습니다.</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-left text-[13px]"><thead><tr className="border-b border-line">
    <th className={TH}>장비</th><th className={TH}>출처</th><th className={TH}>칸 수</th><th className={TH}>낮은 순위 평소 상한</th><th className={TH}>유휴 판정</th><th className={TH}>비워 둘 칸</th>
    <th className={TH}>엔진 실제</th><th className={TH}>역할 순서</th><th className={TH}>점유(예약+진행)</th><th className={TH}>우선 역할</th><th className={TH}>낮은 순위 / 상한</th><th className={TH}>대기</th>
    <th className={TH}>판</th><th className={TH}>마지막 저장</th></tr></thead>
    <tbody>{devices.map(device => {
      const live = device.live;
      const ranked = device.roles.filter(role => role.rank !== null);
      return <tr key={device.deviceId} className="border-b border-line" data-device={device.deviceId}>
        <td className={TD}><a href={`#device-${device.deviceId}`} className="underline"><DeviceName deviceId={device.deviceId} names={names} /></a>
          {!device.enabled && <span className="ml-1 rounded-full bg-amber-100 px-1.5 font-semibold text-amber-900">꺼짐</span>}
          {device.issues.length > 0 && <span className="ml-1 text-red-600" title={device.issues.join("\n")}>문제 {device.issues.length}</span>}</td>
        <td className={TD}><span className={device.source === "table" ? "" : "rounded-full bg-amber-100 px-1.5 font-semibold text-amber-900"}>{deviceSourceLabel(device.source)}</span>
          {live && device.source === "table" && live.source === "policy_fallback" && <span className="ml-1 text-amber-700">판정은 정책 대체</span>}</td>
        <td className={`${TD} tabular-nums`}>{num(device.settings.limitSlots)}</td>
        <td className={`${TD} tabular-nums`}>{num(device.settings.secondaryCap)}</td>
        <td className={`${TD} tabular-nums`}>{secondsLabel(device.settings.idleMs)}</td>
        <td className={`${TD} tabular-nums`}>{num(device.settings.reserveSlots)}</td>
        <td className={`${TD} tabular-nums`}>{device.settings.physicalLimit === null ? <span className="text-fg-3">없음</span> : num(device.settings.physicalLimit)}</td>
        <td className={TD}>{ranked.length ? ranked.map(role => <div key={role.routeId}><span className="tabular-nums">{role.rank}</span> {role.label}{role.label !== role.routeId && <> <code className="text-fg-3">{role.routeId}</code></>}{!role.inPolicy && <span className="text-amber-700"> 정책 밖</span>}</div>)
          : <span className="text-fg-3">순위 없음(모두 최하위)</span>}
          {device.roles.some(role => role.rank === null) && <div className="text-fg-3" title={device.roles.filter(role => role.rank === null).map(role => role.routeId).join(", ")}>순위 없음: {device.roles.filter(role => role.rank === null).map(role => role.label).join(", ")}</div>}</td>
        <td className={`${TD} tabular-nums`}>{live ? <><strong>{num(live.active)}</strong> / {num(live.limitSlots)}{live.active > live.limitSlots && <span className="text-red-600"> 초과</span>}</> : <span className="text-fg-3">미확인</span>}</td>
        <td className={TD}>{live ? live.primaryBusy ? "바쁨" : "유휴" : <span className="text-fg-3">미확인</span>}</td>
        <td className={`${TD} tabular-nums`}>{live ? <>{num(live.secondaryActive)} / {num(live.secondaryBound)}
          {live.lending && <span className="ml-1 rounded-full bg-amber-100 px-1.5 font-semibold text-amber-900">빌려 쓰는 중</span>}</> : <span className="text-fg-3">미확인</span>}</td>
        <td className={`${TD} tabular-nums`}>{live ? <>{num(live.waiting)}{live.waitingPrimary > 0 && <span className="text-fg-3"> (우선 {num(live.waitingPrimary)})</span>}</> : <span className="text-fg-3">미확인</span>}</td>
        <td className={`${TD} font-mono`}>{device.version ?? "—"}</td>
        <td className={`${TD} whitespace-nowrap`}>{device.updatedAt ? <>{device.updatedBy} {formatListTime(device.updatedAt, now)}</> : <span className="text-fg-3">저장한 적 없음</span>}</td>
      </tr>;
    })}</tbody></table></div>;
}
