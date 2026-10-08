import { beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { productHealth, products, type ProductStatus } from "@/lib/db/schema";
import { countProducts, countProductsByFilter, listProducts } from "@/lib/domain/products/repository";
import { DOWN_THRESHOLD, downProductCount } from "@/lib/domain/products/health";
import { PRODUCT_FILTERS } from "@/app/admin/products/filters";
import { ensureSchema, resetTables } from "./setup";

/**
 * 어드민 제품 관리 — 찾기(이름·slug·URL·저장소), 응답 없음 거르기, 거르기 칩 수(2026-10-08 감사 ADM-03·ADM-05).
 */
beforeAll(ensureSchema);
beforeEach(resetTables);

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
async function product(slug: string, over: { name?: string; url?: string; repoUrl?: string | null; status?: ProductStatus } = {}) {
  await db.insert(products).values({
    slug, url: over.url ?? `https://${slug}.example`, name: over.name ?? slug, tagline: "t", description: "d",
    category: "Dev", status: over.status ?? "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    repoUrl: over.repoUrl ?? null, createdAt: daysAgo(3),
  });
}

it("응답 없음 거르기는 운영센터의 응답 없는 공개 제품 수와 같은 식이다", async () => {
  await product("gone");
  await product("flaky");
  await product("fresh-fail");
  await product("banned-down", { status: "banned" });
  await product("alive");
  await db.insert(productHealth).values([
    { slug: "gone", status: 0, failures: DOWN_THRESHOLD + 2, downSince: daysAgo(2) },
    { slug: "flaky", status: 503, failures: DOWN_THRESHOLD - 1, downSince: daysAgo(1) },
    // 실패 수만 넘고 죽기 시작한 시각이 없는 행은 운영센터도 세지 않는다
    { slug: "fresh-fail", status: 0, failures: DOWN_THRESHOLD, downSince: null },
    { slug: "banned-down", status: 0, failures: DOWN_THRESHOLD, downSince: daysAgo(4) },
    { slug: "alive", status: 200, failures: 0, downSince: null },
  ]);
  const filter = PRODUCT_FILTERS["응답 없음"];
  const listed = await listProducts({ ...filter, limit: 25 });
  expect(listed.map((row) => row.slug)).toEqual(["gone"]);
  expect(await countProducts(filter)).toBe(await downProductCount());
});

it("찾기는 이름·slug·URL·저장소 URL 을 대소문자 없이 보고, % _ 는 글자 그대로다", async () => {
  await product("timer-app", { name: "Pomodoro Timer" });
  await product("notes", { url: "https://NOTES.example/app" });
  await product("cli-tool", { repoUrl: "https://github.com/Acme/Widget_CLI" });
  await product("percent", { name: "100% Uptime" });
  await product("other", { name: "Other" });
  const find = async (adminSearch: string) => (await listProducts({ ...PRODUCT_FILTERS["전체"], adminSearch, limit: 25 })).map((row) => row.slug).sort();
  expect(await find("  pomodoro ")).toEqual(["timer-app"]);
  expect(await find("TIMER-APP")).toEqual(["timer-app"]);
  expect(await find("notes.example")).toEqual(["notes"]);
  expect(await find("acme/widget")).toEqual(["cli-tool"]);
  expect(await find("100%")).toEqual(["percent"]);
  // _ 는 글자 그대로 — 아무 글자 하나로 쓰이면 "cli-tool"의 i-t 가 걸린다
  expect(await find("t_c")).toEqual(["cli-tool"]);
  expect(await find("i_t")).toEqual([]);
  expect(await countProducts({ ...PRODUCT_FILTERS["전체"], adminSearch: "example" })).toBe(5);
});

it("거르기 칩 수는 한 번의 집계로, 칩을 누른 목록의 수와 같다 — 찾는 글자가 있으면 그 안에서 센다", async () => {
  await product("v1", { status: "verified", name: "Alpha" });
  await product("s1", { name: "Alpha Two" });
  await product("s2", { name: "Beta" });
  await product("b1", { status: "banned", name: "Alpha Banned" });
  await db.insert(productHealth).values({ slug: "s2", status: 0, failures: DOWN_THRESHOLD, downSince: daysAgo(1) });
  const counts = await countProductsByFilter(PRODUCT_FILTERS);
  for (const [name, filter] of Object.entries(PRODUCT_FILTERS)) expect(counts[name as keyof typeof counts], name).toBe(await countProducts(filter));
  expect(counts).toMatchObject({ 전체: 4, 검증됨: 1, 미클레임: 2, 차단됨: 1, "응답 없음": 1 });
  const searched = await countProductsByFilter(PRODUCT_FILTERS, "alpha");
  expect(searched).toMatchObject({ 전체: 3, 검증됨: 1, 미클레임: 1, 차단됨: 1, "응답 없음": 0 });
});
