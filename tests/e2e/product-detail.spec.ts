import { expect, test, type Locator, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import {
  PRODUCT_DETAIL_FIXTURES,
  seedProductDetailFixtures,
} from "./fixtures/product-detail";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedProductDetailFixtures();
});

test("installable product copies a repository-specific prompt and supports manual copy", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/p/${PRODUCT_DETAIL_FIXTURES.installable}`);
  await expect(page.getByRole("button", { name: "설치 프롬프트 복사" })).toBeVisible();
  await expect(page.getByRole("link", { name: /제품 방문하기/ })).toHaveCount(0);
  await page.getByRole("button", { name: "설치 프롬프트 복사" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("https://github.com/example/editor-plugin");
  await page.screenshot({ path: "test-results/installable-desktop.png", fullPage: true });
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
  await page.getByRole("button", { name: "복사됨 ✓" }).click();
  await expect(page.getByLabel("설치 프롬프트", { exact: true })).toBeVisible();
  await expect(page.getByLabel("설치 프롬프트", { exact: true })).toHaveValue(/github.com\/example\/editor-plugin/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportContract(page);
  await page.screenshot({ path: "test-results/installable-mobile.png", fullPage: true });
});

function observePage(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const mediaRequests: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/media/")) mediaRequests.push(url.pathname);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) && !["data:", "blob:"].includes(url.protocol)) {
      externalRequests.push(request.url());
    }
  });
  return { consoleErrors, pageErrors, externalRequests, mediaRequests };
}

async function gotoProduct(page: Page, slug: string) {
  await page.goto(`/p/${slug}`);
  await page.waitForLoadState("networkidle");
}

async function expectViewportContract(page: Page) {
  const result = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const sizes = Array.from(document.body.querySelectorAll("*")).filter((element) => (
      visible(element) && Boolean(element.textContent?.trim())
    )).map((element) => parseFloat(getComputedStyle(element).fontSize)).filter(Number.isFinite);
    return {
      minimumFontSize: Math.min(...sizes),
      fitsViewport: document.documentElement.scrollWidth <= innerWidth,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    };
  });
  expect(result.minimumFontSize).toBeGreaterThanOrEqual(13);
  expect(result.fitsViewport).toBe(true);
  expect(result.colorScheme).toBe("light");
}

async function expectTextContrast(page: Page) {
  const failures = await page.evaluate(() => {
    type Rgb = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgb | null => {
      const match = value.match(/rgba?\((\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)(?:[, /]+(\d+(?:\.\d+)?))?\)/);
      return match
        ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) }
        : null;
    };
    const over = (top: Rgb, bottom: Rgb): Rgb => {
      const alpha = top.a + bottom.a * (1 - top.a);
      if (alpha === 0) return { r: 255, g: 255, b: 255, a: 1 };
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / alpha,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / alpha,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / alpha,
        a: alpha,
      };
    };
    const background = (element: Element): Rgb => {
      const layers: Rgb[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0) layers.push(color);
      }
      return layers.reverse().reduce(
        (bottom, top) => over(top, bottom),
        { r: 255, g: 255, b: 255, a: 1 },
      );
    };
    const channel = (value: number) => {
      const normalized = value / 255;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: Rgb) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    const ratio = (one: Rgb, two: Rgb) => {
      const [light, dark] = [luminance(one), luminance(two)].sort((a, b) => b - a);
      return (light + 0.05) / (dark + 0.05);
    };

    return Array.from(document.body.querySelectorAll("*")).flatMap((element) => {
      const hasDirectText = Array.from(element.childNodes).some((node) => (
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
      ));
      if (!hasDirectText) return [];
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || box.width === 0 || box.height === 0) return [];
      const foreground = parse(style.color);
      if (!foreground) return [];
      const bg = background(element);
      const effectiveForeground = over(foreground, bg);
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = Number(style.fontWeight) || 400;
      const required = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700) ? 3 : 4.5;
      const actual = ratio(effectiveForeground, bg);
      return actual + 0.01 < required
        ? [{ text: element.textContent?.trim().slice(0, 80), actual, required, color: style.color, background: style.backgroundColor }]
        : [];
    });
  });
  expect(failures).toEqual([]);
}

async function expectDetailGeometry(page: Page) {
  const section = (heading: string | RegExp) => page.getByRole("heading", { name: heading, exact: typeof heading === "string" })
    .locator("xpath=ancestor::section[1]");
  const fontSize = (locator: Locator) => locator.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));

  // v5 본문 위계 — 소개 17 · 메이커가 밝힌 것 14 · 업데이트 한 줄 13
  const description = section("소개").getByText("Evidence Studio은 AI로 만든 제품을 실제 사용자에게 설명하는 테스트 제품입니다.");
  expect(await fontSize(description)).toBe(17);
  const structured = section("메이커가 밝힌 것").getByText("흩어진 제품 근거와 업데이트를 한 화면에서 확인하기 어렵습니다.");
  expect(await fontSize(structured)).toBe(14);
  const updateRow = section(/^업데이트/).getByText("표가 포함된 문서의 텍스트 추출을 개선했습니다");
  expect(await fontSize(updateRow)).toBe(13);
}

async function expectNoTimelineConnector(page: Page) {
  const updateSection = page.getByRole("heading", { name: /^업데이트/ }).locator("xpath=ancestor::section[1]");
  const candidates = await updateSection.evaluate((root) => Array.from(root.querySelectorAll("*")).flatMap((element) => {
    const style = getComputedStyle(element);
    const onlyLeftBorder = parseFloat(style.borderLeftWidth) > 0
      && parseFloat(style.borderTopWidth) === 0
      && parseFloat(style.borderRightWidth) === 0
      && parseFloat(style.borderBottomWidth) === 0;
    const pseudoConnector = ["::before", "::after"].some((pseudo) => {
      const computed = getComputedStyle(element, pseudo);
      return !["none", "normal", "\"\""].includes(computed.content)
        && parseFloat(computed.height) > 32
        && parseFloat(computed.borderLeftWidth) > 0;
    });
    return onlyLeftBorder || pseudoConnector ? [element.tagName] : [];
  }));
  expect(candidates).toEqual([]);
}

async function expectReadingOrder(steps: Locator[]) {
  const tops: number[] = [];
  for (const step of steps) {
    const box = await step.boundingBox();
    expect(box, `${step} 이 화면에 있어야 한다`).not.toBeNull();
    tops.push(box!.y);
  }
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
}

async function expectControls(page: Page) {
  const controls = [
    page.getByRole("button", { name: "공유" }),
    page.getByRole("link", { name: /제품 방문하기/ }),
    page.getByRole("tab", { name: "전체" }),
    page.getByRole("tab", { name: "메이커" }),
    page.getByRole("tab", { name: "자동 감지" }),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let index = 0; index < 20 && !(await controls[0].evaluate((node) => document.activeElement === node)); index += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(controls[0]).toBeFocused();
  const focus = await controls[0].evaluate((node) => {
    const style = getComputedStyle(node);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(focus.style).not.toBe("none");
  expect(focus.width).toBeGreaterThanOrEqual(2);
}

test("rich desktop profile shows objective evidence and behaves without provider requests", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const observed = observePage(page);
  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.rich);

  await expect(page.getByRole("heading", { name: "Evidence Studio" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "무엇으로 만들었나" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "정보", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "근거", exact: true })).toHaveCount(0);
  await expect(page.getByText("최근 코드 업데이트", { exact: true })).toBeVisible();
  // 유입은 실제로 잰 값이 있을 때만 일곱째 칸으로 나온다
  await expect(page.getByText("유효 방문 · 최근 7일")).toBeVisible();
  await expect(page.getByText(/저장소 생성 \d{4}년/)).toBeVisible();
  await expect(page.getByText("포크 18", { exact: true })).toBeVisible();
  await expect(page.getByText("12명")).toBeVisible();
  await expect(page.getByText("OpenAI · Codex · GPT-5")).toBeVisible();
  await expect(page.getByText("openai/review@1.0.0")).toBeVisible();

  const gallery = page.getByRole("img", { name: "Evidence Studio 제품 근거 대시보드 화면" });
  await expect(gallery).toBeVisible();
  await expect(gallery).toHaveAttribute("src", /^\/api\/media\//);
  expect(observed.mediaRequests.length).toBeGreaterThan(0);

  await page.getByRole("tab", { name: "메이커" }).click();
  await expect(page.getByText("표가 포함된 문서의 텍스트 추출을 개선했습니다")).toBeVisible();
  await expect(page.getByText("v1.6.0 공개")).toBeHidden();
  await page.getByRole("tab", { name: "자동 감지" }).click();
  await expect(page.getByText("v1.6.0 공개")).toBeVisible();
  await expect(page.getByText("저장소 활동이 감지되었습니다")).toBeVisible();
  await expect(page.getByText("표가 포함된 문서의 텍스트 추출을 개선했습니다")).toBeHidden();
  await page.getByRole("tab", { name: "전체" }).click();

  await expectViewportContract(page);
  await expectTextContrast(page);
  await expectDetailGeometry(page);
  await expectNoTimelineConnector(page);
  await expectControls(page);
  await expect(page.getByText(/댓글/)).toHaveCount(0);
  expect(observed.externalRequests).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
  await page.screenshot({ path: "/private/tmp/nomorevibe-product-rich-desktop.png", fullPage: true });
});

test("mobile profile keeps the approved reading order and visible core content", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const observed = observePage(page);
  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.rich);

  // 히어로 → 핵심 사실 → 무엇으로 만들었나 → 소개 → 업데이트 → 정보 (오른쪽 열은 본문 아래로)
  const readingOrder = (name: string) => [
    page.getByRole("heading", { level: 1, name }),
    page.getByText("nomorevibe 등록", { exact: true }),
    page.getByRole("heading", { name: "무엇으로 만들었나" }),
    page.getByRole("heading", { name: "소개", exact: true }),
    page.getByRole("heading", { name: /^업데이트/ }),
    page.getByRole("heading", { name: "정보", exact: true }),
  ];
  await expectReadingOrder(readingOrder("Evidence Studio"));
  await expectViewportContract(page);
  await expectTextContrast(page);
  await expectControls(page);
  expect(observed.externalRequests).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
  await page.screenshot({ path: "/private/tmp/nomorevibe-product-rich-mobile.png", fullPage: true });

  // 운영자 안내는 저장소가 있는 운영자 미확인 제품에만 — 미리보기 다음에 온다.
  // 같은 분야 '지금 뜨는' 줄은 fixture 에 스타가 는 제품이 없어 나오지 않는다.
  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.installable);
  await expectReadingOrder([...readingOrder("Editor Plugin"), page.getByText("이 프로젝트의 운영자인가요?")]);
  await expectViewportContract(page);
});

test("collecting, stale-conflict, and unclaimed states remain explicit", async ({ page }) => {
  const observed = observePage(page);

  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.collecting);
  await expect(page.getByRole("heading", { name: "Early Signal" })).toBeVisible();
  await expect(page.getByText("집계 중", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/유효 방문/)).toHaveCount(0);
  await expect(page.getByText("저장소 정보를 수집하고 있습니다.")).toHaveCount(0);
  await expect(page.getByText("아직 보관된 제품 화면이 없습니다.")).toHaveCount(0);

  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.staleConflict);
  await expect(page.getByRole("heading", { name: "Conflict Lens" })).toBeVisible();
  // 사용자가 제거한 근거 요약은 사라지고, 개별 충돌·연결·접속 상태는 아래에서 확인한다.
  await expect(page.getByRole("heading", { name: "근거", exact: true })).toHaveCount(0);
  await expect(page.getByText("확인 필요 1", { exact: true })).toHaveCount(0);
  const license = page.getByText("라이선스", { exact: true }).locator("..");
  await expect(license).toContainText("정보 충돌");
  await expect(license).toContainText("메이커 MIT · 저장소 GPL-3.0 — 두 값을 모두 확인하세요");
  await expect(page.getByText("연결 끊김")).toBeVisible();
  await expect(page.getByText("접속 불안정").first()).toBeVisible();
  await expect(page.locator("main").getByText(/온라인/)).toHaveCount(0);

  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.unclaimed);
  await expect(page.getByRole("heading", { name: "Open Seed" })).toBeVisible();
  const hero = page.getByRole("heading", { level: 1, name: "Open Seed" }).locator("xpath=ancestor::section[1]");
  await expect(hero.getByText("운영자 미확인", { exact: true })).toBeVisible();
  // 저장소가 없는 운영자 미확인 제품은 운영 주체를 추정해 표시하지 않는다.
  await expect(page.getByRole("heading", { name: "운영 주체와 연락" })).toHaveCount(0);
  await expect(page.getByText("nomorevibe 등록", { exact: true })).toBeVisible();
  await expect(page.getByText("메이커가 아직 상세 소개를 제공하지 않았습니다.")).toHaveCount(0);

  await expectViewportContract(page);
  expect(observed.externalRequests).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
});

test("unclaimed owner guidance keeps one sidebar profile and accepts a takedown request", async ({ page }) => {
  await db.update(products).set({ repoUrl: "https://github.com/example/open-seed" })
    .where(eq(products.slug, PRODUCT_DETAIL_FIXTURES.unclaimed));
  const observed = observePage(page);
  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.unclaimed);

  const sidebar = page.getByRole("complementary").filter({
    has: page.getByRole("heading", { name: "정보", exact: true }),
  });
  await expect(sidebar.getByRole("link", { name: "@example ↗", exact: true })).toHaveCount(1);
  await expect(sidebar.getByRole("heading", { name: "운영 주체와 연락", exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole("heading", { name: "이 프로젝트의 운영자인가요?", exact: true })).toBeVisible();
  await expect(sidebar.locator("code")).toHaveText("/nomorevibe verify");

  const request = sidebar.locator("summary", { hasText: "목록에서 내려달라고 요청하기" });
  await expect(request).toBeVisible();
  expect((await request.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await request.click();
  await sidebar.getByLabel("요청 이유").fill("브라우저 테스트 요청");
  await sidebar.getByRole("button", { name: "요청 보내기", exact: true }).click();
  await expect(sidebar.getByText("요청을 받았습니다. 24시간 안에 확인합니다. 확인 전에도 검색엔진 노출은 바로 멈춥니다.", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectViewportContract(page);
  expect(observed.externalRequests).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
});


test("mobile detail starts at the top after navigation, history return, and reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.rich);
  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(900);
  await page.locator(".brand").click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "Evidence Studio" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, 900));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(900);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("navigation", { name: "경로", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "근거", exact: true })).toHaveCount(0);
});
