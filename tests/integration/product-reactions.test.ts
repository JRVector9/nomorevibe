import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { clearAllMemos } from "@/lib/cache/memo";
import { db } from "@/lib/db";
import { clickEvents, operationsAudit, products, rateLimits } from "@/lib/db/schema";
import { makerReplies, productReactions } from "@/lib/db/me-schema";
import { publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { productVisitorHash } from "@/lib/domain/products/visitors";
import { REACTION_CHANGES_PER_DAY } from "@/lib/domain/reactions/contract";
import { reactionRateKey } from "@/lib/domain/reactions/repository";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const ORIGIN = "https://nomorevibe.example";
const VISITOR = "0b6f4a1e-7d1c-4a55-9f0e-2c3d4e5f6a7b";
const OTHER_VISITOR = "9a8b7c6d-5e4f-4321-8a9b-0c1d2e3f4a5b";

const reactions = () => import("@/app/api/products/[slug]/reactions/route");
const meList = () => import("@/app/api/me/reactions/route");
const browserList = () => import("@/app/api/me/reactions/browser/route");
const merge = () => import("@/app/api/me/reactions/merge/route");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PRODUCT_REACTIONS_ENABLED", "true");
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-at-least-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("VISITOR_HASH_SECRET", "integration-visitor-hash-secret-32-characters");
  vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
  // 제품·요약은 공개 읽기 캐시(30초)를 탄다 — 앞 테스트의 값을 넘기지 않는다
  clearAllMemos();
  await resetTables();
});
afterEach(() => vi.unstubAllEnvs());

async function seed(slug = "try-tool") {
  const [product] = await db.insert(products).values({ slug, name: `Tool ${slug}`, url: `https://${slug}.example`, tagline: "Try", description: "Try",
    category: "Dev", status: "verified", verifyToken: `v-${slug}`, editTokenHash: "e".repeat(64) }).returning();
  return product;
}

async function login(displayName = "써본 사람") {
  const [user] = await db.insert(publicUsers).values({ displayName }).returning();
  const session = newPublicSession();
  await db.insert(publicSessions).values({ userId: user.id, tokenHash: session.tokenHash, createdAt: session.createdAt, expiresAt: session.expiresAt });
  return { user, token: session.token, csrf: csrfForToken(session.token, "session") };
}

type Call = { visitor?: string | null; session?: { token: string; csrf: string }; csrf?: string | null; origin?: string | null; ua?: string; ip?: string };
function headersFor(options: Call, json = false): Record<string, string> {
  const cookies = [options.visitor ? `nmv_visitor=${options.visitor}` : null, options.session ? `nmv_user=${options.session.token}` : null].filter(Boolean);
  const csrf = options.csrf === undefined ? options.session?.csrf : options.csrf;
  return {
    ...(json ? { "content-type": "application/json" } : {}),
    ...(cookies.length ? { cookie: cookies.join("; ") } : {}),
    ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
    ...(csrf ? { "x-csrf-token": csrf } : {}),
    "user-agent": options.ua ?? "Mozilla/5.0 (Macintosh) Safari/605.1.15",
    ...(options.ip ? { "x-forwarded-for": options.ip } : {}),
  };
}
const context = (slug: string) => ({ params: Promise.resolve({ slug }) });
const url = (slug: string) => `${ORIGIN}/api/products/${slug}/reactions`;

async function put(slug: string, body: Record<string, unknown>, options: Call = {}) {
  const route = await reactions();
  return route.PUT(new Request(url(slug), { method: "PUT", headers: headersFor(options, true), body: JSON.stringify(body) }), context(slug));
}
async function get(slug: string, options: Call = {}, query = "") {
  const route = await reactions();
  return route.GET(new Request(`${url(slug)}${query}`, { headers: headersFor({ ...options, origin: null }) }), context(slug));
}
async function remove(slug: string, options: Call = {}) {
  const route = await reactions();
  return route.DELETE(new Request(url(slug), { method: "DELETE", headers: headersFor(options) }), context(slug));
}
const rows = () => db.select().from(productReactions);
const hashOf = (slug: string, visitor = VISITOR) => productVisitorHash(slug, visitor)!;

describe("anonymous reactions keyed by the nmv_visitor cookie", () => {
  it("saves, reads and deletes this browser's reaction with private no-store responses", async () => {
    await seed();
    const saved = await put("try-tool", { verdict: "good", tags: ["useful", "easy"], comment: "  가입 없이 바로 돼요 ", source: "panel", device: "desktop", locale: "en" }, { visitor: VISITOR });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("private, no-store");
    expect(saved.headers.get("set-cookie")).toBeNull();
    expect((await saved.json()).mine).toMatchObject({ verdict: "good", tags: ["easy", "useful"], comment: "가입 없이 바로 돼요", commentState: "accepted", triedVerified: false });
    const [row] = await rows();
    expect(row).toMatchObject({ visitorHash: hashOf("try-tool"), userId: null, locale: "en", source: "panel", device: "desktop", changesToday: 1, commentReason: null });

    const mine = await get("try-tool", { visitor: VISITOR });
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    expect(await mine.json()).toMatchObject({ mine: { verdict: "good" }, summary: null, signedIn: false, csrfToken: null });
    expect((await (await get("try-tool")).json()).mine).toBeNull();
    expect((await (await get("try-tool", { visitor: OTHER_VISITOR })).json()).mine).toBeNull();

    const deleted = await remove("try-tool", { visitor: VISITOR });
    expect(await deleted.json()).toMatchObject({ deleted: true });
    expect((await (await get("try-tool", { visitor: VISITOR })).json()).mine).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  it("issues the same first-party visitor cookie as /go from GET when the browser has none, and refuses cookie-less anonymous writes", async () => {
    await seed();
    const refused = await put("try-tool", { verdict: "meh" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "visitor_required" });
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await rows()).toHaveLength(0);
    const response = await get("try-tool");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const cookie = response.headers.get("set-cookie") ?? "";
    const issued = cookie.match(/nmv_visitor=([a-f0-9-]+)/)?.[1];
    expect(issued).toMatch(/^[a-f0-9-]{36}$/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect((await put("try-tool", { verdict: "meh" }, { visitor: issued })).status).toBe(200);
    const again = await get("try-tool", { visitor: issued });
    expect(again.headers.get("set-cookie")).toBeNull();
    expect((await again.json()).mine).toMatchObject({ verdict: "meh" });
    expect((await rows())[0].visitorHash).toBe(hashOf("try-tool", issued));
    // 모양이 틀린 쿠키는 없는 것과 같다
    expect((await put("try-tool", { verdict: "good" }, { visitor: "not a visitor id" })).status).toBe(400);
    // 로그인했으면 쿠키 없이도 계정으로 쓴다
    const session = await login();
    expect((await put("try-tool", { verdict: "good" }, { session })).status).toBe(200);
  });

  it("marks a reaction tried-verified only after a /go click by the same visitor within seven days", async () => {
    await seed("clicked");
    await seed("stale");
    await db.insert(clickEvents).values([
      { slug: "clicked", visitorHash: hashOf("clicked"), occurredAt: sql`timezone('UTC', now()) - interval '2 hours'` },
      { slug: "stale", visitorHash: hashOf("stale"), occurredAt: sql`timezone('UTC', now()) - interval '8 days'` },
    ]);
    expect((await (await put("clicked", { verdict: "good" }, { visitor: VISITOR })).json()).mine.triedVerified).toBe(true);
    expect((await (await put("stale", { verdict: "good" }, { visitor: VISITOR })).json()).mine.triedVerified).toBe(false);
    expect((await (await put("clicked", { verdict: "good" }, { visitor: OTHER_VISITOR })).json()).mine.triedVerified).toBe(false);
  });

  it("holds comments with links, mentions or repeats and keeps the review when only the verdict changes", async () => {
    await seed();
    const held = await (await put("try-tool", { verdict: "bad", comment: "설명은 docs.example.com/start 참고" }, { visitor: VISITOR })).json();
    expect(held.mine).toMatchObject({ commentState: "held" });
    expect((await rows())[0]).toMatchObject({ commentState: "held", commentReason: "link" });
    await put("try-tool", { verdict: "meh", comment: "설명은 docs.example.com/start 참고" }, { visitor: VISITOR });
    expect((await rows())[0]).toMatchObject({ verdict: "meh", commentState: "held", commentReason: "link" });
    await put("try-tool", { verdict: "meh", comment: null }, { visitor: VISITOR });
    expect((await rows())[0]).toMatchObject({ comment: null, commentState: null, commentReason: null });
  });

  it("silently drops honeypot submissions and refuses bots", async () => {
    await seed();
    const trapped = await put("try-tool", { verdict: "good", website: "https://spam.example" }, { visitor: VISITOR });
    expect(trapped.status).toBe(200);
    expect((await trapped.json()).mine).toMatchObject({ verdict: "good" });
    const bot = await put("try-tool", { verdict: "good" }, { visitor: VISITOR, ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" });
    expect(bot.status).toBe(403);
    expect(await bot.json()).toEqual({ error: "reaction_refused" });
    expect(await rows()).toHaveLength(0);
  });

  it("validates input and unknown or banned products", async () => {
    const product = await seed();
    expect((await put("try-tool", { verdict: "good", tags: ["easy", "fast", "free", "useful", "pretty"] }, { visitor: VISITOR })).status).toBe(400);
    expect((await put("try-tool", { verdict: "good", comment: "가".repeat(141) }, { visitor: VISITOR })).status).toBe(400);
    expect((await put("missing", { verdict: "good" }, { visitor: VISITOR })).status).toBe(404);
    await db.update(products).set({ status: "banned" }).where(eq(products.id, product.id));
    expect((await put("try-tool", { verdict: "good" }, { visitor: VISITOR })).status).toBe(404);
    expect((await get("try-tool", { visitor: VISITOR })).status).toBe(404);
    expect(await rows()).toHaveLength(0);
  });
});

describe("logged-in reactions keyed by user_id", () => {
  it("requires CSRF and keeps one row per account while storing this browser's hash", async () => {
    await seed();
    const session = await login();
    expect((await put("try-tool", { verdict: "good" }, { visitor: VISITOR, session, csrf: null })).status).toBe(403);
    expect((await put("try-tool", { verdict: "good" }, { visitor: VISITOR, session, csrf: "f".repeat(64) })).status).toBe(403);
    const first = await put("try-tool", { verdict: "good", source: "sheet", device: "phone" }, { visitor: VISITOR, session });
    expect(first.status).toBe(200);
    await put("try-tool", { verdict: "bad", tags: ["broken"] }, { visitor: VISITOR, session });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ userId: session.user.id, visitorHash: hashOf("try-tool"), verdict: "bad", tags: ["broken"], changesToday: 2 });
    const read = await (await get("try-tool", { session })).json();
    expect(read).toMatchObject({ mine: { verdict: "bad" }, signedIn: true, csrfToken: session.csrf });
    // 쿠키 없이 와도 계정으로 찾는다
    expect((await put("try-tool", { verdict: "meh" }, { session })).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("never shows or takes over this browser's anonymous row for a logged-in account — only the explicit merge moves it", async () => {
    const product = await seed();
    const maker = await login("메이커");
    // 공용 PC: A 가 로그아웃한 채 남긴 평가와 그 한 줄에 단 메이커 답장
    await put("try-tool", { verdict: "meh", tags: ["slow"], comment: "로그인 전에 남김" }, { visitor: VISITOR });
    const [anonymous] = await rows();
    await db.insert(makerReplies).values({ productId: product.id, targetType: "reaction", targetId: anonymous.id, authorUserId: maker.user.id, body: "고마워요!" });
    const session = await login();
    // B 가 같은 브라우저로 로그인 — A 의 평가를 B 의 것으로 보여 주지 않는다
    expect((await (await get("try-tool", { visitor: VISITOR, session })).json()).mine).toBeNull();
    const results = await Promise.all([
      put("try-tool", { verdict: "good" }, { visitor: VISITOR, session }),
      put("try-tool", { verdict: "bad" }, { visitor: VISITOR, session }),
    ]);
    expect(results.map((response) => response.status)).toEqual([200, 200]);
    const written = await results[0].json();
    expect(written).toMatchObject({ signedIn: true, mine: { tags: [], comment: null } });
    const all = await rows();
    expect(all).toHaveLength(2);
    // A 의 행·한 줄·답장은 그대로, 해시도 A 의 행이 쥔다
    expect(all.find((row) => row.id === anonymous.id)).toMatchObject({ userId: null, verdict: "meh", tags: ["slow"], comment: "로그인 전에 남김", visitorHash: hashOf("try-tool") });
    expect(all.find((row) => row.userId === session.user.id)).toMatchObject({ visitorHash: null, tags: [], comment: null });
    expect(await db.select().from(makerReplies)).toHaveLength(1);
    // B 가 지워도 B 의 행만
    expect(await (await remove("try-tool", { visitor: VISITOR, session })).json()).toMatchObject({ deleted: true, signedIn: true });
    expect(await rows()).toEqual([expect.objectContaining({ id: anonymous.id, userId: null })]);
    expect((await (await get("try-tool", { visitor: VISITOR })).json()).mine).toMatchObject({ verdict: "meh", comment: "로그인 전에 남김" });
    // «옮기기»를 누르면 그때 계정에 붙는다
    const route = await merge();
    const merged = await route.POST(new Request(`${ORIGIN}/api/me/reactions/merge`, { method: "POST", headers: headersFor({ visitor: VISITOR, session }, true), body: JSON.stringify({ slugs: ["try-tool"] }) }));
    expect(await merged.json()).toEqual({ merged: 1 });
    expect(await rows()).toEqual([expect.objectContaining({ id: anonymous.id, userId: session.user.id, comment: "로그인 전에 남김" })]);
    expect((await (await get("try-tool", { visitor: VISITOR, session })).json()).mine).toMatchObject({ verdict: "meh" });
  });

  it("serializes an account write and an anonymous write from the same browser without unique violations", async () => {
    const session = await login();
    for (let round = 0; round < 6; round += 1) {
      const slug = `race-${round}`;
      await seed(slug);
      const results = await Promise.all([
        put(slug, { verdict: "good" }, { visitor: VISITOR }),
        put(slug, { verdict: "bad" }, { visitor: VISITOR, session }),
        put(slug, { verdict: "meh" }, { visitor: VISITOR }),
      ]);
      expect(results.map((response) => response.status)).toEqual([200, 200, 200]);
    }
    const all = await rows();
    // 계정 행은 제품마다 하나, 이 브라우저 해시도 제품마다 한 행만 쥔다
    expect(new Set(all.filter((row) => row.userId).map((row) => row.productId)).size).toBe(all.filter((row) => row.userId).length);
    expect(all.filter((row) => row.userId)).toHaveLength(6);
  });

  it("keeps this browser's anonymous row when the account already rated on another device", async () => {
    await seed();
    const session = await login();
    await put("try-tool", { verdict: "good" }, { visitor: OTHER_VISITOR, session });
    await put("try-tool", { verdict: "bad" }, { visitor: VISITOR });
    expect(await rows()).toHaveLength(2);
    await put("try-tool", { verdict: "meh" }, { visitor: VISITOR, session });
    const all = await rows();
    expect(all).toHaveLength(2);
    // 계정 행만 바뀌고, 이 브라우저 해시는 익명 행이 그대로 쥔다
    expect(all.find((row) => row.userId === session.user.id)).toMatchObject({ verdict: "meh", visitorHash: hashOf("try-tool", OTHER_VISITOR) });
    expect(all.find((row) => row.userId === null)).toMatchObject({ verdict: "bad", visitorHash: hashOf("try-tool") });
  });

  it("never shows an account row to the logged-out browser and gives that browser its own row", async () => {
    await seed();
    const session = await login();
    await put("try-tool", { verdict: "good", comment: "계정으로 남김" }, { visitor: VISITOR, session });
    expect((await (await get("try-tool", { visitor: VISITOR })).json()).mine).toBeNull();
    await put("try-tool", { verdict: "bad" }, { visitor: VISITOR });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.userId === session.user.id)).toMatchObject({ verdict: "good", visitorHash: null });
    expect(all.find((row) => row.userId === null)).toMatchObject({ verdict: "bad", visitorHash: hashOf("try-tool") });
    expect((await (await get("try-tool", { session })).json()).mine).toMatchObject({ verdict: "good" });
  });
});

describe("anti-abuse", () => {
  it("rejects writes from another or missing Origin", async () => {
    await seed();
    for (const origin of ["https://evil.example", null]) {
      const response = await put("try-tool", { verdict: "good" }, { visitor: VISITOR, origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "invalid_origin" });
      expect((await remove("try-tool", { visitor: VISITOR, origin })).status).toBe(403);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("limits a browser to 30 writes an hour and a trusted IP bucket to 60 without storing the raw IP", async () => {
    await seed();
    const visitorKey = `reaction:visitor:${reactionRateKey(VISITOR)}`;
    await db.insert(rateLimits).values({ key: visitorKey, count: 30, resetAt: sql`now() + interval '1 hour'` });
    const limited = await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "reaction_rate_limited" });

    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    for (let index = 0; index < 60; index += 1) {
      expect((await put("try-tool", { verdict: "good" }, { visitor: randomUUID(), ip: "198.51.100.7" })).status).toBe(200);
    }
    // 쿠키를 버리고 새로 받아 와도 IP 묶음이 막는다
    expect((await put("try-tool", { verdict: "good" }, { visitor: randomUUID(), ip: "198.51.100.7" })).status).toBe(429);
    expect((await put("try-tool", { verdict: "good" }, { visitor: randomUUID(), ip: "198.51.100.8" })).status).toBe(200);
    const keys = (await db.select({ key: rateLimits.key }).from(rateLimits)).map((row) => row.key);
    expect(keys.some((key) => key.includes("198.51.100"))).toBe(false);
    expect(keys.some((key) => key.includes(VISITOR))).toBe(false);
  });

  it("buckets IPv6 clients by /64 for the IP limit", async () => {
    const { ipBucket } = await import("@/lib/domain/reactions/http");
    await seed();
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const bucket = productVisitorHash("ip:", "2001:db8:1:2::/64");
    expect(ipBucket("2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    await db.insert(rateLimits).values({ key: `reaction:ip:${bucket}`, count: 60, resetAt: sql`now() + interval '1 hour'` });
    // 같은 /64 안에서 주소를 바꿔도 같은 묶음
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2:ffff:ffff:ffff:fffe"]) {
      expect((await put("try-tool", { verdict: "good" }, { visitor: randomUUID(), ip })).status, ip).toBe(429);
    }
    expect((await put("try-tool", { verdict: "good" }, { visitor: randomUUID(), ip: "2001:db8:1:3::1" })).status).toBe(200);
  });

  it("without a trusted IP, counts only 30 new anonymous rows an hour per product toward the ranking", async () => {
    const product = await seed();
    await seed("other-tool");
    const visitors = Array.from({ length: 30 }, () => randomUUID());
    for (const visitor of visitors) expect((await put("try-tool", { verdict: "good" }, { visitor })).status).toBe(200);
    const late = randomUUID();
    expect((await put("try-tool", { verdict: "good" }, { visitor: late })).status).toBe(200);
    const all = await rows();
    expect(all.filter((row) => row.productId === product.id && row.rankingExcluded)).toEqual([expect.objectContaining({ visitorHash: hashOf("try-tool", late) })]);
    // 이미 있는 줄을 바꾸는 것·계정 줄·다른 제품은 세지 않는다
    expect((await put("try-tool", { verdict: "bad" }, { visitor: visitors[0] })).status).toBe(200);
    const session = await login();
    expect((await put("try-tool", { verdict: "meh" }, { session })).status).toBe(200);
    expect((await put("other-tool", { verdict: "good" }, { visitor: randomUUID() })).status).toBe(200);
    expect((await rows()).filter((row) => row.rankingExcluded)).toHaveLength(1);
    // 신뢰할 IP 가 있으면 IP 묶음 한도가 대신한다
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    expect((await put("try-tool", { verdict: "good" }, { visitor: randomUUID(), ip: "198.51.100.9" })).status).toBe(200);
    expect((await rows()).filter((row) => row.rankingExcluded)).toHaveLength(1);
  });

  it("caps changes per row per KST day and keeps the last value", async () => {
    await seed();
    const verdicts = ["good", "bad"] as const;
    for (let index = 0; index < REACTION_CHANGES_PER_DAY; index += 1) {
      expect((await put("try-tool", { verdict: verdicts[index % 2] }, { visitor: VISITOR })).status).toBe(200);
    }
    const before = (await rows())[0];
    expect(before.changesToday).toBe(REACTION_CHANGES_PER_DAY);
    const capped = await put("try-tool", { verdict: before.verdict === "good" ? "bad" : "good" }, { visitor: VISITOR });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: "reaction_change_limited" });
    // 바뀌는 것이 없으면 한도와 상관없이 그대로 답한다
    expect((await put("try-tool", { verdict: before.verdict }, { visitor: VISITOR })).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ verdict: before.verdict, changesToday: REACTION_CHANGES_PER_DAY });
    // 지난 KST 날의 횟수는 오늘 다시 센다
    await db.update(productReactions).set({ updatedAt: sql`now() - interval '1 day'` });
    expect((await put("try-tool", { verdict: before.verdict === "good" ? "bad" : "good" }, { visitor: VISITOR })).status).toBe(200);
    expect((await rows())[0].changesToday).toBe(1);
  });

  it("allows five new comments an hour per browser", async () => {
    await seed();
    for (let index = 0; index < 5; index += 1) {
      expect((await put("try-tool", { verdict: "good", comment: `한 줄 ${index}` }, { visitor: VISITOR })).status).toBe(200);
    }
    const limited = await put("try-tool", { verdict: "good", comment: "여섯째" }, { visitor: VISITOR });
    expect(limited.status).toBe(429);
    expect((await rows())[0].comment).toBe("한 줄 4");
  });

  it("keeps accepting a flooded product but excludes those rows from the public summary", async () => {
    await seed();
    await db.insert(rateLimits).values({ key: "reaction:product:try-tool", count: 120, resetAt: sql`now() + interval '1 hour'` });
    const response = await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    expect(response.status).toBe(200);
    expect((await rows())[0].rankingExcluded).toBe(true);
  });
});

describe("detail panel reads", () => {
  it("serves the public summary from the 30-second public read cache", async () => {
    await seed();
    for (const visitor of [randomUUID(), randomUUID(), randomUUID()]) await put("try-tool", { verdict: "good" }, { visitor });
    expect((await (await get("try-tool")).json()).summary).toEqual({ tried: 3, good: 3, meh: 0, bad: 0 });
    await put("try-tool", { verdict: "bad" }, { visitor: randomUUID() });
    // 상세를 볼 때마다 다시 세지 않는다 — 30초 안에는 담아 둔 값
    expect((await (await get("try-tool")).json()).summary).toEqual({ tried: 3, good: 3, meh: 0, bad: 0 });
    clearAllMemos();
    expect((await (await get("try-tool")).json()).summary).toEqual({ tried: 4, good: 3, meh: 0, bad: 1 });
  });

  it("skips the anonymous lookup when this browser does not remember the product, but always reads the account row", async () => {
    await seed();
    await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    expect((await (await get("try-tool", { visitor: VISITOR }, "?reacted=0")).json()).mine).toBeNull();
    expect((await (await get("try-tool", { visitor: VISITOR })).json()).mine).toMatchObject({ verdict: "good" });
    const session = await login();
    await put("try-tool", { verdict: "meh" }, { session });
    expect(await (await get("try-tool", { visitor: VISITOR, session }, "?reacted=0")).json()).toMatchObject({ mine: { verdict: "meh" }, signedIn: true, csrfToken: session.csrf });
  });
});

describe("public summary", () => {
  it("shows counts only from three non-excluded people", async () => {
    await seed();
    const visitors = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await put("try-tool", { verdict: "good" }, { visitor: visitors[0] });
    const second = await (await put("try-tool", { verdict: "meh" }, { visitor: visitors[1] })).json();
    expect(second.summary).toBeNull();
    expect((await (await get("try-tool")).json()).summary).toBeNull();
    const third = await (await put("try-tool", { verdict: "good" }, { visitor: visitors[2] })).json();
    // 쓰기 응답의 요약은 바로 그 TX 의 값이다
    expect(third.summary).toEqual({ tried: 3, good: 2, meh: 1, bad: 0 });
    clearAllMemos();
    expect((await (await get("try-tool")).json()).summary).toEqual({ tried: 3, good: 2, meh: 1, bad: 0 });
    await db.update(productReactions).set({ rankingExcluded: true }).where(eq(productReactions.visitorHash, hashOf("try-tool", visitors[2])));
    clearAllMemos();
    expect((await (await get("try-tool")).json()).summary).toBeNull();
    await put("try-tool", { verdict: "bad" }, { visitor: visitors[3] });
    expect((await (await remove("try-tool", { visitor: visitors[3] })).json()).summary).toBeNull();
  });
});

describe("verdict-only writes", () => {
  it("keeps the saved tags, comment and maker reply when the panel sends only a verdict", async () => {
    const product = await seed();
    const maker = await login("메이커");
    await put("try-tool", { verdict: "good", tags: ["easy", "useful"], comment: "정말 좋아요" }, { visitor: VISITOR });
    const [row] = await rows();
    await db.insert(makerReplies).values({ productId: product.id, targetType: "reaction", targetId: row.id, authorUserId: maker.user.id, body: "고마워요!" });
    // 판이 내 평가를 못 읽은 채 눌러도(평가만 보낸다) 남긴 것을 지우지 않는다
    const response = await put("try-tool", { verdict: "meh" }, { visitor: VISITOR });
    expect((await response.json()).mine).toMatchObject({ verdict: "meh", tags: ["easy", "useful"], comment: "정말 좋아요", commentState: "accepted" });
    expect((await rows())[0]).toMatchObject({ id: row.id, verdict: "meh", tags: ["easy", "useful"], comment: "정말 좋아요" });
    expect(await db.select().from(makerReplies)).toHaveLength(1);
    // 비우려면 빈 값을 보낸다
    await put("try-tool", { verdict: "meh", tags: [], comment: null }, { visitor: VISITOR });
    expect((await rows())[0]).toMatchObject({ tags: [], comment: null });
    expect(await db.select().from(makerReplies)).toHaveLength(0);
  });
});

describe("ranking exclusion is decided per write", () => {
  const floodKey = "reaction:product:try-tool";

  it("re-includes a row written during a flood once it is changed again outside the flood", async () => {
    await seed();
    await db.insert(rateLimits).values({ key: floodKey, count: 120, resetAt: sql`now() + interval '1 hour'` });
    await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    expect((await rows())[0].rankingExcluded).toBe(true);
    // 같은 값을 다시 보내도 바뀌지 않는다
    await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    expect((await rows())[0].rankingExcluded).toBe(true);
    await db.delete(rateLimits).where(eq(rateLimits.key, floodKey));
    await put("try-tool", { verdict: "meh" }, { visitor: VISITOR });
    expect((await rows())[0].rankingExcluded).toBe(false);
  });

  it("counts only real changes toward the flood, so resending the same value cannot flood a product", async () => {
    await seed();
    await db.insert(rateLimits).values({ key: floodKey, count: 118, resetAt: sql`now() + interval '1 hour'` });
    await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    for (let index = 0; index < 3; index += 1) expect((await put("try-tool", { verdict: "good" }, { visitor: VISITOR })).status).toBe(200);
    await put("try-tool", { verdict: "bad" }, { visitor: OTHER_VISITOR });
    expect((await rows()).map((row) => row.rankingExcluded)).toEqual([false, false]);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, floodKey)))[0].count).toBe(120);
    // 실패한 쓰기(하루 변경 한도)는 세지 않는다
    await db.update(productReactions).set({ changesToday: 10 }).where(eq(productReactions.visitorHash, hashOf("try-tool")));
    expect((await put("try-tool", { verdict: "meh" }, { visitor: VISITOR })).status).toBe(429);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, floodKey)))[0].count).toBe(120);
  });

  it("without a trusted IP, re-including an over-cap anonymous row by editing it counts against the same cap", async () => {
    const product = await seed();
    const capKey = `reaction-anonymous-new:product:${product.id}`;
    await db.insert(rateLimits).values({ key: capKey, count: 30, resetAt: sql`now() + interval '1 hour'` });
    await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    expect((await rows())[0].rankingExcluded).toBe(true);
    // 한도가 찬 동안 고쳐도 다시 세지 않는다
    await put("try-tool", { verdict: "meh" }, { visitor: VISITOR });
    expect((await rows())[0].rankingExcluded).toBe(true);
    await db.delete(rateLimits).where(eq(rateLimits.key, capKey));
    await put("try-tool", { verdict: "bad" }, { visitor: VISITOR });
    expect((await rows())[0].rankingExcluded).toBe(false);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, capKey)))[0].count).toBe(1);
    // 세는 줄을 고치는 것은 한도를 쓰지 않는다
    await put("try-tool", { verdict: "good" }, { visitor: VISITOR });
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, capKey)))[0].count).toBe(1);
  });
});

describe("held comment review", () => {
  it("lists held comments oldest first and lets an administrator publish or hide what they saw", async () => {
    const { heldReactionComments, reviewHeldReactionComment } = await import("@/lib/domain/reactions/review");
    await seed();
    await put("try-tool", { verdict: "good", comment: "설명은 docs.example.com/start 참고" }, { visitor: VISITOR });
    await put("try-tool", { verdict: "bad", comment: "@spam_seller 연락" }, { visitor: OTHER_VISITOR });
    await put("try-tool", { verdict: "good", comment: "좋아요 ㅋㅋㅋㅋㅋㅋㅋㅋ" }, { visitor: randomUUID() });
    const queue = await heldReactionComments();
    expect(queue.count).toBe(2);
    expect(queue.items.map((item) => [item.comment, item.reason, item.signedIn])).toEqual([
      ["설명은 docs.example.com/start 참고", "link", false], ["@spam_seller 연락", "mention", false],
    ]);
    const [first, second] = queue.items;
    // 글쓴이가 그 사이 고쳤으면 본 글이 아니라 공개하지 않는다
    await put("try-tool", { verdict: "good", comment: "가이드는 docs.example.com/guide" }, { visitor: VISITOR });
    await expect(reviewHeldReactionComment({ id: first.id, comment: first.comment, decision: "accepted", adminLogin: "ops" })).rejects.toMatchObject({ code: "reaction_conflict", status: 409 });
    await reviewHeldReactionComment({ id: first.id, comment: "가이드는 docs.example.com/guide", decision: "accepted", adminLogin: "ops" });
    await reviewHeldReactionComment({ id: second.id, comment: second.comment, decision: "rejected", adminLogin: "ops" });
    expect((await rows()).filter((row) => row.commentState !== "accepted").map((row) => row.commentState)).toEqual(["rejected"]);
    expect((await db.select().from(productReactions).where(eq(productReactions.id, first.id)))[0]).toMatchObject({ commentState: "accepted", commentReason: "link" });
    expect((await heldReactionComments()).count).toBe(0);
    // 이미 정한 것은 다시 바꾸지 않는다
    await expect(reviewHeldReactionComment({ id: second.id, comment: second.comment, decision: "accepted", adminLogin: "ops" })).rejects.toMatchObject({ code: "reaction_conflict" });
    await expect(reviewHeldReactionComment({ id: "not-a-uuid", comment: "x", decision: "accepted", adminLogin: "ops" })).rejects.toMatchObject({ code: "reaction_invalid" });
    // 운영 기록은 resetTables 가 비우지 않는다 — 이 테스트의 대상만 본다
    const audit = (await db.select().from(operationsAudit).where(eq(operationsAudit.action, "reaction.comment_review")))
      .filter((entry) => entry.target === first.id || entry.target === second.id);
    expect(audit.map((entry) => [entry.target, (entry.detail as { decision: string }).decision, entry.actor])).toEqual(expect.arrayContaining([
      [first.id, "accepted", "ops"], [second.id, "rejected", "ops"],
    ]));
    expect(audit).toHaveLength(2);
  });
});

describe("maker replies follow the comment", () => {
  it("drops the maker reply when the comment text changes or is removed, and keeps it when only the verdict or tags change", async () => {
    const product = await seed();
    const maker = await login("메이커");
    await put("try-tool", { verdict: "good", comment: "정말 좋아요" }, { visitor: VISITOR });
    const [row] = await rows();
    const reply = () => db.insert(makerReplies).values({ productId: product.id, targetType: "reaction", targetId: row.id, authorUserId: maker.user.id, body: "고마워요!" });
    const replies = () => db.select().from(makerReplies);
    await reply();
    await put("try-tool", { verdict: "meh", tags: ["slow"], comment: "정말 좋아요" }, { visitor: VISITOR });
    expect(await replies()).toHaveLength(1);
    await put("try-tool", { verdict: "bad", comment: "사기 같아요" }, { visitor: VISITOR });
    expect(await replies()).toHaveLength(0);
    await reply();
    await put("try-tool", { verdict: "bad", comment: null }, { visitor: VISITOR });
    expect(await replies()).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ id: row.id, comment: null });
  });
});

describe("tried tab lists", () => {
  it("lists only my account rows with accepted maker replies", async () => {
    const product = await seed("listed");
    await seed("other");
    const mine = await login("나");
    const other = await login("남");
    await put("listed", { verdict: "good", comment: "좋아요" }, { session: mine });
    await put("other", { verdict: "bad" }, { session: other });
    const [row] = await db.select().from(productReactions).where(eq(productReactions.userId, mine.user.id));
    await db.insert(makerReplies).values({ productId: product.id, targetType: "reaction", targetId: row.id, authorUserId: other.user.id, body: "고마워요!" });
    const route = await meList();
    const response = await route.GET(new Request(`${ORIGIN}/api/me/reactions`, { headers: { cookie: `nmv_user=${mine.token}` } }));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { reactions: listed } = await response.json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ slug: "listed", name: "Tool listed", verdict: "good", comment: "좋아요", commentState: "accepted", reply: { body: "고마워요!", authorName: "남" } });
    // 답장한 계정이 탈퇴하면 이름 대신 null — 화면이 그 언어로 «탈퇴한 사용자»를 적는다
    await db.update(publicUsers).set({ displayName: "탈퇴한 사용자", deletedAt: new Date() }).where(eq(publicUsers.id, other.user.id));
    expect((await (await route.GET(new Request(`${ORIGIN}/api/me/reactions`, { headers: { cookie: `nmv_user=${mine.token}` } }))).json()).reactions[0].reply)
      .toMatchObject({ body: "고마워요!", authorName: null });
    await db.update(makerReplies).set({ reviewState: "held" });
    expect((await (await route.GET(new Request(`${ORIGIN}/api/me/reactions`, { headers: { cookie: `nmv_user=${mine.token}` } }))).json()).reactions[0].reply).toBeNull();
    expect((await route.GET(new Request(`${ORIGIN}/api/me/reactions`))).status).toBe(401);
  });

  it("lets a browser list only its own anonymous rows for the slugs it remembers", async () => {
    await seed("first");
    await seed("second");
    await put("first", { verdict: "good" }, { visitor: VISITOR });
    await put("second", { verdict: "meh", tags: ["slow"] }, { visitor: VISITOR });
    await put("first", { verdict: "bad" }, { visitor: OTHER_VISITOR });
    const route = await browserList();
    const list = (visitor: string | null, slugs = "first,second") => route.GET(new Request(`${ORIGIN}/api/me/reactions/browser?slugs=${slugs}`,
      { headers: visitor ? { cookie: `nmv_visitor=${visitor}` } : {} }));
    const mine = await list(VISITOR);
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    expect((await mine.json()).reactions.map((item: { slug: string; verdict: string }) => [item.slug, item.verdict]).sort()).toEqual([["first", "good"], ["second", "meh"]]);
    expect((await (await list(OTHER_VISITOR)).json()).reactions.map((item: { verdict: string }) => item.verdict)).toEqual(["bad"]);
    expect((await (await list(randomUUID())).json()).reactions).toEqual([]);
    expect((await (await list(null)).json()).reactions).toEqual([]);
    // slug 를 모르면 찾을 수 없다
    expect((await (await list(VISITOR, "")).json()).reactions).toEqual([]);
    // 로그인해 쓴 평가는 이 브라우저의 익명 행을 건드리지 않는다. «옮기기»로 계정에 붙은 행은 목록에 나오지 않는다
    const session = await login();
    await put("first", { verdict: "good" }, { visitor: VISITOR, session });
    expect((await (await list(VISITOR)).json()).reactions.map((item: { slug: string }) => item.slug).sort()).toEqual(["first", "second"]);
    const route2 = await merge();
    await route2.POST(new Request(`${ORIGIN}/api/me/reactions/merge`, { method: "POST", headers: headersFor({ visitor: VISITOR, session }, true), body: JSON.stringify({ slugs: ["first"] }) }));
    expect((await (await list(VISITOR)).json()).reactions.map((item: { slug: string }) => item.slug)).toEqual(["second"]);
  });

  it("limits the unauthenticated browser list per browser", async () => {
    await seed("first");
    await put("first", { verdict: "good" }, { visitor: VISITOR });
    const route = await browserList();
    const list = () => route.GET(new Request(`${ORIGIN}/api/me/reactions/browser?slugs=first`, { headers: { cookie: `nmv_visitor=${VISITOR}` } }));
    expect((await (await list()).json()).reactions).toHaveLength(1);
    await db.update(rateLimits).set({ count: 300 }).where(eq(rateLimits.key, `reaction-browser:visitor:${reactionRateKey(VISITOR)}`));
    const limited = await list();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "reaction_rate_limited" });
    // 다른 브라우저는 따로 센다
    expect((await route.GET(new Request(`${ORIGIN}/api/me/reactions/browser?slugs=first`, { headers: { cookie: `nmv_visitor=${OTHER_VISITOR}` } }))).status).toBe(200);
  });
});

describe("first-login merge", () => {
  async function postMerge(slugs: string[], options: Call) {
    const route = await merge();
    return route.POST(new Request(`${ORIGIN}/api/me/reactions/merge`, { method: "POST", headers: headersFor(options, true), body: JSON.stringify({ slugs }) }));
  }

  it("attaches anonymous rows, keeps the newer row on conflict and ignores other browsers", async () => {
    for (const slug of ["only-anon", "anon-newer", "mine-newer", "other-browser", "untouched"]) await seed(slug);
    const session = await login();
    await put("anon-newer", { verdict: "bad" }, { visitor: OTHER_VISITOR, session });
    await put("mine-newer", { verdict: "good" }, { visitor: OTHER_VISITOR, session });
    await put("only-anon", { verdict: "good" }, { visitor: VISITOR });
    await put("anon-newer", { verdict: "good", comment: "나중에 남김" }, { visitor: VISITOR });
    await put("mine-newer", { verdict: "meh" }, { visitor: VISITOR });
    await put("other-browser", { verdict: "bad" }, { visitor: OTHER_VISITOR });
    const productIds = new Map((await db.select({ id: products.id, slug: products.slug }).from(products)).map((row) => [row.slug, row.id]));
    // 계정 행을 더 나중에 바꾼 것으로 만든다
    await db.update(productReactions).set({ updatedAt: sql`now() + interval '1 minute'` })
      .where(sql`${productReactions.userId} = ${session.user.id} and ${productReactions.productId} = ${productIds.get("mine-newer")}`);
    await db.update(productReactions).set({ updatedAt: sql`now() - interval '1 minute'` })
      .where(sql`${productReactions.userId} = ${session.user.id} and ${productReactions.productId} = ${productIds.get("anon-newer")}`);

    expect((await postMerge(["only-anon"], { visitor: VISITOR, session, csrf: null })).status).toBe(403);
    const response = await postMerge(["only-anon", "anon-newer", "mine-newer", "other-browser", "untouched", "missing"], { visitor: VISITOR, session });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ merged: 3 });

    const all = await rows();
    const bySlug = (slug: string) => all.filter((row) => row.productId === productIds.get(slug));
    expect(bySlug("only-anon")).toEqual([expect.objectContaining({ userId: session.user.id, verdict: "good", visitorHash: hashOf("only-anon") })]);
    expect(bySlug("anon-newer")).toEqual([expect.objectContaining({ userId: session.user.id, verdict: "good", comment: "나중에 남김" })]);
    expect(bySlug("mine-newer")).toEqual([expect.objectContaining({ userId: session.user.id, verdict: "good" })]);
    expect(bySlug("other-browser")).toEqual([expect.objectContaining({ userId: null, visitorHash: hashOf("other-browser", OTHER_VISITOR) })]);
    // 다시 합쳐도 바뀌지 않는다
    expect(await (await postMerge(["only-anon", "anon-newer", "mine-newer"], { visitor: VISITOR, session })).json()).toEqual({ merged: 0 });
  });

  it("accepts a full chunk of 100 long slugs in one request", async () => {
    const slugs = Array.from({ length: 100 }, (_, index) => `long-product-name-${String(index).padStart(3, "0")}-${"x".repeat(60)}`.slice(0, 60));
    await seed(slugs[99]);
    await put(slugs[99], { verdict: "good" }, { visitor: VISITOR });
    const session = await login();
    const response = await postMerge(slugs, { visitor: VISITOR, session });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ merged: 1 });
  });
});

describe("feature flag", () => {
  it("returns 404 from every reaction endpoint when PRODUCT_REACTIONS_ENABLED is off", async () => {
    await seed();
    const session = await login();
    vi.stubEnv("PRODUCT_REACTIONS_ENABLED", "false");
    expect((await get("try-tool", { visitor: VISITOR })).status).toBe(404);
    expect((await put("try-tool", { verdict: "good" }, { visitor: VISITOR })).status).toBe(404);
    expect((await remove("try-tool", { visitor: VISITOR })).status).toBe(404);
    expect((await (await meList()).GET(new Request(`${ORIGIN}/api/me/reactions`, { headers: { cookie: `nmv_user=${session.token}` } }))).status).toBe(404);
    expect((await (await browserList()).GET(new Request(`${ORIGIN}/api/me/reactions/browser?slugs=try-tool`, { headers: { cookie: `nmv_visitor=${VISITOR}` } }))).status).toBe(404);
    const merged = await (await merge()).POST(new Request(`${ORIGIN}/api/me/reactions/merge`, { method: "POST", headers: headersFor({ visitor: VISITOR, session }, true), body: JSON.stringify({ slugs: ["try-tool"] }) }));
    expect(merged.status).toBe(404);
    expect(await rows()).toHaveLength(0);
  });
});
