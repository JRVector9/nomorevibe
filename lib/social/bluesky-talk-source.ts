import { z } from "zod";
import { repoFromUrl } from "@/lib/crawl/jobs/hn-show";
import type { SocialLinkTarget } from "@/lib/db/social-schema";
import { blueskyExternalId } from "./bluesky-link";
import { githubLinkTarget } from "./hn-talk-source";
import type { SocialPostInput } from "./repository";

/**
 * Bluesky 에서 GitHub 를 가리킨 게시물 — AppView 공개 검색(api.bsky.app, 인증 없음·무료).
 *
 * 실측(2026-10-21): app.bsky.feed.searchPosts 는 인증 없이 첫 쪽(100건)만 준다 — cursor 로 다음 쪽을 물으면 403 이다.
 * 그래서 since·until 시간 창을 밀어 가며 읽는다. q=* 는 시간 창을 받지 않아(400) 최신 한 쪽에만 쓰고, 창을 미는 읽기는 q=github.com 이다
 * (q=github.com 은 본문에 주소 글자가 없는 글을 놓친다). domain=github.com 은 링크(facet)·카드(embed)의 호스트로 거른다.
 * 하루 1,000~2,000건이고 절반 넘게 봇이다. 반응은 작다(좋아요 중앙값 0, 상위 10% 4쯤).
 *
 * 글에서 읽는 것은 링크(facet·카드 주소)·시각·반응 수·라벨뿐이다. 본문·핸들·이름·사진은 스키마가 버린다(SNS 화제 설계: 주소·점수·시각만).
 * 글 주소의 DID 는 원문 링크에 필요해 글 ID 로 남는다(bluesky-link.ts).
 */
export const BLUESKY_API = "https://api.bsky.app/xrpc";
/** 수집 창 — HN 화제와 같은 72시간 */
export const BLUESKY_TALK_WINDOW_MS = 72 * 3_600_000;
/** 창 안에 GitHub 링크 글을 이만큼 남긴 계정은 봇으로 본다(실측: 한 계정이 최신순 표본의 58%) */
export const BLUESKY_BOT_POSTS = 15;
/** 봇으로 보아 숨긴 까닭(state_reason). 라벨로 숨긴 까닭은 "label:<값>" */
export const BLUESKY_BOT_HOLD = "bot_suspected";
export const BLUESKY_SEARCH_LIMIT = 100;
/** getPosts 한 번에 묻는 글 수(AppView 상한) */
export const BLUESKY_LOOKUP_BATCH = 25;
/** 창을 미는 읽기의 검색어 — 시간 창은 이 검색어로만 받는다 */
export const BLUESKY_WINDOW_QUERY = "github.com";

const labelSchema = z.object({
  /** 라벨을 단 곳 — 글쓴이 자신(스스로 단 라벨)이거나 검토 서비스 */
  src: z.string().max(256).optional(),
  val: z.string().max(128),
  neg: z.boolean().optional(),
  exp: z.string().max(64).optional(),
});
const externalSchema = z.object({ uri: z.string().max(3000) });
/** 우리가 쓰는 칸만. 모르는 키(text·handle·displayName·avatar 등)는 zod 가 버린다 */
const postSchema = z.object({
  uri: z.string().max(512),
  author: z.object({
    did: z.string().max(256),
    labels: z.array(labelSchema).max(100).default([]),
  }),
  record: z.object({
    createdAt: z.string().max(64).optional(),
    facets: z.array(z.object({
      features: z.array(z.object({ uri: z.unknown().optional() })).max(50).default([]),
    })).max(200).optional(),
    embed: z.object({
      external: externalSchema.optional(),
      media: z.object({ external: externalSchema.optional() }).optional(),
    }).optional(),
    /** 글에 스스로 단 라벨(com.atproto.label.defs#selfLabels) */
    labels: z.object({ values: z.array(z.object({ val: z.string().max(128) })).max(50).default([]) }).optional(),
  }),
  likeCount: z.number().int().min(0).optional(),
  repostCount: z.number().int().min(0).optional(),
  replyCount: z.number().int().min(0).optional(),
  indexedAt: z.string().max(64),
  labels: z.array(labelSchema).max(100).default([]),
});
type BlueskyPostView = z.infer<typeof postSchema>;

/**
 * 검색·getPosts 응답 — 글은 하나씩 읽어 모양이 틀린 글 하나가 쪽 전체를 버리지 않게 한다.
 * cursor 는 따라가지 않는다(403). 다음 쪽이 있다는 표시로만 본다 — 검색은 가린 글을 빼고 주므로 100건이 안 차도 끝이 아니다(실측 99건).
 */
export const blueskyResponseSchema = z.object({ posts: z.array(z.unknown()).max(BLUESKY_SEARCH_LIMIT), cursor: z.string().max(4096).optional() });
export type BlueskyResponse = z.infer<typeof blueskyResponseSchema>;

export type BlueskySort = "latest" | "top";

/**
 * 검색 주소. 시간 창(since 포함·until 제외, 글의 sortAt = 작성·색인 시각 중 이른 쪽)을 걸면 q=github.com, 없으면 q=*.
 * 시각은 밀리초까지 Z 로 쓴다(+00:00·마이크로초는 400).
 */
export function blueskySearchUrl(options: { sort: BlueskySort; since?: Date; until?: Date }): string {
  const windowed = Boolean(options.since || options.until);
  const params = new URLSearchParams({
    q: windowed ? BLUESKY_WINDOW_QUERY : "*", domain: "github.com", sort: options.sort, limit: String(BLUESKY_SEARCH_LIMIT),
  });
  if (options.since) params.set("since", options.since.toISOString());
  if (options.until) params.set("until", options.until.toISOString());
  return `${BLUESKY_API}/app.bsky.feed.searchPosts?${params}`;
}

/** 이미 아는 글을 at-uri 로 다시 묻는다 — 지워진 글·내려간 계정의 글은 돌아오지 않는다 */
export function blueskyLookupUrl(uris: readonly string[]): string {
  if (!uris.length || uris.length > BLUESKY_LOOKUP_BATCH) throw new Error("bluesky_lookup_batch");
  const params = new URLSearchParams();
  for (const uri of uris) params.append("uris", uri);
  return `${BLUESKY_API}/app.bsky.feed.getPosts?${params}`;
}

/** http(s) 주소만 */
function usableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** 글이 가리킨 주소 — 본문 링크(facet) 차례대로, 그다음 링크 카드(embed). 본문 글자에서 주소를 캐지 않는다 */
export function blueskyPostLinks(view: Pick<BlueskyPostView, "record">): string[] {
  const urls: string[] = [];
  for (const facet of view.record.facets ?? []) for (const feature of facet.features) {
    const url = usableUrl(feature.uri);
    if (url) urls.push(url);
  }
  for (const external of [view.record.embed?.external, view.record.embed?.media?.external]) {
    const url = usableUrl(external?.uri);
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}

const isGithub = (url: string) => {
  const host = new URL(url).hostname.toLowerCase();
  return host === "github.com" || host === "www.github.com" || host.endsWith(".github.com") || host.endsWith(".github.io");
};
/** 같은 저장소의 주소가 여럿이면 저장소 자체 > 저장소 안 > PR > 이슈 순으로 하나를 고른다 */
const TARGET_ORDER: SocialLinkTarget[] = ["repo", "path", "pull", "issue"];

/**
 * 글의 링크를 우리 칸으로 — 저장소 하나만 가리키면 그 키를 단다. 저장소가 둘 이상이면(목록·비교 글) 어느 한 곳의 화제로 세지 않도록
 * 키 없이 site 로 두고 주소는 첫 GitHub 주소를 남긴다(관리자 화면은 '저장소 여럿'으로 읽는다 — talk-reasons.ts). 저장소가 아닌 GitHub 주소
 * (사용자·조직 페이지·gist·github.io)도 키 없이 site. 링크가 하나도 없으면 null(검색이 카드 안 인용 글 따위로 맞춘 글).
 */
export function blueskyLink(urls: readonly string[]): { linkUrl: string; linkTarget: SocialLinkTarget; repositoryKey: string | null; repositories: number } | null {
  if (!urls.length) return null;
  const repos = new Map<string, { url: string; target: SocialLinkTarget }[]>();
  for (const url of urls) {
    const repo = repoFromUrl(url)?.toLowerCase();
    const target = repo ? githubLinkTarget(url) : null;
    if (repo && target) repos.set(repo, [...repos.get(repo) ?? [], { url, target }]);
  }
  if (repos.size === 1) {
    const [[key, links]] = [...repos];
    const best = [...links].sort((a, b) => TARGET_ORDER.indexOf(a.target) - TARGET_ORDER.indexOf(b.target))[0];
    return { linkUrl: best.url, linkTarget: best.target, repositoryKey: key, repositories: 1 };
  }
  const github = urls.find(isGithub);
  return { linkUrl: github ?? urls[0], linkTarget: "site", repositoryKey: null, repositories: repos.size };
}

/** Bluesky 검토 서비스(기본 labeler) — 이곳이 단 라벨은 모두 검토 결과다 */
export const BLUESKY_MODERATION_DID = "did:plc:ar7c4by46qjdydhdevvrndac";
/**
 * /talk 에서 빼는 라벨 값. '!' 로 시작하는 시스템 라벨(!no-unauthenticated·!hide·!warn·!takedown…)과 검토 서비스가 단 라벨도 뺀다.
 * 그 밖에 스스로 단 라벨(bridged-from-bridgy-fed-activitypub 같은 출처 표시 등)은 막지 않는다 — 실측 첫 회차 393건 중 9건.
 */
const BLOCKED_LABELS = new Set([
  "porn", "sexual", "nudity", "graphic-media", "gore", "sexual-figurative", "self-harm",
  "spam", "scam", "impersonation", "misleading", "intolerant", "threat", "rude", "extremist", "engagement-farming",
  "bot",
]);

/** /talk 에서 뺄 살아 있는 라벨 — 글의 라벨·글에 스스로 단 라벨·계정 라벨 중. 취소(neg)·만료(exp 지남)는 뺀다 */
export function blueskyBlockingLabels(view: Pick<BlueskyPostView, "labels" | "author" | "record">, now: Date): string[] {
  const live = (label: z.infer<typeof labelSchema>) => !label.neg && !(label.exp && Date.parse(label.exp) <= now.getTime());
  const values = [...view.labels.filter(live), ...view.author.labels.filter(live), ...(view.record.labels?.values ?? [])]
    .map(label => ({ value: label.val.trim().toLowerCase(), moderation: "src" in label && label.src === BLUESKY_MODERATION_DID }))
    .filter(({ value, moderation }) => /^[a-z0-9!][a-z0-9!:_-]{0,47}$/.test(value) && (moderation || value.startsWith("!") || BLOCKED_LABELS.has(value)))
    .map(({ value }) => value);
  return [...new Set(values)];
}

/**
 * 막는 라벨이 붙은 글은 /talk 에 올리지 않는다 — 숨긴 까닭 "label:<값>"(state_reason). 까닭은 무거운 것부터 하나.
 * - !no-unauthenticated: 로그아웃한 사람에게 보이지 않기를 원한 계정(우리 공개 화면은 로그아웃 화면이다)
 * - porn·sexual·nudity·graphic-media·gore: 성인·폭력 라벨(스스로 단 것이든 Bluesky 검토가 단 것이든)
 * - !hide·!warn·spam 등 검토 라벨, bot: 스스로 자동 계정이라 밝힌 계정
 */
const LABEL_ORDER = ["!no-unauthenticated", "!takedown", "!suspend", "!hide", "porn", "sexual", "nudity", "graphic-media", "gore", "spam", "!warn"];
export function blueskyLabelHold(labels: readonly string[]): string | null {
  if (!labels.length) return null;
  const rank = (value: string) => {
    const at = LABEL_ORDER.indexOf(value);
    return at >= 0 ? at : value === "bot" ? LABEL_ORDER.length + 1 : LABEL_ORDER.length;
  };
  const [first] = [...labels].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return `label:${first}`;
}

export type BlueskyTalkPost = SocialPostInput & {
  /** 작성 계정 — 회차 안에서만 쓴다(봇 판단). DB 칸은 없다: 글 ID 에 든 것뿐이다 */
  did: string;
  /** 라벨로 숨길 까닭(label:<값>) — 없으면 null */
  labelHold: string | null;
  /** 글이 가리킨 서로 다른 저장소 수 */
  repositories: number;
};

const parseTime = (value: string | undefined) => {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};
const COUNT_MAX = 1_000_000_000;

/**
 * 게시물 하나를 우리 글로. 본문이 없으므로 제목은 비우고, 화면은 출처가 bluesky 면 'Bluesky 게시물'로 그린다(X 와 같다).
 * 점수 = 좋아요 + 재게시×2(X 와 같은 식), 댓글 = 답글. 게시 시각은 검색 창과 같은 sortAt(작성·색인 시각 중 이른 쪽) —
 * 미래로 적은 작성 시각이 순위를 앞당기지 못한다. 글 ID·시각·링크를 못 읽으면 null.
 */
export function blueskyTalkPost(raw: unknown, now: Date): BlueskyTalkPost | null {
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return null;
  const view = parsed.data;
  const externalId = blueskyExternalId(view.uri);
  if (!externalId || !externalId.startsWith(`${view.author.did}/`)) return null;
  const indexed = parseTime(view.indexedAt), created = parseTime(view.record.createdAt);
  const sortAt = indexed === null ? created : created === null ? indexed : Math.min(indexed, created);
  if (sortAt === null) return null;
  const link = blueskyLink(blueskyPostLinks(view));
  if (!link) return null;
  const { repositories, ...target } = link;
  return {
    externalId, kind: "link", title: "", ...target, postedAt: new Date(sortAt),
    points: Math.min(COUNT_MAX, (view.likeCount ?? 0) + (view.repostCount ?? 0) * 2), comments: Math.min(COUNT_MAX, view.replyCount ?? 0),
    frontPage: false, did: view.author.did, labelHold: blueskyLabelHold(blueskyBlockingLabels(view, now)), repositories,
  };
}

/** 쪽의 글을 읽고 버린 수를 센다 */
export function readBlueskyPosts(response: BlueskyResponse, now: Date) {
  const posts = response.posts.map(raw => blueskyTalkPost(raw, now)).filter((post): post is BlueskyTalkPost => post !== null);
  return { posts, skipped: response.posts.length - posts.length };
}

/** 다음 쪽의 until — 쪽에서 가장 이른 sortAt. 같은 밀리초에 남은 글이 있으면 1ms 뒤로 두어 다시 읽고(중복은 ID 로 거른다), 그래도 제자리면 넘어간다 */
export function nextUntil(posts: readonly { postedAt: Date }[], until: Date | null): Date | null {
  if (!posts.length) return null;
  const oldest = Math.min(...posts.map(post => post.postedAt.getTime()));
  const inclusive = oldest + 1;
  return until && inclusive >= until.getTime() ? new Date(oldest) : new Date(inclusive);
}
