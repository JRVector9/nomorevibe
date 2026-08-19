import { expect, test, type Page } from "@playwright/test";
import {
  PRODUCT_DETAIL_FIXTURES,
  seedProductDetailFixtures,
} from "./fixtures/product-detail";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedProductDetailFixtures();
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
  const section = (heading: string) => page.getByRole("heading", { name: heading }).locator("xpath=ancestor::section[1]");
  expect(parseFloat(await section("Evidence Studio").evaluate((node) => getComputedStyle(node).borderRadius))).toBe(14);
  expect(parseFloat(await page.getByRole("region", { name: "NoMoreVibe 유입 및 가동 지표" })
    .evaluate((node) => getComputedStyle(node).borderRadius))).toBe(10);
  expect(parseFloat(await section("상세 소개").evaluate((node) => getComputedStyle(node).borderRadius))).toBe(12);

  const description = section("상세 소개").getByText("Evidence Studio은 AI로 만든 제품을 실제 사용자에게 설명하는 테스트 제품입니다.");
  expect(parseFloat(await description.evaluate((node) => getComputedStyle(node).fontSize))).toBe(15);
  const structured = section("상세 소개").getByText("흩어진 제품 근거와 업데이트를 한 화면에서 확인하기 어렵습니다.");
  expect(parseFloat(await structured.evaluate((node) => getComputedStyle(node).fontSize))).toBe(14);
  const updateCopy = section("업데이트").getByText("병합된 셀의 읽기 순서와 복사 시 탭 구분을 유지합니다.");
  expect(parseFloat(await updateCopy.evaluate((node) => getComputedStyle(node).fontSize))).toBe(14);
}

async function expectNoTimelineConnector(page: Page) {
  const updateSection = page.getByRole("heading", { name: "업데이트" }).locator("xpath=ancestor::section[1]");
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

async function expectControls(page: Page) {
  const controls = [
    page.getByRole("button", { name: "공유" }),
    page.getByRole("link", { name: /제품 방문하기/ }),
    page.getByRole("button", { name: "전체" }),
    page.getByRole("button", { name: "메이커" }),
    page.getByRole("button", { name: "자동 감지" }),
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
  await expect(page.getByText("고유 유입자 · 최근 7일")).toBeVisible();
  await expect(page.getByText("유효 방문 · 최근 7일")).toBeVisible();
  await expect(page.getByText("저장소 생성일")).toBeVisible();
  await expect(page.getByText("★ 146 · forks 18")).toBeVisible();
  await expect(page.getByText("12명")).toBeVisible();
  await expect(page.getByText("OpenAI · Codex · GPT-5")).toBeVisible();
  await expect(page.getByText("openai/review@1.0.0")).toBeVisible();

  const gallery = page.getByRole("img", { name: "Evidence Studio 제품 근거 대시보드 화면" });
  await expect(gallery).toBeVisible();
  await expect(gallery).toHaveAttribute("src", /^\/api\/media\//);
  expect(observed.mediaRequests.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "메이커" }).click();
  await expect(page.getByText("표가 포함된 문서의 텍스트 추출을 개선했습니다")).toBeVisible();
  await expect(page.getByText("v1.6.0 공개")).toBeHidden();
  await page.getByRole("button", { name: "자동 감지" }).click();
  await expect(page.getByText("v1.6.0 공개")).toBeVisible();
  await expect(page.getByText("저장소 활동이 감지되었습니다")).toBeVisible();
  await expect(page.getByText("표가 포함된 문서의 텍스트 추출을 개선했습니다")).toBeHidden();
  await page.getByRole("button", { name: "전체" }).click();

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

  const headings = ["제품 화면", "상세 소개", "객관적 정보", "저장소와 라이선스", "어떤 AI로 만들었나", "업데이트"];
  const tops = await Promise.all(headings.map(async (name) => {
    const box = await page.getByRole("heading", { name }).boundingBox();
    return box?.y ?? -1;
  }));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
  await expectViewportContract(page);
  await expectTextContrast(page);
  await expectControls(page);
  expect(observed.externalRequests).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
  await page.screenshot({ path: "/private/tmp/nomorevibe-product-rich-mobile.png", fullPage: true });
});

test("collecting, stale-conflict, and unclaimed states remain explicit", async ({ page }) => {
  const observed = observePage(page);

  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.collecting);
  await expect(page.getByRole("heading", { name: "Early Signal" })).toBeVisible();
  await expect(page.getByText("집계 중").first()).toBeVisible();
  await expect(page.getByText("저장소 정보를 수집하고 있습니다.")).toBeVisible();
  await expect(page.getByText("아직 보관된 제품 화면이 없습니다.")).toBeVisible();

  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.staleConflict);
  await expect(page.getByRole("heading", { name: "Conflict Lens" })).toBeVisible();
  await expect(page.getByText(/확인 필요/).first()).toBeVisible();
  await expect(page.getByText("두 값을 모두 확인하세요")).toBeVisible();
  await expect(page.getByText("연결 끊김")).toBeVisible();
  await expect(page.getByText("접속 불안정")).toBeVisible();

  await gotoProduct(page, PRODUCT_DETAIL_FIXTURES.unclaimed);
  await expect(page.getByRole("heading", { name: "Open Seed" })).toBeVisible();
  await expect(page.getByText("미클레임")).toBeVisible();
  await expect(page.getByRole("heading", { name: "이 제품의 주인이신가요?" })).toBeVisible();
  await expect(page.getByText("메이커가 아직 상세 소개를 제공하지 않았습니다.")).toBeVisible();

  await expectViewportContract(page);
  expect(observed.externalRequests).toEqual([]);
  expect(observed.consoleErrors).toEqual([]);
  expect(observed.pageErrors).toEqual([]);
});
