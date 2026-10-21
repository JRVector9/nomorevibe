'use client';

import { useState } from 'react';
import { saveQwenAutoStep } from '../qwen-auto-actions';
import { ConfirmAction } from './ConfirmAction';
import { resultToast, useAdminToast } from './Toast';

type StepValue = { enabled: boolean; perTick: number };

/**
 * Qwen-v2 자동 단계 하나의 켬/끔·틱당 수(settings qwenAuto — 기본 꺼짐). 값은 이 칸이 쥐고 있다가 저장을 누르면 확인 창이 지금 → 바꿀 값을
 * 보인다. 켜는 바꿈은 사유를 꼭 받는다(서버 setQwenAutoStep 도 같은 규칙). 화면이 본 값을 함께 보내 그 사이 바뀌었으면 거절된다.
 * 고친 값이 있는 동안은 자동 갱신을 멈춘다(data-dirty).
 */
export function QwenAutoStepSwitch({ step, value, title, maxPerTick, enableNotes }: {
  step: 'auditSecondOpinion' | 'publishedFilter' | 'splitTiebreak';
  value: StepValue; title: string; maxPerTick: number;
  /** 켤 때 확인 창에 보일 줄 — 무엇을 사람 없이 정하는지 */
  enableNotes: string[];
}) {
  const toast = useAdminToast();
  const [enabled, setEnabled] = useState(value.enabled);
  const [perTick, setPerTick] = useState(String(value.perTick));
  const count = /^\d{1,3}$/.test(perTick) ? Number(perTick) : Number.NaN;
  const valid = Number.isInteger(count) && count >= 1 && count <= maxPerTick;
  const next = { enabled, perTick: count };
  const changed = valid && (next.enabled !== value.enabled || next.perTick !== value.perTick);
  const enabling = enabled && !value.enabled;
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
      {!valid && <span className="text-down">틱마다 수는 1~{maxPerTick} 사이의 정수로 적어 주세요.</span>}
      <ConfirmAction tone={enabling ? 'danger' : 'neutral'} title={enabling ? `${title}을(를) 켭니다 — 사람 없이 정하는 일이 시작됩니다` : `${title} 설정을 바꿉니다`}
        confirmLabel={enabling ? '켜기' : '저장'}
        summary={<ul>
          {value.enabled !== next.enabled && <li>{onOff(value.enabled)} → {onOff(next.enabled)}</li>}
          {value.perTick !== next.perTick && <li>틱마다 {value.perTick}건 → {next.perTick}건</li>}
          {enabling && enableNotes.map((line) => <li key={line}>{line}</li>)}
          {!next.enabled && value.enabled && <li>끄면 다음 쓰기부터 멈춥니다 — 받는 중인 답도 반영하지 않습니다.</li>}
        </ul>}
        note={{ label: enabling ? '왜 켜는지 (꼭 적어 주세요 · 작업 로그에 남습니다)' : '바꾸는 까닭 (선택 · 작업 로그에 남습니다)', optional: !enabling, maxLength: 500 }}
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
