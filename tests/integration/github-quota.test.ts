import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { githubQuotaKeys, readGitHubCooldown, recordGitHubCooldown } from "@/lib/crawl/github-quota";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => { await db.delete(rateLimits); });
it("shares secondary waits across resources but keeps primary credentials isolated", async () => {
  const later = new Date(Date.now()+300_000);
  await recordGitHubCooldown("test-a", "search", {primary:true,secondary:false,retryAt:later});
  expect(await readGitHubCooldown("test-a", "search")).toEqual(later);
  expect(await readGitHubCooldown("test-a", "core")).toBeNull();
  expect(await readGitHubCooldown("test-b", "search")).toBeNull();
  await recordGitHubCooldown("test-a", "search", {primary:false,secondary:true,retryAt:later});
  expect(await readGitHubCooldown("test-a", "core")).toEqual(later);
});
it("does not shorten a persisted wait with a concurrent older response or affect visit limits", async () => {
  const later = new Date(Date.now()+300_000), earlier = new Date(Date.now()+60_000);
  await db.insert(rateLimits).values({key:"visit:test",count:5,resetAt:later});
  await Promise.all([
    recordGitHubCooldown("test-a", "core", {primary:true,secondary:false,retryAt:later}),
    recordGitHubCooldown("test-a", "core", {primary:true,secondary:false,retryAt:earlier}),
  ]);
  expect(await readGitHubCooldown("test-a", "core")).toEqual(later);
  const [visitor] = await db.select().from(rateLimits).where(eq(rateLimits.key,"visit:test"));
  expect(visitor.count).toBe(5);
  const keys = githubQuotaKeys("test-a","core");
  await db.update(rateLimits).set({resetAt:sql`now() - interval '1 second'`}).where(eq(rateLimits.key,keys.primary));
  expect(await readGitHubCooldown("test-a", "core")).toBeNull();
});
