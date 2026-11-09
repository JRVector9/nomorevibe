import { formatListTime } from "@/lib/format/time";
import { ageLabel, durationLabel, percentLabel, type HelperGateView, type HelperRouteDefaults, type HelperRowView, type HelperSettingsDefaults } from "@/lib/operations/admin-model-helpers";
import { HelperForm } from "./HelperForm";
import { HelperRow } from "./HelperRow";

const num = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("ko-KR");
/** 판정 배지 — 모양 하나 + 글자(색만으로 가르지 않는다) */
const VERDICT: Record<HelperRowView["verdict"], { level: string; shape: string }> = {
  help: { level: "ok", shape: "●" }, shadow_only: { level: "info", shape: "◐" }, hold: { level: "idle", shape: "‖" },
};
const COLUMNS = 8;

function gateText(label: string, gate: HelperGateView | null): string {
  return gate ? `${label} ${gate.ok ? "열림" : "닫힘"} · 점유 ${num(gate.active)}/${num(gate.maxSlots)}` : `${label} 미확인`;
}

/** 섀도 표본 · 일치율 — 나머지 지표(잘못 승인·잘못 거절·미확인률·실패율)는 title 로 */
function shadowSummary(row: HelperRowView) {
  if (row.shadow.samples === null) return <span className="mh-muted">표본 없음</span>;
  const rest = `잘못 승인 ${percentLabel(row.shadow.wrongApproval)} · 잘못 거절 ${percentLabel(row.shadow.wrongRejection)} · 미확인률 ${percentLabel(row.shadow.unknownRate)} · 실패율 ${percentLabel(row.shadow.failureRate)}`;
  return <span className="mh-num" title={rest}>{num(row.shadow.samples)} / {num(row.settings.minShadowSamples)} · {percentLabel(row.shadow.agreement)}</span>;
}

/** 펼침 줄 위쪽 — 표에서 뺀 칸(신호 나이·입장·주 장비·자기 일·섀도 세부·판·배정 이름·자동 정지 시각)을 한 덩어리로 */
function HelperFacts({ row, now }: { row: HelperRowView; now: Date }) {
  const primary = row.primary.full === null && row.primary.active === null ? "—"
    : [row.primary.full === null ? null : row.primary.full ? "가득 참" : "여유", row.primary.active !== null ? `${num(row.primary.active)}/${num(row.primary.limit)}` : null,
      row.primary.waiting !== null ? `대기 ${num(row.primary.waiting)}` : null, row.primary.devices !== null ? `장비 ${num(row.primary.devices)}대` : null].filter(Boolean).join(" · ");
  return <dl className="mh-facts">
    <div><dt>배정</dt><dd><code>{row.assignmentId}</code> · 판 <span className="mh-num">{row.version}</span></dd></div>
    <div><dt>신호 나이</dt><dd>{ageLabel(row.signalAgeMs)}{row.signalLeftMs !== null && <> · {row.signalLeftMs > 0 ? `${durationLabel(row.signalLeftMs)} 남음` : "만료"}</>}
      {row.streak !== null && row.signalUsable && <> · 연속 {num(row.streak)}</>}</dd></div>
    <div><dt>입장(실제)</dt><dd>{gateText("실전", row.gates.live)} / {gateText("섀도", row.gates.shadow)}</dd></div>
    <div><dt>주 장비</dt><dd>{primary}</dd></div>
    <div><dt>자기 일</dt><dd>{row.ownWork ? <>{row.ownWork.label} <strong className="mh-num">{num(row.ownWork.backlog)}</strong>
      {" · "}<span className={row.ownWork.fresh ? "" : "mh-warn"}>{row.ownWork.fresh ? ageLabel(row.ownWork.ageMs) : "오래됨 → 바쁨으로 봄"}</span></>
      : <span className="mh-muted">beacon 없음 → 바쁨으로 봄</span>}
      {row.deviceDemand?.usable && row.deviceDemand.primaryDemand && <span className="mh-warn"> · 빌려주기 멈춤</span>}</dd></div>
    {row.shadow.samples !== null && <div><dt>섀도</dt><dd>표본 {num(row.shadow.samples)} · 일치율 {percentLabel(row.shadow.agreement)} · 잘못 승인 {percentLabel(row.shadow.wrongApproval)}
      {" · "}잘못 거절 {percentLabel(row.shadow.wrongRejection)} · 미확인률 {percentLabel(row.shadow.unknownRate)} · 실패율 {percentLabel(row.shadow.failureRate)}</dd></div>}
    {row.stops.map(stop => <div key={stop.id}><dt>자동 정지</dt><dd><span className="mh-alert">{stop.effectLabel}</span> · {stop.reasonLabel} · {formatListTime(stop.createdAt, now)}</dd></div>)}
  </dl>;
}

/**
 * 도우미 배정 표(2026-11-09 승인 시안) — 8열: 서버 · 돕는 단계 · 모델 · 모드 · 지금(판정 + 이유) · 섀도 표본 · 일치율 · 자동 정지 · 동작(「설정」).
 * 판정은 신호를 쓸 수 있을 때만 그 판정이고, 아니면 「쉬는 중」과 신호를 못 쓰는 이유다(fail-closed). 표에서 뺀 칸은 「설정」으로 펼친 줄 위에 있다.
 * form 을 주면 펼친 줄에 그 배정의 설정 폼을 그린다(없으면 사실만).
 */
export function HelperTable({ helpers, now, names, form }: { helpers: HelperRowView[]; now: Date; names?: Readonly<Record<string, string>>;
  form?: { defaults: HelperSettingsDefaults; routeDefaults: HelperRouteDefaults; readOnly?: boolean } }) {
  if (!helpers.length) return <p className="mh-empty">도우미 배정이 없습니다 — 아래 「새 배정 +」에서 꺼짐으로 먼저 만드세요.</p>;
  return <div className="mh-scroll"><table className="mh-table mh-helpers">
    <thead><tr><th>서버</th><th>돕는 단계</th><th>모델</th><th>모드</th><th>지금</th>
      <th className="r" title="잘못 승인·잘못 거절·미확인률·실패율은 숫자에 마우스를 올리거나 「설정」을 펼치면 보입니다">섀도 표본 · 일치율</th>
      <th>자동 정지</th><th className="r">동작</th></tr></thead>
    <tbody>{helpers.map(row => {
      const name = names?.[row.deviceId] ?? row.deviceId;
      const verdict = VERDICT[row.verdict];
      const cells = <>
        <td className="nowrap"><a href={`#helper-${row.assignmentId}`} className="mh-name" title={`장비 id ${row.deviceId}`}>{name}</a>
          {row.issues.length > 0 && <span className="mh-sub mh-warn" title={row.issues.join("\n")}>알림 {row.issues.length}</span>}</td>
        <td className="nowrap">{row.stageLabel}</td>
        <td><code>{row.model}</code></td>
        <td><span className="mh-tag" data-mode={row.mode}>{row.modeLabel}</span></td>
        <td><span className="mh-lv" data-l={verdict.level} data-shape={verdict.shape} data-verdict={row.verdict}>{row.verdictLabel}</span>
          <span className={`mh-sub${row.signalUsable ? "" : " mh-muted"}`}>{row.reasonLabel}</span></td>
        <td className="r nowrap">{shadowSummary(row)}</td>
        <td>{row.stops.length === 0 ? <span className="mh-muted">없음</span>
          : row.stops.map(stop => <span key={stop.id} className="mh-sub" title={`${stop.effectLabel} · ${formatListTime(stop.createdAt, now)}`}>
            <span className="mh-alert">{stop.effect === "stop" ? "정지" : "섀도 강등"}</span> · {stop.reasonLabel}</span>)}</td>
      </>;
      const detail = <div className="mh-detail"><HelperFacts row={row} now={now} />
        {form && <HelperForm helper={row} defaults={form.defaults} routeDefaults={form.routeDefaults} readOnly={form.readOnly} names={names} bare />}</div>;
      return <HelperRow key={row.assignmentId} assignmentId={row.assignmentId} label={`${name} · ${row.stageLabel}`} cells={cells} detail={detail} colSpan={COLUMNS} />;
    })}</tbody>
  </table></div>;
}
