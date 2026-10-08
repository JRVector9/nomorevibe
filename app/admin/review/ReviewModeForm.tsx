'use client';

import { startTransition, useActionState, useState } from 'react';
import { ConfirmAction } from '../components/ConfirmAction';
import { resultToast, useAdminToast } from '../components/Toast';
import { setReviewMode, type ReviewActionState } from './actions';

type Mode = 'off' | 'observe' | 'enforce';
const MODE_LABELS: Record<Mode, string> = { off: '끄기', observe: '관측', enforce: '적용' };
const field = 'mt-1 block rounded-lg border border-line bg-bg-soft px-3 py-2 text-fg';

/**
 * AI 리뷰 운영 모드(발행 보호) — 크롤 설정 2차 심사 칸(/admin#second)에 둔다(2026-10-08 UX 감사 ADM-24).
 *
 * 크롤 설정 폼 안에 그려지므로 <form> 도 name 도 쓰지 않는다 — 중첩 form 이 되거나 설정 저장에 섞여 들어간다.
 * 값은 상태로 들고 있다가 액션(setReviewMode)에 FormData 로 넘긴다. 저장 없이 바로 바뀐다.
 * 끄기(발행 보호 해제)는 확인 창에서 사유를 적어야 바뀐다(ADM-06) — 사유 한 줄만으로 보호를 풀 수 없게.
 */
export function ReviewModeForm({ mode, ready }: { mode: Mode; ready: boolean }) {
  const toast = useAdminToast();
  const [state, action, pending] = useActionState(async (previous: ReviewActionState, form: FormData) => {
    const result = await setReviewMode(previous, form);
    toast.show(resultToast(result));
    return result;
  }, null);
  const [next, setNext] = useState<Mode>(mode);
  const [reason, setReason] = useState('');
  const turningOff = next === 'off' && mode !== 'off';

  const submit = (target: Mode, why: string) => {
    const form = new FormData();
    form.set('mode', target);
    form.set('expectedMode', mode);
    form.set('reason', why);
    startTransition(() => action(form));
  };

  return (
    <div role="group" aria-labelledby="review-mode-title" className="flex flex-col gap-2 rounded-[10px] border border-line px-4 py-3 text-[13px]">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span id="review-mode-title" className="text-[14px] font-semibold">발행 보호 · AI 리뷰 운영 모드</span>
        <span className="font-semibold text-accent-ink">지금 {MODE_LABELS[mode]}</span>
        <span className="text-fg-3">저장 없이 바로 바뀝니다</span>
      </div>
      <p className="leading-relaxed text-fg-2">
        끄기는 기존 규칙으로 발행합니다. 관측은 AI 판정만 기록합니다. 적용은 현재 근거의 AI 승인을 발행 조건으로 사용합니다.
        관리자 승인은 사유와 함께 별도 기록합니다.
      </p>
      {!ready && <p className="text-fg-3">리뷰와 발행 보호 배포 확인 전에는 관측·적용을 켤 수 없습니다.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-fg-2">모드
          <select value={next} onChange={(event) => setNext(event.target.value as Mode)} className={field}>
            <option value="off">끄기 — AI 발행 보호 해제</option>
            <option value="observe" disabled={!ready}>관측 — 판정 기록만</option>
            <option value="enforce" disabled={!ready}>적용 — AI 승인 후 발행</option>
          </select>
        </label>
        {turningOff ? (
          <ConfirmAction
            title="AI 발행 보호를 끕니다"
            tone="danger"
            confirmLabel="발행 보호 끄기"
            summary={<p className="text-fg-2">
              리뷰 모드 <strong>{MODE_LABELS[mode]}</strong> → <strong>끄기</strong>. 끄면 AI 승인 없이 기존 규칙만 통과해도 발행됩니다.
              바꾼 사람과 사유는 기록에 남습니다.
            </p>}
            note={{ label: '끄는 사유', placeholder: '예: 심사 모델 장애로 발행이 멈춤', maxLength: 500 }}
            onConfirm={({ note }) => submit('off', note ?? '')}
            trigger={(open) => (
              <button type="button" onClick={open} disabled={pending}
                className="rounded-lg border border-down px-4 py-2 font-semibold text-down disabled:opacity-50">발행 보호 끄기…</button>
            )}
          />
        ) : (<>
          <label className="min-w-[220px] flex-1 text-fg-2">변경 사유
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500}
              // 크롤 설정 폼 안이라 Enter 가 설정 저장으로 새지 않게 막고 여기서 바꾼다
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (reason.trim() && !pending) submit(next, reason);
              }}
              className={`${field} w-full`} />
          </label>
          <button type="button" disabled={pending || !reason.trim()} onClick={() => submit(next, reason)}
            className="rounded-lg border border-line px-4 py-2 font-semibold disabled:opacity-50">모드 변경</button>
        </>)}
      </div>
      {state?.error && <p role="alert" className="text-down">{state.error}</p>}
    </div>
  );
}
