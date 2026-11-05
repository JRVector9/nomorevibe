import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/crawl/published-review-page", () => ({ readPublishedReviewPage: mocks.page }));
import { GET } from "@/app/(operator)/admin/review/published-scroll/route";
import { encodePublishedReviewCursor } from "@/lib/crawl/published-review-cursor";
const cursor = encodePublishedReviewCursor({ priority: 0, at: "2026-11-05 00:00:00.123456", id: 100 })!;
beforeEach(() => { vi.clearAllMocks(); mocks.admin.mockResolvedValue({ login: "operator" }); mocks.page.mockResolvedValue({ rows: [], total: 400, nextCursor: null }); });
describe("published review scroll read authorization", () => {
  it("checks auth before parsing or reading and returns private no-store", async () => {
    mocks.admin.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost/admin/review/published-scroll?cursor=invalid"));
    expect(response.status).toBe(403); expect(mocks.page).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects invalid, repeated and foreign query parameters without reading rows", async () => {
    for (const query of ["", "cursor=bad", `cursor=${cursor}&cursor=${cursor}`, `cursor=${cursor}&limit=1000`, `cursor=${cursor}&q=changed`])
      expect((await GET(new Request(`http://localhost/admin/review/published-scroll?${query}`))).status).toBe(400);
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("returns just bounded page DTO and cursor, and keeps database failures private", async () => {
    const response = await GET(new Request(`http://localhost/admin/review/published-scroll?cursor=${cursor}`));
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ rows: [], nextCursor: null });
    expect(mocks.page).toHaveBeenCalledWith({ priority: 0, at: "2026-11-05 00:00:00.123456", id: 100 }, "");
    mocks.page.mockRejectedValue(new Error("private database detail"));
    const failed = await GET(new Request(`http://localhost/admin/review/published-scroll?cursor=${cursor}`));
    expect(failed.status).toBe(503);expect(await failed.text()).not.toContain("private database detail");
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
  });
});
