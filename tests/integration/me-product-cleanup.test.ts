import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { userFollows } from "@/lib/db/me-schema";
import { ensureSchema, resetTables } from "./setup";

/**
 * 마이페이지 리뷰 뒷정리 — 제품을 지우면 그 제품 팔로도 지운다(0109 가 남은 줄을 치운다), 0109 색인,
 * 로그아웃 목록 카드(POST /api/product-summaries)는 공용 메모에 담지 않고 IP 마다 센다.
 */
vi.mock("server-only", () => ({}));

const SITE = "https://nomorevibe.example";
beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  await resetTables();
});
afterEach(() => vi.unstubAllEnvs());

async function product(slug: string, status: "seeded" | "verified" | "banned" = "verified") {
  const [row] = await db.insert(products).values({ slug, name: slug.toUpperCase(), url: `https://${slug}.example`, tagline: slug, description: slug,
    category: "Dev", status, verifyToken: "v", editTokenHash: "e" }).returning();
  return row;
}
const followsOf = async (userId: number) => (await db.select({ targetType: userFollows.targetType, targetKey: userFollows.targetKey }).from(userFollows)
  .where(eq(userFollows.userId, userId))).map((row) => `${row.targetType}:${row.targetKey}`).sort();

describe("제품 완전 삭제와 팔로", () => {
  it("메이커가 승인한 삭제는 그 제품의 팔로만 같이 지운다 — 다른 제품·메이커·분야 팔로는 남는다", async () => {
    const { removeProductAndEvidence } = await import("@/lib/domain/products/repository");
    const gone = await product("gone-app");
    const kept = await product("kept-app");
    const [fan] = await db.insert(publicUsers).values({ displayName: "팬" }).returning();
    await db.insert(userFollows).values([
      { userId: fan.id, targetType: "product", targetKey: String(gone.id) },
      { userId: fan.id, targetType: "product", targetKey: String(kept.id) },
      { userId: fan.id, targetType: "maker", targetKey: String(gone.id) },
      { userId: fan.id, targetType: "category", targetKey: "dev" },
    ]);
    expect(await removeProductAndEvidence(gone.id, gone.slug)).toBe(true);
    expect(await followsOf(fan.id)).toEqual(["category:dev", `maker:${gone.id}`, `product:${kept.id}`].sort());
    const { getMeSummary } = await import("@/lib/me/summary");
    expect((await getMeSummary(fan.id))?.counts.following).toBe(3);
  });

  it("0109 는 지운 제품을 가리키는 제품 팔로만 치운다", async () => {
    const kept = await product("kept-app");
    const [fan] = await db.insert(publicUsers).values({ displayName: "팬" }).returning();
    await db.insert(userFollows).values([
      { userId: fan.id, targetType: "product", targetKey: String(kept.id) },
      { userId: fan.id, targetType: "product", targetKey: "987654" },
      { userId: fan.id, targetType: "maker", targetKey: "987654" },
    ]);
    const migration = readFileSync(path.join(__dirname, "../../drizzle/0109_mypage_review.sql"), "utf8");
    const cleanup = migration.split("--> statement-breakpoint").map((part) => part.replace(/^--.*$/gm, "").trim()).find((part) => part.startsWith("DELETE"));
    await db.execute(sql.raw(cleanup!));
    expect(await followsOf(fan.id)).toEqual(["maker:987654", `product:${kept.id}`].sort());
  });

  it("0109 색인 — 제품 삭제 cascade 와 계정 삭제가 훑지 않게", async () => {
    const rows = await db.execute<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public' and indexname in
      ('user_saved_products_product_idx', 'notifications_product_idx', 'email_outbox_user_idx', 'maker_replies_author_idx')`);
    expect(rows.map((row) => row.indexname).sort()).toEqual(["email_outbox_user_idx", "maker_replies_author_idx", "notifications_product_idx", "user_saved_products_product_idx"]);
  });
});

describe("로그아웃 목록 카드 — POST /api/product-summaries", () => {
  const noParams = { params: Promise.resolve({}) };
  const call = (slugs: string[], ip?: string) => new Request(`${SITE}/api/product-summaries`, { method: "POST",
    headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) }, body: JSON.stringify({ slugs, locale: "ko" }) });

  it("브라우저마다 다른 목록은 공용 메모에 담지 않는다 — 방금 내린 제품은 다음 요청에서 바로 빠진다", async () => {
    const { POST } = await import("@/app/api/product-summaries/route");
    const alpha = await product("alpha");
    await product("beta");
    const slugs = (response: Response) => response.json().then((body: { items: { slug: string }[] }) => body.items.map((item) => item.slug));
    expect(await slugs(await POST(call(["alpha", "beta"]), noParams))).toEqual(["alpha", "beta"]);
    await db.update(products).set({ status: "banned" }).where(and(eq(products.id, alpha.id)));
    expect(await slugs(await POST(call(["alpha", "beta"]), noParams))).toEqual(["beta"]);
  });

  it("믿을 프록시가 알려 준 IP 마다 10분에 120번 — IP 를 모르면 세지 않는다", async () => {
    const { POST } = await import("@/app/api/product-summaries/route");
    await product("alpha");
    vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    for (let attempt = 0; attempt < 120; attempt += 1) expect((await POST(call(["alpha"], "198.51.100.7"), noParams)).status).toBe(200);
    const limited = await POST(call(["alpha"], "198.51.100.7"), noParams);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await POST(call(["alpha"], "198.51.100.8"), noParams)).status).toBe(200);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "0");
    expect((await POST(call(["alpha"], "198.51.100.7"), noParams)).status).toBe(200);
  });
});
