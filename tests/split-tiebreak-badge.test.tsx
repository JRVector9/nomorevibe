import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdminReviewEntry } from "@/lib/crawl/admin-review";

// 정적 그리기에는 앱 라우터·서버 액션이 없다
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/app/(operator)/admin/review/actions", () => ({ undoCandidateDecisions: vi.fn(), approveWithTagline: vi.fn(), collectCandidateEvidence: vi.fn() }));
vi.mock("@/app/(operator)/admin/actions", () => ({ decideCrawlCandidate: vi.fn() }));

const { ReviewConsole } = await import("@/app/(operator)/admin/review/ReviewConsole");

const verdict = { decision: "approve" as const, confidence: 0.95, reason: "The homepage introduces a usable product.", model: "qwen3.8-flash-next",
  promptVersion: "2026-10-21.v2", applied: "kept_human", at: "2026-10-21T00:00:00.000Z", current: true };
const entry = (id: number, tiebreak: typeof verdict | null) => ({
  candidate: { id, repo: `acme/tool-${id}`, productUrl: null, state: "needs_review", reason: "second_review_split", publishedSlug: null, signals: {},
    decidedBy: "auto", judgedAt: null, updatedAt: null },
  inputHash: "in", sourceRevisionHash: "src", candidateRevisionHash: `rev-${id}`, name: `Tool ${id}`, description: "", relationship: "", scanState: "",
  evidence: [], status: "succeeded", refreshCount: 0, latest: null, review: null, verdict: null, bucket: "second_review_split", tagline: null, seconds: [],
  tiebreak,
}) as unknown as AdminReviewEntry;

const render = (entries: AdminReviewEntry[]) => renderToStaticMarkup(createElement(ReviewConsole, {
  entries, reasons: [], sort: "", sortHref: { "": "", stars: "", push: "", push_old: "", wait: "", wait_short: "" },
  cause: "", causes: [], title: "직접 판단 · 3건", pageHref: { prev: null, next: null },
}));

/** 갈림 보류에 Qwen-v2 도 승인한 줄 — «Qwen-v2 승인 — 발행 후보» 배지(lib/crawl/gate-split-tiebreak.ts) */
describe("갈림 판가름 배지", () => {
  it("지금 세대의 승인 줄에만 배지를 달고, 상세에 답과 처리를 보인다", () => {
    const out = render([entry(1, verdict), entry(2, { ...verdict, current: false }), entry(3, null)]);
    const table = out.slice(out.indexOf("<table"), out.indexOf("</table>"));
    expect(table.match(/Qwen-v2 승인 — 발행 후보/g)).toHaveLength(1);
    expect(table.indexOf("Qwen-v2 승인 — 발행 후보")).toBeLessThan(table.indexOf("Tool 2"));
    // 첫 줄의 상세 — 승인이지만 발행하지 않았다는 것과 모델·판
    const panel = out.slice(out.indexOf("</table>"));
    expect(panel).toContain("Qwen-v2 승인 — 발행 후보");
    expect(panel).toContain("승인 · 발행하지 않고 사람 확인을 기다립니다");
    expect(panel).toContain("qwen3.8-flash-next · 2026-10-21.v2");
  });
});
