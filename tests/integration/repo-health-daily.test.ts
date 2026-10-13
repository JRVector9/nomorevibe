import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productEvidenceAudit, productHealth, productRepoReviews, products } from "@/lib/db/schema";
import type { RepositoryCheck, RepositoryFacts, RepositoryRef } from "@/lib/crawl/github-repositories";
import { countProducts, listProductSlugs, listProducts } from "@/lib/domain/products/repository";
import { getPublicList } from "@/lib/domain/products/view";
import type { RepoCheck, RepoReviewPage } from "@/lib/domain/products/repo-review";
import { delistGoneRepository, MAX_REPO_GONE_DELISTS_PER_DAY } from "@/lib/domain/products/repo-reviews";
import { refreshProductStars, type StarsCursor } from "@/lib/jobs/products/stars-refresh";
import { reviewGoneRepositories } from "@/lib/jobs/products/repo-review";
import type { JobContext } from "@/lib/jobs/runner";
import { attentionCounts } from "@/lib/operations/dashboard";
import { decideRepoReviewAction } from "@/app/(operator)/admin/actions";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate, revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));

/**
 * 하루 저장소 확인(GraphQL 묶음, 0061)과 저장소가 사라진 제품의 2단계 확인(product-repo-review), 운영자 결정, 운영센터 지표.
 */

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "operator" });
});
afterEach(() => vi.unstubAllEnvs());

const PUBLIC = ["seeded", "verified"] as ("seeded" | "verified")[];
const facts = (over: Partial<RepositoryFacts> = {}): RepositoryFacts =>
  ({ stars: 10, ownerType: "User", archived: false, pushedAt: "2026-10-01T00:00:00Z", renamedTo: null, ...over });
const ok = (over: Partial<RepositoryFacts> = {}): RepositoryCheck => ({ status: "ok", facts: facts(over) });
const empty: RepositoryCheck = { status: "empty", facts: facts({ stars: 0, pushedAt: null }) };
const notFound: RepositoryCheck = { status: "not_found", facts: null };
const checker = (answer: (repo: RepositoryRef) => RepositoryCheck, rateLimit: { remaining: number; resetAt: string | null } | null = null) =>
  vi.fn(async (repos: RepositoryRef[]) => ({ ok: true as const, checks: repos.map(answer), rateLimit }));
const starsContext = (cursor: StarsCursor | null = null): JobContext<StarsCursor> => ({ cursor, save: vi.fn(), hasBudget: () => true, log: vi.fn() });

let serial = 0;
async function seed(overrides: Partial<typeof products.$inferInsert> = {}) {
  const slug = overrides.slug ?? `daily-${++serial}`;
  const [row] = await db.insert(products).values({
    slug, name: overrides.name ?? slug, url: `https://${slug}.example`, tagline: "A useful product", description: "description", category: "Dev",
    repoUrl: `https://github.com/test/${slug}`, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    ...overrides,
  }).returning();
  return row;
}
const read = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
const review = async (id: number) => (await db.select().from(productRepoReviews).where(eq(productRepoReviews.productId, id)))[0];
/** 하루가 지나 다시 볼 때가 된 것처럼 — SQL 시계로 민다 */
const age = (id: number, hours: number) => db.execute(sql`update products set stars_at = stars_at - ${hours} * interval '1 hour',
  stars_checked_at = stars_checked_at - ${hours} * interval '1 hour', repo_checked_at = repo_checked_at - ${hours} * interval '1 hour',
  repo_missing_since = repo_missing_since - ${hours} * interval '1 hour' where id = ${id}`);
const markGone = (id: number, status: "not_found" | "empty" = "not_found") => db.execute(sql`update products set repo_status = ${status},
  repo_missing_since = now() - interval '3 days', repo_checked_at = now() - interval '1 hour', stars_checked_at = now() - interval '1 hour' where id = ${id}`);

// ─────────────────────────── A. 하루 저장소 확인 ───────────────────────────

it("빈 저장소도 하루 넘게 이어지면 사라진 것과 같다 — 없음과 번갈아도 한 줄기다", async () => {
  const site = await seed({ stars: 50, starsAt: new Date() });
  const tool = await seed({ accessMode: "installable", url: "https://github.com/test/tool-empty" });
  let answer: RepositoryCheck = empty;
  const check = checker(() => answer);
  await refreshProductStars(starsContext(), { check });
  const first = await read(site.id);
  expect(first).toMatchObject({ repoStatus: "empty", stars: 0 });
  expect(first.repoMissingSince!.getTime()).toBe(first.repoCheckedAt!.getTime());
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(0);

  // 하루가 지나 이번에는 없음 — 시작은 그대로, 판정이 선다
  for (const row of [site, tool]) await age(row.id, 25);
  answer = notFound;
  await refreshProductStars(starsContext(), { check });
  expect((await read(site.id)).repoMissingSince!.getTime()).toBe(first.repoMissingSince!.getTime() - 25 * 3_600_000);
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(2);
  // 설치형은 가려지고 웹사이트는 남되 스타를 빼다
  const list = await getPublicList(10);
  expect(list.map((item) => item.slug)).toEqual([site.slug]);
  expect(list[0]).toMatchObject({ stars: null });
});

it("보관·마지막 push·바뀐 이름은 기록만 한다 — repo_url 과 공개 화면은 그대로", async () => {
  const p = await seed({ stars: 3000, starsAt: new Date() });
  const check = checker(() => ok({ stars: 3100, archived: true, pushedAt: "2023-01-03T10:49:48Z", renamedTo: "neworg/renamed" }));
  await refreshProductStars(starsContext(), { check });
  const row = await read(p.id);
  expect(row).toMatchObject({ repoStatus: "ok", repoArchived: true, repoRenamedTo: "neworg/renamed", repoUrl: `https://github.com/test/${p.slug}`, stars: 3100 });
  expect(row.repoPushedAt!.toISOString()).toBe("2023-01-03T10:49:48.000Z");
  // 처음 적는 답은 '바뀐 것'이 아니다
  expect(row.repoChangedAt).toBeNull();
  expect((await getPublicList(10))[0]).toMatchObject({ slug: p.slug, stars: 3100 });
  expect(await listProductSlugs({ statuses: PUBLIC, repoArchived: true, limit: 10 })).toEqual([p.slug]);
  expect((await listProducts({ statuses: PUBLIC, repoRenamed: true, limit: 10 })).map((item) => item.repoRenamedTo)).toEqual(["neworg/renamed"]);

  // 다음 확인에서 보관이 풀리면 바뀐 시각이 남는다
  await age(p.id, 21);
  await refreshProductStars(starsContext(), { check: checker(() => ok({ renamedTo: "neworg/renamed" })) });
  const after = await read(p.id);
  expect(after).toMatchObject({ repoArchived: false });
  expect(after.repoChangedAt).not.toBeNull();
  expect(await countProducts({ statuses: PUBLIC, repoArchived: true })).toBe(0);
});

it("한 틱에 50개씩 여덟 묶음까지 묻고, 남은 것은 다음 틱이 잇는다", async () => {
  await db.insert(products).values(Array.from({ length: 430 }, (_, index) => ({
    slug: `bulk-${index}`, name: `bulk-${index}`, url: `https://bulk-${index}.example`, tagline: "t", description: "d", category: "Dev",
    repoUrl: `https://github.com/test/bulk-${index}`, status: "seeded" as const, source: "crawler" as const, verifyToken: `v-bulk-${index}`,
    editTokenHash: "a".repeat(64),
  })));
  const check = checker(() => ok());
  expect(await refreshProductStars(starsContext(), { check })).toEqual({ done: false, cursor: null });
  // 100개 묶음은 GitHub 10초 질의 상한을 넘었다 — 50개씩(github-repositories.ts)
  expect(check.mock.calls.map(([repos]) => repos.length)).toEqual([50, 50, 50, 50, 50, 50, 50, 50]);
  check.mockClear();
  expect(await refreshProductStars(starsContext(), { check })).toEqual({ done: true, cursor: null });
  expect(check.mock.calls.map(([repos]) => repos.length)).toEqual([30]);
  const [coverage] = await db.execute<{ checked: number }>(sql`select count(*)::int as checked from products where repo_checked_at is not null`);
  expect(coverage.checked).toBe(430);
}, 30_000);

it("GraphQL 점수가 바닥나면 이번 틱을 접고 초기화 시각까지 기다린다", async () => {
  for (let index = 0; index < 150; index++) await seed();
  const reset = new Date(Date.now() + 30 * 60_000).toISOString();
  const check = checker(() => ok(), { remaining: 50, resetAt: reset });
  const ctx = starsContext();
  const result = await refreshProductStars(ctx, { check });
  expect(result).toEqual({ done: false, cursor: { retryAfter: new Date(reset).toISOString() } });
  expect(ctx.save).toHaveBeenCalledWith({ retryAfter: new Date(reset).toISOString() });
  expect(check).toHaveBeenCalledTimes(1);
  check.mockClear();
  await refreshProductStars(starsContext(result.cursor), { check });
  expect(check).not.toHaveBeenCalled();
});

it("급상승의 하루 평균은 20시간 구간을 하루로 늘려 나누지 않는다", async () => {
  const hours = (value: number) => new Date(Date.now() - value * 3_600_000);
  // 20시간에 100개(하루 120개 꼴)가 24시간에 110개보다 빠르다
  await seed({ slug: "short-window", stars: 600, starsPrevious: 500, starsPreviousAt: hours(21), starsAt: hours(1) });
  await seed({ slug: "day-window", stars: 610, starsPrevious: 500, starsPreviousAt: hours(25), starsAt: hours(1) });
  expect(await listProductSlugs({ statuses: PUBLIC, excludeDown: true, rising: true, sort: "rising", limit: 10 }))
    .toEqual(["short-window", "day-window"]);
});

// ─────────────────────────── B. 2단계 확인 ───────────────────────────

const site = (name: string, githubLinks: string[] = []): RepoReviewPage => ({ status: 200, finalUrl: `https://${name}.example/`, title: name,
  text: `${name} is a working product that helps people plan trips with friends.`, githubLinks, complete: true });
const reviewContext = (): JobContext<null> => ({ cursor: null, save: vi.fn(), hasBudget: () => true, log: vi.fn() });
/** github.com 흉내 — 키마다 정한 답, 없으면 404 */
const github = (answers: Record<string, RepoCheck> = {}) => vi.fn(async (key: string): Promise<RepoCheck> => answers[key] ?? { state: "gone" });
const repoKey = (row: { repoUrl: string | null }) => row.repoUrl!.replace("https://github.com/", "").toLowerCase();

it("저장소가 정말 없으면 사이트가 살아 있어도 내리고, 다시 열렸거나 옮겨 간 흔적이 있으면 남긴다 — 설치형도 본다", async () => {
  const gone = await seed({ name: "Gone" });
  const tool = await seed({ name: "Tool", accessMode: "installable", url: "https://github.com/test/tool" });
  const back = await seed({ name: "Back" });
  const moved = await seed({ name: "Moved" });
  const linked = await seed({ name: "Linked" });
  const alive = await seed({ name: "Alive" });
  const banned = await seed({ name: "Banned", status: "banned" });
  for (const row of [gone, tool, back, moved, linked, banned]) await markGone(row.id);
  const checkRepo = github({ [repoKey(back)]: { state: "alive" }, [repoKey(moved)]: { state: "moved", to: "org/moved" }, "test/linked-v2": { state: "alive" } });
  const openPage = vi.fn(async (url: string) => url === linked.url ? site("linked", ["test/linked-v2", "mrdoob/three.js"]) : site("plain"));

  expect(await reviewGoneRepositories(reviewContext(), { openPage, checkRepo })).toEqual({ done: true });
  // 정말 없는 둘은 내렸다 — 관리자 차단과 같은 길, 운영자 칸은 auto
  for (const row of [gone, tool]) {
    expect(await read(row.id)).toMatchObject({ status: "banned" });
    expect(await review(row.id)).toMatchObject({ decision: "delist_candidate", reason: "repo_gone", operatorDecision: "delist", operatorBy: "auto:repo-gone" });
  }
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, gone.slug)))
    .toEqual([expect.objectContaining({ action: "admin.product.ban", actor: "auto:repo-gone", reason: "repo_gone", metadata: { status: "banned" } })]);
  expect(await read(back.id)).toMatchObject({ status: "seeded" });
  expect(await review(back.id)).toMatchObject({ decision: "keep", reason: "repo_alive", operatorDecision: null });
  expect(await review(moved.id)).toMatchObject({ decision: "human", reason: "repo_moved", pageExcerpt: "github.com/org/moved" });
  expect(await review(linked.id)).toMatchObject({ decision: "human", reason: "repo_link_alive", pageExcerpt: "github.com/test/linked-v2" });
  // 다시 열렸거나 옮겨 간 것은 페이지를 열지 않고, 남의 라이브러리 링크는 열어 보지 않는다
  expect(openPage.mock.calls.map(([url]) => url).sort()).toEqual([gone.url, tool.url, linked.url].sort());
  expect(checkRepo.mock.calls.map(([key]) => key)).not.toContain("mrdoob/three.js");
  for (const row of [alive, banned]) expect(await review(row.id)).toBeUndefined();
  // 운영센터 — 내린 것은 공개가 아니라 빠진다
  expect((await attentionCounts()).repoReview).toMatchObject({ pending: 0, human: 2, delistCandidates: 0, kept: 1 });

  // 다시 돌려도 볼 때가 안 된 것은 다시 열지 않는다
  openPage.mockClear();
  checkRepo.mockClear();
  expect(await reviewGoneRepositories(reviewContext(), { openPage, checkRepo })).toEqual({ done: true });
  expect(checkRepo).not.toHaveBeenCalled();
});

it("github.com 이 답하지 않으면 적지 않고 틱을 접는다", async () => {
  const rows = [await seed(), await seed(), await seed(), await seed()];
  for (const row of rows) await markGone(row.id);
  const checkRepo = vi.fn(async (): Promise<RepoCheck> => ({ state: "unknown" }));
  const openPage = vi.fn();
  expect(await reviewGoneRepositories(reviewContext(), { openPage, checkRepo })).toEqual({ done: true });
  expect(await db.select().from(productRepoReviews)).toHaveLength(0);
  expect(await read(rows[0].id)).toMatchObject({ status: "seeded" });
  // 잇따라 둘이 막히면 그 뒤로는 묻지 않는다(동시 셋)
  expect(checkRepo.mock.calls.length).toBeLessThanOrEqual(3);
  expect(openPage).not.toHaveBeenCalled();
});

it("페이지를 못 열면 내리지 않는다 — 사이트가 사흘 넘게 죽어 있을 때만 내린다", async () => {
  const blink = await seed({ name: "Blink" });
  const dead = await seed({ name: "Dead" });
  const busy = await seed({ name: "Busy" });
  for (const row of [blink, dead, busy]) await markGone(row.id);
  await db.insert(productHealth).values([{ slug: dead.slug, status: 0, failures: 30, downSince: new Date(Date.now() - 4 * 86_400_000) },
    { slug: blink.slug, status: 0, failures: 1, downSince: new Date(Date.now() - 3_600_000) }]);
  const unreachable: RepoReviewPage = { status: 0, finalUrl: null, title: "", text: "", githubLinks: [], complete: false };
  const openPage = vi.fn(async (url: string) => url === busy.url ? { ...site("busy"), status: 503 } : unreachable);
  await reviewGoneRepositories(reviewContext(), { openPage, checkRepo: github() });
  expect(await read(blink.id)).toMatchObject({ status: "seeded" });
  expect(await review(blink.id)).toMatchObject({ decision: "human", reason: "page_unavailable" });
  expect(await review(busy.id)).toMatchObject({ decision: "human", reason: "page_unavailable" });
  expect(await read(dead.id)).toMatchObject({ status: "banned" });
});

it("열어 볼 링크가 셋을 넘으면 남은 것을 사람에게 넘긴다", async () => {
  const row = await seed({ name: "Many" });
  await markGone(row.id);
  await reviewGoneRepositories(reviewContext(), { openPage: async () => site("many", ["test/a", "test/b", "test/c", "test/d"]), checkRepo: github() });
  expect(await read(row.id)).toMatchObject({ status: "seeded" });
  expect(await review(row.id)).toMatchObject({ decision: "human", reason: "repo_links_unchecked", pageExcerpt: "github.com/test/d" });
});

it("잡이 고른 뒤 운영자가 '유지'를 골랐으면 내리지 않는다", async () => {
  const p = await reviewed("Raced", "human");
  expect(await operator(p.slug, "keep")).toMatchObject({ ok: true });
  const record = { productId: p.id, decision: "delist_candidate" as const, reason: "repo_gone", answers: null, model: null,
    pageHttpStatus: 200, finalUrl: p.url, pageTitle: null, pageExcerpt: null };
  expect(await delistGoneRepository({ ...record, slug: p.slug })).toBe("operator_keep");
  expect(await read(p.id)).toMatchObject({ status: "seeded" });
  expect(await review(p.id)).toMatchObject({ decision: "delist_candidate", operatorDecision: "keep", operatorBy: "operator" });
});

it("하루 한도만큼 내렸으면 더 내리지 않고 운영자 몫으로 둔다", async () => {
  const row = await seed({ name: "Capped" });
  await markGone(row.id);
  await db.insert(productEvidenceAudit).values(Array.from({ length: MAX_REPO_GONE_DELISTS_PER_DAY },
    (_, index) => ({ slug: `earlier-${index}`, actor: "auto:repo-gone", action: "admin.product.ban", reason: "repo_gone" })));
  await reviewGoneRepositories(reviewContext(), { openPage: async () => site("capped"), checkRepo: github() });
  expect(await read(row.id)).toMatchObject({ status: "seeded" });
  expect(await review(row.id)).toMatchObject({ decision: "delist_candidate", reason: "repo_gone", operatorDecision: null });
  expect((await attentionCounts()).repoReview).toMatchObject({ delistCandidates: 1 });
});

// ─────────────────────────── C. 운영자 결정 ───────────────────────────

async function reviewed(name: string, decision: "keep" | "delist_candidate" | "human") {
  const row = await seed({ name });
  await markGone(row.id);
  await db.insert(productRepoReviews).values({ productId: row.id, decision, reason: "model", answers: { same_product: true, parked: false, shutdown: false, no_content: false }, model: "m",
    pageHttpStatus: 200, finalUrl: row.url, reviewedAt: sql`now() - interval '1 hour'` as unknown as Date,
    nextReviewAt: decision === "keep" ? sql`now() + interval '7 days'` as unknown as Date : null });
  return row;
}
const operator = (slug: string | string[], decision: string) => {
  const form = new FormData();
  for (const value of [slug].flat()) form.append("slug", value);
  form.set("decision", decision);
  return decideRepoReviewAction(null, form);
};

it("'내리기'는 어드민 차단과 같은 길로 차단하고 결정·작업 로그를 남긴다", async () => {
  const p = await reviewed("Gone Site", "delist_candidate");
  const floor = await auditFloor();
  expect(await operator(p.slug, "delist")).toMatchObject({ ok: true });
  expect(await read(p.id)).toMatchObject({ status: "banned" });
  expect(await review(p.id)).toMatchObject({ operatorDecision: "delist", operatorBy: "operator", decision: "delist_candidate" });
  expect(await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, p.slug)))
    .toEqual([expect.objectContaining({ action: "admin.product.ban", metadata: { status: "banned" } })]);
  expect(await auditRowsAfter(floor, "repo-review-delist")).toEqual([expect.objectContaining({ actor: "operator", target: p.slug, ok: true })]);
  expect(mocks.revalidate).toHaveBeenCalledWith("/admin/products");
  // 내린 것은 다시 보지 않는다
  await db.execute(sql`update product_repo_reviews set next_review_at = now() - interval '1 day'`);
  const checkRepo = github();
  await reviewGoneRepositories(reviewContext(), { openPage: vi.fn(), checkRepo });
  expect(checkRepo).not.toHaveBeenCalled();
});

it("'유지'는 결정만 적고 30일 뒤에 다시 본다 — 다시 봐도 운영자 결정은 남고, 저장소가 여전히 없으면 내리지 않고 다시 줄에 선다", async () => {
  const p = await reviewed("Kept Site", "human");
  const floor = await auditFloor();
  expect((await attentionCounts()).repoReview).toMatchObject({ human: 1, delistCandidates: 0 });
  expect(await operator(p.slug, "keep")).toMatchObject({ ok: true });
  expect(await read(p.id)).toMatchObject({ status: "seeded" });
  const kept = await review(p.id);
  expect(kept).toMatchObject({ operatorDecision: "keep", operatorBy: "operator" });
  expect(Math.round((kept.nextReviewAt!.getTime() - kept.operatorAt!.getTime()) / 86_400_000)).toBe(30);
  expect(await auditRowsAfter(floor, "repo-review-keep")).toHaveLength(1);
  expect((await attentionCounts()).repoReview).toMatchObject({ human: 0, delistCandidates: 0 });

  // 30일 뒤 다시 본다 — 저장소는 여전히 없다. 운영자가 남긴 것이라 스스로 내리지 않는다
  await db.execute(sql`update product_repo_reviews set next_review_at = now() - interval '1 minute', operator_at = now() - interval '31 days'`);
  await reviewGoneRepositories(reviewContext(), { openPage: async () => site("kept"), checkRepo: github() });
  expect(await read(p.id)).toMatchObject({ status: "seeded" });
  expect(await review(p.id)).toMatchObject({ decision: "delist_candidate", reason: "repo_gone", operatorDecision: "keep", operatorBy: "operator" });
  expect((await attentionCounts()).repoReview).toMatchObject({ delistCandidates: 1 });
});

it("판정이 없거나 이미 내린 제품, 한 번에 둘은 받지 않는다", async () => {
  const bare = await seed();
  const p = await reviewed("Twice", "delist_candidate");
  expect(await operator(bare.slug, "delist")).toMatchObject({ error: expect.any(String) });
  expect(await read(bare.id)).toMatchObject({ status: "seeded" });
  expect(await operator([p.slug, bare.slug], "delist")).toMatchObject({ error: expect.any(String) });
  expect(await operator(p.slug, "remove")).toMatchObject({ error: expect.any(String) });
  expect(await read(p.id)).toMatchObject({ status: "seeded" });
  expect(await operator(p.slug, "delist")).toMatchObject({ ok: true });
  expect(await operator(p.slug, "keep")).toMatchObject({ error: expect.any(String) });
  mocks.admin.mockResolvedValue(null);
  expect(await operator(p.slug, "keep")).toMatchObject({ error: expect.any(String) });
});

// ─────────────────────────── D. 운영센터 지표 ───────────────────────────

it("확인 범위·상태별 수·2단계 줄을 센다", async () => {
  const fresh = await seed();
  const stale = await seed();
  const gone = await seed();
  const emptyRepo = await seed({ accessMode: "installable", url: "https://github.com/test/empty-tool" });
  const archived = await seed();
  const blocked = await seed();
  await seed({ status: "banned" });
  await seed({ repoUrl: null });
  await db.execute(sql`update products set repo_status = 'ok', repo_checked_at = now() - interval '1 hour' where id in (${fresh.id}, ${archived.id})`);
  await db.execute(sql`update products set repo_archived = true, repo_renamed_to = 'x/y', repo_changed_at = now() - interval '2 hours' where id = ${archived.id}`);
  await db.execute(sql`update products set repo_status = 'ok', repo_checked_at = now() - interval '30 hours' where id = ${stale.id}`);
  await db.execute(sql`update products set repo_status = 'blocked', repo_checked_at = now() - interval '2 hours', repo_changed_at = now() - interval '3 days' where id = ${blocked.id}`);
  await markGone(gone.id);
  await markGone(emptyRepo.id, "empty");
  await db.execute(sql`update products set repo_changed_at = now() - interval '3 hours' where id = ${emptyRepo.id}`);
  const counts = await attentionCounts();
  expect(counts.repoHealth).toEqual({ tracked: 6, checked24h: 5, states: {
    ok: { total: 3, new24h: 1 }, not_found: { total: 1, new24h: 0 }, empty: { total: 1, new24h: 1 }, blocked: { total: 1, new24h: 0 },
    archived: { total: 1, new24h: 1 }, renamed: { total: 1, new24h: 1 },
  } });
  expect(counts.repoGone).toEqual({ installable: 1, website: 1 });
  // 사라진 제품 둘(웹·설치형) — 아직 잡이 안 봤고, 확정된 지 이틀(사흘 전 시작 + 하루)
  expect(counts.repoReview).toMatchObject({ pending: 2, delistCandidates: 0, human: 0, kept: 0 });
  expect(Math.round(counts.repoReview.oldestHours!)).toBe(48);
  await db.insert(productRepoReviews).values([{ productId: gone.id, decision: "keep", reason: "repo_alive" },
    { productId: emptyRepo.id, decision: "keep", reason: "repo_alive" }]);
  expect((await attentionCounts()).repoReview).toEqual({ pending: 0, delistCandidates: 0, human: 0, kept: 2, oldestHours: null });
});
