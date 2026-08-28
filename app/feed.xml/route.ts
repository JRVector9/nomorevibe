import { NextResponse } from "next/server";
import { XMLBuilder } from "fast-xml-parser";
import { getDiscoveryList } from "@/lib/domain/products/view";
import { withRoute } from "@/lib/http/handler";
import { siteOrigin } from "@/lib/site";

/**
 * 새로 등재된 제품 피드.
 *
 * 계정 없이 "새 제품이 올라오면 알려달라"에 답하는 가장 싼 길이다. 이 서비스를 볼 사람은
 * 개발자이고, 그들은 아직 RSS를 읽는다.
 *
 * 홈의 발견 보드와 같은 것을 내보낸다 — 검증된 제품과 우리가 대신 올린 제품을 등재 시각순으로.
 * 어느 쪽인지는 제목에 밝힌다. 피드 리더에는 배지가 없으므로 글자로 적는 수밖에 없다.
 */
const FEED_LIMIT = 50;

export const GET = withRoute("feed", async (req: Request) => {
  const origin = siteOrigin(req);
  const items = await getDiscoveryList(FEED_LIMIT);

  const builder = new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true });
  const xml = builder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    rss: {
      "@_version": "2.0",
      "@_xmlns:atom": "http://www.w3.org/2005/Atom",
      channel: {
        title: "NoMoreVibe — 새로 등재된 제품",
        link: `${origin}/`,
        description: "AI로 만들어 배포된 제품. 도메인 소유권을 우리가 직접 확인한 것에만 ✓ 검증됨이 붙습니다.",
        language: "ko",
        "atom:link": { "@_href": `${origin}/feed.xml`, "@_rel": "self", "@_type": "application/rss+xml" },
        lastBuildDate: (items[0]?.listedAt ?? new Date()).toUTCString(),
        item: items.map((product) => ({
          title: `${product.name} — ${product.status === "verified" ? "✓ 검증됨" : "미클레임"}`,
          link: `${origin}/p/${product.slug}`,
          guid: { "@_isPermaLink": "true", "#text": `${origin}/p/${product.slug}` },
          description: product.tagline,
          category: product.category,
          pubDate: product.listedAt.toUTCString(),
        })),
      },
    },
  });

  return new NextResponse(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
});
