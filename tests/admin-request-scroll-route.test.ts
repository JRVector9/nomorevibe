import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ admin: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: fake.admin }));
vi.mock("@/lib/operations/admin-request-workspace-feed", () => ({ readRequestWorkspaceFeed: fake.read }));
const { GET } = await import("@/app/(operator)/admin/requests/scroll/route");
beforeEach(() => { vi.clearAllMocks(); fake.admin.mockResolvedValue({ login: "admin" }); fake.read.mockResolvedValue({ items: [], nextCursor: null, failed: [], count: 0, takedown: null }); });
it("requires current admin and keeps every response private/no-store", async () => {
  fake.admin.mockResolvedValue(null); const result = await GET(new Request("https://admin.test/admin/requests/scroll"));
  expect(result.status).toBe(401); expect(fake.read).not.toHaveBeenCalled(); expect(result.headers.get("cache-control")).toBe("private, no-store");
});
it("rejects invalid cursors and partial source failures without exposing raw errors", async () => {
  fake.read.mockRejectedValueOnce(new Error("request_feed_cursor_invalid")); const invalid = await GET(new Request("https://admin.test/admin/requests/scroll?cursor=bad"));
  expect(invalid.status).toBe(400); expect(await invalid.json()).toEqual({ error: "invalid_cursor" });
  fake.read.mockResolvedValueOnce({ items: [], failed: ["contact"] }); const failed = await GET(new Request("https://admin.test/admin/requests/scroll"));
  expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: "request_feed_unavailable" });
});
