import { afterEach, expect, it, vi } from "vitest";
import { githubRequest } from "@/lib/crawl/github";

const accounts = vi.hoisted(() => ({ tokens: vi.fn(), observe: vi.fn().mockResolvedValue(undefined) }));
const quota = vi.hoisted(() => ({ read: vi.fn().mockResolvedValue(null), record: vi.fn() }));
const auth = vi.hoisted(() => ({ read: vi.fn().mockResolvedValue(null), record: vi.fn() }));
vi.mock("@/lib/crawl/github-accounts", () => ({ collectorTokens: accounts.tokens, observeCollectorQuota: accounts.observe }));
vi.mock("@/lib/crawl/github-quota", async original => ({
  ...await original<typeof import("@/lib/crawl/github-quota")>(),
  readGitHubCooldown: quota.read,
  recordGitHubCooldown: async (_token: string, _resource: string, cooldown: { retryAt: Date }) => {
    quota.record(cooldown); return cooldown.retryAt;
  },
  readGitHubAuthCooldown: auth.read,
  recordGitHubAuthCooldown: async (token: string, retryAt: Date) => {
    auth.record(token, retryAt); return retryAt;
  },
}));

afterEach(() => { vi.unstubAllGlobals(); accounts.tokens.mockReset(); accounts.observe.mockClear(); quota.read.mockReset().mockResolvedValue(null); quota.record.mockClear(); auth.read.mockReset().mockResolvedValue(null); auth.record.mockClear(); });

it("retries a 401 twice, records the rejected credential, then uses the other account", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const fetcher = vi.fn().mockImplementation(async (_url, options) => options.headers.Authorization === "Bearer account-a"
    ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
    : new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  expect(await githubRequest("/repos/acme/app")).toMatchObject({ ok: true, status: 200, value: { id: 7 } });
  expect(fetcher.mock.calls.map(([, options]) => options.headers.Authorization)).toEqual([
    "Bearer account-a", "Bearer account-a", "Bearer account-a", "Bearer account-b",
  ]);
  expect(auth.record).toHaveBeenCalledWith("account-a", expect.any(Date));
});

it("moves to the other account when a 401 becomes an authentication-block 403", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Authentication failed" }), { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  expect(await githubRequest("/repos/acme/app")).toMatchObject({ ok: true, status: 200 });
  const used = fetcher.mock.calls.map(([, options]) => options.headers.Authorization);
  expect(used).toHaveLength(3);
  expect(used[0]).toBe(used[1]);
  expect(used[2]).not.toBe(used[0]);
  expect(auth.record).toHaveBeenCalledWith(used[0].slice(7), expect.any(Date));
});

it("rechecks the account pool soon when every credential is rejected", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ message: "This token has expired" }), { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  const started = Date.now();

  const result = await githubRequest("/repos/acme/app");

  expect(result).toMatchObject({ ok: false, error: { kind: "auth_unavailable", reason: "expired" } });
  if (result.ok || result.error.kind !== "auth_unavailable") return;
  expect(result.error.resetAt!.getTime()).toBeGreaterThanOrEqual(started + 60_000);
  expect(result.error.resetAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(auth.record).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain("This token has expired");
});

it("keeps using the same account when a 401 clears on a bounded retry", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  expect(await githubRequest("/search/repositories?q=app")).toMatchObject({ ok: true, status: 200 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(fetcher.mock.calls[1][1].headers.Authorization);
  expect(auth.record).not.toHaveBeenCalled();
});

it("skips a credential already in a shared auth cooldown", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  auth.read.mockImplementation(async token => token === "account-a" ? new Date(Date.now() + 15 * 60_000) : null);
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 7 }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  expect(await githubRequest("/search/code?q=app")).toMatchObject({ ok: true, status: 200 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer account-b");
});

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

it("keeps one timeout budget across account fallback", async () => {
  accounts.tokens.mockResolvedValue([{ token: "account-a", userId: 1, login: "a" }, { token: "account-b", userId: 2, login: "b" }]);
  const reset = Math.floor(Date.now() / 1000) + 120;
  const fetcher = vi.fn().mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 35));
    return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await githubRequest("/repos/acme/app", {}, { timeoutMs: 20 })).toEqual({ ok: false, error: { kind: "transport" } });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
