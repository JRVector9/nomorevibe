import { describe, expect, it } from "vitest";
import {
  meaningfulSiteFingerprint,
  normalizeUpdateCandidate,
  repositoryUpdateCandidates,
  sameMeaningfulSiteFingerprint,
  siteChangeCandidate,
} from "@/lib/domain/evidence/updates";

describe("update candidate normalization", () => {
  it("deduplicates release sources by canonical URL plus normalized version", () => {
    const observedAt = new Date("2026-08-19T00:00:00Z");
    const github = normalizeUpdateCandidate({
      sourceKind: "github_release",
      dedupeKey: "ignored-github-id",
      canonicalUrl: "https://github.com/Owner/Repo/releases/tag/v1.6.0?utm_source=rss",
      title: "Version v1.6.0",
      summary: null,
      beforeAfter: null,
      publishedAt: observedAt,
      observedAt,
    });
    const feed = normalizeUpdateCandidate({
      sourceKind: "feed",
      dedupeKey: "feed-guid",
      canonicalUrl: "https://github.com/owner/repo/releases/tag/v1.6.0",
      title: "1.6.0 released",
      summary: "<b>Release</b>",
      beforeAfter: null,
      publishedAt: observedAt,
      observedAt,
    });
    expect(feed.dedupeKey).toBe(github.dedupeKey);
    expect(feed.dedupeKey).toContain("release:");
    expect(feed.summary).toBe("Release");
  });

  it("prefers the canonical release URL version over unrelated title numbers", () => {
    const observedAt = new Date("2026-08-19T00:00:00Z");
    const base = {
      sourceKind: "feed" as const,
      dedupeKey: "feed-a",
      canonicalUrl: "https://github.com/owner/repo/releases/tag/v1.6.0",
      title: "Release v1.6.0",
      summary: null,
      beforeAfter: null,
      publishedAt: observedAt,
      observedAt,
    };
    const withRuntimeVersion = normalizeUpdateCandidate({
      ...base,
      dedupeKey: "feed-b",
      title: "Requires Node 20.1 — Release v1.6.0",
    });
    expect(withRuntimeVersion.dedupeKey).toBe(normalizeUpdateCandidate(base).dedupeKey);
  });

  it("stores only meaningful site fields and ignores whitespace/timestamps/assets", () => {
    const first = meaningfulSiteFingerprint(`
      <html><head><title>Simple HWP</title><meta name="description" content="Browser viewer"></head>
      <body><h1>Open HWP files</h1><h2>Local processing</h2><time>10:00</time><script src="app.abc.js"></script></body></html>
    `);
    const noisy = meaningfulSiteFingerprint(`
      <html><head><title> Simple   HWP </title><meta name="description" content="Browser viewer"></head>
      <body><h1> Open HWP files </h1><h2>Local processing</h2><time>11:00</time><script src="app.xyz.js"></script></body></html>
    `);
    expect(first).toEqual({
      type: "site_fingerprint",
      title: "Simple HWP",
      description: "Browser viewer",
      headings: ["Open HWP files", "Local processing"],
    });
    expect(sameMeaningfulSiteFingerprint(first, noisy)).toBe(true);
    expect(sameMeaningfulSiteFingerprint(first, {
      ...noisy,
      description: "Browser viewer with search",
    })).toBe(false);
    expect(siteChangeCandidate(first, noisy, "https://product.example", new Date("2026-08-19T00:00:00Z")))
      .toBeNull();
    expect(siteChangeCandidate(first, {
      ...noisy,
      description: "Browser viewer with search",
    }, "https://product.example", new Date("2026-08-19T00:00:00Z"))).toMatchObject({
      sourceKind: "site_change",
      title: "서비스 소개 변경",
      beforeAfter: { before: first, after: expect.objectContaining({ description: "Browser viewer with search" }) },
    });
  });
});

describe("repository update thresholds", () => {
  const before = {
    stars: 100,
    forks: 20,
    license: "MIT",
    archived: false,
    public: true,
    relationshipState: "site_link",
  };

  it("always emits release-independent material fact changes", () => {
    const events = repositoryUpdateCandidates(before, {
      ...before,
      license: "Apache-2.0",
      archived: true,
      public: false,
      relationshipState: "disconnected",
    }, new Date("2026-08-19T00:00:00Z"));
    expect(events.map((event) => event.dedupeKey)).toEqual(expect.arrayContaining([
      expect.stringContaining("license"),
      expect.stringContaining("archived"),
      expect.stringContaining("visibility"),
      expect.stringContaining("relationship"),
    ]));
  });

  it("emits one activity digest only when an absolute or percentage threshold is reached", () => {
    const at = new Date("2026-08-19T00:00:00Z");
    expect(repositoryUpdateCandidates(before, { ...before, stars: 104, forks: 21 }, at, {
      starsAbsolute: 10,
      starsPercent: 10,
      forksAbsolute: 5,
      forksPercent: 20,
    }).filter((event) => event.sourceKind === "activity_digest")).toHaveLength(0);

    const events = repositoryUpdateCandidates(before, { ...before, stars: 111, forks: 21 }, at, {
      starsAbsolute: 10,
      starsPercent: 20,
      forksAbsolute: 5,
      forksPercent: 20,
    }).filter((event) => event.sourceKind === "activity_digest");
    expect(events).toHaveLength(1);
    expect(events[0].beforeAfter).toEqual({ stars: { before: 100, after: 111 } });
  });
});
