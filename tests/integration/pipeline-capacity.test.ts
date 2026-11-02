import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { changeReviewMode, getSettings, saveSettings } from "@/lib/crawl/settings";
import { claimAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { enqueueSecondReviewsFixture as enqueueSecondReviews, closeSettledSecondReviewsFixture as closeSettledSecondReviews,
  recordSecondReviewFixture } from "./second-review-receipt-fixtures";
import { reviewPolicyHash } from "@/lib/crawl/agent-review-contract";
import { fullReviewPolicyHash, comparisonReviewPolicyHash, reportCapacityRun, type CapacityArtifact } from "@/lib/operations/pipeline-capacity";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { snapshotPipelineGenerations } from "@/lib/operations/pipeline-capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { pinReviewRanks } from "../review-task-ranks-fixture";

beforeAll(ensureSchema);
beforeEach(async () => {
  for (const table of [secondReviews, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs]) await db.delete(table);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
});
const outcome = { decision: "approve" as const, reason: "A usable product", evidenceIds: ["product"], confidence: .95 };
async function fixture(voters = ["second-a", "second-b"], decision: "approve" | "reject" = "approve") {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: "first-fixture" }, secondReview: {
    enabled: true, voters: voters.map(model => ({ provider: "abcllm" as const, model })),
    fallbacks: [{ provider: "abcllm", model: "backup" }], sampleRate: 0,
  } }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "capacity fixture" })).toMatchObject({ ok: true });
  await crawl.putDocument({ repo: "capacity/app", productUrl: "https://capacity.example", pageStatus: 200,
    repoMeta: { description: "A useful product" }, pageMeta: { title: "Capacity", description: "A useful product" } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 2000) });
  const document = (await crawl.getDocument("capacity/app"))!;
  const settings = await getSettings();
  await crawl.recordAutomaticJudgement({ candidate: undefined, document, settings, verdict: { state: "approved", reason: "passed", signals: {} } });
  const candidate = (await crawl.getCandidate(document.repo))!;
  const lease = { name: "crawl-agent-review", token: "capacity-owner", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: lease.token, lockedAt: new Date() } });
  const context = { candidate, document, settings, lease, provider: "claude-cli", model: "first-fixture",
    input: await loadReviewInput(candidate, document, settings) };
  const claim = await claimAgentReview(context);
  if (claim.kind === "skipped") throw new Error(claim.reason);
  await recordAgentReview({ ...context, receipt: claim.receipt, outcome: { ...outcome, decision } });
  return { ...context, attempt: claim.attempt, receipt: claim.receipt };
}
async function approve(id: number) {
  const [row] = await db.select().from(secondReviews).where(eq(secondReviews.id, id));
  await recordSecondReviewFixture(id, { ok: true, decision: "approve", confidence: .95, reason: "Verified product",
    model: row.model!, provider: row.provider!, status: "agreed" });
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return snapshotPipelineGenerations([f.candidate.id], fullReviewPolicyHash(f.settings));
}
it("reads the actual final gate: two required votes complete one current applied generation", async () => {
  const f = await fixture();
  const before = await snapshot(f);
  expect(before.generations).toHaveLength(1);
  expect(before.generations[0]).toMatchObject({ firstAttemptId: f.attempt.id, currentInputMatched: true,
    appliedAttemptId: f.attempt.id, secondGateRequired: true, secondGateSatisfied: false, secondGateCompletedAt: null });
  await enqueueSecondReviews(f.settings);
  const votes = await db.select().from(secondReviews);
  expect(votes).toHaveLength(2);
  await approve(votes[0].id);
  expect((await snapshot(f)).generations[0].secondGateSatisfied).toBe(false);
  await approve(votes[1].id);
  const [last] = await db.select().from(secondReviews).where(eq(secondReviews.id, votes[1].id));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_external_call"));
  try {
    expect((await snapshot(f)).generations[0]).toMatchObject({ secondGateSatisfied: true,
      secondGateCompletedAt: last.reviewedAt!.toISOString() });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.select().from(crawlReviewAttempts)).toHaveLength(1);
  } finally { fetchSpy.mockRestore(); }
});
it("retains a failed primary's configured fallback slot and uses its durable success time", async () => {
  const f = await fixture(["second-a"]);
  await enqueueSecondReviews(f.settings);
  const [root] = await db.select().from(secondReviews);
  await recordSecondReviewFixture(root.id, { ok: false, error: "timeout", model: root.model!, provider: root.provider! });
  const rows = await db.select().from(secondReviews);
  const backup = rows.find(row => row.fallbackForId === root.id)!;
  expect(backup).toBeDefined();
  expect((await snapshot(f)).generations[0].secondGateSatisfied).toBe(false);
  await approve(backup.id);
  const [saved] = await db.select().from(secondReviews).where(eq(secondReviews.id, backup.id));
  expect((await snapshot(f)).generations[0]).toMatchObject({ secondGateSatisfied: true,
    secondGateCompletedAt: saved.reviewedAt!.toISOString() });
});
it("keeps dissent as a human hold and refuses a new input's stale success", async () => {
  const f = await fixture(["second-a"]);
  await enqueueSecondReviews(f.settings);
  const [row] = await db.select().from(secondReviews);
  await recordSecondReviewFixture(row.id, { ok: true, decision: "reject", confidence: .95, reason: "Not a product",
    model: row.model!, provider: row.provider!, status: "needs_human" });
  expect((await snapshot(f)).generations[0]).toMatchObject({ candidateState: "needs_review", secondGateSatisfied: false });
  await db.update(crawlDocuments).set({ pageMeta: { title: "Completely different app", description: "changed" } });
  expect((await snapshot(f)).generations[0].currentInputMatched).toBe(false);
});
it("fingerprints AI2/model settings beyond the existing narrow policy hash", async () => {
  const f = await fixture();
  await saveSettings({ secondReview: { agreeAt: .99 } }, "test");
  const changed = await getSettings();
  expect(reviewPolicyHash(changed)).toBe(reviewPolicyHash(f.settings));
  expect(fullReviewPolicyHash(changed)).not.toBe(fullReviewPolicyHash(f.settings));
  await expect(snapshot(f)).rejects.toThrow("snapshot_policy_mismatch");
});
it("exports administrator decisions as exclusions rather than rewriting them", async () => {
  const f = await fixture();
  await crawl.recordJudgement({ repo: f.candidate.repo, productUrl: f.candidate.productUrl,
    state: "rejected", reason: "not_a_product", decidedBy: "admin" });
  expect((await snapshot(f)).generations[0]).toMatchObject({ decidedBy: "admin", candidateState: "rejected" });
  expect(await crawl.getCandidate(f.candidate.repo)).toMatchObject({ decidedBy: "admin", state: "rejected" });
});
it("fails closed on invalid selection or missing candidates", async () => {
  const f = await fixture();
  await expect(snapshotPipelineGenerations([], fullReviewPolicyHash(f.settings))).rejects.toThrow("invalid_snapshot_candidates");
  await expect(snapshotPipelineGenerations([f.candidate.id, f.candidate.id], fullReviewPolicyHash(f.settings))).rejects.toThrow("invalid_snapshot_candidates");
  await expect(snapshotPipelineGenerations([2147483000], fullReviewPolicyHash(f.settings))).rejects.toThrow("snapshot_candidate_missing");
});
it("retains a completed gate after publication without counting published audit votes", async () => {
  const f = await fixture(["second-a"]);
  await enqueueSecondReviews(f.settings);
  const [row] = await db.select().from(secondReviews);
  await approve(row.id);
  const before = (await snapshot(f)).generations[0];
  expect(before.secondGateSatisfied).toBe(true);
  await db.update(crawlCandidates).set({ state: "published", publishedSlug: "capacity-app" });
  expect((await snapshot(f)).generations[0]).toMatchObject({ candidateState: "published", secondGateSatisfied: true,
    secondGateCompletedAt: before.secondGateCompletedAt });
  await closeSettledSecondReviews();
  // Routine cleanup resolves gate rows. A current-state export must not invent
  // historical approval evidence; PR01b needs an immutable transition ledger.
  expect((await snapshot(f)).generations[0]).toMatchObject({ candidateState: "published", secondGateSatisfied: false,
    secondGateCompletedAt: null });
});

it("AI1 rejection completes without approval-only AI2 slots", async () => {
  const f = await fixture(["second-a"], "reject");
  expect((await snapshot(f)).generations[0]).toMatchObject({ decision: "reject", candidateState: "rejected",
    currentInputMatched: true, secondGateRequired: false, secondGateSatisfied: true, secondGateCompletedAt: null });
});

it("local export keeps only frozen manifest inputs and reports copied reuse separately", async () => {
  const f = await fixture(["second-a"]);
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 500) });
  const candidate = (await crawl.getCandidate(f.candidate.repo))!;
  const document = (await crawl.getDocument(f.candidate.repo))!;
  const input = await loadReviewInput(candidate, document, f.settings);
  const context = { ...f, candidate, document, input };
  const claim = await claimAgentReview(context);
  expect(claim.kind).toBe("reused");
  if (claim.kind === "skipped") throw new Error(claim.reason);
  await recordAgentReview({ ...context, receipt: claim.receipt, outcome });
  expect((await snapshot(f)).generations).toHaveLength(2);
  const end = new Date().toISOString(), start = new Date(Date.now() - 60_000).toISOString();
  const hash = "a".repeat(64);
  const identity = (model: string, provider: "abcllm" | "claude-cli" = "abcllm") => ({ model, provider, canonicalModel: model });
  const template: CapacityArtifact = {
    manifest: { version: 1, runId: "actual-export", revision: "8020dca", mode: "fixtures", cacheMode: "warm",
      referenceTime: start, startedAt: start, endedAt: end, inputPolicyHash: input.policyHash,
      fullReviewPolicyHash: fullReviewPolicyHash(f.settings), comparisonPolicyHash: comparisonReviewPolicyHash(f.settings), initialStateHash: hash,
      models: { first: identity("first-fixture", "claude-cli"), second: [identity("second-a")], fallbacks: [identity("backup")] },
      inputs: [{ candidateId: f.candidate.id, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
        readyAt: start, stratum: "new", reReview: false }],
      limits: { maxCalls: 10, maxTokens: 100_000, maxDurationMs: 60_000, concurrency: 1, perCallTokenUpperBound: 10_000 } },
    source: { kind: "fixture", scope: "as_of_snapshot_only", runId: "actual-export", exportedAt: end, fullReviewPolicyHash: fullReviewPolicyHash(f.settings) },
    generations: [], readiness: [], calls: [], quality: null,
  };
  const directory = mkdtempSync(join(tmpdir(), "nomorevibe-capacity-local-"));
  // CI resolves the fixture URL in setup without setting this optional override.
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  vi.stubEnv("TEST_DATABASE_URL", undefined);
  // 1차·2차 심사자는 「작업 ↔ 모델」 순위다(PR C1) — 자식 스크립트에는 env.ts 의 고정이 없으니 같은 순위(설정의 1차 → 1차 1순위, 투표자·대체 → 칸 1 의
  // 1·2순위)를 preload 로 건넨다. 인증 snapshot 은 manifest 의 모델을 이 순위에서 나온 심사자와 견준다.
  const ranks = { first: [{ provider: "claude-cli", model: "first-fixture" }],
    second: [[{ provider: "abcllm", model: "second-a" }, { provider: "abcllm", model: "backup" }]] };
  const exportScript = ["--import", "tsx", "--import", "./tests/integration/fixtures/review-ranks-child-preload.ts", "scripts/export-pipeline-capacity.ts"];
  try {
    const path = join(directory, "template.json"), output = join(directory, "export.json");
    writeFileSync(path, JSON.stringify(template));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|READ_DATABASE_URL$)/.test(key)));
    const childEnv = (value: typeof ranks) => ({ ...env, NODE_ENV: "test" as const, TEST_DATABASE_URL, NMV_TEST_REVIEW_RANKS: JSON.stringify(value) });
    const child = spawnSync(process.execPath, [...exportScript, path, output], {
      encoding: "utf8", env: childEnv(ranks), timeout: 10_000,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ exported: true, generations: 1, excludedHistoricalGenerations: 1 });
    const artifact = JSON.parse(readFileSync(output, "utf8"));
    expect(artifact.source).toMatchObject({ kind: "local-postgres", scope: "as_of_snapshot_only" });
    expect(reportCapacityRun(artifact)).toMatchObject({ finalCandidates: 0, exclusions: { reuse: 1 } });
    expect(await db.select().from(crawlReviewAttempts)).toHaveLength(2);
    // 같은 snapshot 을 이 프로세스에서: 순위가 manifest 와 같으면 받고, 1차 순위가 둘이면 manifest 가 선언한 1차 하나를 넘는 풀이라 거절한다
    pinReviewRanks(ranks);
    await expect(snapshotPipelineGenerations([f.candidate.id], fullReviewPolicyHash(f.settings), template.manifest))
      .resolves.toMatchObject({ generations: expect.any(Array) });
    pinReviewRanks({ ...ranks, first: [...ranks.first, { provider: "abcllm", model: "first-extra" }] });
    await expect(snapshotPipelineGenerations([f.candidate.id], fullReviewPolicyHash(f.settings), template.manifest))
      .rejects.toThrow("unsupported_capacity_first_review_pool");
    // 순위의 2차 투표자가 manifest 와 다르면 거절한다(설정의 voters 는 같아도) — 자식 스크립트도 순위로 견준다
    const reranked = spawnSync(process.execPath, [...exportScript, path, join(directory, "reranked.json")], {
      encoding: "utf8", env: childEnv({ ...ranks, second: [[{ provider: "abcllm", model: "second-other" }, { provider: "abcllm", model: "backup" }]] }), timeout: 10_000,
    });
    expect(reranked.status).toBe(1);
    expect(reranked.stderr.trim()).toBe("snapshot_model_mismatch");
    template.manifest.models.second[0] = identity("unconfigured-model");
    writeFileSync(path, JSON.stringify(template));
    const mismatched = spawnSync(process.execPath, [...exportScript, path, join(directory, "wrong-model.json")], {
      encoding: "utf8", env: childEnv(ranks), timeout: 10_000,
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr.trim()).toBe("snapshot_model_mismatch");
  } finally {
    vi.stubEnv("TEST_DATABASE_URL", originalTestDatabaseUrl);
    rmSync(directory, { recursive: true, force: true });
  }
});
