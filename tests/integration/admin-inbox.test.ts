import { beforeAll, expect, it } from "vitest";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts, crawlTaglines, productAuditCampaigns, productAuditItems, productEvidenceAudit, productHealth,
  productIntroChecks, products, secondReviews, takedownRequests } from "@/lib/db/schema";
import { humanQueueOverview } from "@/lib/crawl/review-overview";
import { getSettings } from "@/lib/crawl/settings";
import { downProductCount } from "@/lib/domain/products/health";
import { listProducts, SPAM_AUTO_BAN_ACTOR, SPAM_AUTO_BAN_REASON } from "@/lib/domain/products/repository";
import { takedownSummary } from "@/lib/domain/products/takedown";
import { attentionCounts } from "@/lib/operations/dashboard";
import { loadInbox, type InboxSnapshot } from "@/lib/operations/inbox";
import { PRODUCT_FILTERS, type ProductFilterName } from "@/app/admin/products/filters";
import { ensureSchema, resetTables } from "./setup";

/**
 * 오늘 할 일(ADM-07) — 칸의 수는 각 처리 화면이 쓰는 함수의 값과 같고, 미리 보기 줄은 그 화면의 거르기와 같은 조건이다.
 * takedownSummary 가 DB 시계로 재므로 기준 시각은 지금이다.
 */
const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

const product = (slug: string, over: Partial<typeof products.$inferInsert> = {}): typeof products.$inferInsert => ({
  slug, url: `https://${slug}.example`, name: `${slug} 이름`, tagline: "test", description: "test", category: "Productivity",
  status: "seeded", source: "crawler", verifyToken: `verify-${slug}`, editTokenHash: "h".repeat(64), ...over,
});

let inbox: InboxSnapshot;

beforeAll(ensureSchema);
beforeAll(async () => {
  await resetTables();
  for (const table of [crawlReviewAttempts, crawlTaglines, secondReviews, crawlCandidates, takedownRequests]) await db.delete(table);

  const rows = await db.insert(products).values([
    product("take-old"), product("take-new"),
    product("down-old"), product("down-new"), product("down-banned", { status: "banned" }),
    product("intro-open", { tagline: "모르는 소개" }), product("intro-stale", { tagline: "바뀐 소개" }),
    product("gone-web", { repoUrl: "https://github.com/a/web", repoStatus: "not_found", repoMissingSince: ago(72), repoCheckedAt: ago(1) }),
    product("gone-lib", { accessMode: "installable", repoUrl: "https://github.com/a/lib", repoStatus: "empty", repoMissingSince: ago(30), repoCheckedAt: ago(1) }),
    // 하루가 안 됐다 — 아직 사라졌다고 하지 않는다
    product("gone-fresh", { repoUrl: "https://github.com/a/fresh", repoStatus: "not_found", repoMissingSince: ago(5), repoCheckedAt: ago(1) }),
    product("spam-new", { status: "banned" }), product("spam-old", { status: "banned" }),
    product("audit-open"), product("audit-kept"),
  ]).returning();
  const id = (slug: string) => rows.find((row) => row.slug === slug)!.id;

  await db.insert(takedownRequests).values([
    { slug: "take-old", reason: "제가 만든 것이 아닙니다", requestedAt: ago(30) },
    { slug: "take-new", requestedAt: ago(2) },
    { slug: "down-old", requestedAt: ago(40), handledAt: ago(3), handledBy: "admin", outcome: "removed" },
  ]);

  await db.insert(crawlCandidates).values([
    { repo: "human/old", state: "needs_review", reason: "second_review_split", decidedBy: "auto", judgedAt: ago(24 * 20) },
    { repo: "human/new", state: "needs_review", reason: "no_description", decidedBy: "auto", judgedAt: ago(2) },
    { repo: "done/approved", state: "approved", reason: "passed", decidedBy: "auto" },
  ]);

  await db.insert(productHealth).values([
    { slug: "down-old", status: 0, failures: 9, downSince: ago(72) },
    { slug: "down-new", status: 503, failures: 3, downSince: ago(20) },
    { slug: "down-banned", status: 0, failures: 5, downSince: ago(50) },
    { slug: "take-old", status: 0, failures: 2, downSince: ago(10) },  // 아직 문턱 아래
  ]);

  await db.insert(productIntroChecks).values([
    { productId: id("intro-open"), checkedTagline: "모르는 소개", outcome: "needs_editor", problem: "근거로는 무엇인지 알 수 없음" },
    { productId: id("intro-stale"), checkedTagline: "예전 소개", outcome: "needs_editor" },
  ]);

  const ban = (slug: string, createdAt: Date) => ({ slug, actor: SPAM_AUTO_BAN_ACTOR, action: "admin.product.ban", reason: SPAM_AUTO_BAN_REASON,
    metadata: { confidence: 0.97, status: "banned" }, createdAt });
  await db.insert(productEvidenceAudit).values([ban("spam-new", ago(3)), ban("spam-old", ago(30))]);

  const campaign = { startedBy: "test", reason: "test", promptVersion: "test", rulesVersion: "test", provider: "abcllm", model: "m" };
  const [latest] = await db.insert(productAuditCampaigns).values(campaign).returning();
  await db.insert(productAuditItems).values([
    { campaignId: latest.id, productId: id("audit-open"), slug: "audit-open", aiDecision: "reject", aiReason: "제품이 아님", aiConfidence: 0.96, reviewedAt: ago(5) },
    { campaignId: latest.id, productId: id("audit-kept"), slug: "audit-kept", aiDecision: "reject", humanDecision: "kept" },
  ]);

  inbox = await loadInbox(now);
});

const data = (key: keyof InboxSnapshot["results"]) => {
  const result = inbox.results[key];
  if (!result.ok) throw new Error(`${key} 칸을 읽지 못했다`);
  return result.data;
};

it("칸마다 수는 처리 화면이 쓰는 함수의 값과 같다", async () => {
  const [summary, overview, attention, down] = await Promise.all([
    takedownSummary(), humanQueueOverview(await getSettings(), now), attentionCounts(now), downProductCount()]);
  expect(Object.values(inbox.results).every((result) => result.ok)).toBe(true);
  expect(data("takedown")).toMatchObject({ count: summary.pending, overdue: summary.overdue });
  expect(data("human").count).toBe(overview.stages.human);
  expect(data("agreed").count).toBe(overview.stages.agreed);
  expect(data("audit").count).toBe(attention.auditRejectsOpen);
  expect(data("down").count).toBe(down);
  expect(data("intro").count).toBe(attention.introNeedsEditor);
  expect(data("repoGone").count).toBe(attention.repoGone.installable + attention.repoGone.website);
  expect(data("spam").count).toBe(attention.spamAutoBans.day);
  // 심은 값 그대로
  expect([summary.pending, summary.overdue, overview.stages.human, attention.auditRejectsOpen, down, attention.introNeedsEditor,
    attention.repoGone.installable + attention.repoGone.website, attention.spamAutoBans.day]).toEqual([2, 1, 2, 1, 2, 1, 2, 1]);
  // 오늘 처리 — 심사 결정 0(사람 결정 없음) + 요청 처리 1
  expect(inbox.done).toEqual([0, 1]);
});

it("줄은 오래 기다린 것부터이고, 첫 줄이 가장 오래된 것이다", () => {
  expect(data("takedown").items.map((item) => [item.name, item.why])).toEqual([["take-old 이름", "제가 만든 것이 아닙니다"], ["take-new 이름", "사유 없음"]]);
  expect(data("human").items.map((item) => [item.name, item.why])).toEqual([["human/old", "second_review_split"], ["human/new", "no_description"]]);
  expect(data("down").items.map((item) => item.id)).toEqual(["down-old", "down-new"]);
  expect(data("down").items[0].why).toBe("9회 연속 실패 · 연결 안 됨");
  expect(data("repoGone").items.map((item) => item.id)).toEqual(["gone-web", "gone-lib"]);
  expect(data("audit").items).toEqual([expect.objectContaining({ name: "audit-open 이름", why: "제품이 아님 · 확신 0.96" })]);
  expect(data("intro").items).toEqual([expect.objectContaining({ id: "intro-open", why: "근거로는 무엇인지 알 수 없음" })]);
  expect(data("spam").items).toEqual([expect.objectContaining({ name: "spam-new 이름", why: "차단 중 · 확신 0.97" })]);
  // 시각은 UTC ISO — 기준 시각에서 잰 나이가 심은 값과 같다
  const hours = (iso: string | null) => Math.round((now.getTime() - new Date(iso!).getTime()) / 3_600_000);
  expect(hours(data("takedown").items[0].since)).toBe(30);
  expect(hours(data("human").items[0].since)).toBe(480);
  expect(hours(data("down").items[0].since)).toBe(72);
  expect(hours(data("repoGone").items[0].since)).toBe(48);  // 사라졌다고 확정된 때(+24시간)부터
});

it("제품 칸의 줄은 연결된 제품 목록 거르기와 같은 제품이다", async () => {
  const filters: [keyof InboxSnapshot["results"], ProductFilterName][] = [["down", "응답 없음"], ["intro", "소개 확인 필요"], ["repoGone", "저장소 사라짐"]];
  for (const [key, name] of filters) {
    const { statuses, ...flags } = PRODUCT_FILTERS[name];
    const listed = await listProducts({ statuses: [...statuses], ...flags, limit: 100 });
    expect(data(key).items.map((item) => item.id).sort(), name).toEqual(listed.map((row) => row.slug).sort());
  }
});
