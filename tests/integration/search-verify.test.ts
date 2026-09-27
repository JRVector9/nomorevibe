import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const { db } = await import("@/lib/db");
const { jobs, products, productSearchProfiles } = await import("@/lib/db/schema");
const { verifySearchKeywords } = await import("@/lib/jobs/products/search-verify");
const { writeSearchProfiles } = await import("@/lib/jobs/products/search-profile");
const { profileEvidence, profileHash } = await import("@/lib/domain/products/search-profile");
const { runJob } = await import("@/lib/jobs/runner");
const { reconcileSearchProfileBatch } = await import("@/lib/domain/products/search-profiles");
const { ensureSchema, resetTables } = await import("./setup");

async function seed(slug: string, en: string[], ko: string[], values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug, category: "Sports",
    status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", searchKeywords: [...en, ...ko].join(" · "), ...values,
  }).returning();
  await db.insert(productSearchProfiles).values({ productId: row.id, keywordsEn: en, keywordsKo: ko, sourceHash: profileHash(profileEvidence(row, null)), model: "m", attempts: 1 });
  return row.id;
}

type Answer = { status?: number; unsupported?: string[]; invalid?: boolean };
/** 가짜 게이트웨이 — 받은 제품의 키워드마다 fits 를 돌려준다 */
function gateway(pick: (name: string, keywords: string[]) => Answer): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const request = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    const user = body.messages[1].content as string;
    const input = JSON.parse(user.replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "")) as { evidence: { name: string }; keywords: string[] };
    calls.push(input.evidence.name);
    const answer = pick(input.evidence.name, input.keywords);
    const status = answer.status ?? 200;
    const checks = answer.invalid ? [] : input.keywords.map((keyword) => ({ keyword, searcher_wants: keyword, fits: !(answer.unsupported ?? []).includes(keyword) }));
    return { ok: status === 200, status, json: async () => ({ choices: [{ message: { content: JSON.stringify({ product: "p", checks }) } }] }) };
  });
  return Object.assign(request as unknown as typeof fetch, { calls });
}

const tick = (request: typeof fetch) => runJob<null>("product-search-verify", (ctx) => verifySearchKeywords(ctx, request));
const profile = async (id: number) => (await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0];
const keywordsOf = async (id: number) => (await db.select({ k: products.searchKeywords }).from(products).where(eq(products.id, id)))[0].k;

beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(productSearchProfiles); await db.delete(jobs); vi.stubEnv("ABCLLM_API_KEY", "test-key"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("검색 키워드 검수 잡", () => {
  it("preserves the failure cause so explicitly requeued exhausted checks use chunks", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key-${i}`);
    const id = await seed("reconciled-chunks", keys, []);
    await db.update(productSearchProfiles).set({ verifyError: "invalid_output", verifyAttempts: 5 })
      .where(eq(productSearchProfiles.productId, id));
    await reconcileSearchProfileBatch({ apply: true, retryInvalidOutput: true });
    expect(await profile(id)).toMatchObject({ verifyError: "invalid_output", verifyAttempts: 0 });
    const request = gateway(() => ({}));
    await tick(request);
    expect(request.calls).toHaveLength(3);
    expect((await profile(id)).verifiedAt).not.toBeNull();
  });
  it("respects retry backoff then commits only all completed chunks", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key-${i}`);
    const id = await seed("chunk-retry", keys, []);
    await db.update(productSearchProfiles).set({ verifyError: "invalid_output", verifyAttempts: 1,
      verifyRetryAt: sql`now() + interval '1 hour'` }).where(eq(productSearchProfiles.productId, id));
    const request = gateway(() => ({ unsupported: [keys[7], keys[11]] }));
    await tick(request);
    expect(request.calls).toHaveLength(0);
    await db.update(productSearchProfiles).set({ verifyRetryAt: null }).where(eq(productSearchProfiles.productId, id));
    await tick(request);
    expect(request.calls).toHaveLength(3);
    expect(await profile(id)).toMatchObject({ verifyAttempts: 2, verifyError: null, removedKeywords: [keys[7], keys[11]] });
    expect((await profile(id)).verifiedAt).not.toBeNull();
    expect(await keywordsOf(id)).toBe(keys.filter(k => k !== keys[7] && k !== keys[11]).join(" · "));
  });
  it("does not save prior chunk removals when a later chunk fails", async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `key-${i}`);
    const id = await seed("chunk-failure", keys, []);
    await db.update(productSearchProfiles).set({ verifyError: "invalid_output", verifyAttempts: 1 })
      .where(eq(productSearchProfiles.productId, id));
    let calls = 0;
    const request = gateway(() => ++calls === 1 ? { unsupported: [keys[0]] } : { invalid: true });
    await tick(request);
    expect(request.calls).toHaveLength(2);
    expect(await profile(id)).toMatchObject({ verifyAttempts: 2, verifyError: "invalid_output", verifiedAt: null, removedKeywords: [] });
    expect(await keywordsOf(id)).toBe(keys.join(" · "));
  });
  it("뒷받침되지 않는 키워드를 색인용 사본에서 빼고, 원본은 두고, 어느 모델이 봤는지 남긴다", async () => {
    const id = await seed("academy", ["sports academy management", "membership bonuses"], ["스포츠 학원 관리", "보너스 관리"]);
    const request = gateway(() => ({ unsupported: ["membership bonuses", "보너스 관리"] }));

    expect(await tick(request)).toMatchObject({ status: "completed", done: true });

    const row = await profile(id);
    expect(row.verifiedAt).not.toBeNull();
    expect(row).toMatchObject({ removedKeywords: ["membership bonuses", "보너스 관리"], verifyModel: "[supa] Qwen3.8-27B-NVFP4",
      keywordsEn: ["sports academy management", "membership bonuses"] });
    expect(await keywordsOf(id)).toBe("sports academy management · 스포츠 학원 관리");

    // 검수한 것은 다시 부르지 않는다
    await tick(request);
    expect(request.calls).toHaveLength(1);
  });

  it("모델이 내려가 있으면 틱을 접고 30분 쉰다 — 제품의 실패로 세지 않는다", async () => {
    const ids = [await seed("a", ["a app"], []), await seed("b", ["b app"], []), await seed("c", ["c app"], [])];
    const request = gateway(() => ({ status: 404 }));

    expect(await tick(request)).toMatchObject({ status: "completed", done: true });

    const rows = await Promise.all(ids.map(profile));
    const failed = rows.filter((row) => row.verifyError === "model_unavailable");
    expect(failed.length).toBeGreaterThan(0);
    for (const row of failed) {
      expect(row).toMatchObject({ verifyAttempts: 0, verifiedAt: null });
      const [{ minutes }] = await db.execute(sql`select extract(epoch from ${row.verifyRetryAt!.toISOString()}::timestamp - now()) / 60 as minutes`) as unknown as { minutes: number }[];
      expect(Number(minutes)).toBeGreaterThan(20);
    }
  });

  it("알아볼 수 없는 답은 실패로 센다", async () => {
    const id = await seed("garbled", ["coffee shop"], ["카페"]);
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "no json here" } }] }) });
    await tick(request as unknown as typeof fetch);
    expect(await profile(id)).toMatchObject({ verifiedAt: null, verifyError: "invalid_output", verifyAttempts: 1 });
  });

  it("일부만 판정하거나 빈 checks를 받으면 키워드를 지우지 않고 재시도한다", async () => {
    for (const checks of [[], [{ keyword: "coffee shop", fits: false }]]) {
      const id = await seed(`partial-${checks.length}`, ["coffee shop"], ["카페"]);
      const request = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ checks }) } }] }) });
      await tick(request as unknown as typeof fetch);
      expect(await profile(id)).toMatchObject({ verifiedAt: null, verifyError: "invalid_output", verifyAttempts: 1, removedKeywords: [] });
      expect(await keywordsOf(id)).toBe("coffee shop · 카페");
    }
  });

  it("키워드를 다시 지으면 검수를 비워 다시 본다", async () => {
    const id = await seed("academy", ["sports academy management", "membership bonuses"], ["보너스 관리"], { tagline: "Bonos de clases" });
    await tick(gateway(() => ({ unsupported: ["membership bonuses"] })));
    expect((await profile(id)).verifiedAt).not.toBeNull();

    // 글이 바뀌고 30일이 지나 키워드를 다시 짓는다
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '31 days'` }).where(eq(productSearchProfiles.productId, id));
    await db.update(products).set({ tagline: "Class packs for a football academy" }).where(eq(products.id, id));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content:
      JSON.stringify({ keywords_en: ["class pass management"], keywords_ko: ["수강권 관리"] }) } }] }) }));
    await runJob("product-search-profile", writeSearchProfiles);

    expect(await profile(id)).toMatchObject({ verifiedAt: null, removedKeywords: [], keywordsEn: ["class pass management"] });
    expect(await keywordsOf(id)).toBe("class pass management · 수강권 관리");
  });

  it("한 번에 넷을 부른다 — 같은 제품을 두 번 부르지 않는다", async () => {
    for (let i = 0; i < 16; i++) await seed(`p${i}`, [`keyword ${i}`], []);
    let inFlight = 0, peak = 0;
    const inner = gateway(() => ({}));
    const slow = (async (url: unknown, init?: unknown) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { return await (inner as unknown as (u: unknown, i: unknown) => Promise<Response>)(url, init); } finally { inFlight--; }
    }) as unknown as typeof fetch;
    await tick(slow);
    expect(peak).toBe(4);
    expect(inner.calls).toHaveLength(16);
    expect(new Set(inner.calls).size).toBe(16);
  });

  it("검수 도중 원본이 바뀌면 이전 응답을 저장하거나 키워드를 삭제하지 않는다", async () => {
    const id = await seed("changed-during-check", ["coffee shop"], ["카페"]);
    const inner = gateway(() => ({ unsupported: ["coffee shop"] }));
    const request = (async (...args: Parameters<typeof fetch>) => {
      await db.update(products).set({ tagline: "Workout diary" }).where(eq(products.id, id));
      return inner(...args);
    }) as typeof fetch;
    await tick(request);
    expect(await profile(id)).toMatchObject({ verifiedAt: null, removedKeywords: [], needsRefresh: true });
    expect(await keywordsOf(id)).toBe("coffee shop · 카페");
  });

  it("이전 데이터의 해시 불일치를 검수에서 만나면 재생성으로 넘겨 반복 호출하지 않는다", async () => {
    const id = await seed("old-hash", ["coffee shop"], []);
    await db.update(productSearchProfiles).set({ sourceHash: "old" }).where(eq(productSearchProfiles.productId, id));
    const request = gateway(() => ({}));
    await tick(request);
    expect(request.calls).toHaveLength(1);
    expect(await profile(id)).toMatchObject({ needsRefresh: true, verifiedAt: null });
  });

  it("공개되지 않은 제품·키워드가 없는 것은 부르지 않는다", async () => {
    await seed("hidden", ["x keyword"], [], { status: "banned" });
    await seed("empty", [], []);
    const request = gateway(() => ({}));
    await tick(request);
    expect(request.calls).toHaveLength(0);
  });
});
