'use client';

import { useActionState } from 'react';
import { resolvePublishedSecondReview, type ReviewActionState } from './actions';

export type PublishedSecondRow = { id: number; slug: string; repo: string; decision: string | null; confidence: number | null; reason: string | null; trigger: string; signals: string[] };

const TRIGGER: Record<string, string> = { risk: '위험 신호', sample: '무작위 표본' };
const SIGNAL: Record<string, string> = { store_or_messenger: '스토어·메신저 주소', sentence_name: '문장 같은 이름', seo_name: '광고성 이름', no_text: '본문·README 없음' };

function Row({ row }: { row: PublishedSecondRow }) {
  const [state, action, pending] = useActionState<ReviewActionState, FormData>(resolvePublishedSecondReview, null);
  return (
    <tr className="border-t border-line align-top">
      <td className="px-3 py-2">
        <a href={`/p/${row.slug}`} target="_blank" rel="noreferrer noopener" className="font-semibold hover:text-accent">{row.slug}</a>
        <span className="ml-2 font-mono text-fg-3">{row.repo}</span>
        <p className="mt-0.5 text-fg-2">{row.reason?.slice(0, 260)}</p>
        {state?.error && <p className="text-down">{state.error}</p>}
        {state?.message && <p className="text-up">{state.message}</p>}
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-fg-3">
        {TRIGGER[row.trigger] ?? row.trigger}
        {row.signals.length > 0 && <span className="block">{row.signals.map((s) => SIGNAL[s] ?? s).join(' · ')}</span>}
      </td>
      <td className="whitespace-nowrap px-2 py-2">
        <span className="rounded bg-down/10 px-1.5 py-0.5 font-semibold text-down">2차 {row.decision === 'reject' ? '거부' : '보류'}</span>
        {typeof row.confidence === 'number' && <span className="ml-1 font-mono text-fg-3">{row.confidence.toFixed(2)}</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <form action={action} className="inline-flex gap-1.5">
          <input type="hidden" name="id" value={row.id} /><input type="hidden" name="slug" value={row.slug} />
          <button name="decision" value="ban" disabled={pending} className="rounded-lg border border-down/40 bg-down/10 px-2.5 py-1 font-semibold text-down disabled:opacity-50">내리기</button>
          <button name="decision" value="keep" disabled={pending} className="rounded-lg border border-line px-2.5 py-1 font-semibold text-fg-2 disabled:opacity-50">유지</button>
        </form>
      </td>
    </tr>
  );
}

/** 공개된 제품 중 2차가 제품이 아니라고 본 것. 내리면 차단(행은 남아 재수집을 막는다) */
export function PublishedSecondReviews({ rows }: { rows: PublishedSecondRow[] }) {
  if (!rows.length) return <p className="rounded-[12px] border border-line bg-bg-card px-5 py-8 text-center text-[13px] text-fg-3">사람이 볼 공개분이 없습니다.</p>;
  return (
    <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
      <table className="w-full min-w-[720px] text-[13px]">
        <thead className="bg-bg-soft text-left text-fg-3">
          <tr><th className="px-3 py-2 font-semibold">제품 · 2차 사유</th><th className="px-2 py-2 font-semibold">왜 다시 봤나</th><th className="px-2 py-2 font-semibold">2차 판단</th><th className="px-3 py-2" /></tr>
        </thead>
        <tbody>{rows.map((row) => <Row key={row.id} row={row} />)}</tbody>
      </table>
    </div>
  );
}
