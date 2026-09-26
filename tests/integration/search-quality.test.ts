import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, products, textTranslations } from "@/lib/db/schema";
import { listProducts } from "@/lib/domain/products/repository";
import { queryTranslationKey, resolveSearchQuery } from "@/lib/domain/products/search-translation";
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

  it("넓혀도 다 맞는 것이 이름에 두 낱말이 든 것보다 앞이다", async () => {
    // 2026-09-23 프로드: "soccer manager game" 에서 이름에 manager·game 이 든 제품들이 세 낱말이 다 맞는
    // 축구 매니저 게임을 20위 밖으로 밀었다
    await seed("club-season", { name: "Club Season", tagline: "Build a squad and climb the league", description: "Build a squad and climb the league",
      searchPageText: "A soccer club manager game played over a shared season." });
    for (let i = 0; i < 5; i++) await seed(`manager-${i}`, { name: `Game Manager ${i}`, tagline: "Manage your game library", description: "Manage your game library" });
    expect((await find("soccer manager game"))[0]).toBe("club-season");
  });

  it("넓힐 때도 하나만 빠진 것까지다 — 한 낱말만 맞는 것은 들이지 않는다", async () => {
    await seed("restroom-map", { name: "Restroom Map", tagline: "Accessible public restrooms on a map", description: "Accessible public restrooms on a map" });
    await seed("just-map", { name: "Mapper", tagline: "Draw a map", description: "Draw a map" });
    const results = await find("accessible public toilet map");
    expect(results).toContain("restroom-map");
    expect(results).not.toContain("just-map");
  });

  it("결과가 넉넉해도 낱말 셋 이상이면 하나 빠진 것까지 들인다 — 다 맞은 것이 앞이다", async () => {
    // 2026-09-26 프로드: "japanese vocabulary trainer" 는 36건이 다 맞아 넓히지 않았고, 정답에는 "trainer"가 없었다
    for (let i = 0; i < 6; i++) await seed(`trainer-${i}`, { name: `Trainer ${i}`, tagline: "Japanese vocabulary trainer", description: "Japanese vocabulary trainer" });
    await seed("vocab-notebook", { name: "Vocab Notebook", tagline: "Record and review Japanese vocabulary", description: "Record and review Japanese vocabulary" });
    const results = await find("japanese vocabulary trainer", 20);
    expect(results).toContain("vocab-notebook");
    expect(results.indexOf("vocab-notebook")).toBeGreaterThan(Math.max(...[0, 1, 2, 3, 4, 5].map((i) => results.indexOf(`trainer-${i}`))));
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

describe("한국식 영어", () => {
  it("드라마는 번역(drama)과 함께 tv series 로도 찾는다", async () => {
    await seed("show-picks", { name: "Show Picks", tagline: "Pick your next TV series", description: "Pick your next TV series" });
    await db.insert(textTranslations).values({ sourceHash: queryTranslationKey("드라마 추천"), targetLang: "en", status: "done", translated: "drama recommendation" });
    const resolved = await resolveSearchQuery("드라마 추천");
    expect(resolved.translated).toBe("drama recommendation / tv series");
    expect(await find("드라마 추천")).toContain("show-picks");
  });
});

describe("본문·README 로만 걸린 것", () => {
  it("넓힌 검색에서 이름·소개에 맞은 제품이 README 에만 다 맞은 제품보다 앞이다", async () => {
    // 세 낱말 중 둘이 소개에 있는 것과, 셋 다 README 에만 있는 것 — 결과가 적어 넓힌 검색(most)이 된다
    // 둘 다 검색 키워드가 있다(공개분 거의 전부가 그렇다)
    await seed("mood-journal", { name: "Mood Journal", tagline: "Daily mood journal", description: "Daily mood journal", searchKeywords: "mood tracker · 기분 일기" });
    await seed("sdk-kit", { name: "SDK Kit", tagline: "Build faster", description: "Build faster", searchKeywords: "developer sdk · 개발 도구",
      searchReadme: "example app: a daily mood journal with voice notes" });
    expect((await find("mood journal voice"))[0]).toBe("mood-journal");
  });

  it("검색 키워드가 없는 제품은 예전처럼 본문까지 센다 — 소개가 무엇인지 말하지 않으면 본문이 유일한 설명이다", async () => {
    await seed("club-season", { name: "Club Season", tagline: "Build a squad and climb the league", description: "Build a squad and climb the league",
      searchPageText: "A soccer club manager game played over a shared season." });
    for (let i = 0; i < 5; i++) await seed(`manager-${i}`, { name: `Game Manager ${i}`, tagline: "Manage your game library", description: "Manage your game library", searchKeywords: "game library" });
    expect((await find("soccer manager game"))[0]).toBe("club-season");
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
    await db.insert(textTranslations).values({ sourceHash: queryTranslationKey("회의록 요약"), targetLang: "en", status: "done", translated: "meeting summary" });
    expect(await find("회의록 요약")).toContain("meetingly");
  });

  it("번역한 두 표현은 한 번만 센다 — 한국어로 정확히 맞은 제품을 영어 표현 둘이 겹쳐 누르지 않게", async () => {
    await seed("wheel-check", { name: "Wheel Check", tagline: "그라인더 숫돌 호환 확인", description: "그라인더 숫돌 호환 확인" });
    await seed("api-gateway", { name: "API Gateway", tagline: "compatibility check and software compatibility verification for model APIs",
      description: "compatibility check and software compatibility verification for model APIs" });
    await db.insert(textTranslations).values({ sourceHash: queryTranslationKey("숫돌 호환 확인"), targetLang: "en", status: "done",
      translated: "compatibility check | software compatibility verification" });

    const resolved = await resolveSearchQuery("숫돌 호환 확인");
    expect(resolved.translated).toBe("compatibility check / software compatibility verification");
    expect((await find("숫돌 호환 확인"))[0]).toBe("wheel-check");
  });
});
