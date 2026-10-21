'use client';

import { startTransition, useActionState, useState } from 'react';
import type { SplitTiebreakStatus } from '@/lib/crawl/gate-split-tiebreak-read';
import { formatDetailTime } from '@/lib/format/time';
import { setSplitTiebreakAction } from './split-tiebreak-actions';
import { TIEBREAK_APPROVE_BADGE } from './tiebreak';

const n = (value: number) => value.toLocaleString('ko-KR');

/**
 * 2차 갈림 판가름 — 관문에서 갈린 보류를 gpu3090 Qwen-v2 에 한 번 더 묻는다(lib/crawl/gate-split-tiebreak.ts).
 * 스위치와 한 틱의 수는 화면이 본 값과 같을 때만 바뀐다(compare-and-set). 저장된 값이 깨졌으면 꺼진 것으로 읽는다.
 */
export function SplitTiebreakSwitch({ enabled, perTick, status }: { enabled: boolean; perTick: number; status: SplitTiebreakStatus | null }) {
  const [state, action, pending] = useActionState(setSplitTiebreakAction, null);
  const [count, setCount] = useState(String(perTick));
  const send = (next: { enabled: boolean; perTick: number }) => {
    const form = new FormData();
    form.set('enabled', String(next.enabled));
    form.set('perTick', String(next.perTick));
    form.set('expectedEnabled', String(enabled));
    form.set('expectedPerTick', String(perTick));
    startTransition(() => action(form));
  };
  const parsed = /^\d{1,2}$/.test(count) ? Number(count) : NaN;
  const validCount = Number.isInteger(parsed) && parsed >= 1 && parsed <= 50;
  // 접어 두어도 머리 줄에 상태가 보인다 — 처리·거부·승인 대기·남음·마지막 오류
  const summary = status
    ? `처리 ${n(status.processed)} · 거부로 닫음 ${n(status.rejected)} · 승인 대기 ${n(status.approvedWaiting)} · 남음 ${n(status.remaining)}`
      + ` · 마지막 오류 ${status.lastError ? `${status.lastError.code} (${formatDetailTime(status.lastError.at)})` : '없음'}`
    : '상태를 읽지 못했습니다';
  return <details id="split-tiebreak" className="rounded-[10px] border border-line px-4 py-2 text-[13px]">
    <summary className="cursor-pointer text-fg-2">
      <b className="font-semibold text-fg">갈림 판가름 Qwen-v2</b> {enabled ? '켜짐' : '꺼짐'} · <span className="font-mono">{summary}</span>
    </summary>
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span id="split-tiebreak-title" className="text-[14px] font-semibold">2차 갈림 판가름 — Qwen-v2 세 번째 표</span>
        <button type="button" role="switch" aria-checked={enabled} aria-labelledby="split-tiebreak-title" disabled={pending}
          onClick={() => send({ enabled: !enabled, perTick })}
          className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${enabled ? 'bg-up' : 'bg-line'}`}>
          <span aria-hidden className={`absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : ''}`} />
        </button>
      </div>
      <p className="leading-relaxed text-fg-3">1차 승인·2차 반대로 갈린 보류를 gpu3090 Qwen-v2 에 관문과 같은 입력으로 한 번 더 묻습니다.
        2차 거부와 같이 거부하면 거부로 닫고, 승인하면 발행하지 않고 «{TIEBREAK_APPROVE_BADGE}» 배지로 목록 맨 앞에 둡니다. 보류·실패는 그대로 사람 몫입니다.</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-fg-2">한 틱에 묻는 수
          <input inputMode="numeric" value={count} onChange={(event) => setCount(event.target.value)} aria-invalid={!validCount}
            className="mt-1 block w-20 rounded-lg border border-line bg-bg-soft px-2 py-1 font-mono text-fg" />
        </label>
        <button type="button" disabled={pending || !validCount || parsed === perTick} onClick={() => send({ enabled, perTick: parsed })}
          className="rounded-lg border border-line px-3 py-1.5 font-semibold disabled:opacity-50">바꾸기</button>
        <span className="text-fg-3">1~50 · 저장 없이 바로 적용</span>
      </div>
      {status && <p className="font-mono text-fg-3">
        거부 의견 남김(다수 아님·카탈로그) {n(status.heldReject)} · 대상 아님(원본·정책 바뀜) {n(status.ineligible)} · 실패 소진 {n(status.exhausted)}
        {' '}· 24시간 처리 {n(status.day.processed)} · 거부 {n(status.day.rejected)}
      </p>}
    </div>
    {state && <p role="status" className={`mt-1 ${state.error ? 'text-down' : 'text-up'}`}>{state.error ?? state.message}</p>}
  </details>;
}
