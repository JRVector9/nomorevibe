import { createServer } from "node:http";
import type { LookupAddress, LookupOptions } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetch as undiciFetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("tailnet names", () => {
  type Result = { error: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number };
  const notFound = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  const system = (answer: LookupAddress[] | null) => ((_host: string, _options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) =>
    callback(answer ? null : notFound, answer ?? [])) as never;
  async function lookup(host: string, options: LookupOptions, answer: LookupAddress[] | null, resolve4: (name: string) => Promise<string[]>): Promise<Result> {
    const { tailnetLookup } = await import("@/lib/net/tailnet-dns");
    return new Promise(resolve => tailnetLookup(host, options, (error, address, family) => resolve({ error, address, family }), resolve4, system(answer)));
  }
  it("asks Tailscale's resolver only for *.ts.net names the system resolver does not know", async () => {
    const asked: string[] = [];
    const resolve4 = async (name: string) => { asked.push(name); return ["100.111.160.31"]; };
    expect(await lookup("m1.tail0.ts.net", { all: true }, null, resolve4)).toEqual({ error: null, address: [{ address: "100.111.160.31", family: 4 }], family: undefined });
    expect(await lookup("m1.tail0.ts.net.", {}, null, resolve4)).toEqual({ error: null, address: "100.111.160.31", family: 4 });
    // The system answer wins, and other names never reach the tailnet resolver.
    expect(await lookup("m1.tail0.ts.net", { all: true }, [{ address: "100.1.1.1", family: 4 }], resolve4)).toMatchObject({ address: [{ address: "100.1.1.1", family: 4 }] });
    expect((await lookup("api.example.com", {}, null, resolve4)).error?.code).toBe("ENOTFOUND");
    expect(asked).toEqual(["m1.tail0.ts.net", "m1.tail0.ts.net"]);
    expect((await lookup("m1.tail0.ts.net", {}, null, async () => { throw new Error("timeout"); })).error).toBe(notFound);
    expect((await lookup("m1.tail0.ts.net", {}, null, async () => [])).error).toBe(notFound);
  });
  it("installs once over the default dispatcher and keeps ordinary requests working", async () => {
    const previous = getGlobalDispatcher();
    const http = createServer((_request, response) => response.end("ok"));
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as { port: number }).port;
    try {
      const { installTailnetDns } = await import("@/lib/net/tailnet-dns");
      expect(installTailnetDns()).toBe(true);
      expect(installTailnetDns()).toBe(false);
      expect(await (await undiciFetch(`http://localhost:${port}/`)).text()).toBe("ok");
      expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe("ok");
    } finally {
      setGlobalDispatcher(previous); delete (globalThis as Record<symbol, unknown>)[Symbol.for("nomorevibe.tailnetDns")];
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });
});

describe("registry overrides", () => {
  it("replace a code default by key, close a key whose override is invalid, and keep the defaults when the merge is invalid", async () => {
    const { DEFAULT_MODEL_DEFINITIONS, overlaidModelDefinitions, modelRequestName } = await import("@/lib/llm/model-registry");
    const m1 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!;
    const direct = { ...m1, baseUrl: "https://m1.tail0.ts.net/v1", gatewayLabel: undefined };
    delete (direct as { gatewayLabel?: string }).gatewayLabel;
    const merged = overlaidModelDefinitions([direct]);
    expect(merged.find(model => model.key === "m1:translation")).toMatchObject({ baseUrl: "https://m1.tail0.ts.net/v1" });
    expect(modelRequestName(merged.find(model => model.key === "m1:translation")!)).toBe("mlx-community--gemma-4-26b-a4b-it-4bit");
    expect(merged).toHaveLength(DEFAULT_MODEL_DEFINITIONS.length);
    expect(overlaidModelDefinitions([{ ...m1, timeoutMs: -1 }]).some(model => model.key === "m1:translation")).toBe(false);
    expect(overlaidModelDefinitions([direct, { ...direct }])).toHaveLength(DEFAULT_MODEL_DEFINITIONS.length);
  });
  it("are what readModelRegistry serves once the store holds them; an explicit MODEL_REGISTRY_CONFIG stays authoritative", async () => {
    const store = await import("@/lib/llm/serving-contract-store");
    const { DEFAULT_MODEL_DEFINITIONS, readModelRegistry, modelRequestName } = await import("@/lib/llm/model-registry");
    const m1 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!;
    const direct: Record<string, unknown> = { ...m1, baseUrl: "https://m1.tail0.ts.net/v1" };
    delete direct.gatewayLabel;
    try {
      store.setServingContractSnapshotForTest([], [direct]);
      expect(modelRequestName(readModelRegistry().models.find(model => model.key === "m1:translation")!)).toBe(m1.model);
      expect(readModelRegistry({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS }) })
        .models.find(model => model.key === "m1:translation")?.gatewayLabel).toBe("m1");
    } finally { store.setServingContractSnapshotForTest(null); }
    expect(readModelRegistry().models.find(model => model.key === "m1:translation")?.gatewayLabel).toBe("m1");
  });
  it("refuse a save that would make a purpose ambiguous or break a saved stage selection", async () => {
    const { checkRegistryOverrides } = await import("@/lib/operations/admin-model-registry");
    const { DEFAULT_MODEL_DEFINITIONS } = await import("@/lib/llm/model-registry");
    const m1 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!;
    expect(checkRegistryOverrides([{ ...m1, baseUrl: "https://m1.tail0.ts.net/v1" }], {})).toMatchObject({ ok: true });
    expect(checkRegistryOverrides([{ ...m1, key: "m1:second" }], {})).toEqual({ ok: false, reason: "model_purpose_duplicate" });
    expect(checkRegistryOverrides([{ ...m1, key: "m1:second", purposes: ["m1-spare"] }], { "product-translate": ["m1:second"] })).toMatchObject({ ok: true });
    expect(checkRegistryOverrides([{ ...m1, provider: "local-direct", gatewayLabel: undefined }], { "product-translate": ["m1:translation"] }))
      .toEqual({ ok: false, reason: "stage_pools_incompatible" });
    expect(checkRegistryOverrides([{ ...m1, timeoutMs: 0 }], {})).toEqual({ ok: false, reason: "model_definition_invalid" });
  });
});

describe("engine address", () => {
  it("normalizes to the /v1 base the route contracts require", async () => {
    const { engineBaseUrl } = await import("@/lib/operations/admin-engine-connect");
    expect(engineBaseUrl("https://m1.tail0.ts.net/v1")).toBe("https://m1.tail0.ts.net/v1");
    expect(engineBaseUrl(" https://m1.tail0.ts.net/v1/ ")).toBe("https://m1.tail0.ts.net/v1");
    expect(engineBaseUrl("https://m1.tail0.ts.net/v1/chat/completions")).toBe("https://m1.tail0.ts.net/v1");
    expect(engineBaseUrl("http://100.77.43.63:8090/v1")).toBe("http://100.77.43.63:8090/v1");
    for (const bad of ["https://m1.tail0.ts.net", "https://m1.tail0.ts.net/api/v1", "https://u:p@m1.tail0.ts.net/v1", "https://m1/v1?x=1", "ftp://m1/v1", "m1/v1"])
      expect(engineBaseUrl(bad)).toBeNull();
  });
});

describe("model identity across gateway and direct names", () => {
  it("drops the routing label and a publisher prefix, so Supa direct and Supa via the gateway are one model", async () => {
    const { bareModelName, underlyingReviewModel, sameUnderlyingModel } = await import("@/lib/crawl/review-model-identity");
    const { sameOpinionModel, secondOpinionFamily } = await import("@/lib/crawl/second-opinion-rules");
    expect(bareModelName("Inferact/Qwen3.8-27B-NVFP4")).toBe("qwen3.8-27b-nvfp4");
    expect(bareModelName("[supa] Qwen3.8-27B-NVFP4")).toBe("qwen3.8-27b-nvfp4");
    expect(sameUnderlyingModel("Inferact/Qwen3.8-27B-NVFP4", "[supa] Qwen3.8-27B-NVFP4")).toBe(true);
    expect(sameOpinionModel("Inferact/Qwen3.8-27B-NVFP4", "[supa] Qwen3.8-27B-NVFP4")).toBe(true);
    expect(secondOpinionFamily("Inferact/Qwen3.8-27B-NVFP4")).toBe("qwen");
    // Unchanged for the existing names.
    expect(underlyingReviewModel("[gpu3090] qwen3.8-flash-next+vision")).toBe("qwen3.8-flash-next");
    expect(bareModelName("mlx-community--gemma-4-26b-a4b-it-4bit")).toBe("mlx-community--gemma-4-26b-a4b-it-4bit");
    expect(sameUnderlyingModel("qwen3.8-flash-next", "[supa] Qwen3.8-27B-NVFP4")).toBe(false);
  });
});

describe("response model probe", () => {
  it("returns the name the engine answers with, or null for anything but a chat completion", async () => {
    const { probeResponseModel } = await import("@/lib/operations/admin-engine-connect");
    const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
    expect(await probeResponseModel("http://e/v1/chat/completions", "Inferact/Q", null, answer({ object: "chat.completion", model: "local-llm" }))).toBe("local-llm");
    expect(await probeResponseModel("http://e/v1/chat/completions", "m", null, answer({ object: "chat.completion", model: "" }))).toBeNull();
    expect(await probeResponseModel("http://e/v1/chat/completions", "m", null, answer({ error: "x" }, 404))).toBeNull();
    expect(await probeResponseModel("http://e/v1/chat/completions", "m", null, (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeNull();
  });
});
