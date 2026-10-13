import { createMemo } from "@/lib/cache/memo";
import { productSitemapRanges, sitemapIndexXml } from "@/lib/domain/products/sitemap";

export const dynamic = "force-dynamic";
const ranges = createMemo<number[]>({ ttlMs: 10 * 60_000, max: 1 });
export async function GET() {
  return new Response(sitemapIndexXml(await ranges.get("product-id-ranges", productSitemapRanges)), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" },
  });
}
