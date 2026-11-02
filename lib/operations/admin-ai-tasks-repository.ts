import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { aiConnections, aiTaskModels, modelCapacityControl, modelCapacityDevices, operationsAudit, type AiConnectionModel } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { resolveAi2GatewayServingContract } from "@/lib/crawl/second-review-serving-contract";
import { aiTask, aiTaskSlotLabel, aiTaskSlots, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { listModelCapacityDevices, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import type { GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { resolveLocalModelContract } from "@/lib/llm/local-model-contract-table";
import { readModelRegistry } from "@/lib/llm/model-registry";
import { ensureServingContracts, servingContractSnapshot } from "@/lib/llm/serving-contract-store";
import { logger } from "@/lib/observability/logger";
import { openSecret, sealSecret, secretBoxReady } from "@/lib/security/secret-box";
import {
  AI_CONNECTION_DELETE_AUDIT_ACTION, AI_CONNECTION_MODELS_AUDIT_ACTION, AI_CONNECTION_SAVE_AUDIT_ACTION, AI_TASK_AUDIT_ACTIONS, AI_TASK_MODELS_IMPORT_AUDIT_ACTION,
  AI_TASK_MODELS_SAVE_AUDIT_ACTION, aiConnectionBaseUrl, aiConnectionHost, aiConnectionKeyAad, aiImportPlanDigestInput, aiRankReadiness, aiTaskRankNotices,
  aiTaskRankOptions, aiTaskSlotDigestInput, buildAiImportPlan, validateAiTaskRanks,
  type AiConnectionInput, type AiConnectionView, type AiCurrentSlot, type AiImportPlan, type AiPolicyRoute, type AiRankChoice, type AiRankOption,
  type AiRankReadiness, type AiReadinessInput, type AiTaskRankRow, type AiTaskRanksInput,
} from "./admin-ai-tasks";
import { buildAiCurrentSlots, readAiCurrentSources } from "./admin-ai-task-current";
import { readCapacityDevicesControl } from "./admin-capacity-devices";
import { engineRouteContract, ENGINE_CONNECT_ROUTES, probeEngineContract } from "./admin-engine-connect";
import { adminAuditRow, adminLog, type AdminLogRow } from "./admin-log";
import { DIRECT_PROBE_INTERVAL_MS, directProbeDue, directProbeGate } from "./admin-models-direct-probe";
import { readbackServingEndpoint, saveServingContractTx } from "./admin-serving-contracts";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";

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
  if (pg.code === "23503" && constraint === "ai_task_models_connection_fk") return "ai_connection_in_use";
  const message = error instanceof Error ? error.message : String(error);
  if (SAFE_CODE.test(message)) return message;
  logger.warn("ai_tasks.save_failed", { code: typeof pg.code === "string" ? pg.code : null, constraint,
    error: typeof pg.message === "string" && pg !== error ? pg.message.slice(0, 200) : message.startsWith("Failed query") ? "failed_query" : message.slice(0, 200) });
  return "ai_task_save_failed";
}

// ── 읽기 ───────────────────────────────────────────────────────────────────────────────────────────────

const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
export function aiConnectionView(row: ConnectionRecord): AiConnectionView {
  const models = Array.isArray(row.models) ? row.models.filter((entry): entry is AiConnectionModel => !!entry && typeof entry.id === "string")
    .map(entry => Object.freeze({ id: entry.id, maxModelLen: typeof entry.maxModelLen === "number" ? entry.maxModelLen : null })) : null;
  return Object.freeze({ id: row.id, label: row.label, kind: row.kind, baseUrl: row.baseUrl, host: aiConnectionHost(row.baseUrl), hasKey: row.apiKeyCiphertext !== null,
    cliTool: row.cliTool, cliModels: Object.freeze([...row.cliModels]), models: models && Object.freeze(models), modelsReadAt: iso(row.modelsReadAt), modelsError: row.modelsError,
    deviceId: row.deviceId, capacitySlots: row.capacitySlots, contextTokens: typeof row.options?.contextTokens === "number" ? row.options.contextTokens : null,
    enabled: row.enabled, version: Number(row.version), note: row.note, updatedBy: row.updatedBy, updatedAt: new Date(row.updatedAt).toISOString() });
}
export async function listAiConnections(reader?: Reader): Promise<AiConnectionView[]> {
  const load = async (from: Reader) => (await from.select().from(aiConnections).orderBy(asc(aiConnections.kind), asc(aiConnections.label))).map(aiConnectionView);
  return reader ? load(reader) : onPrimary(() => load(db));
}
const rankRowOf = (row: typeof aiTaskModels.$inferSelect): AiTaskRankRow => Object.freeze({ task: row.task, slot: row.slot, rank: row.rank, connectionId: row.connectionId,
  model: row.model, options: Object.freeze({ ...row.options }), enabled: row.enabled });
export async function listAiTaskRows(reader?: Reader): Promise<AiTaskRankRow[]> {
  const load = async (from: Reader) => (await from.select().from(aiTaskModels).orderBy(asc(aiTaskModels.task), asc(aiTaskModels.slot), asc(aiTaskModels.rank))).map(rankRowOf);
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
      provider: typeof contract.provider === "string" ? contract.provider : null, endpoint: typeof contract.endpoint === "string" ? contract.endpoint : null };
  });
  let policy: AiReadinessInput["policy"] = null, policyError: string | null = null;
  try {
    const control = await readCapacityDevicesControl();
    if (control.mode === "disabled") policy = { mode: "disabled", routes: [], groupLimits: {} };
    else if (control.policy) policy = { mode: control.mode, routes: control.policy.routes.map(route => ({ ...route })) as AiPolicyRoute[],
      groupLimits: { ...(control.policy.groupLimits ?? {}) } as Record<string, number> };
    else policyError = control.policyVerified ? "model_capacity_policy_missing" : "model_capacity_policy_unverified";
  } catch (error) { policyError = error instanceof Error ? error.message : "read_failed"; }
  const devices = new Map((await listModelCapacityDevices().catch(() => [])).map(device => [device.deviceId, { enabled: device.enabled, limitSlots: device.limitSlots }]));
  const endpointOf = (value: unknown) => value && typeof value === "object" && typeof (value as { endpoint?: unknown }).endpoint === "string"
    ? (value as { endpoint: string }).endpoint : null;
  return { contracts, policy, policyError, devices, engineRoutes: ENGINE_CONNECT_ROUTES,
    ai2Contract: model => {
      const abc = resolveAi2GatewayServingContract(model, "abcllm");
      if (abc) return { provider: "abcllm", endpoint: endpointOf(abc) };
      const local = resolveAi2GatewayServingContract(model, "local-direct");
      return local ? { provider: "local-direct", endpoint: endpointOf(local) } : null;
    },
    localContract: backendId => {
      const contract = resolveLocalModelContract(backendId);
      return contract ? { model: contract.model, endpoint: contract.endpoint } : null;
    } };
}

/** 같은 작업 안에서 계약·정책 route 가 (경로, provider, 모델) 하나에 서버 하나라 두 순위가 같은 모델을 다른 연결로 쓰면 오늘 실행 쪽이 가를 수 없다. */
function crossRankIssues(task: AiTaskDef, readiness: readonly AiRankReadiness[]): string[] {
  if (!task.routeId || task.wiring === "uncapped" || task.wiring === "deferred") return [];
  const issues: string[] = [];
  readiness.forEach((row, index) => {
    const earlier = readiness.slice(0, index).find(other => other.provider === row.provider && other.model === row.model && other.connectionId !== row.connectionId);
    if (earlier) issues.push(`${earlier.rank}순위와 ${row.rank}순위가 같은 모델(${row.model})을 다른 서버로 씁니다. 오늘 실행 쪽은 경로·모델마다 서버 하나만 알아 `
      + "두 순위를 가를 수 없습니다 — 다음 단계(PR B)에서 풀립니다. 지금은 다른 모델을 고르세요.");
  });
  return issues;
}

export type AiTaskSlotView = Readonly<{
  task: AiTaskDef; slot: number; label: string; revision: string; rows: readonly AiTaskRankRow[]; options: readonly AiRankOption[];
  current: AiCurrentSlot | null; currentLabels: readonly string[]; sameAsCurrent: boolean | null;
  /** 저장된 순위의 준비 상태(막힘·경고) */
  readiness: readonly AiRankReadiness[];
}>;
export type AiTaskAuditView = Readonly<{ id: number; at: string; actor: string; action: string; target: string; ok: boolean; summary: string }>;
export type AiTasksAdminView = Readonly<{
  connections: readonly AiConnectionView[]; rows: readonly AiTaskRankRow[]; slots: readonly AiTaskSlotView[];
  audit: readonly AiTaskAuditView[]; errors: Readonly<Record<string, string>>; secretBox: boolean; policyMode: string | null;
}>;

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
    case AI_CONNECTION_SAVE_AUDIT_ACTION: return `${detail.created ? "만듦" : "고침"} · ${String((detail.after as { label?: unknown } | undefined)?.label ?? "")}${detail.keyChanged ? " · 키 바꿈" : ""}`;
    case AI_CONNECTION_MODELS_AUDIT_ACTION: return detail.error ? `목록 읽기 실패(${String(detail.error)})` : `모델 ${String(detail.count ?? 0)}개 읽음`;
    case AI_CONNECTION_DELETE_AUDIT_ACTION: return `지움 · ${String(detail.label ?? "")}`;
    case AI_TASK_MODELS_SAVE_AUDIT_ACTION: {
      const after = Array.isArray(detail.after) ? detail.after as { rank: number; model: string }[] : [];
      const made = detail.created as { devices?: unknown[]; contracts?: unknown[]; routes?: unknown[] } | undefined;
      const extra = [made?.devices?.length ? `장비 ${made.devices.length}` : "", made?.contracts?.length ? `계약 ${made.contracts.length}` : "",
        made?.routes?.length ? `정책 경로 ${made.routes.length}` : ""].filter(Boolean).join(" · ");
      return `${after.length ? after.map(entry => `${entry.rank}순위 ${entry.model}`).join(", ") : "순위 비움"}${extra ? ` · 만듦: ${extra}` : ""}`;
    }
    case AI_TASK_MODELS_IMPORT_AUDIT_ACTION: return `가져오기 · 연결 ${String((detail.connections as unknown[] | undefined)?.length ?? 0)} · 칸 ${String((detail.slots as unknown[] | undefined)?.length ?? 0)}`;
    default: return "—";
  }
}

/** 화면 한 번 그리기 — 연결·순위·현재 값·준비 상태·최근 기록. 어느 하나를 못 읽어도 화면은 뜬다(그 자리에 이유). */
export async function readAiTasksAdminView(): Promise<AiTasksAdminView> {
  const errors: Record<string, string> = {};
  const settle = async <T>(key: string, work: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await work(); } catch (error) { errors[key] = error instanceof Error ? error.message.slice(0, 160) : "read_failed"; return fallback; }
  };
  const [connections, rows, readiness, audit] = await Promise.all([settle("connections", () => listAiConnections(), [] as AiConnectionView[]),
    settle("rows", () => listAiTaskRows(), [] as AiTaskRankRow[]), settle("readiness", readReadinessInput, null),
    settle("audit", () => adminLog({ actions: [...AI_TASK_AUDIT_ACTIONS] }), [] as AdminLogRow[])]);
  if (readiness?.policyError) errors.policy = readiness.policyError;
  const current = await settle("current", async () => depsForTest?.current ? depsForTest.current()
    : buildAiCurrentSlots(await readAiCurrentSources((await readCapacityDevicesControl().catch(() => null))?.policy ?? null)), [] as AiCurrentSlot[]);
  const slots = aiTaskSlots().map(({ task, slot }): AiTaskSlotView => {
    const own = rows.filter(row => row.task === task.id && row.slot === slot).sort((a, b) => a.rank - b.rank);
    const cur = current.find(entry => entry.task === task.id && entry.slot === slot) ?? null;
    const ready = readiness ? own.flatMap(row => {
      const connection = connections.find(entry => entry.id === row.connectionId);
      return connection ? [aiRankReadiness(task, row.rank, connection, row.model, readiness)] : [];
    }) : [];
    return Object.freeze({ task, slot, label: aiTaskSlotLabel(task, slot), revision: aiTaskSlotRevision(own), rows: Object.freeze(own),
      options: Object.freeze(aiTaskRankOptions(task, connections, own)), current: cur,
      currentLabels: Object.freeze((cur?.uses ?? []).slice(0, 3).map(use => currentLabel(use, connections))), sameAsCurrent: sameAsCurrent(own, cur, connections),
      readiness: Object.freeze(ready) });
  });
  return Object.freeze({ connections: Object.freeze(connections), rows: Object.freeze(rows), slots: Object.freeze(slots), errors: Object.freeze(errors),
    secretBox: secretBoxReady(), policyMode: readiness?.policy?.mode ?? null,
    audit: Object.freeze(audit.slice(0, 30).map(row => Object.freeze({ id: row.id, at: new Date(row.createdAt).toISOString(), actor: row.actor, action: row.action,
      target: row.target, ok: row.ok, summary: auditSummary(row) }))) });
}

// ── 연결 저장 ───────────────────────────────────────────────────────────────────────────────────────────

type ModelsRead = { ok: true; models: AiConnectionModel[] } | { ok: false; reason: string };
/** GET {base}/models — 5초, 리다이렉트 없음, 키는 Bearer 로만(readbackServingEndpoint 그대로). */
async function readModels(baseUrl: string, key: string | null): Promise<ModelsRead> {
  const result = await readbackServingEndpoint(`${baseUrl}/chat/completions`, key, request()).catch(() => ({ ok: false as const, reason: "unreachable" }));
  return result.ok ? { ok: true, models: result.models.slice(0, 512).map(model => ({ id: model.id.slice(0, 200), maxModelLen: model.maxModelLen })) }
    : { ok: false, reason: /^[a-z0-9_]{1,40}$/.test(result.reason) ? result.reason : "unreachable" };
}

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
      const ciphertext = input.kind !== "api" || input.key.mode === "clear" ? null : input.key.mode === "set" ? sealSecret(input.key.value, aiConnectionKeyAad(id))
        : locked?.apiKeyCiphertext ?? null;
      const values = { label: input.label, kind: input.kind, baseUrl: input.kind === "api" ? input.baseUrl : null, apiKeyCiphertext: ciphertext,
        cliTool: input.kind === "cli" ? input.cliTool : null, cliModels: input.kind === "cli" ? input.cliModels : [], models,
        modelsReadAt: input.kind !== "api" ? null : read?.ok ? new Date(now()) : sameBase ? locked?.modelsReadAt ?? null : null,
        modelsError: input.kind !== "api" ? null : read && !read.ok ? read.reason : null, deviceId: input.deviceId, capacitySlots: input.capacitySlots,
        options: input.contextTokens ? { contextTokens: input.contextTokens } : {}, enabled: input.enabled, note: input.note, updatedBy: actor };
      const [row] = locked
        ? await tx.update(aiConnections).set({ ...values, version: sql`${aiConnections.version} + 1`, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(aiConnections.id, id), eq(aiConnections.version, Number(locked.version)))).returning()
        : await tx.insert(aiConnections).values({ id, ...values }).returning();
      if (!row) fail("ai_connection_version_mismatch");
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_CONNECTION_SAVE_AUDIT_ACTION, target: `${row.label}`.slice(0, 200),
        detail: { id, created: !locked, keyChanged: input.key.mode !== "keep", before: connectionAudit(locked ?? null), after: connectionAudit(row),
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
  try {
    const [connections, rows] = await Promise.all([listAiConnections(), listAiTaskRows()]);
    const ranks = input.ranks.slice(0, 3);
    const issues = validateAiTaskRanks(task.id, input.slot, ranks, { connections, rows });
    if (issues.length) return { ok: false, issues };
    const chosen = ranks.flatMap((row, index) => row ? [{ rank: index + 1, row, connection: connections.find(entry => entry.id === row.provider)! }] : []);
    const readinessInput = await readReadinessInput();
    const readiness = chosen.map(entry => aiRankReadiness(task, entry.rank, entry.connection, entry.row.model, readinessInput));
    const blocking = [...readiness.flatMap(row => row.blocking), ...crossRankIssues(task, readiness)];
    if (blocking.length) return { ok: false, issues: blocking };
    const warnings = [...readiness.flatMap(row => row.warnings), ...aiTaskRankNotices(task.id, ranks, rows)];
    // 엔진 직접 계약 — 네트워크는 잠금 전에(엔진 연결·배정 저장과 같은 readback + 1토큰 시험)
    const contracts: { routeId: string; model: string; contract: Readonly<Record<string, unknown>>; key: string | null; label: string }[] = [];
    for (const [index, ready] of readiness.entries()) {
      if (!ready.createContract) continue;
      const { connection, row } = chosen[index];
      const [record] = await onPrimary(() => db.select().from(aiConnections).where(eq(aiConnections.id, connection.id)));
      const key = record ? connectionKey(record) : null;
      if (record?.apiKeyCiphertext && key === null) return { ok: false, issues: ["ai_connection_key_unreadable"] };
      const served = connection.models?.find(model => model.id === row.model);
      let probed;
      try {
        probed = await probeEngineContract({ endpoint: `${connection.baseUrl}/chat/completions`, engineModel: row.model, apiKey: key,
          maxModelLen: served?.maxModelLen ? null : connection.contextTokens }, request());
      } catch (error) {
        const reason = error instanceof Error && /^[a-z0-9_:.-]{1,80}$/.test(error.message) ? error.message : "error";
        return { ok: false, issues: [`ai_task_contract_probe_failed:${ready.createContract.routeId}:${reason}`] };
      }
      const contract = engineRouteContract(ready.createContract.routeId as GatewayServingRoute, row.model, probed.responseModel, probed.endpoint,
        probed.totalTokenBound, connection.deviceId, probed.totalTokenBoundFrom);
      if (!contract) return { ok: false, issues: [`ai_task_contract_probe_failed:${ready.createContract.routeId}:contract_schema_invalid`] };
      contracts.push({ routeId: ready.createContract.routeId, model: row.model, contract, key, label: connection.label });
    }
    const result = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_models'), hashtext(${`${task.id}#${input.slot}`}))`);
      const before = (await tx.select().from(aiTaskModels).where(and(eq(aiTaskModels.task, task.id), eq(aiTaskModels.slot, input.slot)))
        .orderBy(asc(aiTaskModels.rank))).map(rankRowOf);
      if (aiTaskSlotRevision(before) !== input.revision) fail("ai_task_revision_mismatch");
      const ids = [...new Set(chosen.map(entry => entry.connection.id))];
      const live = ids.length ? await tx.select({ id: aiConnections.id, enabled: aiConnections.enabled }).from(aiConnections).where(inArray(aiConnections.id, ids)).for("share") : [];
      if (live.length !== ids.length || live.some(row => !row.enabled)) fail("ai_connection_version_mismatch");
      const madeContracts: string[] = [];
      for (const entry of contracts) {
        const saved = await saveServingContractTx(tx, { routeId: entry.routeId, contract: entry.contract, auth: entry.key ? "stored" : "none", transport: "direct",
          apiKey: entry.key ?? undefined, note: `작업 ↔ 모델 저장(${task.label}) · 연결 ${entry.label}` }, actor);
        madeContracts.push(`${entry.routeId} · ${entry.model} (#${saved.id})`);
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
      const wantRoutes = readiness.flatMap(row => row.appendRoute ? [row.appendRoute] : []);
      let appended: readonly { routeId: string; provider: string; model: string; groupId: string }[] = [], policyRevision: number | null = null;
      if (wantRoutes.length) {
        const { appendCompatibleRoutes } = await import("@/lib/llm/capacity-repository");
        const done = await appendCompatibleRoutes(tx, wantRoutes);
        appended = done.appended; policyRevision = done.policyRevision;
      }
      await tx.delete(aiTaskModels).where(and(eq(aiTaskModels.task, task.id), eq(aiTaskModels.slot, input.slot)));
      const values = chosen.map(entry => {
        const kept = before.find(row => row.connectionId === entry.row.provider && row.model === entry.row.model);
        return { task: task.id, slot: input.slot, rank: entry.rank, connectionId: entry.row.provider, model: entry.row.model, options: { ...kept?.options ?? {} },
          enabled: true, updatedBy: actor };
      });
      const after = values.length ? (await tx.insert(aiTaskModels).values(values).returning()).map(rankRowOf).sort((a, b) => a.rank - b.rank) : [];
      const revision = aiTaskSlotRevision(after);
      const madeRoutes = appended.map(route => `${route.routeId} / ${route.provider} / ${route.model} → ${route.groupId}`);
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_TASK_MODELS_SAVE_AUDIT_ACTION, target: `${task.id}#${input.slot}`,
        detail: { task: task.id, slot: input.slot, revisionBefore: input.revision, revision, before: before.map(row => ({ ...row })), after: after.map(row => ({ ...row })),
          created: { devices: madeDevices, contracts: madeContracts, routes: madeRoutes, policyRevision }, warnings } }));
      return { revision, created: { devices: madeDevices, contracts: madeContracts, routes: madeRoutes } };
    }));
    logger.info("ai_tasks.ranks_saved", { actor, task: task.id, slot: input.slot, ranks: chosen.length, ...result.created });
    return { ok: true, revision: result.revision, warnings, created: result.created };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

// ── 가져오기 ────────────────────────────────────────────────────────────────────────────────────────────

export type AiImportServerRead = Readonly<{ baseUrl: string; host: string | null; count: number | null; error: string | null }>;
export type AiImportPreview = Readonly<{ hash: string | null; plan: AiImportPlan | null; servers: readonly AiImportServerRead[]; error: string | null;
  connectionLabels: Readonly<Record<string, string>> }>;
type BuiltImport = { plan: AiImportPlan; served: Map<string, AiConnectionModel[]>; servers: AiImportServerRead[] };

/**
 * 계획 만들기(쓰지 않는다): 지금 연결·순위·장비·정책과 현재 값(buildAiCurrentSlots)을 읽고, 아직 연결이 없는 엔진 주소마다 GET /models 를 한 번 읽는다
 * (그 목록을 새 연결에 넣고, 서버가 이름을 정하는 임베딩·재정렬의 모델 이름을 고른다). 키는 계약 스냅숏(평문, 메모리 안) 또는 env 이름에서만 온다.
 */
async function buildImport(): Promise<BuiltImport> {
  const control = await readCapacityDevicesControl().catch(() => null);
  const [connections, rows, devices, current] = await Promise.all([listAiConnections(), listAiTaskRows(), listModelCapacityDevices().catch(() => []),
    depsForTest?.current ? depsForTest.current() : readAiCurrentSources(control?.policy ?? null).then(buildAiCurrentSlots)]);
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

export async function previewAiTaskImport(): Promise<AiImportPreview> {
  try {
    const { plan, servers } = await buildImport();
    const connections = await listAiConnections();
    const connectionLabels = Object.fromEntries(plan.connections.map(row => [row.key, row.label]));
    for (const connection of connections) connectionLabels[connection.kind === "cli" ? `cli:${connection.cliTool}` : `api:${connection.baseUrl}`] ??= connection.label;
    return { hash: aiImportPlanHash(plan), plan, servers, error: null, connectionLabels };
  } catch (error) { return { hash: null, plan: null, servers: [], error: issueOf(error), connectionLabels: {} }; }
}

export type ApplyAiTaskImportResult = { ok: true; connections: number; slots: number; skipped: number; warnings: string[] } | { ok: false; issues: string[] };
/**
 * 가져오기 적용 — 계획을 다시 만들어 보여 준 hash 와 같을 때만, 한 TX 에서: 새 연결(목록·키 포함)·CLI 모델 이름 더하기·비어 있던 칸의 순위 행을 쓴다.
 * 계약·정책 route·장비는 만들지 않는다(오늘 설정을 그대로 옮기는 것이라 오늘 없는 것은 오늘도 없다 — 표의 「준비 상태」가 알린다).
 * 이미 순위가 있는 칸은 건너뛴다. 감사 한 줄(가져온 연결·칸 전부).
 */
export async function applyAiTaskImport(expectedHash: string, actor: string): Promise<ApplyAiTaskImportResult> {
  if (!validActor(actor)) return { ok: false, issues: ["invalid_actor"] };
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return { ok: false, issues: ["ai_task_import_plan_changed"] };
  try {
    const { plan, served } = await buildImport();
    if (aiImportPlanHash(plan) !== expectedHash) return { ok: false, issues: ["ai_task_import_plan_changed"] };
    const snapshot = servingContractSnapshot().rows;
    const warnings = [...plan.warnings];
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
        const plain = entry.keyFrom ? snapshot.find(row => row.routeId === entry.keyFrom!.routeId && row.model === entry.keyFrom!.model)?.apiKey ?? null
          : entry.keyEnv ? process.env[entry.keyEnv]?.trim() || null : null;
        const keyWanted = !!entry.keyFrom || !!entry.keyEnv;
        if (keyWanted && (!plain || !secretBoxReady())) warnings.push(`${entry.label}: 키를 옮기지 못했습니다(${!plain ? "키를 읽지 못함" : "암호화 설정 없음"}) — 연결에서 키를 넣으세요.`);
        const models = entry.baseUrl ? served.get(entry.baseUrl) ?? null : null;
        await tx.insert(aiConnections).values({ id, label: entry.label, kind: entry.kind, baseUrl: entry.baseUrl, cliTool: entry.cliTool, cliModels: [...entry.cliModels],
          apiKeyCiphertext: plain && secretBoxReady() ? sealSecret(plain, aiConnectionKeyAad(id)) : null, models,
          modelsReadAt: models ? new Date(now()) : null, modelsError: entry.kind === "api" && !models ? "unreachable" : null, deviceId: entry.deviceId,
          capacitySlots: entry.capacitySlots, options: {}, enabled: true, note: "지금 설정 가져오기로 만듦", updatedBy: actor });
        ids.set(entry.key, id);
        written.push({ key: entry.key, action: "create", id, label: entry.label, kind: entry.kind, baseUrl: entry.baseUrl, cliTool: entry.cliTool,
          cliModels: [...entry.cliModels], deviceId: entry.deviceId, capacitySlots: entry.capacitySlots, keyMoved: !!plain && secretBoxReady(), models: models?.length ?? null });
      }
      const slots: Record<string, unknown>[] = [];
      let skipped = 0;
      for (const slot of plan.slots) {
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
    logger.info("ai_tasks.import_applied", { actor, ...result });
    return { ok: true, ...result, warnings };
  } catch (error) { return { ok: false, issues: [issueOf(error)] }; }
}

/** 화면 줄 이름(감사 target `task#slot` → 「2차 AI 검수 · 투표자 1」). */
export function aiTaskTargetLabel(target: string): string {
  const [id, slot] = target.split("#");
  const task = aiTask(id);
  return task ? aiTaskSlotLabel(task, Number(slot) || 1) : target;
}
export type { AiRankChoice };
