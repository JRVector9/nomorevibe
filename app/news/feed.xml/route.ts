import { NextResponse } from "next/server";
import { XMLBuilder } from "fast-xml-parser";
import { withRoute } from "@/lib/http/handler";
import { NEWS_FEED_HEADERS, newsForFeed } from "@/lib/news/feed";
import { siteOrigin } from "@/lib/site";

/** app/feed.xml 과 같은 이유로 XML 1.0 이 글자로 인정하지 않는 코드포인트를 뺀다 */
const XML_UNSAFE = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
const xmlText = (value: string) => value.replace(XML_UNSAFE, "");

/** AI 소식 RSS 2.0. 원문 출처는 <source> 로 밝힌다 */
export const GET = withRoute("news.feed_xml", async (req: Request) => {
  const origin = siteOrigin(req);
  const { items, query } = await newsForFeed(req);
  const builder = new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true, suppressBooleanAttributes: false });
  const xml = builder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    rss: {
      "@_version": "2.0",
      "@_xmlns:atom": "http://www.w3.org/2005/Atom",
      channel: {
        title: "NoMoreVibe — AI 소식",
        link: `${origin}/news${query}`,
        description: "AI 회사가 직접 낸 발표와 코딩 도구 릴리스. 공식 피드에서 모았고, 링크는 원문으로 갑니다.",
        language: "ko",
        "atom:link": { "@_href": `${origin}/news/feed.xml${query}`, "@_rel": "self", "@_type": "application/rss+xml" },
        lastBuildDate: (items[0]?.publishedAt ?? new Date()).toUTCString(),
        item: items.map((item) => ({
          title: xmlText(item.title),
          link: item.url,
          guid: { "@_isPermaLink": "true", "#text": item.url },
          ...(item.summary ? { description: xmlText(item.summary) } : {}),
          category: [item.vendor, item.label],
          source: { "@_url": `${origin}/news/feed.xml`, "#text": xmlText(item.source) },
          pubDate: item.publishedAt.toUTCString(),
        })),
      },
    },
  });
  return new NextResponse(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", ...NEWS_FEED_HEADERS } });
});
