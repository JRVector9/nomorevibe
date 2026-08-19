"use client";

import { useActionState } from "react";
import { decideCrawlCandidate, type ReviewState } from "../actions";
import type { CrawlCandidate } from "@/lib/db/schema";

/**
 * 거부 사유 목록은 서버에서 내려받는다.
 * 여기서 lib/crawl/review를 직접 import하면 그 모듈이 끌고 오는 DB가 클라이언트 번들에 들어간다.
 */
type Reason = { value: string; label: string };

const button =
  "rounded-lg border px-3 py-1.5 text-[13px] font-semibold disabled:opacity-50";

/** 판정 근거를 사람이 읽는 순서대로 — 무엇을 보고 갈랐는지가 먼저다 */
function signalLine(signals: Record<string, unknown> | null): string {
  if (!signals) return "";
  const parts: string[] = [];
  if (typeof signals.stars === "number") parts.push(`★${signals.stars}`);
  if (typeof signals.pushAgeDays === "number") parts.push(`${signals.pushAgeDays}일 전 푸시`);
  if (signals.ownerType === "Organization") parts.push("조직 계정");
  if (typeof signals.pageStatus === "number") {
    parts.push(signals.pageStatus === 0 ? "접속 실패" : `HTTP ${signals.pageStatus}`);
  }
  return parts.join(" · ");
}

export function ReviewItem({
  candidate,
  reasons,
}: {
  candidate: CrawlCandidate;
  reasons: readonly Reason[];
}) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(decideCrawlCandidate, null);
  const signals = signalLine(candidate.signals);

  return (
    <li className="rounded-[12px] border border-line bg-bg-card p-[18px]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <a
          href={`https://github.com/${candidate.repo}`}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[14px] font-bold hover:text-accent"
        >
          {candidate.repo}
        </a>
        {signals && <span className="font-mono text-[13px] text-fg-3">{signals}</span>}
      </div>

      {candidate.productUrl && (
        <a
          href={candidate.productUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 block text-[13px] text-fg-2 hover:text-accent"
        >
          {candidate.productUrl.replace(/^https?:\/\//, "")}
        </a>
      )}

      <form action={action} className="mt-3.5 flex flex-wrap items-center gap-2">
        <input type="hidden" name="repo" value={candidate.repo} />
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className={`${button} border-up/40 bg-up/10 text-up`}
        >
          발행 대상
        </button>
        <select
          name="reason"
          defaultValue={reasons[0]?.value}
          className="rounded-lg border border-line bg-bg-soft px-2.5 py-1.5 text-[13px] text-fg-2 outline-none focus:border-accent"
        >
          {reasons.map((reason) => (
            <option key={reason.value} value={reason.value}>
              {reason.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          name="decision"
          value="reject"
          disabled={pending}
          className={`${button} border-line text-fg-2 hover:text-fg`}
        >
          거부
        </button>
      </form>

      {state?.error && <p className="mt-2 text-[13px] text-down">{state.error}</p>}
    </li>
  );
}
