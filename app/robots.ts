import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";

/**
 * 크롤러에게 어디를 보지 말라고 알린다.
 *
 * /go는 클릭을 세고 제품으로 넘기는 문이다. 봇이 따라오면 지표가 크롤 빈도로 오염되고,
 * 우리가 남의 서버에 요청을 대신 쏘는 꼴이 된다. 세는 쪽에서도 봇을 거르지만
 * (lib/domain/products/clicks.ts) 애초에 오지 않게 하는 것이 먼저다.
 *
 * sitemap 주소가 실제 origin이어야 하므로 빌드 시점에 굳히지 않는다. sitemap.ts와 같은 이유다.
 * 기본값대로 정적 생성하면 NEXT_PUBLIC_SITE_URL이 없는 Dockerfile 빌더 단계의 값이 그대로
 * 이미지에 박혀 `Sitemap: http://localhost:3000/sitemap.xml`을 영영 내보낸다 — 그 변수는
 * compose가 런타임에만 준다.
 */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/go/", "/admin", "/api/"],
    },
    sitemap: `${siteOrigin()}/sitemap.xml`,
  };
}
