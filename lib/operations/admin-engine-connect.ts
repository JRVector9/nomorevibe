import { db, onPrimary } from "@/lib/db";
import { ADMIN_MODEL_STAGES, type AdminStagePools } from "@/lib/llm/admin-model-stages";
import { GATEWAY_SERVING_CONTRACT_ROUTES, registeredGatewayServingContractSchema, type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { modelRequestName, readModelRegistry, type ModelDefinition } from "@/lib/llm/model-registry";
import { ensureServingContracts, servingContractAuth } from "@/lib/llm/serving-contract-store";
import { writerSiteActive, DrWriterFencedError } from "./dr/epoch";
import { readbackServingEndpoint, saveServingContractTx, validateAdminServingContract } from "./admin-serving-contracts";
import { saveRegistryOverrideTx } from "./admin-model-registry";

/**
 * 엔진 연결: an OpenAI-compatible engine address + key + engine model, applied to one existing registry key in one step.
 * - The registry definition of that key keeps its equipment, adapter, limits and purposes; only its address and engine
 *   model name change, and the gateway label goes (the engine expects its own model name on the wire).
 * - Each chosen gateway route gets a direct contract (transport direct, the stored or no key). The engine's own model list
 *   is read on the server first: the model must be there, and its maximum length becomes the contract's total bound.
 *   One 1-token completion then gives the name the engine answers with (vLLM answers with its first served name, e.g.
 *   'local-llm' for 'Inferact/Qwen3.8-27B-NVFP4'), which becomes the contract's response model.
 * - Optionally the chosen routes' admin stages select that key, so the jobs pick it on their next lease; with the AI1 route,
 *   a 1차 selection still naming the old request name (e.g. '[supa] …') is renamed to the engine name.
 * - Capacity is not changed here: a route missing from the capacity policy is reported and stays deferred until it is added.
 */
export type EngineConnectInput = { registryKey: string; baseUrl: string; auth: "stored" | "none"; apiKey?: string; engineModel: string;
  routes: readonly string[]; selectStages: boolean; note?: string | null };
export type EngineConnectResult = { registryId: number; contracts: { routeId: string; id: number }[]; stages: string[]; requestModel: string;
  responseModel: string; firstReviewRenamed: boolean; missingPolicyRoutes: string[]; totalTokenBound: number };

/** Routes whose contract is the plain total-bound shape (AI2 has its own adapter contract and is configured separately). */
export const ENGINE_CONNECT_ROUTES = GATEWAY_SERVING_CONTRACT_ROUTES.filter(route => route !== "second-review");

/** `https://host/v1` (trailing slash or /chat/completions tolerated). Contracts require exactly /v1/chat/completions. */
export function engineBaseUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  return path === "/v1" ? `${url.origin}/v1` : null;
}

/** One 1-token completion: the model name the engine answers with. Admin-time only, outside the capacity ledger. */
export async function probeResponseModel(endpoint: string, model: string, apiKey: string | null, request: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await request(endpoint, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 1, messages: [{ role: "user", content: "OK" }] }) });
    if (!response.ok) return null;
    const body = await response.json() as { object?: unknown; model?: unknown };
    const answered = typeof body.model === "string" ? body.model.trim() : "";
    return body.object === "chat.completion" && answered && answered.length <= 200 && !/[\p{Cc}]/u.test(answered) ? answered : null;
  } catch { return null; }
}

function routeContract(routeId: GatewayServingRoute, model: string, responseModel: string, endpoint: string, totalTokenBound: number, equipment: string) {
  const shape = (registeredGatewayServingContractSchema(routeId) as unknown as { shape?: Record<string, { value?: unknown }> } | null)?.shape;
  const protocol = shape?.protocol?.value;
  if (typeof protocol !== "string") return null;
  const contract: Record<string, unknown> = { version: 1, protocol, routeId, provider: "abcllm", model, responseModel,
    deploymentRevision: `direct-${equipment}-${model}-C${totalTokenBound}`.slice(0, 200), endpoint, totalTokenBound };
  // The four translation routes open only with the strict-terminal mark; a direct engine's own completion is terminal.
  if (shape && "strictTerminalOptIn" in shape) contract.strictTerminalOptIn = "abcllm-strict-terminal-v1";
  const checked = validateAdminServingContract(routeId, contract);
  return checked.ok ? checked.contract : null;
}

async function policyRoutes(): Promise<{ routeId: string; provider: string; model: string }[] | null> {
  try {
    const { readModelCapacityControlObservation } = await import("@/lib/llm/capacity-repository");
    const policy = (await readModelCapacityControlObservation()).policy as { routes?: unknown } | null;
    return Array.isArray(policy?.routes) ? policy.routes.filter((route): route is { routeId: string; provider: string; model: string } =>
      !!route && typeof route === "object" && typeof (route as { routeId?: unknown }).routeId === "string") : [];
  } catch { return null; }
}

export async function connectAdminEngine(input: EngineConnectInput, actor: string, request: typeof fetch = fetch): Promise<EngineConnectResult> {
  const base = engineBaseUrl(input.baseUrl);
  if (!base) throw new Error("engine_base_url_invalid");
  const routes = [...new Set(input.routes)];
  if (!routes.length || routes.some(route => !(ENGINE_CONNECT_ROUTES as readonly string[]).includes(route))) throw new Error("engine_routes_invalid");
  if (!["stored", "none"].includes(input.auth) || !actor.trim()) throw new Error("serving_contract_input_invalid");
  const current = readModelRegistry().models.find(model => model.key === input.registryKey);
  if (!current) throw new Error("registry_key_unknown");
  if (current.provider !== "abcllm") throw new Error("engine_connect_provider_unsupported");
  const engineModel = input.engineModel.trim();
  // A new key, else the key already stored for these routes (same engine model), else none.
  await ensureServingContracts(0);
  const typedKey = input.apiKey?.trim() || undefined;
  const storedKey = routes.map(route => servingContractAuth(route, engineModel)).find(auth => auth?.mode === "stored" && auth.apiKey)?.apiKey ?? undefined;
  const key = input.auth === "stored" ? typedKey ?? storedKey : undefined;
  if (input.auth === "stored" && !key) throw new Error("serving_contract_key_required");
  const readback = await readbackServingEndpoint(`${base}/chat/completions`, key ?? null, request);
  if (!readback.ok) throw new Error(`engine_unreachable:${readback.reason}`);
  const served = readback.models.find(model => model.id === engineModel);
  if (!served) throw new Error("engine_model_not_found");
  if (!served.maxModelLen) throw new Error("engine_max_len_unknown");
  const totalTokenBound = served.maxModelLen;
  const responseModel = await probeResponseModel(`${base}/chat/completions`, engineModel, key ?? null, request);
  if (!responseModel) throw new Error("engine_probe_failed");
  const definition: ModelDefinition = { ...current, baseUrl: base, model: engineModel, displayName: current.displayName.includes("직접")
    ? current.displayName : `${current.displayName} · 직접 연결`.slice(0, 200) };
  delete (definition as { gatewayLabel?: string }).gatewayLabel;
  const contracts = routes.map(route => ({ route, contract: routeContract(route as GatewayServingRoute, engineModel, responseModel, `${base}/chat/completions`,
    totalTokenBound, current.equipment) }));
  if (contracts.some(entry => !entry.contract)) throw new Error("contract_schema_invalid");
  const { getSettings, saveSettings } = await import("@/lib/crawl/settings");
  const settings = await getSettings(), stageIds = input.selectStages
    ? ADMIN_MODEL_STAGES.filter(stage => stage.provider === "abcllm" && routes.includes(stage.purpose)).map(stage => stage.id) : [];
  const pools: AdminStagePools = { ...(settings.stageModelPools ?? {}), ...Object.fromEntries(stageIds.map(stage => [stage, [input.registryKey]])) };
  const note = input.note?.trim() ? input.note.trim().slice(0, 400) : `엔진 연결 ${base}`;
  const saved = await onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const registry = await saveRegistryOverrideTx(tx, definition, actor, note, pools);
    const rows = [];
    for (const entry of contracts) rows.push({ routeId: entry.route, ...await saveServingContractTx(tx, { routeId: entry.route, contract: entry.contract,
      auth: input.auth, transport: "direct", apiKey: input.auth === "stored" ? key : undefined, note }, actor) });
    return { registryId: registry.id, contracts: rows.map(row => ({ routeId: row.routeId, id: row.id })) };
  }));
  // Stage selection is the ordinary settings save (own version check and audit); the connection above already stands alone.
  const oldName = modelRequestName(current);
  const rename = <T extends { provider: string; model: string }>(row: T): T => row.provider === "abcllm" && row.model === oldName ? { ...row, model: engineModel } : row;
  const renameAi1 = input.selectStages && routes.includes("crawl-agent-review") && oldName !== engineModel
    && [settings.firstReview, ...settings.firstReviewAdditional ?? []].some(row => row && rename(row) !== row);
  const patch = { ...(stageIds.length ? { stageModelPools: pools } : {}),
    ...(renameAi1 ? { firstReview: settings.firstReview && rename(settings.firstReview), firstReviewAdditional: (settings.firstReviewAdditional ?? []).map(rename) } : {}) };
  if (Object.keys(patch).length) {
    const result = await saveSettings(patch, actor);
    if (!result.ok) throw new Error("engine_stage_save_failed");
  }
  const policy = await policyRoutes();
  const missingPolicyRoutes = policy === null ? routes.map(route => `${route} / abcllm / ${engineModel}`)
    : routes.filter(route => !policy.some(row => row.routeId === route && row.provider === "abcllm" && row.model === engineModel))
      .map(route => `${route} / abcllm / ${engineModel}`);
  return { ...saved, stages: stageIds, requestModel: engineModel, responseModel, firstReviewRenamed: renameAi1, missingPolicyRoutes, totalTokenBound };
}
