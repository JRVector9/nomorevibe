import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments } from "@/lib/db/schema";
import { dequeue, enqueue, getDocument, saveFetchedDocument } from "@/lib/crawl/repository";
import { crawlFrontier } from "@/lib/db/schema";
import { loadReviewDocument } from "@/lib/crawl/jobs/review-document";
import { loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { ensureSchema } from "./setup";
import { claimFetchFixtureJob } from "./fetch-fixtures";

/**
 * 2026-11-17 운영: 1차 심사 스냅숏 product.readme 가 11-08 이후 99.8% 빈 글자였다(설치형 100%).
 *
 * 원본 저장(saveFetchedDocument)은 fetched_at 을 clock_timestamp() — 마이크로초까지 — 로 쓴다. 심사가 README 를 받아
 * 원본 옆에 붙일 때(setReadmeSample)는 읽어 온 JS Date(밀리초)로 fetched_at 을 대조해서, 마이크로초가 0 이 아닌 거의 모든 원본에서
 * 쓰기가 0행으로 끝났다. 그러면 다시 읽은 원본(README 없음)으로 심사 입력이 만들어져 모델은 「README·pageText 가 비어 있음」을 본다.
 * 시험은 운영과 같은 마이크로초 시각으로 원본을 저장한다(putDocument 의 new Date() 는 밀리초라 이 결함을 보지 못했다).
 */
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/crawl/readme", async original => ({
  ...await original<typeof import("@/lib/crawl/readme")>(), fetchReadmeSample: mocks.fetch,
}));

const README = "Agent Bridge MCP — an MCP server. Install with npx agent-bridge-mcp and add it to your Claude config.";

async function clean() {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
}
beforeAll(() => ensureSchema());
beforeEach(async () => { vi.resetAllMocks(); await clean(); });
// 빈 후보 표를 전제로 하는 직렬 파일(pipeline-consumer 등)이 뒤에 와도 깨지지 않게 남기지 않는다
afterAll(clean);

/** saveFetchedDocument 처럼 fetched_at 을 DB 시계(마이크로초)로 쓴다. 밀리초 경계에 우연히 걸리지 않게 456µs 를 더한다 */
async function saveLikeCrawler(repo: string, productUrl: string | null, pageMeta: Record<string, unknown> | null) {
  const values = { repo, productUrl, pageStatus: productUrl ? 200 : null, pageMeta,
    repoMeta: { stargazers_count: 12, description: "bridge" },
    fetchedAt: sql`date_trunc('milliseconds', clock_timestamp()) + interval '456 microseconds'` };
  await db.insert(crawlDocuments).values(values as never);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "new", judgedAt: new Date() }).returning();
  return candidate;
}

async function firstReviewReadme(repo: string) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  const document = await loadReviewDocument(repo);
  expect(document).toBeDefined();
  const input = await loadReviewInput(candidate, document!, mergeWithDefaults({}));
  return input.snapshot.product.readme;
}

it("fills the first-review README of an installable document without a page (page_meta null)", async () => {
  await saveLikeCrawler("vstratful/agent-bridge-mcp", null, null);
  mocks.fetch.mockResolvedValue(README);
  expect(await firstReviewReadme("vstratful/agent-bridge-mcp")).toBe(README);
  expect((await getDocument("vstratful/agent-bridge-mcp"))?.pageMeta)
    .toEqual({ readmeSample: README, readmeSampleVersion: README_SAMPLE_VERSION });
  // 한 번 붙은 README 는 다음 심사에서 다시 받지 않는다
  await loadReviewDocument("vstratful/agent-bridge-mcp");
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("fills the first-review README of a document with a product page", async () => {
  await saveLikeCrawler("acme/site-tool", "https://site-tool.example/", { title: "Site tool", textSample: "Sign up" });
  mocks.fetch.mockResolvedValue(README);
  expect(await firstReviewReadme("acme/site-tool")).toBe(README);
  expect((await getDocument("acme/site-tool"))?.pageMeta).toMatchObject({ title: "Site tool", readmeSample: README });
});

it("still refuses to attach a README to a document recrawled while the README was in flight", async () => {
  await saveLikeCrawler("acme/racing", null, null);
  mocks.fetch.mockImplementation(async () => {
    await db.update(crawlDocuments).set({ pageMeta: { title: "new website" }, fetchedAt: sql`clock_timestamp()` })
      .where(eq(crawlDocuments.repo, "acme/racing"));
    return "stale";
  });
  expect((await loadReviewDocument("acme/racing"))?.pageMeta).toEqual({ title: "new website" });
});

it("does not reopen an approved candidate only because a recrawl invalidated its README version", async () => {
  const repo = "acme/approved-tool";
  const candidate = await saveLikeCrawler(repo, null, { readmeSample: README, readmeSampleVersion: README_SAMPLE_VERSION });
  await db.update(crawlCandidates).set({ state: "approved", decidedBy: "auto", decidedAt: new Date() })
    .where(eq(crawlCandidates.id, candidate.id));
  const repoMeta = (await getDocument(repo))!.repoMeta;
  await enqueue([{ repo, signal: "commit-trailer" }]);
  const [claim] = await dequeue(1, undefined, await claimFetchFixtureJob());
  expect(await saveFetchedDocument(claim, { repo, repoMeta, productUrl: null, pageStatus: null, pageMeta: null })).not.toBeNull();
  // 다시 수집은 README 를 옮겨 오며 판만 지운다(다음 심사에서 다시 받게) — 페이지 내용은 그대로이므로 승인을 new 로 되돌리지 않는다
  expect((await getDocument(repo))?.pageMeta).toEqual({ readmeSample: README, readmeSampleVersion: null });
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)))[0].state).toBe("approved");
});
