import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getSettings } from '@/lib/crawl/settings';
import { ADMIN_MODEL_STAGES, type AdminModelStage, type AdminStagePools } from '@/lib/llm/admin-model-stages';
import { tableStageSelections, validateAdminStagePools, withAdminModelStage, withAdminStagePools } from '@/lib/llm/admin-model-pools';
import { modelBaseUrl, modelForPurpose, modelRequestName, readModelRegistry, type ModelDefinition, type ModelEnvironment, type ModelRegistry } from '@/lib/llm/model-registry';
import { stageTableRows } from '@/lib/llm/stage-assignments';
import { servingContractsDbEnabled } from '@/lib/llm/serving-contract-store';
import { assignmentReadFlag, liveAssignmentRows, requireStageAssignments } from '@/lib/llm/stage-assignment-snapshot';
import type { ModelAssignmentRow } from '@/lib/llm/capacity-helpers';
import type { AssignmentFormOptions } from '@/lib/operations/admin-model-assignments';
import { MODEL_ASSIGNMENT_TABLE_ENV, parseAssignmentTableOverride } from '@/lib/llm/assignment-flag';
import { runtimeSettings } from '@/lib/db/operations-schema';
import { resolveRuntimeSettings } from './runtime-settings-schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';

export const HUMAN_MODEL_STAGES: readonly AdminModelStage[] = Object.freeze([
  'human-review', 'split-confirm', 'split-tiebreak', 'held-review-retry',
]);

const HUMAN_REVIEW_STAGE = ADMIN_MODEL_STAGES.find(stage => stage.id === 'human-review')!;
type Settings = Awaited<ReturnType<typeof getSettings>>;
export type HumanModelSourceKind = 'table' | 'pool' | 'default' | 'unknown';

export type HumanModelSelectionRow = Readonly<{
  assignmentId: string; version: number; rank: number; key: string; model: string; provider: string; deviceId: string;
}>;

export type HumanModelTarget = Readonly<{
  key: string; wire: string; provider: ModelDefinition['provider']; baseUrl: string;
}>;

export type HumanModelSelection = Readonly<{
  source: HumanModelSourceKind;
  effectiveModels: ModelDefinition[];
  effectiveKeys: string[];
  tableOn: boolean;
  eligibleRows: readonly HumanModelSelectionRow[];
  targets: readonly HumanModelTarget[];
  fingerprint: string;
}>;

export type HumanModelSource = {
  settings: Settings;
  models: ModelDefinition[];
  pools: AdminStagePools;
  defaults: Record<string, string>;
  assignments: readonly ModelAssignmentRow[];
  options: AssignmentFormOptions;
  source: HumanModelSourceKind;
  humanUsesTable: boolean;
  tableOn: boolean;
  unknown: boolean;
  effectiveModels: ModelDefinition[];
  effectiveKeys: string[];
  version: string;
  selection: HumanModelSelection;
  saveBlocked: boolean;
};

export type HumanModelSourceContext = Readonly<{
  tableOn: boolean;
  tableUnread: boolean;
  rows: readonly ModelAssignmentRow[] | null;
  registry: ModelRegistry | null;
}>;

function unknownSelection(tableOn = false): HumanModelSelection {
  return { source: 'unknown', effectiveModels: [], effectiveKeys: [], tableOn, eligibleRows: [], targets: [], fingerprint: '' };
}

function dedupeModels(models: ModelDefinition[]): ModelDefinition[] {
  const seen = new Set<string>();
  return models.filter(model => {
    if (seen.has(model.key)) return false;
    seen.add(model.key);
    return true;
  });
}

function compareRows(a: ModelAssignmentRow, b: ModelAssignmentRow): number {
  return a.rank - b.rank || a.assignmentId.localeCompare(b.assignmentId);
}

function compareSelectionRows(a: HumanModelSelectionRow, b: HumanModelSelectionRow): number {
  return a.rank - b.rank || a.assignmentId.localeCompare(b.assignmentId);
}

function compareTargets(a: HumanModelTarget, b: HumanModelTarget): number {
  return a.key.localeCompare(b.key) || a.wire.localeCompare(b.wire) || a.provider.localeCompare(b.provider)
    || a.baseUrl.localeCompare(b.baseUrl);
}

function registryEnv(registry: ModelRegistry, key?: string): ModelEnvironment {
  if (!key) return { ...process.env, MODEL_REGISTRY_CONFIG: JSON.stringify(registry) };
  const models = registry.models.map(model => model.key === key
    ? { ...model, purposes: [...new Set([...model.purposes, 'human-review'])] } : model);
  return { ...process.env, MODEL_REGISTRY_CONFIG: JSON.stringify({ ...registry,
    selections: { ...registry.selections, 'human-review': key }, models }) };
}

function targetFor(model: ModelDefinition, registry: ModelRegistry): HumanModelTarget {
  const baseUrl = modelBaseUrl('human-review', registryEnv(registry, model.key), model.provider);
  return { key: model.key, wire: modelRequestName(model), provider: model.provider, baseUrl };
}

function buildSelection(source: Exclude<HumanModelSourceKind, 'unknown'>, tableOn: boolean, models: ModelDefinition[],
  rows: readonly ModelAssignmentRow[], registry: ModelRegistry): HumanModelSelection {
  const effectiveModels = dedupeModels(models);
  let targets: HumanModelTarget[];
  try { targets = effectiveModels.map(model => targetFor(model, registry)); } catch { return unknownSelection(tableOn); }
  const eligibleRows = rows.map(row => ({ assignmentId: row.assignmentId, version: row.version, rank: row.rank,
    key: row.registryKey, model: row.model, provider: row.provider, deviceId: row.deviceId })).sort(compareSelectionRows);
  targets.sort(compareTargets);
  const fingerprint = createHash('sha256').update(JSON.stringify({ source, tableOn, rows: eligibleRows, targets })).digest('hex');
  return { source, effectiveModels, effectiveKeys: effectiveModels.map(model => model.key), tableOn, eligibleRows, targets, fingerprint };
}

function withoutIgnoredHumanReview(pools: AdminStagePools): AdminStagePools {
  return Object.fromEntries(Object.entries(pools).filter(([key]) => key !== 'human-review')) as AdminStagePools;
}

/** Validate every effective pool exactly as the runtime does, ignoring only a table-selected human-review pool. */
export function validateHumanModelPools(pools: AdminStagePools, selection: HumanModelSelection, registry = readModelRegistry()): AdminStagePools {
  return validateAdminStagePools(selection.source === 'table' ? withoutIgnoredHumanReview(pools) : pools, registry);
}

/** Same checks as tableStageSelections, then the rows the runtime can actually choose (lowest rank). */
export function resolveHumanModelSelection(keys: readonly string[], enabled: boolean, rows: readonly ModelAssignmentRow[] | null,
  registry: ModelRegistry): HumanModelSelection {
  const byKey = new Map(registry.models.map(model => [model.key, model] as const));
  if (enabled) {
    if (rows === null) return unknownSelection(true);
    const orderedRows = [...stageTableRows('human', rows)].sort(compareRows);
    const eligible = orderedRows.filter(row => {
      const selected = tableStageSelections(stage => stage === 'human' ? [row] : null, `human-source:${row.assignmentId}`, registry);
      return selected['human-review'] === row.registryKey;
    });
    if (eligible.length) {
      const lowest = eligible[0].rank;
      const models = dedupeModels(eligible.filter(row => row.rank === lowest).flatMap(row => {
        const model = byKey.get(row.registryKey);
        return model ? [model] : [];
      })).sort((a, b) => a.key.localeCompare(b.key));
      if (models.length) return buildSelection('table', true, models, eligible.filter(row => row.rank === lowest), registry);
    }
  }
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length) {
    const models: ModelDefinition[] = [];
    for (const key of uniqueKeys) {
      const model = byKey.get(key);
      if (!model || model.provider !== HUMAN_REVIEW_STAGE.provider) return unknownSelection(enabled);
      models.push(model);
    }
    return buildSelection('pool', enabled, models, [], registry);
  }
  try {
    const model = modelForPurpose('human-review', registryEnv(registry));
    if (model.provider !== HUMAN_REVIEW_STAGE.provider) return unknownSelection(enabled);
    return buildSelection('default', enabled, [model], [], registry);
  } catch { return unknownSelection(enabled); }
}

/** Async — refreshes the assignment snapshot through the runtime gate, then resolves the actual human-review delegate. */
export async function readHumanModelSelection(keys: readonly string[] = []): Promise<HumanModelSelection> {
  try { await requireStageAssignments(); } catch { return unknownSelection(false); }
  let registry: ModelRegistry;
  try { registry = readModelRegistry(); } catch { return unknownSelection(false); }
  const flag = assignmentReadFlag();
  const tableOn = flag.source !== 'unread' && flag.enabled;
  const rows = tableOn ? liveAssignmentRows({ reload: false }) : null;
  if (tableOn && rows === null) return unknownSelection(true);
  return resolveHumanModelSelection(keys, tableOn, rows, registry);
}

/** Sync display helper for legacy callers — reads only the existing snapshot, never opens a DB connection. */
export function currentHumanModelSelection(keys: readonly string[] = []): HumanModelSelection {
  let registry: ModelRegistry;
  try { registry = readModelRegistry(); } catch { return unknownSelection(false); }
  let flag: ReturnType<typeof assignmentReadFlag>;
  try { flag = assignmentReadFlag(); } catch { return unknownSelection(false); }
  if (flag.source === 'unread') {
    return servingContractsDbEnabled() ? unknownSelection(false) : resolveHumanModelSelection(keys, false, null, registry);
  }
  const rows = flag.enabled ? liveAssignmentRows({ reload: false }) : null;
  if (flag.enabled && rows === null) return unknownSelection(true);
  return resolveHumanModelSelection(keys, flag.enabled, rows, registry);
}

function emptyOptions(): AssignmentFormOptions {
  return { stages: [], registry: [], devices: [],
    transportLabels: { gateway: '장비 표지', direct: '엔진 직접', 'local-direct': '로컬 직접', cli: 'CLI' },
    rankMax: 8, confirmWord: '배정' };
}

/** One server read for /admin/models/human and the Flow wrapper. Never returns secrets. */
export async function readHumanModelSource(): Promise<HumanModelSource> {
  const [dbModule, settingsModule, servingModule] = await Promise.all([
    import('@/lib/db'), import('@/lib/crawl/settings'), import('@/lib/llm/serving-contract-store'),
  ]);
  const settings = await dbModule.onPrimary(settingsModule.getSettings);
  let saveBlocked = false;
  try { saveBlocked = settingsModule.settingsUnreadable(settings); } catch { saveBlocked = true; }
  let registry: ModelRegistry | null = null;
  try {
    await servingModule.ensureServingContracts(0);
    registry = readModelRegistry();
  } catch { registry = null; }
  let tableOn = false;
  let flagUnread = false;
  try {
    await requireStageAssignments();
    const flag = assignmentReadFlag();
    tableOn = flag.source !== 'unread' && flag.enabled;
  } catch { flagUnread = true; }
  let assignmentRows: readonly ModelAssignmentRow[] | null = null;
  let assignmentReadFailed = false;
  if (tableOn) {
    try {
      const { readModelAssignments } = await import('@/lib/llm/capacity-helpers-repository');
      assignmentRows = await readModelAssignments({ stage: 'human' });
    } catch { assignmentReadFailed = true; }
  }
  const pools = settings.stageModelPools ?? {};
  let selection = unknownSelection(tableOn);
  if (registry && !saveBlocked && !flagUnread && !assignmentReadFailed && (!tableOn || assignmentRows !== null)) {
    selection = resolveHumanModelSelection(pools['human-review'] ?? [], tableOn, tableOn ? assignmentRows : null, registry);
  }
  let poolsValid = true;
  if (registry && !saveBlocked && !flagUnread) {
    try { validateHumanModelPools(pools, selection, registry); } catch { poolsValid = false; }
  }
  let devices: readonly { deviceId: string; enabled: boolean }[] = [];
  let deviceReadFailed = false;
  if (tableOn && assignmentRows !== null) {
    try {
      const { listModelCapacityDevices } = await import('@/lib/llm/capacity-devices-repository');
      devices = await listModelCapacityDevices();
    } catch { deviceReadFailed = true; }
  }
  const assignments: readonly ModelAssignmentRow[] = tableOn && assignmentRows ? assignmentRows : [];
  const models: ModelDefinition[] = registry ? [...registry.models] : [];
  const defaultPools = selection.source === 'table' ? withoutIgnoredHumanReview(pools) : pools;
  const defaults: Record<string, string> = {};
  for (const stageId of HUMAN_MODEL_STAGES) {
    const stage = ADMIN_MODEL_STAGES.find(candidate => candidate.id === stageId);
    if (!stage) continue;
    try {
      defaults[stage.id] = withAdminStagePools(defaultPools, 'human-model-source', () =>
        withAdminModelStage(stage.id, () => modelRequestName(modelForPurpose(stage.purpose))));
    } catch { defaults[stage.id] = '기본 모델 미확인'; }
  }
  if (selection.source === 'table') defaults['human-review'] = selection.effectiveModels.length === 1
    ? modelRequestName(selection.effectiveModels[0])
    : selection.effectiveModels.map(model => modelRequestName(model)).join(', ');
  if (!(pools['split-confirm']?.length) && selection.source !== 'unknown' && selection.effectiveModels.length) {
    defaults['split-confirm'] = selection.effectiveModels.map(model => modelRequestName(model)).join(', ');
  }
  let options = emptyOptions();
  try {
    const { assignmentFormOptions } = await import('./admin-model-assignments');
    options = assignmentFormOptions(models, devices);
    options.stages = options.stages.filter(stage => stage.id === 'human');
  } catch { saveBlocked = true; options = emptyOptions(); }
  let version = '0';
  try { version = settingsModule.settingsFormVersion(settings); } catch { saveBlocked = true; version = '0'; }
  saveBlocked = saveBlocked || flagUnread || registry === null || assignmentReadFailed || deviceReadFailed;
  const unknown = saveBlocked || !poolsValid || selection.source === 'unknown';
  return { settings, models, pools, defaults, assignments, options, selection,
    source: selection.source, humanUsesTable: selection.source === 'table', tableOn, unknown,
    effectiveModels: selection.effectiveModels, effectiveKeys: selection.effectiveKeys, version, saveBlocked };
}

/** Lock the source rows/toggle before the existing writer locks. No HTTP is allowed inside this transaction. */
export async function lockHumanModelSource(tx: ProductTransaction): Promise<HumanModelSourceContext> {
  await tx.execute(sql`set local lock_timeout = '3s'`);
  await tx.execute(sql`set local statement_timeout = '5s'`);
  const control = await tx.execute(sql`select 1 from model_capacity_control where id = 1 for share`);
  if (!control.length) return { tableOn: false, tableUnread: true, rows: null, registry: null };
  await tx.execute(sql`select 1 from runtime_settings where id = 1 for share`);
  const override = parseAssignmentTableOverride(process.env[MODEL_ASSIGNMENT_TABLE_ENV]);
  let tableOn = override.override === 'on';
  let tableUnread = false;
  if (!override.override) {
    try {
      const [runtime] = await tx.select().from(runtimeSettings).where(eq(runtimeSettings.id, 1));
      if (!runtime) {
        tableOn = false;
        tableUnread = true;
      } else {
        const resolved = resolveRuntimeSettings(runtime.values);
        const invalidAssignments = resolved.issues.some(issue => issue.startsWith('runtime_settings_invalid:assignments.')
          || issue.startsWith('unknown_setting:assignments.'));
        tableOn = !invalidAssignments && resolved.settings.assignments.tableReads === 'on';
        tableUnread = invalidAssignments;
      }
    } catch { tableOn = false; tableUnread = true; }
  }
  let registry: ModelRegistry | null = null;
  try { registry = readModelRegistry(process.env); } catch { registry = null; }
  let rows: readonly ModelAssignmentRow[] | null = null;
  if (tableOn) {
    try {
      const { readModelAssignments } = await import('@/lib/llm/capacity-helpers-repository');
      rows = await readModelAssignments({ stage: 'human' }, tx);
    } catch { rows = null; }
  }
  return { tableOn, tableUnread, rows, registry };
}
