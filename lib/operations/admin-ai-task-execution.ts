import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { aiConnections, aiTaskExecutionConfigs, aiTaskPoolMembers, aiTaskModels, operationsAudit } from "@/lib/db/schema";
import { aiTask, aiTaskAccepts, aiTaskSlots } from "@/lib/llm/ai-tasks";
import { aiTaskExecutionInputSchema, aiTaskWorkloadPoolApiOnly, AI_TASK_EXECUTION_SAVE_AUDIT_ACTION, type AiTaskExecutionInput } from "@/lib/llm/ai-task-execution-config";
import { taskPoolEngineKey } from "@/lib/llm/ai-task-pool-identity";
import { aiTaskUsesCliEngine } from "@/lib/llm/cli-engine-config";
import { aiConnectionKeyAad, aiTaskConnectionModelIds, aiRankReasoningEfforts, aiRanksReadiness } from "./admin-ai-tasks";
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
      updatedAt: config?.updatedAt.toISOString() ?? null, members: stored.members.filter(row => row.task === task.id && row.slot === slot)
        .map(row => ({ memberId: row.memberId, position: row.position, connectionId: row.connectionId, model: row.model,
          options: row.options, canonicalModel: row.canonicalModel, deviceId: row.deviceId, engineKey: row.engineKey })) };
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

/** Separate pool CAS; existing fallback rank rows and all in-flight request/dispatch bindings are untouched. */
export async function saveAiTaskExecutionConfig(input: unknown, actor: string): Promise<SaveAiTaskExecutionResult> {
  if (typeof actor !== "string" || !actor.trim() || actor.length > 120) return { ok: false, issues: ["invalid_actor"] };
  const parsed = aiTaskExecutionInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: [...new Set(parsed.error.issues.map(issue =>
    /^[a-z_]{1,80}$/.test(issue.message) ? issue.message : "ai_task_execution_invalid_input"))] };
  const value: AiTaskExecutionInput = parsed.data, task = aiTask(value.task)!;
  try {
    if (value.mode === "workload_pool" && (!task.routeId || task.wiring === "deferred" || task.id === "grok-session-check"))
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
        canonicalModel, deviceId: connection.deviceId, engineKey: taskPoolEngineKey(connection, canonicalModel) };
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
    const warnings = readiness.flatMap(row => row.warnings);
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
      await tx.insert(aiTaskExecutionConfigs).values({ task: task.id, slot: value.slot, mode: value.mode, revision, updatedBy: actor })
        .onConflictDoUpdate({ target: [aiTaskExecutionConfigs.task, aiTaskExecutionConfigs.slot],
          set: { mode: value.mode, revision, updatedBy: actor, updatedAt: sql`clock_timestamp()` } });
      if (value.mode === "workload_pool") {
        await tx.delete(aiTaskPoolMembers).where(ownMembers(task.id, value.slot));
        if (members.length) await tx.insert(aiTaskPoolMembers).values(members);
      } // Switching to fallback keeps the saved inactive pool; execution reads only the existing ranks.
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AI_TASK_EXECUTION_SAVE_AUDIT_ACTION, target: `${task.id}#${value.slot}`,
        detail: { task: task.id, slot: value.slot, revisionBefore: value.expectedRevision, revision, modeBefore: before.mode, mode: value.mode,
          before: before.members, after: value.mode === "fallback" ? before.members : members, created, warnings, activeBindingsChanged: false } }));
      return { revision, created: { devices: created.devices, contracts: created.contracts, routes: created.routes } };
    }));
    await ensureAiTaskExecutionConfigs(0);
    return { ok: true, ...saved, warnings };
  } catch (error) { return { ok: false, issues: [safeIssue(error)] }; }
}
