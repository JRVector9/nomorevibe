import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { githubStarOperations } from "@/lib/db/github-star-schema";
import { saveGithubUserConnection } from "@/lib/domain/github-user/repository";
import { GET, PUT } from "@/app/api/products/[slug]/github-star/route";
import { ensureSchema, resetTables } from "@/tests/integration/setup";
import { E2E_BASE_URL } from "../../playwright.config";

test.skip(process.env.PUBLIC_USER_AUTH_ENABLED !== "true" || process.env.GITHUB_STAR_ENABLED !== "true", "명시적으로 활성화한 GitHub 연동 기능 구성에서 실행합니다.");
test.describe.configure({ mode: "serial" });
let remoteStarred = false;
let failWrite = false;
let writes: string[] = [];
const originalFetch = globalThis.fetch;
const slug = "e2e-personal-stars";

test.beforeAll(() => {
  process.env.PUBLIC_USER_AUTH_ENABLED = "true";
  process.env.GITHUB_STAR_ENABLED = "true";
  process.env.PUBLIC_AUTH_SECRET = "playwright-public-auth-secret-with-at-least-32-characters";
  process.env.GITHUB_INTEGRATION_SECRET = "playwright-github-integration-secret-at-least-32-characters";
  process.env.GITHUB_STAR_APP_CLIENT_ID = "Iv1.playwright-star-id";
  process.env.GITHUB_STAR_APP_CLIENT_SECRET = "playwright-star-secret";
  ensureSchema();
});
test.beforeEach(async () => {
  await resetTables();
  await db.insert(products).values({ slug, name: "Personal Star Project", url: "https://stars.example", tagline: "개인 GitHub 스타 검증", description: "별 버튼 검증", category: "Dev", status: "verified", verifyToken: "e2e-star-verify", editTokenHash: "e2e-star-edit", repoUrl: "https://github.com/example/project", stars: 100 });
  remoteStarred = false; failWrite = false; writes = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com") return originalFetch(input, init);
    if (url.pathname === "/repos/example/project") return Response.json({ id: 1000, owner: { login: "example" }, name: "project", full_name: "example/project", html_url: "https://github.com/example/project", private: false, archived: false, has_issues: true });
    if (url.pathname === "/user/starred/example/project") {
      const method = init?.method ?? "GET";
      if (method === "GET") return new Response(null, { status: remoteStarred ? 204 : 404 });
      writes.push(method);
      if (failWrite) throw new Error("mock provider response lost");
      remoteStarred = method === "PUT";
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected provider endpoint");
  };
});
test.afterEach(() => { globalThis.fetch = originalFetch; });

async function localProviderAdapter(page: Page) {
  // Browser UI + real auth/database/service code run with a provider transport fixture.
  // The star route is invoked in this test process so no production GitHub write occurs.
  await page.route(`**/api/products/${slug}/github-star`, async (route) => {
    const source = route.request();
    const request = new Request(source.url(), { method: source.method(), headers: await source.allHeaders(), ...(source.method() === "PUT" ? { body: source.postData() } : {}) });
    const response = await (source.method() === "PUT" ? PUT : GET)(request, { params: Promise.resolve({ slug }) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: await response.text() });
  });
}

test("anonymous users see GitHub connection separately from the browser save control", async ({ page }) => {
  await page.goto(`/p/${slug}`);
  await expect(page.getByRole("link", { name: "GitHub 연결 후 스타", exact: true })).toHaveAttribute("href", `/login?connectGithub=1&returnTo=%2Fp%2F${slug}`);
  await expect(page.getByRole("button", { name: "Personal Star Project 저장", exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test("a connected user adds and cancels a remote star while public totals and browser saving stay independent", async ({ page, context }) => {
  const connected = await saveGithubUserConnection({ actorUserId: null, githubUser: { id: 101, login: "star-reader" }, tokens: { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) } });
  await context.addCookies([{ name: "nmv_user", value: connected.token, url: E2E_BASE_URL, httpOnly: true, sameSite: "Lax" }]);
  await localProviderAdapter(page);
  await page.goto(`/p/${slug}`);
  await page.getByRole("button", { name: "GitHub 스타", exact: true }).click();
  await expect(page.getByRole("button", { name: "GitHub 스타 취소", exact: true })).toBeVisible();
  expect(remoteStarred).toBe(true);
  await page.getByRole("button", { name: "GitHub 스타 취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "GitHub 스타", exact: true })).toBeEnabled();
  expect(remoteStarred).toBe(false); expect(writes).toEqual(["PUT", "DELETE"]);
  expect((await db.select().from(products).where(eq(products.slug, slug)))[0].stars).toBe(100);
  await expect(page.getByRole("button", { name: "Personal Star Project 저장", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("an ambiguous provider response shows unknown and blocks an opposite write", async ({ page, context }) => {
  const connected = await saveGithubUserConnection({ actorUserId: null, githubUser: { id: 102, login: "uncertain-reader" }, tokens: { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) } });
  await context.addCookies([{ name: "nmv_user", value: connected.token, url: E2E_BASE_URL, httpOnly: true, sameSite: "Lax" }]);
  await localProviderAdapter(page); failWrite = true;
  await page.goto(`/p/${slug}`);
  await page.getByRole("button", { name: "GitHub 스타", exact: true }).click();
  await expect(page.getByRole("button", { name: "GitHub 스타 확인 불가", exact: true })).toBeDisabled();
  await expect(page.getByTestId("github-star-control").getByRole("status")).toContainText("변경 결과를 확인할 수 없습니다");
  await page.getByRole("button", { name: "스타 상태 다시 확인", exact: true }).click();
  await expect(page.getByRole("button", { name: "GitHub 스타 확인 불가", exact: true })).toBeDisabled();
  expect((await db.select().from(githubStarOperations))[0].state).toBe("unknown");
  expect(writes).toEqual(["PUT"]);
});

test("an expired credential asks for GitHub reconnection without reporting a star", async ({ page, context }) => {
  const connected = await saveGithubUserConnection({ actorUserId: null, githubUser: { id: 103, login: "expired-reader" }, tokens: { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() - 1_000), refreshExpiresAt: new Date(Date.now() - 1_000) } });
  await context.addCookies([{ name: "nmv_user", value: connected.token, url: E2E_BASE_URL, httpOnly: true, sameSite: "Lax" }]);
  await localProviderAdapter(page);
  await page.goto(`/p/${slug}`);
  await expect(page.getByRole("link", { name: "GitHub 재연결 후 스타", exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});
