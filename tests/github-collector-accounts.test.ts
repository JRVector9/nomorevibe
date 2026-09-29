import { afterEach, expect, it, vi } from "vitest";
import { inspectGitHubCollectorToken, collectorSecret, encryptCollectorToken, decryptCollectorToken, parseCoreQuota, saveGitHubCollectorAccount } from "@/lib/crawl/github-accounts";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("checks identity and quota without returning the PAT", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "OtherOwner" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 12, remaining: 4988, reset: 1800000000 } } }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const result = await inspectGitHubCollectorToken("github_pat_12345678901234567890");
  expect(result).toEqual({ userId: 42, login: "OtherOwner", core: { limit: 5000, used: 12, remaining: 4988, reset: 1800000000 } });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://api.github.com/user", "https://api.github.com/rate_limit"]);
  expect(JSON.stringify(result)).not.toContain("github_pat_");
});

it("rejects an invalid credential without persisting its text", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
  await expect(inspectGitHubCollectorToken("github_pat_12345678901234567890")).rejects.toThrow("github_token_invalid");
});

it("encrypts PATs with the dedicated shared secret", () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "a".repeat(48));
  const secret = collectorSecret();
  const sealed = encryptCollectorToken("github_pat_12345678901234567890", secret);
  expect(sealed).not.toContain("github_pat_");
  expect(decryptCollectorToken(sealed, secret)).toBe("github_pat_12345678901234567890");
  expect(() => decryptCollectorToken(sealed, "b".repeat(48))).toThrow();
});

it("does not replace a different GitHub user when a specific account was selected", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "a".repeat(48));
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 42, login: "OtherOwner" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 12, remaining: 4988, reset: 1800000000 } } }), { status: 200 })));
  await expect(saveGitHubCollectorAccount("github_pat_12345678901234567890", "admin", 43)).rejects.toThrow("github_account_mismatch");
});

it("rejects absent quota fields instead of displaying false zero usage", () => {
  expect(parseCoreQuota({ limit: 5000, remaining: 0 })).toBeNull();
});
