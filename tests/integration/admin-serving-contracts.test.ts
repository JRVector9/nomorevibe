import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { TEST_DATABASE_URL } from "./setup";

// Own disposable DB; production and model endpoints are never touched.
const name = `nomorevibe_test_contracts_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
let created = false;
const contract = (model: string, host = "100.77.43.63") => ({ version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm",
  model, responseModel: model, deploymentRevision: "gpu3090-vllm-C50000", endpoint: `http://${host}:8090/v1/chat/completions`, totalTokenBound: 50000 });
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  vi.stubEnv("NMV_SECRET_BOX_KEY", randomBytes(32).toString("base64"));
}, 120000);
afterAll(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});

it("saves a validated contract, keeps the previous one as disabled history, and audits without the key", async () => {
  const { saveAdminServingContract, listAdminServingContracts } = await import("@/lib/operations/admin-serving-contracts");
  const first = await saveAdminServingContract({ routeId: "crawl-agent-review", contract: contract("qwen3.8-flash-next"), auth: "none" }, "jr");
  const second = await saveAdminServingContract({ routeId: "crawl-agent-review", contract: contract("qwen3.8-flash-next"), auth: "stored", apiKey: "sk-secret-1" }, "jr");
  const rows = (await listAdminServingContracts()).filter(row => row.model === "qwen3.8-flash-next");
  expect(rows.map(row => [row.id, row.enabled, row.auth, row.hasKey])).toEqual([[second.id, true, "stored", true], [first.id, false, "none", false]]);
  const [raw] = await client`SELECT api_key_ciphertext FROM model_serving_contracts WHERE id=${second.id}`;
  expect(raw.api_key_ciphertext).not.toContain("sk-secret-1");
  const audits = await client`SELECT action, detail::text detail FROM operations_audit WHERE action LIKE 'model-serving-contract-%' ORDER BY id`;
  expect(audits.map(row => row.action)).toEqual(["model-serving-contract-save", "model-serving-contract-save"]);
  expect(audits.some(row => row.detail.includes("sk-secret-1"))).toBe(false);
  // Empty key keeps the stored one.
  await saveAdminServingContract({ routeId: "crawl-agent-review", contract: contract("qwen3.8-flash-next"), auth: "stored" }, "jr");
  const [kept] = await client`SELECT api_key_ciphertext FROM model_serving_contracts WHERE enabled AND model='qwen3.8-flash-next'`;
  expect(kept.api_key_ciphertext).toBe(raw.api_key_ciphertext);
});

it("refuses a contract that does not match its route schema or a stored mode without a key", async () => {
  const { saveAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
  await expect(saveAdminServingContract({ routeId: "crawl-agent-review", contract: { ...contract("m"), protocol: "other" }, auth: "gateway" }, "jr")).rejects.toThrow("contract_schema_invalid");
  await expect(saveAdminServingContract({ routeId: "crawl-agent-review", contract: { ...contract("m"), endpoint: "http://h/v1/other" }, auth: "gateway" }, "jr")).rejects.toThrow("contract_schema_invalid");
  await expect(saveAdminServingContract({ routeId: "unknown-route", contract: contract("m"), auth: "gateway" }, "jr")).rejects.toThrow("unknown_route");
  await expect(saveAdminServingContract({ routeId: "crawl-agent-review", contract: contract("fresh"), auth: "stored" }, "jr")).rejects.toThrow("serving_contract_key_required");
});

it("the DB itself refuses identity drift and a stored mode without ciphertext", async () => {
  const insert = (overrides: Record<string, unknown>) => client`INSERT INTO model_serving_contracts ${client({ route_id: "crawl-agent-review", model: "m2",
    contract: JSON.stringify(contract("m2")), contract_hash: "a".repeat(64), auth: "gateway", updated_by: "jr", ...overrides } as Record<string, string>)}`;
  await expect(insert({ model: "other" })).rejects.toThrow();
  await expect(insert({ auth: "stored" })).rejects.toThrow();
  await expect(insert({ contract_hash: "short" })).rejects.toThrow();
});

it("a process reload serves the admin contract and its decrypted key; switching it off removes it", async () => {
  const store = await import("@/lib/llm/serving-contract-store");
  const { disableAdminServingContract } = await import("@/lib/operations/admin-serving-contracts");
  vi.stubEnv("DATABASE_URL", url.toString());
  await store.refreshServingContracts();
  expect(store.servingContractAuth("crawl-agent-review", "qwen3.8-flash-next")).toEqual({ mode: "stored", apiKey: "sk-secret-1", transport: "gateway" });
  expect(await disableAdminServingContract("crawl-agent-review", "qwen3.8-flash-next", "jr")).toBe(true);
  await store.refreshServingContracts();
  expect(store.servingContractAuth("crawl-agent-review", "qwen3.8-flash-next")).toBeNull();
});

it("engine connect repoints one registry key, writes direct contracts with the stored key and selects the stages in one step", async () => {
  const { connectAdminEngine } = await import("@/lib/operations/admin-engine-connect");
  const { listAdminServingContracts } = await import("@/lib/operations/admin-serving-contracts");
  const { listAdminRegistryOverrides, disableAdminRegistryOverride } = await import("@/lib/operations/admin-model-registry");
  const store = await import("@/lib/llm/serving-contract-store");
  const { readModelRegistry, modelRequestName } = await import("@/lib/llm/model-registry");
  const { getSettings } = await import("@/lib/crawl/settings");
  const ENGINE = "mlx-community--gemma-4-26b-a4b-it-4bit", BASE = "https://m1.tail0.ts.net/v1";
  vi.stubEnv("DATABASE_URL", url.toString());
  const seen: { url: string; auth: string | null }[] = [];
  const engine = (async (target: string, init?: RequestInit) => {
    seen.push({ url: target, auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ data: [{ id: ENGINE, max_model_len: 98304 }, { id: "other", max_model_len: 8192 }] });
  }) as typeof fetch;
  const input = { registryKey: "m1:translation", baseUrl: `${BASE}/`, auth: "stored" as const, apiKey: "engine-secret-1", engineModel: ENGINE,
    routes: ["product-translate", "reason-translate"], selectStages: true };
  const before = (await listAdminServingContracts()).length;
  await expect(connectAdminEngine({ ...input, engineModel: "missing" }, "jr", engine)).rejects.toThrow("engine_model_not_found");
  await expect(connectAdminEngine({ ...input, baseUrl: "https://m1.tail0.ts.net" }, "jr", engine)).rejects.toThrow("engine_base_url_invalid");
  expect((await listAdminServingContracts()).length).toBe(before);

  const result = await connectAdminEngine(input, "jr", engine);
  expect(result).toMatchObject({ requestModel: ENGINE, totalTokenBound: 98304, stages: ["reason-translate", "product-translate"] });
  expect(result.missingPolicyRoutes).toEqual([`product-translate / abcllm / ${ENGINE}`, `reason-translate / abcllm / ${ENGINE}`]);
  expect(seen.at(-1)).toEqual({ url: `${BASE}/models`, auth: "Bearer engine-secret-1" });
  const rows = (await listAdminServingContracts()).filter(row => row.enabled && row.model === ENGINE);
  expect(rows.map(row => [row.routeId, row.auth, row.transport, row.hasKey, row.contract.endpoint, row.contract.totalTokenBound])).toEqual([
    ["product-translate", "stored", "direct", true, `${BASE}/chat/completions`, 98304], ["reason-translate", "stored", "direct", true, `${BASE}/chat/completions`, 98304]]);
  const [override] = (await listAdminRegistryOverrides()).filter(row => row.enabled);
  expect(override.definition).toMatchObject({ key: "m1:translation", baseUrl: BASE, model: ENGINE, provider: "abcllm" });
  expect(override.definition).not.toHaveProperty("gatewayLabel");
  expect((await getSettings()).stageModelPools).toMatchObject({ "product-translate": ["m1:translation"], "reason-translate": ["m1:translation"] });
  const audits = await client`SELECT action, detail::text detail FROM operations_audit WHERE action IN ('model-serving-contract-save','model-registry-override-save') ORDER BY id`;
  expect(audits.some(row => row.detail.includes("engine-secret-1"))).toBe(false);

  // Every app: the next reload serves the bare engine name, its direct contract and the decrypted key.
  await store.refreshServingContracts();
  expect(modelRequestName(readModelRegistry().models.find(model => model.key === "m1:translation")!)).toBe(ENGINE);
  expect(store.servingContractAuth("product-translate", ENGINE)).toEqual({ mode: "stored", apiKey: "engine-secret-1", transport: "direct" });
  const { resolveProductTranslationServingContract } = await import("@/lib/llm/product-translation-serving-contract");
  expect(resolveProductTranslationServingContract(ENGINE)).toMatchObject({ endpoint: `${BASE}/chat/completions`, strictTerminalOptIn: "abcllm-strict-terminal-v1" });

  // Reconnecting without a key reuses the stored one; reverting brings the code default back under the same key.
  await connectAdminEngine({ ...input, apiKey: undefined, routes: ["product-translate"], selectStages: false }, "jr", engine);
  expect(seen.at(-1)?.auth).toBe("Bearer engine-secret-1");
  expect(await disableAdminRegistryOverride("m1:translation", "jr")).toBe(true);
  await store.refreshServingContracts();
  expect(readModelRegistry().models.find(model => model.key === "m1:translation")?.gatewayLabel).toBe("m1");
});
