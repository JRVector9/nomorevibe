import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Product } from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";

const mocks = vi.hoisted(() => ({
  mode: vi.fn(), rate: vi.fn(), find: vi.fn(), register: vi.fn(), verify: vi.fn(),
  update: vi.fn(), remove: vi.fn(), takedown: vi.fn(),
}));
// Keep the real routes, public guard, session verifier, parsers, and response serializers.
// Only DB/network operations and the DR transaction boundary are fixtures.
vi.mock("@/lib/operations/dr/web-gate", async original => ({
  ...await original<typeof import("@/lib/operations/dr/web-gate")>(),
  runWebWrite: (load: () => Promise<unknown>) => load(),
}));
vi.mock("@/lib/anti-scrape/control", () => ({ publicApiMode: mocks.mode }));
vi.mock("@/lib/rate-limit", async original => ({
  ...await original<typeof import("@/lib/rate-limit")>(), rateLimitWindow: mocks.rate, rateLimit: async () => true,
}));
vi.mock("@/lib/domain/products/repository", async original => ({
  ...await original<typeof import("@/lib/domain/products/repository")>(), findBySlug: mocks.find,
}));
vi.mock("@/lib/domain/products/register", () => ({ registerProduct: mocks.register }));
vi.mock("@/lib/domain/products/verify", () => ({ verifyProduct: mocks.verify }));
vi.mock("@/lib/domain/products/manage", () => ({ updateProduct: mocks.update, deleteProduct: mocks.remove }));
vi.mock("@/lib/domain/products/takedown", () => ({ requestTakedown: mocks.takedown, takedownRequesterHash: () => null }));
vi.mock("@/lib/analytics/server", () => ({ trackServer: vi.fn(), agentClass: () => "agent" }));
vi.mock("@/lib/domain/evidence/repository", async original => ({
  ...await original<typeof import("@/lib/domain/evidence/repository")>(),
  getMakerProfileResource: async () => ({}), getMakerLinksResource: async () => ({ links: [] }),
  getMakerMediaResource: async () => ({ items: [] }), getMakerProvenanceResource: async () => ({ agents: [], skills: [] }),
  saveMakerProfile: vi.fn(), replaceMakerLinks: vi.fn(), replaceProductProvenance: vi.fn(),
}));
vi.mock("@/lib/domain/evidence/maker", async original => ({
  ...await original<typeof import("@/lib/domain/evidence/maker")>(),
  replaceMakerMedia: async () => 0, createMakerUpdate: async () => 1, queueMakerRefresh: vi.fn(),
}));

import * as products from "@/app/api/products/route";
import * as product from "@/app/api/products/[slug]/route";
import * as profile from "@/app/api/products/[slug]/profile/route";
import * as links from "@/app/api/products/[slug]/links/route";
import * as media from "@/app/api/products/[slug]/media/route";
import * as provenance from "@/app/api/products/[slug]/provenance/route";
import * as updates from "@/app/api/products/[slug]/updates/route";
import * as refresh from "@/app/api/products/[slug]/refresh/route";
import * as verify from "@/app/api/products/[slug]/verify/route";
import * as takedown from "@/app/api/products/[slug]/takedown/route";
import { issueSession, SESSION_COOKIE } from "@/lib/anti-scrape/session";

const SIGNING = "skill-contract-test-only-signing-secret";
const MARKERS = {
  url: "https://site-link-marker.test", repo: "https://github.com/repo-link-marker/project",
  readme: "README_BODY_MARKER_DO_NOT_EXPOSE", maker: "MAKER_MARKER_DO_NOT_EXPOSE", stars: 987654321,
};
const fixture = {
  id: 42, slug: "skill-check", name: "Skill check", tagline: "Claim preview", category: "Dev", status: "seeded",
  source: "crawler", claimedAt: null, verifyToken: "public-ownership-challenge", url: MARKERS.url,
  repoUrl: MARKERS.repo, searchReadme: MARKERS.readme, readme: MARKERS.readme, readmeHtml: MARKERS.readme, githubStars: MARKERS.stars,
  makerName: MARKERS.maker,
  editTokenHash: hashToken("unit-test-edit-token"),
} as unknown as Product;
const ctx = { params: Promise.resolve({ slug: fixture.slug }) };
type Route = Record<string, (req: Request, context: typeof ctx) => Promise<Response>>;
const routes: Record<string, Route> = {
  "/api/products": products, "/api/products/<slug>": product,
  "/api/products/<slug>/profile": profile, "/api/products/<slug>/links": links,
  "/api/products/<slug>/media": media, "/api/products/<slug>/provenance": provenance,
  "/api/products/<slug>/updates": updates, "/api/products/<slug>/refresh": refresh,
  "/api/products/<slug>/verify": verify, "/api/products/<slug>/takedown": takedown,
};

// Parse explicit method/path declarations AND curl commands (including implicit GET).
// New documented paths require an executable route fixture, so they cannot silently escape coverage.
const skill = readFileSync("skill/SKILL.md", "utf8");
const calls = new Set<string>();
for (const match of skill.matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(?:<API>)?(\/api\/[\w/<>-]+)/g)) {
  calls.add(`${match[1]} ${match[2]}`);
}
for (const match of skill.replace(/\\\n\s*/g, " ").matchAll(/\bcurl\s+[^\n`]+/g)) {
  const path = match[0].match(/<API>(\/api\/[\w/<>-]+)/)?.[1];
  if (path) calls.add(`${match[0].match(/-X\s+(\w+)/)?.[1] ?? "GET"} ${path}`);
}
const documentedCalls = [...calls].sort().map(call => {
  const [method, path] = call.split(" ");
  return { call, method, path };
});

function request(path = "/api/products/<slug>", method = "GET", body?: unknown, headers: HeadersInit = {}) {
  return new Request(`https://nomorevibe.test${path.replace("<slug>", fixture.slug)}`, {
    method, headers: { "user-agent": "nomorevibe-skill/1", "x-forwarded-for": "8.8.8.8",
      "x-edit-token": "unit-test-edit-token", "if-match": '"fixture-version"',
      "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.stubEnv("TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
  vi.stubEnv("PUBLIC_API_SESSION_SECRET", SIGNING);
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1"); vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  mocks.mode.mockReset().mockResolvedValue("enforce");
  mocks.rate.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 60 });
  mocks.find.mockReset().mockResolvedValue(fixture);
  mocks.register.mockResolvedValue({ ok: true, value: { slug: fixture.slug, editToken: "fixture-token", verifyToken: fixture.verifyToken } });
  mocks.verify.mockResolvedValue({ ok: true, value: { slug: fixture.slug, claimed: true, edit_token: "fixture-token" } });
  for (const mock of [mocks.update, mocks.remove, mocks.takedown]) mock.mockResolvedValue({ ok: true, value: {} });
});
afterEach(() => vi.unstubAllEnvs());

describe("SKILL.md API contract — enforce without a browser session", () => {
  it("enumerates all documented methods and paths, including the four authenticated reads", () => {
    expect(documentedCalls.map(({ call }) => call)).toMatchInlineSnapshot(`
      [
        "DELETE /api/products/<slug>",
        "GET /api/products/<slug>",
        "GET /api/products/<slug>/links",
        "GET /api/products/<slug>/media",
        "GET /api/products/<slug>/profile",
        "GET /api/products/<slug>/provenance",
        "PATCH /api/products/<slug>",
        "POST /api/products",
        "POST /api/products/<slug>/refresh",
        "POST /api/products/<slug>/takedown",
        "POST /api/products/<slug>/updates",
        "POST /api/products/<slug>/verify",
        "PUT /api/products/<slug>/links",
        "PUT /api/products/<slug>/media",
        "PUT /api/products/<slug>/profile",
        "PUT /api/products/<slug>/provenance",
      ]
    `);
    const mentionedPaths = [...skill.matchAll(/\/api\/[\w/<>-]+/g)].map(match => match[0]);
    expect(mentionedPaths.length).toBeGreaterThan(0);
    for (const path of mentionedPaths) expect(documentedCalls.some(call => call.path === path), path).toBe(true);
  });

  it.each(documentedCalls)("$call has no api_session_required and reaches its success response", async ({ method, path }) => {
    const handler = routes[path]?.[method];
    expect(handler, `${method} ${path} needs a real route fixture`).toBeTypeOf("function");
    const payload = path === "/api/products" ? { url: MARKERS.url, name: "Skill check", tagline: "Preview", description: "Description", category: "Dev" }
      : path.endsWith("/profile") ? { pricingModel: "unknown", lifecycle: "unknown", longDescriptionMarkdown: "", team: [] }
      : path.endsWith("/links") ? { links: [] } : path.endsWith("/media") ? { items: [] }
      : path.endsWith("/provenance") ? { agents: [], skills: [] }
      : path.endsWith("/updates") ? { title: "An update" } : {};
    const response = await handler(request(path, method, method === "GET" ? undefined : payload), ctx);
    const body = await response.json();
    expect(body.error).not.toBe("api_session_required");
    expect(response.status, JSON.stringify(body)).toBeGreaterThanOrEqual(200);
    expect(response.status, JSON.stringify(body)).toBeLessThan(300);
  });
});

describe("sessionless claim-check response", () => {
  it.each(["nomorevibe-skill/1", "Mozilla/5.0 Chrome/131.0 Safari/537.36"])("%s receives only identity and public verification instructions", async ua => {
    const response = await product.GET(request(undefined, "GET", undefined, { "user-agent": ua }), ctx);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["category", "claimable", "name", "slug", "status", "tagline", "verify"]);
    expect(body).toMatchObject({ slug: fixture.slug, claimable: true, verify: { file: { content: fixture.verifyToken } } });
    const serialized = JSON.stringify(body);
    for (const marker of Object.values(MARKERS)) expect(serialized).not.toContain(String(marker));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });

  it("claimed products omit claimable and verify", async () => {
    mocks.find.mockResolvedValue({ ...fixture, source: "skill", claimedAt: new Date() });
    const body = await (await product.GET(request(), ctx)).json();
    expect(Object.keys(body).sort()).toEqual(["category", "name", "slug", "status", "tagline"]);
  });

  it.each([null, { ...fixture, status: "banned" }])("missing or banned products remain 404", async value => {
    mocks.find.mockResolvedValue(value);
    expect((await product.GET(request(), ctx)).status).toBe(404);
  });

  it.each([
    ["http://www.site-link-marker.test/?tracking=1#section", true],
    [MARKERS.repo + "/?tracking=1", true], ["https://different.test", false],
    ["javascript:alert(1)", false], ["", false],
  ])("normalizes %s and reports matches=%s without disclosing stored addresses", async (url, matches) => {
    const response = await product.GET(request(`/api/products/<slug>?url=${encodeURIComponent(url)}`), ctx);
    const body = await response.json();
    expect(body.matches).toBe(matches);
    for (const marker of Object.values(MARKERS)) expect(JSON.stringify(body)).not.toContain(String(marker));
  });

  it("does not equate two invalid or absent URLs", async () => {
    mocks.find.mockResolvedValue({ ...fixture, url: "invalid:stored", repoUrl: null });
    expect(await (await product.GET(request("/api/products/<slug>?url=invalid:input"), ctx)).json()).toMatchObject({ matches: false });
  });

  it.each(["valid session", "observe", "unconfigured"])("%s preserves the existing full body", async mode => {
    const headers: Record<string, string> = {};
    if (mode === "observe") mocks.mode.mockResolvedValue("observe");
    if (mode === "unconfigured") vi.stubEnv("TURNSTILE_SITE_KEY", "");
    if (mode === "valid session") headers.cookie = `${SESSION_COOKIE}=${issueSession(request(), SIGNING).value}`;
    const response = await product.GET(request(undefined, "GET", undefined, headers), ctx);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["category", "claimable", "name", "slug", "status", "tagline", "url", "verify"]);
    expect(body.url).toBe(MARKERS.url);
    if (mode === "valid session") expect(mocks.rate).toHaveBeenCalledWith(expect.stringContaining("api-session:detail:"), 60, 600000, 1);
  });

  it("invalid cookies only receive the minimal body", async () => {
    const body = await (await product.GET(request(undefined, "GET", undefined, { cookie: `${SESSION_COOKIE}=forged` }), ctx)).json();
    expect(body).not.toHaveProperty("url");
    expect(body.slug).toBe(fixture.slug);
  });

  it.each([
    [{ "user-agent": "curl/8.7.1" }, 403], [{ "sec-fetch-site": "cross-site" }, 403],
  ] as const)("keeps the existing request refusal %j", async (headers, status) => {
    expect((await product.GET(request(undefined, "GET", undefined, headers), ctx)).status).toBe(status);
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("IP limit and trap blocks still refuse before reading a product", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, count: 301, retryAfterSeconds: 120 });
    const response = await product.GET(request(), ctx);
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("120");
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("session read limits and unavailable policy never fall back to the minimal body", async () => {
    const headers = { cookie: `${SESSION_COOKIE}=${issueSession(request(), SIGNING).value}` };
    mocks.rate.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    expect((await product.GET(request(undefined, "GET", undefined, headers), ctx)).status).toBe(429);
    mocks.mode.mockRejectedValue(new Error("unavailable"));
    expect((await product.GET(request(), ctx)).status).toBe(503);
    expect(mocks.find).not.toHaveBeenCalled();
  });
});
