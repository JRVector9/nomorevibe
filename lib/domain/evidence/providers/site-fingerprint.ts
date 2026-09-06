import { normalizeTypedLink } from "../contracts";

export const SITE_FINGERPRINT_BYTES = 2 * 1024 * 1024;

/** Only explicit source links count. Multiple distinct repositories remain ambiguous. */
export function extractSiteRepositoryKeys(html: string, finalUrl: string): string[] {
  // Never infer a unique source from a truncated prefix. The generic crawl page
  // reader can stop exactly at 2 MiB, so that boundary also remains unconfirmed.
  if (Buffer.byteLength(html, "utf8") >= SITE_FINGERPRINT_BYTES) return [];
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|pre|code|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const keys = new Set<string>();
  for (const anchor of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = Object.fromEntries([...anchor[1].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map((match) => [match[1].toLowerCase(), match[2] ?? match[3]]));
    const label = [anchor[2].replace(/<[^>]*>/g, " "), attributes["aria-label"], attributes.title]
      .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!/\b(?:source code|view source|repository|source)\b|소스\s*코드|저장소/i.test(label)
      || /\b(?:example|sample|template|powered|inspired|sponsor|dependency|dependencies)\b|예제|참고|후원/i.test(label)) continue;
    try {
      const link = normalizeTypedLink("repository", new URL(attributes.href, finalUrl).href);
      if (link) keys.add(link.normalizedKey);
    } catch { /* An invalid or missing href is not relationship evidence. */ }
  }
  return [...keys].sort();
}

export async function refreshSiteFingerprint(
  input: { slug: string; productId: number; url: string },
  options: { now?: Date; fetch?: typeof import("@/lib/net/fetch").fetchCapped } = {},
): Promise<boolean> {
  const [{ fetchCapped }, { upsertObservedSource }] = await Promise.all([
    import("@/lib/net/fetch"), import("../repository"),
  ]);
  const now = options.now ?? new Date();
  const result = await (options.fetch ?? fetchCapped)(input.url, { maxBytes: SITE_FINGERPRINT_BYTES });
  const identity = { slug: input.slug, kind: "documentation", provider: "product_site", sourceKey: "canonical_site", sourceUrl: input.url };
  if (!result.ok) {
    await upsertObservedSource({ ...identity, state: "failed", lastFailureAt: now,
      lastErrorCode: `site_${result.reason}`, nextAttemptAt: new Date(now.getTime() + 6 * 3600000) }, undefined, input.productId);
    return false;
  }
  await upsertObservedSource({ ...identity, state: "ok", normalizedFacts: {
    type: "site_fingerprint", finalUrl: result.finalUrl,
    repositoryKeys: extractSiteRepositoryKeys(result.body.toString("utf8"), result.finalUrl),
  }, observedAt: now, lastSuccessAt: now, attempts: 0, lastErrorCode: null,
  nextAttemptAt: new Date(now.getTime() + 24 * 3600000) }, undefined, input.productId);
  return true;
}
