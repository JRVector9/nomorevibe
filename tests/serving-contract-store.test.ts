import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const BOX = randomBytes(32).toString("base64");
const endpoint = (host: string) => `http://${host}:8090/v1/chat/completions`;
const ai1 = (model: string, host = "gateway") => ({ version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm",
  model, responseModel: model, deploymentRevision: "rev", endpoint: endpoint(host), totalTokenBound: 50000 });

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
async function load() {
  // The removed env contract list and gateway key are set to prove they are ignored.
  vi.stubEnv("ABCLLM_SERVING_CONTRACTS", JSON.stringify({ version: 1, contracts: [ai1("env-model")] }));
  vi.stubEnv("ABCLLM_API_KEY", "gateway-key");
  vi.stubEnv("NMV_SECRET_BOX_KEY", BOX);
  vi.resetModules();
  const store = await import("@/lib/llm/serving-contract-store");
  const ai1Module = await import("@/lib/crawl/agent-review-serving-contract");
  const box = await import("@/lib/security/secret-box");
  const gateway = await import("@/lib/crawl/agent-review-gateway");
  return { store, resolve: ai1Module.resolveAi1GatewayServingContract, box, contractBearer: gateway.contractBearer };
}
const row = (contract: ReturnType<typeof ai1>, auth: "gateway" | "none" | "stored" = "gateway", apiKey: string | null = null,
  transport: "gateway" | "direct" = "direct") => ({ routeId: contract.routeId, model: contract.model, contract, auth, apiKey, transport });

describe("secret box", () => {
  it("round-trips only for the same row identity and refuses without its key", async () => {
    const { box } = await load();
    const sealed = box.sealSecret("sk-live", box.servingContractKeyAad("crawl-agent-review", "m"));
    expect(sealed).not.toContain("sk-live");
    expect(box.openSecret(sealed, box.servingContractKeyAad("crawl-agent-review", "m"))).toBe("sk-live");
    expect(box.openSecret(sealed, box.servingContractKeyAad("second-review", "m"))).toBeNull();
    expect(box.openSecret(sealed, box.servingContractKeyAad("crawl-agent-review", "m"), { NMV_SECRET_BOX_KEY: randomBytes(32).toString("base64") })).toBeNull();
    expect(() => box.sealSecret("x", "aad", {})).toThrow("secret_box_key_missing");
  });
  it("decrypts stored keys into the snapshot; a moved ciphertext stays closed", async () => {
    const { store, box } = await load();
    const sealed = box.sealSecret("sk-1", box.servingContractKeyAad("crawl-agent-review", "a"));
    const snapshot = store.servingContractSnapshotFromRows([
      { route_id: "crawl-agent-review", model: "a", contract: ai1("a"), auth: "stored", api_key_ciphertext: sealed, updated_at: "t" },
      { route_id: "crawl-agent-review", model: "b", contract: ai1("b"), auth: "stored", api_key_ciphertext: sealed, updated_at: "t" }]);
    expect(snapshot.rows.map(entry => entry.apiKey)).toEqual(["sk-1", null]);
  });
});

describe("live gateway contracts", () => {
  it("reads admin rows only (no env contracts), closes a model whose admin row is invalid, and closes it when switched off", async () => {
    const { store, resolve } = await load();
    store.setServingContractSnapshotForTest([row(ai1("admin-model", "gpu3090")), row(ai1("shared", "gpu3090"))]);
    expect(resolve("env-model")).toBeNull();
    expect(resolve("admin-model")?.endpoint).toBe(endpoint("gpu3090"));
    expect(resolve("shared")?.endpoint).toBe(endpoint("gpu3090"));
    store.setServingContractSnapshotForTest([row({ ...ai1("shared"), protocol: "other" } as never)]);
    expect(resolve("shared")).toBeNull();
    expect(resolve("admin-model")).toBeNull();
    store.setServingContractSnapshotForTest([]);
    expect(resolve("shared")).toBeNull();
    expect(resolve("env-model")).toBeNull();
  });
  it("never lets a row of another route or model identity fill a contract", async () => {
    const { store, resolve } = await load();
    store.setServingContractSnapshotForTest([{ ...row(ai1("x")), model: "y" }, { ...row(ai1("z")), routeId: "second-review" }]);
    expect(resolve("x")).toBeNull(); expect(resolve("y")).toBeNull(); expect(resolve("z")).toBeNull();
  });
});

describe("contract bearer", () => {
  it("opens an abcllm contract only as a direct engine with no key or its own stored key — never the gateway key", async () => {
    const { store, contractBearer } = await load();
    const contract = (model: string, provider = "abcllm") => ({ routeId: "crawl-agent-review", model, provider });
    store.setServingContractSnapshotForTest([row(ai1("none"), "none"), row(ai1("stored"), "stored", "sk-9"), row(ai1("closed"), "stored", null),
      row(ai1("gw"), "gateway"), row(ai1("via-gateway"), "none", null, "gateway")]);
    expect(contractBearer(contract("default"))).toBeUndefined();
    expect(contractBearer(contract("gw"))).toBeUndefined();
    expect(contractBearer(contract("via-gateway"))).toBeUndefined();
    expect(contractBearer(contract("none"))).toBeNull();
    expect(contractBearer(contract("stored"))).toBe("sk-9");
    expect(contractBearer(contract("closed"))).toBeUndefined();
    // AI2 local-direct contracts without an admin row still send no key.
    expect(contractBearer(contract("direct", "local-direct"))).toBeNull();
    expect(contractBearer(contract("gw", "local-direct"))).toBeNull();
  });
});
