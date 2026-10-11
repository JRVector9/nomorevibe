import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { publicIdentities, publicSessions } from "@/lib/db/public-user-schema";
import { startEmailLogin } from "@/lib/domain/accounts/email-login";
import { requestCookie, requireLoginMutation } from "@/lib/domain/accounts/request-auth";
import { hashSessionToken, LOGIN_NONCE_COOKIE } from "@/lib/domain/accounts/session";
import { ensureSchema, resetTables } from "@/tests/integration/setup";
import { E2E_BASE_URL } from "../../playwright.config";

test.skip(process.env.PUBLIC_USER_AUTH_ENABLED !== "true", "명시적으로 활성화한 GitHub 연동 기능 구성에서 실행합니다.");
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  process.env.PUBLIC_USER_AUTH_ENABLED = "true";
  process.env.PUBLIC_AUTH_SECRET = "playwright-public-auth-secret-with-at-least-32-characters";
  ensureSchema();
});
test.beforeEach(async () => resetTables());

/** Only email delivery is substituted. The database and verify/session/logout routes are real. */
async function installLocalMailAdapter(page: Page) {
  let deliveredCode = "";
  await page.route("**/api/auth/user/email/start", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const headers = await request.allHeaders();
    // Validate the same Origin/browser CSRF contract used by the actual start handler.
    const boundary = new Request(request.url(), { method: "POST", headers, body: request.postData() });
    const browserNonce = requireLoginMutation(boundary);
    const input = request.postDataJSON();
    expect(requestCookie(boundary, LOGIN_NONCE_COOKIE)).toBe(browserNonce);
    const started = await startEmailLogin({ email: input.email, returnTo: input.returnTo, browserNonce, ip: "127.0.0.1" }, async (mail) => { deliveredCode = mail.code; return "accepted"; });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(started), headers: { "Cache-Control": "private, no-store" } });
  });
  return () => deliveredCode;
}

test("email-only participant signs in, stays outside admin, and revokes the session on logout", async ({ page, context }) => {
  const receivedCode = await installLocalMailAdapter(page);
  await page.goto("/login?returnTo=/#projects");
  await page.getByLabel("이메일", { exact: true }).fill("browser-reader@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await expect(page.getByLabel("인증 코드", { exact: true })).toBeVisible();
  expect(receivedCode()).toMatch(/^\d{8}$/);
  await page.getByLabel("인증 코드", { exact: true }).fill(receivedCode());
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(`${E2E_BASE_URL}/`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  // Chromium sends loopback Secure cookies; Node APIRequestContext applies a different policy.
  const me = await page.evaluate(async () => {
    const response = await fetch("/api/me", { cache: "no-store" });
    return { status: response.status, cacheControl: response.headers.get("cache-control"), vary: response.headers.get("vary"), body: await response.json() };
  });
  expect(me.status).toBe(200);
  const body = me.body;
  expect(body.user.id).toBeGreaterThan(0);
  expect(body.user.displayName).not.toContain("browser-reader");
  expect(me.cacheControl).toBe("private, no-store");
  expect(me.vary?.split(",").map((field) => field.trim().toLowerCase())).toContain("cookie");
  const cookie = (await context.cookies()).find((entry) => entry.name === "nmv_user")!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.secure).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect((await db.select().from(publicIdentities))).toHaveLength(1);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.goto("/");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("link", { name: "로그인", exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await (await fetch("/api/me", { cache: "no-store" })).json()).user)).toBeNull();
  const [stored] = await db.select().from(publicSessions).where(eq(publicSessions.tokenHash, hashSessionToken(cookie.value)));
  expect(stored.revokedAt).not.toBeNull();
});

test("wrong code preserves the form and an external return URL becomes the local home", async ({ page }) => {
  const receivedCode = await installLocalMailAdapter(page);
  await page.goto("/login?returnTo=https%3A%2F%2Fevil.example");
  await page.getByLabel("이메일", { exact: true }).fill("retry-reader@example.com");
  await page.getByRole("button", { name: "인증 코드 받기", exact: true }).click();
  await expect(page.getByLabel("인증 코드", { exact: true })).toBeVisible();
  await page.getByLabel("인증 코드", { exact: true }).fill(receivedCode() === "00000000" ? "11111111" : "00000000");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.locator("form").filter({ has: page.getByLabel("이메일", { exact: true }) }).getByRole("alert")).toContainText("코드가 올바르지 않거나 만료");
  await expect(page.getByLabel("이메일", { exact: true })).toHaveValue("retry-reader@example.com");
  await page.getByLabel("인증 코드", { exact: true }).fill(receivedCode());
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page).toHaveURL(`${E2E_BASE_URL}/`);
});

test("real public start/verify endpoints reject a cross-site mutation before any email delivery", async ({ request }) => {
  const start = await request.post("/api/auth/user/email/start", { headers: { Origin: "https://evil.example" }, data: { email: "never-sent@example.com" } });
  expect(start.status()).toBe(403);
  expect(await start.json()).toEqual({ error: "invalid_origin" });
  const verify = await request.post("/api/auth/user/email/verify", { headers: { Origin: "https://evil.example" }, data: { challengeId: "forged", code: "00123456" } });
  expect(verify.status()).toBe(403);
  expect((await db.select().from(publicIdentities))).toHaveLength(0);
});
