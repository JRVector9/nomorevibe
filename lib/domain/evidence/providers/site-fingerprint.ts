import { normalizeTypedLink } from "../contracts";
import { createHash } from "node:crypto";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { assertCanonicalInput, captureCanonicalInput } from "../source-context";

export const SITE_FINGERPRINT_BYTES = 2 * 1024 * 1024;
const SITE_FINGERPRINT_PARSER_VERSION = 1;

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
  options: { now?: Date; force?: boolean; deadlineAt?: number; signal?: AbortSignal; hasBudget?: () => boolean; lease?: JobLease;
    fetch?: typeof import("@/lib/net/fetch").fetchCapped } = {},
): Promise<boolean | "budget_exhausted"> {
  const remainingMs = (options.deadlineAt ?? Infinity) - Date.now();
  if (remainingMs <= 0 || options.signal?.aborted || options.hasBudget?.() === false) return "budget_exhausted";
  const deadlineSignal = Number.isFinite(remainingMs) ? AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs))) : undefined;
  const signal = options.signal && deadlineSignal ? AbortSignal.any([options.signal, deadlineSignal]) : options.signal ?? deadlineSignal;
  const hasBudget = () => !signal?.aborted && options.hasBudget?.() !== false && Date.now() < (options.deadlineAt ?? Infinity);
  const [{ fetchCapped }, { upsertObservedSource, findObservedSource }, { currentEvidenceSettings }] = await Promise.all([
    import("@/lib/net/fetch"), import("../repository"), import("../settings-store"),
  ]);
  if (!hasBudget()) return "budget_exhausted";
  const now = options.now ?? new Date();
  const [stored, settings] = await Promise.all([findObservedSource({ slug: input.slug, kind: "documentation", sourceKey: "canonical_site" }), currentEvidenceSettings()]);
  if (!hasBudget()) return "budget_exhausted";
  const sameUrl = stored?.sourceUrl === input.url;
  if (sameUrl && stored.nextAttemptAt > now && (!options.force || stored.lastErrorCode)) return stored.state === "ok";
  const cached = sameUrl && stored.normalizedFacts?.type === "site_fingerprint"
    && stored.normalizedFacts.parserVersion === SITE_FINGERPRINT_PARSER_VERSION
    && typeof stored.normalizedFacts.finalUrl === "string" && typeof stored.normalizedFacts.bodyDigest === "string"
    && Array.isArray(stored.normalizedFacts.repositoryKeys)
    && stored.normalizedFacts.repositoryKeys.every(key => typeof key === "string") ? stored.normalizedFacts : null;
  const fetch = options.fetch ?? fetchCapped;
  const headers: Record<string, string> = {};
  if (cached && stored?.etag) headers["If-None-Match"] = stored.etag;
  if (cached && stored?.lastModified) headers["If-Modified-Since"] = stored.lastModified;
  const read = (headers: Record<string, string>) => {
    if (!hasBudget()) return Promise.resolve(null);
    // Await the real request: aborting a permit wait must retain its deferred
    // error, rather than racing it into generic budget exhaustion.
    return fetch(input.url, { maxBytes: SITE_FINGERPRINT_BYTES, acceptNotModified: true, headers, signal });
  };
  const original = await captureCanonicalInput(input);
  let result = await read(headers);
  if (!result || !hasBudget()) return "budget_exhausted";
  if (result.ok && result.status === 304 && (!cached || cached.finalUrl !== result.finalUrl)) {
    result = await read({});
  }
  if (!result || !hasBudget()) return "budget_exhausted";
  if (result.ok && result.status !== 304 && result.body.length >= SITE_FINGERPRINT_BYTES) return "budget_exhausted";
  const identity = { slug: input.slug, kind: "documentation", provider: "product_site", sourceKey: "canonical_site", sourceUrl: input.url };
  if (!result.ok || (result.status === 304 && (!cached || cached.finalUrl !== result.finalUrl))) {
    const attempts = (sameUrl ? stored?.attempts ?? 0 : 0) + 1;
    const delayHours = Math.min(7 * 24, 6 * 2 ** Math.min(attempts - 1, settings.maxRetries - 1));
    const persisted = await withJobLeaseWrite(options.lease, async tx => {
      if (!hasBudget()) return false;
      await assertCanonicalInput(tx, input, settings, original);
      await upsertObservedSource({ ...identity, state: "failed", lastFailureAt: now,
        attempts, lastErrorCode: `site_${result.ok ? "cacheless_304" : result.reason}`, nextAttemptAt: new Date(now.getTime() + delayHours * 3600000) }, tx, input.productId);
      return true;
    });
    return persisted ? false : "budget_exhausted";
  }
  const digest = result.status === 304 ? cached!.bodyDigest : createHash("sha256").update(result.body).digest("hex");
  const facts = cached && cached.bodyDigest === digest && cached.finalUrl === result.finalUrl ? cached : {
    type: "site_fingerprint", finalUrl: result.finalUrl, bodyDigest: digest, parserVersion: SITE_FINGERPRINT_PARSER_VERSION,
    repositoryKeys: extractSiteRepositoryKeys(result.body.toString("utf8"), result.finalUrl),
  };
  const persisted = await withJobLeaseWrite(options.lease, async tx => {
    if (!hasBudget()) return false;
    await assertCanonicalInput(tx, input, settings, original);
    await upsertObservedSource({ ...identity, state: "ok", normalizedFacts: facts,
      etag: result.headers.get("etag") ?? (result.status === 304 ? stored?.etag : null),
      lastModified: result.headers.get("last-modified") ?? (result.status === 304 ? stored?.lastModified : null),
      observedAt: now, lastSuccessAt: now, attempts: 0, lastErrorCode: null,
      nextAttemptAt: new Date(now.getTime() + settings.linkCheckHours * 3600000) }, tx, input.productId);
    return true;
  });
  return persisted ? true : "budget_exhausted";
}
