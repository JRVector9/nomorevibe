'use client';

import { useState } from 'react';
import type { AdminReviewEntry } from '@/lib/crawl/admin-review';
import { ConfirmAction } from '../components/ConfirmAction';
import { useAdminToast } from '../components/Toast';
import { decideCrawlCandidates } from '../actions';
import { undoCandidateDecisions } from './actions';
import { approvalNote, causeShort, modelsAgree } from './causes';
import { MAX_BULK_DECISIONS, packSelection, type BulkReviewState } from './contract';

type Reason = { value: string; label: string };
type Decision = 'approve' | 'reject';
const n = (value: number) => value.toLocaleString('ko-KR');

/** 확인 창의 결정 요약 — 갈래별 수와 두 모델이 같은 결론인 수. 무엇을 한꺼번에 바꾸는지 훑게 한다 */
export function bulkSummary(selected: readonly AdminReviewEntry[], decision: Decision): string[] {
  const byCause = new Map<string, number>();
  for (const entry of selected) {
    const key = entry.bucket ? causeShort(entry.bucket) : '갈래 없음';
    byCause.set(key, (byCause.get(key) ?? 0) + 1);
  }
  const agreeing = selected.filter((entry) => entry.review?.decision === decision && modelsAgree(decision, entry.seconds)).length;
  return [
    decision === 'approve' ? `승인 ${n(selected.length)}건 — 발행 워커가 중복·차단을 다시 확인한 뒤 올립니다` : `거부 ${n(selected.length)}건 — 고른 사유가 모두에 같은 사유로 기록됩니다`,
    `갈래 · ${[...byCause].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${n(count)}`).join(' · ')}`,
    `두 모델이 같은 결론(${decision === 'approve' ? '승인' : '거부'}) ${n(agreeing)}건`,
  ];
}

/**
 * 메모를 비웠을 때 남길 사유 — 고른 것 모두가 두 모델 일치 승인이면 'AI·2차 일치 승인'(ADM-11).
 * 아니면 빈 값을 보내 서버가 고른 사유 이름("관리자 승인"·거부 사유)을 남긴다.
 */
export function bulkAutoNote(selected: readonly AdminReviewEntry[], decision: Decision): string {
  if (decision !== 'approve' || selected.length === 0) return '';
  const notes = new Set(selected.map((entry) => approvalNote(entry.review?.decision, modelsAgree(entry.review?.decision, entry.seconds))));
  return notes.size === 1 ? [...notes][0] ?? '' : '';
}

/**
 * 같은 갈래는 같은 판단이다.
 *
 * 심사 큐의 대부분이 한 갈래에 몰려 있어, 한 건씩 누르는 것은 같은 결정을 수백 번 반복하는
 * 일이다. 묶어서 보낼 뿐 검사는 한 건씩 그대로 받으므로, 그 사이에 바뀐 후보만 거절된다.
 *
 * 표 위 한 줄이다. 고른 줄은 표(ReviewConsole)가 들고 있다. 누르면 대상 이름과 결정 요약을 보이는 확인 창을
 * 거친다(ADM-06) — 거부는 사유를 꼭 고른다(ADM-11). 끝나면 알림에 되돌리기를 단다(ADM-12).
 */
export function BulkDecision({ selected, reasons, title, onDone }: {
  selected: readonly AdminReviewEntry[]; reasons: readonly Reason[];
  /** 표 카드의 이름 — 지금 보는 구간과 건수 */
  title: React.ReactNode;
  /** 처리한 뒤 — 표가 고른 줄을 비운다 */
  onDone: () => void;
}) {
  const toast = useAdminToast();
  const [picked, setPicked] = useState<Decision | null>(null);
  const [failures, setFailures] = useState<NonNullable<BulkReviewState>['failures']>([]);
  const over = selected.length > MAX_BULK_DECISIONS;

  async function confirm(decision: Decision, values: { reason?: string; note?: string }) {
    const form = new FormData();
    form.set('decision', decision);
    form.set('reason', values.reason ?? '');
    form.set('note', values.note || bulkAutoNote(selected, decision));
    for (const entry of selected) {
      form.append('selected', packSelection({ repo: entry.candidate.repo, inputHash: entry.inputHash,
        sourceRevisionHash: entry.sourceRevisionHash, candidateRevisionHash: entry.candidateRevisionHash }));
    }
    const result = await decideCrawlCandidates(null, form);
    if (!result || result.error) return result ?? { error: '처리하지 못했습니다' };
    const decided = result.decided ?? [];
    const failed = result.failures ?? [];
    setFailures(failed);
    toast.show({
      message: `${decision === 'approve' ? '승인함' : '거부함'} · ${n(decided.length)}건${failed.length ? ` · ${n(failed.length)}건 실패` : ''}`,
      tone: failed.length ? 'warn' : 'ok',
      link: { label: '기록 보기', href: '/admin/activity' },
      undo: decided.length ? { run: () => undoCandidateDecisions(decided) } : undefined,
    });
    onDone();
    return null;
  }

  const button = 'rounded-lg border px-3 py-1 text-[13px] font-semibold disabled:opacity-50';
  return (
    <div className="border-b border-line px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="review-list-title" className="text-[13px] font-bold">{title}</h2>
        <span className="h-4 w-px bg-line" aria-hidden />
        <span className="text-[13px] text-fg-3">{n(selected.length)}건 선택{over ? ` — 한 번에 최대 ${MAX_BULK_DECISIONS}건` : ''}</span>
        <button type="button" disabled={!selected.length || over} onClick={() => setPicked('approve')}
          className={`${button} border-up/40 bg-up/10 text-up`}>선택 승인</button>
        <button type="button" disabled={!selected.length || over} onClick={() => setPicked('reject')}
          className={`${button} border-line text-fg-2`}>선택 거부</button>
      </div>
      {picked && (
        <ConfirmAction open onOpenChange={(open) => { if (!open) setPicked(null); }}
          title={`${n(selected.length)}건을 ${picked === 'approve' ? '승인' : '거부'}합니다`}
          targets={selected.map((entry) => entry.name === entry.candidate.repo ? entry.name : `${entry.name} · ${entry.candidate.repo}`)}
          summary={<ul>{bulkSummary(selected, picked).map((line) => <li key={line}>{line}</li>)}</ul>}
          confirmLabel={`${n(selected.length)}건 ${picked === 'approve' ? '승인' : '거부'}`}
          tone={picked === 'reject' ? 'danger' : 'neutral'}
          reasons={picked === 'reject' ? { label: '거부 사유', options: reasons } : undefined}
          note={{ label: '메모', optional: true, maxLength: 2000,
            placeholder: picked === 'approve' ? (bulkAutoNote(selected, 'approve') || '관리자 승인') + ' — 비우면 이렇게 기록합니다' : '비우면 고른 거부 사유 이름으로 기록합니다' }}
          onConfirm={(values) => confirm(picked, values)} />
      )}
      {failures && failures.length > 0 && (
        <div aria-live="polite">
          {failures.map((failure) => (
            <p key={failure.repo} className="mt-1 text-[13px] text-down">
              <span className="font-mono">{failure.repo}</span> — {failure.message}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
