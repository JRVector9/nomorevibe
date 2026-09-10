import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, products } from "@/lib/db/schema";
import { judge, factsFromRepoMeta, pageFactsFromDocument, PUSH_AGE_RULE, type RuleStep } from "@/lib/crawl/rules";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";

/**
 * 이미 발행된 제품에 현재 규칙을 다시 태운다.
 *
 * 발행되면 규칙이 다시 닿지 않는다. 그래서 기준을 고쳐도 이미 올라간 것은 그대로 남는다 —
 * 문서 제목 규칙을 넣은 뒤에도 "Scut Docs"가 목록에 있는 이유다.
 *
 * 여기서는 아무것도 바꾸지 않는다. 지금 기준으로 걸리는 것을 사유와 함께 보여줄 뿐이고,
 * 내릴지는 사람이 고른다 — 자동으로 내리면 잠깐의 응답 실패나 기준 실험이 공개 목록을 흔든다.
 *
 * "무엇인가"를 묻는 규칙만 짚는다. 시간이 가면 저절로 걸리는 규칙(푸시 나이)은 뺀다 —
 * 아래를 참고.
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
  /**
   * 본문이 아직 없어 "설치 유도 아님"을 못 태운 수.
   *
   * 이 규칙은 본문을 보는데, 그 값이 생기기 전에 수집된 것들이 있다. 생존 확인이
   * 6시간 주기로 채우는 중이라 시간이 지나면 0으로 간다. 0이 아닌 동안 "걸린 게 없다"는
   * 말은 절반만 참이라, 화면이 그 사실을 밝혀야 한다.
   */
  withoutText: number;
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
  let withoutText = 0;
  for (const row of rows) {
    const page = pageFactsFromDocument(row.document);
    if (!page.textSample) withoutText += 1;
    const verdict = judge(
      factsFromRepoMeta(row.repo, row.document.repoMeta),
      page,
      settings,
    );
    // 보류는 "규칙이 못 가른 것"이라 이미 올라간 제품을 내릴 근거가 못 된다. 거부만 짚는다.
    if (verdict.state !== "rejected") continue;
    /**
     * 푸시가 끊긴 것은 내릴 근거가 아니다.
     *
     * 이 규칙은 수집에서 죽은 레포를 안 들이려고 쓰는 것이지, 올라간 제품이 살아 있는지를
     * 재는 것이 아니다. 실측(2026-09-10): 이 규칙에 걸린 31건의 주소를 전부 열어봤더니
     * 31건 모두 HTTP 200이었다 — 다 만들어 놓고 손을 뗀 작은 도구는 커밋이 없는 게 정상이다.
     *
     * 게다가 이 규칙은 시간이 가면 저절로 걸린다. 걸러내지 않으면 재검수 목록이 날마다
     * 불어나 실제로 내려야 할 것을 덮는다. 살아 있는지는 생존 확인이 따로 재고 있다.
     */
    if (verdict.trace.at(-1)?.rule === PUSH_AGE_RULE) continue;
    hits.push({
      slug: row.slug, name: row.name, url: row.url, repo: row.repo,
      reason: verdict.reason, stopped: verdict.trace.at(-1) ?? null,
    });
  }
  return { hits, checked: rows.length, withoutText, offset, limit };
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
