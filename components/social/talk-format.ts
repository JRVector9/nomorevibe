import type { SocialLinkTarget, SocialSource } from "@/lib/db/social-schema";
import { blueskyPostUrl } from "@/lib/social/bluesky-link";
import type { TalkPost } from "@/lib/social/talk";

/** 출처 이름은 번역하지 않는다 — 플랫폼 이름이다 */
export const SOURCE_NAME: Record<SocialSource, string> = { hn: "Hacker News", geeknews: "GeekNews", x: "X", bluesky: "Bluesky" };
const SOURCE_SHORT: Record<SocialSource, string> = { hn: "HN", geeknews: "GN", x: "X", bluesky: "Bsky" };

/** 칩에 쓰는 짧은 이름 — 만든 사람이 올린 HN 글은 Show HN */
export function sourceChip(post: Pick<TalkPost, "source" | "kind">, long = false): string {
  if (post.source === "hn" && post.kind === "show") return "Show HN";
  return long ? SOURCE_NAME[post.source] : SOURCE_SHORT[post.source];
}

/** 본문을 옮기지 않는 출처 — 반응 수와 원문 링크만 보인다(X 정책, Bluesky 도 같은 원칙) */
export const linkOnly = (source: SocialSource) => source === "x" || source === "bluesky";

/** 원문 토론 주소 — 글 ID로 만든다(저장하지 않는다) */
export function discussionUrl(post: Pick<TalkPost, "source" | "externalId">): string {
  const id = encodeURIComponent(post.externalId);
  if (post.source === "hn") return `https://news.ycombinator.com/item?id=${id}`;
  if (post.source === "geeknews") return `https://news.hada.io/topic?id=${id}`;
  if (post.source === "bluesky") return blueskyPostUrl(post.externalId);
  return `https://x.com/i/web/status/${id}`;
}

/** 지금 읽고 있는 출처들 — 수집하지 않는 출처를 이름에 올리지 않는다 */
export function sourceList(sources: readonly SocialSource[]): string {
  const known = sources.length ? [...new Set(sources)] : (["hn"] as SocialSource[]);
  return known.map(source => SOURCE_NAME[source]).join("·");
}

export const sourceClass = (source: SocialSource) => `talk-src talk-src-${source}`;

/** 주소를 이름표로 — 호스트(www. 뺌)와 경로만, 길면 줄인다. 검색어·조각은 버린다. http(s) 가 아니거나 못 읽으면 null */
export function shortLink(url: string, max = 48): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) return null;
  let path = parsed.pathname.replace(/\/+$/, "");
  try { path = decodeURI(path); } catch { /* 깨진 퍼센트 인코딩은 그대로 둔다 */ }
  const text = parsed.hostname.replace(/^www\./, "") + path;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const TARGET_SUFFIX: Partial<Record<SocialLinkTarget, string>> = { issue: " 이슈", pull: " PR" };

/**
 * 관리자 목록·미리보기의 글 이름 — 제목이 있으면 제목.
 * X·Bluesky 는 본문·작성자를 받지 않아(social-schema.ts) 제목이 비어 있다. 그러면 출처와 글이 가리킨 곳으로 붙인다 —
 * 저장소면 owner/repo(이슈·PR 이면 덧붙임), 저장소가 아니면 주소의 호스트·경로. 본문을 지어내거나 가져오지 않는다.
 * 가리킨 주소가 글 자신뿐이면(X 저장소 없는 글은 링크가 X 게시물 주소다) 저장소 주소 없음으로 적는다.
 */
export function socialPostLabel(post: Pick<TalkPost, "source" | "kind" | "title" | "externalId" | "linkTarget"> & { linkUrl: string; repositoryKey: string | null }): string {
  const title = post.title.trim();
  if (title) return title;
  const name = `${sourceChip(post, true)} 게시물`;
  if (post.repositoryKey) return `${name} · ${post.repositoryKey}${TARGET_SUFFIX[post.linkTarget] ?? ""}`;
  const link = post.linkUrl === discussionUrl(post) ? null : shortLink(post.linkUrl);
  return `${name} · ${link ?? "저장소 주소 없음"}`;
}
