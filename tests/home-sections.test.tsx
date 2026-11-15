import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BrowseCountsResponse } from "@/app/api/browse-counts/route";
import type { ActiveFill } from "@/components/home/ActiveRows";
import { emptyHomePulse } from "@/lib/domain/products/home-pulse";

/**
 * 공개 수와 활발한 목록의 아이콘·분야·스타·새 버전 수는 서버 HTML 에 싣지 않고 화면 JS 가 API 로 받는다(2026-11-15 공개 HTML 이름·요약만).
 * 받은 값(/api/browse-counts·/api/product-cards?list=active)을 바꿔 끼워 받기 전·받은 뒤 모양을 본다.
 */
const fills = vi.hoisted(() => ({
  counts: undefined as BrowseCountsResponse | null | undefined,
  countQueries: [] as (string | null)[],
  active: undefined as ActiveFill[] | null | undefined,
  lists: [] as (string | null)[],
}));
vi.mock("@/components/home/browse-counts", async (original) => ({
  ...await original<typeof import("@/components/home/browse-counts")>(),
  useBrowseCounts: (query: string | null) => { fills.countQueries.push(query); return fills.counts; },
}));
vi.mock("@/components/cards/CardEnrich", async (original) => ({
  ...await original<typeof import("@/components/cards/CardEnrich")>(),
  useCardList: (source: string | null) => { fills.lists.push(source); return fills.active; },
}));
const { ActiveList } = await import("@/components/home/ActiveList");
const { IntroLine } = await import("@/components/home/IntroLine");
const { ToolsBoard } = await import("@/components/home/ToolsBoard");

const now = new Date("2026-10-02T03:00:00+09:00");

describe("홈 소개 줄", () => {
  it("타이틀 한 줄과 세 숫자를 낸다 — 공개 수는 목록과 같은 지금 값, 이번 주 기준은 말로", () => {
    const pulse = { ...emptyHomePulse(now), total: 25183, born: { current: 157, previous: 100, change: 57 }, updates: { projects: 3483, releases: 17553 } };
    // 받기 전에는 공개 수 자리만(글자 없음) — 서버 HTML 에 수가 없다
    fills.counts = undefined;
    fills.countQueries.length = 0;
    const pending = renderToStaticMarkup(createElement(IntroLine, { pulse, state: { sort: "ai", category: "Dev" } }));
    expect(pending).toMatch(/공개 <b><span class="fill-line" aria-hidden="true"[^>]*><\/span><\/b>/);
    expect(pending).not.toContain("25,402");
    expect(fills.countQueries).toEqual(["category=Dev"]);
    fills.counts = { total: 25_402, counts: {}, resultCount: 0 };
    const html = renderToStaticMarkup(createElement(IntroLine, { pulse, state: { sort: "ai" } }));
    expect(html).toContain("AI로 만든 것들이");
    // 같은 화면의 '공개' 수는 하나 — 자정 집계(pulse.total)가 아니라 목록이 세는 값(UX-27), 거르기 줄과 같은 API 값
    expect(html).toContain("공개 <b>25,402</b>");
    expect(html).not.toContain("25,183");
    expect(html).toContain("이번 주 새로 생긴 <b>157</b>");
    expect(html).toContain("3,483");
    expect(html).toContain("이번 주 = 어제 자정까지 7일");
    expect(html).not.toContain("KST");
  });
});

describe("무엇으로 만들었나", () => {
  it("알약은 신고값 대신 도구 흔적을 거르고 현재 분야를 유지하며 더 보기 수를 초기화한다", () => {
    const html = renderToStaticMarkup(createElement(ToolsBoard, {
      tools: { scanned: 12, withTool: 10, rows: [{ label: "Claude Code", count: 9 }, { label: "Codex", count: 1 }] },
      state: { sort: "recent", category: "Dev", observedTool: "Codex", shown: 18 },
    }));
    expect(html).toContain('href="/c/dev?sort=recent&amp;observedTool=Claude+Code"');
    expect(html).toContain('class="chip chip-dark" aria-current="true" href="/c/dev?sort=recent&amp;observedTool=Codex"');
    expect(html).not.toContain("metric=tools");
    expect(html).not.toContain("builder=");
    expect(html).not.toContain("shown=");
  });
  it("도구 집계가 없으면 구획을 내지 않는다", () => {
    expect(renderToStaticMarkup(createElement(ToolsBoard, { tools: null, state: { sort: "ai" } }))).toBe("");
  });
  it("도구 알약과 조사 범위를 낸다", () => {
    const html = renderToStaticMarkup(createElement(ToolsBoard, {
      tools: { scanned: 20864, withTool: 16650, rows: [{ label: "Claude Code", count: 11798 }, { label: "Codex", count: 788 }] }, state: { sort: "ai" },
    }));
    expect(html).toContain("Claude Code");
    expect(html).toContain("11,798");
    expect(html).toContain("20,864개 중 16,650개");
  });
});

describe("이번 주 가장 활발한", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ slug: `p${index}`, name: `P${index}` }));

  it("다섯 줄까지만, 새 버전 수와 함께", () => {
    fills.active = rows.map((row, index) => ({ slug: row.slug, category: "Dev", releases: 70 - index, stars: index === 0 ? 1_234 : null, ogImage: null }));
    fills.lists.length = 0;
    const html = renderToStaticMarkup(createElement(ActiveList, { rows, projects: 3483 }));
    expect(fills.lists).toEqual(["list=active"]);
    expect(html).toContain("70건");
    expect(html).toContain("★ 1,234");
    expect(html).toContain("P4");
    expect(html).not.toContain("P5");
    expect(html).toContain("3,483개 중 상위 5");
  });

  it("서버 HTML 에는 차례·이름·링크만 — 받는 동안은 빈 자리, 못 받으면 빈 자리를 거둔다", () => {
    fills.active = undefined;
    const pending = renderToStaticMarkup(createElement(ActiveList, { rows, projects: 3483 }));
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain('href="/p/p0"');
    expect(pending).toContain("P0");
    expect(pending).not.toContain("건");
    expect(pending).not.toContain("★");
    expect(pending.match(/class="fill-line"/g)).toHaveLength(10);
    fills.active = null;
    const failed = renderToStaticMarkup(createElement(ActiveList, { rows, projects: 3483 }));
    expect(failed).toContain("P4");
    expect(failed).not.toContain("fill-line");
    expect(failed).not.toContain("aria-busy");
  });

  it("목록이 비면 빈 문구", () => {
    expect(renderToStaticMarkup(createElement(ActiveList, { rows: [], projects: 0 }))).not.toContain("rank-list");
  });
});
