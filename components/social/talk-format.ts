import type { SocialSource } from "@/lib/db/social-schema";
import type { TalkPost } from "@/lib/social/talk";

/** 출처 이름은 번역하지 않는다 — 플랫폼 이름이다 */
export const SOURCE_NAME: Record<SocialSource, string> = { hn: "Hacker News", geeknews: "GeekNews", x: "X" };
const SOURCE_SHORT: Record<SocialSource, string> = { hn: "HN", geeknews: "GN", x: "X" };

/** 칩에 쓰는 짧은 이름 — 만든 사람이 올린 HN 글은 Show HN */
export function sourceChip(post: Pick<TalkPost, "source" | "kind">, long = false): string {
  if (post.source === "hn" && post.kind === "show") return "Show HN";
  return long ? SOURCE_NAME[post.source] : SOURCE_SHORT[post.source];
}

/** 원문 토론 주소 — 글 ID로 만든다(저장하지 않는다) */
export function discussionUrl(post: Pick<TalkPost, "source" | "externalId">): string {
  const id = encodeURIComponent(post.externalId);
  if (post.source === "hn") return `https://news.ycombinator.com/item?id=${id}`;
  if (post.source === "geeknews") return `https://news.hada.io/topic?id=${id}`;
  return `https://x.com/i/web/status/${id}`;
}

/** 지금 읽고 있는 출처들 — 수집하지 않는 출처를 이름에 올리지 않는다 */
export function sourceList(sources: readonly SocialSource[]): string {
  const known = sources.length ? [...new Set(sources)] : (["hn"] as SocialSource[]);
  return known.map(source => SOURCE_NAME[source]).join("·");
}

export const sourceClass = (source: SocialSource) => `talk-src talk-src-${source}`;
