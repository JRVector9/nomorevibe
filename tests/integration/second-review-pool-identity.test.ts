import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, jobs, secondReviews, secondReviewWorkloadAssignments, type SecondReview } from "@/lib/db/schema";

/**
 * 2차 「동시에」(투표자 1 의 작업 분산) 모드의 심사자 identity 동등 규칙(reviewer-identity.ts, #1011) — 실제 PostgreSQL 로. 1단계 리뷰의 시험 공백 ①:
 * 바뀐 SQL 세 조각(secondReviewPoolRootMembershipSql·secondReviewPoolMembershipSql·secondReviewPoolApprovedSql)을 실제 행에 돌려 TS 회원 자격과 같은 답인지,
 * 그리고 정리(closeSettledSecondReviews)가 「동시에」 모드에서도 아직 보내지 않은 표를 지금 구성원의 이름표로 옮기는지 본다.
 * 순위·구성원 묶기만 고정한다(tests/second-review-workload-identity.test.ts 와 같은 모형) — 표·배정 행·SQL·정리 TX 는 실제다. 운영 값이 아니다.
 */
const MEMBER = "0b0c0d0e-0000-4000-8000-00000000c0c0", OTHER = "0b0c0d0e-0000-4000-8000-00000000d0d0";
const pool = vi.hoisted(() => ({ providers: {} as Record<string, string>, legacyModels: [] as string[] }));
const binding = (model: string) => ({ routeId: "second-review", provider: pool.providers[model] ?? "abcllm", identity: model, engineModel: model,
  connectionId: "c", deviceId: "gpu" });
const member = (memberId: string, model: string, position: number) => ({ memberId, position, connectionId: `0b0c0d0e-0000-4000-8000-00000000000${position}`,
  model, options: {}, canonicalModel: model, deviceId: "gpu", engineKey: "e".repeat(64), maxSlots: null, connection: {} });
const members = [member(MEMBER, "qwen-next", 1), member(OTHER, "deepseek-flash", 2)];
const config = { task: "second-review", slot: 1, mode: "workload_pool", revision: 3, updatedAt: null, reserveRanks: false, members };

vi.mock("@/lib/llm/ai-task-resolver", async load => ({
  ...await load<typeof import("@/lib/llm/ai-task-resolver")>(),
  taskModels: (_task: string, slot: number) => slot === 1
    ? pool.legacyModels.map((model, index) => ({ task: "second-review", slot: 1, rank: index + 1, model, enabled: true, options: {}, connection: {} })) : [],
}));
vi.mock("@/lib/crawl/review-task-ranks", async load => ({
  ...await load<typeof import("@/lib/crawl/review-task-ranks")>(),
  settingsReviewersActive: () => false, reviewTaskRanksPinned: () => false, reviewRouteContracts: () => [],
  bindReviewTaskRank: (_task: string, rank: { model: string }) => ({ rank, unusable: null, detail: null, binding: binding(rank.model) }),
  resolveReviewTaskRanks: (_task: string, slot = 1) => ({ task: "second-review", slot, routeId: "second-review", status: "ok",
    execution: slot === 1 ? config : undefined,
    candidates: slot === 1 ? members.map(entry => ({ rank: { rank: entry.position }, unusable: null, detail: null, poolMember: entry, binding: binding(entry.model) })) : [] }),
}));
import { secondReviewPoolApprovedSql, secondReviewPoolMembershipSql, secondReviewPoolRootMembershipSql, secondReviewWorkloadMembership } from "@/lib/crawl/second-review-workload";
import { setAiTaskExecutionConfigsForTest } from "@/lib/llm/ai-task-execution-snapshot";
import type { AiTaskExecutionConfig } from "@/lib/llm/ai-task-execution-config";
import * as crawl from "@/lib/crawl/repository";
import { closeSettledSecondReviewsFixture } from "./second-review-receipt-fixtures";
import { ensureSchema } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(jobs);
  pool.providers = {};
  pool.legacyModels = ["legacy-voter", "legacy-fallback"];
  setAiTaskExecutionConfigsForTest([config as unknown as AiTaskExecutionConfig]);
});

let serial = 0;
async function candidate() {
  const repo = `pool-identity/app-${++serial}`;
  await crawl.putDocument({ repo, productUrl: `https://pool-identity-${serial}.test`, repoMeta: { description: "A deployed product" },
    pageStatus: 200, pageMeta: { title: "Product", description: "An app" } });
  await crawl.recordJudgement({ repo, productUrl: `https://pool-identity-${serial}.test`, state: "approved", reason: "passed", decidedBy: "auto" });
  return (await crawl.getCandidate(repo))!;
}
type VoteInput = Partial<typeof secondReviews.$inferInsert> & { provider: string; model: string };
async function vote(owner: { id: number; repo: string }, value: VoteInput, assignment?: { memberId: string; canonicalModel: string }): Promise<SecondReview> {
  const [row] = await db.insert(secondReviews).values({ candidateId: owner.id, repo: owner.repo, trigger: "ai_approved", firstDecision: "approve",
    firstModel: "first", firstAttemptId: 7_000 + owner.id, inputHash: "i".repeat(64), generationKey: "g".repeat(64), ...value }).returning();
  if (assignment) await db.insert(secondReviewWorkloadAssignments).values({ secondReviewId: row.id, taskSlot: 1, configRevision: 3, ...assignment });
  return row;
}
const assignmentOf = async (id: number) => (await db.select().from(secondReviewWorkloadAssignments).where(eq(secondReviewWorkloadAssignments.secondReviewId, id)))[0];
/** SQL 회원 자격이 고른 표 id — 실제 PostgreSQL */
async function sqlMembers(kind: "root" | "chain"): Promise<number[]> {
  const predicate = kind === "root" ? secondReviewPoolRootMembershipSql(sql`second_reviews`) : secondReviewPoolMembershipSql(sql`second_reviews`);
  const rows = await db.execute<{ id: number }>(sql`SELECT id FROM second_reviews WHERE ${predicate} ORDER BY id`);
  return rows.map(row => Number(row.id));
}
/** TS 회원 자격이 고른 표 id — 대체 표는 그 첫 표의 배정으로 본다(second-review.ts 와 같다) */
async function tsMembers(kind: "root" | "chain"): Promise<number[]> {
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  const picked: number[] = [];
  for (const row of rows) {
    if (kind === "root" && row.fallbackForId !== null) continue;
    if (secondReviewWorkloadMembership(row, await assignmentOf(row.fallbackForId ?? row.id))) picked.push(row.id);
  }
  return picked;
}

describe("「동시에」 회원 자격 SQL 은 실제 PostgreSQL 에서 TS 와 같은 답이고, abcllm ↔ local-direct 를 같은 심사자로 본다", () => {
  it("배정된 첫 표·배정 없는 첫 표(저장된 1순위)", async () => {
    const a = await candidate();
    const assigned = await vote(a, { provider: "abcllm", model: "qwen-next" }, { memberId: MEMBER, canonicalModel: "qwen-next" });
    const relabelled = await vote(await candidate(), { provider: "local-direct", model: "qwen-next" }, { memberId: MEMBER, canonicalModel: "qwen-next" });
    const otherMember = await vote(await candidate(), { provider: "abcllm", model: "qwen-next" }, { memberId: OTHER, canonicalModel: "deepseek-flash" });
    const otherName = await vote(await candidate(), { provider: "abcllm", model: "[MLX] qwen-next" }, { memberId: MEMBER, canonicalModel: "qwen-next" });
    const legacy = await vote(await candidate(), { provider: "abcllm", model: "legacy-voter" });
    const legacyCli = await vote(await candidate(), { provider: "claude-cli", model: "legacy-voter" });

    // 구성원·저장된 1순위의 계약을 local-direct 로 다시 저장했다 — abcllm 으로 올린 표도 그 자리의 표다
    pool.providers = { "qwen-next": "local-direct", "legacy-voter": "local-direct" };
    expect(await sqlMembers("root")).toEqual([assigned.id, relabelled.id, legacy.id]);
    expect(await tsMembers("root")).toEqual(await sqlMembers("root"));
    // abcllm 그대로(오늘)도 같은 답이다
    pool.providers = {};
    expect(await sqlMembers("root")).toEqual([assigned.id, relabelled.id, legacy.id]);
    expect(await tsMembers("root")).toEqual(await sqlMembers("root"));
    // 같은 이름의 CLI 는 그 구성원이 아니다
    pool.providers = { "qwen-next": "opencode-cli", "legacy-voter": "claude-cli" };
    expect(await sqlMembers("root")).toEqual([legacyCli.id]);
    expect(await tsMembers("root")).toEqual(await sqlMembers("root"));
    // 다른 구성원의 배정·글자가 다른 장부 이름은 어느 이름표에서도 회원이 아니다
    expect((await tsMembers("root")).includes(otherMember.id) || (await tsMembers("root")).includes(otherName.id)).toBe(false);
  });

  it("대체 표: 첫 표(배정됨)가 대체로 넘어갔고 대체 표의 모델이 저장된 대체 순위다", async () => {
    const a = await candidate();
    const root = await vote(a, { provider: "abcllm", model: "qwen-next", status: "resolved", resolution: "fallback" }, { memberId: MEMBER, canonicalModel: "qwen-next" });
    const child = await vote(a, { provider: "abcllm", model: "legacy-fallback", fallbackForId: root.id });
    pool.providers = { "qwen-next": "local-direct", "legacy-fallback": "local-direct" };
    expect(await sqlMembers("chain")).toEqual([root.id, child.id]);
    expect(await tsMembers("chain")).toEqual(await sqlMembers("chain"));
    pool.providers = { "qwen-next": "local-direct", "legacy-fallback": "grok-cli" };
    expect(await sqlMembers("chain")).toEqual([root.id]);
    expect(await tsMembers("chain")).toEqual(await sqlMembers("chain"));
  });

  it("발행 관문 SQL: abcllm 으로 받은 승인 표는 그 구성원의 계약이 local-direct 가 된 뒤에도 그 1차 판단의 관문 표다", async () => {
    const a = await candidate(), attemptId = 7_000 + a.id;
    const approved = async () => (await db.execute<{ approved: boolean }>(sql`SELECT ${secondReviewPoolApprovedSql({ id: sql`${attemptId}`, model: sql`'first'` })} AS approved`))[0].approved;
    await vote(a, { provider: "abcllm", model: "qwen-next", status: "agreed", secondDecision: "approve" }, { memberId: MEMBER, canonicalModel: "qwen-next" });
    expect(await approved()).toBe(true);
    pool.providers = { "qwen-next": "local-direct" };
    expect(await approved()).toBe(true);
    pool.providers = { "qwen-next": "opencode-cli" };
    expect(await approved()).toBe(false);
  });
});

it("정리는 「동시에」 모드에서도 아직 보내지 않은 표를 지금 구성원의 이름표로 옮기고, 받은 표는 그대로 둔다", async () => {
  const a = await candidate(), b = await candidate();
  const waiting = await vote(a, { provider: "abcllm", model: "qwen-next" }, { memberId: MEMBER, canonicalModel: "qwen-next" });
  const received = await vote(b, { provider: "abcllm", model: "qwen-next", status: "agreed", secondDecision: "approve" }, { memberId: MEMBER, canonicalModel: "qwen-next" });
  pool.providers = { "qwen-next": "local-direct" };
  expect(await closeSettledSecondReviewsFixture()).toBe(1);
  expect(await db.select().from(secondReviews).orderBy(secondReviews.id)).toMatchObject([
    { id: waiting.id, provider: "local-direct", model: "qwen-next", status: "pending", resolution: null },
    { id: received.id, provider: "abcllm", model: "qwen-next", status: "agreed", resolution: null }]);
  expect(await closeSettledSecondReviewsFixture()).toBe(0);
  // 같은 이름의 CLI 로 바뀌면 그 표는 예전처럼 빠진다(옮기지 않는다)
  pool.providers = { "qwen-next": "opencode-cli" };
  await closeSettledSecondReviewsFixture();
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, waiting.id))).toMatchObject([{ provider: "local-direct", status: "resolved", resolution: "model_removed" }]);
});
