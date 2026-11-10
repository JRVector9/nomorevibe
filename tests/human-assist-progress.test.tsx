import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn(), cancelAdminModelOperation: vi.fn() }));
import { PrototypeFlow } from "@/app/(operator)/admin/flow/PrototypeFlow";
import { HumanAssistDecided, HumanAssistInsight, HumanAssistTaskProgress, humanAssistLine } from "@/app/(operator)/admin/flow/HumanAssistProgress";
import { buildConveyor } from "@/lib/operations/conveyor-model";
import type { HumanQueueOverview } from "@/lib/crawl/human-queue";
import { summarizeHumanAssist, type HumanAssistRow } from "@/lib/operations/human-assist-progress";

// 2026-11-10 운영 읽기(06:45Z)와 같은 모양의 집계 줄
const rows: HumanAssistRow[] = [
  { task: "human-review", bucket: "day", outcome: "approve", n: 42 }, { task: "human-review", bucket: "day", outcome: "reject", n: 46 },
  { task: "human-review", bucket: "day", outcome: "held", n: 1442 }, { task: "human-review", bucket: "day", outcome: "refresh", n: 43 },
  { task: "human-review", bucket: "day", outcome: "failed", n: 43 }, { task: "human-review", bucket: "hour", outcome: "approve", n: 4 },
  { task: "human-review", bucket: "hour", outcome: "reject", n: 3 }, { task: "human-review", bucket: "hour", outcome: "held", n: 166 },
  { task: "human-review", bucket: "five", outcome: "approve", n: 1 }, { task: "human-review", bucket: "five", outcome: "held", n: 12 },
  { task: "split-confirm", bucket: "day", outcome: "reject", n: 7 }, { task: "split-confirm", bucket: "day", outcome: "held", n: 5 },
  { task: "split-tiebreak", bucket: "day", outcome: "forward", n: 8 }, { task: "split-tiebreak", bucket: "day", outcome: "ineligible", n: 1200 },
  { task: "held-review-retry", bucket: "day", outcome: "reject", n: 13 }, { task: "held-review-retry", bucket: "day", outcome: "forward", n: 6 },
  // 모르는 작업·결과·창은 버린다
  { task: "unknown-task", bucket: "day", outcome: "reject", n: 99 }, { task: "human-review", bucket: "week", outcome: "reject", n: 99 },
  { task: "human-review", bucket: "day", outcome: "bogus", n: 99 },
];
const progress = summarizeHumanAssist(rows, { humanReview: 3657, splitConfirm: 0 }, "2026-11-10T06:45:10.280Z");

describe("human assist progress (사람 확인 · AI 보조 처리 현황)", () => {
  it("sums each task's outcomes per window and counts only AI decisions that leave the human queue", () => {
    expect(progress.tasks["human-review"].day).toMatchObject({ approve: 42, reject: 46, held: 1442, refresh: 43, failed: 43 });
    expect(progress.tasks["human-review"].hour).toMatchObject({ approve: 4, reject: 3, held: 166, refresh: 0 });
    // 5분 창(2026-11-10 운영자 요청)은 1시간·24시간과 따로 센다
    expect(progress.tasks["human-review"].five).toMatchObject({ approve: 1, reject: 0, held: 12 });
    expect(progress.tasks["split-confirm"].five).toMatchObject({ reject: 0, held: 0 });
    expect(progress.tasks["human-review"].waiting).toBe(3657);
    expect(progress.tasks["split-confirm"].waiting).toBe(0);
    expect(progress.tasks["split-tiebreak"].waiting).toBeNull();
    // 위임 승인 42 + 반려 46 + 재확인 반려 7 + 보류 재심사 반려 13 + 2차로 넘김 6 — 판가름의 「재확인으로 넘김」은 아직 결정이 아니다
    expect(progress.decidedDay).toBe(114);
  });
  it("words each card's line by what the task actually decides and hides zero side buckets", () => {
    expect(humanAssistLine("human-review", progress.tasks["human-review"].day))
      .toBe("결정 88(공개로 42 · 반려 46) · 사람에게 남김 1,442 · 원본 다시 받기 43 · 실패 43");
    expect(humanAssistLine("human-review", progress.tasks["human-review"].hour)).toBe("결정 7(공개로 4 · 반려 3) · 사람에게 남김 166");
    expect(humanAssistLine("split-confirm", progress.tasks["split-confirm"].day)).toBe("반려 확정 7 · 사람에게 남김 5");
    expect(humanAssistLine("split-tiebreak", progress.tasks["split-tiebreak"].day)).toBe("재확인으로 넘김 8 · 사람에게 남김 0 · 대상 아님 1,200");
    expect(humanAssistLine("held-review-retry", progress.tasks["held-review-retry"].day)).toBe("반려 13 · 2차로 넘김 6 · 사람에게 남김 0");
  });
  it("renders all three windows of a card with a bar and numbers, and says so when the read failed", async () => {
    const html = renderToStaticMarkup(await HumanAssistTaskProgress({ read: Promise.resolve(progress), task: "human-review" }));
    expect(html.match(/data-window-block="(five|hour|day)"/g)).toEqual(['data-window-block="five"', 'data-window-block="hour"', 'data-window-block="day"']);
    expect(html).toContain('aria-label="최근 24시간 결정 88(공개로 42 · 반려 46) · 사람에게 남김 1,442 · 원본 다시 받기 43 · 실패 43"');
    expect(html).toContain('aria-label="최근 5분 결정 1(공개로 1 · 반려 0) · 사람에게 남김 12"');
    expect(html).toContain('<span data-kind="decided" style="width:5.6%"></span><span data-kind="held" style="width:91.7%"></span><span data-kind="failed" style="width:2.7%"></span>');
    const confirm = renderToStaticMarkup(await HumanAssistTaskProgress({ read: Promise.resolve(progress), task: "split-confirm" }));
    expect(confirm).toContain("재확인 대기 0건");
    const insight = renderToStaticMarkup(await HumanAssistInsight({ read: Promise.resolve(progress) }));
    expect(insight).toContain("최근 24시간 위임 검수가 본 1,573건 중 결정 88건(6%).");
    expect(insight).toContain("최근 5분 위임 검수가 본 13건 중 결정 1건(8%).");
    expect(renderToStaticMarkup(await HumanAssistTaskProgress({ read: Promise.resolve(null), task: "split-confirm" }))).toContain("처리 현황을 읽지 못했습니다");
    expect(renderToStaticMarkup(await HumanAssistDecided({ read: Promise.resolve(progress) }))).toBe("114건");
    expect(renderToStaticMarkup(await HumanAssistDecided({ read: Promise.resolve(null) }))).toBe("미확인");
  });
  it("links each human-share count to the review list filtered to that stage and places the progress slots", () => {
    const human: HumanQueueOverview = {
      held: 5726, ids: { ai: [], second: [], agreed: [], human: [] }, stages: { ai: 0, second: 93, agreed: 65, human: 5568 },
      agreed: { reject: 40, approve: 25 }, person: 5633, secondIds: {} as HumanQueueOverview["secondIds"], second: {} as HumanQueueOverview["second"],
      secondPublished: 0, wait: { oldestDays: 13, stalled: 0, in24h: 10 }, decided24h: { approve: 0, reject: 0 },
      aiDecisions: { counts: {} as HumanQueueOverview["aiDecisions"]["counts"], ids: new Map() },
    };
    const data = buildConveyor({ now: "2026-11-10T06:40:35.000Z", enabled: true, throughput: null, flow: null, hourly: null, human,
      progress: null, search: null, holds: null, rejected: null, classification: null, sources: [] });
    const html = renderToStaticMarkup(<PrototypeFlow data={data} desk={null} controls={{ jobs: {}, csrf: null }} editor={null}
      humanAssist={{ decided: <>114건</>, insight: <p>위임 요약</p> }} />);
    // 바로 확정 — 두 모델 같은 결론은 한 번에 확정하는 목록으로
    expect(html).toContain('class="flow-human-quick" aria-label="확정 필요 65건 목록 보기" href="/admin/review?tab=human&amp;stage=agreed"><b>65</b>');
    expect(html).toContain('href="/admin/review?tab=human&amp;stage=second"');
    // 묶음 상자 셋 — 먼저 볼 것 · 그 밖의 보류 · AI가 처리 중
    expect(html.match(/class="flow-human-group" data-tone="(first|other|waiting)"/g)).toEqual([
      'class="flow-human-group" data-tone="first"', 'class="flow-human-group" data-tone="other"', 'class="flow-human-group" data-tone="waiting"']);
    expect(html).toMatch(/24시간 결정 — AI (<!-- -->)?114건(<!-- -->)? · 사람 (<!-- -->)?0(<!-- -->)?건 · 최장 대기 (<!-- -->)?13일/);
    // 기간 단추 — 5분·1시간·24시간, 처음은 1시간
    expect(html).toContain('<section class="flow-human-assist" data-window="hour">');
    expect(html).toMatch(/aria-pressed="false"[^>]*>최근 5분<\/button><button[^>]*aria-pressed="true"[^>]*>최근 1시간<\/button><button[^>]*aria-pressed="false"[^>]*>최근 24시간</);
    expect(html).toContain("<p>위임 요약</p>");
  });
});
