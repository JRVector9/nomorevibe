import { afterEach, expect, it, vi } from "vitest";
import { githubRequest } from "@/lib/crawl/github";

const accounts = vi.hoisted(() => ({ tokens: vi.fn(), observe: vi.fn().mockResolvedValue(undefined) }));
const quota = vi.hoisted(() => ({ read: vi.fn().mockResolvedValue(null), record: vi.fn() }));
vi.mock("@/lib/crawl/github-accounts", () => ({ collectorTokens: accounts.tokens, observeCollectorQuota: accounts.observe }));
vi.mock("@/lib/crawl/github-quota", async original => ({
  ...await original<typeof import("@/lib/crawl/github-quota")>(),
  readGitHubCooldown: quota.read,
  recordGitHubCooldown: async (_token: string, _resource: string, cooldown: { retryAt: Date }) => {
    quota.record(cooldown); return cooldown.retryAt;
  },
}));

afterEach(() => { vi.unstubAllGlobals(); accounts.tokens.mockReset(); accounts.observe.mockClear(); quota.read.mockReset().mockResolvedValue(null); quota.record.mockClear(); });

it("tries another registered account when one primary core quota is exhausted", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const reset = Math.floor(Date.now() / 1000) + 120;
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 403, headers: {
    "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000", "x-ratelimit-used": "5000",
    "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset),
  } })).mockResolvedValueOnce(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await githubRequest("/repos/acme/app")).toMatchObject({ ok: true, status: 200, value: { id: 7 } });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1].headers.Authorization).not.toBe(fetcher.mock.calls[1][1].headers.Authorization);
});

it("does not rotate credentials on an ordinary 403", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await githubRequest("/repos/acme/app")).toEqual({ ok: false, error: { kind: "http", status: 403 } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("stops the pool on a secondary limit", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "60" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await githubRequest("/repos/acme/app")).toMatchObject({ ok: false, error: { kind: "rate_limited" } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses the next account when the first has an existing primary cooldown", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  quota.read.mockResolvedValueOnce(new Date(Date.now() + 90_000)).mockResolvedValueOnce(null);
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await githubRequest("/repos/acme/app")).toMatchObject({ ok: true, status: 200 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
