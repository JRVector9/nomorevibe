import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * 삭제 뒤 slug 재사용 — 수집 원본 연결.
 *
 * crawl_candidates.published_slug는 FK가 아니라 문자열이고, nextAvailableSlug는 비어 있는
 * slug를 다시 쓴다. 삭제가 이 연결을 풀지 않으면 같은 이름으로 들어온 새 제품이 지워진
 * 제품의 레포·문서를 물려받아, 재검수가 새 제품을 남의 원본으로 판정하고 생존 확인이
 * 새 제품의 본문으로 남의 문서를 덮는다.
 */

const fetchPage = vi.fn();
vi.mock("@/lib/net/fetch", () => ({
  fetchPage: (...a: unknown[]) => fetchPage(...a),
  safeFetch: vi.fn().mockResolvedValue(null),
  readBodyCapped: vi.fn(),
}));

const { eq } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { crawlCandidates, crawlDocuments } = await import("@/lib/db/schema");
const repo = await import("@/lib/domain/products/repository");
const { verifyProduct } = await import("@/lib/domain/products/verify");
const { registerProduct } = await import("@/lib/domain/products/register");
const { deleteProduct } = await import("@/lib/domain/products/manage");
const { recheckableCount } = await import("@/lib/domain/products/recheck");
const { refreshTextSample } = await import("@/lib/crawl/repository");
const { ensureSchema, resetTables } = await import("./setup");

const SOURCE_REPO = "someone/found-app";
const SEED_TOKEN = "nmv_verify_found_app";

/** 수집기가 발행한 제품과 그 원본 */
async function publishedFromCrawl() {
  await repo.insert({
    slug: "found-app",
    url: "https://found.test",
    name: "Found App",
    tagline: "수집된 소개",
    description: "공개 저장소에서 찾은 제품입니다.",
    category: "Other",
    stack: [],
    status: "seeded",
    source: "crawler",
    verifyToken: SEED_TOKEN,
    editTokenHash: "x".repeat(64),
  });
  await db.insert(crawlDocuments).values({
    repo: SOURCE_REPO,
    repoMeta: { description: "이전 제품의 레포" },
    productUrl: "https://found.test",
    pageStatus: 200,
    pageMeta: { title: "Found App", textSample: "이전 제품의 본문" },
  });
  await db.insert(crawlCandidates).values({
    repo: SOURCE_REPO,
    productUrl: "https://found.test",
    state: "published",
    reason: "passed",
    decidedBy: "auto",
    publishedSlug: "found-app",
  });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  // resetTables는 수집 테이블을 비우지 않는다
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await resetTables();
  fetchPage.mockReset();
});

describe("삭제 뒤 slug 재사용 — 수집 원본", () => {
  it("클레임한 주인이 지운 slug를 새 제품이 얻어도 이전 레포·문서가 따라오지 않는다", async () => {
    await publishedFromCrawl();
    fetchPage.mockResolvedValueOnce({ status: 200, html: SEED_TOKEN });
    const claim = await verifyProduct("found-app");
    if (!claim.ok || !claim.value.edit_token) throw new Error("사전 조건: 클레임 실패");

    expect(await deleteProduct("found-app", { editToken: claim.value.edit_token }))
      .toMatchObject({ ok: true });
    fetchPage.mockResolvedValue({ status: 200, html: "<html></html>" });
    const replacement = await registerProduct({
      url: "https://other.test",
      name: "Found App",
      tagline: "다른 사람의 제품",
      description: "이름만 같은 전혀 다른 제품입니다.",
      category: "Dev",
    });
    expect(replacement).toMatchObject({ ok: true, value: { slug: "found-app" } });
    if (!replacement.ok) return;
    // 새 제품도 검증을 마쳐 재검수 대상(verified)이 된다
    fetchPage.mockResolvedValueOnce({ status: 200, html: replacement.value.verifyToken });
    expect(await verifyProduct("found-app")).toMatchObject({ ok: true });

    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, SOURCE_REPO));
    expect(candidate.publishedSlug).toBeNull();
    // 발행 기록은 남는다 — 주인이 지운 것을 수집기가 다시 올리지 않는다
    expect(candidate.state).toBe("published");
    // 재검수는 새 제품을 이전 원본으로 판정하지 않는다
    expect(await recheckableCount()).toBe(0);
    // 생존 확인의 본문 백필은 새 제품의 본문으로 이전 문서를 덮지 않는다
    await refreshTextSample("found-app", "새 제품의 본문");
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, SOURCE_REPO));
    expect(document.pageMeta).toMatchObject({ textSample: "이전 제품의 본문" });
  });

  it("다른 slug를 가리키는 수집 원본은 건드리지 않는다", async () => {
    await publishedFromCrawl();
    await db.insert(crawlCandidates).values({
      repo: "someone/found-app-2",
      productUrl: "https://found-2.test",
      state: "published",
      reason: "passed",
      decidedBy: "auto",
      publishedSlug: "found-app-2",
    });
    const product = await repo.findBySlug("found-app");

    expect(await repo.removeProductAndEvidence(product!.id, "found-app")).toBe(true);

    const rows = await db.select({ repo: crawlCandidates.repo, publishedSlug: crawlCandidates.publishedSlug })
      .from(crawlCandidates).orderBy(crawlCandidates.repo);
    expect(rows).toEqual([
      { repo: SOURCE_REPO, publishedSlug: null },
      { repo: "someone/found-app-2", publishedSlug: "found-app-2" },
    ]);
  });
});
