import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { githubCollectorAccounts, operationsAudit } from "@/lib/db/schema";
import { collectorTokens, listGitHubCollectorAccounts, saveGitHubCollectorAccount, setGitHubCollectorAccountEnabled } from "@/lib/crawl/github-accounts";
import { ensureSchema } from "./setup";

const userId = 909090909;
beforeAll(() => ensureSchema());
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await db.delete(githubCollectorAccounts).where(eq(githubCollectorAccounts.userId, userId));
  await db.delete(operationsAudit).where(eq(operationsAudit.target, String(userId)));
});

function githubIdentity() {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: userId, login: "fixture-owner" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ resources: { core: { limit: 5000, used: 2, remaining: 4998, reset: 1800000000 } } }), { status: 200 })));
}

it("stores encrypted PAT, replaces the same user, and excludes disabled accounts", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "s".repeat(48));
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  githubIdentity();
  await saveGitHubCollectorAccount("github_pat_first_123456789012345", "integration");
  const first = await db.select().from(githubCollectorAccounts).where(eq(githubCollectorAccounts.userId, userId));
  expect(first).toHaveLength(1);
  expect(first[0].encryptedToken).not.toContain("github_pat_first");
  expect((await collectorTokens()).map(item => item.token)).toContain("github_pat_first_123456789012345");

  githubIdentity();
  await saveGitHubCollectorAccount("github_pat_second_123456789012345", "integration", userId);
  const rows = await db.select().from(githubCollectorAccounts).where(eq(githubCollectorAccounts.userId, userId));
  expect(rows).toHaveLength(1);
  expect((await collectorTokens()).map(item => item.token)).toEqual(["legacy-fixture-token", "github_pat_second_123456789012345"]);
  expect((await listGitHubCollectorAccounts()).find(item => item.userId === userId)).toMatchObject({ login: "fixture-owner", enabled: true });

  expect(await setGitHubCollectorAccountEnabled(userId, false, "integration")).toBe(true);
  expect((await collectorTokens()).map(item => item.token)).toEqual(["legacy-fixture-token"]);
});
