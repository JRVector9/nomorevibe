'use client';

import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { AdminReviewEntry, ReviewSort } from '@/lib/crawl/admin-review';
import { useAdminToast } from '../components/Toast';
import { REASON_LABELS } from '../reasons';
import { undoCandidateDecisions } from './actions';
import { BulkDecision } from './BulkDecision';
import { BUCKET_NOTE, causeLabel, causeShort } from './causes';
import { ReviewDetail, entryFacts, waitingDays, type DecidedResult } from './ReviewDetail';
import { secondVoteView } from './secondVote';
import { SHORTCUT_TABLE, reviewShortcut } from './shortcuts';

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
 *
 * 표 머리가 곧 거르기·정렬이다. 갈래는 드롭다운으로 고르고, 숫자 칸은 눌러 정렬을 바꾼다.
 * 정렬은 서버가 한다(쪽 넘김이 서버에 있어, 화면에서 섞으면 이 쪽 50건 안에서만 섞인다).
 *
 * 키보드로 끝까지 일한다(2026-10-08 UX 감사 ADM-10·31) — 표는 grid, 줄마다 포커스를 받는다. J/K 로 줄을 옮기면 그 줄이
 * 화면 안으로 들어오고, Enter 는 상세를 연다, Space 는 일괄 처리에 싣는다, N/P 는 쪽을 넘긴다, ? 는 단축키 표다.
 * A/R·1~5·⌘Enter 는 상세가 받는다. 결정이 기록되면 알림(되돌리기 10초)을 띄우고 다음 줄로 넘어가 그 줄에 포커스를 둔다.
 *
 * 고른 줄은 id 로 든다 — 결정한 줄이 목록에서 빠지면(새로 고침) 자리만으로는 한 줄을 건너뛴다.
 */
export function ReviewConsole({ entries, reasons, focus, sort, sortHref, cause, causes, title, footer, pageHref }: {
  entries: AdminReviewEntry[]; reasons: readonly Reason[]; focus?: number;
  sort: ReviewSort; sortHref: Record<ReviewSort, string>; cause: string; causes: CauseOption[];
  /** 표 카드의 이름 — 지금 보는 구간과 건수 */
  title: React.ReactNode;
  footer?: React.ReactNode;
  /** N/P 로 갈 쪽. 없으면 그쪽 끝이다 */
  pageHref: { prev: string | null; next: string | null };
}) {
  const router = useRouter();
  const toast = useAdminToast();
  const initial = Math.max(0, entries.findIndex((entry) => entry.candidate.id === focus));
  const [selection, setSelection] = useState({ id: entries[initial]?.candidate.id ?? 0, index: initial });
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [help, setHelp] = useState(false);
  const found = entries.findIndex((entry) => entry.candidate.id === selection.id);
  const index = found >= 0 ? found : Math.min(selection.index, entries.length - 1);
  const selected = entries[index];
  const selectable = useMemo(() => entries.filter((entry) => !!entry.inputHash && !!entry.sourceRevisionHash
    && entry.candidate.state !== 'published' && !entry.candidate.publishedSlug), [entries]);
  const tableRef = useRef<HTMLTableElement>(null);
  // 다음 그리기에서 고른 줄로 포커스를 옮길지 — J/K·결정 뒤에만
  const focusRow = useRef(false);

  const select = (row: number, moveFocus = true) => {
    const next = entries[Math.max(0, Math.min(entries.length - 1, row))];
    if (!next) return;
    focusRow.current = moveFocus;
    setSelection({ id: next.candidate.id, index: entries.indexOf(next) });
  };
  const toggle = (id: number) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => {
    if (!focusRow.current || !selected) return;
    focusRow.current = false;
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-review-row="${selected.candidate.id}"]`);
    if (!row) return;
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
    // selection 도 본다 — 끝 줄에서 J 를 눌러 같은 줄을 다시 고를 때도 포커스를 돌려준다
  }, [selected, selection]);

  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const shortcut = reviewShortcut(event);
    if (!shortcut) return;
    if (shortcut.kind === 'move') { event.preventDefault(); select(index + shortcut.delta); }
    else if (shortcut.kind === 'toggle' && selected && selectable.includes(selected)) {
      // 지금 줄 고르기 — 일괄 처리에 싣는다. 결정할 수 없는 줄(공개분·입력 없음)은 건너뛴다
      event.preventDefault();
      toggle(selected.candidate.id);
    } else if (shortcut.kind === 'open') {
      event.preventDefault();
      const row = (event.target as Element).closest<HTMLElement>('[data-review-row]');
      const at = entries.findIndex((entry) => String(entry.candidate.id) === row?.dataset.reviewRow);
      if (at >= 0) select(at, false);
      // 상세로 포커스를 옮긴다 — 넓은 화면에서는 옆 패널이라 페이지가 움직이지 않는다
      const panel = document.querySelector<HTMLElement>('[data-review-panel]');
      panel?.focus({ preventScroll: true });
      if (panel && getComputedStyle(panel).position !== 'sticky') panel.scrollIntoView({ block: 'nearest' });
    } else if (shortcut.kind === 'page') {
      const href = shortcut.delta > 0 ? pageHref.next : pageHref.prev;
      if (href) { event.preventDefault(); router.push(href); }
    } else if (shortcut.kind === 'help') { event.preventDefault(); setHelp(true); }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  /** 한 건 결정이 기록됐다 — 알림을 띄우고 다음 줄로. 결정한 줄이 목록에 남아도(진행 중 목록의 승인) 빠져도 같은 줄에 선다 */
  function decided(entry: AdminReviewEntry, result: DecidedResult) {
    const at = entries.indexOf(entry);
    const next = entries[at + 1] ?? entries[at - 1] ?? entry;
    focusRow.current = true;
    setSelection({ id: next.candidate.id, index: at });
    setChecked((current) => { const copy = new Set(current); copy.delete(entry.candidate.id); return copy; });
    toast.show({
      message: `${result.decision === 'approve' ? '승인함' : '거부함'} · ${entry.name}`,
      link: { label: '기록 보기', href: `/admin/activity?target=${encodeURIComponent(result.repo)}` },
      undo: { run: () => undoCandidateDecisions([{ repo: result.repo, attemptId: result.attemptId }]) },
    });
  }

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
      <section aria-labelledby="review-list-title" className="min-w-0 overflow-hidden rounded-[12px] border border-line bg-bg-card">
        <BulkDecision title={title} reasons={reasons} onDone={() => setChecked(new Set())}
          selected={selectable.filter((entry) => checked.has(entry.candidate.id))} />
        <div className="admin-table-scroll" role="region" aria-label="심사 후보 표">
        {/* 칸 폭을 고정한다 — 자동 배치는 남는 폭을 숫자 칸에 나눠 줘 이름이 몇 글자로 잘렸다. 이름 칸은 남는 폭 전부(최소 180px) */}
        <table ref={tableRef} role="grid" aria-labelledby="review-list-title" className="w-full min-w-[720px] table-fixed text-[13px] tabular-nums">
          <colgroup><col className="w-9" /><col /><col className="w-[120px]" /><col className="w-[76px]" /><col className="w-[92px]" /><col className="w-[52px]" /><col className="w-[84px]" /><col className="w-[64px]" /></colgroup>
          <thead className="bg-bg-soft text-left text-fg-3">
            <tr role="row">
              <th className="w-9 px-3 py-2">
                <input type="checkbox" aria-label="이 쪽 모두 선택" className="size-4 accent-accent" checked={allChecked}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(selectable.map((entry) => entry.candidate.id)))} />
              </th>
              <th className="min-w-[180px] px-2 py-2 font-semibold">후보</th>
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
              const reasonText = candidate.reason ? REASON_LABELS[candidate.reason] ?? candidate.reason : '—';
              return (
                <tr key={`${candidate.id}:${entry.candidateRevisionHash}`} role="row" tabIndex={0} data-review-row={candidate.id}
                  onClick={() => select(row, false)} onFocus={(event) => { if (event.target === event.currentTarget && !active) select(row, false); }} aria-selected={active}
                  className={`cursor-pointer border-t border-line outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)] ${active ? 'bg-accent-soft' : 'hover:bg-bg-hover'}`}>
                  <td className={`px-3 py-1 ${active ? 'shadow-[inset_3px_0_0_var(--color-accent)]' : ''}`} onClick={(event) => event.stopPropagation()}>
                    {canDecide && (
                      <input type="checkbox" aria-label={`${entry.name} 선택`} className="size-4 accent-accent" tabIndex={-1}
                        checked={checked.has(candidate.id)} onChange={() => toggle(candidate.id)} />
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex min-w-0 flex-col leading-[16px]">
                      <span className="truncate font-semibold" title={entry.name}>{entry.name}</span>
                      {entry.name !== candidate.repo && <span className="truncate font-mono text-fg-3" title={candidate.repo}>{candidate.repo}</span>}
                    </div>
                  </td>
                  {/* 갈래가 없는 줄(거부·통과)은 사유 코드를 사람 말로 적는다 — 거부 목록이 영어 코드로 보였다.
                      보류 줄은 갈래 칩·운영센터와 같은 값(entry.bucket)을 쓰고, 칩에는 짧은 이름을 쓴다(ADM-13) */}
                  <td className="truncate px-2 py-1">
                    {bucket
                      ? <span className="rounded bg-warn/10 px-1.5 py-0.5 font-semibold text-warn" title={causeLabel(bucket)}>{causeShort(bucket)}</span>
                      : <span className="text-fg-3" title={reasonText}>{reasonText}</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1">
                    {chip ? <span title={typeof entry.review?.confidence === 'number' ? `확신 ${entry.review.confidence.toFixed(2)}` : undefined} className={`rounded px-1.5 py-0.5 font-semibold ${chip.className}`}>{chip.label}</span> : <span className="text-fg-3">—</span>}
                  </td>
                  <td className="truncate px-2 py-1">
                    {vote ? <span title={vote.title} className={`rounded px-1.5 py-0.5 font-semibold ${VOTE_CHIP[vote.tone]}`}>{vote.label}</span> : <span className="text-fg-3">—</span>}
                  </td>
                  <td className="px-2 py-1 text-right">{facts.stars ?? '—'}</td>
                  {/* 푸시 칸의 숫자는 "마지막 푸시로부터 지난 날"이다 — 머리와 꼬리를 맞춰 적는다 */}
                  <td className="px-2 py-1 text-right">{facts.pushDays === null ? '—' : `${facts.pushDays}일 전`}</td>
                  <td className="px-3 py-1 text-right text-fg-3">{days === null ? '—' : `${days}일`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3 py-2 text-[13px] text-fg-3">
          <span>{checked.size}건 선택 · J/K 줄 · Enter 열기 · Space 선택 · A/R 결정 · N/P 쪽</span>
          <button type="button" onClick={() => setHelp(true)} className="text-accent hover:text-fg">단축키 전부 (?)</button>
          {footer}
        </div>
      </section>
      <aside data-review-panel tabIndex={-1} aria-label="고른 후보의 근거와 결정"
        className="rounded-[12px] border border-line bg-bg-card outline-none lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
        {selected ? <ReviewDetail key={`${selected.candidate.id}:${selected.candidateRevisionHash}`} entry={selected} reasons={reasons}
          onDecided={(result) => decided(selected, result)} />
          : <p className="p-4 text-[13px] text-fg-3">고른 후보가 없습니다.</p>}
      </aside>
      <ShortcutHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

/** ? 로 여는 단축키 표 */
function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="admin-confirm" data-tone="neutral" aria-labelledby="review-shortcuts-title" onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="admin-confirm-body">
        <h2 id="review-shortcuts-title">심사 큐 단축키</h2>
        <table className="w-full text-[13px]">
          <tbody>
            {SHORTCUT_TABLE.map(([keys, what]) => (
              <tr key={keys} className="border-t border-line first:border-t-0">
                <th scope="row" className="whitespace-nowrap py-1.5 pr-4 text-left font-mono font-semibold">{keys}</th>
                <td className="py-1.5 text-fg-2">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-confirm-actions">
          <button type="button" className="admin-button" data-tone="primary" onClick={onClose} autoFocus>닫기</button>
        </div>
      </div>
    </dialog>
  );
}
