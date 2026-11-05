"use client";

import { useActionState, useState } from "react";
import type { DeviceView } from "@/lib/operations/admin-capacity-devices";
import type { EngineLimitIdentity } from "@/lib/operations/admin-engine-limits";
import { modelPickerConnectionLabel, modelPickerModelLabel } from "../model-picker-display";
import { saveCapacityDevice, type DeviceSaveState } from "./actions";

/** The same group-wide maximum is shared across review, writing and every other mapped route. */
export function SharedLimitForm({ device, engine, policyHash, readOnly }: {
  device: DeviceView; engine: EngineLimitIdentity; policyHash: string; readOnly?: boolean;
}) {
  const [state, action, pending] = useActionState<DeviceSaveState, FormData>(saveCapacityDevice, null);
  const [dirty, setDirty] = useState(false);
  const names = [...new Set(engine.connections.map(connection => modelPickerConnectionLabel(connection)))];
  const models = [...new Set(engine.models.map(model => {
    const connection = engine.connections.find(connection => connection.models?.some(entry => entry.id === model));
    return connection ? modelPickerModelLabel(connection, model) : model;
  }))];
  const active = device.live?.active, limit = device.live?.limitSlots ?? device.settings.limitSlots;
  return <form action={action} data-dirty={dirty || undefined} onChange={() => setDirty(true)}
    className="grid min-w-0 gap-4 rounded-xl border border-line bg-bg-card p-5" aria-label={`${names.join(" · ")} 공유 한도`}>
    <input type="hidden" name="formMode" value="shared-limit" />
    <input type="hidden" name="deviceId" value={device.deviceId} />
    <input type="hidden" name="expectedVersion" value={device.version ?? ""} />
    <input type="hidden" name="policyHash" value={policyHash} />
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-1">
        <h3 className="break-words text-[19px] font-semibold">{names.join(" · ")}</h3>
        <p className="break-all text-[15px] text-fg-2">{models.join(" · ")}</p>
        {engine.connections.map(connection => <p key={connection.id} className="break-all text-[13px] text-fg-3">{connection.baseUrl ?? "등록된 CLI 연결"}</p>)}
      </div>
      <p className="text-[13px] text-fg-3">현재 예약·실행 <strong className="text-[19px] text-fg">{active ?? "미확인"}</strong> / {limit ?? "미설정"}
        {device.live && <> · 대기 {device.live.waiting}</>}</p>
    </header>
    <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <label className="grid gap-1 text-[15px]">
        <span className="font-semibold">공유 최대 동시 실행</span>
        <span className="flex items-center gap-2"><input name="limitSlots" type="number" min={1} max={256} step={1} required
          defaultValue={device.settings.limitSlots ?? ""} disabled={readOnly || pending} aria-label={`${names.join(" · ")} 공유 최대 동시 실행`}
          className="w-24 rounded border border-line bg-bg px-3 py-2 text-right text-[21px] font-semibold tabular-nums" />건</span>
        <span className="text-[13px] text-fg-3">저장된 운영 한도 {device.settings.limitSlots ?? "없음"}건 · 엔진 최대치 {device.settings.physicalLimit ?? "미설정"}</span>
      </label>
      <button disabled={pending || readOnly} className="rounded bg-fg px-4 py-2 text-[15px] font-semibold text-bg disabled:opacity-50">
        {pending ? "저장 중…" : "공유 한도 저장"}
      </button>
    </div>
    <div className="grid gap-1 text-[13px] text-fg-3">
      <p>단계마다 각각 배정하는 수가 아닙니다. 아래 작업의 예약·실행을 모두 합쳐 이 한도 안에서 처리합니다.</p>
      <p className="text-fg-2">함께 쓰는 작업: {device.roles.filter(role => role.inPolicy).map(role => role.label).join(" · ") || engine.routes.join(" · ")}</p>
      <p>이 값은 운영 한도와 엔진 최대치에 함께 저장됩니다. 낮은 순위 상한·비워 둘 수가 새 한도를 넘으면 그 범위까지만 낮춥니다. 역할 순서·유휴 시간은 유지합니다.</p>
      <p>낮춰도 진행 중 호출은 끝까지 받으며, 다음 입장부터 적용합니다. <a href={`#device-${device.deviceId}`} onClick={() => {
        const details = document.getElementById(`device-${device.deviceId}`)?.closest("details");
        if (details) details.open = true;
      }} className="font-semibold text-accent-ink underline">세부 설정 →</a></p>
    </div>
    {state?.ok && <p role="status" className="text-[15px]">{state.message}</p>}
    {state?.issues?.map(issue => <p key={issue} role="alert" className="text-[15px] text-red-600">{issue}</p>)}
  </form>;
}
