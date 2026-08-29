import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const repo = await import("@/lib/domain/products/repository");
const { siteOrigin } = await import("@/lib/site");
const { GET: feed } = await import("@/app/feed.xml/route");
const { default: sitemap } = await import("@/app/sitemap");
const { ensureSchema, resetTables } = await import("./setup");

/**
 * 밖으로 나가는 두 문 — 검색엔진의 sitemap과 구독자의 RSS.
 *
 * 둘은 담는 것이 다르다. sitemap은 검증된 제품만이다(상세 페이지가 나머지를 noindex로 두므로).
 * 피드는 홈의 발견 보드처럼 우리가 대신 올린 것도 싣되 제목에 어느 쪽인지 적는다.
 */
async function product(over: {
  slug: string;
  status: "verified" | "seeded";
  name?: string;
  tagline?: string;
  at?: Date;
}) {
  const verified = over.status === "verified";
  await repo.insert({
    slug: over.slug,
    url: `https://${over.slug}.test`,
    name: over.name ?? over.slug,
    tagline: over.tagline ?? `${over.slug} 소개 <b>&</b>`,
    description: "설명",
    category: "Dev",
    stack: [],
    status: over.status,
    source: verified ? "skill" : "crawler",
    verifyToken: `nmv_verify_${over.slug}`,
    verifiedAt: verified ? (over.at ?? new Date()) : null,
    ...(over.at ? { createdAt: over.at, updatedAt: over.at } : {}),
    editTokenHash: "x".repeat(64),
  });
}

const FEED_REQUEST = new Request("http://localhost:3000/feed.xml");

function request() {
  return feed(FEED_REQUEST, { params: Promise.resolve({}) });
}

/**
 * XML 1.0이 글자로 인정하는 제어문자는 이 셋뿐이다.
 * 소스에 제어문자를 그대로 적지 않으려고 코드로 만든다.
 */
const ALLOWED_CONTROLS = String.fromCharCode(9, 10, 13);
const BACKSPACE = String.fromCharCode(8);

function illegalControls(xml: string): string[] {
  return [...xml].filter((c) => c.codePointAt(0)! < 0x20 && !ALLOWED_CONTROLS.includes(c));
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

    const res = await request();
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await res.text());

    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    type Item = { title: string; link: string; description: string };
    const raw = parsed.rss.channel.item as Item | Item[];
    const items = Array.isArray(raw) ? raw : [raw];
    expect(items.map((i) => i.title).sort()).toEqual(["Found — 미클레임", "Mine — ✓ 검증됨"]);
    // origin은 NEXT_PUBLIC_SITE_URL이 무엇이냐에 달렸다 — 경로만 본다
    expect(items.map((i) => new URL(i.link).pathname).sort()).toEqual(["/p/found", "/p/mine"]);
    // 태그라인의 <b>와 &는 글자로 남아야 한다 — 이스케이프가 깨지면 피드 전체가 안 읽힌다
    expect(items.find((i) => i.title.startsWith("Mine"))?.description).toBe("mine 소개 <b>&</b>");
  });

  it("비어 있어도 유효한 피드를 준다", async () => {
    const res = await request();
    const parsed = new XMLParser().parse(await res.text());
    expect(parsed.rss.channel.title).toContain("NoMoreVibe");
  });

  /**
   * 관대한 파서는 `<guid isPermaLink>`를 읽어내지만 그것은 XML이 아니다.
   * 엄격한 리더는 항목 하나가 아니라 문서 전체를 버린다.
   */
  it("값 없는 속성을 만들지 않는다 — 엄격한 파서가 문서를 받아야 한다", async () => {
    await product({ slug: "mine", status: "verified", name: "Mine" });

    const xml = await (await request()).text();

    expect(xml).toContain(`<guid isPermaLink="true">`);
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  /**
   * 수집한 텍스트에는 제어문자가 섞여 들어온다 — og:description의 `&#8;` 같은 참조가
   * lib/net/normalize.ts를 그대로 통과한다. 제품 하나가 피드 전체를 못 읽게 만들면 안 된다.
   */
  it("XML이 글자로 인정하지 않는 제어문자를 실어 보내지 않는다", async () => {
    await product({
      slug: "ctrl",
      status: "seeded",
      name: `Ctrl${BACKSPACE}Name`,
      tagline: `한 줄${BACKSPACE} 소개`,
    });

    const xml = await (await request()).text();

    expect(illegalControls(xml)).toEqual([]);
    expect(XMLValidator.validate(xml)).toBe(true);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    expect(parsed.rss.channel.item.title).toBe("CtrlName — 미클레임");
    expect(parsed.rss.channel.item.description).toBe("한 줄 소개");
  });

  /**
   * 문서 전체를 글자 하나까지 고정한다.
   *
   * 피드는 발견 보드와 같은 목록을 내지만 지표는 쓰지 않으므로 지표 없는 조회로 읽는다.
   * 그 교체가 출력을 한 글자도 바꾸지 않았음을 여기서 잡는다.
   */
  it("고정된 입력에 대해 정해진 문서를 낸다", async () => {
    await product({
      slug: "golden",
      status: "verified",
      name: "Golden",
      tagline: "한 줄 소개",
      at: new Date("2026-01-02T03:04:05Z"),
    });

    const xml = await (await request()).text();

    // origin은 라우트와 같은 곳에서 얻는다 — 여기서 재는 것은 문서의 모양이지 주소가 아니다
    const origin = siteOrigin(FEED_REQUEST);
    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>NoMoreVibe — 새로 등재된 제품</title>
    <link>${origin}/</link>
    <description>AI로 만들어 배포된 제품. 도메인 소유권을 우리가 직접 확인한 것에만 ✓ 검증됨이 붙습니다.</description>
    <language>ko</language>
    <atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml"/>
    <lastBuildDate>Fri, 02 Jan 2026 03:04:05 GMT</lastBuildDate>
    <item>
      <title>Golden — ✓ 검증됨</title>
      <link>${origin}/p/golden</link>
      <guid isPermaLink="true">${origin}/p/golden</guid>
      <description>한 줄 소개</description>
      <category>Dev</category>
      <pubDate>Fri, 02 Jan 2026 03:04:05 GMT</pubDate>
    </item>
  </channel>
</rss>
`,
    );
  });
});
