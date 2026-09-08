'use client';

import { useActionState } from 'react';
import { decideCrawlCandidate, type ReviewState } from '../actions';
import { collectCandidateEvidence } from './actions';
import type { AdminReviewEntry } from '@/lib/crawl/admin-review';

type Reason = { value: string; label: string };
const button = 'rounded-lg border px-3 py-2 text-[13px] font-semibold disabled:opacity-50';
const STATUS = { unreviewed: '미심사', running: '심사 중', succeeded: '심사 완료', failed: '심사 실패 · 재시도 대기', exhausted: '재시도 소진 · 직접 확인 필요', outdated: '입력 변경 · 재심사 필요' };
const STATES: Record<string, string> = { new: '규칙 검사 대기', approved: '발행 조건 확인 대상', needs_review: '보류', rejected: '거부', published: '발행 완료' };
function safeUrl(value: string | null) {
  try { const url = new URL(value ?? ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function ReviewItem({ entry, reasons }: { entry: AdminReviewEntry; reasons: readonly Reason[] }) {
  const { candidate } = entry;
  const [state, action, pending] = useActionState<ReviewState, FormData>(decideCrawlCandidate, null);
  const [refresh, refreshAction, refreshing] = useActionState(collectCandidateEvidence, null);
  const canDecide = !!entry.inputHash && !!entry.sourceRevisionHash && candidate.state !== 'published' && !candidate.publishedSlug;
  const canCollect = canDecide && candidate.decidedBy === 'auto' && candidate.state === 'needs_review' && entry.refreshCount < 2;
  const productUrl = safeUrl(candidate.productUrl);
  const identity = <>
    <input type="hidden" name="repo" value={candidate.repo} />
    <input type="hidden" name="inputHash" value={entry.inputHash ?? ''} />
    <input type="hidden" name="sourceRevisionHash" value={entry.sourceRevisionHash ?? ''} />
    <input type="hidden" name="candidateRevisionHash" value={entry.candidateRevisionHash} />
  </>;
  return (
    <li className="rounded-xl border border-line bg-bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <a href={`https://github.com/${candidate.repo}`} target="_blank" rel="noreferrer noopener" className="text-[15px] font-bold hover:text-accent">{candidate.repo}</a>
        <span className="text-[13px] font-semibold text-fg-2">{STATES[candidate.state]} · {candidate.decidedBy === 'admin' ? '관리자 결정' : STATUS[entry.status]}</span>
      </div>
      <h3 className="mt-2 text-[14px] font-semibold">{entry.name}</h3>
      {entry.description && <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-fg-2">{entry.description.slice(0, 1200)}</p>}
      {productUrl && <a href={productUrl} target="_blank" rel="noreferrer noopener" className="mt-2 block break-all text-[13px] text-accent">{productUrl}</a>}
      <p className="mt-2 text-[13px] text-fg-3">규칙 사유: {candidate.reason ?? '아직 없음'} · 저장소 연결: {entry.relationship} · 근거 수집: {entry.scanState}</p>
      {entry.review && entry.latest?.kind !== 'automatic' && <div className="mt-3 rounded-lg bg-bg-soft p-3 text-[13px] leading-relaxed text-fg-2">
        <p className="font-semibold">최근 AI·규칙 심사 기록</p>
        <p>{entry.review.provider ?? '실행기 미확인'}{entry.review.model ? ` · ${entry.review.model}` : ''} · {entry.review.decision ?? entry.review.state}</p>
        {entry.review.reason && <p className="whitespace-pre-line">{entry.review.reason}</p>}
        {entry.review.error && <p className="text-down">실행 오류: {entry.review.error}</p>}
        {entry.review.retryAfter && <p>재시도 가능 시각: {entry.review.retryAfter}</p>}
        <p className="mt-1 text-[13px] text-fg-3">{entry.review.at}</p>
      </div>}
      {entry.latest && <div className="mt-3 rounded-lg bg-bg-soft p-3 text-[13px] leading-relaxed text-fg-2">
        <p className="font-semibold">{entry.latest.kind === 'admin_override' ? '관리자 결정 기록' : entry.latest.kind === 'evidence_refresh' ? '추가 수집 접수 기록' : '최근 AI·규칙 심사 기록'}</p>
        {entry.latest.kind === 'automatic' && <p>{entry.latest.provider ?? '실행기 미확인'}{entry.latest.model ? ` · ${entry.latest.model}` : ''} · {entry.latest.decision ?? entry.latest.state}</p>}
        {entry.latest.actor && <p>담당자: {entry.latest.actor}</p>}
        {entry.latest.reason && <p className="whitespace-pre-line">{entry.latest.reason}</p>}
        {entry.latest.error && <p className="text-down">실행 오류: {entry.latest.error}</p>}
        {entry.latest.retryAfter && <p>재시도 가능 시각: {entry.latest.retryAfter}</p>}
        <p className="mt-1 text-[13px] text-fg-3">{entry.latest.at}</p>
      </div>}
      <details className="mt-3 text-[13px] text-fg-2">
        <summary className="cursor-pointer">발견한 근거 {entry.evidence.length}개</summary>
        <p className="mt-2 text-[13px] text-fg-3">지침·설정 파일의 발견은 해당 AI로 실제 개발했다는 확인이 아닙니다.</p>
        {entry.evidence.length ? <ul className="mt-2 space-y-1">{entry.evidence.map(item => <li key={item.id}>
          {safeUrl(item.url) ? <a href={safeUrl(item.url)!} target="_blank" rel="noreferrer noopener" className="break-all hover:text-accent">{item.label}</a> : item.label}
        </li>)}</ul> : <p className="mt-2">저장된 공개 근거가 없습니다.</p>}
      </details>
      {canDecide && <form action={action} className="mt-4 border-t border-line pt-4">
        {identity}
        <label className="block text-[13px] font-semibold">관리자 판단 사유
          <textarea name="note" required maxLength={2000} rows={2} className="mt-2 block w-full rounded-lg border border-line bg-bg-soft p-2 font-normal" />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button name="decision" value="approve" disabled={pending || refreshing} className={`${button} border-up/40 bg-up/10 text-up`}>관리자 승인</button>
          <select name="reason" aria-label="거부 사유 유형" defaultValue={reasons[0]?.value} className="rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px]">
            {reasons.map(reason => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
          </select>
          <button name="decision" value="reject" disabled={pending || refreshing} className={`${button} border-line text-fg-2`}>거부</button>
        </div>
        <p className="mt-2 text-[13px] text-fg-3">관리자 승인은 AI 판정과 별개로 기록되며 발행 워커의 중복·차단 검사는 유지됩니다.</p>
      </form>}
      {state?.error && <p role="status" className="mt-2 text-[13px] text-down">{state.error}</p>}
      {canCollect && <form action={refreshAction} className="mt-4 border-t border-line pt-4">
        {identity}
        <label className="block text-[13px] font-semibold">추가 근거가 필요한 이유
          <input name="note" required maxLength={2000} className="mt-2 block w-full rounded-lg border border-line bg-bg-soft p-2 font-normal" />
        </label>
        <button disabled={refreshing || pending} className={`${button} mt-2 border-line text-fg-2`}>추가 수집 요청 ({entry.refreshCount}/2)</button>
        <p className="mt-2 text-[13px] text-fg-3">수집을 예약합니다. 같은 입력당 최대 2회이며 외부 호출 제한과 재시도 대기를 유지합니다.</p>
      </form>}
      {refresh && <p role="status" className={`mt-2 text-[13px] ${refresh.error ? 'text-down' : 'text-up'}`}>{refresh.error ?? refresh.message}</p>}
    </li>
  );
}
