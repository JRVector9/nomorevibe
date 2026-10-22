import type { SocialSource } from "@/lib/db/social-schema";

/**
 * 화제 점수 첫 판(SNS 화제·홍보 설계 4장). /talk·홈의 순서에만 쓰고 반응 순위에는 섞지 않는다.
 *
 *   post(p)    = w_s · log2(1 + 점수 + 댓글/2)
 *   talk(r, t) = Σ_s max_{p∈s} post(p) · 2^(−(t − 게시 시각)/36시간) + (출처 수 − 1)
 *
 * '지금'은 36시간 반감, '이번 주'는 반감 없이 합친다. 기준·무게는 2주 관측 뒤 다시 맞춘다(계획 D9).
 */
export type TalkMode = "now" | "week";
export type TalkPostInput = { source: SocialSource; kind: "link" | "show"; points: number; comments: number; postedAt: Date };

export const TALK_SOURCE_WEIGHT: Record<SocialSource, number> = { hn: 1, geeknews: 1.6, x: 0.6, bluesky: 1 };
export const TALK_HALF_LIFE_MS = 36 * 3_600_000;
/** /talk·홈에 글이 보이는 기간 */
export const TALK_VISIBLE_MS = 7 * 86_400_000;

/**
 * Bluesky 자격 — 반응(좋아요 + 재게시×2) 5. 반응이 작다(실측 2026-10-21: 좋아요 중앙값 0, 상위 10% 4쯤,
 * 제품에 이어진 저장소 100곳 중 좋아요 5 이상 11곳). X 50 을 그대로 쓰면 하나도 오르지 않는다. 2주 관측 뒤 다시 맞춘다
 */
export const BLUESKY_TALK_POINTS = 5;

/** 화면에 오를 자격의 기준값 — 관리자 화면도 이 값으로 '점수 미달'을 적는다 */
export const TALK_THRESHOLD = {
  hn: { points: 30, comments: 15 },
  geeknews: { showPoints: 3, linkPoints: 5 },
  x: { points: 50 },
  bluesky: { points: BLUESKY_TALK_POINTS },
} as const;

/** 화면에 오를 자격 — 하나라도 넘어야 한다. X·GeekNews 는 수집을 붙일 때 실제 분포로 다시 정한다 */
export function talkQualifies(post: TalkPostInput): boolean {
  if (post.source === "hn") return post.points >= TALK_THRESHOLD.hn.points || post.comments >= TALK_THRESHOLD.hn.comments;
  if (post.source === "geeknews") return post.points >= (post.kind === "show" ? TALK_THRESHOLD.geeknews.showPoints : TALK_THRESHOLD.geeknews.linkPoints);
  if (post.source === "bluesky") return post.points >= TALK_THRESHOLD.bluesky.points;
  return post.points >= TALK_THRESHOLD.x.points;
}

export const postScore = (post: TalkPostInput) =>
  TALK_SOURCE_WEIGHT[post.source] * Math.log2(1 + post.points + post.comments / 2);

/** 저장소 하나의 화제 점수. 자격을 넘은 글만 센다 — 자격 글이 없으면 null */
export function repositoryTalkScore(posts: readonly TalkPostInput[], now: Date, mode: TalkMode): number | null {
  const best = new Map<SocialSource, number>();
  for (const post of posts) {
    if (!talkQualifies(post)) continue;
    const age = Math.max(0, now.getTime() - post.postedAt.getTime());
    if (age > TALK_VISIBLE_MS) continue;
    const decay = mode === "now" ? 2 ** (-age / TALK_HALF_LIFE_MS) : 1;
    const score = postScore(post) * decay;
    if (score > (best.get(post.source) ?? -1)) best.set(post.source, score);
  }
  if (!best.size) return null;
  return [...best.values()].reduce((sum, value) => sum + value, 0) + (best.size - 1);
}
