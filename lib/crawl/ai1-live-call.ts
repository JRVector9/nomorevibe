import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { reviewGatewayLadder } from "@/lib/llm/deadline-ladder";
import { modelTimeoutMs } from "@/lib/llm/model-registry";

/**
 * 1차 호출 하나가 「지금 보내진 중」일 수 있는 시간 — 그 공급자의 호출 기한(게이트웨이·엔진 직접은 review-gateway 사다리 clientMs,
 * CLI 는 review-cli·grok-review 제한 시간) + 여유 60초. 이보다 오래된 running 시도·dispatched 장부 행은 후보를 그 모델에 묶지 않는다
 * (2026-11-01 운영자 결정, first-reviewers.ts selectFirstReviewer). 모르는 공급자는 가장 긴 기한을 쓴다.
 * 이것은 고르기의 힌트다 — 장부의 같은 후보 fence·점유 유일 색인(model_capacity_requests_logical_active_idx)은 그대로다.
 */
export const AI1_LIVE_CALL_MARGIN_MS = 60_000;

function windows() {
  const gateway = reviewGatewayLadder().clientMs, cli = modelTimeoutMs("review-cli"), grok = modelTimeoutMs("grok-review");
  return { gateway, cli, grok, unknown: Math.max(gateway, cli, grok) };
}

export function ai1LiveCallWindowMs(provider: string | null): number {
  const w = windows();
  const base = provider === "abcllm" || provider === "local-direct" ? w.gateway : provider === "claude-cli" ? w.cli
    : provider === "grok-cli" ? w.grok : w.unknown;
  return base + AI1_LIVE_CALL_MARGIN_MS;
}

/** `startedAt` 이 provider 의 창 안인가(DB 시각). NULL 시각은 살아 있다고 본다 — 나이를 모르는 것을 버리지 않는다. */
export function ai1WithinLiveCallWindowSql(provider: SQLWrapper, startedAt: SQLWrapper): SQL {
  const w = windows(), margin = AI1_LIVE_CALL_MARGIN_MS;
  return sql`(${startedAt} IS NULL OR ${startedAt} > clock_timestamp() - (CASE
    WHEN ${provider} IN ('abcllm','local-direct') THEN ${w.gateway + margin}::integer
    WHEN ${provider} = 'claude-cli' THEN ${w.cli + margin}::integer
    WHEN ${provider} = 'grok-cli' THEN ${w.grok + margin}::integer
    ELSE ${w.unknown + margin}::integer END) * interval '1 millisecond')`;
}
