import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const repo = await import("@/lib/domain/products/repository");
const { GET } = await import("@/app/badge/[slug]/route");
const { ensureSchema, resetTables } = await import("./setup");

async function product(slug: string, status: "verified" | "seeded" | "banned") {
  await repo.insert({
    slug,
    url: `https://${slug}.test`,
    name: slug,
    tagline: "소개",
    description: "설명",
    category: "Dev",
    stack: [],
    status,
    source: status === "seeded" ? "crawler" : "skill",
    verifyToken: `nmv_verify_${slug}`,
    verifiedAt: status === "verified" ? new Date() : null,
    editTokenHash: "x".repeat(64),
  });
}

const badge = (slug: string) =>
  GET(new Request(`http://localhost:3000/badge/${slug}`), { params: Promise.resolve({ slug }) });

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("배지", () => {
  it("검증된 제품에는 SVG를 내준다 — .svg를 붙여 불러도 된다", async () => {
    await product("mine", "verified");

    const res = await badge("mine.svg");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const svg = await res.text();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("NoMoreVibe");
    expect(svg).toContain("verified");
  });

  it("검증되지 않은 제품에는 내주지 않는다 — 배지가 없는 것이 곧 정보다", async () => {
    await product("found", "seeded");
    await product("gone", "banned");

    expect((await badge("found")).status).toBe(404);
    expect((await badge("gone")).status).toBe(404);
    expect((await badge("nobody")).status).toBe(404);
  });
});
