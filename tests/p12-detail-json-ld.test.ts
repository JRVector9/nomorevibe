import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { productJsonLd, serializeJsonLd, type ProductJsonLdInput } from "@/lib/seo/product-json-ld";

const ORIGIN = "https://nomorevibe.brut.bot";
const base: ProductJsonLdInput = {
  origin: ORIGIN, slug: "infisical", name: "Infisical", description: "올인원 신원 보안 플랫폼",
  url: "https://infisical.com", category: "Security", categoryName: "보안", categoryPath: "/c/security",
  accessMode: "website", repoUrl: "https://github.com/Infisical/infisical", image: null, languages: ["TypeScript"],
};

describe("상세 구조화 데이터(SEO-06)", () => {
  it("웹사이트는 SoftwareApplication — 가진 사실만, 평점·가격은 만들지 않는다", () => {
    const [item] = productJsonLd(base);
    expect(item).toMatchObject({
      "@context": "https://schema.org", "@type": "SoftwareApplication", "@id": `${ORIGIN}/p/infisical#product`,
      name: "Infisical", description: "올인원 신원 보안 플랫폼", url: "https://infisical.com/", applicationCategory: "보안",
      sameAs: "https://github.com/Infisical/infisical",
    });
    const text = serializeJsonLd(productJsonLd(base));
    expect(text).not.toMatch(/aggregateRating|offers|price|ratingValue|review/i);
    // 값이 없는 칸은 빠진다
    expect(JSON.parse(text)[0]).not.toHaveProperty("image");
  });

  it("설치형은 SoftwareSourceCode(저장소), 사라진 저장소는 적지 않는다", () => {
    const [item] = productJsonLd({ ...base, accessMode: "installable", url: "https://github.com/Infisical/infisical" });
    expect(item).toMatchObject({ "@type": "SoftwareSourceCode", codeRepository: "https://github.com/Infisical/infisical", programmingLanguage: ["TypeScript"] });
    const [gone] = JSON.parse(serializeJsonLd(productJsonLd({ ...base, accessMode: "installable", repoGone: true })));
    expect(gone).not.toHaveProperty("codeRepository");
  });

  it("개인프로필은 소프트웨어가 아니다 — CreativeWork", () => {
    expect(productJsonLd({ ...base, category: "Profile", categoryName: "개인프로필" })[0]["@type"]).toBe("CreativeWork");
  });

  it("빵부스러기는 화면 경로와 같은 세 칸", () => {
    const [, breadcrumb] = productJsonLd(base);
    expect(breadcrumb).toEqual({
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "발견하기", item: `${ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "보안", item: `${ORIGIN}/c/security` },
        { "@type": "ListItem", position: 3, name: "Infisical", item: `${ORIGIN}/p/infisical` },
      ],
    });
  });

  it("http(s) 가 아닌 주소와 바깥 그림은 적지 않고, 받아 둔 그림만 절대 주소로", () => {
    const [item] = JSON.parse(serializeJsonLd(productJsonLd({ ...base, url: "javascript:alert(1)", repoUrl: "ftp://x", image: "https://evil.example/a.png" })));
    expect(item).not.toHaveProperty("url");
    expect(item).not.toHaveProperty("sameAs");
    expect(item).not.toHaveProperty("image");
    expect(productJsonLd({ ...base, image: "/api/og-cache/abc.png" })[0].image).toBe(`${ORIGIN}/api/og-cache/abc.png`);
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
