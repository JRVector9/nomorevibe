import { beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, products, textTranslations } from "@/lib/db/schema";
import { listProducts } from "@/lib/domain/products/repository";
import { queryTranslationKey, resolveSearchQuery, warmQueryTranslation } from "@/lib/domain/products/search-translation";
import { searchQueries } from "@/lib/domain/products/search";
import { refreshProductSearchDocuments } from "@/lib/jobs/products/search-refresh";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(textTranslations).where(eq(textTranslations.targetLang, "en"));
});

async function seed(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug,
    category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", ...values,
  });
}

const search = async (query: string) =>
  (await listProducts({ statuses: ["seeded"], sort: "relevance", limit: 10, query })).map((row) => row.slug);

const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} };

it("이름이 본문보다 앞에 온다 — 무게가 없으면 긴 본문이 이름을 덮는다", async () => {
  await seed("meeting-notes", { name: "Meeting Notes", tagline: "Take notes", description: "Take notes" });
  await seed("unrelated-blog", {
    name: "Some Blog", tagline: "A blog", description: "A blog",
    // 본문(D)에만 같은 말이 여러 번 든 제품
    searchPageText: "meeting meeting meeting notes notes notes about many other things entirely",
  });
  expect(await search("meeting notes")).toEqual(["meeting-notes", "unrelated-blog"]);
});

it("소개가 태그라인과 똑같으면 두 번 세지 않는다", async () => {
  // 발행분의 41%가 소개와 태그라인이 바이트까지 같다(2026-09-18 프로드)
  await seed("duplicated", { name: "A", tagline: "invoice generator", description: "invoice generator" });
  await seed("distinct", { name: "B", tagline: "invoice generator", description: "for small teams" });
  const [first] = await search("invoice generator");
  // 같은 말을 두 번 센다면 duplicated 가 늘 이긴다. 둘의 점수가 같아 슬러그 순으로 갈린다
  expect(first).toBe("distinct");
});

it("본문이 없으면 찾지 못하던 것을 찾는다", async () => {
  await seed("mailmate", {
    name: "Mailmate", tagline: "Your inbox", description: "Your inbox",
    searchPageText: "Automatically summarize meetings and send the notes to your team.",
  });
  expect(await search("summarize meetings")).toEqual(["mailmate"]);
});

it("토픽으로도 찾는다", async () => {
  await seed("topical", { name: "Thing", tagline: "A thing", description: "A thing", searchTopics: "kubernetes devops" });
  expect(await search("kubernetes")).toEqual(["topical"]);
});

it("제작 도구는 신고된 제품에서만 찾힌다", async () => {
  await seed("unclaimed", { builder: "UnconfirmedAI", source: "crawler", claimedAt: null });
  await seed("claimed", { builder: "UnconfirmedAI", source: "crawler", claimedAt: new Date() });
  expect(await search("UnconfirmedAI")).toEqual(["claimed"]);
});

it("잡이 crawl_documents 의 토픽·본문을 옮겨 적고, 같은 값이면 다시 쓰지 않는다", async () => {
  await seed("published");
  await db.insert(crawlDocuments).values({
    repo: "owner/published", productUrl: "https://published.test", pageStatus: 200,
    repoMeta: { topics: ["pdf", "cli"] }, pageMeta: { textSample: "Merge PDF files in your browser." },
  });
  await db.insert(crawlCandidates).values({ repo: "owner/published", state: "published", publishedSlug: "published" });

  expect(await refreshProductSearchDocuments(ctx)).toEqual({ done: true });
  const [row] = await db.select().from(products).where(eq(products.slug, "published"));
  expect(row.searchTopics).toBe("pdf cli");
  expect(row.searchPageText).toBe("Merge PDF files in your browser.");
  expect(await search("merge pdf")).toEqual(["published"]);

  // 두 번째 틱은 고칠 것이 없다 — 커서 없이 낡은 행만 고르므로 스스로 마른다
  const before = await db.select({ updated: sql<string>`${products.updatedAt}::text` }).from(products).where(eq(products.slug, "published"));
  await refreshProductSearchDocuments(ctx);
  const after = await db.select({ updated: sql<string>`${products.updatedAt}::text` }).from(products).where(eq(products.slug, "published"));
  expect(after).toEqual(before);
});

it("옮겨 둔 번역이 있으면 게이트웨이를 부르지 않는다", async () => {
  await seed("pdfree", { name: "PDFree", tagline: "merge pdf files", description: "merge pdf files" });
  const hash = queryTranslationKey("PDF 합치는 도구");
  await db.insert(textTranslations).values({ sourceHash: hash, targetLang: "en", status: "done", translated: "merge pdf" });

  const resolved = await resolveSearchQuery("PDF 합치는 도구");
  expect(resolved.translated).toBe("merge pdf");
  expect(await search("PDF 합치는 도구")).toEqual([]);
  expect((await listProducts({ statuses: ["seeded"], sort: "relevance", limit: 10, query: resolved.queries })).map((r) => r.slug))
    .toEqual(["pdfree"]);
});

it("한국어로 친 말이 원문으로 많이 맞아도 번역을 붙인다 — 한국어 키워드만 맞은 결과가 영어 정답을 가리지 않게", async () => {
  // 한국어 키워드로만 맞는 제품 20개와, 소개가 영어라 번역으로만 맞는 정답
  for (let i = 0; i < 20; i++) await seed(`kw-${i}`, { name: `Tracker ${i}`, tagline: "Something", description: "Something", searchKeywords: "비용 추적" });
  await seed("agentacct", { name: "AgentAcct", tagline: "Track what your coding agents cost", description: "Track what your coding agents cost" });
  await db.insert(textTranslations).values({ sourceHash: queryTranslationKey("비용 추적"), targetLang: "en", status: "done", translated: "cost tracking | agent cost tracking" });

  const resolved = await resolveSearchQuery("비용 추적");
  expect(resolved.translated).toBe("cost tracking / agent cost tracking");
  const found = (await listProducts({ statuses: ["seeded"], sort: "relevance", limit: 30, query: resolved.queries })).map((r) => r.slug);
  expect(found).toContain("agentacct");
});

it("번역이 안 되면 친 그대로 찾는다 — 오류 화면이 되지 않는다", async () => {
  // 키가 없으면 게이트웨이를 부르지 못한다. 그래도 검색은 돌아야 한다
  delete process.env.ABCLLM_API_KEY;
  await seed("korean-page", { name: "한글 도구", tagline: "PDF 합치는 도구", description: "PDF 합치는 도구" });

  const resolved = await resolveSearchQuery("PDF 합치는 도구");
  expect(resolved.translated).toBe(null);
  // 친 그대로 한 줄만 찾는다(번역한 말이 붙지 않는다)
  expect(searchQueries(resolved.queries)).toEqual(["PDF 합치는 도구"]);
  // 실패도 남겨 둔다 — 같은 말로 매번 다시 부르지 않게
  const [row] = await db.select().from(textTranslations)
    .where(and(eq(textTranslations.sourceHash, queryTranslationKey("PDF 합치는 도구")), eq(textTranslations.targetLang, "en")));
  expect(row.status).toBe("failed");
  expect(row.errorCode).toBe("no_key");
});

it("관련도순은 번역을 기다리지 않는다 — 옮겨 둔 것은 쓰고, 없으면 친 그대로 찾고 응답 뒤에 옮겨 둔다", async () => {
  delete process.env.ABCLLM_API_KEY;
  const translationRow = (query: string) => db.select().from(textTranslations)
    .where(and(eq(textTranslations.sourceHash, queryTranslationKey(query)), eq(textTranslations.targetLang, "en")));
  await db.insert(textTranslations).values({ sourceHash: queryTranslationKey("PDF 합치는 도구"), targetLang: "en", status: "done", translated: "merge pdf" });

  const cached = await resolveSearchQuery("PDF 합치는 도구", { waitForTranslation: false });
  expect(cached.translated).toBe("merge pdf");
  expect(cached.translationPending).toBeUndefined();

  const fresh = await resolveSearchQuery("회의록 정리", { waitForTranslation: false });
  expect(fresh).toMatchObject({ translated: null, translationPending: true });
  expect(searchQueries(fresh.queries)).toEqual(["회의록 정리"]);
  // 게이트웨이를 부르지 않았다 — 기록도 없다
  expect(await translationRow("회의록 정리")).toEqual([]);

  // 응답 뒤(after)에 옮긴다 — 여기서는 키가 없어 실패로 남는 것으로 불렀음을 본다
  await warmQueryTranslation("회의록 정리");
  const [row] = await translationRow("회의록 정리");
  expect(row.errorCode).toBe("no_key");
});
