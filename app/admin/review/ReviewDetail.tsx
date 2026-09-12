'use client';

import { useActionState } from 'react';
import { decideCrawlCandidate, type ReviewState } from '../actions';
import { collectCandidateEvidence } from './actions';
import type { AdminReviewEntry } from '@/lib/crawl/admin-review';
import { RuleTrace } from './RuleTrace';
import { causeLabel } from './causes';
import { ReasonText } from './ReasonText';

type Reason = { value: string; label: string };
const button = 'rounded-lg border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50';
const STATUS = { unreviewed: '미심사', running: '심사 중', succeeded: '심사 완료', failed: '심사 실패 · 재시도 대기', exhausted: '재시도 소진 · 직접 확인 필요', outdated: '입력 변경 · 재심사 필요' };
const STATES: Record<string, string> = { new: '규칙 검사 대기', approved: '발행 조건 확인 대상', needs_review: '보류', rejected: '거부', published: '발행 완료' };
const VERDICT = {
  reject: { label: 'AI 거부', className: 'border-down/40 bg-down/10', text: 'text-down' },
  approve: { label: 'AI 승인', className: 'border-up/40 bg-up/10', text: 'text-up' },
  needs_review: { label: 'AI 보류', className: 'border-line bg-bg-soft', text: 'text-fg-2' },
} as const;

export function safeUrl(value: string | null) {
  try { const url = new URL(value ?? ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

/**
 * 목록에서 한눈에 재는 값. 근거와 같은 출처(지금 다시 잰 값)를 쓴다 — 저장된 값을 쓰면
 * 판정 당시의 숫자가 남아 아래 근거의 숫자와 어긋난다 (판정 때 "푸시 0일"이던 것이 지금은 23일이다).
 */
export function entryFacts(entry: AdminReviewEntry) {
  const s = (entry.verdict?.signals ?? entry.candidate.signals ?? {}) as Record<string, unknown>;
  const num = (key: string) => (typeof s[key] === 'number' ? (s[key] as number) : null);
  return { stars: num('stars'), pushDays: num('pushAgeDays'), status: num('pageStatus'), owner: typeof s.ownerType === 'string' ? s.ownerType : null };
}

/** 대기 일수 — 오래 묵은 것을 먼저 처리하려면 목록에서 보여야 한다 */
export function waitingDays(entry: AdminReviewEntry): number | null {
  const at = entry.candidate.judgedAt ?? entry.candidate.updatedAt;
  return at ? Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000) : null;
}

/** 오른쪽 상세. 표에서 고른 후보 하나의 근거와 결정 */
export function ReviewDetail({ entry, reasons }: { entry: AdminReviewEntry; reasons: readonly Reason[] }) {
  const { candidate } = entry;
  const [state, action, pending] = useActionState<ReviewState, FormData>(decideCrawlCandidate, null);
  const [refresh, refreshAction, refreshing] = useActionState(collectCandidateEvidence, null);
  const canDecide = !!entry.inputHash && !!entry.sourceRevisionHash && candidate.state !== 'published' && !candidate.publishedSlug;
  const canCollect = canDecide && candidate.decidedBy === 'auto' && candidate.state === 'needs_review' && entry.refreshCount < 2;
  const productUrl = safeUrl(candidate.productUrl);
  const facts = entryFacts(entry);
  const verdict = entry.review?.decision && entry.review.decision in VERDICT ? VERDICT[entry.review.decision as keyof typeof VERDICT] : null;

  const identity = <>
    <input type="hidden" name="repo" value={candidate.repo} />
    <input type="hidden" name="inputHash" value={entry.inputHash ?? ''} />
    <input type="hidden" name="sourceRevisionHash" value={entry.sourceRevisionHash ?? ''} />
    <input type="hidden" name="candidateRevisionHash" value={entry.candidateRevisionHash} />
  </>;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-[15px] font-bold leading-snug">{entry.name}</h2>
        <a href={`https://github.com/${candidate.repo}`} target="_blank" rel="noreferrer noopener"
          className="font-mono text-[13px] text-fg-3 hover:text-accent">{candidate.repo}</a>
        {productUrl && (
          <a href={productUrl} target="_blank" rel="noreferrer noopener"
            className="mt-1 block break-all font-mono text-[13px] text-accent">{productUrl}</a>
        )}
        <p className="mt-1 flex flex-wrap gap-x-3 font-mono text-[13px] text-fg-3">
          <span>★ {facts.stars ?? '—'}</span><span>푸시 {facts.pushDays ?? '—'}일</span>
          <span>{facts.status === null ? '응답 —' : `HTTP ${facts.status}`}</span><span>{facts.owner ?? '—'}</span>
        </p>
      </div>

      {verdict && (
        <p className={`rounded-lg border px-2.5 py-2 text-[13px] leading-[1.6] text-fg-2 ${verdict.className}`}>
          <b className={`font-semibold ${verdict.text}`}>{verdict.label}</b>
          {entry.review?.model ? <span className="ml-1.5 font-mono text-fg-3">{entry.review.model}</span> : null}
          {typeof entry.review?.confidence === 'number' ? <span className="ml-1.5 font-mono text-fg-3">확신 {entry.review.confidence.toFixed(2)}</span> : null}
          {entry.review?.reason ? <span className="mt-1 block"><ReasonText text={entry.review.reason} korean={entry.review.reasonKo} limit={400} /></span> : null}
        </p>
      )}

      {/*
        2차는 모델마다 한 줄 — 어느 모델이 무엇이라 했는지가 한눈에 보여야 사람이 가른다.
        아직 보지 않은 표와 실패한 표도 보여 준다. 무엇을 기다리는지 모르면 사람이 먼저 확정해 버린다.
      */}
      {entry.seconds.map((vote, index) => (
        <p key={`${vote.model ?? 'model'}-${index}`}
          className={`rounded-lg border px-2.5 py-2 text-[13px] leading-[1.6] text-fg-2 ${
            vote.status === 'agreed' ? 'border-up/40 bg-up/5' : vote.status === 'pending' ? 'border-line bg-bg-soft' : 'border-warn/40 bg-warn/5'}`}>
          <b className="font-semibold">2차 {
            vote.status === 'pending' ? '아직 안 봄'
              : vote.status === 'failed' ? `실패 · ${vote.errorCode ?? '알 수 없음'}`
              : vote.decision === 'approve' ? '승인' : vote.decision === 'reject' ? '거부' : vote.decision === 'needs_review' ? '보류' : vote.status}</b>
          {vote.model ? <span className="ml-1.5 font-mono text-fg-3">{vote.model}</span> : null}
          {typeof vote.confidence === 'number' ? <span className="ml-1.5 font-mono text-fg-3">확신 {vote.confidence.toFixed(2)}</span> : null}
          <span className="ml-1.5 font-semibold">{
            vote.echo ? '· 1차와 같은 모델 — 셈에서 뺌'
              : vote.status === 'agreed' ? '· 1차와 일치' : vote.status === 'needs_human' ? '· 사람 확인' : ''}</span>
          {vote.reason ? <span className="mt-1 block"><ReasonText text={vote.reason} korean={vote.reasonKo} limit={400} /></span> : null}
        </p>
      ))}

      <p className="text-[13px] text-fg-2">
        {entry.verdict?.cause
          ? <b className="font-semibold text-down">{causeLabel(entry.verdict.cause)}</b>
          : <>{STATES[candidate.state]} · {candidate.reason ?? '사유 없음'}</>}
        {' · '}{candidate.decidedBy === 'admin' ? '관리자 결정' : STATUS[entry.status]}
      </p>

      {canDecide && <form action={action} className="rounded-lg border border-line bg-bg-soft p-3">
        {identity}
        <label className="block text-[13px] font-semibold">관리자 판단 사유
          <textarea name="note" required maxLength={2000} rows={2} className="mt-1.5 block w-full rounded-lg border border-line bg-bg-card p-2 font-normal" />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button name="decision" value="approve" disabled={pending || refreshing} className={`${button} border-up/40 bg-up/10 text-up`}>승인</button>
          <select name="reason" aria-label="거부 사유 유형" defaultValue={reasons[0]?.value} className="rounded-lg border border-line bg-bg-card px-2 py-1.5 text-[13px]">
            {reasons.map(reason => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
          </select>
          <button name="decision" value="reject" disabled={pending || refreshing} className={`${button} border-line bg-bg-card text-fg-2`}>거부</button>
        </div>
        {state?.error && <p role="status" className="mt-2 text-[13px] text-down">{state.error}</p>}
      </form>}

      {entry.description && (
        <details className="text-[13px]" open>
          <summary className="cursor-pointer font-semibold text-fg-3">설명</summary>
          <p className="mt-1.5 max-h-[140px] overflow-auto whitespace-pre-line leading-relaxed text-fg-2">{entry.description.slice(0, 1200)}</p>
        </details>
      )}

      {entry.verdict
        ? <RuleTrace verdict={entry.verdict} />
        : <p className="text-[13px] text-fg-3">원본이 없어 규칙을 되짚을 수 없습니다.</p>}

      <p className="text-[13px] text-fg-3">저장소 연결: {entry.relationship} · 근거 수집: {entry.scanState}</p>

      {entry.latest && <div className="rounded-lg bg-bg-soft p-3 text-[13px] leading-relaxed text-fg-2">
        <p className="font-semibold">{entry.latest.kind === 'admin_override' ? '관리자 결정 기록' : entry.latest.kind === 'evidence_refresh' ? '추가 수집 접수 기록' : '최근 AI·규칙 심사 기록'}</p>
        {entry.latest.kind === 'automatic' && <p>{entry.latest.provider ?? '실행기 미확인'}{entry.latest.model ? ` · ${entry.latest.model}` : ''} · {entry.latest.decision ?? entry.latest.state}</p>}
        {entry.latest.actor && <p>담당자: {entry.latest.actor}</p>}
        {entry.latest.reason && <p className="whitespace-pre-line"><ReasonText text={entry.latest.reason} korean={entry.latest.reasonKo} /></p>}
        {entry.latest.error && <p className="text-down">실행 오류: {entry.latest.error}</p>}
        <p className="mt-1 text-[13px] text-fg-3">{entry.latest.at}</p>
      </div>}

      <details className="text-[13px] text-fg-2">
        <summary className="cursor-pointer font-semibold text-fg-3">발견한 근거 {entry.evidence.length}개</summary>
        <p className="mt-1.5 text-[13px] text-fg-3">지침·설정 파일의 발견은 해당 AI로 실제 개발했다는 확인이 아닙니다.</p>
        {entry.evidence.length ? <ul className="mt-1.5 space-y-1">{entry.evidence.map(item => <li key={item.id}>
          {safeUrl(item.url) ? <a href={safeUrl(item.url)!} target="_blank" rel="noreferrer noopener" className="break-all hover:text-accent">{item.label}</a> : item.label}
        </li>)}</ul> : <p className="mt-1.5">저장된 공개 근거가 없습니다.</p>}
      </details>

      {canCollect && <form action={refreshAction} className="border-t border-line pt-3">
        {identity}
        <label className="block text-[13px] font-semibold">추가 근거가 필요한 이유
          <input name="note" required maxLength={2000} className="mt-1.5 block w-full rounded-lg border border-line bg-bg-soft p-2 font-normal" />
        </label>
        <button disabled={refreshing || pending} className={`${button} mt-2 border-line text-fg-2`}>추가 수집 요청 ({entry.refreshCount}/2)</button>
      </form>}
      {refresh && <p role="status" className={`text-[13px] ${refresh.error ? 'text-down' : 'text-up'}`}>{refresh.error ?? refresh.message}</p>}
      <p className="text-[13px] text-fg-3">관리자 승인은 AI 판정과 별개로 기록되며 발행 워커의 중복·차단 검사는 유지됩니다.</p>
    </div>
  );
}
