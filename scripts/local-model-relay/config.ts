import net from "node:net";
import path from "node:path";
import { lstatSync, readFileSync } from "node:fs";

export const isTailnetIpv4 = (value: string): boolean => {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

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
  const model = env.LOCAL_MODEL_RELAY_MODEL ?? "qwen3.8-flash-next";
  if (model !== "qwen3.8-flash-next") throw new Error("relay_model_not_allowed");
  const token = secretFile(env.LOCAL_MODEL_RELAY_TOKEN_FILE), upstreamToken = secretFile(env.LOCAL_MODEL_RELAY_UPSTREAM_TOKEN_FILE);
  if (token.length < 32 || token === upstreamToken) throw new Error("relay_separate_tokens_required");
  return { host, port, allowFrom, stateDirectory, relayRevision, deploymentRevision, token, upstreamToken, model };
}
