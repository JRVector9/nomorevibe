import { describe, expect, it } from "vitest";
import type { FeedItem } from "@/lib/domain/evidence/providers/feeds";
import {
  newsCandidate,
  npmCandidates,
  pageCandidate,
  releaseCandidate,
  sitemapChanges,
  sitemapUrls,
  SITEMAP_REBASELINE_AT,
} from "@/lib/news/normalize";
import { newsSource, type NewsSource } from "@/lib/news/sources";

const NOW = new Date("2026-09-11T00:00:00Z");
const source = (key: string): NewsSource => {
  const found = newsSource(key);
  if (!found) throw new Error(`no source ${key}`);
  return found;
};
const item = (over: Partial<FeedItem>): FeedItem => ({
  title: "제목", canonicalUrl: null, link: null, summary: null, externalId: null, publishedAt: new Date("2026-09-10T00:00:00Z"), ...over,
});
const release = (repo: string, tag: string, title = tag) =>
  item({ title, canonicalUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}` });

describe("코딩 도구 릴리스", () => {
  it("버전만 적힌 제목에 도구 이름을 붙인다", () => {
    expect(releaseCandidate(source("claude-code"), release("anthropics/claude-code", "v2.1.268"), NOW)?.title).toBe("Claude Code 2.1.268");
  });

  /** 실측(2026-09-11): 최신 10건 중 정식은 1건이었다 — 나머지는 매일 밤 빌드와 미리보기 */
  it("nightly·preview 는 받지 않는다", () => {
    const gemini = source("gemini-cli");
    expect(releaseCandidate(gemini, release("google-gemini/gemini-cli", "v0.61.0-nightly.20260910.ged2ac40df"), NOW)).toBeNull();
    expect(releaseCandidate(gemini, release("google-gemini/gemini-cli", "v0.60.0-preview.0"), NOW)).toBeNull();
    expect(releaseCandidate(gemini, release("google-gemini/gemini-cli", "v0.59.0", "Release v0.59.0"), NOW)?.title).toBe("Gemini CLI 0.59.0");
  });

  /** 한 저장소가 여러 제품을 낸다. 규칙 없이 받으면 "Codex CLI · Cygwin build inputs…"가 소식이 됐다 */
  it("같은 저장소의 다른 제품 릴리스는 받지 않는다", () => {
    const codex = source("codex-cli");
    expect(releaseCandidate(codex, release("openai/codex", "rust-v0.154.0"), NOW)?.title).toBe("Codex CLI 0.154.0");
    expect(releaseCandidate(codex, release("openai/codex", "rust-v0.155.0-alpha.2"), NOW)).toBeNull();
    expect(releaseCandidate(codex, release("openai/codex", "python-v0.154.0"), NOW)).toBeNull();
    expect(releaseCandidate(codex, release("openai/codex", "voice-cygwin-108b38cf67cbb731", "Cygwin build inputs"), NOW)).toBeNull();

    const qwen = source("qwen-code");
    expect(releaseCandidate(qwen, release("QwenLM/qwen-code", "v0.23.3"), NOW)?.title).toBe("Qwen Code 0.23.3");
    expect(releaseCandidate(qwen, release("QwenLM/qwen-code", "sdk-typescript-v0.1.12"), NOW)).toBeNull();
    expect(releaseCandidate(source("kimi-cli"), release("MoonshotAI/kimi-cli", "kosong-0.56.0"), NOW)).toBeNull();
  });

  it("주소에 인코딩된 범위 태그도 읽는다", () => {
    const kimi = release("MoonshotAI/kimi-code", "@moonshot-ai/kimi-code@0.42.0", "@moonshot-ai/kimi-code@0.42.0");
    expect(kimi.canonicalUrl).toContain("%40moonshot-ai%2Fkimi-code%400.42.0");
    expect(releaseCandidate(source("kimi-code"), kimi, NOW)?.title).toBe("Kimi Code 0.42.0");
  });
});

describe("공식 발표", () => {
  /** Z.ai 릴리스 노트는 제목이 날짜뿐이고, 글마다 같은 페이지의 #날짜 앵커를 가리킨다 */
  it("날짜뿐인 제목은 본문 첫 문장으로, 앵커 주소는 앵커째로 쓴다", () => {
    const zai = newsCandidate(source("zai"), item({
      title: "2026-08-26",
      link: "https://docs.z.ai/release-notes/new-released#2026-08-26",
      summary: "Native visual capabilities enable the model to observe interfaces. Efficient hybrid architecture.",
    }), NOW);
    expect(zai).toMatchObject({
      url: "https://docs.z.ai/release-notes/new-released#2026-08-26",
      title: "Native visual capabilities enable the model to observe interfaces.",
    });
  });

  it("앵커를 뗀 주소가 공개 주소가 아니면 받지 않는다", () => {
    expect(newsCandidate(source("zai"), item({ title: "x", link: "http://127.0.0.1/notes#a" }), NOW)).toBeNull();
    expect(newsCandidate(source("zai"), item({ title: "x", link: "https://docs.z.ai/notes" }), NOW)).toBeNull();
  });

  it("앞날로 적힌 게시일은 지금으로 당긴다", () => {
    const future = newsCandidate(source("openai"), item({ canonicalUrl: "https://openai.com/index/x", publishedAt: new Date("2027-01-01T00:00:00Z") }), NOW);
    expect(future?.publishedAt).toEqual(NOW);
  });
});

describe("사이트맵 출처", () => {
  const anthropic = source("anthropic");
  const xml = (locs: string[]) => `<urlset>${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("")}</urlset>`;

  it("글 경로 아래 주소만 모은다 — 목록 페이지와 다른 호스트는 뺀다", () => {
    expect(sitemapUrls(xml([
      "https://www.anthropic.com/news/claude-5",
      "https://www.anthropic.com/news",
      "https://www.anthropic.com/engineering/harness/",
      "https://www.anthropic.com/careers/x",
      "https://evil.example/news/x",
      "https://www.anthropic.com/news/a?b=1&amp;c=2",
    ]), anthropic)).toEqual([
      "https://www.anthropic.com/news/claude-5",
      "https://www.anthropic.com/engineering/harness",
      "https://www.anthropic.com/news/a",
    ]);
  });

  /** Anthropic 은 글 400여 개에 게시일이 없다 — 첫 회차에 전부 "방금 올라온 글"이 되면 안 된다 */
  it("처음 보는 사이트맵은 기준선만 잡는다", () => {
    expect(sitemapChanges(["a", "b"], undefined)).toEqual({ fresh: [], rebaseline: true });
  });

  it("기준선 이후 새 주소만 새 글이다", () => {
    expect(sitemapChanges(["a", "b", "c"], ["a", "b"])).toEqual({ fresh: ["c"], rebaseline: false });
  });

  it("한꺼번에 많이 생기면 잘렸다 돌아온 것으로 보고 다시 기준선을 잡는다", () => {
    const back = Array.from({ length: SITEMAP_REBASELINE_AT + 1 }, (_, i) => `u${i}`);
    expect(sitemapChanges(["a", ...back], ["a"])).toEqual({ fresh: [], rebaseline: true });
  });

  it("새 글 페이지에서 제목·게시일을 읽는다", () => {
    const deepseek = pageCandidate(source("deepseek"), "https://api-docs.deepseek.com/news/news260910",
      `<head><meta property="og:title" content="DeepSeek-V4.1-Flash: Smarter, Faster | DeepSeek API Docs"></head>`, NOW);
    expect(deepseek).toMatchObject({ title: "DeepSeek-V4.1-Flash: Smarter, Faster", publishedAt: new Date("2026-09-10T00:00:00Z") });

    const dated = pageCandidate(anthropic, "https://www.anthropic.com/news/x",
      `<title>Claude 5 \\ Anthropic</title><meta property="article:published_time" content="2026-09-09T10:00:00Z">`, NOW);
    expect(dated).toMatchObject({ title: "Claude 5", publishedAt: new Date("2026-09-09T10:00:00Z") });

    const undated = pageCandidate(anthropic, "https://www.anthropic.com/news/y", `<title>Something new</title>`, NOW);
    expect(undated?.publishedAt).toEqual(NOW);
  });
});

describe("npm 배포", () => {
  it("정식 버전만 최신부터 받는다", () => {
    const grok = npmCandidates(source("grok-build"), {
      time: {
        created: "2026-01-01T00:00:00Z", modified: "2026-09-10T20:26:22Z",
        "1.0.27": "2026-09-10T03:12:47Z", "1.0.28": "2026-09-10T20:26:22Z", "1.1.0-beta.1": "2026-09-10T21:00:00Z",
      },
    }, NOW);
    expect(grok.map((entry) => [entry.title, entry.url])).toEqual([
      ["Grok Build 1.0.28", "https://www.npmjs.com/package/@xai-official/grok/v/1.0.28"],
      ["Grok Build 1.0.27", "https://www.npmjs.com/package/@xai-official/grok/v/1.0.27"],
    ]);
  });

  it("모양이 다른 문서는 비운다", () => {
    expect(npmCandidates(source("grok-build"), { versions: {} }, NOW)).toEqual([]);
  });
});
