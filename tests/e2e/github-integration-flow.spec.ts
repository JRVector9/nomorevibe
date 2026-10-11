import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { newPublicSession } from "@/lib/domain/accounts/session";
import { ensureSchema } from "../integration/setup";

// Local DB/session/provider-result fixtures exercise browser and API contracts.
// Real email, OAuth, installations and GitHub writes belong to the recorded pilot.
const slug = "github-integration-e2e", origin = "http://127.0.0.1:43127";
test.skip(process.env.PUBLIC_USER_AUTH_ENABLED !== "true" || process.env.PRODUCT_FEEDBACK_ENABLED !== "true" || process.env.GITHUB_FEEDBACK_DELIVERY_ENABLED !== "true", "명시적으로 활성화한 GitHub 연동 기능 구성에서 실행합니다.");
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await ensureSchema();
  await db.delete(products).where(eq(products.slug, slug));
  await db.insert(products).values({ slug, name: "GitHub Integration E2E", url: "https://integration-e2e.example", repoUrl: "https://github.com/acme/tool",
    tagline: "제품 연동 검증", description: "제품 피드백 연동 브라우저 검증입니다.", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" });
});
test.beforeEach(async () => {
  const [product] = await db.select().from(products).where(eq(products.slug, slug));
  await db.delete(productFeedback).where(eq(productFeedback.productId, product.id));
  await db.delete(githubProductBindings).where(eq(githubProductBindings.productId, product.id));
});

async function account(context: BrowserContext) {
  const [user] = await db.insert(publicUsers).values({ displayName: `참여자-${randomUUID().slice(0, 8)}` }).returning();
  const session = newPublicSession();
  await db.insert(publicSessions).values({ userId: user.id, tokenHash: session.tokenHash, expiresAt: session.expiresAt });
  await context.addCookies([{ name: "nmv_user", value: session.token, url: origin, httpOnly: true, sameSite: "Lax", secure: false }]);
  const response = await context.request.get("/api/me");
  expect(response.status()).toBe(200);
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { user, csrfToken };
}

async function binding(userId: number) {
  const [product] = await db.select().from(products).where(eq(products.slug, slug));
  await db.insert(githubProductBindings).values({ productId: product.id, repositoryId: 123, repositoryFullName: "acme/tool",
    repositoryUrl: "https://github.com/acme/tool", productRepoUrl: product.repoUrl!, installationId: 456, consentedByUserId: userId, revision: 1, enabled: true });
}
const payload = (sendToGithub: boolean) => ({ requestId: randomUUID(), kind: "bug", title: "설치 오류", body: "서비스 원문을 GitHub 이슈와 연결합니다.",
  serviceDisclosureConsent: true, sendToGithub, githubDisclosureConsent: sendToGithub });

test("an email-only public account opts out of GitHub while keeping service feedback public", async ({ page, context }) => {
  const { user, csrfToken } = await account(context);
  await binding(user.id);
  const response = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data: payload(false) });
  expect(response.status()).toBe(201);
  const { feedback } = await response.json();
  expect(feedback.deliveryState).toBe("local_only");
  expect(await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.feedbackId, feedback.id))).toEqual([]);
  await page.goto(`/feedback/${feedback.id}`);
  await expect(page.getByText(/서비스에 공개됨/)).toBeVisible();
  await expect(page.getByText(/서비스에 접수됨/)).toBeVisible();
});

test("separate GitHub consent queues one request and exact replay returns the same feedback", async ({ page, context }) => {
  const { user, csrfToken } = await account(context);
  await binding(user.id);
  await page.goto(`/p/${slug}`);
  await page.getByLabel("피드백 제목", { exact: true }).fill("설치 오류");
  await page.getByLabel("피드백 내용", { exact: true }).fill("서비스 원문을 GitHub 이슈와 연결합니다.");
  await page.getByLabel("닉네임·제목·내용을 NoMoreVibe에 공개하는 데 동의합니다.").check();
  await page.getByLabel("제작자가 연결한 GitHub 저장소에 이슈로 전송합니다.").check();
  await page.getByLabel("닉네임·원문 링크·내용이 앱 봇의 GitHub 공개 이슈에 게시되는 데 별도로 동의합니다.").check();
  const submitted = page.waitForResponse((response) => response.url().endsWith(`/api/products/${slug}/feedback`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "피드백 제출", exact: true }).click();
  const response = await submitted;
  expect(response.status()).toBe(201);
  const { feedback } = await response.json();
  expect(feedback.deliveryState).toBe("queued");
  const replay = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data: response.request().postDataJSON() });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).feedback.id).toBe(feedback.id);
  const rows = await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.feedbackId, feedback.id));
  expect(rows).toHaveLength(1);
  expect(rows[0].payloadBody).toContain(`/feedback/${feedback.id}`);
  expect(rows[0].payloadBody).toContain(user.displayName);
  expect(rows[0].payloadBody).not.toContain(csrfToken);
  await page.getByRole("link", { name: "접수 원문 보기" }).click();
  await expect(page).toHaveURL(`/feedback/${feedback.id}`);
  await expect(page.getByRole("heading", { name: "제품 피드백 원문", exact: true })).toBeVisible();
  await expect(page.getByRole("article").getByText(/GitHub 전송 대기/)).toBeVisible();
});

test("a verified delivery result links the original to GitHub and a closed issue does not claim resolution", async ({ page, context }) => {
  const { user, csrfToken } = await account(context);
  await binding(user.id);
  const response = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data: payload(true) });
  expect(response.status()).toBe(201);
  const { feedback } = await response.json();
  // The delivery integration suite verifies real dispatcher transitions. This
  // fixture represents that verified 201 followed by an authoritative closed GET.
  await db.transaction(async (tx) => {
    await tx.update(githubIssueOutbox).set({ state: "delivered", githubIssueId: 88, githubIssueNumber: 7,
      githubIssueUrl: "https://github.com/acme/tool/issues/7", externalIssueState: "closed", lastCheckedAt: new Date() }).where(eq(githubIssueOutbox.feedbackId, feedback.id));
    await tx.update(productFeedback).set({ deliveryState: "delivered" }).where(eq(productFeedback.id, feedback.id));
  });
  await page.goto(`/feedback/${feedback.id}`);
  await expect(page.getByRole("link", { name: /GitHub 이슈/ })).toHaveAttribute("href", "https://github.com/acme/tool/issues/7");
  await expect(page.getByText(/닫힘/)).toBeVisible();
  await expect(page.getByText(/해결 완료|배포 완료/)).toHaveCount(0);
  const mine = await context.request.get(`/api/me/feedback?slug=${slug}`);
  expect(mine.headers()["cache-control"]).toBe("private, no-store");
  expect((await mine.json()).feedback[0].githubIssueUrl).toBe("https://github.com/acme/tool/issues/7");
});

test("uncertain provider results remain visible as awaiting confirmation and consent cannot be omitted", async ({ page, context }) => {
  const { user, csrfToken } = await account(context);
  await binding(user.id);
  const data = payload(true);
  const invalid = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data: { ...data, githubDisclosureConsent: false } });
  expect(invalid.status()).toBe(400);
  const response = await context.request.post(`/api/products/${slug}/feedback`, { headers: { Origin: origin, "x-csrf-token": csrfToken }, data });
  expect(response.status()).toBe(201);
  const { feedback } = await response.json();
  await db.transaction(async (tx) => {
    await tx.update(githubIssueOutbox).set({ state: "uncertain", lastErrorCode: "github_timeout" }).where(eq(githubIssueOutbox.feedbackId, feedback.id));
    await tx.update(productFeedback).set({ deliveryState: "uncertain" }).where(eq(productFeedback.id, feedback.id));
  });
  await page.goto(`/feedback/${feedback.id}`);
  await expect(page.getByText(/GitHub 전송 결과 확인 중/)).toBeVisible();
  await expect(page.getByRole("link", { name: /GitHub 이슈/ })).toHaveCount(0);
  await expect(page.getByText(data.body, { exact: true })).toBeVisible();
});
