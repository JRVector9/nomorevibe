import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { batchCanaryAnchorKey, batchCapabilitySchema, batchJobsForRole, batchPolicyHash, batchPolicySchema, batchResultReadbackSchema,
  classifyBatchCandidateEvidence, type BatchCanaryCandidate } from '@/lib/jobs/batches';
import { JOBS } from '@/lib/jobs/registry';
import { runJob, type RunResult } from '@/lib/jobs/runner';
import { releaseRole, tryAcquireRole, type RoleLease } from '@/lib/jobs/role-leader';
import { JOB_CATALOG, JOB_ROLES, type JobRole } from '@/lib/jobs/catalog';
import { httpOriginPolicyHash, httpOriginPolicySchema } from '@/lib/net/http-origin-policy';
import { ORACLE_DB_PRINCIPALS, ORACLE_PRIVILEGE_CATALOG_SQL, ORACLE_UNSAFE_AUTHORITY_SQL, oracleDbPrivilegeMismatches } from './oracle-db-profile';

/**
 * Operator canary for Oracle roles. Evidence comes from an actual stored job ACK and a domain readback of the rows that
 * tick wrote; it is written only through the separate attest principal, never by a worker heartbeat. Capability fields
 * are positive only when the live DB principal/privileges and HTTP permit participation are observed. No model-bound
 * evidence path exists yet, so model stays unknown and translation cannot become ready.
 */
export const ORACLE_CANARY_ROLES = ['translation', 'product-health', 'site-evidence', 'official-news'] as const;
export type OracleCanaryRole = typeof ORACLE_CANARY_ROLES[number];
export type OracleCanaryIdentity = { role: OracleCanaryRole; instanceId: string; release: string };
const HOST = 'oracle-osaka-smoke';
const HTTP_JOBS = new Set(['news-refresh', 'uptime-ping', 'product-site-evidence-refresh']);
const RESULT_MAX_AGE_MS = 24 * 60 * 60_000;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Tx = postgres.TransactionSql;
type Window = { from: string; to: string };

export function oracleCanaryIdentity(role: string, env: Readonly<Record<string, string | undefined>>): OracleCanaryIdentity {
  const instanceId = env.SERVICE_INSTANCE_ID ?? '', release = env.RELEASE_TAG ?? '';
  if (!(ORACLE_CANARY_ROLES as readonly string[]).includes(role) || env.JOB_BATCH_VERSION !== '1' || env.PHYSICAL_HOST !== HOST
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(instanceId) || !/^[a-f0-9]{40}$/.test(release)) throw new Error('oracle_canary_identity_invalid');
  return { role: role as OracleCanaryRole, instanceId, release };
}

/** Rows the tick wrote, read back after its ACK. Naive timestamps are compared as UTC wall time (SET LOCAL TimeZone). */
async function domainReadback(tx: Tx, job: string, instanceId: string, window: Window): Promise<readonly unknown[]> {
  const { from, to } = window;
  if (job === 'news-refresh') return tx`SELECT id,source_key,url,title,state,created_at::text FROM news_items
    WHERE created_at::timestamptz BETWEEN ${from}::timestamptz AND ${to}::timestamptz ORDER BY id`;
  if (job === 'uptime-ping') return tx`SELECT observation_id,product_id,url_hash,slot::text,status,kind,disposition,payload_hash FROM uptime_observations
    WHERE instance_id=${instanceId} AND received_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz ORDER BY observation_id`;
  if (job === 'product-site-evidence-refresh') return tx`SELECT c.product_id,c.last_outcome,c.binding_hash,s.state,s.source_url,s.normalized_facts,s.updated_at::text
    FROM evidence_source_claims c JOIN product_evidence_sources s ON s.slug=c.binding->>'slug' AND s.kind='documentation' AND s.source_key='canonical_site'
    WHERE c.updated_at BETWEEN ${from}::timestamptz AND ${to}::timestamptz AND c.last_outcome IN ('ok','failed') ORDER BY c.product_id`;
  if (job === 'reason-translate') return tx`SELECT source_hash,status,translated,model,attempts,updated_at::text FROM text_translations
    WHERE target_lang='ko' AND updated_at::timestamptz BETWEEN ${from}::timestamptz AND ${to}::timestamptz ORDER BY source_hash`;
  if (job === 'product-tagline-ko') return tx`SELECT to_jsonb(t) AS row FROM product_korean_taglines t
    WHERE updated_at::timestamptz BETWEEN ${from}::timestamptz AND ${to}::timestamptz ORDER BY product_id`;
  if (job === 'product-translate') return tx`SELECT product_id,locale,field,source_hash,status,text,error_code,attempts,updated_at::text FROM product_translations
    WHERE updated_at::timestamptz BETWEEN ${from}::timestamptz AND ${to}::timestamptz ORDER BY product_id,locale,field`;
  throw new Error('oracle_canary_job_unsupported');
}

/** Same principal/catalog/hash as the runtime preflight, read through the worker's own connection. */
async function workerAuthority(role: OracleCanaryRole) {
  const [row] = await db.execute<{ principal: string; sessionPrincipal: string; unsafe: boolean; privileges: unknown }>(sql`SELECT current_user AS principal,
    session_user AS "sessionPrincipal", ${ORACLE_UNSAFE_AUTHORITY_SQL} AS unsafe, ${ORACLE_PRIVILEGE_CATALOG_SQL} AS privileges
    FROM pg_roles r WHERE r.rolname=current_user`);
  const verified = row.unsafe === false && row.principal === row.sessionPrincipal
    && oracleDbPrivilegeMismatches(role, row.principal, row.privileges).length === 0;
  return { dbPrivileges: verified ? 'verified' as const : 'unknown' as const, dbRole: row.principal,
    effectivePrivilegeHash: hash({ principal: row.principal, privileges: row.privileges }) };
}

async function control(tx: Tx, identity: OracleCanaryIdentity) {
  const [principal] = await tx`SELECT current_user AS name`;
  if (principal.name !== ORACLE_DB_PRINCIPALS.attest) throw new Error('oracle_attest_principal_required');
  await tx`SET LOCAL TimeZone='UTC'`;
  const [row] = await tx`SELECT mode,epoch,policy,policy_hash AS "policyHash" FROM job_batch_control WHERE id=1 FOR SHARE`;
  const policy = batchPolicySchema.safeParse(row?.policy);
  if (!row || row.mode === 'draining' || !policy.success || batchPolicyHash(policy.data) !== row.policyHash || policy.data.release !== identity.release
    || !policy.data.instances.some(item => item.instanceId === identity.instanceId && item.host === HOST)) throw new Error('oracle_canary_batch_unavailable');
  const [clock] = await tx`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  return { epoch: Number(row.epoch), policyHash: String(row.policyHash), at: String(clock.at) };
}

async function httpParticipation(tx: Tx, identity: OracleCanaryIdentity, permits: boolean, window: Window, requireReleased: boolean) {
  const [row] = await tx`SELECT mode,policy,policy_hash AS "policyHash" FROM http_origin_control WHERE id=1`;
  const policy = httpOriginPolicySchema.safeParse(row?.policy);
  const [hops] = await tx`SELECT count(*) FILTER (WHERE state='released')::int AS released,
    count(*) FILTER (WHERE state IN ('reserved','dispatched','indeterminate'))::int AS open FROM http_origin_hops
    WHERE instance_id=${identity.instanceId} AND created_at BETWEEN ${window.from}::timestamptz AND ${window.to}::timestamptz`;
  return permits && row?.mode === 'open' && policy.success && httpOriginPolicyHash(policy.data) === row.policyHash
    && policy.data.instanceHosts[identity.instanceId] === HOST && hops.open === 0 && (!requireReleased || hops.released > 0)
    ? 'verified' as const : 'unknown' as const;
}

export type OracleCanaryAttestation = { ready: boolean; reason: string; job: string; requestedVersion: number; bootId: string;
  domainReadbackHash: string; readbackRows: number; anchorInvalidated: boolean;
  capability: { dbPrivileges: 'verified' | 'unknown'; http: 'verified' | 'unknown'; model: 'unknown' } };

/** One attest-principal TX: read the actual ACK and its domain rows, write strict capability/result evidence, and
 * delete an existing PR10d anchor that is not valid for the new tuple (restart/epoch/readback change). */
export async function attestOracleCanary(input: { identity: OracleCanaryIdentity; job: string; attest: postgres.Sql; permits: boolean;
  anchor: 'always' | 'if_stale'; bootId?: string }): Promise<OracleCanaryAttestation> {
  const { identity, job } = input;
  if (!batchJobsForRole(identity.role, 'versioned').includes(job)) throw new Error('oracle_canary_job_unsupported');
  const worker = await workerAuthority(identity.role);
  return input.attest.begin(async tx => {
    const state = await control(tx, identity);
    const resultKey = `batch-result:${identity.instanceId}:${job}`;
    const [observation] = await tx`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${resultKey}`;
    const result = observation?.result as Record<string, unknown> | null | undefined;
    if (!result || result.instanceId !== identity.instanceId || result.host !== HOST || result.release !== identity.release || result.job !== job
      || !Number.isSafeInteger(result.requestedVersion) || typeof result.recordedAt !== 'string') throw new Error('oracle_canary_result_missing');
    const age = Date.parse(state.at) - Date.parse(result.recordedAt);
    if (!Number.isFinite(age) || age < 0 || age > RESULT_MAX_AGE_MS) throw new Error('oracle_canary_result_stale');
    // The ACKed tick is the last claim of this job: its DB claim time opens the readback window.
    const [jobRow] = await tx`SELECT processed_version AS "processedVersion",lease_token AS "leaseToken",
      to_char(last_run_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startedAt" FROM jobs WHERE name=${job}`;
    if (!jobRow || Number(jobRow.processedVersion) !== result.requestedVersion || jobRow.leaseToken !== null || !jobRow.startedAt
      || Date.parse(jobRow.startedAt) > Date.parse(result.recordedAt)) throw new Error('oracle_canary_tick_window_unknown');
    const window = { from: String(jobRow.startedAt), to: String(result.recordedAt) };
    const rows = await domainReadback(tx, job, identity.instanceId, window);
    if (!rows.length) throw new Error('oracle_canary_domain_readback_empty');
    const domainReadbackHash = hash({ job, requestedVersion: result.requestedVersion, rows });
    const http = await httpParticipation(tx, identity, input.permits, window, HTTP_JOBS.has(job));
    const capability = batchCapabilitySchema.parse({ host: HOST, release: identity.release, instanceId: identity.instanceId,
      dbPrivileges: worker.dbPrivileges, dbRole: worker.dbRole, effectivePrivilegeHash: worker.effectivePrivilegeHash,
      http, model: 'unknown', observedAt: state.at });
    const [existing] = await tx`SELECT boot_id AS "bootId",host,release,policy_hash AS "policyHash",result_evidence AS "resultEvidence"
      FROM job_batch_candidates WHERE role=${identity.role} AND instance_id=${identity.instanceId} FOR UPDATE`;
    // Re-attesting the identical readback keeps its first observation, so a still-valid PR10d anchor stays bound to it.
    const stored = batchResultReadbackSchema.safeParse(existing?.resultEvidence);
    const readback = stored.success && stored.data.job === job && stored.data.instanceId === identity.instanceId && stored.data.host === HOST
      && stored.data.release === identity.release && stored.data.requestedVersion === result.requestedVersion
      && stored.data.domainReadbackHash === domainReadbackHash ? stored.data
      : batchResultReadbackSchema.parse({ job, instanceId: identity.instanceId, host: HOST, release: identity.release,
        requestedVersion: result.requestedVersion, domainReadbackHash, observedAt: state.at });
    const bootId = existing ? String(existing.bootId) : input.bootId ?? randomUUID();
    if (!existing) await tx`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
      VALUES(${identity.role},${identity.instanceId},${HOST},${bootId},${identity.release},${state.policyHash},${tx.json(capability)},${tx.json(readback)})`;
    else if (existing.host !== HOST || existing.release !== identity.release || existing.policyHash !== state.policyHash) throw new Error('oracle_canary_candidate_identity_mismatch');
    else await tx`UPDATE job_batch_candidates SET capability=${tx.json(capability)},result_evidence=${tx.json(readback)}
      WHERE role=${identity.role} AND instance_id=${identity.instanceId}`;
    const candidate: BatchCanaryCandidate = { role: identity.role, instanceId: identity.instanceId, host: HOST, bootId, release: identity.release,
      policyHash: state.policyHash, capability, resultEvidence: readback };
    const anchorKey = batchCanaryAnchorKey(identity.role, identity.instanceId), at = Date.parse(state.at);
    const [anchor] = await tx`SELECT value FROM operations_observations WHERE key=${anchorKey}`;
    let anchorInvalidated = false;
    if (anchor && (input.anchor === 'always' || !classifyBatchCandidateEvidence({ candidate, controlEpoch: state.epoch, at, anchor: anchor.value, latest: [] }).report.ready)) {
      // Exact compare-delete: a concurrently replaced anchor aborts the whole evidence write.
      const deleted = await tx`DELETE FROM operations_observations WHERE key=${anchorKey} AND value=${tx.json(anchor.value)} RETURNING key`;
      if (deleted.length !== 1) throw new Error('oracle_canary_anchor_changed');
      anchorInvalidated = true;
    }
    const { report } = classifyBatchCandidateEvidence({ candidate, controlEpoch: state.epoch, at,
      anchor: anchor && !anchorInvalidated ? anchor.value : undefined, latest: [{ key: resultKey, result }] });
    return { ...report, job, requestedVersion: Number(result.requestedVersion), bootId, domainReadbackHash, readbackRows: rows.length,
      anchorInvalidated, capability: { dbPrivileges: capability.dbPrivileges, http: capability.http, model: 'unknown' as const } };
  }) as Promise<OracleCanaryAttestation>;
}

/** Elect this boot through the normal batch admission and run exactly one direct tick of the job. */
export async function runOracleCanaryTick(identity: OracleCanaryIdentity, job: string, bootId: string): Promise<RunResult> {
  const lease = await tryAcquireRole({ role: identity.role, instanceId: identity.instanceId, bootId, release: identity.release,
    kind: 'primary', batchVersion: 1, host: HOST });
  return tick(lease, job);
}

/** First-ever ACK only: in legacy mode the job's own legacy parent role (a free lease; the M3/mini consumer must be
 * drained first) runs exactly one real tick. The existing legacy admission records it with the policy host. */
export async function runOracleLegacySeedTick(identity: OracleCanaryIdentity, job: string, bootId: string): Promise<RunResult> {
  const parent = JOB_CATALOG.find(entry => entry.name === job && entry.batchVersion !== 1)?.role;
  if (!batchJobsForRole(identity.role, 'versioned').includes(job) || !parent || !(JOB_ROLES as readonly string[]).includes(parent))
    throw new Error('oracle_canary_seed_unsupported');
  const lease = await tryAcquireRole({ role: parent as JobRole, instanceId: identity.instanceId, bootId, release: identity.release, kind: 'primary' });
  return tick(lease, job);
}

async function tick(lease: RoleLease | null, job: string): Promise<RunResult> {
  if (!lease) throw new Error('oracle_canary_role_not_elected');
  const keys = ['ROLE_LEASE_ROLE', 'ROLE_LEASE_INSTANCE_ID', 'ROLE_LEASE_BOOT_ID', 'ROLE_LEASE_RELEASE', 'ROLE_LEASE_EPOCH',
    'ROLE_LEASE_BATCH_VERSION', 'ROLE_LEASE_BATCH_EPOCH', 'ROLE_LEASE_HOST'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { ROLE_LEASE_ROLE: lease.role, ROLE_LEASE_INSTANCE_ID: lease.instanceId, ROLE_LEASE_BOOT_ID: lease.bootId,
    ROLE_LEASE_RELEASE: lease.release, ROLE_LEASE_EPOCH: String(lease.epoch),
    ...(lease.batchVersion === 1 ? { ROLE_LEASE_BATCH_VERSION: '1', ROLE_LEASE_BATCH_EPOCH: String(lease.batchEpoch), ROLE_LEASE_HOST: HOST } : {}) });
  let primary: unknown, run: RunResult | undefined;
  try { run = await runJob(job, JOBS[job], { roleLease: lease }); } catch (error) { primary = error; }
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  try { if (!await releaseRole(lease)) throw new Error('oracle_canary_role_release_failed'); }
  catch (cleanup) { if (primary !== undefined) throw new AggregateError([primary, cleanup], 'oracle_canary_tick_and_release_failed'); throw cleanup; }
  if (primary !== undefined) throw primary;
  return run!;
}

/** attest(latest) -> elect a new boot + one real tick -> attest(that tick). Both attestations drop the old anchor. */
export async function runOracleCanary(input: { identity: OracleCanaryIdentity; job: string; attest: postgres.Sql; permits: boolean }) {
  const before = await attestOracleCanary({ ...input, anchor: 'always' });
  if (!before.ready) return { before, run: null, after: null };
  const run = await runOracleCanaryTick(input.identity, input.job, randomUUID());
  if (run.status !== 'completed') return { before, run, after: null };
  const after = await attestOracleCanary({ ...input, anchor: 'always' });
  return { before, run, after };
}

/** Capability-only re-observation: result evidence and the PR10d anchor are left exactly as stored. */
export async function refreshOracleCapability(input: { identity: OracleCanaryIdentity; attest: postgres.Sql; permits: boolean }) {
  const worker = await workerAuthority(input.identity.role);
  return input.attest.begin(async tx => {
    const state = await control(tx, input.identity);
    const [candidate] = await tx`SELECT host,release,policy_hash AS "policyHash" FROM job_batch_candidates
      WHERE role=${input.identity.role} AND instance_id=${input.identity.instanceId} FOR UPDATE`;
    if (!candidate || candidate.host !== HOST || candidate.release !== input.identity.release || candidate.policyHash !== state.policyHash)
      throw new Error('oracle_canary_candidate_identity_mismatch');
    const [since] = await tx`SELECT to_char((clock_timestamp()-interval '15 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
    const http = await httpParticipation(tx, input.identity, input.permits, { from: String(since.at), to: state.at }, false);
    const capability = batchCapabilitySchema.parse({ host: HOST, release: input.identity.release, instanceId: input.identity.instanceId,
      dbPrivileges: worker.dbPrivileges, dbRole: worker.dbRole, effectivePrivilegeHash: worker.effectivePrivilegeHash,
      http, model: 'unknown', observedAt: state.at });
    await tx`UPDATE job_batch_candidates SET capability=${tx.json(capability)} WHERE role=${input.identity.role} AND instance_id=${input.identity.instanceId}`;
    return { dbPrivileges: capability.dbPrivileges, http: capability.http, model: capability.model, observedAt: state.at };
  });
}
