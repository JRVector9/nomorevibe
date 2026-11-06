import { createHash } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { aiConnections, aiTaskModels, operationsAudit } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import {
  EMBEDDING_DIMENSIONS, EMBEDDING_DOCUMENT, EMBEDDING_MODEL, EMBEDDING_MODEL_SHA256, EMBEDDING_PARITY_MIN_COSINE,
  EMBEDDING_PARITY_MIN_SAMPLES, EMBEDDING_PREPROCESSING_HASH, embeddingParity, embeddingReadiness,
} from "./embedding";
import {
  normalizeSearchBaseUrl, resolveSearchModelSettings, resolveSearchModelSettingsFromRows, type SearchModelTask,
} from "./search-model-settings";
import { aiConnectionBaseUrl, aiConnectionKeyAad, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { listAiConnections } from "@/lib/operations/admin-ai-tasks-repository";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { openSecret } from "@/lib/security/secret-box";
import { DrWriterFencedError, writerSiteActive } from "@/lib/operations/dr/epoch";
import {
  aiTaskModelSnapshotRows, ensureAiTaskModels, withReadOnlyAiTaskModels, type AiTaskModelSnapshotRow,
} from "@/lib/llm/ai-task-models-snapshot";
import { readSearchModelJson } from "./search-model-http";

type Reader = Pick<ProductTransaction, "select" | "execute">;
type RankRow = Readonly<{
  id: number; task: string; slot: number; rank: number; connectionId: string; model: string;
  options: Readonly<Record<string, unknown>>; enabled: boolean;
}>;
type StoredSample = { product_id: number; embedding: string; document: string };
type PreConnection = { version: number; baseUrl: string | null; apiKeyCiphertext: string | null; kind: string; enabled: boolean; models: unknown };
type Pre = { revision: string; connection: PreConnection | null; apiKey: string | null };
type ReadyConnection = { ok: true; version: number; rawBaseUrl: string | null; apiKeyCiphertext: string | null; baseUrl: string; apiKey: string | null };

const SEARCH_TASKS = ["product-embedding", "search-embedding", "search-rerank"] as const;
const EMBEDDING_TASKS: readonly SearchModelTask[] = ["product-embedding", "search-embedding"];
const SAVE_ACTION = "search-model-settings-save";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^search_model_[a-z0-9_]+$/;
const CONTROL = /\p{Cc}/u;
const validActor = (actor: string): boolean => typeof actor === "string" && !!actor.trim() && actor.length <= 120 && !CONTROL.test(actor);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export type SearchModelServiceView = Readonly<{
  source: "environment" | "configured";
  baseUrl: string;
  model: string | null;
  /** GET /v1/models(목록 응답)만 본 상태다 — 화면을 열 때 실제 추론을 돌리지 않는다. */
  status: "configured" | "environment" | "unconfigured" | "error" | "unobserved";
  error?: string;
  servedModels?: readonly string[];
}>;
export type SearchModelSettingsView = Readonly<{
  revision: string;
  connections: AiConnectionView[];
  embedding: SearchModelServiceView;
  rerank: SearchModelServiceView;
  stored: readonly { model: string; count: number; latest: string | null }[];
  readAt: string;
  observedAt: string;
}>;
export type SearchModelSettingsSaveResult = { ok: true } | { ok: false; issue: string };

async function loadRanks(reader: Reader): Promise<RankRow[]> {
  const rows = await reader.select({
    id: aiTaskModels.id, task: aiTaskModels.task, slot: aiTaskModels.slot, rank: aiTaskModels.rank,
    connectionId: aiTaskModels.connectionId, model: aiTaskModels.model, options: aiTaskModels.options, enabled: aiTaskModels.enabled,
  }).from(aiTaskModels).where(inArray(aiTaskModels.task, [...SEARCH_TASKS]))
    .orderBy(asc(aiTaskModels.task), asc(aiTaskModels.slot), asc(aiTaskModels.rank));
  return rows.map((row) => ({ ...row, options: { ...row.options } }));
}

function searchRevision(rows: readonly RankRow[]): string {
  const ordered = [...rows].sort((a, b) => a.task.localeCompare(b.task) || a.slot - b.slot || a.rank - b.rank || a.id - b.id);
  return sha256(JSON.stringify(ordered.map(({ id, task, slot, rank, connectionId, model, options, enabled }) =>
    ({ id, task, slot, rank, connectionId, model, options, enabled }))));
}

function modelListed(models: unknown, model: string): boolean {
  return Array.isArray(models) && models.some((entry) => !!entry && typeof entry === "object" && (entry as { id?: unknown }).id === model);
}

function codeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return SAFE_CODE.test(message) ? message : "search_model_settings_unavailable";
}

function configuredSource(task: SearchModelTask, rows: readonly AiTaskModelSnapshotRow[]): "environment" | "configured" {
  if (task === "search-rerank") return rows.some((row) => row.task === task) ? "configured" : "environment";
  return rows.some((row) => row.task === "product-embedding" || row.task === "search-embedding") ? "configured" : "environment";
}

type ModelListProbe = { ok: true; models: string[] } | { ok: false; error: string };
function modelListIds(body: unknown): string[] | null {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data) || data.length === 0 || data.length > 512) return null;
  const models: string[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.length <= 200 && !CONTROL.test(id)) models.push(id);
  }
  return models;
}
async function probeModelList(baseUrl: string, apiKey: string | null, timeoutMs: number): Promise<ModelListProbe> {
  const base = normalizeSearchBaseUrl(baseUrl);
  if (!base) return { ok: false, error: "search_model_url_missing" };
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(`${base}/v1/models`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch { return { ok: false, error: "search_model_models_unavailable" }; }
  if (!response.ok) return { ok: false, error: `search_model_models_http_${response.status}` };
  let body: unknown;
  try { body = await readSearchModelJson(response, 1_000_000); }
  catch { return { ok: false, error: "search_model_models_bad_response" }; }
  const models = modelListIds(body);
  if (!models || !models.length) return { ok: false, error: "search_model_models_bad_response" };
  return { ok: true, models };
}

type VersionedSnapshotRow = AiTaskModelSnapshotRow & Readonly<{ connection: AiTaskModelSnapshotRow["connection"] & Readonly<{ version: number }> }>;

async function describeService(
  task: SearchModelTask, rows: readonly VersionedSnapshotRow[], probe: boolean,
): Promise<SearchModelServiceView> {
  try {
    const settings = process.env.MODEL_SERVING_CONTRACTS_DB === "0"
      ? await resolveSearchModelSettings(task)
      : await resolveSearchModelSettingsFromRows(task, rows);
    if (!settings.baseUrl) return { source: settings.source, baseUrl: "", model: settings.model, status: "unconfigured" };
    if (!probe) return { source: settings.source, baseUrl: settings.baseUrl, model: settings.model, status: "unobserved" };
    if (settings.source === "environment" && task !== "search-rerank") {
      const readiness = embeddingReadiness(process.env, settings.baseUrl);
      if (readiness.mode === "degraded")
        return { source: settings.source, baseUrl: settings.baseUrl, model: settings.model, status: "error", error: `degraded:${readiness.reasons.join(",")}` };
    }
    const observedProbe = await probeModelList(settings.baseUrl, settings.apiKey, 3_000);
    if (!observedProbe.ok) return { source: settings.source, baseUrl: settings.baseUrl, model: settings.model, status: "error", error: observedProbe.error };
    if (settings.source === "configured" && settings.model && !observedProbe.models.includes(settings.model))
      return { source: settings.source, baseUrl: settings.baseUrl, model: settings.model, status: "error", error: "search_model_model_not_listed" };
    const observed = settings.model ?? (task !== "search-rerank" && observedProbe.models.includes(EMBEDDING_MODEL)
      ? EMBEDDING_MODEL : observedProbe.models.length === 1 ? observedProbe.models[0]! : null);
    return { source: settings.source, baseUrl: settings.baseUrl, model: observed,
      status: settings.source === "configured" ? "configured" : "environment", servedModels: observedProbe.models };
  } catch (error) {
    const source: "environment" | "configured" = process.env.MODEL_SERVING_CONTRACTS_DB === "0"
      ? "environment"
      : configuredSource(task, rows);
    if (source === "environment") {
      const baseUrl = normalizeSearchBaseUrl(task === "search-rerank" ? process.env.RERANK_URL : process.env.EMBEDDING_URL);
      const model = task === "search-rerank" ? null : EMBEDDING_MODEL;
      return { source, baseUrl, model, status: "error", error: codeOf(error) };
    }
    const row = task === "search-rerank"
      ? rows.find((entry) => entry.task === task)
      : (rows.find((entry) => entry.task === "product-embedding") ?? rows.find((entry) => entry.task === "search-embedding"));
    const baseUrl = row ? normalizeSearchBaseUrl(aiConnectionBaseUrl(row.connection.baseUrl ?? "")) : "";
    return { source, baseUrl, model: row?.model ?? null, status: "error", error: codeOf(error) };
  }
}

export async function readSearchModelSettings(options: { probe?: boolean } = {}): Promise<SearchModelSettingsView> {
  const probe = options.probe !== false;
  return withReadOnlyAiTaskModels(async () => {
    const data = await onPrimary(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      const reader = tx as unknown as Reader;
      const rows = await loadRanks(reader);
      const connections = await listAiConnections(reader);
      const storedRows = Array.from(await tx.execute<{ model: string; count: number | string; latest: Date | string | null }>(sql`
        SELECT model, count(*)::int AS count, max(embedded_at) AS latest
        FROM product_embeddings GROUP BY model ORDER BY model`));
      const snapshots: VersionedSnapshotRow[] = process.env.MODEL_SERVING_CONTRACTS_DB === "0" ? [] : await (async () => {
        const rawRows = Array.from(await tx.execute<{
          task: string; slot: number | string; rank: number | string; model: string; enabled: boolean; options: unknown;
          connection_id: string; label: string; kind: string; base_url: string | null; api_key_ciphertext: string | null;
          cli_tool: string | null; device_id: string; connection_enabled: boolean; models: unknown;
          connection_options: unknown; connection_version: number | string;
        }>(sql`
          SELECT t.task, t.slot, t.rank, t.model, t.enabled, t.options,
                 c.id AS connection_id, c.label, c.kind, c.base_url, c.api_key_ciphertext,
                 c.cli_tool, c.device_id, c.enabled AS connection_enabled, c.models,
                 c.options AS connection_options, c.version AS connection_version
          FROM ai_task_models t JOIN ai_connections c ON c.id = t.connection_id
          WHERE t.task IN ('product-embedding', 'search-embedding', 'search-rerank')
          ORDER BY t.task, t.slot, t.rank`));
        return aiTaskModelSnapshotRows(rawRows).map((row, index) => ({
          ...row,
          connection: { ...row.connection, version: Number(rawRows[index]!.connection_version) },
        }));
      })();
      return {
        revision: searchRevision(rows),
        connections,
        stored: storedRows.map((row) => ({ model: row.model, count: Number(row.count),
          latest: row.latest ? new Date(row.latest).toISOString() : null })),
        snapshots,
        readAt: new Date().toISOString(),
      };
    }, { accessMode: "read only", isolationLevel: "repeatable read" }));
    const [embedding, rerank] = await Promise.all([
      describeService("product-embedding", data.snapshots, probe),
      describeService("search-rerank", data.snapshots, probe),
    ]);
    return {
      revision: data.revision, connections: data.connections, stored: data.stored,
      embedding, rerank, readAt: data.readAt, observedAt: new Date().toISOString(),
    };
  });
}

async function readPre(connectionId: string): Promise<Pre> {
  return onPrimary(() => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const rows = await loadRanks(tx as unknown as Reader);
    const [connection] = await tx.select({
      version: aiConnections.version, baseUrl: aiConnections.baseUrl, apiKeyCiphertext: aiConnections.apiKeyCiphertext,
      kind: aiConnections.kind, enabled: aiConnections.enabled, models: aiConnections.models,
    }).from(aiConnections).where(eq(aiConnections.id, connectionId)).limit(1);
    let apiKey: string | null = null;
    if (connection?.apiKeyCiphertext) {
      try { apiKey = openSecret(connection.apiKeyCiphertext, aiConnectionKeyAad(connectionId)); } catch { apiKey = null; }
    }
    return { revision: searchRevision(rows), connection: connection ?? null, apiKey };
  }, { accessMode: "read only" }));
}

function readyConnection(pre: Pre, model: string): ReadyConnection | { ok: false; issue: string } {
  const connection = pre.connection;
  if (!connection) return { ok: false, issue: "search_model_connection_not_found" };
  if (!connection.enabled) return { ok: false, issue: "search_model_connection_disabled" };
  if (connection.kind !== "api") return { ok: false, issue: "search_model_connection_not_api" };
  const baseUrl = aiConnectionBaseUrl(connection.baseUrl ?? "");
  if (!baseUrl) return { ok: false, issue: "search_model_base_url_invalid" };
  if (connection.apiKeyCiphertext && !pre.apiKey) return { ok: false, issue: "search_model_key_unreadable" };
  if (!modelListed(connection.models, model)) return { ok: false, issue: "search_model_model_not_listed" };
  return { ok: true, version: connection.version, rawBaseUrl: connection.baseUrl,
    apiKeyCiphertext: connection.apiKeyCiphertext, baseUrl, apiKey: pre.apiKey };
}

function parseStoredVector(text: string): number[] | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) return null;
    const vector: number[] = [];
    for (const entry of value) {
      if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
      vector.push(entry);
    }
    return vector;
  } catch { return null; }
}

async function verifyEmbedding(connection: ReadyConnection, model: string): Promise<{ ok: true; profile: Record<string, unknown> } | { ok: false; issue: string }> {
  let samples: StoredSample[];
  try {
    samples = await onPrimary(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      return Array.from(await tx.execute<StoredSample>(sql`
        SELECT e.product_id, e.embedding::text AS embedding, ${EMBEDDING_DOCUMENT} AS document
        FROM product_embeddings e JOIN products ON products.id = e.product_id
        WHERE e.model = ${EMBEDDING_MODEL} AND e.text_hash = md5(${EMBEDDING_DOCUMENT})
          AND products.status IN ('seeded', 'verified')
        ORDER BY e.product_id DESC LIMIT 32`));
    }, { accessMode: "read only" }));
  } catch { return { ok: false, issue: "search_model_embedding_samples_unavailable" }; }
  if (samples.length !== 32 || samples.some((row) => typeof row.document !== "string"))
    return { ok: false, issue: "search_model_embedding_samples_missing" };
  const stored: number[][] = [];
  for (const row of samples) {
    const vector = parseStoredVector(row.embedding);
    if (!vector) return { ok: false, issue: "search_model_embedding_samples_unavailable" };
    stored.push(vector);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}/embeddings`, {
      method: "POST", headers, body: JSON.stringify({ input: samples.map((row) => row.document), model }),
      signal: AbortSignal.timeout(30_000), redirect: "error",
    });
  } catch { return { ok: false, issue: "search_model_embedding_probe_failed" }; }
  if (!response.ok) return { ok: false, issue: "search_model_embedding_probe_failed" };
  let body: unknown;
  try { body = await readSearchModelJson(response, 8_000_000); }
  catch { return { ok: false, issue: "search_model_embedding_bad_response" }; }
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data)) return { ok: false, issue: "search_model_embedding_bad_response" };
  const byIndex = new Map<number, number[]>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object") return { ok: false, issue: "search_model_embedding_bad_response" };
    const index = (entry as { index?: unknown }).index;
    const embedding = (entry as { embedding?: unknown }).embedding;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= 32 || byIndex.has(index))
      return { ok: false, issue: "search_model_embedding_bad_response" };
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS)
      return { ok: false, issue: "search_model_embedding_bad_response" };
    const vector: number[] = [];
    for (const value of embedding) {
      if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, issue: "search_model_embedding_bad_response" };
      vector.push(value);
    }
    byIndex.set(index, vector);
  }
  if (byIndex.size !== 32) return { ok: false, issue: "search_model_embedding_bad_response" };
  const observed = Array.from({ length: 32 }, (_, index) => byIndex.get(index)!);
  const parity = embeddingParity(samples.map((_, index) => ({ observed: observed[index]!, stored: stored[index]! })));
  if (parity.samples < EMBEDDING_PARITY_MIN_SAMPLES || parity.minCosine < EMBEDDING_PARITY_MIN_COSINE)
    return { ok: false, issue: "search_model_embedding_parity_failed" };
  return { ok: true, profile: {
    version: 1, model: EMBEDDING_MODEL, modelSha256: EMBEDDING_MODEL_SHA256, dimensions: EMBEDDING_DIMENSIONS,
    preprocessingHash: EMBEDDING_PREPROCESSING_HASH,
    parity: { samples: parity.samples, minCosine: parity.minCosine },
    endpoint: connection.baseUrl, modelName: model, connectionVersion: connection.version,
  } };
}

async function verifyRerank(connection: Pick<ReadyConnection, "baseUrl" | "apiKey">, model: string): Promise<{ ok: true } | { ok: false; issue: string }> {
  const signal = AbortSignal.timeout(10_000);
  const authHeaders: Record<string, string> = {};
  if (connection.apiKey) authHeaders.authorization = `Bearer ${connection.apiKey}`;
  let listResponse: Response;
  try {
    listResponse = await fetch(`${connection.baseUrl}/models`, { method: "GET", headers: authHeaders,
      signal, redirect: "error" });
  } catch { return { ok: false, issue: "search_model_rerank_probe_failed" }; }
  if (!listResponse.ok) return { ok: false, issue: "search_model_rerank_probe_failed" };
  let listBody: unknown;
  try { listBody = await readSearchModelJson(listResponse, 1_000_000); }
  catch { return { ok: false, issue: "search_model_rerank_bad_response" }; }
  const models = modelListIds(listBody);
  if (!models) return { ok: false, issue: "search_model_rerank_bad_response" };
  if (!models.includes(model)) return { ok: false, issue: "search_model_rerank_model_not_listed" };

  let rerankResponse: Response;
  try {
    rerankResponse = await fetch(`${connection.baseUrl}/rerank`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ model, query: "검색 연결 확인", documents: ["검색 모델 API 연결을 확인합니다."], top_n: 1 }),
      signal, redirect: "error",
    });
  } catch { return { ok: false, issue: "search_model_rerank_probe_failed" }; }
  if (!rerankResponse.ok) return { ok: false, issue: "search_model_rerank_probe_failed" };
  let rerankBody: unknown;
  try { rerankBody = await readSearchModelJson(rerankResponse, 1_000_000); }
  catch { return { ok: false, issue: "search_model_rerank_bad_response" }; }
  const results = rerankBody && typeof rerankBody === "object" ? (rerankBody as { results?: unknown }).results : null;
  if (!Array.isArray(results) || results.length !== 1) return { ok: false, issue: "search_model_rerank_bad_response" };
  const first = results[0];
  if (!first || typeof first !== "object") return { ok: false, issue: "search_model_rerank_bad_response" };
  const index = (first as { index?: unknown }).index;
  const score = (first as { relevance_score?: unknown }).relevance_score;
  if (index !== 0 || typeof score !== "number" || !Number.isFinite(score))
    return { ok: false, issue: "search_model_rerank_bad_response" };
  return { ok: true };
}

function issueOf(error: unknown): string {
  if (error instanceof DrWriterFencedError) return "site_fenced";
  const message = error instanceof Error ? error.message : "";
  return SAFE_CODE.test(message) ? message : "search_model_save_failed";
}

export async function saveSearchModelSettings(
  input: { revision: string; kind: "embedding" | "rerank"; connectionId: string; model: string }, actor: string,
): Promise<SearchModelSettingsSaveResult> {
  if (process.env.MODEL_SERVING_CONTRACTS_DB === "0") return { ok: false, issue: "search_model_database_disabled" };
  if (!validActor(actor)) return { ok: false, issue: "invalid_actor" };
  if (!REVISION.test(input.revision)) return { ok: false, issue: "search_model_revision_invalid" };
  if (input.kind !== "embedding" && input.kind !== "rerank") return { ok: false, issue: "search_model_kind_invalid" };
  if (typeof input.model !== "string") return { ok: false, issue: "search_model_model_invalid" };
  const model = input.model.trim();
  if (!model || model.length > 200 || CONTROL.test(model)) return { ok: false, issue: "search_model_model_invalid" };
  if (!UUID.test(input.connectionId)) return { ok: false, issue: "search_model_connection_not_found" };
  try {
    const pre = await readPre(input.connectionId);
    if (pre.revision !== input.revision) return { ok: false, issue: "search_model_revision_mismatch" };
    const ready = readyConnection(pre, model);
    if (!ready.ok) return ready;

    let profile: Record<string, unknown> | null = null;
    if (input.kind === "embedding") {
      const verified = await verifyEmbedding(ready, model);
      if (!verified.ok) return verified;
      profile = verified.profile;
    } else {
      const verified = await verifyRerank(ready, model);
      if (!verified.ok) return verified;
    }

    await onPrimary(() => db.transaction(async (tx) => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('search_model_settings'), hashtext('all'))`);
      const allTasks = [...SEARCH_TASKS].sort();
      for (const task of allTasks) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_execution_task'), hashtext(${task}))`);
      }
      for (const task of allTasks) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_models'), hashtext(${`${task}#1`}))`);
      }
      const reader = tx as unknown as Reader;
      const before = await loadRanks(reader);
      if (searchRevision(before) !== input.revision) throw new Error("search_model_revision_mismatch");
      const [live] = await tx.select({
        version: aiConnections.version, baseUrl: aiConnections.baseUrl, apiKeyCiphertext: aiConnections.apiKeyCiphertext,
        kind: aiConnections.kind, enabled: aiConnections.enabled, models: aiConnections.models,
      }).from(aiConnections).where(eq(aiConnections.id, input.connectionId)).for("share");
      if (!live || live.version !== ready.version || live.baseUrl !== ready.rawBaseUrl
        || live.apiKeyCiphertext !== ready.apiKeyCiphertext || !live.enabled || live.kind !== "api")
        throw new Error("search_model_connection_changed");
      if (!modelListed(live.models, model)) throw new Error("search_model_model_not_listed");

      if (input.kind === "embedding") {
        if (!profile) throw new Error("search_model_embedding_profile_missing");
        await tx.delete(aiTaskModels).where(inArray(aiTaskModels.task, [...EMBEDDING_TASKS]));
        await tx.insert(aiTaskModels).values(EMBEDDING_TASKS.map((task) => ({
          task, slot: 1, rank: 1, connectionId: input.connectionId, model,
          options: { searchEmbeddingProfile: profile }, enabled: true, updatedBy: actor,
        })));
      } else {
        await tx.delete(aiTaskModels).where(eq(aiTaskModels.task, "search-rerank"));
        await tx.insert(aiTaskModels).values({ task: "search-rerank", slot: 1, rank: 1,
          connectionId: input.connectionId, model, options: {}, enabled: true, updatedBy: actor });
      }

      const after = await loadRanks(reader);
      const revisionAfter = searchRevision(after);
      const detail = {
        kind: input.kind, connectionId: input.connectionId, model,
        profile: profile ? { version: profile.version, model: profile.model, referenceModelSha256: profile.modelSha256,
          dimensions: profile.dimensions, preprocessingHash: profile.preprocessingHash,
          endpoint: profile.endpoint, modelName: profile.modelName, parity: profile.parity,
          connectionVersion: profile.connectionVersion } : null,
        revisionBefore: input.revision, revisionAfter,
        before: before.map((row) => ({ task: row.task, slot: row.slot, rank: row.rank,
          connectionId: row.connectionId, model: row.model, enabled: row.enabled })),
        after: after.map((row) => ({ task: row.task, slot: row.slot, rank: row.rank,
          connectionId: row.connectionId, model: row.model, enabled: row.enabled })),
      };
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, {
        action: SAVE_ACTION, target: input.kind, detail,
      }));
    }));
    await ensureAiTaskModels(0);
    return { ok: true };
  } catch (error) { return { ok: false, issue: issueOf(error) }; }
}
