import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ currentAdmin: vi.fn(), navBadges: vi.fn(), admission: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.currentAdmin }));
vi.mock("@/app/(operator)/admin/badges", () => ({ navBadges: mocks.navBadges }));
vi.mock("@/lib/operations/admission-status", () => ({ readAdmissionStatus: mocks.admission }));

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
    mocks.navBadges.mockResolvedValue({ badges: { "/admin/status": { label: "2", tone: "critical", title: "긴급 2건" } }, unknown: ["/admin/review"] });
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { badges: unknown; unknown: string[]; at: string };
    expect(body.badges).toEqual({ "/admin/status": { label: "2", tone: "critical", title: "긴급 2건" } });
    // 셀 수 없었던 칸 — 화면은 전에 보이던 배지를 둔다
    expect(body.unknown).toEqual(["/admin/review"]);
    expect(Number.isFinite(Date.parse(body.at))).toBe(true);
  });

  it("머리줄의 접수 표시를 서버에서 글자로 만들어 함께 준다 — 못 읽으면 「셀 수 없음」", async () => {
    mocks.currentAdmin.mockResolvedValue({ login: "jr" });
    mocks.navBadges.mockResolvedValue({ badges: {}, unknown: [] });
    mocks.admission.mockResolvedValue({ mode: "draining", since: new Date(Date.now() - 18 * 60_000).toISOString(), actor: "JR" });
    const body = await (await GET(request(), context)).json() as { admission: { mode: string; tone: string; label: string; detail: string } };
    expect(body.admission).toMatchObject({ mode: "draining", tone: "warn", label: "접수 중단" });
    expect(body.admission.detail).toMatch(/^\d\d:\d\d부터 · JR · 18분$/);
    mocks.admission.mockRejectedValue(new Error("down"));
    const failed = await (await GET(request(), context)).json() as { admission: { mode: null; label: string }; badges: unknown };
    expect(failed.admission).toMatchObject({ mode: null, label: "접수 셀 수 없음" });
    expect(failed.badges).toEqual({});
  });
});
