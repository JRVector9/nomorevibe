'use client';

import { useState } from 'react';
import { POLICY_KEEP_DAYS, type PolicyKeepDays } from '@/lib/crawl/audit-policy-filter';
import type { KeepExtendPreview } from '@/lib/crawl/audit-policy';
import { useAdminToast } from '../components/Toast';
import { previewKeepExtendAction, startKeepExtendAction } from './policy-actions';
import { RunProgress } from './PolicyBuilder';
import { usePolicyRunLoop } from './policy-run-loop';

const n = (value: number) => value.toLocaleString('ko-KR');
const CONTENT = { same: '페이지 그대로', changed: '페이지 바뀜', no_source: '원본 없음' } as const;

/**
 * 곧 끝나는 유지(0116) — 유지는 90일 뒤 끝나 같은 판단을 다시 하게 된다. 다음 감사는 페이지 내용(source_hash)이 바뀐 것은 기한과 상관없이 다시 넣고,
 * 그대로인 것은 기한 안에서만 뺀다(startProductAudit liveKeptProducts). 그래서 페이지가 그대로인 유지만(기본) 기한을 늦추면 같은 판단을 되풀이하지 않고,
 * 바뀐 페이지는 다음 감사가 다시 본다. 미리보기 → 연장할 수를 그대로 적어 적용 → 실행째 되돌리기.
 */
export function KeepExtend({ expiring, withinDays }: { expiring: number; withinDays: number }) {
  const toast = useAdminToast();
  const [preview, setPreview] = useState<KeepExtendPreview | null>(null);
  const [unchangedOnly, setUnchangedOnly] = useState(true);
  const [days, setDays] = useState<PolicyKeepDays>(90);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = usePolicyRunLoop();

  const load = async (onlySame: boolean) => {
    setBusy(true); setProblem(null);
    try {
      const result = await previewKeepExtendAction(onlySame);
      if (!result.ok) setProblem(result.error);
      else { setPreview(result.value); setTyped(''); }
    } catch { setProblem('미리보기를 불러오지 못했습니다.'); } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true); setProblem(null);
    try {
      const result = await startKeepExtendAction({ days, unchangedOnly, expected: preview.eligible, note: '' });
      if (!result.ok) { setProblem(result.error); return; }
      await run.loop(result.value.runId, 'apply');
      toast.show({ message: `유지 연장 #${result.value.runId}을 마쳤거나 멈췄습니다`, tone: 'ok' });
      setPreview(null);
    } catch { setProblem('요청이 끊겼습니다. 실행 목록의 «이어서 적용»을 누르세요.'); } finally { setBusy(false); }
  };

  const running = busy || run.running;
  const input = 'rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]';
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-line bg-bg-card p-4 text-[13px]" aria-labelledby="audit-keep-title"
      data-dirty={preview || running ? true : undefined}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="audit-keep-title" className="text-[14.5px] font-bold">곧 끝나는 유지</h2>
        <span className="tabular-nums text-fg-2">{withinDays}일 안에 끝나는 유지 <b className="font-semibold">{n(expiring)}</b>건</span>
        <span className="text-fg-3">끝나면 다음 감사에 다시 들어 같은 판단을 되풀이합니다. 페이지가 바뀐 것은 기한과 상관없이 다시 봅니다.</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-9 items-center gap-1.5">
          <input type="checkbox" checked={unchangedOnly} disabled={running} className="size-4 accent-accent"
            onChange={(event) => { setUnchangedOnly(event.target.checked); setPreview(null); }} />
          페이지가 유지할 때와 같은 것만(기본)
        </label>
        <label className="flex items-center gap-1.5">늦출 기간
          <select value={days} disabled={running} onChange={(event) => setDays(Number(event.target.value) as PolicyKeepDays)} className={input}>
            {POLICY_KEEP_DAYS.map((value) => <option key={value} value={value}>{value}일</option>)}
          </select>
        </label>
        <button type="button" className="admin-button" disabled={running || expiring === 0} onClick={() => void load(unchangedOnly)}>
          {busy && !preview ? '세는 중…' : '연장 미리보기'}</button>
      </div>
      {problem && <p className="text-down" role="alert">{problem}</p>}
      {preview && <>
        <p className="tabular-nums text-fg-2">끝나는 유지 {n(preview.expiring)}건 — 페이지 그대로 {n(preview.same)} · 바뀜 {n(preview.changed)} · 원본 없음 {n(preview.noSource)}
          → 연장할 것 <b className="font-semibold text-accent">{n(preview.eligible)}</b>건</p>
        {preview.sample.length > 0 && <ul className="flex flex-col gap-0.5">
          {preview.sample.map((row) => (
            <li key={row.itemId}><a href={row.url} target="_blank" rel="noreferrer noopener" className="font-semibold hover:text-accent">{row.name}</a>
              <span className="text-fg-3"> · {n(row.daysLeft)}일 남음 · {CONTENT[row.content]}</span></li>
          ))}
        </ul>}
        {preview.eligible > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-soft p-3">
          <span className="font-semibold">{n(preview.eligible)}건을 {days}일 늦춥니다 — 이 수를 그대로 적어야 적용됩니다</span>
          <input value={typed} inputMode="numeric" onChange={(event) => setTyped(event.target.value)} placeholder={String(preview.eligible)}
            aria-label="연장할 수 다시 적기" className={`${input} w-[7rem] font-mono`} disabled={running} />
          <button type="button" className="admin-button" data-tone="primary" disabled={running || typed.trim() !== String(preview.eligible)} onClick={apply}>
            {running ? '적용 중…' : `${n(preview.eligible)}건 연장`}</button>
        </div>}
      </>}
      {run.progress && <RunProgress progress={run.progress} running={run.running} waiting={run.waiting} error={run.error} onStop={run.stop} />}
    </section>
  );
}
