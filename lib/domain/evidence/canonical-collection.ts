import { z } from "zod";
import { createHash } from "node:crypto";
import { fetchCapped } from "@/lib/net/fetch";
import { extractSiteRepositoryKeys, SITE_FINGERPRINT_BYTES } from "./providers/site-fingerprint";
import type { ProductEvidenceSource } from "@/lib/db/product-evidence-schema";

const siteFactsSchema=z.strictObject({type:z.literal("site_fingerprint"),finalUrl:z.url(),bodyDigest:z.string().regex(/^[a-f0-9]{64}$/),
 parserVersion:z.literal(1),repositoryKeys:z.array(z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/)).max(2000)})
 .refine(value=>Buffer.byteLength(JSON.stringify(value))<=64*1024);
export const CanonicalCollectionSchema=z.discriminatedUnion("state",[
 z.strictObject({state:z.literal("ok"),facts:siteFactsSchema,etag:z.string().max(500).nullable(),lastModified:z.string().max(200).nullable()}),
 z.strictObject({state:z.literal("failed"),reason:z.string().min(1).max(80)}),z.strictObject({state:z.literal("incomplete")})]);
export type CanonicalCollection=z.infer<typeof CanonicalCollectionSchema>;
/** Collection is data only. The result writer must validate actual source ownership and current input. */
export async function collectCanonicalSite(url: string, stored: Pick<ProductEvidenceSource, "sourceUrl" | "normalizedFacts" | "etag" | "lastModified"> | undefined,
  options: { signal?: AbortSignal; deadlineAt?: number; fetch?: typeof fetchCapped } = {}): Promise<CanonicalCollection> {
  const remaining = (options.deadlineAt ?? Date.now() + 25_000) - Date.now();
  if (remaining <= 0 || options.signal?.aborted) return { state: "incomplete" };
  const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const value = stored?.sourceUrl === url ? stored.normalizedFacts : null;
  const parsed=siteFactsSchema.safeParse(value);
  const cached=parsed.success?parsed.data:null;
  const headers: Record<string, string> = {};
  if (cached && stored?.etag) headers["If-None-Match"] = stored.etag;
  if (cached && stored?.lastModified) headers["If-Modified-Since"] = stored.lastModified;
  const fetch = options.fetch ?? fetchCapped;
  const read = (conditional: Record<string, string>) => fetch(url, { maxBytes: SITE_FINGERPRINT_BYTES, acceptNotModified: true, headers: conditional, signal });
  // Await the actual reader/cancellation settlement; no synthetic early timeout result.
  let result = await read(headers);
  if (signal.aborted) return { state: "incomplete" };
  if (result.ok && result.status === 304 && (!cached || cached.finalUrl !== result.finalUrl)) result = await read({});
  if (signal.aborted) return { state: "incomplete" };
  if (!result.ok) return { state: "failed", reason: `site_${result.reason}` };
  if (result.status === 304 && (!cached || cached.finalUrl !== result.finalUrl)) return { state: "failed", reason: "site_cacheless_304" };
  if (result.status !== 304 && result.body.length >= SITE_FINGERPRINT_BYTES) return { state: "incomplete" };
  const digest = result.status === 304 ? cached!.bodyDigest : createHash("sha256").update(result.body).digest("hex");
  const facts = cached && cached.bodyDigest === digest && cached.finalUrl === result.finalUrl ? cached : {
    type: "site_fingerprint" as const, finalUrl: result.finalUrl, bodyDigest: digest, parserVersion: 1 as const,
    repositoryKeys: extractSiteRepositoryKeys(result.body.toString("utf8"), result.finalUrl),
  };
  if (!siteFactsSchema.safeParse(facts).success) return { state: "incomplete" };
  return { state: "ok", facts, etag: result.headers.get("etag") ?? (result.status === 304 ? stored?.etag ?? null : null),
    lastModified: result.headers.get("last-modified") ?? (result.status === 304 ? stored?.lastModified ?? null : null) };
}
