import { afterEach, expect, it, vi } from "vitest";
import { githubRequest } from "@/lib/crawl/github";
const quota = vi.hoisted(() => ({ read: vi.fn().mockResolvedValue(null), record: vi.fn() }));
vi.mock("@/lib/crawl/github-quota", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/github-quota")>(),
  readGitHubCooldown: quota.read,
  recordGitHubCooldown: async (token: string, resource: string, cooldown: { retryAt: Date }) => {
    quota.record(token, resource, cooldown); return cooldown.retryAt;
  },
}));

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

it("does not follow redirects while carrying an authorization header", async () => {
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", {status: 200}));
  vi.stubGlobal("fetch", fetcher);
  await githubRequest("/repos/acme/app");
  expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/acme/app", expect.objectContaining({redirect: "error"}));
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
