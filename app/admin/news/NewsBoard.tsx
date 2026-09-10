"use client";

import { useActionState, useState } from "react";
import { decideNews, type NewsActionState } from "./actions";

export type NewsBoardItem = {
  id: number;
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  state: "approved" | "pending" | "hidden";
};

const STATE_LABEL: Record<NewsBoardItem["state"], { text: string; className: string }> = {
  approved: { text: "게시", className: "border-up/40 bg-up/10 text-up" },
  pending: { text: "대기", className: "border-accent bg-accent-soft text-accent" },
  hidden: { text: "숨김", className: "border-line bg-bg-soft text-fg-3" },
};

const posted = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });

/** 글 목록. 고른 것을 한 번에 게시하거나 숨긴다 */
export function NewsBoard({ items }: { items: NewsBoardItem[] }) {
  const [state, action, pending] = useActionState<NewsActionState, FormData>(decideNews, null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const allSelected = items.length > 0 && selected.size === items.length;
  const toggle = (id: number) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" name="decision" value="approved" disabled={pending || selected.size === 0}
          className="rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-[13px] font-semibold text-up disabled:opacity-50">
          선택 게시
        </button>
        <button type="submit" name="decision" value="hidden" disabled={pending || selected.size === 0}
          className="rounded-lg border border-line bg-bg-card px-3 py-2 text-[13px] font-semibold disabled:opacity-50">
          선택 숨김
        </button>
        <span className="text-[13px] text-fg-3">{selected.size}건 선택</span>
        <div aria-live="polite">
          {state?.error && <p className="text-[13px] text-down">{state.error}</p>}
          {state?.ok && <p className="text-[13px] font-semibold text-up">{state.ok}</p>}
        </div>
      </div>

      <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="text-left text-fg-3">
            <tr className="border-b border-line">
              <th className="px-3 py-2">
                <input type="checkbox" aria-label="모두 선택" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))} />
              </th>
              <th className="px-3 py-2 font-semibold">출처</th>
              <th className="px-3 py-2 font-semibold">제목</th>
              <th className="px-3 py-2 font-semibold">게시일</th>
              <th className="px-3 py-2 font-semibold">상태</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-line last:border-0 align-top">
                <td className="px-3 py-2">
                  <input type="checkbox" name="id" value={item.id} checked={selected.has(item.id)} onChange={() => toggle(item.id)}
                    aria-label={`${item.title} 선택`} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-fg-2">{item.source}</td>
                <td className="px-3 py-2">
                  <a href={item.url} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">{item.title}</a>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-fg-3">{posted(item.publishedAt)}</td>
                <td className="px-3 py-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[13px] font-semibold ${STATE_LABEL[item.state].className}`}>
                    {STATE_LABEL[item.state].text}
                  </span>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-fg-3">이 상태의 글이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </form>
  );
}
