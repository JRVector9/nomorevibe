import { listPublicNews, type PublicNewsItem } from "./repository";
import { parseNewsFilter } from "./view";

/**
 * 외부에 내보내는 AI 소식.
 *
 * 공개(approved) 글만, 최신 50건. 소식 페이지와 같은 거르기(?kind=news|release, ?company=openai)를
 * 받는다 — 페이지에서 고른 조건을 주소째 옮겨 구독할 수 있다.
 */
export const NEWS_FEED_LIMIT = 50;

/** 브라우저에서 바로 받아 가는 도구도 있다. 공개 글이라 출처를 막을 이유가 없다 */
export const NEWS_FEED_HEADERS = {
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*",
} as const;

export async function newsForFeed(req: Request): Promise<{ items: PublicNewsItem[]; query: string }> {
  const url = new URL(req.url);
  const company = url.searchParams.get("company");
  const filter = parseNewsFilter({ company, kind: url.searchParams.get("kind") });
  const { items } = await listPublicNews(filter, NEWS_FEED_LIMIT);
  const query = new URLSearchParams();
  if (filter.section) query.set("kind", filter.section);
  if (filter.vendor && company) query.set("company", company);
  return { items, query: query.size ? `?${query}` : "" };
}
