"use client";
import { useActionState, useState } from "react";
// 형만 가져온다 — 그 모듈들은 서버 모듈(DB·node:crypto)이라 클라이언트 묶음에 들면 안 된다(devices/DeviceForm 과 같은 규칙)
import type { HelperStage } from "@/lib/llm/capacity-helpers";
import type { HelperRouteDefaults, HelperRowView, HelperSettingsDefaults } from "@/lib/operations/admin-model-helpers";
import { ConfirmSubmit } from "../ConfirmSubmit";
import { changeModelHelperMode, clearModelHelperStop, saveModelHelper, type HelperActionState } from "./actions";

const INPUT = "w-24 rounded border border-line bg-bg px-2 py-1 text-right tabular-nums";
const TEXT_INPUT = "w-64 rounded border border-line bg-bg px-2 py-1 font-mono";
/** 0~1 비율 → 백분율 글자("95", "0.5") — lib/operations/admin-model-helpers.ts ratioToPercentInput 과 같은 규칙 */
export const ratioToPercentText = (ratio: number): string => String(Math.round(ratio * 1000) / 10);
/** ms → 초 글자("120", "1.5") — lib 의 msToSecondsInput 과 같은 규칙 */
export const msToSecondsText = (ms: number): string => String(Math.round(ms) / 1000);
const STAGES: readonly { value: HelperStage; label: string }[] = [{ value: "ai1", label: "1차 검수" }, { value: "ai2", label: "2차 검수" }];

type NumberSpec = { name: string; label: string; unit: string; note: string };
/** 정수 칸(이름 = 저장 칸) */
const INT_SPECS: readonly (NumberSpec & { field: "maxSlots" | "perTick" | "shadowPerHour" | "minShadowSamples" | "enterSamples" | "exitSamples" })[] = [
  { field: "maxSlots", name: "maxSlots", label: "최대 칸", unit: "칸", note: "이 도우미가 동시에 쓰는 칸(1~256). 장비 한도의 낮은 순위 상한도 함께 지킵니다" },
  { field: "perTick", name: "perTick", label: "한 틱 최대 건수", unit: "건", note: "도우미 단계 한 번에 하는 호출 수(1~16, 한 건씩 차례로)" },
  { field: "shadowPerHour", name: "shadowPerHour", label: "시간당 섀도 표본", unit: "건", note: "섀도로 다시 보는 수(0~600). 실전 중에도 이 속도로 품질을 감사합니다" },
  { field: "minShadowSamples", name: "minShadowSamples", label: "승격 최소 표본", unit: "건", note: "실전 승격에 필요한 같은 evidence_key 의 섀도 표본(20~10000)" },
  { field: "enterSamples", name: "enterSamples", label: "들어가는 표본 수", unit: "번", note: "주 장비가 가득 찬 순환이 이만큼 이어지면 돕기 시작(1~20)" },
  { field: "exitSamples", name: "exitSamples", label: "나오는 표본 수", unit: "번", note: "여유 순환이 이만큼 이어지고 최소 유지 시간이 지나면 멈춤(1~40)" },
];
/** 백분율 칸(폼 이름 <비율>Pct, 저장은 0~1) */
const PCT_SPECS: readonly (NumberSpec & { field: "minAgreement" | "maxWrongApproval" | "maxWrongRejection" | "maxUnknownRate" | "maxFailureRate" | "maxLiveDisagreement" })[] = [
  { field: "minAgreement", name: "minAgreementPct", label: "최소 일치율", unit: "%", note: "섀도 결정 쌍 중 주 모델과 같은 비율(50~100)" },
  { field: "maxWrongApproval", name: "maxWrongApprovalPct", label: "잘못 승인 상한", unit: "%", note: "주 모델이 거절한 것을 도우미가 승인한 비율(0~50)" },
  { field: "maxWrongRejection", name: "maxWrongRejectionPct", label: "잘못 거절 상한", unit: "%", note: "주 모델이 승인한 것을 도우미가 거절한 비율(0~50)" },
  { field: "maxUnknownRate", name: "maxUnknownRatePct", label: "확인 못함 비율 상한", unit: "%", note: "넘으면(표본 10 이상) 자동 정지(0~50)" },
  { field: "maxFailureRate", name: "maxFailureRatePct", label: "실패 비율 상한", unit: "%", note: "넘으면(표본 10 이상) 자동 정지(0~90)" },
  { field: "maxLiveDisagreement", name: "maxLiveDisagreementPct", label: "실전 2차 불일치 상한", unit: "%", note: "실전 승인을 2차가 뒤집은 비율 — 넘으면 섀도로 강등(0~90)" },
];
/** 초 칸(폼 이름 …Seconds, 저장은 ms) */
const SEC_SPECS: readonly (NumberSpec & { field: "minHelpMs" | "reenterCooldownMs" })[] = [
  { field: "minHelpMs", name: "minHelpSeconds", label: "최소 유지 시간", unit: "초", note: "돕기 시작한 뒤 최소한 이만큼은 유지(0~3600). 자기 일이 오면 바로 멈춥니다" },
  { field: "reenterCooldownMs", name: "reenterCooldownSeconds", label: "재진입 대기", unit: "초", note: "돕기를 멈춘 뒤 다시 들어가기까지 기다림(0~3600)" },
];

function NumberField({ name, label, value, defaultValue, unit, note, readOnly }: { name: string; label: string; value: string; defaultValue: string; unit: string;
  note: string; readOnly?: boolean }) {
  const overridden = value !== defaultValue;
  return <label className="grid gap-0.5 text-[13px]">
    <span className="font-semibold text-fg-2">{label}</span>
    <span className="flex items-center gap-1">
      <input name={name} defaultValue={value} aria-label={label} title={note} inputMode="decimal" disabled={readOnly} className={INPUT} />
      <span className="text-fg-3">{unit}</span>
      <span className={`rounded-full px-1.5 font-semibold ${overridden ? "bg-amber-100 text-amber-900" : "text-fg-3"}`}>{overridden ? "바꿈" : "기본값"}</span>
    </span>
    <span className="text-fg-3">기본 {defaultValue}{unit} · {note}</span>
  </label>;
}

function TextField({ name, label, value, placeholder, note, readOnly }: { name: string; label: string; value: string; placeholder?: string; note?: string; readOnly?: boolean }) {
  return <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">{label}</span>
    <input name={name} defaultValue={value} aria-label={label} placeholder={placeholder} disabled={readOnly} maxLength={200} className={TEXT_INPUT} />
    {note && <span className="text-fg-3">{note}</span>}</label>;
}

function Result({ state, prefix }: { state: HelperActionState; prefix: string }) {
  return <>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{prefix} — {text}</p>)}
  </>;
}

/**
 * 모드 단추 — 섀도 시작 / 섀도로 내리기 / 끄기 / 자동 정지 해제(= 같은 값으로 다시 저장, 판이 오른다) / 실전으로 올리기(PR 2c 전까지 꺼짐).
 * 숨은 expectedVersion 으로 CAS — 그 사이 저장이 있었으면 거절을 그대로 보인다.
 */
function ModeControls({ helper, readOnly }: { helper: HelperRowView; readOnly?: boolean }) {
  const [modeState, modeAction, modePending] = useActionState<HelperActionState, FormData>(changeModelHelperMode, null);
  const [clearState, clearAction, clearPending] = useActionState<HelperActionState, FormData>(clearModelHelperStop, null);
  const busy = modePending || clearPending || readOnly;
  const button = "rounded border border-line px-3 py-1.5 disabled:opacity-50";
  return <form action={modeAction} className="grid gap-2">
    <input type="hidden" name="assignmentId" value={helper.assignmentId} />
    <input type="hidden" name="expectedVersion" value={helper.version} />
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="font-semibold text-fg-2">모드 {helper.modeLabel}</span>
      {/* 모드 단추도 두 단계 확인(PR 5) — 무엇이 바뀌는지 보이고 「… 확인」으로 보낸다 */}
      {helper.mode === "off" && <ConfirmSubmit label="섀도 시작" confirmLabel="섀도 시작 확인" name="mode" value="shadow" pending={modePending} disabled={busy} className={button}
        changes={[{ label: "모드", before: helper.modeLabel, after: "섀도" }]} summary="섀도 결과는 어떤 판정에도 쓰이지 않습니다." />}
      {helper.mode === "live" && <ConfirmSubmit label="섀도로 내리기" confirmLabel="섀도로 내리기 확인" name="mode" value="shadow" pending={modePending} disabled={busy} className={button}
        changes={[{ label: "모드", before: helper.modeLabel, after: "섀도" }]} summary="이 장비가 실제로 돕지 않고 결과만 남깁니다." />}
      {helper.mode !== "off" && <ConfirmSubmit label="끄기" confirmLabel="끄기 확인" name="mode" value="off" pending={modePending} disabled={busy} className={button}
        changes={[{ label: "모드", before: helper.modeLabel, after: "꺼짐" }]} summary="이 장비가 더는 돕지 않습니다. 우선 역할 일은 그대로입니다." />}
      {helper.stops.length > 0 && <ConfirmSubmit label="자동 정지 해제" confirmLabel="해제 확인" formAction={clearAction} pending={clearPending} disabled={busy} className={`${button} border-red-600 text-red-600`}
        changes={[{ label: "자동 정지", before: `${helper.stops.length}건`, after: "해제" }]} summary="같은 값으로 다시 저장해 판이 오릅니다. 정지 조건이 다시 맞으면 또 멈춥니다." />}
      <button type="button" disabled aria-disabled="true" title="PR 2c 에서 엽니다 — 섀도 근거(같은 evidence_key)·조건 목록·확인 「실전」이 필요합니다" className={button}>실전으로 올리기</button>
      <span className="text-fg-3">실전 승격은 PR 2c 에서 엽니다. 섀도 결과는 어떤 판정에도 쓰이지 않습니다.</span>
    </div>
    <Result state={modeState} prefix="모드 거절" />
    <Result state={clearState} prefix="해제 거절" />
  </form>;
}

/**
 * 배정 한 개 폼(helper 가 null 이면 새 배정). 숨은 expectedVersion 으로 CAS. 있는 배정은 장비·단계·이름·모드를 숨은 값으로 지키고(모드는 단추로만 바꾼다),
 * 모델·경로·임계값·이력·메모를 바꾼다. 모델·경로를 바꾸면 섀도 근거(evidence_key)가 처음부터 시작한다. 새 배정은 단계에 맞는 경로 기본값으로 채운다.
 */
export function HelperForm({ helper, defaults, routeDefaults, readOnly, names }: { helper: HelperRowView | null; defaults: HelperSettingsDefaults;
  routeDefaults: HelperRouteDefaults; readOnly?: boolean; names?: Readonly<Record<string, string>> }) {
  const [state, action, pending] = useActionState<HelperActionState, FormData>(saveModelHelper, null);
  const [dirty, setDirty] = useState(false);
  const [stage, setStage] = useState<HelperStage>(helper?.stage ?? "ai1");
  const values = helper?.settings ?? { ...defaults, ...routeDefaults[stage], assignmentId: "", stage, deviceId: "", model: "" };
  const routes = helper ? { shadowRouteId: helper.settings.shadowRouteId, liveRouteId: helper.settings.liveRouteId, liveProvider: helper.settings.liveProvider } : routeDefaults[stage];
  const id = helper ? `helper-${helper.assignmentId}` : "helper-new";
  return <div id={id} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px] scroll-mt-6">
    <div className="flex flex-wrap items-baseline gap-2">
      {helper ? <><h3 className="text-[17px] font-semibold" title={`장비 id ${helper.deviceId}`}>{names?.[helper.deviceId] ?? helper.deviceId} · {helper.stageLabel}</h3>
        <span className="text-[13px] text-fg-3">배정 <code>{helper.assignmentId}</code> · 판 {helper.version} · evidence <code title={helper.evidenceKey}>{helper.evidenceKey.slice(0, 12)}</code>
          {helper.promotedAt && <> · 승격됨</>}</span></>
        : <h3 className="text-[17px] font-semibold">새 배정</h3>}
    </div>
    {helper?.issues.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">{text}</p>)}
    {helper && <ModeControls helper={helper} readOnly={readOnly} />}
    <form action={action} data-dirty={dirty || undefined} onChange={() => setDirty(true)} className="grid gap-3">
      <input type="hidden" name="expectedVersion" value={helper?.version ?? ""} />
      {helper ? <>
        <input type="hidden" name="assignmentId" value={helper.assignmentId} />
        <input type="hidden" name="stage" value={helper.stage} />
        <input type="hidden" name="deviceId" value={helper.deviceId} />
        <input type="hidden" name="mode" value={helper.mode} />
      </> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">돕는 단계</span>
          <select name="stage" aria-label="돕는 단계" value={stage} disabled={readOnly} onChange={event => setStage(event.target.value as HelperStage)}
            className="rounded border border-line bg-bg px-2 py-1">{STAGES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <TextField name="deviceId" label="도우미 장비" value="" placeholder="예: m3-deepseek" note="장비 한도에 있는 장비 이름(우선 역할이 쉬면 돕는다)" readOnly={readOnly} />
        <TextField name="assignmentId" label="배정 이름" value="" placeholder="비우면 <장비>:<단계>" note="소문자·숫자·':'·'-'" readOnly={readOnly} />
        <label className="grid gap-0.5 text-[13px]"><span className="font-semibold text-fg-2">모드</span>
          <select name="mode" aria-label="모드" defaultValue="off" disabled={readOnly} className="rounded border border-line bg-bg px-2 py-1">
            <option value="off">꺼짐</option><option value="shadow">섀도</option><option value="live" disabled>실전(PR 2c 승격으로만)</option></select>
          <span className="text-fg-3">처음에는 꺼짐으로 만듭니다</span></label>
      </div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" key={helper ? "fixed" : stage}>
        <TextField name="model" label="모델" value={values.model} placeholder="예: deepseek-v4.1-flash-1017" note="계약·wire 모델 이름(참 identity)" readOnly={readOnly} />
        <TextField name="shadowRouteId" label="섀도 경로" value={routes.shadowRouteId} note={`기본 ${routeDefaults[helper?.stage ?? stage].shadowRouteId}`} readOnly={readOnly} />
        <TextField name="liveRouteId" label="실전 경로" value={routes.liveRouteId} note={`기본 ${routeDefaults[helper?.stage ?? stage].liveRouteId}`} readOnly={readOnly} />
        <TextField name="liveProvider" label="실전 공급자" value={routes.liveProvider} note={`기본 ${routeDefaults[helper?.stage ?? stage].liveProvider}`} readOnly={readOnly} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {INT_SPECS.map(spec => <NumberField key={spec.name} name={spec.name} label={spec.label} unit={spec.unit} note={spec.note} readOnly={readOnly}
          value={String(values[spec.field])} defaultValue={String(defaults[spec.field])} />)}
        {PCT_SPECS.map(spec => <NumberField key={spec.name} name={spec.name} label={spec.label} unit={spec.unit} note={spec.note} readOnly={readOnly}
          value={ratioToPercentText(values[spec.field])} defaultValue={ratioToPercentText(defaults[spec.field])} />)}
        {SEC_SPECS.map(spec => <NumberField key={spec.name} name={spec.name} label={spec.label} unit={spec.unit} note={spec.note} readOnly={readOnly}
          value={msToSecondsText(values[spec.field])} defaultValue={msToSecondsText(defaults[spec.field])} />)}
        <label className="grid gap-0.5 text-[13px] sm:col-span-2 lg:col-span-3"><span className="font-semibold text-fg-2">메모</span>
          <input name="note" defaultValue={values.note ?? ""} maxLength={400} aria-label="메모" disabled={readOnly} className="rounded border border-line bg-bg px-2 py-1" /></label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <ConfirmSubmit label={helper ? "이 배정 저장" : "새 배정 만들기"} pending={pending} disabled={readOnly} savedKey={helper?.version ?? null} />
        <span className="text-[13px] text-fg-3">저장하면 판이 오르고(그 판의 자동 정지가 풀립니다) 감시자의 다음 순환부터 새 판으로 판정합니다</span>
        {readOnly && <span className="text-[13px] text-fg-3">도우미 상태를 읽지 못해 읽기 전용입니다.</span>}
      </div>
      <Result state={state} prefix="저장 거절" />
    </form>
  </div>;
}
