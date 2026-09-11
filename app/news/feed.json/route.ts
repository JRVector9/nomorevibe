import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { NEWS_FEED_HEADERS, newsForFeed } from "@/lib/news/feed";
import { siteOrigin } from "@/lib/site";

/**
 * AI 소식 JSON Feed 1.1 (https://jsonfeed.org/version/1.1).
 * 표준 필드 밖의 값은 규격대로 _ 로 시작하는 키에 담는다.
 */
export const GET = withRoute("news.feed_json", async (req: Request) => {
  const origin = siteOrigin(req);
  const { items, query } = await newsForFeed(req);
  return NextResponse.json({
    version: "https://jsonfeed.org/version/1.1",
    title: "NoMoreVibe — AI 소식",
    home_page_url: `${origin}/news${query}`,
    feed_url: `${origin}/news/feed.json${query}`,
    description: "AI 회사가 직접 낸 발표와 코딩 도구 릴리스. 공식 피드에서 모았고, 링크는 원문으로 갑니다.",
    language: "ko",
    items: items.map((item) => ({
      id: item.url,
      url: item.url,
      title: item.title,
      content_text: item.summary ?? item.title,
      ...(item.summary ? { summary: item.summary } : {}),
      date_published: item.publishedAt.toISOString(),
      tags: [item.vendor, item.label],
      _nomorevibe: { source: item.source, vendor: item.vendor, kind: item.section },
    })),
  }, { headers: { "content-type": "application/feed+json; charset=utf-8", ...NEWS_FEED_HEADERS } });
});
