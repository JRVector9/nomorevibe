import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

const { db } = await import("@/lib/db");
const { products, cdnPurges } = await import("@/lib/db/schema");
const { purgeRemovedProducts } = await import("@/lib/jobs/products/cdn-purge");
const { purgeTargets } = await import("@/lib/cdn/purge");

/**
 * 내려간 제품을 Cloudflare 에서 지운다(2026-10-06 엣지 캐시).
 * 내리는 길이 여럿이라 DB 트리거가 적고, 발행 워커가 모아서 지운 뒤 60초 뒤 한 번 더 지운다.
 */
const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() };
const env = { CLOUDFLARE_ZONE_ID: "zone-1", CLOUDFLARE_PURGE_TOKEN: "purge-token" };
/** Cloudflare 만 설정된 워커 — fetch 를 가짜로 */
const cloudflareOnly = (fetch: typeof globalThis.fetch) => ({ targets: purgeTargets(env, { fetch }) });

async function product(slug: string, status: "seeded" | "verified" | "banned") {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "소개", description: "설명",
    category: "Dev", status, source: "crawler", verifyToken: `nmv_verify_${slug}`, editTokenHash: "x".repeat(64),
  });
}

function cloudflare(body: unknown = { success: true }, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}
const tagsSent = (fetch: ReturnType<typeof cloudflare>, call = 0) =>
  JSON.parse(String((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body)).tags;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  ctx.log.mockClear();
});

describe("내려간 제품의 Cloudflare 지우기", () => {
  it("공개 제품이 내려가거나 지워질 때만 지울 목록에 적힌다", async () => {
    for (const slug of ["gone", "deleted", "still-public", "renamed"]) await product(slug, "seeded");
    await product("came-back", "banned");

    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "gone"));
    await db.delete(products).where(eq(products.slug, "deleted"));
    await db.update(products).set({ status: "verified" }).where(eq(products.slug, "still-public"));
    await db.update(products).set({ name: "새 이름" }).where(eq(products.slug, "renamed"));
    await db.update(products).set({ status: "seeded" }).where(eq(products.slug, "came-back"));

    const rows = await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges).orderBy(cdnPurges.id);
    expect(rows).toEqual([{ slug: "gone", reason: "banned" }, { slug: "deleted", reason: "deleted" }]);
  });

  it("한 요청에 모아 지우고 60초 뒤 한 번 더 지운 뒤 끝낸다", async () => {
    await product("one", "seeded");
    await product("two", "verified");
    await db.update(products).set({ status: "banned" });

    const fetch = cloudflare();
    await purgeRemovedProducts(ctx, cloudflareOnly(fetch));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer purge-token");
    expect(tagsSent(fetch)).toEqual(["p-one", "og-one", "p-two", "og-two", "lists"]);

    // 60초가 지나기 전에는 다시 보내지 않는다
    await purgeRemovedProducts(ctx, cloudflareOnly(fetch));
    expect(fetch).toHaveBeenCalledTimes(1);

    await db.update(cdnPurges).set({ purgedAt: sql`now() - interval '61 seconds'` });
    await purgeRemovedProducts(ctx, cloudflareOnly(fetch));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tagsSent(fetch, 1)).toEqual(["p-one", "og-one", "p-two", "og-two", "lists"]);
    const rows = await db.select().from(cdnPurges);
    expect(rows.every((row) => row.purgedAt && row.confirmedAt)).toBe(true);

    await purgeRemovedProducts(ctx, cloudflareOnly(fetch));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Cloudflare 가 거절하면 행을 남기고 시도 수와 오류만 적는다", async () => {
    await product("limited", "seeded");
    await db.update(products).set({ status: "banned" });

    await purgeRemovedProducts(ctx, cloudflareOnly(cloudflare({ success: false, errors: [{ message: "rate limited" }] }, 429)));

    const [row] = await db.select().from(cdnPurges);
    expect(row).toMatchObject({ purgedAt: null, confirmedAt: null, attempts: 1, lastError: "cloudflare: rate limited" });
    expect(ctx.log).toHaveBeenCalledWith("cdn_purge.failed", expect.objectContaining({ status: 429 }));
  });

  it("설정이 없으면 보내지 않고 쌓아 둔다", async () => {
    await product("waiting", "seeded");
    await db.update(products).set({ status: "banned" });
    const fetch = cloudflare();

    await purgeRemovedProducts(ctx, { targets: purgeTargets({}, { fetch }) });

    expect(fetch).not.toHaveBeenCalled();
    const [row] = await db.select().from(cdnPurges);
    expect(row).toMatchObject({ purgedAt: null, attempts: 0 });
    expect(ctx.log).toHaveBeenCalledWith("cdn_purge.unconfigured", { pending: 1 });
  });

  it("CloudFront 도 설정돼 있으면 같은 태그로 무효화하고, 한쪽이라도 실패하면 다시 보낸다", async () => {
    await product("both", "seeded");
    await db.update(products).set({ status: "banned" });
    const sent: unknown[] = [];
    let fail = true;
    const cloudfront = { send: vi.fn(async (command: { input: unknown }) => {
      sent.push(command.input);
      if (fail) throw Object.assign(new Error("Throttled"), { name: "TooManyInvalidationsInProgress", $metadata: { httpStatusCode: 400 } });
      return {};
    }) };
    const fetch = cloudflare();
    const targets = purgeTargets({ ...env, CLOUDFRONT_DISTRIBUTION_ID: "E123" }, { fetch, cloudfront: cloudfront as never });
    expect(targets.map((target) => target.name)).toEqual(["cloudflare", "cloudfront"]);

    await purgeRemovedProducts(ctx, { targets });
    let [row] = await db.select().from(cdnPurges);
    expect(row).toMatchObject({ purgedAt: null, attempts: 1 });
    expect(row.lastError).toContain("cloudfront: TooManyInvalidationsInProgress");

    fail = false;
    await purgeRemovedProducts(ctx, { targets });
    [row] = await db.select().from(cdnPurges);
    expect(row.purgedAt).not.toBeNull();
    expect(sent.at(-1)).toMatchObject({ DistributionId: "E123", InvalidationBatch: { Paths: { Quantity: 3, Items: ["#p-both", "#og-both", "#lists"] } } });
  });
});
