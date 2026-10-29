import { expect, it } from "vitest";
import { deadlineLadderViolation, PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS, REVIEW_GATEWAY_LADDER, worstGenerationMs } from "@/lib/llm/deadline-ladder";
import { REVIEW_GATEWAY_TIMEOUT_MS } from "@/lib/crawl/agent-review-gateway";

it("declared ladders keep engine < relay < gateway < client with skew between neighbours", () => {
  expect(deadlineLadderViolation(REVIEW_GATEWAY_LADDER)).toBeNull();
  // The AI review client is unchanged at 60s; only inner layers are declared.
  expect(REVIEW_GATEWAY_TIMEOUT_MS).toBe(60_000);
  // Product translation client must fit the 55s job budget with the 2s record margin.
  expect(PRODUCT_TRANSLATION_CLIENT_TIMEOUT_MS + 2_000).toBeLessThanOrEqual(55_000);
});

it("rejects inverted or too-close layers, including the old client-first order", () => {
  // Old reality: client 20s, relay 90s, gateway 600s read.
  expect(deadlineLadderViolation({ engineMs: 3_600_000, relayMs: 90_000, gatewayMs: 600_000, clientMs: 20_000 })).toBe("deadline_order_inverted");
  expect(deadlineLadderViolation({ engineMs: 45_000, relayMs: null, gatewayMs: 46_000, clientMs: 60_000 })).toBe("deadline_order_inverted");
  expect(deadlineLadderViolation({ engineMs: 45_000, relayMs: null, gatewayMs: 47_000, clientMs: 60_000 })).toBeNull();
  expect(deadlineLadderViolation({ engineMs: 0, relayMs: null, gatewayMs: 1, clientMs: 2 })).toBe("invalid_ladder");
});

it("bounds worst-case generation by max_tokens, measured decode speed and prefill", () => {
  expect(worstGenerationMs({ maxOutputTokens: 3_000, minDecodeTokensPerSec: 100, maxPrefillMs: 5_000 })).toBe(35_000);
  expect(() => worstGenerationMs({ maxOutputTokens: 3_000, minDecodeTokensPerSec: 0, maxPrefillMs: 0 })).toThrow("invalid_generation_bound");
  expect(() => worstGenerationMs({ maxOutputTokens: 0, minDecodeTokensPerSec: 10, maxPrefillMs: 0 })).toThrow("invalid_generation_bound");
});
