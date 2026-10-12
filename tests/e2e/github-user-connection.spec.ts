import { expect, test } from "@playwright/test";
import { db } from "@/lib/db";
import { githubAuthFlows, githubUserConnections } from "@/lib/db/github-user-schema";
import { saveGithubUserConnection } from "@/lib/domain/github-user/repository";
import { ensureSchema, resetTables } from "@/tests/integration/setup";
import { E2E_BASE_URL } from "../../playwright.config";

test.skip(process.env.PUBLIC_USER_AUTH_ENABLED !== "true" || process.env.GITHUB_STAR_ENABLED !== "true", "명시적으로 활성화한 GitHub 연동 기능 구성에서 실행합니다.");
test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  process.env.PUBLIC_USER_AUTH_ENABLED = "true";
  process.env.GITHUB_STAR_ENABLED = "true";
  process.env.PUBLIC_AUTH_SECRET = "playwright-public-auth-secret-with-at-least-32-characters";
  process.env.GITHUB_INTEGRATION_SECRET = "playwright-github-integration-secret-at-least-32-characters";
  ensureSchema();
});
test.beforeEach(async () => resetTables());

test("explicit personal star consent starts a real flow and denial consumes it without exchanging tokens", async ({ page, context }) => {
  let authorizeState = "";
  let intercepted = false;
  await page.route((url) => ["github.com", "api.github.com"].includes(url.hostname), async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://github.com" || url.pathname !== "/login/oauth/authorize") {
      await route.abort("blockedbyclient");
      return;
    }
    intercepted = true;
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("redirect_uri")).toBe(`${E2E_BASE_URL}/api/auth/user/github/callback`);
    authorizeState = url.searchParams.get("state")!;
    const callback = `${E2E_BASE_URL}/api/auth/user/github/callback?state=${encodeURIComponent(authorizeState)}&error=access_denied`;
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"><title>Local OAuth provider fixture</title></head><body><a href="${callback.replace(/&/g, "&amp;")}">취소하고 돌아가기</a></body></html>` });
  });
  await page.goto("/login?connectGithub=1");
  const button = page.getByRole("button", { name: "GitHub로 로그인", exact: true });
  await expect(button).toBeDisabled();
  await page.getByLabel("본인 계정의 GitHub 스타 추가·취소 권한을 승인합니다.", { exact: true }).check();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole("link", { name: "취소하고 돌아가기", exact: true })).toBeVisible();
  expect(intercepted).toBe(true);
  await page.getByRole("link", { name: "취소하고 돌아가기" }).click();
  await expect(page).toHaveURL(/githubError=github_authorization_declined/);
  await expect(page.getByRole("region", { name: "GitHub 로그인", exact: true }).getByRole("alert")).toContainText("GitHub 연결을 취소했습니다");
  const [flow] = await db.select().from(githubAuthFlows);
  expect(flow.consumedAt).not.toBeNull();
  expect(flow.stateHash).not.toBe(authorizeState);
  expect(await db.select().from(githubUserConnections)).toHaveLength(0);
  expect((await context.cookies()).find((entry) => entry.name === "nmv_github_nonce")).toBeUndefined();
});

test("an existing verified connection displays its account and disconnects locally", async ({ page, context }) => {
  // A pre-verified test fixture replaces provider credentials; no real OAuth grant is requested.
  const connected = await saveGithubUserConnection({ actorUserId: null, githubUser: { id: 101, login: "browser-reader" }, tokens: { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) } });
  await context.addCookies([{ name: "nmv_user", value: connected.token, url: E2E_BASE_URL, httpOnly: true, sameSite: "Lax" }]);
  const external: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).hostname === "github.com" || new URL(request.url()).hostname === "api.github.com") external.push(request.url()); });
  await page.goto("/login?connectGithub=1");
  await expect(page.getByText("@browser-reader 연결됨", { exact: true })).toBeVisible();
  await expect(page.getByText("연결을 해제해도 이미 남긴 GitHub 스타는 유지됩니다.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "GitHub 연결 해제", exact: true }).click();
  await expect(page.getByRole("button", { name: "GitHub 연결", exact: true })).toBeVisible();
  const response = await page.evaluate(async () => {
    const current = await fetch("/api/me/github", { cache: "no-store" });
    return { status: current.status, cacheControl: current.headers.get("cache-control"), body: await current.json() };
  });
  expect(response.status).toBe(200);
  expect(response.cacheControl).toBe("private, no-store");
  expect(response.body.connection.state).toBe("revoked");
  const [stored] = await db.select().from(githubUserConnections);
  expect(stored.encryptedAccessToken).toBeNull();
  expect(stored.encryptedRefreshToken).toBeNull();
  expect(external).toEqual([]);
});

test("a signed-in actor sees a failed callback instead of losing the error during login redirection", async ({ page, context }) => {
  const connected = await saveGithubUserConnection({ actorUserId: null, githubUser: { id: 102, login: "signed-in-reader" }, tokens: { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) } });
  await context.addCookies([{ name: "nmv_user", value: connected.token, url: E2E_BASE_URL, httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/api/auth/user/github/callback?state=forged");
  await expect(page).toHaveURL(/connectGithub=1/);
  await expect(page.getByRole("region", { name: "개인 GitHub 연결", exact: true }).getByRole("alert")).toContainText("연결 요청이 만료되었거나 로그인 계정이 바뀌었습니다");
});
