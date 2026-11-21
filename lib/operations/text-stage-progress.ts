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
import { logger } from '@/lib/observability/logger';
import { progressReadFailure, TEXT_PROGRESS_STAGE_JOBS, type ProgressReadFailure, type ProgressStageInput, type TextProgressStageKey } from './worker-progress';

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
  return sql`WITH reason_eligible AS MATERIALIZED (
    -- Repeated model reasons share one translation: one row per text hash. Group by the hash, not the body text — 89% of
    -- reasons are distinct (2026-11-15: 359k of 404k), so a body-keyed aggregate spilled 80MB+ to temp files on every read.
    SELECT encode(sha256(convert_to(body, 'UTF8')), 'hex') AS hash, max(at) AS at
      FROM (${TRANSLATION_SOURCE_ROWS_SQL}) source_rows WHERE ${progressReasonNeedsKoreanSql()} GROUP BY 1
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
      FROM ${t} JOIN ${products} ON ${products.id}=${t.productId} WHERE ${productTranslationEligible} AND ${t.locale} IN ('en','zh-Hans','ja')
    UNION ALL
    SELECT 'tagline-ko', ${q.ready},
      (${q.retry} AND NOT ${q.due}),
      (${q.current} AND ${k.errorCode} IS NOT NULL AND NOT ${q.allowance}),
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

/**
 * Two exact read-only statements. The other text stages keep the three-second SQL limit of evidence monitoring; the reason group hashes every
 * distinct model reason and crossed 3 s in production on 2026-11-02 (3.2 s measured), which made worker progress `unknown` and blocked every
 * deploy gate. It got 10 s then.
 *
 * 2026-11-21: 사유 그룹은 한 번에 6.5~6.8초이고 원천 행이 6일에 20% 씩 늘어(40.4만 → 48.5만) 약 3주 뒤 10초를 넘는다. 이제 프로세스마다 5분에 한 번만
 * 돌고(아래 재사용) 감시에서는 다른 읽기와 겹치지 않게 혼자 먼저 돌므로 20초로 올린다. 더 올리지 않는 까닭:
 * - 감시 하트비트는 90초 안에 다시 써야 한다(monitor-healthcheck·복구 게이트웨이). 한 주기 = 쉼 30초 + push 최대 5초 + 다른 읽기(3초 상한 TX 넷과
 *   짧은 문장들) + 이 문장.
 * - 배포 관문은 스크립트 하나에 35초, 둘에 80초를 준다(deploy_shared_images.py REMOTE_MONITOR). 시작 + 이 문장 + 그 밖 3초가 35초 안이어야 한다.
 * 근본 해결(사유 원천 표, 전수 점검 W3-2)이 들어올 때까지의 완화책이다.
 */
export const TEXT_PROGRESS_STATEMENT_TIMEOUT = { reason: '20s', other: '3s' } as const;
/**
 * 사유 그룹의 해시 집계는 약 90MB 를 쓴다(2026-11-21 복제본 EXPLAIN, 48.5만 행). 32MB 에서는 해시 한도가 64MB(hash_mem_multiplier 2)라 호출마다
 * 임시 파일로 흘렸다(5 batch · 디스크 11MB). 256MB(한도 512MB)는 원천이 지금의 5배가 될 때까지 메모리 안에서 끝난다 — 실제로 쓰는 양은 이 상한이
 * 아니라 자료 크기가 정하고, 5분 재사용 뒤로는 동시에 도는 수가 프로세스 수를 넘지 않는다. 그 밖 그룹은 가벼워 32MB 그대로다.
 */
export const TEXT_PROGRESS_WORK_MEM = { reason: '256MB', other: '32MB' } as const;
/**
 * 사유 그룹 재사용(2026-11-21, 근본 해결 W3-2 까지의 완화책). 이 단계의 경보 문턱은 10·30분인데 감시는 30~40초마다 48만 행을 다시 묶었다.
 * - REUSE: 잰 지 5분 안이면 다시 세지 않는다(프로세스마다 따로 담는다 — 한 번 도는 관문 스크립트는 늘 새로 센다).
 * - RETRY: 실패한 뒤 1분은 다시 시도하지 않는다(20초 문장을 주기마다 되풀이하지 않게). 그동안은 담아 둔 값을 나이와 함께 쓴다.
 * - MAX_AGE: 담아 둔 값이 15분보다 낡으면 쓰지 않고 그 단계만 「모름」이다 — 낡은 값으로 정상이라 말하지 않는다.
 * 판정은 잰 때의 값 그대로라 이 단계의 경보는 최대 5분(읽기 실패가 이어지면 15분) 늦을 수 있다.
 */
export const TEXT_REASON_REUSE_MS = 5 * 60_000;
export const TEXT_REASON_RETRY_MS = 60_000;
export const TEXT_REASON_MAX_AGE_MS = 15 * 60_000;

type TextProgressRow = { key: TextProgressStageKey; waiting: number; oldest: string | null; completed: number; errors: number;
  deferred: number; blocked: number; provider_errors: number; error_age: string | null };

function readGroup(group: 'reason' | 'other', home: readonly string[]) {
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL jit = off`);
    await tx.execute(sql.raw(`SET LOCAL work_mem = '${TEXT_PROGRESS_WORK_MEM[group]}'`));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${TEXT_PROGRESS_STATEMENT_TIMEOUT[group]}'`));
    return Array.from(await tx.execute<TextProgressRow>(textStageProgressSql(home, group)));
  }, { accessMode: 'read only' });
}

/** 실패한 조각 — 이름과 SQLSTATE·오류 이름만 로그 한 줄로 남기고 그대로 돌려준다(SQL 본문·입력값·message 는 적지 않는다) */
function pieceFailed(piece: 'text-reason' | 'text-other', error: unknown): ProgressReadFailure {
  const failure = progressReadFailure(piece, error);
  logger.warn('progress.piece_failed', failure);
  return failure;
}

let reasonValue: { rows: TextProgressRow[]; measuredAt: number } | null = null;
let reasonFailure: { failure: ProgressReadFailure; at: number } | null = null;
let reasonRead: Promise<void> | null = null;
/** 시계가 뒤로 가 나이가 음수면 믿지 않는다(다시 센다) */
const within = (since: number, now: number, limit: number) => now - since >= 0 && now - since < limit;

/** 테스트 전용 — 담아 둔 사유 그룹 값을 비운다(같은 프로세스에서 자료를 바꿔 가며 읽는 통합 테스트) */
export function resetTextReasonProgressForTest(): void { reasonValue = null; reasonFailure = null; reasonRead = null; }

/**
 * 사유 그룹을 다시 셀 때가 됐으면 센다. 던지지 않는다 — 실패는 담아 두고 판정(readTextStageProgress)이 그 단계만 모름으로 한다.
 * 같은 프로세스의 동시 호출은 한 번만 센다. 감시(연결 1개)는 이것을 다른 읽기보다 먼저 혼자 부른다(failover-monitor.ts).
 */
export function warmTextReasonProgress(): Promise<void> {
  if (reasonRead) return reasonRead;
  const now = Date.now();
  if (reasonFailure && within(reasonFailure.at, now, TEXT_REASON_RETRY_MS)) return Promise.resolve();
  if (reasonValue && within(reasonValue.measuredAt, now, TEXT_REASON_REUSE_MS)) return Promise.resolve();
  const read: Promise<void> = (async () => {
    try {
      // 사유 가지는 홈 목록을 쓰지 않는다(그 조건은 other 가지에만 있다) — 홈 목록 읽기 실패가 이 조각으로 번지지 않게 빈 목록으로 만든다
      const rows = await readGroup('reason', []);
      reasonValue = { rows, measuredAt: now }; reasonFailure = null;
    } catch (error) {
      reasonFailure = { failure: pieceFailed('text-reason', error), at: Date.now() };
    }
  })().finally(() => { if (reasonRead === read) reasonRead = null; });
  reasonRead = read;
  return read;
}

/**
 * 일곱 단계. 두 조각(사유 그룹 · 그 밖)은 서로의 실패를 넘기지 않는다 — 읽지 못한 조각의 단계만 `unread`(모름)이고 나머지는 그대로 판정된다
 * (2026-11-21 전에는 어느 한쪽이 던지면 진행 전체가 unknown 이었고 원인이 남지 않았다).
 * 가벼운 그 밖 조각은 매번 먼저 읽고, 무거운 사유 조각은 맨 뒤에 5분 재사용으로 읽는다. `reuseReasonOnly` 는 여기서 사유를 다시 세지 않고
 * 담아 둔 값만 쓴다 — 방금 warmTextReasonProgress 를 따로 부른 호출자(감시)가 다른 읽기와 겹치는 20초 문장을 만들지 않게.
 */
export async function readTextStageProgress(options: { reuseReasonOnly?: boolean } = {}): Promise<ProgressStageInput[]> {
  let other: TextProgressRow[] = [], otherFailure: ProgressReadFailure | null = null;
  try { other = await readGroup('other', await homeListSlugs()); } catch (error) { otherFailure = pieceFailed('text-other', error); }
  if (!options.reuseReasonOnly) await warmTextReasonProgress();
  const now = Date.now(), reasonAge = reasonValue ? now - reasonValue.measuredAt : -1;
  const reason = reasonValue && reasonAge >= 0 && reasonAge <= TEXT_REASON_MAX_AGE_MS ? reasonValue : null;
  // 값이 없거나 낡았다 — 마지막 실패의 원인이 있으면 그것을, 없으면(한 번도 세지 않음·세지 않고 낡음) 그 사실을 싣는다
  const reasonFailed = reason ? null : reasonFailure?.failure ?? { piece: 'text-reason', code: reasonValue ? 'stale' : 'not_read' };
  const values = new Map([...other, ...(reason?.rows ?? [])].map(row => [row.key, row]));
  return (Object.keys(TEXT_PROGRESS_STAGE_JOBS) as TextProgressStageKey[]).map(key => {
    const unread = key === 'reason-translate' ? reasonFailed : otherFailure;
    if (unread) return { key, enabled: true, waiting: 0, oldestMinutes: null, completed5m: 0, progress5m: 0, errors5m: 0, unread };
    const row = values.get(key);
    const age = (value: string | null | undefined) => value == null ? null : Math.max(0, Number(value));
    return { key, enabled: true, waiting: row?.waiting ?? 0, oldestMinutes: age(row?.oldest),
      completed5m: row?.completed ?? 0, progress5m: row?.completed ?? 0, errors5m: row?.errors ?? 0,
      deferred: row?.deferred ?? 0, manualAttention: row?.blocked ?? 0,
      providerErrors: row?.provider_errors ?? 0, providerErrorMinutes: age(row?.error_age),
      ...(key === 'reason-translate' ? { measuredAgeSeconds: Math.floor(reasonAge / 1000) } : {}) };
  });
}
