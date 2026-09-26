import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { ReviewCliRun } from "@/lib/crawl/agent-review";

const { db } = await import("@/lib/db");
const { jobs, products, productIntroChecks, productSearchProfiles } = await import("@/lib/db/schema");
const { checkProductIntros } = await import("@/lib/jobs/products/intro-check");
const { countProducts, listProducts } = await import("@/lib/domain/products/repository");
const { runJob } = await import("@/lib/jobs/runner");
const { ensureSchema, resetTables } = await import("./setup");

async function seed(slug: string, tagline: string, values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline, description: tagline, category: "Games", taglineSource: "ai_page",
    status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", searchPageText: `${slug} page text`, ...values,
  }).returning({ id: products.id });
  return row.id;
}

type Answer = { verdict: string; problem?: string; corrected?: string };
/** 가짜 claude -p — 받은 제품마다 판정을 돌려준다 */
function cli(pick: (slug: string) => Answer | undefined): ReviewCliRun & { calls: number; seen: string[] } {
  const run = Object.assign(async (_args: string[], stdin: string) => {
    run.calls++;
    const body = JSON.parse(stdin.replace(/^<untrusted_evidence_json>\n/, "").replace(/\n<\/untrusted_evidence_json>$/, "")) as { slug: string }[];
    run.seen.push(...body.map((p) => p.slug));
    const results = body.flatMap((p) => { const a = pick(p.slug); return a ? [{ slug: p.slug, problem: "", corrected: "", ...a }] : []; });
    return { kind: "exit" as const, code: 0, stdout: JSON.stringify({ is_error: false, structured_output: { results } }), stderr: "" };
  }, { calls: 0, seen: [] as string[] });
  return run;
}

const tick = (run: ReviewCliRun) => runJob<null>("product-intro-check", (ctx) => checkProductIntros(ctx, run));
const product = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
const check = async (id: number) => (await db.select().from(productIntroChecks).where(eq(productIntroChecks.productId, id)))[0];

beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(jobs); });

describe("소개 검수 잡", () => {
  it("틀린 AI 소개를 고쳐 쓴 줄로 바꾸고 원래 값을 남긴다 — 키워드는 다시 짓게 지운다", async () => {
    const id = await seed("margo", "Create custom items for World of Warcraft", { searchKeywords: "wow items" });
    await db.insert(productSearchProfiles).values({ productId: id, keywordsEn: ["wow items"], keywordsKo: [], sourceHash: "h", model: "m" });
    const run = cli(() => ({ verdict: "wrong", problem: "Margonem, not WoW", corrected: "Margonem 아이템을 만들어 보는 편집기." }));

    expect(await tick(run)).toMatchObject({ status: "completed", done: true });

    expect(await product(id)).toMatchObject({ tagline: "Margonem 아이템을 만들어 보는 편집기", taglineSource: "ai_fixed",
      description: "Margonem 아이템을 만들어 보는 편집기", searchKeywords: null });
    expect(await check(id)).toMatchObject({ verdict: "wrong", outcome: "replaced", problem: "Margonem, not WoW",
      originalTagline: "Create custom items for World of Warcraft", originalSource: "ai_page",
      originalDescription: "Create custom items for World of Warcraft", errorCode: null });
    expect(await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id))).toHaveLength(0);

    // 고쳐 쓴 소개는 다시 보지 않는다
    await tick(run);
    expect(run.calls).toBe(1);
  });

  it("메이커 소개는 쓸모없을 때만 바꾸고 메이커의 주장은 둔다 — 설명이 따로 있으면 설명은 그대로", async () => {
    const junk = await seed("photo-sorter", "zianocom/photo-sorter", { taglineSource: "maker", description: "Photo sorting tool with OCR for receipts" });
    const claim = await seed("checker", "Verify in 10s", { taglineSource: "maker" });
    const run = cli((slug) => slug === "photo-sorter"
      ? { verdict: "uninformative", corrected: "Sort receipt photos by the business name read with OCR" }
      : { verdict: "wrong", corrected: "Check if a product is genuine" });

    await tick(run);

    expect(await product(junk)).toMatchObject({ tagline: "Sort receipt photos by the business name read with OCR",
      taglineSource: "ai_fixed", description: "Photo sorting tool with OCR for receipts" });
    expect(await product(claim)).toMatchObject({ tagline: "Verify in 10s", taglineSource: "maker" });
    expect(await check(claim)).toMatchObject({ verdict: "wrong", outcome: "kept", originalTagline: null });
  });

  it("근거로 알 수 없으면 관리자 목록의 \"소개 확인 필요\"에 올린다 — 소개가 바뀌면 빠진다", async () => {
    const id = await seed("blank", "Default page", { taglineSource: "maker" });
    await seed("fine", "Plan meals for the week");
    await tick(cli((slug) => slug === "blank" ? { verdict: "uninformative", corrected: "" } : { verdict: "ok" }));

    expect(await check(id)).toMatchObject({ outcome: "needs_editor", corrected: "" });
    expect((await product(id)).tagline).toBe("Default page");
    const listed = await listProducts({ statuses: ["seeded", "verified"], introNeedsEditor: true, limit: 10 });
    expect(listed.map((p) => p.slug)).toEqual(["blank"]);
    expect(await countProducts({ statuses: ["seeded", "verified"], introNeedsEditor: true })).toBe(1);

    await db.update(products).set({ tagline: "Book a table at our cafe" }).where(eq(products.id, id));
    expect(await countProducts({ statuses: ["seeded", "verified"], introNeedsEditor: true })).toBe(0);
  });

  it("소개가 바뀌면 다시 본다", async () => {
    const id = await seed("planner", "Plan meals for the week");
    const run = cli(() => ({ verdict: "ok" }));
    await tick(run);
    expect(await check(id)).toMatchObject({ outcome: "kept", checkedTagline: "Plan meals for the week" });

    await db.update(products).set({ tagline: "Plan meals and shop for them", taglineSource: "ai_both" }).where(eq(products.id, id));
    await tick(run);
    expect(run.calls).toBe(2);
    expect(await check(id)).toMatchObject({ checkedTagline: "Plan meals and shop for them" });
  });

  it("검수하는 사이 소개가 바뀌었으면 아무것도 적지 않는다", async () => {
    const id = await seed("racing", "Create custom items for World of Warcraft");
    const run = cli(() => ({ verdict: "wrong", corrected: "Margonem 아이템을 만들어 보는 편집기" }));
    const racing: ReviewCliRun = async (args, stdin, options) => {
      await db.update(products).set({ tagline: "Written by the maker", taglineSource: "maker" }).where(eq(products.id, id));
      return run(args, stdin, options);
    };
    await tick(racing);
    expect(await product(id)).toMatchObject({ tagline: "Written by the maker", taglineSource: "maker" });
    expect(await check(id)).toBeUndefined();
  });

  it("주인 있는 것·멀쩡한 메이커 소개·사람이 쓴 소개·내린 것은 부르지 않는다", async () => {
    await seed("claimed", "Plan meals", { claimedAt: new Date() });
    await seed("maker", "Plan meals for the whole family every week", { taglineSource: "maker" });
    await seed("editor", "Plan meals", { taglineSource: "editor" });
    await seed("banned", "Plan meals", { status: "banned" });
    await seed("skill", "Plan meals", { source: "skill" });
    const run = cli(() => ({ verdict: "ok" }));
    await tick(run);
    expect(run.calls).toBe(0);
  });

  it("한도에 걸리면 이번 틱을 접고 30분 쉰다 — 실패로 세지 않는다. 답이 빠진 제품은 실패로 센다", async () => {
    const limited = await seed("limited", "Plan meals");
    const limit = Object.assign(async () => ({ kind: "exit" as const, code: 1, stderr: "",
      stdout: JSON.stringify({ is_error: true, result: "Claude AI usage limit reached" }) }), {});
    expect(await tick(limit)).toMatchObject({ status: "completed", done: true });
    const row = await check(limited);
    expect(row).toMatchObject({ errorCode: "rate_limited", attempts: 0, outcome: null });
    const [{ minutes }] = await db.execute(sql`select extract(epoch from ${row.retryAt!.toISOString()}::timestamp - now()) / 60 as minutes`) as unknown as { minutes: number }[];
    expect(Number(minutes)).toBeGreaterThan(20);

    const skipped = await seed("skipped", "Order coffee ahead");
    await tick(cli((slug) => slug === "skipped" ? undefined : { verdict: "ok" }));
    expect(await check(skipped)).toMatchObject({ errorCode: "missing_result", attempts: 1, outcome: null });
  });
});
