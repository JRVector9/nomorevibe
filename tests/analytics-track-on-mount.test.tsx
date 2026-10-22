import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * 그려지면 한 번 보내는 표시(TrackOnMount) — 검색 결과·404·오류 경계(2026-10-22).
 * 서버 렌더는 효과를 돌리지 않으므로 이 파일에서만 useEffect 를 바로 돌게 바꾼다.
 */
const sent = vi.hoisted(() => [] as Array<[string, unknown]>);
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void) => { effect(); } };
});
vi.mock("@/lib/analytics/client", () => ({ track: (name: string, params: unknown) => { sent.push([name, params]); } }));
vi.mock("next/navigation", () => ({ usePathname: () => "/p/x", useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const { TrackOnMount } = await import("@/components/analytics/TrackOnMount");
const { default: RouteError } = await import("@/app/(public)/[locale]/(content)/error");

describe("TrackOnMount", () => {
  it("아무것도 그리지 않고 이벤트 하나를 보낸다", () => {
    sent.length = 0;
    expect(renderToStaticMarkup(<TrackOnMount name="search" params={{ search_term: "PDF", result_count: 3, surface: "search" }} />)).toBe("");
    expect(sent).toEqual([["search", { search_term: "PDF", result_count: 3, surface: "search" }]]);
  });

  it("오류 경계는 코드만 — 메시지·digest 는 보내지 않는다", () => {
    sent.length = 0;
    renderToStaticMarkup(<RouteError error={Object.assign(new Error("secret token=abc"), { digest: "123456" })} retry={() => {}} />);
    renderToStaticMarkup(<RouteError error={new Error("boom")} retry={() => {}} />);
    expect(sent).toEqual([
      ["app_error", { error_code: "server_render", page_type: "other" }],
      ["app_error", { error_code: "client_render", page_type: "other" }],
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/secret|123456|boom/);
  });
});
