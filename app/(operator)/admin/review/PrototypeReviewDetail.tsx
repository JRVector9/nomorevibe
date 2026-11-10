'use client';

import { useActionState, useEffect, useEffectEvent, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { AdminReviewEntry } from '@/lib/crawl/admin-review';
import type { StoppedAt } from '@/lib/crawl/rules';
import { formatDetailTime } from '@/lib/format/time';
import { decideCrawlCandidate } from '../actions';
import { REASON_LABELS, REVIEW_QUICK_REASONS } from '../reasons';
import { approveWithTagline, collectCandidateEvidence } from './actions';
import { RuleTrace } from './RuleTrace';
import { approvalNote, causeLabel, modelsAgree, recommendDecision } from './causes';
import { entryVersion, type ReviewDecisionState } from './contract';
import { ReasonText } from './ReasonText';
import { revealInPanel, reviewShortcut } from './shortcuts';
import { SPLIT_TIEBREAK_ACTOR, TIEBREAK_APPROVE_BADGE, tiebreakApproved, tiebreakDeepseekLine, tiebreakSummary } from './tiebreak';
import { DelegateOpinionBox } from './DelegateOpinion';

/** 성공한 한 건 결정 — 알림과 되돌리기가 쓴다 */
export type DecidedResult = Extract<NonNullable<ReviewDecisionState>, { ok: true }>;

type Reason = { value: string; label: string };
const STATUS = { unreviewed: '미심사', running: '심사 중', succeeded: '심사 완료', failed: '심사 실패 · 재시도 대기', exhausted: '재시도 소진 · 직접 확인 필요', outdated: '입력 변경 · 재심사 필요' };
const STATES: Record<string, string> = { new: '규칙 검사 대기', approved: '발행 조건 확인 대상', needs_review: '보류', rejected: '거부', published: '발행 완료' };
const VERDICT = {
  reject: { label: 'AI 거부', className: 'border-down/40 bg-down/10', text: 'text-down' },
  approve: { label: 'AI 승인', className: 'border-up/40 bg-up/10', text: 'text-up' },
  needs_review: { label: 'AI 보류', className: 'border-line bg-bg-soft', text: 'text-fg-2' },
} as const;

/** 거부·보류할 때 남긴 사유(rules.ts 의 StoppedAt). 이 값을 남기기 전의 기록에는 없다 */
export function stoppedAt(signals: Record<string, unknown> | null | undefined): StoppedAt | null {
  const value = signals?.stoppedAt as Partial<StoppedAt> | undefined;
  return typeof value?.rule === 'string' && typeof value.detail === 'string' ? { rule: value.rule, detail: value.detail } : null;
}

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

/** 오른쪽 상세. 표에서 고른 후보 하나의 근거와 결정. 결정이 기록되면 onDecided 로 알린다(알림·다음 줄은 표가 맡는다) */
export function PrototypeReviewDetail({ entry, reasons, onDecided }: {
  entry: AdminReviewEntry; reasons: readonly Reason[]; onDecided?: (result: DecidedResult) => void;
}) {
  const { candidate } = entry;
  // 보류 후보는 갈래 칩·목록과 같은 갈래(entry.bucket), 나머지는 지금 기준으로 다시 판정해 멈춘 곳
  const bucket = entry.bucket ?? entry.verdict?.cause ?? null;
  const [refresh, refreshAction, refreshing] = useActionState(collectCandidateEvidence, null);
  const [written, writeAction, writing] = useActionState(approveWithTagline, null);
  const canDecide = !!entry.inputHash && !!entry.sourceRevisionHash && candidate.state !== 'published' && !candidate.publishedSlug;
  const canCollect = canDecide && candidate.decidedBy === 'auto' && candidate.state === 'needs_review' && entry.refreshCount < 2;
  const productUrl = safeUrl(candidate.productUrl);
  const stop = stoppedAt(candidate.signals);
  const facts = entryFacts(entry);
  const verdict = entry.review?.decision && entry.review.decision in VERDICT ? VERDICT[entry.review.decision as keyof typeof VERDICT] : null;
  const ai = entry.review?.decision ?? null;
  const agree = modelsAgree(ai, entry.seconds);
  // 권장 결정 + 미리 쓴 사유(ADM-07) — 누르면 사유를 적지 않고 그대로 확정한다
  const recommendation = canDecide ? recommendDecision({ bucket: entry.bucket, ai, agree }) : null;
  /*
   * A/R 은 결정을 준비만 한다 — 승인은 두 모델이 같거나 AI 승인을 따르면 사유가 저절로 채워지고(ADM-11),
   * 거부는 사유를 골라야 한다(1~5 자주 쓰는 사유). ⌘/Ctrl+Enter 로 보낸다. 메모는 비워도 된다 — 서버가 고른 사유 이름을 남긴다.
   * 상세는 후보마다 새로 그려져(key) 고른 것이 다음 후보로 넘어가지 않는다.
   */
  const [intent, setIntent] = useState<'approve' | 'reject' | null>(null);
  /*
   * 본 판 — 처음 그린 후보의 해시. 다시 읽은 목록에서 같은 후보의 내용이 바뀌면(상세는 id 로만 새로 그린다) 새 내용을 보이되
   * "후보 내용이 바뀌었습니다"를 띄우고, 확인할 때까지 결정을 막는다. 결정은 본 판으로 보낸다(서버가 그 사이 바뀐 것을 거절한다).
   */
  const [seen, setSeen] = useState(() => ({ version: entryVersion(entry), inputHash: entry.inputHash ?? '',
    sourceRevisionHash: entry.sourceRevisionHash ?? '', candidateRevisionHash: entry.candidateRevisionHash }));
  const changed = seen.version !== entryVersion(entry);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startDecision] = useTransition();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);

  function decide(decision: 'approve' | 'reject', values: { reason: string; note: string } = { reason, note }) {
    if (pending) return;
    if (changed) { setError('후보 내용이 바뀌었습니다 — 바뀐 내용을 확인한 뒤 결정해 주세요.'); return; }
    if (decision === 'reject' && !values.reason) {
      setIntent('reject');
      setError('거부 사유를 골라주세요.');
      if (reasonRef.current) revealInPanel(reasonRef.current);
      return;
    }
    const form = new FormData();
    form.set('repo', candidate.repo);
    form.set('inputHash', seen.inputHash);
    form.set('sourceRevisionHash', seen.sourceRevisionHash);
    form.set('candidateRevisionHash', seen.candidateRevisionHash);
    form.set('decision', decision);
    form.set('reason', decision === 'reject' ? values.reason : '');
    // 승인 단추를 바로 눌러도 두 모델이 같거나 AI 승인을 따르는 것이면 그 사유로 남긴다
    form.set('note', values.note || (decision === 'approve' ? approvalNote(ai, agree) ?? '' : ''));
    setError(null);
    startDecision(async () => {
      const result = await decideCrawlCandidate(null, form);
      if (result?.ok) onDecided?.(result);
      else setError(result?.error ?? '처리하지 못했습니다 — 잠시 뒤 다시 해 주세요');
    });
  }
  function prepare(decision: 'approve' | 'reject') {
    setIntent(decision);
    setError(null);
    if (decision === 'approve') {
      const auto = approvalNote(ai, agree);
      if (auto && !note) setNote(auto);
      if (noteRef.current) revealInPanel(noteRef.current);
    } else if (reasonRef.current) revealInPanel(reasonRef.current);
  }
  function pickQuick(index: number) {
    const quick = REVIEW_QUICK_REASONS[index];
    if (!quick) return;
    setIntent('reject');
    setReason(quick.reason);
    setNote(quick.note);
    setError(null);
  }
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    const shortcut = reviewShortcut(event);
    if (shortcut?.kind === 'intent') { event.preventDefault(); prepare(shortcut.decision); }
    else if (shortcut?.kind === 'reason' && shortcut.index < REVIEW_QUICK_REASONS.length) { event.preventDefault(); pickQuick(shortcut.index); }
    else if (shortcut?.kind === 'submit' && intent) { event.preventDefault(); decide(intent); }
  });
  useEffect(() => {
    if (!canDecide) return;
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [canDecide]);

  const identity = <>
    <input type="hidden" name="repo" value={candidate.repo} />
    <input type="hidden" name="inputHash" value={seen.inputHash} />
    <input type="hidden" name="sourceRevisionHash" value={seen.sourceRevisionHash} />
    <input type="hidden" name="candidateRevisionHash" value={seen.candidateRevisionHash} />
  </>;
  function acceptChange() {
    setSeen({ version: entryVersion(entry), inputHash: entry.inputHash ?? '', sourceRevisionHash: entry.sourceRevisionHash ?? '',
      candidateRevisionHash: entry.candidateRevisionHash });
    setIntent(null);
    setError(null);
  }

  return <div className="stack" data-dirty={intent !== null || changed || !!note || !!reason || undefined}>
    {changed && <div className="notice amber" role="alert">후보 내용이 바뀌었습니다. 아래의 새 내용을 다시 읽은 뒤 결정하세요. <button className="text-button" onClick={acceptChange}>바뀐 내용 확인</button></div>}
    <div className="detail-header"><div><div className="eyebrow">C-{candidate.id} / 저장소 후보</div><h2>{entry.name}</h2><p>{candidate.repo} · 원본 {entry.sourceRevisionHash?.slice(0, 10) ?? "—"} · 후보 검수</p></div><span className={`tag ${candidate.state === "rejected" ? "red" : candidate.state === "approved" ? "green" : "amber"}`}>{STATES[candidate.state] ?? candidate.state}</span></div>
    <div className="evidence-box"><b>수집 원문 · 제품 소개</b><p>{entry.description ? `${entry.description.slice(0, 650)}${entry.description.length > 650 ? "…" : ""}` : "원문 소개 —"}</p><div className="flex"><a className="text-button" href={`https://github.com/${candidate.repo}`} target="_blank" rel="noreferrer noopener">저장소 원문 ↗</a>{productUrl && <a className="text-button" href={productUrl} target="_blank" rel="noreferrer noopener">제품 페이지 ↗</a>}</div></div>
    <div className="vote-grid"><div className="vote"><span className="small muted">AI 1차 · {entry.review?.model ?? "—"}</span><b>{verdict?.label ?? STATUS[entry.status] ?? "—"}</b><span className="tag gray">확신 {entry.review?.confidence?.toFixed(2) ?? "—"}</span><p>{entry.review?.reason ? <ReasonText text={entry.review.reason} korean={entry.review.reasonKo} limit={130} /> : "기록된 판단 사유 —"}</p></div><div className="vote"><span className="small muted">AI 2차 · {entry.seconds.length ? `${entry.seconds.length}개 판단 기록` : "—"}</span>{entry.seconds.length ? entry.seconds.map((vote, index) => <div key={index}><b>{vote.decision === "approve" ? "승인" : vote.decision === "reject" ? "반려 의견" : vote.decision === "needs_review" ? "보류" : vote.status === "pending" ? "판단 대기" : vote.status === "failed" ? "호출 실패" : vote.status}</b><p>{vote.model ?? "모델 —"} · {vote.echo ? "1차와 같은 모델 · 합의 제외" : vote.status === "agreed" ? "1차와 일치" : "독립 판단"}</p></div>) : <b>기록 —</b>}</div></div>
    {entry.delegate && <DelegateOpinionBox opinion={entry.delegate} />}
    <dl className="facts"><dt>확인 사유</dt><dd>{bucket ? causeLabel(bucket) : REASON_LABELS[candidate.reason ?? ""] ?? candidate.reason ?? "—"}</dd><dt>개발 근거</dt><dd>별 {facts.stars ?? "—"} · 최근 푸시 {facts.pushDays === null ? "—" : `${facts.pushDays}일 전`} · HTTP {facts.status ?? "—"}</dd><dt>다음 단계</dt><dd>{candidate.state === "approved" ? "분류·출처·중복·차단 검사 후 공개" : candidate.state === "published" ? "공개 프로젝트 상태 확인" : canDecide ? "판단 후 발행 대기 또는 반려 기록" : "자동 작업의 진행·완료 확인"}</dd></dl>
    {candidate.state === "approved" && <div className="notice blue"><p>발행 전 카테고리를 직접 지정하고 발행 조건의 재검토를 요청할 수 있습니다.</p><Link href="/admin/status?tab=manual" prefetch={false} className="button mt-sm">수동 카테고리 지정·발행 검토 열기 →</Link></div>}
    <details className="panel"><summary>원문·규칙·AI 근거·시도 이력</summary><div className="panel-body stack">
      {entry.description.length > 650 && <div className="evidence-box"><b>수집한 소개 전체</b><p>{entry.description}</p></div>}
      {entry.verdict ? <RuleTrace verdict={entry.verdict} /> : <p className="small muted">규칙 재판정 근거 —</p>}
      {stop && <p className="small">판정 당시 멈춘 곳: {stop.rule} · {stop.detail}</p>}
      {entry.seconds.map((vote, index) => <div className="evidence-box" key={index}><b>{vote.model ?? "모델 —"} · {vote.decision ?? vote.status}</b><p>{vote.reason ? <ReasonText text={vote.reason} korean={vote.reasonKo} /> : vote.errorCode ?? "사유 —"}</p></div>)}
      {entry.tiebreak && <div className="evidence-box"><b>{tiebreakApproved(entry.tiebreak) ? TIEBREAK_APPROVE_BADGE : "갈림 판가름"} · {entry.tiebreak.model}</b><p>{tiebreakSummary(entry.tiebreak)}</p><p>{entry.tiebreak.reason}</p>{tiebreakDeepseekLine(entry.tiebreak) && <p>{tiebreakDeepseekLine(entry.tiebreak)}</p>}{entry.tiebreak.deepseek?.reason && <p>{entry.tiebreak.deepseek.reason}</p>}</div>}
      {entry.latest && <div className="evidence-box"><b>최근 기록 · {entry.latest.kind === "admin_override" ? "관리자 결정" : entry.latest.actor === SPLIT_TIEBREAK_ACTOR ? "Qwen 판가름" : entry.latest.kind}</b><p>{entry.latest.actor ?? entry.latest.model ?? "—"} · {entry.latest.decision ?? entry.latest.state} · {formatDetailTime(entry.latest.at)}</p><p>{entry.latest.reason ? <ReasonText text={entry.latest.reason} korean={entry.latest.reasonKo} /> : "—"}</p>{entry.latest.error && <p className="error">{entry.latest.error}</p>}</div>}
      <p className="small muted">저장소 연결 {entry.relationship} · 근거 수집 {entry.scanState}</p><ul className="list-rows">{entry.evidence.map(item => <li key={item.id}>{safeUrl(item.url) ? <a className="text-button" href={safeUrl(item.url)!} target="_blank" rel="noreferrer noopener">{item.label}</a> : item.label}</li>)}</ul>
      {candidate.reason === "already_listed" && typeof candidate.signals?.existingSlug === "string" && <a className="text-button" href={`/admin/products/${encodeURIComponent(candidate.signals.existingSlug)}`}>중복된 기존 프로젝트 확인</a>}
    </div></details>
    {candidate.reason === "no_description" && <div className="notice amber"><b>한 줄 소개 확인</b><p>{entry.tagline?.text || (entry.tagline?.errorCode ? `AI 작성 실패 · ${entry.tagline.errorCode}` : "발행할 소개가 아직 없습니다.")}</p><p>소개 없이 승인하면 AI 작성 이후 발행 조건을 다시 확인합니다.</p>{canDecide && <form action={writeAction} className="field mt">{identity}<label>직접 확인한 한 줄 소개<input name="tagline" required minLength={5} maxLength={200} defaultValue={entry.tagline?.text || ""} /></label><button className="button" disabled={writing || changed}>이 소개로 승인</button></form>}{written && <p role="status">{written.error ?? written.message}</p>}</div>}
    {canDecide && <form onSubmit={event => { event.preventDefault(); const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; const decision = submitter?.value === "reject" ? "reject" : submitter?.value === "approve" ? "approve" : intent; if (decision) decide(decision); }}>
      <div className="field"><label>결정 사유<textarea ref={noteRef} value={note} onChange={event => { setNote(event.target.value); if (!intent) setIntent("approve"); }} maxLength={2000} rows={3} placeholder="확인한 근거와 판단 이유를 적어 주세요." /></label></div>
      <div className="field mt-sm"><label>반려 사유<select ref={reasonRef} aria-label="거부 사유 유형" value={reason} required={intent === "reject"} onChange={event => { setReason(event.target.value); if (event.target.value) setIntent("reject"); }}><option value="">사유 선택</option>{reasons.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}</select></label></div>
      <details className="mt-sm"><summary className="small muted">빠른 판단·자주 쓰는 사유</summary><div className="flex mt-sm">{REVIEW_QUICK_REASONS.map((quick, index) => <button className="button small" type="button" key={quick.note} onClick={() => pickQuick(index)}>{index + 1} · {quick.note}</button>)}{recommendation && <button className="button small" type="button" disabled={pending || refreshing || changed} onClick={() => decide(recommendation.decision, { reason: recommendation.decision === "reject" ? recommendation.reason : "", note: recommendation.note })}>권장대로 {recommendation.decision === "approve" ? "승인" : "반려"} · {recommendation.basis}</button>}</div></details>
      <div className="decision-bar"><button className="button primary" type="submit" value="approve" disabled={pending || refreshing || changed}>승인 → 발행 대기</button><button className="button" type="button" onClick={() => { setIntent(null); setError(null); }}>검토 유지</button><button className="button danger" type="submit" value="reject" disabled={pending || refreshing || changed}>반려</button>{pending && <span className="small muted">처리 중…</span>}</div>{error && <p role="alert" className="error">{error}</p>}
    </form>}
    {canCollect && <details><summary className="small muted">추가 원본·근거 수집 요청</summary><form action={refreshAction} className="field mt">{identity}<label>추가 근거가 필요한 이유<input name="note" required maxLength={2000} /></label><button disabled={refreshing || pending || changed} className="button">추가 수집 요청 ({entry.refreshCount}/2)</button></form>{refresh && <p role="status" className="small">{refresh.error ?? refresh.message}</p>}</details>}
    {candidate.publishedSlug && <a className="text-button" href={`/admin/products/${candidate.publishedSlug}`}>발행된 프로젝트 관리 →</a>}
    <p className="small muted">승인은 발행 완료가 아닙니다. 실제 목록 반영과 후처리 결과를 이어서 확인합니다. 지금 결정하지 않으면 현재 상태가 유지됩니다.</p>
  </div>;
}
