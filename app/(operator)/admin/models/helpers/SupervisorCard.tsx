"use client";
import { useActionState, useState } from "react";
// 형만 가져온다 — 그 모듈은 DB 를 읽는 서버 모듈이라 클라이언트 묶음에 들면 안 된다(devices/DeviceForm 과 같은 규칙)
import type { SupervisorBadge, SupervisorView } from "@/lib/operations/admin-model-helpers";
import { ConfirmSubmit } from "../ConfirmSubmit";
import { saveCapacitySupervisorTiming, switchCapacitySupervisor, type HelperActionState } from "./actions";

const INPUT = "w-24 rounded border border-line bg-bg px-2 py-1 text-right tabular-nums";
const BADGE_CLASS: Record<SupervisorBadge, string> = {
  ok: "bg-emerald-100 text-emerald-900", late: "bg-amber-100 text-amber-900", off: "bg-bg-soft text-fg-2", principal_mismatch: "bg-red-100 text-red-900",
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
  return <div className="grid gap-0.5"><dt className="text-[13px] font-semibold text-fg-3">{label}</dt><dd className="text-[14px]">{children}</dd></div>;
}

function Result({ state }: { state: HelperActionState }) {
  return <>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">거절 — {text}</p>)}
  </>;
}

/**
 * 감시자 카드(Oracle) — 전체 스위치(kill switch)·상태 배지(정상/늦음/꺼짐/계정 불일치)·lease·epoch·마지막 신호·신호 유효 시간/순환 간격(바꿀 수 있다)·
 * 빌려주기 제한 신호·자기 일 beacon. 끄면 다음 입장 판정부터 모든 도우미가 닫히고, 돌고 있는 호출은 끝까지 간다.
 */
export function SupervisorCard({ supervisor, readOnly }: { supervisor: SupervisorView | null; readOnly?: boolean }) {
  const [switchState, switchAction, switching] = useActionState<HelperActionState, FormData>(switchCapacitySupervisor, null);
  const [timingState, timingAction, timing] = useActionState<HelperActionState, FormData>(saveCapacitySupervisorTiming, null);
  const [dirty, setDirty] = useState(false);
  if (!supervisor) return <div className="rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <h3 className="text-[17px] font-semibold">감시자 (Oracle)</h3>
    <p className="text-[13px] text-fg-3">감시자 상태를 읽지 못해 스위치를 보이지 않습니다. 감시자가 없거나 꺼져 있으면 도우미는 모두 쉬고 우선 역할은 그대로입니다.</p>
  </div>;
  const s = supervisor;
  return <div id="supervisor-card" className="grid gap-4 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <div className="flex flex-wrap items-baseline gap-2">
      <h3 className="text-[17px] font-semibold">감시자 (Oracle)</h3>
      <span data-badge={s.badge} className={`rounded-full px-2 text-[13px] font-semibold ${BADGE_CLASS[s.badge]}`}>{s.badgeLabel}</span>
      <span className="text-[13px] text-fg-3">전체 스위치 <strong>{s.enabled ? "켜짐" : "꺼짐"}</strong></span>
    </div>
    <p className="text-[13px] text-fg-2">{s.badgeDetail}</p>
    <form action={switchAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="enabled" value={s.enabled ? "false" : "true"} />
      {!s.enabled && <label className="flex items-center gap-1 text-[13px]"><input type="checkbox" name="confirm" value="yes" disabled={readOnly} />
        감시자 계정·GRANT·정책의 도우미 경로·배정(꺼짐)을 마쳤습니다</label>}
      <ConfirmSubmit label={s.enabled ? "감시자 끄기" : "감시자 켜기"} confirmLabel={s.enabled ? "끄기 확인" : "켜기 확인"} pending={switching} pendingLabel="바꾸는 중…"
        disabled={readOnly} className={`rounded px-3 py-2 disabled:opacity-50 ${s.enabled ? "bg-red-600 text-white" : "bg-fg text-bg"}`}
        changes={[{ label: "감시자 전체 스위치", before: s.enabled ? "켜짐" : "꺼짐", after: s.enabled ? "꺼짐" : "켜짐" }]}
        summary={s.enabled ? "다음 입장 판정부터 모든 도우미가 닫힙니다. 돌고 있는 호출은 끝까지 갑니다." : "신선한 신호가 있을 때만 도우미가 열립니다. 우선 역할 일은 막지 않습니다."} />
      <span className="text-[13px] text-fg-3">끄면 다음 입장 판정부터 모든 도우미가 닫힙니다 — 돌고 있는 호출은 끝까지 갑니다. 우선 역할은 영향이 없습니다.</span>
    </form>
    <Result state={switchState} />
    <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Fact label="위치">{s.location}</Fact>
      <Fact label="인스턴스"><code>{s.instanceId ?? "없음"}</code></Fact>
      <Fact label="boot"><code className="break-all">{s.bootId ?? "없음"}</code></Fact>
      <Fact label="epoch · 순환 번호"><span className="font-mono">{s.epoch}</span> · <span className="font-mono">{s.loopSeq}</span></Fact>
      <Fact label="lease">{s.leaseAlive ? <>살아 있음({clientDurationLabel(s.leaseLeftMs)} 남음)</> : <span className="text-amber-700">만료{s.leaseUntil ? "" : "(잡은 적 없음)"}</span>}</Fact>
      <Fact label="마지막 heartbeat">{clientAgeLabel(s.heartbeatAgeMs)}</Fact>
      <Fact label="마지막 신호">{clientAgeLabel(s.lastSignalAgeMs)}</Fact>
      <Fact label="배포판(release)"><code>{s.release ?? "없음"}</code></Fact>
      <Fact label="신호 계정(signal_principal)"><code>{s.signalPrincipal}</code></Fact>
      <Fact label="신호 유효 시간 · 순환 간격">{clientDurationLabel(s.signalTtlMs)} · {clientDurationLabel(s.loopMs)}</Fact>
      <Fact label="마지막 변경">{s.updatedBy}</Fact>
    </dl>
    {s.foreignWriters.length > 0 && <p role="alert" className="text-[13px] text-red-600">다른 계정이 쓴 신호: {s.foreignWriters.join(", ")}</p>}
    <form action={timingAction} data-dirty={dirty || undefined} onChange={() => setDirty(true)} className="flex flex-wrap items-end gap-3">
      <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">신호 유효 시간</span>
        <span className="flex items-center gap-1"><input name="signalTtlSeconds" defaultValue={seconds(s.signalTtlMs)} aria-label="신호 유효 시간" inputMode="decimal"
          disabled={readOnly} className={INPUT} /><span className="text-fg-3">초</span></span>
        <span className="text-fg-3">15~300초 · 이 시간이 지나면 신호가 만료되어 도우미가 닫힙니다</span></label>
      <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">순환 간격</span>
        <span className="flex items-center gap-1"><input name="loopSeconds" defaultValue={seconds(s.loopMs)} aria-label="순환 간격" inputMode="decimal"
          disabled={readOnly} className={INPUT} /><span className="text-fg-3">초</span></span>
        <span className="text-fg-3">5~60초 · 유효 시간의 절반 이하</span></label>
      <ConfirmSubmit label="순환 설정 저장" pending={timing} disabled={readOnly} savedKey={`${s.signalTtlMs}:${s.loopMs}`} />
    </form>
    <Result state={timingState} />
    <div className="grid gap-1">
      <h4 className="text-[15px] font-semibold">빌려주기 제한 신호(장비별 자기 일 수요)</h4>
      <p className="text-[13px] text-fg-3">신선한 수요 신호는 그 장비의 빌려주기를 바로 멈춥니다. 오래된 신호는 무시하고 장부 규칙(장비 한도)으로 돌아갑니다 — 막지 않습니다.</p>
      {s.deviceDemand.length === 0 ? <p className="text-[13px] text-fg-3">신호가 없습니다.</p>
        : <ul className="grid gap-0.5 text-[13px]">{s.deviceDemand.map(entry => <li key={entry.deviceId}><code>{entry.deviceId}</code> · {entry.primaryDemand ? `수요 있음(대기 ${entry.backlog.toLocaleString("ko-KR")})` : "수요 없음"}
          {" · "}{entry.usable ? "쓰는 신호" : <span className="text-fg-3">무시(오래됨·다른 epoch·계정)</span>} · {clientAgeLabel(entry.ageMs)}{entry.reason && <span className="text-fg-3"> · {entry.reason}</span>}</li>)}</ul>}
    </div>
    <div className="grid gap-1">
      <h4 className="text-[15px] font-semibold">자기 일 beacon</h4>
      <p className="text-[13px] text-fg-3">집 쪽 잡이 남기는 자기 역할 적체입니다. 오래되거나 없으면 감시자는 그 장비를 바쁨으로 봅니다(돕지 않음).</p>
      {s.roleDemand.length === 0 ? <p className="text-[13px] text-fg-3">beacon 이 없습니다.</p>
        : <ul className="grid gap-0.5 text-[13px]">{s.roleDemand.map(entry => <li key={entry.roleId}>{entry.label} <strong className="tabular-nums">{entry.backlog.toLocaleString("ko-KR")}</strong>
          {" · "}<code>{entry.deviceId}</code> · {entry.fresh ? "신선" : <span className="text-amber-700">오래됨 → 바쁨으로 봄</span>} · {clientAgeLabel(entry.ageMs)}</li>)}</ul>}
    </div>
  </div>;
}
