import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import {
  clickEvents,
  mediaAssets,
  productAgents,
  productEvidenceSources,
  productHealth,
  productHealthDaily,
  productLinks,
  productMedia,
  productProfiles,
  productSkills,
  productUpdates,
  products,
  rankingEntries,
  rankingPolicyRevisions,
  rankingSeasons,
  visitCollectionState,
  type ProductStatus,
} from "@/lib/db/schema";
import {
  getProductDetail,
  getProductIdentity,
} from "@/lib/domain/products/detail-view";
import { UNIQUE_FIRST_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { ensureSchema, resetTables } from "./setup";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const now = () => new Date();
const ago = (milliseconds: number) => new Date(Date.now() - milliseconds);

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

async function insertProduct(slug: string, status: ProductStatus = "verified") {
  const [product] = await db.insert(products).values({
    slug,
    url: `https://${slug}.example`,
    name: slug.replaceAll("-", " "),
    tagline: `${slug} tagline`,
    description: `${slug} description`,
    category: "Dev",
    status,
    source: status === "seeded" ? "crawler" : "skill",
    claimedAt: status === "seeded" ? null : ago(30 * DAY),
    verifiedAt: status === "verified" ? ago(20 * DAY) : null,
    verifyToken: `verify-${slug}`,
    editTokenHash: "a".repeat(64),
  }).returning();
  return product;
}

describe("public product detail read model", () => {
  it("composes rich stored evidence in parallel-safe public shapes", async () => {
    const product = await insertProduct("detail-rich");
    await db.insert(productProfiles).values({
      slug: product.slug,
      problem: "객관적 제품 정보를 한곳에서 보기 어렵습니다.",
      targetUsers: "AI 제품을 검토하는 사람",
      keyFeatures: ["근거", "업데이트"],
      useCases: ["도입 검토"],
      pricingModel: "freemium",
      pricingUrl: "https://detail-rich.example/pricing",
      lifecycle: "ga",
      platforms: ["Web"],
      privacySummary: "브라우저에서 처리합니다.",
      longDescriptionMarkdown: "## 상세 소개",
      team: [{ name: "Maker", role: "Builder" }],
      makerLicense: { value: "MIT", spdxId: "MIT" },
    });
    await db.insert(productLinks).values([
      {
        slug: product.slug,
        kind: "repository",
        declarationSource: "maker",
        url: "https://github.com/example/detail-rich",
        normalizedKey: "example/detail-rich",
        verificationState: "ok",
        relationshipState: "bidirectional",
        verifiedAt: ago(DAY),
      },
      {
        slug: product.slug,
        kind: "npm",
        declarationSource: "maker",
        url: "https://www.npmjs.com/package/detail-rich",
        normalizedKey: "detail-rich",
        verificationState: "unobserved",
      },
    ]);
    await db.insert(productEvidenceSources).values({
      slug: product.slug,
      kind: "repository",
      provider: "github",
      sourceKey: "example/detail-rich",
      sourceUrl: "https://github.com/example/detail-rich",
      state: "ok",
      normalizedFacts: {
        type: "github_repository",
        repositoryKey: "example/detail-rich",
        repositoryUrl: "https://github.com/example/detail-rich",
        createdAt: ago(400 * DAY).toISOString(),
        pushedAt: ago(DAY).toISOString(),
        updatedAt: ago(DAY).toISOString(),
        stars: 146,
        forks: 18,
        public: true,
        archived: false,
        fork: false,
        homepage: "https://detail-rich.example",
        contributors: { count: 12, incomplete: false, cap: 500 },
        license: { value: "MIT License", spdxId: "MIT", url: null },
        languages: [{ name: "TypeScript", bytes: 82_000, percent: 82 }],
        latestRelease: {
          id: 16,
          tagName: "v1.6.0",
          name: "v1.6.0",
          url: "https://github.com/example/detail-rich/releases/tag/v1.6.0",
          notesUrl: "https://github.com/example/detail-rich/releases/tag/v1.6.0",
          publishedAt: ago(5 * DAY).toISOString(),
        },
        relationshipState: "bidirectional",
      },
      observedAt: ago(DAY),
      lastSuccessAt: ago(DAY),
      nextAttemptAt: new Date(Date.now() + DAY),
    });
    const hash = "b".repeat(64);
    await db.insert(mediaAssets).values({
      hash,
      webData: Buffer.from("web"),
      thumbnailData: Buffer.from("thumb"),
      width: 960,
      height: 600,
      thumbnailWidth: 480,
      thumbnailHeight: 300,
      mimeType: "image/webp",
      webSize: 3,
      thumbnailSize: 5,
    });
    await db.insert(productMedia).values({
      slug: product.slug,
      sourceUrl: "https://detail-rich.example/gallery.png",
      assetHash: hash,
      position: 0,
      altText: "제품 근거 대시보드",
      lastObservedAt: ago(DAY),
      lastSuccessAt: ago(DAY),
    });
    await db.insert(productUpdates).values([
      {
        slug: product.slug,
        sourceKind: "maker",
        dedupeKey: "maker:1",
        title: "메이커 업데이트",
        observedAt: ago(HOUR),
      },
      {
        slug: product.slug,
        sourceKind: "github_release",
        dedupeKey: "release:1",
        title: "v1.6.0 공개",
        canonicalUrl: "https://github.com/example/detail-rich/releases/tag/v1.6.0",
        observedAt: ago(5 * DAY),
      },
      {
        slug: product.slug,
        sourceKind: "feed",
        dedupeKey: "hidden:1",
        title: "숨긴 업데이트",
        visible: false,
        observedAt: ago(2 * HOUR),
      },
    ]);
    await db.insert(productAgents).values({
      slug: product.slug,
      provider: "OpenAI",
      client: "Codex",
      roles: ["implementation", "review"],
      evidenceLevel: "maker_reported",
    });
    await db.insert(productSkills).values({
      slug: product.slug,
      namespace: "openai",
      name: "review",
      version: "1.0.0",
      evidenceLevel: "maker_reported",
    });
    await db.update(visitCollectionState).set({ uniqueVisitorStartedAt: ago(10 * DAY) });
    await db.insert(clickEvents).values([
      { slug: product.slug, visitorHash: "1".repeat(64), occurredAt: ago(HOUR) },
      { slug: product.slug, visitorHash: "2".repeat(64), occurredAt: ago(2 * HOUR) },
      { slug: product.slug, visitorHash: "3".repeat(64), occurredAt: ago(3 * HOUR) },
      { slug: product.slug, visitorHash: "1".repeat(64), occurredAt: ago(4 * HOUR) },
    ]);
    await db.insert(productHealth).values({
      slug: product.slug,
      status: 200,
      latencyMs: 84,
      failures: 0,
      checkedAt: ago(HOUR),
    });
    await db.insert(productHealthDaily).values({
      slug: product.slug,
      day: now().toISOString().slice(0, 10),
      checks: 10,
      successes: 9,
      latencyTotalMs: 840,
      latencySamples: 10,
    });
    const [revision] = await db.insert(rankingPolicyRevisions).values({
      values: UNIQUE_FIRST_RANKING_POLICY,
      state: "applied",
      createdBy: "test",
      appliedAt: ago(7 * DAY),
    }).returning({ id: rankingPolicyRevisions.id });
    const [season] = await db.insert(rankingSeasons).values({
      key: "2026-W34-detail",
      cadence: "weekly",
      startsAt: ago(7 * DAY),
      endsAt: new Date(Date.now() + DAY),
      state: "active",
      policyRevisionId: revision.id,
      policySnapshot: UNIQUE_FIRST_RANKING_POLICY,
      effectiveLaunchWindowDays: 28,
    }).returning({ id: rankingSeasons.id });
    await db.insert(rankingEntries).values({
      seasonId: season.id,
      slug: product.slug,
      validClicks: 4,
      uniqueVisitors: 3,
      scoreUnits: 32_500,
      rank: 2,
    });

    const view = await getProductDetail(product.slug);

    const identity = await getProductIdentity(product.slug);
    expect(identity).toMatchObject({ id: product.id, slug: product.slug });
    expect(identity).not.toHaveProperty("verifyToken");
    expect(identity).not.toHaveProperty("verifyMethod");
    expect(identity).not.toHaveProperty("editTokenHash");
    expect(view?.product).not.toHaveProperty("verifyToken");
    expect(view?.product).not.toHaveProperty("verifyMethod");
    expect(view?.product).not.toHaveProperty("editTokenHash");
    expect(view).toMatchObject({
      product: { slug: product.slug },
      unclaimed: false,
      rank: { seasonKey: "2026-W34-detail", rank: 2, scoreMode: "unique_visitors" },
      visits: { periodDays: 7, validVisits: 4, uniqueVisitors: 3, collecting: false },
      health: { uptime30d: 90, latencyMs: 84, down: false },
      repository: {
        provider: "github",
        state: "ok",
        facts: { stars: 146, contributors: { count: 12 }, latestRelease: { tagName: "v1.6.0" } },
      },
      license: { state: "matched", label: "GitHub에서 확인", maker: { spdxId: "MIT" }, observed: { spdxId: "MIT" } },
      media: [{ hash, src: `/api/media/${hash}`, width: 960, height: 600, altText: "제품 근거 대시보드" }],
      updates: [{ title: "메이커 업데이트" }, { title: "v1.6.0 공개" }],
      agents: [{ provider: "OpenAI", evidenceLabel: "메이커 제공" }],
      skills: [{ name: "review", evidenceLabel: "메이커 제공" }],
      freshness: [{ kind: "repository", state: "current", label: "최신" }],
    });
    expect(view?.links.map((link) => link.evidenceLabel)).toEqual([
      "공식 출처에서 확인",
      "메이커 제공·미검증",
    ]);
    expect(view?.updates.map((update) => update.title)).not.toContain("숨긴 업데이트");
  });

  it("represents unclaimed collecting and empty states without false zeroes", async () => {
    const product = await insertProduct("detail-collecting", "seeded");
    await db.insert(productLinks).values({
      slug: product.slug,
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/detail-collecting",
      normalizedKey: "example/detail-collecting",
      verificationState: "unobserved",
    });
    await db.insert(productEvidenceSources).values({
      slug: product.slug,
      kind: "repository",
      provider: "github",
      sourceKey: "example/detail-collecting",
      state: "unobserved",
    });

    await expect(getProductDetail(product.slug)).resolves.toMatchObject({
      unclaimed: true,
      rank: null,
      visits: { validVisits: 0, uniqueVisitors: null, collecting: true, collectionStartedAt: null },
      health: { uptime30d: null, latencyMs: null, checkedAt: null, down: false },
      profile: null,
      repository: { state: "unobserved", facts: null },
      license: { state: "missing", label: "라이선스 확인 안 됨", maker: null, observed: null },
      media: [],
      updates: [],
      agents: [],
      skills: [],
      freshness: [{ state: "collecting", label: "집계 중" }],
    });
  });

  it("retains both conflicting licenses and distinguishes delayed from old data", async () => {
    const product = await insertProduct("detail-stale");
    await db.insert(productProfiles).values({
      slug: product.slug,
      pricingModel: "paid",
      lifecycle: "maintenance",
      longDescriptionMarkdown: "Stale",
      makerLicense: { value: "MIT", spdxId: "MIT" },
    });
    await db.insert(productLinks).values([
      {
        slug: product.slug,
        kind: "repository",
        declarationSource: "maker",
        url: "https://github.com/example/detail-stale",
        normalizedKey: "example/detail-stale",
        verificationState: "ok",
      },
      {
        slug: product.slug,
        kind: "changelog",
        declarationSource: "maker",
        url: "https://detail-stale.example/changelog",
        normalizedKey: "https://detail-stale.example/changelog",
        verificationState: "ok",
      },
    ]);
    await db.insert(productEvidenceSources).values([
      {
        slug: product.slug,
        kind: "repository",
        provider: "github",
        sourceKey: "example/detail-stale",
        state: "stale",
        normalizedFacts: {
          type: "github_repository",
          license: { value: "Apache License 2.0", spdxId: "Apache-2.0", url: null },
          stars: 10,
        },
        lastSuccessAt: ago(10 * DAY),
        lastFailureAt: ago(DAY),
        nextAttemptAt: ago(HOUR),
      },
      {
        slug: product.slug,
        kind: "changelog",
        provider: "changelog",
        sourceKey: "https://detail-stale.example/changelog",
        state: "stale",
        normalizedFacts: { type: "link", reachable: true },
        lastSuccessAt: ago(15 * HOUR),
        lastFailureAt: ago(HOUR),
        nextAttemptAt: ago(HOUR),
      },
    ]);
    await db.insert(productHealth).values({
      slug: product.slug,
      status: 503,
      failures: 3,
      checkedAt: ago(HOUR),
      downSince: ago(DAY),
    });

    const view = await getProductDetail(product.slug);
    expect(view?.license).toMatchObject({
      state: "conflict",
      label: "정보 충돌",
      maker: { spdxId: "MIT" },
      observed: { spdxId: "Apache-2.0" },
    });
    expect(view?.freshness).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "repository", state: "stale", label: "오래된 정보" }),
      expect.objectContaining({ kind: "changelog", state: "delayed", label: "갱신 지연" }),
    ]));
    expect(view?.health.down).toBe(true);
  });

  it("keeps last-known facts when a source becomes disconnected", async () => {
    const product = await insertProduct("detail-disconnected");
    await db.insert(productLinks).values({
      slug: product.slug,
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/detail-disconnected",
      normalizedKey: "example/detail-disconnected",
      verificationState: "disconnected",
    });
    await db.insert(productEvidenceSources).values({
      slug: product.slug,
      kind: "repository",
      provider: "github",
      sourceKey: "example/detail-disconnected",
      state: "disconnected",
      normalizedFacts: {
        type: "github_repository",
        stars: 31,
        license: null,
        relationshipState: "disconnected",
      },
      lastSuccessAt: ago(3 * DAY),
      lastFailureAt: ago(HOUR),
      nextAttemptAt: ago(HOUR),
    });

    const view = await getProductDetail(product.slug);
    expect(view?.repository).toMatchObject({
      state: "disconnected",
      facts: { stars: 31, relationshipState: "disconnected" },
    });
    expect(view?.freshness).toEqual([
      expect.objectContaining({ state: "disconnected", label: "연결 끊김" }),
    ]);
    expect(view?.license).toMatchObject({ state: "missing", label: "라이선스 확인 안 됨" });
  });

  it("exposes only evidence still attached to a visible current link", async () => {
    const product = await insertProduct("detail-current-source");
    await db.insert(productLinks).values({
      slug: product.slug,
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/current-source",
      normalizedKey: "example/current-source",
      verificationState: "ok",
    });
    await db.insert(productEvidenceSources).values([
      {
        slug: product.slug,
        kind: "repository",
        provider: "github",
        sourceKey: "example/removed-source",
        sourceUrl: "https://github.com/example/removed-source",
        state: "ok",
        normalizedFacts: { type: "github_repository", stars: 999 },
        lastSuccessAt: ago(DAY),
      },
      {
        slug: product.slug,
        kind: "repository",
        provider: "github",
        sourceKey: "example/current-source",
        sourceUrl: "https://github.com/example/current-source",
        state: "ok",
        normalizedFacts: { type: "github_repository", stars: 12 },
        lastSuccessAt: ago(DAY),
      },
    ]);

    const view = await getProductDetail(product.slug);

    expect(view?.repository?.sourceUrl).toBe("https://github.com/example/current-source");
    expect(view?.repository?.facts?.stars).toBe(12);
    expect(view?.freshness).toHaveLength(1);
  });

  it("keeps failed sources visibly failed regardless of prior success", async () => {
    const product = await insertProduct("detail-failed-source");
    await db.insert(productLinks).values([
      {
        slug: product.slug,
        kind: "repository",
        declarationSource: "maker",
        url: "https://github.com/example/detail-failed-source",
        normalizedKey: "example/detail-failed-source",
        verificationState: "failed",
      },
      {
        slug: product.slug,
        kind: "changelog",
        declarationSource: "maker",
        url: "https://detail-failed-source.example/changelog",
        normalizedKey: "https://detail-failed-source.example/changelog",
        verificationState: "failed",
      },
    ]);
    await db.insert(productEvidenceSources).values([
      {
        slug: product.slug,
        kind: "repository",
        provider: "github",
        sourceKey: "example/detail-failed-source",
        state: "failed",
        lastFailureAt: ago(HOUR),
      },
      {
        slug: product.slug,
        kind: "changelog",
        provider: "changelog",
        sourceKey: "https://detail-failed-source.example/changelog",
        state: "failed",
        lastSuccessAt: ago(30 * DAY),
        lastFailureAt: ago(HOUR),
      },
    ]);

    const view = await getProductDetail(product.slug);

    expect(view?.freshness).toEqual([
      expect.objectContaining({ kind: "repository", state: "failed", label: "최근 갱신 실패" }),
      expect.objectContaining({ kind: "changelog", state: "failed", label: "최근 갱신 실패" }),
    ]);
  });

  it("does not open a locking transaction for provenance on a public read", async () => {
    const product = await insertProduct("detail-lock-free");
    await db.insert(productAgents).values({
      slug: product.slug,
      provider: "OpenAI",
      roles: ["implementation"],
      evidenceLevel: "maker_reported",
    });
    const initializedDb = (globalThis as unknown as { db?: typeof db }).db;
    expect(initializedDb).toBeDefined();
    const transaction = vi.spyOn(initializedDb!, "transaction");
    try {
      await expect(getProductDetail(product.slug)).resolves.toMatchObject({
        agents: [{ provider: "OpenAI" }],
      });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it("drops a detail assembled across a concurrent ban", async () => {
    const product = await insertProduct("detail-concurrent-ban");
    const findFirst = db.query.products.findFirst.bind(db.query.products);
    const concurrentBan = async (options: Parameters<typeof findFirst>[0]) => {
      const identity = await findFirst(options);
      await db.update(products).set({ status: "banned" }).where(eq(products.id, product.id));
      return identity;
    };
    const identityRead = vi.spyOn(db.query.products, "findFirst");
    identityRead.mockImplementationOnce(concurrentBan as unknown as typeof findFirst);
    try {
      await expect(getProductDetail(product.slug)).resolves.toBeNull();
    } finally {
      identityRead.mockRestore();
    }
  });

  it("returns null for banned and missing products", async () => {
    await insertProduct("detail-banned", "banned");
    await expect(getProductIdentity("detail-banned")).resolves.toBeNull();
    await expect(getProductDetail("detail-banned")).resolves.toBeNull();
    await expect(getProductDetail("detail-missing")).resolves.toBeNull();
  });
});
