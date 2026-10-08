'use client';

import { useActionState } from 'react';
import { requeueResolved } from './actions';
import type { RequeueState } from './contract';

/**
 * 지금 기준으로는 보류가 아닌 후보를 규칙 판정으로 되돌린다.
 *
 * 지우거나 대신 결정하지 않는다 — 규칙이 다시 가르도록 큐에 올려놓을 뿐이라, 결과는
 * 승인이나 거부로 규칙이 정한다. 사람이 볼 필요가 없는 것을 큐에서 걷어내는 일이다.
 * 해당 건이 있을 때만 표 위에 얇은 알림 줄로 선다(2026-10-08 UX 감사 ADM-09).
 */
export function RequeueResolved({ count }: { count: number }) {
  const [state, action, pending] = useActionState<RequeueState, FormData>(() => requeueResolved(), null);

  return (
    <form action={action} role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-bg-card px-3 py-1.5 text-[13px] text-fg-2">
      <span className="min-w-0 flex-1" title="후보를 지우지 않습니다. 상태만 판정 대기로 되돌리면 다음 판정 틱에 규칙이 다시 가릅니다.">
        <b className="font-semibold text-fg">{count.toLocaleString('ko-KR')}건</b>은 지금 규칙으로는 보류가 아닙니다 — 판정한 뒤 시간이 지났거나 기준이 바뀌었습니다.
      </span>
      {state?.error && <span className="text-down">{state.error}</span>}
      {typeof state?.ok === 'number' && (
        <span title={state.byReason?.map((row) => `${row.reason} ${row.count}`).join(' · ')}>
          <b className="font-semibold text-up">{state.ok.toLocaleString('ko-KR')}건을 판정 대기로 되돌렸습니다</b>
          {' '}({state.scanned?.toLocaleString('ko-KR')}건 확인)
        </span>
      )}
      <button type="submit" disabled={pending} className="font-semibold text-accent hover:text-fg disabled:opacity-50">
        {pending ? '되돌리는 중…' : '규칙 판정으로 되돌리기 →'}
      </button>
    </form>
  );
}
