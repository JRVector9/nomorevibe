import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, products, roleLeases, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, getSettings, saveSettings, setHumanReviewEnabled } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { judgeRevision } from "@/lib/crawl/rules";
import { lockedInput } from "@/lib/crawl/admin-review";
import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { publishCandidates } from "@/lib/crawl/jobs/publish";
import { claimHumanReview, deferHumanReviewForModelCapacity, humanReviewRepos, recordHumanReview, refreshStaleDelegatedSources,
  requeueInvalidHumanApprovals, type HumanReviewClaim } from "@/lib/crawl/human-review-repository";
import type { DelegatedRepoCheck } from "@/lib/crawl/delegated-repo-check";
import { localModelDomainRefusal } from "@/lib/llm/local-model-domain";
import { releaseRole, tryAcquireRole, type RoleLease } from "@/lib/jobs/role-leader";
import { saveRepositoryAgentScan } from "@/lib/domain/evidence/agents/repository";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import type { DeepSeekReviewResult } from "@/lib/crawl/deepseek-review";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

/**
 * 사람 몫 위임 검수(human-deepseek-review) — 2026-11-09 운영자 결정:
 * 최신 것부터 보고, 끝낸 것은 같은 입력에서 다시 집지 않으며, 근거가 24시간 지났다고 못 보게 자르지 않는다.
 * 모델 호출은 이 파일의 범위가 아니다(tests/human-deepseek-review.test.ts) — claim·기록·발행 관문을 실제 DB 로 본다.
 */
const classify = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/lib/crawl/classify", () => ({
  classifyCategory: classify,
  classifyCategories: async (inputs: unknown[]) => Promise.all(inputs.map(input => classify(input))),
}));
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: async () => null }));

const HOUR = 3600_000;
const SHA = "a".repeat(40);
let role: RoleLease | null = null;

beforeAll(async () => {
  ensureSchema();
  const acquired = await tryAcquireRole({ role: "reviewer", instanceId: `hdel-${randomUUID().slice(0, 8)}`, bootId: randomUUID(),
    release: "fixture", kind: "primary" });
  if (!acquired) throw new Error("fixture_role");
  role = acquired;
});
afterAll(async () => {
  if (role) await releaseRole(role);
  await db.delete(roleLeases).where(eq(roleLeases.role, "reviewer"));
  await db.delete(secondReviews); await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier);
});

async function configure(overrides: Partial<typeof DEFAULT_CRAWL_SETTINGS> = {}) {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: "test-model" },
    secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "[MLX] second-test" }], sampleRate: 0, agreeAt: 0.85, includeAiHeld: false },
    ...overrides }, "test");
  const settings = await getSettings();
  if (settings.reviewMode !== "enforce")
    expect(await changeReviewMode({ mode: "enforce", expectedMode: settings.reviewMode, actor: "test", reason: "human delegation test" })).toMatchObject({ ok: true });
  const current = await getSettings();
  if (!current.humanReview.enabled)
    expect(await setHumanReviewEnabled({ enabled: true, expectedGeneration: current.humanReview.generation, actor: "test" })).toMatchObject({ ok: true });
}

beforeEach(async () => {
  await db.delete(secondReviews);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  classify.mockReset().mockResolvedValue(null);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await configure();
});

/** 사람 몫(2차 갈림) 후보 한 건 — ageHours 전에 받은 원본, enteredAt 에 사람 큐에 들어왔다 */
async function split(index: number, options: { ageHours?: number; enteredAt?: Date; repositoryKeys?: boolean } = {}) {
  const repo = `split/product-${index}`, productUrl = `https://split-${index}.example`;
  const fetchedAt = new Date(Date.now() - (options.ageHours ?? 0) * HOUR - 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt,
    repoMeta: { description: "A useful application" }, pageStatus: 200,
    pageMeta: { title: `Split ${index}`, description: "An application for daily work",
      ...(options.repositoryKeys ? { repositoryKeys: [repo] } : {}) } }).returning();
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "needs_review", reason: "second_review_split", decidedBy: "auto",
    judgedAt: fetchedAt, updatedAt: options.enteredAt ?? new Date(fetchedAt.getTime() + index),
    signals: { judgedRevision: judgeRevision(document), stoppedAt: { rule: "2차 심사", detail: "split" } } }).returning();
  return { row, document };
}

async function withJob<T>(name: "human-deepseek-review" | "audit-second-opinion" | "split-tiebreak", load: (lease: JobLease) => Promise<T>): Promise<T> {
  let value!: T;
  const result = await runJob<null>(name, async ctx => { value = await load(ctx.lease!); return { done: true }; });
  if (result.status !== "completed") throw new Error(`${name}_${result.status}`);
  return value;
}
const withHumanJob = <T>(load: (lease: JobLease) => Promise<T>) => withJob("human-deepseek-review", load);
const publish = () => runJob("crawl-publish", publishCandidates);
const candidateRow = async (id: number) => (await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, id)))[0];
const delegatedAttempts = (candidateId: number) => db.select().from(crawlReviewAttempts)
  .where(eq(crawlReviewAttempts.candidateId, candidateId)).orderBy(crawlReviewAttempts.id);
const approve: DeepSeekReviewResult = { ok: true, outcome: { decision: "approve", reason: "A working product page.", evidenceIds: ["product"], confidence: 0.97 } };
const abstain: DeepSeekReviewResult = { ok: true, outcome: { decision: "needs_review", reason: "Unclear from the evidence.", evidenceIds: [], confidence: 0.5 } };
const queue = async (...ids: number[]) => humanReviewRepos(ids, [], { settings: await getSettings() });

/** claim → (모델 답) → 기록. 같은 잡 lease 로 한다 */
async function review(repo: string, result: DeepSeekReviewResult, repoCheck?: DelegatedRepoCheck) {
  return withHumanJob(async lease => {
    const claim = await claimHumanReview(repo, lease);
    if (!claim) return { claim: null, state: null };
    return { claim, state: await recordHumanReview(claim, result, repoCheck ? { repoCheck: { check: repoCheck, retryAt: null } } : {}) };
  });
}
const sweep = async () => withHumanJob(async lease => refreshStaleDelegatedSources(lease, await getSettings()));
const frontierOf = async (repo: string) => (await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, repo)))[0];
const fetchRequests = async () => (await db.select().from(jobs).where(eq(jobs.name, "crawl-fetch")))[0]?.requestedVersion ?? 0;
const publishRequests = async () => (await db.select().from(jobs).where(eq(jobs.name, "crawl-publish")))[0]?.requestedVersion ?? 0;

describe("사람 몫 위임 검수 — 고르기", () => {
  it("사람 큐에 최근 들어온 것부터 고르고, 24시간 지난 근거도 고르며, 읽는 수에 상한이 있다", async () => {
    const base = Date.now() - 10 * HOUR;
    const rows: (typeof crawlCandidates.$inferSelect)[] = [];
    for (const [index, ageHours] of [[0, 1], [1, 72], [2, 2], [3, 30], [4, 0]] as const)
      rows.push((await split(index, { ageHours, enteredAt: new Date(base + index * HOUR) })).row);
    const ids = rows.map(row => row.id);
    expect(await queue(...ids)).toEqual([4, 3, 2, 1, 0].map(index => rows[index].repo));
    expect(await humanReviewRepos(ids, [], { settings: await getSettings(), limit: 2 })).toEqual([rows[4].repo, rows[3].repo]);
  });

  it("같은 입력에서 판단 보류로 끝낸 후보는 다시 고르지도 집지도 않는다 — 원본이 바뀌면 다시 대상이 된다", async () => {
    const aged = await split(0, { ageHours: 30 });
    const fresh = await split(1, { ageHours: 0 });
    expect(await review(aged.row.repo, abstain)).toMatchObject({ state: "held" });
    expect(await queue(aged.row.id, fresh.row.id)).toEqual([fresh.row.repo]);
    expect(await withHumanJob(lease => claimHumanReview(aged.row.repo, lease))).toBeNull();
    expect((await delegatedAttempts(aged.row.id)).map(row => row.state)).toEqual(["succeeded"]);

    // 원본을 다시 받았다 — 새 입력이므로 다시 본다
    await db.update(crawlDocuments).set({ fetchedAt: new Date(), pageMeta: { title: "Split 0", description: "A rewritten application page" } })
      .where(eq(crawlDocuments.id, aged.document.id));
    expect(await queue(aged.row.id, fresh.row.id)).toContain(aged.row.repo);
    expect(await review(aged.row.repo, abstain)).toMatchObject({ state: "held" });
  });

  it("실패는 다시 볼 시각 전까지, 같은 원본 시도 세 번 뒤에는 고르지 않는다 — 용량 미룸은 시도로 세지 않는다", async () => {
    const { row } = await split(0, { ageHours: 30 });
    expect(await review(row.repo, { ok: false, error: "timeout" })).toMatchObject({ state: "failed" });
    expect(await queue(row.id)).toEqual([]);

    // 용량 미룸 — claim 을 풀고 같은 후보를 다음 틱이 다시 본다
    await db.update(crawlReviewAttempts).set({ retryAfter: new Date(Date.now() - 1000) }).where(eq(crawlReviewAttempts.candidateId, row.id));
    await withHumanJob(async lease => {
      const claim = await claimHumanReview(row.repo, lease) as HumanReviewClaim;
      expect(claim).not.toBeNull();
      await deferHumanReviewForModelCapacity(claim);
    });
    expect(await queue(row.id)).toEqual([row.repo]);

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await review(row.repo, { ok: false, error: "timeout" })).toMatchObject({ state: "failed" });
      await db.update(crawlReviewAttempts).set({ retryAfter: new Date(Date.now() - 1000) }).where(eq(crawlReviewAttempts.candidateId, row.id));
    }
    expect(await queue(row.id)).toEqual([]);
    expect(await withHumanJob(lease => claimHumanReview(row.repo, lease))).toBeNull();
  });
});

describe("사람 몫 위임 검수 — 24시간 지난 근거의 승인", () => {
  it("24~72시간(48시간) 지난 입력도 저장소가 있으면 승인해 발행한다 — 되돌리지 않고, 근거 나이·저장소 확인을 감사에 남긴다", async () => {
    const floor = await auditFloor();
    const { row } = await split(0, { ageHours: 48 });
    const beforePublishRequests = await publishRequests();
    const { claim, state } = await review(row.repo, approve, "present");
    expect(state).toBe("applied");
    expect(claim!.input.validUntil.getTime()).toBeLessThan(Date.now());
    expect(await candidateRow(row.id)).toMatchObject({ state: "approved", decidedBy: "deepseek" });
    expect(await publishRequests()).toBe(beforePublishRequests + 1);
    const [audit] = await auditRowsAfter(floor, "candidate-deepseek-decision");
    expect(audit.detail).toMatchObject({ evidenceExpired: true, repoCheck: "present", outcome: { decision: "approve" } });
    expect((audit.detail as { evidenceAgeHours: number }).evidenceAgeHours).toBeGreaterThanOrEqual(48);

    // 다음 틱 머리의 되돌리기가 기한만으로 사람 큐에 돌려보내지 않는다
    expect(await withHumanJob(lease => requeueInvalidHumanApprovals(lease))).toBe(0);
    expect(await candidateRow(row.id)).toMatchObject({ state: "approved", decidedBy: "deepseek" });

    await publish();
    expect(await db.select().from(products)).toHaveLength(1);
    expect(await candidateRow(row.id)).toMatchObject({ state: "published" });
  });

  it("AI 근거를 요구하는 설정에서도 24시간 지난 스캔·원본으로 승인한 것이 발행된다", async () => {
    await configure({ agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility: true } });
    const { row } = await split(0, { ageHours: 30, repositoryKeys: true });
    const claim: AgentObservation = { kind: "commit_attribution", client: "claude-code", compatibleClients: [], modelDeveloper: null,
      declaredModelId: null, gateway: null, routing: "unknown", role: "coauthor", scope: "", keyPath: null, ruleId: "commit.coauthor.v1",
      sourcePath: null, commitSha: SHA, blobSha: null, sourceUrl: `https://github.com/${row.repo}/commit/${SHA}`,
      commitEvidence: { basis: "coauthor", changedPaths: ["src/app.ts"], changeKind: "development", headSha: SHA } };
    await saveRepositoryAgentScan({ repositoryId: "12", repositoryKey: row.repo, commitSha: SHA, scope: "", state: "complete", cursor: null,
      observations: [claim], requestCount: 4, fileCount: 1, errorCode: null, retryAt: null }, new Date(Date.now() - 29 * HOUR));

    // 다른 잡의 기준(window)은 이 입력을 근거 대기로 본다 — 위임 검수(any_age)는 그대로 싣는다
    const window = await db.transaction(tx => lockedInput(tx, row.repo));
    const anyAge = await db.transaction(tx => lockedInput(tx, row.repo, "any_age"));
    expect(window!.input.snapshot).toMatchObject({ scanState: "pending", evidenceSummary: { eligible: false } });
    expect(anyAge!.input.snapshot).toMatchObject({ scanState: "complete", relationship: "same_product", evidenceSummary: { eligible: true } });

    const approveWithEvidence: DeepSeekReviewResult = { ok: true, outcome: { decision: "approve", reason: "Built with an agent and usable.",
      evidenceIds: ["product", anyAge!.input.snapshot.evidence[0].id], confidence: 0.97 } };
    expect(await review(row.repo, approveWithEvidence, "present")).toMatchObject({ state: "applied" });
    expect(await withHumanJob(lease => requeueInvalidHumanApprovals(lease))).toBe(0);
    await publish();
    expect(await candidateRow(row.id)).toMatchObject({ state: "published" });
    expect(await db.select().from(products)).toHaveLength(1);
  });

  it("발행 전에 원본이 바뀌면 그 위임 승인으로 발행하지 않는다 — 기한만 풀었고 같은 원본 대조는 그대로다", async () => {
    const { row, document } = await split(0, { ageHours: 30 });
    expect(await review(row.repo, approve, "present")).toMatchObject({ state: "applied" });
    await db.update(crawlDocuments).set({ fetchedAt: new Date(), pageMeta: { title: "Split 0", description: "Something else now" } })
      .where(eq(crawlDocuments.id, document.id));
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
    expect(await withHumanJob(lease => requeueInvalidHumanApprovals(lease))).toBe(1);
    expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "second_review_split", decidedBy: "auto" });
  });
});

describe("72시간 넘은 근거의 승인 — 공개 전에 다시 검수(2026-11-09 운영자 결정)", () => {
  it("73시간 지난 승인은 발행하지 않고 사람 큐에 남기며, 원본 재수집을 한 번만 요청한다 — 다시 받은 뒤 승인하면 발행된다", async () => {
    const floor = await auditFloor();
    const { row, document } = await split(0, { ageHours: 73 });
    expect(await review(row.repo, approve)).toMatchObject({ state: "stale" });
    expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "second_review_split", decidedBy: "auto" });
    const [attempt] = await delegatedAttempts(row.id);
    expect(attempt).toMatchObject({ state: "succeeded", reason: "stale_evidence_refresh", outcome: { decision: "needs_review" } });
    const [audit] = await auditRowsAfter(floor, "candidate-deepseek-stale-hold");
    expect(audit.detail).toMatchObject({ cause: "evidence_over_72h", outcome: { decision: "approve" } });
    expect((audit.detail as { evidenceAgeHours: number }).evidenceAgeHours).toBeGreaterThan(72);
    expect(await withHumanJob(lease => requeueInvalidHumanApprovals(lease))).toBe(0);
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
    // 같은 입력은 다시 고르지 않는다
    expect(await queue(row.id)).toEqual([]);

    const before = await fetchRequests();
    expect(await sweep()).toEqual({ requested: 1, gone: 0, failed: 0 });
    expect(await frontierOf(row.repo)).toMatchObject({ state: "pending", signal: "review-source-refresh" });
    expect(await fetchRequests()).toBeGreaterThan(before);
    // 매 틱 다시 요청하지 않는다 — 수집이 아직 안 돌았을 때도, 돌고 난 뒤에도
    expect(await sweep()).toEqual({ requested: 0, gone: 0, failed: 0 });

    // 수집 잡이 원본을 다시 받았다(내용은 같다 — 해시가 같아도 수집 시각이 새 입력을 만든다)
    await db.update(crawlFrontier).set({ state: "done", updatedAt: new Date() }).where(eq(crawlFrontier.repo, row.repo));
    await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.id, document.id));
    expect(await sweep()).toEqual({ requested: 0, gone: 0, failed: 0 });
    expect(await queue(row.id)).toEqual([row.repo]);
    expect(await review(row.repo, approve)).toMatchObject({ state: "applied" });
    await publish();
    expect(await candidateRow(row.id)).toMatchObject({ state: "published" });
  });

  it("다시 받기가 404 로 끝나면(저장소 삭제·비공개) 발행하지 않고 repo_deleted 로 사람에게 넘기며 감사를 남긴다", async () => {
    const floor = await auditFloor();
    const { row } = await split(0, { ageHours: 80 });
    expect(await review(row.repo, approve)).toMatchObject({ state: "stale" });
    expect(await sweep()).toMatchObject({ requested: 1 });
    // 수집 잡이 404 를 만나 건너뛰었다(원본은 그대로)
    await db.update(crawlFrontier).set({ state: "skipped", lastError: "github_not_found", updatedAt: new Date() }).where(eq(crawlFrontier.repo, row.repo));
    expect(await sweep()).toEqual({ requested: 0, gone: 1, failed: 0 });
    expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "repo_deleted", decidedBy: "auto",
      signals: { stoppedAt: { rule: "원본 재수집" } } });
    const [audit] = await auditRowsAfter(floor, "candidate-deepseek-stale-refresh-failed");
    expect(audit.detail).toMatchObject({ reason: "repo_deleted", frontierError: "github_not_found" });
    expect(await sweep()).toEqual({ requested: 0, gone: 0, failed: 0 });
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
  });

  it("24~72시간 근거의 승인에서 저장소가 사라졌으면 발행하지 않고 repo_deleted 로 넘긴다 — 확인을 못 했으면 미룬다", async () => {
    const floor = await auditFloor();
    const gone = await split(0, { ageHours: 48 });
    expect(await review(gone.row.repo, approve, "gone")).toMatchObject({ state: "repo_gone" });
    expect(await candidateRow(gone.row.id)).toMatchObject({ state: "needs_review", reason: "repo_deleted", decidedBy: "auto" });
    expect(await auditRowsAfter(floor, "candidate-deepseek-repo-gone")).toHaveLength(1);

    const unknown = await split(1, { ageHours: 48 });
    expect(await review(unknown.row.repo, approve, "deferred")).toMatchObject({ state: "deferred" });
    expect(await candidateRow(unknown.row.id)).toMatchObject({ state: "needs_review", reason: "second_review_split" });
    expect((await delegatedAttempts(unknown.row.id))[0]).toMatchObject({ state: "superseded", errorCode: "repo_check_deferred" });
    // 미룸은 다시 볼 시각 전까지 고르지 않고, 시도로 세지 않는다
    expect(await queue(unknown.row.id)).toEqual([]);
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
  });

  it("100시간 지난 근거의 거부는 그대로 닫는다", async () => {
    const { row } = await split(0, { ageHours: 100 });
    const reject: DeepSeekReviewResult = { ok: true, outcome: { decision: "reject", reason: "Not a product.", evidenceIds: ["product"], confidence: 0.97 } };
    expect(await review(row.repo, reject)).toMatchObject({ state: "applied" });
    expect(await candidateRow(row.id)).toMatchObject({ state: "rejected", decidedBy: "deepseek" });
    expect(await sweep()).toEqual({ requested: 0, gone: 0, failed: 0 });
  });
});

// 0173(2026-11-10 운영자 요청): 「사람에게 남김」이 모델의 판단 보류인지 문턱에 못 미친 승인·반려인지 가르게, succeeded 로 닫는 위임 시도에
// 모델의 원래 답과 남긴 까닭을 model_outcome 에 적는다. 결정·적용·감사는 예전 그대로다
describe("위임 시도의 원래 답(model_outcome)", () => {
  const modelOutcome = async (candidateId: number) => (await delegatedAttempts(candidateId)).map(row => row.modelOutcome);
  /** reviewWithDeepSeek 가 돌려주는 모양 — 결정(outcome)은 문턱을 건 것, original 은 모델의 원래 답 */
  const answered = (decision: "approve" | "reject" | "needs_review", confidence: number): DeepSeekReviewResult => {
    const original = { decision, reason: "Read from the evidence.", evidenceIds: decision === "needs_review" ? [] : ["product"], confidence };
    return { ok: true, outcome: { ...original, decision: decision !== "needs_review" && confidence < 0.9 ? "needs_review" : decision }, original };
  };

  it("적용한 승인·반려는 까닭 없이 원래 결정·확신을 적고, 후보는 예전처럼 승인·반려된다", async () => {
    const floor = await auditFloor();
    const approved = await split(0), rejected = await split(1);
    expect(await review(approved.row.repo, answered("approve", 0.97))).toMatchObject({ state: "applied" });
    expect(await review(rejected.row.repo, answered("reject", 0.93))).toMatchObject({ state: "applied" });
    expect(await candidateRow(approved.row.id)).toMatchObject({ state: "approved", decidedBy: "deepseek" });
    expect(await candidateRow(rejected.row.id)).toMatchObject({ state: "rejected", decidedBy: "deepseek", reason: "not_a_product" });
    expect(await modelOutcome(approved.row.id)).toEqual([{ decision: "approve", confidence: 0.97, holdCause: null }]);
    expect(await modelOutcome(rejected.row.id)).toEqual([{ decision: "reject", confidence: 0.93, holdCause: null }]);
    expect((await delegatedAttempts(rejected.row.id))[0]).toMatchObject({ state: "succeeded", outcome: { decision: "reject" } });
    expect(await auditRowsAfter(floor, "candidate-deepseek-decision")).toHaveLength(2);
  });

  it("모델 보류는 model_abstained, 문턱 미만의 승인은 운반이 needs_review 로 바꾼 뒤에도 원래 승인과 low_confidence 로 남는다", async () => {
    const floor = await auditFloor();
    const abstained = await split(0), unsure = await split(1);
    expect(await review(abstained.row.repo, answered("needs_review", 0.5))).toMatchObject({ state: "held" });
    expect(await review(unsure.row.repo, answered("approve", 0.82))).toMatchObject({ state: "held" });
    for (const { row } of [abstained, unsure])
      expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "second_review_split", decidedBy: "auto" });
    expect(await modelOutcome(abstained.row.id)).toEqual([{ decision: "needs_review", confidence: 0.5, holdCause: "model_abstained" }]);
    expect(await modelOutcome(unsure.row.id)).toEqual([{ decision: "approve", confidence: 0.82, holdCause: "low_confidence" }]);
    expect((await delegatedAttempts(unsure.row.id))[0]).toMatchObject({ state: "succeeded", outcome: { decision: "needs_review" } });
    expect(await auditRowsAfter(floor, "candidate-deepseek-decision")).toHaveLength(0);
    // 끝낸 입력이라 다시 고르지 않는 것도 그대로다
    expect(await queue(abstained.row.id, unsure.row.id)).toEqual([]);
  });

  it("사람만 승인할 수 있는 사유(스팸 의심)의 승인은 cannot_approve 로 남기고 발행하지 않는다", async () => {
    const { row } = await split(0);
    await db.update(crawlCandidates).set({ reason: "suspected_spam" }).where(eq(crawlCandidates.id, row.id));
    expect(await review(row.repo, approve)).toMatchObject({ state: "held" });
    expect(await candidateRow(row.id)).toMatchObject({ state: "needs_review", reason: "suspected_spam", decidedBy: "auto" });
    expect(await modelOutcome(row.id)).toEqual([{ decision: "approve", confidence: 0.97, holdCause: "cannot_approve" }]);
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
  });

  it("72시간 넘은 근거의 승인은 stale_evidence, 24~72시간 저장소 사라짐은 repo_gone 으로 남기고 — 미룸·실패는 적지 않는다", async () => {
    const floor = await auditFloor();
    const stale = await split(0, { ageHours: 73 }), gone = await split(1, { ageHours: 48 }), unknown = await split(2, { ageHours: 48 });
    const failed = await split(3);
    expect(await review(stale.row.repo, approve)).toMatchObject({ state: "stale" });
    expect(await review(gone.row.repo, approve, "gone")).toMatchObject({ state: "repo_gone" });
    expect(await review(unknown.row.repo, approve, "deferred")).toMatchObject({ state: "deferred" });
    expect(await review(failed.row.repo, { ok: false, error: "timeout" })).toMatchObject({ state: "failed" });
    expect((await delegatedAttempts(stale.row.id))[0]).toMatchObject({ state: "succeeded", reason: "stale_evidence_refresh",
      outcome: { decision: "needs_review" }, modelOutcome: { decision: "approve", confidence: 0.97, holdCause: "stale_evidence" } });
    expect(await modelOutcome(gone.row.id)).toEqual([{ decision: "approve", confidence: 0.97, holdCause: "repo_gone" }]);
    expect(await candidateRow(gone.row.id)).toMatchObject({ state: "needs_review", reason: "repo_deleted" });
    expect((await delegatedAttempts(unknown.row.id))[0]).toMatchObject({ state: "superseded", errorCode: "repo_check_deferred", modelOutcome: null });
    expect((await delegatedAttempts(failed.row.id))[0]).toMatchObject({ state: "failed", modelOutcome: null });
    expect(await auditRowsAfter(floor, "candidate-deepseek-stale-hold")).toHaveLength(1);
    expect(await auditRowsAfter(floor, "candidate-deepseek-repo-gone")).toHaveLength(1);
    await publish();
    expect(await db.select().from(products)).toHaveLength(0);
  });

  it("문턱 미리보기는 적은 원래 답을 읽어 지금 문턱에서 실제 적용 수와 같고, 문턱을 내리면 확신 부족만 넘어온다", async () => {
    const { readDelegateThresholdPreview } = await import("@/lib/operations/delegate-threshold-preview");
    const applied = await split(0), unsure = await split(1), old = await split(2, { ageHours: 80 }), abstained = await split(3);
    expect(await review(applied.row.repo, approve)).toMatchObject({ state: "applied" });
    expect(await review(unsure.row.repo, answered("approve", 0.82))).toMatchObject({ state: "held" });
    expect(await review(old.row.repo, answered("approve", 0.86))).toMatchObject({ state: "held" });
    expect(await review(abstained.row.repo, abstain)).toMatchObject({ state: "held" });
    const preview = await readDelegateThresholdPreview(24);
    expect(preview).toMatchObject({ total: 4, ending: { applied: 1, low_confidence: 2, model_abstained: 1 } });
    expect(preview.thresholds.find(line => line.threshold === 0.9)).toMatchObject({ approve: 1, reject: 0, approveStale: 0, held: 3 });
    // 0.85: 80시간 근거의 0.86 승인은 적용이 아니라 원본 재수집으로 남는다. 0.8: 0.82 승인이 넘어온다
    expect(preview.thresholds.find(line => line.threshold === 0.85)).toMatchObject({ approve: 1, approveStale: 1, held: 3 });
    expect(preview.thresholds.find(line => line.threshold === 0.8)).toMatchObject({ approve: 2, approveStale: 1, held: 2 });
  });
});

describe("호출 직전 증명", () => {
  it("사람 큐 후보(human_deepseek·held_qwen)는 24시간 지난 입력을 통과시키고, 다른 대상(공개분 거르기·갈림 판가름)은 그대로 input_expired 로 거절한다", async () => {
    const { row } = await split(0, { ageHours: 30 });
    await withHumanJob(async lease => {
      const claim = await claimHumanReview(row.repo, lease);
      expect(claim).not.toBeNull();
      const [attempt] = await delegatedAttempts(row.id);
      const target = { kind: "candidate" as const, purpose: "human_deepseek" as const, attemptId: claim!.attemptId, candidateId: row.id, repo: row.repo };
      expect(await db.transaction(tx => localModelDomainRefusal(tx, target, claim!.input, lease, role!, attempt.model!))).toBeNull();
      await recordHumanReview(claim!, abstain);
    });
    const current = await db.transaction(tx => lockedInput(tx, row.repo));
    await withJob("audit-second-opinion", async lease => {
      const target = { kind: "published" as const, purpose: "published_filter" as const, secondReviewId: 1, slug: "split-0" };
      expect(await db.transaction(tx => localModelDomainRefusal(tx, target, current!.input, lease, role!, "qwen3.8-flash-next")))
        .toMatchObject({ check: "input_expired" });
    });
    await withJob("split-tiebreak", async lease => {
      const target = { kind: "split" as const, purpose: "qwen_tiebreak" as const, tiebreakId: 1, candidateId: row.id,
        generationKey: "b".repeat(64), repo: row.repo };
      expect(await db.transaction(tx => localModelDomainRefusal(tx, target, current!.input, lease, role!, "qwen3.8-flash-next")))
        .toMatchObject({ check: "input_expired" });
    });
  });
});
