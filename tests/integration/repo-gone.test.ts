import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import type { RepositoryCheck, RepositoryRef } from "@/lib/crawl/github-repositories";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { getPopularPage } from "@/lib/domain/products/popular";
import { categoryCounts, countProducts, listProductSlugs, update } from "@/lib/domain/products/repository";
import { getPublicList } from "@/lib/domain/products/view";
import { refreshProductStars, type StarsCursor } from "@/lib/jobs/products/stars-refresh";
import type { JobContext } from "@/lib/jobs/runner";
import { attentionCounts } from "@/lib/operations/dashboard";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 공개 제품의 GitHub 저장소가 사라졌을 때 — 저장소 확인 잡이 답을 적고(0060·0061), 하루 넘게 없음이 이어지면
 * 설치형은 목록에서 가리고 웹사이트는 GitHub 신호만 뺀다(repository.ts repoGone).
 */

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

type Answer = RepositoryCheck;
const ok = (stars: number): Answer => ({ status: "ok", facts: { stars, ownerType: "User", archived: false, pushedAt: null, renamedTo: null } });
const notFound: Answer = { status: "not_found", facts: null };
/** GraphQL 묶음 대신 — 저장소마다 답을 고른다. 부른 저장소 이름(owner/name)을 남긴다 */
const checker = (answer: (repo: RepositoryRef) => Answer) => vi.fn(async (repos: RepositoryRef[]) =>
  ({ ok: true as const, checks: repos.map(answer), rateLimit: null }));
const asked = (check: ReturnType<typeof checker>) => check.mock.calls.flatMap(([repos]) => repos.map((repo) => `${repo.owner}/${repo.name}`));
const context = (): JobContext<StarsCursor> => ({ cursor: null, save: vi.fn(), hasBudget: () => true, log: vi.fn() });
const PUBLIC = ["seeded", "verified"] as ("seeded" | "verified")[];

let serial = 0;
async function seed(overrides: Partial<typeof products.$inferInsert> = {}) {
  const slug = overrides.slug ?? `gone-${++serial}`;
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.example`, tagline: "A useful product", description: "description", category: "Dev",
    repoUrl: `https://github.com/test/${slug}`, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    ...overrides,
  }).returning();
  return row;
}
const read = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
/** 하루가 지나 다시 볼 때가 된 것처럼 — 스타·확인 시각을 SQL 시계로 뒤로 민다(도커 시계가 호스트와 어긋나도 맞게) */
const age = (id: number, hours: number) => db.execute(sql`update products set stars_at = now() - ${hours} * interval '1 hour',
  stars_checked_at = now() - ${hours} * interval '1 hour', repo_checked_at = repo_checked_at - ${hours} * interval '1 hour',
  repo_missing_since = repo_missing_since - ${hours} * interval '1 hour' where id = ${id}`);
/** 하루 넘게 404 가 이어진 상태를 바로 만든다 */
const markGone = (id: number) => db.execute(sql`update products set repo_status = 'not_found',
  repo_missing_since = now() - interval '3 days', repo_checked_at = now() - interval '1 hour', stars_checked_at = now() - interval '1 hour' where id = ${id}`);

it("200 은 'ok', 스타가 0이어도 'ok' 다", async () => {
  const zero = await seed();
  await refreshProductStars(context(), { check: checker(() => ok(0)) });
  expect(await read(zero.id)).toMatchObject({ stars: 0, repoStatus: "ok", repoMissingSince: null });
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(0);
});

it("404 는 이어진 시작을 남기고, 하루 넘게 떨어진 두 번째 404 에서야 사라졌다고 본다 — 200 이 오면 풀린다", async () => {
  const p = await seed({ stars: 120, starsAt: new Date() });
  await age(p.id, 30);
  let answer: Answer = notFound;
  const request = checker(() => answer);

  await refreshProductStars(context(), { check: request });
  const first = await read(p.id);
  expect(first).toMatchObject({ repoStatus: "not_found", stars: 120 });
  expect(first.repoMissingSince).not.toBeNull();
  expect(first.repoMissingSince!.getTime()).toBe(first.repoCheckedAt!.getTime());
  // 한 번의 404 로는 아니다 — 비공개로 잠깐 돌린 것일 수 있다
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(0);

  // 하루 안에는 다시 묻지 않는다
  request.mockClear();
  await db.execute(sql`update products set stars_checked_at = now() - interval '2 hours', repo_checked_at = now() - interval '23 hours' where id = ${p.id}`);
  await refreshProductStars(context(), { check: request });
  expect(request).not.toHaveBeenCalled();

  // 하루가 지나 다시 404 — 시작은 그대로, 판정이 선다
  await age(p.id, 25);
  const since = (await read(p.id)).repoMissingSince!;
  await refreshProductStars(context(), { check: request });
  expect(request).toHaveBeenCalledTimes(1);
  const second = await read(p.id);
  expect(second.repoMissingSince!.getTime()).toBe(since.getTime());
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(1);

  // 다시 공개되면 저절로 풀린다
  answer = ok(130);
  await age(p.id, 25);
  await refreshProductStars(context(), { check: request });
  expect(await read(p.id)).toMatchObject({ repoStatus: "ok", repoMissingSince: null, stars: 130 });
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(0);
});

it("비활성·잠김·접근 금지는 'blocked' 로 적고 잡을 세우지 않는다", async () => {
  const legal = await seed();
  const blocked = await seed();
  const after = await seed();
  const request = checker((repo) => repo.name === legal.slug ? { status: "blocked", facts: null }
    : repo.name === blocked.slug ? { status: "blocked", facts: { stars: 9, ownerType: "User", archived: false, pushedAt: null, renamedTo: null } } : ok(5));
  const result = await refreshProductStars(context(), { check: request });
  expect(result).toEqual({ done: true, cursor: null });
  expect(await read(legal.id)).toMatchObject({ repoStatus: "blocked", repoMissingSince: null });
  expect(await read(blocked.id)).toMatchObject({ repoStatus: "blocked", repoMissingSince: null });
  expect(await read(after.id)).toMatchObject({ repoStatus: "ok", stars: 5 });
  // 막힌 저장소는 하루 뒤에, 있는 저장소는 20시간 뒤에 다시 본다
  request.mockClear();
  await db.execute(sql`update products set stars_checked_at = now() - interval '2 hours', repo_checked_at = now() - interval '21 hours'`);
  await refreshProductStars(context(), { check: request });
  expect(asked(request)).toEqual([`test/${after.slug}`]);
  // 막힌 것은 사라진 것이 아니다
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(0);
});

it("알 수 없는 별칭 오류·묶음 전체 실패는 지난 답을 바꾸지 않고 시도 시각만 남긴다", async () => {
  const unknown = await seed();
  const failedBatch = await seed();
  for (const row of [unknown, failedBatch]) await markGone(row.id);
  await db.execute(sql`update products set stars_checked_at = now() - interval '25 hours', repo_checked_at = now() - interval '25 hours'`);
  const before = await Promise.all([unknown, failedBatch].map((row) => read(row.id)));
  await refreshProductStars(context(), { check: checker(() => ({ status: null, facts: null })) });
  // 묶음 전체가 시간 초과·5xx — GitHub 이 흔들리는 동안은 뒤 묶음을 보내지 않는다
  await db.execute(sql`update products set stars_checked_at = now() - interval '25 hours' where id = ${failedBatch.id}`);
  const failing = vi.fn(async () => ({ ok: false as const, error: { kind: "transport" as const } }));
  expect(await refreshProductStars(context(), { check: failing })).toEqual({ done: false, cursor: null });
  for (const [index, row] of [unknown, failedBatch].entries()) {
    const after = await read(row.id);
    expect(after).toMatchObject({ repoStatus: "not_found", repoMissingSince: before[index].repoMissingSince, repoCheckedAt: before[index].repoCheckedAt });
    expect(after.starsCheckedAt!.getTime()).toBeGreaterThan(before[index].starsCheckedAt!.getTime());
  }
  // 일시적인 실패만 있었던 저장소는 한 시간 뒤에 다시 본다
  const request = checker(() => ok(1));
  await refreshProductStars(context(), { check: request });
  expect(request).not.toHaveBeenCalled();
  await db.execute(sql`update products set stars_checked_at = now() - interval '2 hours' where id = ${unknown.id}`);
  await refreshProductStars(context(), { check: request });
  expect(asked(request)).toEqual([`test/${unknown.slug}`]);
});

it("설치형은 저장소가 사라지면 공개 목록·개수·검색에서 가려지고 200 이 오면 돌아온다", async () => {
  const gone = await seed({ accessMode: "installable", url: "https://github.com/test/installable-gone", slug: "installable-gone", name: "Deleted Tool" });
  await seed({ accessMode: "installable", url: "https://github.com/test/installable-alive", slug: "installable-alive" });
  await markGone(gone.id);
  const slugs = async () => (await getPublicList(10)).map((item) => item.slug);
  expect(await slugs()).toEqual(["installable-alive"]);
  expect(await countProducts({ statuses: PUBLIC, excludeDown: true })).toBe(1);
  expect(await categoryCounts({ statuses: PUBLIC, excludeDown: true })).toEqual({ Dev: 1 });
  expect(await listProductSlugs({ statuses: PUBLIC, excludeDown: true, query: "Deleted Tool", limit: 10 })).toEqual([]);
  // 어드민 목록은 가리지 않는다
  expect(await countProducts({ statuses: PUBLIC })).toBe(2);
  // 상세는 열리되 설치 안내 대신 사라졌다고 알린다
  expect(await getProductIdentity("installable-gone")).toMatchObject({ repoGone: true, stars: null });

  await db.execute(sql`update products set stars_at = now() - interval '2 days', stars_checked_at = now() - interval '2 days',
    repo_checked_at = now() - interval '2 days' where id = ${gone.id}`);
  await refreshProductStars(context(), { check: checker(() => ok(3)) });
  expect((await slugs()).sort()).toEqual(["installable-alive", "installable-gone"]);
});

it("웹사이트는 목록에 남되 급상승·스타 구간·스타순·카드와 상세의 ★ 에서 빠진다", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
  const dayAgo = new Date(Date.now() - 86_400_000);
  const rising = { stars: 500, starsPrevious: 100, starsPreviousAt: twoDaysAgo, starsAt: dayAgo };
  const gone = await seed({ slug: "site-gone", ...rising });
  await seed({ slug: "site-alive", ...rising, stars: 400 });
  const bigGone = await seed({ slug: "big-gone", stars: 4500, starsAt: dayAgo });
  await seed({ slug: "big-alive", stars: 3000, starsAt: dayAgo });
  await markGone(gone.id);
  await markGone(bigGone.id);

  const list = await getPublicList(10);
  expect(list.map((item) => item.slug).sort()).toEqual(["big-alive", "big-gone", "site-alive", "site-gone"]);
  expect(list.find((item) => item.slug === "site-gone")).toMatchObject({ stars: null, starsPrevious: null });
  expect(list.find((item) => item.slug === "site-alive")).toMatchObject({ stars: 400 });

  expect(await listProductSlugs({ statuses: PUBLIC, excludeDown: true, rising: true, sort: "rising", limit: 10 })).toEqual(["site-alive"]);
  expect((await getPopularPage("rising")).items.map((item) => item.slug)).toEqual(["big-alive"]);
  // 스타순에서는 스타가 없는 것처럼 맨 뒤로 — 4,500 이라는 옛 값으로 앞서지 않는다
  expect(await listProductSlugs({ statuses: PUBLIC, excludeDown: true, sort: "stars", limit: 10 }))
    .toEqual(["big-alive", "site-alive", "big-gone", "site-gone"]);
  expect(await getProductIdentity("site-gone")).toMatchObject({ repoGone: true, stars: null, starsAt: null });
  expect(await getProductIdentity("site-alive")).toMatchObject({ repoGone: false, stars: 400 });
});

it("어드민 거르기와 운영센터가 사라진 저장소를 이용 방식별로 센다", async () => {
  const installable = await seed({ accessMode: "installable", url: "https://github.com/test/tool" });
  const website = await seed();
  const banned = await seed({ status: "banned" });
  const once = await seed();
  for (const row of [installable, website, banned]) await markGone(row.id);
  // 한 번의 404 는 아직 아니다
  await db.execute(sql`update products set repo_status = 'not_found', repo_missing_since = now(), repo_checked_at = now() where id = ${once.id}`);
  expect(await countProducts({ statuses: PUBLIC, repoGone: true })).toBe(2);
  expect((await attentionCounts()).repoGone).toEqual({ installable: 1, website: 1 });
});

it("저장소 주소를 바꾸면 이전 저장소의 답을 지운다", async () => {
  const p = await seed();
  await markGone(p.id);
  await update(p.id, { repoUrl: "https://github.com/test/replacement" });
  expect(await read(p.id)).toMatchObject({ repoStatus: null, repoCheckedAt: null, repoMissingSince: null, repoArchived: null, repoRenamedTo: null });
});
