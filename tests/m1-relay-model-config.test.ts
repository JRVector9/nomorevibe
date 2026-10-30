import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL_DEFINITIONS, DEFAULT_MODEL_PURPOSE_LIMITS, type ModelDefinition } from "@/lib/llm/model-registry";
import { localModelRelayConfig, relayAllowedModels } from "@/scripts/local-model-relay/config";
import { migrateM1TranslationRegistry } from "@/scripts/migrate-model-registry-m1";
import { createLocalModelRelay } from "@/scripts/local-model-relay/service";
import { fileRelayReceiptStore } from "@/scripts/local-model-relay/store";
import { LOCAL_MODEL_RELAY_REQUEST_HEADER } from "@/scripts/local-model-relay/protocol";

const GEMMA = "mlx-community--gemma-4-26b-a4b-it-4bit", QWEN = "qwen3.8-flash-next";
const TOKEN = "relay-private-token-" + "a".repeat(40), UPSTREAM_TOKEN = "upstream-private-key-" + "b".repeat(40);
const servers: http.Server[] = [], directories: string[] = [];
const m1 = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "m1:translation")!;
const gpu = DEFAULT_MODEL_DEFINITIONS.find(model => model.key === "gpu3090:review")!;
const registry = (models: readonly ModelDefinition[], extra: object = {}) => ({ MODEL_REGISTRY_CONFIG: JSON.stringify({ version: 1, models, ...extra }) });

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function relayEnv() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nmv-m1-relay-model-")); directories.push(directory);
  const relayKey = path.join(directory, "relay"), upstreamKey = path.join(directory, "upstream");
  writeFileSync(relayKey, TOKEN, { mode: 0o600 }); writeFileSync(upstreamKey, UPSTREAM_TOKEN, { mode: 0o600 });
  return { LOCAL_MODEL_RELAY_HOST: "100.80.1.2", LOCAL_MODEL_RELAY_ALLOW_FROM: "100.90.1.2", LOCAL_MODEL_RELAY_TOKEN_FILE: relayKey,
    LOCAL_MODEL_RELAY_UPSTREAM_TOKEN_FILE: upstreamKey, LOCAL_MODEL_RELAY_STATE_DIR: directory, LOCAL_MODEL_RELAY_VERSION: "c".repeat(40) };
}

describe("M1 relay allowed models come from the model registry", () => {
  it("defaults to the registry's M1 relay entry (actual Gemma id), never the old M1 Qwen id", () => {
    const env = relayEnv();
    // 출력 상한은 relay purpose 한도(10K)와 모델 정의(30K, 2026-10-30 번역 상한 인상)의 최솟값
    expect(localModelRelayConfig(env)).toMatchObject({ equipment: "m1", model: GEMMA, models: [GEMMA], maxOutputTokens: Math.min(m1.maxTokens, DEFAULT_MODEL_PURPOSE_LIMITS.relay.maxTokens) });
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_MODEL: QWEN })).toThrow("relay_model_not_allowed");
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_MODEL: `[m1] ${GEMMA}` })).toThrow("relay_model_not_allowed");
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_MODEL_KEY: "gpu3090:review" })).toThrow("relay_model_not_allowed");
    expect(localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_MODEL: GEMMA, LOCAL_MODEL_RELAY_MODEL_FAMILY: "gemma4-26b" }).model).toBe(GEMMA);
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_MODEL_FAMILY: QWEN })).toThrow("relay_model_family_mismatch");
  });

  it("routes a model name shared by M1 and GPU3090 by the relay's equipment, not by the first name match", () => {
    const env = { ...relayEnv(), ...registry([
      { ...m1, model: "shared-weights", family: "shared", maxTokens: 700 },
      { ...gpu, model: "shared-weights", family: "shared", maxTokens: 900, purposes: [...gpu.purposes, "relay"] },
    ]) };
    expect(relayAllowedModels(env).primary.key).toBe("m1:translation");
    expect(localModelRelayConfig(env)).toMatchObject({ equipment: "m1", model: "shared-weights", maxOutputTokens: 700 });
    expect(localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_MODEL: "shared-weights" }).equipment).toBe("m1");
    const gpuRelay = { ...env, LOCAL_MODEL_RELAY_EQUIPMENT: "gpu3090" };
    expect(relayAllowedModels(gpuRelay).primary.key).toBe("gpu3090:review");
    expect(localModelRelayConfig(gpuRelay)).toMatchObject({ equipment: "gpu3090", maxOutputTokens: 900 });
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_EQUIPMENT: "supa" })).toThrow("relay_model_not_registered");
    expect(() => localModelRelayConfig({ ...env, LOCAL_MODEL_RELAY_EQUIPMENT: "M1 " })).toThrow("relay_invalid_equipment");
  });

  it("reflects a registry change (new id, extra allowed entry, selection) without editing code", () => {
    const base = relayEnv();
    const replaced = { ...base, ...registry([{ ...m1, model: "gemma-next-id", family: "gemma-next" }, gpu]) };
    expect(localModelRelayConfig(replaced)).toMatchObject({ model: "gemma-next-id", models: ["gemma-next-id"] });
    expect(() => localModelRelayConfig({ ...replaced, LOCAL_MODEL_RELAY_MODEL: GEMMA })).toThrow("relay_model_not_allowed");
    const second: ModelDefinition = { ...m1, key: "m1:vision", model: "m1-vision-id", family: "m1-vision", purposes: ["relay"] };
    const both = { ...base, ...registry([m1, second, gpu], { selections: { relay: "m1:vision" } }) };
    expect(localModelRelayConfig(both)).toMatchObject({ model: "m1-vision-id", models: [GEMMA, "m1-vision-id"] });
    // An installer pin narrows the list to one registered entry.
    expect(localModelRelayConfig({ ...both, LOCAL_MODEL_RELAY_MODEL: GEMMA }).models).toEqual([GEMMA]);
  });

  it("migrates an older registry (relay purpose on GPU3090, M1 still Qwen) to an M1 Gemma relay entry", () => {
    const older = { version: 1, models: [{ ...m1, model: QWEN, family: QWEN, purposes: ["product-translate", "reason-translate"] },
      { ...gpu, purposes: [...gpu.purposes, "relay"] }] };
    const env = relayEnv();
    expect(() => localModelRelayConfig({ ...env, MODEL_REGISTRY_CONFIG: JSON.stringify(older) })).toThrow("relay_model_not_registered");
    const migrated = { ...env, MODEL_REGISTRY_CONFIG: JSON.stringify(migrateM1TranslationRegistry(JSON.stringify(older))) };
    expect(localModelRelayConfig(migrated)).toMatchObject({ equipment: "m1", model: GEMMA, models: [GEMMA] });
    expect(localModelRelayConfig({ ...migrated, LOCAL_MODEL_RELAY_EQUIPMENT: "gpu3090" }).model).toBe(QWEN);
  });
});

async function listen(server: http.Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function relayWith(upstream: () => readonly string[] | null) {
  const chats: string[] = [];
  const upstreamPort = await listen(http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    chats.push(JSON.parse(text).model);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: GEMMA, choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { total_tokens: 3 } }));
  }));
  const state = mkdtempSync(path.join(os.tmpdir(), "nmv-m1-relay-upstream-")); directories.push(state);
  let reads = 0;
  const service = createLocalModelRelay({ token: TOKEN, upstreamToken: UPSTREAM_TOKEN, allowFrom: ["127.0.0.1"], model: GEMMA,
    models: [GEMMA, "m1-vision-id"], relayRevision: "c".repeat(40), deploymentRevision: "d".repeat(40), store: fileRelayReceiptStore(state),
    upstreamPort, upstreamModelsTtlMs: 0, readUpstreamModels: async () => { reads++; return upstream(); } });
  const base = `http://127.0.0.1:${await listen(service)}`;
  const call = (url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...init.headers } });
  const chat = async (model: string) => {
    const response = await call("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }], max_tokens: 10 }),
      headers: { "content-type": "application/json", [LOCAL_MODEL_RELAY_REQUEST_HEADER]: randomUUID() } });
    return { status: response.status, body: await response.json() as { error?: { code: string } } };
  };
  return { service, call, chat, chats, reads: () => reads };
}

describe("M1 relay compares the request with the actual upstream model id", () => {
  it("forwards a registry-allowed id the upstream serves", async () => {
    const relay = await relayWith(() => [GEMMA]);
    expect((await relay.chat(GEMMA)).status).toBe(200);
    expect(relay.chats).toEqual([GEMMA]);
    expect(await (await relay.call("/v1/health")).json()).toMatchObject({ allowedModels: [GEMMA, "m1-vision-id"], upstreamModelMatch: true, upstreamModelReason: "matched" });
  });

  it("refuses an unregistered id with model_not_allowed before any upstream access", async () => {
    const relay = await relayWith(() => [GEMMA, QWEN]);
    expect(await relay.chat(QWEN)).toEqual({ status: 400, body: { error: { code: "model_not_allowed" } } });
    expect(await relay.chat(`[m1] ${GEMMA}`)).toEqual({ status: 400, body: { error: { code: "model_not_allowed" } } });
    expect(relay.chats).toEqual([]); expect(relay.reads()).toBe(0);
  });

  it("refuses an allowed id the upstream no longer serves with upstream_model_mismatch and leaves no unknown", async () => {
    let served: readonly string[] | null = [QWEN];
    const relay = await relayWith(() => served);
    expect(await relay.chat(GEMMA)).toEqual({ status: 503, body: { error: { code: "upstream_model_mismatch" } } });
    expect(await relay.chat("m1-vision-id")).toEqual({ status: 503, body: { error: { code: "upstream_model_mismatch" } } });
    expect(await (await relay.call("/v1/health")).json()).toMatchObject({ upstreamModelMatch: false, upstreamModelReason: "upstream_model_mismatch",
      relayReady: true, indeterminate: false, nativeCapacityReady: false });
    served = null;
    expect(await relay.chat(GEMMA)).toEqual({ status: 503, body: { error: { code: "upstream_models_unavailable" } } });
    expect(relay.chats).toEqual([]);
    served = [GEMMA];
    expect((await relay.chat(GEMMA)).status).toBe(200);
    expect(relay.service.relayHealth()).toMatchObject({ indeterminate: false, busy: false });
  });
});
