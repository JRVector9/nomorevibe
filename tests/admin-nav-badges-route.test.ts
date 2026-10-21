import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentAdmin: vi.fn(), navBadges: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.currentAdmin }));
vi.mock("@/app/(operator)/admin/badges", () => ({ navBadges: mocks.navBadges }));

const { GET } = await import("@/app/(operator)/admin/nav-badges/route");
const request = () => new Request("http://localhost/admin/nav-badges");
const context = { params: Promise.resolve({}) };

describe("GET /admin/nav-badges — 화면을 옮긴 뒤 메뉴 배지", () => {
  beforeEach(() => vi.clearAllMocks());

  it("관리자가 아니면 403 이고 배지를 세지 않는다", async () => {
    mocks.currentAdmin.mockResolvedValue(null);
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.navBadges).not.toHaveBeenCalled();
  });

  it("레이아웃과 같은 배지와 센 서버 시각을 저장하지 않게 준다", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "jr" });
    mocks.navBadges.mockResolvedValue({ "/admin/status": { label: "2", tone: "critical", title: "긴급 2건" } });
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { badges: unknown; at: string };
    expect(body.badges).toEqual({ "/admin/status": { label: "2", tone: "critical", title: "긴급 2건" } });
    expect(Number.isFinite(Date.parse(body.at))).toBe(true);
  });
});
