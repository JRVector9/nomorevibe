import { afterEach, describe, expect, it, vi } from "vitest";
import { setServingContractSnapshotForTest, TEXT_ROUTE_BLOCK_DETAIL, textRouteAccess, textRouteBlock, textRouteCallable } from "@/lib/llm/serving-contract-store";

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

  // PR 3b-C, merged with the gateway removal: the tick gate and the senders' bearer (contractBearer) are one decision — textRouteAccess.
  it("is the senders' bearer rule: no key sends none, a stored key only when it opens; gateway auth and gateway transport are closed", () => {
    vi.stubEnv("ABCLLM_API_KEY", "gateway-key");
    expect(textRouteAccess("product-translate", "gemma-direct")).toEqual({ block: "no_direct_contract" });
    setServingContractSnapshotForTest([row("direct")]);
    expect(textRouteAccess("product-translate", "gemma-direct")).toEqual({ block: null, bearer: null });
    setServingContractSnapshotForTest([row("direct", "stored")]);
    expect(textRouteAccess("product-translate", "gemma-direct")).toEqual({ block: null, bearer: "engine-key" });
    setServingContractSnapshotForTest([row("direct", "stored", null)]);
    expect(textRouteAccess("product-translate", "gemma-direct")).toEqual({ block: "stored_key_unreadable" });
    setServingContractSnapshotForTest([row("gateway", "none")]);
    expect(textRouteCallable("product-translate", "gemma-direct")).toBe(false);
    setServingContractSnapshotForTest([row("gateway", "stored")]);
    expect(textRouteCallable("product-translate", "gemma-direct")).toBe(false);
    setServingContractSnapshotForTest([row("direct", "gateway")]);
    expect(textRouteAccess("product-translate", "gemma-direct")).toEqual({ block: "gateway_auth" });
    setServingContractSnapshotForTest([]);
    expect(textRouteCallable("crawl-tagline", "any-model")).toBe(false);
  });

  // PR 3b-C: a local-direct contract (AI1·AI2 direct-openai-chat-v1, the engine's own name on the wire) is direct by definition —
  // whatever the row's transport flag says — and sends no key unless its row stores one.
  it("treats a local-direct contract as a directly connected engine, open with no key unless its row stores one", () => {
    const local = { routeId: "crawl-agent-review", model: "qwen3.6-35b", contract: { provider: "local-direct", protocol: "direct-openai-chat-v1" },
      auth: "none" as const, apiKey: null, transport: "gateway" as const };
    setServingContractSnapshotForTest([local]);
    expect(textRouteAccess("crawl-agent-review", "qwen3.6-35b")).toEqual({ block: null, bearer: null });
    expect(textRouteCallable("crawl-agent-review", "qwen3.6-35b")).toBe(true);
    // gateway auth on an engine row means "no key" to the senders — the gate says the same
    setServingContractSnapshotForTest([{ ...local, auth: "gateway" }]);
    expect(textRouteAccess("crawl-agent-review", "qwen3.6-35b")).toEqual({ block: null, bearer: null });
    setServingContractSnapshotForTest([{ ...local, auth: "stored", apiKey: "engine-key" }]);
    expect(textRouteAccess("crawl-agent-review", "qwen3.6-35b")).toEqual({ block: null, bearer: "engine-key" });
    setServingContractSnapshotForTest([{ ...local, auth: "stored", apiKey: null }]);
    expect(textRouteAccess("crawl-agent-review", "qwen3.6-35b")).toEqual({ block: "stored_key_unreadable" });
    // a sender holding a parsed local-direct contract is open without any row (the AI2 contract fixtures); an abcllm one is not
    setServingContractSnapshotForTest([]);
    expect(textRouteAccess("second-review", "qwen3.6-35b", "local-direct")).toEqual({ block: null, bearer: null });
    expect(textRouteAccess("second-review", "qwen3.6-35b", "abcllm")).toEqual({ block: "no_direct_contract" });
  });
});
