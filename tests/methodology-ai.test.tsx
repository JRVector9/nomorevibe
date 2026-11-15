import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HomePulseView } from "@/components/home/types";

/** '데이터와 집계 기준'(푸터 → /?metric=all) 창의 '만든 방식' 칸 — 근거 이름·한계·근거별 수. 단계 번호는 보이지 않는다(2026-10-11) */

const navigation = vi.hoisted(() => ({ metric: "ai" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(`metric=${navigation.metric}`),
}));
/** 단계별 수는 서버 HTML 에 싣지 않고 창이 열릴 때 /api/browse-counts?part=method 로 받는다(2026-11-15) — 받은 값을 바꿔 끼운다 */
const counts = vi.hoisted(() => ({ method: undefined as { aiLevels: Record<1 | 2 | 3, number> | null; categories: [] } | null | undefined, enabled: [] as boolean[] }));
vi.mock("@/components/home/browse-counts", () => ({
  useMethodCounts: (enabled: boolean) => { counts.enabled.push(enabled); return enabled ? counts.method : undefined; },
}));
const { MethodologyDialog } = await import("@/components/home/MethodologyDialog");

const pulse: HomePulseView = {
  asOf: "2026-10-10T00:00:00Z", asOfLabel: "10월 10일", methodVersion: "1",
  born: { current: 1, previous: 1, change: null }, updates: { projects: 0, releases: 0 }, activeCount: 0, tools: null,
};
const render = (aiLevels: Record<1 | 2 | 3, number> | null) => {
  counts.method = { aiLevels, categories: [] };
  return renderToStaticMarkup(createElement(MethodologyDialog, { pulse }));
};

describe("만든 방식 기준", () => {
  it("세 근거의 이름과 수, ''AI' 표시가 없다고 AI 없이 만든 것은 아니다'를 보이고 단계 번호는 없다", () => {
    navigation.metric = "ai";
    const html = render({ 1: 310, 2: 27_300, 3: 1_150 });
    expect(html).toContain("만든 방식 — 저장소에 남은 AI 제작 근거로 봅니다.");
    expect(html).toContain("<tr><td>AI 에이전트가 연 PR 병합</td><td>310개</td></tr>");
    expect(html).toContain("<tr><td>AI 도구 서명이 있는 개발 커밋</td><td>27,300개</td></tr>");
    expect(html).toContain("<tr><td>AI 도구 전용 설정 파일</td><td>1,150개</td></tr>");
    expect(html).toContain("표시가 없다고 AI 없이 만든 것은 아닙니다");
    expect(html).not.toMatch(/[123]단계/);
  });

  it("수를 못 읽었으면 기준만, 전체 보기(푸터 링크)에도 들어 있다", () => {
    navigation.metric = "ai";
    expect(render(null)).not.toContain("<th>프로젝트 수</th>");
    // 받는 중(undefined)·실패(null)도 수 없이 기준만
    counts.method = undefined;
    const loading = renderToStaticMarkup(createElement(MethodologyDialog, { pulse }));
    expect(loading).toContain("만든 방식 — 저장소에 남은 AI 제작 근거로 봅니다.");
    expect(loading).not.toContain("<th>프로젝트 수</th>");
    navigation.metric = "all";
    const all = render({ 1: 1, 2: 2, 3: 3 });
    expect(all).toContain("만든 방식 — 저장소에 남은 AI 제작 근거로 봅니다.");
    expect(all).toContain(">만든 방식</button>");
  });

  it("창이 닫혀 있으면 수를 받지 않는다", () => {
    navigation.metric = "";
    counts.enabled.length = 0;
    renderToStaticMarkup(createElement(MethodologyDialog, { pulse }));
    expect(counts.enabled).toEqual([false]);
  });
});
