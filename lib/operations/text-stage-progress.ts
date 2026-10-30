import { sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlTaglines, productIntroChecks, productKoreanTaglines,
  products, productTranslations, textTranslations } from '@/lib/db/schema';
import { TRANSLATION_SOURCE_ROWS_SQL } from '@/lib/crawl/translations';
import { pendingTaglinePredicate } from '@/lib/crawl/taglines';
import { introCheckEligibilityPredicate, pendingIntroCheckPredicate } from '@/lib/domain/products/intro-checks';
import { homeListSlugs, koreanQueuePredicates } from '@/lib/domain/products/korean-taglines';
import { productTranslationEligible } from '@/lib/domain/products/translations';
import { productTranslationPolicy } from '@/lib/domain/products/translation-policy';
import { profileGenerationRetryAllowedSql } from '@/lib/domain/products/search-profile-retry';
import { TEXT_PROGRESS_STAGE_JOBS, type ProgressStageInput, type TextProgressStageKey } from './worker-progress';

/** Same word ratio as NEEDS_KOREAN, without a correlated set-returning aggregate for every product. */
export function progressNeedsKoreanSql(): SQL {
  const line = sql`btrim(${products.tagline})`;
  return sql`(${line} <> '' AND CASE WHEN ${products.tagline} !~ '[가-힣]' THEN true
    ELSE regexp_count(${line}, ${'[^\\s]*[가-힣][^\\s]*'}) * 2 < regexp_count(${line}, ${'\\s+'}) + 1 END)`;
}

/** Canonical 30% character ratio, with native counts instead of allocating two replacement strings per reason. */
export function progressReasonNeedsKoreanSql(): SQL {
  return sql`(length(btrim(body)) > 0 AND CASE WHEN octet_length(body)=length(body) THEN true
    WHEN body !~ '[가-힣]' THEN true
    ELSE regexp_count(body, '[가-힣]')::bigint * 10 < regexp_count(body, '[A-Za-z가-힣]')::bigint * 3 END)`;
}

/** Seven independent queues. Failed attempts never count as successful output from another text lane. */
export function textStageProgressSql(homeSlugs: readonly string[], group: 'all' | 'reason' | 'other' = 'all'): SQL {
  const q = koreanQueuePredicates(homeSlugs), k = productKoreanTaglines, t = productTranslations, i = productIntroChecks;
  // 공개 번역의 최대 시도는 지금 판의 translation.product.maxAttempts (관리자 실시간 한도)
  const translationMaxAttempts = productTranslationPolicy().maxAttempts;
  const sameDocument = sql`${crawlTaglines.documentAt} IS NOT DISTINCT FROM ${crawlDocuments.fetchedAt}`;
  const filter = group === 'reason' ? sql`WHERE key='reason-translate'` : group === 'other' ? sql`WHERE key<>'reason-translate'` : sql``;
  return sql`WITH reason_sources AS MATERIALIZED (
    -- Repeated model reasons share one translation. Group text before hashing/filtering, rather than per history row.
    SELECT body, max(at) AS at FROM (${TRANSLATION_SOURCE_ROWS_SQL}) source_rows GROUP BY body
  ), reason_eligible AS MATERIALIZED (
    SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex') AS hash, at FROM reason_sources WHERE ${progressReasonNeedsKoreanSql()}
  ), reason_translations AS MATERIALIZED (
    -- Distinct source cardinality is underestimated. Avoid one random PK probe for every eligible reason.
    SELECT source_hash, status, updated_at, retry_at FROM ${textTranslations} WHERE target_lang='ko'
  ), korean_pending AS MATERIALIZED (
    -- Current successful translations cannot be selected again. Exclude them before the per-line word scan.
    SELECT ${products.id}, ${products.slug}, ${products.tagline}, ${products.createdAt}, ${products.verifiedAt}
      FROM ${products} LEFT JOIN ${k} ON ${k.productId}=${products.id}
      WHERE ${products.status} IN ('seeded','verified') AND (${q.fresh} OR ${k.errorCode} IS NOT NULL)
  ), korean_successes AS MATERIALIZED (
    SELECT ${k.productId}, ${k.sourceTagline}, ${k.updatedAt} FROM ${k}
      WHERE ${k.errorCode} IS NULL AND ${k.updatedAt}>now()-interval '5 minutes' AND ${k.updatedAt}<=now()
  ), targets AS (
    SELECT 'reason-translate' AS key,
      (t.source_hash IS NULL OR (t.status='failed' AND (t.retry_at IS NULL OR t.retry_at<=now()))) AS ready,
      (t.status='failed' AND t.retry_at>now()) AS deferred, false AS blocked,
      greatest(u.at,t.updated_at,t.retry_at) AS since,
      CASE WHEN t.status='done' THEN t.updated_at END AS success_at,
      CASE WHEN t.status='failed' THEN t.updated_at END AS failure_at
      FROM reason_eligible u LEFT JOIN reason_translations t ON t.source_hash=u.hash
    UNION ALL
    SELECT 'crawl-tagline', ${pendingTaglinePredicate()},
      (${sameDocument} AND ${crawlTaglines.errorCode} IS NOT NULL AND ${crawlTaglines.attempts}<5 AND ${crawlTaglines.retryAt}>now()),
      (${crawlTaglines.errorCode} IS NOT NULL AND ${crawlTaglines.attempts}>=5
        AND ${crawlTaglines.documentAt} IS NOT DISTINCT FROM ${crawlDocuments.fetchedAt}),
      CASE WHEN ${sameDocument} THEN greatest(${crawlCandidates.updatedAt},${crawlTaglines.updatedAt},${crawlTaglines.retryAt})
        ELSE greatest(${crawlCandidates.updatedAt},${crawlDocuments.fetchedAt}) END,
      NULL::timestamp,
      CASE WHEN ${sameDocument} AND ${crawlTaglines.errorCode} IS NOT NULL THEN ${crawlTaglines.updatedAt} END
      FROM ${crawlCandidates} JOIN ${crawlDocuments} ON ${crawlDocuments.repo}=${crawlCandidates.repo}
      LEFT JOIN ${crawlTaglines} ON ${crawlTaglines.repo}=${crawlCandidates.repo}
      WHERE ${crawlCandidates.state}='needs_review' AND ${crawlCandidates.reason}='no_description'
        AND ${crawlCandidates.decidedBy} IN ('auto','admin','deepseek') AND ${crawlTaglines.writtenBy} IS NULL
    UNION ALL
    SELECT 'product-translate', (${t.status} IN ('pending','failed') AND ${t.attempts}<${translationMaxAttempts}
        AND (${t.retryAt} IS NULL OR ${t.retryAt}<=now())),
      (${t.status}='failed' AND ${t.attempts}<${translationMaxAttempts} AND ${t.retryAt}>now()),
      (${t.status}='failed' AND ${t.attempts}>=${translationMaxAttempts}),
      greatest(${t.updatedAt},${t.retryAt}),
      CASE WHEN ${t.status} IN ('ready','reviewed') THEN ${t.updatedAt} END,
      CASE WHEN ${t.status}='failed' THEN ${t.updatedAt} END
      FROM ${t} JOIN ${products} ON ${products.id}=${t.productId} WHERE ${productTranslationEligible}
    UNION ALL
    SELECT 'tagline-ko', (${q.ready} OR ${q.recoveryReady}),
      ((${q.retry} OR ${q.recovery}) AND NOT ${q.due}),
      (${q.current} AND ${k.errorCode} IS NOT NULL AND NOT ${q.allowance} AND NOT ${q.recovery}),
      CASE WHEN ${q.fresh} THEN coalesce(${products.verifiedAt},${products.createdAt})
        ELSE greatest(${k.updatedAt},${k.retryAt}) END,
      NULL::timestamp,
      CASE WHEN ${q.current} AND ${k.errorCode} IS NOT NULL THEN ${k.updatedAt} END
      FROM korean_pending products LEFT JOIN ${k} ON ${k.productId}=${products.id}
      WHERE ${progressNeedsKoreanSql()}
    UNION ALL
    SELECT 'intro-check', ${pendingIntroCheckPredicate()},
      (${i.checkedTagline}=${products.tagline} AND ${i.errorCode} IS NOT NULL AND ${i.attempts}<5 AND ${i.retryAt}>now()),
      (${i.checkedTagline}=${products.tagline} AND (${i.outcome}='needs_editor' OR (${i.errorCode} IS NOT NULL AND ${i.attempts}>=5))),
      CASE WHEN ${i.productId} IS NULL OR ${i.checkedTagline}<>${products.tagline} THEN ${products.updatedAt}
        ELSE greatest(${i.updatedAt},${i.retryAt}) END,
      NULL::timestamp,
      CASE WHEN ${i.checkedTagline}=${products.tagline} AND ${i.errorCode} IS NOT NULL THEN ${i.updatedAt} END
      FROM ${products} LEFT JOIN ${i} ON ${i.productId}=${products.id} WHERE ${introCheckEligibilityPredicate()}
    UNION ALL
    SELECT 'keywords', (sp.product_id IS NULL OR (sp.error_code IS NOT NULL
        AND ${profileGenerationRetryAllowedSql(sql`sp.error_code`, sql`sp.attempts`)} AND (sp.retry_at IS NULL OR sp.retry_at<=now()))
        OR (sp.error_code IS NULL AND (sp.needs_refresh OR sp.updated_at<now()-interval '30 days'))),
      (sp.error_code IS NOT NULL AND ${profileGenerationRetryAllowedSql(sql`sp.error_code`, sql`sp.attempts`)} AND sp.retry_at>now()),
      (sp.error_code IS NOT NULL AND NOT ${profileGenerationRetryAllowedSql(sql`sp.error_code`, sql`sp.attempts`)}),
      CASE WHEN sp.product_id IS NULL THEN p.created_at WHEN sp.error_code IS NOT NULL THEN greatest(sp.updated_at,sp.retry_at)
        WHEN sp.needs_refresh THEN sp.updated_at ELSE sp.updated_at+interval '30 days' END,
      sp.generated_at, CASE WHEN sp.error_code IS NOT NULL THEN sp.updated_at END
      FROM products p LEFT JOIN product_search_profiles sp ON sp.product_id=p.id WHERE p.status IN ('seeded','verified')
    UNION ALL
    SELECT 'keyword-verify', (sp.verified_at IS NULL AND sp.verify_attempts<5 AND (sp.verify_retry_at IS NULL OR sp.verify_retry_at<=now())),
      (sp.verified_at IS NULL AND sp.verify_attempts<5 AND sp.verify_retry_at>now()), (sp.verified_at IS NULL AND sp.verify_attempts>=5),
      greatest(sp.updated_at,sp.verify_retry_at), sp.verified_at, CASE WHEN sp.verify_error IS NOT NULL THEN sp.updated_at END
      FROM products p JOIN product_search_profiles sp ON sp.product_id=p.id
      WHERE p.status IN ('seeded','verified') AND NOT sp.needs_refresh AND sp.error_code IS NULL
        AND jsonb_array_length(sp.keywords_en)+jsonb_array_length(sp.keywords_ko)>0
    UNION ALL
    -- Successful writers can remove their item from the eligible queue in the same transaction.
    SELECT 'crawl-tagline', false, false, false, NULL::timestamp, ${crawlTaglines.updatedAt}, NULL::timestamp
      FROM ${crawlTaglines} JOIN ${crawlDocuments} ON ${crawlDocuments.repo}=${crawlTaglines.repo}
      WHERE ${crawlTaglines.errorCode} IS NULL AND ${crawlTaglines.writtenBy} IS NULL
        -- The fenced writer receives PostgreSQL timestamps as JS Dates (millisecond precision).
        AND date_trunc('milliseconds', ${crawlTaglines.documentAt}) IS NOT DISTINCT FROM date_trunc('milliseconds', ${crawlDocuments.fetchedAt})
        AND ${crawlTaglines.updatedAt}>now()-interval '5 minutes' AND ${crawlTaglines.updatedAt}<=now()
    UNION ALL
    SELECT 'intro-check', false, false, false, NULL::timestamp, ${i.updatedAt}, NULL::timestamp
      FROM ${i} JOIN ${products} ON ${products.id}=${i.productId}
      WHERE ${i.errorCode} IS NULL AND ${i.outcome} IN ('kept','replaced','needs_editor')
        AND ${products.status} IN ('seeded','verified') AND (${i.checkedTagline}=${products.tagline}
          OR (${i.outcome}='replaced' AND ${i.corrected}=${products.tagline} AND ${products.taglineSource}='ai_fixed'))
        AND ${i.updatedAt}>now()-interval '5 minutes' AND ${i.updatedAt}<=now()
    UNION ALL
    SELECT 'tagline-ko', false, false, false, NULL::timestamp, product_korean_taglines.updated_at, NULL::timestamp
      FROM korean_successes product_korean_taglines JOIN ${products} ON ${products.id}=${k.productId}
      WHERE ${products.status} IN ('seeded','verified') AND ${q.current} AND ${progressNeedsKoreanSql()}
  ) SELECT key, count(*) FILTER (WHERE ready)::int AS waiting,
    extract(epoch FROM (now()-min(since) FILTER (WHERE ready)))/60 AS oldest,
    count(*) FILTER (WHERE success_at>now()-interval '5 minutes')::int AS completed,
    count(*) FILTER (WHERE failure_at>now()-interval '5 minutes' AND (ready OR deferred))::int AS errors,
    count(*) FILTER (WHERE deferred)::int AS deferred, count(*) FILTER (WHERE blocked)::int AS blocked,
    count(*) FILTER (WHERE failure_at IS NOT NULL AND (ready OR deferred))::int AS provider_errors,
    extract(epoch FROM (now()-min(failure_at) FILTER (WHERE ready OR deferred)))/60 AS error_age
    FROM targets ${filter} GROUP BY key`;
}

/** Two exact read-only statements, each bounded by the same three-second SQL limit as evidence monitoring. */
export async function readTextStageProgress(): Promise<ProgressStageInput[]> {
  const home = await homeListSlugs();
  const read = (group: 'reason' | 'other') => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL jit = off`);
    await tx.execute(sql`SET LOCAL work_mem = '32MB'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<{ key: TextProgressStageKey; waiting: number; oldest: string | null; completed: number; errors: number;
      deferred: number; blocked: number; provider_errors: number; error_age: string | null }>(textStageProgressSql(home, group));
  }, { accessMode: 'read only' });
  // Keep each exact history/queue read within its budget; either failure remains unknown to the caller.
  const rows = [...await read('reason'), ...await read('other')];
  const values = new Map(rows.map(row => [row.key, row]));
  return (Object.keys(TEXT_PROGRESS_STAGE_JOBS) as TextProgressStageKey[]).map(key => {
    const row = values.get(key);
    const age = (value: string | null | undefined) => value == null ? null : Math.max(0, Number(value));
    return { key, enabled: true, waiting: row?.waiting ?? 0, oldestMinutes: age(row?.oldest),
      completed5m: row?.completed ?? 0, progress5m: row?.completed ?? 0, errors5m: row?.errors ?? 0,
      deferred: row?.deferred ?? 0, manualAttention: row?.blocked ?? 0,
      providerErrors: row?.provider_errors ?? 0, providerErrorMinutes: age(row?.error_age) };
  });
}
