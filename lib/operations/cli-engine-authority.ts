import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { aiConnections, modelCapacityRequests, modelServingContracts, operationsObservations } from "@/lib/db/schema";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { writerSiteActive } from "@/lib/operations/dr/epoch";
import { readCliHostTarget } from "./cli-host-target";
import { cliEngineBearer } from "@/lib/llm/cli-engine-auth";
import { cliEngineEndpoint, parseCliEngineRevision } from "@/lib/llm/cli-engine-config";
import { servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { localModelBindingSchema } from "@/lib/llm/local-model-capacity-contract";
import { localModelContractRouteId } from "@/lib/llm/local-model-contract-table";
import { localModelContractHash, localModelServingContractSchema } from "@/lib/llm/local-model-serving-contract";
import { crawlTaglineDispatchBindingSchema, textProfileDispatchBindingSchema, reasonTranslationDispatchBindingSchema,
  productTranslationDispatchBindingSchema, productTaglineKoDispatchBindingSchema, searchVerifyDispatchBindingSchema,
  websearchQueryDispatchBindingSchema, publicationClassifyApiBindingSchema } from "@/lib/llm/capacity";
import { registeredGatewayServingContractSchema, type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import type { CliEngineAuthorizationInput, CliEngineAuthorization, CliEngineClientAuth } from "./cli-engine-protocol";
// Register the exact existing per-domain parsers; JSONB field order must never substitute for a contract hash.
import "@/lib/llm/crawl-tagline-serving-contract";
import "@/lib/llm/text-profile-serving-contract";
import "@/lib/llm/reason-translation-serving-contract";
import "@/lib/llm/product-translation-serving-contract";
import "@/lib/llm/product-tagline-ko-serving-contract";
import "@/lib/llm/search-verify-serving-contract";
import "@/lib/llm/websearch-query-serving-contract";
import "@/lib/llm/publication-classify-serving-contract";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const bindings = [localModelBindingSchema, crawlTaglineDispatchBindingSchema, textProfileDispatchBindingSchema,
  reasonTranslationDispatchBindingSchema, productTranslationDispatchBindingSchema, productTaglineKoDispatchBindingSchema,
  searchVerifyDispatchBindingSchema, websearchQueryDispatchBindingSchema, publicationClassifyApiBindingSchema];
const reject = (): never => { throw new Error("cli_engine_dispatch_unavailable"); };

type RequestRow = typeof modelCapacityRequests.$inferSelect;
async function contractFor(row: RequestRow) {
  if (row.state !== "dispatched" || !row.dispatchBindingHash) return reject();
  const binding = bindings.map(schema => schema.safeParse(row.dispatchBinding)).find(result => result.success)?.data;
  if (!binding || hash(JSON.stringify(binding.kind === "local_model_direct" ? binding : canonical(binding))) !== row.dispatchBindingHash || binding.model !== row.model
    || binding.routeId !== row.routeId || binding.provider !== row.provider) return reject();
  const candidates = await db.select().from(modelServingContracts).where(eq(modelServingContracts.model, row.model));
  for (const entry of candidates) {
    let contract: Record<string, unknown> | null = null;
    let contractHash: string | null = null;
    if (binding.kind === "local_model_direct") {
      if (!object(entry.contract)) continue;
      const { routeId, ...raw } = entry.contract;
      const parsed = localModelServingContractSchema.safeParse(raw);
      if (!parsed.success || routeId !== entry.routeId || entry.routeId !== localModelContractRouteId(parsed.data.backendId) && entry.routeId !== localModelContractRouteId(parsed.data.backendId, parsed.data.deploymentRevision)) continue;
      contract = parsed.data;
      contractHash = localModelContractHash(parsed.data);
    } else {
      if (entry.routeId !== row.routeId) continue;
      const schema = registeredGatewayServingContractSchema(row.routeId as GatewayServingRoute);
      const parsed = schema?.safeParse(entry.contract);
      if (!parsed?.success) continue;
      contract = parsed.data as unknown as Record<string, unknown>;
      contractHash = hash(JSON.stringify(parsed.data));
    }
    if (contractHash !== binding.servingContractHash || !contract) continue;
    if (contract.model !== row.model || contract.provider !== row.provider) return reject();
    if (binding.kind === "local_model_direct" && (binding.backendId !== contract.backendId
      || binding.physicalGroup !== contract.physicalGroup || binding.deploymentRevision !== contract.deploymentRevision)) return reject();
    const source = parseCliEngineRevision(contract.deploymentRevision);
    if (!source || typeof contract.endpoint !== "string" || typeof contract.responseModel !== "string"
      || typeof contract.totalTokenBound !== "number" || contract.totalTokenBound !== binding.totalTokenBound) return reject();
    const target = await readCliHostTarget(source.connectionId);
    if (cliEngineEndpoint(target.baseUrl) !== contract.endpoint || target.connectionId !== source.connectionId) return reject();
    return { binding, contract, source, target, bindingHash: row.dispatchBindingHash };
  }
  return reject();
}

/** Only registered CLI endpoints incur the extra primary read. Ordinary API traffic is unchanged. */
export async function resolveCliEngineClientAuth(requestId: string, endpoint: string): Promise<CliEngineClientAuth | null> {
  if (!servingContractSnapshot().rows.some(row => object(row.contract) && row.contract.endpoint === endpoint
    && parseCliEngineRevision(row.contract.deploymentRevision))) return null;
  if (currentReplayDb()) return reject();
  return onPrimary(async () => {
    const [row] = await db.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, requestId));
    if (!row) return reject();
    const actual = await contractFor(row);
    if (actual.contract.endpoint !== endpoint) return reject();
    return { bearer: cliEngineBearer(actual.target.apiKey), ...actual.source, bindingHash: actual.bindingHash };
  });
}

/** A permanent one-use tombstone is committed before spawn, including across native host restarts. */
export async function authorizeCliEngineExecution(input: CliEngineAuthorizationInput): Promise<CliEngineAuthorization> {
  if (currentReplayDb() || !/^[a-f0-9-]{36}$/.test(input.requestId) || hash(input.wire) !== input.wireHash) return reject();
  return onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return reject();
    const [row] = await tx.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, input.requestId)).for("update");
    if (!row) return reject();
    const actual = await contractFor(row);
    const expected = Buffer.from(cliEngineBearer(actual.target.apiKey));
    const supplied = Buffer.from(input.bearer);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)
      || actual.contract.endpoint !== input.endpoint || actual.binding.wireHash !== input.wireHash
      || (actual.contract.engineModel ?? actual.contract.model) !== input.model
      || actual.source.reasoningEffort !== input.reasoningEffort) return reject();
    const [connection] = await tx.select({ deviceId: aiConnections.deviceId, enabled: aiConnections.enabled })
      .from(aiConnections).where(eq(aiConnections.id, actual.source.connectionId));
    if (!connection?.enabled || connection.deviceId !== row.groupId) return reject();
    const claimed = await tx.insert(operationsObservations).values({ key: `cli-engine-attempt:${input.requestId}`,
      value: { version: 1, requestId: input.requestId, bindingHash: actual.bindingHash } }).onConflictDoNothing().returning({ key: operationsObservations.key });
    if (claimed.length !== 1) return reject();
    return { ...actual.source, model: input.model, responseModel: String(actual.contract.responseModel),
      totalTokenBound: Number(actual.contract.totalTokenBound), timeoutMs: 120_000, bindingHash: actual.bindingHash };
  }));
}
