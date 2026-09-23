import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, textTranslations } from "@/lib/db/schema";
import { QUERY_PROMPT_VERSION, queryTranslationPhrases, textHash, TRANSLATE_MODEL, translateQueryToEnglish } from "@/lib/crawl/translate";
import { recordTranslations } from "@/lib/crawl/translations";
import { logger } from "@/lib/observability/logger";
import { planTerms, productSearchPredicate, RELAX_MIN_TERMS, type SearchPlan, type SearchQuery } from "./search";

/**
 * 한국어 검색어를 영어 낱말로 바꿔 한 번 더 찾는다.
 *
 * 목록은 영어다 — 소개의 62%가 ASCII 뿐이고 한글이 든 것은 3%뿐이다(2026-09-18 프로드).
 * 그래서 "PDF 합치는 도구"·"코드 리뷰 자동화"·"회의록 요약"·"사진 배경 제거"가 모두 0건이었다.
 * 모델에게 낱말을 받아 같은 색인으로 다시 찾으면 제자리를 찾는다.
 *
 * 세 가지를 지킨다:
 *  - 먼저 친 그대로 찾는다. 번역은 한 번에 6~7초라(2026-09-11 게이트웨이 실측) 글자마다 부를 수 없다.
 *  - 한 번 옮긴 말은 다시 옮기지 않는다(text_translations, target_lang='en'). 지시문 판이 바뀌면 다시 옮긴다.
 *  - 실패하면 번역 없이 찾은 결과를 그대로 준다. 검색이 오류 화면이 되지는 않는다.
 */

/** 이만큼도 안 나오면 옮겨 본다. 홈 한 페이지가 9줄(HOME_FIRST_PAGE)이라 두 페이지가 채 안 되는 수 */
const ENOUGH_HITS = 20;

/**
 * 게이트웨이에 줄 시간. 낱말 서넛짜리 답이라 고정비(약 6초)가 거의 전부다.
 * 검색 한 번이 이보다 오래 걸리면 기다리는 것보다 번역 없는 결과가 낫다.
 */
const TIMEOUT_MS = 8_000;

export type ResolvedSearch = {
  /** 색인에 물어볼 말 — 원문 하나, 번역이 붙었으면 그 표현(한둘)까지 */
  queries: SearchQuery;
  /** 화면에 "이 말로도 찾았다"고 밝힐 영어 낱말 — 표현이 둘이면 " / "로 잇는다. 옮기지 않았으면 null */
  translated: string | null;
};

/** 같은 뜻인데 공백·대소문자만 다른 말을 따로 옮기지 않는다 */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko");
}

/** 번역 캐시의 열쇠 — 지시문 판이 들어 있어, 판을 올리면 옛 지시문으로 옮긴 말을 다시 쓰지 않는다 */
export function queryTranslationKey(query: string): string {
  return textHash(`q${QUERY_PROMPT_VERSION}:${normalizeQuery(query)}`);
}

const hasHangul = (text: string) => /[가-힣]/.test(text);

/** 공개 목록에서 이 말이 몇 건이나 맞나 — 카테고리·제작 도구 같은 필터는 보지 않는다.
 *  필터 때문에 0건인 것은 말이 안 통한 것이 아니라 필터가 좁힌 것이다. */
async function publicHits(query: SearchQuery): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(and(sql`${products.status} in ('seeded', 'verified')`, productSearchPredicate(query)!));
  return Number(row?.count ?? 0);
}

async function cachedTranslation(hash: string): Promise<string | null> {
  const [row] = await db
    .select({ translated: textTranslations.translated })
    .from(textTranslations)
    .where(and(
      eq(textTranslations.sourceHash, hash),
      eq(textTranslations.targetLang, "en"),
      eq(textTranslations.status, "done"),
    ));
  return row?.translated ?? null;
}

/** 모든 낱말로 이만큼도 안 나오면 넓힌다(하나만 빠진 것까지) */
const FEW_HITS = 5;

/** 질의문의 어간 — 색인과 같은 영어 분석기로 뽑는다. 불용어·구두점은 여기서 빠진다 */
async function lexemesOf(text: string): Promise<string[]> {
  const rows = await db.execute<{ lexeme: string }>(sql`select lexeme from unnest(to_tsvector('english', ${text}))`);
  return [...rows].map((row) => row.lexeme);
}

/**
 * 검색을 짠다 — 질의문마다 찾을 낱말을 뽑고, 모든 낱말로 몇 건 안 나오면 넓힌다.
 *
 * 넓히는 것은 좁을 때만이다. "merge pdf" 처럼 넉넉히 맞는 검색까지 넓히면 "merge"만 맞는 것이 섞여
 * 흐려진다. 낱말이 하나뿐이면 넓힐 것이 없다.
 */
export async function planSearch(texts: readonly string[]): Promise<SearchPlan> {
  const terms = await Promise.all(texts.map(async (text) => planTerms(await lexemesOf(text))));
  const strict: SearchPlan = { kind: "plan", texts, terms, mode: "all" };
  if (!terms.some((list) => list.length >= RELAX_MIN_TERMS)) return strict;
  return await publicHits(strict) >= FEW_HITS ? strict : { ...strict, mode: "most" };
}

/** 한국어로 쳤는데 몇 건 안 나오면 영어 낱말로 옮긴다. 옮기지 못하면 null — 친 그대로 찾는다 */
async function translateIfFew(raw: string): Promise<string | null> {
  try {
    const own = await planSearch([raw]);
    if (await publicHits({ ...own, mode: "all" }) >= ENOUGH_HITS) return null;

    const hash = queryTranslationKey(raw);
    const cached = await cachedTranslation(hash);
    if (cached) return cached;

    const result = await translateQueryToEnglish(raw, TIMEOUT_MS);
    await recordTranslations(
      [{ hash, translated: result.ok ? result.keywords : null, error: result.ok ? undefined : result.error }],
      TRANSLATE_MODEL,
      "en",
    );
    if (!result.ok) {
      logger.warn("search.translate_failed", { error: result.error });
      return null;
    }
    logger.info("search.translated", { keywords: result.keywords });
    return result.keywords;
  } catch (error) {
    // 번역은 덤이다 — 번역 쪽이 죽어도 검색은 사용자가 친 말로 그대로 돈다
    logger.warn("search.translate_unavailable", { error });
    return null;
  }
}

export async function resolveSearchQuery(query: string | undefined): Promise<ResolvedSearch> {
  const raw = query?.trim() ?? "";
  if (!raw) return { queries: [], translated: null };
  const stored = hasHangul(raw) ? await translateIfFew(raw) : null;
  const phrases = stored ? queryTranslationPhrases(stored) : [];
  const translated = phrases.length ? phrases.join(" / ") : null;
  const texts = [raw, ...phrases];
  try {
    // 번역 표현들은 같은 뜻이라 한 묶음이다 — 원문(0)과 번역(1)
    return { queries: { ...await planSearch(texts), groups: texts.map((_, index) => (index === 0 ? 0 : 1)) }, translated };
  } catch (error) {
    // 짜지 못해도 검색은 돈다 — 예전처럼 모든 낱말로 찾는다
    logger.warn("search.plan_failed", { error });
    return { queries: texts, translated };
  }
}
