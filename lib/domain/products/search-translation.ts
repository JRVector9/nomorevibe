import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, textTranslations } from "@/lib/db/schema";
import { textHash, TRANSLATE_MODEL, translateQueryToEnglish } from "@/lib/crawl/translate";
import { recordTranslations } from "@/lib/crawl/translations";
import { logger } from "@/lib/observability/logger";
import { productSearchPredicate, type SearchQuery } from "./search";

/**
 * 한국어 검색어를 영어 낱말로 바꿔 한 번 더 찾는다.
 *
 * 목록은 영어다 — 소개의 62%가 ASCII 뿐이고 한글이 든 것은 3%뿐이다(2026-09-18 프로드).
 * 그래서 "PDF 합치는 도구"·"코드 리뷰 자동화"·"회의록 요약"·"사진 배경 제거"가 모두 0건이었다.
 * 모델에게 낱말을 받아 같은 색인으로 다시 찾으면 제자리를 찾는다.
 *
 * 세 가지를 지킨다:
 *  - 먼저 친 그대로 찾는다. 번역은 한 번에 6~7초라(2026-09-11 게이트웨이 실측) 글자마다 부를 수 없다.
 *  - 한 번 옮긴 말은 다시 옮기지 않는다(text_translations, target_lang='en').
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
  /** 색인에 물어볼 말 — 원문 하나, 번역이 붙었으면 둘 */
  queries: SearchQuery;
  /** 화면에 "이 말로도 찾았다"고 밝힐 영어 낱말. 옮기지 않았으면 null */
  translated: string | null;
};

/** 같은 뜻인데 공백·대소문자만 다른 말을 따로 옮기지 않는다 */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko");
}

const hasHangul = (text: string) => /[가-힣]/.test(text);

/** 공개 목록에서 이 말이 몇 건이나 맞나 — 카테고리·제작 도구 같은 필터는 보지 않는다.
 *  필터 때문에 0건인 것은 말이 안 통한 것이 아니라 필터가 좁힌 것이다. */
async function publicHits(query: string): Promise<number> {
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

export async function resolveSearchQuery(query: string | undefined): Promise<ResolvedSearch> {
  const raw = query?.trim() ?? "";
  if (!raw || !hasHangul(raw)) return { queries: raw ? [raw] : [], translated: null };

  try {
    if (await publicHits(raw) >= ENOUGH_HITS) return { queries: [raw], translated: null };

    const hash = textHash(normalizeQuery(raw));
    const cached = await cachedTranslation(hash);
    if (cached) return { queries: [raw, cached], translated: cached };

    const result = await translateQueryToEnglish(raw, TIMEOUT_MS);
    await recordTranslations(
      [{ hash, translated: result.ok ? result.keywords : null, error: result.ok ? undefined : result.error }],
      TRANSLATE_MODEL,
      "en",
    );
    if (!result.ok) {
      logger.warn("search.translate_failed", { error: result.error });
      return { queries: [raw], translated: null };
    }
    logger.info("search.translated", { keywords: result.keywords });
    return { queries: [raw, result.keywords], translated: result.keywords };
  } catch (error) {
    // 번역은 덤이다 — 번역 쪽이 죽어도 검색은 사용자가 친 말로 그대로 돈다
    logger.warn("search.translate_unavailable", { error });
    return { queries: [raw], translated: null };
  }
}
