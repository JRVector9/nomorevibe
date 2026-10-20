import { z } from 'zod';
import { consumerNames, consumerSpec, type ConsumerName } from '@/lib/runtime/consumer-registry';

const hosts = ['m3', 'mini', 'oracle-osaka-smoke'] as const;
const roles = ['crawler', 'reviewer', 'publisher', 'text', 'maintenance', 'translation', 'product-health', 'site-evidence', 'official-news'] as const;
const reviewerConsumers = ['ai1', 'ai2'] as const;
// 그 밖의 등록 consumer(lib/runtime/consumer-registry.ts)는 policy.consumers 로 선언한다. ai1·ai2 는 옛 칸(reviewerConsumers)에만 둔다
const isGeneralConsumer = (name: string) => !(reviewerConsumers as readonly string[]).includes(name) && consumerSpec(name) !== undefined;
/** process.consumer 가 허용되는 부모 역할. legacy·ai1·ai2 는 reviewer, 일반 consumer 는 등록부의 역할 */
const consumerRole = (name: string) => ['legacy', ...reviewerConsumers].includes(name) ? 'reviewer'
  : isGeneralConsumer(name) ? consumerSpec(name)!.role : undefined;
const count = z.number().int().min(0).max(2);
export const HostDbBudgetSchema = z.strictObject({
  version: z.literal(1), host: z.enum(hosts), release: z.string().min(1).max(120),
  roles: z.array(z.enum(roles)).max(roles.length).refine(value => new Set(value).size === value.length),
  schedulerReplicas: count, webReplicas: count, webReadReplica: z.boolean(),
  monitor: z.boolean(), connectAgent: z.boolean(),
  preflightProcesses: z.number().int().min(0).max(1), migrationProcesses: z.number().int().min(0).max(1),
  rolloutCopies: z.union([z.literal(1), z.literal(2)]),
  reviewerConsumers: z.array(z.enum(reviewerConsumers)).max(2).refine(value => new Set(value).size === value.length).optional(),
  consumers: z.array(z.string().refine(isGeneralConsumer)).max(consumerNames().length)
    .refine(value => new Set(value).size === value.length).optional(),
}).refine(value => !value.webReadReplica || value.webReplicas > 0);
export type HostDbBudget = z.infer<typeof HostDbBudgetSchema>;
type WorkerRole = typeof roles[number];
export type HostDbReviewerConsumer = 'legacy' | 'ai1' | 'ai2';
export type HostDbConsumer = HostDbReviewerConsumer | ConsumerName;
export type HostDbProcessKind = 'role-parent' | 'worker' | 'scheduler-parent' | 'scheduler-worker' | 'web' | 'monitor' | 'connect-agent' | 'preflight' | 'migration';
export type HostDbProcessBudget = { kind: HostDbProcessKind; role: string; count: number; primaryMax: number; readMax: number; consumer?: ConsumerName };
const identity = { host: z.enum(hosts), release: z.string().min(1).max(120), replica: z.number().int().min(1).max(2), copy: z.union([z.literal(1), z.literal(2)]) };
const ProcessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...identity, kind: z.literal('role-parent'), role: z.enum(roles), consumer: z.string().optional() }),
  z.strictObject({ ...identity, kind: z.literal('worker'), role: z.enum(roles), consumer: z.string().optional() }),
  z.strictObject({ ...identity, kind: z.literal('scheduler-parent'), role: z.literal('scheduler') }),
  z.strictObject({ ...identity, kind: z.literal('scheduler-worker'), role: z.literal('scheduler') }),
  z.strictObject({ ...identity, kind: z.literal('web'), role: z.literal('web') }),
  z.strictObject({ ...identity, kind: z.literal('monitor'), role: z.literal('monitor') }),
  z.strictObject({ ...identity, kind: z.literal('connect-agent'), role: z.literal('connect-agent') }),
  z.strictObject({ ...identity, kind: z.literal('preflight'), role: z.literal('preflight') }),
  z.strictObject({ ...identity, kind: z.literal('migration'), role: z.literal('migration') }),
]).refine(value => !('consumer' in value) || value.consumer === undefined || consumerRole(value.consumer) === value.role);
const OptionsSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('enabled'), policy: HostDbBudgetSchema, process: ProcessSchema,
    overrides: z.strictObject({ max: z.number().int().positive().optional(), readMax: z.number().int().positive().optional() }).optional() }),
]);
const unverified = { enforcement: 'unknown', ready: false, activationAllowed: false } as const;
const workerMax: Record<WorkerRole, number> = {
  crawler: 4, reviewer: 3, publisher: 3, text: 3, maintenance: 3,
  translation: 3, 'product-health': 3, 'site-evidence': 3, 'official-news': 3,
};

function processBudgets(policy: HostDbBudget): HostDbProcessBudget[] {
  const processes: HostDbProcessBudget[] = [];
  const add = (kind: HostDbProcessKind, role: string, count: number, primaryMax: number, readMax = 0,
    consumer?: ConsumerName) => {
    if (count > 0) processes.push({ kind, role, count, primaryMax, readMax, ...(consumer ? { consumer } : {}) });
  };
  for (const role of roles.filter(role => policy.roles.includes(role))) {
    // Supervisor/observations/role heartbeat run in this same parent process.
    add('role-parent', role, policy.rolloutCopies, 1);
    add('worker', role, policy.rolloutCopies, workerMax[role]);
  }
  for (const consumer of reviewerConsumers.filter(value => policy.reviewerConsumers?.includes(value))) {
    add('role-parent', 'reviewer', policy.rolloutCopies, 1, 0, consumer);
    add('worker', 'reviewer', policy.rolloutCopies, workerMax.reviewer, 0, consumer);
  }
  // 일반 consumer 도 감독(부모 1)과 자식 worker 한 쌍이다. 자식 상한은 등록부가 정한다
  for (const consumer of consumerNames().filter(value => policy.consumers?.includes(value))) {
    const { role, workerMax: max } = consumerSpec(consumer)!;
    add('role-parent', role, policy.rolloutCopies, 1, 0, consumer);
    add('worker', role, policy.rolloutCopies, max, 0, consumer);
  }
  const copies = policy.rolloutCopies;
  add('scheduler-parent', 'scheduler', policy.schedulerReplicas * copies, 1);
  add('scheduler-worker', 'scheduler', policy.schedulerReplicas * copies, 2);
  add('web', 'web', policy.webReplicas * copies, 8, policy.webReadReplica ? 4 : 0);
  add('monitor', 'monitor', Number(policy.monitor) * copies, 1);
  add('connect-agent', 'connect-agent', Number(policy.connectAgent) * copies, 1);
  // CLI counts already describe their declared simultaneous overlap.
  add('preflight', 'preflight', policy.preflightProcesses, 1);
  add('migration', 'migration', policy.migrationProcesses, 1);
  return processes;
}

/** Pure declared client catalog. It neither opens a pool nor attests a physical host. */
export function hostDbBudgetCatalog(value: unknown) {
  const policy = HostDbBudgetSchema.parse(value);
  const processes = processBudgets(policy);
  const primaryClients = processes.reduce((total, row) => total + row.count * row.primaryMax, 0);
  const replicaClients = processes.reduce((total, row) => total + row.count * row.readMax, 0);
  return { host: policy.host, release: policy.release, processes, primaryClients, replicaClients, totalClients: primaryClients + replicaClients, ...unverified };
}

/** Disabled preserves the exact caller object; declared quotas remain unverified evidence. */
export function resolveHostDbPoolConfig<T extends { role: string; max: number }>(original: T, input: unknown = { mode: 'disabled' }): {
  config: Omit<T, 'max'> & { max: number }; readMax: number | undefined;
  enforcement: 'unknown'; ready: false; activationAllowed: false;
} {
  const options = OptionsSchema.parse(input);
  if (options.mode === 'disabled') return { config: original, readMax: undefined, ...unverified };
  const { policy, process, overrides } = options;
  const row = processBudgets(policy).find(row => row.role === process.role && row.kind === process.kind
    && consumerKey(row) === consumerKey(process));
  const copies = process.kind === 'preflight' || process.kind === 'migration' ? 1 : policy.rolloutCopies;
  if (process.host !== policy.host || process.release !== policy.release || original.role !== process.role ||
      !row || process.copy > copies || process.replica > row.count / copies) {
    throw new Error('host_db_process_not_declared');
  }
  const max = overrides?.max ?? row.primaryMax;
  const readMax = overrides?.readMax ?? row.readMax;
  if (max > row.primaryMax || readMax > row.readMax) throw new Error('host_db_pool_quota_exceeded');
  return { config: { ...original, max }, readMax, ...unverified };
}


type HostDbEnvironment = Readonly<Record<string, string | undefined>>;
const RuntimeOptionsSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('enabled'), policy: HostDbBudgetSchema, process: ProcessSchema }),
]);

/** Startup configuration; changing it requires a process restart, not singleton reconfiguration. */
function runtimeOptions(env: HostDbEnvironment) {
  const raw = env.HOST_DB_BUDGET;
  if (raw === undefined) return { mode: 'disabled' as const };
  try {
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) throw new Error();
    const options = RuntimeOptionsSchema.parse(JSON.parse(raw));
    if (options.mode === 'enabled' && (env.WORKER_ROLE !== options.process.role ||
        env.PHYSICAL_HOST !== options.process.host || env.RELEASE_TAG !== options.process.release)) throw new Error();
    return options;
  } catch { throw new Error('host_db_budget_invalid'); }
}

/** Trusted declarations are checked here; they do not attest process identity or host-wide enforcement. */
function consumerKey(value: { role: string; consumer?: string }) {
  return value.consumer ?? (value.role === 'reviewer' ? 'legacy' : undefined);
}
export function assertHostDbEntry(env: HostDbEnvironment, expected: {
  kind: HostDbProcessKind; role: string; consumer?: HostDbConsumer;
}): void {
  const options = runtimeOptions(env);
  if (options.mode === 'disabled') return;
  if (options.process.kind !== expected.kind || options.process.role !== expected.role
      || expected.consumer !== undefined && consumerRole(expected.consumer) !== expected.role
      || consumerKey(options.process) !== consumerKey(expected)) throw new Error('host_db_entry_mismatch');
  resolveHostDbPoolConfig({ role: expected.role, max: 1 }, options);
}

/** host 합계 장부용 선언(같은 strict 검증). 비활성은 null 이며 실제 물리 합계를 증명하지 않는다 */
export function hostDbRuntimeDeclaration(env: HostDbEnvironment) {
  const options = runtimeOptions(env);
  if (options.mode === 'disabled') return null;
  const { config, readMax } = resolveHostDbPoolConfig({ role: options.process.role, max: 1 }, options);
  return { policy: options.policy, process: options.process, primaryMax: config.max, readMax: readMax ?? 0 };
}

export function hostDbChildEnvironment(env: NodeJS.ProcessEnv, role: string, consumer?: HostDbConsumer): NodeJS.ProcessEnv;
export function hostDbChildEnvironment(env: HostDbEnvironment, role: string, consumer?: HostDbConsumer): Record<string, string | undefined>;
export function hostDbChildEnvironment(env: HostDbEnvironment, role: string, consumer?: HostDbConsumer): Record<string, string | undefined> {
  const parentKind = role === 'scheduler' ? 'scheduler-parent' : 'role-parent';
  assertHostDbEntry(env, { kind: parentKind, role, consumer });
  const options = runtimeOptions(env);
  return { ...env, WORKER_ROLE: role, ...(options.mode === 'enabled' ? {
    HOST_DB_BUDGET: JSON.stringify({ ...options, process: { ...options.process,
      kind: role === 'scheduler' ? 'scheduler-worker' : 'worker' } }),
  } : {}) };
}

/** Shared by config derivation and the actual driver factory; no authority is returned. */
export function resolveHostDbRuntimePoolConfig<T extends { role: string; max: number }>(original: T,
  env: HostDbEnvironment, purpose: 'primary' | 'read', explicitMax?: number): T {
  const options = runtimeOptions(env);
  if (options.mode === 'disabled') return original;
  if (purpose !== 'primary' && purpose !== 'read') throw new Error('host_db_pool_purpose_invalid');
  if (explicitMax !== undefined && (!Number.isSafeInteger(explicitMax) || explicitMax < 1)) throw new Error('host_db_pool_quota_exceeded');
  const resolved = resolveHostDbPoolConfig(original, options);
  const quota = purpose === 'primary' ? resolved.config.max : resolved.readMax;
  if (!quota) throw new Error('host_db_read_pool_not_declared');
  if (explicitMax !== undefined && explicitMax > quota) throw new Error('host_db_pool_quota_exceeded');
  return { ...original, max: explicitMax ?? quota };
}
