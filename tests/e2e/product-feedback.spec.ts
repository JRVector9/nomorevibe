import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, rateLimits } from "@/lib/db/schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { newPublicSession } from "@/lib/domain/accounts/session";
import { ensureSchema } from "../integration/setup";

const slug = "feedback-e2e";
const origin = "http://127.0.0.1:43127";

test.skip(process.env.PUBLIC_USER_AUTH_ENABLED !== "true" || process.env.PRODUCT_FEEDBACK_ENABLED !== "true", "명시적으로 활성화한 GitHub 연동 기능 구성에서 실행합니다.");
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  ensureSchema();
  await db.delete(products).where(eq(products.slug, slug));
  await db.insert(products).values({ slug, name: "Feedback E2E", url: "https://feedback-e2e.example", tagline: "제품 피드백 검증",
    description: "피드백 화면을 검증하는 제품입니다.", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" });
});
test.beforeEach(async () => {
  const [product] = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
  await db.delete(productFeedback).where(eq(productFeedback.productId, product.id));
});

async function login(context: BrowserContext) {
  const [user] = await db.insert(publicUsers).values({ displayName: `참여자-${randomUUID().slice(0, 8)}` }).returning();
  const session = newPublicSession();
  await db.insert(publicSessions).values({ tokenHash: session.tokenHash, userId: user.id, expiresAt: session.expiresAt });
  await db.delete(rateLimits).where(eq(rateLimits.key, `feedback:hour:${user.id}`));
  await context.addCookies([{ name: "nmv_user", value: session.token, url: origin, httpOnly: true, sameSite: "Lax", secure: false }]);
  const response = await context.request.get("/api/me");
  expect(response.ok()).toBe(true);
  const state = await response.json() as { user: { id: number }; csrfToken: string };
  expect(state.user.id).toBe(user.id);
  return { user, csrfToken: state.csrfToken };
}

test("email account can submit while preserving a failed draft and the same retry request ID", async ({ page, context }) => {
  await login(context);
  await page.goto(`/p/${slug}`);
  await page.getByRole("button", { name: "댓글 남기기", exact: true }).click();
  await page.getByRole("textbox", { name: "댓글 내용", exact: true }).fill("원문을 보관하고 다시 제출합니다.");
  await page.getByLabel("닉네임·제목·내용을 NoMoreVibe에 공개하는 데 동의합니다.").check();
  let failedRequestId: string | null = null;
  await page.route(`**/api/products/${slug}/feedback`, async (route) => {
    if (route.request().method() === "POST") {
      failedRequestId = route.request().postDataJSON().requestId;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "feedback_unavailable" }) });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await expect(page.locator("#feedback").getByRole("alert")).toContainText("작성 내용은 보관되어 있습니다");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "댓글 내용", exact: true })).toHaveValue("원문을 보관하고 다시 제출합니다.");
  await page.unroute(`**/api/products/${slug}/feedback`);
  const posted = page.waitForRequest((request) => request.url().endsWith(`/api/products/${slug}/feedback`) && request.method() === "POST");
  await page.getByRole("button", { name: "등록", exact: true }).click();
  expect((await posted).postDataJSON().requestId).toBe(failedRequestId);
  await expect(page.locator("#feedback").getByRole("status").filter({ hasText: "GitHub에는 전송되지 않았습니다" })).toBeVisible();
  await page.getByRole("link", { name: "접수 원문 보기" }).click();
  await expect(page.getByText("원문을 보관하고 다시 제출합니다.", { exact: true })).toBeVisible();
});

test("published originals render hostile HTML as text and only the session author is recorded", async ({ page, context, browser }) => {
  const { user, csrfToken } = await login(context);
  const body = "<script>window.__feedbackXss=1</script><img src=x onerror=alert(1)>";
  const payload = { requestId: randomUUID(), kind: "question", title: "<b>원문</b>", body, serviceDisclosureConsent: true,
    sendToGithub: false, githubDisclosureConsent: false, authorUserId: 999 };
  const response = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data: payload });
  expect(response.status()).toBe(201);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  const { feedback } = await response.json();
  expect(feedback.authorUserId).toBe(user.id);
  await page.goto(`/feedback/${feedback.id}`);
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__feedbackXss"))).toBeUndefined();
  const anonymous = await browser.newContext({ baseURL: origin });
  expect((await anonymous.request.get(`/feedback/${feedback.id}`)).status()).toBe(200);
  await anonymous.close();
});

test("held feedback is absent from the public list and hidden from other accounts", async ({ page, context, browser }) => {
  const { csrfToken } = await login(context);
  const response = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data: {
    requestId: randomUUID(), kind: "bug", title: "링크 검토", body: "https://a.test https://b.test https://c.test https://d.test",
    serviceDisclosureConsent: true, sendToGithub: false, githubDisclosureConsent: false,
  } });
  expect(response.status()).toBe(201);
  const { feedback } = await response.json();
  expect(feedback.reviewState).toBe("held");
  const publicList = await context.request.get(`/api/products/${slug}/feedback`);
  expect((await publicList.json()).feedback).toEqual([]);
  await page.goto(`/feedback/${feedback.id}`);
  await expect(page.getByText(/검토 중 · 작성자와 관리자만/)).toBeVisible();
  const other = await browser.newContext({ baseURL: origin });
  expect((await other.request.get(`/feedback/${feedback.id}`)).status()).toBe(404);
  await login(other);
  expect((await other.request.get(`/feedback/${feedback.id}`)).status()).toBe(404);
  await other.close();
});

test("general login cannot enter feedback administration and writes require both Origin and CSRF", async ({ page, context }) => {
  const { csrfToken } = await login(context);
  await page.goto("/admin/feedback");
  await expect(page).toHaveURL(/\/admin\/login/);
  const data = { requestId: randomUUID(), kind: "bug", title: "오류", body: "설치 오류", serviceDisclosureConsent: true, sendToGithub: false, githubDisclosureConsent: false };
  expect((await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin }, data })).status()).toBe(403);
  expect((await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: "https://attacker.example", "x-csrf-token": csrfToken }, data })).status()).toBe(403);
  const missingConsent = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data: { ...data, sendToGithub: true } });
  expect(missingConsent.status()).toBe(400);
});
