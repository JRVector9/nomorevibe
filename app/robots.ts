import type { MetadataRoute } from "next";

/**
 * 크롤러에게 어디를 보지 말라고 알린다.
 *
 * /go는 클릭을 세고 제품으로 넘기는 문이다. 봇이 따라오면 지표가 크롤 빈도로 오염되고,
 * 우리가 남의 서버에 요청을 대신 쏘는 꼴이 된다. 세는 쪽에서도 봇을 거르지만
 * (lib/domain/products/clicks.ts) 애초에 오지 않게 하는 것이 먼저다.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/go/", "/admin", "/api/"],
    },
  };
}
