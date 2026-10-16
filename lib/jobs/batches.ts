import { createHash } from 'node:crypto';
import { z } from 'zod';
import { jobsForRole, lanesForRole, JOB_ROLES, type JobRole } from './catalog';
export const BATCH_ROLES = [...JOB_ROLES, 'translation', 'product-health', 'site-evidence', 'official-news'] as const;
export type BatchRole = typeof BATCH_ROLES[number];
export type BatchMode = 'legacy' | 'draining' | 'versioned';
export const BATCH_HOSTS = ['m3', 'mini', 'oracle-osaka-smoke'] as const;
export type BatchHost = typeof BATCH_HOSTS[number];
export const batchPolicySchema = z.object({ version: z.literal(1), release: z.string().min(1).max(120),
  instances: z.array(z.object({ instanceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/), host: z.enum(BATCH_HOSTS) }).strict()).min(1).max(100)
    .refine(v => new Set(v.map(r => r.instanceId)).size === v.length),
}).strict();
export type BatchPolicy = z.infer<typeof batchPolicySchema>;
export const batchCandidateSchema = z.object({role:z.enum(BATCH_ROLES),instanceId:z.string().min(1).max(48),bootId:z.string().min(1).max(36),release:z.string().min(1).max(120),kind:z.enum(['primary','standby']),batchVersion:z.literal(1),host:z.enum(BATCH_HOSTS)}).strict();
export const batchLeaseSchema=batchCandidateSchema.extend({epoch:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),batchEpoch:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)});
export function batchPolicyHash(value: BatchPolicy): string {
  const checked = batchPolicySchema.parse(value);
  return createHash('sha256').update(JSON.stringify({ ...checked, instances: [...checked.instances].sort((a,b) => a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0) })).digest('hex');
}
const SPLIT_JOBS = {
  translation: ['reason-translate', 'product-tagline-ko', 'product-translate'],
  'product-health': ['uptime-ping'], 'official-news': ['news-refresh'],
  // PR08's canonical-only adapter must be installed before this role can claim anything.
  'site-evidence': [],
} satisfies Record<string, readonly string[]>;
export function batchJobsForRole(role: BatchRole, mode: BatchMode): string[] {
  if (mode === 'draining' || !BATCH_ROLES.includes(role)) return [];
  if (!JOB_ROLES.includes(role as JobRole)) return mode === 'versioned' ? [...SPLIT_JOBS[role as keyof typeof SPLIT_JOBS]] : [];
  const legacy = jobsForRole(role as JobRole);
  return mode === 'legacy' ? legacy : legacy.filter(name => !Object.values(SPLIT_JOBS).some(names => (names as readonly string[]).includes(name)));
}
export function batchLanesForRole(role: BatchRole, mode: BatchMode): string[][] {
  const names = batchJobsForRole(role, mode);
  if (!names.length) return [];
  if (!JOB_ROLES.includes(role as JobRole)) return [names];
  const selected = new Set(names);
  return lanesForRole(role as JobRole).map(lane => lane.filter(name => selected.has(name))).filter(lane => lane.length > 0);
}
export function batchRoleForJob(name: string): BatchRole | undefined { return BATCH_ROLES.find(role => batchJobsForRole(role, 'versioned').includes(name)); }
export function batchHostOrder(role: BatchRole): readonly BatchHost[] {
  if (!JOB_ROLES.includes(role as JobRole)) return ['oracle-osaka-smoke', 'm3', 'mini'];
  return role === 'crawler' ? ['mini', 'm3', 'oracle-osaka-smoke'] : ['m3', 'mini', 'oracle-osaka-smoke'];
}
export const batchCapabilitySchema = z.object({ host: z.enum(BATCH_HOSTS), release: z.string().min(1).max(120), instanceId: z.string().min(1).max(48),
  dbPrivileges: z.enum(['unknown', 'verified']), http: z.enum(['unknown', 'verified']), model: z.enum(['unknown', 'verified']),
  dbRole:z.string().min(1).max(63).optional(), effectivePrivilegeHash:z.string().regex(/^[0-9a-f]{64}$/).optional(),
  modelBoundEvidenceHash:z.string().regex(/^[0-9a-f]{64}$/).optional(),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();
const resultSchema = z.object({ role:z.enum(BATCH_ROLES),batchEpoch:z.number().int().positive(), job: z.string(), instanceId: z.string(), host: z.enum(BATCH_HOSTS), release: z.string(), bootId: z.string().min(1),
  recordedAt: z.iso.datetime({ offset: true }), count: z.number().int().positive(), requestedVersion: z.number().int().positive(),
}).strict();
export const batchResultReadbackSchema=z.object({job:z.string().min(1),instanceId:z.string().min(1),host:z.enum(BATCH_HOSTS),release:z.string().min(1),requestedVersion:z.number().int().positive(),domainReadbackHash:z.string().regex(/^[0-9a-f]{64}$/),observedAt:z.iso.datetime({offset:true})}).strict();
export type BatchResultEvidence = z.infer<typeof resultSchema>;
export function classifyBatchReadiness(input: {role: BatchRole; host: BatchHost; instanceId: string; release: string; at: number; evidence: unknown; result: unknown; readback?:unknown}) {
  const capability = batchCapabilitySchema.safeParse(input.evidence);
  if (!capability.success || capability.data.host !== input.host || capability.data.instanceId !== input.instanceId || capability.data.release !== input.release ||
    capability.data.dbPrivileges !== 'verified' || !capability.data.dbRole || !capability.data.effectivePrivilegeHash || capability.data.http !== 'verified' ||
    (['translation','reviewer','publisher','text'].includes(input.role) && (capability.data.model !== 'verified' || !capability.data.modelBoundEvidenceHash))) return { ready: false, reason: 'capability_unknown' } as const;
  const age = input.at - Date.parse(capability.data.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 15 * 60_000) return { ready: false, reason: 'capability_stale' } as const;
  const result = resultSchema.safeParse(input.result);
  if (!result.success || result.data.host !== input.host || result.data.instanceId !== input.instanceId || result.data.release !== input.release ||
    !batchJobsForRole(input.role, 'versioned').includes(result.data.job)) return { ready: false, reason: 'result_unknown' } as const;
  const resultAge = input.at - Date.parse(result.data.recordedAt);
  if (!Number.isFinite(resultAge) || resultAge < 0 || resultAge > 24 * 60 * 60_000) return { ready: false, reason: 'result_stale' } as const;
  const readback=batchResultReadbackSchema.safeParse(input.readback);
  if(!readback.success || readback.data.job!==result.data.job || readback.data.instanceId!==input.instanceId || readback.data.host!==input.host || readback.data.release!==input.release || readback.data.requestedVersion!==result.data.requestedVersion || Date.parse(readback.data.observedAt)<Date.parse(result.data.recordedAt) || Date.parse(readback.data.observedAt)>input.at) return {ready:false,reason:'result_unverified'} as const;
  return { ready: true, reason: 'ready' } as const;
}
