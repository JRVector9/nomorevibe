"use client";

import { useActionState } from "react";
import { banProducts, type BulkBanState } from "../../actions";
import { MAX_BULK_DECISIONS } from "../../review/contract";

/**
 * 재검수가 짚은 것을 이 화면에서 바로 내린다.
 *
 * 짚어만 주고 내리는 곳이 다른 화면이면, 이름을 손으로 옮겨 적게 된다 — 실제로 그러다
 * 없는 레포 이름을 지어낸 적이 있다. 화면이 가진 slug를 그대로 보내는 것이 안전하다.
 *
 * 체크박스는 각 행에 있고 form 속성으로 이 폼에 실린다 — 폼은 겹칠 수 없다.
 */
export function BanHits({ formId, total }: { formId: string; total: number }) {
  const [state, action, pending] = useActionState<BulkBanState, FormData>(banProducts, null);

  return (
    <form id={formId} action={action} className="mt-5 rounded-[12px] border border-line bg-bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[14.5px] font-bold">선택한 것 내리기</h2>
        <p className="text-[13px] text-fg-3">
          아래 {total}건 중 체크한 것만 · 한 번에 최대 {MAX_BULK_DECISIONS}건
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] font-semibold text-down disabled:opacity-50"
        >
          {pending ? "내리는 중…" : "선택 차단"}
        </button>
        <span className="text-[13px] text-fg-3">
          행은 남습니다 — 같은 URL의 재수집·재등록이 막히고, 제품 화면에서 되돌릴 수 있습니다
        </span>
      </div>

      <div aria-live="polite" className="mt-2">
        {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
        {typeof state?.ok === "number" && (
          <p className="text-[13px] text-fg-2">
            <b className="font-semibold text-up">{state.ok.toLocaleString("ko-KR")}건을 내렸습니다.</b>
            {state.failures?.length ? ` ${state.failures.length}건은 찾지 못했습니다.` : ""}
          </p>
        )}
        {state?.failures?.map((slug) => (
          <p key={slug} className="mt-1 font-mono text-[13px] text-down">{slug}</p>
        ))}
      </div>
    </form>
  );
}
