/**
 * 상세 페이지의 구조화 데이터(JSON-LD, 2026-10-08 점검 SEO-06) — 검색엔진에 '이 페이지는 무엇이고 어디에 있나'를 알린다.
 *
 * 공개 HTML 에는 제품의 주소(slug)·이름·요약만 싣는다(2026-11-15 사람 결정, docs/tasks/2026-11-15-public-html-name-summary.md 4.3).
 * 그래서 우리 페이지(WebPage)와 그 주제(CreativeWork: 이름·요약)만 적는다 — 제품 사이트·저장소·분야·언어·표지는 적지 않는다.
 * 그림(image)은 og:image 와 같은 공유 카드(이름·요약만 그린 /p/<slug>/share-card.png)다(2026-11-15 사람 결정).
 * 평점·가격·설치 수처럼 모르는 값도 만들지 않는다.
 * 빵부스러기(BreadcrumbList)는 화면의 경로 nav 와 같은 두 칸이다 — 홈 › 이름.
 */

type JsonLd = Record<string, unknown>;

export type ProductJsonLdInput = {
  /** 사이트 주소(끝 / 없음) — lib/site.ts siteOrigin() */
  origin: string;
  slug: string;
  name: string;
  /** 요약 — 그 언어의 한 줄(메타 description 과 같은 값, lib/domain/products/public-teaser.ts teaserSummary) */
  description: string;
  /** 페이지 언어(BCP 47, 예: "ko") */
  inLanguage: string;
  /** 공유 카드 그림(/p/<slug>/share-card.png)의 절대 주소 — og:image 와 같은 것. 없으면 적지 않는다(표지 주소는 받지 않는다) */
  shareCardImage?: string;
  /** 언어별 공개 주소와 빵부스러기 이름 — 없으면 한국어 기본값 */
  pagePath?: string;
  homePath?: string;
  homeName?: string;
};

export function productJsonLd(input: ProductJsonLdInput): JsonLd[] {
  const page = `${input.origin}${input.pagePath ?? `/p/${encodeURIComponent(input.slug)}`}`;
  const description = input.description || undefined;

  const webPage: JsonLd = {
    "@type": "WebPage", "@id": page, url: page, inLanguage: input.inLanguage, name: input.name, description,
    isPartOf: { "@type": "WebSite", "@id": "https://nomorevibe.com/#website", name: "nomorevibe", url: "https://nomorevibe.com" },
    publisher: { "@type": "Organization", "@id": "https://nomorevibe.com/#organization", name: "nomorevibe", url: "https://nomorevibe.com" },
    mainEntity: { "@type": "CreativeWork", name: input.name, description, image: input.shareCardImage },
  };

  const breadcrumb: JsonLd = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: input.homeName ?? "발견하기", item: `${input.origin}${input.homePath ?? "/"}` },
      { "@type": "ListItem", position: 2, name: input.name, item: page },
    ],
  };

  // 값이 없는 칸(undefined)은 JSON.stringify 가 빼 준다
  return [{ "@context": "https://schema.org", ...webPage }, { "@context": "https://schema.org", ...breadcrumb }];
}

/**
 * <script type="application/ld+json"> 에 넣을 글 — "<" 를 < 로 바꿔 소개 글 속 "</script>" 가 태그를 닫지 못하게 한다
 * (Next 의 JSON-LD 안내 node_modules/next/dist/docs/01-app/02-guides/json-ld.md 와 같은 방법). JSON 으로서 뜻은 그대로다.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
