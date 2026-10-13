import { productSitemapEntries, sitemapXml, staticSitemapEntries } from "@/lib/domain/products/sitemap";
import { isLocale } from "@/lib/i18n/locales";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ locale: string; file: string }> }) {
  const { locale, file } = await params;
  if (!isLocale(locale)) return new Response("Not found", { status: 404 });
  const part = /^products-(0|[1-9]\d*)\.xml$/.exec(file);
  if (file !== "static.xml" && (!part || !Number.isSafeInteger(Number(part[1]))
    || Number(part[1]) > Math.floor(2_147_483_646 / 10_000))) return new Response("Not found", { status: 404 });
  const entries = file === "static.xml" ? await staticSitemapEntries(locale) : await productSitemapEntries(locale, Number(part![1]));
  return new Response(sitemapXml(entries), {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=600" },
  });
}
