import type { ReviewInput } from "./agent-review-contract";
import { reviewCliTimeoutMs, reviewWithAgent, type AgentReviewResult } from "./agent-review";
import { reviewGatewayTimeoutMs, reviewWithGateway } from "./agent-review-gateway";
import { grokReviewTimeoutMs, reviewWithGrokCli } from "./agent-review-grok";
import { dispatchReviewFixtureCall, type ReviewFixtureCallBinding } from "./review-fixture-transport";
import { CLI_TOOL_COMMANDS } from "@/lib/llm/cli-serving-contract";

import type { SecondReviewItemReceipt } from "./second-review-ownership";

export type SecondReviewTransportBinding = Extract<ReviewFixtureCallBinding, { stage: "second" }>;

/** 제공자별 전송 상한 — 부를 때의 등록부(관리자 실시간 한도 포함)를 읽는다 */
export function secondReviewTransportTimeoutMs(provider: SecondReviewTransportBinding["provider"]): number {
  return provider === "abcllm" || provider === "local-direct" ? reviewGatewayTimeoutMs()
    : provider === "grok-cli" ? grokReviewTimeoutMs() : reviewCliTimeoutMs();
}

export async function dispatchSecondReviewTransport(binding: SecondReviewTransportBinding, input: ReviewInput,
  options: { timeoutMs: number; signal?: AbortSignal; itemReceipt?: SecondReviewItemReceipt }): Promise<AgentReviewResult> {
  const fixture = await dispatchReviewFixtureCall(binding, input, options);
  if (fixture !== undefined) return fixture;
  // Direct AI2 requires an atomic item/model dispatch; compatibility paths never send it.
  if (binding.provider === "local-direct") return { ok: false, error: "not_configured" };
  const adapterOptions = { model: binding.model, timeoutMs: options.timeoutMs, signal: options.signal };
  // CLI 는 PATH 의 도구 이름으로 띄운다(env 경로를 읽지 않는다, PR C1)
  return binding.provider === "abcllm" ? reviewWithGateway(input, adapterOptions)
    : binding.provider === "grok-cli" ? reviewWithGrokCli(input, { ...adapterOptions, command: CLI_TOOL_COMMANDS["grok-cli"] })
      : reviewWithAgent(input, { ...adapterOptions, command: CLI_TOOL_COMMANDS["claude-cli"] });
}
