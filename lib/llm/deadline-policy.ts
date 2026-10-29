import { z } from "zod";

/**
 * 기한 사다리: 안쪽 층이 항상 먼저 끝나야 바깥 층이 "모름"(indeterminate)을 만들지 않는다.
 * 모델 서버(엔진) 상한 < relay < gateway < client. 이웃 층 사이에는 시계 차이·전송 여유(skew) 이상을 둔다.
 * 값의 근거(기록된 지연 분포)는 docs/operations/2026-10-28-deadline-ladder.md 에 있다.
 */
export const DEADLINE_LADDER_SKEW_MS = 2_000;

const ms = z.number().int().min(1).max(3_600_000);
export const deadlineLadderSchema = z.object({
  engineMs: ms, relayMs: ms.nullable(), gatewayMs: ms, clientMs: ms,
}).strict();
export type DeadlineLadder = Readonly<z.infer<typeof deadlineLadderSchema>>;

/** 순서 위반 이유. 맞으면 null. */
export function deadlineLadderViolation(value: DeadlineLadder, skewMs = DEADLINE_LADDER_SKEW_MS): string | null {
  const parsed = deadlineLadderSchema.safeParse(value);
  if (!parsed.success) return "invalid_ladder";
  const layers = [parsed.data.engineMs, ...(parsed.data.relayMs === null ? [] : [parsed.data.relayMs]), parsed.data.gatewayMs, parsed.data.clientMs];
  for (let index = 1; index < layers.length; index++) if (layers[index] < layers[index - 1] + skewMs) return "deadline_order_inverted";
  return null;
}

/**
 * max_tokens 로 묶인 최악 생성 시간. 측정한 최저 decode 속도와 최대 prefill 시간이 있어야 계산한다.
 * 선언한 엔진 상한이 이 값보다 짧으면 정상 생성도 상한에 걸리므로 선언을 받지 않는다.
 */
export function worstGenerationMs(input: { maxOutputTokens: number; minDecodeTokensPerSec: number; maxPrefillMs: number }): number {
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || !(input.minDecodeTokensPerSec > 0)
    || !Number.isFinite(input.minDecodeTokensPerSec) || !Number.isSafeInteger(input.maxPrefillMs) || input.maxPrefillMs < 0)
    throw new Error("invalid_generation_bound");
  return Math.ceil(input.maxPrefillMs + input.maxOutputTokens * 1_000 / input.minDecodeTokensPerSec);
}
