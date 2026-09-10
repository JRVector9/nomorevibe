import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const { db } = await import("@/lib/db");
const { crawlSettings, jobs, newsItems } = await import("@/lib/db/schema");
const { saveSettings } = await import("@/lib/crawl/settings");
const { refreshNews } = await import("@/lib/news/refresh");
const { listHomeNews, setNewsState } = await import("@/lib/news/repository");
const { NEWS_SOURCE_KEYS } = await import("@/lib/news/sources");
const { ensureSchema } = await import("./setup");

type NewsCursor = import("@/lib/news/refresh").NewsCursor;
type Result = import("@/lib/net/fetch").CappedFetchResult;

const ok = (url: string, body: string): Result => ({ ok: true, status: 200, finalUrl: url, headers: new Headers(), body: Buffer.from(body) });
const missing: Result = { ok: false, reason: "http", status: 404 };
const rss = (items: { title: string; link: string; date: string }[]) =>
  `<rss><channel>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date}</pubDate></item>`).join("")}</channel></rss>`;
const atom = (repo: string, tags: string[]) =>
  `<feed xmlns="http://www.w3.org/2005/Atom">${tags.map((tag) => `<entry><id>${tag}</id><title>${tag}</title><updated>2026-09-10T10:00:00Z</updated><link rel="alternate" href="https://github.com/${repo}/releases/tag/${tag}"/></entry>`).join("")}</feed>`;

/** 출처 주소 → 응답. 없는 주소는 404 */
function serve(pages: Record<string, string>) {
  const asked: string[] = [];
  const request = async (url: string) => {
    asked.push(url);
    return pages[url] === undefined ? missing : ok(url, pages[url]);
  };
  return { request, asked };
}

const context = (cursor: NewsCursor | null = null) => ({
  cursor, save: async () => {}, hasBudget: () => true, log: () => {},
});

async function only(keys: string[], autoApprove = true) {
  const result = await saveSettings({ news: { autoApprove, disabledSources: NEWS_SOURCE_KEYS.filter((key) => !keys.includes(key)) } }, "테스트");
  if (!result.ok) throw new Error(result.issues.join(", "));
}

const OPENAI = "https://openai.com/news/rss.xml";
const DEEPMIND = "https://deepmind.google/blog/rss.xml";
const GEMINI = "https://blog.google/products-and-platforms/products/gemini/rss/";
const CLAUDE_CODE = "https://github.com/anthropics/claude-code/releases.atom";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(newsItems);
  await db.delete(crawlSettings);
  await db.delete(jobs);
});

describe("AI 소식 수집", () => {
  it("기본값은 자동 승인이다 — 새 글이 곧바로 홈에 오른다", async () => {
    await saveSettings({}, "테스트");
    await only(["openai"]);
    const { request } = serve({ [OPENAI]: rss([{ title: "GPT-6", link: "https://openai.com/index/gpt-6", date: "Wed, 09 Sep 2026 10:00:00 GMT" }]) });

    const outcome = await refreshNews(context(), request);

    expect(outcome.cursor?.sources.openai).toMatchObject({ ok: true, found: 1, added: 1 });
    expect(await db.select({ state: newsItems.state, decidedBy: newsItems.decidedBy }).from(newsItems)).toEqual([{ state: "approved", decidedBy: "auto" }]);
    expect((await listHomeNews()).map((news) => news.title)).toEqual(["GPT-6"]);
  });

  it("자동 승인을 끄면 새 글은 승인 대기로 들어가 홈에 오르지 않는다", async () => {
    await only(["openai"], false);
    const { request } = serve({ [OPENAI]: rss([{ title: "GPT-6", link: "https://openai.com/index/gpt-6", date: "Wed, 09 Sep 2026 10:00:00 GMT" }]) });

    await refreshNews(context(), request);

    expect(await db.select({ state: newsItems.state }).from(newsItems)).toEqual([{ state: "pending" }]);
    expect(await listHomeNews()).toEqual([]);
  });

  it("관리자가 숨긴 글은 다시 수집돼도 되살아나지 않는다", async () => {
    await only(["openai"]);
    const { request } = serve({ [OPENAI]: rss([{ title: "GPT-6", link: "https://openai.com/index/gpt-6", date: "Wed, 09 Sep 2026 10:00:00 GMT" }]) });
    const first = await refreshNews(context(), request);
    const [row] = await db.select({ id: newsItems.id }).from(newsItems);
    await setNewsState([row.id], "hidden", "admin");

    const second = await refreshNews(context(first.cursor ?? null), request);

    expect(second.cursor?.sources.openai).toMatchObject({ found: 1, added: 0 });
    expect(await db.select({ state: newsItems.state, decidedBy: newsItems.decidedBy }).from(newsItems)).toEqual([{ state: "hidden", decidedBy: "admin" }]);
  });

  it("한 출처가 실패해도 나머지는 모으고, 실패는 출처별로 남긴다", async () => {
    await only(["openai", "google-deepmind"]);
    const { request } = serve({ [DEEPMIND]: rss([{ title: "Gemini 4", link: "https://deepmind.google/blog/gemini-4", date: "Wed, 09 Sep 2026 10:00:00 GMT" }]) });

    const outcome = await refreshNews(context(), request);

    expect(outcome.done).toBe(true);
    expect(outcome.cursor?.sources.openai).toMatchObject({ ok: false, error: "http_404" });
    expect(outcome.cursor?.sources["google-deepmind"]).toMatchObject({ ok: true, added: 1 });
  });

  it("끈 출처는 요청하지 않는다", async () => {
    await only(["google-deepmind"]);
    const { request, asked } = serve({});

    await refreshNews(context(), request);

    expect(asked).toEqual([DEEPMIND]);
  });

  it("사이트맵 출처는 기준선을 잡고, 그 뒤에 생긴 글만 새 글로 연다", async () => {
    await only(["anthropic"]);
    const sitemap = (paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>https://www.anthropic.com${p}</loc></url>`).join("")}</urlset>`;
    const before = serve({ "https://www.anthropic.com/sitemap.xml": sitemap(["/news/old-a", "/news/old-b"]) });
    const baseline = await refreshNews(context(), before.request);
    expect(baseline.cursor?.sources.anthropic).toMatchObject({ ok: true, found: 0, seen: ["https://www.anthropic.com/news/old-a", "https://www.anthropic.com/news/old-b"] });
    expect(before.asked).toEqual(["https://www.anthropic.com/sitemap.xml"]);

    const after = serve({
      "https://www.anthropic.com/sitemap.xml": sitemap(["/news/old-a", "/news/old-b", "/news/claude-5"]),
      "https://www.anthropic.com/news/claude-5": `<title>Introducing Claude 5 \\ Anthropic</title>`,
    });
    const next = await refreshNews(context(baseline.cursor ?? null), after.request);

    expect(next.cursor?.sources.anthropic).toMatchObject({ found: 1, added: 1 });
    expect(next.cursor?.sources.anthropic.seen).toContain("https://www.anthropic.com/news/claude-5");
    expect(await db.select({ title: newsItems.title, url: newsItems.url }).from(newsItems))
      .toEqual([{ title: "Introducing Claude 5", url: "https://www.anthropic.com/news/claude-5" }]);
  });

  /** Google 은 출처가 셋이다. 회사 기준으로 하나만 올려야 카드를 혼자 차지하지 않는다 */
  it("홈 카드는 회사마다 최신 하나씩, 코딩 도구 릴리스는 빼고 보여 준다", async () => {
    await only(["openai", "google-deepmind", "google-gemini", "claude-code"]);
    const { request } = serve({
      [OPENAI]: rss([{ title: "OpenAI 소식", link: "https://openai.com/index/a", date: "Mon, 07 Sep 2026 10:00:00 GMT" }]),
      [DEEPMIND]: rss([{ title: "DeepMind 소식", link: "https://deepmind.google/blog/a", date: "Wed, 09 Sep 2026 10:00:00 GMT" }]),
      [GEMINI]: rss([{ title: "Gemini 소식", link: "https://blog.google/gemini-a", date: "Tue, 08 Sep 2026 10:00:00 GMT" }]),
      [CLAUDE_CODE]: atom("anthropics/claude-code", ["v2.1.268"]),
    });

    await refreshNews(context(), request);

    expect(await db.$count(newsItems)).toBe(4);
    expect((await listHomeNews()).map((news) => news.title)).toEqual(["DeepMind 소식", "OpenAI 소식"]);
  });
});
