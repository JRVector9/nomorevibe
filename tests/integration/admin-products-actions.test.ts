import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  crawlCandidates, crawlReviewAttempts, operationsAudit, productAuditCampaigns, productAuditItems, productEvidenceAudit, productIntroChecks,
  productRepoReviews, products,
} from "@/lib/db/schema";
import { countProducts, listProducts } from "@/lib/domain/products/repository";
import { productHistory } from "@/lib/domain/products/history";
import { repoGonePending } from "@/lib/domain/products/repo-pending";
import { banProducts, setProductBan } from "@/app/admin/actions";
import { keepIntroAction } from "@/app/admin/products/actions";
import { PRODUCT_FILTERS } from "@/app/admin/products/filters";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate, revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

/**
 * 제품 관리 — 차단 사유(ADM-06), 되돌리기(ADM-12), 이 제품의 기록(ADM-20), 소개 그대로 두기(ADM-23), 저장소 사라짐 대기(ADM-33).
 *
 * 작업 로그(operations_audit)와 후보(crawl_candidates)는 resetTables 가 비우지 않는다 — 실행마다 다른 slug·저장소를 쓴다.
 */
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "operator" });
});

const RUN = Date.now().toString(36);
let serial = 0;
const candidateRepos: string[] = [];
afterAll(async () => {
  if (candidateRepos.length) await db.delete(crawlCandidates).where(inArray(crawlCandidates.repo, candidateRepos));
});

async function seed(overrides: Partial<typeof products.$inferInsert> = {}) {
  const slug = overrides.slug ?? `p5-${RUN}-${++serial}`;
  const [row] = await db.insert(products).values({
    slug, name: overrides.name ?? slug, url: `https://${slug}.example`, tagline: "A useful product", description: "description",
    category: "Dev", repoUrl: `https://github.com/p5-${RUN}/${slug}`, status: "seeded", source: "crawler", verifyToken: `v-${slug}`,
    editTokenHash: "a".repeat(64), ...overrides,
  }).returning();
  return row;
}
const read = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

// ─────────────────────────── 차단 사유·되돌리기 ───────────────────────────

it("사유 없는 차단은 서버가 거절한다 — 한 건도, 일괄도", async () => {
  const p = await seed();
  const floor = await auditFloor();
  expect(await setProductBan(null, form({ slug: p.slug, action: "ban" }))).toMatchObject({ error: expect.any(String) });
  expect(await setProductBan(null, form({ slug: p.slug, action: "ban", reason: "because" }))).toMatchObject({ error: expect.any(String) });
  expect(await banProducts(null, form({ slug: p.slug }))).toMatchObject({ error: expect.any(String) });
  expect(await read(p.id)).toMatchObject({ status: "seeded" });
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, p.slug))).toEqual([]);
  expect(await auditRowsAfter(floor, "product-ban")).toEqual([]);
});

it("차단은 사유·메모·누가를 차단 감사 행과 작업 로그에 남기고 알림이 쓸 결과를 돌려준다", async () => {
  const p = await seed();
  const floor = await auditFloor();
  expect(await setProductBan(null, form({ slug: p.slug, action: "ban", reason: "spam", note: "다운로드 미끼" })))
    .toEqual({ ok: true, message: expect.any(String) });
  expect(await read(p.id)).toMatchObject({ status: "banned" });
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, p.slug))).toEqual([expect.objectContaining({
    action: "admin.product.ban", reason: "spam", metadata: { by: "operator", note: "다운로드 미끼", status: "banned" },
  })]);
  expect(await auditRowsAfter(floor, "product-ban")).toEqual([expect.objectContaining({
    actor: "operator", target: p.slug, ok: true, detail: { reason: "spam", note: "다운로드 미끼" },
  })]);
  expect(mocks.revalidate).toHaveBeenCalledWith(`/admin/products/${p.slug}`);
});

it("되돌리기는 같은 해제 길로 차단 전 상태를 돌리고, 되돌림도 새 줄로 남긴다", async () => {
  const p = await seed({ verifiedAt: new Date(), status: "verified" });
  await setProductBan(null, form({ slug: p.slug, action: "ban", reason: "not_product" }));
  const floor = await auditFloor();
  expect(await setProductBan(null, form({ slug: p.slug, action: "unban", undo: "1" }))).toMatchObject({ ok: true });
  expect(await read(p.id)).toMatchObject({ status: "verified" });
  expect(await auditRowsAfter(floor, "product-unban")).toEqual([expect.objectContaining({ target: p.slug, detail: { undo: true } })]);
  const audits = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, p.slug)).orderBy(productEvidenceAudit.id);
  expect(audits.map((row) => [row.action, row.reason])).toEqual([["admin.product.ban", "not_product"], ["admin.product.unban", null]]);
  expect(audits[1].metadata).toEqual({ by: "operator", undo: true, status: "verified" });
});

it("일괄 차단도 고른 사유를 건마다 남긴다", async () => {
  const [a, b] = [await seed(), await seed()];
  const data = form({ reason: "fraud" });
  data.append("slug", a.slug);
  data.append("slug", b.slug);
  expect(await banProducts(null, data)).toEqual({ ok: 2, failures: [] });
  const rows = await db.select().from(productEvidenceAudit).where(inArray(productEvidenceAudit.slug, [a.slug, b.slug]));
  expect(rows.map((row) => row.reason)).toEqual(["fraud", "fraud"]);
});

// ─────────────────────────── 이 제품의 기록 ───────────────────────────

it("이 제품의 기록은 다섯 출처를 시각 순(최근 것부터)으로 합치고 자른다", async () => {
  const p = await seed();
  const other = await seed();
  const repo = `p5-${RUN}/${p.slug}`;
  candidateRepos.push(repo);
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, state: "published", publishedSlug: p.slug }).returning();
  const attempt = { candidateId: candidate.id, inputHash: "i", policyHash: "p", sourceRevisionHash: "s", snapshot: {} as never,
    source: {} as never, promptVersion: "v", rulesVersion: "v", validUntil: at(-24) };
  await db.insert(crawlReviewAttempts).values([
    { ...attempt, kind: "automatic", state: "succeeded", attemptNumber: 1, model: "sonnet", startedAt: at(10), completedAt: at(10),
      outcome: { decision: "needs_review", reason: "애매함", evidenceIds: [] } },
    { ...attempt, kind: "admin_override", state: "succeeded", attemptNumber: 1, actor: "jr", reason: "직접 봄", startedAt: at(9),
      completedAt: at(9), outcome: { decision: "approve", reason: "직접 봄", evidenceIds: ["product"] } },
    // 끝나지 않은 시도는 기록에 넣지 않는다
    { ...attempt, kind: "automatic", state: "failed", attemptNumber: 2, startedAt: at(8), errorCode: "cli_error" },
  ]);
  const [campaign] = await db.insert(productAuditCampaigns).values({ startedBy: "jr", reason: "r", promptVersion: "v", rulesVersion: "v",
    provider: "claude-cli", model: "sonnet" }).returning();
  await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: p.id, slug: p.slug, aiDecision: "reject", aiReason: "소개 페이지",
    reviewedAt: at(7), humanDecision: "kept", humanBy: "jr", humanAt: at(6), humanNote: "제품 맞음" });
  await db.insert(productRepoReviews).values({ productId: p.id, decision: "human", reason: "site_down", model: "m", reviewedAt: at(5),
    operatorDecision: "keep", operatorBy: "jr", operatorAt: at(4) });
  // 작업 로그 — 후보 저장소로 남긴 심사 결정, slug 로 남긴 차단. 다른 제품 것은 빠진다
  await db.insert(operationsAudit).values([
    { actor: "jr", action: "candidate-approve", target: repo, detail: { note: "직접 봄" }, createdAt: at(9) },
    { actor: "jr", action: "product-ban", target: p.slug, detail: { reason: "spam" }, createdAt: at(2) },
    { actor: "jr", action: "product-ban", target: other.slug, detail: { reason: "spam" }, createdAt: at(1) },
  ]);
  await db.insert(productEvidenceAudit).values([
    { slug: p.slug, actor: "admin", action: "admin.product.ban", reason: "spam", createdAt: at(2) },
    // 차단·해제가 아닌 근거 감사는 기존 '감사 기록' 패널에만
    { slug: p.slug, actor: "maker", action: "maker.profile.save", createdAt: at(1) },
  ]);

  const history = await productHistory(p.slug);
  // 같은 시각이면 출처 순서(작업 로그 → 심사 → 감사 → 저장소 확인 → 상태)를 지킨다
  expect(history.map((entry) => [entry.kind, entry.action])).toEqual([
    ["admin", "product-ban"], ["status", "admin.product.ban"],
    ["repo_review", "operator-keep"], ["repo_review", "ai-human"],
    ["audit", "human-kept"], ["audit", "ai-reject"],
    ["admin", "candidate-approve"], ["review", "admin-approve"],
    ["review", "ai-needs_review"],
  ]);
  for (let i = 1; i < history.length; i++) expect(history[i - 1].at.getTime()).toBeGreaterThanOrEqual(history[i].at.getTime());
  expect(history.find((entry) => entry.kind === "audit" && entry.action === "human-kept")).toMatchObject({ actor: "jr", note: "제품 맞음" });
  expect(history.find((entry) => entry.kind === "review" && entry.action === "ai-needs_review")).toMatchObject({ actor: "sonnet", note: "애매함" });
  expect(history[0]).toMatchObject({ actor: "jr", note: "spam", ok: true });

  expect(await productHistory(p.slug, 3)).toHaveLength(3);
  expect(await productHistory("no-such-product")).toEqual([]);
});

// ─────────────────────────── 소개 그대로 두기 ───────────────────────────

it("그대로 두기는 검수 결과를 kept 로 바꿔 '소개 확인 필요'에서 뺀다 — 소개가 그 사이 바뀌었으면 거절한다", async () => {
  const p = await seed({ tagline: "Loading" });
  const changed = await seed({ tagline: "New tagline written by maker" });
  await db.insert(productIntroChecks).values([
    { productId: p.id, checkedTagline: "Loading", verdict: "uninformative", problem: "자리표시", outcome: "needs_editor" },
    { productId: changed.id, checkedTagline: "Old tagline", verdict: "uninformative", problem: "x", outcome: "needs_editor" },
  ]);
  const filter = PRODUCT_FILTERS["소개 확인 필요"];
  expect((await listProducts({ ...filter, limit: 25 })).map((row) => row.slug)).toEqual([p.slug]);

  const floor = await auditFloor();
  expect(await keepIntroAction(null, form({ slug: p.slug }))).toMatchObject({ ok: true });
  expect(await countProducts(filter)).toBe(0);
  expect((await db.select().from(productIntroChecks).where(eq(productIntroChecks.productId, p.id)))[0])
    .toMatchObject({ outcome: "kept", verdict: "uninformative", problem: "자리표시" });
  expect(await auditRowsAfter(floor, "intro-keep")).toEqual([expect.objectContaining({ actor: "operator", target: p.slug, ok: true })]);

  // 두 번째는 이미 처리한 것, 바뀐 소개는 다시 검수할 몫이다
  expect(await keepIntroAction(null, form({ slug: p.slug }))).toMatchObject({ error: expect.any(String) });
  expect(await keepIntroAction(null, form({ slug: changed.slug }))).toMatchObject({ error: expect.any(String) });
  mocks.admin.mockResolvedValue(null);
  expect(await keepIntroAction(null, form({ slug: p.slug }))).toMatchObject({ error: expect.any(String) });
});

// ─────────────────────────── 저장소 사라짐 대기 ───────────────────────────

it("저장소 사라짐은 24시간 넘은 것만, pending 보기는 24시간 전 '지금 없음'까지 — 대기 수와 나타날 시각을 준다", async () => {
  const gone = await seed();
  const fresh = await seed();
  const freshEmpty = await seed();
  const banned = await seed({ status: "banned" });
  await db.execute(sql`update products set repo_status = 'not_found', repo_missing_since = now() - interval '3 days',
    repo_checked_at = now() - interval '1 hour' where id = ${gone.id}`);
  await db.execute(sql`update products set repo_status = 'not_found', repo_missing_since = now() - interval '2 hours',
    repo_checked_at = now() - interval '2 hours' where id = ${fresh.id}`);
  await db.execute(sql`update products set repo_status = 'empty', repo_missing_since = now() - interval '5 hours',
    repo_checked_at = now() - interval '1 hour' where id = ${freshEmpty.id}`);
  await db.execute(sql`update products set repo_status = 'not_found', repo_missing_since = now() - interval '1 hour',
    repo_checked_at = now() where id = ${banned.id}`);

  const { statuses, ...flags } = PRODUCT_FILTERS["저장소 사라짐"];
  const base = { statuses: [...statuses], ...flags };
  expect((await listProducts({ ...base, limit: 25 })).map((row) => row.slug)).toEqual([gone.slug]);
  const pending = { ...base, repoGone: undefined, repoMissing: true };
  expect((await listProducts({ ...pending, limit: 25 })).map((row) => row.slug).sort()).toEqual([gone.slug, fresh.slug, freshEmpty.slug].sort());
  expect(await countProducts(pending)).toBe(3);

  const waiting = await repoGonePending();
  expect(waiting.count).toBe(2);
  const [{ since }] = await db.select({ since: products.repoMissingSince }).from(products).where(eq(products.id, freshEmpty.id));
  expect(waiting.firstAt?.getTime()).toBe(since!.getTime() + 24 * 3_600_000);
});
