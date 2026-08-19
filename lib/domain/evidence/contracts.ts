import net from "node:net";
import { z } from "zod";
import type { EvidenceLevel, LinkKind } from "@/lib/db/product-evidence-schema";

const LINK_KINDS = [
  "repository",
  "app_store",
  "play_store",
  "npm",
  "pypi",
  "crates",
  "documentation",
  "support",
  "rss",
  "changelog",
  "video",
] as const satisfies readonly LinkKind[];

const EVIDENCE_LEVELS = [
  "maker_reported",
  "repository_evidenced",
  "nomorevibe_recorded",
  "signed_build",
] as const satisfies readonly EvidenceLevel[];

export const PROVENANCE_ROLES = [
  "planning",
  "design",
  "implementation",
  "review",
  "qa",
  "research",
  "testing",
  "documentation",
  "deployment",
] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "소문자 SHA-256 형식이어야 합니다");

function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const privateDnsAliases = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me"];
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    privateDnsAliases.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  ) {
    return false;
  }

  const version = net.isIP(host);
  if (version === 0) return host.includes(".");
  if (version === 6) {
    const value = host.replace(/^\[|\]$/g, "");
    return !(
      value === "::" ||
      value === "::1" ||
      value.startsWith("::ffff:") ||
      value.startsWith("64:ff9b::") ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/.test(value) ||
      value.startsWith("ff")
    );
  }

  const [a, b] = host.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseExternalUrl(input: string): URL | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.hash || !isPublicHostname(url.hostname)) return null;
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.port === "80" || url.port === "443") url.port = "";
  return url;
}

function normalizedHttpsUrl(input: string): string | null {
  const url = parseExternalUrl(input);
  if (!url) return null;
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export const safeHttpUrl = z.string().max(1_000).transform((value, ctx) => {
  const normalized = normalizedHttpsUrl(value);
  if (!normalized) {
    ctx.addIssue({ code: "custom", message: "공개 http(s) URL이어야 합니다" });
    return z.NEVER;
  }
  return normalized;
});

export function isSafeMakerMarkdown(markdown: string): boolean {
  const normalized = markdown
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1")
    .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, value) => decodeCodePoint(value, 16, whole))
    .replace(/&#([0-9]{1,7});?/g, (whole, value) => decodeCodePoint(value, 10, whole))
    .replace(/&colon;/gi, ":");
  const rawTag = /<\/?[a-z][a-z0-9:-]*(?:\s|\/?>)|<!--|<!doctype|<\?xml/i;
  const eventAttribute = /\bon[a-z]+\s*=/i;
  const unsafeMarkdownUrl = /(?:\]\(|<)\s*(?:javascript|data|vbscript|file):/i;
  const unsafeReference = /^\s*\[[^\]]+\]:\s*(?:javascript|data|vbscript|file):/im;
  return (
    !rawTag.test(normalized) &&
    !eventAttribute.test(normalized) &&
    !unsafeMarkdownUrl.test(normalized) &&
    !unsafeReference.test(normalized)
  );
}

function decodeCodePoint(value: string, radix: number, fallback: string): string {
  const point = Number.parseInt(value, radix);
  if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(point);
  } catch {
    return fallback;
  }
}

export const makerProfileSchema = z.object({
  problem: z.string().max(2_000).optional(),
  targetUsers: z.string().max(2_000).optional(),
  keyFeatures: z.array(z.string().max(240)).max(12).default([]),
  useCases: z.array(z.string().max(500)).max(12).default([]),
  pricingModel: z.enum(["free", "freemium", "paid", "open_source", "contact", "unknown"]),
  pricingUrl: safeHttpUrl.optional(),
  lifecycle: z.enum(["prototype", "beta", "ga", "maintenance", "sunset", "unknown"]),
  platforms: z.array(z.string().max(60)).max(12).default([]),
  privacySummary: z.string().max(2_000).optional(),
  longDescriptionMarkdown: z.string().max(20_000).refine(isSafeMakerMarkdown, "안전하지 않은 Markdown입니다"),
  team: z.array(z.object({
    name: z.string().max(120),
    role: z.string().max(120),
  }).strict()).max(20),
  makerLicense: z.object({
    value: z.string().max(120),
    spdxId: z.string().max(80).optional(),
    url: safeHttpUrl.optional(),
  }).strict().optional(),
}).strict();

export type MakerProfileInput = z.infer<typeof makerProfileSchema>;

export type NormalizedProductLink = { url: string; normalizedKey: string };

function exactHost(url: URL, host: string): boolean {
  return url.hostname === host || url.hostname === `www.${host}`;
}

function exactPathParts(url: URL): string[] | null {
  try {
    return url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

export function normalizeTypedLink(kind: LinkKind, input: string): NormalizedProductLink | null {
  const url = parseExternalUrl(input);
  if (!url) return null;
  const parts = exactPathParts(url);
  if (!parts) return null;

  if (kind === "repository") {
    if (!exactHost(url, "github.com") || url.search || parts.length !== 2) return null;
    const owner = parts[0].toLowerCase();
    const repo = parts[1].replace(/\.git$/i, "").toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(owner) || !/^[a-z0-9_.-]+$/.test(repo)) return null;
    const normalizedKey = `${owner}/${repo}`;
    return { url: `https://github.com/${normalizedKey}`, normalizedKey };
  }

  if (kind === "app_store") {
    if (!exactHost(url, "apps.apple.com")) return null;
    const id = [...parts].reverse().map((part) => part.match(/^id(\d+)$/i)?.[1]).find(Boolean);
    if (!id) return null;
    return { url: `https://apps.apple.com/app/id${id}`, normalizedKey: id };
  }

  if (kind === "play_store") {
    if (!exactHost(url, "play.google.com") || url.pathname !== "/store/apps/details") return null;
    const id = url.searchParams.get("id")?.toLowerCase();
    if (!id || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(id)) return null;
    return { url: `https://play.google.com/store/apps/details?id=${id}`, normalizedKey: id };
  }

  if (kind === "npm") {
    if (!exactHost(url, "npmjs.com") || parts[0] !== "package") return null;
    const raw = parts.slice(1).join("/").toLowerCase();
    if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(raw)) return null;
    return { url: `https://www.npmjs.com/package/${encodeURIComponent(raw)}`, normalizedKey: raw };
  }

  if (kind === "pypi") {
    if (!exactHost(url, "pypi.org") || parts.length !== 2 || parts[0].toLowerCase() !== "project") return null;
    const name = parts[1].toLowerCase().replace(/[-_.]+/g, "-");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
    return { url: `https://pypi.org/project/${name}`, normalizedKey: name };
  }

  if (kind === "crates") {
    if (!exactHost(url, "crates.io") || parts.length !== 2 || parts[0].toLowerCase() !== "crates") return null;
    const name = parts[1].toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null;
    return { url: `https://crates.io/crates/${name}`, normalizedKey: name };
  }

  const normalized = normalizedHttpsUrl(input);
  return normalized && normalized.length <= 500
    ? { url: normalized, normalizedKey: normalized }
    : null;
}

const makerLinkSchema = z.object({
  kind: z.enum(LINK_KINDS),
  url: z.string().max(1_000),
}).strict().transform((input, ctx) => {
  const normalized = normalizeTypedLink(input.kind, input.url);
  if (!normalized) {
    ctx.addIssue({ code: "custom", message: "지원되는 공식 공개 URL이어야 합니다" });
    return z.NEVER;
  }
  return { kind: input.kind, ...normalized };
});

export const makerLinksSchema = z.object({ links: z.array(makerLinkSchema).max(32) }).strict();

export const makerMediaSchema = z.object({
  items: z.array(z.object({
    url: safeHttpUrl,
    altText: z.string().max(500),
  }).strict()).max(8),
}).strict();

const evidenceLevel = z.enum(EVIDENCE_LEVELS);
const agentSchema = z.object({
  provider: z.string().min(1).max(120),
  client: z.string().max(120).optional(),
  model: z.string().max(160).optional(),
  roles: z.array(z.enum(PROVENANCE_ROLES)).min(1).max(PROVENANCE_ROLES.length),
  commitFrom: sha256.optional(),
  commitTo: sha256.optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  sourceUrl: safeHttpUrl.optional(),
  evidenceLevel,
}).strict();

const skillSchema = z.object({
  namespace: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  version: z.string().max(80).optional(),
  source: safeHttpUrl.optional(),
  hash: sha256.optional(),
  commit: sha256.optional(),
  evidenceLevel,
}).strict();

export const makerProvenanceSchema = z.object({
  agents: z.array(agentSchema).max(12).default([]),
  skills: z.array(skillSchema).max(12).default([]),
}).strict();
