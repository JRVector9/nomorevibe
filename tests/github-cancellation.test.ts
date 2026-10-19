import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { githubRequest } from "@/lib/crawl/github";

const mocks = vi.hoisted(() => ({ tokens: vi.fn(), auth: vi.fn(), quota: vi.fn(), observe: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/crawl/github-accounts", () => ({ collectorTokens: mocks.tokens, observeCollectorQuota: mocks.observe }));
vi.mock("@/lib/crawl/github-quota", async original => ({
  ...await original<typeof import("@/lib/crawl/github-quota")>(),
  readGitHubAuthCooldown: mocks.auth, readGitHubCooldown: mocks.quota,
}));
beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.tokens.mockResolvedValue([{ token: "fixture", userId: null, login: "fixture" }]);
  mocks.auth.mockResolvedValue(null);
  mocks.quota.mockResolvedValue(null);
  mocks.observe.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["token", "auth", "quota"] as const)("starts no downstream work after abort during %s preparation", async phase => {
  const controller = new AbortController();
  const delayed = phase === "token" ? mocks.tokens : phase === "auth" ? mocks.auth : mocks.quota;
  delayed.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    return phase === "token" ? [{ token: "fixture", userId: null, login: "fixture" }] : null;
  });
  const pending = githubRequest("/repos/owner/repo", {}, { signal: controller.signal } as Parameters<typeof githubRequest>[2]);
  await vi.advanceTimersByTimeAsync(20);
  controller.abort();
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ ok: false, error: { kind: "transport" } });
  expect(mocks.fetch).not.toHaveBeenCalled();
  if (phase === "token") expect(mocks.auth).not.toHaveBeenCalled();
  if (phase !== "quota") expect(mocks.quota).not.toHaveBeenCalled();
});

it("starts no quota lookup after the shared deadline expires in auth lookup", async () => {
  mocks.auth.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 80)); return null; });
  const pending = githubRequest("/repos/owner/repo", {}, { deadlineAt: Date.now() + 20 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ ok: false, error: { kind: "transport" } });
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("forwards the caller signal to in-flight HTTP and prevents quota writes after abort", async () => {
  const controller = new AbortController();
  let actualSignal: AbortSignal | null | undefined;
  mocks.fetch.mockImplementation(async (_url, init: RequestInit) => {
    actualSignal = init.signal;
    controller.abort();
    return new Response("{}", { status: 200 });
  });
  expect(await githubRequest("/repos/owner/repo", {}, { signal: controller.signal } as Parameters<typeof githubRequest>[2]))
    .toMatchObject({ ok: false, error: { kind: "transport" } });
  expect(actualSignal?.aborted).toBe(true);
  expect(mocks.observe).not.toHaveBeenCalled();
});

it('bounds an unresolved token provider and fences late token settlement at the absolute deadline', async () => {
  let resolve!: (value: unknown) => void;
  mocks.tokens.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = githubRequest('/repos/owner/repo', {}, { deadlineAt: Date.now() + 20 });
  await vi.advanceTimersByTimeAsync(20);
  expect(await pending).toMatchObject({ ok: false, error: { kind: 'transport' } });
  resolve([{ token: 'late', userId: null, login: 'late' }]);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.auth).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
