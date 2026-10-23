import { localModelContractHash, localModelServingContractsSchema } from "../../lib/llm/local-model-serving-contract";
import type { RelayNativeReadinessVerifier } from "./protocol";
import { lstatSync, readFileSync } from "node:fs";

/** PR02와 같은 exact readback hash를 사용한다. 설정 shape나 env boolean만으로 ready를 만들지 않는다. */
export function relayNativeReadinessVerifier(endpoint: string, env: Readonly<Record<string, string | undefined>> = process.env): RelayNativeReadinessVerifier {
  return context => {
    try {
      let configuration: Readonly<Record<string, string | undefined>> = env;
      if (env.LOCAL_MODEL_RELAY_NATIVE_READBACK_FILE) {
        const file = env.LOCAL_MODEL_RELAY_NATIVE_READBACK_FILE, stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || stat.size > 100_000) throw new Error("invalid_readback_file");
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
        || contract.modelFamily !== "qwen3.8-flash-next" || context.indeterminate || context.activeRequestId
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
