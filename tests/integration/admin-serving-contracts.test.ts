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
  expect(store.servingContractAuth("crawl-agent-review", "qwen3.8-flash-next")).toEqual({ mode: "stored", apiKey: "sk-secret-1" });
  expect(await disableAdminServingContract("crawl-agent-review", "qwen3.8-flash-next", "jr")).toBe(true);
  await store.refreshServingContracts();
  expect(store.servingContractAuth("crawl-agent-review", "qwen3.8-flash-next")).toBeNull();
});
