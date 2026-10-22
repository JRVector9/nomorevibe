import { repoFromUrl } from "@/lib/crawl/jobs/hn-show";
import type { SocialLinkTarget, SocialPostKind, SocialPostState, SocialSource } from "@/lib/db/social-schema";
import { BLUESKY_BOT_HOLD, BLUESKY_BOT_POSTS, BLUESKY_TALK_WINDOW_MS } from "./bluesky-talk-source";
import {
  BLUESKY_FRESH_MS, blueskyFreshSince, RANKED_TARGETS, TALK_LIST_LIMIT, TALK_PRODUCT_STATUSES, X_FRESH_MS, xFreshSince, type TalkGroup,
} from "./talk";
import { TALK_THRESHOLD, TALK_VISIBLE_MS, talkQualifies } from "./talk-score";

/**
 * 관리자 화면 — 모은 글 하나가 /talk 에 오르는지, 오르지 않으면 왜인지.
 *
 * /talk 에 오를 수 있는 글은 talkGroups(lib/social/talk.ts)가 실제 공개 조건으로 고른다. 거기 든 글은 저장소 순위로,
 * 들지 못한 글은 같은 조건(상태·저장소·제품·7일·X 24시간·자격 기준)을 하나씩 짚어 막힌 것을 모두 적는다.
 */
export type TalkReasonCode =
  | "gone" | "hidden" | "no_repo" | "excluded" | "discussion" | "no_product" | "not_public"
  | "old" | "future" | "x_stale" | "below" | "rank_out" | "carried" | "unknown"
  | "bot" | "label" | "multi_repo" | "bluesky_stale";
export type TalkReason = { code: TalkReasonCode; label: string };
export type TalkVerdict = { shown: boolean; rank: number | null; reasons: TalkReason[] };

/** 저장소 키로 찾은 제품과 공개 조건 하나하나(publicProductChecks) */
export type TalkProductCheck = {
  slug: string; status: string;
  publicProduct: boolean; down: boolean; unlisted: boolean; auditHeld: boolean; repoGone: boolean;
};
export type TalkVerdictPost = {
  id: number; source: SocialSource; kind: SocialPostKind; state: SocialPostState; linkTarget: SocialLinkTarget;
  repositoryKey: string | null; postedAt: Date; lastSeenAt: Date; points: number; comments: number;
  excluded: boolean; product: TalkProductCheck | null;
  /** 숨긴 까닭(admin·bot_suspected·label:<값>)과 글이 가리킨 주소 — 있으면 '숨김'·'저장소 아님'을 더 자세히 적는다 */
  stateReason?: string | null; linkUrl?: string;
};
/** 글 id → 저장소의 지금 순위. 자격 글이 없는 저장소의 글은 null */
export type TalkPlacement = Map<number, { rank: number | null }>;

const DAYS = Math.round(TALK_VISIBLE_MS / 86_400_000);
const X_HOURS = Math.round(X_FRESH_MS / 3_600_000);
const BLUESKY_HOURS = Math.round(BLUESKY_FRESH_MS / 3_600_000);
const BLUESKY_WINDOW_HOURS = Math.round(BLUESKY_TALK_WINDOW_MS / 3_600_000);

/** 자격 기준 — 출처마다 talkQualifies 와 같은 값 */
export function thresholdLabel(source: SocialSource): string {
  if (source === "hn") return `HN ${TALK_THRESHOLD.hn.points}점 또는 댓글 ${TALK_THRESHOLD.hn.comments}개`;
  if (source === "geeknews") return `GeekNews ${TALK_THRESHOLD.geeknews.linkPoints}점(Show ${TALK_THRESHOLD.geeknews.showPoints}점)`;
  if (source === "bluesky") return `Bluesky 반응 ${TALK_THRESHOLD.bluesky.points}`;
  return `X 반응 ${TALK_THRESHOLD.x.points}`;
}

/**
 * 글 하나의 반응 — 공개 /talk 와 같은 말(talk.score·talk.xScore). HN·GeekNews 는 "점·댓글", X·Bluesky 는 "반응(좋아요 + 재게시×2)·답글".
 * 단위 없이 "90 · 20"으로 두면 출처마다 뜻이 달라 기준과 견줄 수 없었다.
 */
export function reactionLabel(post: Pick<TalkVerdictPost, "source" | "points" | "comments">): string {
  const n = (value: number) => value.toLocaleString("ko-KR");
  return post.source === "x" || post.source === "bluesky" ? `반응 ${n(post.points)} · 답글 ${n(post.comments)}` : `${n(post.points)}점 · 댓글 ${n(post.comments)}`;
}

const reason = (code: TalkReasonCode, label: string): TalkReason => ({ code, label });
const below = (post: TalkVerdictPost) => reason("below", `점수 미달 — ${thresholdLabel(post.source)} 아래`);

/**
 * 숨긴 까닭 — 관리자가 숨긴 것과 Bluesky 수집기가 숨긴 것(봇·라벨, lib/social/bluesky-talk-store.ts)을 가른다.
 * 수집기가 숨긴 글도 관리자가 '다시 보이기'로 풀 수 있다(라벨은 다음 회차에 라벨이 남아 있으면 다시 숨는다).
 */
function hiddenReason(stateReason: string | null | undefined): TalkReason {
  if (stateReason === BLUESKY_BOT_HOLD) return reason("bot", `숨김 — 봇으로 보임(${BLUESKY_WINDOW_HOURS}시간에 GitHub 링크 글 ${BLUESKY_BOT_POSTS}개 이상)`);
  if (stateReason === "label:bot") return reason("bot", "숨김 — 봇 계정(스스로 자동 계정이라 밝힘)");
  if (stateReason === "label:!no-unauthenticated") return reason("label", "숨김 — 로그아웃 사용자에게 보이지 않기를 원한 계정");
  if (stateReason?.startsWith("label:")) return reason("label", `숨김 — 라벨 ${stateReason.slice("label:".length)}`);
  return reason("hidden", "숨김");
}

/** 제품 상태 코드의 이름 — 관리자 제품 화면(PRODUCT_STATUS_LABELS)과 같은 말. 모르는 코드는 그대로 */
export const PRODUCT_STATUS_NAMES: Readonly<Record<string, string>> = {
  verified: "검증됨", seeded: "미클레임", unverified: "검증 대기", banned: "차단됨",
};
export const productStatusName = (status: string) => PRODUCT_STATUS_NAMES[status] ?? status;

/** 공개 제품이 아닌 까닭 — 상태가 먼저, 그다음 공개 목록 조건 */
function notPublic(product: TalkProductCheck): TalkReason {
  const why = !(TALK_PRODUCT_STATUSES as readonly string[]).includes(product.status) ? productStatusName(product.status)
    : [product.down && "응답 없음", product.unlisted && "기본 목록 밖", product.auditHeld && "감사 보류", product.repoGone && "저장소 사라짐"]
      .filter(Boolean).join("·") || productStatusName(product.status);
  return reason("not_public", `공개 제품 아님 — ${why}`);
}

/** talkGroups 결과에서 글마다 저장소 순위를 단다. 순위는 점수 있는 묶음만 1부터 */
export function talkPlacement(groups: readonly TalkGroup[]): TalkPlacement {
  const placement: TalkPlacement = new Map();
  let rank = 0;
  for (const group of groups) {
    const at = group.score === null ? null : ++rank;
    for (const post of group.posts) placement.set(post.id, { rank: at });
  }
  return placement;
}

/** 지금 /talk 에 보이는 글 id — 순위가 한 화면(TALK_LIST_LIMIT) 안인 저장소의 글 */
export const shownPostIds = (placement: TalkPlacement): number[] =>
  [...placement].filter(([, place]) => place.rank !== null && place.rank <= TALK_LIST_LIMIT).map(([id]) => id);

export function talkVerdict(post: TalkVerdictPost, placement: TalkPlacement, now: Date): TalkVerdict {
  const place = placement.get(post.id);
  if (place) {
    if (place.rank === null) return { shown: false, rank: null, reasons: [below(post)] };
    if (place.rank > TALK_LIST_LIMIT) return { shown: false, rank: place.rank, reasons: [reason("rank_out", `순위 밖 — ${place.rank}위(${TALK_LIST_LIMIT}위까지 오름)`)] };
    // 저장소에 자격 글이 하나라도 있으면 그 저장소의 다른 글도 함께 보인다
    return { shown: true, rank: place.rank, reasons: talkQualifies(post) ? [] : [reason("carried", "같은 저장소의 다른 글로 오름")] };
  }

  const reasons: TalkReason[] = [];
  if (post.state === "gone") reasons.push(reason("gone", "원문 삭제"));
  if (post.state === "hidden") reasons.push(hiddenReason(post.stateReason));
  // 저장소 주소인데 키가 없다 — 여러 저장소를 가리켰는데 그중 공개 제품 저장소가 없던 글(Bluesky·X)
  if (!post.repositoryKey) reasons.push(post.linkUrl && repoFromUrl(post.linkUrl)
    ? reason("multi_repo", "저장소 여럿 — 공개 제품 저장소가 없어 어느 한 곳에도 세지 않음")
    : reason("no_repo", "저장소 아님 — 저장소 모양이 아닌 주소"));
  else {
    if (post.excluded) reasons.push(reason("excluded", "저장소 빼기"));
    if (!RANKED_TARGETS.includes(post.linkTarget)) reasons.push(reason("discussion", "이슈·PR 글 — 제품 상세에만"));
    if (!post.product) reasons.push(reason("no_product", "공개 제품 아님 — 제품 없음"));
    else if (!post.product.publicProduct) reasons.push(notPublic(post.product));
  }
  if (post.postedAt.getTime() < now.getTime() - TALK_VISIBLE_MS) reasons.push(reason("old", `${DAYS}일 지남`));
  else if (post.postedAt > now) reasons.push(reason("future", "게시 시각이 지금보다 뒤"));
  if (post.source === "x" && post.lastSeenAt < xFreshSince(now)) reasons.push(reason("x_stale", `X 확인 ${X_HOURS}시간 지남`));
  if (post.source === "bluesky" && post.lastSeenAt < blueskyFreshSince(now)) reasons.push(reason("bluesky_stale", `Bluesky 확인 ${BLUESKY_HOURS}시간 지남`));
  if (!talkQualifies(post)) reasons.push(below(post));
  // 위 조건을 모두 넘었는데도 후보에 없다 — 같은 식을 읽으므로 생기지 않아야 한다
  if (!reasons.length) reasons.push(reason("unknown", "조건 밖 — 다시 불러 보세요"));
  return { shown: false, rank: null, reasons };
}
