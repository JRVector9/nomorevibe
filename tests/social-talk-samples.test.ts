import { describe, expect, it } from "vitest";
import type { LocalizedTalkEntry } from "@/components/social/TalkHero";
import { padWithSamples, TALK_SAMPLE_TARGET, talkSamples } from "@/lib/social/talk-samples";

const NOW = new Date("2026-10-20T15:00:00Z");
const name = (n: number) => `예시 프로젝트 ${n}`;
const real = (rank: number): LocalizedTalkEntry => ({
  rank, repositoryKey: `acme/p${rank}`, score: 3, sources: ["hn"], byMaker: false, starGrowth: null, homeDecision: null,
  posts: [{ id: rank, source: "hn", externalId: String(9000 + rank), kind: "link", title: "Real", linkTarget: "repo", postedAt: NOW, points: 40, comments: 3, frontPage: false }],
  product: { id: rank, slug: `p${rank}`, name: `p${rank}`, translationName: `p${rank}`, tagline: "t", taglineKo: null, taglineSource: "maker", category: "Dev",
    repoUrl: `https://github.com/acme/p${rank}`, ogImage: null, stars: 10, aiLevel: 1, accessMode: "website" },
});

describe("SNS 화제 '예시' 카드", () => {
  it("실제가 다섯 개 이상이면 예시를 붙이지 않는다", () => {
    const five = [1, 2, 3, 4, 5].map(real);
    expect(padWithSamples(five, NOW, name)).toEqual(five);
  });

  it("모자란 자리만 예시로 채우고, 순위는 실제 다음부터 이어진다", () => {
    const padded = padWithSamples([real(1)], NOW, name);
    expect(padded).toHaveLength(TALK_SAMPLE_TARGET);
    expect(padded[0].sample).toBeUndefined();
    expect(padded.slice(1).map(entry => [entry.rank, entry.sample, entry.product.name])).toEqual([
      [2, true, "예시 프로젝트 1"], [3, true, "예시 프로젝트 2"], [4, true, "예시 프로젝트 3"], [5, true, "예시 프로젝트 4"],
    ]);
  });

  it("예시는 실제 제품·실제 글을 가리키지 않는다 — 링크 재료가 비어 있고 저장소 열쇠도 sample/", () => {
    for (const entry of talkSamples(TALK_SAMPLE_TARGET, 1, NOW, name)) {
      expect(entry.repositoryKey).toMatch(/^sample\/\d$/);
      expect([entry.product.slug, entry.product.repoUrl, entry.product.ogImage]).toEqual(["", null, null]);
      expect(entry.posts.every(post => post.externalId === "" && post.id < 0)).toBe(true);
      expect(entry.sources).toEqual([...new Set(entry.posts.map(post => post.source))]);
      expect(entry.starGrowth?.points.at(-1)?.stars).toBe(entry.product.stars);
    }
  });
});
