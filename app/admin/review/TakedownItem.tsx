"use client";

import { useActionState } from "react";
import { resolveTakedownRequest, type ReviewState } from "../actions";

/** 요청 한 건 — 내리거나, 요청을 물린다 */
export function TakedownItem({
  slug,
  reason,
  requestedAt,
}: {
  slug: string;
  reason: string | null;
  requestedAt: string;
}) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(resolveTakedownRequest, null);

  return (
    <li className="rounded-[14px] border border-down/40 bg-down/5 p-[18px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a href={`/p/${slug}`} target="_blank" rel="noreferrer noopener" className="text-[14px] font-bold hover:text-accent">
          {slug}
        </a>
        <span className="font-mono text-[13px] text-fg-3">{requestedAt}</span>
      </div>
      {reason && <p className="mt-2 text-[13px] leading-[1.7] text-fg-2">{reason}</p>}

      <form action={action} className="mt-3.5 flex flex-wrap items-center gap-2">
        <input type="hidden" name="slug" value={slug} />
        <button
          type="submit"
          name="action"
          value="remove"
          disabled={pending}
          className="rounded-lg border border-down/40 bg-down/10 px-3 py-1.5 text-[13px] font-semibold text-down disabled:opacity-50"
        >
          내린다
        </button>
        <button
          type="submit"
          name="action"
          value="dismiss"
          disabled={pending}
          className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-semibold text-fg-2 hover:text-fg disabled:opacity-50"
        >
          두고 본다
        </button>
      </form>
      {state?.error && <p className="mt-2 text-[13px] text-down">{state.error}</p>}
    </li>
  );
}
