'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { ConfirmAction } from '../../components/ConfirmAction';
import { useAdminToast } from '../../components/Toast';
import { candidateHref, HUMAN_BATCH_GUIDE, HUMAN_BATCH_LOG_ANCHOR, HUMAN_BATCH_SAMPLE_SIZE, humanBatchConfirmLines, humanBatchResultLine,
  type HumanBatchGateView, type HumanBatchKey, type HumanBatchResult, type HumanBatchVerdict } from '@/lib/crawl/human-batch-model';
import type { HumanBatchSampleCard } from '@/lib/operations/human-batches-read';
import { markHumanBatchSampleAction, runHumanBatchAction, startHumanBatchSampleAction, undoHumanBatchAction, type HumanBatchActionState } from './actions';

const n = (value: number) => value.toLocaleString('ko-KR');
const DECISION: Record<string, string> = { approve: '승인', reject: '거절', needs_review: '보류' };
const decisionText = (value: string | null) => value ? DECISION[value] ?? value : '—';

export type BatchGateProps = {
  batchKey: HumanBatchKey;
  /** 지금 묶음 수(못 읽으면 null) */
  memberCount: number | null;
  /** 운영자의 마지막 관문 줄 — 없거나 실행한 줄이면 새 표본부터 */
  gate: { id: number; sampleIds: number[]; verdicts: Record<string, HumanBatchVerdict>; executed: boolean; result: HumanBatchResult | null } | null;
  view: HumanBatchGateView | null;
  cards: HumanBatchSampleCard[];
  /** 일괄 대상의 저장소 이름 — 저장 전 확인에 훑게 보인다 */
  targetRepos: string[];
  reasons: readonly { value: string; label: string }[];
};

/**
 * 표본 확인 관문(시안 「흐름 5」 1~3번) — 무작위 표본을 한 건씩 열어 「맞음/아님」을 누르고, 모두 맞을 때만 일괄 단추가 켜진다.
 * 하나라도 「아님」이면 단추는 꺼지고 그 건은 따로 보인다(다음 표본에서도 뺀다). 일괄 실행은 저장 전 확인(몇 건·다음 단계·되돌리는 방법)을 거친다.
 * 표본·판정은 서버(human_batch_gates)에 남으므로 새로고침해도 그대로다.
 */
export function BatchGate({ batchKey, memberCount, gate, view, cards, targetRepos, reasons }: BatchGateProps) {
  const guide = HUMAN_BATCH_GUIDE[batchKey];
  const toast = useAdminToast();
  const [pending, startTransition] = useTransition();
  const [picked, setPicked] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const active = gate && !gate.executed && view ? { gate, view } : null;

  const report = (result: HumanBatchActionState, success?: string) => {
    if ('error' in result) toast.show({ message: result.error, tone: 'error' });
    else if (success !== '') toast.show({ message: success ?? result.message });
  };
  const start = () => startTransition(async () => { setPicked(null); report(await startHumanBatchSampleAction(batchKey)); });
  const mark = (candidateId: number, verdict: HumanBatchVerdict) => startTransition(async () => {
    report(await markHumanBatchSampleAction(active!.gate.id, candidateId, verdict), '');
    setPicked(null);
  });

  if (!active) {
    const size = memberCount === null ? HUMAN_BATCH_SAMPLE_SIZE : Math.min(HUMAN_BATCH_SAMPLE_SIZE, memberCount);
    return <div className="hb-gate">
      {gate?.executed && <p className="hb-last">지난 일괄 · {gate.result ? humanBatchResultLine(gate.result) : '처리 중이거나 결과를 남기지 못함'}
        {' · '}<a className="text-button" href={`#${HUMAN_BATCH_LOG_ANCHOR}`}>기록 보기</a></p>}
      <div className="hb-acts">
        <button type="button" className="button small primary" disabled={pending || !size} onClick={start}>
          {pending ? '뽑는 중…' : `표본 ${n(size)}건 열어 보기`}</button>
        <span className="hb-hint">무작위로 뽑은 표본이 모두 맞을 때만 한 번에 {guide.verb}할 수 있습니다.</span>
      </div>
    </div>;
  }

  const { view: state } = active;
  const byId = new Map(cards.map(card => [card.id, card]));
  const verdict = (id: number) => active.gate.verdicts[String(id)];
  const openId = picked ?? state.pendingIds[0] ?? null;
  const card = openId === null ? null : byId.get(openId) ?? null;
  const blocked = state.open ? null : state.unknownCurrent ? '지금 묶음을 읽지 못해 꺼져 있습니다.'
    : state.wrongIds.length ? '「아님」이 있어 꺼졌습니다. 그 건은 하나씩 보고, 나머지는 표본을 다시 뽑습니다.'
    : state.pendingIds.length ? `표본을 모두 보면 켜집니다(${n(state.pendingIds.length)}건 남음).`
    : '지금 결정할 대상이 없습니다.';
  return <div className="hb-gate">
    <p className="hb-progress">표본 {n(state.sampleSize)}건 중 {n(state.judged)}건 봄 · 맞음 {n(state.ok)} · 아님 {n(state.wrongIds.length)}</p>
    <ol className="hb-picks" aria-label="표본">
      {active.gate.sampleIds.map((id, index) => {
        const mark = verdict(id);
        return <li key={id} data-verdict={mark ?? 'none'} data-open={id === openId || undefined}>
          <button type="button" onClick={() => setPicked(id)} aria-current={id === openId ? 'true' : undefined}>
            <i aria-hidden="true" /><span className="hb-pick-n">{index + 1}</span>
            <span className="hb-pick-name">{byId.get(id)?.repo ?? `후보 ${id}`}</span>
            <span className="hb-pick-state">{mark === 'ok' ? '맞음' : mark === 'wrong' ? '아님' : '아직'}</span>
          </button>
        </li>;
      })}
    </ol>
    {card ? <SampleCard card={card} index={active.gate.sampleIds.indexOf(card.id) + 1} total={state.sampleSize} verdict={verdict(card.id) ?? null}
      verb={guide.verb} pending={pending} onMark={value => mark(card.id, value)} />
      : openId !== null && <p className="hb-note">이 표본을 읽지 못했습니다 — <Link prefetch={false} className="text-button" href={candidateHref(openId)}>상세 열기</Link></p>}
    {state.wrongIds.length > 0 && <div className="hb-wrong" role="note">
      <b>아님으로 본 {n(state.wrongIds.length)}건 — 일괄에서 빠집니다</b>
      <ul>{state.wrongIds.map(id => <li key={id}><Link prefetch={false} className="text-button" href={candidateHref(id)}>{byId.get(id)?.repo ?? `후보 ${id}`}</Link> 하나씩 보기</li>)}</ul>
    </div>}
    {state.added > 0 && <p className="hb-note">표본을 뽑은 뒤 들어온 {n(state.added)}건은 이번 일괄에 넣지 않습니다.</p>}
    <div className="hb-acts">
      <button type="button" className="button small primary" disabled={!state.open || pending} onClick={() => setConfirming(true)}>
        {n(state.targets.length)}건 {guide.verb}</button>
      <button type="button" className="button small" disabled={pending} onClick={start}>표본 다시 뽑기</button>
      {blocked && <span className="hb-hint">{blocked}</span>}
    </div>
    {confirming && <ConfirmAction open onOpenChange={open => { if (!open) setConfirming(false); }}
      title={`${n(state.targets.length)}건을 ${guide.verb}합니다`} targets={targetRepos}
      summary={<ul className="hb-confirm">{humanBatchConfirmLines(batchKey, state).map(line => <li key={line}>{line}</li>)}</ul>}
      confirmLabel={guide.verb} tone={guide.decision === 'reject' ? 'danger' : 'neutral'}
      reasons={guide.decision === 'reject' ? { label: '거절 사유', options: reasons } : undefined}
      note={{ label: '메모', optional: true, maxLength: 2000, placeholder: `${guide.note} — 비우면 이렇게 기록합니다` }}
      onConfirm={async values => {
        const result = await runHumanBatchAction(active.gate.id, values);
        if ('error' in result) return result;
        const gateId = active.gate.id;
        toast.show({ message: result.message, tone: 'ok', link: { label: '기록 보기', href: `#${HUMAN_BATCH_LOG_ANCHOR}` },
          undo: { label: '묶음째 되돌리기', run: () => undoHumanBatchAction(gateId) } });
        return null;
      }} />}
  </div>;
}

function SampleCard({ card, index, total, verdict, verb, pending, onMark }: {
  card: HumanBatchSampleCard; index: number; total: number; verdict: HumanBatchVerdict | null; verb: string; pending: boolean;
  onMark: (verdict: HumanBatchVerdict) => void;
}) {
  const settled = card.state !== 'needs_review';
  return <article className="hb-card" aria-label={`표본 ${index}/${total}`}>
    <header><span className="hb-card-n">{index}/{total}</span><h4>{card.name}</h4>
      <Link prefetch={false} className="text-button" href={candidateHref(card.id)} target="_blank">상세 열기 ↗</Link></header>
    <p className="hb-links"><a className="text-button" href={`https://github.com/${card.repo}`} target="_blank" rel="noreferrer noopener">{card.repo} ↗</a>
      {card.productUrl && /^https?:\/\//.test(card.productUrl) && <a className="text-button" href={card.productUrl} target="_blank" rel="noreferrer noopener">제품 페이지 ↗</a>}</p>
    {settled && <p className="hb-note">표본을 뽑은 뒤 다른 곳에서 처리됐습니다(지금 {card.state}).</p>}
    <dl className="hb-facts">
      <dt>소개</dt><dd>{card.intro ?? '—'}</dd>
      {card.stopped && <><dt>멈춘 곳</dt><dd>{card.stopped}</dd></>}
      <dt>1차 AI</dt><dd>{card.first ? <>{decisionText(card.first.decision)}{card.first.confidence !== null ? ` · 확신 ${card.first.confidence.toFixed(2)}` : ''}
        {card.first.reason && <span className="hb-reason">{card.first.reason}</span>}</> : '—'}</dd>
      {card.seconds.map((vote, position) => <div key={position} className="hb-fact-row"><dt>2차</dt>
        <dd>{decisionText(vote.decision)}{vote.model ? ` · ${vote.model}` : ''}{vote.reason && <span className="hb-reason">{vote.reason}</span>}</dd></div>)}
      {card.delegate && <><dt>AI 위임</dt><dd>{card.delegate.leaning}{card.delegate.confidence !== null ? ` · 확신 ${card.delegate.confidence.toFixed(2)}` : ''}
        <span className="hb-reason">{card.delegate.cause}</span></dd></>}
    </dl>
    <div className="hb-acts">
      <button type="button" className="button small" data-on={verdict === 'ok' || undefined} disabled={pending} onClick={() => onMark('ok')}
        aria-pressed={verdict === 'ok'}>맞음 · {verb}해도 됨</button>
      <button type="button" className="button small" data-on={verdict === 'wrong' || undefined} disabled={pending} onClick={() => onMark('wrong')}
        aria-pressed={verdict === 'wrong'}>아님</button>
    </div>
  </article>;
}
