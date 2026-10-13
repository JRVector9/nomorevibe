"use client";

import { useActionState } from "react";
import { saveOperatorName, type OperatorNameState } from "./actions";

/**
 * 로컬 로그인의 "내 이름" — 진짜 로그인을 붙이기 전까지 작업 로그의 처리자로 남길 이름(ADM-21).
 * 이 브라우저에만 적힌다. 본인이 적는 이름이라 신원 확인은 아니다.
 */
export function OperatorName({ current, max }: { current: string | null; max: number }) {
  const [state, action, pending] = useActionState<OperatorNameState, FormData>(saveOperatorName, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 rounded-[12px] border border-line bg-bg-card px-3 py-2 text-[13px]">
      <label className="flex min-w-0 flex-1 basis-[240px] items-center gap-2">
        <span className="shrink-0 font-semibold text-fg-2">내 이름</span>
        <input name="name" defaultValue={current ?? ""} maxLength={max} placeholder="예: 지우 — 비우면 local"
          className="min-w-0 flex-1 rounded-lg border border-line bg-bg-soft px-2.5 py-1.5 text-[13px]" />
      </label>
      <button type="submit" disabled={pending} className="admin-button">{pending ? "적는 중…" : "적기"}</button>
      <span className="basis-full text-fg-3">
        로컬 로그인은 모두 local 로 남습니다. 이름을 적어 두면 이 브라우저에서 한 작업이 그 이름으로 남습니다(처리 방식은 로컬 로그인).
      </span>
      <span aria-live="polite" className="basis-full empty:hidden">
        {state?.error && <span className="text-down">{state.error}</span>}
        {state?.message && <span className="text-up">{state.message}</span>}
      </span>
    </form>
  );
}
