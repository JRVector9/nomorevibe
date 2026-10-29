import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it("runtime review exports and wire max_tokens follow the registry after reload", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "fixture-only");
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS,
    deadlines: { "review-gateway": { engineMs: 20_000, relayMs: 25_000, gatewayMs: 30_000, clientMs: 35_000 } },
    limits: { "gateway-review": { maxTokens: 900, concurrency: 1 } } }));
  vi.resetModules();
  const { REVIEW_GATEWAY_TIMEOUT_MS, reviewWithGateway } = await import("@/lib/crawl/agent-review-gateway");
  expect(REVIEW_GATEWAY_TIMEOUT_MS).toBe(35_000);
  const request = vi.fn<typeof fetch>(async () => new Response("{}", { status: 503 }));
  const timer = vi.spyOn(AbortSignal, "timeout");
  const result = await reviewWithGateway({ snapshot: {} } as Parameters<typeof reviewWithGateway>[0], { model: "[supa] fixture", request });
  expect(result).toEqual({ ok: false, error: "gateway_error" });
  expect(timer).toHaveBeenCalledWith(35_000);
  expect(JSON.parse(String(request.mock.calls[0][1]?.body)).max_tokens).toBe(900);
  timer.mockRestore();
});
