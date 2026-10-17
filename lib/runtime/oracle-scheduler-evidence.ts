import { z } from 'zod';
import { BATCH_RESULT_MAX_AGE_MS } from '@/lib/jobs/batches';

/**
 * Oracle scheduler evidence (PR11g). The scheduler claims no job, so it has no election, role lease or PR10d anchor. Its canary is
 * one real tick (markSchedulerSeen + requestDueJobs) whose ACK the scheduler principal writes inside the requestDueJobs transaction,
 * so an ACK exists only for a tick that passed the DR writer fence and committed. Capability and result evidence live in the
 * job_batch_candidates row of role 'scheduler' (migration 0100) and only the attest principal can write them. Every scheduler boot
 * rewrites that row's boot_id before its first tick, so after a restart the stored ACK never matches and a new canary is required.
 */
const HOST = 'oracle-osaka-smoke';
export type OracleSchedulerIdentity = { instanceId: string; release: string };
export function oracleSchedulerIdentity(env: Readonly<Record<string, string | undefined>>): OracleSchedulerIdentity {
  const instanceId = env.SERVICE_INSTANCE_ID ?? '', release = env.RELEASE_TAG ?? '';
  if (env.JOB_BATCH_VERSION !== '1' || env.PHYSICAL_HOST !== HOST || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(instanceId)
    || !/^[a-f0-9]{40}$/.test(release)) throw new Error('oracle_scheduler_identity_invalid');
  return { instanceId, release };
}
export const oracleSchedulerResultKey = (instanceId: string) => `scheduler-result:${instanceId}`;

const at = z.iso.datetime({ offset: true });
const identity = { instanceId: z.string().min(1).max(48), host: z.literal(HOST), release: z.string().min(1).max(120) };
export const oracleSchedulerResultSchema = z.object({ role: z.literal('scheduler'), ...identity, bootId: z.string().min(1).max(36),
  batchEpoch: z.number().int().positive(), requested: z.number().int().nonnegative(), tickAt: at, recordedAt: at }).strict();
export type OracleSchedulerResult = z.infer<typeof oracleSchedulerResultSchema>;
export const oracleSchedulerCapabilitySchema = z.object({ kind: z.literal('oracle_scheduler'), ...identity,
  dbPrivileges: z.enum(['unknown', 'verified']), dbRole: z.string().min(1).max(63), effectivePrivilegeHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: at }).strict();
export const oracleSchedulerReadbackSchema = z.object({ kind: z.literal('oracle_scheduler_tick'), ...identity, bootId: z.string().min(1).max(36),
  batchEpoch: z.number().int().positive(), recordedAt: at, jobs: z.number().int().positive(), domainReadbackHash: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: at }).strict();

// Same age limits as classifyBatchReadiness: capability 15 minutes, result 24 hours.
const CAPABILITY_MAX_AGE_MS = 15 * 60_000;
const within = (age: number, limit: number) => age >= 0 && age <= limit;

/** Positive only for attest-written evidence of this candidate row's current boot at the current batch epoch. */
export function classifyOracleSchedulerEvidence(input: { instanceId: string; release: string; principal: string; controlEpoch: number;
  at: number; candidate: { bootId: string; capability: unknown; resultEvidence: unknown }; result: unknown }): { ready: boolean; reason: string } {
  const capability = oracleSchedulerCapabilitySchema.safeParse(input.candidate.capability);
  if (!capability.success || capability.data.instanceId !== input.instanceId || capability.data.release !== input.release
    || capability.data.dbPrivileges !== 'verified' || capability.data.dbRole !== input.principal) return { ready: false, reason: 'capability_unknown' };
  if (!within(input.at - Date.parse(capability.data.observedAt), CAPABILITY_MAX_AGE_MS)) return { ready: false, reason: 'capability_stale' };
  const result = oracleSchedulerResultSchema.safeParse(input.result);
  if (!result.success || result.data.instanceId !== input.instanceId || result.data.release !== input.release) return { ready: false, reason: 'result_unknown' };
  if (result.data.bootId !== input.candidate.bootId) return { ready: false, reason: 'result_boot_mismatch' };
  if (result.data.batchEpoch !== input.controlEpoch) return { ready: false, reason: 'result_epoch_mismatch' };
  const recorded = Date.parse(result.data.recordedAt);
  if (!within(input.at - recorded, BATCH_RESULT_MAX_AGE_MS)) return { ready: false, reason: 'result_stale' };
  const readback = oracleSchedulerReadbackSchema.safeParse(input.candidate.resultEvidence);
  const observed = readback.success ? Date.parse(readback.data.observedAt) : NaN;
  if (!readback.success || readback.data.instanceId !== input.instanceId || readback.data.release !== input.release
    || readback.data.bootId !== result.data.bootId || readback.data.batchEpoch !== result.data.batchEpoch
    || readback.data.recordedAt !== result.data.recordedAt || !(recorded <= observed && observed <= input.at)) return { ready: false, reason: 'result_unverified' };
  return { ready: true, reason: 'ready' };
}
