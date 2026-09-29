import { afterEach, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { githubAuthKey, readGitHubAuthCooldown, recordGitHubAuthCooldown } from "@/lib/crawl/github-quota";
import { ensureSchema } from "./setup";

beforeAll(ensureSchema);
afterEach(async () => { await db.delete(rateLimits).where(eq(rateLimits.key, githubAuthKey("test-expired-credential"))); });

it("shares a rejected credential cooldown without exposing or blocking a replacement token", async () => {
  const expiredToken = "test-expired-credential";
  const replacementToken = "test-replacement-credential";
  const key = githubAuthKey(expiredToken);
  await db.delete(rateLimits).where(eq(rateLimits.key, key));
  const retryAt = new Date(Date.now() + 15 * 60_000);

  expect(await recordGitHubAuthCooldown(expiredToken, retryAt)).toEqual(retryAt);
  expect(await readGitHubAuthCooldown(expiredToken)).toEqual(retryAt);
  expect(await readGitHubAuthCooldown(replacementToken)).toBeNull();
  expect(key).not.toContain(expiredToken);
  expect(await recordGitHubAuthCooldown(expiredToken, new Date(Date.now() + 60_000))).toEqual(retryAt);
});
