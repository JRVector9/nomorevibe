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
    // 순위가 서기 전 홈 기본 '추천'은 스타가 는 제품만 보여 준다 — 카드와 저장 목록에 나오게 한 번 늘려 둔다
    stars: 146,
    starsAt: new Date(),
    starsPrevious: 140,
    starsPreviousAt: new Date(Date.now() - 24 * 60 * 60 * 1_000),
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

  await expect(page.getByRole("heading", { name: /AI로 만든 것들이/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "발견할 가치가 있는 프로젝트" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "많이 쓰이는 프로젝트" })).toBeVisible();

  const card = page.locator(".project-card").filter({ hasText: "Evidence Studio" });
  const tile = card.locator(".project-tile");
  const save = card.getByRole("button", { name: "Evidence Studio 저장" });
  // 카드 하나 = 링크 하나(UX-30) — 커버 링크는 탭·읽기 도구에서 빠지고 제목 링크가 카드를 덮는다
  await expect(card.getByRole("link", { name: "Evidence Studio", exact: true }))
    .toHaveAttribute("href", `/p/${PRODUCT_DETAIL_FIXTURES.rich}`);
  await expect(card.locator(`a[href="/p/${PRODUCT_DETAIL_FIXTURES.rich}"]:not([tabindex="-1"])`)).toHaveCount(1);
  await expect(tile).toBeVisible();
  await save.click();
  await expect(card.getByRole("button", { name: "Evidence Studio 저장 취소" })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("link", { name: /이번 주 태어난/ }).click();
  const dialog = page.getByRole("dialog", { name: "숫자의 기준" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((node) => node.matches(":modal"))).toBe(true);
  await expect(dialog.getByText("태어난 프로젝트 — 저장소를 처음 만든 날로 셉니다.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/metric=/);

  const search = page.getByRole("searchbox", { name: "프로젝트 검색" });
  await search.fill("Evidence Studio");
  await Promise.all([page.waitForURL(/q=Evidence\+Studio/), search.press("Enter")]);
  await expect(page.getByRole("heading", { name: "Evidence Studio", exact: true })).toBeVisible();
  // 헤더 검색은 관련도순이라 어느 탭도 선택되지 않는다
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(0);

  await page.getByRole("link", { name: "Evidence Studio", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${PRODUCT_DETAIL_FIXTURES.rich}$`));
  await page.getByRole("button", { name: "저장한 프로젝트" }).click();
  await expect(page).toHaveURL(/saved=1/);
  await expect(page.getByText("이 브라우저에 저장한 프로젝트 1개", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evidence Studio", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Open Seed", exact: true })).toHaveCount(0);

  // 제작 도구 고르기 칸은 v5 에서 빠졌다 — 같은 키가 둘 와도 화면이 서는지만 본다
  const repeated = await page.goto("/?builder=Codex&builder=Claude");
  expect(repeated?.status()).toBe(200);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?sort=recent");
  await expect(page.getByRole("navigation", { name: "모바일 탐색" })).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  expect(fits).toBe(true);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
});
