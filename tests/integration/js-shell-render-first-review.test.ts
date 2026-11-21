import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, saveSettings } from "@/lib/crawl/settings";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { resetShellRenderBackoff } from "@/lib/crawl/jobs/shell-render-document";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { RENDERED_PAGE_KEY } from "@/lib/crawl/shell-render";
import { runJob } from "@/lib/jobs/runner";
import { setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import type { RenderClientResult } from "@/lib/screen-review/render-client";
import { ensureSchema, resetTables } from "./setup";

/**
 * JS 앱 껍데기 1차 직전 그리기(PR #983, 2026-11-21 보완)의 실제 1차 틱 — 규칙·claim·기록·lease 는 실제 DB, 모델(Grok CLI)과 화면 서버만 바꾼다.
 * 모델을 부르지 않을 후보(스팸 의심·규칙 거절)는 그리지 않고, 그린 글은 모델 입력이 되며, 스위치를 끄면 그리지 않는다.
 */
const grok = vi.hoisted(() => vi.fn());
const render = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review-grok", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: grok,
}));
vi.mock("@/lib/screen-review/render-client", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/screen-review/render-client")>(), requestRender: render,
}));

const SHELL = "모찌펫 · 작은 친구의 큰 모험";
const RENDERED = "Lv.1 모찌 토끼 60/60 EXP 집 앞 마당 자유 산책 우리 집 사냥터 입장 쓰다듬기 쉬기 친구 상점 스킬 기록 설정 친구 선택하기 자동 저장 준비 완료";
const ok = (text: string, finalUrl: string): RenderClientResult => ({ ok: true, finalUrl, status: 200, text, textLength: text.length,
  jpeg: Buffer.from([0xff, 0xd8, 0xff]), renderMs: 10, egress: { requests: 1, bytes: 1, blocked: 0 } });
const approve = { ok: true, outcome: { decision: "approve", reason: "A working browser RPG", evidenceIds: ["product"], confidence: 0.9 }, usage: {} };
// The production worker grants AI1 110s for its gateway/Grok transport ceiling.
const tick = () => runJob("crawl-agent-review", reviewCrawlCandidates, { budgetMs: 110_000 });

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  resetShellRenderBackoff();
  setRuntimeSettingsForTest(null);
  grok.mockReset().mockResolvedValue(approve);
  render.mockReset().mockImplementation(async (url: string) => ok(RENDERED, `${url}/`));
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  vi.stubEnv("SCREEN_RENDER_URL", "http://100.64.0.9:8791");
  vi.stubEnv("SCREEN_RENDER_TOKEN", "s".repeat(40));
  await saveSettings({ enabled: true, firstReview: { provider: "grok-cli", model: "grok-fixture" } }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "shell render first review test" })).toMatchObject({ ok: true });
});
afterEach(() => { setRuntimeSettingsForTest(null); vi.unstubAllEnvs(); });

async function source(repo: string, productUrl: string, pageMeta: Record<string, unknown>, repoMeta: Record<string, unknown> = {}) {
  const fetchedAt = new Date(Date.now() - 2000);
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt,
    pageMeta: { readmeSample: "브라우저에서 펫을 키우는 RPG", readmeSampleVersion: README_SAMPLE_VERSION, ...pageMeta },
    repoMeta: { description: "Browser pet RPG", pushed_at: fetchedAt.toISOString(), stargazers_count: 3, owner: { type: "User" }, ...repoMeta } });
  await db.insert(crawlCandidates).values({ repo, productUrl, state: "needs_review", reason: "ambiguous", decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt });
}

it("renders a shell after the rule split and sends the rendered text to the first reviewer", async () => {
  await source("daelong/mochipet-rpg", "https://mochi.example", { title: SHELL, textSample: SHELL });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(render).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledWith("https://mochi.example", expect.objectContaining({ timeoutMs: expect.any(Number) }));
  expect(grok).toHaveBeenCalledOnce();
  expect(grok.mock.calls[0][0].snapshot.product).toMatchObject({ pageText: RENDERED, renderedPage: { source: "browser_render", crawlerPageText: SHELL } });
  const [document] = await db.select().from(crawlDocuments);
  expect(document.pageMeta?.[RENDERED_PAGE_KEY]).toMatchObject({ ok: true, text: RENDERED });
  // 시도 행의 입력이 그린 글의 입력이다(2차·발행이 같은 입력을 본다)
  const [attempt] = await db.select().from(crawlReviewAttempts);
  expect(attempt).toMatchObject({ provider: "grok-cli", state: "succeeded" });
});

it("does not run a suspected-spam shell in Chromium and hands it to a person", async () => {
  // 프로드 /p/codex-deepseek 를 줄인 것(spam-gate.test.ts) — 본문이 비어 껍데기이고 README 가 캠페인 꼴이다
  await source("Promisedlandsubtraction2856/codex-deepseek", "https://promisedlandsubtraction2856.github.io",
    { title: "codex-deepseek", description: "Run Codex on DeepSeek models.",
      readmeSample: "🤖 codex-deepseek - Run Codex on DeepSeek Models\n\n"
        + "1. **Download** – Visit this link to download the application: https://promisedlandsubtraction2856.github.io" },
    { name: "codex-deepseek", owner: { login: "Promisedlandsubtraction2856", type: "User" }, stargazers_count: 1, fork: false, archived: false,
      has_issues: true, description: "Run the real OpenAI Codex CLI on DeepSeek models." });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(render).not.toHaveBeenCalled();
  expect(grok).not.toHaveBeenCalled();
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "needs_review", reason: "suspected_spam" }]);
  const [document] = await db.select().from(crawlDocuments);
  expect(document.pageMeta).not.toHaveProperty(RENDERED_PAGE_KEY);
});

it("does not render a shell the rules reject and records the rule rejection", async () => {
  await source("maker/forked-shell", "https://forked.example", { title: SHELL, textSample: SHELL }, { fork: true });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(render).not.toHaveBeenCalled();
  expect(grok).not.toHaveBeenCalled();
  expect(await db.select().from(crawlReviewAttempts)).toMatchObject([{ provider: "rules", state: "succeeded", outcome: { decision: "reject" } }]);
});

it("does not render with the runtime switch off and reviews the crawled text", async () => {
  setRuntimeSettingsForTest({ version: 1, jobs: { "crawl-agent-review": { shellRender: 0 } } });
  await source("daelong/mochipet-rpg", "https://mochi.example", { title: SHELL, textSample: SHELL });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(render).not.toHaveBeenCalled();
  expect(grok).toHaveBeenCalledOnce();
  expect(grok.mock.calls[0][0].snapshot.product.pageText).toBe(SHELL);
  expect(grok.mock.calls[0][0].snapshot.product).not.toHaveProperty("renderedPage");
});

it("waits without writing when the render server is busy and renders on a later tick", async () => {
  await source("daelong/mochipet-rpg", "https://mochi.example", { title: SHELL, textSample: SHELL });
  render.mockResolvedValueOnce({ ok: false, kind: "busy", code: "render_busy" });
  await tick();
  expect(grok).not.toHaveBeenCalled();
  const [waiting] = await db.select().from(crawlDocuments);
  expect(waiting.pageMeta).not.toHaveProperty(RENDERED_PAGE_KEY);
  expect(await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, "daelong/mochipet-rpg"))).toMatchObject([{ state: "needs_review" }]);
  // 붐빔 쉼(15초)이 지난 뒤의 틱 — 시도를 깎지 않았으므로 바로 그려 심사한다(쪽 커서가 한 바퀴 돌아오는 틱까지)
  resetShellRenderBackoff();
  for (let ticks = 0; ticks < 3 && !grok.mock.calls.length; ticks++) await tick();
  expect(render).toHaveBeenCalledTimes(2);
  expect(grok).toHaveBeenCalledOnce();
  expect(grok.mock.calls[0][0].snapshot.product.pageText).toBe(RENDERED);
});

// PR #1020 리뷰 BLOCKER — 짝 없는 서로게이트·NUL 이 든 그린 글이 jsonb 쓰기를 22P02 로 실패시켜 틱 전체가 매 틱 멈췄다. 옆의 정상 후보와 함께 돈다
it("a rendered page with a lone surrogate and NUL is stored cleanly and does not stall the tick for a healthy neighbour", async () => {
  const lone = String.fromCharCode(0xd800);
  await source("daelong/mochipet-rpg", "https://mochi.example", { title: SHELL, textSample: SHELL });
  await source("acme/normal-app", "https://normal.example", { title: "Normal App",
    textSample: "Track invoices, send payment reminders, export monthly reports and manage customers for your small shop." });
  render.mockImplementation(async (url: string) => ok(`${RENDERED} ${lone} 타자 효과\u0000 끝`, `${url}/`));
  const results = [];
  for (let ticks = 0; ticks < 3 && grok.mock.calls.length < 2; ticks++) results.push(await tick());
  expect(results.every(result => result.status === "completed")).toBe(true);
  expect(render).toHaveBeenCalledOnce();
  expect(grok).toHaveBeenCalledTimes(2);
  const reviewed = new Map(grok.mock.calls.map(([input]) => [input.snapshot.product.repo, input.snapshot.product.pageText as string]));
  expect(reviewed.get("acme/normal-app")).toContain("Track invoices");
  const shellText = reviewed.get("daelong/mochipet-rpg")!;
  expect(shellText.isWellFormed()).toBe(true);
  expect(shellText).not.toContain("\u0000");
  expect(shellText).toContain("�");
  const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, "daelong/mochipet-rpg"));
  expect(document.pageMeta?.[RENDERED_PAGE_KEY]).toMatchObject({ ok: true });
  expect(await db.select({ repo: crawlCandidates.repo }).from(crawlReviewAttempts)
    .innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))).toHaveLength(2);
});
