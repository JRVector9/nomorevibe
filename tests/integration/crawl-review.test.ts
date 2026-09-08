import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { crawlFrontier, crawlDocuments, crawlCandidates, crawlReviewAttempts } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { decideCandidate } from "@/lib/crawl/review";
import { ensureSchema } from "./setup";
import { getSettings } from "@/lib/crawl/settings";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { candidateRevisionHash } from "@/lib/crawl/admin-review";

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
