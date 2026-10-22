'use client';

import { useState } from 'react';
import { AUDIT_REASON_CATEGORIES, AUDIT_REASON_KEYS, type AuditReasonCategory } from '@/lib/crawl/audit-reason-category';
import { EMPTY_POLICY_FILTER, POLICY_ACTION_LABELS, POLICY_KEEP_DAYS, POLICY_SCREEN, POLICY_SCREEN_LABELS, POLICY_SECOND, POLICY_SECOND_LABELS,
  POLICY_SKIP_LABELS, type PolicyAction, type PolicyFilter, type PolicyKeepDays } from '@/lib/crawl/audit-policy-filter';
import { THIN_PAGE_TEXT_CHARS } from '@/lib/crawl/second-opinion-rules';
import type { PolicyPreview, PolicyPreviewRow } from '@/lib/crawl/audit-policy';
import { useAdminToast } from '../components/Toast';
import { previewAuditPolicyAction, startPolicyRunAction } from './policy-actions';
import { progressRatio, progressText, usePolicyRunLoop } from './policy-run-loop';
import { secondOpinionLabel } from './second-opinion-label';

const n = (value: number) => value.toLocaleString('ko-KR');
type Choice = PolicyAction | 'none';

export type PolicyPreset = { key: string; label: string; hint: string; filter: Partial<PolicyFilter>; action: Choice };

/**
 * 정책 처리의 거르기·미리보기·적용(0116). 거르기를 바꾸면 미리보기를 버린다 — 적용은 지금 화면이 미리 본 그 거르기·그 수로만.
 * 적용은 손댈 수를 그대로 적어야 열린다. 누르면 서버가 같은 거르기로 다시 골라 수가 같을 때만 실행을 만들고, 화면이 끝날 때까지 나눠 부른다.
 * '그대로 둠'은 미리보기만 하고 아무것도 하지 않는다. 미리보기가 있거나 도는 동안은 자동 갱신을 멈춘다(data-dirty).
 */
export function PolicyBuilder({ reviewers, sources, presets, initialPreset }: {
  reviewers: { key: string; provider: string; model: string; count: number }[];
  sources: { source: string; count: number }[];
  presets: PolicyPreset[];
  /** 처음 채울 자주 쓰는 거르기(?preset=) — 감사 탭의 보류 칸이 '보류 골라 풀기·유지'로 연다 */
  initialPreset?: string | null;
}) {
  const toast = useAdminToast();
  const initial = presets.find((preset) => preset.key === initialPreset) ?? null;
  const [filter, setFilterState] = useState<PolicyFilter>(initial ? { ...EMPTY_POLICY_FILTER, ...initial.filter } : EMPTY_POLICY_FILTER);
  const [action, setActionState] = useState<Choice>(initial?.action ?? 'none');
  const [preview, setPreview] = useState<PolicyPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [keepDays, setKeepDays] = useState<PolicyKeepDays>(90);
  const [starting, setStarting] = useState(false);
  const run = usePolicyRunLoop();

  const reset = () => { setPreview(null); setTyped(''); setProblem(null); };
  const setFilter = (next: Partial<PolicyFilter>) => { setFilterState((now) => ({ ...now, ...next })); reset(); };
  const setAction = (next: Choice) => { setActionState(next); reset(); };
  const toggle = <T,>(list: readonly T[], value: T) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const number = (value: string) => value.trim() === '' ? null : Number(value);

  const runPreview = async () => {
    setPreviewing(true);
    setProblem(null);
    try {
      // '그대로 둠'도 무엇이 남는지 보려면 유지와 같은 셈(건너뛰는 것 없음)으로 본다
      const result = await previewAuditPolicyAction({ filter, action: action === 'none' ? 'keep' : action });
      if (!result.ok) setProblem(result.error);
      else { setPreview(result.value); setTyped(''); }
    } catch {
      setProblem('미리보기를 불러오지 못했습니다. 거르기 값을 확인하고 다시 눌러 주세요.');
    } finally { setPreviewing(false); }
  };

  const apply = async () => {
    if (!preview || action === 'none') return;
    setStarting(true);
    setProblem(null);
    try {
      const result = await startPolicyRunAction({ filter, action, expected: preview.eligible, note, keepDays });
      if (!result.ok) { setProblem(result.error); return; }
      run.setProgress(null);
      await run.loop(result.value.runId, 'apply');
      toast.show({ message: `정책 #${result.value.runId} 적용을 마쳤거나 멈췄습니다 — 실행 목록에서 결과를 보세요`, tone: 'ok',
        link: { label: '작업 로그', href: '/admin/activity?group=takedown' } });
    } catch {
      setProblem('요청이 끊겼습니다. 실행 목록의 «이어서 적용»을 누르면 남은 것부터 잇습니다.');
    } finally { setStarting(false); }
  };

  const busy = starting || run.running;
  const canApply = Boolean(preview) && action !== 'none' && preview!.eligible > 0 && typed.trim() === String(preview!.eligible) && !busy;
  const input = 'rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]';
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-bg-card p-4" aria-labelledby="audit-policy-title"
      data-dirty={preview || busy ? true : undefined}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="audit-policy-title" className="text-[14.5px] font-bold">정책으로 닫기</h2>
        <span className="text-[13px] text-fg-3">거르기 → 미리보기(수·갈래·표본·건너뛸 것) → 수를 적어 적용 → 필요하면 실행 하나를 통째로 되돌리기</span>
      </div>

      {presets.length > 0 && <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13px] font-semibold text-fg-3">자주 쓰는 거르기</span>
        {presets.map((preset) => (
          <button key={preset.key} type="button" title={preset.hint} disabled={busy}
            onClick={() => { setFilterState({ ...EMPTY_POLICY_FILTER, ...preset.filter }); setActionState(preset.action); reset(); }}
            className="min-h-9 rounded-full border border-line bg-bg-soft px-2.5 py-1 text-[13px] text-fg-2 hover:bg-bg-hover disabled:opacity-50">
            {preset.label}</button>
        ))}
      </div>}

      <fieldset disabled={busy} className="grid gap-x-4 gap-y-2 text-[13px] text-fg-2 md:grid-cols-2">
        <legend className="sr-only">거르기</legend>
        <div className="flex flex-col gap-1">
          <span className="font-semibold text-fg-3">감사 답을 낸 모델</span>
          <div className="flex flex-wrap gap-x-3">
            {reviewers.length === 0 && <span className="text-fg-3">열린 거절이 없습니다</span>}
            {reviewers.map((reviewer) => (
              <label key={reviewer.key} className="flex min-h-9 items-center gap-1.5">
                <input type="checkbox" checked={filter.reviewers.includes(reviewer.key)} className="size-4 accent-accent"
                  onChange={() => setFilter({ reviewers: toggle(filter.reviewers, reviewer.key) })} />
                {reviewer.model} <span className="font-mono text-fg-3">{reviewer.provider} · {n(reviewer.count)}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg-3">확신</span>
          <input type="number" min={0} max={1} step={0.01} value={filter.confidenceMin ?? ''} aria-label="확신 이상" placeholder="0.00"
            onChange={(event) => setFilter({ confidenceMin: number(event.target.value) })} className={`${input} w-[5.5rem] font-mono`} />
          이상
          <input type="number" min={0} max={1} step={0.01} value={filter.confidenceBelow ?? ''} aria-label="확신 미만" placeholder="1.00"
            onChange={(event) => setFilter({ confidenceBelow: number(event.target.value) })} className={`${input} w-[5.5rem] font-mono`} />
          미만(1이면 1.00 포함)
        </div>
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg-3">보류</span>
          <select value={filter.held} onChange={(event) => setFilter({ held: event.target.value as PolicyFilter['held'] })} className={input}>
            <option value="any">가리지 않음</option><option value="held">보류 중(목록에서 빠짐)</option><option value="not_held">보류 아님(목록에 떠 있음)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg-3">두 번째 의견</span>
          <select value={filter.second} aria-label="두 번째 의견" onChange={(event) => setFilter({ second: event.target.value as PolicyFilter['second'] })} className={input}>
            {POLICY_SECOND.map((key) => <option key={key} value={key}>{POLICY_SECOND_LABELS[key]}</option>)}
          </select>
          <select value={filter.secondSource ?? ''} aria-label="두 번째 의견 출처" onChange={(event) => setFilter({ secondSource: event.target.value || null })} className={input}>
            <option value="">모든 출처</option>
            {sources.map((source) => <option key={source.source} value={source.source}>{source.source} ({n(source.count)})</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1 md:col-span-2">
          <span className="font-semibold text-fg-3">사유 갈래(비우면 모두)</span>
          <div className="flex flex-wrap gap-x-3">
            {AUDIT_REASON_KEYS.map((key) => (
              <label key={key} title={AUDIT_REASON_CATEGORIES[key].hint} className="flex min-h-9 items-center gap-1.5">
                <input type="checkbox" checked={filter.branches.includes(key)} className="size-4 accent-accent"
                  onChange={() => setFilter({ branches: toggle<AuditReasonCategory>(filter.branches, key) })} />
                {AUDIT_REASON_CATEGORIES[key].label}
              </label>
            ))}
          </div>
        </div>
        <label className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg-3">주인</span>
          <select value={filter.owner} onChange={(event) => setFilter({ owner: event.target.value as PolicyFilter['owner'] })} className={input}>
            <option value="any">가리지 않음</option><option value="unowned">주인 없음(수집분)</option><option value="owned">주인 있음(클레임·검증·메이커)</option>
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg-3">기다린 날</span>
          <input type="number" min={0} step={1} value={filter.waitMinDays ?? ''} aria-label="기다린 날 이상" placeholder="0"
            onChange={(event) => setFilter({ waitMinDays: number(event.target.value) })} className={`${input} w-[4.5rem] font-mono`} />
          일 넘게 ·
          <input type="number" min={0} step={1} value={filter.waitMaxDays ?? ''} aria-label="기다린 날 미만" placeholder="—"
            onChange={(event) => setFilter({ waitMaxDays: number(event.target.value) })} className={`${input} w-[4.5rem] font-mono`} />
          일 안
        </div>
        <label className="flex flex-wrap items-center gap-2" title={`수집한 페이지 글이 ${THIN_PAGE_TEXT_CHARS}자 아래(원본 없음 포함)면 글만 본 m1 은 닫지 않습니다 — 화면 판정을 기다립니다`}>
          <span className="font-semibold text-fg-3">페이지 글(화면 판별)</span>
          <select value={filter.screen} onChange={(event) => setFilter({ screen: event.target.value as PolicyFilter['screen'] })} className={input}>
            {POLICY_SCREEN.map((key) => <option key={key} value={key}>{POLICY_SCREEN_LABELS[key]}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-fg-3">제품 상태</span>
          {(['seeded', 'verified'] as const).map((status) => (
            <label key={status} className="flex min-h-9 items-center gap-1.5">
              <input type="checkbox" checked={filter.statuses.includes(status)} className="size-4 accent-accent"
                onChange={() => setFilter({ statuses: toggle(filter.statuses, status) })} />
              {status === 'seeded' ? '수집 공개(seeded)' : '검증됨(verified)'}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3 text-[13px]">
        <span className="font-semibold text-fg-3">할 일</span>
        {(['none', 'keep', 'remove', 'release'] as Choice[]).map((choice) => (
          <label key={choice} className="flex min-h-9 items-center gap-1.5">
            <input type="radio" name="policy-action" checked={action === choice} disabled={busy} onChange={() => setAction(choice)} className="size-4 accent-accent" />
            {choice === 'none' ? '그대로 둠(미리보기만)' : POLICY_ACTION_LABELS[choice]}
          </label>
        ))}
        <button type="button" className="admin-button" data-tone="primary" onClick={runPreview} disabled={previewing || busy}>
          {previewing ? '세는 중…' : '미리보기'}</button>
      </div>
      {action === 'remove' && <p className="text-[13px] text-fg-3">내리기는 지금 묶어 내리기와 같은 문턱만 손댑니다 — 확신 0.95 이상 · 주인 없음 ·
        갈림 아님 · 두 번째 모델이 승인하지 않음. 나머지는 미리보기에 건너뛸 것으로 까닭과 함께 보입니다. 되돌리기는 차단을 풀고 보류를 다시 겁니다.</p>}
      {action === 'keep' && <p className="text-[13px] text-fg-3">유지는 사람의 유지와 같습니다 — 보류 중이면 풀어 목록에 돌려놓고, 기한 동안·페이지 내용이 그대로인
        동안 다음 감사에서 뺍니다(내용이 바뀌면 기한과 상관없이 다시 봅니다).</p>}
      {action === 'release' && <p className="text-[13px] text-fg-3">보류 풀기는 &lsquo;보류 모두 풀기&rsquo;의 고른 판입니다 — 고른 보류만 풀어 목록에 돌려놓고 같은 항목으로 다시
        보류하지 않습니다. 사람 결정은 남기지 않아 감사 거절 목록에는 그대로 남습니다. 보류 중이 아닌 것은 건너뜁니다. 되돌리면 원래 시각·항목으로 다시 보류합니다.</p>}
      {problem && <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] text-down" role="alert">{problem}</p>}

      {preview && <PreviewPanel preview={preview} action={action} />}

      {preview && action !== 'none' && preview.eligible > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-bg-soft p-3 text-[13px]">
          <p className="font-semibold">{POLICY_ACTION_LABELS[action]} {n(preview.eligible)}건 — 이 수를 그대로 적어야 적용됩니다</p>
          <div className="flex flex-wrap items-center gap-2">
            {action === 'keep' && <label className="flex items-center gap-1.5">유지 기간
              <select value={keepDays} onChange={(event) => setKeepDays(Number(event.target.value) as PolicyKeepDays)} className={input} disabled={busy}>
                {POLICY_KEEP_DAYS.map((days) => <option key={days} value={days}>{days}일</option>)}
              </select></label>}
            <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="까닭 (선택 · 작업 로그와 사람 결정 메모에 남습니다)"
              className={`${input} min-w-[16rem] flex-1`} disabled={busy} />
            <input value={typed} inputMode="numeric" onChange={(event) => setTyped(event.target.value)} placeholder={String(preview.eligible)}
              aria-label="손댈 수 다시 적기" className={`${input} w-[7rem] font-mono`} disabled={busy} />
            <button type="button" className="admin-button" data-tone={action === 'remove' ? 'danger' : 'primary'} disabled={!canApply} onClick={apply}>
              {busy ? '적용 중…' : `${n(preview.eligible)}건 ${action === 'remove' ? '내리기' : action === 'release' ? '보류 풀기' : '유지'}`}</button>
          </div>
        </div>
      )}
      {run.progress && <RunProgress progress={run.progress} running={run.running} waiting={run.waiting} error={run.error} onStop={run.stop} />}
      {!run.progress && run.error && <p className="text-[13px] text-down" role="alert">{run.error}</p>}
    </section>
  );
}

export function RunProgress({ progress, running, waiting, error, onStop }: {
  progress: NonNullable<ReturnType<typeof usePolicyRunLoop>['progress']>; running: boolean; waiting: string | null; error: string | null; onStop: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-[13px]" aria-live="polite">
      <div className="h-2 overflow-hidden rounded-full bg-bg-soft" role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(progressRatio(progress) * 100)}>
        <div className="h-full bg-accent" style={{ width: `${Math.round(progressRatio(progress) * 100)}%` }} />
      </div>
      <p className="tabular-nums text-fg-2">정책 #{progress.runId} · {progressText(progress)}{progress.done ? ' — 끝' : running ? ' — 진행 중' : ' — 멈춤'}</p>
      {waiting && <p className="text-warn">{waiting}</p>}
      {error && <p className="text-down" role="alert">{error}</p>}
      {running && <button type="button" className="admin-button self-start" onClick={onStop}>지금 묶음 뒤 멈춤</button>}
    </div>
  );
}

/** 미리보기 — 수·갈래별·건너뛸 것(까닭마다 예)·층별 표본 스무 줄 */
function PreviewPanel({ preview, action }: { preview: PolicyPreview; action: Choice }) {
  const skipped = preview.skipped.reduce((sum, group) => sum + group.count, 0);
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3 text-[13px]">
      <p className="tabular-nums text-fg-2">
        <b className="font-semibold">{preview.filterText}</b> — 거르기에 든 것 <b className="font-semibold">{n(preview.matched)}</b>건 ·
        {action === 'none' ? ' 아무것도 하지 않습니다' : <> {action === 'remove' ? '내릴' : action === 'release' ? '보류를 풀' : '유지할'} 것 <b className="font-semibold text-accent">{n(preview.eligible)}</b>건
          (그중 보류 중 {n(preview.eligibleHeld)}) · 건너뛸 것 {n(skipped)}건</>}
        {preview.oldestWaitDays !== null && ` · 가장 오래 기다린 것 ${n(preview.oldestWaitDays)}일`}
        {preview.latestCampaignId && ` · 감사 #${preview.latestCampaignId}`}
      </p>
      {preview.byBranch.length > 0 && (
        <table className="w-full max-w-[560px] text-left">
          <thead className="text-fg-3"><tr><th className="py-1 font-semibold">사유 갈래</th><th className="py-1 text-right font-semibold">거르기에 든 것</th>
            <th className="py-1 text-right font-semibold">손댈 것</th></tr></thead>
          <tbody className="tabular-nums">{preview.byBranch.map((row) => (
            <tr key={row.branch} className="border-t border-line"><td className="py-1">{row.label}</td><td className="py-1 text-right">{n(row.matched)}</td>
              <td className="py-1 text-right">{n(row.eligible)}</td></tr>))}</tbody>
        </table>
      )}
      {preview.skipped.length > 0 && action !== 'none' && (
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-fg-3">건너뛸 것과 까닭</p>
          {preview.skipped.map((group) => (
            <details key={group.reason} className="rounded-lg border border-line px-3 py-1.5">
              <summary className="cursor-pointer">{POLICY_SKIP_LABELS[group.reason] ?? group.reason} — <b className="font-semibold">{n(group.count)}</b>건</summary>
              <ul className="mt-1 flex flex-col gap-0.5">{group.examples.map((row) => <li key={row.itemId}><RowLinks row={row} /></li>)}</ul>
            </details>
          ))}
        </div>
      )}
      {preview.sample.length > 0 && (
        <div className="relative overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[760px] text-left">
            <caption className="px-3 py-1.5 text-left font-semibold text-fg-3">표본 {n(preview.sample.length)}건 — 갈래마다 수에 비례해 무작위로(손댈 것에서). 열어 보고 정책이 맞는지 확인하세요</caption>
            <thead className="bg-bg-soft text-fg-3"><tr><th className="px-3 py-1.5 font-semibold">제품</th><th className="px-2 py-1.5 font-semibold">갈래 · AI 사유</th>
              <th className="px-2 py-1.5 font-semibold">확신</th><th className="px-2 py-1.5 font-semibold">두 번째 의견</th><th className="px-2 py-1.5 font-semibold">기다림</th></tr></thead>
            <tbody>{preview.sample.map((row) => (
              <tr key={row.itemId} className="border-t border-line align-top">
                <td className="px-3 py-1.5"><RowLinks row={row} /></td>
                <td className="max-w-[360px] px-2 py-1.5 text-fg-2"><span className="mr-1 rounded bg-bg-soft px-1.5 py-0.5 font-semibold">{AUDIT_REASON_CATEGORIES[row.branch]?.label ?? row.branch}</span>
                  <span className="line-clamp-3">{row.reason ?? '사유 없음'}</span></td>
                <td className="px-2 py-1.5 font-mono">{row.confidence?.toFixed(2) ?? '—'}<span className="block font-sans text-fg-3">{row.model}</span></td>
                <td className="max-w-[320px] px-2 py-1.5">
                  {row.m1Split && <span className="mb-0.5 inline-block rounded bg-warn/15 px-1.5 font-semibold text-warn" title="확신 0.90 이상인 m1 과 다른 모델이 반대로 정했습니다">엇갈림</span>}
                  {(row.textLength === null || row.textLength < THIN_PAGE_TEXT_CHARS) && <span className="mb-0.5 ml-1 inline-block rounded bg-bg-soft px-1.5 text-fg-2"
                    title={row.screenJudged ? '화면 판정이 있습니다' : '글만 본 m1 의 답으로 닫지 않고 화면 판정을 기다립니다'}>
                    글 {row.textLength === null ? '없음' : `${n(row.textLength)}자`}{row.screenJudged ? ' · 화면 판정 있음' : ' · 화면 판별 대기'}</span>}
                  {row.second.length ? row.second.map((opinion) => (
                    <span key={opinion.model} className="block" title={opinion.source ? `${opinion.model} · ${opinion.source}` : opinion.model}>
                      <span className="whitespace-nowrap font-semibold">{secondOpinionLabel(opinion)}</span>
                      {opinion.reason && <span className="line-clamp-2 text-fg-2">{opinion.reason}</span>}
                    </span>))
                  : <span className="block text-fg-3">없음</span>}</td>
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{row.waitDays === null ? '—' : `${n(row.waitDays)}일`}{row.held && <span className="block text-warn">보류 중</span>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 이름(주소 새 탭) · 공개 페이지 · 관리자 제품 화면 */
function RowLinks({ row }: { row: PolicyPreviewRow }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <a href={row.url} target="_blank" rel="noreferrer noopener" className="font-semibold hover:text-accent">{row.name}</a>
      <span className="max-w-[260px] truncate font-mono text-fg-3" title={row.url}>{row.url.replace(/^https?:\/\//, '')}</span>
      {row.owned && <span className="rounded bg-bg-soft px-1 text-fg-3">주인 있음</span>}
      <a href={`/p/${row.slug}`} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">공개 페이지</a>
      <a href={`/admin/products/${row.slug}`} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">관리자</a>
    </span>
  );
}
