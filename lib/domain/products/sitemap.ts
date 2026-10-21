import { and, asc, inArray, sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { productIntroChecks, products, productTranslations } from "@/lib/db/schema";
import { productReadyLocales } from "@/lib/i18n/metadata";
import { isLocale, LOCALES, type Locale } from "@/lib/i18n/locales";
import { localePath } from "@/lib/i18n/routing";
import { CATEGORIES } from "./categories";
import { indexableProduct, sitemapLastModified } from "./indexing";
import { hiddenByDefault } from "./visibility";
import { getCurrentSeason, getSeasonHistory } from "@/lib/domain/ranking/view";
import { seasonKeysWithEntries } from "@/lib/domain/ranking/season-entries";
import { siteOrigin } from "@/lib/site";

export const SITEMAP_ID_RANGE = 10_000;
export const SITEMAP_URL_LIMIT = 50_000;
export const SITEMAP_BYTE_LIMIT = 50 * 1024 * 1024;
export type SitemapEntry = { url: string; lastModified?: Date; changeFrequency?: string; priority?: number };

/** Populated stable ID ranges; no rank/order offset and no 49,000-product cutoff. */
export async function productSitemapRanges(): Promise<number[]> {
  return onReplica(async () => {
    // Sort the selected alias: repeating the parameterized expression creates a distinct $2 for PostgreSQL.
    const range = sql<number>`floor((${products.id} - 1)::numeric / ${SITEMAP_ID_RANGE})::int`.as("range");
    const rows = await db.selectDistinct({ range }).from(products).where(indexableProduct).orderBy(range);
    return rows.map((row) => row.range);
  });
}

export async function productSitemapEntries(locale: Locale, range: number): Promise<SitemapEntry[]> {
  if (!isLocale(locale) || !Number.isSafeInteger(range) || range < 0 || range > Math.floor(2_147_483_646 / SITEMAP_ID_RANGE)) {
    throw new Error("Invalid sitemap range");
  }
  return onReplica(async () => {
    const rows = await db.select({ id: products.id, slug: products.slug, name: products.name,
      tagline: products.tagline, description: products.description, updatedAt: sitemapLastModified,
      contentEligible: sql<boolean>`not exists (select 1 from ${productIntroChecks} i
        where i.product_id = ${products.id} and i.checked_tagline = ${products.tagline} and i.outcome = 'needs_editor')`,
    }).from(products).where(and(indexableProduct,
      sql`${products.id} > ${range * SITEMAP_ID_RANGE} and ${products.id} <= ${(range + 1) * SITEMAP_ID_RANGE}`))
      .orderBy(asc(products.id));
    if (!rows.length) return [];
    // Read readiness markers, not up to 8,000 characters of translated text per field.
    const translations = locale === "ko" ? [] : await db.select({
      productId: productTranslations.productId, locale: productTranslations.locale, field: productTranslations.field,
      sourceHash: productTranslations.sourceHash, status: productTranslations.status, errorCode: productTranslations.errorCode,
      text: sql<string | null>`case when length(btrim(${productTranslations.text})) > 0 then 'present' end`,
    }).from(productTranslations).where(and(inArray(productTranslations.productId, rows.map((row) => row.id)),
      inArray(productTranslations.status, ["ready", "reviewed"])));
    const byProduct = new Map<number, typeof translations>();
    for (const row of translations) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row]);
    const origin = siteOrigin();
    return rows.filter((row) => productReadyLocales(row, byProduct.get(row.id) ?? [], row.contentEligible).includes(locale))
      .map((row) => ({ url: `${origin}${localePath(locale, `/p/${row.slug}`)}`, lastModified: row.updatedAt,
        changeFrequency: "daily", priority: 0.8 }));
  });
}

/** Fixed UI shares URLs across locales; season visibility keeps the current existing rule. */
export async function staticSitemapEntries(locale: Locale): Promise<SitemapEntry[]> {
  if (!isLocale(locale)) throw new Error("Invalid sitemap locale");
  const origin = siteOrigin();
  const url = (path: string) => `${origin}${localePath(locale, path)}`;
  const [current, closed] = await Promise.all([getCurrentSeason(), getSeasonHistory(500)]);
  const seasons = current ? [current, ...closed] : closed;
  const listed = new Set(await seasonKeysWithEntries(seasons.map((season) => season.key)));
  return [
    { url: url("/"), changeFrequency: "hourly", priority: 1 },
    { url: url("/popular"), changeFrequency: "daily", priority: 0.7 },
    { url: url("/rising"), changeFrequency: "daily", priority: 0.7 },
    { url: url("/launch"), changeFrequency: "monthly", priority: 0.5 },
    { url: url("/policy"), changeFrequency: "monthly", priority: 0.3 },
    ...CATEGORIES.filter((category) => !hiddenByDefault(category)).map((category) => ({
      url: url(`/c/${category.toLowerCase()}`), changeFrequency: "daily", priority: 0.6,
    })),
    ...seasons.filter((season) => listed.has(season.key)).map((season) => ({
      url: url(`/rankings/${season.key}`), lastModified: season.refreshedAt ?? season.startsAt,
      changeFrequency: season.state === "active" ? "hourly" : "yearly", priority: season.state === "active" ? 0.7 : 0.4,
    })),
  ];
}

const xmlEscape = (value: string) => value.replace(/[<>&"']/g, (char) =>
  ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
function boundedXml(body: string, count: number): string {
  if (count > SITEMAP_URL_LIMIT || Buffer.byteLength(body, "utf8") > SITEMAP_BYTE_LIMIT) throw new Error("Sitemap protocol limit exceeded");
  return body;
}
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => `<url><loc>${xmlEscape(entry.url)}</loc>`
    + (entry.lastModified ? `<lastmod>${entry.lastModified.toISOString()}</lastmod>` : "")
    + (entry.changeFrequency ? `<changefreq>${xmlEscape(entry.changeFrequency)}</changefreq>` : "")
    + (entry.priority === undefined ? "" : `<priority>${entry.priority}</priority>`) + "</url>").join("");
  return boundedXml(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, entries.length);
}
export function sitemapIndexXml(ranges: readonly number[]): string {
  const origin = siteOrigin();
  const urls = LOCALES.flatMap((locale) => [ `${origin}/sitemaps/${locale}/static.xml`,
    ...ranges.map((range) => `${origin}/sitemaps/${locale}/products-${range}.xml`) ]);
  return boundedXml(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
    + urls.map((url) => `<sitemap><loc>${xmlEscape(url)}</loc></sitemap>`).join("") + "</sitemapindex>", urls.length);
}
