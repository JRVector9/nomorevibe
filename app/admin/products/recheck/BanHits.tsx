"use client";

import { useActionState, useRef, useState } from "react";
import { banProducts, type BulkBanState } from "../../actions";
import { MAX_BULK_DECISIONS } from "../../review/contract";

/**
 * 재검수가 짚은 것을 이 화면에서 바로 내린다.
 *
 * 짚어만 주고 내리는 곳이 다른 화면이면, 이름을 손으로 옮겨 적게 된다 — 실제로 그러다
 * 없는 레포 이름을 지어낸 적이 있다. 화면이 가진 slug를 그대로 보내는 것이 안전하다.
 *
 * 체크박스는 각 행에 있고 form 속성으로 이 폼에 실린다 — 폼은 겹칠 수 없다.
 *
 * 버튼을 누르면 곧바로 내리지 않고 확인 창을 띄운다(2026-09-18). 전에는 "선택 차단"이 그냥
 * submit 이라 체크해 둔 것이 한 번에 공개 목록에서 사라졌고, 되돌리기는 제품 화면에서 한 건씩만
 * 된다. 누르기 전에 몇 건이, 무엇이, 어떻게 되는지를 이름과 함께 보여 줘야 한다.
 * 기본 초점은 "취소"에 둔다 — 창이 뜬 채로 엔터를 치면 내리는 쪽이 아니라 닫히는 쪽이어야 한다.
 */
type Picked = { slug: string; name: string };

export function BanHits({ formId, total }: { formId: string; total: number }) {
  const [state, action, pending] = useActionState<BulkBanState, FormData>(banProducts, null);
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);

  /** 창을 여는 순간 체크된 것을 그대로 옮겨 적는다. 창이 떠 있는 동안에는 체크를 바꿀 수 없다 */
  function openConfirm() {
    const boxes = document.querySelectorAll<HTMLInputElement>(
      `input[type="checkbox"][form="${formId}"][name="slug"]:checked`,
    );
    setPicked([...boxes].map((box) => ({ slug: box.value, name: box.dataset.name || box.value })));
    dialog.current?.showModal();
  }

  function confirm() {
    dialog.current?.close();
    form.current?.requestSubmit();
  }

  const tooMany = picked.length > MAX_BULK_DECISIONS;
  const blocked = picked.length === 0 || tooMany;

  return (
    <form ref={form} id={formId} action={action} className="mt-5 rounded-[12px] border border-line bg-bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[14.5px] font-bold">선택한 것 내리기</h2>
        <p className="text-[13px] text-fg-3">
          아래 {total}건 중 체크한 것만 · 한 번에 최대 {MAX_BULK_DECISIONS}건
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* submit 이 아니다 — 누르면 확인 창만 뜬다. 실제로 내리는 것은 창 안의 버튼이다 */}
        <button
          type="button"
          onClick={openConfirm}
          disabled={pending}
          aria-haspopup="dialog"
          className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-[13px] font-semibold text-down disabled:opacity-50"
        >
          {pending ? "내리는 중…" : "선택 차단"}
        </button>
        <span className="text-[13px] text-fg-3">
          누르면 확인 창이 먼저 뜹니다
        </span>
      </div>

      <dialog
        ref={dialog}
        aria-labelledby={`${formId}-confirm-title`}
        onClick={(event) => { if (event.target === dialog.current) dialog.current?.close(); }}
        className="w-[min(560px,calc(100vw-32px))] rounded-[14px] border border-line bg-bg-card p-0 text-fg backdrop:bg-black/50"
      >
        <div className="p-5">
          <h3 id={`${formId}-confirm-title`} className="text-[16px] font-extrabold">
            {picked.length === 0 ? "선택한 제품이 없습니다" : `${picked.length}건을 공개 목록에서 내립니다`}
          </h3>

          {picked.length > 0 && (
            <div role="alert" className="mt-3 rounded-lg border border-down/40 bg-down/10 p-3 text-[13px] leading-[1.6] text-fg">
              <p className="font-bold text-down">한 번 누르면 {picked.length}건이 한꺼번에 처리됩니다.</p>
              <ul className="mt-1.5 list-disc pl-5">
                <li>사이트에서 <b>곧바로 사라집니다</b> — 목록에서 빠지고 상세 페이지는 없는 페이지가 됩니다.</li>
                <li>같은 주소를 다시 수집하거나 다시 등록할 수 없게 막힙니다.</li>
                <li>되돌리려면 제품 화면에서 <b>한 건씩</b> 풀어야 합니다. 한꺼번에 되돌리는 기능은 없습니다.</li>
              </ul>
            </div>
          )}

          {tooMany && (
            <p className="mt-3 text-[13px] font-semibold text-down">
              한 번에 최대 {MAX_BULK_DECISIONS}건까지입니다. 체크를 줄여서 다시 눌러주세요.
            </p>
          )}

          {picked.length > 0 && (
            <>
              <p className="mt-4 text-[13px] font-semibold text-fg-2">내릴 것 — 이름을 한 번 훑어 주세요</p>
              <ol className="mt-1.5 max-h-[40vh] list-decimal overflow-y-auto rounded-lg border border-line bg-bg-soft py-2 pl-9 pr-3 text-[13px]">
                {picked.map((item) => (
                  <li key={item.slug} className="py-0.5">
                    <span className="font-semibold">{item.name}</span>
                    <span className="ml-2 font-mono text-fg-3">{item.slug}</span>
                  </li>
                ))}
              </ol>
            </>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {/* 기본 초점 — 엔터를 치면 내리지 않고 닫힌다 */}
            <button type="button" autoFocus onClick={() => dialog.current?.close()}
              className="rounded-lg border border-line bg-bg-soft px-4 py-2 text-[13px] font-semibold text-fg-2 hover:text-fg">
              취소
            </button>
            <button type="button" onClick={confirm} disabled={blocked}
              className="rounded-lg border border-down bg-down px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40">
              {picked.length > 0 ? `${picked.length}건 내리기` : "내리기"}
            </button>
          </div>
        </div>
      </dialog>

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
