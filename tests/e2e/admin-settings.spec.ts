import { expect, test } from "@playwright/test";
import { db } from "@/lib/db";
import { crawlSettings } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { ensureSchema } from "../integration/setup";

/**
 * 크롤 설정 화면의 안전장치(2026-10-08 UX 감사 ADM-06·ADM-18) — 고르고 누르는 상호작용이라 브라우저에서 본다.
 * 발행 보호 끄기는 확인 창에서 사유를 적어야 바뀌고, 바꾼 값이 있으면 다른 메뉴로 갈 때 묻고, 기본값 되돌리기는 바뀔 값을 보인다.
 */
// 포크 제외를 뒤집어 "기본값과 비교"가 뜨게 하고, 비교표에 없는 동시 실행 수도 바꿔 둔다 — 되돌리기 창이 그것까지 보여야 한다
const SETTINGS = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce" as const, reviewConcurrency: 4,
  judge: { ...DEFAULT_CRAWL_SETTINGS.judge, excludeForks: !DEFAULT_CRAWL_SETTINGS.judge.excludeForks } };
const reviewMode = async () => (await db.select().from(crawlSettings))[0].values.reviewMode;

test.describe.configure({ mode: "serial" });
test.beforeAll(() => ensureSchema());
test.beforeEach(async ({ context, baseURL }) => {
  await db.insert(crawlSettings).values({ id: 1, values: SETTINGS })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: SETTINGS } });
  await context.addCookies([{ name: SESSION_COOKIE, value: await signSession("playwright-admin", "playwright-auth-secret-with-at-least-32-characters"),
    url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
});

test("발행 보호 끄기는 확인 창에서 사유를 적어야 바뀐다", async ({ page }) => {
  await page.goto("/admin#second");
  await page.waitForLoadState("networkidle");
  const mode = page.getByRole("group", { name: "발행 보호 · AI 리뷰 운영 모드", exact: true });
  await mode.getByRole("combobox", { name: "모드", exact: true }).selectOption("off");
  // 끄기를 고르면 바로 바꾸는 단추가 사라지고 확인 창을 여는 단추만 남는다
  await expect(mode.getByRole("button", { name: "모드 변경", exact: true })).toHaveCount(0);
  await mode.getByRole("button", { name: "발행 보호 끄기…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI 발행 보호를 끕니다" });
  await expect(dialog).toContainText("적용 → 끄기");
  await dialog.getByRole("button", { name: "발행 보호 끄기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("끄는 사유");
  expect(await reviewMode()).toBe("enforce");

  await dialog.getByLabel("끄는 사유").fill("Browser acceptance: model outage");
  await dialog.getByRole("button", { name: "발행 보호 끄기", exact: true }).click();
  await expect.poll(reviewMode).toBe("off");
});

test("바꾼 값이 있으면 다른 메뉴로 갈 때 묻고, 저장해도 수집 켜짐은 그대로다", async ({ page }) => {
  await page.goto("/admin");
  await page.waitForLoadState("networkidle");
  await expect(page.locator('input[name="enabled"]')).toHaveCount(0);
  await page.locator("#windowDays").fill("33");
  await expect(page.getByText("바뀐 항목 1개")).toBeVisible();

  await page.getByRole("link", { name: "운영센터에서 켜고 끄기 →" }).click();
  const leave = page.getByRole("dialog", { name: "저장하지 않은 변경이 있습니다" });
  await expect(leave).toBeVisible();
  await expect(page).toHaveURL(/\/admin$/);
  await leave.getByRole("button", { name: "취소" }).click();

  await page.getByRole("button", { name: "저장 — 다음 틱부터 적용" }).click();
  await expect(page.getByText("저장했습니다")).toBeVisible();
  const saved = (await db.select().from(crawlSettings))[0].values as typeof SETTINGS;
  expect(saved.discover.windowDays).toBe(33);
  expect(saved.enabled).toBe(true);
});

test("기본값 되돌리기는 바뀔 값을 보여 준 뒤에만 되돌린다", async ({ page }) => {
  await page.goto("/admin#defaults");
  await page.waitForLoadState("networkidle");
  await page.locator("#defaults summary").click();
  await page.getByRole("button", { name: /전부 기본값으로 되돌리기/ }).click();
  const dialog = page.getByRole("dialog", { name: "크롤 설정을 기본값으로 되돌립니다" });
  await expect(dialog).toContainText("1차 심사 동시 실행 수");
  await dialog.getByRole("button", { name: "취소" }).click();
  expect(((await db.select().from(crawlSettings))[0].values as typeof SETTINGS).reviewConcurrency).toBe(4);
});
