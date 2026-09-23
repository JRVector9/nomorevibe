import { or, sql, type SQL } from "drizzle-orm";
import { products } from "@/lib/db/schema";

/**
 * 제품 검색.
 *
 * 전에는 검색어를 공백으로 쪼개 낱말마다 ILIKE '%낱말%' 을 만들고 전부 AND 로 묶었다.
 * 색인이 없어 매번 10,751행을 훑었고, 무엇보다 목적으로 찾으면 아무것도 나오지 않았다
 * (2026-09-18 프로드 실측): "PDF 합치는 도구" 0건, "코드 리뷰 자동화" 0건, "회의록 요약" 0건,
 * "사진 배경 제거" 0건, "summarize meetings" 0건, "remove image background" 0건.
 *
 * AND 를 OR 로 바꾸는 것은 답이 아니었다 — "app to learn a language" 가 10,751건 중 10,288건을
 * 물어 온다. 'a' 와 'to' 가 거의 모든 행에 있고 순서를 매길 방법이 없기 때문이다.
 *
 * 그래서 색인(products.search_vector, schema.ts 에 무게와 함께 적어 뒀다)과 tsquery 로 옮겼다.
 *
 * 2026-09-23 실제 카탈로그 17,975건에서 정답을 아는 질의 60개로 다시 쟀더니(scripts/search-judged.ts)
 * 정답이 5위 안에 든 것이 42%, 0건이 20%였다. 놓친 이유는 셋이었다 —
 *  - 모든 낱말이 필수라, 소개에 없는 말 하나("offline", "tool")가 결과를 없앤다
 *  - 영어 어간이 갈린다: summary→summari / summarize→summar, tracker / track. 접두 대조는 질의 어간이
 *    문서 어간의 앞부분일 때만 맞아 "meeting summary"로 "Summarize your meetings"를 못 찾는다
 *  - 흔한 말(app·tool·도구·앱)이 필수 낱말이 된다
 * 이 파일이 그 셋을 다룬다. 화면은 resolveSearchQuery(search-translation.ts)가 짠 계획(SearchPlan)을 넘긴다.
 */

/** 검색어 상한. 여기를 넘는 글은 검색어가 아니라 붙여넣기다 */
const MAX_QUERY_CHARS = 200;

/**
 * 본문을 여기까지만 적어 둔다 — 색인도 딱 이만큼만 본다(schema.ts 의 left(…, 2000)).
 *
 * 원본(page_meta->>'textSample')은 6,000자까지다. 그대로 두면 products 한 행이 그만큼 넓어지고,
 * 목록 조회가 select * 라 화면에 쓰지도 않을 글자를 매번 실어 나른다. 색인이 보지 않는 뒤 4,000자는
 * 검색에 아무 값도 더하지 않으므로 저장하지 않는다 — 10,751행 기준 약 64MB 대신 약 21MB.
 * README 도 같은 길이로 적는다.
 */
export const SEARCH_PAGE_TEXT_CHARS = 2_000;

/** 낱말 하나 — 색인이 맞출 앞부분(loose)과, 어간 그대로(exact) */
export type SearchTerm = { loose: string; exact: string };

/**
 * 짜 둔 검색 — 질의문(원문, 번역이 붙었으면 둘)마다 낱말 목록과, 몇 개가 맞아야 하는지.
 *
 * all: 낱말이 전부 있어야 한다(기본). most: 절반 이상 — 전부로는 몇 건 안 나올 때만 넓힌다.
 */
export type SearchPlan = { kind: "plan"; texts: readonly string[]; terms: readonly (readonly SearchTerm[])[]; mode: "all" | "most" };

/**
 * 찾을 말 — 사용자가 친 것 하나, 한국어 번역이 붙었으면 둘. 짜 둔 계획이면 그것.
 *
 * 둘일 때는 OR 다. 번역한 말로 갈아 끼우지 않고 더한다 — 원문으로 이미 맞은 몇 건
 * (소개에 한글이 있는 행이 3%)을 번역 결과가 밀어내면 그만큼 잃는 것이다.
 */
export type SearchQuery = string | readonly string[] | SearchPlan;

const isPlan = (query: SearchQuery): query is SearchPlan => typeof query === "object" && "kind" in query;

/** 빈 것을 걸러낸 질의문. 하나도 없으면 검색하지 않는다 */
export function searchQueries(query: SearchQuery | undefined): string[] {
  if (query && isPlan(query)) return [...query.texts];
  const list = typeof query === "string" ? [query] : query ?? [];
  return list.map((text) => text.trim().slice(0, MAX_QUERY_CHARS)).filter(Boolean);
}

export function hasSearchQuery(query: SearchQuery | undefined): boolean {
  return searchQueries(query).length > 0;
}

/**
 * 흔한 말 — 필수 낱말에서 뺀다(순위에는 남는다).
 *
 * "pdf merge tool" 은 소개에 "tool"이 없는 PDF 합치기 제품을 놓쳤다. 목록에 오른 것은 다 앱이고
 * 도구라, 이 말들은 무엇을 찾는지 좁히지 못한다. 영어는 어간으로 적는다(application → applic).
 * 흔한 말만 쳤으면(예: "app") 뺄 것이 없으므로 그대로 찾는다.
 */
export const GENERIC_TERMS = new Set([
  "app", "applic", "tool", "servic", "websit", "site", "platform", "softwar", "program", "onlin", "web",
  "free", "best", "simpl", "easi",
  "앱", "어플", "어플리케이션", "애플리케이션", "도구", "툴", "서비스", "사이트", "웹사이트", "프로그램", "웹",
]);

/**
 * 어간을 느슨하게 — 앞부분만 대조해 같은 뜻의 다른 꼴을 잇는다.
 *
 * 영어 어간은 꼴마다 갈린다: summary→summari / summarize→summar, tracker / track, analysis→analysi /
 * analyze→analyz. 긴 어간은 끝을 떼어 앞부분으로 맞춘다(7자 이상 두 자, 6자는 한 자). 짧은 어간은 이미
 * 앞부분 대조로 충분하고, 더 떼면 "expe"처럼 아무 말에나 맞는다.
 *
 * 한국어는 영어 분석기가 조사를 떼지 못해 "견적서를"이 한 토큰이다. 질의가 문서보다 길면("계산기" 대
 * "계산하세요") 앞부분 대조도 빗나가므로, 세 글자 이상은 마지막 글자를 뗀다.
 *
 * 떼어 넓힌 만큼 잡음이 섞이므로, 어간이 그대로 맞는 제품에 점수를 더 준다(productSearchRank).
 */
export function looseTerm(lexeme: string): string {
  if (/[가-힣]/.test(lexeme)) return [...lexeme].length >= 3 ? [...lexeme].slice(0, -1).join("") : lexeme;
  if (lexeme.length >= 7) return lexeme.slice(0, -2);
  if (lexeme.length === 6) return lexeme.slice(0, -1);
  return lexeme;
}

/** 분석기가 뽑은 어간 → 찾을 낱말. 흔한 말은 빼되, 다 흔한 말이면 그대로 둔다 */
export function planTerms(lexemes: readonly string[]): SearchTerm[] {
  const all = [...new Set(lexemes)].map((exact) => ({ exact, loose: looseTerm(exact) }));
  const content = all.filter((term) => !GENERIC_TERMS.has(term.exact) && !GENERIC_TERMS.has(term.loose));
  return content.length ? content : all;
}

/** tsquery 에 넣을 낱말 하나 — 따옴표는 겹치고 역슬래시는 버린다(둘 다 tsquery 문법 글자) */
const quote = (term: string, prefix = true) => `'${term.replace(/\\/g, "").replace(/'/g, "''")}'${prefix ? ":*" : ""}`;
const tsq = (terms: readonly string[], join: " & " | " | ") => sql`to_tsquery('simple', ${terms.map((t) => quote(t)).join(join)})`;

/**
 * 짜 두지 않은 검색어(스크립트·다른 목록) — 예전 그대로 SQL 에서 어간을 뽑아 전부 AND 로 찾는다.
 *
 * to_tsquery 는 검색어를 문법으로 읽으므로 사용자가 친 글자를 그대로 넘기면 안 된다.
 * to_tsvector 로 한 번 토큰을 뽑고(여기서 불용어·구두점이 걸러진다) 그 결과만 따옴표로 감싼다.
 */
const QUOTED_PREFIX = sql.raw(`'''' || replace(replace(lexeme, '\\', ''), '''', '''''') || ''':*'`);
const rawTsquery = (text: string) =>
  sql`to_tsquery('english', (select string_agg(${QUOTED_PREFIX}, ' & ') from unnest(to_tsvector('english', ${text}))))`;

/** 절반 이상 맞아야 하는 수 */
const needed = (terms: readonly SearchTerm[]) => Math.ceil(terms.length / 2);

/** 이 행에 맞는 낱말 수 — 낱말 몇 개짜리라 행마다 몇 번의 @@ 뿐이다 */
const coverage = (terms: readonly SearchTerm[]) =>
  sql`(${sql.join(terms.map((term) => sql`(${products.searchVector} @@ ${tsq([term.loose], " & ")})::int`), sql` + `)})`;

/**
 * 어느 질의문이든 맞으면 결과다. 불용어뿐인 검색어는 낱말이 없어 아무것도 맞지 않는다.
 *
 * 넓힌 검색(most)은 GIN 이 낱말 중 하나라도 있는 행을 먼저 추리고, 그중 절반 이상 맞는 것만 남긴다.
 *
 * 제작 도구(builder)를 신고된 제품에서만 찾는 규칙은 여기 없다 — 그 조건이 행의 컬럼
 * (source·claimed_at)이라 search_vector 안에 들어가 있다. 조건을 이 쪽 OR 로 빼면
 * GIN 인덱스를 쓰지 못하고 표 전체를 훑는다.
 */
export function productSearchPredicate(query: SearchQuery): SQL | undefined {
  if (!isPlan(query)) {
    const queries = searchQueries(query);
    if (!queries.length) return undefined;
    return or(...queries.map((text) => sql`${products.searchVector} @@ ${rawTsquery(text)}`));
  }
  const parts = query.terms.filter((terms) => terms.length > 0).map((terms) => query.mode === "all"
    ? sql`${products.searchVector} @@ ${tsq(terms.map((t) => t.loose), " & ")}`
    : sql`(${products.searchVector} @@ ${tsq(terms.map((t) => t.loose), " | ")} and ${coverage(terms)} >= ${needed(terms)})`);
  return parts.length ? or(...parts) : sql`false`;
}

/**
 * 관련도. 질의문이 둘이면 더한다 — 원문과 번역 양쪽에 맞는 제품이 가장 앞이다.
 *
 * - ts_rank_cd: 낱말이 붙어 있을수록 높다("code review"가 붙어 있는 소개가 떨어져 있는 것보다 앞).
 *   무게는 {D,C,B,A} = {0.1, 0.2, 0.4, 1.0} — 이름·토픽(A)이 본문(D)의 열 배라 본문에 한 번 스친 것이
 *   이름에 든 것을 이기지 못한다. 정규화 1(길이의 로그로 나눔)로 긴 본문이 양으로 이기지 못하게 한다.
 * - 어간이 그대로 맞으면 더한다 — 느슨하게 넓힌 잡음이 정확히 맞은 것을 앞지르지 못하게.
 * - 넓힌 검색에서는 맞은 낱말의 비율을 더한다 — 넷 중 넷이 맞은 것이 넷 중 둘보다 앞.
 * - 이름이 검색어와 같으면 크게, 검색어로 시작하면 조금 더한다 — 이름으로 찾는 사람도 있다.
 */
export function productSearchRank(query: SearchQuery): SQL<number> {
  if (!isPlan(query)) {
    const queries = searchQueries(query);
    if (!queries.length) return sql<number>`0::float4`;
    return sql<number>`(${sql.join(
      queries.map((text) => sql`coalesce(ts_rank(${products.searchVector}, ${rawTsquery(text)}), 0)`),
      sql` + `,
    )})`;
  }
  const parts = query.texts.flatMap((text, index) => {
    const terms = query.terms[index] ?? [];
    if (!terms.length) return [];
    const exact = tsq(terms.map((t) => t.exact), " & ");
    const name = text.trim().toLowerCase();
    return [sql`(
      coalesce(ts_rank_cd(${products.searchVector}, ${tsq(terms.map((t) => t.loose), " | ")}, 1), 0)
      + case when ${products.searchVector} @@ ${exact} then coalesce(ts_rank(${products.searchVector}, ${exact}), 0) else 0 end
      + ${query.mode === "most" ? sql`${coverage(terms)}::float4 / ${terms.length}` : sql`0`}
      + case when lower(${products.name}) = ${name} then 2 when lower(${products.name}) like ${`${name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`} then 0.5 else 0 end
    )`];
  });
  return parts.length ? sql<number>`(${sql.join(parts, sql` + `)})` : sql<number>`0::float4`;
}
