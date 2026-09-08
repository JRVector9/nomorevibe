import { expect, test } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, productRefreshRequests, products } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { ensureSchema } from "../integration/setup";

const repos = ["e2e-worker/approve", "e2e-worker/refresh"];
const slug = "e2e-worker-force";
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  ensureSchema();
  await db.delete(crawlCandidates).where(inArray(crawlCandidates.repo, repos));
  await db.delete(crawlDocuments).where(inArray(crawlDocuments.repo, repos));
  await db.delete(jobs);
  await db.delete(productRefreshRequests).where(eq(productRefreshRequests.slug, slug));
  await db.delete(products).where(eq(products.slug, slug));
  await db.insert(crawlSettings).values({ id: 1, values: {
    ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "observe",
    agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true },
  } }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: {
    ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "observe",
    agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enabled: true },
  } } });
  for (const repo of repos) {
    const productUrl = `https://${repo.split('/')[1]}.example`;
    await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200,
      repoMeta: { description: "Isolated browser fixture" }, pageMeta: { title: repo }, fetchedAt: new Date(Date.now() - 1000) });
    await db.insert(crawlCandidates).values({ repo, productUrl, state: "needs_review", reason: "ambiguous",
      decidedBy: "auto", judgedAt: new Date(Date.now() - 1000) });
  }
  await db.insert(products).values({ slug, url: "https://force.example", name: "Worker refresh fixture", tagline: "Fixture",
    description: "Isolated browser fixture", category: "Dev", status: "verified", source: "skill",
    verifyToken: "e2e-worker-force", editTokenHash: "a".repeat(64) });
});
test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: SESSION_COOKIE, value: await signSession("playwright-admin", "playwright-auth-secret-with-at-least-32-characters"),
    url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
});

test("administrator mode changes and decisions preserve audited queue boundaries", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/admin/review");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "AI 리뷰 운영 모드" })).toBeVisible();
  await page.locator('select[name="mode"]').selectOption("enforce");
  await page.getByLabel("변경 사유", { exact: true }).fill("Browser acceptance: enforce gate");
  await page.getByRole("button", { name: "모드 변경", exact: true }).click();
  await expect.poll(async () => (await db.select().from(crawlSettings))[0].values.reviewMode).toBe("enforce");
  const approval = page.locator("li").filter({ has: page.getByRole("link", { name: repos[0], exact: true }) }).first();
  await approval.getByLabel("관리자 판단 사유", { exact: true }).fill("Browser fixture verified by administrator");
  await approval.getByRole("button", { name: "관리자 승인", exact: true }).click();
  await expect.poll(async () => (await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repos[0])))[0].decidedBy).toBe("admin");
  const refresh = page.locator("li").filter({ has: page.getByRole("link", { name: repos[1], exact: true }) }).first();
  await refresh.getByLabel("추가 근거가 필요한 이유", { exact: true }).fill("Collect current public evidence");
  await refresh.getByRole("button", { name: "추가 수집 요청 (0/2)", exact: true }).click();
  await expect(refresh.getByRole("status")).toContainText("접수했습니다");
  expect(await db.select().from(crawlReviewAttempts).where(and(
    inArray(crawlReviewAttempts.kind, ["admin_override", "evidence_refresh"]),
    eq(crawlReviewAttempts.actor, "playwright-admin"),
  ))).toHaveLength(2);
  const queued = await db.select().from(jobs).where(inArray(jobs.name, ["crawl-publish", "crawl-fetch", "agent-evidence-refresh"]));
  expect(queued).toHaveLength(3);
  expect(queued.every(job => job.requestedVersion > 0 && job.runs === 0)).toBe(true);
  expect(errors).toEqual([]);
});

test("force refresh and cron return receipts while executable workers are absent", async ({ page, request }) => {
  await page.goto(`/admin/products/${slug}`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "근거 갱신 예약", exact: true }).click();
  await expect(page.getByText("갱신을 예약했습니다.", { exact: false })).toBeVisible();
  expect(await db.select().from(productRefreshRequests).where(eq(productRefreshRequests.slug, slug)))
    .toMatchObject([{ force: true, requestedVersion: 1, completedVersion: 0 }]);
  const response = await request.post("/api/cron/crawl-fetch", { headers: { Authorization: "Bearer playwright-cron-secret" } });
  expect(response.status()).toBe(202);
  expect(await response.json()).toMatchObject({ status: "queued", job: "crawl-fetch" });
  expect(await db.select().from(jobs).where(and(eq(jobs.name, "crawl-fetch"), eq(jobs.runs, 0)))).toHaveLength(1);
  await page.goto("/admin/status");
  await expect(page.getByRole("heading", { name: "수집 현황" })).toBeVisible();
});
