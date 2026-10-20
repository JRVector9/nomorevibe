import { z } from "zod";
import { repoFromUrl } from "@/lib/crawl/jobs/hn-show";
import type { SocialLinkTarget, SocialPostKind } from "@/lib/db/social-schema";

/**
 * Hacker News 에서 GitHub 저장소를 가리킨 글 — 알골리아 공개 검색(인증 없음·무료).
 *
 * Show HN 수집기(hn-show-seed)는 저장소 주소만 프론티어에 넣고 글은 버린다. 이것은 반대로 글을 남긴다:
 * 남이 소개한 글까지 포함해 주소가 github.com 인 글을 점수와 함께 읽는다.
 * 실측(2026-10-20): 최근 72시간·10점 이상 19건, 한 페이지로 끝났다.
 */
export const HN_SEARCH_BY_DATE = "https://hn.algolia.com/api/v1/search_by_date";
export const HN_SEARCH = "https://hn.algolia.com/api/v1/search";
export const HN_HITS_PER_PAGE = 100;
/** 태그 OR 조회(story_1,story_2,…) 한 번에 묻는 글 수 */
export const HN_LOOKUP_BATCH = 50;

const hitSchema = z.object({
  objectID: z.string().regex(/^[1-9]\d{0,15}$/),
  created_at_i: z.number().int().positive(),
  url: z.string().max(2000).nullish(),
  title: z.string().max(2000).nullish(),
  points: z.number().int().min(0).nullish(),
  num_comments: z.number().int().min(0).nullish(),
  _tags: z.array(z.string().max(80)).max(50).default([]),
});

export const hnResponseSchema = z.object({
  hits: z.array(hitSchema).max(HN_HITS_PER_PAGE),
  nbPages: z.number().int().min(0).default(0),
});
export type HnResponse = z.infer<typeof hnResponseSchema>;
export type HnHit = z.infer<typeof hitSchema>;

export type HnTalkPost = {
  externalId: string;
  kind: SocialPostKind;
  title: string;
  linkUrl: string;
  linkTarget: SocialLinkTarget;
  repositoryKey: string;
  postedAt: Date;
  points: number;
  comments: number;
  frontPage: boolean;
};

/** 주소가 github.com 이고 created_at 이 since 이후, 점수가 minPoints 이상인 글 */
export function hnDiscoverUrl(sinceSeconds: number, minPoints: number, page: number): string {
  const params = new URLSearchParams({
    query: "github.com",
    restrictSearchableAttributes: "url",
    tags: "story",
    numericFilters: `created_at_i>=${sinceSeconds},points>=${minPoints}`,
    hitsPerPage: String(HN_HITS_PER_PAGE),
    page: String(page),
  });
  return `${HN_SEARCH_BY_DATE}?${params}`;
}

/** 이미 아는 글을 ID로 다시 묻는다 — 돌아오지 않으면 지워졌거나 죽은 글이다 */
export function hnLookupUrl(externalIds: readonly string[]): string {
  if (!externalIds.length || externalIds.length > HN_LOOKUP_BATCH) throw new Error("hn_lookup_batch");
  const params = new URLSearchParams({
    tags: `story,(${externalIds.map(id => `story_${id}`).join(",")})`,
    hitsPerPage: String(HN_HITS_PER_PAGE),
  });
  return `${HN_SEARCH}?${params}`;
}

/** 저장소 주소 안의 어디를 가리키나. 저장소 첫 화면·코드는 repo, 이슈·PR 은 따로 보여 준다 */
export function githubLinkTarget(url: string): SocialLinkTarget | null {
  if (!repoFromUrl(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  const rest = parsed.pathname.split("/").filter(Boolean).slice(2);
  const head = rest[0]?.toLowerCase();
  if (!head || head === "tree" || head === "blob") return "repo";
  if (head === "issues") return "issue";
  if (head === "pull" || head === "pulls") return "pull";
  return "path";
}

/** 알골리아 글 하나를 우리 글로 — GitHub 저장소를 가리키지 않으면 버린다 */
export function hnTalkPost(hit: HnHit): HnTalkPost | null {
  const url = hit.url?.trim();
  if (!url) return null;
  const repo = repoFromUrl(url);
  const linkTarget = githubLinkTarget(url);
  if (!repo || !linkTarget) return null;
  const title = (hit.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!title) return null;
  return {
    externalId: hit.objectID,
    kind: hit._tags.includes("show_hn") ? "show" : "link",
    title,
    linkUrl: url,
    linkTarget,
    repositoryKey: repo.toLowerCase(),
    postedAt: new Date(hit.created_at_i * 1000),
    points: hit.points ?? 0,
    comments: hit.num_comments ?? 0,
    frontPage: hit._tags.includes("front_page"),
  };
}

/** 원문 토론 주소 — 저장하지 않고 ID로 만든다 */
export const hnDiscussionUrl = (externalId: string) => `https://news.ycombinator.com/item?id=${encodeURIComponent(externalId)}`;
