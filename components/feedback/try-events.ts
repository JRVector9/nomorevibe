import type { AnalyticsEvent } from "@/lib/analytics/events";
import type { ReactionMine } from "@/lib/domain/reactions/contract";

type Mine = Pick<ReactionMine, "verdict" | "tags" | "comment"> | null;

/**
 * 써봤어요 저장·삭제 뒤 보낼 분석 이벤트(2026-10-22) — 서버가 받은 뒤에만 부른다.
 * - product_tried: 처음이면 add, 평가·태그·한 줄을 바꾸면 update, 지우면 remove. 평가 코드(good·meh·bad)만 싣는다.
 * - reaction_change: 태그는 코드마다 add/remove, 한 줄은 내용 없이 'comment' 로만(글은 보내지 않는다).
 */
export function triedEvents(slug: string, previous: Mine, next: Mine): AnalyticsEvent[] {
  if (!next) return previous ? [{ name: "product_tried", params: { product_slug: slug, action: "remove" } }] : [];
  const events: AnalyticsEvent[] = [{ name: "product_tried", params: { product_slug: slug, action: previous ? "update" : "add", verdict: next.verdict } }];
  const before = new Set(previous?.tags ?? []), after = new Set(next.tags);
  for (const tag of next.tags) if (!before.has(tag)) events.push({ name: "reaction_change", params: { product_slug: slug, reaction_kind: tag, action: "add" } });
  for (const tag of previous?.tags ?? []) if (!after.has(tag)) events.push({ name: "reaction_change", params: { product_slug: slug, reaction_kind: tag, action: "remove" } });
  const hadComment = Boolean(previous?.comment), hasComment = Boolean(next.comment);
  if (hadComment !== hasComment) events.push({ name: "reaction_change", params: { product_slug: slug, reaction_kind: "comment", action: hasComment ? "add" : "remove" } });
  return events;
}
