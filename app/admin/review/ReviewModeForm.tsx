'use client';

import { useActionState } from 'react';
import { setReviewMode } from './actions';

export function ReviewModeForm({ mode, ready }: { mode: 'off' | 'observe' | 'enforce'; ready: boolean }) {
  const [state, action, pending] = useActionState(setReviewMode, null);
  return (
    <section className="mt-6 rounded-xl border border-line bg-bg-card p-5">
      <h2 className="text-[15px] font-bold">AI 리뷰 운영 모드</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-fg-2">
        끄기는 기존 규칙으로 발행합니다. 관측은 AI 판정만 기록합니다. 적용은 현재 근거의 AI 승인을 발행 조건으로 사용합니다.
        관리자 승인은 사유와 함께 별도 기록합니다.
      </p>
      {!ready && <p className="mt-2 text-[13px] text-fg-3">리뷰와 발행 보호 배포 확인 전에는 관측·적용을 켤 수 없습니다.</p>}
      <form action={action} className="mt-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="expectedMode" value={mode} />
        <label className="text-[13px] text-fg-2">모드
          <select name="mode" defaultValue={mode} className="mt-1 block rounded-lg border border-line bg-bg-soft px-3 py-2">
            <option value="off">끄기 — AI 발행 보호 해제</option>
            <option value="observe" disabled={!ready}>관측 — 판정 기록만</option>
            <option value="enforce" disabled={!ready}>적용 — AI 승인 후 발행</option>
          </select>
        </label>
        <label className="min-w-[220px] flex-1 text-[13px] text-fg-2">변경 사유
          <input name="reason" required maxLength={500} className="mt-1 block w-full rounded-lg border border-line bg-bg-soft px-3 py-2" />
        </label>
        <button disabled={pending} className="rounded-lg border border-line px-4 py-2 text-[13px] font-semibold disabled:opacity-50">모드 변경</button>
      </form>
      {state && <p role="status" className={`mt-3 text-[13px] ${state.error ? 'text-down' : 'text-up'}`}>{state.error ?? state.message}</p>}
    </section>
  );
}
