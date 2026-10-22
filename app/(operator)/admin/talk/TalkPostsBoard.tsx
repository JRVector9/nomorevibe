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
  /** 원문(HN 토론·X 게시물) */
  discussionUrl: string;
  /** 글이 가리킨 주소(http(s) 가 아니면 null)와 그 호스트 */
  linkUrl: string | null;
  linkHost: string;
  linkTarget: string;
  repositoryKey: string | null;
  points: number;
  comments: number;
  /** 단위를 단 반응 — HN "90점 · 댓글 20", X·Bluesky "반응 52 · 답글 3"(lib/social/talk-reasons.ts reactionLabel) */
  reaction: string;
  /** 출처의 /talk 자격 기준과 넘었는지(talkQualifies·thresholdLabel) */
  threshold: { met: boolean; rule: string };
  frontPage: boolean;
  postedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  state: "visible" | "hidden" | "gone";
  excluded: boolean;
  /** statusLabel — 상태 코드의 이름(검증됨·미클레임·검증 대기·차단됨). 코드는 title 로만 */
  product: { slug: string; status: string; statusLabel: string } | null;
  /** 지금 /talk 에 오르는지, 아니면 왜 아닌지(lib/social/talk-reasons.ts) — '보임'은 상태(숨김의 반대)에만 쓴다 */
  talk: { shown: boolean; rank: number | null; reasons: string[] };
};

const STATE_LABEL: Record<TalkPostRow["state"], { text: string; className: string }> = {
  visible: { text: "보임", className: "border-up/40 bg-up/10 text-up" },
  hidden: { text: "숨김", className: "border-line bg-bg-soft text-fg-3" },
  gone: { text: "원문 삭제", className: "border-down/40 bg-down/5 text-down" },
};
const TARGET_LABEL: Record<string, string> = { repo: "저장소", path: "저장소 안", issue: "이슈", pull: "PR", site: "저장소 아님" };

/** 수집한 글 — 고른 글을 숨기거나 다시 보이고, 저장소째 화제에서 뺀다. now 는 서버가 그린 시각 */
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
        <ScrollTable label="수집한 글">
          <table className="w-full min-w-[1100px] text-[13px]">
            <thead className="text-left text-fg-3">
              <tr className="border-b border-line">
                <th className="px-3 py-2"><input type="checkbox" aria-label="이 쪽 모두 선택" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(row => row.id)))} /></th>
                <th className="px-3 py-2 font-semibold">출처</th>
                <th className="px-3 py-2 font-semibold">글</th>
                <th className="px-3 py-2 font-semibold">반응 · 자격 기준</th>
                <th className="px-3 py-2 font-semibold">게시 · 확인</th>
                <th className="px-3 py-2 font-semibold">저장소 · 연결 제품</th>
                <th className="px-3 py-2 font-semibold">상태</th>
                <th className="px-3 py-2 font-semibold">/talk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-b border-line align-top last:border-0">
                  <td className="px-3 py-2">
                    <input type="checkbox" form="talk-posts" name="id" value={row.id} checked={selected.has(row.id)} onChange={() => toggle(row.id)}
                      aria-label={`${row.title} 선택`} disabled={row.state === "gone"} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-fg-2">
                    {row.source}{row.kind === "show" ? " · 메이커 글" : ""}
                    {row.frontPage && <span className="block text-fg-3">첫 화면</span>}
                  </td>
                  <td className="max-w-[360px] px-3 py-2">
                    <a href={row.discussionUrl} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline">{row.title}</a>
                    <span className="block break-all text-fg-3">
                      {row.linkUrl ? <a href={row.linkUrl} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">{row.linkHost}</a> : row.linkHost}
                      {" "}({TARGET_LABEL[row.linkTarget] ?? row.linkTarget})
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="font-mono">{row.reaction}</span>
                    <span className={`block ${row.threshold.met ? "text-fg-2" : "text-fg-3"}`}>{row.threshold.met ? "기준 넘음" : "기준 아래"} · {row.threshold.rule}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-fg-3">
                    <span className="text-fg-2">{formatListTime(row.postedAt, now)}</span>
                    <span className="block">처음 {formatListTime(row.firstSeenAt, now)}</span>
                    <span className="block">마지막 {formatListTime(row.lastSeenAt, now)}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-[13px]">{row.repositoryKey ?? "—"}</span>
                    <span className="block text-fg-3">
                      {row.product ? <a href={`/p/${row.product.slug}`} target="_blank" rel="noopener noreferrer" className="hover:underline" title={row.product.status}>{row.product.slug} · {row.product.statusLabel}</a>
                        : row.repositoryKey ? "제품 없음" : "저장소 없음"}
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
                  <td className="min-w-[180px] px-3 py-2">
                    {row.talk.shown
                      ? <span className="whitespace-nowrap rounded-full border border-up/40 bg-up/10 px-2 py-0.5 text-[13px] font-semibold text-up">오름 · {row.talk.rank}위</span>
                      : <span className="whitespace-nowrap rounded-full border border-line bg-bg-soft px-2 py-0.5 text-[13px] font-semibold text-fg-3">안 오름</span>}
                    {row.talk.reasons.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-0.5 text-[13px] text-fg-2">
                        {row.talk.reasons.map(reason => <li key={reason}>{reason}</li>)}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-fg-3">조건에 맞는 글이 없습니다.</td></tr>}
            </tbody>
          </table>
        </ScrollTable>
      </div>
    </div>
  );
}
