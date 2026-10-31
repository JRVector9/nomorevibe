"use client";
import { useActionState, useState } from "react";
// 형만 가져온다 — 그 모듈은 DB 를 읽는 서버 모듈이라 클라이언트 묶음에 들면 안 된다(limits/fields.tsx 와 같은 규칙)
import type { DeviceSettingsView, DeviceView } from "@/lib/operations/admin-capacity-devices";
import { RolesEditor } from "./RolesEditor";
import { saveCapacityDevice, type DeviceSaveState } from "./actions";

const INPUT = "w-24 rounded border border-line bg-bg px-2 py-1 text-right tabular-nums";
const num = (value: number | null) => value === null ? "" : String(value);
/** ms → 초 글자("60", "1.5") — lib/operations/admin-capacity-devices.ts idleToInput 과 같은 규칙(폼은 초로 받고 저장은 ms) */
const idleToInput = (ms: number) => String(Math.round(ms) / 1000);

/**
 * 한 칸 — 지금 값 입력 + 기본값. 기본값은 정책 groupLimits(칸 수·낮은 순위 상한)·60초(유휴)·0(비워 둘 칸)·없음(엔진 실제)이다.
 * 입력은 손대지 않은(uncontrolled) 칸이라 폼이 data-dirty 를 달아 자동 새로고침(live-refresh)이 값을 덮지 않게 한다.
 */
function NumberField({ name, label, value, defaultValue, unit, note, readOnly, placeholder }: { name: string; label: string; value: string; defaultValue: string;
  unit?: string; note?: string; readOnly?: boolean; placeholder?: string }) {
  const overridden = value !== defaultValue;
  return <label className="grid gap-0.5 text-[13px]">
    <span className="font-semibold text-fg-2">{label}</span>
    <span className="flex items-center gap-1">
      <input name={name} defaultValue={value} aria-label={label} title={note ?? label} inputMode="decimal" placeholder={placeholder} disabled={readOnly} className={INPUT} />
      {unit && <span className="text-fg-3">{unit}</span>}
      <span className={`rounded-full px-1.5 font-semibold ${overridden ? "bg-amber-100 text-amber-900" : "text-fg-3"}`}>{overridden ? "바꿈" : "기본값"}</span>
    </span>
    <span className="text-fg-3">기본 {defaultValue === "" ? "없음" : `${defaultValue}${unit ?? ""}`}{note ? ` · ${note}` : ""}</span>
  </label>;
}

/**
 * 장비 한 대 폼(device 가 null 이면 새 장비). 숨은 expectedVersion 으로 CAS — 저장 사이에 다른 사람이 저장했으면 거절을 그대로 보인다.
 * 정책 대체(policy_fallback)·미설정 장비도 같은 폼으로 첫 행을 만든다(expectedVersion 빈 값).
 */
export function DeviceForm({ device, readOnly }: { device: DeviceView | null; readOnly?: boolean }) {
  const [state, action, pending] = useActionState<DeviceSaveState, FormData>(saveCapacityDevice, null);
  const [dirty, setDirty] = useState(false);
  const settings: DeviceSettingsView = device?.settings ?? { limitSlots: null, secondaryCap: null, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null };
  const defaults: DeviceSettingsView = device?.defaults ?? { limitSlots: null, secondaryCap: null, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null };
  const id = device ? `device-${device.deviceId}` : "device-new";
  return <form id={id} action={action} data-dirty={dirty || undefined} onChange={() => setDirty(true)} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px] scroll-mt-6">
    <div className="flex flex-wrap items-baseline gap-2">
      {device ? <><h3 className="font-mono text-[17px] font-semibold">{device.deviceId}</h3><input type="hidden" name="deviceId" value={device.deviceId} />
        <span className="text-[13px] text-fg-3">{device.source === "table" ? `판 ${device.version}` : device.source === "policy_fallback" ? "정책 대체 — 저장하면 행이 생깁니다" : "미설정 — 저장해야 입장이 됩니다"}</span>
        {!device.enabled && <span className="rounded-full bg-amber-100 px-1.5 text-[13px] font-semibold text-amber-900">꺼짐</span>}</>
        : <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">장비 이름(정책 groupId)</span>
          <input name="deviceId" aria-label="장비 이름" placeholder="예: m3-gptoss" maxLength={120} disabled={readOnly} className="w-56 rounded border border-line bg-bg px-2 py-1 font-mono" /></label>}
      <input type="hidden" name="expectedVersion" value={device?.version ?? ""} />
    </div>
    {device?.issues.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">{text}</p>)}
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <NumberField name="limitSlots" label="칸 수" value={num(settings.limitSlots)} defaultValue={num(defaults.limitSlots)} unit="칸" readOnly={readOnly}
        note="장비가 동시에 처리하는 호출 수(1~256). 낮추면 새 입장만 막힙니다" placeholder="필수" />
      <NumberField name="secondaryCap" label="낮은 순위 평소 상한" value={num(settings.secondaryCap)} defaultValue={num(defaults.secondaryCap)} unit="칸" readOnly={readOnly}
        note="우선 역할이 바쁠 때 2 이상 역할 합계 상한(0~칸 수). 칸 수와 같으면 우선순위가 없던 때와 같습니다" placeholder="필수" />
      <NumberField name="idleSeconds" label="유휴 판정 시간" value={idleToInput(settings.idleMs)} defaultValue={idleToInput(defaults.idleMs)} unit="초" readOnly={readOnly}
        note="우선 역할의 마지막 행 갱신 뒤 이 시간이 지나면 유휴로 봅니다(0~3600)" />
      <NumberField name="reserveSlots" label="항상 비워 둘 칸" value={num(settings.reserveSlots)} defaultValue={num(defaults.reserveSlots)} unit="칸" readOnly={readOnly}
        note="빌려 쓰는 중에도 우선 역할용으로 남겨 두는 칸(칸 수 미만)" />
      <NumberField name="physicalLimit" label="엔진 실제 동시 처리 수" value={num(settings.physicalLimit)} defaultValue="" unit="칸" readOnly={readOnly}
        note="운영자가 적는 엔진의 실제 동시 처리 수(선택). 적으면 칸 수가 이를 넘을 수 없습니다" placeholder="없음" />
      <label className="grid gap-0.5 text-[13px] sm:col-span-2 lg:col-span-1"><span className="font-semibold text-fg-2">메모</span>
        <input name="note" defaultValue={settings.note ?? ""} maxLength={400} aria-label="메모" disabled={readOnly} className="rounded border border-line bg-bg px-2 py-1" /></label>
    </div>
    <RolesEditor roles={device?.roles ?? []} readOnly={readOnly} extraRows={device ? 1 : 3} />
    <div className="flex flex-wrap items-center gap-3">
      <button type="submit" disabled={pending || readOnly} className="rounded bg-fg px-3 py-2 text-bg disabled:opacity-50">{pending ? "저장 중…" : device ? "이 장비 저장" : "새 장비 만들기"}</button>
      <span className="text-[13px] text-fg-3">저장 즉시 다음 입장 판정부터 — DRAIN 불필요</span>
      {readOnly && <span className="text-[13px] text-fg-3">장비 행을 읽지 못해 읽기 전용입니다.</span>}
    </div>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">저장 거절 — {text}</p>)}
  </form>;
}
