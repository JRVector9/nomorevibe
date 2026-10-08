import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildHumanQueueOverview, heldStages, humanFlowLabel, humanWaitLabel } from "@/lib/crawl/human-queue";
import type { ReviewAiDecision } from "@/lib/crawl/admin-review";
import { StageRail } from "@/app/admin/status/dashboard/StageRail";
import { ReviewStageRail } from "@/app/admin/review/ReviewStageRail";
import { AttentionList, sortActions, type ActionItem } from "@/app/admin/status/dashboard/AttentionList";
import { humanOverview } from "./fixtures/human-queue";

// 쌓인 일의 "확인함" 단추가 router 를 쓴다 — 정적 그리기에는 앱 라우터가 없다
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

/**
 * "사람이 볼 것"은 한 곳(human-queue.ts)에서 정하고 운영센터·심사 큐가 같은 필드를 그린다(2026-10-08 감사 ADM-04).
 * 전에는 운영센터 "사람 확인 1,355 · 최장 39일", 심사 큐 "직접 판단 1,075 · 최장 7일"로 같은 개념이 갈렸다.
 */
const html = (element: React.ReactElement) => renderToStaticMarkup(element);
const noSecond = { unanimous_reject: [], unanimous_approve: [], agreed_reject: [], agreed_approve: [], needs_human: [] };

describe("사람이 볼 것 — 정의", () => {
  it("사람만 가르는 사유는 모두 직접 판단에 서고, 2차가 같은 결론을 낸 것은 확정만에 남아 구간이 겹치지 않는다", () => {
    const aiIds = new Map<ReviewAiDecision, number[]>([["none", [1, 2, 3]], ["approve", [4, 5]], ["reject", []], ["needs_review", []]]);
    // 1: 재시도 소진(AI 결론 없음) · 2: 저장소 삭제 · 4: 사람만 가르는 사유인데 2차가 2표 일치
    const result = heldStages(aiIds, { ...noSecond, agreed_approve: [4] }, [1, 2, 4]);
    expect(result.ids).toEqual({ ai: [3], second: [5], agreed: [4], human: [1, 2] });
    const all = Object.values(result.ids).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("2차 칩의 수는 보류 안의 후보로 좁히고, 사람 몫은 확정만 + 직접 판단이다", () => {
    const overview = buildHumanQueueOverview({
      aiDecisions: { counts: { approve: 3, reject: 0, needs_review: 0, none: 0 }, ids: new Map([["approve", [1, 2, 3]], ["reject", []], ["needs_review", []], ["none", []]]) },
      // 99 는 이미 보류가 아니다 — 2차 행은 후보가 다시 판정돼도 남는다
      seconds: { counts: { unanimousReject: 0, unanimousApprove: 0, agreedReject: 0, agreedApprove: 2, needsHuman: 1, published: 4, pending: 0 },
        ids: { ...noSecond, agreed_approve: [1, 99], needs_human: [2] } },
      humanOnly: [3], wait: { oldestDays: 7, stalled: 0, in24h: 2 }, decided24h: { approve: 1, reject: 2 },
    });
    expect(overview.second.agreed_approve).toBe(1);
    expect(overview.secondIds.agreed_approve).toEqual([1]);
    expect(overview.stages).toEqual({ ai: 0, second: 0, agreed: 1, human: 2 });
    expect(overview.person).toBe(3);
    expect(overview.held).toBe(3);
    expect(overview.secondPublished).toBe(4);
    expect(humanWaitLabel(overview)).toBe("판정 뒤 최장 7일");
    expect(humanFlowLabel(overview)).toBe("24h +2 · 처리 3");
  });

  it("운영센터 파이프라인과 심사 큐 구간은 같은 객체에서 같은 수·문구를 그린다", () => {
    const overview = humanOverview({ human: 1075, agreed: 49, oldestDays: 7, in24h: 238, decided: 12 });
    const status = html(createElement(StageRail, { snapshot: null, flow: { stages: [], bottleneck: null, published: 0 }, human: overview }));
    const counts = { judge: 0, ...overview.stages, publish: 0, published: 0, rejected: 0 };
    const review = html(createElement(ReviewStageRail, { stage: "", counts, overview, publication: { added: 0, removed: 0, net: 0 } }));
    for (const text of ["1,075", "49", humanWaitLabel(overview), humanFlowLabel(overview)]) {
      expect(status, `운영센터: ${text}`).toContain(text);
      expect(review, `심사 큐: ${text}`).toContain(text);
    }
    // 옛 정의(보류 전체·2차 갈림)는 더 쓰지 않는다
    expect(status).not.toContain("2차 갈림");
  });

  it("직접 판단이 비면 나이를 말하지 않는다", () => {
    expect(humanWaitLabel(humanOverview())).toBe("대기 없음");
  });
});

describe("조치할 일 — 자리와 순서", () => {
  const item = (key: string, tone: ActionItem["tone"]): ActionItem => ({ key, tone, count: 1, unit: "건", title: key, detail: `${key} 설명` });
  const split = (row: ActionItem) => ({ ...row, trend: null, fresh: false });

  it("급한 것부터, 같은 급 안에서는 넣은 차례(막는 순서)를 지킨다", () => {
    const sorted = sortActions([item("review", "hold"), item("second", "hold"), item("health", "clear"), item("down", "critical"), item("jobs", "critical")]);
    expect(sorted.map((row) => row.key)).toEqual(["down", "jobs", "review", "second", "health"]);
  });

  it("지금 조치와 쌓인 일을 두 칸으로 나눠 그린다 — 지금 조치가 먼저", () => {
    const out = html(createElement(AttentionList, { urgent: [split(item("down", "critical"))], backlog: [split(item("review", "hold"))], hidden: [], now: "2026-10-08T04:38:00Z" }));
    expect(out.match(/dash-6/g)).toHaveLength(2);
    expect(out.indexOf("지금 조치")).toBeLessThan(out.indexOf("쌓인 일"));
    expect(out.indexOf("down 설명")).toBeLessThan(out.indexOf("review 설명"));
  });

  it("지금 조치가 비면 '지금 손댈 것이 없습니다'를 보인다", () => {
    const out = html(createElement(AttentionList, { urgent: [], backlog: [split(item("review", "hold"))], hidden: [], now: "2026-10-08T04:38:00Z" }));
    expect(out).toContain("지금 손댈 것이 없습니다");
    expect(out).toContain("review 설명");
  });
});
