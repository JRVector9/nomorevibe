import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const { db } = await import("@/lib/db");
const { newsItems } = await import("@/lib/db/schema");
const { listPublicNews, publicNewsCountsByVendor } = await import("@/lib/news/repository");
const { GET: rss } = await import("@/app/news/feed.xml/route");
const { GET: json } = await import("@/app/news/feed.json/route");
const { ensureSchema } = await import("./setup");

type State = "approved" | "pending" | "hidden";
async function put(sourceKey: string, title: string, at: string, state: State = "approved") {
  await db.insert(newsItems).values({
    sourceKey, url: `https://example.com/${sourceKey}/${encodeURIComponent(title)}`, title, summary: `${title} 요약 <b>&</b>`,
    publishedAt: new Date(at), state, decidedBy: "auto",
  });
}
const call = (route: typeof rss, path: string) => route(new Request(`http://localhost:3000${path}`), { params: Promise.resolve({}) });

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(newsItems);
  await put("openai", "GPT-6", "2026-09-10T10:00:00Z");
  await put("google-deepmind", "Gemini 4", "2026-09-09T10:00:00Z");
  await put("claude-code", "Claude Code 2.1.268", "2026-09-10T12:00:00Z");
  await put("openai", "대기 중인 글", "2026-09-10T11:00:00Z", "pending");
  await put("openai", "숨긴 글", "2026-09-10T11:30:00Z", "hidden");
});

describe("공개 소식", () => {
  it("공개 글만 최신부터 보여 준다 — 대기·숨김은 빠진다", async () => {
    const { items, hasMore } = await listPublicNews({}, 10);
    expect(items.map((item) => item.title)).toEqual(["Claude Code 2.1.268", "GPT-6", "Gemini 4"]);
    expect(hasMore).toBe(false);
  });

  it("회사·종류로 거르고, 쪽을 넘긴다", async () => {
    expect((await listPublicNews({ vendor: "OpenAI" }, 10)).items.map((item) => item.title)).toEqual(["GPT-6"]);
    expect((await listPublicNews({ section: "release" }, 10)).items.map((item) => item.title)).toEqual(["Claude Code 2.1.268"]);
    const first = await listPublicNews({}, 2);
    const second = await listPublicNews({}, 2, 2);
    expect([first.hasMore, second.hasMore]).toEqual([true, false]);
    expect(second.items.map((item) => item.title)).toEqual(["Gemini 4"]);
  });

  it("회사별 수는 공개 글만 센다", async () => {
    expect(Object.fromEntries(await publicNewsCountsByVendor())).toEqual({ OpenAI: 1, Google: 1, Anthropic: 1 });
    expect(Object.fromEntries(await publicNewsCountsByVendor("news"))).toEqual({ OpenAI: 1, Google: 1 });
  });
});

describe("외부로 내보내는 피드", () => {
  it("RSS 는 유효한 XML 이고 공개 글만, 원문 링크와 출처를 싣는다", async () => {
    const res = await call(rss, "/news/feed.xml");
    const body = await res.text();
    expect(XMLValidator.validate(body)).toBe(true);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const channel = new XMLParser({ ignoreAttributes: false }).parse(body).rss.channel;
    type Item = { title: string; link: string; description: string; source: { "#text": string } };
    const items = channel.item as Item[];
    expect(items.map((item) => item.title)).toEqual(["Claude Code 2.1.268", "GPT-6", "Gemini 4"]);
    expect(items[1]).toMatchObject({ link: "https://example.com/openai/GPT-6", source: { "#text": "OpenAI" } });
    // 요약의 <b>와 &는 글자로 남아야 한다 — 이스케이프가 깨지면 피드 전체가 안 읽힌다
    expect(items[1].description).toBe("GPT-6 요약 <b>&</b>");
  });

  it("거르기를 받는다 — 페이지 주소의 조건을 그대로 옮겨 구독한다", async () => {
    const channel = new XMLParser({ ignoreAttributes: false }).parse(await (await call(rss, "/news/feed.xml?kind=news&company=google")).text()).rss.channel;
    expect(channel.item.title).toBe("Gemini 4");
    expect(channel["atom:link"]["@_href"]).toMatch(/\/news\/feed\.xml\?kind=news&company=google$/);
  });

  it("JSON Feed 1.1 로도 준다", async () => {
    const res = await call(json, "/news/feed.json?kind=release");
    expect(res.headers.get("content-type")).toContain("application/feed+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const feed = await res.json();
    expect(feed.version).toBe("https://jsonfeed.org/version/1.1");
    expect(feed.items).toEqual([expect.objectContaining({
      id: "https://example.com/claude-code/Claude%20Code%202.1.268",
      title: "Claude Code 2.1.268",
      date_published: "2026-09-10T12:00:00.000Z",
      _nomorevibe: { source: "Claude Code", vendor: "Anthropic", kind: "release" },
    })]);
  });
});
