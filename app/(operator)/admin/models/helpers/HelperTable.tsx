import { formatListTime } from "@/lib/format/time";
import { ageLabel, durationLabel, percentLabel, type HelperGateView, type HelperRowView } from "@/lib/operations/admin-model-helpers";

const TH = "py-2 pr-3 text-[13px] font-semibold text-fg-3";
const TD = "py-2 pr-3 align-top";
const num = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("ko-KR");
const VERDICT_CLASS: Record<HelperRowView["verdict"], string> = {
  help: "bg-emerald-100 text-emerald-900", shadow_only: "bg-amber-100 text-amber-900", hold: "bg-bg-soft text-fg-2",
};

function Gate({ label, gate }: { label: string; gate: HelperGateView | null }) {
  if (!gate) return <div className="text-fg-3">{label} 미확인</div>;
  return <div>{label} {gate.ok ? <strong>열림</strong> : <span className="text-fg-3">닫힘</span>}
    <span className="tabular-nums text-fg-3"> · 점유 {num(gate.active)}/{num(gate.maxSlots)}</span></div>;
}

/**
 * 도우미 표 — 배정 한 줄씩: 도우미 장비 · 돕는 단계 · 모델 · 모드 · 지금 판정(+이유) · 신호 나이 · 입장(DB 의 helper_gate) · 주 장비 · 자기 일 · 섀도 · 자동 정지 · 판.
 * 판정은 신호를 쓸 수 있을 때만 그 판정이고, 아니면 「쉬는 중」과 신호를 못 쓰는 이유다(fail-closed). 색만으로 가르지 않고 글자를 낸다.
 */
export function HelperTable({ helpers, now, names }: { helpers: HelperRowView[]; now: Date; names?: Readonly<Record<string, string>> }) {
  if (!helpers.length) return <p className="text-[13px] text-fg-3">도우미 배정이 없습니다 — 아래 「새 배정」에서 꺼짐으로 먼저 만드세요.</p>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[1320px] text-left text-[13px]"><thead><tr className="border-b border-line">
    <th className={TH}>도우미 장비</th><th className={TH}>돕는 단계</th><th className={TH}>모델</th><th className={TH}>모드</th><th className={TH}>지금 판정</th>
    <th className={TH}>신호 나이</th><th className={TH}>입장(실제)</th><th className={TH}>주 장비</th><th className={TH}>자기 일</th><th className={TH}>섀도</th>
    <th className={TH}>자동 정지</th><th className={TH}>판</th></tr></thead>
    <tbody>{helpers.map(row => <tr key={row.assignmentId} className="border-b border-line" data-assignment={row.assignmentId}>
      <td className={TD}><a href={`#helper-${row.assignmentId}`} className="font-semibold underline" title={`장비 id ${row.deviceId}`}>{names?.[row.deviceId] ?? row.deviceId}</a>
        <div className="font-mono text-fg-3">{row.assignmentId}</div>
        {row.issues.length > 0 && <div className="text-amber-700" title={row.issues.join("\n")}>알림 {row.issues.length}</div>}</td>
      <td className={TD}>{row.stageLabel}</td>
      <td className={TD}><code className="break-all">{row.model}</code></td>
      <td className={TD}><span className={row.mode === "off" ? "text-fg-3" : "font-semibold"}>{row.modeLabel}</span></td>
      <td className={TD}><span data-verdict={row.verdict} className={`rounded-full px-1.5 font-semibold ${VERDICT_CLASS[row.verdict]}`}>{row.verdictLabel}</span>
        <div className={row.signalUsable ? "" : "text-fg-3"}>{row.reasonLabel}</div>
        {row.streak !== null && row.signalUsable && <div className="tabular-nums text-fg-3">연속 {num(row.streak)}</div>}</td>
      <td className={`${TD} whitespace-nowrap`}>{ageLabel(row.signalAgeMs)}
        {row.signalLeftMs !== null && <div className="text-fg-3">{row.signalLeftMs > 0 ? `${durationLabel(row.signalLeftMs)} 남음` : "만료"}</div>}</td>
      <td className={`${TD} whitespace-nowrap`}><Gate label="실전" gate={row.gates.live} /><Gate label="섀도" gate={row.gates.shadow} /></td>
      <td className={`${TD} tabular-nums`}>{row.primary.full === null && row.primary.active === null ? <span className="text-fg-3">—</span> : <>
        {row.primary.full === null ? null : row.primary.full ? <strong>가득 참</strong> : "여유"}
        {row.primary.active !== null && <> {num(row.primary.active)}/{num(row.primary.limit)}</>}
        {row.primary.waiting !== null && <div>대기 {num(row.primary.waiting)}</div>}
        {row.primary.devices !== null && <div className="text-fg-3">장비 {num(row.primary.devices)}대</div>}</>}</td>
      <td className={TD}>{row.ownWork ? <>{row.ownWork.label} <strong className="tabular-nums">{num(row.ownWork.backlog)}</strong>
        <div className={row.ownWork.fresh ? "text-fg-3" : "text-amber-700"}>{row.ownWork.fresh ? ageLabel(row.ownWork.ageMs) : "오래됨 → 바쁨으로 봄"}</div></>
        : <span className="text-fg-3">beacon 없음 → 바쁨으로 봄</span>}
        {row.deviceDemand?.usable && row.deviceDemand.primaryDemand && <div className="text-amber-700">빌려주기 멈춤</div>}</td>
      <td className={`${TD} tabular-nums`}>{row.shadow.samples === null ? <span className="text-fg-3">표본 없음</span> : <>
        <div>표본 {num(row.shadow.samples)}<span className="text-fg-3"> / 승격 기준 {num(row.settings.minShadowSamples)}</span></div>
        <div>일치율 {percentLabel(row.shadow.agreement)}</div>
        <div>위험 불일치 잘못 승인 {percentLabel(row.shadow.wrongApproval)} · 잘못 거절 {percentLabel(row.shadow.wrongRejection)}</div>
        <div>미확인률 {percentLabel(row.shadow.unknownRate)} · 실패율 {percentLabel(row.shadow.failureRate)}</div></>}</td>
      <td className={TD}>{row.stops.length === 0 ? <span className="text-fg-3">없음</span>
        : row.stops.map(stop => <div key={stop.id}><span className="font-semibold text-red-600">{stop.effectLabel}</span><div>{stop.reasonLabel}</div>
          <div className="whitespace-nowrap text-fg-3">{formatListTime(stop.createdAt, now)}</div></div>)}</td>
      <td className={`${TD} font-mono`}>{row.version}</td>
    </tr>)}</tbody></table></div>;
}
