import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productKoreanTaglines, products, type ProductStatus } from "@/lib/db/schema";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";
import { slugArrayPredicate } from "@/lib/domain/ranking/refresh";
import { NEEDS_KOREAN } from "./korean-tagline";
import { getPopularGroups } from "./popular";
import { listProductSlugs } from "./repository";

/**
 * 한국어 한 줄 소개의 대기열과 저장. 옮기는 일(게이트웨이)은 lib/crawl/translate.ts, 검사는 korean-tagline.ts 에 있다.
 */

const PUBLIC: ProductStatus[] = ["seeded", "verified"];
/** 검사에서 이만큼 버리면 손을 뗀다 — 원문이 보인다. 게이트웨이 실패는 세지 않고 하루 간격까지 늘려 가며 계속 본다 */
export const MAX_REJECTIONS = 4;
/** 등재 뒤 이 기간은 '새 제품'으로 맨 앞에 선다 */
const NEW_DAYS = 3;
/** 홈 목록 하나에서 앞쪽 몇 개를 '홈에 보이는 제품'으로 칠지 — 첫 화면과 '더 보기' 한두 번 */
const HOME_DEPTH = 40;

const listedAt = sql`coalesce(${products.verifiedAt}, ${products.createdAt})`;
const k = productKoreanTaglines;

export type KoreanTaglineTask = {
  productId: number; name: string; tagline: string; repoUrl: string | null;
  /** 같은 소개로 시도한 횟수(소개가 바뀌었으면 0) */
  attempts: number;
};

/**
 * 홈에 보이는 제품 — 급상승('추천'·띠), 최신, 인기 구간의 앞쪽. 홈과 같은 목록 조회(listProductSlugs·getPopularGroups)를 쓴다.
 * 잡이 틱마다 한 번 읽는다.
 */
export async function homeListSlugs(depth = HOME_DEPTH): Promise<string[]> {
  const base = { statuses: PUBLIC, excludeDown: true, limit: depth };
  const lists = await Promise.all([
    listProductSlugs({ ...base, sort: "rising", rising: true }),
    listProductSlugs({ ...base, sort: "recent", repoChecked: true }),
    getPopularGroups().then((groups) => groups.flatMap((group) => group.items.map((item) => item.slug))),
  ]);
  return [...new Set(lists.flat())];
}

/**
 * 옮길 공개 제품 — 아직 안 옮겼거나, 소개가 바뀌었거나, 실패를 다시 볼 때가 된 것. 이미 한국어인 소개(isKoreanLine)는 빼고.
 *
 * 차례(2026-10-09 운영자 결정 D3): 새로 올라온 제품(NEW_DAYS 안, 최신순) → 홈에 보이는 제품 → 나머지는 스타 많은 순.
 * 실패는 retry_at 이 지나야 다시 서므로 한 건이 앞을 막지 않는다.
 */
export async function pendingKoreanTaglines(limit: number, homeSlugs: readonly string[]): Promise<KoreanTaglineTask[]> {
  const tier = sql`case when ${listedAt} > now() - make_interval(days => ${NEW_DAYS}::int) then 0
    when ${slugArrayPredicate(products.slug, [...homeSlugs])} then 1 else 2 end`;
  const rows = await db.select({
    productId: products.id, name: products.name, tagline: products.tagline, repoUrl: products.repoUrl,
    attempts: sql<number>`case when ${k.sourceTagline} = ${products.tagline} then ${k.attempts} else 0 end`,
  }).from(products)
    .leftJoin(k, eq(k.productId, products.id))
    .where(and(
      inArray(products.status, PUBLIC),
      NEEDS_KOREAN,
      sql`(${k.productId} is null or ${k.sourceTagline} <> ${products.tagline}
        or (${k.errorCode} is not null and (${k.errorCode} not like 'rejected:%' or ${k.attempts} < ${MAX_REJECTIONS})
            and (${k.retryAt} is null or ${k.retryAt} <= now())))`,
    ))
    .orderBy(tier, sql`case when ${listedAt} > now() - make_interval(days => ${NEW_DAYS}::int) then ${listedAt} end desc nulls last`,
      sql`${products.stars} desc nulls last`, desc(products.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, attempts: Number(row.attempts) }));
}

export type KoreanTaglineResult =
  | { kind: "success"; line: string; model: string }
  /** error: 게이트웨이 실패 코드 또는 'rejected:<검사 사유>' */
  | { kind: "failure"; error: string; model: string };

/**
 * 결과를 남긴다 — 한 묶음을 한 트랜잭션에. 그사이 소개가 바뀌었거나 내려간 제품은 건너뛴다(다음 틱이 지금 소개로 다시 옮긴다).
 * 실패는 5분·10분·20분… 뒤에 다시(최대 하루). 지금 소개에서 옮긴 한국어가 이미 있으면 실패로 덮지 않는다.
 * 리스 확인은 맨 마지막이다 — 잃었으면 적은 것 전부가 되돌려진다. 적은 수를 돌려준다.
 */
export async function recordKoreanTaglines(entries: { task: KoreanTaglineTask; result: KoreanTaglineResult }[], lease: JobLease): Promise<number> {
  return db.transaction(async (tx) => {
    let stored = 0;
    for (const { task, result } of entries) {
      const [product] = await tx.select({ tagline: products.tagline, status: products.status })
        .from(products).where(eq(products.id, task.productId)).for("share");
      if (!product || product.tagline !== task.tagline || !PUBLIC.includes(product.status)) continue;
      const same = sql`${k.sourceTagline} = excluded.source_tagline`;
      const attempts = sql`case when ${same} then ${k.attempts} + 1 else 1 end`;
      const values = { productId: task.productId, sourceTagline: task.tagline, model: result.model, attempts: 1 };
      if (result.kind === "success") {
        await tx.insert(k).values({ ...values, taglineKo: result.line, errorCode: null, retryAt: null })
          .onConflictDoUpdate({ target: k.productId, set: { sourceTagline: task.tagline, taglineKo: result.line, model: result.model,
            attempts, errorCode: null, retryAt: null, updatedAt: sql`now()` } });
      } else {
        const code = result.error.slice(0, 60);
        await tx.insert(k).values({ ...values, taglineKo: null, errorCode: code, retryAt: sql`now() + interval '5 minutes'` })
          .onConflictDoUpdate({ target: k.productId,
            set: { sourceTagline: task.tagline, taglineKo: null, model: result.model, attempts, errorCode: code, updatedAt: sql`now()`,
              retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, case when ${same} then ${k.attempts} else 0 end))` },
            setWhere: sql`not (${same} and ${k.errorCode} is null)` });
      }
      stored++;
    }
    await assertJobLease(tx, lease);
    return stored;
  });
}

export type KoreanTaglineProgress = {
  /** 옮길 공개 제품(이미 한국어인 소개는 빠진다) */
  eligible: number;
  /** 지금 소개에서 옮긴 한국어가 있는 것 */
  done: number;
  /** 아직 한 번도 안 옮겼거나 소개가 바뀐 것 */
  waiting: number;
  /** 게이트웨이 실패로 다시 기다리는 것 */
  failed: number;
  /** 검사에서 MAX_REJECTIONS 번 버려 손을 뗀 것 — 원문이 보인다 */
  gaveUp: number;
  /** 지금 소개의 마지막 시도가 검사에서 버려진 것, 사유별(rejected: 를 뗀 사유) */
  rejected: { reason: string; count: number }[];
  /** 지난 한 시간에 옮긴 것 */
  lastHour: number;
};

/** 운영센터·관리자가 볼 진행과 품질 수치 — 채운 수와 함께 버린 수를 사유별로 본다 */
export async function koreanTaglineProgress(): Promise<KoreanTaglineProgress> {
  const current = sql`${k.sourceTagline} = ${products.tagline}`;
  const [totals] = await db.select({
    eligible: sql<number>`count(*)::int`,
    done: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} is null))::int`,
    waiting: sql<number>`(count(*) filter (where ${k.productId} is null or not ${current}))::int`,
    failed: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} not like 'rejected:%'))::int`,
    gaveUp: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} like 'rejected:%' and ${k.attempts} >= ${MAX_REJECTIONS}))::int`,
    lastHour: sql<number>`(count(*) filter (where ${current} and ${k.errorCode} is null and ${k.updatedAt} > now() - interval '1 hour'))::int`,
  }).from(products).leftJoin(k, eq(k.productId, products.id)).where(and(inArray(products.status, PUBLIC), NEEDS_KOREAN));
  const rejected = await db.select({ code: k.errorCode, count: sql<number>`count(*)::int` })
    .from(products).innerJoin(k, eq(k.productId, products.id))
    .where(and(inArray(products.status, PUBLIC), NEEDS_KOREAN, sql`${current} and ${k.errorCode} like 'rejected:%'`))
    .groupBy(k.errorCode).orderBy(sql`count(*) desc`);
  return {
    eligible: Number(totals?.eligible ?? 0), done: Number(totals?.done ?? 0), waiting: Number(totals?.waiting ?? 0),
    failed: Number(totals?.failed ?? 0), gaveUp: Number(totals?.gaveUp ?? 0), lastHour: Number(totals?.lastHour ?? 0),
    rejected: rejected.map((row) => ({ reason: (row.code ?? "").replace(/^rejected:/, ""), count: Number(row.count) })),
  };
}

/** 표본 검수용 — 옮긴 것 중 무작위로. 원문과 나란히 사람이 읽고 맞게 옮겼는지 본다(운영자 결정 D3) */
export async function koreanTaglineSample(limit = 20): Promise<{ slug: string; name: string; tagline: string; taglineKo: string; model: string }[]> {
  const rows = await db.select({ slug: products.slug, name: products.name, tagline: products.tagline, taglineKo: k.taglineKo, model: k.model })
    .from(products).innerJoin(k, eq(k.productId, products.id))
    .where(and(inArray(products.status, PUBLIC), sql`${k.sourceTagline} = ${products.tagline} and ${k.errorCode} is null and ${k.taglineKo} is not null`))
    .orderBy(sql`random()`).limit(Math.max(1, Math.min(200, limit)));
  return rows.map((row) => ({ ...row, taglineKo: row.taglineKo ?? "" }));
}
