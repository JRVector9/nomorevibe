import { expect, test } from "@playwright/test";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlSettings, products } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { ensureSchema, resetTables } from "../integration/setup";

test.beforeAll(async () => {
  ensureSchema(); await resetTables();
  await db.delete(crawlCandidates); await db.delete(crawlDocuments);
  await db.insert(crawlSettings).values({ id: 1, values: { ...DEFAULT_CRAWL_SETTINGS, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, displayObservedFacts: true } } }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: { ...DEFAULT_CRAWL_SETTINGS, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, displayObservedFacts: true } } } });
  for (let i = 0; i < 13; i++) {
    const slug = `observed-${String(i).padStart(2, "0")}`;
    await db.insert(products).values({ slug, name: i === 12 ? "Reported-only Outsider" : `Observed Project ${i}`, url: `https://${slug}.example`, tagline: "A useful observed project", description: "Tools for teams", category: "Dev", status: "seeded", source: "crawler", builder: i === 12 ? "Claude Code" : null, verifyToken: "v", editTokenHash: "e", createdAt: new Date("2026-09-01") });
    await db.insert(crawlCandidates).values({ repo: `acme/${slug}`, state: "published", publishedSlug: slug });
    const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(i + 1), repositoryKey: `acme/${slug}`, commitSha: "c".repeat(40), detectorVersion: "v", scopeHash: "s", state: "complete", completedAt: new Date("2026-09-02") }).returning();
    await db.insert(agentRepositoryObservations).values({ scanId: scan.id, observationKey: "k", facts: { kind: "instruction_file", client: i === 12 ? "codex" : "claude-code" } as AgentObservation });
  }
});

test("도구 알약은 저장소 흔적만 거르고 분야·더 보기·초기화에 따라간다", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const tools = page.getByRole("region", { name: "무엇으로 만들었나" });
  // 다른 파일이 먼저 읽은 집계는 60초 캐시에 남는다 — 새 표본이 보일 때까지 정확한 알약 수로 확인한다
  await expect(async () => {
    await page.goto("/?sort=recent");
    await expect(tools.getByRole("link", { name: "Claude Code 12", exact: true })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 75_000, intervals: [1_000, 5_000, 10_000] });
  await tools.getByRole("link", { name: "Claude Code 12", exact: true }).click();
  await expect(page).toHaveURL(/observedTool=Claude\+Code/);
  expect(new URL(page.url()).searchParams.get("observedTool")).toBe("Claude Code");
  await expect(page.locator(".filter-summary")).toContainText("검색 결과 12개");
  await expect(page.locator(".project-card")).toHaveCount(9);
  await expect(tools.getByRole("link", { name: "Claude Code 12", exact: true })).toHaveAttribute("aria-current", "true");
  const control = await tools.getByRole("link", { name: "Claude Code 12", exact: true }).evaluate(element => ({ height: element.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(element).fontSize) }));
  expect(control.height).toBeGreaterThanOrEqual(44);
  expect(control.fontSize).toBeGreaterThanOrEqual(13);
  await page.getByRole("navigation", { name: "분야", exact: true }).getByRole("link", { name: "개발 도구 13", exact: true }).click();
  await page.getByRole("link", { name: "프로젝트 더 보기 (9 / 12)", exact: true }).click();
  await expect(page.locator(".project-title")).toHaveText(Array.from({ length: 12 }, (_, i) => `Observed Project ${i}`));
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ sort: "recent", category: "Dev", observedTool: "Claude Code", shown: "12" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await tools.screenshot({ path: "/private/tmp/nmv-v5-c1-tools-mobile.png" });
  await page.getByRole("link", { name: "필터 초기화", exact: true }).click();
  await expect(page.locator(".filter-summary")).toContainText("13개");
  expect(new URL(page.url()).searchParams.has("observedTool")).toBe(false);
  expect(errors).toEqual([]);
});

test("헤더 검색에서도 관찰 도구 필터가 남아 신고값만 같은 제품을 포함하지 않는다", async ({ page }) => {
  await page.goto("/?sort=recent&observedTool=Claude+Code");
  await expect(page.locator(".filter-summary")).toContainText("검색 결과 12개");
  const search = page.getByRole("searchbox", { name: "프로젝트 검색", exact: true });
  await search.fill("Outsider"); await search.press("Enter");
  await expect(page).toHaveURL(/q=Outsider/);
  expect(new URL(page.url()).searchParams.get("observedTool")).toBe("Claude Code");
  await expect(page.getByRole("heading", { name: "조건에 맞는 제품이 없습니다", exact: true })).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(0);
});
