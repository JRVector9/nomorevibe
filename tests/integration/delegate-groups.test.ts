import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, roleLeases, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, getSettings, saveSettings, setHumanReviewEnabled } from "@/lib/crawl/settings";
import { judgeRevision } from "@/lib/crawl/rules";
import { listAdminReviewEntries } from "@/lib/crawl/admin-review";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { runJob } from "@/lib/jobs/runner";
import type { JobLease } from "@/lib/jobs/control";
import { claimHumanReview, recordHumanReview } from "@/lib/crawl/human-review-repository";
import { releaseRole, tryAcquireRole, type RoleLease } from "@/lib/jobs/role-leader";
import type { DeepSeekReviewResult } from "@/lib/crawl/deepseek-review";
import type { DelegatedModelOutcome } from "@/lib/crawl/delegated-hold";
import { readDelegateGroups } from "@/lib/crawl/delegate-groups-read";
import { delegateOpinions } from "@/lib/crawl/delegate-opinions-read";
import { readHumanDelegateSummary } from "@/lib/operations/human-delegate-summary";
import { prototypeReviewFilter, prototypeReviewOptions } from "@/app/(operator)/admin/review/PrototypeReviewQuery";
import { ensureSchema, resetTables } from "./setup";

/**
 * 사람 몫의 「AI 위임 결과」 갈래(2026-11-10 운영자: 근거 부족은 따로 사람이 승인하는 목록으로) — 실제 DB 로 본다.
 * 시도 행은 실제 claim·기록으로 만들고(지금 원본·세대가 맞게), 원래 답(model_outcome)은 갈래마다 직접 적는다 —
 * 기록 함수가 그 칸을 쓰든 안 쓰든 이 시험의 갈래가 같게.
 */
vi.mock("@/lib/domain/products/og", () => ({ cacheOgImage: async () => null }));

const HOUR = 3600_000;
let role: RoleLease | null = null;

beforeAll(async () => {
  ensureSchema();
  const acquired = await tryAcquireRole({ role: "reviewer", instanceId: `dgrp-${randomUUID().slice(0, 8)}`, bootId: randomUUID(),
    release: "fixture", kind: "primary" });
  if (!acquired) throw new Error("fixture_role");
  role = acquired;
});
afterAll(async () => {
  if (role) await releaseRole(role);
  await db.delete(roleLeases).where(eq(roleLeases.role, "reviewer"));
  await db.delete(secondReviews); await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier);
});

async function configure() {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: "test-model" },
    secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "[MLX] second-test" }], sampleRate: 0, agreeAt: 0.85, includeAiHeld: false } }, "test");
  const settings = await getSettings();
  if (settings.reviewMode !== "enforce")
    expect(await changeReviewMode({ mode: "enforce", expectedMode: settings.reviewMode, actor: "test", reason: "delegate groups test" })).toMatchObject({ ok: true });
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
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await configure();
});

/** 사람 몫(2차 갈림 — 사람만 가르는 사유라 「직접 판단」 구간) 후보 한 건 */
async function split(index: number) {
  const repo = `delegate/product-${index}`, productUrl = `https://delegate-${index}.example`;
  const fetchedAt = new Date(Date.now() - HOUR - index * 1000);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt,
    repoMeta: { description: "A useful application" }, pageStatus: 200,
    pageMeta: { title: `Delegate ${index}`, description: "An application for daily work" } }).returning();
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "needs_review", reason: "second_review_split", decidedBy: "auto",
    judgedAt: fetchedAt, updatedAt: new Date(fetchedAt.getTime() + index),
    signals: { judgedRevision: judgeRevision(document), stoppedAt: { rule: "2차 심사", detail: "split" } } }).returning();
  return { row, document };
}

async function withHumanJob<T>(load: (lease: JobLease) => Promise<T>): Promise<T> {
  let value!: T;
  const result = await runJob<null>("human-deepseek-review", async ctx => { value = await load(ctx.lease!); return { done: true }; });
  if (result.status !== "completed") throw new Error(`human-deepseek-review_${result.status}`);
  return value;
}
const abstain: DeepSeekReviewResult = { ok: true, outcome: { decision: "needs_review", reason: "Unclear from the evidence.", evidenceIds: [], confidence: 0.5 } };

/** 실제 claim·기록으로 위임 시도를 끝내고, 그 시도의 원래 답을 정한 값으로 적는다(null = 0173 전 옛 행) */
async function delegated(repo: string, modelOutcome: DelegatedModelOutcome | null, result: DeepSeekReviewResult = abstain) {
  const attemptId = await withHumanJob(async lease => {
    const claim = await claimHumanReview(repo, lease);
    if (!claim) throw new Error(`claim_failed:${repo}`);
    await recordHumanReview(claim, result);
    return claim.attemptId;
  });
  await db.update(crawlReviewAttempts).set({ modelOutcome }).where(eq(crawlReviewAttempts.id, attemptId));
  return attemptId;
}
const outcome = (decision: DelegatedModelOutcome["decision"], confidence: number | null, holdCause: DelegatedModelOutcome["holdCause"]): DelegatedModelOutcome =>
  ({ decision, confidence, holdCause });

describe("AI 위임 결과 갈래 — 지금 원본·세대의 마지막 성공 위임 시도로 나눈다", () => {
  it("근거 부족·확신 부족·사람만 승인·이전 기록·미검토·관리자 보류로 겹치지 않게 나누고, 목록·칩·운영 홈이 같은 수를 낸다", async () => {
    const abstained = await split(0), low = await split(1), humanOnly = await split(2), legacy = await split(3), untouched = await split(4);
    const admin = await split(5), sourceChanged = await split(6), latestWins = await split(7), oldGeneration = await split(8), failed = await split(9);
    const rejected = await split(10);

    await delegated(abstained.row.repo, outcome("needs_review", 0.5, "model_abstained"));
    await delegated(low.row.repo, outcome("approve", 0.72, "low_confidence"));
    await delegated(humanOnly.row.repo, outcome("approve", 0.95, "stale_evidence"));
    await delegated(legacy.row.repo, null);
    await db.update(crawlCandidates).set({ decidedBy: "admin" }).where(eq(crawlCandidates.id, admin.row.id));

    // 원본을 다시 받았다 — 이전 원본의 근거 부족은 지금 원본의 판단이 아니다
    await delegated(sourceChanged.row.repo, outcome("needs_review", 0.4, "model_abstained"));
    await db.update(crawlDocuments).set({ fetchedAt: new Date(), pageMeta: { title: "Delegate 6", description: "A rewritten application page" } })
      .where(eq(crawlDocuments.id, sourceChanged.document.id));

    // 같은 원본에 성공 시도가 둘이면 나중 것(id 큰 것)을 본다 — 옛 행 뒤에 까닭을 적은 행
    const first = await delegated(latestWins.row.repo, null);
    const [copy] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, first));
    const { id: _id, ...rest } = copy;
    void _id;
    await db.insert(crawlReviewAttempts).values({ ...rest, modelOutcome: outcome("needs_review", 0.6, "model_abstained") });

    // 스위치 세대가 바뀐 뒤의 옛 세대 판단 — 위임 잡이 다시 집으므로 미검토
    const old = await delegated(oldGeneration.row.repo, outcome("needs_review", 0.3, "model_abstained"));
    await db.update(crawlReviewAttempts).set({ actor: "m3-deepseek:999999" }).where(eq(crawlReviewAttempts.id, old));

    // 실패한 시도만 있으면 판단이 아니다
    await withHumanJob(async lease => {
      const claim = await claimHumanReview(failed.row.repo, lease);
      if (!claim) throw new Error("claim_failed");
      expect(await recordHumanReview(claim, { ok: false, error: "timeout" })).toBe("failed");
    });
    await db.update(crawlCandidates).set({ state: "rejected" }).where(eq(crawlCandidates.id, rejected.row.id));

    const settings = await getSettings();
    const groups = await readDelegateGroups(settings);
    expect(groups.ids).toEqual({
      abstained: [abstained.row.id, latestWins.row.id], low_confidence: [low.row.id], human_only: [humanOnly.row.id], legacy: [legacy.row.id],
      unreviewed: [untouched.row.id, sourceChanged.row.id, oldGeneration.row.id, failed.row.id], admin: [admin.row.id],
    });

    // 상세의 위임 의견 — 갈래와 같은 시도. 원본이 바뀐·세대가 다른 판단은 current=false
    const opinions = await delegateOpinions(settings, [abstained, low, legacy, untouched, sourceChanged, latestWins, oldGeneration].map(item => item.row.id));
    expect(opinions.get(abstained.row.id)).toMatchObject({ current: true, applied: "needs_review", confidence: 0.5,
      model: { decision: "needs_review", holdCause: "model_abstained" }, reason: "Unclear from the evidence." });
    expect(opinions.get(low.row.id)).toMatchObject({ current: true, confidence: 0.72, model: { decision: "approve", holdCause: "low_confidence" } });
    expect(opinions.get(legacy.row.id)).toMatchObject({ current: true, model: null, applied: "needs_review", confidence: 0.5 });
    expect(opinions.get(latestWins.row.id)).toMatchObject({ current: true, model: { confidence: 0.6, holdCause: "model_abstained" } });
    expect(opinions.get(sourceChanged.row.id)).toMatchObject({ current: false });
    expect(opinions.get(oldGeneration.row.id)).toMatchObject({ current: false });
    expect(opinions.has(untouched.row.id)).toBe(false);

    // 심사 목록 ?tab=human&delegate=abstained — 근거 부족만 남은 사람 몫 목록, 줄마다 위임 의견이 붙는다
    const overview = await humanQueueOverview(settings);
    const options = prototypeReviewOptions(prototypeReviewFilter({ tab: "human", delegate: "abstained" }), null, overview, groups);
    const list = await listAdminReviewEntries(settings, { ...options, limit: 30 });
    expect(list.total).toBe(2);
    expect(list.entries.map(entry => entry.candidate.id).sort((a, b) => a - b)).toEqual([abstained.row.id, latestWins.row.id]);
    expect(list.entries.every(entry => entry.delegate?.model?.holdCause === "model_abstained")).toBe(true);

    // 운영 홈 「사람이 처리할 일」 — 같은 사람 몫 범위 안의 수(거부된 후보는 없다)
    const summary = await readHumanDelegateSummary(true);
    expect(summary.counts).toEqual({ abstained: 2, low_confidence: 1, human_only: 1, legacy: 1, unreviewed: 4, admin: 1 });
  });
});
