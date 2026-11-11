import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

const { db } = await import("@/lib/db");
const { products, cdnPurges, operationsObservations } = await import("@/lib/db/schema");
const { purgeRemovedProducts } = await import("@/lib/jobs/products/cdn-purge");
const { queueDetailPurge } = await import("@/lib/cdn/detail-purge");
const { PURGE_BATCH } = await import("@/lib/cdn/purge");
const repository = await import("@/lib/domain/products/repository");

/**
 * 내려간 제품을 Cloudflare 에서 지운다(2026-10-06 엣지 캐시).
 * 내리는 길이 여럿이라 DB 트리거가 적고, 발행 워커가 모아서 지운 뒤 60초 뒤 한 번 더 지운다.
 */
const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() };
const config = { zoneId: "zone-1", token: "purge-token" };

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
  // 웹 생존 관측은 resetTables 가 비우지 않는다 — 다른 파일이 남긴 웹 관측이 html 지우기를 부르지 않게
  await db.delete(operationsObservations).where(sql`${operationsObservations.key} like 'service:app:%'`);
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
    await purgeRemovedProducts(ctx, { config, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer purge-token");
    expect(tagsSent(fetch)).toEqual(["p-one", "og-one", "p-two", "og-two", "lists"]);

    // 60초가 지나기 전에는 다시 보내지 않는다
    await purgeRemovedProducts(ctx, { config, fetch });
    expect(fetch).toHaveBeenCalledTimes(1);

    await db.update(cdnPurges).set({ purgedAt: sql`now() - interval '61 seconds'` });
    await purgeRemovedProducts(ctx, { config, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tagsSent(fetch, 1)).toEqual(["p-one", "og-one", "p-two", "og-two", "lists"]);
    const rows = await db.select().from(cdnPurges);
    expect(rows.every((row) => row.purgedAt && row.confirmedAt)).toBe(true);

    await purgeRemovedProducts(ctx, { config, fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  /** 감사 보류(0110) — 상태가 바뀌지 않아 트리거가 적지 않는다. 보류는 그 상세(p-·og-)와 목록을, 모두 풀기는 목록만(빈 slug) 지운다 */
  it("감사 보류가 적은 줄을 같은 요청에 싣는다 — 빈 slug 의 줄은 목록만 지운다", async () => {
    await db.insert(cdnPurges).values([{ slug: "held", reason: "audit_hold" }, { slug: "", reason: "audit_release" }]);
    const fetch = cloudflare();
    await purgeRemovedProducts(ctx, { config, fetch });
    expect(tagsSent(fetch)).toEqual(["p-held", "og-held", "lists"]);

    await db.delete(cdnPurges);
    await db.insert(cdnPurges).values({ slug: "", reason: "audit_release" });
    await purgeRemovedProducts(ctx, { config, fetch });
    expect(tagsSent(fetch, 1)).toEqual(["lists"]);
  });

  it("Cloudflare 가 거절하면 행을 남기고 시도 수와 오류만 적는다", async () => {
    await product("limited", "seeded");
    await db.update(products).set({ status: "banned" });

    await purgeRemovedProducts(ctx, { config, fetch: cloudflare({ success: false, errors: [{ message: "rate limited" }] }, 429) });

    const [row] = await db.select().from(cdnPurges);
    expect(row).toMatchObject({ purgedAt: null, confirmedAt: null, attempts: 1, lastError: "rate limited" });
    expect(ctx.log).toHaveBeenCalledWith("cdn_purge.failed", expect.objectContaining({ status: 429 }));
  });

  it("설정이 없으면 보내지 않고 쌓아 둔다", async () => {
    await product("waiting", "seeded");
    await db.update(products).set({ status: "banned" });
    const fetch = cloudflare();

    await purgeRemovedProducts(ctx, { config: null, fetch });

    expect(fetch).not.toHaveBeenCalled();
    const [row] = await db.select().from(cdnPurges);
    expect(row).toMatchObject({ purgedAt: null, attempts: 0 });
    expect(ctx.log).toHaveBeenCalledWith("cdn_purge.unconfigured", { pending: 1 });
  });

  /**
   * 상세만 새로 받는 줄(2026-11-11) — 사람이 고친 상세가 엣지 사본(최대 5분)이 끝날 때까지 남지 않게 지운다.
   * 목록은 지우지 않고(목록은 2분 안에 스스로 새로 받는다), 내린 줄보다 뒤에 보낸다.
   */
  it("상세만 새로 받는 줄은 목록을 지우지 않고 내린 줄 뒤에 보낸다", async () => {
    await db.insert(cdnPurges).values({ slug: "edited-one", reason: "edited" });
    await product("gone", "seeded");
    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "gone"));

    const fetch = cloudflare();
    await purgeRemovedProducts(ctx, { config, fetch });
    // 내린 줄이 섞이면 목록까지, 내린 줄이 먼저
    expect(tagsSent(fetch)).toEqual(["p-gone", "og-gone", "p-edited-one", "og-edited-one", "lists"]);

    await db.delete(cdnPurges);
    await db.insert(cdnPurges).values([{ slug: "a", reason: "edited" }, { slug: "b", reason: "status" }]);
    await purgeRemovedProducts(ctx, { config, fetch });
    expect(tagsSent(fetch, 1)).toEqual(["p-a", "og-a", "p-b", "og-b"]);
  });

  it("한 요청이 꽉 차도 내린 줄이 먼저 실린다", async () => {
    await db.insert(cdnPurges).values(Array.from({ length: PURGE_BATCH }, (_, index) => ({ slug: `edit-${index}`, reason: "edited" })));
    await db.insert(cdnPurges).values({ slug: "later-ban", reason: "banned" });
    const fetch = cloudflare();
    await purgeRemovedProducts(ctx, { config, fetch });
    const tags = tagsSent(fetch) as string[];
    expect(tags.slice(0, 2)).toEqual(["p-later-ban", "og-later-ban"]);
    expect(tags).toContain("lists");
    expect(tags.filter((tag) => tag.startsWith("p-"))).toHaveLength(PURGE_BATCH);
    expect(tags.length).toBeLessThanOrEqual(100);
  });

  it("사람이 고친 제품의 지우기 줄은 아직 첫 지우기 전이면 하나로 모은다", async () => {
    await db.transaction((tx) => queueDetailPurge(tx, "same", "edited"));
    await db.transaction((tx) => queueDetailPurge(tx, "same", "status"));
    expect(await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges)).toEqual([{ slug: "same", reason: "edited" }]);
    // 첫 지우기를 한 줄은 두 번째 지우기가 이 커밋 직후일 수 있다 — 새 줄을 적는다
    await db.update(cdnPurges).set({ purgedAt: sql`now()` });
    await db.transaction((tx) => queueDetailPurge(tx, "same", "edited"));
    expect(await db.select({ id: cdnPurges.id }).from(cdnPurges)).toHaveLength(2);
  });

  it("메이커·관리자 수정과 트리거가 적지 않는 상태 바뀜이 상세 지우기 줄을 적는다", async () => {
    await product("maker-edit", "seeded");
    await product("came-back", "banned");
    await product("going", "seeded");
    const id = async (slug: string) => (await db.select({ id: products.id }).from(products).where(eq(products.slug, slug)))[0].id;

    await repository.update(await id("maker-edit"), { tagline: "고친 소개" });
    expect(await repository.setStatusWithAudit({ id: await id("came-back"), slug: "came-back", status: "seeded", action: "admin.product.unban" })).toBe(true);
    expect(await repository.setStatusWithAudit({ id: await id("going"), slug: "going", status: "banned", action: "admin.product.ban" })).toBe(true);

    const rows = await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges).orderBy(cdnPurges.id);
    // 공개에서 빠지는 차단은 트리거 줄 하나뿐(상세 줄을 겹쳐 적지 않는다)
    expect(rows).toEqual([
      { slug: "maker-edit", reason: "edited" },
      { slug: "came-back", reason: "status" },
      { slug: "going", reason: "banned" },
    ]);
  });

  /**
   * 웹 릴리스가 바뀐 뒤의 옛 HTML — 배포 도구의 지우기는 Linux 운영 호스트에서 토큰이 없어 건너뛴다. 토큰을 가진 발행 워커가
   * 웹 생존 관측(service:app:*)이 모두 같은 새 릴리스를 말할 때 html 태그를 지우고 2분 뒤 한 번 더 지운다.
   */
  it("웹이 모두 새 릴리스가 되면 html 을 한 번 지우고 2분 뒤 한 번 더 지운다", async () => {
    const observe = async (instance: string, release: string, ageSeconds = 0) => {
      const key = `service:app:${instance}`;
      const observedAt = sql`localtimestamp - make_interval(secs => ${ageSeconds})`;
      await db.insert(operationsObservations).values({ key, value: { status: "running", release }, observedAt })
        .onConflictDoUpdate({ target: operationsObservations.key, set: { value: { status: "running", release }, observedAt } });
    };
    const run = async (cursor: unknown, fetch: ReturnType<typeof cloudflare>) => {
      const outcome = await purgeRemovedProducts({ ...ctx, cursor: cursor as never }, { config, fetch });
      return (outcome as { cursor?: { html?: { release: string; purgedAt: string; confirmedAt?: string } } }).cursor ?? null;
    };

    // 롤링 중 — 릴리스가 갈리면 기다린다
    await observe("m3-web", "r1");
    await observe("mini-web", "r0");
    const fetch = cloudflare();
    expect(await run(null, fetch)).toEqual({});
    expect(fetch).not.toHaveBeenCalled();

    await observe("mini-web", "r1");
    let cursor = await run(null, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tagsSent(fetch)).toEqual(["html"]);
    expect(cursor?.html).toMatchObject({ release: "r1" });
    expect(cursor?.html?.confirmedAt).toBeUndefined();

    // 2분 전에는 다시 지우지 않는다
    cursor = await run(cursor, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);

    cursor = await run({ html: { ...cursor!.html!, purgedAt: new Date(Date.now() - 121_000).toISOString() } }, fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(tagsSent(fetch, 1)).toEqual(["html"]);
    expect(cursor?.html?.confirmedAt).toBeTruthy();

    // 확인까지 마친 릴리스는 더 지우지 않는다. 지우기 줄이 있어도 커서는 그대로 남는다
    await db.insert(cdnPurges).values({ slug: "x", reason: "edited" });
    const kept = await run(cursor, fetch);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(tagsSent(fetch, 2)).toEqual(["p-x", "og-x"]);
    expect(kept).toEqual(cursor);

    // 오래된 관측(멈춘 웹)은 세지 않는다 — 살아 있는 웹이 모두 r2 면 지운다
    await observe("m3-web", "r2");
    await observe("mini-web", "r1", 120);
    await run(kept, fetch);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(tagsSent(fetch, 3)).toEqual(["html"]);

    // 관측이 모두 오래되면 아무것도 하지 않는다
    await observe("m3-web", "r3", 120);
    await run(kept, fetch);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("html 지우기가 실패하면 지운 릴리스를 적지 않고 다음 틱에 다시 한다", async () => {
    await db.insert(operationsObservations).values({ key: "service:app:m3-web", value: { release: "r9" }, observedAt: sql`localtimestamp` });
    const failed = await purgeRemovedProducts({ ...ctx, cursor: null }, { config, fetch: cloudflare({ success: false, errors: [{ message: "rate limited" }] }, 429) });
    expect((failed as { cursor?: unknown }).cursor).toEqual({});
    expect(ctx.log).toHaveBeenCalledWith("cdn_purge.html_failed", expect.objectContaining({ release: "r9", status: 429 }));
  });
});
