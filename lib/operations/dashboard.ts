import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, onReplica } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlFrontier, crawlReviewAttempts, productAuditCampaigns, productAuditItems, productEvidenceAudit, productHealth,
  productRepoReviews, productSearchProfiles, products, secondReviews } from "@/lib/db/schema";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { sameReviewModel } from "@/lib/crawl/review-model-identity";
import { SHOW_HN_SIGNAL, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { RECHECK_AFTER_MINUTES } from "@/lib/domain/products/health-freshness";
import { countProducts, repoGone, SPAM_AUTO_BAN_ACTOR, SPAM_AUTO_BAN_REASON, spamAutoBanned } from "@/lib/domain/products/repository";
import { repoReviewOpen } from "@/lib/domain/products/repo-reviews";
import { PROFILE_MODEL } from "@/lib/domain/products/search-profile";

/**
 * 운영 센터 대시보드 — 읽기만 한다.
 *
 * 시각 컬럼은 모두 시간대 없는 timestamp(UTC 벽시계)다. 경계는 SQL 에서 now 를 그대로 박아 재고,
 * 내보내는 시각도 SQL 에서 ISO 로 만든다 — 노드가 로컬 시각으로 읽으면 9시간 밀린다.
 */

/** 한 시간 칸 — 24칸, 오래된 것부터. hour 는 그 칸의 시작(ISO, UTC) */
export type HourPoint = {
  hour: string; discovered: number; judged: number;
  /** firstReviews = 끝난 1차 모델 심사, firstFailed = 실패한 호출(둘은 겹치지 않는다) */
  firstReviews: number; firstFailed: number;
  secondReviews: number; secondAgreed: number;   // secondAgreed = second_decision = first_decision (second_decision not null)
  published: number; publishedKorean: number;     // publishedKorean = products.name or tagline contains Hangul [가-힣]
  keywords: number;                               // product_search_profiles.generated_at in that hour
};
export type HourlySeries = { measuredAt: string; points: HourPoint[] };

export type ModelHealth = {
  key: "first" | "second" | "fallback" | "keywords";
  label: string;                 // "1차 심사" | "2차 투표" | "2차 fallback" | "키워드 짓기"
  model: string | null;          // configured model name (settings) or the model observed in the last hour
  /** 지난 1시간에 끝난 호출(성공+실패). failed1h 는 그중 실패 */
  calls1h: number; failed1h: number;
  /** 2차는 줄에 올린 때부터 재므로 대기 시간이 들어 있다. 키워드는 걸린 시간을 남기지 않아 늘 null */
  avgSeconds: number | null;     // mean (completed_at - started_at) or (reviewed_at - created_at); null when no calls
  agreement1h: number | null;    // second/fallback only: share of rows (0..1) whose second_decision = first_decision; null otherwise
  /** 지난 24시간 안의 마지막 성공. 그보다 오래됐으면 null */
  lastSuccessAt: string | null;  // ISO
};

export type SignalYield = { signal: string; enqueued: number; published: number; gated: number; requireEvidence: boolean };

export type RecentPublication = { slug: string; name: string; tagline: string; category: string; signal: string | null; createdAt: string; korean: boolean };
export type TodayPublications = { total24h: number; korean24h: number; latest: RecentPublication[] };

export type AttentionCounts = {
  /** 마지막 감사에서 AI 가 내리자고 했는데 아직 사람이 보지 않은 것 — /admin/audit 의 숫자와 같다(제품이 아직 떠 있는 것만) */
  auditRejectsOpen: number;      // product_audit_items where ai_decision = 'reject' and human_decision is null
  /** 생존 확인 대상(웹사이트로 여는 공개 제품)만 센다 — 설치형은 확인하지 않으므로 늘 밀린 것으로 보이게 된다 */
  healthOverdue: number;         // listed products (status seeded|verified) whose product_health.checked_at is null or older than 6 hours
  /** 생존 확인이 따라가야 할 시간당 건수 — 웹사이트 공개 제품 수 ÷ 재확인 간격(시간) */
  healthTargetPerHour: number;
  introNeedsEditor: number;      // use countProducts({ statuses: ["seeded","verified"], introNeedsEditor: true }) from "@/lib/domain/products/repository"
  /**
   * 진행 중인 감사. 프롬프트·규칙이 시작 때와 다르면 잡이 매 틱 건너뛴다(product-audit.ts) — 작업 표엔 "정상"으로만 보였다.
   * current=false 면 사람이 중단하고 새로 열어야 한다
   */
  auditCampaign: { id: number; promptVersion: string; current: boolean; unanswered: number } | null;
  /** 내린 제품의 CDN 캐시 지우기가 10분 넘게 확인되지 않은 것 — 지우기 토큰이 없으면 잡은 "끝남"으로만 남는다 */
  cdnPurgesPending: number;
  /**
   * GitHub 저장소가 사라졌다고 확정된 공개 제품(repository.ts repoGone) — /admin/products '저장소 사라짐'과 같은 수.
   * 설치형은 목록에서 가려졌고 웹사이트는 GitHub 표시만 뺐다
   */
  repoGone: { installable: number; website: number };
  /**
   * 하루 저장소 확인(product-stars-refresh)의 품질 — 공개 제품 중 GitHub 저장소가 있는 것(tracked) 가운데 지난 24시간에
   * 확정 답을 받은 것(checked24h). 상태별 수와 그중 지난 24시간에 바뀐 것(repo_changed_at — 첫 기록은 세지 않는다).
   * archived·renamed 는 상태와 겹친다(보관된 저장소도 'ok' 다)
   */
  repoHealth: {
    tracked: number; checked24h: number;
    states: Record<"ok" | "not_found" | "empty" | "blocked" | "archived" | "renamed", { total: number; new24h: number }>;
  };
  /**
   * 2단계 확인(product-repo-review) — 저장소가 사라진 공개 웹사이트. pending 은 아직 AI 가 안 본 것,
   * delistCandidates·human 은 운영자를 기다리는 것(repoReviewOpen), kept 는 AI 가 그대로 둔 것.
   * oldestHours 는 안 본 것·기다리는 것 중 사라졌다고 확정된 뒤(repo_missing_since + 24시간) 가장 오래된 것
   */
  repoReview: { pending: number; delistCandidates: number; human: number; kept: number; oldestHours: number | null };
  /**
   * 공개 제품 스팸 재검사(product-spam-rescan)가 내린 것 — day 는 지난 24시간에 내린 수(잡의 하루 한도와 같은 식),
   * banned 는 지금 차단 상태로 남은 수(/admin/products '스팸 자동 차단'과 같다)
   */
  spamAutoBans: { day: number; banned: number };
};

const at = (now: Date) => sql`${now.toISOString()}::timestamp`;
const iso = (value: SQL) => sql`to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const korean = sql`(${products.name} ~ '[가-힣]' OR ${products.tagline} ~ '[가-힣]')`;

/** 1차 모델 호출 — 규칙 처리·결과 재사용·종료 취소는 모델을 부른 것이 아니다(throughput.ts 와 같은 기준) */
const firstModelCall = sql`${crawlReviewAttempts.kind} = 'automatic' AND ${crawlReviewAttempts.provider} <> 'rules'
  AND ${crawlReviewAttempts.reusedFromAttemptId} IS NULL AND ${crawlReviewAttempts.state} IN ('succeeded', 'failed')
  AND ${crawlReviewAttempts.errorCode} IS DISTINCT FROM 'cancelled'`;
/** 끝난 2차 표 — 실패한 표는 결정이 없다 */
const voted = sql`${secondReviews.secondDecision} IS NOT NULL AND ${secondReviews.errorCode} IS NULL`;

/**
 * 지금 목록에 있고 since 이후에 만든 제품.
 *
 * created_at 에는 인덱스가 없다. 등재 시각(coalesce(verified_at, created_at))은 created_at 보다 늦거나 같으므로
 * 그 조건을 덧붙여도 결과는 같고, products_status_listed_at_idx 를 탈 수 있다.
 */
const listedSince = (since: SQL) => sql`${products.status} IN ('seeded', 'verified')
  AND coalesce(${products.verifiedAt}, ${products.createdAt}) >= ${since} AND ${products.createdAt} >= ${since}`;

/**
 * 프로드에서 JIT 컴파일이 집계보다 오래 걸렸다(throughput.ts, 7.3초) — 대시보드 읽기는 끄고 돈다.
 * 운영센터가 10초마다 다시 부르는 표 훑기라 복제본에서 센다(lib/db/replica.ts) — 주 DB 는 워커와 다른 DB 가 같이 쓴다.
 * 복제가 10초 넘게 밀리거나 닿지 않으면 주 DB 로 읽는다.
 */
function readOnly<T extends Record<string, unknown>>(query: SQL) {
  return onReplica(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL jit = off`);
    return tx.execute<T>(query);
  }, { accessMode: "read only" }));
}

/**
 * 시간별·신호별 집계는 화면이 10초마다 불러도 인스턴스마다 1분에 한 번만 센다(home-pulse 와 같은 방식).
 * 키는 집계 창이 바뀌는 단위다. 실패는 담아 두지 않는다 — 다음 요청이 다시 센다.
 */
const CACHE_TTL_MS = 60_000;

function cachedLoader<T>() {
  let entry: { key: string; expiresAt: number; value: Promise<T> } | null = null;
  return async (key: string, nowMs: number, load: () => Promise<T>): Promise<T> => {
    if (entry?.key === key && nowMs < entry.expiresAt) return entry.value;
    const current = { key, expiresAt: nowMs + CACHE_TTL_MS, value: load() };
    entry = current;
    try {
      return await current.value;
    } catch (error) {
      if (entry === current) entry = null;
      throw error;
    }
  };
}

const hourlyCache = cachedLoader<HourlySeries>();
const signalCache = cachedLoader<Omit<SignalYield, "requireEvidence">[]>();

export async function hourlyThroughput(now = new Date()): Promise<HourlySeries> {
  return hourlyCache(String(Math.floor(now.getTime() / 3_600_000)), now.getTime(), () => loadHourly(now));
}

/**
 * 표마다 24시간 창을 한 번만 훑어 시간으로 묶고, 24칸에 붙인다.
 *
 * 칸마다 LATERAL 로 세지 않는다 — 이 시각 컬럼들에는 인덱스가 없어 칸마다 표 전체를 다시 읽게 된다.
 */
async function loadHourly(now: Date): Promise<HourlySeries> {
  const end = at(now);
  const start = sql`date_trunc('hour', ${end}) - interval '23 hours'`;
  const hourOf = (column: AnyPgColumn) => sql`date_trunc('hour', ${column})`;
  const within = (column: AnyPgColumn) => sql`${column} >= ${start} AND ${column} <= ${end}`;

  const rows = await readOnly<{
    hour: string; discovered: number; judged: number; first_reviews: number; first_failed: number;
    second_reviews: number; second_agreed: number; published: number; published_korean: number; keywords: number;
  }>(sql`
    WITH hours AS (
      SELECT date_trunc('hour', ${end}) - g * interval '1 hour' AS hour FROM generate_series(23, 0, -1) AS g
    ), discovered AS (
      SELECT ${hourOf(crawlFrontier.discoveredAt)} AS hour, count(*)::int AS n
      FROM ${crawlFrontier} WHERE ${within(crawlFrontier.discoveredAt)} GROUP BY 1
    ), judged AS (
      SELECT ${hourOf(crawlCandidates.judgedAt)} AS hour, count(*)::int AS n
      FROM ${crawlCandidates} WHERE ${within(crawlCandidates.judgedAt)} GROUP BY 1
    ), first_done AS (
      SELECT ${hourOf(crawlReviewAttempts.completedAt)} AS hour,
        count(*) FILTER (WHERE ${crawlReviewAttempts.state} = 'succeeded')::int AS reviews,
        count(*) FILTER (WHERE ${crawlReviewAttempts.state} = 'failed')::int AS failed
      FROM ${crawlReviewAttempts} WHERE ${firstModelCall} AND ${within(crawlReviewAttempts.completedAt)} GROUP BY 1
    ), votes AS (
      SELECT ${hourOf(secondReviews.reviewedAt)} AS hour, count(*)::int AS reviews,
        count(*) FILTER (WHERE ${secondReviews.secondDecision} = ${secondReviews.firstDecision})::int AS agreed
      FROM ${secondReviews} WHERE ${voted} AND ${within(secondReviews.reviewedAt)} GROUP BY 1
    ), listed AS (
      SELECT ${hourOf(products.createdAt)} AS hour, count(*)::int AS n, count(*) FILTER (WHERE ${korean})::int AS korean
      FROM ${products} WHERE ${listedSince(start)} AND ${products.createdAt} <= ${end} GROUP BY 1
    ), keywords AS (
      SELECT ${hourOf(productSearchProfiles.generatedAt)} AS hour, count(*)::int AS n
      FROM ${productSearchProfiles} WHERE ${within(productSearchProfiles.generatedAt)} GROUP BY 1
    )
    SELECT ${iso(sql`h.hour`)} AS hour, coalesce(d.n, 0) AS discovered, coalesce(j.n, 0) AS judged,
      coalesce(f.reviews, 0) AS first_reviews, coalesce(f.failed, 0) AS first_failed,
      coalesce(v.reviews, 0) AS second_reviews, coalesce(v.agreed, 0) AS second_agreed,
      coalesce(l.n, 0) AS published, coalesce(l.korean, 0) AS published_korean, coalesce(k.n, 0) AS keywords
    FROM hours h
    LEFT JOIN discovered d ON d.hour = h.hour LEFT JOIN judged j ON j.hour = h.hour
    LEFT JOIN first_done f ON f.hour = h.hour LEFT JOIN votes v ON v.hour = h.hour
    LEFT JOIN listed l ON l.hour = h.hour LEFT JOIN keywords k ON k.hour = h.hour
    ORDER BY h.hour
  `);

  return { measuredAt: now.toISOString(), points: rows.map((row) => ({
    hour: row.hour, discovered: Number(row.discovered), judged: Number(row.judged),
    firstReviews: Number(row.first_reviews), firstFailed: Number(row.first_failed),
    secondReviews: Number(row.second_reviews), secondAgreed: Number(row.second_agreed),
    published: Number(row.published), publishedKorean: Number(row.published_korean), keywords: Number(row.keywords),
  })) };
}

const MODEL_SLOTS = [
  { key: "first", label: "1차 심사" },
  { key: "second", label: "2차 투표" },
  { key: "fallback", label: "2차 fallback" },
  { key: "keywords", label: "키워드 짓기" },
] as const;

/**
 * 모델 자리마다 지난 1시간의 호출. 한 문장에서 자리별 호출을 같은 모양으로 모아 한 번에 센다.
 *
 * 2차 투표는 1차와 다른 모델 중 첫 투표자다 — 같은 모델은 메아리라 줄에 올리지 않는다(second-review.ts).
 * 키워드 실패는 따로 남지 않아, 지난 1시간에 실패로 고쳐 쓴 행을 센다.
 */
export async function modelHealth(settings: CrawlSettings, now = new Date()): Promise<ModelHealth[]> {
  const firstModel = settings.firstReview?.model ?? null;
  const configured: Record<ModelHealth["key"], string | null> = {
    first: firstModel,
    second: settings.secondReview.voters.find((voter) => !sameReviewModel(voter.model, firstModel))?.model ?? null,
    fallback: settings.secondReview.fallbacks?.[0]?.model ?? null,
    keywords: PROFILE_MODEL,
  };
  const end = at(now);
  const within = (column: AnyPgColumn) => sql`${column} > ${end} - interval '24 hours' AND ${column} <= ${end}`;

  const rows = await readOnly<{
    key: ModelHealth["key"]; observed: string | null; calls: number; failed: number;
    avg_seconds: number | null; agreement: number | null; last_success: string | null;
  }>(sql`
    WITH calls AS (
      SELECT 'first' AS key, ${crawlReviewAttempts.model} AS model, ${crawlReviewAttempts.state} = 'failed' AS failed,
        ${crawlReviewAttempts.completedAt} - ${crawlReviewAttempts.startedAt} AS took,
        ${crawlReviewAttempts.completedAt} AS done_at, NULL::boolean AS agreed
      FROM ${crawlReviewAttempts} WHERE ${firstModelCall} AND ${within(crawlReviewAttempts.completedAt)}
      UNION ALL
      SELECT slot.key, ${secondReviews.model}, ${secondReviews.errorCode} IS NOT NULL,
        ${secondReviews.reviewedAt} - ${secondReviews.createdAt}, ${secondReviews.reviewedAt},
        CASE WHEN ${voted} THEN ${secondReviews.secondDecision} = ${secondReviews.firstDecision} END
      FROM ${secondReviews}
      JOIN (VALUES ('second', ${configured.second}::text), ('fallback', ${configured.fallback}::text)) AS slot(key, model)
        ON slot.model = ${secondReviews.model}
      WHERE ${secondReviews.errorCode} IS DISTINCT FROM 'cancelled' AND ${within(secondReviews.reviewedAt)}
      UNION ALL
      SELECT 'keywords', ${productSearchProfiles.model}, false, NULL::interval, ${productSearchProfiles.generatedAt}, NULL
      FROM ${productSearchProfiles} WHERE ${within(productSearchProfiles.generatedAt)}
      UNION ALL
      SELECT 'keywords', ${productSearchProfiles.model}, true, NULL::interval, ${productSearchProfiles.updatedAt}, NULL
      FROM ${productSearchProfiles} WHERE ${productSearchProfiles.errorCode} IS NOT NULL AND ${within(productSearchProfiles.updatedAt)}
    ), marked AS (
      SELECT *, done_at > ${end} - interval '1 hour' AS recent FROM calls
    )
    SELECT key, (array_agg(model ORDER BY done_at DESC) FILTER (WHERE recent))[1] AS observed,
      count(*) FILTER (WHERE recent)::int AS calls, count(*) FILTER (WHERE recent AND failed)::int AS failed,
      round(avg(extract(epoch FROM took)) FILTER (WHERE recent), 1)::float8 AS avg_seconds,
      avg(agreed::int) FILTER (WHERE recent)::float8 AS agreement,
      ${iso(sql`max(done_at) FILTER (WHERE NOT failed)`)} AS last_success
    FROM marked GROUP BY key
  `);

  const byKey = new Map(rows.map((row) => [row.key, row]));
  return MODEL_SLOTS.map(({ key, label }) => {
    const row = byKey.get(key);
    const voting = key === "second" || key === "fallback";
    return {
      key, label,
      model: configured[key] ?? row?.observed ?? null,
      calls1h: Number(row?.calls ?? 0), failed1h: Number(row?.failed ?? 0),
      avgSeconds: row?.avg_seconds == null ? null : Number(row.avg_seconds),
      agreement1h: voting && row?.agreement != null ? Number(row.agreement) : null,
      lastSuccessAt: row?.last_success ?? null,
    };
  });
}

/** 최근 days 일 동안 frontier 에 들어온 레포를 신호별로 — published = 후보 state published, gated = 후보 reason 'ai_evidence_not_found' */
export async function signalYields(settings: CrawlSettings, days = 7): Promise<SignalYield[]> {
  const now = new Date();
  const rows = await signalCache(String(days), now.getTime(), () => loadSignals(now, days));
  // 설정은 담아 둔 집계에 섞지 않는다 — 흔적 요구를 바꾸면 바로 보인다
  return rows.map((row) => ({ ...row, requireEvidence: row.signal === SHOW_HN_SIGNAL
    ? settings.discover.showHn.requireEvidence === true
    : settings.discover.queries.find((query) => query.label === row.signal)?.requireEvidence === true }));
}

async function loadSignals(now: Date, days: number): Promise<Omit<SignalYield, "requireEvidence">[]> {
  const rows = await readOnly<{ signal: string; enqueued: number; published: number; gated: number }>(sql`
    SELECT ${crawlFrontier.signal} AS signal, count(*)::int AS enqueued,
      count(*) FILTER (WHERE ${crawlCandidates.state} = 'published')::int AS published,
      count(*) FILTER (WHERE ${crawlCandidates.reason} = 'ai_evidence_not_found')::int AS gated
    FROM ${crawlFrontier} LEFT JOIN ${crawlCandidates} ON ${crawlCandidates.repo} = ${crawlFrontier.repo}
    WHERE ${crawlFrontier.discoveredAt} > ${at(now)} - ${days}::int * interval '1 day'
    GROUP BY 1 ORDER BY enqueued DESC, signal
  `);
  return rows.map((row) => ({ signal: row.signal, enqueued: Number(row.enqueued), published: Number(row.published), gated: Number(row.gated) }));
}

/** 지난 24시간에 목록에 오른 제품. 신호는 발행한 후보(published_slug)의 프론티어 행에서 — 메이커 등록분은 null */
export async function todayPublications(now = new Date(), limit = 6): Promise<TodayPublications> {
  const end = at(now);
  const rows = await readOnly<{
    total: number; korean_total: number; slug: string | null; name: string; tagline: string; category: string;
    signal: string | null; created_at: string; korean: boolean;
  }>(sql`
    WITH recent AS (
      SELECT ${products.slug} AS slug, ${products.name} AS name, ${products.tagline} AS tagline,
        ${products.category} AS category, ${products.createdAt} AS created_at, ${korean} AS korean
      FROM ${products} WHERE ${listedSince(sql`${end} - interval '24 hours'`)} AND ${products.createdAt} <= ${end}
    ), totals AS (
      SELECT count(*)::int AS total, count(*) FILTER (WHERE korean)::int AS korean_total FROM recent
    )
    SELECT totals.total, totals.korean_total, latest.* FROM totals LEFT JOIN LATERAL (
      SELECT recent.slug, recent.name, recent.tagline, recent.category, ${iso(sql`recent.created_at`)} AS created_at, recent.korean,
        (SELECT ${crawlFrontier.signal} FROM ${crawlCandidates} JOIN ${crawlFrontier} ON ${crawlFrontier.repo} = ${crawlCandidates.repo}
          WHERE ${crawlCandidates.publishedSlug} = recent.slug ORDER BY ${crawlCandidates.id} DESC LIMIT 1) AS signal
      FROM recent ORDER BY recent.created_at DESC, recent.slug LIMIT ${limit}
    ) latest ON true
  `);

  return {
    total24h: Number(rows[0]?.total ?? 0),
    korean24h: Number(rows[0]?.korean_total ?? 0),
    latest: rows.filter((row) => row.slug !== null).map((row) => ({
      slug: row.slug!, name: row.name, tagline: row.tagline, category: row.category,
      signal: row.signal, createdAt: row.created_at, korean: row.korean,
    })),
  };
}

/** 저장소 상태별로 셀 조건 — 보관·이름 바뀜은 상태와 따로 센다 */
const REPO_STATES = [
  ["ok", sql`${products.repoStatus} = 'ok'`],
  ["not_found", sql`${products.repoStatus} = 'not_found'`],
  ["empty", sql`${products.repoStatus} = 'empty'`],
  ["blocked", sql`${products.repoStatus} = 'blocked'`],
  ["archived", sql`${products.repoArchived} IS TRUE`],
  ["renamed", sql`${products.repoRenamedTo} IS NOT NULL`],
] as const;

export async function attentionCounts(now = new Date()): Promise<AttentionCounts> {
  const [[row], introNeedsEditor, [campaign], [repo], [review]] = await Promise.all([
    readOnly<{ audit: number; health: number; websites: number; purges: number; gone_installable: number; gone_website: number;
      spam_day: number; spam_banned: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM ${productAuditItems} JOIN ${products} ON ${products.id} = ${productAuditItems.productId}
          WHERE ${productAuditItems.campaignId} = (SELECT max(${productAuditCampaigns.id}) FROM ${productAuditCampaigns})
            AND ${productAuditItems.aiDecision} = 'reject' AND ${productAuditItems.humanDecision} IS NULL
            AND ${products.status} IN ('seeded', 'verified')) AS audit,
        (SELECT count(*)::int FROM ${products} LEFT JOIN ${productHealth} ON ${productHealth.slug} = ${products.slug}
          WHERE ${products.status} IN ('seeded', 'verified') AND ${products.accessMode} = 'website'
            AND (${productHealth.checkedAt} IS NULL
              OR ${productHealth.checkedAt} < ${at(now)} - ${RECHECK_AFTER_MINUTES}::int * interval '1 minute')) AS health,
        (SELECT count(*)::int FROM ${products}
          WHERE ${products.status} IN ('seeded', 'verified') AND ${products.accessMode} = 'website') AS websites,
        (SELECT count(*)::int FROM ${cdnPurges} WHERE ${cdnPurges.confirmedAt} IS NULL
          AND ${cdnPurges.createdAt} < ${at(now)} - interval '10 minutes') AS purges,
        (SELECT count(*)::int FROM ${products}
          WHERE ${products.status} IN ('seeded', 'verified') AND ${products.accessMode} <> 'website' AND ${repoGone}) AS gone_installable,
        (SELECT count(*)::int FROM ${products}
          WHERE ${products.status} IN ('seeded', 'verified') AND ${products.accessMode} = 'website' AND ${repoGone}) AS gone_website,
        (SELECT count(*)::int FROM ${productEvidenceAudit} WHERE ${productEvidenceAudit.action} = 'admin.product.ban'
          AND ${productEvidenceAudit.actor} = ${SPAM_AUTO_BAN_ACTOR} AND ${productEvidenceAudit.reason} = ${SPAM_AUTO_BAN_REASON}
          AND ${productEvidenceAudit.createdAt} > ${at(now)} - interval '24 hours') AS spam_day,
        (SELECT count(*)::int FROM ${products} WHERE ${spamAutoBanned}) AS spam_banned
    `),
    countProducts({ statuses: ["seeded", "verified"], introNeedsEditor: true }),
    readOnly<{ id: number; prompt_version: string; rules_version: string; unanswered: number }>(sql`
      SELECT c.id, c.prompt_version, c.rules_version,
        (SELECT count(*)::int FROM ${productAuditItems} i WHERE i.campaign_id = c.id AND i.ai_decision IS NULL) AS unanswered
      FROM ${productAuditCampaigns} c WHERE c.status = 'running' ORDER BY c.id DESC LIMIT 1
    `),
    readOnly<Record<string, number>>(sql`
      SELECT count(*)::int AS tracked,
        count(*) FILTER (WHERE ${products.repoCheckedAt} >= ${at(now)} - interval '24 hours')::int AS checked,
        ${sql.join(REPO_STATES.map(([key, condition]) => sql`count(*) FILTER (WHERE ${condition})::int AS ${sql.identifier(key)},
          count(*) FILTER (WHERE ${condition} AND ${products.repoChangedAt} >= ${at(now)} - interval '24 hours')::int AS ${sql.identifier(`${key}_new`)}`), sql`, `)}
      FROM ${products} WHERE ${products.status} IN ('seeded', 'verified') AND ${products.repoUrl} IS NOT NULL
    `),
    readOnly<{ pending: number; delist: number; human: number; kept: number; oldest_hours: number | null }>(sql`
      SELECT count(*) FILTER (WHERE ${productRepoReviews.productId} IS NULL)::int AS pending,
        count(*) FILTER (WHERE ${repoReviewOpen} AND ${productRepoReviews.decision} = 'delist_candidate')::int AS delist,
        count(*) FILTER (WHERE ${repoReviewOpen} AND ${productRepoReviews.decision} = 'human')::int AS human,
        count(*) FILTER (WHERE ${productRepoReviews.decision} = 'keep')::int AS kept,
        (max(extract(epoch FROM ${at(now)} - (${products.repoMissingSince} + interval '24 hours')))
          FILTER (WHERE ${productRepoReviews.productId} IS NULL OR ${repoReviewOpen}) / 3600)::float8 AS oldest_hours
      FROM ${products} LEFT JOIN ${productRepoReviews} ON ${productRepoReviews.productId} = ${products.id}
      WHERE ${products.status} IN ('seeded', 'verified') AND ${products.accessMode} = 'website' AND ${repoGone}
    `),
  ]);
  // 한 바퀴를 재확인 간격 안에 돌려면 시간당 몇 건을 봐야 하나 — 제품이 늘면 목표도 는다(고정값 3,224 는 1만9천 개 때 것)
  const healthTargetPerHour = Math.ceil(Number(row?.websites ?? 0) / (RECHECK_AFTER_MINUTES / 60));
  return { auditRejectsOpen: Number(row?.audit ?? 0), healthOverdue: Number(row?.health ?? 0), healthTargetPerHour, introNeedsEditor,
    cdnPurgesPending: Number(row?.purges ?? 0),
    repoGone: { installable: Number(row?.gone_installable ?? 0), website: Number(row?.gone_website ?? 0) },
    spamAutoBans: { day: Number(row?.spam_day ?? 0), banned: Number(row?.spam_banned ?? 0) },
    repoHealth: { tracked: Number(repo?.tracked ?? 0), checked24h: Number(repo?.checked ?? 0),
      states: Object.fromEntries(REPO_STATES.map(([key]) => [key, { total: Number(repo?.[key] ?? 0), new24h: Number(repo?.[`${key}_new`] ?? 0) }])) as
        AttentionCounts["repoHealth"]["states"] },
    repoReview: { pending: Number(review?.pending ?? 0), delistCandidates: Number(review?.delist ?? 0), human: Number(review?.human ?? 0),
      kept: Number(review?.kept ?? 0), oldestHours: review?.oldest_hours === null || review?.oldest_hours === undefined ? null : Number(review.oldest_hours) },
    auditCampaign: campaign ? { id: Number(campaign.id), promptVersion: campaign.prompt_version,
      current: campaign.prompt_version === REVIEW_PROMPT_VERSION && campaign.rules_version === REVIEW_RULES_VERSION,
      unanswered: Number(campaign.unanswered) } : null };
}
