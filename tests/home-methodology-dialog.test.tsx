import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MethodologyDialog } from "@/components/home/MethodologyDialog";
import type { HomePulseView } from "@/components/home/types";

const state = vi.hoisted(() => ({ metric: "all" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams({ metric: state.metric }),
  useRouter: () => ({ replace: vi.fn() }),
}));
const pulse: HomePulseView = {
  asOf: "2026-10-04T15:00:00.000Z", asOfLabel: "10.05 00:00 KST 기준", timezone: "Asia/Seoul", methodVersion: "2.1",
  born: { current: 1013, previous: 539, change: 87.9 }, updates: { projects: 1, releases: 2 },
  active: [{ slug: "a-project", name: "Z Project", category: "Dev", releases: 2, stars: 10, ogImage: null }],
  categories: [{ key: "Dev", total: 2, born: 1 }, { key: "Other", total: 1, born: 0 }], tools: null, total: 3,
};
function render(metric: string) {
  state.metric = metric;
  return renderToStaticMarkup(<MethodologyDialog pulse={pulse} rankingFallback />).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

describe("숫자 설명과 실제 집계 기준", () => {
  it("gives the completed KST windows across a month boundary", () => {
    const text = render("born");
    expect(text).toContain("2026.09.28 00:00–2026.10.05 00:00 KST");
    expect(text).toContain("2026.09.21 00:00–2026.09.28 00:00 KST");
    expect(text).toContain("시작 포함, 끝 제외");
    expect(text).toContain("같은 저장소를 쓰는 프로젝트도 각각 셉니다");
    expect(text).toContain("기준 시각 전에 목록에 오른");
    expect(text).toContain("1013개");
    expect(text).toContain("539개");
    expect(text).toContain("87.9%");
  });
  it("describes the three-per-tier popular list and the current-star sort", () => {
    expect(render("popular")).toContain("홈에는 구간별 최대 3개");
    expect(render("popular")).not.toContain("최대 5개");
    expect(render("rising")).toContain("마지막 확인의 전체 스타 수가 많은 순");
  });
  it("includes Other and states the activity tie-break and both update sources", () => {
    const text = render("categories");
    expect(text).toContain("기타도 포함합니다");
    expect(text).toContain("기타 1개 0개");
    expect(render("active")).toContain("같으면 프로젝트 주소 순");
    expect(render("active")).toContain("GitHub 릴리스·제작자 업데이트");
    expect(render("updates")).toContain("공개 시각이 없으면 처음 확인한 시각");
  });
});
