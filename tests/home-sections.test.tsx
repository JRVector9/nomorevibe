import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveList } from "@/components/home/ActiveList";
import { IntroLine } from "@/components/home/IntroLine";
import { ToolsBoard } from "@/components/home/ToolsBoard";
import { emptyHomePulse } from "@/lib/domain/products/home-pulse";

const now = new Date("2026-10-02T03:00:00+09:00");

describe("홈 소개 줄", () => {
  it("타이틀 한 줄과 세 숫자를 낸다", () => {
    const pulse = { ...emptyHomePulse(now), total: 25183, born: { current: 157, previous: 100, change: 57 }, updates: { projects: 3483, releases: 17553 } };
    const html = renderToStaticMarkup(createElement(IntroLine, { pulse, state: { sort: "weekly" } }));
    expect(html).toContain("AI로 만든 것들이");
    expect(html).toContain("25,183");
    expect(html).toContain("157");
    expect(html).toContain("3,483");
    expect(html).toContain("10.02 00:00 KST");
  });
});

describe("무엇으로 만들었나", () => {
  it("알약은 신고값 대신 도구 흔적을 거르고 현재 분야를 유지하며 더 보기 수를 초기화한다", () => {
    const html = renderToStaticMarkup(createElement(ToolsBoard, {
      tools: { scanned: 12, withTool: 10, rows: [{ label: "Claude Code", count: 9 }, { label: "Codex", count: 1 }] },
      state: { sort: "recent", category: "Dev", observedTool: "Codex", shown: 18 },
    }));
    expect(html).toContain('href="/?sort=recent&amp;category=Dev&amp;observedTool=Claude+Code"');
    expect(html).toContain('class="chip chip-dark" aria-current="true" href="/?sort=recent&amp;category=Dev&amp;observedTool=Codex"');
    expect(html).not.toContain("metric=tools");
    expect(html).not.toContain("builder=");
    expect(html).not.toContain("shown=");
  });
  it("도구 집계가 없으면 구획을 내지 않는다", () => {
    expect(renderToStaticMarkup(createElement(ToolsBoard, { tools: null, state: { sort: "weekly" } }))).toBe("");
  });
  it("도구 알약과 조사 범위를 낸다", () => {
    const html = renderToStaticMarkup(createElement(ToolsBoard, {
      tools: { scanned: 20864, withTool: 16650, rows: [{ label: "Claude Code", count: 11798 }, { label: "Codex", count: 788 }] }, state: { sort: "weekly" },
    }));
    expect(html).toContain("Claude Code");
    expect(html).toContain("11,798");
    expect(html).toContain("20,864개 중 16,650개");
  });
});

describe("이번 주 가장 활발한", () => {
  it("다섯 줄까지만, 새 버전 수와 함께", () => {
    const active = Array.from({ length: 7 }, (_, index) => ({ slug: `p${index}`, name: `P${index}`, category: "Dev" as const, releases: 70 - index, stars: null, ogImage: null }));
    const html = renderToStaticMarkup(createElement(ActiveList, { active, projects: 3483 }));
    expect(html).toContain("70건");
    expect(html).toContain("P4");
    expect(html).not.toContain("P5");
    expect(html).toContain("3,483개 중 상위 5");
  });
});
