"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
// 형만 가져온다 — 그 모듈들은 서버 모듈(DB·node:crypto)이라 클라이언트 묶음에 들면 안 된다(helpers/HelperForm 과 같은 규칙)
import type { AssignmentStage, AssignmentTransport } from "@/lib/llm/capacity-helpers";
import type { AssignmentFormOptions, AssignmentPrefill } from "@/lib/operations/admin-model-assignments";
import { saveModelAssignmentAction, type AssignmentActionState } from "./actions";

const SELECT = "rounded border border-line bg-bg px-2 py-1 text-[13px]";
const LABEL = "grid gap-0.5 text-[13px]";
const CAPTION = "font-semibold text-fg-2";
/** 저장된 배정을 고칠 때 폼에 넣는 값(서버 화면 모형이 만든다) */
export type AssignmentFormValues = { assignmentId: string; version: number; stage: AssignmentStage; deviceId: string; registryKey: string;
  transport: AssignmentTransport; rank: number; vote: boolean; mode: "off" | "live"; maxSlots: number; note: string | null };

/**
 * 배정 하나 만들기·고치기 폼. 고를 수 있는 것은 서버가 만든 options 그대로다: 단계 → (그 단계가 허락하는 전송을 하나라도 쓰는) 등록부 모델 →
 * (단계 × 모델 공급자 × cli 는 connect 장비만) 전송. 표(투표)는 2차 검수 순위 1 에서만, 모드는 꺼짐·실전, 실전 저장은 확인 「배정」.
 * 숨은 expectedVersion 이 CAS 다. 도우미 역할을 고르면 도우미 화면으로 보낸다(이 폼은 주 배정만 저장한다).
 */
export function AssignmentForm({ options, initial, prefill = {}, readOnly }: { options: AssignmentFormOptions; initial: AssignmentFormValues | null;
  prefill?: AssignmentPrefill; readOnly?: boolean }) {
  const [state, action, pending] = useActionState<AssignmentActionState, FormData>(saveModelAssignmentAction, null);
  const openStages = options.stages.filter(stage => !stage.reserved);
  const [stage, setStage] = useState<AssignmentStage>(initial?.stage ?? prefill.stage ?? openStages[0]?.id ?? "ai1");
  const [deviceId, setDeviceId] = useState(initial?.deviceId ?? prefill.deviceId ?? options.devices.find(device => device.enabled)?.id ?? "");
  const [registryKey, setRegistryKey] = useState(initial?.registryKey ?? prefill.registryKey ?? "");
  const [transport, setTransport] = useState<string>(initial?.transport ?? prefill.transport ?? "");
  const [rank, setRank] = useState(String(initial?.rank ?? 1));
  const [role, setRole] = useState<"primary" | "helper">("primary");
  const [mode, setMode] = useState<"off" | "live">(initial?.mode ?? "off");
  const [dirty, setDirty] = useState(false);

  const stageOption = options.stages.find(option => option.id === stage);
  const registry = options.registry.filter(entry => (entry.transportsByStage[stage]?.length ?? 0) > 0);
  // 단계를 바꾸면 그 단계에서 못 쓰는 모델·전송은 첫 선택지로 — 효과(effect) 없이 그릴 때 정한다
  const effectiveKey = registry.some(entry => entry.key === registryKey) ? registryKey : registry[0]?.key ?? "";
  const entry = registry.find(option => option.key === effectiveKey);
  const transports = entry?.transportsByStage[stage] ?? [];
  const effectiveTransport = (transports as string[]).includes(transport) ? transport as AssignmentTransport : transports[0] ?? "";
  const wire = entry && effectiveTransport ? entry.wire[effectiveTransport] : undefined;
  const rankNumber = Number(rank);
  const voteAllowed = !!stageOption?.vote && rankNumber === 1;
  const enabledDevices = options.devices.filter(device => device.enabled);
  const derivedId = deviceId && effectiveKey ? `${deviceId}:${stage}:${effectiveKey}` : "";
  const blocked = readOnly || pending || role === "helper" || !effectiveKey || !effectiveTransport || !deviceId;
  const id = initial ? `assignment-edit-${initial.assignmentId}` : "assignment-new";

  return <div id={id} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <div className="flex flex-wrap items-baseline gap-2">
      {initial ? <><h3 className="text-[17px] font-semibold">배정 고치기 · <span className="font-mono">{initial.assignmentId}</span></h3>
        <span className="text-[13px] text-fg-3">판 {initial.version} · 단계·장비는 바꿀 수 없습니다(새 배정을 만들고 이것은 끄세요)</span>
        <Link href="/admin/models/assignments#form" prefetch={false} className="text-[13px] text-accent-ink underline">새 배정으로</Link></>
        : <h3 className="text-[17px] font-semibold">새 배정</h3>}
    </div>
    <form action={action} data-dirty={dirty || undefined} onChange={() => setDirty(true)} className="grid gap-3">
      <input type="hidden" name="expectedVersion" value={initial?.version ?? ""} />
      <input type="hidden" name="maxSlots" value={initial?.maxSlots ?? 1} />
      <input type="hidden" name="registryKey" value={effectiveKey} />
      <input type="hidden" name="transport" value={effectiveTransport} />
      {initial && <><input type="hidden" name="assignmentId" value={initial.assignmentId} /><input type="hidden" name="stage" value={initial.stage} />
        <input type="hidden" name="deviceId" value={initial.deviceId} /></>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={LABEL}><span className={CAPTION}>단계</span>
          <select aria-label="단계" name={initial ? undefined : "stage"} value={stage} disabled={readOnly || !!initial}
            onChange={event => setStage(event.target.value as AssignmentStage)} className={SELECT}>
            {options.stages.map(option => <option key={option.id} value={option.id} disabled={option.reserved}>
              {option.label}{option.reserved ? " (예약)" : ""}</option>)}</select>
          {stageOption?.routeId && <span className="font-mono text-fg-3">{stageOption.routeId}</span>}</label>
        <label className={LABEL}><span className={CAPTION}>장비</span>
          <select aria-label="장비" name={initial ? undefined : "deviceId"} value={deviceId} disabled={readOnly || !!initial}
            onChange={event => setDeviceId(event.target.value)} className={SELECT}>
            {!deviceId && <option value="">장비를 고르세요</option>}
            {options.devices.map(device => <option key={device.id} value={device.id} disabled={!device.enabled}>{device.id}{device.enabled ? "" : " (꺼짐)"}</option>)}
          </select>
          {enabledDevices.length === 0 && <span role="note" className="text-amber-700">켜진 장비 행이 없습니다(device_unconfigured) — 장비 한도(/admin/models/devices)에서 먼저 저장하세요.</span>}</label>
        <label className={LABEL}><span className={CAPTION}>모델(등록부)</span>
          <select aria-label="모델(등록부)" value={effectiveKey} disabled={readOnly} onChange={event => setRegistryKey(event.target.value)} className={SELECT}>
            {registry.length === 0 && <option value="">이 단계에 쓸 수 있는 모델이 없습니다</option>}
            {registry.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
          {wire && <span className="text-fg-3">wire 모델 <code className="break-all">{wire}</code></span>}</label>
        <label className={LABEL}><span className={CAPTION}>전송</span>
          <select aria-label="전송" value={effectiveTransport} disabled={readOnly} onChange={event => setTransport(event.target.value)} className={SELECT}>
            {transports.length === 0 && <option value="">없음</option>}
            {transports.map(option => <option key={option} value={option}>{options.transportLabels[option]}</option>)}</select>
          <span className="text-fg-3">CLI 는 connect 장비 모델만 · 단계가 허락한 전송만. 장비 표지는 요청 이름 앞의 대괄호입니다. 텍스트 경로는 「모델 연결」의 직접 연결 계약만 열립니다.</span></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={LABEL}><span className={CAPTION}>순위</span>
          <input name="rank" type="number" min={1} max={options.rankMax} step={1} inputMode="numeric" value={rank} disabled={readOnly}
            onChange={event => setRank(event.target.value)} aria-label="순위" className={`${SELECT} w-24 text-right tabular-nums`} />
          <span className="text-fg-3">1~{options.rankMax} · 1 이 먼저 · 장비 역할 순위도 이 값으로 맞춥니다</span></label>
        <fieldset className={LABEL}><legend className={CAPTION}>역할</legend>
          <span className="flex flex-wrap gap-3">
            <label className="flex items-center gap-1"><input type="radio" name="role" value="primary" checked={role === "primary"} disabled={readOnly || !!initial}
              onChange={() => setRole("primary")} />주 배정</label>
            <label className="flex items-center gap-1"><input type="radio" name="role" value="helper" checked={role === "helper"} disabled={readOnly || !!initial}
              onChange={() => setRole("helper")} />도우미</label>
          </span>
          {role === "helper" && <span role="note" className="text-amber-700">도우미는 「도우미 장비」 화면에서 만들고 임계값·섀도·승격을 정합니다 —
            {" "}<Link href="/admin/models/helpers#new" prefetch={false} className="font-semibold underline">도우미 장비로 →</Link></span>}</fieldset>
        {stageOption?.vote && <label className={LABEL}><span className={CAPTION}>표(투표)</span>
          <span className="flex items-center gap-1"><input type="checkbox" name="vote" defaultChecked={initial?.vote ?? false} disabled={readOnly || !voteAllowed}
            aria-label="표(투표)" />2차 투표자로 세운다</span>
          <span className="text-fg-3">{voteAllowed ? "순위 1 배정만 표를 냅니다" : "순위 1 일 때만 켤 수 있습니다"}</span></label>}
        <label className={LABEL}><span className={CAPTION}>모드</span>
          <select name="mode" aria-label="모드" value={mode} disabled={readOnly || role === "helper"} onChange={event => setMode(event.target.value as "off" | "live")} className={SELECT}>
            <option value="off">꺼짐</option><option value="live">실전</option></select>
          <span className="text-fg-3">섀도는 도우미에만 있습니다</span></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {!initial && <label className={LABEL}><span className={CAPTION}>배정 이름</span>
          <input name="assignmentId" maxLength={120} placeholder={derivedId || "<장비>:<단계>:<등록부 key>"} disabled={readOnly} aria-label="배정 이름"
            className={`${SELECT} font-mono`} />
          <span className="text-fg-3">비우면 {derivedId ? <code>{derivedId}</code> : "<장비>:<단계>:<등록부 key>"} · 소문자·숫자·&apos;:&apos;·&apos;-&apos;</span></label>}
        <label className={LABEL}><span className={CAPTION}>메모</span>
          <input name="note" defaultValue={initial?.note ?? ""} maxLength={400} disabled={readOnly} aria-label="메모" className={SELECT} /></label>
      </div>
      {mode === "live" && <label className={LABEL}><span className={CAPTION}>확인 — 「{options.confirmWord}」 을 적으세요</span>
        <input name="confirm" autoComplete="off" placeholder={options.confirmWord} disabled={readOnly} aria-label="확인" className={`${SELECT} w-40`} />
        <span className="text-fg-3">실전으로 저장하면 플래그가 켜진 뒤 이 배정을 바로 고릅니다. 저장 때 계약을 확인하고 없으면 엔진에 readback·1토큰 시험을 보냅니다.</span></label>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={blocked} className="rounded bg-fg px-3 py-2 text-bg disabled:opacity-50">
          {pending ? "저장 중… (엔진 확인 포함)" : initial ? "이 배정 저장" : "배정 만들기"}</button>
        <span className="text-[13px] text-fg-3">저장 한 번이 계약 확인 → 정책 경로 덧붙이기(DRAIN 없음) → 장비 역할 순위 → 배정 행 → 감사 한 줄을 한 번에 합니다. 거절되면 아무것도 바뀌지 않습니다.</span>
        {readOnly && <span className="text-[13px] text-fg-3">배정 표를 읽지 못해 읽기 전용입니다.</span>}
      </div>
      {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
      {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">저장 거절 — {text}</p>)}
    </form>
  </div>;
}
