import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { githubCollectorApps } from "@/lib/db/schema";
import { collectorTokens, observeCollectorQuota } from "@/lib/crawl/github-accounts";
import { clearAppTokenCache, listGitHubCollectorApps, saveGitHubCollectorApp, setGitHubCollectorAppEnabled } from "@/lib/crawl/github-apps";
import { ensureSchema } from "./setup";

/** GitHub App 수집 자격(0064) — 같은 계정이어도 설치마다 한도가 따로다. 개인 키는 암호화, 설치 토큰은 프로세스 안에 들고 쓴다 */

const installationId = 818181818;
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
beforeAll(() => ensureSchema());
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearAppTokenCache();
  await db.delete(githubCollectorApps).where(eq(githubCollectorApps.installationId, installationId));
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const minted = (token: string) => json({ token, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }, 201);

it("stores the app key encrypted, adds its installation token after personal tokens, and reuses it until near expiry", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "s".repeat(48));
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(json({ id: 123, slug: "nmv-collector" }))
    .mockResolvedValueOnce(json({ id: installationId, account: { login: "fixture-owner" } }))
    .mockResolvedValueOnce(minted("ghs_inspect_token_123456789012"))
    .mockResolvedValueOnce(json({ resources: { core: { limit: 5000, used: 0, remaining: 5000, reset: 1800000000 } } })));
  await saveGitHubCollectorApp({ appId: 123, installationId, privateKeyPem: pem }, "integration");
  const [row] = await db.select().from(githubCollectorApps).where(eq(githubCollectorApps.installationId, installationId));
  expect(row).toMatchObject({ appId: 123, appSlug: "nmv-collector", accountLogin: "fixture-owner", enabled: true });
  expect(row.encryptedPrivateKey).not.toContain("PRIVATE KEY");

  const fetcher = vi.fn().mockResolvedValue(minted("ghs_worker_token_1234567890123"));
  vi.stubGlobal("fetch", fetcher);
  const tokens = await collectorTokens();
  expect(tokens.map((item) => item.token)).toEqual(["legacy-fixture-token", "ghs_worker_token_1234567890123"]);
  expect(tokens[1]).toMatchObject({ userId: null, installationId, login: "nmv-collector (앱)" });
  // 두 번째부터는 들고 있는 토큰을 쓴다 — GitHub 에 다시 묻지 않는다
  await collectorTokens();
  expect(fetcher).toHaveBeenCalledOnce();

  // 한도 관측은 그 설치에 적는다
  const headers = new Headers({ "x-ratelimit-limit": "5000", "x-ratelimit-used": "12", "x-ratelimit-remaining": "4988", "x-ratelimit-reset": "1800000000", "x-ratelimit-resource": "core" });
  await observeCollectorQuota({ userId: null, installationId }, headers);
  expect((await listGitHubCollectorApps()).find((app) => app.installationId === installationId)?.coreQuota).toMatchObject({ remaining: 4988 });

  expect(await setGitHubCollectorAppEnabled(installationId, false, "integration")).toBe(true);
  expect((await collectorTokens()).map((item) => item.token)).toEqual(["legacy-fixture-token"]);
});

it("skips an installation whose token cannot be minted and does not retry it on every request", async () => {
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", "s".repeat(48));
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(json({ id: 123, slug: "nmv-collector" }))
    .mockResolvedValueOnce(json({ id: installationId, account: { login: "fixture-owner" } }))
    .mockResolvedValueOnce(minted("ghs_inspect_token_123456789012"))
    .mockResolvedValueOnce(json({ resources: { core: { limit: 5000, used: 0, remaining: 5000, reset: 1800000000 } } })));
  await saveGitHubCollectorApp({ appId: 123, installationId, privateKeyPem: pem }, "integration");
  const fetcher = vi.fn().mockResolvedValue(json({ message: "Not Found" }, 404));
  vi.stubGlobal("fetch", fetcher);
  expect((await collectorTokens()).map((item) => item.token)).toEqual(["legacy-fixture-token"]);
  await collectorTokens();
  expect(fetcher).toHaveBeenCalledOnce();
});
