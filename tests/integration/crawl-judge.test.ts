import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
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

  /**
   * 승인에서 발행까지 스케줄(5분)을 기다리지 않는다. 다만 후보마다가 아니라 묶음이 끝날 때
   * 한 번이다 — 후보마다 부르면 잡 행 하나를 두고 경합한다.
   */
  it("승인한 묶음은 발행을 한 번만 요청한다", async () => {
    await putDocument({ repo: "someone/one", productUrl: "https://one.test" });
    await putDocument({ repo: "someone/two", productUrl: "https://two.test" });

    await tick();

    expect(await crawl.candidateCounts()).toEqual({ approved: 2 });
    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-publish") }))
      .toMatchObject({ requestedVersion: 1, processedVersion: 0 });
  });

  it("승인한 것이 없으면 발행을 요청하지 않는다", async () => {
    await putDocument({ repo: "someone/no-deploy", productUrl: null, pageStatus: null });

    await tick();

    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-publish") })).toBeUndefined();
  });

  it("대기 목록을 읽을 때 가져온 후보를 다시 조회하지 않는다", async () => {
    await putDocument({ repo: "someone/one", productUrl: "https://one.test" });
    await putDocument({ repo: "someone/two", productUrl: "https://two.test" });
    await crawl.recordJudgement({ repo: "someone/two", productUrl: "https://two.test",
      state: "new", reason: "source_changed", decidedBy: "auto" });
    const spy = vi.spyOn(crawl, "getCandidate");
    try {
      await tick();
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(await crawl.candidateCounts()).toEqual({ approved: 2 });
  });

  it("수집이 꺼져 있으면 아무것도 판정하지 않는다", async () => {
    await saveSettings({ enabled: false }, "테스트");
    await putDocument({ repo: "someone/my-app" });

    const result = await tick();

    expect(result).toMatchObject({ status: "completed", done: true });
    expect(await crawl.getCandidate("someone/my-app")).toBeUndefined();
  });

  it.each([false,true])("비동기 판정 중 관리자 거부가 도착하면 보존한다 (기존 new 후보 %s)", async existing => {
    await putDocument({repo:"someone/my-app"});
    if (existing) await crawl.recordJudgement({repo:"someone/my-app",productUrl:"https://my-app.test",state:"new",reason:"passed",decidedBy:"auto"});
    const findByUrl = products.findByUrl;
    const spy = vi.spyOn(products,"findByUrl").mockImplementationOnce(async url => {
      await crawl.recordJudgement({repo:"someone/my-app",productUrl:url,state:"rejected",reason:"banned",decidedBy:"admin",signals:{review:"newer admin"}});
      return findByUrl(url);
    });
    try {
      expect(await tick()).toMatchObject({status:"completed",done:false});
      expect(await crawl.getCandidate("someone/my-app")).toMatchObject({state:"rejected",reason:"banned",decidedBy:"admin",signals:{review:"newer admin"}});
    } finally {spy.mockRestore();}
  });

  it("비동기 판정 중 문서 URL이 바뀌면 과거 결과를 저장하지 않는다", async () => {
    await putDocument({repo:"someone/my-app"});
    const findByUrl = products.findByUrl;
    const spy = vi.spyOn(products,"findByUrl").mockImplementationOnce(async url => {
      await putDocument({repo:"someone/my-app",productUrl:"https://changed.test"});
      return findByUrl(url);
    });
    try {
      expect(await tick()).toMatchObject({status:"completed",done:false});
      expect(await crawl.getCandidate("someone/my-app")).toBeUndefined();
      expect(await crawl.getDocument("someone/my-app")).toMatchObject({productUrl:"https://changed.test"});
    } finally {spy.mockRestore();}
  });

  it("비동기 판정 중 설정이 바뀌면 최신 설정으로 다시 판단한다", async () => {
    await putDocument({repo:"someone/my-app"});
    const findByUrl = products.findByUrl;
    const spy = vi.spyOn(products,"findByUrl").mockImplementationOnce(async url => {
      await saveSettings({judge:{maxStars:1}},"concurrent admin");
      return findByUrl(url);
    });
    try {
      expect(await tick()).toMatchObject({status:"completed",done:false});
      expect(await crawl.getCandidate("someone/my-app")).toBeUndefined();
    } finally {spy.mockRestore();}
    expect(await tick()).toMatchObject({status:"completed",done:true});
    expect(await crawl.getCandidate("someone/my-app")).toMatchObject({reason:"large_oss",state:"rejected"});
  });
});
