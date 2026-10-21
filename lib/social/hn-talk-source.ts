import { z } from "zod";
import { repoFromUrl } from "@/lib/crawl/jobs/hn-show";
import type { SocialLinkTarget, SocialPostKind } from "@/lib/db/social-schema";

/**
 * Hacker News 에서 GitHub 저장소를 가리킨 글 — 알골리아 공개 검색(인증 없음·무료).
 *
 * Show HN 수집기(hn-show-seed)는 저장소 주소만 프론티어에 넣고 글은 버린다. 이것은 반대로 글을 남긴다:
 * 남이 소개한 글까지 포함해 주소가 github.com 인 글을 점수와 함께 읽는다.
 * 실측(2026-10-20): 최근 72시간·10점 이상 19건, 한 페이지로 끝났다.
 * 검색은 주소의 낱말로 맞추므로 저장소가 아닌 주소(github.io·gist·사용자 페이지 등)도 돌아온다 — 버리지 않고 저장소 키 없이 남긴다.
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
  /** 소문자 owner/repo. 저장소 모양이 아닌 주소(site)는 null */
  repositoryKey: string | null;
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

/** http(s) 주소만 링크로 남긴다 */
function usableUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * 알골리아 글 하나를 우리 글로. 검색이 돌려준 글은 버리지 않는다(관리자 화면에서 모두 본다).
 * 저장소 모양 주소(github.com/owner/repo…)만 저장소 키를 달고, 나머지(github.io·gist·사용자 페이지·다른 사이트)는
 * 키 없이 site 로 남긴다 — 저장소를 추측하지 않으므로 /talk 에는 오르지 않는다. 주소·제목이 없으면 보여 줄 것이 없어 null.
 */
export function hnTalkPost(hit: HnHit): HnTalkPost | null {
  const url = usableUrl(hit.url);
  if (!url) return null;
  const title = (hit.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!title) return null;
  const repo = repoFromUrl(url);
  const target = repo ? githubLinkTarget(url) : null;
  return {
    externalId: hit.objectID,
    kind: hit._tags.includes("show_hn") ? "show" : "link",
    title,
    linkUrl: url,
    linkTarget: repo && target ? target : "site",
    repositoryKey: repo && target ? repo.toLowerCase() : null,
    postedAt: new Date(hit.created_at_i * 1000),
    points: hit.points ?? 0,
    comments: hit.num_comments ?? 0,
    frontPage: hit._tags.includes("front_page"),
  };
}

/** 원문 토론 주소 — 저장하지 않고 ID로 만든다 */
export const hnDiscussionUrl = (externalId: string) => `https://news.ycombinator.com/item?id=${encodeURIComponent(externalId)}`;
