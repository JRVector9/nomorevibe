'use client';

import { startTransition, useActionState, useState } from 'react';
import { resultToast, useAdminToast } from '../components/Toast';
import { switchSecondVoter, type ReviewActionState } from './actions';
import { voterValue, type VoterChoice } from './voters';

/**
 * 2차 표 빠른 전환 — 크롤 설정 2차 심사 칸(/admin#second)에서 저장 없이 바로 바꾼다(2026-10-08 UX 감사 ADM-24).
 *
 * 크롤 설정 폼 안에 그려지므로 <form> 도 name 도 쓰지 않는다 — 고른 값은 상태로 들고 액션에 FormData 로 넘긴다.
 * 바로 바꾸면 아래 "다시 볼 모델" 칸은 옛 값을 보인 채라, 폼을 저장하면 "그 사이 바뀌었다"로 거절된다(덮어쓰지 않는다).
 */
export function SecondVoterSwitch({ current, choices, gatewayReachable }: {
  current: { provider: string; model: string } | null; choices: VoterChoice[]; gatewayReachable: boolean;
}) {
  const toast = useAdminToast();
  const [state, action, pending] = useActionState(async (previous: ReviewActionState, form: FormData) => {
    const result = await switchSecondVoter(previous, form);
    toast.show(resultToast(result));
    return result;
  }, null);
  const groups = [...new Set(choices.map((choice) => choice.group))];
  const now = current ? voterValue(current.provider as VoterChoice['provider'], current.model) : '';
  const [voter, setVoter] = useState(now);
  const submit = () => {
    const form = new FormData();
    form.set('voter', voter);
    startTransition(() => action(form));
  };
  return (
    <div role="group" aria-labelledby="second-voter-title" className="flex flex-col gap-2 rounded-[10px] border border-line px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span id="second-voter-title" className="text-[14px] font-semibold">2차 표 바로 바꾸기</span>
        <span className="font-mono text-accent-ink">{current?.model ?? '없음'}</span>
        <span className="text-fg-3">저장 없이 바로 바뀝니다</span>
      </div>
      <p className="leading-relaxed text-fg-2">
        Grok 한도가 바닥나거나 게이트웨이 모델이 내려가면 여기서 바꿉니다. 바꾸면 옛 모델의 대기 표는 닫히고 다음 2차 잡(1분 안)부터 새 모델이 봅니다.
        실패 대체 모델과 기준값은 그대로입니다.
      </p>
      {!gatewayReachable && <p className="text-warn">게이트웨이 모델 목록을 읽지 못했습니다 — Grok·Claude 만 고를 수 있습니다.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[260px] flex-1 text-fg-2">모델
          <select value={voter} onChange={(event) => setVoter(event.target.value)}
            className="mt-1 block w-full rounded-lg border border-line bg-bg-soft px-3 py-2 font-mono text-fg">
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
        <button type="button" disabled={pending || voter === now} onClick={submit}
          className="rounded-lg border border-line px-4 py-2 font-semibold disabled:opacity-50">바꾸기</button>
      </div>
      {state && <p role="status" className={state.error ? 'text-down' : 'text-up'}>{state.error ?? state.message}</p>}
    </div>
  );
}
