'use client';

import { useState } from 'react';
import { detectImportSource, IMPORT_LINE_LIMIT, IMPORT_SOURCE_KEYS, IMPORT_SOURCES, type ImportSource } from '@/lib/crawl/audit-import-sources';
import { AUDIT_REASON_CATEGORIES } from '@/lib/crawl/audit-reason-category';
import type { ImportPreview, ImportPreviewRow, ImportStageSummary } from '@/lib/crawl/audit-second-opinion-upload';
import { useAdminToast } from '../components/Toast';
import { discardImportAction, previewImportAction, stageImportAction, startImportApplyAction } from './policy-actions';
import { RunProgress } from './PolicyBuilder';
import { usePolicyRunLoop } from './policy-run-loop';

const n = (value: number) => value.toLocaleString('ko-KR');
/** 한 번에 보내는 줄·바이트 — 서버 액션 본문 상한(1MB) 아래로 */
const CHUNK_LINES = 400;
const CHUNK_BYTES = 600_000;
const DECISION = { approve: '승인', reject: '거절', needs_review: '판단 보류' } as Record<string, string>;
const SKIP = { error: '실패가 적힌 줄', invalid: '모양이 틀린 줄', duplicate: '같은 항목 두 번(뒤의 것만)', missing: '없는 항목', product_mismatch: '제품이 다름',
  model_mismatch: '모델이 다름' } as Record<string, string>;

export type StagedImportView = { runId: number; label: string; createdBy: string; createdAt: string; summary: ImportStageSummary };

/** 줄을 본문 상한 안의 묶음으로 */
function chunks(lines: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const line of lines) {
    const size = encoder.encode(line).length + 8;
    if (current.length && (current.length >= CHUNK_LINES || bytes + size > CHUNK_BYTES)) { out.push(current); current = []; bytes = 0; }
    current.push(line);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * 두 번째 의견 파일 올리기(0116) — 파일 고르기 → 올려서 검사(아무것도 적지 않는다) → 미리보기 → 적을 수를 그대로 적어 적용.
 * 대체(supersede)는 기본 꺼짐이고, 켜면 어느 항목의 보류가 더 풀리는지·무엇을 대신하는지 목록이 그대로 보인다.
 * 적용한 올리기는 실행 목록에서 통째로 되돌린다(의견을 덮어쓰기 전으로, 푼 보류는 다시).
 */
export function ImportOpinions({ staged }: { staged: StagedImportView | null }) {
  const toast = useAdminToast();
  const [lines, setLines] = useState<string[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [source, setSource] = useState<ImportSource>('qwen-vision-m1');
  const [stageProgress, setStageProgress] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(staged?.runId ?? null);
  const [summary, setSummary] = useState<ImportStageSummary | null>(staged?.summary ?? null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [supersede, setSupersede] = useState(false);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = usePolicyRunLoop();

  const loadPreview = async (id: number, withSupersede: boolean) => {
    const result = await previewImportAction(id, withSupersede);
    if (!result.ok) { setProblem(result.error); setPreview(null); return; }
    setPreview(result.value);
    setTyped('');
  };

  const pick = async (file: File | undefined) => {
    setProblem(null); setPreview(null); setRunId(null); setSummary(null);
    if (!file) { setLines(null); return; }
    const text = await file.text();
    const all = text.split('\n').map((line) => line.trim()).filter(Boolean);
    setFileName(file.name);
    setLines(all);
    setSource(detectImportSource(all) ?? 'grok-cli-batch');
  };

  const stage = async () => {
    if (!lines?.length) return;
    setBusy(true); setProblem(null); setPreview(null);
    try {
      const parts = chunks(lines.map((line) => line.length > IMPORT_LINE_LIMIT ? line.slice(0, IMPORT_LINE_LIMIT + 1) : line));
      let id: number | null = null;
      let sent = 0;
      for (const [index, part] of parts.entries()) {
        const result = await stageImportAction({ runId: id, source, lines: part, final: index === parts.length - 1 });
        if (!result.ok) { setProblem(result.error); return; }
        id = result.value.runId;
        sent += part.length;
        setSummary(result.value.summary);
        setStageProgress(`${n(sent)} / ${n(lines.length)}줄 검사`);
      }
      setRunId(id);
      if (id) await loadPreview(id, supersede);
    } catch {
      setProblem('올리다 끊겼습니다. 다시 올려 주세요(이 단계는 아무것도 적지 않습니다).');
    } finally { setBusy(false); }
  };

  const toggleSupersede = async (next: boolean) => {
    setSupersede(next);
    if (runId) await loadPreview(runId, next);
  };

  const apply = async () => {
    if (!preview || !runId) return;
    setBusy(true); setProblem(null);
    try {
      const result = await startImportApplyAction({ runId, supersede, expected: preview.writable });
      if (!result.ok) { setProblem(result.error); return; }
      await run.loop(runId, 'apply');
      toast.show({ message: `올리기 #${runId} 적용을 마쳤거나 멈췄습니다 — 실행 목록에서 보세요`, tone: 'ok' });
      setPreview(null);
    } catch {
      setProblem('요청이 끊겼습니다. 실행 목록의 «이어서 적용»을 누르면 남은 것부터 잇습니다.');
    } finally { setBusy(false); }
  };

  const discard = async () => {
    if (!runId) return;
    const result = await discardImportAction(runId);
    if (!result.ok) setProblem(result.error);
    setRunId(null); setPreview(null); setSummary(null); setLines(null);
  };

  const running = busy || run.running;
  const input = 'rounded-lg border border-line bg-bg-soft px-2 py-1.5 text-[13px]';
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-bg-card p-4" aria-labelledby="audit-import-title"
      data-dirty={lines || preview || running ? true : undefined}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="audit-import-title" className="text-[14.5px] font-bold">두 번째 의견 올리기</h2>
        <span className="text-[13px] text-fg-3">JSONL 파일 → 검사(아무것도 적지 않음) → 미리보기(풀릴 보류·막는 의견) → 수를 적어 적용 → 실행째 되돌리기</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <input type="file" accept=".jsonl,.json,.txt,application/json" disabled={running} aria-label="두 번째 의견 파일"
          onChange={(event) => void pick(event.target.files?.[0])} className="text-[13px]" />
        <label className="flex items-center gap-1.5">출처
          <select value={source} onChange={(event) => setSource(event.target.value as ImportSource)} disabled={running} className={input}>
            {IMPORT_SOURCE_KEYS.map((key) => <option key={key} value={key}>{key} — {IMPORT_SOURCES[key].label}</option>)}
          </select>
        </label>
        <button type="button" className="admin-button" data-tone="primary" disabled={!lines?.length || running} onClick={stage}>
          {busy && !preview ? '검사 중…' : `올려서 검사${lines ? ` (${n(lines.length)}줄)` : ''}`}</button>
        {runId && !run.running && <button type="button" className="admin-button" onClick={discard}>이 올리기 버리기</button>}
      </div>
      <p className="text-[13px] text-fg-3">{IMPORT_SOURCES[source].hint}. 모델 이름 {IMPORT_SOURCES[source].model ?? '줄의 model'}
        {IMPORT_SOURCES[source].promptVersion && ` · 글 ${IMPORT_SOURCES[source].promptVersion}`}
        {IMPORT_SOURCES[source].confidenceFloor !== null && ` · 보류에서는 확신 ${IMPORT_SOURCES[source].confidenceFloor!.toFixed(2)} 이상만 셉니다`}</p>
      {staged && !lines && runId === staged.runId && <p className="text-[13px] text-fg-2">검사만 하고 적용하지 않은 올리기 #{staged.runId}({staged.label} · {staged.createdBy} · {staged.createdAt})가 있습니다.
        <button type="button" className="ml-2 text-accent hover:underline" onClick={() => void loadPreview(staged.runId, supersede)}>미리보기 열기</button></p>}
      {stageProgress && busy && <p className="text-[13px] tabular-nums text-fg-2">{stageProgress}{fileName && ` · ${fileName}`}</p>}
      {summary && <p className="text-[13px] tabular-nums text-fg-2">검사: 읽은 줄 {n(summary.read)} · 받은 줄 <b className="font-semibold">{n(summary.stored)}</b>
        {Object.entries(SKIP).map(([key, label]) => (summary as Record<string, number>)[key] ? ` · ${label} ${n((summary as Record<string, number>)[key])}` : '').join('')}</p>}
      {problem && <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] text-down" role="alert">{problem}</p>}

      {preview && <div className="flex flex-col gap-3 border-t border-line pt-3 text-[13px]">
        <p className="tabular-nums text-fg-2">
          지금 열린 거절에 적을 것 <b className="font-semibold text-accent">{n(preview.writable)}</b>건(새로 {n(preview.inserted)} · 덮어씀 {n(preview.updated)})
          {preview.notOpen > 0 && ` · 이제 열린 거절이 아니라 건너뛸 것 ${n(preview.notOpen)}`} ·
          {' '}{Object.entries(preview.decisions).map(([key, count]) => `${DECISION[key] ?? key} ${n(count)}`).join(' · ')}
        </p>
        <p className="tabular-nums text-fg-2">
          보류 중인 항목에 온 승인 {n(preview.heldApprovals)}건 → 풀림 <b className="font-semibold">{n(preview.releaseByGate)}</b>(덮어쓴 뒤 둘째 문이 맞지 않음)
          · 대체를 켜면 더 풀림 <b className="font-semibold">{n(preview.releaseBySupersede)}</b> · 그래도 보류 <b className="font-semibold">{n(preview.blocked)}</b>
          {preview.unheldRejects > 0 && ` · 보류 아닌 항목의 거절 ${n(preview.unheldRejects)}건은 감사 잡의 쓸기가 다음 틱부터 분당 20건씩 보류할 수 있습니다`}
        </p>
        <label className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2">
          <input type="checkbox" checked={supersede} disabled={running} onChange={(event) => void toggleSupersede(event.target.checked)} className="mt-1 size-4 accent-accent" />
          <span><b className="font-semibold">대체(기본 꺼짐)</b> — 이 출처의 승인({IMPORT_SOURCES[preview.source].screenshot ? '스크린샷까지 본 판정' : '스크린샷 없는 출처라 대체할 수 없음'},
            확신 하한 이상)이 같은 항목의 <b className="font-semibold">글만 본 거절</b>(grok 일괄·Qwen-v2 자동 의견 등)을 대신합니다. 지금 규칙은 거절이 하나라도 남으면 풀지 않아,
            크롤러가 글을 못 읽은 JS 페이지를 예전 글만 보고 거절한 것이 새 승인으로도 풀리지 않습니다. 켜면 아래 {n(preview.releaseBySupersede)}건의 보류가 풀립니다.
            거절 의견은 지우지 않고 남습니다.</span>
        </label>
        {preview.supersedeRows.length > 0 && <RowsTable caption={`대체가 푸는 보류 — ${n(preview.supersedeRows.length)}건 전부 ${supersede ? '(켬: 적용하면 풀립니다)' : '(꺼짐: 켜면 풀립니다)'}`}
          rows={preview.supersedeRows} extra={(row) => (row.superseded ?? []).map((opinion) => `대신함: ${opinion.model}${opinion.source ? `(${opinion.source})` : ''} 거절${opinion.confidence !== null ? ` ${opinion.confidence.toFixed(2)}` : ''}`).join(' · ')} />}
        {preview.blockedRows.length > 0 && <RowsTable caption={`그래도 보류 — 막는 의견(처음 ${n(preview.blockedRows.length)}건)`} rows={preview.blockedRows}
          extra={(row) => (row.blockers ?? []).map((blocker) => blocker.kind === 'reject'
            ? `${blocker.model}${blocker.source ? `(${blocker.source})` : ''} 거절${blocker.confidence !== null ? ` ${blocker.confidence.toFixed(2)}` : ''}`
            : `사유 갈래 보류: ${AUDIT_REASON_CATEGORIES[blocker.category].label}(세는 승인 없음)`).join(' · ')} />}
        {preview.gateRows.length > 0 && <details className="rounded-lg border border-line px-3 py-1.5"><summary className="cursor-pointer">대체 없이 풀리는 보류 — 처음 {n(preview.gateRows.length)}건</summary>
          <RowsTable caption="" rows={preview.gateRows} extra={() => ''} /></details>}
        {preview.writable > 0 && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-soft p-3">
          <span className="font-semibold">의견 {n(preview.writable)}건{supersede ? ' · 대체 켬' : ''} — 이 수를 그대로 적어야 적용됩니다</span>
          <input value={typed} inputMode="numeric" onChange={(event) => setTyped(event.target.value)} placeholder={String(preview.writable)}
            aria-label="적을 수 다시 적기" className={`${input} w-[7rem] font-mono`} disabled={running} />
          <button type="button" className="admin-button" data-tone="primary" disabled={running || typed.trim() !== String(preview.writable)} onClick={apply}>
            {running ? '적용 중…' : `의견 ${n(preview.writable)}건 적기`}</button>
        </div>}
      </div>}
      {run.progress && <RunProgress progress={run.progress} running={run.running} waiting={run.waiting} error={run.error} onStop={run.stop} />}
      {!run.progress && run.error && <p className="text-[13px] text-down" role="alert">{run.error}</p>}
    </section>
  );
}

function RowsTable({ caption, rows, extra }: { caption: string; rows: ImportPreviewRow[]; extra: (row: ImportPreviewRow) => string }) {
  return (
    <div className="relative max-h-[420px] overflow-auto rounded-lg border border-line">
      <table className="w-full min-w-[760px] text-left text-[13px]">
        {caption && <caption className="px-3 py-1.5 text-left font-semibold text-fg-3">{caption}</caption>}
        <thead className="bg-bg-soft text-fg-3"><tr><th className="px-3 py-1.5 font-semibold">제품</th><th className="px-2 py-1.5 font-semibold">올린 판정</th>
          <th className="px-2 py-1.5 font-semibold">감사 사유</th><th className="px-2 py-1.5 font-semibold">무엇이</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.itemId} className="border-t border-line align-top">
            <td className="px-3 py-1.5">{row.url ? <a href={row.url} target="_blank" rel="noreferrer noopener" className="font-semibold hover:text-accent">{row.name ?? row.slug}</a> : row.slug}
              <a href={`/admin/products/${row.slug}`} target="_blank" rel="noreferrer noopener" className="ml-2 text-accent hover:underline">관리자</a></td>
            <td className="max-w-[300px] px-2 py-1.5 text-fg-2">{DECISION[row.decision] ?? row.decision}{row.confidence !== null && ` ${row.confidence.toFixed(2)}`}
              <span className="line-clamp-2 text-fg-3">{row.reason ?? ''}</span></td>
            <td className="max-w-[260px] px-2 py-1.5 text-fg-3"><span className="line-clamp-2">{row.auditReason ?? '—'}</span></td>
            <td className="max-w-[300px] px-2 py-1.5 text-fg-2">{extra(row)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}
