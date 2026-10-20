import type { LocalizedTalkEntry } from "@/components/social/TalkHero";
import type { SocialSource } from "@/lib/db/social-schema";
import type { TalkPost, TalkStarGrowth } from "./talk";

/**
 * 실제 화제가 이만큼 모이기 전까지 빈 자리를 '예시' 카드로 채운다 — 홈 대표 구획(1위 + 4자리)과 /talk 의 모양을 보여 주는 견본.
 * 예시는 실제 제품·실제 SNS 글이 아니다: 이름은 "예시 프로젝트 n", 링크가 없고 화면마다 '예시' 표시가 붙는다(2026-10-20 사용자 결정).
 * 실제 화제가 TALK_SAMPLE_TARGET 개 이상이면 하나도 나오지 않는다. 상세 페이지·타임라인에는 넣지 않는다.
 */
export const TALK_SAMPLE_TARGET = 5;

const HOUR = 3_600_000;
const SPECS: { category: string; stars: number; growth: number; posts: [SocialSource, number, number][] }[] = [
  { category: "Design", stars: 1840, growth: 420, posts: [["hn", 214, 86], ["x", 120, 14]] },
  { category: "Productivity", stars: 920, growth: 160, posts: [["hn", 138, 41]] },
  { category: "Dev", stars: 2310, growth: 75, posts: [["x", 96, 9]] },
  { category: "Media", stars: 410, growth: 55, posts: [["hn", 72, 33]] },
  { category: "Data", stars: 260, growth: 20, posts: [["hn", 41, 18]] },
];

function sampleGrowth(stars: number, growth: number, from: Date, now: Date): TalkStarGrowth {
  const span = now.getTime() - from.getTime();
  const points = [0, 0.35, 0.7, 1].map(step => ({ stars: Math.round(stars - growth + growth * step ** 0.8), at: new Date(from.getTime() + span * step) }));
  return { delta: growth, basis: "mention", from: stars - growth, fromAt: from, to: stars, toAt: now, points };
}

/** 예시 카드 count 개 — 순위는 fromRank 부터, 이름은 name(n) */
export function talkSamples(count: number, fromRank: number, now: Date, name: (n: number) => string): LocalizedTalkEntry[] {
  return SPECS.slice(0, Math.max(0, count)).map((spec, index) => {
    const n = index + 1;
    const postedAt = new Date(now.getTime() - (index + 2) * 3 * HOUR);
    const posts: TalkPost[] = spec.posts.map(([source, points, comments], at) => ({
      id: -(n * 10 + at), source, externalId: "", kind: "link", title: "", linkTarget: "repo",
      postedAt: new Date(postedAt.getTime() + at * HOUR), points, comments, frontPage: false,
    }));
    return {
      rank: fromRank + index, repositoryKey: `sample/${n}`, score: 0, sample: true,
      product: { id: -n, slug: "", name: name(n), translationName: name(n), tagline: "", taglineKo: null, taglineSource: "editor",
        category: spec.category, repoUrl: null, ogImage: null, stars: spec.stars, aiLevel: null, accessMode: "website" },
      posts, sources: [...new Set(posts.map(post => post.source))], byMaker: false, homeDecision: null,
      starGrowth: sampleGrowth(spec.stars, spec.growth, postedAt, now),
    };
  });
}

/** 실제 항목 뒤에 예시를 붙여 TALK_SAMPLE_TARGET 개를 채운다. 실제가 충분하면 그대로 */
export function padWithSamples(real: readonly LocalizedTalkEntry[], now: Date, name: (n: number) => string): LocalizedTalkEntry[] {
  if (real.length >= TALK_SAMPLE_TARGET) return [...real];
  const nextRank = real.reduce((max, entry) => Math.max(max, entry.rank), 0) + 1;
  return [...real, ...talkSamples(TALK_SAMPLE_TARGET - real.length, nextRank, now, name)];
}
