import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const { db } = await import("@/lib/db");
const { jobs, products, productKoreanTaglines } = await import("@/lib/db/schema");
const { writeKoreanTaglines } = await import("@/lib/jobs/products/korean-tagline");
const { koreanTaglineProgress, koreanTaglineSample, pendingKoreanTaglines } = await import("@/lib/domain/products/korean-taglines");
const { getPublicList, getDiscoveryList } = await import("@/lib/domain/products/view");
const { getPopularGroups } = await import("@/lib/domain/products/popular");
const { runJob } = await import("@/lib/jobs/runner");
const { clearAllMemos } = await import("@/lib/cache/memo");
const { ensureSchema, resetTables } = await import("./setup");

let serial = 0;
async function seed(values: Partial<typeof products.$inferInsert> = {}) {
  const slug = values.slug ?? `ko-${++serial}`;
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: `A tool called ${slug}`, description: "d", category: "Dev",
    status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    createdAt: sql`now() - interval '30 days'` as unknown as Date, ...values,
  }).returning({ id: products.id, slug: products.slug });
  return row;
}

/** 게이트웨이 대신 — 받은 항목마다 answer 로 한국어 줄을 지어 배열로 돌려준다. 받은 순서를 남긴다 */
const seen: string[][] = [];
const gateway = vi.fn();
function answerWith(answer: (item: { name: string; tagline: string }) => string) {
  gateway.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const items = JSON.parse(body.messages[1].content) as { name: string; tagline: string }[];
    seen.push(items.map((item) => item.name));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(items.map(answer)) } }] }) } as unknown as Response;
  });
}
const korean = (item: { name: string }) => `${item.name} 이라는 쓸모 있는 도구`;
const tick = () => runJob("product-tagline-ko", writeKoreanTaglines);
const stored = async (id: number) => (await db.select().from(productKoreanTaglines).where(eq(productKoreanTaglines.productId, id)))[0];

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(jobs);
  clearAllMemos();
  seen.length = 0;
  gateway.mockReset();
  vi.stubEnv("ABCLLM_API_KEY", "test-key");
  vi.stubGlobal("fetch", gateway);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("한국어 한 줄 소개 잡", () => {
  it("새 제품 → 홈에 보이는 제품 → 나머지는 스타 순으로 옮긴다", async () => {
    const rest = await seed({ slug: "rest-low", stars: 10 });
    const restHigh = await seed({ slug: "rest-high", stars: 900 });
    // 홈의 인기 구간(스타 2천 이상)에 보이는 제품
    const popular = await seed({ slug: "popular", stars: 3_000, starsAt: new Date(), repoUrl: "https://github.com/acme/popular" });
    const fresh = await seed({ slug: "fresh", createdAt: sql`now() - interval '1 hour'` as unknown as Date });
    const fresher = await seed({ slug: "fresher", createdAt: sql`now() - interval '1 minute'` as unknown as Date });
    // 홈 '최신'의 앞쪽 40개 밖으로 밀어 '나머지'가 홈에 보이지 않게 한다
    for (let i = 0; i < 40; i++) await seed({ slug: `filler-${i}`, tagline: "이미 한국어로 쓴 소개", createdAt: sql`now() - interval '2 days'` as unknown as Date });

    const home = (await getPopularGroups()).flatMap((group) => group.items.map((item) => item.slug));
    expect(home).toContain("popular");
    const order = (await pendingKoreanTaglines(10, home)).map((task) => task.name);
    expect(order).toEqual(["fresher", "fresh", "popular", "rest-high", "rest-low"]);

    answerWith(korean);
    expect(await tick()).toMatchObject({ status: "completed", done: true });
    expect(seen).toEqual([["fresher", "fresh", "popular", "rest-high", "rest-low"]]);
    for (const row of [rest, restHigh, popular, fresh, fresher]) expect((await stored(row.id))?.taglineKo).toBe(`${row.slug} 이라는 쓸모 있는 도구`);
    // 인기 구간 카드도 한국어 줄을 받는다
    clearAllMemos();
    expect((await getPopularGroups()).flatMap((group) => group.items).find((item) => item.slug === "popular")?.taglineKo)
      .toBe("popular 이라는 쓸모 있는 도구");
  });

  it("이미 한국어인 소개는 옮기지 않는다", async () => {
    await seed({ slug: "hangul", tagline: "Claude Code용 MCP 서버" });
    await seed({ slug: "empty", tagline: "  " });
    expect(await pendingKoreanTaglines(10, [])).toEqual([]);
    answerWith(korean);
    await tick();
    expect(gateway).not.toHaveBeenCalled();
  });

  it("소개가 바뀌면 화면에서 옛 한국어가 빠지고 잡이 다시 옮긴다", async () => {
    const row = await seed({ slug: "changing", tagline: "Edit videos locally" });
    answerWith(() => "로컬에서 동영상을 편집하는 도구");
    await tick();
    const shown = async () => (await getPublicList(10)).find((item) => item.slug === "changing")?.taglineKo;
    expect(await shown()).toBe("로컬에서 동영상을 편집하는 도구");
    expect((await getDiscoveryList(10)).find((item) => item.slug === "changing")?.taglineKo).toBe("로컬에서 동영상을 편집하는 도구");

    await db.update(products).set({ tagline: "Merge PDF files in the browser" }).where(eq(products.id, row.id));
    expect(await shown()).toBeNull();
    expect((await pendingKoreanTaglines(10, [])).map((task) => task.productId)).toEqual([row.id]);
    answerWith(() => "브라우저에서 PDF 파일 합치기");
    await tick();
    expect(await shown()).toBe("브라우저에서 PDF 파일 합치기");
    expect(await stored(row.id)).toMatchObject({ sourceTagline: "Merge PDF files in the browser", attempts: 1, errorCode: null });
  });

  it("검사에서 버린 줄은 남기지 않고 사유를 세며, 몇 번 버리면 손을 뗀다", async () => {
    const row = await seed({ slug: "rejected", name: "Wireshark", tagline: "Wireshark is a network protocol analyzer" });
    const ok = await seed({ slug: "fine", tagline: "Track your daily habits" });
    answerWith((item) => item.name === "Wireshark" ? "와이어샤크는 네트워크 프로토콜 분석기" : "매일의 습관을 기록");
    await tick();
    expect(await stored(row.id)).toMatchObject({ taglineKo: null, errorCode: "rejected:name_lost", attempts: 1 });
    expect((await stored(ok.id))?.taglineKo).toBe("매일의 습관을 기록");
    expect(await koreanTaglineProgress()).toMatchObject({ eligible: 2, done: 1, waiting: 0, failed: 0, gaveUp: 0,
      rejected: [{ reason: "name_lost", count: 1 }] });
    expect((await koreanTaglineSample(5)).map((item) => item.slug)).toEqual(["fine"]);

    // 다시 볼 때가 되기 전에는 집지 않는다
    expect(await pendingKoreanTaglines(10, [])).toEqual([]);
    await db.update(productKoreanTaglines).set({ retryAt: null, attempts: 4 }).where(eq(productKoreanTaglines.productId, row.id));
    expect(await pendingKoreanTaglines(10, [])).toEqual([]);
    expect(await koreanTaglineProgress()).toMatchObject({ gaveUp: 1 });
  });

  it("게이트웨이 실패는 손을 떼지 않고 늘어나는 간격으로 다시 보며, 이미 옮긴 한국어를 덮지 않는다", async () => {
    const row = await seed({ slug: "gateway", tagline: "Plan your trips" });
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);
    expect(await tick()).toMatchObject({ status: "completed", done: true });
    const failed = await stored(row.id);
    expect(failed).toMatchObject({ errorCode: "http_502", taglineKo: null, attempts: 1 });
    await db.update(productKoreanTaglines).set({ retryAt: null, attempts: 9 }).where(eq(productKoreanTaglines.productId, row.id));
    expect((await pendingKoreanTaglines(10, [])).map((task) => task.productId)).toEqual([row.id]);
    expect(await koreanTaglineProgress()).toMatchObject({ failed: 1, gaveUp: 0 });

    answerWith(() => "여행 계획 세우기");
    await tick();
    expect(await stored(row.id)).toMatchObject({ taglineKo: "여행 계획 세우기", errorCode: null, attempts: 10 });
    expect(await pendingKoreanTaglines(10, [])).toEqual([]);
  });

  it("개수가 맞지 않는 답은 묶음 전체를 실패로 남긴다", async () => {
    const a = await seed({ slug: "batch-a" });
    const b = await seed({ slug: "batch-b" });
    gateway.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '["하나뿐인 줄"]' } }] }) } as unknown as Response);
    await tick();
    expect((await stored(a.id))?.errorCode).toBe("invalid_output");
    expect((await stored(b.id))?.errorCode).toBe("invalid_output");
  });

  it("키가 없으면 부르지 않는다", async () => {
    await seed({ slug: "nokey" });
    vi.stubEnv("ABCLLM_API_KEY", "");
    expect(await tick()).toMatchObject({ status: "completed", done: true });
    expect(gateway).not.toHaveBeenCalled();
  });
});
