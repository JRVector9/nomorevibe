"use client";
import { useActionState, useState } from "react";
// 형만 가져온다 — 그 모듈은 DB 를 읽는 서버 모듈이라 클라이언트 묶음에 들면 안 된다(devices/DeviceForm 과 같은 규칙)
import type { SupervisorBadge, SupervisorView } from "@/lib/operations/admin-model-helpers";
import { ConfirmSubmit } from "../ConfirmSubmit";
import { saveCapacitySupervisorTiming, switchCapacitySupervisor, type HelperActionState } from "./actions";

const INPUT = "w-24 rounded border border-line bg-bg px-2 py-1 text-right tabular-nums";
/** 상태 배지 — 모양 하나 + 글자(helpers.css .mh-lv) */
const BADGE: Record<SupervisorBadge, { level: string; shape: string }> = {
  ok: { level: "ok", shape: "●" }, late: { level: "warn", shape: "▲" }, off: { level: "idle", shape: "‖" }, principal_mismatch: { level: "bad", shape: "■" },
};
/** ms 나이 → "12초 전" — lib/operations/admin-model-helpers.ts ageLabel 과 같은 규칙(이 파일은 서버 모듈을 값으로 가져오지 않는다) */
export function clientAgeLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 ${seconds % 60}초 전`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}시간 ${minutes % 60}분 전` : `${Math.floor(hours / 24).toLocaleString("ko-KR")}일 전`;
}
/** ms 길이 → "45초", "2분" — lib 의 durationLabel 과 같은 규칙 */
export function clientDurationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.round(ms) / 1000;
  return seconds >= 60 && Number.isInteger(seconds / 60) ? `${(seconds / 60).toLocaleString("ko-KR")}분` : `${seconds.toLocaleString("ko-KR")}초`;
}
const seconds = (ms: number) => String(Math.round(ms) / 1000);

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function Result({ state }: { state: HelperActionState }) {
  return <>
    {state?.ok && <p role="status">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="mh-alert">거절 — {text}</p>)}
  </>;
}

/**
 * 감시자(Oracle) — 표 한 줄: 상태 배지(정상/늦음/꺼짐/계정 불일치) · 전체 스위치 · 마지막 신호 · 신호 유효 · 순환 · 동작(시간 바꾸기 · 끄기/켜기).
 * 끄면 다음 입장 판정부터 모든 도우미가 닫히고, 돌고 있는 호출은 끝까지 간다. lease·epoch·release·빌려주기 제한 신호·자기 일 beacon 은 「감시자 자세히」에 접는다.
 * names: 장비 id → 보이는 이름(그 장비를 쓰는 연결 이름). 장비 id 는 title 에만
 */
export function SupervisorCard({ supervisor, readOnly, names }: { supervisor: SupervisorView | null; readOnly?: boolean; names?: Readonly<Record<string, string>> }) {
  const [switchState, switchAction, switching] = useActionState<HelperActionState, FormData>(switchCapacitySupervisor, null);
  const [timingState, timingAction, timing] = useActionState<HelperActionState, FormData>(saveCapacitySupervisorTiming, null);
  const [dirty, setDirty] = useState(false);
  const [timingOpen, setTimingOpen] = useState(false);
  if (!supervisor) return <p className="mh-empty">감시자 상태를 읽지 못해 스위치를 보이지 않습니다. 감시자가 없거나 꺼져 있으면 도우미는 모두 쉬고 우선 역할은 그대로입니다.</p>;
  const s = supervisor;
  const badge = BADGE[s.badge];
  const switchHint = s.enabled ? "끄면 다음 입장 판정부터 모든 도우미가 닫힙니다 — 돌고 있는 호출은 끝까지 갑니다. 우선 역할은 영향이 없습니다."
    : "신선한 신호가 있을 때만 도우미가 열립니다. 우선 역할 일은 막지 않습니다.";
  return <div id="supervisor-card">
    <div className="mh-scroll"><table className="mh-table mh-supervisor">
      <thead><tr><th>상태</th><th>전체 스위치</th><th className="r">마지막 신호</th><th className="r">신호 유효</th><th className="r">순환</th><th className="r">동작</th></tr></thead>
      <tbody><tr>
        <td><span className="mh-lv" data-l={badge.level} data-shape={badge.shape} data-badge={s.badge} title={s.badgeDetail}>{s.badgeLabel}</span></td>
        <td>{s.enabled ? "켜짐" : "꺼짐"}</td>
        <td className="r mh-num nowrap">{clientAgeLabel(s.lastSignalAgeMs)}</td>
        <td className="r mh-num nowrap">{clientDurationLabel(s.signalTtlMs)}</td>
        <td className="r mh-num nowrap">{clientDurationLabel(s.loopMs)}</td>
        <td><div className="mh-acts">
          <button type="button" className="mh-btn" aria-expanded={timingOpen} aria-controls="supervisor-timing" onClick={() => setTimingOpen(!timingOpen)}>시간 바꾸기</button>
          <form action={switchAction} title={switchHint}>
            <input type="hidden" name="enabled" value={s.enabled ? "false" : "true"} />
            {!s.enabled && <label className="mh-check" title="감시자 계정·GRANT·정책의 도우미 경로·배정(꺼짐)을 마쳤습니다"><input type="checkbox" name="confirm" value="yes" disabled={readOnly} />
              준비 마침</label>}
            <ConfirmSubmit label={s.enabled ? "감시자 끄기" : "감시자 켜기"} confirmLabel={s.enabled ? "끄기 확인" : "켜기 확인"} pending={switching} pendingLabel="바꾸는 중…"
              disabled={readOnly} className={`mh-btn${s.enabled ? " danger" : ""}`}
              changes={[{ label: "감시자 전체 스위치", before: s.enabled ? "켜짐" : "꺼짐", after: s.enabled ? "꺼짐" : "켜짐" }]} summary={switchHint} />
          </form>
        </div></td>
      </tr></tbody>
    </table></div>
    <div className="mh-panel-body">
      {s.badge !== "ok" && <p className={s.badge === "off" ? "mh-muted" : "mh-warn"}>{s.badgeDetail}</p>}
      {s.foreignWriters.length > 0 && <p role="alert" className="mh-alert">다른 계정이 쓴 신호: {s.foreignWriters.join(", ")}</p>}
      <Result state={switchState} />
      <form id="supervisor-timing" hidden={!timingOpen} action={timingAction} data-dirty={dirty || undefined} onChange={() => setDirty(true)} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-0.5"><span className="font-semibold">신호 유효 시간</span>
          <span className="flex items-center gap-1"><input name="signalTtlSeconds" defaultValue={seconds(s.signalTtlMs)} aria-label="신호 유효 시간" inputMode="decimal"
            disabled={readOnly} className={INPUT} title="15~300초 · 이 시간이 지나면 신호가 만료되어 도우미가 닫힙니다" /><span className="mh-muted">초 · 15~300</span></span></label>
        <label className="grid gap-0.5"><span className="font-semibold">순환 간격</span>
          <span className="flex items-center gap-1"><input name="loopSeconds" defaultValue={seconds(s.loopMs)} aria-label="순환 간격" inputMode="decimal"
            disabled={readOnly} className={INPUT} title="5~60초 · 유효 시간의 절반 이하" /><span className="mh-muted">초 · 유효 시간의 절반 이하</span></span></label>
        <ConfirmSubmit label="순환 설정 저장" pending={timing} disabled={readOnly} savedKey={`${s.signalTtlMs}:${s.loopMs}`} />
      </form>
      <Result state={timingState} />
      <details className="mh-details">
        <summary>감시자 자세히</summary>
        <div className="mh-detail">
          <dl className="mh-facts">
            <Fact label="위치">{s.location}</Fact>
            <Fact label="인스턴스"><code>{s.instanceId ?? "없음"}</code></Fact>
            <Fact label="boot"><code>{s.bootId ?? "없음"}</code></Fact>
            <Fact label="epoch · 순환 번호"><span className="mh-num">{s.epoch}</span> · <span className="mh-num">{s.loopSeq}</span></Fact>
            <Fact label="lease">{s.leaseAlive ? <>살아 있음({clientDurationLabel(s.leaseLeftMs)} 남음)</> : <span className="mh-warn">만료{s.leaseUntil ? "" : "(잡은 적 없음)"}</span>}</Fact>
            <Fact label="마지막 heartbeat">{clientAgeLabel(s.heartbeatAgeMs)}</Fact>
            <Fact label="배포판"><code>{s.release ?? "없음"}</code></Fact>
            <Fact label="신호 계정"><code>{s.signalPrincipal}</code></Fact>
            <Fact label="마지막 변경">{s.updatedBy}</Fact>
          </dl>
          <div><strong>빌려주기 제한 신호</strong> <span className="mh-muted">— 신선한 수요 신호는 그 장비의 빌려주기를 바로 멈춥니다. 오래된 신호는 무시합니다.</span>
            {s.deviceDemand.length === 0 ? <p className="mh-muted">신호가 없습니다.</p>
              : <ul className="mh-list">{s.deviceDemand.map(entry => <li key={entry.deviceId}><span className="font-semibold" title={`장비 id ${entry.deviceId}`}>{names?.[entry.deviceId] ?? entry.deviceId}</span> · {entry.primaryDemand ? `수요 있음(대기 ${entry.backlog.toLocaleString("ko-KR")})` : "수요 없음"}
                {" · "}{entry.usable ? "쓰는 신호" : <span className="mh-muted">무시(오래됨·다른 epoch·계정)</span>} · {clientAgeLabel(entry.ageMs)}{entry.reason && <span className="mh-muted"> · {entry.reason}</span>}</li>)}</ul>}</div>
          <div><strong>자기 일 beacon</strong> <span className="mh-muted">— 오래되거나 없으면 감시자는 그 장비를 바쁨으로 봅니다(돕지 않음).</span>
            {s.roleDemand.length === 0 ? <p className="mh-muted">beacon 이 없습니다.</p>
              : <ul className="mh-list">{s.roleDemand.map(entry => <li key={entry.roleId}>{entry.label} <strong className="mh-num">{entry.backlog.toLocaleString("ko-KR")}</strong>
                {" · "}<span title={`장비 id ${entry.deviceId}`}>{names?.[entry.deviceId] ?? entry.deviceId}</span> · {entry.fresh ? "신선" : <span className="mh-warn">오래됨 → 바쁨으로 봄</span>} · {clientAgeLabel(entry.ageMs)}</li>)}</ul>}</div>
        </div>
      </details>
    </div>
  </div>;
}
