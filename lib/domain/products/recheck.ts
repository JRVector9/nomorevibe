import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, products } from "@/lib/db/schema";
import { judge, factsFromRepoMeta, pageFactsFromDocument, type RuleStep } from "@/lib/crawl/rules";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";

/**
 * 이미 발행된 제품에 현재 규칙을 다시 태운다.
 *
 * 발행되면 규칙이 다시 닿지 않는다. 그래서 기준을 고쳐도 이미 올라간 것은 그대로 남는다 —
 * 문서 제목 규칙을 넣은 뒤에도 "Scut Docs"가 목록에 있는 이유다.
 *
 * 여기서는 아무것도 바꾸지 않는다. 지금 기준으로 걸리는 것을 사유와 함께 보여줄 뿐이고,
 * 내릴지는 사람이 제품 화면에서 정한다 — 자동으로 내리면 잠깐의 응답 실패나 기준 실험이
 * 공개 목록을 흔든다.
 */
export type RecheckHit = {
  slug: string;
  name: string;
  url: string;
  repo: string;
  reason: string;
  /** 멈춘 규칙과 잰 값 */
  stopped: RuleStep | null;
};

export type RecheckResult = {
  hits: RecheckHit[];
  /** 원본이 남아 있어 실제로 다시 판정한 수 */
  checked: number;
  /** 이번 범위에서 원본을 찾지 못해 건너뛴 수 */
  skipped: number;
  offset: number;
  limit: number;
};

export async function recheckPublishedProducts(
  settings: CrawlSettings,
  { limit = 500, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<RecheckResult> {
  const rows = await db
    .select({
      slug: products.slug, name: products.name, url: products.url,
      repo: crawlCandidates.repo, document: crawlDocuments,
    })
    .from(products)
    .innerJoin(crawlCandidates, eq(crawlCandidates.publishedSlug, products.slug))
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(inArray(products.status, ["verified", "seeded"])))
    .orderBy(asc(products.slug))
    .limit(limit)
    .offset(offset);

  const hits: RecheckHit[] = [];
  for (const row of rows) {
    const verdict = judge(
      factsFromRepoMeta(row.repo, row.document.repoMeta),
      pageFactsFromDocument(row.document),
      settings,
    );
    // 보류는 "규칙이 못 가른 것"이라 이미 올라간 제품을 내릴 근거가 못 된다. 거부만 짚는다.
    if (verdict.state !== "rejected") continue;
    hits.push({
      slug: row.slug, name: row.name, url: row.url, repo: row.repo,
      reason: verdict.reason, stopped: verdict.trace.at(-1) ?? null,
    });
  }
  return { hits, checked: rows.length, skipped: 0, offset, limit };
}

/** 발행된 제품 중 원본이 남아 있어 다시 판정할 수 있는 수 */
export async function recheckableCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .innerJoin(crawlCandidates, eq(crawlCandidates.publishedSlug, products.slug))
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(inArray(products.status, ["verified", "seeded"]));
  return row?.count ?? 0;
}
