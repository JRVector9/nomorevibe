import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, products, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, getSettings, saveSettings, setHeldQwenRetry, setHumanReviewEnabled } from "@/lib/crawl/settings";
import { loadReviewInput, reviewApprovalPredicate } from "@/lib/crawl/agent-review-repository";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { judgeRevision } from "@/lib/crawl/rules";
import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { reviewHumanQueue } from "@/lib/crawl/jobs/human-review";
import { claimHumanReview, humanReviewRepos } from "@/lib/crawl/human-review-repository";
import { heldQwenBadges, heldQwenRetryStatus, runHeldQwenRetry } from "@/lib/crawl/held-qwen-retry";
import { heldQwenOwnedReasons } from "@/lib/crawl/held-qwen-retry-policy";
import { QWEN_V2_ADDENDUM, QWEN_V2_PROMPT_VERSION } from "@/lib/crawl/qwen-direct-review";
import { qwenEndpointBackingOff, qwenEndpointBackoff, resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { DEFAULT_HELD_QWEN_RETRY } from "@/lib/crawl/settings-schema";
import { enqueueSecondReviewsFixture as enqueueSecondReviews, recordSecondReviewFixture } from "./second-review-receipt-fixtures";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

const classify = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: classify,
  classifyCategories: async (inputs: unknown[]) => Promise.all(inputs.map(input => classify(input))),
}));
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: async () => null }));

/**
 * 가짜 gpu3090 — 실제 HTTP 서버다(AUDIT_SECOND_OPINION_URL 로 가리킨다). 답은 차례로 꺼낸다. 비면 needs_review 를 돌려준다.
 */
type Reply = { status?: number; outcome?: Record<string, unknown>; raw?: string };
const replies: Reply[] = [];
const requests: { url: string; body: { model: string; messages: { role: string; content: string }[] } }[] = [];
let server: Server;
function reply(...values: Reply[]) { replies.push(...values); }
const outcome = (decision: "approve" | "reject" | "needs_review", confidence = 0.97): Reply =>
  ({ outcome: { decision, reason: `Qwen says ${decision}`, evidenceIds: ["product"], confidence } });

beforeAll(async () => {
  ensureSchema();
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body: JSON.parse(text) });
      const next = replies.shift() ?? outcome("needs_review", 0.5);
      response.writeHead(next.status ?? 200, { "content-type": "application/json" });
      response.end(next.raw ?? JSON.stringify({ model: "qwen3.8-flash-next", choices: [{ finish_reason: "stop",
        message: { content: JSON.stringify(next.outcome ?? {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterAll(async () => {
  // 다음 파일이 빈 후보·2차 표 기준선에서 시작하게 남긴 행을 지운다(시도 행은 후보와 함께 지워진다)
  await db.delete(secondReviews); await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const QWEN_VOTER = { provider: "abcllm" as const, model: "[gpu3090] qwen3.8-flash-next" };
const OTHER_VOTER = { provider: "abcllm" as const, model: "[MLX] second-test" };

beforeEach(async () => {
  await db.delete(secondReviews);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  replies.length = 0;
  requests.length = 0;
  resetQwenAuditBackoff();
  classify.mockReset().mockResolvedValue(null);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  vi.stubEnv("CRAWL_REVIEW_MODEL", "test-model");
  vi.stubEnv("AUDIT_SECOND_OPINION_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  vi.stubEnv("AUDIT_SECOND_OPINION_MODEL", "");
  await saveSettings({ enabled: true, secondReview: { enabled: true, voters: [QWEN_VOTER, OTHER_VOTER], sampleRate: 0, agreeAt: 0.85, includeAiHeld: false } }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "held qwen test" })).toMatchObject({ ok: true });
});

/** 보류 후보 한 건 — 원본은 신선하고 소개가 있다 */
async function held(index: number, reason: "no_description" | "ai_review_exhausted" | "ambiguous" | "second_review_split" = "ai_review_exhausted") {
  const repo = `held/product-${index}`, productUrl = `https://held-${index}.example`;
  const now = new Date(Date.now() - 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now,
    repoMeta: { description: "A useful application" }, pageStatus: 200,
    pageMeta: { title: `Held ${index}`, description: "An application for daily work" } }).returning();
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "needs_review", reason, decidedBy: "auto",
    judgedAt: now, updatedAt: new Date(now.getTime() + index), signals: { judgedRevision: judgeRevision(document),
      stoppedAt: { rule: "AI 1차 심사", detail: "held" } } }).returning();
  return { row, document };
}

/** 1차가 이 입력에서 판단 보류를 냈다 — 1차가 다시 볼 것이 아니다 */
async function firstAbstained(candidate: typeof crawlCandidates.$inferSelect, document: typeof crawlDocuments.$inferSelect) {
  const input = await loadReviewInput(candidate, document, await getSettings());
  await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded",
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot,
    source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "claude-cli",
    model: "test-model", attemptNumber: 1, outcome: { decision: "needs_review", reason: "unclear", evidenceIds: ["product"], confidence: 0.5 },
    validUntil: input.validUntil, startedAt: new Date(), completedAt: new Date() });
}

const tick = () => runJob("human-deepseek-review", reviewHumanQueue);
const publish = () => runJob("crawl-publish", publishCandidates);
const candidateRow = async (id: number) => (await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, id)))[0];
const qwenAttempts = (candidateId?: number) => db.select().from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.provider, "qwen-direct"),
  candidateId ? eq(crawlReviewAttempts.candidateId, candidateId) : undefined)).orderBy(crawlReviewAttempts.id);
const vote = (row: { id: number; model: string | null }, decision: "approve" | "reject") =>
  recordSecondReviewFixture(row.id, { ok: true, decision, confidence: 0.9, reason: "Second model", model: row.model!, provider: "abcllm", status: "agreed" });

/** 잡 lease 로 저장소 함수를 부른다 — 실제 runner 가 준 lease 다 */
async function withHumanJob<T>(load: (lease: JobLease) => Promise<T>): Promise<T> {
  let value!: T;
  const result = await runJob<null>("human-deepseek-review", async ctx => { value = await load(ctx.lease!); return { done: true }; });
  if (result.status !== "completed") throw new Error(`human_job_${result.status}`);
  return value;
}

describe("보류 Qwen-v2 재심사", () => {
  it("거부하면 DeepSeek 위임과 같은 기록으로 끝낸다 — 시도 행·운영 감사·decided_by qwen-v2", async () => {
    const floor = await auditFloor();
    const { row } = await held(0);
    reply(outcome("reject", 0.97));
    expect(await tick()).toMatchObject({ status: "completed" });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/v1/chat/completions");
    expect(requests[0].body.model).toBe("qwen3.8-flash-next");
    expect(requests[0].body.messages[0].content.endsWith(QWEN_V2_ADDENDUM)).toBe(true);
    expect(await candidateRow(row.id)).toMatchObject({ state: "rejected", reason: "not_a_product", decidedBy: "qwen-v2",
      signals: { heldQwenPreviousReason: "ai_review_exhausted", stoppedAt: { rule: "Qwen-v2 심사" } } });
    const [attempt] = await qwenAttempts(row.id);
    expect(attempt).toMatchObject({ kind: "delegated", state: "succeeded", actor: `qwen-v2:${QWEN_V2_PROMPT_VERSION}`,
      model: "qwen3.8-flash-next", promptVersion: REVIEW_PROMPT_VERSION, outcome: { decision: "reject" } });
    expect((await candidateRow(row.id)).signals?.heldQwenAttemptId).toBe(attempt.id);
    const [audit] = await auditRowsAfter(floor, "candidate-qwen-held-review");
    expect(audit).toMatchObject({ actor: "qwen-v2", actorKind: "model", target: row.repo,
      detail: { attemptId: attempt.id, result: "rejected", model: "qwen3.8-flash-next", promptVersion: QWEN_V2_PROMPT_VERSION } });
    // 사람 결정(admin_override)으로 남지 않는다
    expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.kind, "admin_override"))).toHaveLength(0);
  });

  it("승인하면 1차 승인처럼 자동 경로로 되돌리고, 두 모델 관문을 그대로 지나야 발행된다", async () => {
    const { row } = await held(0);
    reply(outcome("approve", 0.95));
    await tick();
    const back = await candidateRow(row.id);
    expect(back).toMatchObject({ state: "approved", reason: "passed", decidedBy: "auto" });
    expect(back.signals?.stoppedAt).toBeUndefined();
    const [attempt] = await qwenAttempts(row.id);
    expect((await db.select().from(jobs).where(eq(jobs.name, "second-review")))[0]?.requestedVersion).toBeGreaterThan(0);

    // 2차 전에는 발행하지 않는다
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
    expect(await enqueueSecondReviews(await getSettings())).toBe(2);
    const gates = await db.select().from(secondReviews).orderBy(secondReviews.id);
    expect(gates.map((gate) => gate.model).sort()).toEqual([OTHER_VOTER.model, QWEN_VOTER.model].sort());
    expect(gates.every((gate) => gate.trigger === "ai_approved" && gate.firstAttemptId === attempt.id && gate.firstModel === "qwen3.8-flash-next")).toBe(true);

    // 같은 Qwen(게이트웨이 이름)의 승인만으로는 열리지 않는다 — 독립 투표자(second-test)의 승인이 있어야 한다
    await vote(gates.find((gate) => gate.model === QWEN_VOTER.model)!, "approve");
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
    await vote(gates.find((gate) => gate.model === OTHER_VOTER.model)!, "approve");
    await publish();
    expect(await db.select().from(products)).toHaveLength(1);
    expect(await candidateRow(row.id)).toMatchObject({ state: "published" });
  });

  it("관문에 든 뒤 독립 투표자를 빼면 같은 Qwen 의 승인만으로는 발행하지 않는다 — Qwen-v2 승인도 1차 승인으로 받지 않는다", async () => {
    const { row } = await held(0);
    reply(outcome("approve", 0.95));
    await tick();
    expect(await candidateRow(row.id)).toMatchObject({ state: "approved", reason: "passed" });
    await enqueueSecondReviews(await getSettings());
    const gates = await db.select().from(secondReviews).orderBy(secondReviews.id);
    await vote(gates.find((gate) => gate.model === QWEN_VOTER.model)!, "approve");
    await vote(gates.find((gate) => gate.model === OTHER_VOTER.model)!, "approve");
    // 두 표가 모두 승인한 뒤 독립 투표자(second-test)를 빼고 같은 Qwen(게이트웨이 이름)만 남긴다 — 남은 승인은 Qwen-v2 와 같은 모델뿐이다
    await saveSettings({ secondReview: { enabled: true, voters: [QWEN_VOTER] } }, "test");
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
    expect((await candidateRow(row.id)).state).not.toBe("published");
    // 독립 투표자를 되돌리면 그 승인으로 발행된다 — 막은 것은 같은 모델 규칙이다
    await saveSettings({ secondReview: { enabled: true, voters: [QWEN_VOTER, OTHER_VOTER] } }, "test");
    await publish();
    expect(await db.select().from(products)).toHaveLength(1);
  });

  it("독립 2차 투표자가 반대하면 관문에서 멈춘다 — 발행하지 않는다", async () => {
    const { row } = await held(0);
    reply(outcome("approve", 0.95));
    await tick();
    await enqueueSecondReviews(await getSettings());
    const gates = await db.select().from(secondReviews);
    await vote(gates.find((gate) => gate.model === OTHER_VOTER.model)!, "reject");
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
    expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
  });

  it("투표자가 같은 Qwen 뿐이면 관문에 넣지 않고 사람에게 «승인 의견»으로 둔다 — 독립 투표자가 생기면 다시 부르지 않고 넣는다", async () => {
    const floor = await auditFloor();
    await saveSettings({ secondReview: { enabled: true, voters: [QWEN_VOTER] } }, "test");
    const { row } = await held(0);
    reply(outcome("approve", 0.95));
    await tick();
    expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "ai_review_exhausted", decidedBy: "auto" });
    const [audit] = await auditRowsAfter(floor, "candidate-qwen-held-review");
    expect(audit.detail).toMatchObject({ result: "held", cause: "no_independent_voter" });
    const input = await loadReviewInput(await candidateRow(row.id), (await db.select().from(crawlDocuments))[0], await getSettings());
    const badges = await heldQwenBadges([{ candidateId: row.id, reason: "ai_review_exhausted", inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash }]);
    expect(badges[row.id]).toMatchObject({ label: "Qwen-v2: 승인 의견" });
    // 관문도 이 승인을 1차 승인으로 받지 않는다
    expect(await enqueueSecondReviews(await getSettings())).toBe(0);

    await saveSettings({ secondReview: { enabled: true, voters: [QWEN_VOTER, OTHER_VOTER] } }, "test");
    await tick();
    expect(requests).toHaveLength(1);
    expect(await candidateRow(row.id)).toMatchObject({ state: "approved", reason: "passed" });
    expect(await qwenAttempts(row.id)).toHaveLength(1);
  });

  it("소개 없음은 승인해도 발행에서 같은 자리로 돌아오므로 되돌리지 않고 «승인 의견»으로 둔다", async () => {
    const floor = await auditFloor();
    const { row } = await held(0, "no_description");
    reply(outcome("approve", 0.97));
    await tick();
    expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "no_description" });
    expect((await auditRowsAfter(floor, "candidate-qwen-held-review"))[0].detail).toMatchObject({ result: "held", cause: "no_description" });
    // 다음 틱에도 다시 묻지 않는다
    await tick();
    expect(requests).toHaveLength(1);
  });

  it("판단 보류·낮은 확신은 사람 큐에 «Qwen-v2: 판단 보류»로 남는다", async () => {
    const one = await held(0), two = await held(1);
    reply(outcome("needs_review", 0.6), outcome("reject", 0.6));
    await tick();
    expect(requests).toHaveLength(2);
    for (const { row, document } of [one, two]) {
      const current = await candidateRow(row.id);
      expect(current).toMatchObject({ state: "needs_review", reason: "ai_review_exhausted", decidedBy: "auto" });
      const input = await loadReviewInput(current, document, await getSettings());
      const badges = await heldQwenBadges([{ candidateId: row.id, reason: current.reason, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash }]);
      expect(badges[row.id]).toMatchObject({ label: "Qwen-v2: 판단 보류" });
    }
    const [lowConfidence] = await qwenAttempts(two.row.id);
    expect(lowConfidence.outcome).toMatchObject({ decision: "needs_review" });
  });

  it("같은 입력 세대는 한 번만 묻는다", async () => {
    await held(0);
    reply(outcome("needs_review", 0.8));
    await tick();
    await tick();
    expect(requests).toHaveLength(1);
    expect(await qwenAttempts()).toHaveLength(1);
  });

  it("스위치를 끄면 부르지 않고, 진행 중 결과도 적용하지 않으며, 관문도 그 승인을 받지 않는다", async () => {
    const { row } = await held(0);
    const current = (await getSettings()).review.qwenHeldRetry;
    expect(await setHeldQwenRetry({ next: { ...current, enabled: false }, expected: current, actor: "test" })).toMatchObject({ ok: true });
    await tick();
    expect(requests).toHaveLength(0);
    expect(heldQwenOwnedReasons(await getSettings())).toEqual([]);

    // 켜서 승인을 넣은 뒤 다시 끄면 발행 조건이 그 승인을 받지 않는다
    const off = (await getSettings()).review.qwenHeldRetry;
    await setHeldQwenRetry({ next: { ...off, enabled: true }, expected: off, actor: "test" });
    reply(outcome("approve", 0.95));
    await tick();
    expect(await candidateRow(row.id)).toMatchObject({ state: "approved" });
    await enqueueSecondReviews(await getSettings());
    for (const gate of await db.select().from(secondReviews)) await vote(gate, "approve");
    const on = (await getSettings()).review.qwenHeldRetry;
    await setHeldQwenRetry({ next: { ...on, enabled: false }, expected: on, actor: "test" });
    const approvable = await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(reviewApprovalPredicate(await getSettings()));
    expect(approvable).toHaveLength(0);
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
  });

  it("스위치는 화면이 본 값과 같을 때만 바뀌고, 크롤 설정 폼은 바꾸지 못하며, 깨진 값은 꺼짐으로 읽는다", async () => {
    const current = (await getSettings()).review.qwenHeldRetry;
    expect(current).toEqual(DEFAULT_HELD_QWEN_RETRY);
    expect(await setHeldQwenRetry({ next: { ...current, perTick: 3 }, expected: { ...current, perTick: 7 }, actor: "test" }))
      .toMatchObject({ ok: false });
    await saveSettings({ review: { qwenHeldRetry: { ...current, enabled: false } } }, "test");
    expect((await getSettings()).review.qwenHeldRetry.enabled).toBe(true);
    const [row] = await db.select().from(crawlSettings);
    await db.update(crawlSettings).set({ values: { ...row.values, review: { qwenHeldRetry: { enabled: "yes", perTick: 10 } } } });
    expect((await getSettings()).review.qwenHeldRetry.enabled).toBe(false);
  });

  it("부르는 곳이 탈 나면 이 틱의 나머지를 부르지 않고 물러나며, 15분 뒤 다시 본다 — 형식 오류는 다음 후보로 넘어간다", async () => {
    await held(0); await held(1); await held(2);
    reply({ status: 503 });
    await tick();
    expect(requests).toHaveLength(1);
    const [failed] = await qwenAttempts();
    expect(failed).toMatchObject({ state: "failed", errorCode: "qwen_http_503" });
    expect(failed.retryAfter!.getTime() - failed.completedAt!.getTime()).toBeGreaterThanOrEqual(14 * 60_000);
    // gpu3090 을 부르는 모두가 함께 물러난다(qwen-endpoint-backoff.ts). 웹 화면은 이 재심사의 행으로 어림해 보인다
    expect(qwenEndpointBackingOff()).toBe(true);
    expect(qwenEndpointBackoff).toMatchObject({ failures: 1, lastError: "qwen_http_503" });
    const status = await heldQwenRetryStatus(await getSettings());
    expect(status.backoffUntil).not.toBeNull();
    expect(status.lastError).toMatchObject({ code: "qwen_http_503" });
    await tick();
    expect(requests).toHaveLength(1);

    // 물러남이 끝난 뒤: 형식 오류는 그 후보만의 실패라 다음 후보를 계속 본다
    resetQwenAuditBackoff();
    await db.update(crawlReviewAttempts).set({ completedAt: new Date(Date.now() - 3 * 60_000) }).where(eq(crawlReviewAttempts.id, failed.id));
    reply({ raw: "not json" }, outcome("reject", 0.95));
    await tick();
    expect(requests).toHaveLength(3);
    const states = (await qwenAttempts()).map((row) => row.state === "failed" ? row.errorCode : row.state);
    expect(states).toEqual(["qwen_http_503", "qwen_invalid_json", "succeeded"]);
  });

  it("DeepSeek 위임은 Qwen-v2 가 맡은 사유를 집지 않는다 — 끄면 다시 DeepSeek 몫이고, DeepSeek 이 보는 동안 Qwen-v2 는 비킨다", async () => {
    const exhausted = await held(0);
    const split = await held(1, "second_review_split");
    const settings = await getSettings();
    expect(await setHumanReviewEnabled({ enabled: true, expectedGeneration: settings.humanReview.generation, actor: "test" })).toMatchObject({ ok: true });
    expect(await humanReviewRepos([exhausted.row.id, split.row.id], heldQwenOwnedReasons(await getSettings()))).toEqual([split.row.repo]);
    expect(await withHumanJob(lease => claimHumanReview(exhausted.row.repo, lease))).toBeNull();

    const current = (await getSettings()).review.qwenHeldRetry;
    await setHeldQwenRetry({ next: { ...current, enabled: false }, expected: current, actor: "test" });
    expect(await humanReviewRepos([exhausted.row.id], heldQwenOwnedReasons(await getSettings()))).toEqual([exhausted.row.repo]);
    const claim = await withHumanJob(lease => claimHumanReview(exhausted.row.repo, lease));
    expect(claim).not.toBeNull();

    // DeepSeek 이 보는 중(진행 중 행)에 Qwen-v2 를 다시 켜도 같은 후보를 집지 않는다 — 한 후보에 진행 중 시도는 하나다
    const off = (await getSettings()).review.qwenHeldRetry;
    await setHeldQwenRetry({ next: { ...off, enabled: true }, expected: off, actor: "test" });
    reply(outcome("reject", 0.99));
    const result = await withHumanJob(async lease => runHeldQwenRetry({ lease, hasBudget: () => true, log: () => {} }, await getSettings()));
    expect(result.started).toBe(0);
    expect(requests).toHaveLength(0);
    expect(await candidateRow(exhausted.row.id)).toMatchObject({ state: "needs_review", decidedBy: "auto" });
  });

  it("같은 qwen-direct 를 쓰는 다른 일(2차 갈림 판가름 등)의 진행 중 행은 주인 없음으로 닫지 않는다 — 우리 것만 닫는다", async () => {
    const other = await held(0, "second_review_split"), ours = await held(1, "no_description");
    const old = new Date(Date.now() - 10 * 60_000);
    const row = async (candidate: typeof crawlCandidates.$inferSelect, document: typeof crawlDocuments.$inferSelect, actor: string) => {
      const input = await loadReviewInput(candidate, document, await getSettings());
      const [inserted] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "delegated", state: "running",
        inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot,
        source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "qwen-direct",
        model: "qwen3.8-flash-next", actor, attemptNumber: 1, leaseToken: "someone-else", validUntil: input.validUntil, startedAt: old }).returning();
      return inserted;
    };
    const foreign = await row(other.row, other.document, "qwen-v2-auto");
    const lost = await row(ours.row, ours.document, `qwen-v2:${QWEN_V2_PROMPT_VERSION}`);
    reply(outcome("needs_review", 0.5));
    await tick();
    const states = new Map((await qwenAttempts()).map((attempt) => [attempt.id, [attempt.state, attempt.errorCode]]));
    expect(states.get(foreign.id)).toEqual(["running", null]);
    expect(states.get(lost.id)).toEqual(["failed", "owner_lost"]);
    // 주인 없음은 세 번에 세지 않는다 — 바로 다시 본다
    expect(requests).toHaveLength(1);
  });

  it("판단 보류(ambiguous)는 1차가 이 입력에서 판단 보류를 낸 뒤에만 본다", async () => {
    const { row, document } = await held(0, "ambiguous");
    await tick();
    expect(requests).toHaveLength(0);
    await firstAbstained(row, document);
    reply(outcome("reject", 0.95));
    await tick();
    expect(requests).toHaveLength(1);
    expect(await candidateRow(row.id)).toMatchObject({ state: "rejected", decidedBy: "qwen-v2" });
  });

  it("원본이 24시간 지나 입력이 만료된 보류는 원본을 다시 받게 한다 — 하루 안에 받은 것·이 원본으로 이미 판단한 것은 다시 받지 않는다", async () => {
    const stale = new Date(Date.now() - 25 * 3600_000);
    const due = await held(0), recent = await held(1), judged = await held(2);
    for (const { document } of [due, recent, judged]) await db.update(crawlDocuments).set({ fetchedAt: stale }).where(eq(crawlDocuments.id, document.id));
    await db.insert(crawlFrontier).values([
      { repo: due.row.repo, signal: "test", state: "done", updatedAt: stale },
      { repo: recent.row.repo, signal: "test", state: "done", updatedAt: new Date(Date.now() - 3600_000) },
      { repo: judged.row.repo, signal: "test", state: "done", updatedAt: stale },
    ]);
    // judged: 이 원본으로 Qwen-v2 가 판단 보류를 냈다
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.id, judged.document.id));
    const input = await loadReviewInput(judged.row, document, await getSettings());
    await db.insert(crawlReviewAttempts).values({ candidateId: judged.row.id, kind: "delegated", state: "succeeded", inputHash: input.inputHash,
      policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "qwen-direct", model: "qwen3.8-flash-next",
      actor: `qwen-v2:${QWEN_V2_PROMPT_VERSION}`, attemptNumber: 1, validUntil: input.validUntil,
      outcome: { decision: "needs_review", reason: "unclear", evidenceIds: [], confidence: 0.4 }, completedAt: new Date() });

    await tick();
    expect(requests).toHaveLength(0);
    const frontiers = await db.select().from(crawlFrontier).orderBy(crawlFrontier.repo);
    expect(frontiers.map((row) => [row.repo, row.state])).toEqual([[due.row.repo, "pending"], [recent.row.repo, "done"], [judged.row.repo, "done"]]);
    expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-fetch")))[0]?.requestedVersion).toBeGreaterThan(0);
    // 후보는 그대로 사람 큐에 있다 — 새 원본이 오면 그 입력으로 다시 본다
    expect(await candidateRow(due.row.id)).toMatchObject({ state: "needs_review", reason: "ai_review_exhausted" });
    const status = await heldQwenRetryStatus(await getSettings());
    expect(status).toMatchObject({ waiting: 3, expired: 3 });
  });

  it("상태 칸이 처리·복귀·거부·사람 몫을 센다", async () => {
    const before = await heldQwenRetryStatus(await getSettings());
    await held(0); await held(1); await held(2, "no_description");
    reply(outcome("reject", 0.95), outcome("approve", 0.95), outcome("needs_review", 0.5));
    await tick();
    const after = await heldQwenRetryStatus(await getSettings());
    expect(after.day.processed - before.day.processed).toBe(3);
    expect(after.day.rejected - before.day.rejected).toBe(1);
    expect(after.day.pipeline - before.day.pipeline).toBe(1);
    expect(after.day.held - before.day.held).toBe(1);
    expect(after).toMatchObject({ enabled: true, model: "qwen3.8-flash-next", configured: true, waiting: 1, expired: 0 });
  });
});
