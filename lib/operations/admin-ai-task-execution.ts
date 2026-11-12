import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { aiConnections, aiTaskExecutionConfigs, aiTaskPoolMembers, aiTaskModels, operationsAudit } from "@/lib/db/schema";
import { aiConnectionTaskAllowed, aiTask, aiTaskAccepts, aiTaskSlots } from "@/lib/llm/ai-tasks";
import { aiTaskExecutionInputSchema, aiTaskPoolFeatures, aiTaskWorkloadPoolApiOnly, AI_TASK_EXECUTION_SAVE_AUDIT_ACTION, type AiTaskExecutionInput } from "@/lib/llm/ai-task-execution-config";
import { taskPoolEngineKey } from "@/lib/llm/ai-task-pool-identity";
import { aiTaskUsesCliEngine } from "@/lib/llm/cli-engine-config";
import { aiConnectionKeyAad, aiConnectionManualOnly, aiTaskConnectionModelIds, aiRankReasoningEfforts, aiRanksReadiness } from "./admin-ai-tasks";
import { aiTaskCrossResourceIssues, listAiConnections, prepareAiTaskServingResources,
  readAiTaskReadinessInput, saveAiTaskServingResources } from "./admin-ai-tasks-repository";
import { readAdminCliCatalog } from "./admin-cli-catalog";
import { readbackServingEndpoint } from "./admin-serving-contracts";
import { adminAuditRow } from "./admin-log";
import { openSecret } from "@/lib/security/secret-box";
import { DrWriterFencedError, writerSiteActive } from "./dr/epoch";
import { ensureAiTaskExecutionConfigs } from "@/lib/llm/ai-task-execution-snapshot";

const fail = (code: string): never => { throw new Error(code); };
const own = (task: string, slot: number) => and(eq(aiTaskExecutionConfigs.task, task), eq(aiTaskExecutionConfigs.slot, slot));
const ownMembers = (task: string, slot: number) => and(eq(aiTaskPoolMembers.task, task), eq(aiTaskPoolMembers.slot, slot));
async function otherAi2SlotsConfigured(tx: ProductTransaction): Promise<boolean> {
  const [ranks] = await tx.select({ id: aiTaskModels.id }).from(aiTaskModels)
    .where(and(eq(aiTaskModels.task, "second-review"), gt(aiTaskModels.slot, 1))).limit(1);
  const [pools] = await tx.select({ slot: aiTaskExecutionConfigs.slot }).from(aiTaskExecutionConfigs)
    .where(and(eq(aiTaskExecutionConfigs.task, "second-review"), gt(aiTaskExecutionConfigs.slot, 1), eq(aiTaskExecutionConfigs.mode, "workload_pool"))).limit(1);
  return Boolean(ranks || pools);
}
export type AiTaskPoolMemberView = Readonly<Omit<typeof aiTaskPoolMembers.$inferSelect, "task" | "slot">>;
export type AiTaskExecutionAdminView = Readonly<{
  task: string; slot: number; mode: "fallback" | "workload_pool"; revision: number | null; updatedAt: string | null;
  /** Inactive saved members are retained when mode is fallback. No connection credentials are included. */
  members: readonly AiTaskPoolMemberView[];
  /** 묶음이 모두 설 때 순위를 예비로 쓴다(0179) */
  reserveRanks: boolean;
}>;
/** UI-safe batch: two table reads in one primary snapshot for all task/slots. Reuse the existing admin connections DTO. */
export async function readAiTaskExecutionAdminViews(): Promise<readonly AiTaskExecutionAdminView[]> {
  const stored = await onPrimary(() => db.transaction(async tx => {
    const configs = await tx.select().from(aiTaskExecutionConfigs);
    const members = await tx.select().from(aiTaskPoolMembers).orderBy(asc(aiTaskPoolMembers.position));
    return { configs, members };
  }, { accessMode: "read only", isolationLevel: "repeatable read" }));
  return aiTaskSlots().map<AiTaskExecutionAdminView>(({ task, slot }) => {
    const config = stored.configs.find(row => row.task === task.id && row.slot === slot);
    return { task: task.id, slot, mode: config?.mode ?? "fallback", revision: config?.revision ?? null,
      updatedAt: config?.updatedAt.toISOString() ?? null, reserveRanks: config?.reserveRanks ?? false,
      members: stored.members.filter(row => row.task === task.id && row.slot === slot)
        .map(row => ({ memberId: row.memberId, position: row.position, connectionId: row.connectionId, model: row.model,
          options: row.options, canonicalModel: row.canonicalModel, deviceId: row.deviceId, engineKey: row.engineKey, maxSlots: row.maxSlots ?? null })) };
  });
}
/** Save/read one line; pages should call the batch once instead of this per slot. */
export async function readAiTaskExecutionAdminView(taskId: string, slot = 1): Promise<AiTaskExecutionAdminView> {
  const found = (await readAiTaskExecutionAdminViews()).find(row => row.task === taskId && row.slot === slot);
  if (!found) fail("ai_task_execution_invalid_task_slot");
  return found!;
}

function safeIssue(error: unknown): string {
  if (error instanceof DrWriterFencedError) return "site_fenced";
  const value = error instanceof Error ? error.message : "";
  if (/^[a-z0-9_:./-]{1,160}$/.test(value)) return value;
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : error;
  const code = (cause as { code?: unknown } | null)?.code;
  return code === "23505" ? "ai_task_execution_revision_mismatch" : code === "23503" ? "ai_connection_in_use" : "ai_task_execution_save_failed";
}
export type SaveAiTaskExecutionResult = { ok: true; revision: number; warnings: string[];
  created: { devices: string[]; contracts: string[]; routes: string[] } } | { ok: false; issues: string[] };

/**
 * 같은 엔진(같은 주소·같은 canonical 모델 — engine_key)을 두 자리에 넣은 구성원 알림(2026-11-12 검토). 저장은 막지 않는다(0167 반복 선택은 소유자가 연 기능).
 * 한 엔진은 장비 한도·모델 상한·장부 줄을 함께 쓰므로 자리를 늘려도 동시에 도는 수는 늘지 않고 고르기 몫만 커진다 — 실행 쪽은 한 자리가 서면 같은 엔진의 자리를 함께 쉬게 한다.
 */
export function repeatedPoolMemberWarnings(members: readonly { position: number; engineKey: string; model: string; options: Readonly<Record<string, unknown>> }[],
  taskId: string, slot: number): string[] {
  const warnings: string[] = [], seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.engineKey)) continue;
    const same = members.filter(other => other.engineKey === member.engineKey);
    if (same.length < 2) continue;
    seen.add(member.engineKey);
    warnings.push(`${same.map(row => row.position).join("·")}번째 모델(${member.model})이 같은 연결·같은 엔진입니다 — 장비 한도는 하나라 동시에 도는 수는 늘지 않고 `
      + `고르는 몫만 커집니다(한 자리가 포화·실패로 쉬면 같은 엔진의 다른 자리도 함께 쉽니다). ${aiTaskPoolFeatures(taskId, slot).slotCaps
        ? "더 많이 돌리려면 한 자리만 두고 칸 수를 늘리세요." : "한 자리만 두는 것을 권합니다."}`);
  }
  return warnings;
}

/** Separate pool CAS; existing fallback rank rows and all in-flight request/dispatch bindings are untouched. */
export async function saveAiTaskExecutionConfig(input: unknown, actor: string): Promise<SaveAiTaskExecutionResult> {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  const parsed = aiTaskExecutionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: [...new Set(parsed.error.issues.map(issue =>
    /^[a-z_]{1,80}$/.test(issue.message) ? issue.message : "ai_task_execution_invalid_input"))] };
  const value: AiTaskExecutionInput = parsed.data, task = aiTask(value.task)!;
  try {
    // 「발행분 감사 · 변경 재판정」(audit-direct)은 두 잡이 순위 차례로 나눠 묻는다 — 작업 분산 실행이 없다
    if (value.mode === "workload_pool" && (!task.routeId || task.wiring === "deferred" || task.wiring === "audit-direct" || task.id === "grok-session-check"))
      fail("ai_task_pool_route_not_supported");
    const [before, storedConnections] = await Promise.all([readAiTaskExecutionAdminView(value.task, value.slot), listAiConnections()]);
    if (before.revision !== value.expectedRevision) fail("ai_task_execution_revision_mismatch");
    // Refuse a known incompatible vote layout before catalog/probe work; repeat under the shared lock below.
    if (task.id === "second-review" && value.mode === "workload_pool"
      && await onPrimary(() => db.transaction(otherAi2SlotsConfigured, { accessMode: "read only" })))
      fail("ai_task_pool_ai2_other_slots_configured");
    let connections = [...storedConnections];
    const ids = [...new Set(value.members.map(member => member.connectionId))];
    const records = ids.length ? await onPrimary(() => db.select().from(aiConnections).where(inArray(aiConnections.id, ids))) : [];
    for (const id of ids) {
      const connection = connections.find(row => row.id === id);
      if (!connection) return { ok: false, issues: ["ai_task_pool_connection_unsupported"] };
      const record = records.find(row => row.id === id);
      if (!record) return { ok: false, issues: ["ai_connection_version_mismatch"] };
      if (Number(record.version) !== connection.version) fail("ai_connection_version_mismatch");
      const cliEngine = aiTaskUsesCliEngine(task.id, connection);
      if (!connection.enabled || !record.enabled
        || !(connection.kind === "api" || cliEngine || (!aiTaskWorkloadPoolApiOnly(task.id) && aiTaskAccepts(task, connection))))
        fail("ai_task_pool_connection_unsupported");
      // 연결의 「쓸 수 있는 작업」(2026-11-10) — 예: 비상업 전용 API 를 심사 사유 번역에만 묶은 연결은 다른 작업의 분산에 넣지 않는다
      if (!aiConnectionTaskAllowed(task.id, connection)) fail("ai_task_pool_connection_restricted");
      if (connection.cliTool === "opencode") {
        const catalog = await readAdminCliCatalog({ fresh: true, connectionId: id });
        connections = connections.map(row => row.id === id ? { ...row, cliVersion: catalog.cliVersion, cliCatalog: catalog } : row);
      }
    }
    const canonical = new Map<string, string>(), endpointModels = new Map<string, Set<string>>();
    for (const member of value.members) {
      const connection = connections.find(row => row.id === member.connectionId)!;
      if (!aiTaskConnectionModelIds(task, connection).includes(member.model)) fail("ai_task_pool_model_not_offered");
      if (member.reasoningEffort && !aiRankReasoningEfforts(task.id, connection, member.model).includes(member.reasoningEffort))
        fail("ai_task_pool_reasoning_unsupported");
      if (connection.kind === "api") {
        const models = endpointModels.get(connection.baseUrl!) ?? new Set<string>();
        models.add(member.model); endpointModels.set(connection.baseUrl!, models);
      }
    }
    const catalogs = new Map<string, Awaited<ReturnType<typeof readbackServingEndpoint>>>();
    for (const member of value.members) {
      const connection = connections.find(row => row.id === member.connectionId)!;
      if (connection.kind === "cli") { canonical.set(member.connectionId + "\n" + member.model, member.model); continue; }
      const record = records.find(row => row.id === member.connectionId)!;
      const key = record.apiKeyCiphertext ? openSecret(record.apiKeyCiphertext, aiConnectionKeyAad(record.id)) : null;
      if (record.apiKeyCiphertext && key === null) fail("ai_connection_key_unreadable");
      // 목록(/models)이 없는 서버에 적은 모델(2026-11-10): 대조할 목록이 없다 — 엔진 이름이 곧 canonical 이고, 계약은 아래 준비가 1토큰 시험으로 확인해 만든다.
      // 같은 주소에 모델이 둘 이상이면 같은 엔진인지 가를 근거(root)가 없어 예전처럼 거절한다
      if (aiConnectionManualOnly(connection, member.model)) {
        if ((endpointModels.get(connection.baseUrl!)?.size ?? 0) > 1) fail("ai_task_pool_engine_identity_unconfirmed");
        canonical.set(member.connectionId + "\n" + member.model, member.model);
        continue;
      }
      if (!catalogs.has(connection.id)) catalogs.set(connection.id,
        await readbackServingEndpoint(`${connection.baseUrl}/chat/completions`, key));
      const catalog = catalogs.get(connection.id)!;
      if (!catalog.ok) fail("ai_task_pool_catalog_unavailable");
      if (!catalog.ok) continue;
      const offered = catalog.models.find(row => row.id === member.model);
      if (!offered) fail("ai_task_pool_model_not_offered");
      // Two model IDs at one endpoint require actual root metadata to distinguish engines from aliases.
      if ((endpointModels.get(connection.baseUrl!)?.size ?? 0) > 1 && !offered!.canonicalModel) fail("ai_task_pool_engine_identity_unconfirmed");
      canonical.set(member.connectionId + "\n" + member.model, offered!.canonicalModel ?? member.model);
    }
    const members = value.members.map((member, index) => {
      const connection = connections.find(row => row.id === member.connectionId)!;
      const canonicalModel = canonical.get(member.connectionId + "\n" + member.model)!;
      const previous = before.members.find(row => row.memberId === member.memberId);
      if (member.memberId && (!previous || previous.connectionId !== member.connectionId || previous.model !== member.model))
        fail("ai_task_pool_member_identity_mismatch");
      return { memberId: member.memberId ?? randomUUID(), task: task.id, slot: value.slot, position: index + 1,
        connectionId: member.connectionId, model: member.model, options: member.reasoningEffort ? { reasoningEffort: member.reasoningEffort } : {},
        canonicalModel, deviceId: connection.deviceId, engineKey: taskPoolEngineKey(connection, canonicalModel),
        // 0179: 이 단계에 내줄 칸 수 — 비우면 정하지 않음(예전 작업 분산)
        maxSlots: member.maxSlots ?? null };
    });
    if (new Set(members.map(member => member.memberId)).size !== members.length) fail("ai_task_pool_member_identity_mismatch");
    // Review resumes identify provider/model, not a pool member. Identical CLI entries must therefore have identical options.
    for (const member of members) {
      const connection = connections.find(row => row.id === member.connectionId)!;
      if (connection.kind === "cli" && members.some(other => other.connectionId === member.connectionId && other.model === member.model
        && other.options.reasoningEffort !== member.options.reasoningEffort)) fail("ai_task_pool_repeated_model_options_mismatch");
    }
    // Repeated members have independent work IDs, but one actual engine must still share one device budget.
    for (const member of members) if (members.some(other => other.engineKey === member.engineKey && other.deviceId !== member.deviceId))
      fail("ai_task_pool_engine_device_mismatch");
    const cliIdentities = new Map<string, Set<string>>();
    for (const member of members) {
      const connection = connections.find(row => row.id === member.connectionId)!;
      if (connection.kind !== "cli") continue;
      const identity = `${connection.cliTool}:${member.model}`, ids = cliIdentities.get(identity) ?? new Set<string>();
      ids.add(member.connectionId); cliIdentities.set(identity, ids);
    }
    if ([...cliIdentities.values()].some(ids => ids.size > 1)) fail("ai_task_pool_cli_connection_ambiguous");
    const chosen = members.map(member => ({ rank: member.position,
      row: { provider: member.connectionId, model: member.model, ...(typeof member.options.reasoningEffort === "string" ? { reasoningEffort: member.options.reasoningEffort } : {}) },
      connection: connections.find(row => row.id === member.connectionId)! }));
    // OpenCode 구성원의 연결 버전은 위에서 호스트에서 방금 읽은 값이다(기록된 옛 버전이 아니다)
    const readinessInput = { ...await readAiTaskReadinessInput(),
      hostCliVersions: new Set(ids.filter(id => connections.find(row => row.id === id)?.cliTool === "opencode")) };
    const readiness = aiRanksReadiness(task, chosen.map(entry => ({ rank: entry.rank, connection: entry.connection, model: entry.row.model,
      ...(typeof entry.row.reasoningEffort === "string" ? { reasoningEffort: entry.row.reasoningEffort } : {}) })), readinessInput);
    const blocking = [...readiness.flatMap(row => row.blocking), ...aiTaskCrossResourceIssues(task, readiness)];
    if (blocking.length) return { ok: false, issues: blocking };
    const resources = await prepareAiTaskServingResources(task, chosen, readiness);
    if (!resources.ok) return resources;
    const warnings = [...readiness.flatMap(row => row.warnings), ...(value.mode === "workload_pool" ? repeatedPoolMemberWarnings(members, task.id, value.slot) : [])];
    const saved = await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) throw new DrWriterFencedError("site_fenced");
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_execution_task'),hashtext(${task.id}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai_task_execution_configs'),hashtext(${`${task.id}#${value.slot}`}))`);
      if (task.id === "second-review" && value.mode === "workload_pool") {
        if (value.slot !== 1) fail("ai_task_pool_ai2_single_slot_only");
        if (await otherAi2SlotsConfigured(tx)) fail("ai_task_pool_ai2_other_slots_configured");
      }
      const [liveConfig] = await tx.select().from(aiTaskExecutionConfigs).where(own(task.id, value.slot)).for("update");
      if ((liveConfig?.revision ?? null) !== value.expectedRevision) fail("ai_task_execution_revision_mismatch");
      const revision = (liveConfig?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) fail("ai_task_execution_revision_exhausted");
      const live = ids.length ? await tx.select().from(aiConnections).where(inArray(aiConnections.id, ids)).for("share") : [];
      if (live.length !== records.length || live.some(row => !row.enabled || row.version !== records.find(old => old.id === row.id)?.version))
        fail("ai_connection_version_mismatch");
      const created = await saveAiTaskServingResources(tx, task, readiness, resources, actor);
      // 예비(0179)는 「동시에」로 저장할 때만 바꾼다 — 순위대로로 돌릴 때는 보관된 구성원처럼 그대로 둔다(실행 쪽은 순위대로에서 읽지 않는다)
      const reserve = value.mode === "workload_pool" ? { reserveRanks: value.reserveRanks === true } : {};
      await tx.insert(aiTaskExecutionConfigs).values({ task: task.id, slot: value.slot, mode: value.mode, revision, updatedBy: actor, ...reserve })
        .onConflictDoUpdate({ target: [aiTaskExecutionConfigs.task, aiTaskExecutionConfigs.slot],
          set: { mode: value.mode, revision, updatedBy: actor, updatedAt: sql`clock_timestamp()`, ...reserve } });
      if (value.mode === "workload_pool") {
        await tx.delete(aiTaskPoolMembers).where(ownMembers(task.id, value.slot));
        if (members.length) await tx.insert(aiTaskPoolMembers).values(members);
      } // Switching to fallback keeps the saved inactive pool; execution reads only the existing ranks.
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_TASK_EXECUTION_SAVE_AUDIT_ACTION, target: `${task.id}#${value.slot}`,
        detail: { task: task.id, slot: value.slot, revisionBefore: value.expectedRevision, revision, modeBefore: before.mode, mode: value.mode,
          reserveRanksBefore: before.reserveRanks, reserveRanks: value.mode === "workload_pool" ? value.reserveRanks === true : before.reserveRanks,
          before: before.members, after: value.mode === "fallback" ? before.members : members, created, warnings, activeBindingsChanged: false } }));
      return { revision, created: { devices: created.devices, contracts: created.contracts, routes: created.routes } };
    }));
    await ensureAiTaskExecutionConfigs(0);
    return { ok: true, ...saved, warnings };
  } catch (error) { return { ok: false, issues: [safeIssue(error)] }; }
}
