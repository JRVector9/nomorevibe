import Link from "next/link";
import type { AdminReviewEntry, ReviewAiDecision } from "@/lib/crawl/admin-review";
import { causeLabel } from "../review/causes";

const AI: Record<string, { label: string; className: string }> = {
  reject: { label: "AI 거부", className: "bg-down/10 text-down" },
  approve: { label: "AI 승인", className: "bg-up/10 text-up" },
  needs_review: { label: "AI 보류", className: "bg-bg-soft text-fg-2" },
};
const FILTERS: [ReviewAiDecision, string][] = [["reject", "AI 거부"], ["approve", "AI 승인"], ["needs_review", "AI 보류"], ["none", "판단 없음"]];

/**
 * 운영센터 가운데의 심사 대기 — 처리는 심사 큐에서 한다.
 *
 * 운영센터만 열어도 무엇이 기다리는지, AI가 무엇이라고 했는지가 보여야 한다. 줄을 누르면
 * 심사 큐에서 그 후보가 골라진 채로 열린다.
 */
export function QueuePreview({ entries, total, counts }: {
  entries: AdminReviewEntry[]; total: number; counts: Record<ReviewAiDecision, number>;
}) {
  return (
    <section aria-label="심사 대기" className="overflow-hidden rounded-[12px] border border-line bg-bg-card">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2 text-[13px]">
        <b className="mr-1 font-bold">심사 대기 {total.toLocaleString("ko-KR")}</b>
        {FILTERS.map(([key, label]) => (
          <Link key={key} href={`/admin/review?ai=${key}`} className="rounded-full border border-line px-2 py-0.5 text-fg-2 hover:bg-bg-hover">
            {label} <span className="font-mono">{counts[key]}</span>
          </Link>
        ))}
        <Link href="/admin/review?state=needs_review" className="ml-auto font-semibold text-accent">심사 큐에서 처리 →</Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] table-fixed text-[13px] tabular-nums">
          <colgroup><col /><col className="w-[150px]" /><col className="w-[76px]" /><col className="w-12" /><col className="w-16" /></colgroup>
          <thead className="bg-bg-soft text-left text-fg-3">
            <tr><th className="px-3 py-1.5 font-semibold">후보</th><th className="px-2 py-1.5 font-semibold">갈래</th><th className="px-2 py-1.5 font-semibold">AI 1차</th>
              <th className="px-2 py-1.5 text-right font-semibold">★</th><th className="px-3 py-1.5 text-right font-semibold">푸시</th></tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const signals = (entry.verdict?.signals ?? entry.candidate.signals ?? {}) as Record<string, unknown>;
              const chip = entry.review?.decision ? AI[entry.review.decision] : null;
              return (
                <tr key={entry.candidate.id} className="border-t border-line hover:bg-bg-hover">
                  <td className="px-3 py-1.5">
                    <Link href={`/admin/review?state=needs_review&focus=${entry.candidate.id}`} className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-semibold">{entry.name}</span>
                      <span className="truncate font-mono text-fg-3">{entry.candidate.repo}</span>
                    </Link>
                  </td>
                  <td className="truncate px-2 py-1.5">{entry.verdict?.cause
                    ? <span className="rounded bg-warn/10 px-1.5 py-0.5 font-semibold text-warn">{causeLabel(entry.verdict.cause).slice(0, 14)}</span>
                    : <span className="text-fg-3">—</span>}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">{chip ? <span className={`rounded px-1.5 py-0.5 font-semibold ${chip.className}`}>{chip.label}</span> : <span className="text-fg-3">—</span>}</td>
                  <td className="px-2 py-1.5 text-right">{typeof signals.stars === "number" ? signals.stars : "—"}</td>
                  <td className="px-3 py-1.5 text-right">{typeof signals.pushAgeDays === "number" ? `${signals.pushAgeDays}일` : "—"}</td>
                </tr>
              );
            })}
            {entries.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-fg-3">사람이 가를 후보가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
