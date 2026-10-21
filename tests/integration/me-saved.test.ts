import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { notifications, productMakerMembers, productReactions, userSavedProducts } from "@/lib/db/me-schema";
import { publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { clearAllMemos } from "@/lib/cache/memo";
import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { SAVED_LIMIT } from "@/lib/me/contract";
import { deleteSaved, mergeSaved, putSaved } from "@/lib/me/saved";
import { readDatabaseIdentity } from "@/lib/operations/dr/epoch";
import { GET as me } from "@/app/api/me/route";
import { GET, POST as merge } from "@/app/api/me/saved/route";
import { DELETE, PUT } from "@/app/api/me/saved/[slug]/route";
import { POST as summaries } from "@/app/api/product-summaries/route";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/*
 * 계정 저장 목록 API(마이페이지 MY2·로그인 설계 L4) — 실제 PostgreSQL 로 route handler 를 직접 부른다.
 * 로그인·CSRF·Origin, 멱등, 500개 상한, 합치기, 공개되지 않은 제품, 다른 사람의 행, 써봤어요(product_reactions) 거르기.
 */
const SITE = "https://nomorevibe.example";
type Account = { id: number; token: string; csrf: string };

function call(method: string, path: string, { account, csrf = account?.csrf, origin = SITE, body }: { account?: Account; csrf?: string | null; origin?: string | null; body?: unknown } = {}) {
  const headers = new Headers();
  if (account) headers.set("cookie", `nmv_user=${account.token}`);
  if (csrf) headers.set("x-csrf-token", csrf);
  if (origin) headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${SITE}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
}
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const noParams = { params: Promise.resolve({}) };
const put = (slug: string, account?: Account, options: Parameters<typeof call>[2] = {}) => PUT(call("PUT", `/api/me/saved/${slug}`, { account, ...options }), params(slug));
const remove = (slug: string, account?: Account) => DELETE(call("DELETE", `/api/me/saved/${slug}`, { account }), params(slug));
const list = async (account: Account, query = "") => {
  const response = await GET(call("GET", `/api/me/saved${query}`, { account, origin: null }));
  return { status: response.status, body: await response.json() };
};

async function user(name: string): Promise<Account> {
  const [row] = await db.insert(publicUsers).values({ displayName: name }).returning({ id: publicUsers.id });
  const session = newPublicSession();
  await db.insert(publicSessions).values({ tokenHash: session.tokenHash, userId: row.id, expiresAt: session.expiresAt });
  return { id: row.id, token: session.token, csrf: csrfForToken(session.token, "session") };
}

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}): Promise<number> {
  const [row] = await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: `${slug} tagline`, description: "Test", category: "Productivity",
    status: "verified", source: "skill", verifyToken: `${slug}-verify`, editTokenHash: `${slug}-hash`, ...values,
  }).returning({ id: products.id });
  return row.id;
}

const rows = (userId: number) => db.select().from(userSavedProducts).where(eq(userSavedProducts.userId, userId));

/** 다른 연결 count 개가 행 잠금을 기다릴 때까지 — 기다리지 않고 끝났으면(done) 바로 멈춘다 */
async function lockWaiters(count: number, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250 && !done(); attempt++) {
    const [row] = await db.execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`);
    if (Number(row.waiting) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const lockUserRow = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: number) =>
  tx.select({ id: publicUsers.id }).from(publicUsers).where(eq(publicUsers.id, userId)).for("update");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-at-least-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  clearAllMemos();
  await resetTables();
});
afterEach(() => vi.unstubAllEnvs());

describe("로그인·CSRF·Origin", () => {
  it("로그인하지 않으면 읽기·쓰기 모두 401, 응답은 private no-store", async () => {
    await product("alpha");
    const read = await GET(call("GET", "/api/me/saved"));
    expect(read.status).toBe(401);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    expect(await read.json()).toEqual({ error: "login_required" });
    expect((await put("alpha")).status).toBe(401);
  });

  it("CSRF 토큰이 없거나 다른 사람의 것이면, Origin 이 다르면 403 이고 쓰지 않는다", async () => {
    const reader = await user("reader"), other = await user("other");
    await product("alpha");
    const missing = await put("alpha", reader, { csrf: null });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "invalid_csrf" });
    expect((await put("alpha", reader, { csrf: other.csrf })).status).toBe(403);
    const foreign = await put("alpha", reader, { origin: "https://evil.example" });
    expect(await foreign.json()).toEqual({ error: "invalid_origin" });
    const merged = await merge(call("POST", "/api/me/saved", { account: reader, csrf: null, body: { slugs: ["alpha"] } }));
    expect(merged.status).toBe(403);
    expect(await rows(reader.id)).toHaveLength(0);
  });

  it("로그인 기능이 꺼져 있으면 404", async () => {
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false");
    const reader = { id: 0, token: newPublicSession().token, csrf: "0".repeat(64) };
    expect((await GET(call("GET", "/api/me/saved", { account: reader }))).status).toBe(404);
  });
});

describe("넣기·빼기", () => {
  it("PUT·DELETE 는 멱등이고 목록에 저장한 때와 써봤는지가 실린다", async () => {
    const reader = await user("reader");
    await product("alpha");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await put("alpha", reader);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ saved: true, total: 1 });
    }
    const [row] = await rows(reader.id);
    expect(row.source).toBe("web");
    const { body } = await list(reader);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ slug: "alpha", name: "alpha", tagline: "alpha tagline", category: "Productivity", tried: false });
    expect(new Date(body.items[0].savedAt).getTime()).toBe(row.createdAt.getTime());
    expect(body.items[0]).not.toHaveProperty("id");
    expect(body.items[0]).not.toHaveProperty("metrics");
    expect(body).toMatchObject({ counts: { all: 1, untried: 1 }, categories: [{ key: "Productivity", count: 1 }], total: 1, nextCursor: null });
    for (let attempt = 0; attempt < 2; attempt++) expect(await (await remove("alpha", reader)).json()).toEqual({ saved: false, total: 0 });
    expect(await rows(reader.id)).toHaveLength(0);
  });

  it("모르는 주소·잘못된 주소는 넣지 않는다", async () => {
    const reader = await user("reader");
    expect(await (await put("missing", reader)).json()).toEqual({ error: "product_not_found" });
    expect((await put("Bad_Slug", reader)).status).toBe(400);
  });

  it(`상한 ${SAVED_LIMIT}개 — 넘는 저장은 saved_limit 409, 이미 있는 것은 그대로 200`, async () => {
    const reader = await user("reader");
    const ids = await db.insert(products).values(Array.from({ length: SAVED_LIMIT }, (_, index) => ({
      slug: `bulk-${index}`, url: `https://bulk-${index}.example`, name: `bulk ${index}`, tagline: "bulk", description: "Test",
      category: "Dev", status: "verified" as const, verifyToken: `bulk-${index}-verify`, editTokenHash: `bulk-${index}-hash`,
    }))).returning({ id: products.id });
    await db.insert(userSavedProducts).values(ids.map(({ id }) => ({ userId: reader.id, productId: id })));
    await product("one-more");
    const over = await put("one-more", reader);
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "saved_limit" });
    expect((await put("bulk-3", reader)).status).toBe(200);
    const merged = await merge(call("POST", "/api/me/saved", { account: reader, body: { slugs: ["one-more", "bulk-4"] } }));
    expect(await merged.json()).toEqual({ merged: 0, skipped: 1, total: SAVED_LIMIT });
    expect(await rows(reader.id)).toHaveLength(SAVED_LIMIT);
  });

  it("두 기기가 동시에 마지막 자리를 노려도 상한을 넘지 않는다", async () => {
    const reader = await user("reader");
    const ids = await db.insert(products).values(Array.from({ length: SAVED_LIMIT - 1 }, (_, index) => ({
      slug: `fill-${index}`, url: `https://fill-${index}.example`, name: `fill ${index}`, tagline: "fill", description: "Test",
      category: "Dev", status: "verified" as const, verifyToken: `fill-${index}-verify`, editTokenHash: `fill-${index}-hash`,
    }))).returning({ id: products.id });
    await db.insert(userSavedProducts).values(ids.map(({ id }) => ({ userId: reader.id, productId: id })));
    await product("phone");
    await product("laptop");
    const results = await Promise.all([put("phone", reader), put("laptop", reader)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await rows(reader.id)).toHaveLength(SAVED_LIMIT);
  });

  it("탈퇴가 사용자 행을 잠근 사이 기다리던 넣기·합치기·빼기는 탈퇴 뒤 멈추고 지운 계정에 행을 되살리지 않는다", async () => {
    const reader = await user("reader");
    await product("alpha");
    await product("beta");
    let settled = false;
    let writes!: Promise<PromiseSettledResult<unknown>[]>;
    await db.transaction(async (tx) => {
      // deleteAccount 처럼 사용자 행을 잠그고 지운 뒤 deleted_at 을 쓴다 — 세션 확인을 이미 지난 쓰기가 잠금에서 기다린다
      await lockUserRow(tx, reader.id);
      writes = Promise.allSettled([putSaved(reader.id, "alpha"), mergeSaved(reader.id, ["beta"]), deleteSaved(reader.id, "alpha")])
        .then((results) => { settled = true; return results; });
      await lockWaiters(3, () => settled);
      await tx.delete(userSavedProducts).where(eq(userSavedProducts.userId, reader.id));
      await tx.update(publicUsers).set({ deletedAt: sql`now()` }).where(eq(publicUsers.id, reader.id));
    });
    const results = await writes;
    expect(results.map((result) => result.status === "rejected" && result.reason instanceof PublicAuthError ? result.reason.status : result.status)).toEqual([401, 401, 401]);
    expect(await rows(reader.id)).toHaveLength(0);
  });

  it("빼기는 합치기와 줄을 선다 — 합치기가 넣는 중(커밋 전)인 주소를 먼저 빼고 끝나지 않는다", async () => {
    const reader = await user("reader");
    const alpha = await product("alpha");
    let done = false;
    let removal!: Promise<unknown>;
    await db.transaction(async (tx) => {
      // mergeSaved 처럼 사용자 행을 잠그고 넣었다 — 아직 커밋 전이라 다른 연결에는 보이지 않는다
      await lockUserRow(tx, reader.id);
      await tx.insert(userSavedProducts).values({ userId: reader.id, productId: alpha, source: "merge" });
      removal = deleteSaved(reader.id, "alpha").finally(() => { done = true; });
      await lockWaiters(1, () => done);
    });
    expect(await removal).toEqual({ saved: false, total: 0 });
    expect(await rows(reader.id)).toHaveLength(0);
  });

  it("fenced DB 면 503·Retry-After 이고 아무것도 쓰지 않는다", async () => {
    const reader = await user("reader");
    await product("alpha");
    const site = await db.transaction((tx) => readDatabaseIdentity(tx));
    await db.execute(sql`update dr_writer_fence set state = 'fenced', reason = 'operator_fence', fenced_db = ${JSON.stringify(site)}::jsonb where id = 1`);
    clearAllMemos();
    try {
      const response = await put("alpha", reader);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      const merged = await merge(call("POST", "/api/me/saved", { account: reader, body: { slugs: ["alpha"] } }));
      expect(merged.status).toBe(503);
      // 읽기는 그대로 된다
      expect((await list(reader)).status).toBe(200);
    } finally {
      await db.execute(sql`update dr_writer_fence set state = 'active', reason = null, fenced_db = null where id = 1`);
      clearAllMemos();
    }
    expect(await rows(reader.id)).toHaveLength(0);
  });
});

describe("공개되지 않은 제품·다른 사람의 행", () => {
  it("내린·검증 전·주인 없는 개인 프로필은 넣지 않고, 저장 뒤 내려가면 목록에서 빠진다", async () => {
    const reader = await user("reader");
    await product("banned", { status: "banned" });
    await product("draft", { status: "unverified" });
    await product("portfolio", { category: "Profile", source: "crawler", status: "seeded" });
    await product("seeded", { status: "seeded", source: "crawler" });
    const later = await product("later");
    for (const slug of ["banned", "draft", "portfolio"]) expect((await put(slug, reader)).status).toBe(404);
    expect((await put("seeded", reader)).status).toBe(200);
    expect((await put("later", reader)).status).toBe(200);
    await db.update(products).set({ status: "banned" }).where(eq(products.id, later));
    const { body } = await list(reader);
    expect(body.items.map((item: { slug: string }) => item.slug)).toEqual(["seeded"]);
    expect(body.counts.all).toBe(1);
    expect((await list(reader, "?view=slugs")).body).toEqual({ slugs: ["seeded"] });
    await db.delete(products).where(eq(products.slug, "seeded"));
    expect((await list(reader, "?view=slugs")).body).toEqual({ slugs: [] });
  });

  it("다른 사람의 저장은 보이지 않고 빼지도 못한다", async () => {
    const reader = await user("reader"), other = await user("other");
    await product("mine");
    await product("theirs");
    await put("mine", reader);
    await put("theirs", other);
    expect((await list(reader)).body.items.map((item: { slug: string }) => item.slug)).toEqual(["mine"]);
    expect((await list(reader, "?view=slugs")).body).toEqual({ slugs: ["mine"] });
    await remove("theirs", reader);
    expect(await rows(other.id)).toHaveLength(1);
  });
});

describe("거르기·정렬·커서", () => {
  it("아직 안 써봄은 내 product_reactions 행이 없는 것 — 다른 사람의 평가는 세지 않는다", async () => {
    const reader = await user("reader"), other = await user("other");
    const tried = await product("tried", { category: "Design" });
    const untried = await product("untried");
    await put("tried", reader);
    await put("untried", reader);
    await db.insert(productReactions).values([
      { productId: tried, userId: reader.id, verdict: "good", source: "panel", locale: "ko" },
      { productId: untried, userId: other.id, verdict: "bad", source: "panel", locale: "ko" },
    ]);
    const all = (await list(reader)).body;
    expect(all.counts).toEqual({ all: 2, untried: 1 });
    expect(Object.fromEntries(all.items.map((item: { slug: string; tried: boolean }) => [item.slug, item.tried]))).toEqual({ tried: true, untried: false });
    const filtered = (await list(reader, "?filter=untried")).body;
    expect(filtered.items.map((item: { slug: string }) => item.slug)).toEqual(["untried"]);
    expect(filtered.total).toBe(1);
    expect(filtered.categories).toEqual([{ key: "Productivity", count: 1 }]);
    const design = (await list(reader, "?category=Design")).body;
    expect(design.items.map((item: { slug: string }) => item.slug)).toEqual(["tried"]);
    expect(design.counts).toEqual({ all: 1, untried: 0 });
    expect((await list(reader, "?filter=tried")).status).toBe(400);
  });

  it("커서로 이어 받으면 빠짐·겹침이 없고, 스타·최근 활동·저장한 순으로 줄 선다", async () => {
    const reader = await user("reader");
    for (let index = 0; index < 30; index++) {
      const id = await product(`p-${index}`, { stars: index % 3 === 0 ? null : index * 10, repoPushedAt: index < 5 ? new Date(Date.UTC(2026, 9, 1 + index)) : null });
      // 저장한 때는 제품 id 와 거꾸로 — 저장한 순이 id 로 이어 붙인 순과 달라야 정렬 열쇠를 잰다
      await db.insert(userSavedProducts).values({ userId: reader.id, productId: id, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 29 - index)) });
    }
    for (const sort of ["recent", "stars", "activity"] as const) {
      const first = (await list(reader, `?sort=${sort}`)).body;
      expect(first.items).toHaveLength(24);
      expect(first.total).toBe(30);
      const second = (await list(reader, `?sort=${sort}&cursor=${first.nextCursor}`)).body;
      expect(second.nextCursor).toBeNull();
      const slugs = [...first.items, ...second.items].map((item: { slug: string }) => item.slug);
      expect(new Set(slugs).size).toBe(30);
      if (sort === "recent") expect(slugs).toEqual(Array.from({ length: 30 }, (_, index) => `p-${index}`));
      if (sort === "stars") {
        expect(slugs.slice(0, 2)).toEqual(["p-29", "p-28"]);
        // 스타를 모르는 제품은 맨 뒤
        expect(slugs.slice(-10).every((slug) => Number(slug.slice(2)) % 3 === 0)).toBe(true);
      }
      if (sort === "activity") expect(slugs.slice(0, 5)).toEqual(["p-4", "p-3", "p-2", "p-1", "p-0"]);
    }
    const first = (await list(reader, "?sort=stars")).body;
    expect((await list(reader, `?sort=recent&cursor=${first.nextCursor}`)).body).toEqual({ error: "invalid_cursor" });
    expect((await list(reader, "?cursor=not-a-cursor")).status).toBe(400);
  });
});

describe("첫 로그인 합치기", () => {
  const mergeCall = (account: Account, body: unknown) => merge(call("POST", "/api/me/saved", { account, body }));

  it("없는 것만 source=merge 로 넣고, 모르는·공개되지 않은 주소는 건너뛰고, 두 번 보내도 한 번만", async () => {
    const reader = await user("reader");
    await product("alpha");
    await product("beta");
    await product("banned", { status: "banned" });
    await put("beta", reader);
    const first = await mergeCall(reader, { slugs: ["alpha", "beta", "unknown", "banned", "alpha"] });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(await first.json()).toEqual({ merged: 1, skipped: 2, total: 2 });
    expect(await (await mergeCall(reader, { slugs: ["alpha", "beta", "unknown", "banned"] })).json()).toEqual({ merged: 0, skipped: 2, total: 2 });
    const stored = await db.select({ source: userSavedProducts.source }).from(userSavedProducts)
      .innerJoin(products, eq(products.id, userSavedProducts.productId)).where(and(eq(userSavedProducts.userId, reader.id), eq(products.slug, "alpha")));
    expect(stored).toEqual([{ source: "merge" }]);
  });

  it("이 브라우저 순서(오래된 것 먼저)를 저장한 순으로 남긴다", async () => {
    const reader = await user("reader");
    // 제품 id 는 브라우저 순서와 거꾸로 — 같은 시각이면 id 로 줄 서므로, 순서가 남는지는 저장한 때로만 맞는다
    for (const slug of ["new", "mid", "old"]) await product(slug);
    await mergeCall(reader, { slugs: ["old", "mid", "new"] });
    expect((await list(reader)).body.items.map((item: { slug: string }) => item.slug)).toEqual(["new", "mid", "old"]);
  });

  it("본문은 JSON·주소 500개·약 40KB 까지", async () => {
    const reader = await user("reader");
    expect((await merge(call("POST", "/api/me/saved", { account: reader, body: undefined }))).status).toBe(415);
    expect(await (await mergeCall(reader, { slugs: Array.from({ length: SAVED_LIMIT + 1 }, (_, index) => `s-${index}`) })).json()).toEqual({ error: "invalid_slugs" });
    expect(await (await mergeCall(reader, { slugs: ["../etc"] })).json()).toEqual({ error: "invalid_slugs" });
    expect(await (await mergeCall(reader, "{nope")).json()).toEqual({ error: "invalid_request" });
    const long = Array.from({ length: SAVED_LIMIT }, (_, index) => `${"x".repeat(76)}${String(index).padStart(3, "0")}`);
    expect((await mergeCall(reader, { slugs: long })).status).toBe(200);
    expect((await mergeCall(reader, { slugs: long, pad: "x".repeat(50_000) })).status).toBe(413);
  });

  it("합치기는 한 시간 10번까지", async () => {
    const reader = await user("reader");
    for (let attempt = 0; attempt < 10; attempt++) expect((await mergeCall(reader, { slugs: [] })).status).toBe(200);
    expect(await (await mergeCall(reader, { slugs: [] })).json()).toEqual({ error: "saved_rate_limited" });
  });

  it("합치기는 목록 주소(POST /api/me/saved)라 'merge' 같은 이름의 제품도 제품 주소로 넣고 뺀다", async () => {
    const reader = await user("reader");
    await product("merge");
    expect(await (await put("merge", reader)).json()).toEqual({ saved: true, total: 1 });
    expect(await (await remove("merge", reader)).json()).toEqual({ saved: false, total: 0 });
  });
});

describe("머리 값 — GET /api/me?view=header", () => {
  const header = async (account?: Account, query = "?view=header") => {
    const response = await me(call("GET", `/api/me${query}`, { account, origin: null }));
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  };

  it("로그아웃이면 user null, view 가 없으면 예전처럼 세션만", async () => {
    expect(await header()).toEqual({ status: 200, cache: "private, no-store", body: { user: null, csrfToken: null } });
    const reader = await user("reader");
    expect((await header(reader, "")).body).toEqual({ user: { id: reader.id, displayName: "reader" }, csrfToken: reader.csrf });
  });

  it("수단·메이커인지·안 읽은 수(100에서 멈춤)·저장 판을 함께 주고, 저장이 바뀌면 판이 바뀐다", async () => {
    const reader = await user("reader");
    const alpha = await product("alpha");
    await product("beta");
    await db.insert(publicIdentities).values({ userId: reader.id, provider: "github", subject: "42", providerLogin: "sky" });
    await db.insert(productMakerMembers).values({ productId: alpha, userId: reader.id, role: "owner", method: "github_repo_owner" });
    await db.insert(notifications).values(Array.from({ length: 101 }, (_, index) => ({ userId: reader.id, kind: "maker_reply" as const, dedupeKey: `n-${index}` })));
    const first = (await header(reader)).body;
    expect(first).toMatchObject({ user: { id: reader.id, displayName: "reader" }, csrfToken: reader.csrf, isMaker: true,
      providers: [{ provider: "github", login: "sky" }], unreadAlerts: 100, savedVersion: "0:0" });
    await put("alpha", reader);
    const saved = (await header(reader)).body.savedVersion;
    expect(saved).toMatch(/^1:\d+$/);
    // 내려간 제품은 판에서도 빠진다 — 저장 탭·계정 목록과 같은 공개 조건
    await db.update(products).set({ status: "banned" }).where(eq(products.id, alpha));
    expect((await header(reader)).body.savedVersion).toBe("0:0");
    await put("beta", reader);
    expect((await header(reader)).body.savedVersion).not.toBe(saved);
  });
});

describe("로그아웃 목록 카드 — POST /api/product-summaries", () => {
  it("쿠키 없이 공개 제품만 보낸 순서대로, 상한·형식을 지킨다", async () => {
    await product("alpha");
    await product("beta", { stars: 12 });
    await product("banned", { status: "banned" });
    const response = await summaries(call("POST", "/api/product-summaries", { origin: null, body: { slugs: ["beta", "banned", "nope", "alpha"], locale: "ko" } }), noParams);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.items.map((item: { slug: string }) => item.slug)).toEqual(["beta", "alpha"]);
    expect(body.items[0]).toMatchObject({ slug: "beta", stars: 12, category: "Productivity" });
    expect(body.items[0]).not.toHaveProperty("id");
    const tooMany = await summaries(call("POST", "/api/product-summaries", { body: { slugs: Array.from({ length: 101 }, (_, index) => `s-${index}`) } }), noParams);
    expect(tooMany.status).toBe(400);
    expect((await summaries(new Request(`${SITE}/api/product-summaries`, { method: "POST", body: "slugs=alpha" }), noParams)).status).toBe(415);
  });
});
