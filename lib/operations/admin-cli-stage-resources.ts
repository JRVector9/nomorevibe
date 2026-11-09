import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { aiConnections, modelCapacityControl, modelCapacityDevices, modelServingContracts, operationsAudit } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { assistWorkTaskSchema, isAuditAssistTask } from '@/lib/domain/llm-assist/work';
import type { AdminStagePools } from '@/lib/llm/admin-model-stages';
import { ensureAiTaskModels } from '@/lib/llm/ai-task-models-snapshot';
import { parseModelCapacityPolicy } from '@/lib/llm/capacity';
import { appendCompatibleRoutes, type NewModelCapacityRoute } from '@/lib/llm/capacity-repository';
import { cliDbContract } from '@/lib/llm/cli-db-contracts';
import { cliEngineEndpoint, cliEngineRevision } from '@/lib/llm/cli-engine-config';
import { cliContractRouteId, cliServingContractHash, type CliServingContract } from '@/lib/llm/cli-serving-contract';
import { localModelContractRouteId } from '@/lib/llm/local-model-contract-table';
import { localModelContractHash, localModelServingContractSchema, type LocalModelServingContract } from '@/lib/llm/local-model-serving-contract';
import { readModelRegistry, type ModelDefinition } from '@/lib/llm/model-registry';
import { ensureServingContracts } from '@/lib/llm/serving-contract-store';
import { openSecret } from '@/lib/security/secret-box';
import { aiConnectionKeyAad } from './admin-ai-tasks';
import { readAdminCliCatalog } from './admin-cli-catalog';
import { adminAuditRow } from './admin-log';
import { saveCliServingContractTx } from './admin-serving-contracts';
import { validateCliHostTarget } from './cli-host-target';
import { writerSiteActive } from './dr/epoch';

type Result = { ok: true } | { ok: false; issues: string[] };
type Connection = typeof aiConnections.$inferSelect;
type Selected = { stage: string; model: ModelDefinition };
type Prepared = { connection: Connection; stage: string; contract: LocalModelServingContract | CliServingContract; kind: 'local' | 'native'; routes: string[] };
function fail(issue: string): never { throw new Error(issue); }
const routesByStage: Readonly<Record<string, readonly string[]>> = {
  'human-review': ['local-human-deepseek'], 'split-confirm': ['local-deepseek-confirm'],
  'split-tiebreak': ['local-qwen-tiebreak'], 'held-review-retry': ['local-held-qwen'],
  'audit-review': ['local-audit'], 'audit-second-opinion': ['local-second-opinion'],
  'published-filter': ['local-published-filter'], 'screen-review': ['local-screen'],
  'direct-review': ['local-qwen-tiebreak', 'local-held-qwen', 'local-audit', 'local-second-opinion', 'local-published-filter'],
};
const drainSchema = z.array(z.object({ backendId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  tasks: z.array(assistWorkTaskSchema).min(1).max(8), maxClaims: z.number().int().min(1).max(4) }).strict()).max(4);
function assistRoutes(stage: string, backendId: string): string[] {
  if (!process.env.LLM_ASSIST_BACKENDS) fail('cli_stage_assist_tasks_missing');
  const drains = drainSchema.parse(JSON.parse(process.env.LLM_ASSIST_BACKENDS));
  const tasks = [...new Set(drains.flatMap(drain => drain.tasks))]
    .filter(task => stage === 'assist-audit' ? isAuditAssistTask(task) : !isAuditAssistTask(task));
  if (!tasks.length) fail('cli_stage_assist_tasks_missing');
  return tasks.map(task => `local-assist-${task}-${backendId}`);
}

/**
 * Retain the contract history and audit format; CLI credentials remain in ai_connections. 「작업 ↔ 모델」 순위 저장(감사 직접 경로 로컬 계약)도 같은 함수로 쓴다 —
 * 같은 계약이 이미 켜져 있으면 null(아무것도 쓰지 않음), 아니면 새 행.
 */
export async function saveLocalContract(tx: ProductTransaction, contract: LocalModelServingContract, actor: string,
  note = '단계별 CLI 모델 설정'): Promise<{ id: number; routeId: string } | null> {
  const routeId = localModelContractRouteId(contract.backendId, contract.deploymentRevision);
  if (routeId.length > 64) fail('cli_stage_contract_identity_invalid');
  const contractHash = localModelContractHash(contract);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('model_serving_contracts'), hashtext(${routeId + ':' + contract.model}))`);
  const [previous] = await tx.select().from(modelServingContracts).where(and(eq(modelServingContracts.routeId, routeId),
    eq(modelServingContracts.model, contract.model), eq(modelServingContracts.enabled, true))).for('update');
  if (previous?.contractHash === contractHash && previous.transport === 'direct' && previous.auth === 'none') return null;
  if (previous) await tx.update(modelServingContracts).set({ enabled: false, updatedBy: actor, updatedAt: new Date() }).where(eq(modelServingContracts.id, previous.id));
  const [saved] = await tx.insert(modelServingContracts).values({ routeId, model: contract.model, contract: { ...contract, routeId }, contractHash,
    auth: 'none', transport: 'direct', apiKeyCiphertext: null, enabled: true, updatedBy: actor, note }).returning({ id: modelServingContracts.id });
  await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: 'model-serving-contract-save', target: `${routeId}:${contract.model}`,
    detail: { id: saved.id, previousId: previous?.id ?? null, contractHash, previousHash: previous?.contractHash ?? null,
      auth: 'none', transport: 'direct', keyChanged: false, endpoint: contract.endpoint, protocol: contract.protocol, note } }));
  return { id: saved.id, routeId };
}

/** Prepare only explicitly selected CLI sources; metadata checks never run model inference. */
export async function ensureCliStageModelResources(pools: AdminStagePools, actor: string): Promise<Result> {
  try {
    if (!actor.trim() || actor.length > 120) fail('invalid_actor');
    const registry = readModelRegistry();
    const selected: Selected[] = [];
    for (const [stage, keys] of Object.entries(pools)) for (const key of keys ?? []) {
      const model = registry.models.find(entry => entry.key === key);
      if (!model) continue; // Table-authoritative stages may retain an unused, retired pool key.
      if (model.cliEngine) selected.push({ stage, model });
    }
    if (!selected.length) return { ok: true };
    const ids = [...new Set(selected.map(entry => entry.model.cliEngine!.connectionId))].sort();
    const records = await onPrimary(() => db.select().from(aiConnections).where(inArray(aiConnections.id, ids)).orderBy(asc(aiConnections.id)));
    const prepared: Prepared[] = [];
    for (const id of ids) {
      const record = records.find(row => row.id === id);
      if (!record || !record.enabled || record.kind !== 'cli' || record.cliTool !== 'opencode' || !record.baseUrl) fail('cli_stage_connection_not_ready');
      const apiKey = record.apiKeyCiphertext ? openSecret(record.apiKeyCiphertext, aiConnectionKeyAad(record.id)) : null;
      if (!apiKey) fail('cli_stage_key_not_ready');
      validateCliHostTarget({ connectionId: record.id, baseUrl: record.baseUrl, apiKey });
      const catalog = await readAdminCliCatalog({ fresh: true, connectionId: id });
      for (const entry of selected.filter(row => row.model.cliEngine!.connectionId === id)) {
        const source = entry.model.cliEngine!;
        const actual = catalog.models.find(model => model.id === entry.model.model);
        if (!record.cliModels.includes(entry.model.model) || !actual || (source.reasoningEffort && !actual.variants.includes(source.reasoningEffort))) fail('cli_stage_catalog_changed');
        if (entry.model.equipment !== record.deviceId || entry.model.baseUrl !== record.baseUrl.replace(/\/$/, '')) fail('cli_stage_connection_changed');
        if (entry.stage === 'product-intro-check') {
          if (entry.model.provider !== 'opencode-cli' || !entry.model.purposes.includes('product-intro-check')) fail('cli_stage_adapter_unsupported');
          const contract = cliDbContract('product-intro-check', 'opencode-cli', entry.model.model, catalog.cliVersion);
          if (!contract) fail('cli_stage_contract_invalid');
          prepared.push({ connection: record, stage: entry.stage, contract, kind: 'native', routes: ['product-intro-check'] });
          continue;
        }
        if (entry.model.provider !== 'local-direct' || !(entry.stage in routesByStage || entry.stage === 'assist-primary' || entry.stage === 'assist-audit')) fail('cli_stage_adapter_unsupported');
        if ((entry.stage === 'screen-review' && actual.vision !== true)
          || ((entry.stage === 'assist-primary' || entry.stage === 'assist-audit') && !entry.model.purposes.includes(entry.stage))) fail('cli_stage_capability_missing');
        const context = actual.maxModelLen;
        if (context === null || !Number.isSafeInteger(context) || context <= 0 || context > 1_048_576) fail('cli_stage_context_not_ready');
        // 35-char backend + variant suffix stays within model_serving_contracts.route_id(64).
        const backendId = 'cli-' + createHash('sha256').update(record.id + '\n' + entry.model.model).digest('hex').slice(0, 31);
        const contract = localModelServingContractSchema.parse({ version: 1, protocol: 'local-openai-chat-v1', backendId,
          provider: 'local-direct', physicalGroup: record.deviceId, endpoint: cliEngineEndpoint(record.baseUrl), model: entry.model.model,
          responseModel: entry.model.model, modelFamily: entry.model.family, deploymentRevision: cliEngineRevision(source),
          contextWindowTokens: context, totalTokenBound: context, maxOutputTokens: Math.min(entry.model.maxTokens, context, 262_144), maxInputBytes: 16 * 1024 * 1024,
          capabilities: { vision: actual.vision === true, jsonSchema: true },
          thinking: { mode: 'cli-variant', parameter: 'reasoning_effort', ...(source.reasoningEffort ? { effort: source.reasoningEffort } : {}) }, termination: { kind: 'response_only' } });
        const routes = entry.stage.startsWith('assist-') ? assistRoutes(entry.stage, backendId) : [...routesByStage[entry.stage]];
        prepared.push({ connection: record, stage: entry.stage, contract, kind: 'local', routes });
      }
    }
    await onPrimary(() => db.transaction(async tx => {
      if (!await writerSiteActive(tx)) fail('site_fenced');
      const [control] = await tx.select().from(modelCapacityControl).where(eq(modelCapacityControl.id, 1)).for('update');
      if (!control) fail('cli_stage_capacity_not_ready');
      const policy = parseModelCapacityPolicy(control.policy);
      const current = await tx.select().from(aiConnections).where(inArray(aiConnections.id, ids)).orderBy(asc(aiConnections.id)).for('share');
      for (const record of records) {
        const live = current.find(row => row.id === record.id);
        if (!live || !live.enabled || live.kind !== 'cli' || live.cliTool !== 'opencode' || Number(live.version) !== Number(record.version)
          || live.baseUrl !== record.baseUrl || live.deviceId !== record.deviceId || live.apiKeyCiphertext !== record.apiKeyCiphertext
          || JSON.stringify(live.cliModels) !== JSON.stringify(record.cliModels)) fail('cli_stage_connection_changed');
      }
      const deviceIds = [...new Set(prepared.map(entry => entry.connection.deviceId))].sort();
      const devices = await tx.select().from(modelCapacityDevices).where(inArray(modelCapacityDevices.deviceId, deviceIds)).orderBy(asc(modelCapacityDevices.deviceId)).for('share');
      for (const entry of prepared) {
        const device = devices.find(row => row.deviceId === entry.connection.deviceId);
        if (!device?.enabled || (entry.kind === 'local' && (!device.physicalLimit || device.physicalLimit < 1))) fail('cli_stage_device_not_ready');
      }
      const routes: NewModelCapacityRoute[] = [];
      for (const entry of prepared) {
        if (entry.kind === 'local') {
          const contract = localModelServingContractSchema.parse(entry.contract);
          await saveLocalContract(tx, contract, actor);
          for (const routeId of entry.routes) routes.push({ routeId, provider: 'local-direct', model: contract.model,
            providerBudgetId: contract.backendId, groupId: contract.physicalGroup });
        } else {
          const contract = entry.contract as CliServingContract;
          const routeId = cliContractRouteId(contract.provider, contract.routeId);
          const hash = cliServingContractHash(contract);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('model_serving_contracts'), hashtext(${routeId + ':' + contract.model}))`);
          const [old] = await tx.select().from(modelServingContracts).where(and(eq(modelServingContracts.routeId, routeId),
            eq(modelServingContracts.model, contract.model), eq(modelServingContracts.enabled, true))).for('update');
          if (old?.contractHash !== hash || old.transport !== 'direct' || old.auth !== 'none') await saveCliServingContractTx(tx, { contract, note: '소개 검수 CLI 모델 설정' }, actor);
          const budget = policy.routes.find(route => route.groupId === entry.connection.deviceId)?.providerBudgetId ?? entry.connection.deviceId;
          for (const target of entry.routes) routes.push({ routeId: target, provider: 'opencode-cli', model: contract.model, providerBudgetId: budget, groupId: entry.connection.deviceId });
        }
      }
      await appendCompatibleRoutes(tx, routes);
    }));
    await Promise.all([ensureServingContracts(0), ensureAiTaskModels(0)]);
    return { ok: true };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { ok: false, issues: [/^[a-z0-9_:./-]{1,160}$/.test(code) ? code : 'cli_stage_save_failed'] };
  }
}
