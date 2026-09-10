'use client';

import { useActionState } from 'react';
import { requeueResolved } from './actions';
import type { RequeueState } from './contract';

/**
 * 지금 기준으로는 보류가 아닌 후보를 규칙 판정으로 되돌린다.
 *
 * 지우거나 대신 결정하지 않는다 — 규칙이 다시 가르도록 큐에 올려놓을 뿐이라, 결과는
 * 승인이나 거부로 규칙이 정한다. 사람이 볼 필요가 없는 것을 큐에서 걷어내는 일이다.
 */
export function RequeueResolved({ count }: { count: number }) {
  const [state, action, pending] = useActionState<RequeueState, FormData>(() => requeueResolved(), null);

  return (
    <form action={action} className="mt-3 rounded-[12px] border border-line bg-bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-[13px] leading-[1.7] text-fg-2">
          <b className="font-semibold text-fg">{count.toLocaleString('ko-KR')}건</b>은 판정한 뒤 시간이 지났거나
          기준이 바뀌어, 지금 규칙으로는 승인이나 거부로 갈립니다. 사람이 볼 필요가 없습니다.
        </p>
        <button type="submit" disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-[13px] font-bold text-white disabled:opacity-50">
          {pending ? '되돌리는 중' : '규칙 판정으로 되돌리기'}
        </button>
      </div>
      <p className="mt-2 text-[13px] text-fg-3">
        후보를 지우지 않습니다. 상태만 판정 대기로 되돌리면 다음 판정 틱에 규칙이 다시 가릅니다.
      </p>

      <div aria-live="polite" className="mt-2">
        {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
        {typeof state?.ok === 'number' && (
          <>
            <p className="text-[13px] text-fg-2">
              <b className="font-semibold text-up">{state.ok.toLocaleString('ko-KR')}건을 판정 대기로 되돌렸습니다.</b>
              {' '}{state.scanned?.toLocaleString('ko-KR')}건을 확인했습니다.
            </p>
            {state.byReason?.length ? (
              <p className="mt-1 font-mono text-[13px] text-fg-3">
                {state.byReason.map((row) => `${row.reason} ${row.count}`).join(' · ')}
              </p>
            ) : null}
          </>
        )}
      </div>
    </form>
  );
}
