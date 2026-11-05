import "@/lib/llm/publication-classify-serving-contract";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { modelServingContracts, operationsAudit } from "@/lib/db/schema";
import { GATEWAY_SERVING_CONTRACT_ROUTES, parseGatewayServingContract, registeredGatewayServingContractSchema,
  type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { sealSecret, secretBoxReady, servingContractKeyAad } from "@/lib/security/secret-box";
import { writerSiteActive, DrWriterFencedError } from "./dr/epoch";
import { adminAuditRow } from "./admin-log";
// Each contract module registers its route schema on first import; the admin validates with exactly those schemas.
import "@/lib/crawl/agent-review-serving-contract";
import "@/lib/crawl/second-review-serving-contract";
import "@/lib/llm/crawl-tagline-serving-contract";
import "@/lib/llm/product-tagline-ko-serving-contract";
import "@/lib/llm/product-translation-serving-contract";
import "@/lib/llm/reason-translation-serving-contract";
import "@/lib/llm/search-verify-serving-contract";
import "@/lib/llm/text-profile-serving-contract";
import "@/lib/llm/websearch-query-serving-contract";

export type ServingContractAuthMode = "gateway" | "none" | "stored";
export type ServingContractTransportMode = "gateway" | "direct";
export type AdminServingContractRow = { id: number; routeId: string; model: string; contract: Record<string, unknown>; contractHash: string;
  auth: ServingContractAuthMode; transport: ServingContractTransportMode; hasKey: boolean; enabled: boolean; note: string | null; updatedBy: string; updatedAt: string };
export type AdminServingContractInput = { routeId: string; contract: unknown; auth: ServingContractAuthMode;
  /** 'direct': the endpoint is the engine itself, not the abcLLM gateway (default 'gateway'). */
  transport?: ServingContractTransportMode;
  /** A new key to store; undefined keeps the current stored key of the same route+model. Never echoed back. */
  apiKey?: string; note?: string | null };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const isRoute = (value: string): value is GatewayServingRoute => (GATEWAY_SERVING_CONTRACT_ROUTES as readonly string[]).includes(value);
export const servingContractHash = (contract: unknown) => createHash("sha256").update(JSON.stringify(contract)).digest("hex");

/** The exact route schema parse, or a readable reason. The hash is over the parsed (schema-ordered) contract. */
export function validateAdminServingContract(routeId: string, value: unknown): { ok: true; contract: Readonly<Record<string, unknown>> & { model: string } } | { ok: false; reason: string } {
  if (!isRoute(routeId)) return { ok: false, reason: "unknown_route" };
  const schema = registeredGatewayServingContractSchema(routeId);
  if (!schema) return { ok: false, reason: "route_schema_unavailable" };
  const parsed = parseGatewayServingContract(value, routeId, schema);
  return parsed ? { ok: true, contract: parsed as Readonly<Record<string, unknown>> & { model: string } } : { ok: false, reason: "contract_schema_invalid" };
}

export async function listAdminServingContracts(): Promise<AdminServingContractRow[]> {
  const rows = await db.select().from(modelServingContracts).orderBy(modelServingContracts.routeId, modelServingContracts.model, desc(modelServingContracts.id));
  return rows.map(row => ({ id: row.id, routeId: row.routeId, model: row.model, contract: row.contract, contractHash: row.contractHash, auth: row.auth,
    transport: row.transport, hasKey: row.apiKeyCiphertext !== null, enabled: row.enabled, note: row.note, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() }));
}

/** Replace the enabled contract of one route+model. The previous row stays as disabled history. */
export async function saveAdminServingContract(input: AdminServingContractInput, actor: string): Promise<{ id: number; contractHash: string }> {
  checkServingContractInput(input, actor);
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    return saveServingContractTx(tx, input, actor);
  }));
}

/** Input checks that need no DB; throws the reason code. */
export function checkServingContractInput(input: AdminServingContractInput, actor: string) {
  const checked = validateAdminServingContract(input.routeId, input.contract);
  if (!checked.ok) throw new Error(checked.reason);
  if (!["gateway", "none", "stored"].includes(input.auth) || !["gateway", "direct", undefined].includes(input.transport) || !actor.trim())
    throw new Error("serving_contract_input_invalid");
  const newKey = input.apiKey?.trim() || undefined;
  if (newKey && (newKey.length > 4096 || /[\s\p{Cc}]/u.test(newKey))) throw new Error("serving_contract_key_invalid");
  if (input.auth === "stored" && newKey && !secretBoxReady()) throw new Error("secret_box_key_missing");
  return { contract: checked.contract, newKey };
}

/** The save inside a caller's fenced transaction (engine connect saves several rows atomically). */
export async function saveServingContractTx(tx: Tx, input: AdminServingContractInput, actor: string): Promise<{ id: number; contractHash: string }> {
  const { contract, newKey } = checkServingContractInput(input, actor);
  const note = input.note?.trim() ? input.note.trim().slice(0, 400) : null, model = contract.model, routeId = input.routeId;
  const transport = input.transport ?? "gateway";
  const contractHash = servingContractHash(contract);
  const [previous] = await tx.select().from(modelServingContracts)
    .where(and(eq(modelServingContracts.routeId, routeId), eq(modelServingContracts.model, model), eq(modelServingContracts.enabled, true))).for("update");
  const ciphertext = input.auth !== "stored" ? null : newKey ? sealSecret(newKey, servingContractKeyAad(routeId, model))
    : previous?.auth === "stored" ? previous.apiKeyCiphertext : null;
  if (input.auth === "stored" && !ciphertext) throw new Error("serving_contract_key_required");
  if (previous) await tx.update(modelServingContracts).set({ enabled: false, updatedBy: actor, updatedAt: new Date() }).where(eq(modelServingContracts.id, previous.id));
  const [row] = await tx.insert(modelServingContracts).values({ routeId, model, contract: { ...contract }, contractHash, auth: input.auth,
    transport, apiKeyCiphertext: ciphertext, enabled: true, note, updatedBy: actor }).returning({ id: modelServingContracts.id });
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "model-serving-contract-save", target: `${routeId}:${model}`,
    detail: { id: row.id, previousId: previous?.id ?? null, contractHash, previousHash: previous?.contractHash ?? null, auth: input.auth, transport,
      keyChanged: input.auth === "stored" && !!newKey, endpoint: typeof contract.endpoint === "string" ? contract.endpoint : null, note } }));
  return { id: row.id, contractHash };
}

/**
 * Store a local-direct contract (protocol local-openai-chat-v1) in the same table (PR 3b-A assignment save). The row's route_id is namespaced
 * (`local-direct:<route>`, LOCAL_DIRECT_CONTRACT_ROUTE_PREFIX) so a gateway route's (route_id, model) contract is never replaced or closed by it;
 * the stored JSON is the local contract plus that `routeId` (the table's identity CHECK), its hash is localModelContractHash of the local contract
 * (the hash the helper evidence and the local dispatch use). transport 'direct', auth 'none' (local engines carry no key). Same history rule
 * as saveServingContractTx: the previous enabled row of the route+model is disabled, never deleted; one `model-serving-contract-save` audit row.
 * Nothing reads these rows yet (3b-C moves the verified local contract readers here); the env LOCAL_MODEL_SERVING_CONTRACTS still decides.
 */
export async function saveLocalServingContractTx(tx: Tx, input: { routeId: string; contract: unknown; note?: string | null }, actor: string):
  Promise<{ id: number; contractHash: string }> {
  const { LOCAL_DIRECT_CONTRACT_ROUTE_PREFIX } = await import("@/lib/llm/capacity-helpers");
  const { localModelContractHash, localModelServingContractSchema } = await import("@/lib/llm/local-model-serving-contract");
  const parsed = localModelServingContractSchema.safeParse(input.contract);
  const routeId = input.routeId;
  if (!parsed.success) throw new Error("contract_schema_invalid");
  if (!routeId.startsWith(LOCAL_DIRECT_CONTRACT_ROUTE_PREFIX) || routeId.length > 64 || routeId !== routeId.trim() || !actor.trim())
    throw new Error("serving_contract_input_invalid");
  const contract = parsed.data, model = contract.model, contractHash = localModelContractHash(contract);
  const note = input.note?.trim() ? input.note.trim().slice(0, 400) : null;
  const [previous] = await tx.select().from(modelServingContracts)
    .where(and(eq(modelServingContracts.routeId, routeId), eq(modelServingContracts.model, model), eq(modelServingContracts.enabled, true))).for("update");
  if (previous) await tx.update(modelServingContracts).set({ enabled: false, updatedBy: actor, updatedAt: new Date() }).where(eq(modelServingContracts.id, previous.id));
  const [row] = await tx.insert(modelServingContracts).values({ routeId, model, contract: { ...contract, routeId }, contractHash, auth: "none",
    transport: "direct", apiKeyCiphertext: null, enabled: true, note, updatedBy: actor }).returning({ id: modelServingContracts.id });
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "model-serving-contract-save", target: `${routeId}:${model}`,
    detail: { id: row.id, previousId: previous?.id ?? null, contractHash, previousHash: previous?.contractHash ?? null, auth: "none", transport: "direct",
      keyChanged: false, endpoint: contract.endpoint, protocol: contract.protocol, note } }));
  return { id: row.id, contractHash };
}

/**
 * CLI 계약 행 저장(PR C1 — 「작업 ↔ 모델」 순위 저장이 1차·2차·Grok 로그인 유지 CLI 순위에 만든다). route_id 는 `cli:<provider>:<route>`(cliContractRouteId)라
 * 같은 이름의 API 계약·다른 CLI 의 계약과 겹치지 않고, 계약 JSON 의 routeId 도 그 값이다(표의 identity CHECK). hash 는 원래 계약(routeId = route)의
 * cliServingContractHash 다(호출 binding 의 cliContractHash 와 같다). auth none·transport direct(키 없음). 앞의 켜진 행은 꺼서 남기고 감사 한 줄을 쓴다.
 */
export async function saveCliServingContractTx(tx: Tx, input: { contract: unknown; note?: string | null }, actor: string): Promise<{ id: number; contractHash: string }> {
  const { CLI_DB_CONTRACT_ROUTES, cliContractRouteId, cliServingContractHash, cliServingContractSchema } = await import("@/lib/llm/cli-serving-contract");
  const parsed = cliServingContractSchema.safeParse(input.contract);
  if (!parsed.success || !CLI_DB_CONTRACT_ROUTES.has(parsed.data.routeId)) throw new Error("contract_schema_invalid");
  if (!actor.trim()) throw new Error("serving_contract_input_invalid");
  const contract = parsed.data, routeId = cliContractRouteId(contract.provider, contract.routeId), model = contract.model;
  const contractHash = cliServingContractHash(contract);
  const note = input.note?.trim() ? input.note.trim().slice(0, 400) : null;
  const [previous] = await tx.select().from(modelServingContracts)
    .where(and(eq(modelServingContracts.routeId, routeId), eq(modelServingContracts.model, model), eq(modelServingContracts.enabled, true))).for("update");
  if (previous) await tx.update(modelServingContracts).set({ enabled: false, updatedBy: actor, updatedAt: new Date() }).where(eq(modelServingContracts.id, previous.id));
  const [row] = await tx.insert(modelServingContracts).values({ routeId, model, contract: { ...contract, routeId }, contractHash, auth: "none",
    transport: "direct", apiKeyCiphertext: null, enabled: true, note, updatedBy: actor }).returning({ id: modelServingContracts.id });
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "model-serving-contract-save", target: `${routeId}:${model}`,
    detail: { id: row.id, previousId: previous?.id ?? null, contractHash, previousHash: previous?.contractHash ?? null, auth: "none", transport: "direct",
      keyChanged: false, endpoint: null, protocol: contract.protocol, cliVersion: contract.cliVersion, note } }));
  return { id: row.id, contractHash };
}

/** Turn an admin contract off: that route+model then has no contract (its calls defer) until one is saved again. */
export async function disableAdminServingContract(routeId: string, model: string, actor: string): Promise<boolean> {
  if (!isRoute(routeId) || !actor.trim()) throw new Error("serving_contract_input_invalid");
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
    const [previous] = await tx.select().from(modelServingContracts)
      .where(and(eq(modelServingContracts.routeId, routeId), eq(modelServingContracts.model, model), eq(modelServingContracts.enabled, true))).for("update");
    if (!previous) return false;
    await tx.update(modelServingContracts).set({ enabled: false, updatedBy: actor, updatedAt: new Date() }).where(eq(modelServingContracts.id, previous.id));
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: "model-serving-contract-disable", target: `${routeId}:${model}`,
      detail: { id: previous.id, contractHash: previous.contractHash } }));
    return true;
  }));
}

/**
 * Read an OpenAI-compatible engine's model list to fill a contract (responseModel, totalTokenBound). GET only, no redirects,
 * 5 s. The key is used for this one request and never returned.
 */
export async function readbackServingEndpoint(endpoint: string, apiKey: string | null, request: typeof fetch = fetch):
  Promise<{ ok: true; models: { id: string; maxModelLen: number | null; canonicalModel?: string }[] } | { ok: false; reason: string }> {
  let url: URL;
  try { url = new URL(endpoint); } catch { return { ok: false, reason: "endpoint_invalid" }; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return { ok: false, reason: "endpoint_invalid" };
  const base = url.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
  try {
    const response = await request(`${url.origin}${base}/models`, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5_000),
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    if (!response.ok) return { ok: false, reason: `http_${response.status}` };
    const body = await response.json() as { data?: { id?: unknown; max_model_len?: unknown; root?: unknown }[] };
    return { ok: true, models: (body.data ?? []).flatMap(item => typeof item.id === "string" ? [{ id: item.id,
      maxModelLen: typeof item.max_model_len === "number" && Number.isSafeInteger(item.max_model_len) ? item.max_model_len : null,
      ...(typeof item.root === "string" && item.root.length > 0 && item.root.length <= 200 && item.root === item.root.trim()
        && !/[\p{Cc}]/u.test(item.root) ? { canonicalModel: item.root } : {}) }] : []) };
  } catch { return { ok: false, reason: "unreachable" }; }
}
