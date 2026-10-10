import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AdminReviewEntry } from "@/lib/crawl/admin-review";

// 정적 그리기에는 앱 라우터·서버 액션이 없다
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/app/admin/review/actions", () => ({ undoCandidateDecisions: vi.fn(), approveWithTagline: vi.fn(), collectCandidateEvidence: vi.fn() }));
vi.mock("@/app/admin/actions", () => ({ decideCrawlCandidate: vi.fn() }));

const { ReviewConsole } = await import("@/app/admin/review/ReviewConsole");

const entry = (id: number, repo: string, productUrl: string | null, name = repo) => ({
  candidate: { id, repo, productUrl, state: "needs_review", reason: null, publishedSlug: null, signals: {}, decidedBy: "auto",
    judgedAt: null, updatedAt: null },
  inputHash: "in", sourceRevisionHash: "src", candidateRevisionHash: `rev-${id}`, name, description: "", relationship: "", scanState: "",
  evidence: [], status: "succeeded", refreshCount: 0, latest: null, review: null, verdict: null, bucket: null, tagline: null, seconds: [],
}) as unknown as AdminReviewEntry;

const render = (entries: AdminReviewEntry[]) => renderToStaticMarkup(createElement(ReviewConsole, {
  entries, reasons: [], sort: "", sortHref: { "": "", stars: "", push: "", push_old: "", wait: "", wait_short: "" },
  cause: "", causes: [], title: "확정만 · 2건", pageHref: { prev: null, next: null },
}));

/** 심사 표의 후보 칸 — 승인 전에 저장소와 배포 페이지를 표에서 바로 연다(2026-10-10 운영자 요청) */
describe("심사 표 후보 칸의 링크", () => {
  it("모든 줄에 GitHub 링크, 배포 URL 이 있으면 그 주소 링크를 단다", () => {
    const out = render([entry(1, "acme/tool", "https://tool.acme.dev/app"), entry(2, "solo/cli", null, "Solo CLI")]);
    const table = out.slice(out.indexOf("<table"), out.indexOf("</table>"));
    expect(table).toContain('href="https://github.com/acme/tool"');
    expect(table).toContain('href="https://github.com/solo/cli"');
    expect(table).toContain('href="https://tool.acme.dev/app"');
    expect(table).toContain("tool.acme.dev ↗");
    // 배포 URL 이 없는 줄은 GitHub 링크만 — 표 안의 바깥 링크는 셋이다
    expect(table.match(/target="_blank"/g)).toHaveLength(3);
    // J/K·Enter 흐름을 지키려고 줄 안 링크는 탭 순서에서 뺀다
    expect(table.match(/<a [^>]*tabindex="-1"/g)).toHaveLength(3);
  });

  it("http(s) 가 아니거나 계정 정보가 든 배포 주소는 링크로 만들지 않는다", () => {
    const out = render([entry(1, "acme/a", "javascript:alert(1)"), entry(2, "acme/b", "https://user:pw@evil.example")]);
    const table = out.slice(out.indexOf("<table"), out.indexOf("</table>"));
    expect(table).not.toContain("javascript:");
    expect(table).not.toContain("evil.example");
    expect(table.match(/target="_blank"/g)).toHaveLength(2);
  });
});
