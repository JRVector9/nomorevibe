import { z } from "zod";
import type { LinkKind } from "@/lib/db/product-evidence-schema";
import { normalizeTypedLink } from "../contracts";
import { fetchCapped, type CappedFetchResult } from "@/lib/net/fetch";

const JSON_CAP = 512 * 1024;
const PAGE_CAP = 256 * 1024;

export type LinkEvidenceRequest = (
  url: string,
  options: { maxBytes: number; headers?: Record<string, string> },
) => Promise<CappedFetchResult>;

const appStoreLookupSchema = z.object({
  resultCount: z.number().int().nonnegative(),
  results: z.array(z.object({
    trackId: z.number().int().positive(),
    trackName: z.string().min(1),
    bundleId: z.string().min(1),
    version: z.string().min(1),
    currentVersionReleaseDate: z.string().nullish(),
    trackViewUrl: z.string().url(),
    sellerName: z.string().min(1),
  }).passthrough()).max(50),
}).passthrough();

function parseJson(result: CappedFetchResult): unknown | null {
  if (!result.ok) return null;
  try {
    return JSON.parse(result.body.toString("utf8"));
  } catch {
    return null;
  }
}

export async function verifyAppStoreLink(
  link: string,
  request: LinkEvidenceRequest = fetchCapped,
) {
  const normalized = normalizeTypedLink("app_store", link);
  if (!normalized) throw new Error("invalid app_store link");
  const result = await request(`https://itunes.apple.com/lookup?id=${normalized.normalizedKey}`, {
    maxBytes: JSON_CAP,
    headers: { accept: "application/json" },
  });
  const parsed = appStoreLookupSchema.safeParse(parseJson(result));
  if (!parsed.success) return null;
  const app = parsed.data.results.find((candidate) => String(candidate.trackId) === normalized.normalizedKey);
  if (!app) return null;
  const released = app.currentVersionReleaseDate ? new Date(app.currentVersionReleaseDate) : null;
  return {
    type: "app_store" as const,
    provider: "apple" as const,
    appId: normalized.normalizedKey,
    name: app.trackName.slice(0, 200),
    bundleId: app.bundleId.slice(0, 200),
    version: app.version.slice(0, 80),
    currentVersionReleaseDate: released && !Number.isNaN(released.getTime())
      ? released.toISOString()
      : null,
    sellerName: app.sellerName.slice(0, 200),
    url: normalized.url,
    evidenceLabel: "공식 출처에서 확인" as const,
  };
}

export async function verifyPlayStoreLink(
  link: string,
  request: LinkEvidenceRequest = fetchCapped,
) {
  const normalized = normalizeTypedLink("play_store", link);
  if (!normalized) throw new Error("invalid play_store link");
  const result = await request(normalized.url, { maxBytes: PAGE_CAP });
  if (!result.ok) return null;
  const final = normalizeTypedLink("play_store", result.finalUrl);
  if (!final || final.normalizedKey !== normalized.normalizedKey) return null;
  return {
    type: "link" as const,
    provider: "google_play" as const,
    packageId: normalized.normalizedKey,
    url: final.url,
    evidenceLabel: "링크 확인" as const,
  };
}

type PackageKind = Extract<LinkKind, "npm" | "pypi" | "crates">;

function packageEndpoint(kind: PackageKind, key: string): string {
  if (kind === "npm") return `https://registry.npmjs.org/${encodeURIComponent(key)}`;
  if (kind === "pypi") return `https://pypi.org/pypi/${encodeURIComponent(key)}/json`;
  return `https://crates.io/api/v1/crates/${encodeURIComponent(key)}`;
}

function packageIdentity(kind: PackageKind, payload: unknown): { name: string; version: string } | null {
  if (!payload || typeof payload !== "object") return null;
  if (kind === "npm") {
    const value = payload as { name?: unknown; "dist-tags"?: { latest?: unknown } };
    return typeof value.name === "string" && typeof value["dist-tags"]?.latest === "string"
      ? { name: value.name, version: value["dist-tags"].latest }
      : null;
  }
  if (kind === "pypi") {
    const info = (payload as { info?: { name?: unknown; version?: unknown } }).info;
    return typeof info?.name === "string" && typeof info.version === "string"
      ? { name: info.name, version: info.version }
      : null;
  }
  const crate = (payload as { crate?: { name?: unknown; max_version?: unknown } }).crate;
  return typeof crate?.name === "string" && typeof crate.max_version === "string"
    ? { name: crate.name, version: crate.max_version }
    : null;
}

export async function verifyPackageLink(
  kind: PackageKind,
  link: string,
  request: LinkEvidenceRequest = fetchCapped,
) {
  const normalized = normalizeTypedLink(kind, link);
  if (!normalized) throw new Error(`invalid ${kind} link`);
  const result = await request(packageEndpoint(kind, normalized.normalizedKey), {
    maxBytes: JSON_CAP,
    headers: { accept: "application/json" },
  });
  const identity = packageIdentity(kind, parseJson(result));
  if (!identity) return null;
  return {
    type: "package" as const,
    registry: kind,
    name: identity.name.slice(0, 214),
    version: identity.version.slice(0, 100),
    url: normalized.url,
    evidenceLabel: "공식 출처에서 확인" as const,
  };
}

export async function verifyChangelogLink(
  link: string,
  request: LinkEvidenceRequest = fetchCapped,
) {
  const normalized = normalizeTypedLink("changelog", link);
  if (!normalized) throw new Error("invalid changelog link");
  const result = await request(normalized.url, { maxBytes: PAGE_CAP });
  if (!result.ok) return null;
  return {
    type: "link" as const,
    provider: "product_changelog" as const,
    url: normalized.url,
    evidenceLabel: "링크 확인" as const,
  };
}
