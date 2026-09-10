'use client';

import { useActionState } from 'react';
import { decideCrawlCandidate, type ReviewState } from '../actions';
import { collectCandidateEvidence } from './actions';
import type { AdminReviewEntry } from '@/lib/crawl/admin-review';
import { RuleTrace } from './RuleTrace';
import { causeLabel } from './causes';
import { packSelection } from './contract';

type Reason = { value: string; label: string };
const button = 'rounded-lg border px-3 py-2 text-[13px] font-semibold disabled:opacity-50';
const STATUS = { unreviewed: '미심사', running: '심사 중', succeeded: '심사 완료', failed: '심사 실패 · 재시도 대기', exhausted: '재시도 소진 · 직접 확인 필요', outdated: '입력 변경 · 재심사 필요' };
const STATES: Record<string, string> = { new: '규칙 검사 대기', approved: '발행 조건 확인 대상', needs_review: '보류', rejected: '거부', published: '발행 완료' };

function safeUrl(value: string | null) {
  try { const url = new URL(value ?? ''); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

/**
 * 목록에서 한눈에 재는 값. 펼치지 않아도 판단의 절반은 여기서 끝난다.
 *
 * 근거와 같은 출처(지금 다시 잰 값)를 쓴다 — 저장된 값을 쓰면 판정 당시의 숫자가 남아
 * 아래 근거의 숫자와 어긋난다 (판정 때 "푸시 0일"이던 것이 지금은 23일이다).
 */
function facts(entry: AdminReviewEntry) {
  const s = (entry.verdict?.signals ?? entry.candidate.signals ?? {}) as Record<string, unknown>;
  const num = (key: string) => (typeof s[key] === 'number' ? (s[key] as number) : null);
  const push = num('pushAgeDays');
  const status = num('pageStatus');
  return [
    `★ ${num('stars') ?? '—'}`,
    push === null ? '푸시 —' : `푸시 ${push}일`,
    status === null ? '응답 —' : `HTTP ${status}`,
    typeof s.ownerType === 'string' ? s.ownerType : '—',
  ];
}

/** 대기 일수 — 오래 묵은 것을 먼저 처리하려면 목록에서 보여야 한다 */
function waitingDays(entry: AdminReviewEntry): number | null {
  const at = entry.candidate.judgedAt ?? entry.candidate.updatedAt;
  return at ? Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000) : null;
}

export function ReviewItem({ entry, reasons, bulkFormId }: {
  entry: AdminReviewEntry; reasons: readonly Reason[]; bulkFormId?: string;
}) {
  const { candidate } = entry;
  const [state, action, pending] = useActionState<ReviewState, FormData>(decideCrawlCandidate, null);
  const [refresh, refreshAction, refreshing] = useActionState(collectCandidateEvidence, null);
  const canDecide = !!entry.inputHash && !!entry.sourceRevisionHash && candidate.state !== 'published' && !candidate.publishedSlug;
  const canCollect = canDecide && candidate.decidedBy === 'auto' && candidate.state === 'needs_review' && entry.refreshCount < 2;
  const productUrl = safeUrl(candidate.productUrl);
  const days = waitingDays(entry);
  // 일괄 선택은 툴바의 폼에 실린다. 폼을 겹칠 수 없으므로 form 속성으로 연결한다.
  const packed = packSelection({ repo: candidate.repo, inputHash: entry.inputHash,
    sourceRevisionHash: entry.sourceRevisionHash, candidateRevisionHash: entry.candidateRevisionHash });

  const identity = <>
    <input type="hidden" name="repo" value={candidate.repo} />
    <input type="hidden" name="inputHash" value={entry.inputHash ?? ''} />
    <input type="hidden" name="sourceRevisionHash" value={entry.sourceRevisionHash ?? ''} />
    <input type="hidden" name="candidateRevisionHash" value={entry.candidateRevisionHash} />
  </>;

  return (
    <li className="rounded-xl border border-line bg-bg-card">
      <div className="flex items-start gap-3 px-4 py-3">
        {bulkFormId && canDecide && (
          <input
            type="checkbox" name="selected" value={packed} form={bulkFormId}
            aria-label={`${entry.name} 선택`}
            className="mt-1 size-4 shrink-0 accent-accent"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[14.5px] font-bold">{entry.name}</span>
            <a href={`https://github.com/${candidate.repo}`} target="_blank" rel="noreferrer noopener"
              className="font-mono text-[13px] text-fg-3 hover:text-accent">{candidate.repo}</a>
            {days !== null && <span className="ml-auto text-[13px] text-fg-3">{days}일 대기</span>}
          </div>

          {entry.verdict?.cause && (
            <p className="mt-1.5 text-[13px] font-semibold text-down">{causeLabel(entry.verdict.cause)}</p>
          )}
          {/* AI가 갈랐으면 사유를 접지 않고 보여준다 — 묶어서 처리하려면 목록에서 읽혀야 한다 */}
          {entry.review?.decision === 'reject' && (
            <p className="mt-1.5 rounded-lg border border-down/40 bg-down/10 px-2.5 py-1.5 text-[13px] leading-[1.7] text-fg-2">
              <b className="font-semibold text-down">AI 거부</b>
              {entry.review.model ? <span className="ml-1.5 font-mono text-fg-3">{entry.review.model}</span> : null}
              {entry.review.reason ? <span className="ml-1.5">{entry.review.reason.slice(0, 220)}</span> : null}
            </p>
          )}
          {!entry.verdict?.cause && (
            <p className="mt-1.5 text-[13px] text-fg-2">
              {STATES[candidate.state]} · {candidate.reason ?? '사유 없음'} ·{' '}
              {candidate.decidedBy === 'admin' ? '관리자 결정' : STATUS[entry.status]}
            </p>
          )}

          <p className="mt-1.5 flex flex-wrap gap-x-4 font-mono text-[13px] text-fg-3">
            {facts(entry).map((fact) => <span key={fact}>{fact}</span>)}
          </p>
          {productUrl && (
            <a href={productUrl} target="_blank" rel="noreferrer noopener"
              className="mt-1.5 block break-all font-mono text-[13px] text-accent">{productUrl}</a>
          )}
        </div>
      </div>

      {/* 목록이 쌓여도 화면이 길어지지 않도록 접어 둔다. 판단에 필요한 것만 펼친다 */}
      <details className="border-t border-line px-4 py-3">
        <summary className="cursor-pointer text-[13px] font-semibold text-fg-2">
          근거와 결정 열기
        </summary>

        {entry.description && (
          <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-fg-2">{entry.description.slice(0, 1200)}</p>
        )}

        {entry.verdict
          ? <RuleTrace verdict={entry.verdict} />
          : <p className="mt-3 text-[13px] text-fg-3">원본이 없어 규칙을 되짚을 수 없습니다.</p>}

        <p className="mt-3 text-[13px] text-fg-3">저장소 연결: {entry.relationship} · 근거 수집: {entry.scanState}</p>

        {entry.latest && <div className="mt-3 rounded-lg bg-bg-soft p-3 text-[13px] leading-relaxed text-fg-2">
          <p className="font-semibold">{entry.latest.kind === 'admin_override' ? '관리자 결정 기록' : entry.latest.kind === 'evidence_refresh' ? '추가 수집 접수 기록' : '최근 AI·규칙 심사 기록'}</p>
          {entry.latest.kind === 'automatic' && <p>{entry.latest.provider ?? '실행기 미확인'}{entry.latest.model ? ` · ${entry.latest.model}` : ''} · {entry.latest.decision ?? entry.latest.state}</p>}
          {entry.latest.actor && <p>담당자: {entry.latest.actor}</p>}
          {entry.latest.reason && <p className="whitespace-pre-line">{entry.latest.reason}</p>}
          {entry.latest.error && <p className="text-down">실행 오류: {entry.latest.error}</p>}
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
      </details>
    </li>
  );
}
