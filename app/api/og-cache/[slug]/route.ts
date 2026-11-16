import { isWatermarkIcon } from "@/lib/images/watermark-policy";
import { watermarkLayers } from "@/lib/images/watermark";
import { NextResponse } from "next/server";
import { coverKeyMatches, parseCoverSegment } from "@/lib/domain/products/cover-url";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { getOgImage } from "@/lib/domain/products/repository";
import { VariantCache, variantSize } from "@/lib/domain/products/og-variants";
import { withRoute } from "@/lib/http/handler";
import { logger } from "@/lib/observability/logger";
import { OgImageUnavailableError } from "@/lib/storage/og-store";

type Params = { params: Promise<{ slug: string }> };

/** 줄인 사본 — 같은 인스턴스가 같은 그림을 되풀이해 줄이지 않게 */
const variants = new VariantCache();
/** 공개 사본은 브라우저 1시간, Cloudflare 하루. 모든 크기는 같은 purge 태그를 쓴다 */
const VARIANT_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800";
/**
 * Cloudflare 캐시 태그 — 제품이 내려가면 크기별 사본과 옛 주소의 넘김을 한 번에 지운다(lib/cdn/purge.ts 가 og-·p- 둘 다 지운다).
 * 404 에도 단다 — 감사 보류가 풀리거나 다시 올라오면 그 지우기가 남은 404 도 지운다
 */
const tags = (slug: string) => ({ "cache-tag": `og-${slug},p-${slug}` });
/** 상세와 같은 기본 정보 읽기(같은 열쇠, 30초) — 내려간(banned)·없는 제품의 표지는 열쇠가 맞아도 주지 않는다 */
const identityOf = (slug: string) => publicRead("detail", ["identity", slug], () => getProductIdentity(slug));

/**
 * 등록 시 우리 저장소에 복사해둔 OG 이미지(제품 표지)를 서빙(버킷 먼저, 없으면 DB — repository.getOgImage).
 *  - `<slug>.<열쇠>` 는 JPEG 미리보기, `<slug>.<열쇠>.webp?size=<n>` 은 화면용 WebP 사본이다. 열쇠는 보호 API 가 내준 것만 맞는다
 *    (lib/domain/products/cover-url.ts). 틀린 열쇠·내려간 제품은 404.
 *  - 옛 공개 주소 `<slug>`·`<slug>.webp` 는 표지를 주지 않고 그 제품의 공유 카드(/p/<slug>/share-card.png, 이름·요약)로 302 —
 *    예전에 SNS 에 실린 미리보기 주소가 깨지지 않게(2026-11-15 사람 결정).
 * 어느 주소·쿼리도 원본이나 다중 프레임을 반환하지 않는다. 최대 1200×630, 512KiB.
 */
export const GET = withRoute("og.serve", async (req: Request, { params }: Params) => {
  const { slug: raw } = await params;
  const parsed = parseCoverSegment(raw);
  if (!parsed) {
    return NextResponse.json({ error: "잘못된 요청" }, { status: 400 });
  }
  const { slug, key: coverKey, webp: variant } = parsed;
  if (coverKey === null) {
    return new NextResponse(null, { status: 302, headers: {
      location: `/p/${slug}/share-card.png`, "cache-control": VARIANT_CACHE, ...tags(slug),
    } });
  }
  const missing = () => NextResponse.json({ error: "이미지가 없습니다" }, { status: 404,
    headers: { "cache-control": "public, max-age=300", ...tags(slug) } });
  if (!coverKeyMatches(slug, coverKey) || !(await identityOf(slug))) return missing();
  const url = new URL(req.url);
  const size = variantSize(url.searchParams.get("size"));
  const thumbnail = url.searchParams.get("thumbnail");
  const key = `preview-v3|${isWatermarkIcon(thumbnail) ? "icon" : "cover"}|${variant ? "webp" : "jpeg"}|${slug}|${variant ? size : 1200}|${url.searchParams.get("v") ?? ""}`;
  const headers = {
    "content-type": variant ? "image/webp" : "image/jpeg",
    "cache-control": VARIANT_CACHE,
    ...tags(slug),
    "x-content-type-options": "nosniff",
  };
  const hit = variants.get(key);
  if (hit) return new NextResponse(new Uint8Array(hit), { headers });
  let cached: Awaited<ReturnType<typeof getOgImage>>;
  try {
    cached = await getOgImage(slug);
  } catch (error) {
    // 버킷이 답하지 않고 DB 에도 없다 — 있는 그림일 수 있어 404 를 엣지에 남기지 않는다
    if (!(error instanceof OgImageUnavailableError)) throw error;
    return NextResponse.json({ error: "이미지를 잠시 불러올 수 없습니다" }, {
      status: 503,
      headers: { "cache-control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "retry-after": "30" },
    });
  }
  if (!cached) return missing();
  try {
    const { default: sharp } = await import("sharp");
    // 첫 프레임만 처리한다. EXIF 방향 적용 뒤 축소하며 출력에 원본 메타데이터를 복사하지 않는다.
    const preview = sharp(cached.data, { pages: 1, limitInputPixels: 16_000_000 })
      .rotate()
      .resize({ width: variant ? size : 1200, height: 630, fit: "inside", withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true });
    const resized = await preview;
    const output = sharp(resized.data, { raw: resized.info })
      .composite(await watermarkLayers(resized.info.width, resized.info.height, thumbnail));
    let data: Buffer | undefined;
    for (const quality of [78, 60]) {
      const candidate = await (variant ? output.clone().webp({ quality })
        : output.clone().flatten({ background: "#ffffff" }).jpeg({ quality })).toBuffer();
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
