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
 * 체크박스는 목록의 각 행에 있고 form 속성으로 이 폼에 실린다 — 폼은 겹칠 수 없다.
 */
export function BulkDecision({ formId, reasons, total }: {
  formId: string; reasons: readonly Reason[]; total: number;
}) {
  const [state, action, pending] = useActionState<BulkReviewState, FormData>(decideCrawlCandidates, null);

  return (
    <form id={formId} action={action} className="mt-4 rounded-[12px] border border-line bg-bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[14.5px] font-bold">선택한 후보 한 번에 처리</h2>
        <p className="text-[13px] text-fg-3">
          이 화면의 {total}건 중 체크한 것만 처리합니다 · 한 번에 최대 {MAX_BULK_DECISIONS}건
        </p>
      </div>

      <label className="mt-3 block text-[13px] font-semibold text-fg-2">
        판단 사유 <span className="font-normal text-fg-3">— 선택한 모든 건에 같은 사유가 기록됩니다</span>
        <textarea
          name="note" required maxLength={2000} rows={2}
          placeholder="예) owner.github.io 하위 경로에 올린 웹앱. 페이지에서 바로 조작이 됨."
          className="mt-2 block w-full rounded-lg border border-line bg-bg-soft p-2 text-[13px] font-normal"
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          name="decision" value="approve" disabled={pending}
          className="rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-[13px] font-semibold text-up disabled:opacity-50"
        >
          선택 승인
        </button>
        <select
          name="reason" aria-label="거부 사유 유형" defaultValue={reasons[0]?.value}
          className="rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px]"
        >
          {reasons.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
        </select>
        <button
          name="decision" value="reject" disabled={pending}
          className="rounded-lg border border-line px-3 py-2 text-[13px] font-semibold text-fg-2 disabled:opacity-50"
        >
          선택 거부
        </button>
        {pending && <span className="text-[13px] text-fg-3">처리 중…</span>}
      </div>

      <div aria-live="polite" className="mt-2">
        {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
        {typeof state?.ok === 'number' && (
          <p className="text-[13px] text-fg-2">
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
