import { beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ queue: vi.fn() }));
vi.mock("@/lib/operations/admin-request-workspace", () => ({ readRequestWorkspaceQueues: fake.queue, readRequestSection: vi.fn() }));
vi.mock("@/lib/domain/products/takedown", () => ({ takedownSummary: vi.fn() }));
const { readSelectedWorkspaceRequest } = await import("@/lib/operations/admin-request-workspace-feed");
const { requestFeedFilter } = await import("@/lib/operations/admin-request-workspace-feed-model");
const id = "56aa5d32-6ae5-4524-bbea-f9a0928346fd", key = `contact:${id}`, filter = requestFeedFilter({ tab: "contact", state: "waiting" });
beforeEach(() => { vi.clearAllMocks(); fake.queue.mockResolvedValue({ items: [{ key }], failed: [] }); });
it("loads an explicit older record from one source by key without depending on the first30 feed", async () => {
  expect(await readSelectedWorkspaceRequest(key, filter)).toEqual({ key });
  expect(fake.queue).toHaveBeenCalledWith(["contact"], "waiting", 0, undefined, key);
});
it("does not read another kind or invalid source identifiers through a selected link", async () => {
  expect(await readSelectedWorkspaceRequest(`feedback:${id}`, filter)).toBeNull();
  expect(await readSelectedWorkspaceRequest("contact:not-an-id", filter)).toBeNull();
  expect(fake.queue).not.toHaveBeenCalled();
});
it("distinguishes a failed detail read from an absent request", async () => {
  fake.queue.mockResolvedValue({ items: [], failed: ["contact"] });
  await expect(readSelectedWorkspaceRequest(key, filter)).rejects.toThrow("request_detail_unavailable");
  fake.queue.mockResolvedValue({ items: [], failed: [] });
  expect(await readSelectedWorkspaceRequest(key, filter)).toBeNull();
});
