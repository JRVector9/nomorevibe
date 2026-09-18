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
 * 불용어가 빠지고('app to learn a language' → 'app' & 'learn' & 'languag'), 남은 낱말은
 * 여전히 AND 이며, ts_rank 로 순서가 생긴다.
 */

/** 검색어 상한. 여기를 넘는 글은 검색어가 아니라 붙여넣기다 */
const MAX_QUERY_CHARS = 200;

/**
 * 본문을 여기까지만 적어 둔다 — 색인도 딱 이만큼만 본다(schema.ts 의 left(…, 2000)).
 *
 * 원본(page_meta->>'textSample')은 6,000자까지다. 그대로 두면 products 한 행이 그만큼 넓어지고,
 * 목록 조회가 select * 라 화면에 쓰지도 않을 글자를 매번 실어 나른다. 색인이 보지 않는 뒤 4,000자는
 * 검색에 아무 값도 더하지 않으므로 저장하지 않는다 — 10,751행 기준 약 64MB 대신 약 21MB.
 */
export const SEARCH_PAGE_TEXT_CHARS = 2_000;

/**
 * 찾을 말 — 사용자가 친 것 하나, 한국어 번역이 붙었으면 둘.
 *
 * 둘일 때는 OR 다. 번역한 말로 갈아 끼우지 않고 더한다 — 원문으로 이미 맞은 몇 건
 * (소개에 한글이 있는 행이 3%)을 번역 결과가 밀어내면 그만큼 잃는 것이다.
 */
export type SearchQuery = string | readonly string[];

/** 빈 것을 걸러낸 질의문. 하나도 없으면 검색하지 않는다 */
export function searchQueries(query: SearchQuery | undefined): string[] {
  const list = typeof query === "string" ? [query] : query ?? [];
  return list.map((text) => text.trim().slice(0, MAX_QUERY_CHARS)).filter(Boolean);
}

export function hasSearchQuery(query: SearchQuery | undefined): boolean {
  return searchQueries(query).length > 0;
}

/**
 * 검색어 → tsquery. 낱말마다 뒤를 열어 둔다(접두 검색).
 *
 * websearch_to_tsquery 를 그대로 쓰면 낱말이 통째로 같아야 맞는다. 한국어에서 그것은 거의
 * 맞지 않는다 — 조사가 붙어 한 낱말이 되기 때문이다. "에이전트를 위한 도구"의 토큰은
 * '에이전트를'이라 "에이전트"로 찾으면 0건이다(영어 분석기에는 한국어 형태소 분석이 없다).
 * 앞부분만 대조하면 조사가 붙어도 맞는다. 옛 ILIKE '%낱말%' 가 해 주던 일이기도 하다 —
 * "ledg"로 "Ledger"를 찾던 동작이 그래서 남는다.
 *
 * 값은 넓어진다. 공개 1,808건으로 잰 것(2026-09-18): 여러 낱말짜리 목적 검색은 그대로거나
 * 조금 늘고(track expenses 3→5, summarize meetings 0→1), 짧고 흔한 한 낱말이 많이 는다
 * (chat 41→76, app 265→352, ai 750→777). 늘어난 쪽은 ts_rank 가 뒤로 민다.
 *
 * to_tsquery 는 검색어를 문법으로 읽으므로 사용자가 친 글자를 그대로 넘기면 안 된다.
 * to_tsvector 로 한 번 토큰을 뽑고(여기서 불용어·구두점이 걸러진다) 그 결과만 따옴표로 감싼다.
 * 따옴표는 겹치고 역슬래시는 버린다 — tsquery 안에서 둘 다 문법 글자다.
 * 상관 서브쿼리가 아니므로 행마다가 아니라 쿼리마다 한 번 계산된다.
 */
const QUOTED_PREFIX = sql.raw(`'''' || replace(replace(lexeme, '\\', ''), '''', '''''') || ''':*'`);
const tsquery = (text: string) =>
  sql`to_tsquery('english', (select string_agg(${QUOTED_PREFIX}, ' & ') from unnest(to_tsvector('english', ${text}))))`;

/**
 * 어느 질의문이든 맞으면 결과다. 불용어뿐인 검색어는 tsquery 가 null 이라 아무것도 맞지 않는다.
 *
 * 제작 도구(builder)를 신고된 제품에서만 찾는 규칙은 여기 없다 — 그 조건이 행의 컬럼
 * (source·claimed_at)이라 search_vector 안에 들어가 있다. 조건을 이 쪽 OR 로 빼면
 * GIN 인덱스를 쓰지 못하고 표 전체를 훑는다.
 */
export function productSearchPredicate(query: SearchQuery): SQL | undefined {
  const queries = searchQueries(query);
  if (!queries.length) return undefined;
  return or(...queries.map((text) => sql`${products.searchVector} @@ ${tsquery(text)}`));
}

/**
 * 관련도. 질의문이 둘이면 더한다 — 원문과 번역 양쪽에 맞는 제품이 가장 앞이다.
 *
 * ts_rank 의 기본 무게는 {D,C,B,A} = {0.1, 0.2, 0.4, 1.0} 이다. 이름·토픽(A)이 본문(D)의
 * 열 배라, 본문에 한 번 스친 것이 이름에 든 것을 이기지 못한다.
 */
export function productSearchRank(query: SearchQuery): SQL<number> {
  const queries = searchQueries(query);
  if (!queries.length) return sql<number>`0::float4`;
  return sql<number>`(${sql.join(
    queries.map((text) => sql`coalesce(ts_rank(${products.searchVector}, ${tsquery(text)}), 0)`),
    sql` + `,
  )})`;
}
