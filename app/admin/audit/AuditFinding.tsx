'use client';

import { useActionState } from 'react';
import { decideAuditFinding, type AuditActionState } from './actions';

export type AuditFindingView = {
  id: number; slug: string; name: string; url: string; category: string;
  reason: string | null; confidence: number | null; reviewedAt: string | null; owned: boolean;
};

/**
 * 감사가 짚은 제품 한 줄. 폼 하나가 제품 하나다 — 고르는 칸도, 모두 고르기도 두지 않는다.
 *
 * 주소는 새 탭으로 연다. 사람이 판단하는 근거는 모델의 사유가 아니라 지금 떠 있는 그 페이지다.
 */
export function AuditFinding({ finding }: { finding: AuditFindingView }) {
  const [state, action, pending] = useActionState<AuditActionState, FormData>(decideAuditFinding, null);
  return (
    <tr className="border-t border-line align-top">
      <td className="px-3 py-2">
        <a href={finding.url} target="_blank" rel="noreferrer noopener" className="font-semibold hover:text-accent">{finding.name}</a>
        {finding.owned && <span className="ml-2 rounded bg-bg-soft px-1.5 py-0.5 text-fg-3">주인 있음</span>}
        <span className="mt-0.5 block break-all font-mono text-fg-3">{finding.url.replace(/^https?:\/\//, '')}</span>
        <p className="mt-1 leading-[1.6] text-fg-2">{finding.reason ?? '사유 없음'}</p>
        {state?.error && <p className="mt-1 text-down">{state.error}</p>}
        {state?.message && <p className="mt-1 text-up">{state.message}</p>}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-fg-2">{finding.category}</td>
      <td className="whitespace-nowrap px-2 py-2 font-mono text-fg-2">
        {typeof finding.confidence === 'number' ? finding.confidence.toFixed(2) : '—'}
        <span className="block font-sans text-fg-3">{finding.reviewedAt ?? ''}</span>
      </td>
      <td className="px-3 py-2">
        <form action={action} className="flex flex-col items-end gap-1.5">
          <input type="hidden" name="item" value={finding.id} />
          <input type="hidden" name="slug" value={finding.slug} />
          <input name="note" maxLength={500} placeholder="유지 사유 (선택)" aria-label={`${finding.name} 유지 사유`}
            className="w-[180px] rounded-lg border border-line bg-bg-soft px-2 py-1 text-[13px]" />
          <div className="flex gap-1.5">
            <button type="submit" name="decision" value="remove" disabled={pending}
              onClick={(event) => {
                if (!window.confirm(`"${finding.name}"을(를) 공개 목록에서 내립니다.\n행은 남아 같은 주소의 재수집을 막고, 제품 관리에서 되돌릴 수 있습니다.`)) event.preventDefault();
              }}
              className="rounded-lg border border-down/40 bg-down/10 px-2.5 py-1 font-semibold text-down disabled:opacity-50">내리기</button>
            <button type="submit" name="decision" value="keep" disabled={pending}
              className="rounded-lg border border-line px-2.5 py-1 font-semibold text-fg-2 disabled:opacity-50">유지</button>
          </div>
        </form>
      </td>
    </tr>
  );
}
