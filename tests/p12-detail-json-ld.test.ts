import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productJsonLd, serializeJsonLd, type ProductJsonLdInput } from "@/lib/seo/product-json-ld";

const ORIGIN = "https://nomorevibe.brut.bot";
const base: ProductJsonLdInput = {
  origin: ORIGIN, slug: "infisical", name: "Infisical", description: "올인원 신원 보안 플랫폼", inLanguage: "ko",
};

describe("상세 구조화 데이터(SEO-06, 2026-11-15 이름·요약만)", () => {
  it("우리 페이지(WebPage)와 그 주제(CreativeWork: 이름·요약)만 — 평점·가격은 만들지 않는다", () => {
    const [page] = productJsonLd(base);
    expect(page).toEqual({
      "@context": "https://schema.org", "@type": "WebPage", "@id": `${ORIGIN}/p/infisical`, url: `${ORIGIN}/p/infisical`,
      inLanguage: "ko", name: "Infisical", description: "올인원 신원 보안 플랫폼",
      isPartOf: { "@type": "WebSite", "@id": "https://nomorevibe.com/#website", name: "nomorevibe", url: "https://nomorevibe.com" },
      publisher: { "@type": "Organization", "@id": "https://nomorevibe.com/#organization", name: "nomorevibe", url: "https://nomorevibe.com" },
      mainEntity: { "@type": "CreativeWork", name: "Infisical", description: "올인원 신원 보안 플랫폼" },
    });
    expect(serializeJsonLd(productJsonLd(base))).not.toMatch(/aggregateRating|offers|price|ratingValue|review/i);
  });

  it("분야·저장소·제품 사이트·언어·그림 칸이 없다", () => {
    // 예전 입력 칸을 넘겨도(호출부가 늦게 바뀐 경우) 출력에 나오지 않는다
    const legacy = { ...base, url: "https://sentinel.example/site", category: "SENTINEL_CAT", categoryName: "SENTINEL_CAT", categoryPath: "/c/sentinel",
      accessMode: "installable", repoUrl: "https://github.com/sentinel/repo", image: "/api/og-cache/sentinel", languages: ["SENTINEL_LANG"] };
    const text = serializeJsonLd(productJsonLd(legacy as ProductJsonLdInput));
    expect(text).not.toMatch(/SENTINEL|sentinel|github\.com|og-cache/);
    expect(text).not.toMatch(/codeRepository|sameAs|applicationCategory|genre|programmingLanguage|"image"|SoftwareApplication|SoftwareSourceCode/);
    expect(JSON.parse(text)[0].url).toBe(`${ORIGIN}/p/infisical`);
  });

  it("언어별 주소·언어 — 요약이 비면 description 칸을 뺀다", () => {
    const [page, breadcrumb] = JSON.parse(serializeJsonLd(productJsonLd({ ...base, description: "", inLanguage: "en", pagePath: "/en/p/infisical", homePath: "/en", homeName: "Discover" })));
    expect(page).toMatchObject({ url: `${ORIGIN}/en/p/infisical`, inLanguage: "en" });
    expect(page).not.toHaveProperty("description");
    expect(page.mainEntity).toEqual({ "@type": "CreativeWork", name: "Infisical" });
    expect(breadcrumb.itemListElement[0]).toEqual({ "@type": "ListItem", position: 1, name: "Discover", item: `${ORIGIN}/en` });
  });

  it("빵부스러기는 화면 경로와 같은 두 칸 — 홈 › 이름(분야 없음)", () => {
    const [, breadcrumb] = productJsonLd(base);
    expect(breadcrumb).toEqual({
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "발견하기", item: `${ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Infisical", item: `${ORIGIN}/p/infisical` },
      ],
    });
  });

  it("소개 속 </script> 가 태그를 닫지 못한다 — 뜻은 그대로", () => {
    const data = productJsonLd({ ...base, name: "</script><script>alert(1)</script>", description: "a <b> & c" });
    const text = serializeJsonLd(data);
    expect(text).not.toContain("<");
    expect(text).toContain("\\u003c/script>");
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it("상세 페이지가 ld+json 스크립트로 그린다", () => {
    const source = readFileSync("app/(public)/[locale]/(content)/p/[slug]/page.tsx", "utf8");
    expect(source).toContain('<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />');
  });
});
