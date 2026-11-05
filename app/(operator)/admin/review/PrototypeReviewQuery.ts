import type { listAdminReviewEntries, reviewQueueCauses, ReviewAiDecision, ReviewSort } from "@/lib/crawl/admin-review";
import { REVIEW_SORTS } from "@/lib/crawl/admin-review";
import type { humanQueueOverview } from "@/lib/crawl/review-overview";
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
  };
}
type Filter = ReturnType<typeof prototypeReviewFilter>;
/** Membership must remain fresh; display-only counts are not a prerequisite for every queue. */
export function prototypeReviewNeeds(filter: Filter) {
  const heldStage = ["ai", "second", "agreed", "human"].includes(filter.stage);
  const detailable = !filter.stage || heldStage;
  return {
    overview: Boolean(heldStage || filter.tab === "human" || (detailable && (filter.ai || (filter.second && filter.second !== "published")))),
    causes: Boolean(detailable && filter.cause),
  };
}
export function prototypeReviewOptions(filter: Filter, causes: Awaited<ReturnType<typeof reviewQueueCauses>> | null, overview: Awaited<ReturnType<typeof humanQueueOverview>> | null): NonNullable<Parameters<typeof listAdminReviewEntries>[1]> {
  const { tab, stage, cause, ai, second, q, updated, sort, rawState } = filter;
  const heldStage = ["ai", "second", "agreed", "human"].includes(stage) ? stage as "ai" | "second" | "agreed" | "human" : null;
  const detailable = !stage || heldStage !== null;
  const needs = prototypeReviewNeeds(filter);
  if (needs.overview && !overview) throw new Error("review_overview_unavailable");
  if (needs.causes && !causes) throw new Error("review_causes_unavailable");
  const ids = [heldStage ? overview!.ids[heldStage] : tab === "human" ? [...overview!.ids.human, ...overview!.ids.agreed] : undefined,
    detailable && cause ? causes!.ids.get(cause) ?? [] : undefined,
    detailable && ai ? overview!.aiDecisions.ids.get(ai) ?? [] : undefined,
    detailable && second && second !== "published" ? overview!.secondIds[second] : undefined]
    .filter((items): items is number[] => items !== undefined).reduce<number[] | undefined>((result, items) => { if (!result) return items; const keep = new Set(items); return result.filter(id => keep.has(id)); }, undefined);
  const state = stage ? STAGE_STATE[stage] : tab === "human" || (detailable && (cause || ai || second)) ? "needs_review"
    : ["pending", "needs_review", "rejected", "published"].includes(rawState) ? rawState as "pending" | "needs_review" | "rejected" | "published" : "all";
  return { state, ids, search: q || undefined, pushedWithinDays: updated ? UPDATED_DAYS[updated] : undefined, sort };
}
