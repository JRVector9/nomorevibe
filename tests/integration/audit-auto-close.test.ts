import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, operationsObservations, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems, productAuditPolicyRunItems, productAuditPolicyRuns, productAuditSecondOpinions,
  productEvidenceAudit, secondReviews } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, saveSettings, setAuditHold, setQwenAutoStep } from "@/lib/crawl/settings";
import { QWEN_AUTO_OBSERVATION, qwenSecondOpinionStatus } from "@/lib/crawl/audit-second-opinion-auto";
import { writeAuditSecondOpinions } from "@/lib/crawl/audit-second-opinion-import";
import { autoCloseToday, utcDay } from "@/lib/crawl/audit-auto-close";
import { applyAuditPolicyChunk, listPolicyRuns, previewAuditPolicy, startAuditPolicyRun, startAuditPolicyUndo, undoAuditPolicyChunk } from "@/lib/crawl/audit-policy";
import { EMPTY_POLICY_FILTER } from "@/lib/crawl/audit-policy-filter";
import { listAuditFindings, startProductAudit } from "@/lib/crawl/product-audit";
import { screenReviewCounts, screenReviewQueue } from "@/lib/crawl/audit-screen-review";
import { resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
/** DR writer fence 가 닫힌 쓰기 거부만 바꿔 본다 — 나머지는 실제 DB */
const fence = vi.hoisted(() => ({ active: true }));
vi.mock("@/lib/operations/dr/epoch", async (original) => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(),
  writerSiteActive: async () => fence.active }));

/**
 * 감사 두 번째 의견으로 닫기(2026-10-22 "승인은 유지, 거절은 숨김", lib/crawl/audit-auto-close.ts) — 열린 거절 전부를 묻고(scope all),
 * 의견을 적는 트랜잭션에서 승인은 유지·주인 없는 것의 거절은 숨김으로 닫는다. 정책 실행 일지에 남아 정책 처리의 되돌리기로 돌린다.
 * gpu3090 Qwen 은 가짜 서버, 쓰기·보류·일지·되돌리기는 실제 DB 다. 감사는 닫혀 있어 감사 묻기는 돌지 않는다.
 */
type Answer = { decision: "approve" | "reject" | "needs_review"; confidence?: number };
const server = vi.hoisted(() => ({ answers: new Map<string, unknown>(), calls: [] as string[] }));
async function fakeQwen(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body));
  const user: string = body.messages[1].content;
  const repo: string = JSON.parse(user.slice(user.indexOf("\n") + 1, user.lastIndexOf("\n"))).product.repo;
  server.calls.push(repo);
  const answer = (server.answers.get(repo) ?? { decision: "needs_review", confidence: 0.5 }) as Answer;
  const content = JSON.stringify({ decision: answer.decision, reason: `Qwen says ${answer.decision}.`, evidenceIds: ["product"],
    confidence: answer.confidence ?? 0.95 });
  return new Response(JSON.stringify({ model: "qwen3.8-flash-next", choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 5_000, completion_tokens: 120 } }), { status: 200 });
}

const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const CONTENT = 'pageText: "Getting started" — a documentation site for a library, not a usable product';
/** 카탈로그 같은 사유 — Qwen 거절의 카탈로그 예외가 걸리는 항목(자동 숨김에는 걸지 않는다) */
const CATALOG = "The page is an awesome list of documentation links for many tools, not one product";
/** 빈 화면 갈래 */
const EMPTY = "The page text is empty; only shows a title and a JavaScript bundle";
/** 수집 본문 — 300자 이상이라 글만 본 m1 의 답으로 닫을 수 있다(audit-text-gate.ts). THIN 은 화면 판별 대기 */
const RICH = "쓸 수 있는 앱 — 가입하고 바로 씁니다. ".repeat(14);
const THIN = "쓸 수 있는 앱";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  fence.active = true;
  vi.unstubAllEnvs();
  for (const table of [secondReviews, productAuditAttempts, productAuditItems, productAuditCampaigns, crawlReviewAttempts, crawlCandidates,
    crawlDocuments, crawlFrontier, crawlSettings, jobs]) await db.delete(table);
  await db.delete(operationsObservations).where(eq(operationsObservations.key, QWEN_AUTO_OBSERVATION));
  await resetTables();
  server.answers.clear();
  server.calls.length = 0;
  resetQwenAuditBackoff();
  vi.stubGlobal("fetch", vi.fn(fakeQwen));
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, reviewConcurrency: 1 }, "test");
  // 켬과 틱당 수만 적는다 — 범위·답으로 닫기는 새 기본값(열린 거절 전부·켬)으로 읽힌다
  expect(await turn({ enabled: true, perTick: 10 })).toMatchObject({ ok: true });
});
afterEach(() => vi.unstubAllGlobals());

let sequence = 0;
async function listed(repo: string, over: Partial<typeof products.$inferInsert> = {}, document = true, text = RICH) {
  const slug = repo.split("/")[1];
  const url = `https://${slug}.test`;
  const [product] = await db.insert(products).values({
    slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded", source: "crawler",
    verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64), ...over,
  }).returning();
  if (!document) return product;
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: slug, textSample: text } });
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
    publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
  return product;
}
type Row = { repo: string; confidence?: number; reason?: string; over?: Partial<typeof products.$inferInsert>; document?: boolean;
  provider?: string; model?: string; text?: string };
/** 감사를 열고 답을 직접 적은 뒤 닫는다 — 틱은 쓸기와 Qwen-v2 단계만 돈다 */
async function judged(rows: Row[]) {
  for (const row of rows) await listed(row.repo, row.over, row.document ?? true, row.text ?? RICH);
  await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false });
  for (const row of rows) {
    await db.update(productAuditItems).set({ aiDecision: "reject", aiConfidence: row.confidence ?? 0.97, aiReason: row.reason ?? COMPANY,
      reviewedAt: sql`now()`, attempts: 1, aiProvider: row.provider ?? null, aiModel: row.model ?? null })
      .where(eq(productAuditItems.slug, row.repo.split("/")[1]));
  }
  await db.update(productAuditCampaigns).set({ status: "done" });
}
const tick = () => runJob("product-audit", auditPublishedProducts, { budgetMs: jobRunOptions("product-audit", { requestedOnly: true }).budgetMs });
const item = async (slug: string) => (await db.select().from(productAuditItems).where(eq(productAuditItems.slug, slug))
  .orderBy(asc(productAuditItems.id))).at(-1)!;
const product = async (slug: string) => (await db.select().from(products).where(eq(products.slug, slug)))[0];
const heldSlugs = async () => (await db.select({ slug: products.slug }).from(products)
  .where(sql`${products.auditHoldAt} is not null`).orderBy(asc(products.slug))).map((row) => row.slug);
const keptSlugs = async () => (await db.select({ slug: productAuditItems.slug }).from(productAuditItems)
  .where(eq(productAuditItems.humanDecision, "kept")).orderBy(asc(productAuditItems.slug))).map((row) => row.slug);
const autoRuns = () => db.select().from(productAuditPolicyRuns).where(eq(productAuditPolicyRuns.createdBy, "qwen-v2-auto"))
  .orderBy(asc(productAuditPolicyRuns.id));
const runItems = (runId: number) => db.select().from(productAuditPolicyRunItems).where(eq(productAuditPolicyRunItems.runId, runId))
  .orderBy(asc(productAuditPolicyRunItems.id));
const turn = async (next: Record<string, unknown>, reason = "테스트") => {
  const expected = (await getSettings()).qwenAuto.auditSecondOpinion;
  return setQwenAutoStep({ step: "auditSecondOpinion", next: { ...expected, ...next } as never, expected, actor: "jr", reason });
};
const vote = async (slug: string, model: string, decision: "approve" | "reject", source = "grok-cli-batch") => {
  const row = await item(slug);
  await db.insert(productAuditSecondOpinions).values({ itemId: row.id, productId: row.productId, model, decision, confidence: 0.9,
    reason: "earlier", source });
};
async function undoAll(runId: number) {
  expect(await startAuditPolicyUndo({ runId, by: "jr" })).toMatchObject({ ok: true });
  for (let calls = 0; ; calls++) {
    const progress = (await undoAuditPolicyChunk({ runId, by: "jr" }))!;
    if (progress.done || calls > 50) return progress;
  }
}
/** 감사 잡이 적는 것과 같은 쓰기를 바로 부른다(같은 모델·판) — 다시 답할 때·DR 관문 */
const answerDirectly = async (slug: string, decision: "approve" | "reject", confidence = 0.95, promptVersion = QWEN_V2_PROMPT_VERSION) => {
  const row = await item(slug);
  return writeAuditSecondOpinions(db, [{ itemId: row.id, productId: row.productId, model: "qwen3.8-flash-next", decision, confidence,
    reason: "again", inputHash: null, promptVersion }], { dryRun: false, source: "qwen-v2-auto", auto: { actor: "qwen-v2-auto", close: true } });
};

describe("묻는 범위", () => {
  it("열린 거절 전부 — 확신 0.95 아래·주인 있는 것까지 묻는다. 공개 중(확신 높은 순) → 보류 중 → 글이 적은 페이지(같은 차례) → id", async () => {
    await judged([{ repo: "o/low", confidence: 0.6, reason: CONTENT }, { repo: "o/mid", confidence: 0.8, reason: CONTENT },
      { repo: "o/cand", confidence: 0.96, reason: CONTENT }, { repo: "o/owned", confidence: 0.97, over: { claimedAt: new Date() } },
      { repo: "o/verified", confidence: 0.9, over: { status: "verified", verifiedAt: new Date() } }, { repo: "o/held", confidence: 0.97 },
      { repo: "o/held-low", confidence: 0.6, reason: CONTENT },
      // 글이 적은 페이지는 m1 의 답이 닫지 못한다 — 닫을 수 있는 것을 다 물은 뒤에(공개 먼저·확신 높은 순)
      { repo: "o/thin", confidence: 0.99, reason: CONTENT, text: THIN }, { repo: "o/thin-held", confidence: 0.99, text: THIN },
      // 같은 모델 규칙(감사 답을 같은 Qwen 이 냄)·수집 원본 없음·내려간 제품은 묻지 않는다
      { repo: "o/same", confidence: 0.6, provider: "qwen-direct", model: "qwen3.8-flash-next" }, { repo: "o/nodoc", confidence: 0.6, document: false },
      { repo: "o/banned", confidence: 0.6, over: { status: "banned" } }]);
    // 보류 중인 것 — 쓸기가 이 틱에 회사 소개(o/held·o/thin-held, 확신 0.97·0.99)를 걸고, o/held-low 는 지난 보류로 둔다
    await db.update(products).set({ auditHoldAt: sql`now()`, auditHoldItemId: sql`(select id from product_audit_items where slug = 'held-low')` })
      .where(eq(products.slug, "held-low"));
    expect(await turn({ perTick: 20 })).toMatchObject({ ok: true });
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(await heldSlugs()).toEqual(["held", "held-low", "thin-held"]);
    expect(server.calls).toEqual(["o/owned", "o/cand", "o/verified", "o/mid", "o/low", "o/held", "o/held-low", "o/thin", "o/thin-held"]);
    const status = await qwenSecondOpinionStatus(await getSettings());
    expect(status.audit).toMatchObject({ enabled: true, scope: "all", autoClose: true, remaining: 0, lastHour: 9 });
  });

  it("보류 후보만(scope hold) — 확신 문턱 아래·주인 있는 것은 묻지 않는다", async () => {
    await judged([{ repo: "h/low", confidence: 0.6, reason: CONTENT }, { repo: "h/cand", confidence: 0.96, reason: CONTENT },
      { repo: "h/owned", confidence: 0.97, over: { claimedAt: new Date() } }]);
    expect(await turn({ scope: "hold" })).toMatchObject({ ok: true });
    await tick();
    expect(server.calls).toEqual(["h/cand"]);
  });

  it("지난 감사의 항목으로 보류 중인 것도 묻는다(감사 화면·정책 처리의 대상과 같다) — 마지막 감사가 끝나도 그 감사의 열린 거절을 묻는다", async () => {
    await judged([{ repo: "p/old", confidence: 0.97 }]);
    await tick();
    expect(await heldSlugs()).toEqual(["old"]);
    server.calls.length = 0;
    await db.delete(productAuditSecondOpinions);
    await listed("p/new");
    // 새 감사(#2)를 열어 닫는다 — p/old 는 #2 에서 승인, p/new 는 #2 의 열린 거절
    await startProductAudit({ startedBy: "jr", reason: "감사 2", reauditKept: false });
    await db.update(productAuditItems).set({ aiDecision: "approve", aiConfidence: 0.9, reviewedAt: sql`now()`, attempts: 1 })
      .where(and(eq(productAuditItems.slug, "old"), sql`${productAuditItems.campaignId} = (select max(id) from product_audit_campaigns)`));
    await db.update(productAuditItems).set({ aiDecision: "reject", aiConfidence: 0.5, aiReason: CONTENT, reviewedAt: sql`now()`, attempts: 1 })
      .where(eq(productAuditItems.slug, "new"));
    await db.update(productAuditCampaigns).set({ status: "done" });
    await tick();
    expect(server.calls.sort()).toEqual(["p/new", "p/old"]);
  });
});

describe("답으로 닫기", () => {
  it("승인은 유지·주인 없는 것의 거절은 숨김 — 확신 0.90 이상만, 갈림·주인 있음·판단 보류는 열어 둔다. 일지·작업 로그에 남는다", async () => {
    await judged([
      { repo: "a/keep-low", confidence: 0.6, reason: CONTENT }, { repo: "a/keep-held", confidence: 0.97 },
      { repo: "a/keep-owned", confidence: 0.7, over: { claimedAt: new Date() } }, { repo: "a/split", confidence: 0.6, reason: CONTENT },
      { repo: "a/hide-low", confidence: 0.6, reason: CONTENT }, { repo: "a/hide-catalog", confidence: 0.55, reason: CATALOG },
      { repo: "a/hide-owned", confidence: 0.6, reason: CONTENT, over: { claimedAt: new Date() } },
      { repo: "a/hide-verified", confidence: 0.6, reason: CONTENT, over: { status: "verified", verifiedAt: new Date() } },
      { repo: "a/weak-approve", confidence: 0.6, reason: CONTENT }, { repo: "a/weak-reject", confidence: 0.6, reason: CONTENT },
      { repo: "a/unsure", confidence: 0.6, reason: CONTENT }, { repo: "a/edge", confidence: 0.6, reason: CONTENT },
    ]);
    await vote("split", "grok-4.7", "reject");
    for (const repo of ["a/keep-low", "a/keep-owned", "a/split"]) server.answers.set(repo, { decision: "approve", confidence: 0.95 });
    server.answers.set("a/keep-held", { decision: "approve", confidence: 1 });
    for (const repo of ["a/hide-low", "a/hide-catalog", "a/hide-owned", "a/hide-verified"]) server.answers.set(repo, { decision: "reject", confidence: 0.95 });
    server.answers.set("a/weak-approve", { decision: "approve", confidence: 0.89 });
    server.answers.set("a/weak-reject", { decision: "reject", confidence: 0.85 });
    server.answers.set("a/unsure", { decision: "needs_review", confidence: 0.99 });
    // 확신 문턱 그대로(0.90)는 닫는다
    server.answers.set("a/edge", { decision: "reject", confidence: 0.9 });
    // 열두 건을 한 틱에 — 틱당 상한(20)까지 올린다(넓히는 바꿈이라 까닭을 받는다)
    expect(await turn({ perTick: 20 }, "")).toMatchObject({ ok: false });
    expect(await turn({ perTick: 20 })).toMatchObject({ ok: true });
    const floor = await auditFloor();

    expect(await tick()).toMatchObject({ status: "completed" });
    expect(server.calls).toHaveLength(12);
    // 쓸기는 이 틱에 회사 소개(keep-held)를 걸었고 승인이 같은 커밋에서 풀었다. split 은 grok 이 거절해 갈림이라 열어 둔다
    expect(await keptSlugs()).toEqual(["keep-held", "keep-low", "keep-owned"]);
    expect(await heldSlugs()).toEqual(["edge", "hide-catalog", "hide-low"]);
    const kept = await item("keep-low");
    expect(kept).toMatchObject({ humanDecision: "kept", humanBy: "qwen-v2-auto" });
    expect(kept.humanNote).toMatch(/^m1 자동 유지 · 정책 #\d+$/);
    const keepDays = (kept.keepUntil!.getTime() - kept.humanAt!.getTime()) / 86_400_000;
    expect(Math.round(keepDays)).toBe(90);
    for (const slug of ["split", "hide-owned", "hide-verified", "weak-approve", "weak-reject", "unsure"]) {
      expect((await item(slug)).humanDecision, slug).toBeNull();
    }
    // 숨김은 보류 길 그대로 — 그 항목이 까닭, 제품 기록의 누가 qwen-v2-auto(사유 갈래와 상관없이: 글·문서·카탈로그 같은 것도)
    const hidden = await product("hide-low");
    expect(hidden.auditHoldItemId).toBe((await item("hide-low")).id);
    const holds = await db.select().from(productEvidenceAudit).where(and(eq(productEvidenceAudit.action, "audit.hold"),
      eq(productEvidenceAudit.actor, "qwen-v2-auto"))).orderBy(asc(productEvidenceAudit.slug));
    expect(holds.map((row) => [row.slug, row.reason])).toEqual([["edge", "second_reject · audit:content"],
      ["hide-catalog", "second_reject · audit:content"], ["hide-low", "second_reject · audit:content"]]);
    expect(holds[0].metadata).toMatchObject({ auto: true, by: "qwen-v2-auto", model: "qwen3.8-flash-next", confidence: 0.9, aiConfidence: 0.6 });
    // 보류 중이던 것을 유지하면 같은 커밋에서 푼다(사람의 유지와 같은 길)
    const releases = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"));
    expect(releases.map((row) => [row.slug, row.actor, row.reason])).toEqual([["keep-held", "qwen-v2-auto", "kept"]]);

    // 일지 — 오늘(UTC)·행동마다 시스템 실행 하나, 처음부터 '적용함'. 숨김은 0116 의 action 검사 안에서 release 로 적고 뜻은 options.auto 다
    const runs = await autoRuns();
    expect(runs).toHaveLength(2);
    const keepRun = runs.find((run) => run.action === "keep")!;
    const holdRun = runs.find((run) => run.action === "release")!;
    for (const [run, action] of [[keepRun, "keep"], [holdRun, "hold"]] as const) {
      expect(run).toMatchObject({ kind: "close", status: "applied", planned: 3, createdBy: "qwen-v2-auto" });
      expect(run.appliedAt).not.toBeNull();
      expect(run.options).toMatchObject({ auto: { by: "qwen-v2-auto", action, day: utcDay(), model: "qwen3.8-flash-next", minConfidence: 0.9 } });
    }
    expect((keepRun.options as { keepDays: number }).keepDays).toBe(90);
    const keepItems = await runItems(keepRun.id);
    expect(keepItems.map((row) => [row.slug, row.state])).toEqual(expect.arrayContaining([["keep-held", "applied"], ["keep-low", "applied"], ["keep-owned", "applied"]]));
    const heldItem = keepItems.find((row) => row.slug === "keep-held")!;
    expect(heldItem.before).toMatchObject({ status: "seeded", holdItemId: (await item("keep-held")).id });
    expect((heldItem.before as { heldAt: string }).heldAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/);
    expect(heldItem.after).toMatchObject({ keepUntil: expect.stringMatching(/^\d{4}-/) });
    expect(heldItem.payload).toMatchObject({ model: "qwen3.8-flash-next", decision: "approve", confidence: 1 });
    expect((await runItems(holdRun.id)).map((row) => row.slug).sort()).toEqual(["edge", "hide-catalog", "hide-low"]);
    // 작업 로그 — 한 건마다(사람이 정하지 않은 공개 목록 변화)
    expect((await auditRowsAfter(floor, "audit-auto-keep")).map((row) => row.target).sort()).toEqual(["keep-held", "keep-low", "keep-owned"]);
    expect((await auditRowsAfter(floor, "audit-auto-hold")).map((row) => [row.target, row.actor, row.actorKind]).sort())
      .toEqual([["edge", "qwen-v2-auto", "model"], ["hide-catalog", "qwen-v2-auto", "model"], ["hide-low", "qwen-v2-auto", "model"]]);
    // 오늘의 수 — 정책 처리 탭·Qwen 상태 칸
    expect(await autoCloseToday()).toEqual({ day: utcDay(), kept: 3, held: 3, undone: 0 });
    expect((await qwenSecondOpinionStatus(await getSettings())).autoClose).toEqual({ day: utcDay(), kept: 3, held: 3, undone: 0, minConfidence: 0.9 });
    const listed = await listPolicyRuns();
    expect(listed.map((run) => run.auto?.action).sort()).toEqual(["hold", "keep"]);

    // 다음 틱 — 다시 묻지 않는다(같은 모델·판의 의견이 있다). 일지도 그대로
    server.calls.length = 0;
    await tick();
    expect(server.calls).toEqual([]);
    expect((await autoRuns()).map((run) => run.planned)).toEqual(runs.map((run) => run.planned));
  });

  it("다시 답해도 한 번만 닫는다 — 유지한 항목은 열린 거절이 아니고, 숨긴 제품은 이미 보류 중이다. 같은 날 실행 하나에 덧붙인다", async () => {
    await judged([{ repo: "i/keep", confidence: 0.6, reason: CONTENT }, { repo: "i/hide", confidence: 0.6, reason: CONTENT },
      { repo: "i/later", confidence: 0.6, reason: CONTENT }]);
    expect((await answerDirectly("keep", "approve")).autoClose).toEqual({ kept: 1, held: 0, left: {} });
    expect((await answerDirectly("hide", "reject")).autoClose).toEqual({ kept: 0, held: 1, left: {} });
    // 같은 답·다른 판으로 다시 — 유지한 것은 열린 거절이 아니라 의견도 적지 않고, 숨긴 것은 이미 보류 중
    const again = await answerDirectly("keep", "approve", 0.99, "2026-10-30.v3");
    expect(again).toMatchObject({ inserted: 0, updated: 0, skipped: { not_open: 1 } });
    expect((await answerDirectly("hide", "reject", 0.99, "2026-10-30.v3")).autoClose).toEqual({ kept: 0, held: 0, left: { held_already: 1 } });
    // 같은 날의 다른 항목은 같은 실행에 덧붙는다
    expect((await answerDirectly("later", "reject")).autoClose).toMatchObject({ held: 1 });
    const runs = await autoRuns();
    expect(runs.map((run) => [run.action, run.planned])).toEqual([["keep", 1], ["release", 2]]);
    expect((await runItems(runs[1].id)).map((row) => row.slug)).toEqual(["hide", "later"]);
  });

  it("감사 보류가 꺼져 있으면 숨기지 않는다(유지는 한다). 사람·정책이 보류를 푼 항목·살아 있는 유지가 있는 제품도 숨기지 않는다", async () => {
    await judged([{ repo: "s/hide", confidence: 0.6, reason: CONTENT }, { repo: "s/keep", confidence: 0.6, reason: CONTENT },
      { repo: "s/settled", confidence: 0.6, reason: CONTENT }]);
    await db.update(productAuditItems).set({ holdReleasedAt: sql`now()` }).where(eq(productAuditItems.slug, "settled"));
    const before = (await getSettings()).auditHold;
    expect(await setAuditHold({ next: { ...before, enabled: false }, expected: before, actor: "jr" })).toMatchObject({ ok: true });
    expect((await answerDirectly("hide", "reject")).autoClose).toEqual({ kept: 0, held: 0, left: { hold_off: 1 } });
    expect((await answerDirectly("keep", "approve")).autoClose).toMatchObject({ kept: 1 });
    const off = (await getSettings()).auditHold;
    expect(await setAuditHold({ next: { ...off, enabled: true }, expected: off, actor: "jr", reason: "다시 켬" })).toMatchObject({ ok: true });
    expect((await answerDirectly("settled", "reject")).autoClose).toEqual({ kept: 0, held: 0, left: { settled: 1 } });
    expect(await heldSlugs()).toEqual([]);
  });

  it("답으로 닫기를 끄면 옛 길 그대로다 — 확신 0.95 아래는 열어 두고, 보류 중인 것의 승인은 두 번째 모델 승인으로 푼다", async () => {
    await judged([{ repo: "f/low", confidence: 0.6, reason: CONTENT }, { repo: "f/held", confidence: 0.97 }, { repo: "f/hide", confidence: 0.6, reason: CONTENT }]);
    expect(await turn({ autoClose: false })).toMatchObject({ ok: true });
    server.answers.set("f/low", { decision: "approve", confidence: 0.95 });
    server.answers.set("f/held", { decision: "approve", confidence: 1 });
    server.answers.set("f/hide", { decision: "reject", confidence: 0.95 });
    await tick();
    expect(server.calls.sort()).toEqual(["f/held", "f/hide", "f/low"]);
    expect(await keptSlugs()).toEqual([]);
    expect(await heldSlugs()).toEqual([]);
    const releases = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"));
    expect(releases.map((row) => [row.slug, row.actor, row.reason])).toEqual([["held", "import:qwen-v2-auto", "second_approve"]]);
    expect(await autoRuns()).toEqual([]);
  });

  it("운영 행에 범위·닫기 칸이 없으면 새 기본값(열린 거절 전부·닫기 켬)으로 돈다 — 배포만으로 켜진다", async () => {
    await judged([{ repo: "d/low", confidence: 0.6, reason: CONTENT }]);
    await db.execute(sql`update crawl_settings set values = jsonb_set(values, '{qwenAuto,auditSecondOpinion}', '{"enabled": true, "perTick": 10}') where id = 1`);
    expect((await getSettings()).qwenAuto.auditSecondOpinion).toEqual({ enabled: true, perTick: 10, scope: "all", autoClose: true });
    server.answers.set("d/low", { decision: "reject", confidence: 0.97 });
    await tick();
    expect(server.calls).toEqual(["d/low"]);
    expect(await heldSlugs()).toEqual(["low"]);
  });

  it("답으로 닫기 전에 받아 둔 이 판의 답은 다시 묻지 않고 그 답으로 닫는다(따라잡기) — 옛 판의 답은 다시 묻는다", async () => {
    await judged([{ repo: "c/approve", confidence: 0.6, reason: CONTENT }, { repo: "c/catalog", confidence: 0.97, reason: CATALOG },
      { repo: "c/owned", confidence: 0.6, reason: CONTENT, over: { claimedAt: new Date() } }, { repo: "c/split", confidence: 0.6, reason: CONTENT },
      { repo: "c/weak", confidence: 0.6, reason: CONTENT }, { repo: "c/old", confidence: 0.6, reason: CONTENT },
      { repo: "c/edge", confidence: 0.6, reason: CONTENT },
      // 글이 적은 페이지·다른 모델이 승인한 거절(엇갈림)은 받아 둔 답으로도 닫지 않는다
      { repo: "c/thin", confidence: 0.6, reason: CONTENT, text: THIN }, { repo: "c/rsplit", confidence: 0.6, reason: CONTENT }]);
    const earlier = async (slug: string, decision: "approve" | "reject", confidence: number, promptVersion = QWEN_V2_PROMPT_VERSION) => {
      const row = await item(slug);
      await db.insert(productAuditSecondOpinions).values({ itemId: row.id, productId: row.productId, model: "qwen3.8-flash-next", decision, confidence,
        reason: "earlier", source: "qwen-v2-auto", promptVersion });
    };
    await earlier("approve", "approve", 0.95);
    // 카탈로그 같은 항목의 Qwen 거절 — 쓸기는 걸지 않았지만(카탈로그 예외) 자동 숨김은 갈래와 상관없이 숨긴다
    await earlier("catalog", "reject", 1);
    await earlier("owned", "reject", 0.95);
    await earlier("split", "approve", 0.95);
    await vote("split", "grok-4.7", "reject");
    await earlier("weak", "approve", 0.85);
    // 문턱 그대로(real 0.9) — SQL 의 미리 거르기도 문턱 안으로 본다
    await earlier("edge", "approve", 0.9);
    await earlier("old", "approve", 0.95, "2026-10-01.v1");
    await earlier("thin", "reject", 0.95);
    await earlier("rsplit", "reject", 0.95);
    await vote("rsplit", "grok-4.7", "approve");
    server.answers.set("c/old", { decision: "approve", confidence: 0.95 });
    // 답으로 닫기가 꺼져 있으면 따라잡지 않는다
    expect(await turn({ autoClose: false })).toMatchObject({ ok: true });
    await tick();
    expect(server.calls).toEqual(["c/old"]);
    expect(await keptSlugs()).toEqual([]);
    expect(await heldSlugs()).toEqual([]);
    await db.delete(productAuditSecondOpinions).where(eq(productAuditSecondOpinions.itemId, (await item("old")).id));
    await earlier("old", "approve", 0.95, "2026-10-01.v1");
    server.calls.length = 0;
    expect(await turn({ autoClose: true })).toMatchObject({ ok: true });
    await tick();
    // 이 판의 답은 다시 묻지 않는다 — 옛 판의 답(c/old)만 다시 묻고 새 답으로 닫는다
    expect(server.calls).toEqual(["c/old"]);
    expect(await keptSlugs()).toEqual(["approve", "edge", "old"]);
    expect(await heldSlugs()).toEqual(["catalog"]);
    const [keepRun] = (await autoRuns()).filter((run) => run.action === "keep");
    expect((await runItems(keepRun.id)).map((row) => row.slug).sort()).toEqual(["approve", "edge", "old"]);
    // 다음 틱 — 닫히지 않는 것(주인 있음·갈림·확신 낮음)을 다시 고르지 않는다
    server.calls.length = 0;
    await tick();
    expect(server.calls).toEqual([]);
    expect((await autoRuns()).map((run) => run.planned).sort()).toEqual([1, 3]);
  });

  it("DR writer fence 가 닫혀 있으면 의견도 닫기도 적지 않는다", async () => {
    await judged([{ repo: "dr/low", confidence: 0.6, reason: CONTENT }]);
    fence.active = false;
    await expect(answerDirectly("low", "reject")).rejects.toBeInstanceOf(DrWriterFencedError);
    fence.active = true;
    expect(await db.select().from(productAuditSecondOpinions)).toEqual([]);
    expect(await heldSlugs()).toEqual([]);
    expect(await autoRuns()).toEqual([]);
  });
});

describe("글이 적은 페이지·엇갈림(2026-10-22 사용자 결정)", () => {
  it("글이 적은 페이지는 승인·거절 모두 닫지 않는다 — 의견만 남고 화면 판별 대기에 든다. 쓸기도 m1 거절로 숨기지 않고 m1 승인으로 풀지 않는다", async () => {
    await judged([{ repo: "t/rich", confidence: 0.97, reason: CONTENT }, { repo: "t/thin", confidence: 0.97, reason: CONTENT, text: THIN },
      // 회사 소개 갈래 — 쓸기가 첫 감사의 갈래로 건다(첫 감사의 갈래 보류는 그대로다)
      { repo: "t/thin-held", confidence: 0.97, text: THIN },
      // 299자 — 문턱 바로 아래
      { repo: "t/edge", confidence: 0.6, reason: CONTENT, text: "가".repeat(299) }]);
    server.answers.set("t/rich", { decision: "reject", confidence: 0.95 });
    server.answers.set("t/thin", { decision: "reject", confidence: 1 });
    server.answers.set("t/thin-held", { decision: "approve", confidence: 1 });
    server.answers.set("t/edge", { decision: "approve", confidence: 1 });
    expect(await tick()).toMatchObject({ status: "completed" });
    // 닫을 수 있는 것(글 충분)을 먼저 묻고, 글이 적은 것도 묻는다(의견은 남는다)
    expect(server.calls).toEqual(["t/rich", "t/thin", "t/edge", "t/thin-held"]);
    expect((await db.select().from(productAuditSecondOpinions)).map((row) => row.source)).toEqual(Array(4).fill("qwen-v2-auto"));
    // 글 충분한 거절만 숨긴다 — 글이 적은 거절은 숨기지 않고, 글이 적은 승인은 유지하지도 갈래 보류를 풀지도 않는다
    expect(await heldSlugs()).toEqual(["rich", "thin-held"]);
    expect(await keptSlugs()).toEqual([]);
    expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"))).toEqual([]);
    // 다음 틱 — 쓸기도 글이 적은 페이지의 m1 거절(확신 0.97 · 글·문서 갈래 — 두 번째 모델 거절로만 걸 수 있다)로 숨기지 않는다
    await tick();
    expect(await heldSlugs()).toEqual(["rich", "thin-held"]);
    // 같은 쓰기를 바로 불러도 열어 둔 까닭은 화면 판별 대기다(다른 판으로 다시 답함)
    expect((await answerDirectly("thin", "reject", 1, "2026-10-30.v3")).autoClose).toEqual({ kept: 0, held: 0, left: { thin_text: 1 } });
    expect((await answerDirectly("edge", "approve", 1, "2026-10-30.v3")).autoClose).toEqual({ kept: 0, held: 0, left: { thin_text: 1 } });

    // 화면 판별 대기 — 공개 중 먼저(확신 높은 순), 그다음 보류 중. 글 충분한 것은 들지 않는다
    const queue = await screenReviewQueue();
    expect(queue.map((row) => [row.slug, row.held, row.textLength])).toEqual([["thin", false, 8], ["edge", false, 299], ["thin-held", true, 8]]);
    expect(queue[0]).toMatchObject({ url: "https://thin.test", pageText: THIN, owned: false,
      audit: { confidence: 0.97, reason: CONTENT, category: "content", model: "[MLX] gpt-oss-120b" } });
    expect(queue[0].opinions).toEqual([expect.objectContaining({ model: "qwen3.8-flash-next", decision: "reject", source: "qwen-v2-auto",
      reason: "again" })]);
    expect(await screenReviewCounts()).toEqual({ screenWait: 3, screenWaitPublic: 2, split: 0 });
    const status = await qwenSecondOpinionStatus(await getSettings());
    expect(status.screen).toEqual({ screenWait: 3, screenWaitPublic: 2, split: 0 });
    // 정책 처리의 거르기 — 화면 판별 대기·글 적음·글 충분
    const preview = async (screen: "wait" | "thin" | "text") =>
      (await previewAuditPolicy({ filter: { ...EMPTY_POLICY_FILTER, screen }, action: "keep" })).matched;
    expect([await preview("wait"), await preview("thin"), await preview("text")]).toEqual([3, 3, 1]);
    const sample = (await previewAuditPolicy({ filter: { ...EMPTY_POLICY_FILTER, screen: "wait" }, action: "keep" })).sample;
    expect(sample.find((row) => row.slug === "thin")).toMatchObject({ textLength: 8, screenJudged: false, m1Split: false });
  });

  it("답으로 닫기를 꺼도 쓸기는 글이 적은 페이지·다른 모델이 승인한 것을 m1 거절(두 번째 모델 거절)로 숨기지 않는다", async () => {
    expect(await turn({ autoClose: false })).toMatchObject({ ok: true });
    await judged([{ repo: "w/rich", reason: CONTENT }, { repo: "w/thin", reason: CONTENT, text: THIN }, { repo: "w/split", reason: CONTENT },
      { repo: "w/grok", reason: CONTENT, text: THIN }]);
    await vote("split", "grok-4.7", "approve");
    // 글이 적어도 grok 의 거절은 그대로 센다
    await vote("grok", "grok-4.7", "reject");
    for (const repo of ["w/rich", "w/thin", "w/split", "w/grok"]) server.answers.set(repo, { decision: "reject", confidence: 0.97 });
    await tick();
    expect(server.calls.sort()).toEqual(["w/grok", "w/rich", "w/split", "w/thin"]);
    await tick();
    expect(await heldSlugs()).toEqual(["grok", "rich"]);
    // 감사 화면의 '두 모델 모두 거절'도 같은 셈이다(SQL) — 엇갈린 것은 '갈림'에 든다
    const [campaign] = await db.select().from(productAuditCampaigns);
    const slugs = async (second: "agreed" | "split") => (await listAuditFindings(campaign.id, "reject", { limit: 50, offset: 0, second }))
      .map((row) => row.slug).sort();
    expect(await slugs("agreed")).toEqual(["grok", "rich"]);
    expect(await slugs("split")).toEqual(["split"]);
  });

  it("다른 모델이 승인했으면 숨기지 않는다 — 엇갈림으로 열어 두고 두 모델의 결정·사유를 작업 로그·감사 줄·정책 처리 표본에 남긴다", async () => {
    await judged([{ repo: "x/reject", confidence: 0.6, reason: CONTENT }, { repo: "x/approve", confidence: 0.6, reason: CONTENT },
      { repo: "x/owned", confidence: 0.6, reason: CONTENT, over: { claimedAt: new Date() } }, { repo: "x/hide", confidence: 0.6, reason: CONTENT }]);
    await vote("reject", "grok-4.7", "approve");
    await vote("approve", "grok-4.7", "reject");
    await vote("owned", "qwen3.8-flash-next+vision", "approve", "qwen-vision-m1");
    // 같은 모델(게이트웨이 자리 표시만 다름)의 승인은 엇갈림이 아니다
    await vote("hide", "[gpu3090] qwen3.8-flash-next", "approve");
    server.answers.set("x/reject", { decision: "reject", confidence: 0.95 });
    server.answers.set("x/approve", { decision: "approve", confidence: 0.95 });
    server.answers.set("x/owned", { decision: "reject", confidence: 0.95 });
    server.answers.set("x/hide", { decision: "reject", confidence: 0.95 });
    const floor = await auditFloor();
    await tick();
    expect(await heldSlugs()).toEqual(["hide"]);
    expect(await keptSlugs()).toEqual([]);
    const splits = await auditRowsAfter(floor, "audit-auto-split");
    expect(splits.map((row) => row.target).sort()).toEqual(["approve", "owned", "reject"]);
    expect(splits.find((row) => row.target === "reject")).toMatchObject({ actor: "qwen-v2-auto", actorKind: "model", ok: true, detail: {
      itemId: (await item("reject")).id, aiConfidence: 0.6, category: "content",
      m1: { model: "qwen3.8-flash-next", decision: "reject", confidence: 0.95, promptVersion: QWEN_V2_PROMPT_VERSION, reason: "Qwen says reject." },
      others: [{ model: "grok-4.7", source: "grok-cli-batch", decision: "approve", confidence: 0.9, reason: "earlier" }] } });
    expect(splits.find((row) => row.target === "owned")).toMatchObject({ detail: { others: [{ model: "qwen3.8-flash-next+vision", source: "qwen-vision-m1" }] } });
    expect(splits.find((row) => row.target === "approve")).toMatchObject({ detail: { m1: { decision: "approve" }, others: [{ decision: "reject" }] } });
    // 감사 줄 — 엇갈림 표시와 두 모델의 사유
    const [campaign] = await db.select().from(productAuditCampaigns);
    const rows = await listAuditFindings(campaign.id, "reject", { limit: 50, offset: 0 });
    const row = rows.find((finding) => finding.slug === "reject")!;
    expect(row).toMatchObject({ m1Split: true, screenJudged: false, textLength: [...RICH.trim()].length });
    expect(row.second.map((opinion) => [opinion.model, opinion.decision, opinion.source, opinion.reason])).toEqual([
      ["grok-4.7", "approve", "grok-cli-batch", "earlier"], ["qwen3.8-flash-next", "reject", "qwen-v2-auto", "Qwen says reject."]]);
    expect(rows.find((finding) => finding.slug === "hide")?.m1Split).toBe(false);
    // 정책 처리의 '엇갈림' 거르기와 수
    const preview = await previewAuditPolicy({ filter: { ...EMPTY_POLICY_FILTER, second: "m1_split" }, action: "keep" });
    expect(preview.matched).toBe(3);
    expect(preview.sample.every((sampled) => sampled.m1Split && sampled.second.every((opinion) => opinion.reason))).toBe(true);
    expect((await screenReviewCounts()).split).toBe(3);
    // 엇갈린 것은 다음 틱에도 다시 묻거나 닫지 않는다
    server.calls.length = 0;
    await tick();
    expect(server.calls).toEqual([]);
    expect(await heldSlugs()).toEqual(["hide"]);
  });
});

describe("보이기·되돌리기", () => {
  it("자동 유지를 되돌리면 유지를 지우고 풀었던 보류를 원래 시각·항목으로 다시 건다 — 자동 숨김을 되돌리면 보류를 풀고 다시 걸지 않는다", async () => {
    await judged([{ repo: "u/keep-low", confidence: 0.6, reason: CONTENT }, { repo: "u/keep-held", confidence: 0.97 },
      { repo: "u/hide", confidence: 0.97, reason: CONTENT }, { repo: "u/hide-low", confidence: 0.6, reason: CONTENT },
      { repo: "u/open", confidence: 0.6, reason: EMPTY }]);
    // 쓸기가 먼저 회사 소개(keep-held)를 건다
    await tick();
    expect(await heldSlugs()).toEqual(["keep-held"]);
    const original = await product("keep-held");
    server.calls.length = 0;
    await db.delete(productAuditSecondOpinions);
    server.answers.set("u/keep-low", { decision: "approve", confidence: 0.95 });
    server.answers.set("u/keep-held", { decision: "approve", confidence: 0.95 });
    server.answers.set("u/hide", { decision: "reject", confidence: 0.95 });
    server.answers.set("u/hide-low", { decision: "reject", confidence: 0.95 });
    await tick();
    expect(await keptSlugs()).toEqual(["keep-held", "keep-low"]);
    expect(await heldSlugs()).toEqual(["hide", "hide-low"]);
    expect((await item("open")).humanDecision).toBeNull();
    const runs = await autoRuns();
    const keepRun = runs.find((run) => run.action === "keep")!;
    const holdRun = runs.find((run) => run.action === "release")!;

    // 자동 실행은 '적용 중' 하나뿐 규칙을 잡지 않는다 — 운영자의 정책 실행을 막지 않는다(판단 보류로 열린 u/open 을 사람이 정책으로 유지)
    const filter = { ...EMPTY_POLICY_FILTER, branches: ["placeholder" as const] };
    const preview = await previewAuditPolicy({ filter, action: "keep" });
    expect(preview.sample.map((row) => row.slug)).toEqual(["open"]);
    const manual = await startAuditPolicyRun({ filter, action: "keep", expected: 1, note: "", keepDays: 90, by: "jr" });
    expect(manual).toMatchObject({ ok: true, planned: 1 });
    expect(await applyAuditPolicyChunk({ runId: (manual as { runId: number }).runId, by: "jr" })).toMatchObject({ status: "applied", applied: 1 });

    const floor = await auditFloor();
    expect(await undoAll(keepRun.id)).toMatchObject({ status: "undone", undone: 2, blocked: 0 });
    // 사람의 정책 유지(u/open)는 그대로
    expect(await keptSlugs()).toEqual(["open"]);
    const restored = await product("keep-held");
    expect(restored.auditHoldItemId).toBe(original.auditHoldItemId);
    expect(restored.auditHoldAt?.getTime()).toBe(original.auditHoldAt?.getTime());
    expect((await item("keep-held")).holdReleasedAt).toBeNull();
    expect(await auditRowsAfter(floor, "audit-policy-undo")).toMatchObject([{ actor: "jr", ok: true,
      detail: { runId: keepRun.id, undone: 2, auto: { action: "keep", by: "qwen-v2-auto" } } }]);
    // 새 판의 답이 와도(글이 바뀌어 다시 물음) 되돌린 항목은 다시 닫지 않는다 — 의견만 적힌다
    expect((await answerDirectly("keep-low", "approve", 0.99, "2026-10-30.v3")).autoClose).toEqual({ kept: 0, held: 0, left: { reverted: 1 } });
    expect(await keptSlugs()).toEqual(["open"]);

    expect(await undoAll(holdRun.id)).toMatchObject({ status: "undone", undone: 2, blocked: 0 });
    expect(await heldSlugs()).toEqual(["keep-held"]);
    // 운영자가 '숨기지 말라'고 정한 것 — 그 제품의 열린 항목에 '풀었음'을 적어 쓸기(0.97 · 두 번째 모델 거절)가 다시 걸지 않는다
    expect((await item("hide")).holdReleasedAt).not.toBeNull();
    const releases = await db.select().from(productEvidenceAudit).where(and(eq(productEvidenceAudit.action, "audit.hold.release"),
      eq(productEvidenceAudit.actor, "jr")));
    expect(releases.map((row) => [row.slug, row.reason]).sort()).toEqual([["hide", "policy_release"], ["hide-low", "policy_release"]]);
    server.calls.length = 0;
    await tick();
    expect(await heldSlugs()).toEqual(["keep-held"]);
    // 위에서 다른 판으로 덮어쓴 keep-low 만 지금 판으로 다시 묻는다(승인) — 되돌린 항목이라 감사 잡의 쓰기도 닫지 않는다
    expect(server.calls).toEqual(["u/keep-low"]);
    // 되돌린 자동 유지는 받아 둔 같은 답으로도(따라잡기) 새 답으로도 다시 닫지 않는다 — 사람이 본다
    expect(await keptSlugs()).toEqual(["open"]);
    expect(await autoCloseToday()).toEqual({ day: utcDay(), kept: 2, held: 2, undone: 4 });
  });

  it("되돌린 그 사이 사람이 정했거나 보류가 바뀐 것은 되돌리지 않고 까닭을 남긴다. 되돌리는 중·뒤의 자동 닫기는 새 실행에 적는다", async () => {
    await judged([{ repo: "b/hide", confidence: 0.6, reason: CONTENT }, { repo: "b/kept-by-human", confidence: 0.6, reason: CONTENT },
      { repo: "b/next", confidence: 0.6, reason: CONTENT }]);
    await answerDirectly("hide", "reject");
    await answerDirectly("kept-by-human", "reject");
    const [run] = await autoRuns();
    // 사람이 그 뒤 유지로 정했다(보류도 풀린다)
    await db.update(productAuditItems).set({ humanDecision: "kept", humanBy: "jr", humanAt: sql`now()`, keepUntil: sql`now() + interval '90 days'` })
      .where(eq(productAuditItems.slug, "kept-by-human"));
    await db.update(products).set({ auditHoldAt: null, auditHoldItemId: null }).where(eq(products.slug, "kept-by-human"));
    expect(await startAuditPolicyUndo({ runId: run.id, by: "jr" })).toMatchObject({ ok: true });
    // 되돌리는 중에 온 자동 숨김은 새 실행에 적힌다
    expect((await answerDirectly("next", "reject")).autoClose).toMatchObject({ held: 1 });
    for (let calls = 0; calls < 10; calls++) if ((await undoAuditPolicyChunk({ runId: run.id, by: "jr" }))!.done) break;
    const items = await runItems(run.id);
    expect(items.map((row) => [row.slug, row.state, row.reason])).toEqual([["hide", "undone", null], ["kept-by-human", "undo_blocked", "decision_changed"]]);
    const runs = await autoRuns();
    expect(runs.map((row) => [row.id === run.id, row.status, row.planned])).toEqual([[true, "undone", 2], [false, "applied", 1]]);
    expect(await heldSlugs()).toEqual(["next"]);
  });
});
