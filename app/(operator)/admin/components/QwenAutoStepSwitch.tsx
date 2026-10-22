'use client';

import { useState } from 'react';
import { saveQwenAutoStep } from '../qwen-auto-actions';
import { ConfirmAction } from './ConfirmAction';
import { resultToast, useAdminToast } from './Toast';

type StepValue = { enabled: boolean; perTick: number } & Record<string, unknown>;
/** 틱당 수 말고 더 받는 정수 칸 하나(갈림 판가름의 하루 자동 거부 상한 등) — 이름은 설정 칸 이름이다 */
type ExtraField = { name: string; label: string; unit: string; min: number; max: number };
/** 고르는 칸(감사 두 번째 의견의 묻는 범위 등) — widens 로 바꾸는 것은 넓히는 바꿈이다(서버 qwenAutoWidens 와 같다) */
type ChoiceField = { name: string; label: string; options: { value: string; label: string }[]; widens: string };
/** 켜고 끄는 칸(감사 두 번째 의견의 답으로 닫기 등) — 켜는 것은 넓히는 바꿈이다 */
type ToggleField = { name: string; label: string };

/**
 * Qwen-v2 자동 단계 하나의 켬/끔·틱당 수(settings qwenAuto — 기본 꺼짐). 값은 이 칸이 쥐고 있다가 저장을 누르면 확인 창이 지금 → 바꿀 값을
 * 보인다. 켜는 바꿈은 사유를 꼭 받는다(서버 setQwenAutoStep 도 같은 규칙). 화면이 본 값을 함께 보내 그 사이 바뀌었으면 거절된다.
 * 고친 값이 있는 동안은 자동 갱신을 멈춘다(data-dirty).
 */
export function QwenAutoStepSwitch({ step, value, title, maxPerTick, enableNotes, extra, choices = [], toggles = [] }: {
  step: 'auditSecondOpinion' | 'publishedFilter' | 'splitTiebreak';
  value: StepValue; title: string; maxPerTick: number;
  /** 켤 때(또는 켜 둔 채 넓힐 때) 확인 창에 보일 줄 — 무엇을 사람 없이 정하는지 */
  enableNotes: string[];
  extra?: ExtraField;
  choices?: ChoiceField[];
  toggles?: ToggleField[];
}) {
  const toast = useAdminToast();
  const [enabled, setEnabled] = useState(value.enabled);
  const [perTick, setPerTick] = useState(String(value.perTick));
  const extraValue = extra ? Number(value[extra.name]) : Number.NaN;
  const [extraText, setExtraText] = useState(extra ? String(extraValue) : '');
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(choices.map((choice) => [choice.name, String(value[choice.name])])));
  const [toggled, setToggled] = useState<Record<string, boolean>>(() => Object.fromEntries(toggles.map((toggle) => [toggle.name, value[toggle.name] === true])));
  const count = /^\d{1,3}$/.test(perTick) ? Number(perTick) : Number.NaN;
  const extraCount = extra && /^\d{1,3}$/.test(extraText) ? Number(extraText) : Number.NaN;
  const extraValid = !extra || (Number.isInteger(extraCount) && extraCount >= extra.min && extraCount <= extra.max);
  const valid = Number.isInteger(count) && count >= 1 && count <= maxPerTick && extraValid;
  // 화면에 없는 칸은 지금 값 그대로 보낸다 — 서버가 단계 값 전체를 compare-and-set 한다
  const next: StepValue = { ...value, enabled, perTick: count, ...(extra ? { [extra.name]: extraCount } : {}), ...picked, ...toggled };
  const extraChanged = Boolean(extra && extraCount !== extraValue);
  const choiceChanged = choices.filter((choice) => picked[choice.name] !== String(value[choice.name]));
  const toggleChanged = toggles.filter((toggle) => toggled[toggle.name] !== (value[toggle.name] === true));
  const changed = valid && (next.enabled !== value.enabled || next.perTick !== value.perTick || extraChanged || choiceChanged.length > 0 || toggleChanged.length > 0);
  const enabling = enabled && !value.enabled;
  // 켜 둔 채 범위를 넓히거나 답으로 닫기를 켜는 것도 넓히는 바꿈이다 — 서버(qwenAutoWidens)와 같다
  const widerFields = choiceChanged.some((choice) => picked[choice.name] === choice.widens) || toggleChanged.some((toggle) => toggled[toggle.name]);
  // 켜 둔 채 틱당 수·상한을 올리는 것도 넓히는 바꿈이다 — 서버(setQwenAutoStep)와 같이 까닭을 꼭 받는다
  const widening = enabling || (enabled && value.enabled && (count > value.perTick || Boolean(extra && extraCount > extraValue) || widerFields));
  const optionLabel = (choice: ChoiceField, raw: unknown) => choice.options.find((option) => option.value === String(raw))?.label ?? String(raw);
  const edited = !valid || changed;
  const onOff = (on: boolean) => (on ? '켬' : '끔');
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-fg-2" data-dirty={edited || undefined}>
      <label className="flex min-h-10 items-center gap-2">
        <input type="checkbox" name={`${step}-enabled`} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-accent" />
        <b className="font-semibold">{title}</b>
      </label>
      <label className="flex min-h-10 items-center gap-2">
        틱마다
        <input type="number" name={`${step}-perTick`} min={1} max={maxPerTick} step={1} value={perTick} onChange={(event) => setPerTick(event.target.value)}
          aria-invalid={!valid} aria-label={`${title} 틱당 수`} data-dirty={perTick !== String(value.perTick) || undefined}
          className="w-[4.5rem] rounded-lg border border-line bg-bg-soft px-2 py-1.5 font-mono text-[13px]" />
        건
      </label>
      {extra && <label className="flex min-h-10 items-center gap-2">
        {extra.label}
        <input type="number" name={`${step}-${extra.name}`} min={extra.min} max={extra.max} step={1} value={extraText}
          onChange={(event) => setExtraText(event.target.value)} aria-invalid={!extraValid} aria-label={`${title} ${extra.label}`}
          data-dirty={extraText !== String(extraValue) || undefined}
          className="w-[4.5rem] rounded-lg border border-line bg-bg-soft px-2 py-1.5 font-mono text-[13px]" />
        {extra.unit}
      </label>}
      {choices.map((choice) => <label key={choice.name} className="flex min-h-10 items-center gap-2">
        {choice.label}
        <select name={`${step}-${choice.name}`} value={picked[choice.name]} onChange={(event) => setPicked({ ...picked, [choice.name]: event.target.value })}
          aria-label={`${title} ${choice.label}`} data-dirty={picked[choice.name] !== String(value[choice.name]) || undefined}
          className="rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]">
          {choice.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>)}
      {toggles.map((toggle) => <label key={toggle.name} className="flex min-h-10 items-center gap-2">
        <input type="checkbox" name={`${step}-${toggle.name}`} checked={toggled[toggle.name]} onChange={(event) => setToggled({ ...toggled, [toggle.name]: event.target.checked })}
          data-dirty={toggled[toggle.name] !== (value[toggle.name] === true) || undefined} className="size-4 accent-accent" />
        {toggle.label}
      </label>)}
      {!valid && <span className="text-down">{extraValid ? `틱마다 수는 1~${maxPerTick} 사이의 정수로 적어 주세요.`
        : `${extra!.label}은(는) ${extra!.min}~${extra!.max} 사이의 정수로 적어 주세요.`}</span>}
      <ConfirmAction tone={enabling ? 'danger' : 'neutral'} title={enabling ? `${title}을(를) 켭니다 — 사람 없이 정하는 일이 시작됩니다` : `${title} 설정을 바꿉니다`}
        confirmLabel={enabling ? '켜기' : '저장'}
        summary={<ul>
          {value.enabled !== next.enabled && <li>{onOff(value.enabled)} → {onOff(next.enabled)}</li>}
          {value.perTick !== next.perTick && <li>틱마다 {value.perTick}건 → {next.perTick}건</li>}
          {extra && extraChanged && <li>{extra.label} {extraValue}{extra.unit} → {extraCount}{extra.unit}</li>}
          {choiceChanged.map((choice) => <li key={choice.name}>{choice.label} {optionLabel(choice, value[choice.name])} → {optionLabel(choice, picked[choice.name])}</li>)}
          {toggleChanged.map((toggle) => <li key={toggle.name}>{toggle.label} {onOff(value[toggle.name] === true)} → {onOff(toggled[toggle.name])}</li>)}
          {(enabling || (enabled && value.enabled && widerFields)) && enableNotes.map((line) => <li key={line}>{line}</li>)}
          {!next.enabled && value.enabled && <li>끄면 다음 쓰기부터 멈춥니다 — 받는 중인 답도 반영하지 않습니다.</li>}
        </ul>}
        note={{ label: enabling ? '왜 켜는지 (꼭 적어 주세요 · 작업 로그에 남습니다)' : widening ? '왜 넓히는지 (꼭 적어 주세요 · 작업 로그에 남습니다)'
          : '바꾸는 까닭 (선택 · 작업 로그에 남습니다)', optional: !widening, maxLength: 500 }}
        onConfirm={async ({ note }) => {
          const form = new FormData();
          form.set('step', step);
          form.set('next', JSON.stringify(next));
          form.set('expected', JSON.stringify(value));
          form.set('reason', note ?? '');
          const result = await saveQwenAutoStep(null, form);
          if (result && !result.error) toast.show(resultToast(result, { message: result.message ?? '저장했습니다' }));
          return result;
        }}
        trigger={(open) => <button type="button" onClick={open} disabled={!changed}
          className="min-h-10 rounded-lg border border-line px-3 py-1.5 font-semibold disabled:opacity-50">저장…</button>} />
    </div>
  );
}
