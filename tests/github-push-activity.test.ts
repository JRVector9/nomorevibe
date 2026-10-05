import { describe, expect, it, vi } from "vitest";
import type { GitHubHttpResult } from "@/lib/crawl/github";
import { fetchPushActivity } from "@/lib/domain/evidence/providers/github-activity";

const now = new Date("2026-10-05T00:00:00Z");
const ok = (value: unknown, link: string | null = null): GitHubHttpResult<unknown> => ({
  ok: true, status: 200, value, link, etag: null, lastModified: null,
});
const event = (id: number, activity_type = "push", timestamp = "2026-10-04T00:00:00Z") => ({ id, activity_type, timestamp });

describe("weekly repository pushes", () => {
  it("follows GitHub numeric-ID cursors only for the repository confirmed by its metadata", async () => {
    const link = '<https://api.github.com/repositories/123/activity?after=cursor>; rel="next"';
    const request = vi.fn().mockResolvedValueOnce(ok([event(1)], link)).mockResolvedValueOnce(ok([event(2)]));
    await expect(fetchPushActivity(request, "maker/product", now, () => true, 123)).resolves.toMatchObject({ count: 2 });
    expect(request.mock.calls[1][0]).toBe("/repositories/123/activity?after=cursor");
    await expect(fetchPushActivity(async () => ok([event(1)], link), "maker/product", now, () => true, 456)).resolves.toBeNull();
    await expect(fetchPushActivity(async () => ok([event(1)], link), "maker/product", now, () => true)).resolves.toBeNull();
  });

  it("counts pushes and force pushes across cursor pages once, excluding other activities and outside-window events", async () => {
    const request = vi.fn().mockResolvedValueOnce(ok([
      event(1), event(2, "force_push"), event(3, "pr_merge"), event(4, "push", "2026-09-27T00:00:00Z"),
    ], '<https://api.github.com/repos/maker/product/activity?time_period=week&per_page=100&after=cursor>; rel="next"'))
      .mockResolvedValueOnce(ok([event(2, "force_push"), event(5), event(6, "push", "2026-10-06T00:00:00Z")]));
    await expect(fetchPushActivity(request, "maker/product", now, () => true)).resolves.toEqual({
      count: 3, since: "2026-09-28T00:00:00.000Z", observedAt: now.toISOString(),
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/repos/maker/product/activity?time_period=week&per_page=100&direction=desc",
      "/repos/maker/product/activity?time_period=week&per_page=100&after=cursor",
    ]);
  });

  it("preserves an observed empty week as zero", async () => {
    await expect(fetchPushActivity(async () => ok([]), "maker/product", now, () => true)).resolves.toEqual({
      count: 0, since: "2026-09-28T00:00:00.000Z", observedAt: now.toISOString(),
    });
  });

  it("never publishes a partial count when the budget ends or a later page fails", async () => {
    const next = '<https://api.github.com/repos/maker/product/activity?after=cursor>; rel="next"';
    const request = vi.fn().mockResolvedValueOnce(ok([event(1)], next)).mockResolvedValueOnce({ ok: false, error: { kind: "transport" } });
    await expect(fetchPushActivity(request, "maker/product", now, () => true)).resolves.toBeNull();
    const budget = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(fetchPushActivity(async () => ok([event(1)], next), "maker/product", now, budget)).resolves.toBeNull();
  });

  it.each([
    { value: { message: "unexpected" }, link: null },
    { value: [{ id: 1, activity_type: "push", timestamp: "invalid" }], link: null },
    { value: [{ id: 1, activity_type: "push", timestamp: "1" }], link: null },
    { value: [event(1)], link: '<https://tracker.example/activity?after=x>; rel="next"' },
    { value: [event(1)], link: '<https://api.github.com/repos/another/repo/activity?after=x>; rel="next"' },
  ])("rejects invalid data or a cursor for an unrelated resource", async ({ value, link }) => {
    await expect(fetchPushActivity(async () => ok(value, link), "maker/product", now, () => true)).resolves.toBeNull();
  });

  it("stops repeated cursors and bounded pages instead of claiming a complete count", async () => {
    let page = 0;
    const request = vi.fn(async () => ok([event(++page)], `<https://api.github.com/repos/maker/product/activity?after=${page}>; rel="next"`));
    await expect(fetchPushActivity(request, "maker/product", now, () => true)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(10);
    const repeated = '<https://api.github.com/repos/maker/product/activity?after=same>; rel="next"';
    const loop = vi.fn(async () => ok([event(1)], repeated));
    await expect(fetchPushActivity(loop, "maker/product", now, () => true)).resolves.toBeNull();
    expect(loop).toHaveBeenCalledTimes(2);
  });
});
