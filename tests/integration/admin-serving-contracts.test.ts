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
    // The 1-token probe answers with the engine's own name (vLLM: its first served name), not necessarily the requested one.
    if (init?.method === "POST") return Response.json({ object: "chat.completion", model: `${JSON.parse(String(init.body)).model}-served` });
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
  expect(seen.slice(-2)).toEqual([{ url: `${BASE}/models`, auth: "Bearer engine-secret-1" }, { url: `${BASE}/chat/completions`, auth: "Bearer engine-secret-1" }]);
  expect(result.responseModel).toBe(`${ENGINE}-served`);
  const rows = (await listAdminServingContracts()).filter(row => row.enabled && row.model === ENGINE);
  expect(rows.map(row => [row.routeId, row.auth, row.transport, row.hasKey, row.contract.endpoint, row.contract.totalTokenBound, row.contract.responseModel])).toEqual([
    ["product-translate", "stored", "direct", true, `${BASE}/chat/completions`, 98304, `${ENGINE}-served`],
    ["reason-translate", "stored", "direct", true, `${BASE}/chat/completions`, 98304, `${ENGINE}-served`]]);
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
  expect(seen.slice(-2).map(row => row.auth)).toEqual(["Bearer engine-secret-1", "Bearer engine-secret-1"]);
  expect(await disableAdminRegistryOverride("m1:translation", "jr")).toBe(true);
  await store.refreshServingContracts();
  expect(readModelRegistry().models.find(model => model.key === "m1:translation")?.gatewayLabel).toBe("m1");
});

it("engine connect for Supa: keyless direct contracts for AI1 and text routes, and the 1차 selection follows the new engine name", async () => {
  const { connectAdminEngine } = await import("@/lib/operations/admin-engine-connect");
  const { saveSettings, getSettings } = await import("@/lib/crawl/settings");
  const { listAdminServingContracts } = await import("@/lib/operations/admin-serving-contracts");
  const ENGINE = "Inferact/Qwen3.8-27B-NVFP4", BASE = "http://100.78.219.124:8000/v1";
  vi.stubEnv("DATABASE_URL", url.toString());
  expect(await saveSettings({ firstReview: { provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" } }, "jr")).toMatchObject({ ok: true });
  const auth: (string | null)[] = [];
  const vllm = (async (_target: string, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    return init?.method === "POST" ? Response.json({ object: "chat.completion", model: "local-llm" })
      : Response.json({ data: [{ id: "local-llm", max_model_len: 131072 }, { id: ENGINE, max_model_len: 131072 }] });
  }) as typeof fetch;
  const result = await connectAdminEngine({ registryKey: "supa:review", baseUrl: BASE, auth: "none", engineModel: ENGINE,
    routes: ["crawl-agent-review", "product-search-verify", "crawl-tagline"], selectStages: true }, "jr", vllm);
  expect(result).toMatchObject({ requestModel: ENGINE, responseModel: "local-llm", firstReviewRenamed: true, totalTokenBound: 131072,
    stages: ["product-search-verify", "crawl-tagline"] });
  expect(auth).toEqual([null, null]);
  expect((await getSettings()).firstReview).toEqual({ provider: "abcllm", model: ENGINE });
  const rows = (await listAdminServingContracts()).filter(row => row.enabled && row.model === ENGINE);
  expect(rows.map(row => [row.routeId, row.auth, row.transport, row.contract.responseModel])).toEqual([["crawl-agent-review", "none", "direct", "local-llm"],
    ["crawl-tagline", "none", "direct", "local-llm"], ["product-search-verify", "none", "direct", "local-llm"]]);
  // The direct and gateway names of Supa are one model for independence checks, in TS and in SQL.
  const { underlyingReviewModel } = await import("@/lib/crawl/review-model-identity");
  const { underlyingModelSql } = await import("@/lib/crawl/held-qwen-retry-policy");
  const { sql } = await import("drizzle-orm");
  const { db } = await import("@/lib/db");
  expect(underlyingReviewModel(ENGINE)).toBe(underlyingReviewModel("[supa] Qwen3.8-27B-NVFP4"));
  const [row] = await db.execute<{ a: string; b: string }>(sql`SELECT ${underlyingModelSql(sql`${ENGINE}::text`)} a, ${underlyingModelSql(sql`'[supa] Qwen3.8-27B-NVFP4'::text`)} b`);
  expect([row.a, row.b]).toEqual(["qwen3.8-27b-nvfp4", "qwen3.8-27b-nvfp4"]);
  // A reconnect to another served name starts from the overridden definition: the 1차 selection follows from the
  // previous engine name, and an admin-set limit survives (it used to fall back to the code default).
  const { saveAdminRegistryOverride } = await import("@/lib/operations/admin-model-registry");
  const { readModelRegistry } = await import("@/lib/llm/model-registry");
  const { ensureServingContracts } = await import("@/lib/llm/serving-contract-store");
  await ensureServingContracts(0);
  const connected = readModelRegistry().models.find(model => model.key === "supa:review")!;
  expect(connected).toMatchObject({ model: ENGINE });
  await saveAdminRegistryOverride({ ...connected, timeoutMs: 120_000 }, "jr", "longer bound");
  const again = await connectAdminEngine({ registryKey: "supa:review", baseUrl: BASE, auth: "none", engineModel: "local-llm",
    routes: ["crawl-agent-review"], selectStages: true }, "jr", vllm);
  expect(again).toMatchObject({ requestModel: "local-llm", firstReviewRenamed: true });
  expect((await getSettings()).firstReview).toEqual({ provider: "abcllm", model: "local-llm" });
  await ensureServingContracts(0);
  expect(readModelRegistry().models.find(model => model.key === "supa:review")).toMatchObject({ model: "local-llm", timeoutMs: 120_000 });
});

it("engine connect without max_model_len (mlx_lm.server, M3 mlx-serve): the typed bound stands in and is marked; a typed bound never overrides a served one", async () => {
  const { connectAdminEngine } = await import("@/lib/operations/admin-engine-connect");
  const { listAdminServingContracts } = await import("@/lib/operations/admin-serving-contracts");
  const { listAdminRegistryOverrides, disableAdminRegistryOverride } = await import("@/lib/operations/admin-model-registry");
  const ENGINE = "mlx-community--gemma-4-26b-a4b-it-4bit", BASE = "https://m1.tail0.ts.net/v1";
  vi.stubEnv("DATABASE_URL", url.toString());
  // The same engine with and without max_model_len in its /models answer.
  const engine = (served: number | null) => (async (_target: string, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ object: "chat.completion", model: ENGINE }) : Response.json({ data: [{ id: ENGINE, ...(served ? { max_model_len: served } : {}) }] })) as typeof fetch;
  const input = { registryKey: "m1:translation", baseUrl: BASE, auth: "none" as const, engineModel: ENGINE, routes: ["product-translate"], selectStages: false };
  const before = (await listAdminServingContracts()).length;
  // Omitted: the operator must type the bound, a positive integer up to the ceiling.
  await expect(connectAdminEngine(input, "jr", engine(null))).rejects.toThrow("engine_max_len_unknown");
  for (const bad of [0, -1, 1.5, 2_097_153]) await expect(connectAdminEngine({ ...input, maxModelLen: bad }, "jr", engine(null))).rejects.toThrow("engine_max_len_invalid");
  // Reported: the served value is authoritative — a different typed value is refused with both numbers, an equal one passes.
  await expect(connectAdminEngine({ ...input, maxModelLen: 131072 }, "jr", engine(98304))).rejects.toThrow("engine_max_len_mismatch:98304:131072");
  expect((await listAdminServingContracts()).length).toBe(before);
  expect(await connectAdminEngine({ ...input, maxModelLen: 98304 }, "jr", engine(98304))).toMatchObject({ totalTokenBound: 98304, totalTokenBoundFrom: "engine" });
  expect(await connectAdminEngine({ ...input, maxModelLen: 131072, note: "M1 mlx_lm.server" }, "jr", engine(null))).toMatchObject({ totalTokenBound: 131072, totalTokenBoundFrom: "operator" });
  // The typed bound is the contract's bound, and its origin is in the revision and the note (so in the save audit); the engine-read one is unmarked.
  const rows = (await listAdminServingContracts()).filter(row => row.routeId === "product-translate" && row.model === ENGINE);
  expect(rows.slice(0, 2).map(row => [row.enabled, row.contract.totalTokenBound, row.contract.deploymentRevision, row.note])).toEqual([
    [true, 131072, `direct-m1-${ENGINE}-C131072-operator-bound`, "M1 mlx_lm.server · 컨텍스트 상한 운영자 입력 131072"],
    [false, 98304, `direct-m1-${ENGINE}-C98304`, `엔진 연결 ${BASE}`]]);
  const [audit] = await client`SELECT detail::text detail FROM operations_audit WHERE action='model-serving-contract-save' ORDER BY id DESC LIMIT 1`;
  expect(audit.detail).toContain("컨텍스트 상한 운영자 입력 131072");
  expect((await listAdminRegistryOverrides()).find(row => row.enabled && row.key === "m1:translation")?.note).toBe("M1 mlx_lm.server");
  expect(await disableAdminRegistryOverride("m1:translation", "jr")).toBe(true);
});
