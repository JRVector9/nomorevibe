import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  productEvidenceAudit,
  productEvidenceSources,
  productAgents,
  productMedia,
  productMediaDeclarations,
  productProfiles,
  productSkills,
  productUpdates,
  products,
  rateLimits,
} from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens";
import { refreshProductEvidence } from "@/lib/domain/evidence/refresh";
import {
  getMakerLinksResource,
  getMakerMediaResource,
  getMakerProfileResource,
  getMakerProvenanceResource,
} from "@/lib/domain/evidence/repository";
import { GET as getProfile, PUT as putProfile } from "@/app/api/products/[slug]/profile/route";
import { GET as getLinks, PUT as putLinks } from "@/app/api/products/[slug]/links/route";
import { GET as getMedia, PUT as putMedia } from "@/app/api/products/[slug]/media/route";
import { GET as getProvenance, PUT as putProvenance } from "@/app/api/products/[slug]/provenance/route";
import { POST as postUpdate } from "@/app/api/products/[slug]/updates/route";
import {
  DELETE as deleteUpdate,
  PATCH as patchUpdate,
} from "@/app/api/products/[slug]/updates/[id]/route";
import { POST as queueRefresh } from "@/app/api/products/[slug]/refresh/route";
import { ensureSchema, resetTables } from "./setup";

const TOKEN = "nmv_edit_maker_evidence_api";
const PROFILE = {
  problem: "객관적인 제품 정보를 모으기 어렵습니다.",
  targetUsers: "AI 제품을 검토하는 사용자",
  keyFeatures: ["근거 수집"],
  useCases: ["도입 검토"],
  pricingModel: "freemium",
  lifecycle: "ga",
  platforms: ["Web"],
  privacySummary: "방문 이벤트에는 원본 IP를 저장하지 않습니다.",
  longDescriptionMarkdown: "## 상세 소개\n\n메이커가 직접 제공한 설명입니다.",
  team: [{ name: "Maker", role: "Founder" }],
  makerLicense: { value: "MIT", spdxId: "MIT" },
};

type Handler = (request: Request, context: never) => Promise<Response>;

function request(method: string, path: string, body?: unknown, token?: string, ifMatch?: string): Request {
  return new Request(`https://nomorevibe.test${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { "x-edit-token": token } : {}),
      ...(ifMatch ? { "if-match": ifMatch } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function slugContext(slug: string) {
  return { params: Promise.resolve({ slug }) } as never;
}

function updateContext(slug: string, id: number) {
  return { params: Promise.resolve({ slug, id: String(id) }) } as never;
}

const makerResourceReaders: Record<string, Handler> = {
  "/profile": getProfile as Handler,
  "/links": getLinks as Handler,
  "/media": getMedia as Handler,
  "/provenance": getProvenance as Handler,
};

async function replaceResource(handler: Handler, path: string, body: unknown, slug = "maker-api") {
  const baseline = await makerResourceReaders[path](
    request("GET", path, undefined, TOKEN),
    slugContext(slug),
  );
  const etag = baseline.headers.get("etag");
  expect(etag, path).toMatch(/^"[a-f0-9]{64}"$/);
  return handler(request("PUT", path, body, TOKEN, etag!), slugContext(slug));
}

async function insertProduct(slug: string, status: "verified" | "banned" = "verified") {
  const [product] = await db.insert(products).values({
    slug,
    url: `https://${slug}.example`,
    name: slug,
    tagline: "Maker evidence fixture",
    description: "Maker evidence fixture product",
    category: "Dev",
    status,
    source: "skill",
    verifyToken: `verify-${slug}`,
    editTokenHash: hashToken(TOKEN),
    verifiedAt: new Date(),
  }).returning({ id: products.id });
  return product;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(rateLimits);
  await insertProduct("maker-api");
  await insertProduct("banned-maker", "banned");
});

describe("maker evidence resource APIs", () => {
  it("requires a current resource version for valid replacement requests", async () => {
    const response = await (putLinks as Handler)(
      request("PUT", "/links", { links: [] }, TOKEN),
      slugContext("maker-api"),
    );
    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({ error: "최신 리소스 버전을 먼저 조회하세요" });
  });

  it("rejects stale merge-and-replace writes for every maker resource", async () => {
    const cases = [
      {
        get: getProfile as Handler,
        put: putProfile as Handler,
        path: "/profile",
        first: PROFILE,
        stale: { ...PROFILE, problem: "뒤늦은 소개" },
      },
      {
        get: getLinks as Handler,
        put: putLinks as Handler,
        path: "/links",
        first: { links: [{ kind: "documentation", url: "https://maker-api.example/docs" }] },
        stale: { links: [] },
      },
      {
        get: getMedia as Handler,
        put: putMedia as Handler,
        path: "/media",
        first: { items: [{ url: "https://maker-api.example/one.png", altText: "첫 화면" }] },
        stale: { items: [] },
      },
      {
        get: getProvenance as Handler,
        put: putProvenance as Handler,
        path: "/provenance",
        first: {
          agents: [{ provider: "OpenAI", roles: ["implementation"], evidenceLevel: "maker_reported" }],
          skills: [],
        },
        stale: { agents: [], skills: [] },
      },
    ];

    for (const item of cases) {
      const baseline = await item.get(request("GET", item.path, undefined, TOKEN), slugContext("maker-api"));
      const etag = baseline.headers.get("etag");
      expect(etag, item.path).toMatch(/^"[a-f0-9]{64}"$/);
      expect((await item.put(
        request("PUT", item.path, item.first, TOKEN, etag!),
        slugContext("maker-api"),
      )).status).toBeLessThan(300);

      const stale = await item.put(
        request("PUT", item.path, item.stale, TOKEN, etag!),
        slugContext("maker-api"),
      );
      expect(stale.status, item.path).toBe(412);
      expect(await stale.json()).toEqual({ error: "다른 변경이 먼저 저장됐습니다. 최신 정보를 다시 불러오세요" });

      const current = await item.get(request("GET", item.path, undefined, TOKEN), slugContext("maker-api"));
      expect(await current.json(), item.path).not.toEqual(item.stale);
    }
  });

  it("rejects merge reads for a replaced product generation", async () => {
    const old = await db.query.products.findFirst({ where: eq(products.slug, "maker-api") });
    expect(old).toBeDefined();
    await db.delete(products).where(eq(products.slug, "maker-api"));
    const replacement = await insertProduct("maker-api");
    expect(replacement.id).not.toBe(old!.id);

    for (const read of [
      getMakerProfileResource,
      getMakerLinksResource,
      getMakerMediaResource,
      getMakerProvenanceResource,
    ]) {
      await expect(read("maker-api", old!.id)).rejects.toThrow("product generation changed");
    }
  });

  it("serializes the maker provenance merge baseline with replacement", async () => {
    const product = await db.query.products.findFirst({ where: eq(products.slug, "maker-api") });
    expect(product).toBeDefined();
    await db.insert(productAgents).values({
      slug: "maker-api",
      provider: "OpenAI",
      roles: ["implementation"],
      evidenceLevel: "maker_reported",
    });
    await db.insert(productSkills).values({
      slug: "maker-api",
      namespace: "openai",
      name: "review",
      evidenceLevel: "maker_reported",
    });

    let release!: () => void;
    let signalHeld!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('product-provenance:maker-api'))`);
      signalHeld();
      await gate;
    });
    await held;

    let settled = false;
    const reading = getMakerProvenanceResource("maker-api", product!.id).then((value) => {
      settled = true;
      return value;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      release();
      await holder;
    }
    await expect(reading).resolves.toMatchObject({
      agents: [{ provider: "OpenAI" }],
      skills: [{ namespace: "openai", name: "review" }],
    });
  });

  it("preserves a stronger retained skill when a maker submits the same identity", async () => {
    await db.insert(productSkills).values({
      slug: "maker-api",
      namespace: "openai",
      name: "review",
      version: "1.0.0",
      commit: "b".repeat(40),
      evidenceLevel: "repository_evidenced",
    });
    const response = await replaceResource(putProvenance as Handler, "/provenance", {
      agents: [{ provider: "OpenAI", roles: ["implementation"], evidenceLevel: "maker_reported" }],
      skills: [{
        namespace: "openai",
        name: "review",
        version: "1.0.0",
        commit: "b".repeat(40),
        evidenceLevel: "maker_reported",
      }],
    });
    expect(response.status).toBe(200);
    expect(await db.select().from(productAgents)).toHaveLength(1);
    expect(await db.select().from(productSkills)).toEqual([
      expect.objectContaining({ evidenceLevel: "repository_evidenced" }),
    ]);
  });

  it("returns authenticated merge-ready maker resources without internal fields", async () => {
    await replaceResource(putProfile as Handler, "/profile", PROFILE);
    await replaceResource(putLinks as Handler, "/links", {
      links: [{ kind: "repository", url: "https://github.com/Example/Maker-API" }],
    });
    await replaceResource(putMedia as Handler, "/media", {
      items: [{ url: "https://maker-api.example/gallery.png", altText: "Maker API 화면" }],
    });
    await replaceResource(putProvenance as Handler, "/provenance", {
      agents: [{ provider: "OpenAI", client: "Codex", roles: ["implementation"], evidenceLevel: "maker_reported" }],
      skills: [{ namespace: "openai", name: "review", evidenceLevel: "maker_reported" }],
    });
    await db.insert(productAgents).values({
      slug: "maker-api",
      provider: "GitHub",
      roles: ["testing"],
      evidenceLevel: "repository_evidenced",
    });
    await db.insert(productSkills).values({
      slug: "maker-api",
      namespace: "github",
      name: "actions",
      evidenceLevel: "repository_evidenced",
    });

    const cases = [
      { handler: getProfile as Handler, path: "/profile", expected: { profile: PROFILE } },
      {
        handler: getLinks as Handler,
        path: "/links",
        expected: { links: [{ kind: "repository", url: "https://github.com/example/maker-api" }] },
      },
      {
        handler: getMedia as Handler,
        path: "/media",
        expected: { items: [{ url: "https://maker-api.example/gallery.png", altText: "Maker API 화면" }] },
      },
      {
        handler: getProvenance as Handler,
        path: "/provenance",
        expected: {
          agents: [{ provider: "OpenAI", client: "Codex", roles: ["implementation"], evidenceLevel: "maker_reported" }],
          skills: [{ namespace: "openai", name: "review", evidenceLevel: "maker_reported" }],
        },
      },
    ];
    for (const item of cases) {
      expect((await item.handler(request("GET", item.path), slugContext("maker-api"))).status).toBe(401);
      const response = await item.handler(request("GET", item.path, undefined, TOKEN), slugContext("maker-api"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = await response.json();
      expect(body).toEqual(item.expected);
      expect(JSON.stringify(body)).not.toMatch(/(?:slug|createdAt|updatedAt|evidenceLabel|revision|nextAttemptAt)/);
    }

    expect((await replaceResource(putProvenance as Handler, "/provenance", {
      agents: [{ provider: "OpenAI", client: "Codex", roles: ["implementation"], evidenceLevel: "maker_reported" }],
      skills: [{ namespace: "openai", name: "review", evidenceLevel: "maker_reported" }],
    })).status).toBe(200);
    expect(await db.select().from(productAgents)).toHaveLength(2);
    expect(await db.select().from(productSkills)).toHaveLength(2);
  });

  it("authenticates every resource before mutation and rejects banned products", async () => {
    const [automatic] = await db.insert(productUpdates).values({
      slug: "maker-api",
      sourceKind: "github_release",
      dedupeKey: "release:automatic",
      title: "automatic",
      observedAt: new Date(),
    }).returning({ id: productUpdates.id });
    const cases: Array<{ handler: Handler; request: Request; context: never }> = [
      { handler: putProfile as Handler, request: request("PUT", "/profile", PROFILE), context: slugContext("maker-api") },
      { handler: putLinks as Handler, request: request("PUT", "/links", { links: [] }), context: slugContext("maker-api") },
      { handler: putMedia as Handler, request: request("PUT", "/media", { items: [] }), context: slugContext("maker-api") },
      { handler: putProvenance as Handler, request: request("PUT", "/provenance", { agents: [], skills: [] }), context: slugContext("maker-api") },
      { handler: postUpdate as Handler, request: request("POST", "/updates", { title: "update" }), context: slugContext("maker-api") },
      { handler: patchUpdate as Handler, request: request("PATCH", "/updates/1", { title: "update" }), context: updateContext("maker-api", automatic.id) },
      { handler: deleteUpdate as Handler, request: request("DELETE", "/updates/1"), context: updateContext("maker-api", automatic.id) },
      { handler: queueRefresh as Handler, request: request("POST", "/refresh"), context: slugContext("maker-api") },
    ];
    for (const item of cases) {
      expect((await item.handler(item.request, item.context)).status).toBe(401);
      const wrong = new Request(item.request, { headers: { "x-edit-token": "wrong-token" } });
      expect((await item.handler(wrong, item.context)).status).toBe(403);
    }

    const banned = await (putProfile as Handler)(
      request("PUT", "/profile", PROFILE, TOKEN),
      slugContext("banned-maker"),
    );
    expect(banned.status).toBe(403);
    expect(await db.select().from(productProfiles)).toHaveLength(0);
    expect(await db.select().from(rateLimits)).toHaveLength(0);
  });

  it("replaces maker resources transactionally, labels provenance, and preserves observations", async () => {
    const observedFacts = { type: "github_repository", stars: 41, license: { spdxId: "Apache-2.0" } };
    await db.insert(productEvidenceSources).values({
      slug: "maker-api",
      kind: "repository",
      provider: "github",
      sourceKey: "example/maker-api",
      sourceUrl: "https://github.com/example/maker-api",
      state: "ok",
      normalizedFacts: observedFacts,
      nextAttemptAt: new Date("2030-01-01T00:00:00.000Z"),
    });

    expect((await replaceResource(putProfile as Handler, "/profile", PROFILE)).status).toBe(200);
    expect((await replaceResource(putLinks as Handler, "/links", {
      links: [{ kind: "repository", url: "https://github.com/Example/Maker-API" }],
    })).status).toBe(200);
    expect((await replaceResource(putMedia as Handler, "/media", {
      items: [{ url: "https://maker-api.example/gallery.png", altText: "Maker API 화면" }],
    })).status).toBe(202);
    expect((await replaceResource(putProvenance as Handler, "/provenance", {
      agents: [{ provider: "OpenAI", client: "Codex", roles: ["implementation"], evidenceLevel: "maker_reported" }],
      skills: [{ namespace: "openai", name: "review", evidenceLevel: "maker_reported" }],
    })).status).toBe(200);

    expect(await db.query.productProfiles.findFirst({ where: eq(productProfiles.slug, "maker-api") }))
      .toMatchObject({ lifecycle: "ga", pricingModel: "freemium" });
    expect(await db.select().from(productMedia)).toHaveLength(0);
    expect(await db.query.productMediaDeclarations.findFirst({
      where: eq(productMediaDeclarations.slug, "maker-api"),
    })).toMatchObject({ altText: "Maker API 화면", position: 0 });
    const refresh = await refreshProductEvidence("maker-api", {
      force: true,
      dependencies: {
        image: async () => ({
          ok: true,
          asset: {
            hash: "d".repeat(64),
            mimeType: "image/webp",
            web: { data: Buffer.from("web"), width: 800, height: 500, size: 3 },
            thumbnail: { data: Buffer.from("thumb"), width: 400, height: 250, size: 5 },
          },
          finalUrl: "https://maker-api.example/gallery.png",
        }),
      },
    });
    expect(refresh.mediaInserted).toBe(1);
    expect(await db.query.productMedia.findFirst({ where: eq(productMedia.slug, "maker-api") }))
      .toMatchObject({ sourceUrl: "https://maker-api.example/gallery.png", current: true });
    expect((await db.query.productEvidenceSources.findFirst({
      where: eq(productEvidenceSources.slug, "maker-api"),
    }))?.normalizedFacts).toEqual(observedFacts);
    const responseText = JSON.stringify(await (await replaceResource(
      putLinks as Handler,
      "/links",
      { links: [] },
    )).json());
    expect(responseText).not.toContain(TOKEN);
    expect(responseText).not.toContain("Apache-2.0");
  });

  it("creates, edits, and tombstones only maker-authored updates", async () => {
    const createdResponse = await (postUpdate as Handler)(request("POST", "/updates", {
      title: "메이커 업데이트",
      summary: "첫 설명",
      canonicalUrl: "https://maker-api.example/changelog/1",
    }, TOKEN), slugContext("maker-api"));
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: number };

    expect((await (patchUpdate as Handler)(request("PATCH", "/updates/1", {
      title: "수정된 업데이트",
      summary: "수정 설명",
    }, TOKEN), updateContext("maker-api", created.id))).status).toBe(200);
    expect((await (deleteUpdate as Handler)(request(
      "DELETE",
      "/updates/1",
      undefined,
      TOKEN,
    ), updateContext("maker-api", created.id))).status).toBe(200);
    expect(await db.query.productUpdates.findFirst({ where: eq(productUpdates.id, created.id) }))
      .toMatchObject({ title: "수정된 업데이트" });
    expect((await db.query.productUpdates.findFirst({ where: eq(productUpdates.id, created.id) }))
      ?.makerDeletedAt).toBeInstanceOf(Date);

    const [automatic] = await db.insert(productUpdates).values({
      slug: "maker-api",
      sourceKind: "github_release",
      dedupeKey: "release:auto",
      title: "automatic",
      observedAt: new Date(),
    }).returning({ id: productUpdates.id });
    expect((await (patchUpdate as Handler)(request("PATCH", "/updates/2", {
      title: "침범",
    }, TOKEN), updateContext("maker-api", automatic.id))).status).toBe(403);
    expect((await (deleteUpdate as Handler)(request(
      "DELETE",
      "/updates/2",
      undefined,
      TOKEN,
    ), updateContext("maker-api", automatic.id))).status).toBe(403);
  });

  it("queues refresh without provider I/O and rate-limits it once per product per hour", async () => {
    await db.insert(productEvidenceSources).values({
      slug: "maker-api",
      kind: "repository",
      provider: "github",
      sourceKey: "example/maker-api",
      state: "ok",
      normalizedFacts: { type: "github_repository", secretUpstreamBody: "must-stay-private" },
      nextAttemptAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    const first = await (queueRefresh as Handler)(
      request("POST", "/refresh", undefined, TOKEN),
      slugContext("maker-api"),
    );
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ queued: true });
    expect((await db.query.productEvidenceSources.findFirst({
      where: eq(productEvidenceSources.slug, "maker-api"),
    }))?.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    const second = await (queueRefresh as Handler)(
      request("POST", "/refresh", undefined, TOKEN),
      slugContext("maker-api"),
    );
    expect(second.status).toBe(429);
    expect(JSON.stringify(await second.json())).not.toContain("must-stay-private");
    expect((await db.select().from(productEvidenceAudit)
      .where(eq(productEvidenceAudit.slug, "maker-api")))
      .map((row) => row.action)).toContain("maker.refresh.queue");
  });

  it("charges invalid bodies before parsing without creating a global direct-IP bucket", async () => {
    const priorHops = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = "0";
    try {
      const product = await db.query.products.findFirst({ where: eq(products.slug, "maker-api") });
      expect(product).toBeDefined();
      const oversized = new Request("https://nomorevibe.test/profile", {
        method: "PUT",
        headers: {
          "content-length": String(70 * 1024),
          "content-type": "application/json",
          "x-edit-token": TOKEN,
        },
        body: "{}",
      });
      expect((await (putProfile as Handler)(oversized, slugContext("maker-api"))).status).toBe(413);
      expect((await (putProfile as Handler)(
        request("PUT", "/profile", {}, TOKEN),
        slugContext("maker-api"),
      )).status).toBe(400);

      const limits = await db.select().from(rateLimits);
      expect(limits).toContainEqual(expect.objectContaining({
        key: `maker:profile:product:${product!.id}`,
        count: 2,
      }));
      expect(limits.some((row) => row.key.includes(":ip:direct"))).toBe(false);
    } finally {
      if (priorHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = priorHops;
    }
  });

  it("uses trusted client IP buckets and product-generation buckets", async () => {
    const priorHops = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = "1";
    try {
      const firstProduct = await db.query.products.findFirst({ where: eq(products.slug, "maker-api") });
      expect(firstProduct).toBeDefined();
      const firstRequest = new Request("https://nomorevibe.test/refresh", {
        method: "POST",
        headers: { "x-edit-token": TOKEN, "x-forwarded-for": "198.51.100.10" },
      });
      expect((await (queueRefresh as Handler)(firstRequest, slugContext("maker-api"))).status).toBe(202);

      await db.delete(products).where(eq(products.slug, "maker-api"));
      const replacement = await insertProduct("maker-api");
      expect(replacement.id).not.toBe(firstProduct!.id);
      const replacementRequest = new Request("https://nomorevibe.test/refresh", {
        method: "POST",
        headers: { "x-edit-token": TOKEN, "x-forwarded-for": "198.51.100.11" },
      });
      expect((await (queueRefresh as Handler)(replacementRequest, slugContext("maker-api"))).status).toBe(202);

      const keys = (await db.select().from(rateLimits)).map((row) => row.key);
      expect(keys).toContain("maker:refresh:ip:198.51.100.10");
      expect(keys).toContain("maker:refresh:ip:198.51.100.11");
      expect(keys).toContain(`maker:refresh:product:${firstProduct!.id}`);
      expect(keys).toContain(`maker:refresh:product:${replacement.id}`);
    } finally {
      if (priorHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = priorHops;
    }
  });

  it("does not publish a gallery response after its declaration is removed or revised", async () => {
    const sourceUrl = "https://maker-api.example/racing-gallery.png";
    const declare = (altText: string) => replaceResource(putMedia as Handler, "/media", {
      items: [{ url: sourceUrl, altText }],
    });
    expect((await declare("이전 설명")).status).toBe(202);

    async function pausedRefresh(onStarted: () => void, gate: Promise<void>, hash: string) {
      return refreshProductEvidence("maker-api", {
        force: true,
        dependencies: {
          image: async () => {
            onStarted();
            await gate;
            return {
              ok: true as const,
              asset: {
                hash,
                mimeType: "image/webp",
                web: { data: Buffer.from("web"), width: 800, height: 500, size: 3 },
                thumbnail: { data: Buffer.from("thumb"), width: 400, height: 250, size: 5 },
              },
              finalUrl: sourceUrl,
            };
          },
        },
      });
    }

    let releaseRemoved!: () => void;
    let startedRemoved!: () => void;
    const removedGate = new Promise<void>((resolve) => { releaseRemoved = resolve; });
    const removedStarted = new Promise<void>((resolve) => { startedRemoved = resolve; });
    const removingRefresh = pausedRefresh(startedRemoved, removedGate, "e".repeat(64));
    await removedStarted;
    expect((await replaceResource(putMedia as Handler, "/media", { items: [] })).status).toBe(202);
    releaseRemoved();
    expect(await removingRefresh).toMatchObject({ mediaInserted: 0, sourcesFailed: 1 });
    expect(await db.select().from(productMedia)).toHaveLength(0);

    expect((await declare("수정 전 설명")).status).toBe(202);
    let releaseRevised!: () => void;
    let startedRevised!: () => void;
    const revisedGate = new Promise<void>((resolve) => { releaseRevised = resolve; });
    const revisedStarted = new Promise<void>((resolve) => { startedRevised = resolve; });
    const revisingRefresh = pausedRefresh(startedRevised, revisedGate, "f".repeat(64));
    await revisedStarted;
    expect((await declare("수정된 설명")).status).toBe(202);
    releaseRevised();
    expect(await revisingRefresh).toMatchObject({ mediaInserted: 0, sourcesFailed: 1 });
    expect(await db.select().from(productMedia)).toHaveLength(0);
  });
});
