'use client';

import { startTransition, useActionState } from 'react';
import { setHumanReview } from './human-review-actions';

export function HumanReviewSwitch({ enabled, generation, ready }: { enabled: boolean; generation: number; ready: boolean }) {
  const [state, action, pending] = useActionState(setHumanReview, null);
  const toggle = () => {
    const form = new FormData();
    form.set('enabled', String(!enabled));
    form.set('generation', String(generation));
    startTransition(() => action(form));
  };
  return <div id="human-review" className="flex flex-col gap-2 rounded-[10px] border border-line px-4 py-3 text-[13px]">
    <div className="flex items-center justify-between gap-3">
      <span id="human-review-title" className="text-[14px] font-semibold">사람 검토를 DeepSeek에 맡기기</span>
      <button type="button" role="switch" aria-checked={enabled} aria-labelledby="human-review-title"
        disabled={pending || !enabled && !ready} onClick={toggle}
        className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${enabled ? 'bg-up' : 'bg-line'}`}>
        <span aria-hidden className={`absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : ''}`} />
      </button>
    </div>
    <p className="text-fg-2">{enabled ? '켜짐' : '꺼짐'} · M3 Ultra · DeepSeek v4.1 Flash · 저장 없이 바로 적용</p>
    <p className="leading-relaxed text-fg-3">심사 큐의 직접 판단·확정 대기를 승인 또는 거부합니다. 판단 보류·실패는 사람 큐에 남습니다.
      스팸 의심·원본 소실은 자동 승인하지 않으며, 소개·발행 검사는 유지합니다. 기존 사람 결정과 공개 제품은 바꾸지 않습니다.</p>
    <p className={ready ? 'text-fg-3' : 'text-warn'}>{ready ? '로컬 모델 확인됨' : '로컬 모델 연결 미확인 — 끄기는 항상 가능합니다'}</p>
    {state && <p role="status" className={state.error ? 'text-down' : 'text-up'}>{state.error ?? state.message}</p>}
  </div>;
}
