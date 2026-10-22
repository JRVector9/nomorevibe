import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, operationsObservations, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems, productAuditPolicyRuns, productAuditSecondOpinions, secondReviews } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, saveSettings, setQwenAutoStep } from "@/lib/crawl/settings";
import { writeAuditSecondOpinions } from "@/lib/crawl/audit-second-opinion-import";
import { startProductAudit } from "@/lib/crawl/product-audit";
import { qwenEndpointBackoff, resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { readScreenObservation, resetScreenBackoff, reviewThinPagesByScreen, screenBackoff, screenReviewStatus, SCREEN_REVIEW_JOB,
  SCREEN_REVIEW_OBSERVATION } from "@/lib/screen-review/job";
import { createRenderService } from "@/lib/screen-review/server";
import type { RenderOutcome } from "@/lib/screen-review/renderer";
import type { FontCheck } from "@/lib/screen-review/protocol";
import { SCREEN_REVIEW_NOTE } from "@/lib/screen-review/vision-review";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 화면 판별 잡(lib/screen-review/job.ts) — 화면 판별 대기(글이 적은 감사 거절)를 화면 서버로 그려 m1 Qwen 에 글+첫 화면으로 묻고 두 번째 의견(qwen-vision-auto)으로
 * 적은 뒤 그 답으로 닫는다. 화면 서버는 진짜 HTTP 서버(createRenderService — 그리기만 가짜), 모델은 진짜 HTTP 의 가짜 OpenAI 호환 서버다.
 * 쓰기·보류·유지·일지는 실제 DB 다. 바깥 사이트에는 나가지 않는다.
 */
const TOKEN = "screen-token-".padEnd(48, "x");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1]);
const COMPANY = 'pageText: "Acme" — only the product name, the page is empty';
type Answer = { decision: "approve" | "reject" | "needs_review"; confidence?: number } | number;

const model = { answers: new Map<string, Answer>(), calls: [] as { repo: string; pageText: string; image: boolean; note: boolean; model: string }[],
  before: null as (() => Promise<void>) | null };
const renderer = { pages: new Map<string, RenderOutcome>(), calls: [] as string[], fonts: { ko: true, ja: true, zh: true } as FontCheck | null };
let modelServer: http.Server, renderService: ReturnType<typeof createRenderService>, modelUrl = "", renderUrl = "";

beforeAll(async () => {
  await ensureSchema();
  modelServer = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model: string; messages: { role: string; content: unknown }[] };
    const parts = body.messages.at(-1)!.content as { type: string; text?: string; image_url?: { url: string } }[];
    const text = parts[0].text!;
    const snapshot = JSON.parse(text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n</untrusted_evidence_json>")));
    model.calls.push({ repo: snapshot.product.repo, pageText: snapshot.product.pageText, model: body.model, note: text.endsWith(SCREEN_REVIEW_NOTE),
      image: parts[1]?.type === "image_url" && parts[1].image_url!.url === `data:image/jpeg;base64,${JPEG.toString("base64")}` });
    if (model.before) await model.before();
    const answer = model.answers.get(snapshot.product.repo) ?? { decision: "approve" };
    if (typeof answer === "number") { res.writeHead(answer); return res.end("{}"); }
    const content = JSON.stringify({ decision: answer.decision, reason: `screen says ${answer.decision}`, evidenceIds: ["product"], confidence: answer.confidence ?? 0.95 });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 7_000, completion_tokens: 80 } }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  modelUrl = `http://127.0.0.1:${(modelServer.address() as net.AddressInfo).port}/v1`;
  renderService = createRenderService({ token: TOKEN, maxConcurrent: 2, ports: [80, 443], version: "test", sandbox: true, fonts: () => renderer.fonts,
    render: async (url) => {
      renderer.calls.push(url);
      return renderer.pages.get(url) ?? { ok: true, finalUrl: url, status: 200, text: `Rendered app at ${url} — sign up to start tracking tasks`,
        textLength: 60, screenshot: JPEG, renderMs: 900, egress: { requests: 5, bytes: 1_000, blocked: 0, reasons: {}, blockedTargets: [] } };
    } });
  await new Promise<void>((resolve) => renderService.listen(0, "127.0.0.1", resolve));
  renderUrl = `http://127.0.0.1:${(renderService.address() as net.AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  await new Promise<void>((resolve) => renderService.close(() => resolve()));
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("SCREEN_RENDER_URL", renderUrl);
  vi.stubEnv("SCREEN_RENDER_TOKEN", TOKEN);
  vi.stubEnv("AUDIT_SECOND_OPINION_URL", modelUrl);
  vi.stubEnv("SCREEN_REVIEW_MODEL_URL", "");
  for (const table of [secondReviews, productAuditAttempts, productAuditItems, productAuditCampaigns, crawlReviewAttempts, crawlCandidates,
    crawlDocuments, crawlFrontier, crawlSettings, jobs]) await db.delete(table);
  await db.delete(operationsObservations).where(eq(operationsObservations.key, SCREEN_REVIEW_OBSERVATION));
  await resetTables();
  model.answers.clear(); model.calls.length = 0; model.before = null;
  renderer.pages.clear(); renderer.calls.length = 0; renderer.fonts = { ko: true, ja: true, zh: true };
  resetQwenAuditBackoff();
  resetScreenBackoff();
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, reviewConcurrency: 1 }, "test");
  expect(await turn({ enabled: true, perTick: 4 })).toMatchObject({ ok: true });
});
afterEach(() => vi.unstubAllEnvs());

const turn = async (next: { enabled: boolean; perTick: number; autoClose?: boolean }, reason = "화면 판별 시험") => {
  const expected = (await getSettings()).qwenAuto.screenReview;
  return setQwenAutoStep({ step: "screenReview", next: { ...expected, ...next }, expected, actor: "jr", reason });
};

let sequence = 0;
/** 공개 제품 하나 — textSample 이 짧으면(300자 아래) 글이 얇은 항목이다 */
async function listed(repo: string, textSample: string, over: Partial<typeof products.$inferInsert> = {}) {
  const slug = repo.split("/")[1];
  const url = `https://${slug}.test`;
  await db.insert(products).values({ slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded",
    source: "crawler", verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64), ...over });
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: slug, textSample } });
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto", publishedSlug: slug,
    judgedAt: new Date(), decidedAt: new Date() });
}
async function judged(rows: { repo: string; text?: string; confidence?: number; over?: Partial<typeof products.$inferInsert> }[]) {
  for (const row of rows) await listed(row.repo, row.text ?? "", row.over);
  await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false });
  for (const row of rows) {
    await db.update(productAuditItems).set({ aiDecision: "reject", aiConfidence: row.confidence ?? 0.97, aiReason: COMPANY, reviewedAt: sql`now()`,
      attempts: 1 }).where(eq(productAuditItems.slug, row.repo.split("/")[1]));
  }
  await db.update(productAuditCampaigns).set({ status: "done" });
}
const tick = () => runJob(SCREEN_REVIEW_JOB, reviewThinPagesByScreen, { budgetMs: jobRunOptions(SCREEN_REVIEW_JOB, { requestedOnly: true }).budgetMs });
const item = async (slug: string) => (await db.select().from(productAuditItems).where(eq(productAuditItems.slug, slug)).orderBy(asc(productAuditItems.id))).at(-1)!;
const product = async (slug: string) => (await db.select().from(products).where(eq(products.slug, slug)))[0];
const opinions = () => db.select().from(productAuditSecondOpinions).orderBy(asc(productAuditSecondOpinions.itemId), asc(productAuditSecondOpinions.model));
const vote = async (slug: string, modelName: string, decision: "approve" | "reject", source: string, promptVersion: string | null = null) => {
  const row = await item(slug);
  await db.insert(productAuditSecondOpinions).values({ itemId: row.id, productId: row.productId, model: modelName, decision, confidence: 0.95,
    reason: "earlier", source, promptVersion });
};
const LONG = "Acme is a task tracker for small teams. ".repeat(12);

describe("화면 판별", () => {
  it("화면 판별 대기만 그려서 묻고, 출처 qwen-vision-auto·모델 +vision·판 shot1 로 적는다 — 승인은 유지, 주인 없는 것의 거절은 숨김", async () => {
    await judged([{ repo: "s/approve" }, { repo: "s/reject" }, { repo: "s/thick", text: LONG }, { repo: "s/owned", over: { claimedAt: new Date() } }]);
    model.answers.set("s/reject", { decision: "reject", confidence: 0.96 });
    model.answers.set("s/owned", { decision: "reject", confidence: 0.96 });
    const result = await tick();
    expect(result).toMatchObject({ status: "completed" });
    expect("degraded" in result ? result.degraded : undefined).toBeUndefined();
    // 글이 두꺼운 항목은 그리지 않는다
    expect(renderer.calls.sort()).toEqual(["https://approve.test", "https://owned.test", "https://reject.test"]);
    expect(model.calls.every((call) => call.image && call.note && call.model === "qwen3.8-flash-next")).toBe(true);
    // 그린 뒤 글이 더 길어 pageText 를 바꿔 물었다
    expect(model.calls.find((call) => call.repo === "s/approve")!.pageText).toContain("Rendered app at https://approve.test");
    expect((await opinions()).map((row) => [row.source, row.model, row.promptVersion, row.decision])).toEqual([
      ["qwen-vision-auto", "qwen3.8-flash-next+vision", "2026-10-21.v2+shot1", "approve"],
      ["qwen-vision-auto", "qwen3.8-flash-next+vision", "2026-10-21.v2+shot1", "reject"],
      ["qwen-vision-auto", "qwen3.8-flash-next+vision", "2026-10-21.v2+shot1", "reject"],
    ]);
    expect((await item("approve")).humanDecision).toBe("kept");
    expect((await product("reject")).auditHoldAt).not.toBeNull();
    // 주인 있는 제품의 거절은 열어 둔다
    expect((await item("owned")).humanDecision).toBeNull();
    expect((await product("owned")).auditHoldAt).toBeNull();
    const runs = await db.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.createdBy, "qwen-vision-auto"));
    expect(runs.map((run) => (run.options as { auto: { action: string } }).auto.action).sort()).toEqual(["hold", "keep"]);
    const status = await screenReviewStatus(await getSettings());
    expect(status).toMatchObject({ enabled: true, configured: true, model: "qwen3.8-flash-next+vision", shared: true, lastHour: 3, approveDay: 1, rejectDay: 2,
      remaining: 0, waitingPublic: 0, givenUp: 0, health: { ok: true, sandbox: true, fonts: { ko: true, ja: true, zh: true } } });
  });

  it("보류 중인 것 먼저(글만 본 판단으로 숨겨진 것) — 그다음 공개 중, 틱당 수를 넘기지 않는다. 화면 승인은 유지하고 보류를 푼다", async () => {
    await judged([{ repo: "o/first", confidence: 0.6 }, { repo: "o/second", confidence: 0.99 }, { repo: "o/third", confidence: 0.8 }]);
    await db.update(products).set({ auditHoldAt: sql`now()`, auditHoldItemId: (await item("first")).id }).where(eq(products.slug, "first"));
    expect(await turn({ enabled: true, perTick: 2 })).toMatchObject({ ok: true });
    await tick();
    expect(renderer.calls).toEqual(["https://first.test", "https://second.test"]);
    expect((await item("first")).humanDecision).toBe("kept");
    expect((await product("first")).auditHoldAt).toBeNull();
  });

  it("화면 판별의 답으로 닫기는 글 단계의 스위치와 따로다 — 끄면 의견만 적고, 글 단계의 닫기를 꺼도 화면 답은 닫는다", async () => {
    await judged([{ repo: "x/one" }, { repo: "x/two" }]);
    expect(await turn({ enabled: true, perTick: 1, autoClose: false })).toMatchObject({ ok: true });
    await tick();
    expect((await opinions()).map((row) => [row.source, row.decision])).toEqual([["qwen-vision-auto", "approve"]]);
    expect((await item("one")).humanDecision).toBeNull();
    // 글 단계(감사 두 번째 의견)의 답으로 닫기를 끄고 화면 판별의 것을 켜면 화면 답은 닫는다
    const text = (await getSettings()).qwenAuto.auditSecondOpinion;
    expect(await setQwenAutoStep({ step: "auditSecondOpinion", next: { ...text, autoClose: false }, expected: text, actor: "jr" })).toMatchObject({ ok: true });
    expect(await turn({ enabled: true, perTick: 1, autoClose: true })).toMatchObject({ ok: true });
    await tick();
    expect((await item("two")).humanDecision).toBe("kept");
  });

  it("글만 본 거절(qwen-v2-auto·grok 일괄)이 있어도 화면 승인이 정한다 — 글만 본 의견끼리는 여전히 갈림이다", async () => {
    // d/text 는 글이 두꺼워 화면 판별이 묻지 않는다 — 글만 본 의견끼리의 규칙을 견준다
    await judged([{ repo: "d/screen" }, { repo: "d/text", text: LONG }]);
    await vote("screen", "qwen3.8-flash-next", "reject", "qwen-v2-auto", QWEN_V2_PROMPT_VERSION);
    await vote("screen", "grok-4.7", "reject", "grok-cli-batch");
    await db.update(products).set({ auditHoldAt: sql`now()`, auditHoldItemId: (await item("screen")).id }).where(eq(products.slug, "screen"));
    await vote("text", "grok-4.7", "reject", "grok-cli-batch");
    await tick();
    expect(renderer.calls).toEqual(["https://screen.test"]);
    expect((await item("screen")).humanDecision).toBe("kept");
    expect((await product("screen")).auditHoldAt).toBeNull();
    // 글만 본 Qwen 승인은 다른 모델(grok)의 거절이 있으면 갈림으로 열어 둔다(그대로) — 그 단계를 켜고 같은 쓰기를 바로 부른다
    const expected = (await getSettings()).qwenAuto.auditSecondOpinion;
    expect(await setQwenAutoStep({ step: "auditSecondOpinion", next: { ...expected, enabled: true }, expected, actor: "jr", reason: "시험" }))
      .toMatchObject({ ok: true });
    const row = await item("text");
    const written = await writeAuditSecondOpinions(db, [{ itemId: row.id, productId: row.productId, model: "qwen3.8-flash-next", decision: "approve",
      confidence: 0.97, reason: "text approve", inputHash: null, promptVersion: QWEN_V2_PROMPT_VERSION }],
    { dryRun: false, source: "qwen-v2-auto", auto: { actor: "qwen-v2-auto", close: true } });
    expect(written.autoClose?.left).toEqual({ split: 1 });
    expect((await item("text")).humanDecision).toBeNull();
  });

  it("글만 본 승인(qwen-v2-auto·grok 일괄)이 있어도 화면 거절이 정한다 — 주인 없는 것은 숨긴다", async () => {
    await judged([{ repo: "v/hide" }]);
    await vote("hide", "qwen3.8-flash-next", "approve", "qwen-v2-auto", QWEN_V2_PROMPT_VERSION);
    await vote("hide", "grok-4.7", "approve", "grok-cli-batch");
    model.answers.set("v/hide", { decision: "reject", confidence: 0.97 });
    await tick();
    expect((await product("hide")).auditHoldAt).not.toBeNull();
    expect((await item("hide")).humanDecision).toBeNull();
  });

  it("화면 판정 출처의 의견이 있으면(파일로 올린 qwen-vision-m1 포함) 다시 그리지도 묻지도 않는다 — 글만 본 의견은 덮지 않는다", async () => {
    await judged([{ repo: "r/uploaded" }, { repo: "r/fresh" }]);
    await vote("uploaded", "qwen3.8-flash-next+vision", "approve", "qwen-vision-m1", "2026-10-21.v2+shot1");
    await vote("fresh", "qwen3.8-flash-next", "reject", "qwen-v2-auto", QWEN_V2_PROMPT_VERSION);
    model.answers.set("r/fresh", { decision: "needs_review", confidence: 0.5 });
    await tick();
    expect(renderer.calls).toEqual(["https://fresh.test"]);
    expect((await opinions()).map((row) => [row.source, row.model, row.decision]).sort()).toEqual([
      ["qwen-v2-auto", "qwen3.8-flash-next", "reject"], ["qwen-vision-auto", "qwen3.8-flash-next+vision", "needs_review"],
      ["qwen-vision-m1", "qwen3.8-flash-next+vision", "approve"]].sort());
    renderer.calls.length = 0;
    await tick();
    expect(renderer.calls).toEqual([]);
  });

  it("페이지 탓 실패(막힘·4xx)는 그 항목만 두 번까지, 수집 원본이 없으면 바로 — 그 뒤로는 사람이 본다", async () => {
    await judged([{ repo: "f/blocked" }, { repo: "f/ok" }, { repo: "f/nosource" }]);
    // 원본이 없는 항목도 화면 판별 대기에 든다(글을 확인할 수 없다) — 입력을 만들 수 없어 그리지 않고 바로 그만 본다
    await db.delete(crawlCandidates).where(eq(crawlCandidates.publishedSlug, "nosource"));
    renderer.pages.set("https://blocked.test", { ok: false, error: "blocked", status: 403, renderMs: 50, egress: null });
    await tick();
    await tick();
    expect(renderer.calls.filter((url) => url === "https://blocked.test")).toHaveLength(2);
    const observation = await readScreenObservation("qwen3.8-flash-next+vision");
    expect(observation.failures[`a:${(await item("blocked")).id}`]).toMatchObject({ code: "page_blocked", count: 2 });
    renderer.calls.length = 0;
    await tick();
    expect(renderer.calls).toEqual([]);
    expect((await opinions()).map((row) => row.decision)).toEqual(["approve"]);
    expect(observation.failures[`a:${(await item("nosource")).id}`]).toMatchObject({ code: "no_source", count: 2 });
    expect(renderer.calls).not.toContain("https://nosource.test");
    expect(await screenReviewStatus(await getSettings())).toMatchObject({ givenUp: 2, remaining: 0 });
    // 하루가 지나면 그만 본 것을 한 번 더 본다 — 다시 실패하면 또 하루 쉰다
    const key = `a:${(await item("blocked")).id}`;
    const value = { ...observation, failures: { ...observation.failures, [key]: { ...observation.failures[key], at: new Date(Date.now() - 25 * 3600_000).toISOString() } } };
    await db.update(operationsObservations).set({ value }).where(eq(operationsObservations.key, SCREEN_REVIEW_OBSERVATION));
    renderer.calls.length = 0;
    await tick();
    expect(renderer.calls).toEqual(["https://blocked.test"]);
    expect((await readScreenObservation("qwen3.8-flash-next+vision")).failures[key]).toMatchObject({ code: "page_blocked", count: 3 });
    renderer.calls.length = 0;
    await tick();
    expect(renderer.calls).toEqual([]);
  });

  it("글꼴이 모자라거나 샌드박스가 꺼진 화면 서버로는 그리지 않는다(critical)", async () => {
    await judged([{ repo: "g/one" }]);
    renderer.fonts = { ko: false, ja: true, zh: true };
    expect(await tick()).toMatchObject({ status: "completed", degraded: "screen_render_fonts_missing" });
    expect(renderer.calls).toEqual([]);
    expect(model.calls).toEqual([]);
  });

  it("화면 서버 탈(닿지 않음)·모델 서버 탈(404)은 그 줄만 물러난다 — 글 단계의 물러나기는 건드리지 않는다", async () => {
    await judged([{ repo: "b/one" }, { repo: "b/two" }]);
    vi.stubEnv("SCREEN_RENDER_URL", "http://127.0.0.1:1");
    expect(await tick()).toMatchObject({ status: "completed", degraded: "screen_render_unreachable" });
    expect(screenBackoff.render.retryAt).toBeGreaterThan(Date.now());
    resetScreenBackoff();
    vi.stubEnv("SCREEN_RENDER_URL", renderUrl);
    model.answers.set("b/one", 404);
    model.answers.set("b/two", 404);
    expect(await tick()).toMatchObject({ status: "completed", degraded: "screen_model_outage" });
    expect(model.calls).toHaveLength(1);
    expect(screenBackoff.model).toMatchObject({ failures: 1, code: "qwen_http_404" });
    expect(qwenEndpointBackoff.retryAt).toBe(0);
    // 물러나는 동안은 그리지도 않는다
    renderer.calls.length = 0;
    await tick();
    expect(renderer.calls).toEqual([]);
  });

  it("같은 m1 을 글 단계가 탈로 물러나는 중이면 그리지 않는다", async () => {
    await judged([{ repo: "q/one" }]);
    qwenEndpointBackoff.retryAt = Date.now() + 60_000;
    await tick();
    expect(renderer.calls).toEqual([]);
  });

  it("꺼져 있으면 아무것도 하지 않고, 묻는 사이 꺼졌으면 적지 않는다", async () => {
    await judged([{ repo: "w/one" }, { repo: "w/two" }]);
    expect(await turn({ enabled: false, perTick: 4 })).toMatchObject({ ok: true });
    await tick();
    expect(renderer.calls).toEqual([]);
    expect(await turn({ enabled: true, perTick: 4 })).toMatchObject({ ok: true });
    model.before = async () => { await turn({ enabled: false, perTick: 4 }); model.before = null; };
    await tick();
    expect(model.calls).toHaveLength(1);
    expect(await opinions()).toEqual([]);
  });

  it("설정이 없으면 일하지 않고 까닭을 남긴다", async () => {
    await judged([{ repo: "c/one" }]);
    vi.stubEnv("SCREEN_RENDER_TOKEN", "short");
    expect(await tick()).toMatchObject({ status: "completed", degraded: "screen_review_not_configured" });
    expect(renderer.calls).toEqual([]);
  });
});
