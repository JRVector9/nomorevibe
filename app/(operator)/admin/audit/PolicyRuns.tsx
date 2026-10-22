'use client';

import { useState } from 'react';
import { POLICY_RUN_STATUS_LABELS, POLICY_SKIP_LABELS, POLICY_UNDO_BLOCK_LABELS } from '@/lib/crawl/audit-policy-filter';
import { ConfirmAction } from '../components/ConfirmAction';
import { useAdminToast } from '../components/Toast';
import { policyRunExceptionsAction, startPolicyUndoAction } from './policy-actions';
import { usePolicyRunLoop } from './policy-run-loop';
import { RunProgress } from './PolicyBuilder';

const n = (value: number) => value.toLocaleString('ko-KR');

export type PolicyRunRow = {
  id: number; kind: string; action: string; status: string; planned: number; note: string | null; createdBy: string; createdAt: string;
  appliedAt: string | null; undoBy: string | null; undoneAt: string | null; filterText: string; counts: Record<string, number>;
  /** 화면 이름 — 내리기·유지·보류 풀기·의견 올리기·유지 연장·m1 자동 유지·숨김 */
  label: string;
  /** 감사 두 번째 의견의 자동 실행(lib/crawl/audit-auto-close.ts)이면 그 행동 — 사람이 만든 실행은 null */
  auto?: 'keep' | 'hold' | null;
};

type Exception = { itemId: number; slug: string; state: string; reason: string | null; name: string | null; url: string | null };

/**
 * 정책 실행 목록(0116) — 누가 언제 어떤 거르기로 무엇을 했고 몇 건이 적용·건너뜀·되돌림·되돌리지 못함인지. 적용 중이면 '이어서 적용',
 * 적용했으면 '되돌리기'(확인 창), 되돌리는 중이면 '되돌리기 이어서'. 건너뛴 것·되돌리지 못한 것은 펼쳐서 이름·까닭을 본다.
 */
export function PolicyRuns({ runs }: { runs: PolicyRunRow[] }) {
  if (runs.length === 0) return <p className="rounded-[12px] border border-line bg-bg-card px-5 py-6 text-center text-[13px] text-fg-3">아직 정책 실행이 없습니다.</p>;
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-line bg-bg-card p-4" aria-labelledby="audit-policy-runs-title">
      <h2 id="audit-policy-runs-title" className="text-[14.5px] font-bold">정책 실행</h2>
      <ul className="flex flex-col divide-y divide-line">
        {runs.map((run) => <RunItem key={run.id} run={run} />)}
      </ul>
    </section>
  );
}

function RunItem({ run }: { run: PolicyRunRow }) {
  const toast = useAdminToast();
  const loop = usePolicyRunLoop();
  const [exceptions, setExceptions] = useState<Exception[] | null>(null);
  const count = (state: string) => run.counts[state] ?? 0;
  const live = loop.progress;
  const status = live?.status ?? run.status;
  const canResume = status === 'applying' && !loop.running;
  const canUndo = (status === 'applied' || status === 'applying') && !loop.running;
  const canResumeUndo = status === 'undoing' && !loop.running;
  const loadExceptions = async () => {
    if (exceptions) return;
    const result = await policyRunExceptionsAction(run.id);
    setExceptions(result.ok ? result.value : []);
  };
  const exceptionCount = count('skipped') + count('undo_blocked');
  return (
    <li className="flex flex-col gap-1.5 py-2.5 text-[13px]" data-dirty={loop.running || undefined}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <b className="font-semibold">정책 #{run.id} · {run.label}</b>
        <span className={`rounded px-1.5 py-0.5 font-semibold ${status === 'applying' || status === 'undoing' ? 'bg-warn/15 text-warn' : 'bg-bg-soft text-fg-2'}`}>
          {POLICY_RUN_STATUS_LABELS[status] ?? status}</span>
        <span className="text-fg-3">{run.createdAt} · {run.createdBy}{run.undoBy && ` · 되돌림 ${run.undoBy}${run.undoneAt ? ` ${run.undoneAt}` : ''}`}</span>
      </div>
      <p className="text-fg-2">{run.filterText}{run.note && <span className="text-fg-3"> — {run.note}</span>}</p>
      <p className="tabular-nums text-fg-2">계획 {n(run.planned)} · 적용 {n(count('applied') + count('undone') + count('undo_blocked'))} · 건너뜀 {n(count('skipped'))}
        {count('pending') > 0 && <> · <b className="font-semibold text-warn">남은 것 {n(count('pending'))}</b></>}
        {count('cancelled') > 0 && ` · 취소 ${n(count('cancelled'))}`}
        {(count('undone') > 0 || count('undo_blocked') > 0) && ` · 되돌림 ${n(count('undone'))} · 되돌리지 못함 ${n(count('undo_blocked'))}`}</p>
      {status === 'applying' && !loop.running && !live && <p className="text-warn">적용이 멈춰 있습니다 — 남은 것은 아직 손대지 않았습니다. 이어서 적용하거나 되돌리세요.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {canResume && <button type="button" className="admin-button" data-tone="primary" onClick={() => loop.loop(run.id, 'apply')}>이어서 적용</button>}
        {canResumeUndo && <button type="button" className="admin-button" data-tone="primary" onClick={() => loop.loop(run.id, 'undo')}>되돌리기 이어서</button>}
        {canUndo && <ConfirmAction tone="danger" title={`정책 #${run.id}(${run.label})을 되돌립니다`} confirmLabel="되돌리기"
          summary={<ul>
            {run.auto === 'hold' ? <li>이 실행이 숨긴 것만 되돌립니다 — 보류를 풀어 목록에 돌려놓고, 그 제품의 열린 항목에 &lsquo;풀었음&rsquo;을 적어 쓸기·자동 숨김이 다시 걸지 않게 합니다.
              Qwen 의견은 남아 다시 묻지 않습니다 — 사람이 봅니다.</li>
              : run.auto === 'keep' ? <li>이 실행이 자동으로 유지한 것만 되돌립니다 — 유지를 지우고 그때 풀었던 보류를 다시 겁니다. Qwen 의견은 남아 다시 묻지 않습니다 — 사람이 봅니다.</li>
              : <li>이 실행이 적용한 것만 실행 전 상태로 돌립니다 — 내림은 차단을 풀고, 유지·보류 풀기는 사람 결정을 지우고 풀었던 보류를 다시 겁니다.</li>}
            {run.auto && <li>지금까지 적힌 것만 되돌립니다. 되돌리는 동안·뒤에 자동으로 닫는 것은 새 실행에 적힙니다 — 멈추려면 감사 거절 탭에서 답으로 닫기를 끕니다.</li>}
            <li>그 뒤에 바뀐 것(다시 정함·차단 해제·보류가 다시 걸림·주인이 생김·유지 연장 등)은 손대지 않고 &lsquo;되돌리지 못함&rsquo;으로 까닭과 함께 남깁니다.</li>
            {status === 'applying' && <li>아직 적용하지 않은 {n(count('pending'))}건은 취소합니다.</li>}
            {run.kind === 'import' && <li>올린 의견은 덮어쓰기 전으로 돌립니다(없었으면 지움). 올린 거절 때문에 그 뒤 감사 잡이 건 보류는 풀지 않습니다 —
              필요하면 정책 처리의 &lsquo;보류 풀기&rsquo;로 고릅니다.</li>}
            <li>작업 로그에 한 줄 남습니다.</li>
          </ul>}
          onConfirm={async () => {
            const started = await startPolicyUndoAction(run.id);
            if (!started.ok) return started;
            loop.setProgress(started.value);
            void loop.loop(run.id, 'undo').then(() => toast.show({ message: `정책 #${run.id} 되돌리기를 마쳤거나 멈췄습니다`, tone: 'ok' }));
            return null;
          }}
          trigger={(open) => <button type="button" className="admin-button" onClick={open}>되돌리기…</button>} />}
        {exceptionCount > 0 && <details onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void loadExceptions(); }}>
          <summary className="cursor-pointer text-accent">건너뛴 것·되돌리지 못한 것 {n(exceptionCount)}건</summary>
          {exceptions === null ? <p className="text-fg-3">불러오는 중…</p> : (
            <ul className="mt-1 flex max-h-[320px] flex-col gap-0.5 overflow-y-auto">
              {exceptions.map((row) => (
                <li key={`${row.state}:${row.itemId}`}>
                  <span className={row.state === 'undo_blocked' ? 'font-semibold text-down' : 'text-fg-3'}>{row.state === 'undo_blocked' ? '되돌리지 못함' : '건너뜀'}</span>
                  {' · '}{row.url ? <a href={row.url} target="_blank" rel="noreferrer noopener" className="hover:text-accent">{row.name ?? row.slug}</a> : row.slug}
                  {' · '}<a href={`/admin/products/${row.slug}`} target="_blank" rel="noreferrer noopener" className="text-accent">관리자</a>
                  {' · '}<span className="text-fg-2">{(row.state === 'undo_blocked' ? POLICY_UNDO_BLOCK_LABELS : POLICY_SKIP_LABELS)[row.reason ?? ''] ?? row.reason ?? '—'}</span>
                </li>
              ))}
            </ul>
          )}
        </details>}
      </div>
      {live && <RunProgress progress={live} running={loop.running} waiting={loop.waiting} error={loop.error} onStop={loop.stop} />}
      {!live && loop.error && <p className="text-down" role="alert">{loop.error}</p>}
    </li>
  );
}
