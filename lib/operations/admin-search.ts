import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiConnections, aiTaskModels, aiTaskPoolMembers, crawlCandidates, operationsAudit, products } from "@/lib/db/schema";
import { activityHref, candidateHref, contextSearch, searchTerm, type AdminSearchResult } from "./admin-search-shared";
import { searchAdminDestinations } from "./admin-search-navigation";
import { llmEditHref } from "./llm-ops-links";

export * from "./admin-search-shared";

/**
 * 관리자 전역 검색(⌘K) — 연결·모델·작업·설정과 프로젝트·심사 후보·작업 로그 대상을 찾는다.
 * 연결·모델은 저장된 목록과 배정을 읽고, 검색 결과에서 해당 연결 편집으로 간다.
 *
 * 2026-10-11 운영 실측: 제품 4만·후보 25만 행 ILIKE 가 각 0.1초 안팎이라 trigram 색인 없이 둔다(pg_trgm 미설치).
 * 범주별로 함께 읽고, 글자 그대로 찾는다(% _ \ 는 이스케이프).
 */
const LIMIT = { products: 8, candidates: 8, targets: 6, engines: 8, models: 8 } as const;

const likeOf = (term: string) => `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

// Stored catalogs and assignments only: no credentials are selected and no engine is contacted.
// UNION keeps the same model on different connections separate while removing duplicate catalog/rank entries.
const modelNames = sql`
  select entry->>'id' as model from jsonb_array_elements(
    case when jsonb_typeof(${aiConnections.models}) = 'array' then ${aiConnections.models} else '[]'::jsonb end
  ) as entry where jsonb_typeof(entry->'id') = 'string'
  union select unnest(${aiConnections.cliModels})
  union select entry #>> '{}' from jsonb_array_elements(
    case when jsonb_typeof(${aiConnections.options}->'manualModels') = 'array'
      then ${aiConnections.options}->'manualModels' else '[]'::jsonb end
  ) as entry where jsonb_typeof(entry) = 'string'
  union select ${aiTaskModels.model} from ${aiTaskModels} where ${aiTaskModels.connectionId} = ${aiConnections.id}
  union select ${aiTaskPoolMembers.model} from ${aiTaskPoolMembers} where ${aiTaskPoolMembers.connectionId} = ${aiConnections.id}`;
const visibleModel = sql`catalog.model <> '' and not coalesce(
  jsonb_typeof(${aiConnections.options}->'hiddenModels') = 'array'
    and (${aiConnections.options}->'hiddenModels') ? catalog.model, false)`;
type ModelRow = { connectionId: string; connectionLabel: string; deviceId: string; kind: "api" | "cli"; model: string; enabled: boolean };

export async function adminGlobalSearch(raw: string): Promise<AdminSearchResult> {
  const term = searchTerm(raw);
  if (!term) return { q: (raw ?? "").trim(), products: [], candidates: [], targets: [], engines: [], models: [], destinations: [] };
  const like = likeOf(term);
  const lower = term.toLowerCase();
  const context = contextSearch(term);
  const engineKind = /^(엔진|engine|api)$/.test(lower) ? "api" : lower === "cli" ? "cli" : null;
  const allConnections = /^(연결|서버|connections?|servers?)$/.test(lower);
  const allModels = /^(모델|models?)$/.test(lower);
  const [productRows, candidateRows, targetRows, engineRows, modelRows] = await Promise.all([
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
    db.select({ id: aiConnections.id, label: aiConnections.label, kind: aiConnections.kind, baseUrl: aiConnections.baseUrl,
      deviceId: aiConnections.deviceId, enabled: aiConnections.enabled,
      contextTokens: sql<string | null>`${aiConnections.options}->>'contextTokens'` })
      .from(aiConnections)
      .where(or(sql`${allConnections}`, engineKind ? eq(aiConnections.kind, engineKind) : undefined,
        context ? eq(aiConnections.kind, "api") : undefined,
        ilike(aiConnections.label, like), ilike(aiConnections.deviceId, like), ilike(aiConnections.baseUrl, like), ilike(aiConnections.cliTool, like),
        sql`exists (select 1 from (${modelNames}) as catalog where ${visibleModel} and catalog.model ilike ${like})`))
      .orderBy(desc(sql`lower(${aiConnections.label}) = ${lower}`), aiConnections.label, aiConnections.id)
      .limit(LIMIT.engines),
    db.execute<ModelRow>(sql`select ${aiConnections.id} as "connectionId", ${aiConnections.label} as "connectionLabel",
        ${aiConnections.deviceId} as "deviceId", ${aiConnections.kind} as kind, ${aiConnections.enabled} as enabled, catalog.model
      from ${aiConnections} cross join lateral (${modelNames}) as catalog
      where ${visibleModel} and (${allModels} or catalog.model ilike ${like}
        or ${aiConnections.label} ilike ${like} or ${aiConnections.deviceId} ilike ${like})
      order by (lower(catalog.model) = ${lower}) desc, ${aiConnections.enabled} desc, ${aiConnections.label}, catalog.model
      limit ${LIMIT.models}`),
  ]);
  return {
    q: term,
    products: productRows.map((row) => ({ ...row, href: `/admin/products/${row.slug}`, publicHref: `/p/${row.slug}`, logHref: activityHref(row.slug) })),
    candidates: candidateRows.map((row) => ({ ...row, href: candidateHref(row), logHref: activityHref(row.repo) })),
    targets: targetRows.map((row) => ({ ...row, lastAt: new Date(row.lastAt), href: activityHref(row.target) })),
    engines: engineRows.map(row => {
      const tokens = Number(row.contextTokens);
      return { ...row, contextTokens: Number.isSafeInteger(tokens) && tokens >= 1 && tokens <= 2097152 ? tokens : null,
        href: llmEditHref(row.id, context && row.kind === "api" ? "context" : null),
        contextHref: row.kind === "api" ? llmEditHref(row.id, "context") : null };
    }),
    models: Array.from(modelRows, row => ({ ...row, href: llmEditHref(row.connectionId) })),
    destinations: searchAdminDestinations(term),
  };
}
