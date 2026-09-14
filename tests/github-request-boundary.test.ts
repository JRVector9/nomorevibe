import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { githubRequest } from "@/lib/crawl/github";
const quota = vi.hoisted(() => ({ read: vi.fn().mockResolvedValue(null), record: vi.fn() }));
vi.mock("@/lib/crawl/github-quota", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/github-quota")>(),
  readGitHubCooldown: quota.read,
  recordGitHubCooldown: async (token: string, resource: string, cooldown: { retryAt: Date }) => {
    quota.record(token, resource, cooldown); return cooldown.retryAt;
  },
}));

beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "test-token"));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); quota.read.mockReset().mockResolvedValue(null); quota.record.mockClear(); });

it("rejects path tricks before attaching the GitHub token", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}", {status: 200})));
  vi.stubGlobal("fetch", fetcher);
  for (const path of ["//other.example/repos", "/repos/a/b/../secrets", "/repos/a/b#fragment"]) {
    expect(await githubRequest(path)).toMatchObject({ ok: false });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("returns the shared cooldown without making another API request", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const waiting = new Date(Date.now() + 120_000);
  quota.read.mockResolvedValue(waiting);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(githubRequest("/repos/acme/app")).resolves.toEqual({ ok:false,error:{kind:"rate_limited",resetAt:waiting} });
  expect(fetcher).not.toHaveBeenCalled();
});

it("uses manual redirects so every destination is checked before authorization", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", {status: 200}));
  vi.stubGlobal("fetch", fetcher);
  await githubRequest("/repos/acme/app");
  expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/acme/app", expect.objectContaining({redirect: "manual"}));
});

it("honors the later Retry-After date instead of an earlier primary reset", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const later = new Date(Math.ceil(Date.now() / 1000) * 1000 + 120_000);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
    status: 429,
    headers: {
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30),
      "retry-after": later.toUTCString(),
    },
  })));
  await expect(githubRequest("/repos/acme/app")).resolves.toEqual({
    ok: false, error: { kind: "rate_limited", resetAt: later },
  });
});

it('follows repository moves only inside the GitHub API origin', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, {status: 301, headers: {location: 'https://api.github.com/repositories/42'}}))
    .mockResolvedValueOnce(new Response(JSON.stringify({id: 42, full_name: 'new/app'}), {status: 200}));
  vi.stubGlobal('fetch', fetcher);
  expect(await githubRequest('/repos/old/app')).toMatchObject({ok: true, status: 200, value: {id: 42}});
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['https://api.github.com/repos/old/app','https://api.github.com/repositories/42']);
  expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer test-token');
  expect(fetcher.mock.calls[0][1].signal).toBe(fetcher.mock.calls[1][1].signal);
});
it.each(['https://evil.example/api','http://api.github.com/repositories/42','https://user:pass@api.github.com/repositories/42'])('never forwards credentials to unsafe redirect %s', async location => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, {status: 301, headers: {location}}));vi.stubGlobal('fetch', fetcher);
  expect(await githubRequest('/repos/old/app')).toMatchObject({ok: false, error: {kind: 'invalid_response'}});
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('bounds redirect loops and rejects missing locations', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, {status: 301, headers: {location: '/repos/old/app'}}));vi.stubGlobal('fetch', fetcher);
  expect(await githubRequest('/repos/old/app')).toMatchObject({ok: false, error: {kind: 'invalid_response'}});
  expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  fetcher.mockReset().mockResolvedValue(new Response(null, {status: 301}));
  expect(await githubRequest('/repos/old/app')).toMatchObject({ok: false, error: {kind: 'invalid_response'}});
});

it('stops after three same-origin redirects', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(null, {status: 302, headers: {location: '/repositories/'+(fetcher.mock.calls.length+1)}}));vi.stubGlobal('fetch', fetcher);
  expect(await githubRequest('/repos/old/app')).toMatchObject({ok: false, error: {kind: 'invalid_response'}});
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it('honors quota exhaustion on the redirect before making another request', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, {status: 301, headers: {location: '/repositories/42',
    'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now()/1000)+60)}}));vi.stubGlobal('fetch', fetcher);
  expect(await githubRequest('/repos/old/app')).toMatchObject({ok: false, error: {kind: 'rate_limited'}});
  expect(fetcher).toHaveBeenCalledTimes(1);expect(quota.record).toHaveBeenCalledOnce();
});
