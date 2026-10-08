'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AdminReviewEntry, ReviewSort } from '@/lib/crawl/admin-review';
import { BUCKET_NOTE, causeLabel } from './causes';
import { REASON_LABELS } from '../reasons';
import { packSelection } from './contract';
import { ReviewDetail, entryFacts, waitingDays } from './ReviewDetail';
import { secondVoteView } from './secondVote';

type Reason = { value: string; label: string };
const VOTE_CHIP = { ok: 'bg-up/10 text-up', bad: 'bg-down/10 text-down', warn: 'bg-warn/10 text-warn', soft: 'bg-bg-soft text-fg-2' } as const;
const AI_CHIP: Record<string, { label: string; className: string }> = {
  reject: { label: 'AI 거부', className: 'bg-down/10 text-down' },
  approve: { label: 'AI 승인', className: 'bg-up/10 text-up' },
  needs_review: { label: 'AI 보류', className: 'bg-bg-soft text-fg-2' },
};

export type CauseOption = { value: string; label: string; count: number; href: string };

/**
 * 심사 표와 오른쪽 상세.
 *
 * 한 후보를 카드 한 장으로 펼치면 50건이 화면 9개가 됐다. 표 한 줄에는 판단의 절반을
 * 끝내는 값(갈래·AI 판단·스타·푸시·대기)만 두고, 근거와 결정은 고른 한 건만 옆에 연다.
 * J/K 로 줄을 옮긴다. 체크박스는 form 속성으로 일괄 처리 폼에 실린다 — 폼은 겹칠 수 없다.
 *
 * 표 머리가 곧 거르기·정렬이다. 갈래는 드롭다운으로 고르고, 숫자 칸은 눌러 정렬을 바꾼다.
 * 정렬은 서버가 한다(쪽 넘김이 서버에 있어, 화면에서 섞으면 이 쪽 50건 안에서만 섞인다).
 *
 * 표 카드 위에는 일괄 처리(toolbar), 아래에는 쪽 넘김(footer)이 붙는다. 2차 표 칸은 상세를 열지 않고도
 * 두 모델이 어떻게 갈렸는지 보이게 한다(secondVote.ts). Space 는 지금 줄을 고르고, A/R 은 상세가 받는다.
 */
export function ReviewConsole({ entries, reasons, bulkFormId, focus, sort, sortHref, cause, causes, toolbar, footer }: {
  entries: AdminReviewEntry[]; reasons: readonly Reason[]; bulkFormId: string; focus?: number;
  sort: ReviewSort; sortHref: Record<ReviewSort, string>; cause: string; causes: CauseOption[];
  toolbar?: React.ReactNode; footer?: React.ReactNode;
}) {
  const router = useRouter();
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
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'j') setIndex((value) => Math.min(entries.length - 1, value + 1));
      if (event.key === 'k') setIndex((value) => Math.max(0, value - 1));
      // 지금 줄 고르기 — 일괄 처리에 싣는다. 결정할 수 없는 줄(공개분·입력 없음)은 건너뛴다
      if (event.key === ' ' && selected && selectable.includes(selected)) {
        event.preventDefault();
        const id = selected.candidate.id;
        setChecked((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries.length, selected, selectable]);

  const toggle = (id: number) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allChecked = selectable.length > 0 && selectable.every((entry) => checked.has(entry.candidate.id));

  /** 누를 때마다 내림차순 → 오름차순 → 기본(들어온 차례)으로 돈다 */
  const sortHead = (label: string, cycle: readonly [ReviewSort, ReviewSort?], hint: string) => {
    const [first, second] = cycle;
    const next: ReviewSort = sort === first ? (second ?? '') : sort === second ? '' : first;
    const mark = sort === first ? '↓' : sort === second ? '↑' : '';
    return (
      <Link href={sortHref[next]} scroll={false} title={hint}
        className={`inline-flex w-full items-baseline justify-end gap-1 hover:text-fg ${mark ? 'font-bold text-accent' : ''}`}>
        {label}<span className="w-2 font-mono">{mark}</span>
      </Link>
    );
  };

  return (
    <div className="rq-work">
      <section aria-labelledby="review-list-title" className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
        {toolbar}
        <div className="overflow-x-auto">
        {/* 칸 폭을 고정한다 — 자동 배치는 남는 폭을 숫자 칸에 나눠 줘 이름이 몇 글자로 잘렸다 */}
        <table className="w-full min-w-[790px] table-fixed text-[13px] tabular-nums">
          <colgroup><col className="w-9" /><col /><col className="w-[140px]" /><col className="w-[76px]" /><col className="w-[92px]" /><col className="w-[52px]" /><col className="w-[84px]" /><col className="w-[64px]" /></colgroup>
          <thead className="bg-bg-soft text-left text-fg-3">
            <tr>
              <th className="w-9 px-3 py-2">
                <input type="checkbox" aria-label="이 쪽 모두 선택" className="size-4 accent-accent" checked={allChecked}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(selectable.map((entry) => entry.candidate.id)))} />
              </th>
              <th className="px-2 py-2 font-semibold">후보</th>
              <th className="px-2 py-1 font-semibold" title={BUCKET_NOTE}>
                {/* 갈래는 정렬이 아니라 거르기다 — 같은 갈래는 같은 판단이라 몰아서 본다 */}
                <select aria-label="갈래로 거르기" value={cause} onChange={(event) => {
                  const picked = causes.find((option) => option.value === event.target.value);
                  if (picked) router.push(picked.href, { scroll: false });
                }} className="w-full rounded-lg border border-line bg-bg-soft px-1.5 py-1 text-[13px] font-semibold">
                  {causes.map((option) => (
                    <option key={option.value || 'all'} value={option.value}>
                      {option.label}{option.value ? ` (${option.count.toLocaleString('ko-KR')})` : ''}
                    </option>
                  ))}
                </select>
              </th>
              <th className="px-2 py-2 font-semibold">AI 1차</th>
              <th className="px-2 py-2 font-semibold" title="1차와 다른 모델의 표 — 결론이 난 표, 그중 거부가 먼저">2차 표</th>
              <th className="px-2 py-2 text-right font-semibold">{sortHead('★', ['stars'], '별이 많은 것부터')}</th>
              <th className="px-2 py-2 text-right font-semibold">{sortHead('푸시', ['push', 'push_old'], '마지막 푸시 — ↓ 최근에 손댄 것부터 · ↑ 오래 멈춘 것부터')}</th>
              <th className="px-3 py-2 text-right font-semibold">{sortHead('대기', ['wait', 'wait_short'], '↓ 오래 기다린 것부터 · ↑ 막 들어온 것부터')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, row) => {
              const { candidate } = entry;
              const facts = entryFacts(entry);
              const days = waitingDays(entry);
              const chip = entry.review?.decision ? AI_CHIP[entry.review.decision] : null;
              const vote = secondVoteView(entry.seconds);
              const bucket = entry.bucket ?? entry.verdict?.cause ?? null;
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
                  {/* 갈래가 없는 줄(거부·통과)은 사유 코드를 사람 말로 적는다 — 거부 목록이 영어 코드로 보였다.
                      보류 줄은 갈래 칩·운영센터와 같은 값(entry.bucket)을 쓴다 */}
                  <td className="truncate px-2 py-1.5">
                    {bucket
                      ? <span className="rounded bg-warn/10 px-1.5 py-0.5 font-semibold text-warn" title={causeLabel(bucket)}>{causeLabel(bucket).slice(0, 14)}</span>
                      : <span className="text-fg-3">{candidate.reason ? REASON_LABELS[candidate.reason] ?? candidate.reason : '—'}</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {chip ? <span title={typeof entry.review?.confidence === 'number' ? `확신 ${entry.review.confidence.toFixed(2)}` : undefined} className={`rounded px-1.5 py-0.5 font-semibold ${chip.className}`}>{chip.label}</span> : <span className="text-fg-3">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {vote ? <span title={vote.title} className={`rounded px-1.5 py-0.5 font-semibold ${VOTE_CHIP[vote.tone]}`}>{vote.label}</span> : <span className="text-fg-3">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right">{facts.stars ?? '—'}</td>
                  {/* 푸시 칸의 숫자는 "마지막 푸시로부터 지난 날"이다 — 머리와 꼬리를 맞춰 적는다 */}
                  <td className="px-2 py-1.5 text-right">{facts.pushDays === null ? '—' : `${facts.pushDays}일 전`}</td>
                  <td className="px-3 py-1.5 text-right text-fg-3">{days === null ? '—' : `${days}일`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3 py-2 text-[13px] text-fg-3">
          <span>{checked.size}건 선택 · J/K 줄 이동 · Space 선택 · A/R 결정 칸으로 · 줄을 누르면 오른쪽에 근거와 결정</span>
          {footer}
        </div>
      </section>
      <aside className="rounded-[12px] border border-line bg-bg-card lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
        {selected ? <ReviewDetail key={`${selected.candidate.id}:${selected.candidateRevisionHash}`} entry={selected} reasons={reasons} />
          : <p className="p-4 text-[13px] text-fg-3">고른 후보가 없습니다.</p>}
      </aside>
    </div>
  );
}
