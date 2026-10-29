import { DEADLINE_LADDER_SKEW_MS } from "../../lib/llm/deadline-policy";
import { readModelRegistry, relayModelDefinitions, modelRequestBudget, modelTimeoutMs, type ModelDefinition } from "../../lib/llm/model-registry";
import net from "node:net";
import path from "node:path";
import { lstatSync, readFileSync } from "node:fs";

export const isTailnetIpv4 = (value: string): boolean => {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

/** This relay runs on M1. Another device's relay names its own registry equipment; a model name never selects a device. */
export const DEFAULT_RELAY_EQUIPMENT = "m1";
export function relayEquipment(env: Readonly<Record<string, string | undefined>>): string {
  const equipment = env.LOCAL_MODEL_RELAY_EQUIPMENT?.trim() || DEFAULT_RELAY_EQUIPMENT;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(equipment)) throw new Error("relay_invalid_equipment");
  return equipment;
}

/**
 * Allowed upstream ids come only from MODEL_REGISTRY_CONFIG (or its defaults): this equipment's entries with the relay purpose.
 * An explicit key/model pins one of them; it can never add an unregistered id, a gateway label or another device's entry.
 */
export function relayAllowedModels(env: Readonly<Record<string, string | undefined>>): { primary: ModelDefinition; allowed: ModelDefinition[] } {
  const registered = relayModelDefinitions(relayEquipment(env), env);
  if (!registered.length) throw new Error("relay_model_not_registered");
  const key = env.LOCAL_MODEL_RELAY_MODEL_KEY?.trim(), name = env.LOCAL_MODEL_RELAY_MODEL?.trim();
  const keyed = key ? registered.find(model => model.key === key) : undefined;
  if (key && !keyed) throw new Error("relay_model_not_allowed");
  if (name && (keyed ? keyed.model !== name : !registered.some(model => model.model === name))) throw new Error("relay_model_not_allowed");
  const selected = readModelRegistry(env).selections.relay;
  const primary = keyed ?? (name ? registered.find(model => model.model === name) : undefined)
    ?? registered.find(model => model.key === selected) ?? registered[0];
  const family = env.LOCAL_MODEL_RELAY_MODEL_FAMILY?.trim();
  if (family && family !== primary.family) throw new Error("relay_model_family_mismatch");
  const allowed = key || name ? [primary] : registered.filter((model, index) => registered.findIndex(other => other.model === model.model) === index);
  return { primary, allowed };
}

/** The relay sends the actual upstream id, never a gateway label or a model alias. */
export function relayModelDefinition(env: Readonly<Record<string, string | undefined>>): ModelDefinition {
  return relayAllowedModels(env).primary;
}

function secretFile(value: string | undefined): string {
  if (!value || !path.isAbsolute(value)) throw new Error("relay_private_token_file_required");
  const stat = lstatSync(value);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("relay_token_file_permissions");
  const secret = readFileSync(value, "utf8").trim();
  if (!secret || secret.length > 4096 || !/^[\x21-\x7e]+$/.test(secret)) throw new Error("relay_invalid_token_file");
  return secret;
}

export function localModelRelayConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  const host = env.LOCAL_MODEL_RELAY_HOST?.trim() ?? "";
  const allowFrom = (env.LOCAL_MODEL_RELAY_ALLOW_FROM ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!isTailnetIpv4(host) || !allowFrom.length || allowFrom.some(value => !isTailnetIpv4(value))) throw new Error("relay_tailnet_addresses_required");
  const port = Number(env.LOCAL_MODEL_RELAY_PORT ?? 8792);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("relay_invalid_port");
  const stateDirectory = env.LOCAL_MODEL_RELAY_STATE_DIR ?? "";
  if (!path.isAbsolute(stateDirectory)) throw new Error("relay_state_directory_required");
  const state = lstatSync(stateDirectory);
  if (!state.isDirectory() || (state.mode & 0o077) !== 0) throw new Error("relay_state_directory_permissions");
  const relayRevision = env.LOCAL_MODEL_RELAY_VERSION ?? "";
  if (!/^[0-9a-f]{40}$/.test(relayRevision)) throw new Error("relay_release_revision_required");
  const deploymentRevision = env.LOCAL_MODEL_RELAY_DEPLOYMENT_REVISION ?? "unverified";
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(deploymentRevision)) throw new Error("relay_invalid_deployment_revision");
  if (env.LOCAL_MODEL_RELAY_UPSTREAM_URL || env.LOCAL_MODEL_RELAY_UPSTREAM_HOST || env.LOCAL_MODEL_RELAY_UPSTREAM_PORT)
    throw new Error("relay_upstream_is_fixed");
  const { primary: definition, allowed } = relayAllowedModels(env);
  const model = definition.model, models = allowed.map(entry => entry.model);
  const modelCeiling = Math.min(modelRequestBudget("relay", env).maxTokens, ...allowed.map(entry => entry.maxTokens));
  const token = secretFile(env.LOCAL_MODEL_RELAY_TOKEN_FILE), upstreamToken = secretFile(env.LOCAL_MODEL_RELAY_UPSTREAM_TOKEN_FILE);
  if (token.length < 32 || token === upstreamToken) throw new Error("relay_separate_tokens_required");
  // 기한 사다리(엔진 < relay < gateway < client)의 relay 몫. 값 근거는 docs/operations/2026-10-28-deadline-ladder.md.
  const optionalMs = (name: string, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("relay_invalid_deadline");
    return value;
  };
  const ladder = definition.deadlineLadder;
  if (ladder && ladder.relayMs === null) throw new Error("relay_deadline_ladder_requires_relay");
  const upstreamTimeoutMs = optionalMs("LOCAL_MODEL_RELAY_UPSTREAM_TIMEOUT_MS", 90_000) ?? ladder?.relayMs ?? modelTimeoutMs("relay", env);
  if (upstreamTimeoutMs > 90_000) throw new Error("relay_invalid_deadline");
  if (ladder && upstreamTimeoutMs !== ladder.relayMs) throw new Error("relay_deadline_ladder_override_mismatch");
  const engineDeadlineMs = optionalMs("LOCAL_MODEL_RELAY_ENGINE_DEADLINE_MS", 90_000);
  const engineBoundEffectiveAt = env.LOCAL_MODEL_RELAY_ENGINE_BOUND_EFFECTIVE_AT?.trim();
  const maxOutputTokens = optionalMs("LOCAL_MODEL_RELAY_MAX_OUTPUT_TOKENS", 262_144) ?? modelCeiling;
  if (maxOutputTokens > modelCeiling) throw new Error("relay_model_output_limit_exceeded");
  if (engineDeadlineMs !== undefined && (engineDeadlineMs + DEADLINE_LADDER_SKEW_MS >= upstreamTimeoutMs || (ladder && engineDeadlineMs !== ladder.engineMs)))
    throw new Error("relay_deadline_order_invalid");
  return { host, port, allowFrom, stateDirectory, relayRevision, deploymentRevision, token, upstreamToken, model, models,
    equipment: definition.equipment,
    ...(upstreamTimeoutMs ? { upstreamTimeoutMs } : {}), ...(engineDeadlineMs ? { engineDeadlineMs, engineBoundEffectiveAt } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}) };
}
