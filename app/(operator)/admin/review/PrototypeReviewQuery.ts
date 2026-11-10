import type { listAdminReviewEntries, reviewQueueCauses, ReviewAiDecision, ReviewSort } from "@/lib/crawl/admin-review";
import { REVIEW_SORTS } from "@/lib/crawl/admin-review";
import type { humanQueueOverview } from "@/lib/crawl/review-overview";
import { DELEGATE_GROUPS, type DelegateGroup, type DelegateGroups } from "@/lib/crawl/delegate-groups";
import { REASON_LABELS } from "../reasons";
import { CAUSE_GUIDE, type CauseKey } from "./causes";
import { SECOND_FILTER_KEYS, STAGE_KEYS, STAGE_STATE, type StageKey, type SecondFilter } from "./stages";
import { UPDATED_DAYS, UPDATED_WINDOWS, type UpdatedWindow } from "./ListToolbar";

export const PROTOTYPE_AI_FILTERS: [ReviewAiDecision, string][] = [["reject", "반려 의견"], ["approve", "승인"], ["needs_review", "보류"], ["none", "판단 없음"]];
const one = (value: string | string[] | undefined) => typeof value === "string" ? value : "";
export function prototypeReviewFilter(params: Record<string, string | string[] | undefined>) {
  const tab = ["human", "all", "publish", "rejected"].includes(one(params.tab)) ? one(params.tab)
    : params.state === "rejected" || params.stage === "rejected" ? "rejected" : params.stage === "publish" ? "publish" : params.stage || params.state ? "all" : "human";
  const stage = ((STAGE_KEYS as string[]).includes(one(params.stage)) ? one(params.stage) : tab === "publish" ? "publish" : tab === "rejected" ? "rejected" : "") as StageKey | "";
  return { tab, stage, cause: (Object.hasOwn(CAUSE_GUIDE, one(params.cause)) ? one(params.cause) : "") as CauseKey | "",
    ai: (PROTOTYPE_AI_FILTERS.some(([key]) => key === one(params.ai)) ? one(params.ai) : "") as ReviewAiDecision | "",
    second: (SECOND_FILTER_KEYS.includes(one(params.second) as SecondFilter) ? one(params.second) : "") as SecondFilter | "",
    q: one(params.q).trim().slice(0, 100), updated: (UPDATED_WINDOWS.some(([key]) => key === one(params.updated)) ? one(params.updated) : "") as UpdatedWindow,
    sort: (params.sort === undefined ? "wait_short" : REVIEW_SORTS.includes(one(params.sort) as ReviewSort) ? one(params.sort) : "wait_short") as ReviewSort,
    rawState: one(params.state),
    reason: Object.hasOwn(REASON_LABELS, one(params.reason)) ? one(params.reason) : "",
    /** AI 위임 결과 갈래(?delegate=) — 보류 안에서만 뜻이 있다(delegate-groups.ts) */
    delegate: ((DELEGATE_GROUPS as readonly string[]).includes(one(params.delegate)) ? one(params.delegate) : "") as DelegateGroup | "",
  };
}
type Filter = ReturnType<typeof prototypeReviewFilter>;
type ReviewState = NonNullable<Parameters<typeof listAdminReviewEntries>[1]>["state"];
function filterState(filter: Filter): ReviewState {
  const { tab, stage, cause, ai, second, rawState, delegate } = filter;
  const heldStage = ["ai", "second", "agreed", "human"].includes(stage);
  const detailable = !stage || heldStage;
  return stage ? STAGE_STATE[stage] : rawState === "rejected" ? "rejected" : tab === "human" || (detailable && (cause || ai || second || delegate)) ? "needs_review"
    : ["pending", "needs_review", "rejected", "published"].includes(rawState) ? rawState as "pending" | "needs_review" | "rejected" | "published" : "all";
}
export function prototypeReviewState(filter: ReturnType<typeof prototypeReviewFilter>): ReviewState {
  return filterState(filter);
}
/** Membership must remain fresh; display-only counts are not a prerequisite for every queue. */
export function prototypeReviewNeeds(filter: Filter) {
  const heldStage = ["ai", "second", "agreed", "human"].includes(filter.stage);
  const detailable = !filter.stage || heldStage;
  const rejected = filterState(filter) === "rejected";
  const secondHeld = Boolean(filter.second && filter.second !== "published");
  return {
    overview: Boolean(rejected ? secondHeld : (heldStage || filter.tab === "human" || (detailable && (filter.ai || secondHeld)))),
    causes: Boolean(filter.cause && (detailable || rejected)),
    delegate: Boolean(filter.delegate && detailable && !rejected),
  };
}
/** AI 위임 결과 갈래 칩을 보일 목록 — 사람 몫 탭·보류 구간, 또는 갈래를 이미 고른 목록. 거부·공개분 목록에는 없다 */
export function prototypeReviewDelegateVisible(filter: Filter): boolean {
  const heldStage = ["ai", "second", "agreed", "human"].includes(filter.stage);
  return filterState(filter) === "needs_review" && filter.second !== "published" && (filter.tab === "human" || heldStage || Boolean(filter.delegate));
}
export function prototypeReviewOptions(filter: Filter, causes: Awaited<ReturnType<typeof reviewQueueCauses>> | null, overview: Awaited<ReturnType<typeof humanQueueOverview>> | null,
  delegateGroups: DelegateGroups | null = null): NonNullable<Parameters<typeof listAdminReviewEntries>[1]> {
  const { tab, stage, cause, ai, second, q, updated, sort, reason, delegate } = filter;
  const heldStage = ["ai", "second", "agreed", "human"].includes(stage) ? stage as "ai" | "second" | "agreed" | "human" : null;
  const detailable = !stage || heldStage !== null;
  const state = filterState(filter);
  const rejected = state === "rejected";
  const needs = prototypeReviewNeeds(filter);
  if (needs.overview && !overview) throw new Error("review_overview_unavailable");
  if (needs.causes && !causes) throw new Error("review_causes_unavailable");
  if (needs.causes && causes!.truncated) throw new Error("review_causes_truncated");
  if (needs.delegate && !delegateGroups) throw new Error("review_delegate_unavailable");
  const ids = [rejected ? undefined : heldStage ? overview!.ids[heldStage] : tab === "human" ? [...overview!.ids.human, ...overview!.ids.agreed] : undefined,
    cause && (detailable || rejected) ? causes!.ids.get(cause) ?? [] : undefined,
    ai && detailable && !rejected ? overview!.aiDecisions.ids.get(ai) ?? [] : undefined,
    second && second !== "published" && (detailable || rejected) ? overview!.secondIds[second] : undefined,
    needs.delegate ? delegateGroups!.ids[delegate as DelegateGroup] : undefined]
    .filter((items): items is number[] => items !== undefined).reduce<number[] | undefined>((result, items) => { if (!result) return items; const keep = new Set(items); return result.filter(id => keep.has(id)); }, undefined);
  return { state, ids, ...(rejected && ai ? { aiDecision: ai } : {}), reason: reason || undefined, search: q || undefined, pushedWithinDays: updated ? UPDATED_DAYS[updated] : undefined, sort };
}
/** 갈래 칩의 수를 셀 범위 — 갈래(delegate)만 뺀 같은 조건의 id. undefined 면 보류 전체(갈래는 보류만 담는다) */
export function prototypeReviewDelegateScope(filter: Filter, causes: Awaited<ReturnType<typeof reviewQueueCauses>> | null,
  overview: Awaited<ReturnType<typeof humanQueueOverview>> | null): number[] | undefined {
  return prototypeReviewOptions({ ...filter, delegate: "" }, causes, overview).ids;
}
