import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations, productHealth, products } from "@/lib/db/schema";
import { clearAllMemos } from "@/lib/cache/memo";
import { POST } from "@/app/api/ops/x-query/route";
import { signXPosts } from "@/lib/operations/x-posts";
import { signXQuery, utcDay, X_QUERY_KEY } from "@/lib/operations/x-query";
import { X_STATUS_PREVIOUS_SECRET_ENV, X_STATUS_SECRET_ENV } from "@/lib/operations/x-status";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/*
 * 2026-10-21: X 수집기가 그날 검색할 우리 제품 저장소를 묻는다 — 실제 PostgreSQL 로 공개 제품 고르기와 차례 줄(x-query)을 본다.
 * 공개 제품은 /talk 와 같은 조건(seeded·verified, 응답 있음, 기본 목록, 감사 보류 아님, 저장소 살아 있음)이고 github.com 저장소만 든다.
 */
const SECRET = "x-status-current-secret-0123456789abcdef";
const DAY_MS = 86_400_000;
let serial = 0;

async function product(repoUrl: string, extra: Partial<typeof products.$inferInsert> = {}) {
  const slug = `xq-${++serial}`;
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.example`, tagline: "A useful product", description: "d", category: "Dev",
    repoUrl, stars: 100, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    createdAt: new Date(Date.now() - 200 * DAY_MS), ...extra,
  }).returning();
  return row;
}
const now = () => Math.floor(Date.now() / 1000);
function ask(options: { day?: string; sign?: typeof signXQuery } = {}) {
  const timestamp = now(), raw = JSON.stringify({ v: 1, day: options.day ?? utcDay(timestamp) });
  return new Request("https://nomorevibe.test/api/ops/x-query", { method: "POST", body: raw, headers: {
    "content-type": "application/json", "x-nmv-timestamp": String(timestamp), "x-nmv-signature": (options.sign ?? signXQuery)(SECRET, timestamp, raw) } });
}
const cursor = async () => (await db.select({ value: operationsObservations.value }).from(operationsObservations)
  .where(eq(operationsObservations.key, X_QUERY_KEY)))[0]?.value;
async function answer(request = ask()) {
  const response = await POST(request);
  return { status: response.status, body: response.status === 200 ? await response.json() as { v: 1; day: string; repositories: string[] } : null };
}
/** 저장소 이름을 길게 — 차례 한 날(160자)에 세 곳만 든다 */
const long = (name: string) => `https://github.com/acme-product/${name}-with-a-longer-name`;
const key = (name: string) => `acme-product/${name}-with-a-longer-name`;

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.delete(operationsObservations).where(eq(operationsObservations.key, X_QUERY_KEY));
  clearAllMemos();
  vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
  vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(operationsObservations).where(eq(operationsObservations.key, X_QUERY_KEY));
});

it("비밀이 없으면 404 이고 차례 줄을 쓰지 않는다 — 게시물 보고의 서명도 통하지 않는다", async () => {
  vi.stubEnv(X_STATUS_SECRET_ENV, "");
  expect((await POST(ask())).status).toBe(404);
  vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
  expect((await POST(ask({ sign: signXPosts }))).status).toBe(401);
  expect(await cursor()).toBeUndefined();
});

it("공개 제품의 github.com 저장소만, 소문자로, 같은 저장소는 한 번 — 차례를 적고 같은 날은 같은 목록을 준다", async () => {
  const kept = await product("https://github.com/Acme/Upper.git/");
  await product("https://www.github.com/acme/upper");
  await product("https://github.com/acme/banned", { status: "banned" });
  await product("https://github.com/acme/unverified", { status: "unverified" });
  await product("https://github.com/acme/held", { auditHoldAt: new Date() });
  await product("https://github.com/acme/profile", { category: "Profile" });
  await product("https://github.com/acme/gone", { repoStatus: "not_found", repoMissingSince: new Date(Date.now() - 3 * DAY_MS), repoCheckedAt: new Date() });
  const down = await product("https://github.com/acme/down", { accessMode: "website" });
  await db.insert(productHealth).values({ slug: down.slug, status: 503, failures: 3 });
  await product("https://gitlab.com/acme/elsewhere");
  await product("https://github.com/acme");
  await product(null as unknown as string);

  const first = await answer();
  expect(first).toEqual({ status: 200, body: { v: 1, day: utcDay(now()), repositories: ["acme/upper"] } });
  expect(await cursor()).toEqual({ v: 1, day: utcDay(now()), after: 0, next: kept.id });
  expect(await answer()).toEqual(first);
});

it("차례는 날마다 이어 가고, 남은 자리는 스타가 느는 제품과 새로 오른 제품이 먼저 쓴다", async () => {
  const rows = [];
  for (const name of ["a", "b", "c", "d", "e", "f", "g"]) rows.push(await product(long(name)));
  const rising = await product(long("rising"), { stars: 150, starsAt: new Date(Date.now() - 3_600_000), starsPrevious: 100, starsPreviousAt: new Date(Date.now() - 25 * 3_600_000) });
  const fresh = await product(long("fresh"), { createdAt: new Date(Date.now() - 2 * DAY_MS) });

  const today = await answer();
  expect(today.body!.repositories).toEqual([key("a"), key("b"), key("c"), key("rising"), key("fresh")]);
  expect(await cursor()).toMatchObject({ after: 0, next: rows[2].id });

  // 다음 날(차례 줄의 날짜를 어제로) — 지난 차례가 멈춘 곳 다음부터
  await db.update(operationsObservations).set({ value: sql`jsonb_set(${operationsObservations.value}, '{day}', '"2000-01-01"')` })
    .where(eq(operationsObservations.key, X_QUERY_KEY));
  const tomorrow = await answer();
  expect(tomorrow.body!.repositories).toEqual([key("d"), key("e"), key("f"), key("rising"), key("fresh")]);
  expect(await cursor()).toMatchObject({ day: utcDay(now()), after: rows[2].id, next: rows[5].id });
  expect(rising.id).toBeLessThan(fresh.id);
});

it("묻는 날짜가 보낸 시각의 UTC 날짜가 아니면 400 — 차례를 쓰지 않는다", async () => {
  await product("https://github.com/acme/tool");
  expect((await POST(ask({ day: "2000-01-01" }))).status).toBe(400);
  expect(await cursor()).toBeUndefined();
});
