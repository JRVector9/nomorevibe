import { and, desc, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, operationsAudit, products } from "@/lib/db/schema";

/**
 * 관리자 전역 검색(⌘K, 2026-10-08 UX 점검 ADM-05) — 제품·심사 후보·작업 로그 대상을 한 번에 찾는다.
 * 신고·메일로 "X 를 내려 달라"는 말을 들었을 때 이름·주소·저장소 하나로 바로 그 화면에 간다.
 *
 * 2026-10-11 운영 실측: 제품 4만·후보 25만 행 ILIKE 가 각 0.1초 안팎이라 trigram 색인 없이 둔다(pg_trgm 미설치).
 * 셋을 함께 읽고, 글자 그대로 찾는다(% _ \ 는 이스케이프).
 */
export const ADMIN_SEARCH_MIN = 2;
const LIMIT = { products: 8, candidates: 8, targets: 6 } as const;

export type AdminSearchProduct = { slug: string; name: string; url: string; repoUrl: string | null; status: string; href: string; publicHref: string; logHref: string };
export type AdminSearchCandidate = { id: number; repo: string; state: string; productUrl: string | null; href: string; logHref: string };
export type AdminSearchTarget = { target: string; count: number; lastAt: Date; href: string };
export type AdminSearchResult = { q: string; products: AdminSearchProduct[]; candidates: AdminSearchCandidate[]; targets: AdminSearchTarget[] };

/** 찾는 글자 — 앞뒤 공백을 떼고 100자까지. 너무 짧으면 null(모든 행이 걸린다) */
export function searchTerm(raw: string | null | undefined): string | null {
  const term = (raw ?? "").trim().slice(0, 100);
  return [...term].length >= ADMIN_SEARCH_MIN ? term : null;
}

const likeOf = (term: string) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/** 작업 로그를 그 대상으로 거른 화면 */
export const activityHref = (target: string) => `/admin/activity?target=${encodeURIComponent(target)}`;

/**
 * 후보가 있는 심사 큐 화면 — 그 저장소로 거르고 그 줄을 고른다. 심사 큐의 기본 보기는 아직 결론이 안 난 것(new·approved·보류)이라
 * 거부·발행된 후보는 그 보기로 보낸다.
 */
export function candidateHref(candidate: { id: number; repo: string; state: string }): string {
  const params = new URLSearchParams();
  if (candidate.state === "rejected" || candidate.state === "published") params.set("state", candidate.state);
  params.set("q", candidate.repo);
  params.set("focus", String(candidate.id));
  return `/admin/review?${params}#review-list`;
}

export async function adminGlobalSearch(raw: string): Promise<AdminSearchResult> {
  const term = searchTerm(raw);
  if (!term) return { q: (raw ?? "").trim(), products: [], candidates: [], targets: [] };
  const like = likeOf(term);
  const lower = term.toLowerCase();
  const [productRows, candidateRows, targetRows] = await Promise.all([
    db.select({ slug: products.slug, name: products.name, url: products.url, repoUrl: products.repoUrl, status: products.status })
      .from(products)
      .where(or(ilike(products.name, like), ilike(products.slug, like), ilike(products.url, like), ilike(sql`coalesce(${products.repoUrl}, '')`, like)))
      // 이름·slug 가 꼭 맞는 것 먼저, 그다음 스타 순
      .orderBy(desc(sql`(lower(${products.name}) = ${lower} or ${products.slug} = ${lower})`), sql`${products.stars} desc nulls last`, products.slug)
      .limit(LIMIT.products),
    db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, state: crawlCandidates.state, productUrl: crawlCandidates.productUrl })
      .from(crawlCandidates)
      .where(or(ilike(crawlCandidates.repo, like), ilike(sql`coalesce(${crawlCandidates.productUrl}, '')`, like)))
      .orderBy(desc(sql`(lower(${crawlCandidates.repo}) = ${lower} or lower(split_part(${crawlCandidates.repo}, '/', 2)) = ${lower})`), desc(crawlCandidates.updatedAt))
      .limit(LIMIT.candidates),
    db.select({ target: operationsAudit.target, count: sql<number>`count(*)::int`, lastAt: sql<Date>`max(${operationsAudit.createdAt})` })
      .from(operationsAudit)
      .where(and(ilike(operationsAudit.target, like)))
      .groupBy(operationsAudit.target)
      .orderBy(desc(sql`max(${operationsAudit.createdAt})`))
      .limit(LIMIT.targets),
  ]);
  return {
    q: term,
    products: productRows.map((row) => ({ ...row, href: `/admin/products/${row.slug}`, publicHref: `/p/${row.slug}`, logHref: activityHref(row.slug) })),
    candidates: candidateRows.map((row) => ({ ...row, href: candidateHref(row), logHref: activityHref(row.repo) })),
    targets: targetRows.map((row) => ({ ...row, lastAt: new Date(row.lastAt), href: activityHref(row.target) })),
  };
}
