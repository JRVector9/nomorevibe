import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { crawlFrontier, crawlDocuments, crawlCandidates, crawlSettings } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import * as products from "@/lib/domain/products/repository";
import { saveSettings } from "@/lib/crawl/settings";
import { judgeCrawlDocuments } from "@/lib/crawl/jobs/judge";
import { runJob } from "@/lib/jobs/runner";
import { jobs } from "@/lib/db/schema";
import { ensureSchema, resetTables } from "./setup";

/** 통과할 조건을 갖춘 원본 — 각 테스트는 여기서 한 가지만 바꾼다 */
async function putDocument(over: {
  repo: string;
  productUrl?: string | null;
  pageStatus?: number | null;
  meta?: Record<string, unknown>;
}) {
  await crawl.putDocument({
    repo: over.repo,
    repoMeta: {
      stargazers_count: 12,
      fork: false,
      archived: false,
      pushed_at: new Date().toISOString(),
      owner: { type: "User" },
      ...over.meta,
    },
    productUrl: over.productUrl === undefined ? "https://my-app.test" : over.productUrl,
    pageStatus: over.pageStatus === undefined ? 200 : over.pageStatus,
  });
}

const tick = () => runJob("crawl-judge", judgeCrawlDocuments);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  await saveSettings({ enabled: true }, "테스트");
});

describe("판정 잡", () => {
  it("원본을 판정해 후보로 남긴다", async () => {
    await putDocument({ repo: "someone/my-app" });

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    const candidate = await crawl.getCandidate("someone/my-app");
    expect(candidate).toMatchObject({
      state: "approved",
      reason: "passed",
      decidedBy: "auto",
      productUrl: "https://my-app.test",
    });
    // 왜 그렇게 판정했는지 되짚을 수 있어야 한다
    expect(candidate?.signals).toMatchObject({ stars: 12, ownerType: "User", pageStatus: 200 });
  });

  it("거른 것도 사유와 함께 남긴다", async () => {
    await putDocument({ repo: "someone/no-deploy", productUrl: null, pageStatus: null });
    await putDocument({ repo: "someone/huge", meta: { stargazers_count: 50_000 } });

    await tick();

    expect(await crawl.getCandidate("someone/no-deploy")).toMatchObject({
      state: "rejected",
      reason: "no_homepage",
    });
    expect(await crawl.getCandidate("someone/huge")).toMatchObject({
      state: "rejected",
      reason: "large_oss",
    });
  });

  it("이미 등록된 URL은 거른다 — 규칙만으로는 알 수 없다", async () => {
    await products.insert({
      slug: "my-app",
      url: "https://my-app.test",
      name: "My App",
      tagline: "이미 등록된 제품",
      description: "메이커가 먼저 등록했다.",
      category: "Other",
      stack: [],
      status: "verified",
      source: "skill",
      verifyToken: "nmv_verify_my_app",
      editTokenHash: "x".repeat(64),
    });
    await putDocument({ repo: "someone/my-app" });

    await tick();

    const candidate = await crawl.getCandidate("someone/my-app");
    expect(candidate).toMatchObject({ state: "rejected", reason: "already_listed" });
    expect(candidate?.signals).toMatchObject({ existingSlug: "my-app" });
  });

  it("차단한 URL이 수집기로 되돌아오는 것을 막는다", async () => {
    await products.insert({
      slug: "banned-app",
      url: "https://my-app.test",
      name: "Banned App",
      tagline: "차단된 제품",
      description: "어드민이 차단했다.",
      category: "Other",
      stack: [],
      status: "banned",
      source: "skill",
      verifyToken: "nmv_verify_banned",
      editTokenHash: "x".repeat(64),
    });
    await putDocument({ repo: "someone/my-app" });

    await tick();

    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({
      state: "rejected",
      reason: "banned",
    });
  });

  it("판정한 것은 다시 판정하지 않는다", async () => {
    await putDocument({ repo: "someone/my-app" });
    await tick();
    const first = await crawl.getCandidate("someone/my-app");

    await tick();
    const second = await crawl.getCandidate("someone/my-app");

    expect(second?.judgedAt?.getTime()).toBe(first?.judgedAt?.getTime());
    expect(await crawl.candidateCounts()).toEqual({ approved: 1 });
  });

  it("후보를 new로 되돌리면 다시 판정한다 — 기준을 바꾼 뒤의 재판정 경로다", async () => {
    await putDocument({ repo: "someone/my-app", meta: { stargazers_count: 5_000 } });
    await tick();
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({ reason: "large_oss" });

    // 기준을 올리고 재판정 대기로 되돌린다
    await saveSettings({ judge: { maxStars: 100_000 } }, "테스트");
    await crawl.recordJudgement({
      repo: "someone/my-app",
      productUrl: "https://my-app.test",
      state: "new",
      reason: "passed",
      decidedBy: "admin",
    });

    await tick();

    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({
      state: "approved",
      reason: "passed",
    });
  });

  it("수집이 꺼져 있으면 아무것도 판정하지 않는다", async () => {
    await saveSettings({ enabled: false }, "테스트");
    await putDocument({ repo: "someone/my-app" });

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    expect(await crawl.getCandidate("someone/my-app")).toBeUndefined();
  });
});
