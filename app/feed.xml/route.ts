import { NextResponse } from "next/server";
import { XMLBuilder } from "fast-xml-parser";
import { listRecentlyDiscovered } from "@/lib/domain/products/repository";
import { toListItem } from "@/lib/domain/products/view";
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

/**
 * XML 1.0이 글자로 인정하지 않는 코드포인트.
 *
 * 수집한 페이지의 og:description에 `&#8;` 같은 참조가 있으면 lib/net/normalize.ts가 그것을
 * U+0008로 되돌린다(코드포인트 범위만 보고 통과시킨다). XMLBuilder는 `& < > ' "`만
 * 이스케이프하므로 그 글자가 그대로 나가고, 엄격한 리더는 항목 하나가 아니라 문서 전체를
 * 거부한다 — 제품 하나 때문에 피드가 통째로 사라진다.
 */
const XML_UNSAFE = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** 사람이 쓴 값을 피드에 싣기 전에 거른다 — slug·카테고리는 이미 정해진 글자만 갖는다 */
function xmlText(value: string): string {
  return value.replace(XML_UNSAFE, "");
}

export const GET = withRoute("feed", async (req: Request) => {
  const origin = siteOrigin(req);
  // 발견 보드와 같은 목록이지만 지표는 쓰지 않는다. getDiscoveryList를 쓰면 피드가
  // 읽지도 않을 클릭·생존 조회 두 개를 매번 더 태운다.
  const items = (await listRecentlyDiscovered(FEED_LIMIT)).map(toListItem);

  // suppressBooleanAttributes 기본값(true)은 값이 "true"인 속성을 이름만 남긴다 —
  // `<guid isPermaLink>`는 XML이 아니어서 엄격한 리더가 문서 전체를 버린다.
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressEmptyNode: true,
    suppressBooleanAttributes: false,
  });
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
          title: xmlText(`${product.name} — ${product.status === "verified" ? "✓ 검증됨" : "미클레임"}`),
          link: `${origin}/p/${product.slug}`,
          guid: { "@_isPermaLink": "true", "#text": `${origin}/p/${product.slug}` },
          description: xmlText(product.tagline),
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
