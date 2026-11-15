import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

const { db } = await import("@/lib/db");
const { cdnPurges, jobs, ogImages, products, productThumbnailState, takedownRequests } = await import("@/lib/db/schema");
const repo = await import("@/lib/domain/products/repository");
const { requestTakedown, resolveTakedown } = await import("@/lib/domain/products/takedown");
const { purgeRemovedProducts } = await import("@/lib/jobs/products/cdn-purge");
const { OG_DELETE_PURGE } = await import("@/lib/cdn/purge");
const { loadThumbnailProduct, saveThumbnail } = await import("@/lib/domain/products/thumbnails/repository");
const { defaultThumbnail } = await import("@/lib/domain/products/thumbnails/images");
const { OgImageUnavailableError, OgStoreError, setOgObjectStoreForTests } = await import("@/lib/storage/og-store");
type OgObjectStore = import("@/lib/storage/og-store").OgObjectStore;
type JobLease = import("@/lib/jobs/control").JobLease;

/**
 * 대표 그림 버킷(2026-11-15) — 쓰기·읽기·대체·지우기·내리기·썸네일 차례를 가짜 버킷과 진짜 테스트 DB 로 본다.
 * 가짜 버킷은 모든 호출을 events 에 적어, Cloudflare 지우기보다 버킷 지우기가 먼저인지 같은 차례를 본다.
 */
type Op = "get" | "head" | "put" | "delete";
function fakeStore(events: string[] = []) {
  const objects = new Map<string, { data: Buffer; contentType: string }>();
  const failing = new Set<Op>();
  const hooks: Partial<Record<Op, (slug: string) => Promise<void>>> = {};
  const enter = async (op: Op, slug: string) => {
    events.push(`store:${op}:${slug}`);
    await hooks[op]?.(slug);
    if (failing.has(op)) throw new OgStoreError(op, "http_503");
  };
  const store: OgObjectStore = {
    async get(slug) { await enter("get", slug); return objects.get(slug) ?? null; },
    async head(slug) {
      await enter("head", slug);
      const object = objects.get(slug);
      return object ? { size: object.data.length, etag: null, contentType: object.contentType } : null;
    },
    async put(slug, object, options) {
      await enter("put", slug);
      if (options?.ifAbsent && objects.has(slug)) return "exists";
      objects.set(slug, { data: Buffer.from(object.data), contentType: object.contentType });
      return "stored";
    },
    async delete(slug) { await enter("delete", slug); objects.delete(slug); },
  };
  return { store, objects, failing, hooks, events };
}

const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() };
const config = { zoneId: "zone-1", token: "purge-token" };
function cloudflare(events: string[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    events.push(`cf:${JSON.parse(String(init?.body)).tags.join(",")}`);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

async function product(slug: string, status: "seeded" | "verified" = "seeded", extra: Record<string, unknown> = {}) {
  await repo.insert({
    repoUrl: null, slug, url: `https://${slug}.test`, name: slug, tagline: "소개", description: "설명입니다.",
    category: "Other", stack: [], status, source: "crawler", verifyToken: `nmv_verify_${slug}`, editTokenHash: "x".repeat(64), ...extra,
  } as Parameters<typeof repo.insert>[0]);
  return (await repo.findBySlug(slug))!;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  setOgObjectStoreForTests(undefined);
  await db.delete(takedownRequests);
  await db.delete(jobs).where(eq(jobs.name, "og-store-test"));
  await resetTables();
  ctx.log.mockClear();
});
afterAll(() => setOgObjectStoreForTests(undefined));

describe("쓰기", () => {
  it("버킷이 켜지면 버킷에 두고 그 slug 의 옛 DB 사본을 지운다", async () => {
    const fake = fakeStore();
    await db.insert(ogImages).values({ slug: "app", contentType: "image/png", data: Buffer.from("old") });
    setOgObjectStoreForTests(fake.store);
    await repo.putOgImage("app", "image/jpeg", Buffer.from("new"));
    expect(fake.objects.get("app")).toEqual({ data: Buffer.from("new"), contentType: "image/jpeg" });
    expect(await db.select().from(ogImages)).toEqual([]);
  });

  it("버킷 쓰기가 실패하면 던지고 DB 는 그대로다", async () => {
    const fake = fakeStore();
    await db.insert(ogImages).values({ slug: "app", contentType: "image/png", data: Buffer.from("old") });
    fake.failing.add("put");
    setOgObjectStoreForTests(fake.store);
    await expect(repo.putOgImage("app", "image/jpeg", Buffer.from("new"))).rejects.toThrow("og_store_put_http_503");
    expect((await db.select().from(ogImages)).map((row) => Buffer.from(row.data).toString())).toEqual(["old"]);
  });

  it("일 토큰을 잃은 발행 워커는 버킷도 쓰지 않는다", async () => {
    const fake = fakeStore();
    setOgObjectStoreForTests(fake.store);
    const lease: JobLease = { name: "og-store-test", token: "old-token", requestedVersion: 1 };
    await db.insert(jobs).values({ name: lease.name, leaseToken: null, lockedAt: sql`now()`, requestedVersion: 1 });
    await expect(repo.putOgImage("app", "image/png", Buffer.from("x"), lease)).rejects.toThrow("job_lease_lost");
    expect(fake.events).toEqual([]);
  });

  it("버킷이 꺼져 있으면 지금처럼 DB 에 쓴다", async () => {
    setOgObjectStoreForTests(null);
    await repo.putOgImage("app", "image/png", Buffer.from("db"));
    expect(await repo.getOgImage("app")).toEqual({ data: Buffer.from("db"), contentType: "image/png" });
  });
});

describe("읽기", () => {
  it("버킷 먼저 — 있으면 DB 를 보지 않은 그대로 버킷 것을 준다", async () => {
    const fake = fakeStore();
    fake.objects.set("app", { data: Buffer.from("bucket"), contentType: "image/webp" });
    await db.insert(ogImages).values({ slug: "app", contentType: "image/png", data: Buffer.from("db") });
    setOgObjectStoreForTests(fake.store);
    expect(await repo.getOgImage("app")).toEqual({ data: Buffer.from("bucket"), contentType: "image/webp" });
  });

  it("버킷에 없거나 버킷이 실패하면 DB 로 돌아간다", async () => {
    const fake = fakeStore();
    await db.insert(ogImages).values({ slug: "app", contentType: "image/png", data: Buffer.from("db") });
    setOgObjectStoreForTests(fake.store);
    expect(await repo.getOgImage("app")).toEqual({ data: Buffer.from("db"), contentType: "image/png" });
    expect(await repo.getOgImage("nothing")).toBeNull();
    fake.failing.add("get");
    expect(await repo.getOgImage("app")).toEqual({ data: Buffer.from("db"), contentType: "image/png" });
  });

  it("버킷이 실패했는데 DB 에도 없으면 404 가 아니라 '잠시 못 읽음'", async () => {
    const fake = fakeStore();
    fake.failing.add("get");
    setOgObjectStoreForTests(fake.store);
    await expect(repo.getOgImage("app")).rejects.toBeInstanceOf(OgImageUnavailableError);
  });
});

describe("지우기", () => {
  it("deleteOgImage 는 버킷과 DB 에서 모두 지운다", async () => {
    const fake = fakeStore();
    fake.objects.set("app", { data: Buffer.from("bucket"), contentType: "image/webp" });
    await db.insert(ogImages).values({ slug: "app", contentType: "image/png", data: Buffer.from("db") });
    setOgObjectStoreForTests(fake.store);
    await repo.deleteOgImage("app");
    expect(fake.objects.size).toBe(0);
    expect(await db.select().from(ogImages)).toEqual([]);
  });

  it("메이커 삭제는 같은 커밋에 버킷 지우기 줄을 적는다(버킷이 꺼져 있으면 적지 않는다)", async () => {
    const fake = fakeStore();
    setOgObjectStoreForTests(fake.store);
    const gone = await product("gone");
    expect(await repo.removeProductAndEvidence(gone.id, gone.slug)).toBe(true);
    setOgObjectStoreForTests(null);
    const plain = await product("plain");
    expect(await repo.removeProductAndEvidence(plain.id, plain.slug)).toBe(true);
    const rows = await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges).orderBy(cdnPurges.id);
    expect(rows).toEqual([
      { slug: "gone", reason: OG_DELETE_PURGE }, { slug: "gone", reason: "deleted" }, { slug: "plain", reason: "deleted" },
    ]);
    // 버킷은 아직 건드리지 않는다 — 발행 워커가 지운다
    expect(fake.events).toEqual([]);
  });
});

describe("내리기", () => {
  async function takenDown(fake: ReturnType<typeof fakeStore>, slug = "taken") {
    await product(slug);
    fake.objects.set(slug, { data: Buffer.from("bucket"), contentType: "image/webp" });
    await db.insert(ogImages).values({ slug, contentType: "image/png", data: Buffer.from("db") });
    setOgObjectStoreForTests(fake.store);
    await requestTakedown(slug, "내려 주세요");
    expect(await resolveTakedown(slug, "remove", "jr")).toMatchObject({ ok: true });
  }

  it("DB 사본을 지우고, 발행 워커가 버킷에서 지운 뒤에 Cloudflare 를 지운다", async () => {
    const events: string[] = [];
    const fake = fakeStore(events);
    await takenDown(fake);
    expect(await db.select().from(ogImages)).toEqual([]);
    expect(fake.objects.has("taken")).toBe(true);

    await purgeRemovedProducts(ctx, { config, fetch: cloudflare(events), store: fake.store });
    expect(fake.objects.has("taken")).toBe(false);
    expect(events).toEqual(["store:delete:taken", "cf:p-taken,og-taken,lists"]);
    const rows = await db.select().from(cdnPurges);
    expect(rows.every((row) => row.purgedAt)).toBe(true);
  });

  it("버킷 지우기가 실패하면 그 줄은 남아 다음 틱에 다시 하고, 지운 뒤에야 그 줄로 태그를 지운다", async () => {
    const events: string[] = [];
    const fake = fakeStore(events);
    await takenDown(fake);
    fake.failing.add("delete");
    const fetch = cloudflare(events);

    await purgeRemovedProducts(ctx, { config, fetch, store: fake.store });
    const [og] = await db.select().from(cdnPurges).where(eq(cdnPurges.reason, OG_DELETE_PURGE));
    expect(og).toMatchObject({ purgedAt: null, attempts: 1, lastError: "og_store_delete_http_503" });
    expect(ctx.log).toHaveBeenCalledWith("cdn_purge.og_delete_failed", expect.objectContaining({ slug: "taken", error: "og_store_delete_http_503" }));
    expect(fake.objects.has("taken")).toBe(true);

    fake.failing.delete("delete");
    events.length = 0;
    await purgeRemovedProducts(ctx, { config, fetch, store: fake.store });
    expect(events).toEqual(["store:delete:taken", "cf:p-taken,og-taken"]);
    expect(fake.objects.has("taken")).toBe(false);
    const [done] = await db.select().from(cdnPurges).where(eq(cdnPurges.reason, OG_DELETE_PURGE));
    expect(done.purgedAt).toBeInstanceOf(Date);
  });

  it("발행 워커에 버킷 설정이 없으면 지운 척하지 않는다", async () => {
    const fake = fakeStore();
    await takenDown(fake);
    await purgeRemovedProducts(ctx, { config, fetch: cloudflare([]), store: null });
    const [og] = await db.select().from(cdnPurges).where(eq(cdnPurges.reason, OG_DELETE_PURGE));
    expect(og).toMatchObject({ purgedAt: null, lastError: "og_store_unconfigured" });
    expect(fake.objects.has("taken")).toBe(true);
  });

  it("지운 slug 를 새 제품이 다시 얻었으면 그 그림은 지우지 않는다", async () => {
    const fake = fakeStore();
    setOgObjectStoreForTests(fake.store);
    const old = await product("reuse");
    expect(await repo.removeProductAndEvidence(old.id, old.slug)).toBe(true);
    await db.update(cdnPurges).set({ createdAt: sql`now() - interval '1 minute'` });
    await product("reuse");
    fake.objects.set("reuse", { data: Buffer.from("new product"), contentType: "image/png" });
    await purgeRemovedProducts(ctx, { config, fetch: cloudflare([]), store: fake.store });
    expect(fake.objects.has("reuse")).toBe(true);
    expect(ctx.log).toHaveBeenCalledWith("cdn_purge.og_delete_reused", { slugs: ["reuse"] });
  });
});

describe("썸네일", () => {
  async function fixture() {
    await db.insert(products).values({ slug: "thumb", url: "https://thumb.test", name: "Thumb", tagline: "A useful product", description: "Description",
      category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", repoUrl: "https://github.com/acme/thumb" });
    return (await loadThumbnailProduct("thumb"))!;
  }

  it("검사를 지난 뒤 커밋 전에 버킷에 올린다 — 올리는 순간 상태는 아직 보이지 않고, 커밋된 상태는 버킷의 그림을 가리킨다", async () => {
    const fake = fakeStore();
    let stateAtPut: unknown = "unset";
    fake.hooks.put = async () => { stateAtPut = await db.query.productThumbnailState.findFirst(); };
    setOgObjectStoreForTests(fake.store);
    const p = await fixture();
    const image = await defaultThumbnail(p.name);
    expect(await saveThumbnail(p, { ...image, kind: "default", sourceUrl: null, errors: [] })).toBe(true);
    expect(stateAtPut).toBeUndefined();
    expect(fake.objects.get("thumb")).toEqual({ data: image.data, contentType: "image/webp" });
    expect(await db.select().from(ogImages)).toEqual([]);
    expect((await db.query.productThumbnailState.findFirst())?.kind).toBe("default");
    expect((await loadThumbnailProduct("thumb"))?.ogImage).toContain("/api/og-cache/thumb?thumbnail=default");
  });

  it("버킷 쓰기가 실패하면 상태도 주소도 남지 않는다", async () => {
    const fake = fakeStore();
    fake.failing.add("put");
    setOgObjectStoreForTests(fake.store);
    const p = await fixture();
    await expect(saveThumbnail(p, { ...await defaultThumbnail(p.name), kind: "default", sourceUrl: null, errors: [] }))
      .rejects.toThrow("og_store_put_http_503");
    expect(await db.select().from(productThumbnailState)).toEqual([]);
    expect((await loadThumbnailProduct("thumb"))?.ogImage).toBeNull();
  });

  it("검사가 거절하는 그림(바뀐 제품·더 나쁜 그림)은 버킷에 올리지 않는다", async () => {
    const fake = fakeStore();
    setOgObjectStoreForTests(fake.store);
    let p = await fixture();
    await db.update(products).set({ updatedAt: sql`now() + interval '1 second'`, name: "Changed" }).where(eq(products.slug, "thumb"));
    expect(await saveThumbnail(p, { ...await defaultThumbnail(p.name), kind: "default", sourceUrl: null, errors: [] })).toBe(false);
    expect(fake.events).toEqual([]);

    p = (await loadThumbnailProduct("thumb"))!;
    const good = await defaultThumbnail("good");
    expect(await saveThumbnail(p, { ...good, kind: "site_icon", sourceUrl: "https://thumb.test/icon.png", errors: [] })).toBe(true);
    p = (await loadThumbnailProduct("thumb"))!;
    fake.events.length = 0;
    expect(await saveThumbnail(p, { ...await defaultThumbnail("worse"), kind: "default", sourceUrl: null, errors: ["timeout"] })).toBe(true);
    expect(fake.events).toEqual([]);
    expect(fake.objects.get("thumb")?.data).toEqual(good.data);
    expect((await db.query.productThumbnailState.findFirst())).toMatchObject({ kind: "site_icon", lastError: "timeout" });
  });
});
