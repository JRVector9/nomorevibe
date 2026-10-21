'use client';

import { useState } from 'react';
import { saveQwenAutoStep } from '../qwen-auto-actions';
import { ConfirmAction } from '../components/ConfirmAction';
import { resultToast, useAdminToast } from '../components/Toast';
import type { HeldQwenStatus } from '@/lib/crawl/held-qwen-retry';
import { HELD_QWEN_REASONS, type HeldQwenReason, type HeldQwenRetrySettings } from '@/lib/crawl/settings-schema';

const REASON_LABEL: Record<HeldQwenReason, string> = {
  no_description: '소개 없음', ai_review_exhausted: '1차 재시도 소진', ambiguous: '판단 보류(규칙·1차)',
};
const n = (value: number) => value.toLocaleString('ko-KR');
const time = (iso: string) => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * 보류 Qwen-v2 재심사 — 상태와 스위치(lib/crawl/held-qwen-retry.ts, qwenAuto.heldRetry — 기본 꺼짐). 저장은 화면이 본 값과 견준 뒤에만 되고
 * (compare-and-set), 켜는 바꿈은 확인 창에서 사유를 꼭 받는다(작업 로그 qwen-auto-settings).
 * 승인은 자동 경로로 되돌려 2차 관문을 그대로 지나고, 거부는 끝내고, 판단 보류·오류는 사람 큐에 «Qwen-v2: 판단 보류»로 남는다.
 */
export function HeldQwenRetryPanel({ status }: { status: HeldQwenStatus | null }) {
  const toast = useAdminToast();
  const current: HeldQwenRetrySettings | null = status
    ? { enabled: status.enabled, perTick: status.perTick, budgetSeconds: status.budgetSeconds, reasons: status.reasons } : null;
  const [perTick, setPerTick] = useState(String(status?.perTick ?? 10));
  const [budget, setBudget] = useState(String(status?.budgetSeconds ?? 40));
  const [reasons, setReasons] = useState<HeldQwenReason[]>(status?.reasons ?? [...HELD_QWEN_REASONS]);
  const [enabled, setEnabled] = useState(status?.enabled ?? false);
  if (!status || !current) {
    return <div id="held-qwen" className="rounded-[10px] border border-line px-4 py-3 text-[13px] text-fg-3">Qwen-v2 보류 재심사 상태를 읽지 못했습니다.</div>;
  }
  const edited: HeldQwenRetrySettings = { enabled, perTick: Number(perTick), budgetSeconds: Number(budget), reasons };
  const changed = edited.enabled !== current.enabled || edited.perTick !== current.perTick || edited.budgetSeconds !== current.budgetSeconds
    || edited.reasons.length !== current.reasons.length || edited.reasons.some((reason) => !current.reasons.includes(reason));
  const enabling = edited.enabled && !current.enabled;
  const { day } = status;
  return <div id="held-qwen" className="flex flex-col gap-2 rounded-[10px] border border-line px-4 py-3 text-[13px]" data-dirty={changed || undefined}>
    <span id="held-qwen-title" className="text-[14px] font-semibold">보류를 Qwen-v2 가 다시 보기</span>
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
      {status.backoffUntil ? ` · ${time(status.backoffUntil)}까지 물러남(gpu3090 을 부르는 모두)` : ''}</p>
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-h-10 items-center gap-2 text-fg-2">
        <input type="checkbox" name="heldRetry-enabled" className="size-4 accent-accent" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <b className="font-semibold">켬</b>
      </label>
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
      <ConfirmAction tone={enabling ? 'danger' : 'neutral'} title={enabling ? 'Qwen-v2 보류 재심사를 켭니다 — 사람 없이 정하는 일이 시작됩니다' : 'Qwen-v2 보류 재심사 설정을 바꿉니다'}
        confirmLabel={enabling ? '켜기' : '저장'}
        summary={<ul>
          {edited.enabled !== current.enabled && <li>{current.enabled ? '켬' : '끔'} → {edited.enabled ? '켬' : '끔'}</li>}
          {edited.perTick !== current.perTick && <li>한 틱 {current.perTick}건 → {edited.perTick}건</li>}
          {edited.budgetSeconds !== current.budgetSeconds && <li>한 틱 {current.budgetSeconds}초 → {edited.budgetSeconds}초</li>}
          <li>사유: {edited.reasons.map((reason) => REASON_LABEL[reason]).join(' · ') || '없음'}</li>
          {enabling && <li>거부(확신 0.90 이상)는 사람 없이 끝냅니다 — 적용 모드에서만. 승인(확신 0.90 이상)은 자동 경로로 되돌려 2차 관문을 그대로 지납니다.</li>}
          {enabling && <li>켜 둔 동안 DeepSeek 위임은 이 사유를 집지 않습니다.</li>}
        </ul>}
        note={{ label: enabling ? '왜 켜는지 (꼭 적어 주세요 · 작업 로그에 남습니다)' : '바꾸는 까닭 (선택 · 작업 로그에 남습니다)', optional: !enabling, maxLength: 500 }}
        onConfirm={async ({ note }) => {
          const form = new FormData();
          form.set('step', 'heldRetry');
          form.set('next', JSON.stringify(edited));
          form.set('expected', JSON.stringify(current));
          form.set('reason', note ?? '');
          const result = await saveQwenAutoStep(null, form);
          if (result && !result.error) toast.show(resultToast(result, { message: result.message ?? '저장했습니다' }));
          return result;
        }}
        trigger={(open) => <button type="button" disabled={!changed} onClick={open}
          className="rounded-lg border border-line px-4 py-1.5 font-semibold disabled:opacity-50">저장…</button>} />
    </div>
  </div>;
}
