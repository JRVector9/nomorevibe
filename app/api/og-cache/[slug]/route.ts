import { NextResponse } from "next/server";
import { getOgImage } from "@/lib/domain/products/repository";
import { VariantCache, variantSize } from "@/lib/domain/products/og-variants";
import { withRoute } from "@/lib/http/handler";
import { logger } from "@/lib/observability/logger";

type Params = { params: Promise<{ slug: string }> };

/** 줄인 사본 — 같은 인스턴스가 같은 그림을 되풀이해 줄이지 않게 */
const variants = new VariantCache();
/** 원본 주소는 브라우저 1시간. 줄인 사본은 Cloudflare 가 하루 들고 있고, 바뀐 그림은 하루 안에 퍼진다 */
const VARIANT_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
/** Cloudflare 캐시 태그 — 제품이 내려가면 크기별 사본을 한 번에 지운다(lib/cdn/purge.ts) */
const ogTag = (slug: string) => `og-${slug}`;

/**
 * 등록 시 우리 저장소에 복사해둔 OG 이미지를 서빙.
 * `<slug>.webp?size=<n>` 은 화면 크기로 줄인 WebP 사본이다(og-variants.ts) — 목록·상세의 <img> 가 쓴다.
 */
export const GET = withRoute("og.serve", async (req: Request, { params }: Params) => {
  const { slug: raw } = await params;
  const variant = raw.endsWith(".webp");
  const slug = variant ? raw.slice(0, -".webp".length) : raw;
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const url = new URL(req.url);
  const size = variantSize(url.searchParams.get("size"));
  const key = `${slug}|${size}|${url.searchParams.get("v") ?? ""}`;
  if (variant) {
    const hit = variants.get(key);
    if (hit) return new NextResponse(new Uint8Array(hit), { headers: { "content-type": "image/webp", "cache-control": VARIANT_CACHE, "cache-tag": ogTag(slug) } });
  }
  const cached = await getOgImage(slug);
  if (!cached) {
    return NextResponse.json({ error: "이미지가 없습니다" }, { status: 404 });
  }
  if (variant) {
    try {
      const { default: sharp } = await import("sharp");
      const data = await sharp(cached.data, { animated: cached.contentType === "image/gif", limitInputPixels: 16_000_000 })
        .resize({ width: size, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      variants.set(key, data);
      return new NextResponse(new Uint8Array(data), { headers: { "content-type": "image/webp", "cache-control": VARIANT_CACHE, "cache-tag": ogTag(slug) } });
    } catch (error) {
      // 줄이지 못하면 원본을 그대로 — 그림이 깨지는 것보다 무거운 편이 낫다
      logger.warn("og.variant_failed", { slug, size, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return new NextResponse(new Uint8Array(cached.data), {
    headers: {
      "content-type": cached.contentType,
      "cache-control": "public, max-age=3600",
      "cache-tag": ogTag(slug),
    },
  });
});
