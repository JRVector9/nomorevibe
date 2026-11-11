import { cliEngineModelIdentity } from "@/lib/llm/cli-engine-identity";
import { createHash, randomUUID } from "node:crypto";
import type { AiTaskPoolRuntime } from "@/lib/llm/ai-task-execution-config";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { aiConnections, aiTaskModels, aiTaskExecutionConfigs, aiTaskPoolMembers, modelCapacityControl, modelHelperAssignments, modelCapacityDevices, operationsAudit, operationsObservations, type AiConnectionModel } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { REVIEW_TASK_ROUTES, ensureReviewTaskRanks, resolveReviewTaskRanks, reviewRankUnusableText } from "@/lib/crawl/review-task-ranks";
import { AI_TASK_SLOT_MAX, AI_TEXT_TASK_IDS, aiTask, aiTaskReadsRanks, aiTaskSlotLabel, aiTaskSlots, isAiLiveTask, isAiReviewTask, isRetiredAiTask, RETIRED_AI_TASKS, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { cliDbContract } from "@/lib/llm/cli-db-contracts";
import { CLI_DB_CONTRACT_ROUTES, type CliProvider } from "@/lib/llm/cli-serving-contract";
import { textRankStatusFromCounts, textRankUnusableText, textTaskRankStatus, type TextRankStatus } from "@/lib/llm/ai-task-resolver";
import { listModelCapacityDevices, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import type { GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { resolveLocalModelContract, tableLocalModelContracts } from "@/lib/llm/local-model-contract-table";
import { localModelServingContractSchema, localModelServingContractsSchema, type LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { modelFamily, readModelRegistry } from "@/lib/llm/model-registry";
import { cliDerivedRegistryKeys } from "@/lib/llm/ai-task-models-snapshot";
import { ensureServingContracts, servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { logger } from "@/lib/observability/logger";
import { openSecret, sealSecret, secretBoxReady } from "@/lib/security/secret-box";
import {
  AI_CONNECTION_DELETE_AUDIT_ACTION, AI_CONNECTION_KEY_FILL_AUDIT_ACTION, AI_CONNECTION_MODEL_HIDE_AUDIT_ACTION, AI_CONNECTION_MODELS_AUDIT_ACTION, AI_CONNECTION_SAVE_AUDIT_ACTION, AI_TASK_AUDIT_ACTIONS,
  AI_TASK_MODELS_IMPORT_AUDIT_ACTION,
  AI_TASK_MODELS_SAVE_AUDIT_ACTION, aiConnectionBaseUrl, aiConnectionHiddenModels, aiConnectionHost, aiConnectionManualOnly, aiTaskRanksUnread, aiConnectionKeyAad, aiImportPlanDigestInput,
  aiRanksReadiness, aiTaskRankNotices,
  aiRankSavedOptions, aiTaskRankOptions, aiTaskSlotDigestInput, buildAiImportPlan, validateAiTaskRanks,
  type AiConnectionInput, type AiConnectionView, type AiCurrentSlot, type AiImportPlan, type AiPolicyRoute, type AiRankChoice, type AiRankOption,
  type AiImportConnection, type AiRankReadiness, type AiReadinessInput, type AiTaskRankRow, type AiTaskRanksInput,
} from "./admin-ai-tasks";
import { contractKeyMatch, maybeFillConnectionKeys, readConnectionModels } from "./ai-connection-key-fill";
import { buildAiCurrentSlots, readAiCurrentSources } from "./admin-ai-task-current";
import { aiTaskEditTarget } from "./ai-task-edit-target";
import { readCapacityDevicesControl } from "./admin-capacity-devices";
import { engineRouteContract, ENGINE_CONNECT_ROUTES, probeEngineContract } from "./admin-engine-connect";
import { adminAuditRow, adminLog, type AdminLogRow } from "./admin-log";
import { DIRECT_PROBE_INTERVAL_MS, directProbeDue, directProbeGate } from "./admin-models-direct-probe";
import { saveCliServingContractTx, saveServingContractTx } from "./admin-serving-contracts";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";
import { cliCatalogMetadataFromSnapshot, type CliCatalogMetadata } from "@/lib/llm/cli-catalog-metadata";
import { aiTaskUsesCliEngine, cliEngineEndpoint, cliEngineRevision } from "@/lib/llm/cli-engine-config";
import { cliEngineBearer } from "@/lib/llm/cli-engine-auth";
import { readAdminCliCatalog } from "./admin-cli-catalog";
import { saveLocalContract } from "./admin-cli-stage-resources";
import { validateCliHostTarget } from "./cli-host-target";

/**
 * 「AI 연결」·「작업 ↔ 모델」 저장·읽기(2026-11-02, PR A). 실행 쪽(잡)은 이 표를 아직 읽지 않는다 — 저장해도 오늘 동작은 바뀌지 않는다.
 * 순위 저장만은 다음 단계(PR B)가 바로 쓸 수 있게 오늘 실행 쪽이 요구하는 것을 같은 TX 에서 준비한다: 연결의 장비 행(없을 때)·엔진 직접 계약(없을 때,
 * 엔진 연결과 같은 readback + 1토큰 시험)·정책 route(덧붙이기만, DRAIN 없음). 기존 계약·route·장비 값·장비 역할 순위는 바꾸지 않는다.
 * 만들 수 없는 것이 빠진 순위는 저장하지 않고 무엇이 없는지 한국어로 돌려준다. 모든 저장은 operations_audit 에 한 줄을 남긴다(표는 지울 수 없다).
 */

type Reader = Pick<ProductTransaction, "select" | "execute">;
type ConnectionRecord = typeof aiConnections.$inferSelect;
type Fetch = typeof fetch;
const VERSION_MAX = 9007199254740991;
const fail = (code: string): never => { throw new Error(code); };
const SAFE_CODE = /^[a-z0-9_:./-]{1,160}$/;
const validActor = (actor: string) => typeof actor === "string" && !!actor.trim() && actor.length <= 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const aiTaskSlotRevision = (rows: readonly Pick<AiTaskRankRow, "rank" | "connectionId" | "model" | "options" | "enabled">[]) => sha256(aiTaskSlotDigestInput(rows));
export const aiImportPlanHash = (plan: AiImportPlan) => sha256(aiImportPlanDigestInput(plan));

export type AiTaskDeps = Readonly<{ request?: Fetch; now?: () => number; current?: () => Promise<AiCurrentSlot[]> }>;
let depsForTest: AiTaskDeps | null = null;
/** 테스트 전용 — 네트워크(/models·1토큰 시험)·시계·현재 값을 바꾼다. */
export function setAiTaskDepsForTest(deps: AiTaskDeps | null): void { depsForTest = deps; }
const request = (): Fetch => depsForTest?.request ?? fetch;
const now = () => depsForTest?.now?.() ?? Date.now();

/**
 * 거절 코드. 이 모듈이 던지는 것은 코드(SAFE_CODE)뿐이다. DB 오류는 drizzle 이 「Failed query: … params: …」로 감싸 cause 에 PG 오류를 둔다 —
 * 감싼 글(값·암호문이 든다)은 돌려주지도 기록하지도 않고, PG 오류의 제약 이름·코드만 본다.
 */
function issueOf(error: unknown): string {
  if (error instanceof DrWriterFencedError) return "site_fenced";
  const pg = (error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : error) as { code?: unknown; constraint_name?: unknown; message?: unknown };
  const constraint = typeof pg.constraint_name === "string" ? pg.constraint_name : null;
  if (pg.code === "23505") return constraint === "ai_connections_label_idx" ? "ai_connection_label_taken" : constraint === "ai_connections_base_url_idx"
    ? "ai_connection_base_url_taken" : constraint?.startsWith("ai_task_models") ? "ai_task_revision_mismatch" : "ai_task_save_conflict";
  if (pg.code === "23503" && (constraint === "ai_task_models_connection_fk" || constraint === "ai_task_pool_members_connection_fk")) return "ai_connection_in_use";
  const message = error instanceof Error ? error.message : String(error);
  if (SAFE_CODE.test(message)) return message;
  logger.warn("ai_tasks.save_failed", { code: typeof pg.code === "string" ? pg.code : null, constraint,
    error: typeof pg.message === "string" && pg !== error ? pg.message.slice(0, 200) : message.startsWith("Failed query") ? "failed_query" : message.slice(0, 200) });
  return "ai_task_save_failed";
}

// ── 읽기 ───────────────────────────────────────────────────────────────────────────────────────────────

const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
const hiddenModelsOf = aiConnectionHiddenModels;
export function aiConnectionView(row: ConnectionRecord): AiConnectionView {
  // 목록에서 뺀 모델은 화면·순위 선택지·검증이 보는 이 보기에서 빠진다(저장된 원래 목록과 실행 쪽 스냅숏은 그대로)
  const hidden = hiddenModelsOf(row.options), shown = (id: string) => !hidden.includes(id);
  const models = Array.isArray(row.models) ? row.models.filter((entry): entry is AiConnectionModel => !!entry && typeof entry.id === "string" && shown(entry.id))
    .map(entry => Object.freeze({ id: entry.id, maxModelLen: typeof entry.maxModelLen === "number" ? entry.maxModelLen : null })) : null;
  const storedOptions = row.options as Record<string, unknown>;
  const cliVersion = row.kind === "cli" && typeof storedOptions.cliVersion === "string" ? storedOptions.cliVersion : null;
  const catalog = row.kind === "cli" && row.cliTool === "opencode"
    ? cliCatalogMetadataFromSnapshot(storedOptions.cliHostCatalog, row.cliModels, cliVersion, sha256(JSON.stringify(row.cliModels))) : null;
  const cliCatalog = catalog && hidden.length ? Object.freeze({ ...catalog, models: Object.freeze(catalog.models.filter(model => shown(model.id))) }) : catalog;
  return Object.freeze({ id: row.id, label: row.label, kind: row.kind, baseUrl: row.baseUrl, host: aiConnectionHost(row.baseUrl), hasKey: row.apiKeyCiphertext !== null,
    cliTool: row.cliTool, cliModels: Object.freeze(row.cliModels.filter(shown)), models: models && Object.freeze(models), modelsReadAt: cliCatalog?.observedAt ?? iso(row.modelsReadAt), modelsError: row.modelsError,
    deviceId: row.deviceId, capacitySlots: row.capacitySlots, contextTokens: typeof row.options?.contextTokens === "number" ? row.options.contextTokens : null,
    enabled: row.enabled, version: Number(row.version), note: row.note, updatedBy: row.updatedBy, updatedAt: new Date(row.updatedAt).toISOString(),
    hiddenModels: Object.freeze(hidden), cliVersion, ...(row.kind === "cli" && row.cliTool === "opencode" ? { cliCatalog } : {}),
    ...connectionExtras(storedOptions, row.kind, shown) });
}
/** 2026-11-10 연결 옵션(목록 없는 서버의 모델·쓸 수 있는 작업·추론 여유·키 저장 시각·유효 기간). 모양이 틀린 값은 버린다 */
function connectionExtras(options: Record<string, unknown>, kind: string, shown: (id: string) => boolean) {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 200) : [];
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  return { manualModels: Object.freeze(kind === "api" ? strings(options.manualModels).filter(shown) : []),
    allowedTasks: Object.freeze(strings(options.allowedTasks).filter(id => aiTask(id))),
    reasoningTokenReserve: kind === "api" ? positive(options.reasoningTokenReserve) : null,
    keySetAt: typeof options.keySetAt === "string" && !Number.isNaN(Date.parse(options.keySetAt)) ? options.keySetAt : null,
    keyValidDays: kind === "api" ? positive(options.keyValidDays) : null };
}
export async function listAiConnections(reader?: Reader): Promise<AiConnectionView[]> {
  const load = async (from: Reader) => (await from.select().from(aiConnections).orderBy(asc(aiConnections.kind), asc(aiConnections.label))).map(aiConnectionView);
  return reader ? load(reader) : onPrimary(() => load(db));
}
const rankRowOf = (row: typeof aiTaskModels.$inferSelect): AiTaskRankRow => Object.freeze({ task: row.task, slot: row.slot, rank: row.rank, connectionId: row.connectionId,
  model: row.model, options: Object.freeze({ ...row.options }), enabled: row.enabled });
/** 화면 읽기의 행 — 마지막으로 쓴 시각(updated_at)을 함께 싣는다. 감사 기록(before·after)은 rankRowOf 그대로다 */
const listedRankRowOf = (row: typeof aiTaskModels.$inferSelect): AiTaskRankRow => Object.freeze({ ...rankRowOf(row), updatedAt: new Date(row.updatedAt).toISOString() });
export async function listAiTaskRows(reader?: Reader): Promise<AiTaskRankRow[]> {
  const load = async (from: Reader) => (await from.select().from(aiTaskModels).orderBy(asc(aiTaskModels.task), asc(aiTaskModels.slot), asc(aiTaskModels.rank))).map(listedRankRowOf);
  return reader ? load(reader) : onPrimary(() => load(db));
}
/** 저장한 키(평문) — 메모리 안에서만 쓴다. 없거나 열리지 않으면 null(hasKey 인데 null 이면 열리지 않은 것). */
function connectionKey(row: Pick<ConnectionRecord, "id" | "apiKeyCiphertext">): string | null {
  return row.apiKeyCiphertext ? openSecret(row.apiKeyCiphertext, aiConnectionKeyAad(row.id)) : null;
}

/** 준비 확인 입력 — 계약 스냅숏(키 없이)·2차/로컬 계약 resolver·정책·장비. 못 읽은 정책은 null(저장이 막는다). */
async function readReadinessInput(): Promise<AiReadinessInput & { policyError: string | null }> {
  await ensureServingContracts(0);
  const contracts = servingContractSnapshot().rows.map(row => {
    const contract = row.contract && typeof row.contract === "object" ? row.contract as Record<string, unknown> : {};
    return { routeId: row.routeId, model: row.model, transport: row.transport,
      provider: typeof contract.provider === "string" ? contract.provider : null, endpoint: typeof contract.endpoint === "string" ? contract.endpoint : null,
      engineModel: typeof contract.engineModel === "string" ? contract.engineModel : null,
      cliVersion: typeof contract.cliVersion === "string" ? contract.cliVersion : null,
      deploymentRevision: typeof contract.deploymentRevision === "string" ? contract.deploymentRevision : null,
      reasoningTokenReserve: typeof contract.reasoningTokenReserve === "number" ? contract.reasoningTokenReserve : null };
  });
  let policy: AiReadinessInput["policy"] = null, policyError: string | null = null;
  try {
    const control = await readCapacityDevicesControl();
    if (control.mode === "disabled") policy = { mode: "disabled", routes: [], groupLimits: {} };
    else if (control.policy) policy = { mode: control.mode, routes: control.policy.routes.map(route => ({ ...route })) as AiPolicyRoute[],
      groupLimits: { ...(control.policy.groupLimits ?? {}) } as Record<string, number> };
    else policyError = control.policyVerified ? "model_capacity_policy_missing" : "model_capacity_policy_unverified";
  } catch (error) { policyError = error instanceof Error ? error.message : "read_failed"; }
  const devices = new Map((await listModelCapacityDevices().catch(() => [])).map(device => [device.deviceId,
    { enabled: device.enabled, limitSlots: device.limitSlots, physicalLimit: device.physicalLimit ?? null }]));
  const table = tableLocalModelContracts();
  // 2차(second-review)도 순위 저장이 엔진 직접 계약(abcllm 형 total-bound, transport direct)을 만든다(PR C1 — 예전에는 env·서빙 계약·등록부 화면의 계약만 받았다)
  return { contracts, policy, policyError, devices, cliEngineIdentity: cliEngineModelIdentity, engineRoutes: [...ENGINE_CONNECT_ROUTES, "second-review"], cliContractRoutes: [...CLI_DB_CONTRACT_ROUTES],
    localContract: backendId => {
      const contract = resolveLocalModelContract(backendId);
      return contract ? { model: contract.model, endpoint: contract.endpoint } : null;
    },
    // 감사 직접 경로(「발행분 감사 · 변경 재판정」의 API 순위)·LLM 보강: 표의 행 + 이 프로세스 env 의 로컬 계약 — 같은 주소·모델을 다시 쓰고 장비가 갈리지 않게 본다
    localContracts: [...table.flatMap(row => row.contract ? [row.contract] : []), ...envLocalModelContracts()]
      .map(contract => ({ backendId: contract.backendId, model: contract.model, endpoint: contract.endpoint, physicalGroup: contract.physicalGroup,
        modelFamily: contract.modelFamily })),
    localContractTableCount: new Set(table.flatMap(row => row.contract ? [row.contract.backendId] : [])).size,
    localBackendId: auditDirectBackendId, assistFamilies: readAssistFamilies() };
}

/** LLM 보강의 모델 계열(등록부 용도 assist-primary·assist-audit) — 실행 쪽(rank-backends.ts)과 같은 값. 못 읽으면 null */
function readAssistFamilies(): AiReadinessInput["assistFamilies"] {
  try { return { primary: modelFamily("assist-primary"), audit: modelFamily("assist-audit") }; }
  catch { return null; }
}

/** env LOCAL_MODEL_SERVING_CONTRACTS 의 로컬 계약(모양이 틀리면 없음) — 확인 여부와 상관없이 주소·장비 대조에만 쓴다 */
function envLocalModelContracts(): readonly LocalModelServingContract[] {
  try { return process.env.LOCAL_MODEL_SERVING_CONTRACTS ? localModelServingContractsSchema.parse(JSON.parse(process.env.LOCAL_MODEL_SERVING_CONTRACTS)) : []; }
  catch { return []; }
}

/**
 * 「발행분 감사 · 변경 재판정」의 API 순위가 만드는 로컬 계약의 backend id — 연결 id·모델의 hash(35자, 관리 표 route_id 64자 안). 연결 주소가 바뀌어도 같은 id 라
 * 다시 저장하면 그 계약 행을 새 주소로 바꾼다(정책 route 의 예산 이름은 그대로).
 */
export const auditDirectBackendId = (connectionId: string, model: string): string => `api-${sha256(`${connectionId}\n${model}`).slice(0, 31)}`;

/**
 * 같은 작업 안에서 계약·정책 route 가 (경로, provider, 장부 이름) 하나에 서버 하나다. 글 짓기·번역·검색 text 경로(engine-route, PR B)와 1차·2차(review-ai1·ai2, PR C1)는
 * 순위마다 연결을 가리키는 계약을 찾고 같은 모델을 다른 연결에 두면 연결로 가른 이름을 쓰므로(aiRankReadiness) 장부 이름이 겹칠 때만 막는다.
 * 직접 모델 단계(local-direct)는 아직 예전 실행 쪽이라 같은 모델을 다른 서버로 두 순위에 둘 수 없다(PR C2).
 */
function crossRankIssues(task: AiTaskDef, readiness: readonly AiRankReadiness[]): string[] {
  if (!task.routeId || task.wiring === "uncapped" || task.wiring === "deferred") return [];
  // 「발행분 감사 · 변경 재판정」: CLI 순위는 예전처럼 보지 않고, API 순위(감사 직접 경로)만 — 그 경로의 장부 route 는 모델마다 서버 하나다
  const rows = task.wiring === "audit-direct" ? readiness.filter(row => row.provider === "local-direct") : readiness;
  const issues: string[] = [];
  rows.forEach((row, index) => {
    const earlier = rows.slice(0, index).find(other => other.provider === row.provider && other.identity === row.identity && other.connectionId !== row.connectionId);
    if (!earlier) return;
    if (task.wiring === "audit-direct") {
      issues.push(`${earlier.rank}순위와 ${row.rank}순위가 같은 모델(${row.model})을 다른 서버로 씁니다. 감사 직접 경로(local-audit)는 모델마다 서버 하나만 둡니다 — 다른 모델을 고르세요.`);
      return;
    }
    issues.push(task.wiring === "engine-route" || task.wiring === "review-ai1" || task.wiring === "review-ai2"
      ? `${earlier.rank}순위와 ${row.rank}순위가 같은 계약(${row.identity})을 다른 서버로 가리킵니다. 서빙 계약·등록부 화면에서 계약을 고친 뒤 다시 저장하세요.`
      : `${earlier.rank}순위와 ${row.rank}순위가 같은 모델(${row.model})을 다른 서버로 씁니다. 직접 모델 단계의 실행 쪽은 아직 경로·모델마다 서버 하나만 알아 `
        + "두 순위를 가를 수 없습니다 — 다음 단계(PR C2)에서 풀립니다. 지금은 다른 모델을 고르세요.");
  });
  return issues;
}

/** 실행 쪽의 순위 사정(PR B, text 일곱 작업) — 잡의 마지막 틱(job:<잡> 관측의 ai_task.ranks)이나 이 웹 프로세스의 마지막 검색어 번역. */
export type AiTaskRuntimeView = Readonly<{
  from: "job" | "web"; at: string;
  pool?: AiTaskPoolRuntime;
  /** Job start derived from the existing observation duration, when valid. */
  startedAt?: string;
  served: readonly Readonly<{ rank: number; count: number }>[];
  unusable: readonly Readonly<{ rank: number; code: string; text: string; count: number }>[];
  /** 그 틱이 제 일 못 한 까닭(no_task_models·all_ranks_unusable 등) */
  degraded: Readonly<{ code: string; detail: string | null }> | null;
}>;
export type AiTaskSlotView = Readonly<{
  task: AiTaskDef; slot: number; label: string; revision: string; rows: readonly AiTaskRankRow[]; options: readonly AiRankOption[];
  current: AiCurrentSlot | null; currentLabels: readonly string[]; sameAsCurrent: boolean | null;
  /** 저장된 순위의 준비 상태(막힘·경고) */
  readiness: readonly AiRankReadiness[];
  /** 실행 쪽이 이 순위를 읽는 작업인가(PR B: text 일곱) */
  live: boolean;
  runtime: AiTaskRuntimeView | null;
  /** 이 칸의 순위를 마지막으로 저장한 시각(행의 updated_at 중 가장 늦은 것, ISO). 행이 없으면 null — 작업 배정이 장부 1시간과 견줄 때 쓴다 */
  savedAt: string | null;
}>;
export type AiTaskAuditView = Readonly<{ id: number; at: string; actor: string; action: string; target: string; ok: boolean; summary: string }>;
export type AiTasksAdminView = Readonly<{
  connections: readonly AiConnectionView[]; rows: readonly AiTaskRankRow[]; slots: readonly AiTaskSlotView[];
  audit: readonly AiTaskAuditView[]; errors: Readonly<Record<string, string>>; secretBox: boolean; policyMode: string | null;
  /** 키가 없고 같은 주소의 계약 키가 서로 달라 자동으로 채우지 않은 켜진 API 연결 id(화면 위 알림의 까닭) */
  keyConflicts: readonly string[];
}>;

/** 1차·2차 한 칸의 「지금 실제로 쓰는 모델」 — 저장한 순위와 실행 쪽 묶기 결과(PR C1, lib/crawl/review-task-ranks.ts). */
function reviewCurrentSlot(task: AiTaskDef, slot: number): AiCurrentSlot {
  const resolution = resolveReviewTaskRanks(task.id as keyof typeof REVIEW_TASK_ROUTES, slot);
  const uses = resolution.candidates.map(candidate => Object.freeze({ kind: candidate.rank.connection.kind, baseUrl: candidate.rank.connection.baseUrl,
    cliTool: (candidate.rank.connection.cliTool ?? null) as AiCurrentSlot["uses"][number]["cliTool"], model: candidate.rank.model,
    provider: candidate.binding?.provider ?? (candidate.rank.connection.kind === "cli" ? `${candidate.rank.connection.cliTool}-cli` : "abcllm"),
    origin: `작업 ↔ 모델 ${candidate.rank.rank}순위`, deviceId: candidate.rank.connection.deviceId, keyFrom: null,
    ...(candidate.unusable ? { note: reviewRankUnusableText(candidate.unusable, candidate.detail) }
      : candidate.binding && candidate.binding.identity !== candidate.rank.model ? { note: `장부 이름 ${candidate.binding.identity}` } : {}) }));
  return Object.freeze({ task: task.id, slot, uses: Object.freeze(uses), source: "작업 ↔ 모델(실행 쪽이 이 표를 읽는다)", error: null, notes: Object.freeze([]),
    skip: resolution.status === "ok" ? null : resolution.status === "no_task_models"
      ? "작업 ↔ 모델에 순위가 없습니다 — 이 심사는 돌지 않습니다(no_task_models). 옛 설정·기본값으로 대신 부르지 않습니다."
      : "작업 ↔ 모델 표를 아직 읽지 못했습니다(task_models_unreadable)." });
}

/** 「지금 실제로 쓰는 모델」 한 줄의 글: 연결이 있으면 그 이름, 없으면 호스트(또는 CLI 도구) · 모델. */
function currentLabel(use: AiCurrentSlot["uses"][number], connections: readonly AiConnectionView[]): string {
  if (use.kind === "cli") return `${connections.find(row => row.kind === "cli" && row.cliTool === use.cliTool)?.label ?? use.provider} · ${use.model}`;
  const connection = use.baseUrl ? connections.find(row => row.baseUrl === use.baseUrl) : undefined;
  return `${connection?.label ?? aiConnectionHost(use.baseUrl) ?? "서버 모름"} · ${use.model}${use.note ? ` (${use.note})` : ""}`;
}
/** 저장된 순위가 지금 실행 쪽 순서와 같은가(같은 서버·도구와 모델, 같은 순서). 현재 값을 모르면 null. */
function sameAsCurrent(rows: readonly AiTaskRankRow[], current: AiCurrentSlot | null, connections: readonly AiConnectionView[]): boolean | null {
  if (!current || current.error) return null;
  const uses = current.uses.slice(0, 3);
  if (rows.length !== uses.length) return false;
  return rows.every((row, index) => {
    const connection = connections.find(entry => entry.id === row.connectionId), use = uses[index];
    if (!connection) return false;
    const where = use.kind === "cli" ? connection.kind === "cli" && connection.cliTool === use.cliTool : connection.baseUrl === use.baseUrl;
    return where && (row.model === use.model || !!use.serverNamed);
  });
}

function auditSummary(row: AdminLogRow): string {
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  if (!row.ok) return row.error ?? "거절";
  switch (row.action) {
    case "ai-task-execution-save": return detail.mode === "workload_pool"
      ? `작업 분산 · 모델 ${Array.isArray(detail.after) ? detail.after.length : 0}개` : "기존 대체 실행으로 전환";
    case AI_CONNECTION_SAVE_AUDIT_ACTION: return `${detail.created ? "만듦" : "고침"} · ${String((detail.after as { label?: unknown } | undefined)?.label ?? "")}${detail.keyChanged ? " · 키 바꿈" : ""}`;
    case AI_CONNECTION_MODELS_AUDIT_ACTION: return detail.error ? `목록 읽기 실패(${String(detail.error)})` : `모델 ${String(detail.count ?? 0)}개 읽음`;
    case AI_CONNECTION_DELETE_AUDIT_ACTION: return `지움 · ${String(detail.label ?? "")}`;
    case AI_CONNECTION_MODEL_HIDE_AUDIT_ACTION: return `${detail.hidden ? "목록에서 뺌" : "목록에 되돌림"} · ${Array.isArray(detail.models) ? detail.models.join(", ") : ""}`;
    case AI_TASK_MODELS_SAVE_AUDIT_ACTION: {
      const after = Array.isArray(detail.after) ? detail.after as { rank: number; model: string }[] : [];
      const made = detail.created as { devices?: unknown[]; contracts?: unknown[]; routes?: unknown[] } | undefined;
      const extra = [made?.devices?.length ? `장비 ${made.devices.length}` : "", made?.contracts?.length ? `계약 ${made.contracts.length}` : "",
        made?.routes?.length ? `정책 경로 ${made.routes.length}` : ""].filter(Boolean).join(" · ");
      return `${after.length ? after.map(entry => `${entry.rank}순위 ${entry.model}`).join(", ") : "순위 비움"}${extra ? ` · 만듦: ${extra}` : ""}`;
    }
    case AI_TASK_MODELS_IMPORT_AUDIT_ACTION: return `가져오기 · 연결 ${String((detail.connections as unknown[] | undefined)?.length ?? 0)} · 칸 ${String((detail.slots as unknown[] | undefined)?.length ?? 0)}`;
    case AI_CONNECTION_KEY_FILL_AUDIT_ACTION: return `키 자동 채움 · ${String(detail.label ?? "")} · 같은 주소 계약 ${String((detail.sources as unknown[] | undefined)?.length ?? 0)}개`;
    case "llm-assist-control": {
      const after = (detail.after ?? null) as { mode?: unknown; dispatchEnabled?: unknown; applyEnabled?: unknown } | null;
      return after ? `${String(detail.task ?? row.target)} · ${String(after.mode)} · 보내기 ${after.dispatchEnabled ? "켬" : "끔"} · 반영 ${after.applyEnabled ? "켬" : "끔"}` : "—";
    }
    default: return "—";
  }
}

function runtimeView(status: TextRankStatus, from: AiTaskRuntimeView["from"], degraded: AiTaskRuntimeView["degraded"], startedAt?: string): AiTaskRuntimeView {
  const pool = (status as TextRankStatus & { pool?: AiTaskPoolRuntime }).pool;
  return Object.freeze({ from, at: status.at, degraded, ...(startedAt ? { startedAt } : {}), ...(pool ? { pool } : {}),
    served: Object.freeze(Object.entries(status.served).map(([rank, count]) => Object.freeze({ rank: Number(rank), count })).sort((a, b) => a.rank - b.rank)),
    unusable: Object.freeze(status.unusable.map(row => Object.freeze({ ...row, text: textRankUnusableText(row.code) }))) });
}
/**
 * text 작업마다 실행 쪽의 순위 사정. 잡 여섯은 job:<잡> 관측의 마지막 ai_task.ranks 이벤트(틱 끝에 남긴다)와 그 틱의 degraded, 검색어 번역(웹 요청)은
 * 이 웹 프로세스가 마지막으로 남긴 사정이다(다른 웹 복제본과 다를 수 있다).
 */
export async function readAiTaskRuntime(): Promise<Record<string, AiTaskRuntimeView>> {
  // 작업 → 그 순위를 읽는 잡(text 일곱은 작업 id = 잡 이름, PR C1: 1차·2차·Grok 로그인 유지)
  const jobOf = new Map<string, string>([...AI_TEXT_TASK_IDS.filter(task => task !== "search-query-translate").map(task => [task, task] as const),
    ["first-review", "crawl-agent-review"], ["second-review", "second-review"], ["grok-session-check", "grok-session-check"], ["publish-classify", "crawl-publish"],
    // LLM 보강(2026-11-11): 순위로 고른 틱이 ai_task.ranks 를 남긴다(lib/jobs/products/llm-assist-review.ts)
    ["assist-review", "product-llm-assist-review"], ["assist-audit", "product-llm-assist-audit-review"]]);
  const taskOf = new Map([...jobOf].map(([task, job]) => [`job:${job}`, task]));
  const rows = await onPrimary(() => db.select({ key: operationsObservations.key, value: operationsObservations.value, observedAt: operationsObservations.observedAt })
    .from(operationsObservations).where(inArray(operationsObservations.key, [...taskOf.keys()])));
  const out: Record<string, AiTaskRuntimeView> = {};
  for (const row of rows) {
    const task = taskOf.get(row.key) ?? row.key.slice("job:".length);
    const value = (row.value ?? {}) as { events?: unknown; degraded?: unknown; durationMs?: unknown };
    const events = Array.isArray(value.events) ? value.events as { event?: unknown; counts?: unknown }[] : [];
    const last = [...events].reverse().find(entry => entry?.event === "ai_task.ranks");
    const degraded = value.degraded && typeof value.degraded === "object" ? value.degraded as { code?: unknown; detail?: unknown } : null;
    // Grok 로그인 유지는 순위 요약을 남기지 않는다 — 그 틱의 degraded 만 보인다
    if ((!last || !last.counts || typeof last.counts !== "object") && !(task === "grok-session-check" && degraded)) continue;
    const observedAt = new Date(row.observedAt);
    const duration = value.durationMs;
    const startedAt = typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0 && duration <= observedAt.getTime()
      ? new Date(observedAt.getTime() - duration).toISOString() : undefined;
    out[task] = runtimeView(textRankStatusFromCounts(task, observedAt.toISOString(), (last?.counts ?? {}) as Record<string, unknown>), "job",
      degraded && typeof degraded.code === "string" ? { code: degraded.code, detail: typeof degraded.detail === "string" ? degraded.detail : null } : null, startedAt);
  }
  const web = textTaskRankStatus("search-query-translate");
  if (web) out["search-query-translate"] = runtimeView(web, "web", web.status !== "ok" ? { code: web.status, detail: null } : null);
  return out;
}

/** 화면 한 번 그리기 — 연결·순위·현재 값·준비 상태·최근 기록. 어느 하나를 못 읽어도 화면은 뜬다(그 자리에 이유). */
export async function readAiTasksAdminView(): Promise<AiTasksAdminView> {
  const errors: Record<string, string> = {};
  const settle = async <T>(key: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await work(); } catch (error) { errors[key] = error instanceof Error ? error.message.slice(0, 160) : "read_failed"; return fallback; }
  };
  await settle("review_ranks", () => ensureReviewTaskRanks(0), undefined);
  // 키 없는 API 연결을 같은 주소의 계약 키로 채운다(프로세스마다 5분에 한 번 이하, 상자 키가 있을 때만 — 실패해도 화면은 그대로 뜬다)
  await maybeFillConnectionKeys().catch(() => null);
  const [connections, rows, readiness, audit, runtime] = await Promise.all([settle("connections", () => listAiConnections(), [] as AiConnectionView[]),
    settle("rows", () => listAiTaskRows(), [] as AiTaskRankRow[]), settle("readiness", readReadinessInput, null),
    settle("audit", () => adminLog({ actions: [...AI_TASK_AUDIT_ACTIONS] }), [] as AdminLogRow[]), settle("runtime", readAiTaskRuntime, {} as Record<string, AiTaskRuntimeView>)]);
  if (readiness?.policyError) errors.policy = readiness.policyError;
  const contractRows = servingContractSnapshot().rows;
  const keyConflicts = connections.filter(row => row.enabled && row.kind === "api" && !row.hasKey && contractKeyMatch(row.baseUrl, contractRows).status === "conflict")
    .map(row => row.id);
  const current = await settle("current", async () => depsForTest?.current ? depsForTest.current()
    : buildAiCurrentSlots(await readAiCurrentSources((await readCapacityDevicesControl().catch(() => null))?.policy ?? null)), [] as AiCurrentSlot[]);
  const slots = aiTaskSlots().map(({ task, slot }): AiTaskSlotView => {
    const own = rows.filter(row => row.task === task.id && row.slot === slot).sort((a, b) => a.rank - b.rank);
    // 1차·2차는 실행 쪽이 이 표를 읽는다(PR C1) — 「지금 실제로 쓰는 모델」은 저장한 순위 그대로(쓸 수 없는 순위는 그 까닭). 가져오기 출처(옛 설정)는 가져오기 계획에만 쓴다
    const cur = isAiReviewTask(task.id) ? reviewCurrentSlot(task, slot) : current.find(entry => entry.task === task.id && entry.slot === slot) ?? null;
    const ready = readiness ? aiRanksReadiness(task, own.flatMap(row => {
      const connection = connections.find(entry => entry.id === row.connectionId);
      return connection ? [{ rank: row.rank, connection, model: row.model,
        reasoningEffort: typeof row.options?.reasoningEffort === "string" ? row.options.reasoningEffort : undefined }] : [];
    }), readiness) : [];
    // LLM 보강은 순위가 있을 때만 실행 쪽이 순위를 읽는다 — 순위가 없으면 옛 env(LLM_ASSIST_BACKENDS)로 돌아 「실제 적용 설정」으로 보인다
    const live = aiTaskReadsRanks(task.id, own.length > 0);
    return Object.freeze({ task, slot, label: aiTaskSlotLabel(task, slot), revision: aiTaskSlotRevision(own), rows: Object.freeze(own),
      options: Object.freeze(aiTaskRankOptions(task, connections, own)), current: cur,
      currentLabels: Object.freeze((live ? (cur?.uses ?? []).slice(0, 3) : cur?.uses ?? []).map(use => currentLabel(use, connections))),
      sameAsCurrent: isAiReviewTask(task.id) || !live ? null : sameAsCurrent(own, cur, connections),
      readiness: Object.freeze(ready), live, runtime: runtime[task.id] ?? null,
      savedAt: own.reduce<string | null>((latest, row) => row.updatedAt && (!latest || row.updatedAt > latest) ? row.updatedAt : latest, null) });
  });
  return Object.freeze({ connections: Object.freeze(connections), rows: Object.freeze(rows), slots: Object.freeze(slots), errors: Object.freeze(errors),
    secretBox: secretBoxReady(), policyMode: readiness?.policy?.mode ?? null, keyConflicts: Object.freeze(keyConflicts),
    audit: Object.freeze(audit.slice(0, 30).map(row => Object.freeze({ id: row.id, at: new Date(row.createdAt).toISOString(), actor: row.actor, action: row.action,
      target: row.target, ok: row.ok, summary: auditSummary(row) }))) });
}

// ── 연결 저장 ───────────────────────────────────────────────────────────────────────────────────────────

type ModelsRead = { ok: true; models: AiConnectionModel[] } | { ok: false; reason: string };
/** GET {base}/models — 5초, 리다이렉트 없음, 키는 Bearer 로만(readbackServingEndpoint 그대로). */
const readModels = (baseUrl: string, key: string | null): Promise<ModelsRead> => readConnectionModels(baseUrl, key, request());

const connectionAudit = (row: ConnectionRecord | null) => row && { label: row.label, kind: row.kind, baseUrl: row.baseUrl, hasKey: row.apiKeyCiphertext !== null,
  cliTool: row.cliTool, cliModels: [...row.cliModels], deviceId: row.deviceId, capacitySlots: row.capacitySlots, options: { ...row.options }, enabled: row.enabled,
  version: Number(row.version), models: Array.isArray(row.models) ? row.models.length : null, modelsError: row.modelsError, note: row.note };

export type SaveAiConnectionResult = { ok: true; id: string; version: number; created: boolean; models: number | null; modelsError: string | null }
  | { ok: false; issues: string[] };
/**
 * 연결 하나 저장(만들기·고치기). API 는 저장 전에 GET {주소}/models 를 한 번 읽어 목록을 함께 저장한다 — 못 읽어도 저장은 하고 그 이유를 남긴다
 * (주소가 그대로면 옛 목록을 둔다). 키: 새로 넣으면 secret-box 로 암호화(AAD = 행 id), 비우면 그대로, 「키 지우기」면 지운다. 키는 돌려주지 않는다.
 * TX: DR fence → 행 FOR UPDATE(판 compare-and-set, 종류는 못 바꾼다) → 쓰기(판 + 1) → 감사 한 줄.
 */
export async function saveAiConnection(input: AiConnectionInput, actor: string): Promise<SaveAiConnectionResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  try {
    if (input.key.mode === "set" && !secretBoxReady()) return { ok: false, issues: ["secret_box_key_missing"] };
    const [previous] = input.id ? await onPrimary(() => db.select().from(aiConnections).where(eq(aiConnections.id, input.id!))) : [];
    if (input.id && !previous) return { ok: false, issues: ["ai_connection_missing"] };
    if (previous && previous.kind !== input.kind) return { ok: false, issues: ["ai_connection_kind_change"] };
    const id = previous?.id ?? randomUUID();
    const openCode = input.kind === "cli" && input.cliTool === "opencode";
    const preserveHost = openCode && previous?.kind === "cli" && previous.cliTool === "opencode";
    let hostBaseUrl = preserveHost ? previous!.baseUrl : input.baseUrl;
    let cliCatalog: CliCatalogMetadata | null = null;
    let offlineDisable = false;
    if (openCode) {
      try {
        const hostKey = preserveHost ? connectionKey(previous!) : input.key.mode === "set" ? input.key.value : null;
        if (!hostBaseUrl || !hostKey) throw new Error("cli_host_not_configured");
        const target = validateCliHostTarget({ connectionId: id, baseUrl: hostBaseUrl, apiKey: hostKey });
        hostBaseUrl = target.baseUrl;
        cliCatalog = await readAdminCliCatalog({ fresh: true, target });
      }
      catch {
        // An unreachable host must never prevent the operator from disabling its existing connection.
        offlineDisable = previous?.kind === "cli" && previous.cliTool === "opencode" && previous.enabled && !input.enabled;
        if (!offlineDisable) return { ok: false, issues: ["ai_connection_cli_host_unavailable"] };
      }
      if (cliCatalog) {
        const offered = new Set(cliCatalog.models.map(model => model.id));
        if (input.cliModels.some(model => !offered.has(model))) return { ok: false, issues: ["ai_connection_cli_catalog_changed"] };
      }
    }
    const key = input.key.mode === "set" ? input.key.value : input.key.mode === "keep" && previous ? connectionKey(previous) : null;
    if (input.kind === "api" && input.key.mode === "keep" && previous?.apiKeyCiphertext && key === null) return { ok: false, issues: ["ai_connection_key_unreadable"] };
    const read = input.kind === "api" && input.baseUrl ? await readModels(input.baseUrl, key) : null;
    const sameBase = previous?.baseUrl === input.baseUrl;
    const models = input.kind !== "api" ? null : read?.ok ? read.models : sameBase ? previous?.models ?? null : null;
    const saved = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      const [locked] = input.id ? await tx.select().from(aiConnections).where(eq(aiConnections.id, id)).for("update") : [];
      if (input.id && !locked) fail("ai_connection_missing");
      if (locked && Number(locked.version) !== input.expectedVersion) fail("ai_connection_version_mismatch");
      if (locked && Number(locked.version) >= VERSION_MAX) fail("ai_connection_version_mismatch");
      const ciphertext = openCode ? preserveHost ? locked?.apiKeyCiphertext ?? null : input.key.mode === "set" ? sealSecret(input.key.value, aiConnectionKeyAad(id)) : null
        : input.kind !== "api" || input.key.mode === "clear" ? null : input.key.mode === "set" ? sealSecret(input.key.value, aiConnectionKeyAad(id)) : locked?.apiKeyCiphertext ?? null;
      // Keep unrelated connection options. Only this form's own fields are replaced or cleared.
      const options: Record<string, unknown> = { ...locked?.options };
      if (!offlineDisable) {
        delete options.contextTokens; delete options.cliVersion; delete options.cliHostCatalog;
        delete options.manualModels; delete options.allowedTasks; delete options.reasoningTokenReserve; delete options.keyValidDays;
        if (input.contextTokens) options.contextTokens = input.contextTokens;
        // 2026-11-10: 목록 없는 서버의 모델·쓸 수 있는 작업·추론 여유·키 유효 기간. 키를 새로 넣으면 그 시각을 적고(만료 안내), 지우면 뺀다
        if (input.kind === "api" && input.manualModels?.length) options.manualModels = [...input.manualModels];
        if (input.allowedTasks?.length) options.allowedTasks = [...input.allowedTasks];
        if (input.kind === "api" && input.reasoningTokenReserve) options.reasoningTokenReserve = input.reasoningTokenReserve;
        if (input.kind === "api" && input.keyValidDays) options.keyValidDays = input.keyValidDays;
        if (input.kind !== "api" || input.key.mode === "clear") delete options.keySetAt;
        else if (input.key.mode === "set") options.keySetAt = new Date(now()).toISOString();
        const cliVersion = cliCatalog?.cliVersion ?? input.cliVersion;
        if (input.kind === "cli" && cliVersion) options.cliVersion = cliVersion;
        if (cliCatalog) options.cliHostCatalog = { modelsHash: sha256(JSON.stringify(input.cliModels)), observedAt: cliCatalog.observedAt,
          variantLists: input.cliModels.map(model => [...cliCatalog!.models.find(entry => entry.id === model)!.variants]) };
        if (cliCatalog) options.cliHostCatalog = { ...(options.cliHostCatalog as Record<string, unknown>),
          contextLists: input.cliModels.map(model => cliCatalog!.models.find(entry => entry.id === model)?.maxModelLen ?? null),
          visionLists: input.cliModels.map(model => cliCatalog!.models.find(entry => entry.id === model)?.vision === true) };
      }
      if (!offlineDisable && Buffer.byteLength(JSON.stringify(options), "utf8") > 8192) fail("ai_connection_options_full");
      const values = { label: input.label, kind: input.kind, baseUrl: openCode ? preserveHost ? locked!.baseUrl : hostBaseUrl : input.kind === "api" ? input.baseUrl : null, apiKeyCiphertext: ciphertext,
        cliTool: input.kind === "cli" ? input.cliTool : null, cliModels: offlineDisable ? [...locked!.cliModels] : input.kind === "cli" ? input.cliModels : [], models,
        modelsReadAt: input.kind !== "api" ? null : read?.ok ? new Date(now()) : sameBase ? locked?.modelsReadAt ?? null : null,
        modelsError: input.kind !== "api" ? null : read && !read.ok ? read.reason : null, deviceId: input.deviceId, capacitySlots: input.capacitySlots,
        options, enabled: input.enabled, note: input.note, updatedBy: actor };
      const [row] = locked
        ? await tx.update(aiConnections).set({ ...values, version: sql`${aiConnections.version} + 1`, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(aiConnections.id, id), eq(aiConnections.version, Number(locked.version)))).returning()
        : await tx.insert(aiConnections).values({ id, ...values }).returning();
      if (!row) fail("ai_connection_version_mismatch");
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_CONNECTION_SAVE_AUDIT_ACTION, target: `${row.label}`.slice(0, 200),
        detail: { id, created: !locked, keyChanged: preserveHost ? false : input.key.mode !== "keep", before: connectionAudit(locked ?? null), after: connectionAudit(row),
          modelsRead: read ? (read.ok ? { count: read.models.length } : { error: read.reason }) : null } }));
      return row;
    }));
    logger.info("ai_tasks.connection_saved", { actor, id, kind: saved.kind, created: !previous, models: saved.models?.length ?? null });
    return { ok: true, id, version: Number(saved.version), created: !previous, models: saved.models?.length ?? null, modelsError: saved.modelsError };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

export type ReadAiConnectionModelsResult = { ok: true; count: number } | { ok: false; issues: string[] };
/**
 * 「다시 읽기」 — 저장된 주소·키로 GET /models 를 한 번 읽어 목록만 바꾼다(연결의 판은 그대로 — 열린 고치기 폼을 막지 않는다).
 * 간격은 엔진 자동 확인(#791)과 같은 1분: 마지막 읽은 시각과 이 프로세스의 마지막 시도 둘 다 1분 밖이어야 부른다. 결과(목록 수 또는 이유)를 감사 한 줄로 남긴다.
 */
export async function readAiConnectionModels(id: string, actor: string): Promise<ReadAiConnectionModelsResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!UUID.test(id)) return { ok: false, issues: ["ai_connection_missing"] };
  try {
    const [row] = await onPrimary(() => db.select().from(aiConnections).where(eq(aiConnections.id, id)));
    if (!row) return { ok: false, issues: ["ai_connection_missing"] };
    if (row.kind !== "api" || !row.baseUrl) return { ok: false, issues: ["ai_connection_not_api"] };
    const at = now(), gate = directProbeGate(), gateKey = `ai-connection:${row.id}`, last = gate.get(gateKey);
    const saved = row.modelsReadAt ? { observedAt: new Date(row.modelsReadAt).toISOString() } : undefined;
    if (!directProbeDue(saved, at) || last !== undefined && at - last < DIRECT_PROBE_INTERVAL_MS) return { ok: false, issues: ["ai_connection_models_too_soon"] };
    gate.set(gateKey, at);
    const key = connectionKey(row);
    const read: ModelsRead = row.apiKeyCiphertext && key === null ? { ok: false, reason: "key_unreadable" } : await readModels(row.baseUrl, key);
    await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      await tx.update(aiConnections).set(read.ok ? { models: read.models, modelsReadAt: new Date(at), modelsError: null }
        : { modelsError: read.reason, modelsReadAt: new Date(at) }).where(eq(aiConnections.id, row.id));
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_CONNECTION_MODELS_AUDIT_ACTION, target: row.label,
        detail: { id: row.id, ...(read.ok ? { count: read.models.length } : { error: read.reason }) }, ok: read.ok, error: read.ok ? null : read.reason }));
    }));
    return read.ok ? { ok: true, count: read.models.length } : { ok: false, issues: [`ai_connection_models_failed:${read.reason}`] };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

/**
 * 연결의 모델을 목록에서 빼거나(hidden=true) 되돌린다(2026-11-08 사용자 요청 「안 쓰는 모델은 삭제 가능하게」). options.hiddenModels 한 칸만 바꾼다 —
 * 서버가 다시 알려 줘도(다시 읽기·저장) 빠진 채로 남고, 화면·순위 선택지·검증은 aiConnectionView 에서 빠진 목록을 본다. 실행 쪽 스냅숏은 그대로다.
 * 빼기는 그 모델을 쓰는 순위(ai_task_models)·작업 분산 구성원(ai_task_pool_members)이 없고 지금 목록에 있을 때만. TX: DR fence → 행 FOR UPDATE(판 CAS) → 판 + 1 → 감사 한 줄.
 */
export async function setAiConnectionModelsHidden(input: { id: string; expectedVersion: number; models: readonly string[]; hidden: boolean }, actor: string):
  Promise<{ ok: true; version: number; hidden: string[] } | { ok: false; issues: string[] }> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!UUID.test(input.id)) return { ok: false, issues: ["ai_connection_missing"] };
  const models = [...new Set(input.models)];
  if (!models.length || models.length > 16 || models.some(model => !model || model.length > 200 || /[\p{Cc}]/u.test(model))) return { ok: false, issues: ["ai_connection_model_invalid"] };
  try {
    const saved = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      const [row] = await tx.select().from(aiConnections).where(eq(aiConnections.id, input.id)).for("update");
      if (!row) fail("ai_connection_missing");
      if (Number(row!.version) !== input.expectedVersion || Number(row!.version) >= VERSION_MAX) fail("ai_connection_version_mismatch");
      const before = hiddenModelsOf(row!.options);
      if (input.hidden) {
        const stored = (row!.options as Record<string, unknown>).manualModels;
        const manual = Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === "string") : [];
        const listed = new Set([...(Array.isArray(row!.models) ? row!.models.flatMap(entry => entry && typeof entry.id === "string" ? [entry.id] : []) : []), ...row!.cliModels, ...manual]);
        if (models.some(model => !listed.has(model) || before.includes(model))) fail("ai_connection_model_missing");
        const [ranked] = await tx.select({ id: aiTaskModels.id }).from(aiTaskModels)
          .where(and(eq(aiTaskModels.connectionId, input.id), inArray(aiTaskModels.model, models))).limit(1);
        const [pooled] = await tx.select({ id: aiTaskPoolMembers.memberId }).from(aiTaskPoolMembers)
          .where(and(eq(aiTaskPoolMembers.connectionId, input.id), inArray(aiTaskPoolMembers.model, models))).limit(1);
        if (ranked || pooled) fail("ai_connection_model_in_use");
        // OpenCode deepseek 모델은 등록부 항목(장비:cli-…)으로도 들어가 단계 풀·모델 배정 표가 그 키를 가리킬 수 있다 — 가리키면 뺄 수 없다
        if (row!.kind === "cli" && row!.cliTool === "opencode") {
          const view = aiConnectionView(row!);
          const keys = new Set(models.flatMap(model => cliDerivedRegistryKeys({ id: row!.id, deviceId: row!.deviceId }, model,
            view.cliCatalog?.models.find(entry => entry.id === model)?.variants ?? [])));
          const { getSettings } = await import("@/lib/crawl/settings");
          const pools = Object.values((await getSettings()).stageModelPools ?? {}).flat();
          const [assigned] = keys.size ? await tx.select({ id: modelHelperAssignments.assignmentId }).from(modelHelperAssignments)
            .where(inArray(modelHelperAssignments.registryKey, [...keys])).limit(1) : [];
          if (pools.some(key => keys.has(String(key))) || assigned) fail("ai_connection_model_in_use");
        }
      } else if (models.some(model => !before.includes(model))) fail("ai_connection_model_missing");
      const after = input.hidden ? [...before, ...models] : before.filter(model => !models.includes(model));
      const options: Record<string, unknown> = { ...row!.options };
      if (after.length) options.hiddenModels = after; else delete options.hiddenModels;
      if (Buffer.byteLength(JSON.stringify(options), "utf8") > 8192) fail("ai_connection_options_full");
      const [updated] = await tx.update(aiConnections).set({ options, version: sql`${aiConnections.version} + 1`, updatedBy: actor, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(aiConnections.id, input.id), eq(aiConnections.version, Number(row!.version)))).returning();
      if (!updated) fail("ai_connection_version_mismatch");
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_CONNECTION_MODEL_HIDE_AUDIT_ACTION, target: row!.label.slice(0, 200),
        detail: { id: input.id, hidden: input.hidden, models, before, after } }));
      return { version: Number(updated.version), hidden: after };
    }));
    return { ok: true, ...saved };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

/** 쓰는 순위가 없는 연결만 지운다(FK RESTRICT). 판 compare-and-set, 감사 한 줄. */
export async function deleteAiConnection(id: string, expectedVersion: number, actor: string): Promise<{ ok: true } | { ok: false; issues: string[] }> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!UUID.test(id)) return { ok: false, issues: ["ai_connection_missing"] };
  try {
    await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      const [row] = await tx.select().from(aiConnections).where(eq(aiConnections.id, id)).for("update");
      if (!row) fail("ai_connection_missing");
      if (Number(row!.version) !== expectedVersion) fail("ai_connection_version_mismatch");
      const [used] = await tx.select({ id: aiTaskModels.id }).from(aiTaskModels).where(eq(aiTaskModels.connectionId, id)).limit(1);
      if (used) fail("ai_connection_in_use");
      await tx.delete(aiConnections).where(eq(aiConnections.id, id));
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_CONNECTION_DELETE_AUDIT_ACTION, target: row!.label,
        detail: { id, label: row!.label, before: connectionAudit(row!) } }));
    }));
    return { ok: true };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

// ── 순위 저장 ───────────────────────────────────────────────────────────────────────────────────────────

export type SaveAiTaskRanksResult = { ok: true; revision: string; warnings: string[]; created: { devices: string[]; contracts: string[]; routes: string[] } }
  | { ok: false; issues: string[] };

/**
 * 한 줄(작업 × 칸)의 1·2·3순위 저장. 순서: 검증(순수) → 준비 확인(계약·정책·장비를 읽기만) → 만들 엔진 직접 계약의 readback + 1토큰 시험(네트워크, 잠금 없음)
 * → TX: DR fence → (작업, 칸) advisory lock → 화면 판 compare-and-set → 쓰는 연결 FOR SHARE(켜져 있어야 한다) → 엔진 직접 계약 쓰기(saveServingContractTx)
 * → model_capacity_control FOR UPDATE → 없는 장비 행 만들기(saveModelCapacityDevice, 칸 수 = 정책 groupLimits 또는 연결의 칸 수, 순위 없음)
 * → 정책 route 덧붙이기(appendCompatibleRoutes, DRAIN 없음) → 칸의 순위 행 바꾸기 → 감사 한 줄. 던지면 TX 가 되돌린다.
 * 막는 것이 하나라도 있으면 아무것도 쓰지 않고 그 문장들을 돌려준다.
 */
export async function saveAiTaskRanks(input: AiTaskRanksInput, actor: string): Promise<SaveAiTaskRanksResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  const task = aiTask(input.task);
  if (!task) return { ok: false, issues: ["ai_task_invalid:task"] };
  if (!isAiLiveTask(task.id)) {
    const target = aiTaskEditTarget(task.id);
    return { ok: false, issues: [`${task.label}의 모델 순위는 지금 실행 쪽이 읽지 않아 저장해도 동작이 바뀌지 않습니다 — 실제 적용 설정에서 바꾸세요: ${target?.href ?? "/admin/models/advanced#model-settings"}`] };
  }
  try {
    const [storedConnections, rows] = await Promise.all([listAiConnections(), listAiTaskRows()]);
    const ranks = input.ranks.slice(0, 3);
    let connections = storedConnections;
    const openCode = storedConnections.filter(connection => connection.kind === "cli" && connection.cliTool === "opencode"
      && ranks.some(rank => rank?.provider === connection.id));
    if (openCode.length) {
      const catalogs = new Map<string, CliCatalogMetadata>();
      for (const connection of openCode) {
        let catalog: CliCatalogMetadata;
        try { catalog = await readAdminCliCatalog({ fresh: true, connectionId: connection.id }); }
        catch { return { ok: false, issues: ["ai_connection_cli_host_unavailable"] }; }
        const offered = new Set(catalog.models.map(model => model.id));
        if (ranks.some(rank => rank?.provider === connection.id && !offered.has(rank.model)))
          return { ok: false, issues: ["ai_connection_cli_catalog_changed"] };
        catalogs.set(connection.id, catalog);
      }
      connections = storedConnections.map(connection => {
        const catalog = catalogs.get(connection.id);
        return catalog ? { ...connection, cliVersion: catalog.cliVersion, cliCatalog: catalog } : connection;
      });
    }
    if (task.id === 'publish-classify' && ranks.some(rank => rank && connections.find(connection => connection.id === rank.provider)?.kind === 'api'))
      return { ok: false, issues: ['ai_task_publish_api_pool_only'] };
    const issues = validateAiTaskRanks(task.id, input.slot, ranks, { connections, rows });
    if (issues.length) return { ok: false, issues };
    const chosen = ranks.flatMap((row, index) => row ? [{ rank: index + 1, row, connection: connections.find(entry => entry.id === row.provider)! }] : []);
    // OpenCode 순위의 연결 버전은 위에서 호스트에서 방금 읽은 값이다 — 계약 버전이 다르면 그 값으로 계약을 맞춘다(기록된 옛 버전은 쓰지 않는다)
    const readinessInput = { ...await readReadinessInput(), hostCliVersions: new Set(openCode.map(connection => connection.id)) };
    const readiness = aiRanksReadiness(task, chosen.map(entry => ({ rank: entry.rank, connection: entry.connection, model: entry.row.model,
      ...(typeof entry.row.reasoningEffort === "string" ? { reasoningEffort: entry.row.reasoningEffort } : {}) })), readinessInput);
    const blocking = [...readiness.flatMap(row => row.blocking), ...crossRankIssues(task, readiness)];
    if (blocking.length) return { ok: false, issues: blocking };
    const warnings = [...readiness.flatMap(row => row.warnings), ...aiTaskRankNotices(task.id, ranks, rows)];
    const resources = await prepareAiTaskServingResources(task, chosen, readiness);
    if (!resources.ok) return resources;
    const result = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_execution_task'), hashtext(${task.id}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_models'), hashtext(${`${task.id}#${input.slot}`}))`);
      if (task.id === "second-review" && input.slot > 1 && chosen.length > 0) {
        const [activePool] = await tx.select({ slot: aiTaskExecutionConfigs.slot }).from(aiTaskExecutionConfigs)
          .where(and(eq(aiTaskExecutionConfigs.task, task.id), eq(aiTaskExecutionConfigs.mode, "workload_pool"))).limit(1);
        if (activePool) fail("ai_task_pool_ai2_other_slots_configured");
      }
      const before = (await tx.select().from(aiTaskModels).where(and(eq(aiTaskModels.task, task.id), eq(aiTaskModels.slot, input.slot)))
        .orderBy(asc(aiTaskModels.rank))).map(rankRowOf);
      if (aiTaskSlotRevision(before) !== input.revision) fail("ai_task_revision_mismatch");
      const ids = [...new Set(chosen.map(entry => entry.connection.id))];
      const live = ids.length ? await tx.select({ id: aiConnections.id, enabled: aiConnections.enabled }).from(aiConnections).where(inArray(aiConnections.id, ids)).for("share") : [];
      if (live.length !== ids.length || live.some(row => !row.enabled)) fail("ai_connection_version_mismatch");
      const { contracts: madeContracts, devices: madeDevices, routes: madeRoutes, policyRevision } =
        await saveAiTaskServingResources(tx, task, readiness, resources, actor);
      await tx.delete(aiTaskModels).where(and(eq(aiTaskModels.task, task.id), eq(aiTaskModels.slot, input.slot)));
      const values = chosen.map(entry => {
        const kept = before.find(row => row.connectionId === entry.row.provider && row.model === entry.row.model);
        return { task: task.id, slot: input.slot, rank: entry.rank, connectionId: entry.row.provider, model: entry.row.model, options: aiRankSavedOptions(entry.row, kept?.options),
          enabled: true, updatedBy: actor };
      });
      const after = values.length ? (await tx.insert(aiTaskModels).values(values).returning()).map(rankRowOf).sort((a, b) => a.rank - b.rank) : [];
      const revision = aiTaskSlotRevision(after);
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_TASK_MODELS_SAVE_AUDIT_ACTION, target: `${task.id}#${input.slot}`,
        detail: { task: task.id, slot: input.slot, revisionBefore: input.revision, revision, before: before.map(row => ({ ...row })), after: after.map(row => ({ ...row })),
          created: { devices: madeDevices, contracts: madeContracts, routes: madeRoutes, policyRevision }, warnings } }));
      return { revision, created: { devices: madeDevices, contracts: madeContracts, routes: madeRoutes } };
    }));
    logger.info("ai_tasks.ranks_saved", { actor, task: task.id, slot: input.slot, ranks: chosen.length, ...result.created });
    return { ok: true, revision: result.revision, warnings, created: result.created };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

/**
 * 실행 쪽이 읽지 않는 작업의 옛 순위 행 지우기(2026-11-08 사용자 결정 「1단계 배정 정리」). 실행 동작은 바뀌지 않는다 — 그 작업의 모델은 단계 풀·감사 설정에서 온다.
 * 같은 칸 잠금(advisory) → 화면 판 compare-and-set → 그 (작업, 칸)의 행만 지움 → 순위 저장과 같은 감사 한 줄(reason: unread_records_cleared).
 */
export async function clearUnreadAiTaskRanks(input: { task: string; slot: number; revision: string }, actor: string): Promise<{ ok: true; removed: number } | { ok: false; issues: string[] }> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  // 없앤 작업(RETIRED_AI_TASKS — 예: korean-translation-direct)의 남은 행도 같은 길로 지운다. 실행 쪽은 그 작업을 모른다
  const known = aiTask(input.task);
  const task = known ?? (isRetiredAiTask(input.task) ? { id: input.task, slots: AI_TASK_SLOT_MAX } : null);
  if (!task || !Number.isSafeInteger(input.slot) || input.slot < 1 || input.slot > task.slots) return { ok: false, issues: ["ai_task_invalid:task"] };
  if (known && !aiTaskRanksUnread(known.id)) return { ok: false, issues: ["ai_task_ranks_read"] };
  try {
    const removed = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_models'), hashtext(${`${task.id}#${input.slot}`}))`);
      const before = (await tx.select().from(aiTaskModels).where(and(eq(aiTaskModels.task, task.id), eq(aiTaskModels.slot, input.slot)))
        .orderBy(asc(aiTaskModels.rank))).map(rankRowOf);
      if (aiTaskSlotRevision(before) !== input.revision) fail("ai_task_revision_mismatch");
      if (!before.length) return 0;
      await tx.delete(aiTaskModels).where(and(eq(aiTaskModels.task, task.id), eq(aiTaskModels.slot, input.slot)));
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_TASK_MODELS_SAVE_AUDIT_ACTION, target: `${task.id}#${input.slot}`,
        detail: { task: task.id, slot: input.slot, revisionBefore: input.revision, revision: aiTaskSlotRevision([]), before: before.map(row => ({ ...row })), after: [],
          reason: "unread_records_cleared" } }));
      return before.length;
    }));
    logger.info("ai_tasks.unread_ranks_cleared", { actor, task: task.id, slot: input.slot, removed });
    return { ok: true, removed };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

// ── 가져오기 ────────────────────────────────────────────────────────────────────────────────────────────

export type AiImportServerRead = Readonly<{ baseUrl: string; host: string | null; count: number | null; error: string | null }>;
export type AiImportPreview = Readonly<{ hash: string | null; plan: AiImportPlan | null; servers: readonly AiImportServerRead[]; error: string | null;
  connectionLabels: Readonly<Record<string, string>>;
  /** 키를 옮기지 못해 키 없이 만들 새 연결의 경고(연결 이름마다 한 줄) — 적용을 막지 않는다. 계획의 경고 맨 앞에도 싣는다 */
  keyWarnings: readonly string[] }>;
type BuiltImport = { plan: AiImportPlan; served: Map<string, AiConnectionModel[]>; servers: AiImportServerRead[] };

/**
 * 계획 만들기(쓰지 않는다): 지금 연결·순위·장비·정책과 현재 값(buildAiCurrentSlots)을 읽고, 아직 연결이 없는 엔진 주소마다 GET /models 를 한 번 읽는다
 * (그 목록을 새 연결에 넣고, 서버가 이름을 정하는 임베딩·재정렬의 모델 이름을 고른다). 키는 계약 스냅숏(평문, 메모리 안) 또는 env 이름에서만 온다.
 */
async function buildImport(): Promise<BuiltImport> {
  const control = await readCapacityDevicesControl().catch(() => null);
  const [connections, rows, devices, currentAll] = await Promise.all([listAiConnections(), listAiTaskRows(), listModelCapacityDevices().catch(() => []),
    depsForTest?.current ? depsForTest.current() : readAiCurrentSources(control?.policy ?? null).then(buildAiCurrentSlots)]);
  // 실제로 순위를 읽는 작업만 가져온다 — 검색 등 비live 작업의 옛 설정을 저장된 순위처럼 만들지 않는다
  const current = currentAll.filter(slot => isAiLiveTask(slot.task));
  const deviceSlots = new Map<string, number>(Object.entries(control?.policy?.groupLimits ?? {}).map(([key, value]) => [key, Number(value)]));
  for (const device of devices) deviceSlots.set(device.deviceId, device.limitSlots);
  const hostEquipment = new Map<string, string>();
  for (const model of readModelRegistry().models) {
    const host = aiConnectionHost(model.baseUrl ? aiConnectionBaseUrl(model.baseUrl) : null);
    if (host && !hostEquipment.has(host)) hostEquipment.set(host, model.equipment);
  }
  const snapshot = servingContractSnapshot().rows;
  const bases = new Map<string, string | null>();
  for (const slot of current) for (const use of slot.uses) {
    if (use.kind !== "api" || !use.baseUrl || connections.some(row => row.baseUrl === use.baseUrl)) continue;
    const key = use.keyFrom ? snapshot.find(row => row.routeId === use.keyFrom!.routeId && row.model === use.keyFrom!.model)?.apiKey ?? null
      : use.keyEnv ? process.env[use.keyEnv]?.trim() || null : null;
    if (!bases.has(use.baseUrl) || (key && !bases.get(use.baseUrl))) bases.set(use.baseUrl, key);
  }
  const served = new Map<string, AiConnectionModel[]>(), servers: AiImportServerRead[] = [];
  await Promise.all([...bases.entries()].map(async ([baseUrl, key]) => {
    const read = await readModels(baseUrl, key);
    if (read.ok) served.set(baseUrl, read.models);
    servers.push({ baseUrl, host: aiConnectionHost(baseUrl), count: read.ok ? read.models.length : null, error: read.ok ? null : read.reason });
  }));
  servers.sort((a, b) => a.baseUrl.localeCompare(b.baseUrl));
  const plan = buildAiImportPlan({ current, connections, rows, deviceSlots, hostEquipment,
    served: new Map([...served.entries()].map(([base, models]) => [base, models.map(model => model.id)])) });
  return { plan, served, servers };
}

/** 새 연결이 옮길 키(평문, 메모리 안) — 계약 스냅숏의 저장 키 또는 env 이름. 키가 필요 없거나 읽지 못하면 null. */
function importKey(entry: AiImportConnection, snapshot: ReturnType<typeof servingContractSnapshot>["rows"]): string | null {
  return entry.keyFrom ? snapshot.find(row => row.routeId === entry.keyFrom!.routeId && row.model === entry.keyFrom!.model)?.apiKey ?? null
    : entry.keyEnv ? process.env[entry.keyEnv]?.trim() || null : null;
}
type ImportKeyMissing = { labels: readonly string[]; reason: "secret_box_key_missing" | "key_unreadable" | null; warnings: readonly string[] };
/**
 * 키를 옮기지 못하는 새 연결 — 키가 필요한 새 API 연결(keyFrom·keyEnv)인데 이 프로세스에 상자 키가 없거나 그 키를 읽지 못한 것. 가져오기는 이 때문에 멈추지 않는다
 * (2026-11-02 사람 결정 「키 없어도 배포는 되게」): 그 연결은 키 없이 만들고 순위도 그대로 적용한 뒤, 연결 이름마다 한국어 경고를 맨 앞에 싣는다.
 * 키 없는 연결은 ②(connection_key_missing)가 부르지 않고 다음 순위로 넘기고, ①(ai-connection-key-fill)이 같은 주소의 계약 키로 나중에 채우며,
 * 그사이 관리자가 다른 모델을 고를 수 있다. 문구는 계획(만듭니다)·적용(만들었습니다)만 다르다. 키 값·암호문은 싣지 않는다.
 */
function importKeyMissing(plan: AiImportPlan, snapshot: ReturnType<typeof servingContractSnapshot>["rows"], done: boolean): ImportKeyMissing {
  const needing = plan.connections.filter(entry => entry.action === "create" && entry.kind === "api" && (!!entry.keyFrom || !!entry.keyEnv));
  const boxReady = secretBoxReady();
  const missing = boxReady ? needing.filter(entry => !importKey(entry, snapshot)) : needing;
  const why = (entry: AiImportConnection) => !boxReady ? "이 프로세스에 키 암호화 설정(NMV_SECRET_BOX_KEY)이 없음"
    : `${entry.keyFrom ? `계약 ${entry.keyFrom.routeId} · ${entry.keyFrom.model} 의 저장 키` : `환경변수 ${entry.keyEnv}`}를 이 프로세스에서 읽지 못함`;
  return { labels: missing.map(entry => entry.label), reason: !missing.length ? null : boxReady ? "key_unreadable" : "secret_box_key_missing",
    warnings: missing.map(entry => `${entry.label}: 키를 옮기지 못해 키 없이 ${done ? "만들었습니다" : "만듭니다"}(${why(entry)}) — 이 연결은 키가 채워질 때까지 `
      + "부르지 않고 다음 순위로 넘깁니다. 웹·워커가 같은 주소의 계약 키로 자동으로 채우거나, 연결에 키를 넣거나, 다른 모델을 고르세요") };
}

export async function previewAiTaskImport(): Promise<AiImportPreview> {
  try {
    const { plan, servers } = await buildImport();
    const connections = await listAiConnections();
    const connectionLabels = Object.fromEntries(plan.connections.map(row => [row.key, row.label]));
    for (const connection of connections) connectionLabels[connection.kind === "cli" ? `cli:${connection.cliTool}` : `api:${connection.baseUrl}`] ??= connection.label;
    const keyWarnings = importKeyMissing(plan, servingContractSnapshot().rows, false).warnings;
    // hash 는 연결·순위의 쓰는 칸만 본다 — 경고 앞에 키 경고를 실어도 적용이 다시 만드는 계획의 hash 와 같다
    return { hash: aiImportPlanHash(plan), plan: keyWarnings.length ? Object.freeze({ ...plan, warnings: Object.freeze([...keyWarnings, ...plan.warnings]) }) : plan,
      servers, error: null, connectionLabels, keyWarnings: Object.freeze([...keyWarnings]) };
  } catch (error) { return { hash: null, plan: null, servers: [], error: issueOf(error), connectionLabels: {}, keyWarnings: [] }; }
}

export type ApplyAiTaskImportResult = { ok: true; connections: number; slots: number; skipped: number; warnings: string[] } | { ok: false; issues: string[] };
/**
 * 가져오기 적용 — 계획을 다시 만들어 보여 준 hash 와 같을 때만, 한 TX 에서: 새 연결(목록·키 포함)·CLI 모델 이름 더하기·비어 있던 칸의 순위 행을 쓴다.
 * 계약·정책 route·장비는 만들지 않는다(오늘 설정을 그대로 옮기는 것이라 오늘 없는 것은 오늘도 없다 — 표의 「준비 상태」가 알린다).
 * 이미 순위가 있는 칸은 건너뛴다. 감사 한 줄(가져온 연결·칸 전부).
 * 키가 필요한 새 연결의 키를 옮길 수 없으면(상자 키 없음·키를 못 읽음) 거절하지 않고 그 연결을 키 없이 만든다 — 결과 warnings 맨 앞에 연결 이름별 경고(importKeyMissing).
 */
export async function applyAiTaskImport(expectedHash: string, actor: string): Promise<ApplyAiTaskImportResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return { ok: false, issues: ["ai_task_import_plan_changed"] };
  try {
    const { plan, served } = await buildImport();
    if (aiImportPlanHash(plan) !== expectedHash) return { ok: false, issues: ["ai_task_import_plan_changed"] };
    const snapshot = servingContractSnapshot().rows;
    // 키를 옮길 수 없는 새 연결은 키 없이 만든다(가져오기·배포를 멈추지 않는다) — 경고를 맨 앞에, 로그에는 이유 코드와 개수만
    const keyMissing = importKeyMissing(plan, snapshot, true);
    const sealKeys = secretBoxReady();
    const warnings = [...keyMissing.warnings, ...plan.warnings];
    const result = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      const ids = new Map<string, string>();
      const written: Record<string, unknown>[] = [];
      for (const entry of plan.connections) {
        if (entry.action === "existing") { ids.set(entry.key, entry.id!); continue; }
        if (entry.action === "update") {
          const [row] = await tx.update(aiConnections).set({ cliModels: [...entry.cliModels], version: sql`${aiConnections.version} + 1`, updatedBy: actor,
            updatedAt: sql`clock_timestamp()` }).where(eq(aiConnections.id, entry.id!)).returning({ id: aiConnections.id });
          if (!row) fail("ai_connection_missing");
          ids.set(entry.key, entry.id!);
          written.push({ key: entry.key, action: "update", id: entry.id, cliModels: [...entry.cliModels] });
          continue;
        }
        const id = randomUUID();
        // 상자 키가 있고 키를 읽었을 때만 옮겨 잠근다 — 아니면 키 없이 만든다(위 keyMissing 경고)
        const plain = entry.kind === "api" && sealKeys ? importKey(entry, snapshot) : null;
        const models = entry.baseUrl ? served.get(entry.baseUrl) ?? null : null;
        await tx.insert(aiConnections).values({ id, label: entry.label, kind: entry.kind, baseUrl: entry.baseUrl, cliTool: entry.cliTool, cliModels: [...entry.cliModels],
          apiKeyCiphertext: plain ? sealSecret(plain, aiConnectionKeyAad(id)) : null, models,
          modelsReadAt: models ? new Date(now()) : null, modelsError: entry.kind === "api" && !models ? "unreachable" : null, deviceId: entry.deviceId,
          capacitySlots: entry.capacitySlots, options: {}, enabled: true, note: "지금 설정 가져오기로 만듦", updatedBy: actor });
        ids.set(entry.key, id);
        written.push({ key: entry.key, action: "create", id, label: entry.label, kind: entry.kind, baseUrl: entry.baseUrl, cliTool: entry.cliTool,
          cliModels: [...entry.cliModels], deviceId: entry.deviceId, capacitySlots: entry.capacitySlots, keyMoved: !!plain, models: models?.length ?? null });
      }
      const slots: Record<string, unknown>[] = [];
      let skipped = 0;
      for (const slot of plan.slots) {
        if (!isAiLiveTask(slot.task)) { if (slot.action === "create") skipped += 1; continue; }
        if (slot.action !== "create") continue;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_models'), hashtext(${`${slot.task}#${slot.slot}`}))`);
        const [exists] = await tx.select({ id: aiTaskModels.id }).from(aiTaskModels).where(and(eq(aiTaskModels.task, slot.task), eq(aiTaskModels.slot, slot.slot))).limit(1);
        if (exists) { skipped += 1; continue; }
        await tx.insert(aiTaskModels).values(slot.ranks.map(rank => ({ task: slot.task, slot: slot.slot, rank: rank.rank, connectionId: ids.get(rank.connectionKey)!,
          model: rank.model, options: { ...rank.options }, enabled: true, note: `가져옴: ${rank.origin}`.slice(0, 400), updatedBy: actor })));
        slots.push({ task: slot.task, slot: slot.slot, ranks: slot.ranks.map(rank => ({ rank: rank.rank, connection: rank.connectionKey, model: rank.model, origin: rank.origin })) });
      }
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_TASK_MODELS_IMPORT_AUDIT_ACTION, target: "ai-task-models",
        detail: { hash: expectedHash, connections: written, slots, skipped, warnings: warnings.length } }));
      return { connections: written.length, slots: slots.length, skipped };
    }));
    if (keyMissing.reason) logger.warn("ai_tasks.import_key_missing", { actor, reason: keyMissing.reason, connections: keyMissing.labels.length });
    logger.info("ai_tasks.import_applied", { actor, ...result });
    return { ok: true, ...result, warnings };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

/** 화면 줄 이름(감사 target `task#slot` → 「2차 AI 검수 · 투표자 1」). */
export function aiTaskTargetLabel(target: string): string {
  const [id, slot] = target.split("#");
  const task = aiTask(id);
  return task ? aiTaskSlotLabel(task, Number(slot) || 1) : RETIRED_AI_TASKS[id] ?? target;
}
export type { AiRankChoice };


export { readReadinessInput as readAiTaskReadinessInput, crossRankIssues as aiTaskCrossResourceIssues };
export type AiTaskResourceChoice = Readonly<{ rank: number; row: AiRankChoice; connection: AiConnectionView }>;

/** Existing contract readback/probe path shared by rank and pool saves; no inference during selection. */
export async function prepareAiTaskServingResources(task: AiTaskDef, chosen: readonly AiTaskResourceChoice[], readiness: readonly AiRankReadiness[]) {
// 엔진 직접 계약 — 네트워크는 잠금 전에(엔진 연결·배정 저장과 같은 readback + 1토큰 시험)
  const contracts: { routeId: string; model: string; contract: Readonly<Record<string, unknown>>; key: string | null; label: string }[] = [];
  for (const [index, ready] of readiness.entries()) {
    if (!ready.createContract) continue;
    const { connection, row } = chosen[index];
    const [record] = await onPrimary(() => db.select().from(aiConnections).where(eq(aiConnections.id, connection.id)));
    // Keep the selected endpoint and its credential on the same connection version before network I/O.
    if (!record || Number(record.version) !== connection.version || !record.enabled)
      return { ok: false as const, issues: ["ai_connection_version_mismatch"] };
    const key = connectionKey(record);
    const cliEngine = ready.createContract.cliEngine;
    if (cliEngine) {
      if (!record.apiKeyCiphertext || key === null) return { ok: false as const, issues: ["ai_connection_key_unreadable"] };
      if (record.kind !== "cli" || record.cliTool !== "opencode" || !record.baseUrl || !aiTaskUsesCliEngine(task.id, connection)
        || cliEngine.connectionId !== connection.id)
        return { ok: false as const, issues: [`ai_task_contract_probe_failed:${ready.createContract.routeId}:cli_engine_unsupported`] };
      let catalog: CliCatalogMetadata;
      try { catalog = await readAdminCliCatalog({ fresh: true, connectionId: connection.id }); }
      catch { return { ok: false as const, issues: ["ai_connection_cli_host_unavailable"] }; }
      const served = catalog.models.find(model => model.id === row.model);
      const context = served?.maxModelLen;
      const effortSupported = !cliEngine.reasoningEffort || (served?.variants as readonly unknown[] | undefined)?.some(variant =>
        variant === cliEngine.reasoningEffort || (typeof variant === "object" && variant !== null && (variant as { id?: unknown }).id === cliEngine.reasoningEffort));
      if (!served || typeof context !== "number" || !Number.isSafeInteger(context) || context <= 0 || context > 2097152
        || !effortSupported || (task.kind === "vision" && served.vision !== true))
        return { ok: false as const, issues: ["ai_connection_cli_catalog_changed"] };
      const contract = engineRouteContract(ready.createContract.routeId as GatewayServingRoute, ready.createContract.identity, row.model,
        cliEngineEndpoint(record.baseUrl), context, connection.deviceId, "engine", ready.createContract.engineModel);
      if (!contract) return { ok: false as const, issues: [`ai_task_contract_probe_failed:${ready.createContract.routeId}:contract_schema_invalid`] };
      contracts.push({ routeId: ready.createContract.routeId, model: ready.createContract.identity,
        contract: { ...contract, deploymentRevision: cliEngineRevision(cliEngine) }, key: cliEngineBearer(key), label: connection.label });
      continue;
    }
    if (record?.apiKeyCiphertext && key === null) return { ok: false as const, issues: ["ai_connection_key_unreadable"] };
    const served = connection.models?.find(model => model.id === row.model);
    let probed;
    try {
      // 목록 없는 서버에 적은 모델(2026-11-10)은 GET /models 대조 없이 1토큰 시험만 한다 — 상한은 연결의 「컨텍스트 상한」
      probed = await probeEngineContract({ endpoint: `${connection.baseUrl}/chat/completions`, engineModel: row.model, apiKey: key,
        maxModelLen: served?.maxModelLen ? null : connection.contextTokens, unlisted: aiConnectionManualOnly(connection, row.model) }, request());
    } catch (error) {
      const reason = error instanceof Error && /^[a-z0-9_:.-]{1,80}$/.test(error.message) ? error.message : "error";
      return { ok: false as const, issues: [`ai_task_contract_probe_failed:${ready.createContract.routeId}:${reason}`] };
    }
    // 장부 이름(identity)이 계약 행의 열쇠다. 같은 모델을 다른 연결에도 둔 순위는 연결로 가른 이름이고 엔진에는 engineModel(= 순위 모델)이 나간다(PR B)
    // 추론 토큰 여유는 그 칸을 받는 경로(사유 번역·한국어 소개)의 계약에만 실린다
    const contract = engineRouteContract(ready.createContract.routeId as GatewayServingRoute, ready.createContract.identity, probed.responseModel, probed.endpoint,
      probed.totalTokenBound, connection.deviceId, probed.totalTokenBoundFrom, ready.createContract.engineModel, connection.reasoningTokenReserve ?? null);
    if (!contract) return { ok: false as const, issues: [`ai_task_contract_probe_failed:${ready.createContract.routeId}:contract_schema_invalid`] };
    contracts.push({ routeId: ready.createContract.routeId, model: ready.createContract.identity, contract, key, label: connection.label });
  }
  // 감사 직접 경로의 로컬 계약(「발행분 감사 · 변경 재판정」의 API 순위, 2026-11-09) — 엔진 직접 계약과 같은 readback(GET /models) + 1토큰 시험으로 응답 모델·문맥 상한을
  // 확인하고 local-openai-chat-v1 계약을 만든다(네트워크는 잠금 전에). 관리 표의 행은 확인해 넣은 계약으로 읽힌다(local-model-contract-table.ts)
  const localContracts: LocalModelServingContract[] = [];
  for (const [index, ready] of readiness.entries()) {
    const wanted = ready.createLocalContract;
    if (!wanted) continue;
    const { connection, row } = chosen[index];
    const [record] = await onPrimary(() => db.select().from(aiConnections).where(eq(aiConnections.id, connection.id)));
    if (!record || Number(record.version) !== connection.version || !record.enabled || record.kind !== "api" || record.baseUrl !== connection.baseUrl)
      return { ok: false as const, issues: ["ai_connection_version_mismatch"] };
    const key = connectionKey(record);
    if (record.apiKeyCiphertext && key === null) return { ok: false as const, issues: ["ai_connection_key_unreadable"] };
    const served = connection.models?.find(model => model.id === row.model);
    let probed;
    try {
      probed = await probeEngineContract({ endpoint: wanted.endpoint, engineModel: row.model, apiKey: key,
        maxModelLen: served?.maxModelLen ? null : connection.contextTokens, unlisted: aiConnectionManualOnly(connection, row.model) }, request());
    } catch (error) {
      const reason = error instanceof Error && /^[a-z0-9_:.-]{1,80}$/.test(error.message) ? error.message : "error";
      return { ok: false as const, issues: [`ai_task_contract_probe_failed:${wanted.routeId}:${reason}`] };
    }
    const contract = auditDirectLocalContract(wanted, connection.id, probed);
    if (!contract) return { ok: false as const, issues: [`ai_task_contract_probe_failed:${wanted.routeId}:contract_schema_invalid`] };
    localContracts.push(contract);
  }
  // CLI 계약(PR C1 — 1차·2차·Grok 로그인 유지): 연결의 CLI 버전과 route 의 argv 상한으로 만든다(네트워크 없음)
  const cliContracts = readiness.flatMap(ready => {
    if (!ready.createCliContract) return [];
    const contract = cliDbContract(ready.createCliContract.routeId, ready.createCliContract.provider as CliProvider, ready.createCliContract.model,
      ready.createCliContract.cliVersion);
    return [{ ready, contract }];
  });
  const brokenCli = cliContracts.find(entry => !entry.contract);
  if (brokenCli) return { ok: false as const, issues: [`${brokenCli.ready.rank}순위 ${brokenCli.ready.model}: CLI 계약을 만들 수 없습니다(이 작업이 받지 않는 CLI 이거나 버전 글이 맞지 않음).`] };
  return { ok: true as const, contracts, cliContracts, localContracts };
}

/**
 * 감사 직접 경로의 로컬 계약 한 장(순수) — 엔진이 답한 응답 모델·문맥 상한으로. thinking 은 심사 wire 가 보내던 것(chat_template_kwargs.enable_thinking=false)을
 * 계약이 대신 붙인다(local-model-capacity.ts 가 wire 의 thinking 칸을 지우고 계약의 것을 붙인다). 배포 리비전은 연결 id(CLI 엔진 리비전이 아니다).
 * 모양이 계약 규칙을 어기면 null.
 */
export function auditDirectLocalContract(wanted: NonNullable<AiRankReadiness["createLocalContract"]>, connectionId: string,
  probed: { responseModel: string; totalTokenBound: number }): LocalModelServingContract | null {
  const parsed = localModelServingContractSchema.safeParse({ version: 1, protocol: "local-openai-chat-v1", backendId: wanted.backendId, provider: "local-direct",
    physicalGroup: wanted.physicalGroup, endpoint: wanted.endpoint, model: wanted.model, responseModel: probed.responseModel,
    modelFamily: wanted.model.slice(0, 120).trim(), deploymentRevision: `ai-connection:${connectionId}`,
    contextWindowTokens: probed.totalTokenBound, totalTokenBound: probed.totalTokenBound, maxOutputTokens: Math.min(probed.totalTokenBound, 262_144),
    maxInputBytes: 16 * 1024 * 1024, capabilities: { vision: false, jsonSchema: true },
    thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } });
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export type AiTaskServingResources = Extract<Awaited<ReturnType<typeof prepareAiTaskServingResources>>, { ok: true }>;

/** Caller owns its existing writer fence/config CAS. Resource semantics are the same for both save paths. */
export async function saveAiTaskServingResources(tx: ProductTransaction, task: AiTaskDef, readiness: readonly AiRankReadiness[],
  resources: AiTaskServingResources, actor: string) {
  const { contracts, cliContracts, localContracts = [] } = resources;
  const madeContracts: string[] = [];
  for (const contract of localContracts) {
    const saved = await saveLocalContract(tx, contract, actor, `작업 ↔ 모델 저장(${task.label}) · ${task.wiring === "assist-direct" ? "LLM 보강 경로" : "감사 직접 경로"}`);
    if (saved) madeContracts.push(`${saved.routeId} · ${contract.model} 로컬 계약 (#${saved.id})`);
  }
  for (const entry of contracts) {
    const saved = await saveServingContractTx(tx, { routeId: entry.routeId, contract: entry.contract, auth: entry.key ? "stored" : "none", transport: "direct",
      apiKey: entry.key ?? undefined, note: `작업 ↔ 모델 저장(${task.label}) · 연결 ${entry.label}` }, actor);
    madeContracts.push(`${entry.routeId} · ${entry.model} (#${saved.id})`);
  }
  for (const entry of cliContracts) {
    const saved = await saveCliServingContractTx(tx, { contract: entry.contract!, note: `작업 ↔ 모델 저장(${task.label}) · CLI 버전 ${entry.contract!.cliVersion}` }, actor);
    madeContracts.push(`${entry.contract!.routeId} · ${entry.contract!.provider} · ${entry.contract!.model} CLI (#${saved.id})`);
  }
  const madeDevices: string[] = [];
  const wantDevices = [...new Map(readiness.flatMap(row => row.createDevice ? [[row.createDevice.deviceId, row.createDevice] as const] : [])).values()];
  if (wantDevices.length) {
    // 모든 장비 저장이 control 을 먼저 잡는다 — 잡은 채로 없음을 다시 확인해야 다른 저장이 만든 행을 덮지 않는다
    await tx.select({ id: modelCapacityControl.id }).from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for("update");
    for (const device of wantDevices) {
      const [exists] = await tx.select({ id: modelCapacityDevices.deviceId }).from(modelCapacityDevices).where(eq(modelCapacityDevices.deviceId, device.deviceId)).for("update");
      if (exists) continue;
      await saveModelCapacityDevice(tx, { deviceId: device.deviceId, limitSlots: device.limitSlots, secondaryCap: device.limitSlots, idleMs: 60_000, reserveSlots: 0,
        physicalLimit: null, roles: [], note: `작업 ↔ 모델 저장(${task.label})이 만듦` }, null, actor);
      madeDevices.push(`${device.deviceId} (${device.limitSlots}칸)`);
    }
  }
  const wantRoutes = readiness.flatMap(row => [...row.appendRoute ? [row.appendRoute] : [], ...row.extraRoutes ?? []]);
  let appended: readonly { routeId: string; provider: string; model: string; groupId: string }[] = [], policyRevision: number | null = null;
  if (wantRoutes.length) {
    const { appendCompatibleRoutes } = await import("@/lib/llm/capacity-repository");
    // 정책에 한도 선언 맵(groupLimits·providerLimits)이 있으면 새 장비·예산 이름도 거기 있어야 정책이 파싱된다(운영 정책 rev31 은 두 맵이 있다).
    // 입장은 그 값을 읽지 않으므로(장비 행이 한도) 이 저장이 쓰는(방금 만든) 장비 행의 한도로 선언한다 — 이미 선언된 이름은 그대로 둔다
    const groups = [...new Set(wantRoutes.map(route => route.groupId))];
    const rows = await tx.select({ deviceId: modelCapacityDevices.deviceId, limitSlots: modelCapacityDevices.limitSlots }).from(modelCapacityDevices)
      .where(inArray(modelCapacityDevices.deviceId, groups));
    const done = await appendCompatibleRoutes(tx, wantRoutes, { declareLimit: groupId => rows.find(row => row.deviceId === groupId)?.limitSlots });
    appended = done.appended; policyRevision = done.policyRevision;
  }
  return { contracts: madeContracts, devices: madeDevices, routes: appended.map(route => `${route.routeId} / ${route.provider} / ${route.model} → ${route.groupId}`), policyRevision };
}

export { ensureCliStageModelResources } from "./admin-cli-stage-resources";
