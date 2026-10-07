import { beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges, crawlReviewAttempts, productAuditCampaigns,
  productAuditItems, productHealth, productIntroChecks, productSearchProfiles, products, secondReviews } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { PROFILE_MODEL } from "@/lib/domain/products/search-profile";
import { attentionCounts, hourlyThroughput, modelHealth, signalYields, todayPublications } from "@/lib/operations/dashboard";
import { ensureSchema, resetTables } from "./setup";

// 이번 시(時)의 30분 — 몇 분 전에 심은 행이 늘 마지막 칸에 들어간다
const HOUR_MS = 3_600_000;
const now = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS + 30 * 60_000);
const ago = (minutes: number, plusSeconds = 0) => new Date(now.getTime() - minutes * 60_000 + plusSeconds * 1000);
const DAY = 1440;

const settings: CrawlSettings = {
  ...DEFAULT_CRAWL_SETTINGS,
  firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" },
  secondReview: {
    ...DEFAULT_CRAWL_SETTINGS.secondReview,
    // 첫 투표자는 1차와 같은 모델(접두어만 다름)이라 메아리 — 실제 2차 표는 qwen
    voters: [{ provider: "abcllm", model: "gpt-oss-120b" }, { provider: "abcllm", model: "qwen" }],
    fallbacks: [{ provider: "claude-cli", model: "sonnet" }],
  },
  discover: {
    ...DEFAULT_CRAWL_SETTINGS.discover,
    queries: [...DEFAULT_CRAWL_SETTINGS.discover.queries,
      { label: "readme", kind: "commits", query: "있습니다 in:readme", enabled: true, priority: 10, builder: null, requireEvidence: true }],
    showHn: { enabled: true, priority: 120, requireEvidence: true },
  },
};

const product = (slug: string, overrides: Partial<typeof products.$inferInsert> = {}): typeof products.$inferInsert => ({
  slug, url: `https://${slug}.example`, name: slug, tagline: "test", description: "test", category: "Productivity",
  status: "seeded", source: "crawler", verifyToken: `verify-${slug}`, editTokenHash: "h".repeat(64), ...overrides,
});

beforeAll(ensureSchema);
beforeAll(async () => {
  await resetTables();
  for (const table of [secondReviews, crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges]) await db.delete(table);

  await db.insert(crawlFrontier).values([
    { repo: "dash/korean", signal: "Claude 커밋 트레일러", state: "done", discoveredAt: ago(20) },
    { repo: "dash/gated", signal: "readme", state: "done", discoveredAt: ago(15) },
    { repo: "dash/older", signal: "Claude 커밋 트레일러", discoveredAt: ago(2 * DAY) }, // 7일 안, 24시간 밖
    { repo: "dash/show", signal: "Show HN", discoveredAt: ago(3 * DAY) },
    { repo: "dash/stale", signal: "Claude 커밋 트레일러", discoveredAt: ago(8 * DAY) }, // 7일 밖
  ]);
  const candidates = await db.insert(crawlCandidates).values([
    { repo: "dash/korean", state: "published", reason: "passed", decidedBy: "auto", publishedSlug: "korean-app", judgedAt: ago(18) },
    { repo: "dash/gated", state: "rejected", reason: "ai_evidence_not_found", decidedBy: "auto", judgedAt: ago(14) },
  ]).returning();
  const candidate = candidates.find((row) => row.repo === "dash/korean")!;

  const listed = await db.insert(products).values([
    product("korean-app", { name: "한글 메모장", tagline: "Notes for teams", createdAt: ago(10) }),
    product("english-app", { name: "English App", tagline: "Plain notes", createdAt: ago(120) }),
    product("installable-lib", { accessMode: "installable", createdAt: ago(3 * DAY) }),
    product("banned-app", { status: "banned", createdAt: ago(5) }),
  ]).returning();
  const koreanApp = listed.find((row) => row.slug === "korean-app")!;
  const englishApp = listed.find((row) => row.slug === "english-app")!;

  const attempt = (overrides: Partial<typeof crawlReviewAttempts.$inferInsert>): typeof crawlReviewAttempts.$inferInsert => ({
    candidateId: candidate.id, kind: "automatic", state: "succeeded", inputHash: "i", policyHash: "p", sourceRevisionHash: "s",
    snapshot: {} as never, source: {} as never, promptVersion: "test", rulesVersion: "test", provider: "abcllm",
    model: "[MLX] gpt-oss-120b", attemptNumber: 1, validUntil: ago(-60), ...overrides,
  });
  await db.insert(crawlReviewAttempts).values([
    attempt({ startedAt: ago(12), completedAt: ago(12, 4) }),
    attempt({ state: "failed", errorCode: "timeout", attemptNumber: 2, startedAt: ago(8), completedAt: ago(8, 10) }),
  ]);

  const vote = (inputHash: string, secondDecision: string, reviewedAt: Date): typeof secondReviews.$inferInsert => ({
    candidateId: candidate.id, repo: candidate.repo, trigger: "ai_approved", firstDecision: "approve", inputHash,
    provider: "abcllm", model: "qwen", status: secondDecision === "approve" ? "agreed" : "needs_human",
    secondDecision, createdAt: ago(10), reviewedAt,
  });
  await db.insert(secondReviews).values([vote("agree", "approve", ago(9)), vote("split", "reject", ago(5))]);

  await db.insert(productSearchProfiles).values({ productId: koreanApp.id, model: PROFILE_MODEL, sourceHash: "x", generatedAt: ago(3) });
  await db.insert(productHealth).values({ slug: "korean-app", status: 200, checkedAt: ago(60) });
  await db.insert(productIntroChecks).values({ productId: englishApp.id, checkedTagline: "Plain notes", outcome: "needs_editor" });

  // 지난 감사에 남은 열린 판정은 세지 않는다 — /admin/audit 은 마지막 감사만 보여 준다
  const campaign = { startedBy: "test", reason: "test", promptVersion: "test", rulesVersion: "test", provider: "abcllm", model: "m" };
  const [old] = await db.insert(productAuditCampaigns).values({ ...campaign, status: "done" }).returning();
  const [latest] = await db.insert(productAuditCampaigns).values(campaign).returning();
  await db.insert(productAuditItems).values([
    { campaignId: old.id, productId: englishApp.id, slug: "english-app", aiDecision: "reject" },
    { campaignId: latest.id, productId: koreanApp.id, slug: "korean-app", aiDecision: "reject" },
    { campaignId: latest.id, productId: englishApp.id, slug: "english-app", aiDecision: "reject", humanDecision: "kept" },
  ]);
});

it("buckets the last 24 hours oldest first and reuses the cached series", async () => {
  const series = await hourlyThroughput(now);
  expect(series.measuredAt).toBe(now.toISOString());
  expect(series.points).toHaveLength(24);
  const hours = series.points.map((point) => Date.parse(point.hour));
  expect(hours.at(-1)).toBe(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  hours.slice(1).forEach((hour, index) => expect(hour - hours[index]).toBe(HOUR_MS));

  expect(series.points.at(-1)).toEqual({
    hour: new Date(hours.at(-1)!).toISOString(), discovered: 2, judged: 2, firstReviews: 1, firstFailed: 1,
    secondReviews: 2, secondAgreed: 1, published: 1, publishedKorean: 1, keywords: 1,
  });
  // 두 시간 전 영어 제품은 그 칸에, 차단된 제품과 24시간 밖 발견은 어디에도 없다
  expect(series.points[21]).toMatchObject({ published: 1, publishedKorean: 0 });
  expect(series.points.reduce((sum, point) => sum + point.published, 0)).toBe(2);
  expect(series.points.reduce((sum, point) => sum + point.discovered, 0)).toBe(2);

  expect(await hourlyThroughput(new Date(now.getTime() + 1000))).toBe(series);
});

it("reports each model slot over the last hour", async () => {
  expect(await modelHealth(settings, now)).toEqual([
    { key: "first", label: "1차 심사", model: "[MLX] gpt-oss-120b", calls1h: 2, failed1h: 1, avgSeconds: 7,
      agreement1h: null, lastSuccessAt: ago(12, 4).toISOString() },
    { key: "second", label: "2차 투표", model: "qwen", calls1h: 2, failed1h: 0, avgSeconds: 180,
      agreement1h: 0.5, lastSuccessAt: ago(5).toISOString() },
    { key: "fallback", label: "2차 fallback", model: "sonnet", calls1h: 0, failed1h: 0, avgSeconds: null,
      agreement1h: null, lastSuccessAt: null },
    { key: "keywords", label: "키워드 짓기", model: PROFILE_MODEL, calls1h: 1, failed1h: 0, avgSeconds: null,
      agreement1h: null, lastSuccessAt: ago(3).toISOString() },
  ]);
  // 1차 모델을 설정하지 않았으면 지난 1시간에 실제로 본 모델
  const [first] = await modelHealth({ ...settings, firstReview: undefined }, now);
  expect(first.model).toBe("[MLX] gpt-oss-120b");
});

it("yields per discovery signal over the last 7 days", async () => {
  const yields = await signalYields(settings);
  expect(yields).toHaveLength(3);
  expect(yields[0]).toEqual({ signal: "Claude 커밋 트레일러", enqueued: 2, published: 1, gated: 0, requireEvidence: false });
  expect(yields.slice(1)).toEqual(expect.arrayContaining([
    { signal: "readme", enqueued: 1, published: 0, gated: 1, requireEvidence: true },
    { signal: "Show HN", enqueued: 1, published: 0, gated: 0, requireEvidence: true },
  ]));
});

it("lists the last 24 hours of listed products with their discovery signal", async () => {
  expect(await todayPublications(now)).toEqual({ total24h: 2, korean24h: 1, latest: [
    { slug: "korean-app", name: "한글 메모장", tagline: "Notes for teams", category: "Productivity",
      signal: "Claude 커밋 트레일러", createdAt: ago(10).toISOString(), korean: true },
    { slug: "english-app", name: "English App", tagline: "Plain notes", category: "Productivity",
      signal: null, createdAt: ago(120).toISOString(), korean: false },
  ] });
  expect(await todayPublications(now, 1)).toMatchObject({ total24h: 2, latest: [{ slug: "korean-app" }] });
  expect(await todayPublications(new Date(now.getTime() + 3 * 86_400_000))).toEqual({ total24h: 0, korean24h: 0, latest: [] });
});

it("counts what needs a person", async () => {
  // 생존 확인: korean-app 은 1시간 전에 봤고, 설치형·차단 제품은 확인 대상이 아니다
  // 목표: 웹사이트 공개 제품 둘(korean-app·english-app) ÷ 6시간 → 시간당 1건(올림)
  expect(await attentionCounts(now)).toEqual({ auditRejectsOpen: 1, healthOverdue: 1, healthTargetPerHour: 1, introNeedsEditor: 1 });
});
