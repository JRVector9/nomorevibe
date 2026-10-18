import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { githubCollectorAccounts, githubCollectorApps } from "@/lib/db/schema";
import { githubRequest } from "@/lib/crawl/github";
import { collectorTokens, encryptCollectorToken, observeCollectorQuota } from "@/lib/crawl/github-accounts";
import { clearAppTokenCache, listGitHubCollectorApps, saveGitHubCollectorApp, setGitHubCollectorAppEnabled } from "@/lib/crawl/github-apps";
import { logger } from "@/lib/observability/logger";
import { seal } from "@/lib/operations/credential-vault";
import { ensureSchema } from "./setup";

/** GitHub App 수집 자격(0064) — 같은 계정이어도 설치마다 한도가 따로다. 개인 키는 암호화, 설치 토큰은 프로세스 안에 들고 쓴다 */

const installationId = 818181818;
/** 서버 범위 시험용 두 번째 설치와 개인 토큰 계정 */
const otherInstallationId = 818181819;
const patUserId = 909090919;
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
beforeAll(() => ensureSchema());
beforeEach(() => {
  for (const name of ["GITHUB_COLLECTOR_SOURCES", "GITHUB_COLLECTOR_APP_INSTALLATIONS", "GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS"]) vi.stubEnv(name, undefined);
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearAppTokenCache();
  await db.delete(githubCollectorApps).where(inArray(githubCollectorApps.installationId, [installationId, otherInstallationId]));
  await db.delete(githubCollectorAccounts).where(eq(githubCollectorAccounts.userId, patUserId));
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

it("lets each host pick its credentials: an apps-only host with one installation, another host excluding it, default uses all", async () => {
  const secret = "s".repeat(48);
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", secret);
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  await db.insert(githubCollectorApps).values([installationId, otherInstallationId].map(id => ({ installationId: id, appId: 123, appSlug: `fixture-${id}`,
    accountLogin: "fixture-org", encryptedPrivateKey: seal(pem, secret) })));
  await db.insert(githubCollectorAccounts).values({ userId: patUserId, login: "fixture-owner", encryptedToken: encryptCollectorToken("github_pat_fixture_123456789012345", secret) });
  const fetcher = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const id = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url)?.[1];
    if (id) return minted(`ghs_installation_${id}_123456789`);
    return new Response(JSON.stringify({ id: 1, auth: (init.headers as Record<string, string>).Authorization }), { status: 200, headers: {
      "x-ratelimit-limit": "5000", "x-ratelimit-used": "7", "x-ratelimit-remaining": "4993", "x-ratelimit-reset": "1800000000", "x-ratelimit-resource": "core" } });
  });
  vi.stubGlobal("fetch", fetcher);

  // 기본(환경 변수 없음): 지금처럼 환경 토큰·개인 토큰·설치 둘 다
  expect((await collectorTokens()).map(item => item.token)).toEqual(["legacy-fixture-token", "github_pat_fixture_123456789012345",
    `ghs_installation_${installationId}_123456789`, `ghs_installation_${otherInstallationId}_123456789`]);

  // Oracle: App 만, 새 설치만 — 요청도 그 설치 토큰으로 가고 한도 관측은 그 설치에 적힌다
  clearAppTokenCache(); fetcher.mockClear();
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", "apps");
  vi.stubEnv("GITHUB_COLLECTOR_APP_INSTALLATIONS", String(otherInstallationId));
  expect((await collectorTokens()).map(item => item.token)).toEqual([`ghs_installation_${otherInstallationId}_123456789`]);
  const response = await githubRequest<{ auth: string }>("/repos/fixture-org/fixture");
  expect(response).toMatchObject({ ok: true, value: { auth: `Bearer ghs_installation_${otherInstallationId}_123456789` } });
  expect(fetcher.mock.calls.map(([url]) => url)).not.toContain(`https://api.github.com/app/installations/${installationId}/access_tokens`);
  const quotas = Object.fromEntries((await listGitHubCollectorApps()).map(app => [app.installationId, app.coreQuota]));
  expect(quotas[otherInstallationId]).toMatchObject({ remaining: 4993 });
  expect(quotas[installationId]).toBeNull();

  // M3: 새 설치만 빼고 나머지 전부
  clearAppTokenCache();
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", undefined);
  vi.stubEnv("GITHUB_COLLECTOR_APP_INSTALLATIONS", undefined);
  vi.stubEnv("GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS", String(otherInstallationId));
  expect((await collectorTokens()).map(item => item.token)).toEqual(["legacy-fixture-token", "github_pat_fixture_123456789012345",
    `ghs_installation_${installationId}_123456789`]);
});

it("stops an apps-only host loudly when its allowed installation is turned off — no fallback to other credentials", async () => {
  const secret = "s".repeat(48);
  vi.stubEnv("GITHUB_COLLECTOR_SECRET", secret);
  vi.stubEnv("GITHUB_TOKEN", "legacy-fixture-token");
  vi.stubEnv("GITHUB_COLLECTOR_SOURCES", "apps");
  vi.stubEnv("GITHUB_COLLECTOR_APP_INSTALLATIONS", String(installationId));
  await db.insert(githubCollectorApps).values([
    { installationId, appId: 123, appSlug: "fixture-oracle", accountLogin: "fixture-org", encryptedPrivateKey: seal(pem, secret), enabled: false },
    { installationId: otherInstallationId, appId: 123, appSlug: "fixture-m3", accountLogin: "fixture-org", encryptedPrivateKey: seal(pem, secret) },
  ]);
  const error = vi.spyOn(logger, "error").mockImplementation(() => {});
  const fetcher = vi.fn().mockResolvedValue(minted("ghs_should_not_be_minted_123"));
  vi.stubGlobal("fetch", fetcher);
  expect(await collectorTokens()).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(error.mock.calls.map(([event]) => event)).toEqual(["github.app_scope_installation_disabled", "github.collector_scope_empty"]);
  // 기한이 있는 수집은 인증 대기로 멈추고, 기한 없는 호출은 토큰 없음으로 실패한다 — 다른 설치나 환경 토큰으로 새지 않는다
  expect(await githubRequest("/repos/fixture-org/fixture", {}, { deadlineAt: Date.now() + 15_000 }))
    .toMatchObject({ ok: false, error: { kind: "auth_unavailable", reason: "cooldown" } });
  await expect(githubRequest("/repos/fixture-org/fixture")).rejects.toThrow("GitHub 수집 토큰이 없습니다");
  expect(fetcher).not.toHaveBeenCalled();
});
