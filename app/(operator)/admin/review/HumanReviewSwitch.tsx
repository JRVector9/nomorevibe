'use client';

import { startTransition, useActionState } from 'react';
import { setHumanReview } from './human-review-actions';

export function HumanReviewSwitch({ enabled, generation, ready, modelLabel, modelLocation, readOnly = false }: {
  enabled: boolean; generation: number; ready: boolean; modelLabel: string; modelLocation: string; readOnly?: boolean;
}) {
  const [state, action, pending] = useActionState(setHumanReview, null);
  const toggle = () => {
    if (readOnly) return;
    const form = new FormData();
    form.set('enabled', String(!enabled));
    form.set('generation', String(generation));
    startTransition(() => action(form));
  };
  return <div id='human-review' className='flex flex-col gap-2 rounded-[10px] border border-line px-4 py-3 text-[13px]'>
    <div className='flex items-center justify-between gap-3'>
      <span id='human-review-title' className='min-w-0 break-words text-[14px] font-semibold'>사람 검토를 {modelLabel}에 맡기기</span>
      <button type='button' role='switch' aria-checked={enabled} aria-labelledby='human-review-title'
        disabled={readOnly || pending || (!enabled && !ready)} onClick={toggle}
        className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${enabled ? 'bg-up' : 'bg-line'}`}>
        <span aria-hidden className={`absolute top-[3px] left-[3px] h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : ''}`} />
      </button>
    </div>
    <p className='text-fg-2'>{enabled ? `${modelLabel} 자동 위임` : '사람이 직접 판단'} · {modelLocation} · 변경은 다음 작업부터 반영</p>
    <p className='leading-relaxed text-fg-3'>심사 큐의 직접 판단·확정 대기를 승인 또는 거부합니다. 근거와 확신 기준을 충족한 승인은 기존 최종 발행 검사로 이어집니다.
      판단 보류·낮은 확신·실패는 사람 큐에 남습니다. 스팸 의심·원본 소실은 자동 승인하지 않으며, 소개·발행 검사는 유지합니다. 기존 사람 결정과 공개 제품은 바꾸지 않습니다.</p>
    <p className={readOnly ? 'text-fg-3' : ready ? 'text-fg-3' : 'text-warn'}>{readOnly
      ? '읽기 전용입니다 — 이 화면에서는 자동 위임을 바꾸지 않습니다'
      : ready ? '모델 연결 확인됨(GET /models 메타데이터)' : '모델 연결 미확인 — 끄기는 항상 가능합니다'}</p>
    {state && <p role='status' className={state.error ? 'text-down' : 'text-up'}>{state.error ?? state.message}</p>}
  </div>;
}
