import { createHash } from "node:crypto";
import sharp from "sharp";
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
} from "@/lib/db/schema";
import { UNIQUE_FIRST_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { hashToken } from "@/lib/tokens";
import { ensureSchema, resetTables } from "@/tests/integration/setup";

export const PRODUCT_DETAIL_FIXTURES = {
  rich: "e2e-rich",
  collecting: "e2e-collecting",
  staleConflict: "e2e-stale-conflict",
  unclaimed: "e2e-unclaimed",
} as const;

const EDIT_TOKEN = "nmv_edit_e2e_product_detail";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

async function insertProduct(
  slug: string,
  status: "verified" | "seeded",
  name: string,
): Promise<void> {
  await db.insert(products).values({
    slug,
    url: `https://${slug}.example`,
    name,
    tagline: `${name}의 근거 기반 제품 소개`,
    description: `${name}은 AI로 만든 제품을 실제 사용자에게 설명하는 테스트 제품입니다.`,
    category: "Dev",
    status,
    source: status === "seeded" ? "crawler" : "skill",
    claimedAt: status === "seeded" ? null : daysAgo(30),
    verifiedAt: status === "seeded" ? null : daysAgo(29),
    verifyToken: `verify-${slug}`,
    editTokenHash: hashToken(EDIT_TOKEN),
    makerName: status === "seeded" ? null : "NoMoreVibe Fixture Team",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
  });
}

export async function seedProductDetailFixtures(): Promise<void> {
  ensureSchema();
  await resetTables();

  await insertProduct(PRODUCT_DETAIL_FIXTURES.rich, "verified", "Evidence Studio");
  await insertProduct(PRODUCT_DETAIL_FIXTURES.collecting, "verified", "Early Signal");
  await insertProduct(PRODUCT_DETAIL_FIXTURES.staleConflict, "verified", "Conflict Lens");
  await insertProduct(PRODUCT_DETAIL_FIXTURES.unclaimed, "seeded", "Open Seed");

  await db.insert(productProfiles).values([
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      problem: "흩어진 제품 근거와 업데이트를 한 화면에서 확인하기 어렵습니다.",
      targetUsers: "AI 제품을 비교하는 방문자와 신뢰 가능한 프로필을 관리하는 메이커",
      keyFeatures: ["출처별 객관 정보", "내부 보관 갤러리", "통합 업데이트"],
      useCases: ["도입 전 검토", "공개 프로필 공유"],
      pricingModel: "freemium",
      pricingUrl: `https://${PRODUCT_DETAIL_FIXTURES.rich}.example/pricing`,
      lifecycle: "ga",
      platforms: ["Web", "macOS"],
      privacySummary: "브라우저에서 처리하며 원본 문서를 서버로 업로드하지 않습니다.",
      longDescriptionMarkdown: "## 근거를 읽기 쉽게\n\n메이커 설명과 자동 감지 정보를 분리해 보여줍니다.\n\n- 최근 릴리스\n- 라이선스\n- 저장소 활동",
      team: [{ name: "Fixture Maker", role: "Product & Engineering" }],
      makerLicense: { value: "MIT", spdxId: "MIT" },
      updatedAt: daysAgo(1),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.collecting,
      pricingModel: "unknown",
      lifecycle: "beta",
      longDescriptionMarkdown: "첫 공개 근거를 수집하고 있습니다.",
      updatedAt: daysAgo(1),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.staleConflict,
      pricingModel: "paid",
      lifecycle: "maintenance",
      longDescriptionMarkdown: "메이커 신고와 저장소 관측이 다른 상태를 보여주는 fixture입니다.",
      makerLicense: { value: "MIT", spdxId: "MIT" },
      updatedAt: daysAgo(20),
    },
  ]);

  await db.insert(productLinks).values([
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/evidence-studio",
      normalizedKey: "example/evidence-studio",
      verificationState: "ok",
      relationshipState: "bidirectional",
      verifiedAt: daysAgo(1),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      kind: "npm",
      declarationSource: "maker",
      url: "https://www.npmjs.com/package/evidence-studio",
      normalizedKey: "evidence-studio",
      verificationState: "ok",
      verifiedAt: daysAgo(1),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      kind: "changelog",
      declarationSource: "maker",
      url: `https://${PRODUCT_DETAIL_FIXTURES.rich}.example/changelog`,
      normalizedKey: `https://${PRODUCT_DETAIL_FIXTURES.rich}.example/changelog`,
      verificationState: "ok",
      verifiedAt: daysAgo(1),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.collecting,
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/early-signal",
      normalizedKey: "example/early-signal",
      verificationState: "unobserved",
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.staleConflict,
      kind: "repository",
      declarationSource: "maker",
      url: "https://github.com/example/conflict-lens",
      normalizedKey: "example/conflict-lens",
      verificationState: "stale",
      relationshipState: "disconnected",
      verifiedAt: daysAgo(20),
    },
  ]);

  await db.insert(productEvidenceSources).values([
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      kind: "repository",
      provider: "github",
      sourceKey: "example/evidence-studio",
      sourceUrl: "https://github.com/example/evidence-studio",
      state: "ok",
      normalizedFacts: {
        type: "github_repository",
        createdAt: daysAgo(400).toISOString(),
        pushedAt: daysAgo(1).toISOString(),
        latestRelease: { tag: "v1.6.0", publishedAt: daysAgo(5).toISOString() },
        stars: 146,
        forks: 18,
        contributors: 12,
        license: { spdxId: "MIT", name: "MIT License" },
        languages: [{ name: "TypeScript", bytes: 82_000 }, { name: "Rust", bytes: 18_000 }],
        visibility: "public",
        archived: false,
        relationship: "bidirectional",
      },
      observedAt: daysAgo(1),
      lastSuccessAt: daysAgo(1),
      nextAttemptAt: new Date(Date.now() + 23 * 60 * 60 * 1_000),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.collecting,
      kind: "repository",
      provider: "github",
      sourceKey: "example/early-signal",
      sourceUrl: "https://github.com/example/early-signal",
      state: "unobserved",
      nextAttemptAt: new Date(),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.staleConflict,
      kind: "repository",
      provider: "github",
      sourceKey: "example/conflict-lens",
      sourceUrl: "https://github.com/example/conflict-lens",
      state: "stale",
      normalizedFacts: {
        type: "github_repository",
        license: { spdxId: "GPL-3.0", name: "GNU GPLv3" },
        stars: 31,
        forks: 4,
        contributors: 2,
        languages: [{ name: "TypeScript", bytes: 10_000 }],
        visibility: "public",
        archived: false,
        relationship: "disconnected",
      },
      observedAt: daysAgo(20),
      lastSuccessAt: daysAgo(20),
      lastFailureAt: daysAgo(1),
      nextAttemptAt: daysAgo(1),
      attempts: 3,
      lastErrorCode: "transport_error",
    },
  ]);

  const image = await sharp({
    create: { width: 960, height: 600, channels: 3, background: "#171b2d" },
  }).webp().toBuffer();
  const thumbnail = await sharp(image).resize({ width: 480, height: 300 }).webp().toBuffer();
  const hash = createHash("sha256").update(image).update(thumbnail).digest("hex");
  await db.insert(mediaAssets).values({
    hash,
    webData: image,
    thumbnailData: thumbnail,
    width: 960,
    height: 600,
    thumbnailWidth: 480,
    thumbnailHeight: 300,
    mimeType: "image/webp",
    webSize: image.byteLength,
    thumbnailSize: thumbnail.byteLength,
  });
  await db.insert(productMedia).values({
    slug: PRODUCT_DETAIL_FIXTURES.rich,
    sourceUrl: `https://${PRODUCT_DETAIL_FIXTURES.rich}.example/gallery/dashboard.png`,
    assetHash: hash,
    position: 0,
    altText: "Evidence Studio 제품 근거 대시보드 화면",
    lastObservedAt: daysAgo(1),
    lastSuccessAt: daysAgo(1),
  });

  await db.insert(productUpdates).values([
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      sourceKind: "maker",
      dedupeKey: "maker:table-copy",
      title: "표가 포함된 문서의 텍스트 추출을 개선했습니다",
      summary: "병합된 셀의 읽기 순서와 복사 시 탭 구분을 유지합니다.",
      publishedAt: daysAgo(2),
      observedAt: daysAgo(2),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      sourceKind: "github_release",
      dedupeKey: "github:release:v1.6.0",
      canonicalUrl: "https://github.com/example/evidence-studio/releases/tag/v1.6.0",
      title: "v1.6.0 공개",
      summary: "공개 저장소의 최신 release와 태그를 확인했습니다.",
      publishedAt: daysAgo(5),
      observedAt: daysAgo(5),
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      sourceKind: "repository_change",
      dedupeKey: "github:activity:2026-08",
      title: "저장소 활동이 감지되었습니다",
      summary: "최근 push 시각과 별 수가 변경되었습니다.",
      observedAt: daysAgo(8),
    },
  ]);

  await db.insert(productAgents).values({
    slug: PRODUCT_DETAIL_FIXTURES.rich,
    provider: "OpenAI",
    client: "Codex",
    model: "GPT-5",
    roles: ["planning", "implementation", "review"],
    evidenceLevel: "maker_reported",
  });
  await db.insert(productSkills).values([
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      namespace: "openai",
      name: "review",
      version: "1.0.0",
      hash: "b".repeat(64),
      evidenceLevel: "maker_reported",
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      namespace: "nomorevibe",
      name: "product-register",
      version: "1.0.0",
      evidenceLevel: "nomorevibe_recorded",
    },
  ]);

  await db.insert(clickEvents).values([
    ...Array.from({ length: 12 }, (_, index) => ({
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      visitorHash: index < 8 ? String(index).padStart(64, "a") : String(index - 8).padStart(64, "a"),
      occurredAt: daysAgo(index / 24),
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      slug: PRODUCT_DETAIL_FIXTURES.staleConflict,
      visitorHash: String(index).padStart(64, "c"),
      occurredAt: daysAgo(index / 24),
    })),
  ]);
  await db.update(visitCollectionState).set({ uniqueVisitorStartedAt: daysAgo(10) });

  await db.insert(productHealth).values([
    { slug: PRODUCT_DETAIL_FIXTURES.rich, status: 200, latencyMs: 84, checkedAt: daysAgo(0.1) },
    {
      slug: PRODUCT_DETAIL_FIXTURES.staleConflict,
      status: 503,
      failures: 4,
      downSince: daysAgo(2),
      checkedAt: daysAgo(0.2),
    },
  ]);
  await db.insert(productHealthDaily).values([
    {
      slug: PRODUCT_DETAIL_FIXTURES.rich,
      day: new Date().toISOString().slice(0, 10),
      checks: 100,
      successes: 99,
      latencyTotalMs: 8_400,
      latencySamples: 100,
    },
    {
      slug: PRODUCT_DETAIL_FIXTURES.staleConflict,
      day: new Date().toISOString().slice(0, 10),
      checks: 10,
      successes: 6,
      latencyTotalMs: 1_200,
      latencySamples: 6,
    },
  ]);

  const [revision] = await db.insert(rankingPolicyRevisions).values({
    values: UNIQUE_FIRST_RANKING_POLICY,
    state: "applied",
    createdBy: "playwright",
    appliedAt: daysAgo(7),
  }).returning({ id: rankingPolicyRevisions.id });
  const [season] = await db.insert(rankingSeasons).values({
    key: "2026-W34-e2e",
    cadence: "weekly",
    startsAt: daysAgo(7),
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    state: "active",
    policyRevisionId: revision.id,
    policySnapshot: UNIQUE_FIRST_RANKING_POLICY,
    effectiveLaunchWindowDays: 28,
    refreshedAt: new Date(),
  }).returning({ id: rankingSeasons.id });
  await db.insert(rankingEntries).values({
    seasonId: season.id,
    slug: PRODUCT_DETAIL_FIXTURES.rich,
    validClicks: 12,
    uniqueVisitors: 8,
    scoreUnits: 90_000,
    rank: 2,
    changePercent: 24,
    recentClicks: 7,
    previousClicks: 5,
    recentUniqueVisitors: 5,
    previousUniqueVisitors: 4,
  });
}
