'use client';

import { useActionState } from 'react';
import { decideCrawlCandidates } from '../actions';
import { MAX_BULK_DECISIONS, type BulkReviewState } from './contract';

type Reason = { value: string; label: string };

/**
 * 같은 갈래는 같은 판단이다.
 *
 * 심사 큐의 대부분이 한 갈래에 몰려 있어, 한 건씩 누르는 것은 같은 결정을 수백 번 반복하는
 * 일이다. 묶어서 보낼 뿐 검사는 한 건씩 그대로 받으므로, 그 사이에 바뀐 후보만 거절된다.
 *
 * 표 위 한 줄이다. 체크박스는 표의 각 행에 있고 form 속성으로 이 폼에 실린다 — 폼은 겹칠 수 없다.
 */
export function BulkDecision({ formId, reasons, total }: {
  formId: string; reasons: readonly Reason[]; total: number;
}) {
  const [state, action, pending] = useActionState<BulkReviewState, FormData>(decideCrawlCandidates, null);

  return (
    <form id={formId} action={action} className="rounded-[12px] border border-line bg-bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[13px] font-bold">선택한 후보 한 번에 처리</b>
        <input
          name="note" required maxLength={2000} aria-label="판단 사유 — 선택한 모든 건에 같은 사유가 기록됩니다"
          placeholder="판단 사유 (선택한 모든 건에 같은 사유로 기록)"
          className="min-w-[240px] flex-1 rounded-lg border border-line bg-bg-soft px-2.5 py-1.5 text-[13px]"
        />
        <button name="decision" value="approve" disabled={pending}
          className="rounded-lg border border-up/40 bg-up/10 px-3 py-1.5 text-[13px] font-semibold text-up disabled:opacity-50">
          선택 승인
        </button>
        <select name="reason" aria-label="거부 사유 유형" defaultValue={reasons[0]?.value}
          className="rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]">
          {reasons.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
        </select>
        <button name="decision" value="reject" disabled={pending}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2 disabled:opacity-50">
          선택 거부
        </button>
        <span className="text-[13px] text-fg-3">{pending ? '처리 중…' : `이 쪽 ${total}건 중 체크한 것만 · 한 번에 최대 ${MAX_BULK_DECISIONS}건`}</span>
      </div>

      <div aria-live="polite">
        {state?.error && <p className="mt-1.5 text-[13px] text-down">{state.error}</p>}
        {typeof state?.ok === 'number' && (
          <p className="mt-1.5 text-[13px] text-fg-2">
            <b className="font-semibold text-up">{state.ok}건 처리했습니다.</b>
            {state.failures?.length ? ` ${state.failures.length}건은 처리하지 못했습니다.` : ''}
          </p>
        )}
        {state?.failures?.map((failure) => (
          <p key={failure.repo} className="mt-1 text-[13px] text-down">
            <span className="font-mono">{failure.repo}</span> — {failure.message}
          </p>
        ))}
      </div>
    </form>
  );
}
