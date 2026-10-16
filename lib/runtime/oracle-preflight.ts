import { z } from 'zod';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { batchJobsForRole, batchPolicyHash, batchPolicySchema, classifyBatchReadiness } from '@/lib/jobs/batches';
import { assertJobBatchAdmission, JobBatchBlockedError, lockJobBatch } from '@/lib/jobs/batch-repository';
import { assertRoleLease, roleLeaseFromEnv, RoleLeaseLostError } from '@/lib/jobs/role-leader';
import { serviceInstanceId } from '@/lib/operations/instance';

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
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR current_user<>session_user OR has_database_privilege(current_user,current_database(),'CREATE')
        OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
          AND has_schema_privilege(current_user,n.oid,'CREATE'))
        OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.oid<>r.oid AND pg_has_role(current_user,p.oid,'MEMBER')
          AND (p.rolsuper OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication OR p.rolbypassrls))) AS unsafe,
      extract(epoch FROM current_setting('statement_timeout')::interval)*1000 AS "statementMs",
      extract(epoch FROM current_setting('lock_timeout')::interval)*1000 AS "lockMs",
      extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000 AS "idleMs",
      (SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
        'select',has_table_privilege(current_user,c.oid,'SELECT'),'insert',has_table_privilege(current_user,c.oid,'INSERT'),
        'update',has_table_privilege(current_user,c.oid,'UPDATE'),'delete',has_table_privilege(current_user,c.oid,'DELETE'),
        'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
        'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,
          'select',has_column_privilege(current_user,c.oid,a.attnum,'SELECT'),
          'insert',has_column_privilege(current_user,c.oid,a.attnum,'INSERT'),
          'update',has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')) ORDER BY a.attnum),'[]'::jsonb)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.policyname),'[]'::jsonb)
          FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname)) ORDER BY n.nspname,c.relname),'[]'::jsonb)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')) AS privileges
      FROM pg_roles r WHERE r.rolname=current_user`);
    const session = sessionSchema.parse(rawSession), at = Date.parse(session.at);
    if (!Number.isFinite(at)) throw new Error('oracle_preflight_database_clock_invalid');
    report.checks.database = { ...unknown('approved_privilege_profile_unavailable'),
      hash: hash({ principal: session.principal, privileges: session.privileges }) };
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
    const observations = await tx.execute<{ key: string; value: unknown }>(sql`SELECT key,value FROM operations_observations
      WHERE key=ANY(${names.map(name => `batch-result:${instance}:${name}`)}) ORDER BY key`);
    report.workload.reason = 'canary_unknown';
    for (const observation of observations) {
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
