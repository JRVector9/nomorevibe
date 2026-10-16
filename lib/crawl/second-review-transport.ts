import type { ReviewInput } from "./agent-review-contract";
import { reviewWithAgent, REVIEW_CLI_TIMEOUT_MS, type AgentReviewResult } from "./agent-review";
import { reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS } from "./agent-review-gateway";
import { reviewWithGrokCli, GROK_REVIEW_TIMEOUT_MS } from "./agent-review-grok";
import { dispatchReviewFixtureCall, type ReviewFixtureCallBinding } from "./review-fixture-transport";

import type { SecondReviewItemReceipt } from "./second-review-ownership";

export type SecondReviewTransportBinding = Extract<ReviewFixtureCallBinding, { stage: "second" }>;

export function secondReviewTransportTimeoutMs(provider: SecondReviewTransportBinding["provider"]): number {
  return provider === "abcllm" ? REVIEW_GATEWAY_TIMEOUT_MS
    : provider === "grok-cli" ? GROK_REVIEW_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
}

export async function dispatchSecondReviewTransport(binding: SecondReviewTransportBinding, input: ReviewInput,
  options: { timeoutMs: number; signal?: AbortSignal; itemReceipt?: SecondReviewItemReceipt }): Promise<AgentReviewResult> {
  const fixture = await dispatchReviewFixtureCall(binding, input, options);
  if (fixture !== undefined) return fixture;
  const adapterOptions = { model: binding.model, timeoutMs: options.timeoutMs, signal: options.signal };
  return binding.provider === "abcllm" ? reviewWithGateway(input, adapterOptions)
    : binding.provider === "grok-cli" ? reviewWithGrokCli(input, adapterOptions)
      : reviewWithAgent(input, adapterOptions);
}
