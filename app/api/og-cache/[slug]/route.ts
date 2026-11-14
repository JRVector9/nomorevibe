import { NextResponse } from "next/server";
import { getOgImage } from "@/lib/domain/products/repository";
import { VariantCache, variantSize } from "@/lib/domain/products/og-variants";
import { withRoute } from "@/lib/http/handler";
import { logger } from "@/lib/observability/logger";

type Params = { params: Promise<{ slug: string }> };

/** 줄인 사본 — 같은 인스턴스가 같은 그림을 되풀이해 줄이지 않게 */
const variants = new VariantCache();
/** 공개 사본은 브라우저 1시간, Cloudflare 하루. 모든 크기는 같은 purge 태그를 쓴다 */
const VARIANT_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
/** Cloudflare 캐시 태그 — 제품이 내려가면 크기별 사본을 한 번에 지운다(lib/cdn/purge.ts) */
const ogTag = (slug: string) => `og-${slug}`;

/**
 * 등록 시 우리 저장소에 복사해둔 OG 이미지를 서빙.
 * `<slug>`는 SNS 호환 JPEG 미리보기, `<slug>.webp?size=<n>`은 화면용 WebP 사본이다.
 * 어느 주소·쿼리도 원본이나 다중 프레임을 반환하지 않는다. 최대 1200×630, 512KiB.
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
  const key = `preview-v2|${variant ? "webp" : "jpeg"}|${slug}|${variant ? size : 1200}|${url.searchParams.get("v") ?? ""}`;
  const headers = {
    "content-type": variant ? "image/webp" : "image/jpeg",
    "cache-control": VARIANT_CACHE,
    "cache-tag": ogTag(slug),
    "x-content-type-options": "nosniff",
  };
  const hit = variants.get(key);
  if (hit) return new NextResponse(new Uint8Array(hit), { headers });
  const cached = await getOgImage(slug);
  if (!cached) {
    return NextResponse.json({ error: "이미지가 없습니다" }, { status: 404 });
  }
  try {
    const { default: sharp } = await import("sharp");
    // 첫 프레임만 처리한다. EXIF 방향 적용 뒤 축소하며 출력에 원본 메타데이터를 복사하지 않는다.
    const preview = sharp(cached.data, { pages: 1, limitInputPixels: 16_000_000 })
      .rotate()
      .resize({ width: variant ? size : 1200, height: 630, fit: "inside", withoutEnlargement: true });
    let data: Buffer | undefined;
    for (const quality of [78, 60]) {
      const candidate = await (variant ? preview.clone().webp({ quality })
        : preview.clone().flatten({ background: "#ffffff" }).jpeg({ quality })).toBuffer();
      if (candidate.length <= 512 * 1024) {
        data = candidate;
        break;
      }
    }
    if (!data) throw new Error("preview exceeds byte limit");
    variants.set(key, data);
    return new NextResponse(new Uint8Array(data), { headers });
  } catch (error) {
    // 변환 실패도 원본 다운로드 경로가 되어서는 안 된다.
    logger.warn("og.variant_failed", { slug, size: variant ? size : 1200, error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: "이미지를 표시할 수 없습니다" }, {
      status: 422,
      headers: { "cache-control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" },
    });
  }
});
