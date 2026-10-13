/**
 * 상세 페이지의 구조화 데이터(JSON-LD, 2026-10-08 점검 SEO-06) — 검색엔진에 '이 페이지는 무엇이고 어디에 있나'를 알린다.
 *
 * 우리가 실제로 가진 사실만 적는다: 이름·소개·주소·분야·저장소·저장소 언어. 평점·가격·설치 수처럼 모르는 값은 만들지 않는다 —
 * 그 값이 없으면 리치 결과(별점 등)는 나오지 않지만, 지어낸 값으로 받는 것보다 낫다.
 *
 * 갈래:
 * - 개인프로필(Profile)은 소프트웨어가 아니다 → CreativeWork
 * - 설치형(저장소에서 내려받는 것)은 저장소가 곧 제품이다 → SoftwareSourceCode(codeRepository)
 * - 나머지 웹사이트 → SoftwareApplication(url 은 그 사이트)
 * 빵부스러기(BreadcrumbList)는 화면의 경로 nav 와 같은 세 칸이다 — 발견하기 › 분야 › 이름.
 */

type JsonLd = Record<string, unknown>;

export type ProductJsonLdInput = {
  /** 사이트 주소(끝 / 없음) — lib/site.ts siteOrigin() */
  origin: string;
  slug: string;
  name: string;
  /** 보이는 소개 — 한국어 소개가 있으면 그것(메타 description 과 같은 값) */
  description: string;
  /** 제품 주소(웹사이트, 설치형은 저장소) */
  url: string;
  category: string;
  /** 분야 이름(한국어) */
  categoryName: string;
  /** 분야 목록의 경로("/c/security") */
  categoryPath: string;
  accessMode: string;
  repoUrl: string | null;
  /** 저장소가 사라졌다고 확정됐으면 저장소 주소를 적지 않는다 */
  repoGone?: boolean;
  /** 우리 쪽에 받아 둔 그림(/api/og-cache/…) — 그 밖의 값은 쓰지 않는다 */
  image?: string | null;
  /** 저장소 언어 상위 몇 개 */
  languages?: string[];
  /** Localized public addresses and breadcrumb label; Korean remains the default. */
  pagePath?: string;
  homePath?: string;
  homeName?: string;
};

/** http(s) 주소만 — 그 밖의 값(javascript: 등)은 적지 않는다 */
function httpUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function productJsonLd(input: ProductJsonLdInput): JsonLd[] {
  const page = `${input.origin}${input.pagePath ?? `/p/${encodeURIComponent(input.slug)}`}`;
  const repo = input.repoGone ? undefined : httpUrl(input.repoUrl);
  const site = httpUrl(input.url);
  const image = input.image?.startsWith("/api/og-cache/") ? `${input.origin}${input.image}` : undefined;
  const languages = input.languages?.filter(Boolean) ?? [];
  const common = { "@id": `${page}#product`, name: input.name, description: input.description || undefined, image };

  const item: JsonLd = input.category === "Profile"
    ? { "@type": "CreativeWork", ...common, url: site }
    : input.accessMode === "installable"
      ? {
        "@type": "SoftwareSourceCode", ...common, url: repo ?? site, codeRepository: repo,
        programmingLanguage: languages.length ? languages : undefined, genre: input.categoryName,
      }
      : { "@type": "SoftwareApplication", ...common, url: site, applicationCategory: input.categoryName, sameAs: repo };

  const breadcrumb: JsonLd = {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: input.homeName ?? "발견하기", item: `${input.origin}${input.homePath ?? "/"}` },
      { "@type": "ListItem", position: 2, name: input.categoryName, item: `${input.origin}${input.categoryPath}` },
      { "@type": "ListItem", position: 3, name: input.name, item: page },
    ],
  };

  // 값이 없는 칸(undefined)은 JSON.stringify 가 빼 준다
  return [{ "@context": "https://schema.org", ...item }, { "@context": "https://schema.org", ...breadcrumb }];
}

/**
 * <script type="application/ld+json"> 에 넣을 글 — "<" 를 < 로 바꿔 소개 글 속 "</script>" 가 태그를 닫지 못하게 한다
 * (Next 의 JSON-LD 안내 node_modules/next/dist/docs/01-app/02-guides/json-ld.md 와 같은 방법). JSON 으로서 뜻은 그대로다.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
