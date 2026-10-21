import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems, productEvidenceAudit } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { cancelProductAudit, listAuditFindings, productAuditOverview, startProductAudit, switchAuditReviewer } from "@/lib/crawl/product-audit";
import { auditPublishedProducts, resetQwenAuditBackoff } from "@/lib/crawl/jobs/product-audit";
import { QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

// Qwen-v2 두 번째 의견 단계(감사 잡 틱 안에서 나란히 돈다)는 tests/integration/audit-second-opinion-auto.test.ts 가 본다 — 여기 가짜 서버의 호출 수는 감사 묻기만
vi.mock("@/lib/crawl/audit-second-opinion-auto", () => ({ runQwenSecondOpinions: async () => null }));
vi.mock("server-only", () => ({}));

/**
 * 남은 감사 모델 바꾸기(0112) — 바꾸기(compare-and-set·사유·작업 로그), 바꾼 뒤의 틱(남은 것만 Qwen, 답한 것은 그대로), Qwen 거절의 보류.
 * Qwen 직접 심사(qwen-direct-review.ts)는 진짜로 돌고 HTTP 끝(gpu3090 vLLM)만 가짜(fetch)다. 감사·기록·보류·lease 는 실제 DB 로 돈다.
 */
const QWEN_URL = "http://qwen.test/v1";
const QWEN_MODEL = "qwen3.8-flash-next";
const GPT = { provider: "abcllm", model: "[MLX] gpt-oss-120b" };
const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const DIRECTORY = 'pageText: "Best AI tools" — a curated directory of other tools, not a product';
const LIST_OF = 'pageText: "Studio picks" — a marketing site that is a list of agencies';

type Answer = { decision: "approve" | "reject" | "needs_review"; reason: string; confidence: number };
/** 가짜 vLLM — 요청의 증거에서 저장소 이름을 읽어 그 답을 준다. 없으면 승인 */
function qwen(answers: Record<string, Answer> = {}) {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as { messages: { content: string }[] };
    const evidence = JSON.parse(request.messages[1].content.split("\n")[1]) as { product: { repo: string } };
    const answer = answers[evidence.product.repo] ?? { decision: "approve", reason: 'pageText: "app" — a usable app', confidence: 0.95 };
    return new Response(JSON.stringify({ model: QWEN_MODEL, choices: [{ finish_reason: "stop",
      message: { content: JSON.stringify({ ...answer, evidenceIds: ["product"] }) } }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("AUDIT_SECOND_OPINION_URL", QWEN_URL);
  vi.stubEnv("AUDIT_SECOND_OPINION_MODEL", QWEN_MODEL);
  resetQwenAuditBackoff();
  await db.delete(productAuditAttempts);
  await db.delete(productAuditItems);
  await db.delete(productAuditCampaigns);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  await saveSettings({ enabled: true, firstReview: GPT as never, reviewConcurrency: 2 }, "test");
});
afterEach(() => vi.unstubAllGlobals());

let sequence = 0;
async function listed(repo: string) {
  const slug = repo.split("/")[1];
  const url = `https://${slug}.test`;
  await db.insert(products).values({ slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded",
    source: "crawler", verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64) });
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: slug, textSample: "쓸 수 있는 앱" } });
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
    publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
}
async function started(...repos: string[]) {
  for (const repo of repos) await listed(repo);
  const result = await startProductAudit({ startedBy: "jr", reason: "감사 #4", reauditKept: false });
  if (!result.ok) throw new Error(result.error);
  return result.campaignId;
}
const campaignRow = async (id: number) => (await db.select().from(productAuditCampaigns).where(eq(productAuditCampaigns.id, id)))[0];
const item = async (slug: string) => (await db.select().from(productAuditItems).where(eq(productAuditItems.slug, slug)))[0];
/** 0112 전 gpt-oss 의 답 — 누가 답했는지 칸이 비어 있다 */
const answeredBefore = (slug: string, decision: "approve" | "reject", reason: string, confidence = 0.97) =>
  db.update(productAuditItems).set({ aiDecision: decision, aiReason: reason, aiConfidence: confidence, reviewedAt: sql`now()`, attempts: 1 })
    .where(eq(productAuditItems.slug, slug));
const toQwen = (campaignId: number) => switchAuditReviewer({ campaignId, expected: GPT, reason: "남은 1만5천 건을 하루 안에", by: "jr" });
const tick = () => runJob("product-audit", auditPublishedProducts, { budgetMs: jobRunOptions("product-audit", { requestedOnly: true }).budgetMs });
const heldSlugs = async () => (await db.select({ slug: products.slug }).from(products)
  .where(sql`${products.auditHoldAt} is not null`).orderBy(asc(products.slug))).map((row) => row.slug);

describe("남은 감사 모델 바꾸기 — compare-and-set·사유·작업 로그", () => {
  it("사유 없이·옛 화면으로는 바꾸지 않고, 바꾸면 시작 모델은 그대로 둔 채 current_* 와 작업 로그를 남긴다", async () => {
    const id = await started("s/one", "s/two", "s/three");
    const floor = await auditFloor();
    expect((await productAuditOverview()).switchTo).toEqual({ provider: "qwen-direct", model: QWEN_MODEL });

    expect(await switchAuditReviewer({ campaignId: id, expected: GPT, reason: "   ", by: "jr" }))
      .toEqual({ ok: false, error: expect.stringContaining("적어 주세요") });
    expect(await switchAuditReviewer({ campaignId: id, expected: { provider: "claude-cli", model: "sonnet" }, reason: "옛 화면", by: "jr" }))
      .toEqual({ ok: false, error: expect.stringContaining("그 사이") });
    expect(await campaignRow(id)).toMatchObject({ ...GPT, currentProvider: null, currentModel: null, switchedAt: null });

    expect(await toQwen(id)).toEqual({ ok: true, from: GPT, to: { provider: "qwen-direct", model: QWEN_MODEL }, unanswered: 3 });
    expect(await campaignRow(id)).toMatchObject({ ...GPT, currentProvider: "qwen-direct", currentModel: QWEN_MODEL, switchedBy: "jr",
      switchedAt: expect.any(Date), status: "running" });
    // 같은 화면을 다시 누르면(gpt-oss 를 본 화면) 옛 값이고, 바뀐 값을 보고 눌러도 이미 그 모델이다
    expect(await toQwen(id)).toMatchObject({ ok: false, error: expect.stringContaining("그 사이") });
    expect(await switchAuditReviewer({ campaignId: id, expected: { provider: "qwen-direct", model: QWEN_MODEL }, reason: "다시", by: "jr" }))
      .toMatchObject({ ok: false, error: expect.stringContaining("이미") });
    expect((await productAuditOverview()).switchTo).toBeNull();

    const rows = (await auditRowsAfter(floor, "audit-switch-model")).sort((a, b) => a.id - b.id);
    expect(rows.map((row) => [row.ok, row.error, row.target])).toEqual([
      [false, "reason_required", `campaign:${id}`], [false, "stale_state", `campaign:${id}`], [true, null, `campaign:${id}`],
      [false, "stale_state", `campaign:${id}`], [false, "already_switched", `campaign:${id}`],
    ]);
    expect(rows[2]).toMatchObject({ actor: "jr", detail: { from: GPT, to: { provider: "qwen-direct", model: QWEN_MODEL },
      reason: "남은 1만5천 건을 하루 안에", unanswered: 3, expected: GPT } });
  });

  it("멈춘 감사(글이 바뀜)·끝난 감사는 바꾸지 않는다", async () => {
    const id = await started("x/one");
    await db.update(productAuditCampaigns).set({ promptVersion: "2026-01-01.1" }).where(eq(productAuditCampaigns.id, id));
    expect(await toQwen(id)).toMatchObject({ ok: false, error: expect.stringContaining("멈춘 감사") });
    expect((await productAuditOverview()).switchTo).toBeNull();
    await cancelProductAudit();
    expect(await toQwen(id)).toMatchObject({ ok: false, error: expect.stringContaining("진행 중인 감사가 아닙니다") });
    expect((await campaignRow(id)).currentProvider).toBeNull();
  });

  it("Qwen 주소를 고칠 수 없으면 바꾸지 않는다", async () => {
    const id = await started("y/one");
    vi.stubEnv("AUDIT_SECOND_OPINION_URL", "ftp://qwen.test");
    expect(await toQwen(id)).toMatchObject({ ok: false, error: expect.stringContaining("Qwen 서버 설정") });
    expect((await productAuditOverview()).switchTo).toBeNull();
  });
});

describe("바꾼 뒤의 틱", () => {
  it("이미 답한 항목은 그대로 두고 남은 것만 Qwen 이 답한다 — 답마다 누가·어떤 글 판으로 답했는지 남는다", async () => {
    const id = await started("a/old", "a/next", "a/last");
    await answeredBefore("old", "approve", 'pageText: "old" — a usable app', 0.9);
    const before = await item("old");
    expect(await toQwen(id)).toMatchObject({ ok: true, unanswered: 2 });
    const fetcher = qwen({ "a/last": { decision: "reject", reason: COMPANY, confidence: 1 } });

    expect(await tick()).toMatchObject({ status: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => url === `${QWEN_URL}/chat/completions`)).toBe(true);
    expect(await item("old")).toEqual(before);
    expect(await item("next")).toMatchObject({ aiDecision: "approve", aiProvider: "qwen-direct", aiModel: QWEN_MODEL, attempts: 1 });
    expect(await item("last")).toMatchObject({ aiDecision: "reject", aiConfidence: 1, aiProvider: "qwen-direct", aiModel: QWEN_MODEL });
    const attempts = await db.select().from(productAuditAttempts).orderBy(asc(productAuditAttempts.id));
    expect(attempts.map((row) => [row.provider, row.model, row.promptVersion, row.errorCode])).toEqual([
      ["qwen-direct", QWEN_MODEL, QWEN_V2_PROMPT_VERSION, null], ["qwen-direct", QWEN_MODEL, QWEN_V2_PROMPT_VERSION, null]]);
    // 시작 모델은 기록으로 남는다
    expect(await campaignRow(id)).toMatchObject(GPT);
    const overview = await productAuditOverview();
    expect(overview.counts).toMatchObject({ total: 3, reviewed: 3, answeredByCurrent: 2 });
    // 답이 모두 있으면 다음 틱이 감사를 닫는다
    expect(await tick()).toMatchObject({ status: "completed", done: true });
    expect((await campaignRow(id)).status).toBe("done");
  });

  it("서버가 닿지 않으면 잡을 실패로 남기고 항목의 시도를 쓰지 않는다", async () => {
    const id = await started("d/one");
    await toQwen(id);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await tick()).toMatchObject({ status: "failed", error: "product_audit_endpoint_error:qwen_unreachable" });
    expect(await item("one")).toMatchObject({ aiDecision: null, attempts: 0, errorCode: null });
    expect(await db.select({ errorCode: productAuditAttempts.errorCode, provider: productAuditAttempts.provider }).from(productAuditAttempts))
      .toEqual([{ errorCode: "qwen_unreachable", provider: "qwen-direct" }]);
    // 물러나는 동안의 틱도 실패로 남는다 — 운영센터가 멈춘 것을 본다
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "product-audit"));
    expect(await tick()).toMatchObject({ status: "failed", error: "product_audit_endpoint_backoff:qwen_unreachable" });
  });
});

describe("Qwen 이 낸 거절의 보류 — 모델별 카탈로그 예외", () => {
  it("허용 갈래 거절은 같은 커밋에서 보류하고, 카탈로그·디렉터리 같은 거절은 보류하지 않고 사람의 목록에 둔다 — gpt-oss 의 같은 거절은 그대로 보류", async () => {
    const id = await started("q/qcompany", "q/qdirectory", "q/qlist", "g/gdirectory");
    // 바꾸기 전에 gpt-oss 가 답한 카탈로그 거절 — 남의 플랫폼 갈래라 지금처럼 보류한다(틱의 쓸기가 건다)
    await answeredBefore("gdirectory", "reject", DIRECTORY);
    await toQwen(id);
    qwen({
      "q/qcompany": { decision: "reject", reason: COMPANY, confidence: 0.95 },
      "q/qdirectory": { decision: "reject", reason: DIRECTORY, confidence: 1 },
      "q/qlist": { decision: "reject", reason: LIST_OF, confidence: 1 },
    });
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(await heldSlugs()).toEqual(["gdirectory", "qcompany"]);
    // 쓸기를 한 번 더 돌려도 Qwen 의 카탈로그 거절은 걸지 않는다
    await db.update(cdnPurges).set({ createdAt: sql`now() - interval '1 hour'` });
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "product-audit"));
    await tick();
    expect(await heldSlugs()).toEqual(["gdirectory", "qcompany"]);

    const findings = await listAuditFindings(id, "reject", { limit: 50, offset: 0 });
    expect(findings.map((row) => [row.slug, row.aiProvider, row.heldAt !== null]).sort()).toEqual([
      ["gdirectory", null, true], ["qcompany", "qwen-direct", true], ["qdirectory", "qwen-direct", false], ["qlist", "qwen-direct", false]]);
    const [held] = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, "qcompany"));
    expect(held.metadata).toMatchObject({ category: "company", auditModel: QWEN_MODEL, byCategory: true, bySecondOpinion: false });
  });
});
