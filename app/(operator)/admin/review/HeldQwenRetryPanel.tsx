'use client';

import { startTransition, useActionState, useState } from 'react';
import { setHeldQwenRetryAction } from './held-qwen-actions';
import type { HeldQwenStatus } from '@/lib/crawl/held-qwen-retry';
import { HELD_QWEN_REASONS, type HeldQwenReason, type HeldQwenRetrySettings } from '@/lib/crawl/settings-schema';

const REASON_LABEL: Record<HeldQwenReason, string> = {
  no_description: '소개 없음', ai_review_exhausted: '1차 재시도 소진', ambiguous: '판단 보류(규칙·1차)',
};
const n = (value: number) => value.toLocaleString('ko-KR');
const time = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * 보류 Qwen-v2 재심사 — 상태와 스위치(lib/crawl/held-qwen-retry.ts). 저장은 화면이 본 값과 견준 뒤에만 된다(compare-and-set).
 * 승인은 자동 경로로 되돌려 2차 관문을 그대로 지나고, 거부는 끝내고, 판단 보류·오류는 사람 큐에 «Qwen-v2: 판단 보류»로 남는다.
 */
export function HeldQwenRetryPanel({ status }: { status: HeldQwenStatus | null }) {
  const [state, action, pending] = useActionState(setHeldQwenRetryAction, null);
  const current: HeldQwenRetrySettings | null = status
    ? { enabled: status.enabled, perTick: status.perTick, budgetSeconds: status.budgetSeconds, reasons: status.reasons } : null;
  const [perTick, setPerTick] = useState(String(status?.perTick ?? 10));
  const [budget, setBudget] = useState(String(status?.budgetSeconds ?? 40));
  const [reasons, setReasons] = useState<HeldQwenReason[]>(status?.reasons ?? [...HELD_QWEN_REASONS]);
  if (!status || !current) {
    return <div id="held-qwen" className="rounded-[10px] border border-line px-4 py-3 text-[13px] text-fg-3">Qwen-v2 보류 재심사 상태를 읽지 못했습니다.</div>;
  }
  const submit = (next: HeldQwenRetrySettings) => {
    const form = new FormData();
    form.set('next', JSON.stringify(next));
    form.set('expected', JSON.stringify(current));
    startTransition(() => action(form));
  };
  const edited = { enabled: current.enabled, perTick: Number(perTick), budgetSeconds: Number(budget), reasons };
  const changed = edited.perTick !== current.perTick || edited.budgetSeconds !== current.budgetSeconds
    || edited.reasons.length !== current.reasons.length || edited.reasons.some((reason) => !current.reasons.includes(reason));
  const { day } = status;
  return <div id="held-qwen" className="flex flex-col gap-2 rounded-[10px] border border-line px-4 py-3 text-[13px]">
    <div className="flex items-center justify-between gap-3">
      <span id="held-qwen-title" className="text-[14px] font-semibold">보류를 Qwen-v2 가 다시 보기</span>
      <button type="button" role="switch" aria-checked={current.enabled} aria-labelledby="held-qwen-title" disabled={pending}
        onClick={() => submit({ ...current, enabled: !current.enabled })}
        className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${current.enabled ? 'bg-up' : 'bg-line'}`}>
        <span aria-hidden className={`absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${current.enabled ? 'translate-x-4' : ''}`} />
      </button>
    </div>
    <p className="text-fg-2">{current.enabled ? '켜짐' : '꺼짐'} · gpu3090 직접 · <span className="font-mono">{status.model ?? '주소·모델 설정 오류'}</span>
      {' '}· 한 틱 {n(current.perTick)}건·{n(current.budgetSeconds)}초 · {current.reasons.map((reason) => REASON_LABEL[reason]).join(' · ') || '사유 없음'}</p>
    <p className="leading-relaxed text-fg-3">거부는 끝내고, 승인은 자동 경로로 되돌려 2차 관문(Qwen 과 다른 투표 모델의 승인)을 그대로 지납니다.
      소개 없음의 승인·독립 투표 모델이 없을 때의 승인은 «승인 의견»으로, 판단 보류·오류는 «판단 보류»로 사람 큐에 남습니다. 켜 둔 동안 DeepSeek 위임은 이 사유를 집지 않습니다.</p>
    <p className="text-fg-2" title="최근 24시간 — 운영 감사(candidate-qwen-held-review)와 시도 기록에서 셉니다">
      24시간: 처리 <b>{n(day.processed)}</b> · 자동 경로 복귀 <b className="text-up">{n(day.pipeline)}</b> · 거부 <b>{n(day.rejected)}</b>
      {' '}· 사람에게 남김 <b>{n(day.held)}</b> · 실패 <b className={day.failed ? 'text-down' : ''}>{n(day.failed)}</b>
    </p>
    <p className="text-fg-3">맡은 보류 {n(status.waiting)}건{status.expired ? ` · 그중 원본·스캔이 24시간 지나 갱신을 기다리는 것 ${n(status.expired)}건` : ''}
      {status.lastError ? ` · 마지막 오류 ${status.lastError.code} (${time(status.lastError.at)})` : ' · 오류 없음'}
      {status.backoffUntil ? ` · ${time(status.backoffUntil)}까지 물러남` : ''}</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-fg-2">한 틱 수
        <input type="number" min={1} max={50} value={perTick} onChange={(event) => setPerTick(event.target.value)}
          className="mt-1 block w-20 rounded-lg border border-line bg-bg-soft px-2 py-1 font-mono text-fg" />
      </label>
      <label className="text-fg-2">한 틱 시간(초)
        <input type="number" min={10} max={60} value={budget} onChange={(event) => setBudget(event.target.value)}
          className="mt-1 block w-20 rounded-lg border border-line bg-bg-soft px-2 py-1 font-mono text-fg" />
      </label>
      <fieldset className="flex flex-wrap gap-3 text-fg-2">
        <legend className="sr-only">다시 볼 사유</legend>
        {HELD_QWEN_REASONS.map((reason) => (
          <label key={reason} className="flex items-center gap-1">
            <input type="checkbox" className="size-4 accent-accent" checked={reasons.includes(reason)}
              onChange={() => setReasons((list) => list.includes(reason) ? list.filter((value) => value !== reason) : [...list, reason])} />
            {REASON_LABEL[reason]}
          </label>
        ))}
      </fieldset>
      <button type="button" disabled={pending || !changed} onClick={() => submit(edited)}
        className="rounded-lg border border-line px-4 py-1.5 font-semibold disabled:opacity-50">저장</button>
    </div>
    {state && <p role="status" className={state.error ? 'text-down' : 'text-up'}>{state.error ?? state.message}</p>}
  </div>;
}
