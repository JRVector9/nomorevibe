import { describe, expect, it } from "vitest";
import { candidateStarAutoApproval, starAutoApproval } from "@/lib/crawl/star-auto-approval";
import { judgeStoredDocument } from "@/lib/crawl/rules";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

const now = new Date("2026-09-29T04:00:00Z");
const document = {
  repo: "maker/tool",
  repoMeta: {
    id: 123,
    full_name: "maker/tool",
    private: false,
    fork: false,
    archived: false,
    stargazers_count: 500,
  },
  fetchedAt: new Date("2026-09-29T03:00:00Z"),
  productUrl: null,
  pageStatus: null,
  pageMeta: null,
};

describe("verified GitHub star auto approval", () => {
  it("defaults to 500 and includes 100,000 stars", () => {
    expect(DEFAULT_CRAWL_SETTINGS.judge.autoApproveMinStars).toBe(500);
    expect(starAutoApproval(document, DEFAULT_CRAWL_SETTINGS, now)).toMatchObject({ stars: 500, githubId: 123 });
    expect(starAutoApproval({ ...document, repoMeta: { ...document.repoMeta, stargazers_count: 100_000 } },
      DEFAULT_CRAWL_SETTINGS, now)).toMatchObject({ stars: 100_000 });
    expect(starAutoApproval({ ...document, repoMeta: { ...document.repoMeta, stargazers_count: 499 } },
      DEFAULT_CRAWL_SETTINGS, now)).toBeNull();
  });

  it("uses the saved administrator threshold", () => {
    const settings = { ...DEFAULT_CRAWL_SETTINGS, judge: { ...DEFAULT_CRAWL_SETTINGS.judge, autoApproveMinStars: 1000 } };
    expect(starAutoApproval(document, settings, now)).toBeNull();
    expect(starAutoApproval({ ...document, repoMeta: { ...document.repoMeta, stargazers_count: 1000 } }, settings, now))
      .toMatchObject({ stars: 1000 });
  });

  it("requires a fresh public GitHub repository identity and integer star count", () => {
    const changes: Record<string, unknown>[] = [
      { id: null }, { id: -1 }, { full_name: "other/tool" }, { private: true },
      { fork: true }, { archived: true }, { stargazers_count: 500.5 },
      { stargazers_count: "500" },
    ];
    for (const change of changes) {
      expect(starAutoApproval({ ...document, repoMeta: { ...document.repoMeta, ...change } },
        DEFAULT_CRAWL_SETTINGS, now), JSON.stringify(change)).toBeNull();
    }
    expect(starAutoApproval({ ...document, fetchedAt: new Date("2026-09-28T03:59:59Z") },
      DEFAULT_CRAWL_SETTINGS, now)).toBeNull();
    expect(starAutoApproval({ ...document, fetchedAt: new Date("2026-09-29T04:00:01Z") },
      DEFAULT_CRAWL_SETTINGS, now)).toBeNull();
  });

  it("approves verified popular sources without a homepage or content review", () => {
    const verdict = judgeStoredDocument({ ...document, repoMeta: {
      ...document.repoMeta, description: "Personal research notes and survey data",
    } }, DEFAULT_CRAWL_SETTINGS, now);
    expect(verdict).toMatchObject({
      state: "approved", reason: "passed",
      signals: { accessMode: "installable", starAutoApproval: { stars: 500, githubId: 123 } },
    });
    expect(judgeStoredDocument({ ...document, repoMeta: { ...document.repoMeta, fork: true } },
      DEFAULT_CRAWL_SETTINGS, now).state).not.toBe("approved");
  });

  it("does not trust a stale or forged candidate approval marker", () => {
    const candidate = { decidedBy: "auto", signals: { starAutoApproval: { stars: 500, githubId: 123 } } };
    expect(candidateStarAutoApproval(candidate, document, DEFAULT_CRAWL_SETTINGS, now))
      .toMatchObject({ stars: 500, githubId: 123 });
    expect(candidateStarAutoApproval({ ...candidate, signals: { starAutoApproval: { stars: 100_000, githubId: 123 } } },
      document, DEFAULT_CRAWL_SETTINGS, now)).toBeNull();
    expect(candidateStarAutoApproval({ ...candidate, decidedBy: "admin" }, document, DEFAULT_CRAWL_SETTINGS, now))
      .toBeNull();
  });
});
