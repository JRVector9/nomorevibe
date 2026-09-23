import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, products, textTranslations } from "@/lib/db/schema";
import { listProducts } from "@/lib/domain/products/repository";
import { resolveSearchQuery } from "@/lib/domain/products/search-translation";
import { ensureSchema, resetTables } from "./setup";

/**
 * 검색 품질 — "무엇을 찾으면 무엇이 앞에 와야 하는가"를 적어 둔다.
 *
 * 화면이 하는 그대로 돈다: 검색어를 풀고(resolveSearchQuery — 번역·넓히기) 관련도순으로 목록을 뽑는다.
 * 제품은 프로드에서 실제로 본 것들을 본떴다. 여기 없는 실패는 운영센터의 "못 찾은 말"에서 찾아 더한다.
 */

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(textTranslations).where(eq(textTranslations.targetLang, "en"));
  // 게이트웨이를 부르지 않는다 — 번역이 필요한 경우는 번역 캐시를 미리 넣어 둔다
  delete process.env.ABCLLM_API_KEY;
});

let clock = 0;
async function seed(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  // 나중에 넣은 것이 더 최근이다 — 동점이면 최근이 앞이라, 순서가 실력으로 갈리는지 보려고 일부러 뒤에 넣기도 한다
  const createdAt = new Date(Date.UTC(2026, 8, 1) + ++clock * 60_000);
  await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug,
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    createdAt, ...values,
  });
}

async function find(query: string, limit = 10): Promise<string[]> {
  const resolved = await resolveSearchQuery(query);
  const rows = await listProducts({ statuses: ["seeded", "verified"], sort: "relevance", limit, query: resolved.queries });
  return rows.map((row) => row.slug);
}

describe("정확도", () => {
  it("이름이 검색어와 같으면 맨 앞 — 본문에 그 이름을 여러 번 쓴 제품보다", async () => {
    await seed("meetingly", { name: "Meetingly", tagline: "Summarize your meetings", description: "Summarize your meetings" });
    await seed("notes-pro", {
      name: "Notes Pro", tagline: "Import from Meetingly and more", description: "Works with Meetingly exports",
      searchPageText: "meetingly meetingly meetingly import meetingly notes",
    });
    expect((await find("meetingly"))[0]).toBe("meetingly");
  });

  it("'도구'·'앱' 같은 흔한 말이 소개에 없어도 찾는다", async () => {
    await seed("pdfree", { name: "PDFree", tagline: "Merge PDF files in your browser", description: "Merge PDF files in your browser" });
    expect(await find("pdf merge tool")).toContain("pdfree");
  });

  it("긴 문장으로 물어도 찾는다 — 모든 낱말이 있어야만 맞던 것을 넓힌다", async () => {
    await seed("expense-budget-tracker", { name: "Expense Budget Tracker", tagline: "Track expenses and budgets", description: "Track expenses and budgets" });
    expect(await find("an app to track my daily expenses and budget")).toContain("expense-budget-tracker");
  });

  it("넓혀도 더 많이 맞는 것이 앞이다", async () => {
    await seed("full-match", { name: "Budgetly", tagline: "Track daily expenses and budgets", description: "Track daily expenses and budgets" });
    await seed("partial-match", { name: "Tracky", tagline: "Track your habits", description: "Track your habits" });
    const results = await find("track my daily expenses and budget");
    expect(results[0]).toBe("full-match");
  });

  it("넉넉히 맞으면 넓히지 않는다 — 좁은 검색이 흐려지지 않게", async () => {
    for (let i = 0; i < 6; i++) await seed(`pdf-${i}`, { name: `Pdf ${i}`, tagline: "Merge PDF files", description: "Merge PDF files" });
    await seed("merge-only", { name: "Merger", tagline: "Merge spreadsheets", description: "Merge spreadsheets" });
    expect(await find("merge pdf")).not.toContain("merge-only");
  });

  it("붙어 있는 말이 떨어져 있는 말보다 앞이다", async () => {
    await seed("code-review", { name: "Reviewer", tagline: "AI code review for pull requests", description: "AI code review for pull requests" });
    // 더 최근에 넣는다 — 점수가 같으면 이쪽이 앞으로 온다
    await seed("apart", { name: "Snippets", tagline: "Write code snippets and review your notes later", description: "Write code snippets and review your notes later" });
    expect((await find("code review"))[0]).toBe("code-review");
  });

  it("관련도가 같으면 별이 많은 것이 앞이다", async () => {
    await seed("popular", { name: "Invoice A", tagline: "Invoice generator", description: "Invoice generator", stars: 500 });
    await seed("fresh", { name: "Invoice B", tagline: "Invoice generator", description: "Invoice generator", stars: 3 });
    expect((await find("invoice generator"))[0]).toBe("popular");
  });

  it("흔한 말만 쳐도 그 말로 찾는다", async () => {
    await seed("some-app", { name: "Some App", tagline: "An app", description: "An app" });
    expect(await find("app")).toContain("some-app");
  });

  it("앞부분만 쳐도 찾는다", async () => {
    await seed("ledger", { name: "Ledger", tagline: "Bookkeeping", description: "Bookkeeping" });
    expect(await find("ledg")).toEqual(["ledger"]);
  });
});

describe("한국어와 영어", () => {
  // 2단계(검색 프로필) 몫 — 한국어 제품에 영어로 쓴 검색용 글이 생겨야 풀린다
  it.todo("한국어 제품을 영어로 찾는다");

  it("README 에만 적힌 말로도 찾는다 — 페이지가 비어 있는 제품", async () => {
    await seed("restroom-map", {
      name: "Restroom Map", tagline: "Find a bathroom near you.", description: "Find a bathroom near you.",
      searchReadme: "A crowdsourced map of accessible public restrooms: step-free entry, grab bars, adult changing tables.",
    });
    expect(await find("accessible public toilet map")).toContain("restroom-map");
  });

  it("한국어 제품을 한국어로 찾는다 — 조사가 붙어 있어도", async () => {
    await seed("quote-calc", { name: "견적서 계산기", tagline: "신발 견적서를 계산하세요", description: "신발 견적서를 계산하세요" });
    expect(await find("견적서")).toContain("quote-calc");
  });

  it("영어 제품을 한국어로 찾는다(번역한 말로)", async () => {
    await seed("meetingly", { name: "Meetingly", tagline: "Summarize your meetings", description: "Summarize your meetings" });
    const { textHash } = await import("@/lib/crawl/translate");
    const { normalizeQuery } = await import("@/lib/domain/products/search-translation");
    await db.insert(textTranslations).values({ sourceHash: textHash(normalizeQuery("회의록 요약")), targetLang: "en", status: "done", translated: "meeting summary" });
    expect(await find("회의록 요약")).toContain("meetingly");
  });
});
