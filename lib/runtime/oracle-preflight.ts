import { z } from 'zod';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { batchJobsForRole, batchPolicyHash, batchPolicySchema, classifyBatchReadiness, classifyBatchCandidateEvidence, batchCanaryAnchorKey } from '@/lib/jobs/batches';
import { assertJobBatchAdmission, JobBatchBlockedError, lockJobBatch } from '@/lib/jobs/batch-repository';
import { assertRoleLease, roleLeaseFromEnv, RoleLeaseLostError } from '@/lib/jobs/role-leader';
import { serviceInstanceId } from '@/lib/operations/instance';
import { ORACLE_PRIVILEGE_CATALOG_SQL, ORACLE_UNSAFE_AUTHORITY_SQL, oracleDbPrivilegeMismatches } from '@/lib/runtime/oracle-db-profile';

const target = z.object({ role: z.enum(['translation', 'site-evidence', 'official-news', 'product-health', 'scheduler']) }).strict();
type Check = { status: 'verified' | 'unknown' | 'rejected'; reason: string; hash?: string };
export type OracleRuntimePreflightReport = {
  kind: 'nomorevibe-oracle-runtime-preflight'; version: 1; role: z.infer<typeof target>['role'];
  configuredHost: { tenancy: 'surfguide'; region: 'ap-osaka-1'; instance: 'osaka-smoke' };
  instanceId: string | null; releaseSha: string | null; ready: false; activationAllowed: false;
  workload: { ready: boolean; reason: string; job?: string; evidenceHash?: string };
  checks: Record<'identity' | 'runtime' | 'host' | 'release' | 'database' | 'timeouts' | 'budget' | 'model' | 'batch' | 'admission', Check>;
};
const sessionSchema = z.object({ at: z.string().datetime({ offset: true }).or(z.string().min(1)), principal: z.string().min(1),
  sessionPrincipal: z.string().min(1), unsafe: z.boolean(), readOnly: z.boolean(), replica: z.boolean(),
  statementMs: z.coerce.number().finite(), lockMs: z.coerce.number().finite(), idleMs: z.coerce.number().finite(), privileges: z.unknown() }).strict();
const candidateSchema = z.object({ role: z.string(), instanceId: z.string(), host: z.string(), bootId: z.string().min(1),
  release: z.string(), policyHash: z.string(), capability: z.unknown(), resultEvidence: z.unknown() }).strict();
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unknown = (reason: string): Check => ({ status: 'unknown', reason });

/** Inspection only. No supplied attestation, heartbeat, or report is an execution capability. */
export async function readOracleRuntimePreflight(input: unknown): Promise<OracleRuntimePreflightReport> {
  const parsed = target.safeParse(input);
  if (!parsed.success) throw new Error('invalid_oracle_preflight_input');
  const { role } = parsed.data;
  // Snapshot only the identity fields needed by the existing lease parser before any await.
  const keys = ['JOB_BATCH_VERSION', 'PHYSICAL_HOST', 'SERVICE_INSTANCE_ID', 'RELEASE_TAG', 'DB_POOLER_MODE',
    'ROLE_LEASE_ROLE', 'ROLE_LEASE_INSTANCE_ID', 'ROLE_LEASE_BOOT_ID', 'ROLE_LEASE_RELEASE', 'ROLE_LEASE_EPOCH',
    'ROLE_LEASE_BATCH_VERSION', 'ROLE_LEASE_BATCH_EPOCH', 'ROLE_LEASE_HOST'] as const;
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const report: OracleRuntimePreflightReport = {
    kind: 'nomorevibe-oracle-runtime-preflight', version: 1, role,
    configuredHost: { tenancy: 'surfguide', region: 'ap-osaka-1', instance: 'osaka-smoke' },
    instanceId: null, releaseSha: null, ready: false, activationAllowed: false,
    workload: { ready: false, reason: 'identity_unknown' },
    checks: { identity: unknown('identity_unknown'), runtime: unknown('loaded_runtime_unverified'),
      host: unknown('oracle_host_metadata_unverified'), release: unknown('root_owned_release_unverified'),
      database: unknown('database_unobserved'), timeouts: unknown('timeouts_unobserved'),
      budget: unknown('aggregate_enforcement_unverified'), model: unknown('physical_model_slot_unverified'),
      batch: unknown('batch_unobserved'), admission: unknown('role_lease_unobserved') },
  };
  if (currentReplayDb()) { report.workload.reason = 'replay_unsupported'; return report; }
  let instance: string | null;
  try { instance = serviceInstanceId(env); } catch { return report; }
  if (!instance || !/^[a-f0-9]{40}$/.test(env.RELEASE_TAG ?? '') || env.JOB_BATCH_VERSION !== '1'
    || env.PHYSICAL_HOST !== 'oracle-osaka-smoke') return report;
  report.instanceId = instance; report.releaseSha = env.RELEASE_TAG!;
  report.checks.identity = { status: 'verified', reason: 'configured_identity_matches' };
  if (process.platform !== 'linux' || process.arch !== 'arm64' || !/^v24\./.test(process.version))
    report.checks.runtime = { status: 'rejected', reason: 'runtime_platform_mismatch' };
  if (role === 'scheduler') { report.workload.reason = 'scheduler_canary_unavailable'; return report; }
  const lease = roleLeaseFromEnv(role, env);
  if (lease && (lease.batchVersion !== 1 || lease.host !== 'oracle-osaka-smoke' || lease.instanceId !== instance || lease.release !== report.releaseSha)) {
    report.workload.reason = 'role_identity_mismatch'; return report;
  }
  return onPrimary(() => db.transaction(async tx => {
    // SELECT row locks are forbidden in PostgreSQL READ ONLY transactions. This
    // no-DML inspection uses the existing admission locks, never a new claim.
    const control = await lockJobBatch(tx);
    const policy = batchPolicySchema.safeParse(control.policy);
    if (control.mode !== 'versioned' || control.writerContractVersion < 1 || !Number.isSafeInteger(control.epoch)
      || control.epoch < 1 || !policy.success || batchPolicyHash(policy.data) !== control.policyHash
      || policy.data.release !== report.releaseSha || !policy.data.instances.some(row => row.instanceId === instance && row.host === 'oracle-osaka-smoke')) {
      report.checks.batch = { status: 'rejected', reason: 'batch_unavailable' };
      report.workload.reason = 'batch_unavailable'; return report;
    }
    report.checks.batch = { status: 'verified', reason: 'current_policy_matches' };
    const [rawSession] = await tx.execute(sql`SELECT clock_timestamp()::text AS at, current_user AS principal,
      session_user AS "sessionPrincipal", pg_is_in_recovery() AS replica,
      current_setting('transaction_read_only')='on' AS "readOnly",
      ${ORACLE_UNSAFE_AUTHORITY_SQL} AS unsafe,
      extract(epoch FROM current_setting('statement_timeout')::interval)*1000 AS "statementMs",
      extract(epoch FROM current_setting('lock_timeout')::interval)*1000 AS "lockMs",
      extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000 AS "idleMs",
      ${ORACLE_PRIVILEGE_CATALOG_SQL} AS privileges
      FROM pg_roles r WHERE r.rolname=current_user`);
    const session = sessionSchema.parse(rawSession), at = Date.parse(session.at);
    if (!Number.isFinite(at)) throw new Error('oracle_preflight_database_clock_invalid');
    const privilegeHash = hash({ principal: session.principal, privileges: session.privileges });
    // Only an exact match with the approved least-privilege profile is positive; anything else stays unknown.
    report.checks.database = oracleDbPrivilegeMismatches(role, session.principal, session.privileges).length
      ? { ...unknown('approved_privilege_profile_unavailable'), hash: privilegeHash }
      : { status: 'verified', reason: 'approved_privilege_profile_matches', hash: privilegeHash };
    if (session.unsafe || session.readOnly || session.replica || session.principal !== session.sessionPrincipal) {
      report.checks.database = { status: 'rejected', reason: 'database_authority_rejected' };
      report.workload.reason = 'database_rejected'; return report;
    }
    if (env.DB_POOLER_MODE === 'pgbouncer') report.checks.timeouts = unknown('pooler_server_settings_unverified');
    else if (session.statementMs > 0 && session.statementMs <= 60000 && session.lockMs > 0 && session.lockMs <= 5000
      && session.lockMs <= session.statementMs && session.idleMs > 0 && session.idleMs <= 60000)
      report.checks.timeouts = { status: 'verified', reason: 'effective_session_timeouts_bounded' };
    else { report.checks.timeouts = { status: 'rejected', reason: 'effective_session_timeouts_unbounded' };
      report.workload.reason = 'timeouts_rejected'; return report; }
    const [rawCandidate] = await tx.execute(sql`SELECT role,instance_id AS "instanceId",host,boot_id AS "bootId",
      release,policy_hash AS "policyHash",capability,result_evidence AS "resultEvidence"
      FROM job_batch_candidates WHERE role=${role} AND instance_id=${instance}`);
    const candidate = candidateSchema.safeParse(rawCandidate);
    if (!candidate.success || candidate.data.role !== role || candidate.data.instanceId !== instance
      || candidate.data.host !== 'oracle-osaka-smoke' || candidate.data.release !== report.releaseSha
      || candidate.data.policyHash !== control.policyHash || lease && (lease.batchEpoch !== control.epoch || lease.bootId !== candidate.data.bootId)) {
      report.workload.reason = 'candidate_unknown'; return report;
    }
    const names = batchJobsForRole(role, 'versioned');
    // A JS array inside sql`` expands to a row ($1,$2), which ANY() rejects (42809) on real PostgreSQL.
    const observationKeys = [batchCanaryAnchorKey(role,instance),...names.map(name => `batch-result:${instance}:${name}`)];
    const observations = await tx.execute<{ key: string; value: unknown }>(sql`SELECT key,value FROM operations_observations
      WHERE key IN (${sql.join(observationKeys.map(key => sql`${key}`), sql`,`)}) ORDER BY key`);
    report.workload.reason = 'canary_unknown';
    const anchorKey=batchCanaryAnchorKey(role,instance), anchor=observations.find(row=>row.key===anchorKey);
    const selected=classifyBatchCandidateEvidence({candidate:{...candidate.data,role,host:'oracle-osaka-smoke'},controlEpoch:control.epoch,
      at,anchor:anchor?.value,latest:observations.filter(row=>row.key!==anchorKey).map(row=>({key:row.key,result:object(row.value)?.batchResult}))});
    if(!selected.report.ready) report.workload.reason=selected.report.reason;
    const selectedObservations=selected.selectedResult ? [{key:`batch-result:${instance}:${selected.selectedResult.job}`,value:{batchResult:selected.selectedResult}}] : [];
    for (const observation of selectedObservations) {
      const result = object(object(observation.value)?.batchResult), capability = object(candidate.data.capability);
      if (!result || !names.includes(String(result.job)) || observation.key !== `batch-result:${instance}:${result.job}`
        || result.role !== role || result.bootId !== candidate.data.bootId || result.batchEpoch !== control.epoch
        || capability?.dbRole !== session.principal) continue;
      const classified = classifyBatchReadiness({ role, host: 'oracle-osaka-smoke', instanceId: instance,
        release: report.releaseSha!, at, evidence: candidate.data.capability, result, readback: candidate.data.resultEvidence });
      if (!classified.ready) { report.workload.reason = classified.reason; continue; }
      report.workload = { ready: true, reason: 'ready', job: String(result.job),
        evidenceHash: hash({ policyHash: control.policyHash, capability: candidate.data.capability, result, readback: candidate.data.resultEvidence }) };
      break;
    }
    if (report.workload.ready && lease) {
      try {
        for (const name of names) await assertJobBatchAdmission(tx, name, lease);
        // Actual current owner/epoch and DB wall are checked after every wait.
        await assertRoleLease(tx, lease);
        report.checks.admission = { status: 'verified', reason: 'current_role_admission_verified' };
      } catch (error) {
        if (!(error instanceof JobBatchBlockedError) && !(error instanceof RoleLeaseLostError)) throw error;
        report.checks.admission = { status: 'rejected', reason: 'current_role_admission_rejected' };
        report.workload = { ready: false, reason: 'admission_rejected' };
      }
    }
    return report;
  }, { isolationLevel: 'repeatable read' }));
}
