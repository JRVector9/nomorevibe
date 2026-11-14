import { siteOrigin } from "@/lib/site";

// origin은 Docker 빌드 시점이 아닌 실행 환경에서 읽는다(robots.ts와 동일).
export const dynamic = "force-dynamic";

export function GET() {
  const origin = siteOrigin();
  return new Response(`# NoMoreVibe

> AI로 만든 제품을 발견하고 제작 근거와 출처를 확인하는 공개 제품 디렉터리입니다.

## Citation and permitted use

Search indexing and retrieval for AI search/answers are welcome on public pages.
When citing, name NoMoreVibe and the product, link to the page's canonical URL,
and credit the maker and original sources where applicable. Use short excerpts;
do not mirror full product descriptions or bulk-copy the directory.
Verification badges refer to domain ownership; maker declarations and observed
repository evidence are distinct from proof that an AI tool actually ran.

사이트 콘텐츠를 AI 모델 학습·미세조정 또는 학습 데이터셋 구축에 사용하지 마세요.
Use of site content for AI model training, fine-tuning, or training datasets is prohibited.
See [robots.txt](${origin}/robots.txt) for crawler rules and Content-Signal preferences.

## Public navigation

- [Home](${origin}/): browse public products.
- [Popular](${origin}/popular): popular products.
- [Rising](${origin}/rising): rising products.
- Product pages: ${origin}/p/<slug> (use the actual page's canonical URL).
- [Policy](${origin}/policy): site policies and attribution context.
- [Sitemap](${origin}/sitemap.xml): public canonical URLs and language variants.

This file is navigation and citation guidance, not a product-content export.
`, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
