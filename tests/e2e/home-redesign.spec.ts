import { expect, test, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { PRODUCT_DETAIL_FIXTURES, seedProductDetailFixtures } from "./fixtures/product-detail";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedProductDetailFixtures();
  await db.update(products).set({
    builder: "Codex",
    repoUrl: "https://github.com/example/evidence-studio",
  }).where(eq(products.slug, PRODUCT_DETAIL_FIXTURES.rich));
});

function observePage(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

test("home discovery, saved projects, search, methodology, and mobile layout work together", async ({ page }) => {
  const observed = observePage(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "AI로 만든 것들, 세상에 나오다." })).toBeVisible();
  const strip = page.getByRole("region", { name: "이번 주 nomorevibe" });
  await expect(strip.getByText("태어난 프로젝트")).toBeVisible();
  await expect(strip.getByText("새 버전을 낸 프로젝트")).toBeVisible();
  await expect(page.getByRole("heading", { name: "이번 주 가장 활발한 프로젝트" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "분야 순위" })).toBeVisible();

  const card = page.locator(".project-card").filter({ hasText: "Evidence Studio" });
  const cover = card.locator(".card-visual");
  const save = card.getByRole("button", { name: "Evidence Studio 저장" });
  await expect(card.getByRole("link", { name: "Evidence Studio 상세 보기" }))
    .toHaveAttribute("href", `/p/${PRODUCT_DETAIL_FIXTURES.rich}`);
  const [coverBox, saveBox] = await Promise.all([cover.boundingBox(), save.boundingBox()]);
  expect(saveBox?.x ?? 0).toBeGreaterThan(coverBox?.x ?? 0);
  expect(saveBox?.x ?? Infinity).toBeLessThan((coverBox?.x ?? 0) + (coverBox?.width ?? 0));
  expect(saveBox?.y ?? Infinity).toBeGreaterThanOrEqual(coverBox?.y ?? 0);
  expect(saveBox?.y ?? Infinity).toBeLessThan((coverBox?.y ?? 0) + (coverBox?.height ?? 0));
  await save.click();
  await expect(card.getByRole("button", { name: "Evidence Studio 저장 취소" })).toHaveAttribute("aria-pressed", "true");

  await strip.getByRole("link", { name: /태어난 프로젝트/ }).click();
  const dialog = page.getByRole("dialog", { name: "숫자의 기준" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
  await expect(dialog.getByText("태어난 프로젝트 — 저장소를 처음 만든 날로 셉니다.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/metric=/);

  await page.getByRole("link", { name: "분야 순위 집계 기준" }).click();
  await expect(dialog.getByText("분야 순위 — 공개 수와 이번 주 태어난 수.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/metric=/);

  const search = page.getByRole("searchbox", { name: "프로젝트 검색" });
  await search.fill("Evidence Studio");
  await Promise.all([page.waitForURL(/q=Evidence\+Studio/), search.press("Enter")]);
  await expect(page.getByRole("heading", { name: "Evidence Studio" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "최신" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("link", { name: "Evidence Studio", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${PRODUCT_DETAIL_FIXTURES.rich}$`));
  await page.getByRole("button", { name: "저장한 프로젝트" }).click();
  await expect(page).toHaveURL(/saved=1/);
  await expect(page.getByText("이 브라우저에 저장한 프로젝트 1개", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evidence Studio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open Seed", exact: true })).toHaveCount(0);

  const repeated = await page.goto("/?builder=Codex&builder=Claude");
  expect(repeated?.status()).toBe(200);
  await expect(page.locator("#home-builder")).toHaveValue("Codex");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?sort=recent");
  await expect(page.getByRole("navigation", { name: "모바일 탐색" })).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(fits).toBe(true);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
});
