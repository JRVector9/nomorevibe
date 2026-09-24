import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { ReviewCliRun } from "@/lib/crawl/agent-review";

const { db } = await import("@/lib/db");
const { jobs, products, productSearchProfiles } = await import("@/lib/db/schema");
const { verifySearchKeywords } = await import("@/lib/jobs/products/search-verify");
const { writeSearchProfiles } = await import("@/lib/jobs/products/search-profile");
const { runJob } = await import("@/lib/jobs/runner");
const { ensureSchema, resetTables } = await import("./setup");

async function seed(slug: string, en: string[], ko: string[], values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug, category: "Sports",
    status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", searchKeywords: [...en, ...ko].join(" · "), ...values,
  }).returning({ id: products.id });
  await db.insert(productSearchProfiles).values({ productId: row.id, keywordsEn: en, keywordsKo: ko, sourceHash: "h", model: "m", attempts: 1 });
  return row.id;
}

/** 가짜 claude -p — 받은 제품마다 unsupported 를 돌려준다 */
function cli(pick: (slug: string, keywords: string[]) => string[] | undefined, envelope: object = {}): ReviewCliRun & { calls: number } {
  const run = Object.assign(async (_args: string[], stdin: string) => {
    run.calls++;
    const body = JSON.parse(stdin.replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "")) as { slug: string; keywords: string[] }[];
    const results = body.flatMap((p) => { const u = pick(p.slug, p.keywords); return u ? [{ slug: p.slug, unsupported: u }] : []; });
    return { kind: "exit" as const, code: 0, stdout: JSON.stringify({ is_error: false, structured_output: { results }, ...envelope }), stderr: "" };
  }, { calls: 0 });
  return run;
}

const tick = (run: ReviewCliRun) => runJob<null>("product-search-verify", (ctx) => verifySearchKeywords(ctx, run));
const profile = async (id: number) => (await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0];
const keywordsOf = async (id: number) => (await db.select({ k: products.searchKeywords }).from(products).where(eq(products.id, id)))[0].k;

beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(productSearchProfiles); await db.delete(jobs); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("검색 키워드 검수 잡", () => {
  it("뒷받침되지 않는 키워드를 색인용 사본에서 빼고, 원본은 둔다", async () => {
    const id = await seed("academy", ["sports academy management", "membership bonuses"], ["스포츠 학원 관리", "보너스 관리"]);
    const run = cli((slug) => slug === "academy" ? ["membership bonuses", "보너스 관리"] : []);

    expect(await tick(run)).toMatchObject({ status: "completed", done: true });

    const row = await profile(id);
    expect(row.verifiedAt).not.toBeNull();
    expect(row.removedKeywords).toEqual(["membership bonuses", "보너스 관리"]);
    expect(row.keywordsEn).toEqual(["sports academy management", "membership bonuses"]);
    expect(await keywordsOf(id)).toBe("sports academy management · 스포츠 학원 관리");

    // 검수한 것은 다시 부르지 않는다
    await tick(run);
    expect(run.calls).toBe(1);
  });

  it("한도에 걸리면 이번 틱을 접고 30분 쉰다 — 실패로 세지 않는다", async () => {
    const id = await seed("academy", ["sports academy management"], ["스포츠 학원 관리"]);
    const run = Object.assign(async () => ({ kind: "exit" as const, code: 1, stderr: "",
      stdout: JSON.stringify({ is_error: true, result: "Claude AI usage limit reached" }) }), {});

    expect(await tick(run)).toMatchObject({ status: "completed", done: true });

    const row = await profile(id);
    expect(row).toMatchObject({ verifyError: "rate_limited", verifyAttempts: 0, verifiedAt: null });
    const [{ minutes }] = await db.execute<{ minutes: number }>(sql`select extract(epoch from ${row.verifyRetryAt!.toISOString()}::timestamp - now()) / 60 as minutes`) as unknown as { minutes: number }[];
    expect(Number(minutes)).toBeGreaterThan(20);
    expect(await keywordsOf(id)).toBe("sports academy management · 스포츠 학원 관리");
  });

  it("답이 빠진 제품은 검수하지 않은 것으로 남긴다", async () => {
    const answered = await seed("answered", ["coffee shop"], ["카페"]);
    const skipped = await seed("skipped", ["tea shop"], ["찻집"]);
    await tick(cli((slug) => slug === "answered" ? [] : undefined));

    expect((await profile(answered)).verifiedAt).not.toBeNull();
    expect(await profile(skipped)).toMatchObject({ verifiedAt: null, verifyError: "missing_result", verifyAttempts: 1 });
  });

  it("키워드를 다시 지으면 검수를 비워 다시 본다", async () => {
    const id = await seed("academy", ["sports academy management", "membership bonuses"], ["보너스 관리"], { tagline: "Bonos de clases" });
    await tick(cli(() => ["membership bonuses"]));
    expect((await profile(id)).verifiedAt).not.toBeNull();

    // 글이 바뀌고 30일이 지나 키워드를 다시 짓는다
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '31 days'` }).where(eq(productSearchProfiles.productId, id));
    await db.update(products).set({ tagline: "Class packs for a football academy" }).where(eq(products.id, id));
    vi.stubEnv("ABCLLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content:
      JSON.stringify({ keywords_en: ["class pass management"], keywords_ko: ["수강권 관리"] }) } }] }) }));
    await runJob("product-search-profile", writeSearchProfiles);

    expect(await profile(id)).toMatchObject({ verifiedAt: null, removedKeywords: [], keywordsEn: ["class pass management"] });
    expect(await keywordsOf(id)).toBe("class pass management · 수강권 관리");
  });

  it("한 번에 두 묶음을 동시에 부른다 — 같은 제품을 두 번 부르지 않는다", async () => {
    for (let i = 0; i < 20; i++) await seed(`p${i}`, [`keyword ${i}`], []);
    const seen: string[] = [];
    let inFlight = 0, peak = 0;
    const run = cli((slug) => { seen.push(slug); return []; });
    const slow: ReviewCliRun = async (args, stdin, options) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { return await run(args, stdin, options); } finally { inFlight--; }
    };
    await tick(slow);
    expect(run.calls).toBe(2);
    expect(peak).toBe(2);
    expect(new Set(seen).size).toBe(20);
    expect(seen).toHaveLength(20);
  });

  it("공개되지 않은 제품·키워드가 없는 것은 부르지 않는다", async () => {
    await seed("hidden", ["x keyword"], [], { status: "banned" });
    await seed("empty", [], []);
    const run = cli(() => []);
    await tick(run);
    expect(run.calls).toBe(0);
  });
});
