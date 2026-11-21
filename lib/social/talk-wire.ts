import type { SocialSource } from "@/lib/db/social-schema";
import type { ProductTalk, TalkBoard, TalkEntry, TalkPost, TalkStarGrowth } from "./talk";

/**
 * 화제 채우기 API 의 응답 모양(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에는 순위 자리·이름·요약·링크만 두고,
 * 표지·글(출처·제목·점수·댓글·링크·날짜)·스타·증가 곡선·확인 시각은 이 값으로 브라우저가 채운다.
 * 내부 id(글·제품)·저장소 열쇠·점수·홈 결정은 싣지 않는다. 화면(브라우저)과 API(서버)가 함께 쓴다 — DB 를 부르지 않는다.
 */
export type TalkPostData = Pick<TalkPost, "source" | "externalId" | "kind" | "title" | "linkTarget" | "postedAt" | "points" | "comments">;

export type TalkEntryData = {
  slug: string;
  /** 타임라인이 글 옆에 적는 이름 — 서버 HTML 에도 있는 값 */
  name: string;
  rank: number;
  ogImage: string | null;
  category: string;
  stars: number | null;
  sources: SocialSource[];
  posts: TalkPostData[];
  starGrowth: TalkStarGrowth | null;
};

/** GET /api/talk-board?mode=now|week|home — 홈 대표 구획·/talk 목록 */
export type TalkBoardResponse = {
  preview: boolean;
  /** 마지막으로 출처를 읽은 시각 — 홈(mode=home)은 쓰지 않아 null */
  checkedAt: Date | null;
  /** 자격을 넘었지만 아직 공개 제품이 아닌 저장소 수 — 홈은 null */
  unlisted: { active: number; unknown: number } | null;
  entries: TalkEntryData[];
};

export type ProductTalkData = Pick<ProductTalk, "qualifies" | "rank" | "sources" | "starGrowth" | "checkedAt"> & { posts: TalkPostData[] };

/** GET /api/products/[slug]/talk — 상세 화제 띠. 자격 글이 없으면 talk 가 null */
export type ProductTalkResponse = { preview: boolean; talk: ProductTalkData | null };

/** 글 — 새 객체로 칸을 골라 담는다(id·frontPage 는 빠진다) */
export function talkPostData(post: TalkPostData): TalkPostData {
  return {
    source: post.source, externalId: post.externalId, kind: post.kind, title: post.title, linkTarget: post.linkTarget,
    postedAt: post.postedAt, points: post.points, comments: post.comments,
  };
}

function growthData(growth: TalkStarGrowth | null): TalkStarGrowth | null {
  return growth && {
    delta: growth.delta, basis: growth.basis, from: growth.from, fromAt: growth.fromAt, to: growth.to, toAt: growth.toAt,
    points: growth.points.map(point => ({ stars: point.stars, at: point.at })),
  };
}

export function talkEntryData(entry: Pick<TalkEntry, "rank" | "sources" | "posts" | "starGrowth"> & { product: Pick<TalkEntry["product"], "slug" | "name" | "ogImage" | "category" | "stars"> }): TalkEntryData {
  return {
    slug: entry.product.slug, name: entry.product.name, rank: entry.rank, ogImage: entry.product.ogImage, category: entry.product.category,
    stars: entry.product.stars, sources: [...entry.sources], posts: entry.posts.map(talkPostData), starGrowth: growthData(entry.starGrowth),
  };
}

export function talkBoardResponse(board: Pick<TalkBoard, "entries" | "checkedAt" | "unlisted">, preview: boolean): TalkBoardResponse {
  return { preview, checkedAt: board.checkedAt, unlisted: { ...board.unlisted }, entries: board.entries.map(talkEntryData) };
}

export function productTalkData(talk: ProductTalk): ProductTalkData {
  return {
    posts: talk.posts.map(talkPostData), qualifies: talk.qualifies, rank: talk.rank, sources: [...talk.sources],
    starGrowth: growthData(talk.starGrowth), checkedAt: talk.checkedAt,
  };
}

const DATE_KEYS = new Set(["postedAt", "fromAt", "toAt", "at", "checkedAt"]);

/** JSON.parse 되살리기 — 시각 칸만 Date 로 */
export function reviveTalk(key: string, value: unknown): unknown {
  return DATE_KEYS.has(key) && typeof value === "string" ? new Date(value) : value;
}
