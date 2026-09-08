import { expect, it } from "vitest";
import { githubCooldown, githubQuotaKeys } from "@/lib/crawl/github-quota";

it("isolates primary resources and credentials while sharing secondary waits", () => {
  const core = githubQuotaKeys("secret-token-a", "core");
  const search = githubQuotaKeys("secret-token-a", "search");
  expect(core.primary).not.toBe(search.primary);
  expect(core.secondary).toBe(search.secondary);
  expect(core.secondary).not.toBe(githubQuotaKeys("secret-token-b", "core").secondary);
  expect(JSON.stringify(core)).not.toContain("secret-token-a");
});
it("records exhausted primary quota even on a successful conditional response", () => {
  const now = new Date("2026-09-08T00:00:00Z");
  const retryAt = new Date(now.getTime() + 90_000);
  expect(githubCooldown(304, new Headers({"x-ratelimit-remaining":"0","x-ratelimit-reset":String(retryAt.getTime()/1000)}), now))
    .toEqual({primary:true,secondary:false,retryAt});
});
it("waits at least a minute when a secondary rejection omits retry headers", () => {
  const now = new Date("2026-09-08T00:00:00Z");
  expect(githubCooldown(403, new Headers(), now, true)).toEqual({primary:false,secondary:true,retryAt:new Date(now.getTime()+60_000)});
  expect(githubCooldown(403, new Headers(), now)).toBeNull();
});
it("preserves the later reset when Retry-After is shorter", () => {
  const now = new Date("2026-09-08T00:00:00Z");
  const retryAt = new Date(now.getTime()+120_000);
  expect(githubCooldown(429, new Headers({"retry-after":"30","x-ratelimit-reset":String(retryAt.getTime()/1000)}), now)?.retryAt).toEqual(retryAt);
});
