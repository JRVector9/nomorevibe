import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminReviewEntry } from "@/lib/crawl/admin-review";
import type { ModelHealth } from "@/lib/operations/dashboard";
import { secondVoteView } from "@/app/admin/review/secondVote";
import { ReviewStatusChips } from "@/app/admin/review/ReviewStatusChips";
import { ReviewStageRail } from "@/app/admin/review/ReviewStageRail";
import { ReviewTodo } from "@/app/admin/review/ReviewTodo";
import { humanOverview } from "./fixtures/human-queue";

/**
 * 심사 큐 머리·구간·할 일·2차 표 칸 — 숫자와 색이 데이터대로 나오는지.
 * 배치(12칸 격자·여덟 칸 레일)는 CSS 라 여기서 못 본다.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);
type Vote = AdminReviewEntry["seconds"][number];
const vote = (over: Partial<Vote>): Vote => ({ decision: null, confidence: null, reason: null, reasonKo: null, model: "grok-4.7",
  provider: "grok-cli", status: "pending", trigger: "ai_approved", errorCode: null, echo: false, ...over });

describe("2차 표 칸", () => {
  it("1차와 같은 모델의 표는 세지 않고, 결론 난 표 중 거부가 먼저다", () => {
    expect(secondVoteView([])).toBeNull();
    expect(secondVoteView([vote({ echo: true, decision: "approve", status: "agreed" })])).toBeNull();
    const view = secondVoteView([vote({ decision: "approve", confidence: 0.9, status: "agreed" }),
      vote({ model: "sonnet", decision: "reject", confidence: 0.94, status: "needs_human", isFallback: true })]);
    expect(view).toMatchObject({ label: "대체 거부 0.94", tone: "bad" });
    expect(view!.title).toContain("sonnet");
  });

  it("결론이 없으면 실패·재시도 끝·대기 순으로 적는다", () => {
    expect(secondVoteView([vote({ status: "failed", errorCode: "timeout" })])).toMatchObject({ label: "실패", tone: "warn" });
    expect(secondVoteView([vote({ status: "needs_human", errorCode: "cli_error" })])).toMatchObject({ label: "재시도 끝", tone: "warn" });
    expect(secondVoteView([vote({})])).toMatchObject({ label: "대기", tone: "soft" });
    expect(secondVoteView([vote({ decision: "approve", confidence: 0.88, status: "agreed" })])).toMatchObject({ label: "승인 0.88", tone: "ok" });
  });
});

describe("머리말 칩", () => {
  const models: ModelHealth[] = [
    { key: "first", label: "1차 심사", model: "[MLX] gpt-oss-120b", calls1h: 146, failed1h: 0, avgSeconds: 11, agreement1h: null, lastSuccessAt: null },
    { key: "second", label: "2차 투표", model: "grok-4.7", calls1h: 80, failed1h: 1, avgSeconds: 9, agreement1h: 0.62, lastSuccessAt: null },
  ];
  it("1·2차 모델의 1시간, 24시간 사람 처리·발행, 내려달라는 요청을 한 줄에 적는다", () => {
    const out = html(createElement(ReviewStatusChips, { models, human: { approve: 198, reject: 14 }, publication: { net: 1156 }, takedowns: 2 }));
    expect(out).toContain("1차 [MLX] gpt-oss-120b");
    expect(out).toContain("2차 grok-4.7");
    expect(out).toContain("1차와 일치 <span class=\"font-mono\">62%</span>");
    expect(out).toContain("212</span>건 · 승인 198 · 거부 14");
    expect(out).toContain("+1,156");
    expect(out.match(/data-tone="warn"/g)?.length).toBeGreaterThanOrEqual(1);
    expect(out).toContain('data-tone="bad"');
  });

  it("모델 관측이 없으면 모델 칩을 빼고 나머지는 그린다", () => {
    const out = html(createElement(ReviewStatusChips, { models: null, human: null, publication: { net: -3 }, takedowns: 0 }));
    expect(out).not.toContain("1차");
    expect(out).toContain("-3");
    expect(out).toContain("내려달라는 요청");
  });
});

describe("구간 레일과 할 일", () => {
  const counts = { judge: 0, ai: 101, second: 22, agreed: 15, human: 3904, publish: 17, published: 29820, rejected: 146819 };
  it("여덟 칸에 수를 적고, 사람 칸에는 최장·24시간 유입, 500 넘으면 주황, 고른 칸은 현재 위치다", () => {
    const overview = humanOverview({ human: 3904, agreed: 15, oldestDays: 45, in24h: 38, decided: 7 });
    const out = html(createElement(ReviewStageRail, { stage: "human", counts, overview, publication: { added: 3, removed: 1, net: 2 } }));
    expect(out.match(/<a /g)).toHaveLength(8);
    expect(out).toContain('aria-label="심사 구간"');
    expect(out).toContain("판정 뒤 최장 45일 · 24h +38 · 처리 7");
    expect(out).toContain("거부 0 · 승인 15");
    expect(out).toContain('aria-label="최근 24시간 발행 완료 +2건"');
    expect(out).toContain(">(+2)</span>");
    expect(out).toMatch(/aria-current="page"[^>]*data-tone="warn"|data-tone="warn"[^>]*aria-current="page"/);
    expect(out).toContain("3,904");
    expect(out).toContain('data-zero="true"');
  });

  it("할 일 카드는 0건이어도 자리를 지키고 흐려진다", () => {
    const out = html(createElement(ReviewTodo, { cards: [
      { key: "agreed", title: "확정만 하면 됨", detail: "한 번에 확정", count: 15, href: "/admin/review?stage=agreed", tone: "ok" },
      { key: "published", title: "공개분 확인", detail: "요청 0", count: 0, href: "/admin/review?second=published" },
    ] }));
    expect(out).toContain('href="/admin/review?stage=agreed"');
    expect(out).toContain('data-tone="ok"');
    expect(out.match(/data-zero="true"/g)).toHaveLength(1);
  });
});
