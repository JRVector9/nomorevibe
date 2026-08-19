import { describe, expect, it } from "vitest";
import {
  discoverFeedUrls,
  feedUpdateCandidates,
  fetchFeedEvidence,
  parseFeed,
  sanitizeExternalSummary,
} from "@/lib/domain/evidence/providers/feeds";
import type { CappedFetchResult } from "@/lib/net/fetch";

describe("feed discovery", () => {
  it("discovers bounded RSS/Atom alternate links from product-controlled HTML", () => {
    const html = `
      <link rel="alternate" type="application/rss+xml" href="/updates.xml">
      <link href="https://product.example/atom.xml" type="application/atom+xml" rel="alternate">
      <link rel="stylesheet" href="/style.css">
    `;
    expect(discoverFeedUrls(html, "https://product.example/docs")).toEqual([
      "https://product.example/updates.xml",
      "https://product.example/atom.xml",
    ]);
  });

  it("ignores unsafe protocols and private feed targets", () => {
    expect(discoverFeedUrls(`
      <link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">
      <link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/feed">
    `, "https://product.example")).toEqual([]);
  });
});

describe("RSS and Atom parsing", () => {
  it("normalizes and caps RSS items", () => {
    const items = Array.from({ length: 25 }, (_, index) => `
      <item>
        <title>Version 1.${index}.0</title>
        <link>https://product.example/releases/v1.${index}.0</link>
        <description><![CDATA[<p>Shipped <b>${index}</b></p>]]></description>
        <pubDate>Wed, ${String((index % 20) + 1).padStart(2, "0")} Aug 2026 00:00:00 GMT</pubDate>
        <guid>release-${index}</guid>
      </item>
    `).join("");
    const parsed = parseFeed(`<rss version="2.0"><channel>${items}</channel></rss>`, "https://product.example/feed.xml");
    expect(parsed).toHaveLength(20);
    expect(parsed[0]).toMatchObject({
      title: "Version 1.0.0",
      canonicalUrl: "https://product.example/releases/v1.0.0",
      summary: "Shipped 0",
      externalId: "release-0",
    });
  });

  it("normalizes Atom entries and resolves relative links", () => {
    const parsed = parseFeed(`
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>v2.1.0 released</title>
          <link rel="alternate" href="/releases/v2.1.0"/>
          <summary type="html">&lt;p&gt;Faster &lt;strong&gt;viewer&lt;/strong&gt;&lt;/p&gt;</summary>
          <id>tag:product.example,2026:v2.1.0</id>
          <updated>2026-08-19T01:02:03Z</updated>
        </entry>
      </feed>
    `, "https://product.example/feed.atom");
    expect(parsed).toEqual([expect.objectContaining({
      title: "v2.1.0 released",
      canonicalUrl: "https://product.example/releases/v2.1.0",
      summary: "Faster viewer",
      externalId: "tag:product.example,2026:v2.1.0",
      publishedAt: new Date("2026-08-19T01:02:03Z"),
    })]);
  });

  it("accepts Atom text constructs with attributes and converts them to bounded update candidates", () => {
    const items = parseFeed(`
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title type="text">Version 3.0.0</title>
          <link href="https://product.example/releases/v3.0.0"/>
          <id>release-v3</id>
          <updated>2026-08-19T02:00:00Z</updated>
        </entry>
      </feed>
    `, "https://product.example/feed.atom");
    const candidates = feedUpdateCandidates(items, new Date("2026-08-19T03:00:00Z"));
    expect(candidates).toEqual([expect.objectContaining({
      sourceKind: "feed",
      title: "Version 3.0.0",
      dedupeKey: "feed:release-v3",
      canonicalUrl: "https://product.example/releases/v3.0.0",
    })]);
  });

  it("fetches XML through the capped request boundary", async () => {
    const result: CappedFetchResult = {
      ok: true,
      status: 200,
      finalUrl: "https://product.example/feed.xml",
      headers: new Headers({ "content-type": "application/rss+xml" }),
      body: Buffer.from("<rss><channel><item><title>v1.0.0</title></item></channel></rss>"),
    };
    const fetched = await fetchFeedEvidence("https://product.example/feed.xml", async () => result);
    expect(fetched).toEqual({
      finalUrl: "https://product.example/feed.xml",
      items: [expect.objectContaining({ title: "v1.0.0" })],
    });
  });

  it("rejects malformed, oversized, and entity-bearing XML", () => {
    expect(() => parseFeed("<rss><channel><item></rss>", "https://product.example/feed.xml")).toThrow("malformed feed");
    expect(() => parseFeed(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss/>`, "https://product.example/feed.xml"))
      .toThrow("unsafe feed XML");
    expect(() => parseFeed(`<rss>${"x".repeat(600_000)}</rss>`, "https://product.example/feed.xml"))
      .toThrow("feed too large");
  });

  it("removes scripts, forms, event attributes, raw HTML, and unsafe links from summaries", () => {
    expect(sanitizeExternalSummary(`
      <p onclick="steal()">Safe <a href="javascript:steal()">label</a></p>
      <script>alert(1)</script><form><input value="secret"></form>
    `)).toBe("Safe label");
    expect(() => sanitizeExternalSummary("Broken &#99999999; entity")).not.toThrow();
    expect(sanitizeExternalSummary("Safe &amp;lt;img src=x onerror=steal()&amp;gt;"))
      .toBe("Safe");
  });
});
