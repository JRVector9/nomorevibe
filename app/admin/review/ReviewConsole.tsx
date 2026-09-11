'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AdminReviewEntry } from '@/lib/crawl/admin-review';
import { causeLabel } from './causes';
import { packSelection } from './contract';
import { ReviewDetail, entryFacts, waitingDays } from './ReviewDetail';

type Reason = { value: string; label: string };
const AI_CHIP: Record<string, { label: string; className: string }> = {
  reject: { label: 'AI 거부', className: 'bg-down/10 text-down' },
  approve: { label: 'AI 승인', className: 'bg-up/10 text-up' },
  needs_review: { label: 'AI 보류', className: 'bg-bg-soft text-fg-2' },
};

/**
 * 심사 표와 오른쪽 상세.
 *
 * 한 후보를 카드 한 장으로 펼치면 50건이 화면 9개가 됐다. 표 한 줄에는 판단의 절반을
 * 끝내는 값(갈래·AI 판단·스타·푸시·대기)만 두고, 근거와 결정은 고른 한 건만 옆에 연다.
 * J/K 로 줄을 옮긴다. 체크박스는 form 속성으로 일괄 처리 폼에 실린다 — 폼은 겹칠 수 없다.
 */
export function ReviewConsole({ entries, reasons, bulkFormId, focus }: {
  entries: AdminReviewEntry[]; reasons: readonly Reason[]; bulkFormId: string; focus?: number;
}) {
  const initial = entries.findIndex((entry) => entry.candidate.id === focus);
  const [index, setIndex] = useState(initial >= 0 ? initial : 0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const selected = entries[Math.min(index, entries.length - 1)];
  const selectable = useMemo(() => entries.filter((entry) => !!entry.inputHash && !!entry.sourceRevisionHash
    && entry.candidate.state !== 'published' && !entry.candidate.publishedSlug), [entries]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === 'j') setIndex((value) => Math.min(entries.length - 1, value + 1));
      if (event.key === 'k') setIndex((value) => Math.max(0, value - 1));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries.length]);

  const toggle = (id: number) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allChecked = selectable.length > 0 && selectable.every((entry) => checked.has(entry.candidate.id));

  return (
    <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
        {/* 칸 폭을 고정한다 — 자동 배치는 남는 폭을 숫자 칸에 나눠 줘 이름이 몇 글자로 잘렸다 */}
        <table className="w-full min-w-[640px] table-fixed text-[13px] tabular-nums">
          <colgroup><col className="w-9" /><col /><col className="w-[150px]" /><col className="w-[76px]" /><col className="w-12" /><col className="w-14" /><col className="w-14" /></colgroup>
          <thead className="bg-bg-soft text-left text-fg-3">
            <tr>
              <th className="w-9 px-3 py-2">
                <input type="checkbox" aria-label="이 쪽 모두 선택" className="size-4 accent-accent" checked={allChecked}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(selectable.map((entry) => entry.candidate.id)))} />
              </th>
              <th className="px-2 py-2 font-semibold">후보</th>
              <th className="px-2 py-2 font-semibold">갈래</th>
              <th className="px-2 py-2 font-semibold">AI 1차</th>
              <th className="px-2 py-2 text-right font-semibold">★</th>
              <th className="px-2 py-2 text-right font-semibold">푸시</th>
              <th className="px-3 py-2 text-right font-semibold">대기</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, row) => {
              const { candidate } = entry;
              const facts = entryFacts(entry);
              const days = waitingDays(entry);
              const chip = entry.review?.decision ? AI_CHIP[entry.review.decision] : null;
              const canDecide = selectable.includes(entry);
              const active = row === index;
              return (
                <tr key={`${candidate.id}:${entry.candidateRevisionHash}`} onClick={() => setIndex(row)} aria-selected={active}
                  className={`cursor-pointer border-t border-line ${active ? 'bg-accent-soft' : 'hover:bg-bg-hover'}`}>
                  <td className={`px-3 py-1.5 ${active ? 'shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`} onClick={(event) => event.stopPropagation()}>
                    {canDecide && (
                      <input type="checkbox" name="selected" form={bulkFormId} aria-label={`${entry.name} 선택`} className="size-4 accent-accent"
                        value={packSelection({ repo: candidate.repo, inputHash: entry.inputHash, sourceRevisionHash: entry.sourceRevisionHash, candidateRevisionHash: entry.candidateRevisionHash })}
                        checked={checked.has(candidate.id)} onChange={() => toggle(candidate.id)} />
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-semibold">{entry.name}</span>
                      <span className="truncate font-mono text-fg-3">{candidate.repo}</span>
                    </div>
                  </td>
                  <td className="truncate px-2 py-1.5">
                    {entry.verdict?.cause
                      ? <span className="rounded bg-warn/10 px-1.5 py-0.5 font-semibold text-warn">{causeLabel(entry.verdict.cause).slice(0, 14)}</span>
                      : <span className="text-fg-3">{candidate.reason ?? '—'}</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {chip ? <span className={`rounded px-1.5 py-0.5 font-semibold ${chip.className}`}>{chip.label}</span> : <span className="text-fg-3">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right">{facts.stars ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right">{facts.pushDays === null ? '—' : `${facts.pushDays}일`}</td>
                  <td className="px-3 py-1.5 text-right text-fg-3">{days === null ? '—' : `${days}일`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="border-t border-line px-3 py-2 text-[13px] text-fg-3">{checked.size}건 선택 · J/K 로 줄 이동 · 줄을 누르면 오른쪽에 근거와 결정</p>
      </div>
      <aside className="rounded-[12px] border border-line bg-bg-card lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
        {selected ? <ReviewDetail key={`${selected.candidate.id}:${selected.candidateRevisionHash}`} entry={selected} reasons={reasons} />
          : <p className="p-4 text-[13px] text-fg-3">고른 후보가 없습니다.</p>}
      </aside>
    </div>
  );
}
