import { afterEach, describe, expect, it, vi } from "vitest";
import { setServingContractSnapshotForTest, TEXT_ROUTE_BLOCK_DETAIL, textRouteBlock, textRouteCallable } from "@/lib/llm/serving-contract-store";

const row = (transport: "direct" | "gateway", auth: "stored" | "none" | "gateway" = "none", apiKey: string | null = auth === "stored" ? "engine-key" : null) =>
  ({ routeId: "product-translate", model: "gemma-direct", contract: {}, auth, apiKey, transport });

describe("text routes open only on a directly connected engine (abcLLM gateway removed 2026-10-30)", () => {
  afterEach(() => { setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); });

  it("a directly connected engine is callable, keyless or with its own stored key, with no env key at all", () => {
    vi.stubEnv("ABCLLM_API_KEY", undefined);
    setServingContractSnapshotForTest([row("direct")]);
    expect(textRouteBlock("product-translate", "gemma-direct")).toBeNull();
    expect(textRouteCallable("product-translate", "gemma-direct")).toBe(true);
    setServingContractSnapshotForTest([row("direct", "stored")]);
    expect(textRouteCallable("product-translate", "gemma-direct")).toBe(true);
  });

  it("names why a route is closed: no direct contract, gateway auth, or an unreadable stored key", () => {
    setServingContractSnapshotForTest([row("direct"), { ...row("gateway", "none"), model: "[MLX] gpt-oss-120b" }]);
    expect(textRouteBlock("reason-translate", "gemma-direct")).toBe("no_direct_contract");
    expect(textRouteBlock("product-translate", "other-model")).toBe("no_direct_contract");
    // A gateway-transport contract no longer opens anything.
    expect(textRouteBlock("product-translate", "[MLX] gpt-oss-120b")).toBe("no_direct_contract");
    setServingContractSnapshotForTest([row("direct", "gateway")]);
    expect(textRouteBlock("product-translate", "gemma-direct")).toBe("gateway_auth");
    setServingContractSnapshotForTest([row("direct", "stored", null)]);
    expect(textRouteBlock("product-translate", "gemma-direct")).toBe("stored_key_unreadable");
    for (const detail of Object.values(TEXT_ROUTE_BLOCK_DETAIL)) expect(detail).not.toMatch(/ABCLLM/);
  });

  it("the old gateway key opens nothing any more", () => {
    vi.stubEnv("ABCLLM_API_KEY", "gateway-key");
    setServingContractSnapshotForTest([{ ...row("gateway", "gateway"), model: "[MLX] gpt-oss-120b" }]);
    expect(textRouteCallable("product-translate", "[MLX] gpt-oss-120b")).toBe(false);
    setServingContractSnapshotForTest([]);
    expect(textRouteCallable("product-translate", "gemma-direct")).toBe(false);
  });
});
