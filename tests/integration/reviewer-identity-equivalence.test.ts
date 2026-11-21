import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, modelCapacityRequests, products, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, getSettings, saveSettings } from "@/lib/crawl/settings";
import { claimAgentReview, listReviewCandidates, loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { judgeRevision } from "@/lib/crawl/rules";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { runJob } from "@/lib/jobs/runner";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { admitSecondReviewFixture, closeSettledSecondReviewsFixture as closeSettledSecondReviews,
  enqueueSecondReviewsFixture as enqueueSecondReviews, recordSecondReviewFixture, withLegacySecondReviewJob } from "./second-review-receipt-fixtures";
import { ensureSchema, resetTables } from "./setup";
import { reviewerProviderKey, reviewerProviderKeySql, reviewerProviderMatchSql, sameReviewerProvider, sameReviewerProviderSql } from "@/lib/crawl/reviewer-identity";

/**
 * 심사자 identity 의 provider 동등 규칙(lib/crawl/reviewer-identity.ts, abcllm 이름표 정리 1단계) — 실제 PostgreSQL 로.
 * 같은 장부 이름 M 의 (abcllm, M) 과 (local-direct, M) 은 같은 심사자다: 계약을 local-direct 로 다시 저장해도 이미 낸 1차·받은 2차 표가 그대로 센다.
 * 그 묶음뿐이다 — 다른 모델·CLI·위임 검수의 기록은 예전처럼 다른 심사자의 것이고, 「1차와 2차는 따로 부른다」도 그대로다.
 */
type Provider = "claude-cli" | "abcllm" | "grok-cli" | "opencode-cli" | "local-direct";
const M = "deepseek-v4.1-flash-1017", V = "qwen-voter-test";

const classify = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: classify,
  classifyCategories: async (inputs: unknown[]) => Promise.all(inputs.map(input => classify(input))),
}));
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: async () => null }));

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  classify.mockReset().mockResolvedValue(null);
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: M } }, "test");
  await saveSettings({ secondReview: { enabled: false } }, "test");
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "reviewer identity" })).toMatchObject({ ok: true });
});

const firstIs = (provider: Provider, model: string) => saveSettings({ firstReview: { provider, model } }, "test");
const votersAre = (...voters: { provider: Provider; model: string }[]) => saveSettings({ secondReview: { enabled: true, voters } }, "test");
const tick = () => runJob("crawl-publish", publishCandidates);
const vote = (row: { id: number; model: string | null }, provider: Provider) => recordSecondReviewFixture(row.id,
  { ok: true, decision: "approve", confidence: 0.9, reason: "Second model reason", model: row.model!, provider, status: "agreed" });

/** 승인 상태의 후보와, 주면 그 심사자가 지금 입력으로 낸 승인 시도 하나. */
async function candidate(index: number, first?: { provider: string; model: string; kind?: "automatic" | "delegated"; actor?: string }) {
  const repo = `identity/product-${index}`, productUrl = `https://identity-${index}.example`;
  const now = new Date(Date.now() - 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now,
    repoMeta: { description: "A useful application" }, pageStatus: 200,
    pageMeta: { title: `Identity ${index}`, description: "An application for daily work" } }).returning();
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: now, updatedAt: new Date(now.getTime() + index),
    signals: { judgedRevision: judgeRevision(document) } }).returning();
  const attempt = first ? await approval(row, document, first) : undefined;
  return { row, document, attempt };
}
async function approval(row: typeof crawlCandidates.$inferSelect, document: typeof crawlDocuments.$inferSelect,
  first: { provider: string; model: string; kind?: "automatic" | "delegated"; actor?: string }, attemptNumber = 1) {
  const input = await loadReviewInput(row, document, await getSettings());
  const now = new Date(Date.now() - 500);
  const [attempt] = await db.insert(crawlReviewAttempts).values({ candidateId: row.id,
    kind: first.kind ?? "automatic", state: "succeeded", inputHash: input.inputHash, policyHash: input.policyHash,
    sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: first.provider, model: first.model, actor: first.actor ?? null, attemptNumber,
    outcome: { decision: "approve", reason: "Product description confirmed", evidenceIds: ["product"], confidence: 0.95 },
    validUntil: input.validUntil, startedAt: now, completedAt: now }).returning();
  return attempt;
}
const published = async () => (await db.select().from(products)).length;
const waitingFirst = async () => (await listReviewCandidates(await getSettings())).map(row => row.id);

// ── (a) 1차: 낸 판단이 이름표가 바뀐 뒤에도 센다 ────────────────────────────────────────────────────────────

it("(abcllm, M) 으로 낸 1차 승인은 심사자가 (local-direct, M) 이 된 뒤에도 유효하다 — 다시 심사하지 않고 발행한다", async () => {
  await candidate(1, { provider: "abcllm", model: M });
  expect(await waitingFirst()).toEqual([]);

  await firstIs("local-direct", M);
  // 재심사 대상이 되지 않는다(대량 재심사 없음) — 발행 조건도 그 승인을 지금 1차 심사자의 것으로 읽는다
  expect(await waitingFirst()).toEqual([]);
  await tick();
  expect(await published()).toBe(1);
  expect(await db.select({ provider: crawlReviewAttempts.provider }).from(crawlReviewAttempts)).toEqual([{ provider: "abcllm" }]);
});

it("되돌리기도 같다 — (local-direct, M) 으로 낸 승인은 심사자가 (abcllm, M) 으로 돌아가도 유효하다", async () => {
  await firstIs("local-direct", M);
  await candidate(2, { provider: "local-direct", model: M });
  await firstIs("abcllm", M);
  expect(await waitingFirst()).toEqual([]);
  await tick();
  expect(await published()).toBe(1);
});

it.each([
  ["다른 모델의 local-direct", "local-direct", "qwen3.8-flash-next"],
  ["같은 이름의 CLI(opencode-cli)", "opencode-cli", M],
  ["같은 이름의 CLI(claude-cli)", "claude-cli", M],
] as const)("%s 심사자에게는 (abcllm, M) 의 승인이 예전처럼 남의 기록이다 — 발행하지 않고 다시 심사한다", async (_name, provider, model) => {
  const { row } = await candidate(3, { provider: "abcllm", model: M });
  await firstIs(provider, model);
  expect(await waitingFirst()).toEqual([row.id]);
  await tick();
  expect(await published()).toBe(0);
});

it("위임 검수의 기록은 같은 모델이어도 1차 심사자의 판단이 아니다 — kind·이름표가 다르다", async () => {
  await firstIs("local-direct", M);
  // DeepSeek 위임(m3-deepseek)·보류 Qwen 재심사(qwen-direct)의 시도 행, 그리고 이름표가 local-direct 인 위임 행(지금은 없는 꼴)도 kind 로 걸러진다
  const a = await candidate(4, { provider: "m3-deepseek", model: M, kind: "delegated", actor: "m3-deepseek:1" });
  const b = await candidate(5, { provider: "qwen-direct", model: M, kind: "delegated", actor: "qwen-v2:test" });
  const c = await candidate(6, { provider: "local-direct", model: M, kind: "delegated", actor: "m3-deepseek:1" });
  expect((await waitingFirst()).sort()).toEqual([a.row.id, b.row.id, c.row.id].sort());
  await tick();
  expect(await published()).toBe(0);
});

it("claim 은 이름표만 바뀐 같은 심사자의 판단을 호출 없이 잇고(semantic_reuse), 다른 심사자면 새로 부른다", async () => {
  const { row, document, attempt } = await candidate(7, { provider: "abcllm", model: M });
  await firstIs("local-direct", M);
  const lease = { name: "crawl-agent-review", token: "identity-owner", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 } });
  const settings = await getSettings();
  const context = { candidate: row, document, settings, lease, input: await loadReviewInput(row, document, settings) };

  const reused = await claimAgentReview({ ...context, provider: "local-direct", model: M });
  if (reused.kind === "skipped") throw new Error(reused.reason);
  // 새 행은 지금 이름표로 남고(receipt·binding 이 그 이름표에 묶인다) 옛 행은 그대로다. 장부 줄에 서지 않는다
  expect(reused).toMatchObject({ kind: "reused", receipt: { origin: "semantic_reuse" },
    attempt: { provider: "local-direct", model: M, reusedFromAttemptId: attempt!.id, outcome: { decision: "approve" } } });
  expect(await db.select().from(modelCapacityRequests)).toHaveLength(0);
  await db.update(crawlReviewAttempts).set({ state: "superseded", errorCode: "cancelled", completedAt: new Date() }).where(eq(crawlReviewAttempts.id, reused.attempt.id));

  await firstIs("claude-cli", M);
  const fresh = await claimAgentReview({ ...context, settings: await getSettings(), provider: "claude-cli", model: M });
  expect(fresh).toMatchObject({ kind: "claimed", attempt: { provider: "claude-cli", reusedFromAttemptId: null, outcome: null } });
});

// ── (b) 2차: 받은 표·아직 보내지 않은 표가 이어진다 ─────────────────────────────────────────────────────────

it("(abcllm, V) 로 받은 2차 승인 표는 투표자가 (local-direct, V) 가 된 뒤에도 그 칸의 표다 — 버리지도 다시 올리지도 않고 발행한다", async () => {
  await votersAre({ provider: "abcllm", model: V });
  await candidate(10, { provider: "abcllm", model: M });
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const [gate] = await db.select().from(secondReviews);
  expect(gate).toMatchObject({ provider: "abcllm", model: V, trigger: "ai_approved", status: "pending" });
  await vote(gate, "abcllm");

  await firstIs("local-direct", M);
  await votersAre({ provider: "local-direct", model: V });
  await closeSettledSecondReviews();
  expect(await db.select().from(secondReviews)).toMatchObject([{ id: gate.id, provider: "abcllm", status: "agreed", resolution: null }]);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
  await tick();
  expect(await published()).toBe(1);
});

it("아직 보내지 않은 2차 표는 지금 이름표로 옮겨 적혀 그대로 불린다", async () => {
  await votersAre({ provider: "abcllm", model: V });
  await candidate(11, { provider: "abcllm", model: M });
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const [gate] = await db.select().from(secondReviews);

  await firstIs("local-direct", M);
  await votersAre({ provider: "local-direct", model: V });
  expect(await closeSettledSecondReviews()).toBe(1);
  expect(await db.select().from(secondReviews)).toMatchObject([{ id: gate.id, provider: "local-direct", model: V, status: "pending", resolution: null }]);
  // 다시 돌아도 더 고칠 것이 없고 새 표도 올리지 않는다
  expect(await closeSettledSecondReviews()).toBe(0);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
  await tick();
  expect(await published()).toBe(0);

  await vote(gate, "local-direct");
  await tick();
  expect(await published()).toBe(1);
});

it.each([
  ["다른 모델의 local-direct", "local-direct", "other-voter-test"],
  ["같은 이름의 CLI(opencode-cli)", "opencode-cli", V],
] as const)("투표자가 %s 로 바뀌면 (abcllm, V) 의 표는 예전처럼 빠진다 — 그 승인으로 발행하지 않는다", async (_name, provider, model) => {
  await votersAre({ provider: "abcllm", model: V });
  await candidate(12, { provider: "abcllm", model: M });
  await enqueueSecondReviews(await getSettings());
  const [gate] = await db.select().from(secondReviews);
  await vote(gate, "abcllm");

  await votersAre({ provider, model });
  // 정리 전에도 발행 조건이 그 표를 세지 않는다
  await tick();
  expect(await published()).toBe(0);
  await closeSettledSecondReviews();
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, gate.id))).toMatchObject([{ provider: "abcllm", status: "resolved", resolution: "model_removed" }]);
  await tick();
  expect(await published()).toBe(0);
});

it("관문 표는 「그 1차 심사자」의 최신 판단에 붙는다 — 이름표만 바뀐 같은 심사자의 더 새 판단이 있으면 옛 판단의 표는 지금 입력이 아니다", async () => {
  await votersAre({ provider: "abcllm", model: V });
  const { row, document } = await candidate(13, { provider: "abcllm", model: M });
  await enqueueSecondReviews(await getSettings());
  const [gate] = await db.select().from(secondReviews);

  await firstIs("local-direct", M);
  const newer = await approval(row, document, { provider: "local-direct", model: M }, 2);
  await expect(withLegacySecondReviewJob(lease => admitSecondReviewFixture(gate.id, lease))).rejects.toThrow("second_review_fixture_admission_input_changed");
  // 새 판단의 관문 표가 따로 올라간다(세대가 다르다)
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  expect(await db.select().from(secondReviews).where(eq(secondReviews.firstAttemptId, newer.id))).toMatchObject([{ trigger: "ai_approved", status: "pending" }]);
});

// ── (c) 독립·별도 호출 규칙은 약해지지 않는다 ───────────────────────────────────────────────────────────────

it("1차와 2차가 같은 엔진이어도 2차는 따로 불러야 한다 — 이름표가 달라 보이는 1차 기록이 2차 표를 대신하지 않는다", async () => {
  // 1차 심사자 (local-direct, M), 2차 투표자 (abcllm, M): 같은 장부 이름의 같은 엔진
  await firstIs("local-direct", M);
  await votersAre({ provider: "abcllm", model: M });
  const { row } = await candidate(20, { provider: "abcllm", model: M });
  await tick();
  expect(await published()).toBe(0);

  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const [gate] = await db.select().from(secondReviews);
  expect(gate).toMatchObject({ candidateId: row.id, provider: "abcllm", model: M, firstModel: M, status: "pending" });
  await tick();
  expect(await published()).toBe(0);

  await vote(gate, "abcllm");
  await tick();
  expect(await published()).toBe(1);
});

it("두 투표자를 세우면 예전처럼 둘 다 승인해야 한다 — 한 투표자의 표가 이름표 묶음으로 다른 칸을 채우지 않는다", async () => {
  await votersAre({ provider: "abcllm", model: V }, { provider: "local-direct", model: "other-voter-test" });
  await candidate(21, { provider: "abcllm", model: M });
  expect(await enqueueSecondReviews(await getSettings())).toBe(2);
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map(row => [row.provider, row.model])).toEqual([["abcllm", V], ["local-direct", "other-voter-test"]]);
  await vote(rows[0], "abcllm");
  await tick();
  expect(await published()).toBe(0);
  await vote(rows[1], "local-direct");
  await tick();
  expect(await published()).toBe(1);
});

// ── (d) local-direct 1차의 판단에 2차가 붙는다(TS·SQL 같은 규칙) ────────────────────────────────────────────

it("(local-direct, M) 1차의 승인에 관문 표가 올라가고, 입력 로더가 그 1차 판단을 찾아 표를 받는다", async () => {
  await firstIs("local-direct", M);
  await votersAre({ provider: "abcllm", model: V });
  const { attempt } = await candidate(30, { provider: "local-direct", model: M });
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const [gate] = await db.select().from(secondReviews);
  expect(gate).toMatchObject({ firstAttemptId: attempt!.id, firstModel: M, trigger: "ai_approved" });
  // 로더(secondReviewInputContext 의 1차 질의)가 local-direct 1차를 찾지 못하면 여기서 input_changed 로 거절된다
  await vote(gate, "abcllm");
  await tick();
  expect(await published()).toBe(1);
});

// ── SQL 조각 자체: TS 규칙과 같은 답 ────────────────────────────────────────────────────────────────────────

it("provider 견줌 SQL 은 실제 PostgreSQL 에서 TS 규칙과 같은 답을 낸다 — NULL 은 어느 것과도 같지 않다", async () => {
  const pairs: [string | null, string | null][] = [["abcllm", "local-direct"], ["local-direct", "abcllm"], ["abcllm", "abcllm"], ["claude-cli", "claude-cli"],
    ["abcllm", "claude-cli"], ["local-direct", "opencode-cli"], ["grok-cli", "opencode-cli"], ["local-direct", "qwen-direct"], ["m3-deepseek", "abcllm"],
    [null, "abcllm"], ["local-direct", null], [null, null]];
  for (const [a, b] of pairs) {
    const [row] = await db.execute<{ same: boolean | null; key: string | null; direct: boolean | null; cli: boolean | null }>(sql`
      SELECT ${sameReviewerProviderSql(sql`t.a`, sql`t.b`)} AS same, ${reviewerProviderKeySql(sql`t.a`)} AS key,
        ${reviewerProviderMatchSql(sql`t.a`, "local-direct")} AS direct, ${reviewerProviderMatchSql(sql`t.a`, "claude-cli")} AS cli
      FROM (SELECT ${a}::varchar(80) AS a, ${b}::varchar(80) AS b) t`);
    expect([a, b, row.same ?? false]).toEqual([a, b, sameReviewerProvider(a, b)]);
    expect(row.key).toBe(a === null ? null : reviewerProviderKey(a));
    expect(row.direct ?? false).toBe(sameReviewerProvider(a, "local-direct"));
    expect(row.cli ?? false).toBe(a === "claude-cli");
  }
});
