import type { AdminReviewEntry } from "@/lib/crawl/admin-review";

export type SecondVoteView = { label: string; tone: "ok" | "bad" | "warn" | "soft"; title: string };

const DECISION: Record<string, { label: string; tone: SecondVoteView["tone"] }> = {
  approve: { label: "승인", tone: "ok" },
  reject: { label: "거부", tone: "bad" },
  needs_review: { label: "보류", tone: "soft" },
};

/**
 * 표 한 칸에 적을 2차 표 — 상세를 열지 않고도 두 모델이 어떻게 갈렸는지 보이게.
 *
 * 1차와 같은 모델의 표(메아리)는 셈에서 빠지므로 칸에도 적지 않는다. 결론이 난 표가 먼저고, 그중 거부가 먼저다 —
 * 사람이 확인할 이유가 되는 쪽이다. 대체 모델(sonnet)이 낸 표면 "대체"를 붙인다.
 */
export function secondVoteView(seconds: AdminReviewEntry["seconds"]): SecondVoteView | null {
  const votes = seconds.filter((vote) => !vote.echo);
  if (votes.length === 0) return null;
  const decided = votes.filter((vote) => vote.decision && vote.status !== "pending" && vote.status !== "failed")
    .sort((a, b) => (a.decision === "reject" ? 0 : 1) - (b.decision === "reject" ? 0 : 1));
  const pick = decided[0];
  const title = (vote: (typeof votes)[number]) => [vote.isFallback ? "대체 심사" : "2차", vote.model, vote.status].filter(Boolean).join(" · ");
  if (pick) {
    const decision = DECISION[pick.decision!] ?? { label: pick.decision!, tone: "soft" as const };
    const confidence = typeof pick.confidence === "number" ? ` ${pick.confidence.toFixed(2)}` : "";
    return { label: `${pick.isFallback ? "대체 " : ""}${decision.label}${confidence}`, tone: decision.tone, title: title(pick) };
  }
  const failed = votes.find((vote) => vote.status === "failed" || (vote.status === "needs_human" && vote.errorCode));
  if (failed) return { label: failed.status === "failed" ? "실패" : "재시도 끝", tone: "warn", title: `${title(failed)} · ${failed.errorCode ?? ""}` };
  return { label: "대기", tone: "soft", title: title(votes[0]) };
}
