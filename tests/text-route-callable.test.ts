import { afterEach, describe, expect, it, vi } from "vitest";
import { setServingContractSnapshotForTest, textRouteCallable } from "@/lib/llm/serving-contract-store";

const row = (transport: "direct" | "gateway", auth: "stored" | "none" | "gateway" = "none") =>
  ({ routeId: "product-translate", model: "gemma-direct", contract: {}, auth, apiKey: auth === "stored" ? "engine-key" : null, transport });

describe("text routes without the abcLLM gateway key", () => {
  afterEach(() => { setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); });

  it("a directly connected engine is callable with no gateway key, keyless or with its own stored key", () => {
    vi.stubEnv("ABCLLM_API_KEY", "");
    setServingContractSnapshotForTest([row("direct")]);
    expect(textRouteCallable("product-translate", "gemma-direct")).toBe(true);
    setServingContractSnapshotForTest([row("direct", "stored")]);
    expect(textRouteCallable("product-translate", "gemma-direct")).toBe(true);
  });

  it("anything else still needs the gateway key: another route or model, or a gateway contract", () => {
    vi.stubEnv("ABCLLM_API_KEY", "");
    setServingContractSnapshotForTest([row("direct"), { ...row("gateway", "gateway"), model: "[MLX] gpt-oss-120b" }]);
    expect(textRouteCallable("reason-translate", "gemma-direct")).toBe(false);
    expect(textRouteCallable("product-translate", "other-model")).toBe(false);
    expect(textRouteCallable("product-translate", "[MLX] gpt-oss-120b")).toBe(false);
    vi.stubEnv("ABCLLM_API_KEY", "gateway-key");
    expect(textRouteCallable("product-translate", "[MLX] gpt-oss-120b")).toBe(true);
  });
});
