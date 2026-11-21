import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { FlowBoard } from "@/app/(operator)/admin/flow/FlowBoard";
import { humanHoldRows } from "@/lib/crawl/human-batch-model";
import { buildConveyor, type ConveyorInputs } from "@/lib/operations/conveyor-model";
import { buildConsoleTasks } from "@/lib/operations/console-tasks";
import { reviewHoldCountsQuery } from "@/lib/operations/review-hold-counts";
import { consoleFixtureInputs } from "./fixtures/console-home";

vi.mock("@/lib/db", () => ({ db: {} }));

function conveyor(holds: NonNullable<ConveyorInputs["holds"]>) {
  return buildConveyor({ now: "2026-11-17T00:00:00Z", enabled: true, throughput: null, flow: null,
    hourly: null, human: null, progress: null, search: null, holds, rejected: 0, classification: null, sources: [] });
}
function alerts(holds: NonNullable<ConveyorInputs["holds"]>) {
  return buildConsoleTasks({ ...consoleFixtureInputs(), conveyor: conveyor(holds) }).groups
    .flatMap(group => group.tasks).filter(task => task.rule === "hold-surge");
}

describe("review hold alert counts", () => {
  it("uses the first completed hold rather than a candidate's mutable updated_at (DB cases in integration)", () => {
    const query = new PgDialect().sqlToQuery(reviewHoldCountsQuery()).sql;
    expect(query).not.toContain("updated_at");
    expect(query).toContain("min(a.completed_at)");
    expect(query).toContain("a.candidate_id = c.id");
    expect(query).toContain("c.judged_at");
    expect(query).toContain("interval '24 hours'");
  });

  it("does not alert for old holds rewritten by re-review when their first-hold 24-hour count is zero", () => {
    expect(alerts([{ reason: "ambiguous", count: 548, recent24h: 0 }])).toEqual([]);
    expect(alerts([{ reason: "ai_first_ambiguous", count: 546, recent24h: 0 }])).toEqual([]);
  });

  it("includes newly held candidates and distinguishes rule and AI first-judgement alerts and identities", () => {
    const tasks = alerts([{ reason: "ambiguous", count: 80, recent24h: 60 }, { reason: "ai_first_ambiguous", count: 100, recent24h: 70 }]);
    expect(tasks.map(task => [task.id, task.title, task.fact])).toEqual([
      ["odd:hold:ai_first_ambiguous", "AI 1차 판단 보류가 갑자기 늘었습니다", "AI 1차 판단 보류 · 24시간 +70건 · 누적 100건"],
      ["odd:hold:ambiguous", "규칙 심사 보류가 갑자기 늘었습니다", "규칙으로 못 가름 · 24시간 +60건 · 누적 80건"],
    ]);
    expect(new Set(tasks.map(task => task.id)).size).toBe(2);
  });

  it("places AI holds under AI 1차 and labels the 24-hour first-hold basis in the flow and batch screens", () => {
    const holds = [{ reason: "ambiguous", count: 2, recent24h: 0 }, { reason: "ai_first_ambiguous", count: 546, recent24h: 185 }];
    const data = conveyor(holds);
    expect(data.held).toBe(548);
    expect(data.stations.find(row => row.key === "judge")?.holds.map(row => row.reason)).toEqual(["ambiguous"]);
    expect(data.stations.find(row => row.key === "first")?.holds.map(row => row.reason)).toEqual(["ai_first_ambiguous"]);
    const html = renderToStaticMarkup(createElement(FlowBoard, { data }));
    expect(html).toContain("AI 1차 판단 보류");
    expect(html).toContain("규칙으로 못 가름");
    expect(html).toContain("최근 24시간에 처음 보류된 후보 수");
    const [ai] = humanHoldRows(holds, null);
    expect(ai.label).toBe("AI 1차 판단 보류");
    expect(ai.action).toMatchObject({ kind: "link", href: "/admin/review?tab=all&state=needs_review&reason=ambiguous&ai=needs_review#review-list" });
    // The old false +547/548 surge is gone when first-hold count is 185/546.
    expect(alerts(holds)).toEqual([]);
  });
});
