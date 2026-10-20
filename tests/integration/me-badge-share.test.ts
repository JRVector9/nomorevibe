import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productKoreanTaglines, products } from "@/lib/db/schema";
import { productReactions } from "@/lib/db/me-schema";
import { clearAllMemos } from "@/lib/cache/memo";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const ORIGIN = "https://nomorevibe.example";
const badge = async (slug: string, query = "") => (await import("@/app/badge/[slug]/route")).GET(
  new Request(`${ORIGIN}/badge/${slug}${query}`), { params: Promise.resolve({ slug }) });
const card = async (locale: string, slug: string) => (await import("@/app/(public)/[locale]/(content)/p/[slug]/share-card.png/route")).GET(
  new Request(`${ORIGIN}/${locale}/p/${slug}/share-card.png`), { params: Promise.resolve({ locale, slug }) });

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  await resetTables();
  await db.execute(sql`TRUNCATE product_reactions RESTART IDENTITY CASCADE`);
  clearAllMemos();
  // 공유 카드 글꼴(Google Fonts)은 부르지 않는다 — 받지 못하면 기본 글꼴로 그린다
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network disabled in tests"); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function product(slug: string, status: "seeded" | "verified" | "unverified" | "banned", values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "Turns plain words into cron", description: "Test", category: "Dev", status,
    verifyToken: `${slug}-token`, editTokenHash: `${slug}-hash`, ...values,
  }).returning();
  return row;
}
async function reactions(productId: number, count: number, excluded = 0) {
  for (let index = 0; index < count + excluded; index += 1) {
    await db.insert(productReactions).values({ productId, visitorHash: index.toString(16).padStart(64, "0"), verdict: "good", source: "panel", locale: "ko", rankingExcluded: index >= count });
  }
}

describe("GET /badge/<slug>.svg", () => {
  it("검증 제품은 그대로 ✓ verified, 그 밖의 공개 제품은 listed, 내려간·없는 제품은 404", async () => {
    await product("checked", "verified");
    await product("tiny-cron", "seeded");
    await product("gone", "banned");
    const verified = await badge("checked.svg");
    expect(verified.status).toBe(200);
    expect(await verified.text()).toContain("✓ verified");
    expect(verified.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(verified.headers.get("cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
    expect(verified.headers.get("cache-tag")).toBe("p-checked");
    const listed = await badge("tiny-cron.svg");
    expect(listed.status).toBe(200);
    expect(await listed.text()).toContain(">listed</text>");
    expect(await (await badge("tiny-cron.svg", "?lang=ko")).text()).toContain(">소개됨</text>");
    for (const slug of ["gone.svg", "missing.svg", "Tiny-Cron.svg"]) expect((await badge(slug)).status, slug).toBe(404);
  });

  it("검증 전(unverified) 등록은 배지도 공유 카드도 404 — 누구나 아무 주소로 등록하므로 «listed» 를 내주면 피싱에 쓰인다", async () => {
    await product("phish-wallet", "unverified", { name: "MetaMask Wallet", url: "https://phish.example" });
    for (const query of ["", "?style=tried", "?lang=ko"]) expect((await badge("phish-wallet.svg", query)).status, query).toBe(404);
    expect((await card("ko", "phish-wallet")).status).toBe(404);
    expect((await card("en", "phish-wallet")).status).toBe(404);
    const { shareCardData } = await import("@/lib/me/share");
    expect(await shareCardData("phish-wallet", "ko")).toBeNull();
  });

  it("?style=tried 는 써본 사람 3명부터 숫자, 그 전에는 기본 배지", async () => {
    const seeded = await product("tiny-cron", "seeded");
    const verified = await product("checked", "verified");
    await reactions(seeded.id, 2, 3);
    expect(await (await badge("tiny-cron.svg", "?style=tried")).text()).toContain(">listed</text>");
    await reactions(verified.id, 1_234);
    clearAllMemos();
    expect(await (await badge("checked.svg", "?style=tried")).text()).toContain(">tried by 1,234</text>");
    expect(await (await badge("checked.svg", "?style=tried&lang=ko")).text()).toContain(">써본 사람 1,234</text>");
    expect(await (await badge("checked.svg")).text()).toContain("✓ verified");
  });
});

describe("GET /p/<slug>/share-card.png", () => {
  it("공개 제품은 1200×630 PNG, 내려간·없는 제품·모르는 언어는 404", async () => {
    await product("tiny-cron", "seeded", { stars: 214 });
    await product("gone", "banned");
    // 글꼴은 저장소 파일이다 — 그리는 동안 네트워크를 부르지 않는다
    const network = vi.spyOn(globalThis, "fetch");
    const response = await card("ko", "tiny-cron");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-tag")).toBe("p-tiny-cron");
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
    const png = Buffer.from(await response.arrayBuffer());
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect((await card("en", "tiny-cron")).status).toBe(200);
    expect((await card("zh-Hant", "tiny-cron")).status).toBe(200);
    // next/og 는 렌더러 wasm 을 data: 주소로 읽는다 — 밖(http·https)으로 나간 요청만 센다
    expect(network.mock.calls.map(([url]) => String(url)).filter((url) => /^https?:/.test(url))).toEqual([]);
    network.mockRestore();
    expect((await card("ko", "gone")).status).toBe(404);
    expect((await card("ko", "missing")).status).toBe(404);
    expect((await card("fr", "tiny-cron")).status).toBe(404);
  }, 60_000);

  it("카드 글은 그 언어의 한 줄 소개와 사실 칩(스타·써본 사람·분야)", async () => {
    const seeded = await product("tiny-cron", "seeded", { stars: 1_563 });
    await db.insert(productKoreanTaglines).values({ productId: seeded.id, sourceTagline: seeded.tagline, taglineKo: "자연어 일정을 cron 식으로" });
    await reactions(seeded.id, 12);
    const { shareCardData } = await import("@/lib/me/share");
    const ko = await shareCardData("tiny-cron", "ko", new Date("2026-10-20T03:00:00Z"));
    expect(ko).toMatchObject({ name: "tiny-cron", tagline: "자연어 일정을 cron 식으로", url: "nomorevibe.example/p/tiny-cron", date: "2026-10-20 기준" });
    expect(ko!.chips.map((chip) => chip.text)).toEqual(["GitHub ★ 1,563", "써본 사람 12", "개발 도구"]);
    const en = await shareCardData("tiny-cron", "en", new Date("2026-10-20T03:00:00Z"));
    expect(en).toMatchObject({ tagline: "Turns plain words into cron", date: "as of 2026-10-20" });
    expect(await shareCardData("missing", "ko")).toBeNull();
  });
});
