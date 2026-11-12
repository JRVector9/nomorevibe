import { sql, type SQL } from "drizzle-orm";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { ModelSlotMemberCap } from "@/lib/llm/capacity-repository";
import { ai1WithinLiveCallWindowSql } from "./ai1-live-call";
import { firstReviewRankState, firstReviewerKey, type FirstReviewSettings } from "./first-reviewers";
import { reviewPoolSlotCaps } from "./review-task-ranks";

/**
 * 1차 「동시에」 구성원 칸 수가 세는 살아 있는 1차 장부 행 — 기한 안의 대기·예약, 호출 기한 + 여유 안의 보냄(모든 주인). 고르기 힌트
 * (agent-review-repository.ts firstReviewCappedKeys)와 장부 입장 TX 의 칸 확인(firstReviewMemberSlotCap)이 같은 기준이다.
 */
export function firstReviewLiveLedgerSql(): SQL {
  return sql`route_id = 'crawl-agent-review' AND class = 'first' AND (
      (state = 'waiting' AND queue_until > clock_timestamp()) OR (state = 'reserved' AND reserved_until > clock_timestamp())
      OR (state = 'dispatched' AND ${ai1WithinLiveCallWindowSql(sql`provider`, sql`coalesce(dispatched_at, updated_at)`)}))`;
}

/**
 * 1차 「동시에」 구성원의 칸 수를 예약을 만드는 장부 TX 에서 원자적으로 지키게 하는 값(2026-11-12 검수 F2) — requestAi1ModelSlot·requestCliModelSlot(ai1)에 준다.
 * 장부는 control 행을 FOR UPDATE 로 잡은 채 새 대기 행을 쓰기 전에 그 구성원의 살아 있는 1차 장부 행을 세어, 칸 수에 닿았으면 줄에 서지 않고 model_quota 로
 * 미룬다(두 후보가 함께 세어 둘 다 지나가는 경합이 없다). 이미 줄에 선 자기 요청을 다시 묻는 것은 세지 않는다. 구성원이 아니거나(예비·순위대로)
 * 칸 수를 적지 않았으면 null — 예전과 같다.
 */
export function firstReviewMemberSlotCap(settings: FirstReviewSettings, reviewer: { provider: string; model: string }): ModelSlotMemberCap | null {
  if (currentReplayDb()) return null;
  const resolution = firstReviewRankState(settings).resolution;
  if (resolution?.execution?.mode !== "workload_pool") return null;
  const maxSlots = reviewPoolSlotCaps("first-review", 1, resolution.execution, resolution.candidates)?.get(firstReviewerKey(reviewer));
  if (maxSlots === undefined) return null;
  return Object.freeze({ maxSlots, load: async (tx: ProductTransaction) => {
    const [row] = await tx.execute<{ n: number }>(sql`SELECT count(*)::integer AS n FROM model_capacity_requests
      WHERE ${firstReviewLiveLedgerSql()} AND provider = ${reviewer.provider} AND model = ${reviewer.model}`);
    return Number(row?.n ?? 0);
  } });
}
