"use client";

import { useActionState } from "react";
import {
  forceProductRefresh,
  hideAutomaticUpdate,
  restoreAutomaticUpdate,
} from "./actions";

function Feedback({ state }: { state: Awaited<ReturnType<typeof forceProductRefresh>> }) {
  return (
    <div aria-live="polite" className="text-[13px] text-fg-2">
      {state?.ok && !state.summary && "반영했습니다."}
      {state?.summary && (
        <span>
          출처 {state.summary.attempted} · 실패 {state.summary.failed} · 사실 {state.summary.facts}
          {" · "}업데이트 {state.summary.updates} · 미디어 {state.summary.media}
        </span>
      )}
      {state?.issues?.map((issue) => <p key={issue} className="text-down">{issue}</p>)}
    </div>
  );
}

export function ForceRefreshForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(forceProductRefresh, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="slug" value={slug} />
      <button disabled={pending} className="rounded-lg border border-accent px-3 py-2 text-[13px] font-bold text-accent disabled:opacity-50">
        {pending ? "갱신 중" : "지금 근거 갱신"}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function UpdateVisibilityForm({
  slug,
  updateId,
  visible,
}: {
  slug: string;
  updateId: number;
  visible: boolean;
}) {
  const handler = visible ? hideAutomaticUpdate : restoreAutomaticUpdate;
  const [state, action, pending] = useActionState(handler, null);
  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="updateId" value={updateId} />
      {visible && (
        <input
          name="reason"
          required
          maxLength={500}
          placeholder="숨김 사유"
          className="min-w-[180px] rounded-lg border border-line bg-white px-3 py-1.5 text-[13px]"
        />
      )}
      <button disabled={pending} className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50">
        {pending ? "처리 중" : visible ? "숨기기" : "복원"}
      </button>
      <Feedback state={state} />
    </form>
  );
}
