'use client';

import { useActionState } from 'react';
import { cancelAudit, startAudit, type AuditActionState } from './actions';

/**
 * 감사를 여는 폼. 이 버튼은 아무것도 내리지 않는다 — 화면에도 그렇게 적는다.
 *
 * "유지 판정도 다시 보기"는 기본으로 꺼 둔다. 켜면 사람이 페이지를 열어 보고 유지로 둔 것까지
 * 전부 다시 사람 앞에 온다 — 심사 글을 한 줄 고칠 때마다 그러면 이미 한 확인을 버리는 셈이다.
 * 기준이 실제로 엄격해져 예전의 "유지"를 믿을 수 없을 때만 켠다. 꺼 두어도 페이지가 바뀌었거나
 * 90일이 지난 것은 다시 들어온다.
 */
export function StartAudit({ blockedReason, first }: { blockedReason: string | null; first: boolean }) {
  const [state, action, pending] = useActionState<AuditActionState, FormData>(startAudit, null);
  const disabled = pending || Boolean(blockedReason);
  return (
    <form action={action} className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-[13px] leading-[1.7] text-fg-2">
        <b className="font-semibold">이 버튼은 아무것도 내리지 않습니다.</b> 공개된 제품을 지금의 심사 글로 다시 보고,
        사람이 확인할 새 목록을 만들 뿐입니다. 내리는 것은 아래 목록에서 한 건씩 누릅니다.
      </p>
      <input name="reason" required maxLength={500} disabled={disabled} placeholder="왜 다시 보는지 (기록에 남습니다)"
        className="rounded-lg border border-line bg-bg-soft px-3 py-2 text-[13px] disabled:opacity-50" />
      <label className="flex items-start gap-2 text-[13px] text-fg-2">
        <input type="checkbox" name="reauditKept" disabled={disabled} className="mt-1 size-4 accent-accent" />
        <span>
          <b className="font-semibold">유지 판정도 다시 보기</b>
          <span className="block text-fg-3">
            끄면(기본) 사람이 유지로 둔 제품 중 90일이 안 지났고 페이지도 그대로인 것은 빼고 봅니다.
            기준이 실제로 엄격해졌을 때만 켜세요 — 켜면 이미 확인한 것까지 전부 다시 올라옵니다.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={disabled}
          className="rounded-lg border border-accent bg-accent px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50">
          {pending ? '올리는 중…' : first ? '감사 시작' : '재감사 시작'}
        </button>
        {blockedReason && <span className="text-[13px] text-fg-3">{blockedReason}</span>}
      </div>
      {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
      {state?.message && <p className="text-[13px] text-up">{state.message}</p>}
    </form>
  );
}

/** 진행 중인 감사를 멈춘다. 멈춰도 아무것도 내려가지 않고, 찾은 것은 목록에 남는다 */
export function CancelAudit() {
  const [state, action, pending] = useActionState<AuditActionState, FormData>(cancelAudit, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={pending}
        className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2 disabled:opacity-50">
        이 감사 중단
      </button>
      <span className="text-[13px] text-fg-3">멈춰도 아무것도 내려가지 않고, 지금까지 찾은 것은 남습니다.</span>
      {state?.error && <span className="text-[13px] text-down">{state.error}</span>}
    </form>
  );
}
