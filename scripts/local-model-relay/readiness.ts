import { relayModelDefinition } from "./config";
import { LOCAL_MODEL_UPSTREAM_HOST, LOCAL_MODEL_UPSTREAM_PORT } from "./protocol";
import { localModelContractHash, localModelServingContractsSchema } from "../../lib/llm/local-model-serving-contract";
import type { RelayNativeReadinessVerifier } from "./protocol";
import { lstatSync, readFileSync } from "node:fs";

/** Fixed loopback upstream, separate token, no redirect or unbounded response body. */
export async function relayUpstreamModels(token: string, request: typeof fetch = fetch): Promise<readonly string[] | null> {
  try {
    const response = await request(`http://${LOCAL_MODEL_UPSTREAM_HOST}:${LOCAL_MODEL_UPSTREAM_PORT}/v1/models`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      if (bytes > 100_000) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
    if (!Array.isArray(data) || !data.length || data.some(item => typeof item?.id !== "string")) return null;
    return data.map(item => item.id);
  } catch { return null; }
}

/** PR02와 같은 exact readback hash를 사용한다. 설정 shape나 env boolean만으로 ready를 만들지 않는다. */
export function relayNativeReadinessVerifier(endpoint: string, env: Readonly<Record<string, string | undefined>> = process.env): RelayNativeReadinessVerifier {
  return context => {
    try {
      const definition = relayModelDefinition(env);
      if (context.model !== definition.model || !context.upstreamModels?.includes(definition.model))
        return { ready: false, contractHash: null, reason: "upstream_model_mismatch" };
      let configuration: Readonly<Record<string, string | undefined>> = env;
      if (env.LOCAL_MODEL_RELAY_NATIVE_READBACK_FILE) {
        const file = env.LOCAL_MODEL_RELAY_NATIVE_READBACK_FILE, stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 100_000) throw new Error("invalid_readback_file");
        const data = JSON.parse(readFileSync(file, "utf8")) as { contracts?: unknown; verifiedHashes?: unknown };
        configuration = { LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify(data.contracts), LOCAL_MODEL_VERIFIED_CONTRACT_HASHES: JSON.stringify(data.verifiedHashes) };
      }
      const contracts = localModelServingContractsSchema.parse(JSON.parse(configuration.LOCAL_MODEL_SERVING_CONTRACTS ?? "null"));
      const matches = contracts.filter(contract => contract.endpoint === endpoint);
      if (matches.length !== 1) return { ready: false, contractHash: null, reason: "native_contract_missing" };
      const contract = matches[0], hash = localModelContractHash(contract);
      const verified: unknown = JSON.parse(configuration.LOCAL_MODEL_VERIFIED_CONTRACT_HASHES ?? "null");
      if (!verified || typeof verified !== "object" || Array.isArray(verified)
        || (verified as Record<string, unknown>)[contract.backendId] !== hash) return { ready: false, contractHash: hash, reason: "native_readback_missing" };
      const receipt = context.lastReceipt;
      if (contract.model !== context.model || contract.responseModel !== context.model || contract.deploymentRevision !== context.deploymentRevision
        || contract.modelFamily !== definition.family || context.indeterminate || context.activeRequestId
        || receipt?.deploymentRevision !== contract.deploymentRevision || receipt.relayRevision !== context.relayRevision
        || receipt.state !== "response_complete" || receipt.upstreamStatus !== 200 || !receipt.responseHash)
        return { ready: false, contractHash: hash, reason: "native_observation_mismatch" };
      const usage = receipt.terminal?.usage;
      if (!receipt.terminal?.observerComplete || receipt.terminal.models.length !== 1 || receipt.terminal.models[0] !== contract.responseModel
        || typeof usage?.total_tokens !== "number" || !Number.isSafeInteger(usage.total_tokens)
        || usage.total_tokens < 0 || usage.total_tokens > contract.totalTokenBound)
        return { ready: false, contractHash: hash, reason: "native_usage_unverified" };
      return { ready: true, contractHash: hash, reason: "verified_contract_and_observation" };
    } catch { return { ready: false, contractHash: null, reason: "native_contract_invalid" }; }
  };
}
