import { test, expect } from "@playwright/test";
import { screens, href } from "../../components/design/data";
const errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      errors.push(
        `Unexpected API request: ${request.method()} ${request.url()}`,
      );
    }
  });
  await page.goto("/design");
  await page.evaluate(() => localStorage.removeItem("nomorevibe-design-v1"));
  await page.reload();
});
test.afterEach(async () => {
  expect(errors).toEqual([]);
});
test("mobile search, keyboard shortcut and dashboard source selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "검색창 열기" }).click();
  await expect(page.getByRole("textbox", { name: "제품 검색" })).toBeFocused();
  await page.getByRole("textbox", { name: "제품 검색" }).fill("NoteGen");
  await page.getByRole("textbox", { name: "제품 검색" }).press("Enter");
  await expect(page.locator(".d-product-row")).toHaveCount(1);
  await page.goto("/design/radar");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("textbox", { name: "제품 검색" })).toBeFocused();
  await page.getByRole("textbox", { name: "제품 검색" }).fill("AgentDesk");
  await page.getByRole("textbox", { name: "제품 검색" }).press("Enter");
  await expect(page).toHaveURL(/\/design\/radar\?q=AgentDesk/);
  await expect(page.locator(".d-product-row")).toHaveCount(1);
  await page.goto("/design/dashboard");
  await page
    .getByRole("button", { name: "Agent Feedback", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "선택한 피드백" }),
  ).toContainText("UI Check Agent");
  await page
    .getByRole("button", { name: "User Feedback", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "선택한 피드백" }),
  ).toContainText("서연");
});
test("claim stays pending and insufficient credit cannot create a campaign", async ({
  page,
}) => {
  await page.goto("/design/p/agentdesk/claim");
  await page.getByRole("button", { name: /도메인 DNS/ }).click();
  await page.getByRole("button", { name: "검토 요청 미리보기" }).click();
  await page.reload();
  await expect(page.locator("main")).toContainText("검토 중 · 미리보기 신청");
  await expect(page.locator("main")).toContainText(
    "권한이 부여된 상태가 아닙니다",
  );
  await page.goto("/design/sprints/new");
  await page.getByLabel("대상 사용자 *").fill("디자이너");
  await page.getByLabel("시도할 과제 *").fill("이미지 편집");
  await page.getByRole("button", { name: "모집 인원 늘리기" }).click();
  await page.getByRole("button", { name: "60C 예약하고 요청 만들기" }).click();
  await expect(page.locator("main")).toContainText("크레딧이 부족합니다");
  await page.goto("/design/sprints/demo");
  await expect(page.locator("main")).toContainText("아직 만든 요청이 없어요");
});
for (const width of [1440, 390])
  test(`all documented screens render at ${width}px`, async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width, height: 1000 });
    for (const [id, title, path] of screens) {
      await page.goto(href(path));
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.locator(".d-preview")).toContainText("디자인 미리보기");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${id} ${title} overflow`,
      ).toBe(true);
      await expect(page.locator(".nmb-header")).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
test("search, category, saved filter and product tabs work", async ({
  page,
}) => {
  await page.getByRole("textbox", { name: "제품 검색" }).fill("NoteGen");
  await page.getByRole("textbox", { name: "제품 검색" }).press("Enter");
  await expect(page.locator(".d-product-row")).toHaveCount(1);
  await expect(page.locator(".d-product-row")).toContainText("NoteGen");
  await page.getByRole("button", { name: "NoteGen 저장", exact: true }).click();
  await page.getByRole("link", { name: "검색 지우기" }).click();
  await page.getByRole("button", { name: "저장한 제품", exact: true }).click();
  await expect(page.locator(".d-product-row")).toHaveCount(1);
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await page.getByLabel("카테고리", { exact: true }).selectOption("디자인");
  await expect(page.locator(".d-product-row")).toHaveCount(1);
  await page.goto("/design/p/frameit");
  await page.getByRole("button", { name: "피드백", exact: true }).click();
  await expect(page.locator(".d-feedback-card")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Agent Feedback", exact: true })
    .click();
  await expect(page.locator(".d-feedback-card")).toHaveCount(1);
  expect(errors).toEqual([]);
});
test("blocked experience -> pending -> review -> reward, with no duplicate credit", async ({
  page,
}) => {
  await page.goto("/design/p/notegen/test");
  await page.getByLabel("과제와 이용 조건을 확인했습니다.").check();
  await page
    .getByRole("button", { name: "미션 참여 시작", exact: true })
    .click();
  await page.getByRole("link", { name: "결과 작성하기" }).click();
  await page.getByLabel("막힘", { exact: true }).check();
  await page
    .getByLabel("실제로 어떤 결과가 나왔고, 어디에서 막혔나요? *")
    .fill("내보내기를 눌렀지만 아무 파일도 저장되지 않았습니다.");
  await page
    .getByLabel("한 가지만 바꾼다면 무엇을 바꾸겠나요? *")
    .fill("실패 이유를 알려주는 메시지가 필요합니다.");
  await page
    .getByLabel("직접 시도한 경험이며 공개 범위와 심사 기준을 확인했습니다.")
    .check();
  await page.getByRole("button", { name: "피드백 제출", exact: true }).click();
  await expect(page.locator("main")).toContainText("심사 중");
  await page.goto("/design/dashboard");
  await expect(page.locator(".d-inbox-item")).toHaveCount(2);
  await expect(
    page.getByRole("region", { name: "피드백 작업 목록" }),
  ).not.toContainText("NoteGen");
  await page.goto("/design/credits");
  await expect(page.locator(".d-wallet")).toContainText("45");
  await expect(page.locator(".d-wallet")).toContainText("10");
  await page.goto("/design/admin/review");
  await page
    .getByLabel("판정 사유 *")
    .fill("시도한 순서와 실패가 구체적이고 과제에 관련됩니다.");
  await page.getByRole("button", { name: "적격 확정", exact: true }).click();
  await page.goto("/design/credits");
  await expect(page.locator(".d-wallet>div").first()).toContainText("55");
  await page.reload();
  await expect(page.locator(".d-wallet>div").first()).toContainText("55");
  await page.goto("/design/tests/notegen/feedback");
  await expect(page.locator("main")).toContainText("이미 피드백을 제출했어요");
  expect(errors).toEqual([]);
});
test("campaign reserves credits then releases only once", async ({ page }) => {
  await page.goto("/design/sprints/new");
  await page.getByLabel("대상 사용자 *").fill("디자이너");
  await page.getByLabel("시도할 과제 *").fill("스크린샷 편집 후 내보내기");
  await page.getByRole("button", { name: "45C 예약하고 요청 만들기" }).click();
  await expect(page.locator("main")).toContainText("모집 중");
  await page.goto("/design/credits");
  await expect(page.locator(".d-wallet>div").first()).toContainText("0");
  await page.goto("/design/sprints/demo");
  await page.getByRole("button", { name: "미매칭 예약 해제" }).click();
  await expect(
    page.getByRole("button", { name: "미매칭 예약 해제" }),
  ).toHaveCount(0);
  await page.goto("/design/credits");
  await expect(page.locator(".d-wallet>div").first()).toContainText("45");
  expect(errors).toEqual([]);
});
test("launch draft persists and cannot pretend to publish", async ({
  page,
}) => {
  await page.goto("/design/launch");
  await page.getByLabel("제품 URL *").fill("https://demo.example.com");
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByLabel("제품명 *", { exact: true }).fill("My Demo");
  await page.getByLabel("한 줄 소개 *").fill("내가 만드는 첫 제품");
  await page.getByLabel("카테고리 *").selectOption("디자인");
  await page.getByLabel("대상 사용자 *").fill("디자이너");
  await page.reload();
  await expect(page.getByLabel("제품명 *", { exact: true })).toHaveValue(
    "My Demo",
  );
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByLabel("써봤으면 하는 과제 *").fill("첫 프로젝트 생성");
  await page.getByLabel("User Feedback을 받고 답변하겠습니다.").check();
  await page.getByRole("button", { name: "다음 단계" }).click();
  await page.getByLabel("이 제품의 정보를 게시할 권한이 있습니다.").check();
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(page.locator("main")).toContainText(
    "초안을 저장했습니다. 관리 권한 확인 후 공개할 수 있습니다.",
  );
  expect(errors).toEqual([]);
});
test("all common states recover and preview never calls production APIs", async ({
  page,
}) => {
  const api: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/")) api.push(r.url());
  });
  for (const state of [
    "loading",
    "empty",
    "error",
    "forbidden",
    "partial",
    "stale",
    "pending",
    "normal",
  ]) {
    await page.getByLabel("화면 상태", { exact: true }).selectOption(state);
    await expect(page.locator(".d-main")).toBeVisible();
  }
  await expect(
    page.getByRole("heading", { name: "Ship it. Get real users." }),
  ).toBeVisible();
  expect(api).toEqual([]);
  expect(errors).toEqual([]);
});
test("capture review images", async ({ page }) => {
  test.setTimeout(120000);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, path] of [
      ["home", ""],
      ["launches", "launches"],
      ["detail", "p/frameit"],
      ["dashboard", "dashboard"],
      ["launch", "launch"],
      ["sprint", "sprints/new"],
    ]) {
      await page.goto(href(path));
      await expect(page.locator("main h1")).toBeVisible();
      await page.screenshot({
        path: `.design-review/${name}-${width}.png`,
        fullPage: true,
        // Playwright's default caret hiding can mutate SSR attributes before hydration.
        caret: "initial",
      });
    }
  }
  expect(errors).toEqual([]);
});
