import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { crawlFrontier, crawlDocuments, crawlCandidates } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { decideCandidate } from "@/lib/crawl/review";
import { ensureSchema } from "./setup";

/** 규칙이 가르지 못해 사람에게 온 후보 */
async function pending(repo: string) {
  await crawl.recordJudgement({
    repo,
    productUrl: "https://my-app.test",
    state: "needs_review",
    reason: "ambiguous",
    decidedBy: "auto",
    signals: { stars: 7, pageStatus: 200 },
  });
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

    expect(await decideCandidate({ repo: "someone/my-app", decision: "approve", admin: "jr" })).toEqual({
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

    await decideCandidate({ repo: "someone/my-app", decision: "approve", admin: "jr" });

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
});
