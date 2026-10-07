import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { textTranslations } from "@/lib/db/schema";
import { GLOSSARY_VERSION, glossaryHints, QUERY_PROMPT_VERSION, queryExpansions, queryTranslationPhrases, textHash, TRANSLATE_MODEL,
  translateQueryToEnglish } from "@/lib/crawl/translate";
import { recordTranslations } from "@/lib/crawl/translations";
import { logger } from "@/lib/observability/logger";
import { planTerms, RELAX_MIN_TERMS, type SearchPlan, type SearchQuery } from "./search";

/**
 * 한국어 검색어를 영어 낱말로 바꿔 한 번 더 찾는다.
 *
 * 목록은 영어다 — 소개의 62%가 ASCII 뿐이고 한글이 든 것은 3%뿐이다(2026-09-18 프로드).
 * 그래서 "PDF 합치는 도구"·"코드 리뷰 자동화"·"회의록 요약"·"사진 배경 제거"가 모두 0건이었다.
 * 모델에게 낱말을 받아 같은 색인으로 다시 찾으면 제자리를 찾는다.
 *
 * 세 가지를 지킨다:
 *  - 한국어면 늘 옮기되, 친 그대로도 함께 찾는다 — 번역으로 갈아 끼우지 않는다. 번역은 캐시가 없으면 한 번에
 *    1.5~8초라(게이트웨이 상태에 따라) 글자마다 부를 수 없다 — 검색을 누를 때만 부른다.
 *  - 한 번 옮긴 말은 다시 옮기지 않는다(text_translations, target_lang='en'). 지시문 판이 바뀌면 다시 옮긴다.
 *  - 실패하면 번역 없이 찾은 결과를 그대로 준다. 검색이 오류 화면이 되지는 않는다.
 */

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
  /** 기다리지 않아서 아직 옮기지 못했다 — 응답 뒤에 옮겨 캐시에 둔다(warmQueryTranslation) */
  translationPending?: boolean;
};

/** 같은 뜻인데 공백·대소문자만 다른 말을 따로 옮기지 않는다 */
export function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("ko");
}

/**
 * 번역 캐시의 열쇠 — 지시문 판이 들어 있어, 판을 올리면 옛 지시문으로 옮긴 말을 다시 쓰지 않는다.
 * 용어표 낱말이 든 질의만 용어표 판도 넣는다 — 용어표를 바꿔도 다른 질의의 번역은 그대로 쓴다.
 */
export function queryTranslationKey(query: string): string {
  const glossary = glossaryHints(normalizeQuery(query)) ? `g${GLOSSARY_VERSION}` : "";
  return textHash(`q${QUERY_PROMPT_VERSION}${glossary}:${normalizeQuery(query)}`);
}

const hasHangul = (text: string) => /[가-힣]/.test(text);

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

/** 질의문의 어간 — 색인과 같은 영어 분석기로 뽑는다. 불용어·구두점은 여기서 빠진다 */
async function lexemesOf(text: string): Promise<string[]> {
  const rows = await db.execute<{ lexeme: string }>(sql`select lexeme from unnest(to_tsvector('english', ${text}))`);
  return [...rows].map((row) => row.lexeme);
}

/**
 * 검색을 짠다 — 질의문마다 찾을 낱말을 뽑고, 낱말이 셋 이상이면 하나 빠진 것까지 들인다(넓힌 검색).
 *
 * 전에는 모든 낱말로 5건도 안 나올 때만 넓혔다. 그러면 결과가 넉넉한 질의에서 낱말 하나 없는 정답이 아예
 * 걸리지 않았다 — "japanese vocabulary trainer"는 36건이 다 맞아 넓히지 않았고, 정답(語彙庭)에는 "trainer"가
 * 없었다. "short form video trends"의 정답(숏폼 트렌드 가이드)에는 "video"가 없었다. 순위는 넓혀도 괜찮다 —
 * 다 맞은 것이 맞은 비율 가산(×10, 이름·소개·키워드에서만 센다)으로 하나 빠진 것보다 앞이다.
 * 늘 넓히자(2026-09-26 다중 정답 평가) nDCG@10 0.773→0.846, 1위가 딱 맞는 질의 44→52, 따로 둔 보류 질의 20개에서도
 * 0.648→0.705. 대신 결과 수 중앙이 25→88, 검색 p50 124→163ms·p95 270→380ms.
 *
 * 낱말이 둘 이하면 넓히지 않는다 — "merge pdf"를 넓히면 "merge"만 맞는 것이 섞인다(하나만 맞아도 되면 OR 이다).
 */
export async function planSearch(texts: readonly string[]): Promise<SearchPlan> {
  const terms = await Promise.all(texts.map(async (text) => planTerms(await lexemesOf(text))));
  return { kind: "plan", texts, terms, mode: terms.some((list) => list.length >= RELAX_MIN_TERMS) ? "most" : "all" };
}

/**
 * 한국어로 치면 영어 낱말로 옮긴다. 옮기지 못하면 null — 친 그대로 찾는다.
 *
 * 전에는 원문으로 20건 넘게 나오면 옮기지 않았다. 목록이 거의 영어라 한국어가 20건씩 맞는 일이 드물었는데,
 * 한·영 검색 키워드가 채워지자(2026-09-25) 한국어 키워드만으로 20건을 넘기는 질의가 생겼다 — 그러면 소개·본문이
 * 영어인 정답을 영어 낱말로 찾지 못한다. "코딩 에이전트 비용 추적"이 원문 26건으로 번역을 건너뛰어 13위였고,
 * 번역을 붙이자 3위였다. 한국어 정답 질의 26개 중 나머지는 순위가 같았다. 옮긴 말은 캐시에 남아 처음 한 번만
 * 게이트웨이를 부른다(지금 1.4~1.7초).
 */
async function translateKorean(raw: string): Promise<string | null> {
  try {
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

/**
 * 응답을 보낸 뒤 옮겨 둔다 — 같은 말을 다시 찾으면 캐시에서 바로 붙는다.
 * 관련도순 검색은 번역을 기다리지 않는다(2026-10-07): 의미 검색·재정렬이 한국어 문장을 영어 소개와 바로 재서,
 * 번역 없이도 nDCG 0.824(번역을 붙이면 0.832)다. 처음 들어온 한국어 문장의 게이트웨이 대기(약 3초)를 없앤다.
 */
export async function warmQueryTranslation(query: string): Promise<void> {
  const raw = query.trim();
  if (raw && hasHangul(raw)) await translateKorean(raw);
}

/** 캐시에만 묻는다 — 없으면 null. 캐시가 죽어도 검색은 돈다 */
async function storedTranslation(raw: string): Promise<string | null> {
  try {
    return await cachedTranslation(queryTranslationKey(raw));
  } catch (error) {
    logger.warn("search.translate_unavailable", { error });
    return null;
  }
}

export async function resolveSearchQuery(query: string | undefined, options: { waitForTranslation?: boolean } = {}): Promise<ResolvedSearch> {
  const raw = query?.trim() ?? "";
  if (!raw) return { queries: [], translated: null };
  const wait = options.waitForTranslation ?? true;
  const stored = !hasHangul(raw) ? null : wait ? await translateKorean(raw) : await storedTranslation(raw);
  const translationPending = !wait && hasHangul(raw) && stored === null;
  // 영어로 옮기면 엉뚱한 것이 걸리는 한국식 영어는 정해 둔 영어 말로도 찾는다(translate.ts QUERY_EXPANSIONS)
  const phrases = [...new Set([...(stored ? queryTranslationPhrases(stored) : []), ...queryExpansions(raw)])];
  const translated = phrases.length ? phrases.join(" / ") : null;
  const texts = [raw, ...phrases];
  const pending = translationPending ? { translationPending } : {};
  try {
    // 번역 표현들은 같은 뜻이라 한 묶음이다 — 원문(0)과 번역(1)
    return { queries: { ...await planSearch(texts), groups: texts.map((_, index) => (index === 0 ? 0 : 1)) }, translated, ...pending };
  } catch (error) {
    // 짜지 못해도 검색은 돈다 — 예전처럼 모든 낱말로 찾는다
    logger.warn("search.plan_failed", { error });
    return { queries: texts, translated, ...pending };
  }
}
