import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { XMLParser } from "fast-xml-parser";

const repo = await import("@/lib/domain/products/repository");
const { GET: feed } = await import("@/app/feed.xml/route");
const { default: sitemap } = await import("@/app/sitemap");
const { ensureSchema, resetTables } = await import("./setup");

/**
 * 밖으로 나가는 두 문 — 검색엔진의 sitemap과 구독자의 RSS.
 *
 * 둘은 담는 것이 다르다. sitemap은 검증된 제품만이다(상세 페이지가 나머지를 noindex로 두므로).
 * 피드는 홈의 발견 보드처럼 우리가 대신 올린 것도 싣되 제목에 어느 쪽인지 적는다.
 */
async function product(over: { slug: string; status: "verified" | "seeded"; name?: string }) {
  const verified = over.status === "verified";
  await repo.insert({
    slug: over.slug,
    url: `https://${over.slug}.test`,
    name: over.name ?? over.slug,
    tagline: `${over.slug} 소개 <b>&</b>`,
    description: "설명",
    category: "Dev",
    stack: [],
    status: over.status,
    source: verified ? "skill" : "crawler",
    verifyToken: `nmv_verify_${over.slug}`,
    verifiedAt: verified ? new Date() : null,
    editTokenHash: "x".repeat(64),
  });
}

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("sitemap", () => {
  it("검증된 제품만 싣는다 — 나머지는 상세 페이지가 색인하지 말라고 한다", async () => {
    await product({ slug: "mine", status: "verified" });
    await product({ slug: "found", status: "seeded" });

    const urls = (await sitemap()).map((entry) => entry.url);

    expect(urls.some((u) => u.endsWith("/p/mine"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/p/found"))).toBe(false);
    expect(urls.some((u) => u.endsWith("/"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/launch"))).toBe(true);
  });
});

describe("feed.xml", () => {
  it("검증된 제품과 발견한 제품을 함께 싣고 제목에 어느 쪽인지 적는다", async () => {
    await product({ slug: "mine", status: "verified", name: "Mine" });
    await product({ slug: "found", status: "seeded", name: "Found" });

    const res = await feed(new Request("http://localhost:3000/feed.xml"), { params: Promise.resolve({}) });
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await res.text());

    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    type Item = { title: string; link: string; description: string };
    const raw = parsed.rss.channel.item as Item | Item[];
    const items = Array.isArray(raw) ? raw : [raw];
    expect(items.map((i) => i.title).sort()).toEqual(["Found — 미클레임", "Mine — ✓ 검증됨"]);
    expect(items.every((i) => i.link.startsWith("http://localhost:3000/p/"))).toBe(true);
    // 태그라인의 <b>와 &는 글자로 남아야 한다 — 이스케이프가 깨지면 피드 전체가 안 읽힌다
    expect(items.find((i) => i.title.startsWith("Mine"))?.description).toBe("mine 소개 <b>&</b>");
  });

  it("비어 있어도 유효한 피드를 준다", async () => {
    const res = await feed(new Request("http://localhost:3000/feed.xml"), { params: Promise.resolve({}) });
    const parsed = new XMLParser().parse(await res.text());
    expect(parsed.rss.channel.title).toContain("NoMoreVibe");
  });
});
