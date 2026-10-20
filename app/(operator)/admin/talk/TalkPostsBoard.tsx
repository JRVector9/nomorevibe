"use client";

import { useActionState, useState } from "react";
import { formatListTime } from "@/lib/format/time";
import { ScrollTable } from "../components/ScrollTable";
import { decideTalkPosts, excludeTalkRepository, type TalkActionState } from "./actions";

export type TalkPostRow = {
  id: number;
  source: string;
  kind: "link" | "show";
  title: string;
  discussionUrl: string;
  linkTarget: string;
  repositoryKey: string | null;
  points: number;
  comments: number;
  postedAt: string;
  state: "visible" | "hidden" | "gone";
  excluded: boolean;
  product: { slug: string; status: string } | null;
};

const STATE_LABEL: Record<TalkPostRow["state"], { text: string; className: string }> = {
  visible: { text: "보임", className: "border-up/40 bg-up/10 text-up" },
  hidden: { text: "숨김", className: "border-line bg-bg-soft text-fg-3" },
  gone: { text: "원문 지워짐", className: "border-down/40 bg-down/5 text-down" },
};
const TARGET_LABEL: Record<string, string> = { repo: "저장소", path: "저장소 안", issue: "이슈", pull: "PR", site: "제품 사이트" };

/** 화제 글 — 고른 글을 숨기거나 다시 보이고, 저장소째 화제에서 뺀다. now 는 서버가 그린 시각 */
export function TalkPostsBoard({ rows, now }: { rows: TalkPostRow[]; now: string }) {
  const [state, action, pending] = useActionState<TalkActionState, FormData>(decideTalkPosts, null);
  const [excludeState, exclude, excluding] = useActionState<TalkActionState, FormData>(excludeTalkRepository, null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggle = (id: number) => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const message = (value: TalkActionState) => value?.error
    ? <p className="text-[13px] text-down">{value.error}</p>
    : value?.ok ? <p className="text-[13px] font-semibold text-up">{value.ok}</p> : null;

  return (
    <div className="flex flex-col gap-3">
      <form action={action} id="talk-posts" className="flex flex-wrap items-center gap-2">
        <button type="submit" name="decision" value="hidden" disabled={pending || selected.size === 0}
          className="rounded-lg border border-line bg-bg-card px-3 py-2 text-[13px] font-semibold disabled:opacity-50">선택 숨기기</button>
        <button type="submit" name="decision" value="visible" disabled={pending || selected.size === 0}
          className="rounded-lg border border-up/40 bg-up/10 px-3 py-2 text-[13px] font-semibold text-up disabled:opacity-50">선택 다시 보이기</button>
        <span className="text-[13px] text-fg-3">{selected.size}건 선택</span>
        <div aria-live="polite">{message(state)}{message(excludeState)}</div>
      </form>
      <div className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
        <ScrollTable label="화제 글">
          <table className="w-full min-w-[900px] text-[13px]">
            <thead className="text-left text-fg-3">
              <tr className="border-b border-line">
                <th className="px-3 py-2"><input type="checkbox" aria-label="모두 선택" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(row => row.id)))} /></th>
                <th className="px-3 py-2 font-semibold">출처</th>
                <th className="px-3 py-2 font-semibold">글</th>
                <th className="px-3 py-2 font-semibold">점수 · 댓글</th>
                <th className="px-3 py-2 font-semibold">게시</th>
                <th className="px-3 py-2 font-semibold">저장소 · 연결 제품</th>
                <th className="px-3 py-2 font-semibold">상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-b border-line align-top last:border-0">
                  <td className="px-3 py-2">
                    <input type="checkbox" form="talk-posts" name="id" value={row.id} checked={selected.has(row.id)} onChange={() => toggle(row.id)}
                      aria-label={`${row.title} 선택`} disabled={row.state === "gone"} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-fg-2">{row.source}{row.kind === "show" ? " · 메이커 글" : ""}</td>
                  <td className="px-3 py-2">
                    <a href={row.discussionUrl} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">{row.title}</a>
                    <span className="ml-1 text-fg-3">({TARGET_LABEL[row.linkTarget] ?? row.linkTarget})</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono">{row.points} · {row.comments}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-fg-3">{formatListTime(row.postedAt, now)}</td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-[13px]">{row.repositoryKey ?? "—"}</span>
                    <span className="block text-fg-3">
                      {row.product ? <a href={`/p/${row.product.slug}`} target="_blank" rel="noopener noreferrer" className="hover:underline">{row.product.slug} · {row.product.status}</a> : "제품 없음"}
                    </span>
                    {row.repositoryKey && (
                      <form action={exclude} className="mt-1">
                        <input type="hidden" name="repository" value={row.repositoryKey} />
                        <input type="hidden" name="excluded" value={row.excluded ? "false" : "true"} />
                        <button type="submit" disabled={excluding}
                          className={`rounded-md border px-2 py-0.5 text-[13px] ${row.excluded ? "border-up/40 text-up" : "border-down/40 text-down"} disabled:opacity-50`}>
                          {row.excluded ? "화제에 되돌리기" : "저장소를 화제에서 빼기"}
                        </button>
                      </form>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[13px] font-semibold ${STATE_LABEL[row.state].className}`}>{STATE_LABEL[row.state].text}</span>
                    {row.excluded && <span className="mt-1 block text-[13px] text-down">저장소 빠짐</span>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-fg-3">최근 7일 동안 기록한 화제 글이 없습니다.</td></tr>}
            </tbody>
          </table>
        </ScrollTable>
      </div>
    </div>
  );
}
