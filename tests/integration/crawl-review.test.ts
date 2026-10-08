import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlFrontier, crawlDocuments, crawlCandidates, crawlReviewAttempts } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { decideCandidate } from "@/lib/crawl/review";
import { auditFloor, auditRowsAfter, ensureSchema } from "./setup";
import { getSettings } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { candidateRevisionHash, overrideCandidate, undoAdminDecision } from "@/lib/crawl/admin-review";

/** 규칙이 가르지 못해 사람에게 온 후보 */
async function pending(repo: string) {
  await crawl.putDocument({ repo, repoMeta: { description: 'A deployed product' }, productUrl: 'https://my-app.test',
    pageMeta: { title: 'My app', description: 'A deployed product', repositoryKeys: [repo] }, pageStatus: 200 });
  await crawl.recordJudgement({
    repo,
    productUrl: "https://my-app.test",
    state: "needs_review",
    reason: "ambiguous",
    decidedBy: "auto",
    signals: { stars: 7, pageStatus: 200 },
  });
}

async function currentInput(repo: string) {
  const candidate = (await crawl.getCandidate(repo))!;
  const document = (await crawl.getDocument(repo))!;
  const input = await loadReviewInput(candidate, document, await getSettings());
  return { inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
    candidateRevisionHash: candidateRevisionHash(candidate), note: '운영자가 제품과 공개 근거를 직접 확인했습니다.' };
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
});

describe("심사", () => {
  it("승인하면 발행 대상이 된다", async () => {
    await pending("someone/my-app");

    expect(await decideCandidate({ repo: "someone/my-app", decision: "approve", admin: "jr", ...await currentInput('someone/my-app') })).toEqual({
      ok: true,
    });

    const candidate = await crawl.getCandidate("someone/my-app");
    expect(candidate).toMatchObject({ state: "approved", reason: "passed", decidedBy: "admin" });
    expect(candidate?.decidedAt).toBeInstanceOf(Date);
  });

  it("거부하면 고른 사유가 남는다", async () => {
    await pending("someone/blog");

    await decideCandidate({
      repo: "someone/blog",
      decision: "reject",
      reason: "personal_site",
      admin: "jr",
      ...await currentInput('someone/blog'),
    });

    expect(await crawl.getCandidate("someone/blog")).toMatchObject({
      state: "rejected",
      reason: "personal_site",
      decidedBy: "admin",
    });
  });

  it("자동 판정이 남긴 근거를 지우지 않는다", async () => {
    // recordJudgement는 행을 통째로 덮어쓴다. 넘기지 않으면 왜 그렇게 갈렸는지가 사라진다
    await pending("someone/my-app");

    await decideCandidate({ repo: "someone/my-app", decision: "approve", admin: "jr", ...await currentInput('someone/my-app') });

    const candidate = await crawl.getCandidate("someone/my-app");
    expect(candidate?.signals).toMatchObject({ stars: 7, pageStatus: 200 });
    expect(candidate?.productUrl).toBe("https://my-app.test");
  });

  it("모르는 거부 사유는 받지 않는다", async () => {
    await pending("someone/my-app");

    const result = await decideCandidate({
      repo: "someone/my-app",
      decision: "reject",
      reason: "그냥",
      admin: "jr",
      ...await currentInput('someone/my-app'),
    });

    expect(result).toMatchObject({ ok: false });
    // 아무것도 바꾸지 않는다
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ state: "needs_review" });
  });

  it("이미 발행된 후보는 되돌리지 않는다", async () => {
    await pending("someone/published");
    await crawl.markPublished("someone/published", "published-app");

    const result = await decideCandidate({
      repo: "someone/published",
      decision: "reject",
      reason: "not_a_product",
      admin: "jr",
    });

    expect(result).toMatchObject({ ok: false });
    expect(await crawl.getCandidate("someone/published")).toMatchObject({ state: "published" });
  });

  it("없는 후보는 조용히 성공하지 않는다", async () => {
    expect(await decideCandidate({ repo: "없는/레포", decision: "approve", admin: "jr" })).toMatchObject({
      ok: false,
    });
  });

  it('requires a reason and rejects stale concurrent admin decisions with a durable audit', async () => {
    await pending('someone/my-app');
    const input = await currentInput('someone/my-app');
    expect(await decideCandidate({ repo: 'someone/my-app', decision: 'approve', admin: 'jr', ...input, note: ' ' })).toMatchObject({ ok: false });
    expect(await decideCandidate({ repo: 'someone/my-app', decision: 'approve', admin: 'jr', ...input })).toEqual({ ok: true });
    expect(await decideCandidate({ repo: 'someone/my-app', decision: 'reject', reason: 'personal_site', admin: 'second-admin', ...input })).toMatchObject({ ok: false });
    const audits = await db.select().from(crawlReviewAttempts);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ kind: 'admin_override', state: 'succeeded', actor: 'jr', inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, reason: input.note });
  });
});

describe("결정 되돌리기", () => {
  /** 관리자 결정 — 화면의 서버 액션이 부르는 것과 같은 함수 */
  async function decide(repo: string, decision: 'approve' | 'reject') {
    const { note, ...hashes } = await currentInput(repo);
    const result = await overrideCandidate({ repo, actor: 'jr', decision, reasonCode: decision === 'approve' ? 'passed' : 'not_a_product', reason: note, ...hashes });
    if (!result.ok) throw new Error(result.message);
    return result;
  }

  it("결정 뒤 아무 일도 없었으면 결정 앞 상태로 돌리고, 결정 기록은 닫고, 되돌림을 작업 로그에 새 줄로 남긴다", async () => {
    await pending('someone/undo');
    const before = (await crawl.getCandidate('someone/undo'))!;
    const floor = await auditFloor();
    const decided = await decide('someone/undo', 'reject');
    expect(decided.previous).toEqual({ state: 'needs_review', reason: 'ambiguous' });
    expect(await crawl.getCandidate('someone/undo')).toMatchObject({ state: 'rejected', decidedBy: 'admin' });

    expect(await undoAdminDecision({ repo: 'someone/undo', attemptId: decided.attemptId, actor: 'jr' }))
      .toEqual({ ok: true, restored: { state: 'needs_review', reason: 'ambiguous' } });
    const after = (await crawl.getCandidate('someone/undo'))!;
    expect(after).toMatchObject({ state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto', decidedAt: before.decidedAt, judgedAt: before.judgedAt });
    expect(after.signals).toEqual(before.signals);
    const [attempt] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, decided.attemptId));
    expect(attempt).toMatchObject({ state: 'superseded', errorCode: 'admin_undo' });
    const logged = await auditRowsAfter(floor, 'candidate-undo');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor: 'jr', target: 'someone/undo', ok: true,
      detail: { attemptId: decided.attemptId, from: { state: 'rejected' }, to: { state: 'needs_review', reason: 'ambiguous' } } });

    // 같은 결정을 두 번 되돌리지 않는다. 되돌린 뒤에는 새로 결정할 수 있다
    expect(await undoAdminDecision({ repo: 'someone/undo', attemptId: decided.attemptId, actor: 'jr' })).toMatchObject({ ok: false });
    expect((await decide('someone/undo', 'approve')).ok).toBe(true);
  });

  it("발행 워커가 이미 발행했으면 되돌리지 않고 그 사유를 알린다", async () => {
    await pending('someone/shipped');
    const decided = await decide('someone/shipped', 'approve');
    await crawl.markPublished('someone/shipped', 'shipped-app');
    const result = await undoAdminDecision({ repo: 'someone/shipped', attemptId: decided.attemptId, actor: 'jr' });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('발행 워커가 이미 발행했습니다') });
    expect(await crawl.getCandidate('someone/shipped')).toMatchObject({ state: 'published', publishedSlug: 'shipped-app' });
  });

  it("결정 뒤에 다른 일이 후보를 바꿨으면(발행 워커가 막아 보류로 돌림) 되돌리지 않는다", async () => {
    await pending('someone/guarded');
    const decided = await decide('someone/guarded', 'approve');
    await db.update(crawlCandidates).set({ state: 'needs_review', reason: 'already_listed', updatedAt: new Date(Date.now() + 1000) })
      .where(eq(crawlCandidates.repo, 'someone/guarded'));
    expect(await undoAdminDecision({ repo: 'someone/guarded', attemptId: decided.attemptId, actor: 'jr' }))
      .toMatchObject({ ok: false, message: expect.stringContaining('이미 이 후보를 처리했습니다') });
    expect(await crawl.getCandidate('someone/guarded')).toMatchObject({ state: 'needs_review', reason: 'already_listed' });
  });
});
