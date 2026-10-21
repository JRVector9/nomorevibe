'use client';

import { startTransition, useActionState, useState } from 'react';
import { ConfirmAction } from '../components/ConfirmAction';
import { ReasonText } from '../review/ReasonText';
import type { SecondOpinionView } from '@/lib/crawl/audit-second-opinions';
import { decideAuditFinding, type AuditActionState } from './actions';
import { secondOpinionLabel } from './second-opinion-label';

export type AuditFindingView = {
  id: number; slug: string; name: string; url: string; category: string;
  reason: string | null; reasonKo: string | null; confidence: number | null; reviewedAt: string | null; owned: boolean;
  /** 사유 갈래 이름(audit-reason-category) — 무엇 때문에 내릴 후보가 됐는지 사유를 펴기 전에 본다 */
  reasonCategory: string;
  /** 감사 보류로 공개 목록에서 빠진 시각(화면 글자) — 없으면 없음 */
  heldAt?: string | null;
  /** 다른 모델의 두 번째 의견 — 없으면 없음 */
  second?: SecondOpinionView[];
};


/**
 * 감사가 짚은 제품 한 줄. 폼 하나가 제품 하나다 — 고르는 칸도, 모두 고르기도 두지 않는다.
 *
 * 주소는 새 탭으로 연다. 사람이 판단하는 근거는 모델의 사유가 아니라 지금 떠 있는 그 페이지다.
 * 사유는 두 줄로 접어 두고 눌러서 편다 — 한 화면에 더 많은 줄이 들어오게(ADM-32). 한글·원문은 화면 위 토글을 따른다.
 * 이름·주소는 한 줄에, 사유 갈래는 사유 앞에 붙여 한 줄을 4줄(130~150px)에서 2~3줄(약 80px)로 줄였다.
 * 긴 주소는 줄을 넘기지 않고 말줄임 — 전체는 마우스를 올리면 보이고, 이름을 누르면 그 페이지가 열린다.
 * 내리기는 다른 화면의 차단·내리기와 같은 확인 창(ConfirmAction)을 거친다(ADM-06) — 전에는 window.confirm 이었다.
 */
export function AuditFinding({ finding }: { finding: AuditFindingView }) {
  const [state, action, pending] = useActionState<AuditActionState, FormData>(decideAuditFinding, null);
  const [expanded, setExpanded] = useState(false);
  return (
    <tr className="border-t border-line align-top">
      <td className="w-full max-w-0 px-3 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <a href={finding.url} target="_blank" rel="noreferrer noopener" className="max-w-[60%] shrink-0 truncate font-semibold hover:text-accent">{finding.name}</a>
          {finding.owned && <span className="shrink-0 rounded bg-bg-soft px-1.5 py-0.5 text-fg-3">주인 있음</span>}
          {finding.heldAt && <span title={`${finding.heldAt}부터 공개 목록에서 빠짐 — 차단이 아닙니다`}
            className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 font-semibold text-warn">보류 중(목록에서 빠짐)</span>}
          {(finding.second ?? []).map((opinion) => (
            <span key={opinion.model} title={`두 번째 의견 · ${opinion.model}`}
              className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${opinion.decision === 'reject' ? 'bg-down/10 text-down' : opinion.decision === 'approve' ? 'bg-up/10 text-up' : 'bg-bg-soft text-fg-2'}`}>
              {secondOpinionLabel(opinion)}
            </span>
          ))}
          <span title={finding.url} className="min-w-0 truncate font-mono text-fg-3">{finding.url.replace(/^https?:\/\//, '')}</span>
        </div>
        <div className="mt-1 flex items-start gap-2">
          <span className="shrink-0 rounded bg-bg-soft px-1.5 py-0.5 font-semibold text-fg-2">{finding.reasonCategory}</span>
          {finding.reason ? (
            <button type="button" aria-expanded={expanded} onClick={() => setExpanded((now) => !now)} title={expanded ? '접기' : '사유 펼치기'}
              className={`min-w-0 flex-1 text-left leading-[1.6] text-fg-2 ${expanded ? 'whitespace-pre-line' : 'line-clamp-2'}`}>
              <ReasonText text={finding.reason} korean={finding.reasonKo} />
            </button>
          ) : <p className="text-fg-3">사유 없음</p>}
        </div>
        {state?.error && <p className="mt-1 text-down">{state.error}</p>}
        {state?.message && <p className="mt-1 text-up">{state.message}</p>}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-fg-2">{finding.category}</td>
      <td className="min-w-[7.5rem] whitespace-nowrap px-2 py-2 font-mono text-fg-2">
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
            <ConfirmAction title={`“${finding.name}”을(를) 공개 목록에서 내립니다`} targets={[finding.name]} confirmLabel="내리기"
              summary={<p>행은 남아 같은 주소의 재수집을 막고, 제품 관리에서 차단 해제로 되돌릴 수 있습니다.</p>}
              onConfirm={() => {
                const form = new FormData();
                form.set('item', String(finding.id));
                form.set('slug', finding.slug);
                form.set('decision', 'remove');
                startTransition(() => action(form));
              }}
              trigger={(open) => <button type="button" onClick={open} disabled={pending}
                className="rounded-lg border border-down/40 bg-down/10 px-2.5 py-1 font-semibold text-down disabled:opacity-50">내리기</button>} />
            <button type="submit" name="decision" value="keep" disabled={pending}
              className="rounded-lg border border-line px-2.5 py-1 font-semibold text-fg-2 disabled:opacity-50">유지</button>
          </div>
        </form>
      </td>
    </tr>
  );
}
