/**
 * 검색 평가 — 정해 둔 검색어를 한 번에 돌려 건수와 상위 5개를 찍는다.
 *
 * 검색을 고칠 때마다 같은 말로 다시 재려면 기준이 있어야 한다. 2026-09-18 프로드에서 잰
 * 출발점(낱말 AND + ILIKE, 색인 없음)은 이랬다 — 목적으로 찾으면 아무것도 나오지 않았다:
 *   PDF 합치는 도구 0 · 코드 리뷰 자동화 0 · 회의록 요약 0 · 사진 배경 제거 0
 *   summarize meetings 0 · remove image background 0
 *
 *   tsx --env-file=.env.local scripts/search-eval.ts              (지금 검색)
 *   tsx --env-file=.env.local scripts/search-eval.ts --baseline   (옛 ILIKE 검색 — 비교용)
 *   tsx --env-file=.env.local scripts/search-eval.ts --translate  (한국어를 영어로 옮겨 한 번 더)
 */
import { parseArgs } from "node:util";
import { and, ilike, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, type ProductStatus } from "@/lib/db/schema";
import { listProducts, countProducts } from "@/lib/domain/products/repository";
import { resolveSearchQuery } from "@/lib/domain/products/search-translation";
import type { SearchQuery } from "@/lib/domain/products/search";

/** 목적으로 찾는 말. 한국어와 영어를 같이 둔다 — 같은 뜻이 양쪽에서 같게 나와야 한다 */
const QUERIES = [
  "PDF 합치는 도구",
  "코드 리뷰 자동화",
  "회의록 요약",
  "사진 배경 제거",
  "영어 공부",
  "가계부",
  "merge pdf files",
  "automate code review",
  "summarize meetings",
  "track expenses",
  "remove image background",
  "monitor AI agents",
];

const PUBLIC: ProductStatus[] = ["seeded", "verified"];

/**
 * 고치기 전의 검색 — 낱말을 공백으로 쪼개 전부 AND, 필드마다 ILIKE '%낱말%'.
 * 비교용으로만 남긴다. 같은 DB 에서 같은 말로 재야 숫자가 뜻을 갖는다.
 */
function ilikePredicate(query: string) {
  const terms = query.trim().slice(0, 200).split(/\s+/).filter(Boolean).map((term) => term.replace(/^@(?=[\w-])/, ""));
  const pattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const reported = or(ne(products.source, "crawler"), isNotNull(products.claimedAt))!;
  return and(...terms.map((term) => or(
    ...[products.name, products.tagline, products.description, products.slug, products.repoUrl]
      .map((field) => ilike(field, pattern(term))),
    and(reported, ilike(products.builder, pattern(term))),
  )!));
}

async function baseline(query: string): Promise<{ hits: number; top: string[] }> {
  const where = and(sql`${products.status} in ('seeded', 'verified')`, ilikePredicate(query));
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(products).where(where);
  const rows = await db.select({ name: products.name }).from(products).where(where).limit(5);
  return { hits: Number(row?.count ?? 0), top: rows.map((r) => r.name) };
}

async function current(query: SearchQuery): Promise<{ hits: number; top: string[] }> {
  const options = { statuses: PUBLIC, query, excludeDown: true };
  const [hits, rows] = await Promise.all([
    countProducts(options),
    listProducts({ ...options, sort: "relevance", limit: 5 }),
  ]);
  return { hits, top: rows.map((row) => row.name) };
}

async function main() {
  const { values } = parseArgs({ options: {
    baseline: { type: "boolean", default: false },
    translate: { type: "boolean", default: false },
  } });

  const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(products)
    .where(sql`${products.status} in ('seeded', 'verified')`);
  const mode = values.baseline ? "옛 ILIKE 검색" : values.translate ? "지금 검색 + 한국어 번역" : "지금 검색";
  console.log(`공개 제품 ${Number(total?.count ?? 0)}건 · ${mode}\n`);

  let found = 0;
  for (const query of QUERIES) {
    const startedAt = Date.now();
    let note = "";
    let result: { hits: number; top: string[] };
    if (values.baseline) {
      result = await baseline(query);
    } else {
      const resolved = values.translate ? await resolveSearchQuery(query) : { queries: [query], translated: null };
      if (resolved.translated) note = ` (영어로 “${resolved.translated}”)`;
      result = await current(resolved.queries);
    }
    if (result.hits > 0) found += 1;
    console.log(`${query}${note}`);
    console.log(`  ${result.hits}건 · ${Date.now() - startedAt}ms`);
    for (const [index, name] of result.top.entries()) console.log(`  ${index + 1}. ${name}`);
    if (!result.top.length) console.log("  (없음)");
    console.log("");
  }
  console.log(`결과가 있는 검색어 ${found}/${QUERIES.length}`);
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
