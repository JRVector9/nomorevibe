'use client';

import { useActionState } from 'react';
import { switchSecondVoter } from './actions';
import { voterValue, type VoterChoice } from './voters';

/**
 * 2차 표 빠른 전환 — 지금 누가 2차를 보는지 접힌 한 줄로 보이고, 펼치면 바로 바꾼다.
 * 최근 1시간 호출·실패는 바로 아래 상태 칩(2차 투표)이 보인다.
 */
export function SecondVoterSwitch({ current, choices, gatewayReachable }: {
  current: { provider: string; model: string } | null; choices: VoterChoice[]; gatewayReachable: boolean;
}) {
  const [state, action, pending] = useActionState(switchSecondVoter, null);
  const groups = [...new Set(choices.map((choice) => choice.group))];
  const now = current ? voterValue(current.provider as VoterChoice['provider'], current.model) : '';
  return (
    <details className="rounded-lg border border-line bg-bg-card px-3 py-1.5 text-[13px]">
      <summary className="cursor-pointer font-semibold text-fg-2">
        2차 표 · <span className="font-mono text-accent">{current?.model ?? '없음'}</span>
      </summary>
      <p className="mt-2 text-[13px] leading-relaxed text-fg-2">
        Grok 한도가 바닥나거나 게이트웨이 모델이 내려가면 여기서 바꿉니다. 바꾸면 옛 모델의 대기 표는 닫히고 다음 2차 잡(1분 안)부터 새 모델이 봅니다.
        실패 대체 모델과 기준값은 그대로입니다.
      </p>
      {!gatewayReachable && <p className="mt-2 text-[13px] text-warn">게이트웨이 모델 목록을 읽지 못했습니다 — Grok·Claude 만 고를 수 있습니다.</p>}
      <form action={action} className="my-2 flex flex-wrap items-end gap-3">
        <label className="min-w-[260px] flex-1 text-[13px] text-fg-2">모델
          <select name="voter" defaultValue={now} className="mt-1 block w-full rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono">
            {groups.map((group) => (
              <optgroup key={group} label={group}>
                {choices.filter((choice) => choice.group === group).map((choice) => (
                  <option key={choice.value} value={choice.value} disabled={Boolean(choice.disabled)}>
                    {choice.label}{choice.disabled ? ` — ${choice.disabled}` : ''}{choice.value === now ? ' · 지금' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <button disabled={pending} className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold disabled:opacity-50">바꾸기</button>
      </form>
      {state && <p role="status" className={`mt-2 text-[13px] ${state.error ? 'text-down' : 'text-up'}`}>{state.error ?? state.message}</p>}
    </details>
  );
}
