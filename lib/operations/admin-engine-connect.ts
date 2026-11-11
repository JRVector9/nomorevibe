import { db, onPrimary } from "@/lib/db";
import { ADMIN_MODEL_STAGES, type AdminStagePools } from "@/lib/llm/admin-model-stages";
import { ASSIGNMENT_STAGE_IDS, ASSIGNMENT_STAGES } from "@/lib/llm/capacity-helpers";
import { GATEWAY_SERVING_CONTRACT_ROUTES, registeredGatewayContractShape, type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { modelRequestName, readModelRegistry, type ModelDefinition } from "@/lib/llm/model-registry";
import { ensureServingContracts, servingContractAuth, servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { writerSiteActive, DrWriterFencedError } from "./dr/epoch";
import { readbackServingEndpoint, saveServingContractTx, validateAdminServingContract } from "./admin-serving-contracts";
import { saveRegistryOverrideTx } from "./admin-model-registry";

/**
 * 엔진 연결: an OpenAI-compatible engine address + key + engine model, applied to one existing registry key in one step.
 * - The registry definition of that key keeps its equipment, adapter, limits and purposes; only its address and engine
 *   model name change, and the gateway label goes (the engine expects its own model name on the wire).
 * - Each chosen gateway route gets a direct contract (transport direct, the stored or no key) of the route's plain total-bound shape
 *   (provider abcllm, so the ledger rows and capacity policy routes keep their abcllm identity). The engine's own model list
 *   is read on the server first: the model must be there, and its maximum length becomes the contract's total bound.
 *   Engines whose /models omits max_model_len (mlx_lm.server, the M3 mlx-serve proxy) take the operator-typed bound instead;
 *   a typed bound that differs from a served one is refused, never picked over. The origin stays in the contract.
 *   One 1-token completion then gives the name the engine answers with (vLLM answers with its first served name, e.g.
 *   'local-llm' for 'Inferact/Qwen3.8-27B-NVFP4'), which becomes the contract's response model.
 * - Optionally the chosen routes' admin stages select that key, so the jobs pick it on their next lease; with the AI1 route,
 *   a 1차 selection still naming the old request name (e.g. '[supa] …') is renamed to the engine name.
 * - Capacity is not changed here: a route missing from the capacity policy is reported and stays deferred until it is added.
 */
export type EngineConnectInput = { registryKey: string; baseUrl: string; auth: "stored" | "none"; apiKey?: string; engineModel: string;
  routes: readonly string[]; selectStages: boolean; note?: string | null;
  /** Operator-typed context bound (tokens): required when /models omits max_model_len, must equal it when given. */
  maxModelLen?: number | null };
export type EngineConnectBoundOrigin = "engine" | "operator";
export type EngineConnectResult = { registryId: number; contracts: { routeId: string; id: number }[]; stages: string[]; requestModel: string;
  responseModel: string; firstReviewRenamed: boolean; missingPolicyRoutes: string[]; totalTokenBound: number; totalTokenBoundFrom: EngineConnectBoundOrigin };

/** Routes whose contract is the plain total-bound shape (AI2 has its own adapter contract and is configured separately). */
export const ENGINE_CONNECT_ROUTES = GATEWAY_SERVING_CONTRACT_ROUTES.filter(route => route !== "second-review");
/** Ceiling of the operator-typed bound (2M tokens; no served context is longer today). */
export const ENGINE_CONNECT_MAX_MODEL_LEN = 2_097_152;
/** Revision suffix of a contract whose bound the operator typed, so audits tell it from an engine-reported one. */
export const OPERATOR_BOUND_REVISION_SUFFIX = "-operator-bound";

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

/**
 * Readback (`/models`) + one 1-token probe of an OpenAI-compatible endpoint (`…/v1/chat/completions`): the engine model must be served, its
 * maximum length (or the operator-typed bound when /models omits it; a typed bound beside a served one must match) is the contract's total
 * bound, and the probe gives the name the engine answers with. Admin-time only, outside the capacity ledger. Throws the reason code
 * (`engine_unreachable:<reason>` · `engine_model_not_found` · `engine_max_len_invalid` · `engine_max_len_mismatch:<served>:<typed>` ·
 * `engine_max_len_unknown` · `engine_probe_failed`). Engine connect and the assignment save (PR 3b-A) share it.
 */
export type EngineContractProbe = Readonly<{ endpoint: string; requestModel: string; responseModel: string; totalTokenBound: number;
  totalTokenBoundFrom: EngineConnectBoundOrigin }>;
export async function probeEngineContract(input: { endpoint: string; engineModel: string; apiKey: string | null; maxModelLen?: number | null;
  /**
   * 목록(GET /models)이 없는 서버에 운영자가 적은 모델(2026-11-10, 예: LG EXAONE API — /v1/models 가 없다). readback 을 건너뛰고 운영자가 적은 상한을 쓴다
   * (없으면 engine_max_len_unknown). 모델이 실제로 있는지는 아래 1토큰 시험이 정한다(없는 모델이면 서버가 거절해 engine_probe_failed).
   */
  unlisted?: boolean },
  request: typeof fetch = fetch): Promise<EngineContractProbe> {
  const { endpoint, engineModel, apiKey } = input;
  let servedBound: number | null = null;
  if (!input.unlisted) {
    const readback = await readbackServingEndpoint(endpoint, apiKey, request);
    if (!readback.ok) throw new Error(`engine_unreachable:${readback.reason}`);
    const served = readback.models.find(model => model.id === engineModel);
    if (!served) throw new Error("engine_model_not_found");
    servedBound = served.maxModelLen || null;
  }
  // The served max_model_len is authoritative. Without it (mlx_lm.server, the M3 mlx-serve proxy omit it) the operator's typed
  // bound stands in; a typed bound beside a served one must match, so neither is silently picked over the other.
  const typedBound = input.maxModelLen ?? null;
  if (typedBound !== null && !(Number.isSafeInteger(typedBound) && typedBound > 0 && typedBound <= ENGINE_CONNECT_MAX_MODEL_LEN)) throw new Error("engine_max_len_invalid");
  if (servedBound !== null && typedBound !== null && typedBound !== servedBound) throw new Error(`engine_max_len_mismatch:${servedBound}:${typedBound}`);
  const totalTokenBound = servedBound ?? typedBound;
  if (totalTokenBound === null) throw new Error("engine_max_len_unknown");
  const totalTokenBoundFrom: EngineConnectBoundOrigin = servedBound !== null ? "engine" : "operator";
  const responseModel = await probeResponseModel(endpoint, engineModel, apiKey, request);
  if (!responseModel) throw new Error("engine_probe_failed");
  return Object.freeze({ endpoint, requestModel: engineModel, responseModel, totalTokenBound, totalTokenBoundFrom });
}

/**
 * 저장된 직접 연결 계약의 주소로 GET /models. 이름과 주소는 응답과 계약에만 있고, 키는 돌려주지 않는다.
 * host 는 그 주소의 host:port, equipment 는 같은 host 를 baseUrl 로 둔 등록부 모델의 장비 이름(없으면 null) — 「장비 · 모델」 선택지 표시용이다.
 */
export type ServedContractModels = { routeId: string; storedModel: string; servedIds: string[] | null; reason: string | null;
  host?: string | null; equipment?: string | null };
const endpointHost = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try { return new URL(value).host || null; } catch { return null; }
};
export async function readServedContractModels(request: typeof fetch = fetch): Promise<ServedContractModels[]> {
  const rows = servingContractSnapshot().rows.filter(row => row.transport === "direct");
  const endpointOf = (contract: unknown) => contract && typeof contract === "object" && typeof (contract as { endpoint?: unknown }).endpoint === "string"
    ? (contract as { endpoint: string }).endpoint : "";
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const endpoint = endpointOf(row.contract);
    if (!endpoint) continue;
    groups.set(endpoint, [...(groups.get(endpoint) ?? []), row]);
  }
  const read = new Map<string, { ids: string[] | null; reason: string | null }>();
  await Promise.all([...groups.entries()].map(async ([endpoint, group]) => {
    const auth = servingContractAuth(group[0].routeId, group[0].model);
    const result = await readbackServingEndpoint(endpoint, auth?.apiKey ?? null, request);
    read.set(endpoint, result.ok ? { ids: result.models.map(model => model.id), reason: null } : { ids: null, reason: result.reason });
  }));
  const registry = readModelRegistry().models;
  return rows.flatMap(row => {
    const endpoint = endpointOf(row.contract);
    const got = endpoint ? read.get(endpoint) : undefined;
    const host = endpointHost(endpoint);
    const equipment = host ? registry.find(model => endpointHost(model.baseUrl) === host)?.equipment ?? null : null;
    return got ? [{ routeId: row.routeId, storedModel: row.model, servedIds: got.ids, reason: got.reason, host, equipment }] : [];
  });
}

/** The plain total-bound contract of one gateway route for a directly connected (or gateway) engine model; null when the route schema refuses it. */
export function engineRouteContract(routeId: GatewayServingRoute, model: string, responseModel: string, endpoint: string, totalTokenBound: number, equipment: string,
  boundFrom: EngineConnectBoundOrigin, engineModel: string | null = null, reasoningTokenReserve: number | null = null) {
  // The route's plain total-bound gateway shape: crawl-agent-review also accepts a direct-openai-chat-v1 contract (PR 3b-C), which this
  // connection does not write — it needs the engine's tokenizer read back and is configured separately, like AI2's direct contract.
  const shape = (registeredGatewayContractShape(routeId) as unknown as { shape?: Record<string, { value?: unknown }> } | null)?.shape;
  const protocol = shape?.protocol?.value;
  if (typeof protocol !== "string") return null;
  // The bound and its origin end the revision; a long model name is what gets cut to the 200-char identity, never the tail.
  const tail = `-C${totalTokenBound}${boundFrom === "operator" ? OPERATOR_BOUND_REVISION_SUFFIX : ""}`;
  const contract: Record<string, unknown> = { version: 1, protocol, routeId, provider: "abcllm", model, responseModel,
    deploymentRevision: `direct-${equipment}-${model}`.slice(0, 200 - tail.length) + tail, endpoint, totalTokenBound };
  // The four translation routes open only with the strict-terminal mark; a direct engine's own completion is terminal.
  if (shape && "strictTerminalOptIn" in shape) contract.strictTerminalOptIn = "abcllm-strict-terminal-v1";
  // 같은 모델을 다른 연결에도 둔 순위(PR B): model 은 연결로 가른 장부 이름, 엔진에는 engineModel 이 나간다(text 경로 계약만 이 칸을 받는다)
  if (engineModel && engineModel !== model) {
    if (!shape || !("engineModel" in shape)) return null;
    contract.engineModel = engineModel;
  }
  // 추론 토큰이 max_tokens 에 포함되는 모델의 여유(2026-11-10): 그 칸을 받는 경로(사유 번역·한국어 소개 2026-11-11)의 계약에만 싣는다 — 다른 경로는 그대로(화면이 알린다)
  if (reasoningTokenReserve && shape && "reasoningTokenReserve" in shape) contract.reasoningTokenReserve = reasoningTokenReserve;
  const checked = validateAdminServingContract(routeId, contract);
  return checked.ok ? checked.contract : null;
}

/**
 * 연결이 끝난 뒤 「이 모델을 단계에 배정」(PR 3b-D) — 모델 배정 화면의 새 배정 폼을 이 등록부 key·엔진 직접 전송·고른 경로 중 첫 배정 단계로 미리 채우는 주소.
 * 연결 저장의 뜻은 바꾸지 않는다(배정은 운영자가 그 폼에서 따로 저장한다).
 */
export function engineConnectAssignmentHref(registryKey: string, routes: readonly string[]): string {
  const stage = ASSIGNMENT_STAGE_IDS.find(id => { const spec = ASSIGNMENT_STAGES[id]; return spec.routeId !== null && routes.includes(spec.routeId) && spec.transports.has("direct"); });
  const query = new URLSearchParams({ registryKey, transport: "direct", ...(stage ? { stage } : {}) });
  return `/admin/models/assignments?${query.toString()}#form`;
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
  // Load the stored contracts and registry overrides first: a reconnect starts from the current overridden definition
  // (its engine name, which the 1차 selection now carries, and any admin-set limits such as timeoutMs), not the code default.
  await ensureServingContracts(0);
  const current = readModelRegistry().models.find(model => model.key === input.registryKey);
  if (!current) throw new Error("registry_key_unknown");
  if (current.provider !== "abcllm") throw new Error("engine_connect_provider_unsupported");
  const engineModel = input.engineModel.trim();
  // A new key, else the key already stored for these routes (same engine model), else none.
  const typedKey = input.apiKey?.trim() || undefined;
  const storedKey = routes.map(route => servingContractAuth(route, engineModel)).find(auth => auth?.mode === "stored" && auth.apiKey)?.apiKey ?? undefined;
  const key = input.auth === "stored" ? typedKey ?? storedKey : undefined;
  if (input.auth === "stored" && !key) throw new Error("serving_contract_key_required");
  const { responseModel, totalTokenBound, totalTokenBoundFrom } = await probeEngineContract({ endpoint: `${base}/chat/completions`, engineModel,
    apiKey: key ?? null, maxModelLen: input.maxModelLen }, request);
  const definition: ModelDefinition = { ...current, baseUrl: base, model: engineModel, displayName: current.displayName.includes("직접")
    ? current.displayName : `${current.displayName} · 직접 연결`.slice(0, 200) };
  delete (definition as { gatewayLabel?: string }).gatewayLabel;
  const contracts = routes.map(route => ({ route, contract: engineRouteContract(route as GatewayServingRoute, engineModel, responseModel, `${base}/chat/completions`,
    totalTokenBound, current.equipment, totalTokenBoundFrom) }));
  if (contracts.some(entry => !entry.contract)) throw new Error("contract_schema_invalid");
  const { getSettings, saveSettings } = await import("@/lib/crawl/settings");
  const settings = await getSettings(), stageIds = input.selectStages
    ? ADMIN_MODEL_STAGES.filter(stage => stage.provider === "abcllm" && routes.includes(stage.purpose)).map(stage => stage.id) : [];
  const pools: AdminStagePools = { ...(settings.stageModelPools ?? {}), ...Object.fromEntries(stageIds.map(stage => [stage, [input.registryKey]])) };
  const note = input.note?.trim() ? input.note.trim().slice(0, 400) : `엔진 연결 ${base}`;
  // The contract rows' note (which the save audit carries) also says when the bound was typed, not read from the engine.
  const mark = totalTokenBoundFrom === "operator" ? ` · 컨텍스트 상한 운영자 입력 ${totalTokenBound}` : "";
  const contractNote = note.slice(0, 400 - mark.length) + mark;
  const saved = await onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const registry = await saveRegistryOverrideTx(tx, definition, actor, note, pools);
    const rows = [];
    for (const entry of contracts) rows.push({ routeId: entry.route, ...await saveServingContractTx(tx, { routeId: entry.route, contract: entry.contract,
      auth: input.auth, transport: "direct", apiKey: input.auth === "stored" ? key : undefined, note: contractNote }, actor) });
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
  return { ...saved, stages: stageIds, requestModel: engineModel, responseModel, firstReviewRenamed: renameAi1, missingPolicyRoutes, totalTokenBound, totalTokenBoundFrom };
}
