import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, operationsObservations, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems, productAuditSecondOpinions, productEvidenceAudit, secondReviews } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, saveSettings, setAuditHold, setQwenAutoStep } from "@/lib/crawl/settings";
import { REVIEW_SYSTEM_PROMPT } from "@/lib/crawl/agent-review";
import { classifyAuditReason } from "@/lib/crawl/audit-reason-category";
import { auditReasonCategorySql, catalogLikeReasonSql } from "@/lib/crawl/audit-second-opinions";
import { QWEN_AUTO_OBSERVATION, qwenSecondOpinionStatus, readQwenAutoObservation } from "@/lib/crawl/audit-second-opinion-auto";
import { auditRemovalGroups, listAuditFindings, removeAuditedProducts, startProductAudit, switchAuditReviewer } from "@/lib/crawl/product-audit";
import { qwenEndpointBackoff, resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { QWEN_V2_ADDENDUM, QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { catalogLikeAuditReason } from "@/lib/crawl/second-opinion-rules";
import { publishedInputHash, publishedSecondReviews, secondReviewSummary } from "@/lib/crawl/second-review";
import { auditPublishedProducts, qwenAuditConcurrency } from "@/lib/crawl/jobs/product-audit";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
/** 입력을 만들다 던지는 항목(입력 상한 초과 등) — 그 slug 의 입력만 실패하게 한다. 나머지는 실제 loadAuditInput */
const inputFails = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/crawl/product-audit", async (original) => {
  const actual = await original<typeof import("@/lib/crawl/product-audit")>();
  return { ...actual, loadAuditInput: async (slug: string, settings: Parameters<typeof actual.loadAuditInput>[1]) => {
    if (inputFails.has(slug)) throw new Error("review_input_too_large");
    return actual.loadAuditInput(slug, settings);
  } };
});

/**
 * Qwen-v2 자동 단계(audit-second-opinion-auto.ts) — 감사 잡 틱 안에서 gpu3090 Qwen 을 바로 불러(가짜 서버) 감사 거절에 두 번째 의견을 적고,
 * 공개분 2차의 사람 확인 행을 한 번 더 본다. 쓰기·보류·풀기·lease 는 실제 DB 로 돈다. 감사 묻기는 닫힌 감사라 돌지 않는다.
 */
type Answer = { decision: "approve" | "reject" | "needs_review"; confidence?: number; reason?: string } | "invalid" | number;
const server = vi.hoisted(() => ({
  answers: new Map<string, unknown>(), status: 200, down: false, before: null as (() => Promise<void>) | null,
  calls: [] as { url: string; repo: string; body: { messages: { role: string; content: string }[]; model: string }; headers: unknown }[],
}));
async function fakeQwen(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body));
  const user: string = body.messages[1].content;
  const repo: string = JSON.parse(user.slice(user.indexOf("\n") + 1, user.lastIndexOf("\n"))).product.repo;
  server.calls.push({ url: String(url), repo, body, headers: init?.headers });
  // 답하기 전에 할 일(스위치 끄기 등) — 답을 받는 사이에 바뀐 것을 흉내 낸다
  if (server.before) await server.before();
  if (server.down) throw new TypeError("fetch failed");
  if (server.status !== 200) return new Response("{}", { status: server.status });
  const answer = (server.answers.get(repo) ?? { decision: "approve" }) as Answer;
  if (typeof answer === "number") return new Response("{}", { status: answer });
  const content = answer === "invalid" ? "판단할 수 없습니다"
    : JSON.stringify({ decision: answer.decision, reason: answer.reason ?? `Qwen says ${answer.decision}.`, evidenceIds: ["product"],
      confidence: answer.confidence ?? 0.95 });
  return new Response(JSON.stringify({ model: "qwen3.8-flash-next", choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 5_000, completion_tokens: 120 } }), { status: 200 });
}
const askedRepos = () => server.calls.map((call) => call.repo);

const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const CONTENT = 'pageText: "Getting started" — a documentation site for a library, not a usable product';
/** 글·문서 갈래(허용 목록 밖)이지만 카탈로그 같은 사유 — Qwen 거절은 세지 않는다 */
const CATALOG = "The page is an awesome list of documentation links for many tools, not one product";
/** 남의 플랫폼·목록 갈래(허용 목록 안) — 카탈로그 예외와 상관없이 갈래로 보류된다 */
const PLATFORM = "The page is a curated directory listing third-party tools";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.unstubAllEnvs();
  for (const table of [secondReviews, productAuditAttempts, productAuditItems, productAuditCampaigns, crawlReviewAttempts, crawlCandidates,
    crawlDocuments, crawlFrontier, crawlSettings, jobs]) await db.delete(table);
  await db.delete(operationsObservations).where(eq(operationsObservations.key, QWEN_AUTO_OBSERVATION));
  await resetTables();
  server.answers.clear();
  server.calls.length = 0;
  server.status = 200;
  server.down = false;
  server.before = null;
  inputFails.clear();
  resetQwenAuditBackoff();
  vi.stubGlobal("fetch", vi.fn(fakeQwen));
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, reviewConcurrency: 1 }, "test");
  // 두 단계는 기본 꺼짐이다 — 이 파일은 켜고 시작한다
  expect(await turn("auditSecondOpinion", { enabled: true, perTick: 10 })).toMatchObject({ ok: true });
  expect(await turn("publishedFilter", { enabled: true, perTick: 10 })).toMatchObject({ ok: true });
});
afterEach(() => vi.unstubAllGlobals());

let sequence = 0;
async function listed(repo: string, over: Partial<typeof products.$inferInsert> = {}) {
  const slug = repo.split("/")[1];
  const url = `https://${slug}.test`;
  const [product] = await db.insert(products).values({
    slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded", source: "crawler",
    verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64), ...over,
  }).returning();
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: slug, textSample: "쓸 수 있는 앱" } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
    publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() }).returning();
  return { product, candidate };
}
/** 감사를 열고 답을 직접 적은 뒤 닫는다 — 틱은 쓸기와 Qwen-v2 단계만 돈다 */
async function judged(rows: { repo: string; confidence?: number; reason?: string; over?: Partial<typeof products.$inferInsert> }[]) {
  for (const row of rows) await listed(row.repo, row.over);
  await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false });
  for (const row of rows) {
    await db.update(productAuditItems).set({ aiDecision: "reject", aiConfidence: row.confidence ?? 0.97, aiReason: row.reason ?? COMPANY,
      reviewedAt: sql`now()`, attempts: 1 }).where(eq(productAuditItems.slug, row.repo.split("/")[1]));
  }
  await db.update(productAuditCampaigns).set({ status: "done" });
}
const tick = () => runJob("product-audit", auditPublishedProducts, { budgetMs: jobRunOptions("product-audit", { requestedOnly: true }).budgetMs });
const item = async (slug: string) => (await db.select().from(productAuditItems).where(eq(productAuditItems.slug, slug))
  .orderBy(asc(productAuditItems.id))).at(-1)!;
const heldSlugs = async () => (await db.select({ slug: products.slug }).from(products)
  .where(sql`${products.auditHoldAt} is not null`).orderBy(asc(products.id))).map((row) => row.slug);
const opinions = () => db.select().from(productAuditSecondOpinions).orderBy(asc(productAuditSecondOpinions.itemId));
const vote = async (slug: string, model: string, decision: "approve" | "reject" | "needs_review", promptVersion: string | null = null) => {
  const row = await item(slug);
  await db.insert(productAuditSecondOpinions).values({ itemId: row.id, productId: row.productId, model, decision, confidence: 0.9,
    reason: "earlier", source: promptVersion ? "qwen-v2-auto" : "grok-cli-batch", promptVersion });
};
/** Qwen-v2 자동 단계 하나를 바꾼다 — 화면·운영 스크립트와 같은 setter(compare-and-set·켤 때 사유) */
const turn = async (step: "auditSecondOpinion" | "publishedFilter", next: { enabled: boolean; perTick: number }, reason = "테스트") => {
  const expected = (await getSettings()).qwenAuto[step];
  return setQwenAutoStep({ step, next, expected, actor: "jr", reason });
};
const readStatus = async () => qwenSecondOpinionStatus(await getSettings());

describe("감사 두 번째 의견", () => {
  it("보류 후보에 Qwen-v2 의견을 받아 옮겨 적기와 같은 길로 적는다 — 승인은 보류를 풀고, 거절은 다음 쓸기가 건다", async () => {
    await judged([{ repo: "a/company" }, { repo: "a/content", reason: CONTENT }, { repo: "a/low", confidence: 0.94 },
      { repo: "a/owned", over: { claimedAt: new Date() } }]);
    const floor = await auditFloor();
    server.answers.set("a/company", { decision: "approve", confidence: 1 });
    server.answers.set("a/content", { decision: "reject", reason: "Only documentation." });

    expect(await tick()).toMatchObject({ status: "completed" });
    // 문턱 아래·주인 있는 것은 보류 후보가 아니라 묻지 않는다. 지금 보류된 것(쓸기가 이 틱에 건 회사 소개)이 먼저
    expect(askedRepos()).toEqual(["a/company", "a/content"]);
    const call = server.calls[0];
    expect(call.url).toBe("http://100.77.43.63:8090/v1/chat/completions");
    expect(call.headers).toEqual({ "Content-Type": "application/json" });
    expect(call.body.model).toBe("qwen3.8-flash-next");
    expect(call.body.messages[0].content).toBe(REVIEW_SYSTEM_PROMPT + QWEN_V2_ADDENDUM);

    const rows = await opinions();
    expect(rows.map((row) => [row.itemId, row.model, row.decision, row.confidence, row.source, row.promptVersion])).toEqual([
      [(await item("company")).id, "qwen3.8-flash-next", "approve", 1, "qwen-v2-auto", "2026-10-21.v2"],
      [(await item("content")).id, "qwen3.8-flash-next", "reject", 0.95, "qwen-v2-auto", "2026-10-21.v2"],
    ]);
    expect(rows[1].reason).toBe("Only documentation.");
    expect(rows.every((row) => /^[0-9a-f]{64}$/.test(row.inputHash ?? ""))).toBe(true);
    // 쓸기가 건 회사 소개 보류를 승인이 옮겨 적기와 같은 길로 풀었다
    expect(await heldSlugs()).toEqual([]);
    const releases = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"));
    expect(releases.map((row) => [row.slug, row.actor, row.reason])).toEqual([["company", "import:qwen-v2-auto", "second_approve"]]);
    // 사람 없이 푼 보류는 운영 감사(작업 로그)에도 남긴다 — 누가 모델(qwen-v2-auto)
    expect(await auditRowsAfter(floor, "audit-hold-auto-release")).toMatchObject([{ actor: "qwen-v2-auto", actorKind: "model", ok: true,
      target: "company", detail: { itemId: (await item("company")).id, model: "qwen3.8-flash-next", confidence: 1 } }]);

    // 다음 틱 — 묻지 않고(같은 항목·모델·판), 쓸기가 Qwen 거절(글·문서 갈래)을 두 번째 의견으로 건다
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(server.calls).toHaveLength(2);
    expect(await heldSlugs()).toEqual(["content"]);
    const [hold] = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold"))
      .orderBy(sql`${productEvidenceAudit.id} desc`).limit(1);
    expect(hold.metadata).toMatchObject({ category: "content", byCategory: false, bySecondOpinion: true });

    const status = await readStatus();
    expect(status.audit).toEqual({ enabled: true, perTick: 10, lastHour: 2, lastDay: 2, remaining: 0 });
    expect(status).toMatchObject({ model: "qwen3.8-flash-next", url: "http://100.77.43.63:8090/v1", promptVersion: "2026-10-21.v2", lastError: null });
  });

  it("같은 모델 규칙 — 감사 답을 같은 Qwen 이 냈으면 묻지 않는다. grok 의견이 있어도 따로 묻고, 옛 판의 Qwen 의견은 다시 묻는다", async () => {
    await judged([{ repo: "s/same", reason: CONTENT }, { repo: "s/grokked", reason: CONTENT }, { repo: "s/stale", reason: CONTENT }]);
    const same = await item("same");
    await db.insert(productAuditAttempts).values({ itemId: same.id, startedAt: new Date(), provider: "abcllm", model: "[gpu3090] qwen3.8-flash-next",
      inputHash: "h".repeat(64), source: {} as never, outcome: { decision: "reject", reason: CONTENT, evidenceIds: ["product"], confidence: 0.97 } });
    await vote("grokked", "grok-4.7", "reject");
    await vote("stale", "qwen3.8-flash-next", "approve", "2026-10-01.v1");
    server.answers.set("s/stale", { decision: "reject" });

    await tick();
    expect(askedRepos().sort()).toEqual(["s/grokked", "s/stale"]);
    const rows = await opinions();
    const grokked = (await item("grokked")).id, stale = (await item("stale")).id;
    expect(rows.filter((row) => row.itemId === same.id)).toEqual([]);
    expect(rows.filter((row) => row.itemId === grokked).map((row) => row.model).sort()).toEqual(["grok-4.7", "qwen3.8-flash-next"]);
    expect(rows.filter((row) => row.itemId === stale).map((row) => [row.decision, row.promptVersion])).toEqual([["reject", "2026-10-21.v2"]]);
  });

  it("카탈로그 예외 — Qwen 거절은 카탈로그·디렉터리 같은 항목에서 보류의 까닭이 되지 않고 '갈림'·'Qwen 거절(카탈로그 제외)'에 든다. grok 거절은 건다", async () => {
    await judged([{ repo: "c/catalog", reason: CATALOG }, { repo: "c/grok-catalog", reason: CATALOG }, { repo: "c/platform", reason: PLATFORM },
      { repo: "c/plain", reason: CONTENT }]);
    expect([classifyAuditReason(CATALOG), catalogLikeAuditReason(CATALOG), classifyAuditReason(PLATFORM)]).toEqual(["content", true, "platform"]);
    for (const slug of ["catalog", "platform", "plain"]) server.answers.set(`c/${slug}`, { decision: "reject" });
    server.answers.set("c/grok-catalog", { decision: "needs_review" });
    await vote("grok-catalog", "grok-4.7", "reject");
    await tick();
    await tick();
    // 남의 플랫폼 갈래는 Qwen 거절과 상관없이 갈래(a)로 걸린다. 글·문서 갈래의 카탈로그는 Qwen 거절로 걸리지 않고, grok 거절로는 걸린다
    expect(await heldSlugs()).toEqual(["grok-catalog", "platform", "plain"]);

    const campaignId = (await item("catalog")).campaignId;
    const view = async (second: "agreed" | "split" | "disagree" | "qwen_catalog") =>
      (await listAuditFindings(campaignId, "reject", { limit: 50, offset: 0, second })).map((row) => row.slug).sort();
    expect(await view("agreed")).toEqual(["grok-catalog", "plain"]);
    expect(await view("split")).toEqual(["catalog", "platform"]);
    expect(await view("qwen_catalog")).toEqual(["catalog", "platform"]);
    expect(await view("disagree")).toEqual(["grok-catalog"]);
  });

  it("사유 갈래·카탈로그 판정은 SQL 과 JS 가 같다(감사 화면의 거르기와 보류의 둘째 문)", async () => {
    const corpus = [COMPANY, CONTENT, CATALOG, PLATFORM, null, "", "LOGIN page of a Directory service", "Only shows a sign‑in form (curated list)",
      "Coming soon – waitlist for an AI catalog", "The npm package registry page for a CLI", "A Docker Hub listing", "List of awesome prompts",
      "An e-commerce storefront selling clothing", "A blog post about tools", "A consulting agency’s marketing page", "Telegram channel invite",
      "A GitHub repository page", "pageText is empty", "A product catalog for furniture", "Lists many third-party services", "A usable tool",
      // 아스키가 아닌 글자 옆의 낱말 경계 — SQL 은 collate "C" 로 JS 정규식(\b 는 아스키 낱말 글자만 본다)과 같게 가른다
      "café menu site", "로그인login화면", "αlogin", "Ωdirectory of tools", "ÉCOMMERCE store", "sign-in화면 only", "ｌogin page", "카탈로그catalog"];
    for (const reason of corpus) {
      const [row] = await db.execute<{ category: string; catalog: boolean }>(sql`select ${auditReasonCategorySql(sql`${reason}::text`)} as category,
        ${catalogLikeReasonSql(sql`${reason}::text`)} as catalog`);
      expect([reason, row.category, row.catalog]).toEqual([reason, classifyAuditReason(reason), catalogLikeAuditReason(reason)]);
    }
  });

  it("부르는 곳이 탈 나면 이 틱의 나머지를 멈추고 아무것도 적지 않는다 — 마지막 오류를 관측에 남기고 다음 틱에 다시 부른다", async () => {
    await judged([{ repo: "e/one", reason: CONTENT }, { repo: "e/two", reason: CONTENT }, { repo: "e/three", reason: CONTENT }]);
    server.status = 503;
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(server.calls).toHaveLength(1);
    expect(await opinions()).toEqual([]);
    expect((await readQwenAutoObservation("qwen3.8-flash-next")).lastError).toMatchObject({ code: "qwen_http_503", target: "audit" });
    // gpu3090 을 부르는 모두가 함께 물러난다(qwen-endpoint-backoff.ts — 첫 탈은 1분) — 그동안은 부르지 않는다
    expect(qwenEndpointBackoff).toMatchObject({ failures: 1, lastError: "qwen_http_503" });
    server.status = 200;
    await tick();
    expect(server.calls).toHaveLength(1);

    // 물러남이 끝나면 다시 부른다
    resetQwenAuditBackoff();
    server.down = true;
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(server.calls).toHaveLength(2);
    const down = await readQwenAutoObservation("qwen3.8-flash-next");
    expect(down.lastError).toMatchObject({ code: "qwen_unreachable" });
    // 부르는 곳의 탈은 항목 탓이 아니다 — 그 항목을 그만 묻지 않는다
    expect(down.failures).toEqual({});

    server.down = false;
    resetQwenAuditBackoff();
    await tick();
    expect(server.calls).toHaveLength(5);
    // 답을 받으면 물러나기도 처음으로
    expect(qwenEndpointBackoff.failures).toBe(0);
    expect(await opinions()).toHaveLength(3);
    const status = await readStatus();
    expect(status.lastError).toMatchObject({ code: "qwen_unreachable" });
    expect(status.lastSuccessAt! > status.lastError!.at).toBe(true);
  });

  it("항목만의 실패(형식 오류·400)는 다음 항목으로 넘어가고 두 번까지만 묻는다", async () => {
    await judged([{ repo: "i/bad", reason: CONTENT }, { repo: "i/rejected-request", reason: CONTENT }, { repo: "i/good", reason: CONTENT }]);
    server.answers.set("i/bad", "invalid");
    server.answers.set("i/rejected-request", 400);
    await tick();
    expect(askedRepos()).toEqual(["i/bad", "i/rejected-request", "i/good"]);
    await tick();
    await tick();
    expect(askedRepos()).toEqual(["i/bad", "i/rejected-request", "i/good", "i/bad", "i/rejected-request"]);
    expect((await opinions()).map((row) => row.itemId)).toEqual([(await item("good")).id]);
    const observation = await readQwenAutoObservation("qwen3.8-flash-next");
    expect(Object.values(observation.failures).map((failure) => [failure.code, failure.count]).sort())
      .toEqual([["qwen_http_400", 2], ["qwen_invalid_json", 2]]);
    expect((await readStatus())).toMatchObject({ givenUp: 2, audit: { remaining: 0 } });
  });

  it("스위치 — 끄면 묻지 않고, 수집 스위치(비상 정지)도 멈춘다. 틱당 수를 지킨다. 켜는 바꿈은 까닭을 받는다", async () => {
    await judged([{ repo: "w/one", reason: CONTENT }, { repo: "w/two", reason: CONTENT }, { repo: "w/three", reason: CONTENT }]);
    expect(await turn("auditSecondOpinion", { enabled: false, perTick: 2 })).toMatchObject({ ok: true });
    await tick();
    expect(server.calls).toHaveLength(0);
    // 켜는 것은 넓히는 바꿈이다 — 까닭 없이는 쓰지 않는다
    expect(await turn("auditSecondOpinion", { enabled: true, perTick: 2 }, "")).toMatchObject({ ok: false });
    expect(await turn("auditSecondOpinion", { enabled: true, perTick: 2 })).toMatchObject({ ok: true });
    await saveSettings({ enabled: false }, "test");
    await tick();
    expect(server.calls).toHaveLength(0);
    await saveSettings({ enabled: true }, "test");
    await tick();
    expect(server.calls).toHaveLength(2);
    await tick();
    expect(server.calls).toHaveLength(3);
  });

  it("답을 받는 사이 그 단계를 끄면 적지 않는다 — 쓰는 트랜잭션이 스위치를 다시 읽고, 이 틱의 나머지는 부르지 않는다", async () => {
    await judged([{ repo: "o/one", reason: CONTENT }, { repo: "o/two", reason: CONTENT }]);
    server.answers.set("o/one", { decision: "approve", confidence: 1 });
    server.before = async () => {
      server.before = null;
      expect(await turn("auditSecondOpinion", { enabled: false, perTick: 10 })).toMatchObject({ ok: true });
    };
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(server.calls).toHaveLength(1);
    expect(await opinions()).toEqual([]);
    expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"))).toEqual([]);
  });

  it("확신 문턱 — 0.90 아래의 승인은 적되 보류를 풀지 않는다", async () => {
    await judged([{ repo: "c/company" }]);
    server.answers.set("c/company", { decision: "approve", confidence: 0.8 });
    const floor = await auditFloor();
    await tick();
    expect(askedRepos()).toEqual(["c/company"]);
    expect((await opinions()).map((row) => [row.decision, row.confidence, row.source])).toEqual([["approve", 0.8, "qwen-v2-auto"]]);
    expect(await heldSlugs()).toEqual(["company"]);
    expect(await auditRowsAfter(floor, "audit-hold-auto-release")).toEqual([]);
  });

  it("단계가 꺼져 있으면 Qwen-v2 자동 의견의 거절은 보류의 까닭이 아니다 — grok 거절은 그대로 센다", async () => {
    await judged([{ repo: "n/auto", reason: CONTENT }, { repo: "n/grok", reason: CONTENT }]);
    await vote("auto", "qwen3.8-flash-next", "reject", QWEN_V2_PROMPT_VERSION);
    await vote("grok", "grok-4.7", "reject");
    expect(await turn("auditSecondOpinion", { enabled: false, perTick: 10 })).toMatchObject({ ok: true });
    await tick();
    expect(await heldSlugs()).toEqual(["grok"]);
    // 켜면 다음 쓸기가 건다 — 같은 판의 의견이 있어 다시 묻지 않는다
    expect(await turn("auditSecondOpinion", { enabled: true, perTick: 10 })).toMatchObject({ ok: true });
    await tick();
    expect(await heldSlugs()).toEqual(["auto", "grok"]);
    // grok 의견만 있는 항목은 Qwen 에게 따로 묻는다(기본 답은 승인이지만 grok 거절이 남아 보류는 그대로)
    expect(askedRepos()).toEqual(["n/grok"]);
  });

  it("입력을 만들다 실패한 항목은 그 항목의 실패로 적고 다음 항목을 묻는다", async () => {
    await judged([{ repo: "x/bad", reason: CONTENT }, { repo: "x/good", reason: CONTENT }]);
    inputFails.add("bad");
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(askedRepos()).toEqual(["x/good"]);
    const observation = await readQwenAutoObservation("qwen3.8-flash-next");
    expect(observation.failures[`a:${(await item("bad")).id}`]).toMatchObject({ code: "review_input_too_large", count: 1 });
    expect(observation.lastError).toMatchObject({ code: "review_input_too_large", target: "audit" });
    expect((await opinions()).map((row) => row.itemId)).toEqual([(await item("good")).id]);
  });

  it("깨진 단계·빠진 칸은 그 단계만 끈다(묻지 않는다) — 감사 보류와 다른 단계는 그대로", async () => {
    await judged([{ repo: "f/one", reason: CONTENT }]);
    const corrupt = (expression: string) => db.execute(sql`update crawl_settings set values = ${sql.raw(expression)} where id = 1`);
    await corrupt(`jsonb_set(values, '{qwenAuto,auditSecondOpinion}', '"on"')`);
    expect((await getSettings()).qwenAuto).toMatchObject({ auditSecondOpinion: { enabled: false }, publishedFilter: { enabled: true } });
    expect((await getSettings()).auditHold.enabled).toBe(true);
    await tick();
    expect(server.calls).toHaveLength(0);
    await corrupt(`jsonb_set(values, '{qwenAuto,auditSecondOpinion}', '{"enabled": true, "perTick": 0}')`);
    expect((await getSettings()).qwenAuto.auditSecondOpinion.enabled).toBe(false);
    // 빠진 칸을 기본값으로 채우지 않는다 — 켬만 적힌 단계도 꺼짐이다
    await corrupt(`jsonb_set(values, '{qwenAuto,auditSecondOpinion}', '{"enabled": true}')`);
    expect((await getSettings()).qwenAuto.auditSecondOpinion.enabled).toBe(false);
    // 칸이 통째로 없으면(옛 코드가 저장한 행) 모두 꺼짐
    await corrupt(`values - 'qwenAuto'`);
    expect((await getSettings()).qwenAuto).toMatchObject({ auditSecondOpinion: { enabled: false }, publishedFilter: { enabled: false } });
    await tick();
    expect(server.calls).toHaveLength(0);
  });
});

describe("감사가 Qwen 직접 심사로 바뀐 뒤(0112)", () => {
  /** 감사를 열고 일부만 답을 적는다(0112 전 gpt-oss 의 답 — 누가 답했는지 칸이 비어 있다). 나머지는 답이 없다 */
  async function partly(answered: string[], pending: string[]) {
    for (const repo of [...answered, ...pending]) await listed(repo);
    const started = await startProductAudit({ startedBy: "jr", reason: "감사 #4", reauditKept: false });
    if (!started.ok) throw new Error(started.error);
    for (const repo of answered) {
      await db.update(productAuditItems).set({ aiDecision: "reject", aiConfidence: 0.97, aiReason: CONTENT, reviewedAt: sql`now()`, attempts: 1 })
        .where(eq(productAuditItems.slug, repo.split("/")[1]));
    }
    expect(await switchAuditReviewer({ campaignId: started.campaignId, expected: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
      reason: "남은 것을 Qwen 으로", by: "jr" })).toMatchObject({ ok: true });
    return started.campaignId;
  }

  it("gpu3090 동시 호출은 감사 자리 + 두 번째 의견 1 을 넘지 않고, Qwen 이 감사한 항목에는 두 번째 의견을 묻지 않는다", async () => {
    const answered = ["g/old-1", "g/old-2", "g/old-3"], pending = ["g/new-1", "g/new-2", "g/new-3", "g/new-4", "g/new-5", "g/new-6"];
    await partly(answered, pending);
    for (const repo of pending) server.answers.set(repo, { decision: "reject", reason: CONTENT, confidence: 0.97 });
    const flight = { now: 0, max: 0, second: 0, secondMax: 0 };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const repo = JSON.parse(String(JSON.parse(String(init?.body)).messages[1].content).split("\n")[1]).product.repo as string;
      const second = answered.includes(repo);
      flight.now += 1; flight.max = Math.max(flight.max, flight.now);
      if (second) { flight.second += 1; flight.secondMax = Math.max(flight.secondMax, flight.second); }
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return await fakeQwen(url, init);
      } finally { flight.now -= 1; if (second) flight.second -= 1; }
    }));

    expect(await tick()).toMatchObject({ status: "completed" });
    // 감사(남은 6건)와 두 번째 의견(0112 전 gpt-oss 의 거절 3건 — 지금 감사 모델이 Qwen 이어도 그 답은 gpt-oss 가 냈다)을 함께 물었다
    expect(askedRepos().sort()).toEqual([...answered, ...pending].sort());
    expect(flight.max).toBeLessThanOrEqual(qwenAuditConcurrency() + 1);
    expect(flight.max).toBeGreaterThan(1);
    expect(flight.secondMax).toBe(1);
    const newItem = await item("new-1");
    expect([newItem.aiProvider, newItem.aiModel, newItem.aiDecision]).toEqual(["qwen-direct", "qwen3.8-flash-next", "reject"]);
    expect((await opinions()).map((row) => row.itemId).sort((a, b) => a - b))
      .toEqual(await Promise.all(["old-1", "old-2", "old-3"].map(async (slug) => (await item(slug)).id)));

    // 감사가 끝나 Qwen 이 답한 거절도 보류 후보가 됐지만 같은 모델이라 묻지 않는다
    server.calls.length = 0;
    await tick();
    expect(askedRepos()).toEqual([]);
    expect((await readStatus()).audit.remaining).toBe(0);
  });

  /** 답을 Qwen(남은 감사 모델 바꾸기 뒤의 감사 모델)이 낸 것으로 바꾼다 */
  const answeredByQwen = (slugs: string[]) => Promise.all(slugs.map((slug) => db.update(productAuditItems)
    .set({ aiProvider: "qwen-direct", aiModel: "qwen3.8-flash-next" }).where(eq(productAuditItems.slug, slug))));

  it("Qwen 이 감사한 카탈로그 같은 거절은 '갈림'·'Qwen 거절(카탈로그 예외)'에 들고 묶어 내리기에서 빠진다 — gpt-oss 의 같은 거절은 그대로", async () => {
    await judged([{ repo: "k/catalog", reason: CATALOG }, { repo: "k/platform", reason: PLATFORM }, { repo: "k/company", reason: COMPANY },
      { repo: "k/gpt-catalog", reason: CATALOG }]);
    await answeredByQwen(["catalog", "platform", "company"]);
    const campaignId = (await item("catalog")).campaignId;
    const view = async (second: "agreed" | "split" | "qwen_catalog") =>
      (await listAuditFindings(campaignId, "reject", { limit: 50, offset: 0, second })).map((row) => row.slug).sort();
    expect(await view("split")).toEqual(["catalog", "platform"]);
    expect(await view("qwen_catalog")).toEqual(["catalog", "platform"]);
    expect(await view("agreed")).toEqual([]);
    // 묶어 내리기는 이름을 훑는 창에 누가 답했는지를 함께 싣는다
    const groups = await auditRemovalGroups(campaignId, "reject");
    expect(groups.flatMap((group) => group.items.map((entry) => [entry.slug, entry.answeredBy])).sort())
      .toEqual([["company", "qwen-v2"], ["gpt-catalog", "gpt-oss-120b"]]);
    // 오래된 화면이 실어 보내도 잠근 뒤 다시 보는 조건이 막는다
    const removed = await removeAuditedProducts({ items: [{ itemId: (await item("catalog")).id, slug: "catalog" }], by: "jr" });
    expect(removed.removed).toEqual([]);
    expect(removed.failed.map((entry) => entry.slug)).toEqual(["catalog"]);
  });

  it("Qwen 이 감사한 거절은 확신이 0.90 이상일 때만 사람 없이 보류한다 — 확신 문턱을 낮춰도", async () => {
    const hold = (await getSettings()).auditHold;
    expect(await setAuditHold({ next: { ...hold, minConfidence: 0.8 }, expected: hold, actor: "jr", reason: "테스트" })).toMatchObject({ ok: true });
    await judged([{ repo: "l/sure", reason: COMPANY, confidence: 0.95 }, { repo: "l/unsure", reason: COMPANY, confidence: 0.85 },
      { repo: "l/gpt", reason: COMPANY, confidence: 0.85 }]);
    await answeredByQwen(["sure", "unsure"]);
    // gpt-oss 가 감사한 것은 Qwen 두 번째 의견을 묻는다 — 판단 보류면 보류는 그대로
    server.answers.set("l/gpt", { decision: "needs_review", confidence: 0.5 });
    await tick();
    expect(askedRepos()).toEqual(["l/gpt"]);
    expect(await heldSlugs()).toEqual(["sure", "gpt"]);
  });

  it("같은 틱에서 감사 쪽이 서버 탈을 만나면 두 번째 의견도 곧바로 멈춘다 — 물러나기는 틱이 끝나기 전에 모두에게 걸린다", async () => {
    const answered = ["h/old-1", "h/old-2", "h/old-3", "h/old-4"], pending = ["h/new-1", "h/new-2", "h/new-3", "h/new-4"];
    await partly(answered, pending);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const repo = JSON.parse(String(JSON.parse(String(init?.body)).messages[1].content).split("\n")[1]).product.repo as string;
      if (pending.includes(repo)) {
        server.calls.push({ url, repo, body: JSON.parse(String(init?.body)), headers: init?.headers });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response("{}", { status: 503 });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return fakeQwen(url, init);
    }));
    expect(await tick()).toMatchObject({ status: "failed", error: "product_audit_endpoint_error:qwen_http_503" });
    // 감사의 두 자리가 함께 띄운 것만 — 그 뒤로 감사도 두 번째 의견도 새로 시작하지 않는다
    expect(askedRepos().filter((repo) => pending.includes(repo))).toHaveLength(qwenAuditConcurrency());
    expect(askedRepos().filter((repo) => answered.includes(repo)).length).toBeLessThanOrEqual(1);
    expect(qwenEndpointBackoff).toMatchObject({ failures: 1, lastError: "qwen_http_503" });
  });

  it("감사의 Qwen 직접 심사가 서버 탈로 물러나는 동안에는 두 번째 의견도 부르지 않는다", async () => {
    await judged([{ repo: "b/one", reason: CONTENT }]);
    qwenEndpointBackoff.failures = 1;
    qwenEndpointBackoff.retryAt = Date.now() + 60_000;
    await tick();
    expect(server.calls).toHaveLength(0);
    resetQwenAuditBackoff();
    await tick();
    expect(askedRepos()).toEqual(["b/one"]);
  });
});

describe("공개분 2차 거르기", () => {
  /** 공개분 2차가 사람 확인으로 넘긴 행 — 2차 표(게이트웨이 Qwen 27B)가 거절했다 */
  async function finding(repo: string, over: Partial<typeof secondReviews.$inferInsert> = {}) {
    const { candidate } = await listed(repo);
    const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, publishedSlug: candidate.publishedSlug,
      trigger: "sample", signals: [], firstDecision: "approve", inputHash: publishedInputHash(candidate.publishedSlug!), provider: "abcllm",
      model: "[supa] Qwen3.8-27B-NVFP4", secondDecision: "reject", secondConfidence: 0.9, secondReason: "Only a sign-in form.",
      status: "needs_human", reviewedAt: new Date(), ...over }).returning();
    return row;
  }
  const rowOf = async (id: number) => (await db.select().from(secondReviews).where(eq(secondReviews.id, id)))[0];

  it("Qwen-v2 승인은 사람의 '유지'와 같은 길로 닫고(누가 qwen-v2-auto), 거절·판단 보류는 행을 두고 판단을 적어 앞에 세운다", async () => {
    const kept = await finding("p/kept");
    const rejected = await finding("p/rejected");
    const unsure = await finding("p/unsure");
    const plain = await finding("p/plain", { reviewedAt: new Date(Date.now() + 60_000) });
    // 2차 표가 같은 Qwen 이면 같은 모델의 의견이라 묻지 않는다
    await finding("p/echo", { model: "[gpu3090] qwen3.8-flash-next" });
    server.answers.set("p/kept", { decision: "approve", confidence: 1, reason: "A working app." });
    server.answers.set("p/rejected", { decision: "reject", reason: "Placeholder page." });
    server.answers.set("p/unsure", { decision: "needs_review", confidence: 0.5 });
    await turn("publishedFilter", { enabled: true, perTick: 3 });
    expect((await secondReviewSummary(0.85)).counts.published).toBe(5);
    const floor = await auditFloor();

    await tick();
    expect(askedRepos()).toEqual(["p/kept", "p/rejected", "p/unsure"]);
    expect(server.calls[0].body.messages[0].content).toBe(REVIEW_SYSTEM_PROMPT + QWEN_V2_ADDENDUM);
    // 사람 없이 닫은 유지는 운영 감사(작업 로그)에도 남긴다 — 누가 모델(qwen-v2-auto)
    expect(await auditRowsAfter(floor, "published-second-auto-keep")).toMatchObject([{ actor: "qwen-v2-auto", actorKind: "model", ok: true,
      target: "kept", detail: { secondReviewId: kept.id, confidence: 1 } }]);
    expect(await rowOf(kept.id)).toMatchObject({ status: "resolved", resolution: "kept", resolvedBy: "qwen-v2-auto",
      autoOpinion: { by: "qwen-v2-auto", model: "qwen3.8-flash-next", promptVersion: "2026-10-21.v2", decision: "approve", confidence: 1,
        reason: "A working app.", inputHash: expect.stringMatching(/^[0-9a-f]{64}$/), at: expect.any(String) } });
    // 제품은 그대로 공개다 — 이 길로는 내리지도 숨기지도 않는다
    const [product] = await db.select().from(products).where(eq(products.slug, "kept"));
    expect([product.status, product.auditHoldAt]).toEqual(["seeded", null]);
    expect(await rowOf(rejected.id)).toMatchObject({ status: "needs_human", resolution: null, resolvedBy: null,
      autoOpinion: { decision: "reject", reason: "Placeholder page." } });
    expect(await rowOf(unsure.id)).toMatchObject({ status: "needs_human", autoOpinion: { decision: "needs_review" } });
    expect(await db.select().from(products).where(sql`${products.status} <> 'seeded'`)).toEqual([]);

    // 사람 확인 목록 — Qwen-v2 도 거절한 것, 판단 보류, 나머지(최근 것부터). 승인한 것은 닫혀 빠진다
    expect((await publishedSecondReviews()).map((row) => row.repo)).toEqual(["p/rejected", "p/unsure", "p/plain", "p/echo"]);
    expect((await secondReviewSummary(0.85)).counts.published).toBe(4);

    // 다시 돌아도 같은 판으로 본 행은 묻지 않는다
    await tick();
    expect(askedRepos()).toEqual(["p/kept", "p/rejected", "p/unsure", "p/plain"]);
    expect((await rowOf(plain.id)).status).toBe("resolved");

    const status = await readStatus();
    expect(status.published).toEqual({ enabled: true, perTick: 3, lastHour: 4, lastDay: 4, keptHour: 2, keptDay: 2, remaining: 0 });
  });

  it("끄면 아무것도 하지 않고, 부르는 곳이 탈 나면 행을 건드리지 않는다", async () => {
    const row = await finding("q/row");
    expect(await turn("publishedFilter", { enabled: false, perTick: 10 })).toMatchObject({ ok: true });
    await tick();
    expect(server.calls).toHaveLength(0);
    expect(await rowOf(row.id)).toMatchObject({ status: "needs_human", autoOpinion: null });

    expect(await turn("publishedFilter", { enabled: true, perTick: 10 })).toMatchObject({ ok: true });
    server.status = 502;
    await tick();
    expect(server.calls).toHaveLength(1);
    expect(await rowOf(row.id)).toMatchObject({ status: "needs_human", resolution: null, resolvedBy: null, autoOpinion: null });
    expect((await readQwenAutoObservation("qwen3.8-flash-next")).lastError).toMatchObject({ code: "qwen_http_502", target: "published" });

    server.status = 200;
    resetQwenAuditBackoff();
    await tick();
    expect(await rowOf(row.id)).toMatchObject({ status: "resolved", resolution: "kept", resolvedBy: "qwen-v2-auto" });
  });

  it("답을 받는 사이 그 단계를 끄면 적지 않는다 — 승인이어도 닫지 않는다", async () => {
    const row = await finding("s/pub");
    server.answers.set("s/pub", { decision: "approve", confidence: 1 });
    server.before = async () => {
      server.before = null;
      expect(await turn("publishedFilter", { enabled: false, perTick: 10 })).toMatchObject({ ok: true });
    };
    const floor = await auditFloor();
    await tick();
    expect(server.calls).toHaveLength(1);
    expect(await rowOf(row.id)).toMatchObject({ status: "needs_human", resolution: null, resolvedBy: null, autoOpinion: null });
    expect(await auditRowsAfter(floor, "published-second-auto-keep")).toEqual([]);
  });

  it("확신 문턱 — 0.90 아래의 승인은 닫지 않고 판단만 적는다", async () => {
    const row = await finding("t/pub");
    server.answers.set("t/pub", { decision: "approve", confidence: 0.8 });
    await tick();
    expect(await rowOf(row.id)).toMatchObject({ status: "needs_human", resolution: null, autoOpinion: { decision: "approve", confidence: 0.8 } });
  });

  it("그 사이 사람이 정한 행은 다시 쓰지 않는다", async () => {
    const row = await finding("r/decided");
    server.answers.set("r/decided", { decision: "reject" });
    // 묻는 사이 사람이 내렸다 — 가짜 서버가 답하기 전에 행을 닫는다
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      await db.update(secondReviews).set({ status: "resolved", resolution: "banned", resolvedBy: "jr", resolvedAt: new Date() }).where(eq(secondReviews.id, row.id));
      return fakeQwen(url, init);
    }));
    await tick();
    expect(await rowOf(row.id)).toMatchObject({ status: "resolved", resolution: "banned", resolvedBy: "jr", autoOpinion: null });
  });
});
