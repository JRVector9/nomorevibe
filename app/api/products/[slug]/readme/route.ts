import { NextResponse } from "next/server";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { getReadmeContent } from "@/lib/domain/products/readme-content";
import { readmePreview } from "@/lib/domain/products/readme-preview";
import type { ReadmeResponse } from "@/lib/domain/products/readme-response";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { errorResponse } from "@/lib/http/respond";

type Params = { params: Promise<{ slug: string }> };

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/**
 * 상세 README 전문(2026-11-15 사람 결정) — 서버 HTML·RSC 에는 앞부분 발췌만 글자로 남기고, 전문은 이 같은 출처 API 로 브라우저가 불러온다.
 * 공개 API 읽기 관문(수집 도구·학습 봇·다른 사이트 요청 거절, IP 별 읽기 한도)을 그대로 거친다. 엣지에 담지 않는다.
 * 그리는 양은 예전 서버 구획과 같다 — 앞부분(readme-preview.ts)과 원문 링크.
 */
export const GET = withRoute("products.readme", async (req: Request, { params }: Params) => {
  const refused = await guardPublicApiRead(req, "products.readme");
  if (refused) return refused;
  const { slug } = await params;
  const product = await publicRead("detail", ["identity", slug], () => getProductIdentity(slug));
  if (!product) return errorResponse({ kind: "not_found" });
  if (!product.repoUrl || product.repoGone) return NextResponse.json({ state: "none" } satisfies ReadmeResponse, { headers: NO_STORE });
  const readme = await getReadmeContent(product.repoUrl);
  if (!readme || readme.state !== "available") {
    return NextResponse.json({ state: readme?.state === "too_large" ? "too_large" : "unavailable", sourceUrl: readme?.sourceUrl ?? null } satisfies ReadmeResponse,
      { headers: NO_STORE });
  }
  const preview = readmePreview(readme.markdown);
  return NextResponse.json({
    state: "available", markdown: preview.markdown, truncated: preview.truncated, empty: !readme.markdown.trim(),
    sourceUrl: readme.sourceUrl, repositoryRootUrl: readme.repositoryRootUrl,
  } satisfies ReadmeResponse, { headers: NO_STORE });
});
