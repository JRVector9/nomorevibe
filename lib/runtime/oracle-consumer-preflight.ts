import { z } from 'zod';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { serviceInstanceId } from '@/lib/operations/instance';
import { consumerInstancePrefix, consumerSpec, type ConsumerParentRole } from '@/lib/runtime/consumer-registry';
import { ORACLE_CONSUMER_DB_PROFILES, ORACLE_PRIVILEGE_CATALOG_SQL, ORACLE_UNSAFE_AUTHORITY_SQL, oracleConsumerPrivilegeMismatches,
  type OracleConsumerDbProfile } from '@/lib/runtime/oracle-db-profile';
import { oracleTimeoutsCheck } from '@/lib/runtime/oracle-preflight';
import { agentScanOracleReadiness } from '@/lib/domain/evidence/agents/oracle-readiness';

/**
 * Oracle consumer(건 단위 일꾼) 실행 전 점검. 읽기만 하고 아무것도 쓰지 않는다.
 *
 * 역할 preflight(oracle-preflight.ts)와 달리 batch versioned·canary·역할 admission 을 요구하지 않는다 — consumer 는 역할 lease 없이
 * claim 으로 같은 큐를 나눠 맡으므로 M3·mini 를 멈추는 versioned 전환이 필요 없다. 대신 다음을 모두 본다.
 * identity(<이름>-consumer- 인스턴스·Oracle host·40자 release·부모 역할), database(선언 프로필과 권한 정확 일치, 위험 권한 없음),
 * timeouts(역할 preflight 와 같은 경계), timezone(프로세스·계정 기본값·세션 모두 UTC — 운영 시각 열은 시간대 없는 UTC 라
 * 어긋나면 9시간 밀린다, 설계 R8), consumer(이름별 준비 확인 hook). 보고서 모양은 launcher 가 정확히 검사한다(launch.py).
 */
export type OracleConsumerCheck = { status: 'verified' | 'unknown' | 'rejected' | 'not_applicable'; reason: string; hash?: string };
export type OracleConsumerTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** consumer 별 준비 확인. 같은 repeatable read 트랜잭션에서 읽기만 한다. 확인할 수 없으면 unknown, 틀렸으면 rejected 다 */
export type OracleConsumerReadiness = (tx: OracleConsumerTx, context: { consumer: string; instanceId: string; principal: string })
  => Promise<{ status: 'verified' | 'unknown' | 'rejected'; reason: string }>;
/** 이름별 준비 확인. E5(agent-scan)·U2(uptime)가 더한다. 없는 consumer 는 Oracle 에서 열리지 않는다 */
export const ORACLE_CONSUMER_READINESS: Partial<Record<string, OracleConsumerReadiness>> = { 'agent-scan': agentScanOracleReadiness };
export type OracleConsumerSpec = { consumer: string; role: ConsumerParentRole; db: OracleConsumerDbProfile; readiness: OracleConsumerReadiness };

type CheckName = 'identity' | 'runtime' | 'host' | 'release' | 'database' | 'timeouts' | 'timezone' | 'budget' | 'consumer'
  | 'model' | 'batch' | 'admission';
export type OracleConsumerPreflightReport = {
  kind: 'nomorevibe-oracle-consumer-preflight'; version: 1; consumer: string; role: ConsumerParentRole;
  configuredHost: { tenancy: 'surfguide'; region: 'ap-osaka-1'; instance: 'osaka-smoke' };
  instanceId: string | null; releaseSha: string | null; ready: false; activationAllowed: false;
  workload: { ready: boolean; reason: string };
  checks: Record<CheckName, OracleConsumerCheck>;
};
/** launcher 가 consumer 실행에 verified 를 요구하는 항목. 나머지 host·release·budget·runtime 은 launcher 가 직접 확인한다 */
export const ORACLE_CONSUMER_REQUIRED = ['identity', 'database', 'timeouts', 'timezone', 'consumer'] as const;

const target = z.object({ consumer: z.string().min(1).max(40) }).strict();
const sessionSchema = z.object({ at: z.string().min(1), principal: z.string().min(1), sessionPrincipal: z.string().min(1),
  unsafe: z.boolean(), readOnly: z.boolean(), replica: z.boolean(), statementMs: z.coerce.number().finite(), lockMs: z.coerce.number().finite(),
  idleMs: z.coerce.number().finite(), timeZone: z.string(), privileges: z.unknown(), roleSettings: z.unknown() }).strict();
const UTC = new Set(['UTC', 'Etc/UTC']);
const unknown = (reason: string): OracleConsumerCheck => ({ status: 'unknown', reason });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * 계정 기본 TimeZone(pg_db_role_setting 의 current_user 행 {database, config}). ALTER ROLE ... IN DATABASE 가 ALTER ROLE 을 이긴다.
 * 없으면 null, 모양이 틀리면 undefined(둘 다 증거 아님). PgBouncer 가 새로 여는 서버 연결은 이 값으로 시작한다.
 */
export function oracleRoleTimeZone(value: unknown): string | null | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value as { database?: unknown; config?: unknown }[];
  if (rows.some(row => !row || typeof row.database !== 'boolean' || !Array.isArray(row.config))) return undefined;
  for (const row of [...rows].sort((a, b) => Number(b.database) - Number(a.database))) {
    for (const item of row.config as unknown[]) {
      if (typeof item !== 'string') return undefined;
      if (item.slice(0, item.indexOf('=')).toLowerCase() === 'timezone') return item.slice(item.indexOf('=') + 1);
    }
  }
  return null;
}
/** 프로세스(Node 가 시간대 없는 timestamp 를 읽는 기준)·계정 기본값(PgBouncer 서버 연결)·이 세션 셋 다 UTC 여야 verified 다 */
export function oracleTimeZoneCheck(processZone: string, roleSettings: unknown, sessionZone: string): OracleConsumerCheck {
  if (!UTC.has(processZone)) return { status: 'rejected', reason: 'process_timezone_not_utc' };
  const role = oracleRoleTimeZone(roleSettings);
  if (role === null || role === undefined) return unknown('role_timezone_unverified');
  if (!UTC.has(role)) return { status: 'rejected', reason: 'role_timezone_not_utc' };
  if (!UTC.has(sessionZone)) return { status: 'rejected', reason: 'session_timezone_not_utc' };
  return { status: 'verified', reason: 'process_role_session_utc' };
}

/** 등록된 consumer 이름으로 점검한다. 등록부·DB 프로필·준비 확인 중 하나라도 없으면 입력 오류다(launcher 는 닫힌다) */
export async function readOracleConsumerPreflight(input: unknown): Promise<OracleConsumerPreflightReport> {
  const parsed = target.safeParse(input);
  if (!parsed.success) throw new Error('invalid_oracle_preflight_input');
  const { consumer } = parsed.data, spec = consumerSpec(consumer);
  const profile = ORACLE_CONSUMER_DB_PROFILES[consumer], readiness = ORACLE_CONSUMER_READINESS[consumer];
  if (!spec || !profile || !readiness) throw new Error('invalid_oracle_preflight_input');
  return inspectOracleConsumer({ consumer, role: spec.role, db: profile, readiness });
}

/** Inspection only. No supplied attestation, heartbeat, or report is an execution capability. */
export async function inspectOracleConsumer(spec: OracleConsumerSpec): Promise<OracleConsumerPreflightReport> {
  // await 전에 필요한 값만 떠 둔다(역할 preflight 와 같다)
  const keys = ['PHYSICAL_HOST', 'SERVICE_INSTANCE_ID', 'RELEASE_TAG', 'DB_POOLER_MODE', 'WORKER_ROLE'] as const;
  const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const report: OracleConsumerPreflightReport = {
    kind: 'nomorevibe-oracle-consumer-preflight', version: 1, consumer: spec.consumer, role: spec.role,
    configuredHost: { tenancy: 'surfguide', region: 'ap-osaka-1', instance: 'osaka-smoke' },
    instanceId: null, releaseSha: null, ready: false, activationAllowed: false,
    workload: { ready: false, reason: 'identity_unknown' },
    checks: { identity: unknown('identity_unknown'), runtime: unknown('loaded_runtime_unverified'),
      host: unknown('oracle_host_metadata_unverified'), release: unknown('root_owned_release_unverified'),
      database: unknown('database_unobserved'), timeouts: unknown('timeouts_unobserved'), timezone: unknown('timezone_unobserved'),
      budget: unknown('aggregate_enforcement_unverified'), consumer: unknown('consumer_unobserved'),
      // consumer 는 모델 슬롯·batch·역할 admission 을 쓰지 않는다. 쓰는 consumer 가 생기면 이 자리를 바꾼다
      model: { status: 'not_applicable', reason: 'consumer_without_model_slot' },
      batch: { status: 'not_applicable', reason: 'consumer_without_batch' },
      admission: { status: 'not_applicable', reason: 'consumer_item_claims_only' } },
  };
  if (currentReplayDb()) { report.workload.reason = 'replay_unsupported'; return report; }
  let instance: string | null;
  try { instance = serviceInstanceId(env); } catch { return report; }
  const prefix = consumerInstancePrefix(spec.consumer);
  if (!instance || !instance.startsWith(prefix) || instance.length === prefix.length || !/^[a-f0-9]{40}$/.test(env.RELEASE_TAG ?? '')
    || env.PHYSICAL_HOST !== 'oracle-osaka-smoke' || env.WORKER_ROLE !== spec.role) return report;
  report.instanceId = instance; report.releaseSha = env.RELEASE_TAG!;
  report.checks.identity = { status: 'verified', reason: 'configured_identity_matches' };
  if (process.platform !== 'linux' || process.arch !== 'arm64' || !/^v24\./.test(process.version))
    report.checks.runtime = { status: 'rejected', reason: 'runtime_platform_mismatch' };
  return onPrimary(() => db.transaction(async tx => {
    const [rawSession] = await tx.execute(sql`SELECT clock_timestamp()::text AS at, current_user AS principal,
      session_user AS "sessionPrincipal", pg_is_in_recovery() AS replica,
      current_setting('transaction_read_only')='on' AS "readOnly",
      ${ORACLE_UNSAFE_AUTHORITY_SQL} AS unsafe,
      extract(epoch FROM current_setting('statement_timeout')::interval)*1000 AS "statementMs",
      extract(epoch FROM current_setting('lock_timeout')::interval)*1000 AS "lockMs",
      extract(epoch FROM current_setting('idle_in_transaction_session_timeout')::interval)*1000 AS "idleMs",
      current_setting('TimeZone') AS "timeZone",
      ${ORACLE_PRIVILEGE_CATALOG_SQL} AS privileges,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('database',s.setdatabase<>0,'config',to_jsonb(s.setconfig)) ORDER BY s.setdatabase),'[]'::jsonb)
        FROM pg_db_role_setting s WHERE s.setrole=r.oid
        AND s.setdatabase IN (0,(SELECT d.oid FROM pg_database d WHERE d.datname=current_database()))) AS "roleSettings"
      FROM pg_roles r WHERE r.rolname=current_user`);
    const session = sessionSchema.parse(rawSession);
    const privilegeHash = hash({ principal: session.principal, privileges: session.privileges });
    // 승인된 프로필과 정확히 같을 때만 verified 다. 남는 권한·빠진 권한은 모두 unknown 으로 닫힌다
    report.checks.database = oracleConsumerPrivilegeMismatches(spec.db, session.principal, session.privileges).length
      ? { ...unknown('approved_privilege_profile_unavailable'), hash: privilegeHash }
      : { status: 'verified', reason: 'approved_privilege_profile_matches', hash: privilegeHash };
    if (session.unsafe || session.readOnly || session.replica || session.principal !== session.sessionPrincipal) {
      report.checks.database = { status: 'rejected', reason: 'database_authority_rejected' };
      report.workload.reason = 'database_rejected'; return report;
    }
    report.checks.timeouts = oracleTimeoutsCheck(env.DB_POOLER_MODE === 'pgbouncer', session.roleSettings, session);
    if (report.checks.timeouts.status === 'rejected') { report.workload.reason = 'timeouts_rejected'; return report; }
    report.checks.timezone = oracleTimeZoneCheck(processZone, session.roleSettings, session.timeZone);
    if (report.checks.timezone.status === 'rejected') { report.workload.reason = 'timezone_rejected'; return report; }
    report.checks.consumer = await spec.readiness(tx, { consumer: spec.consumer, instanceId: instance, principal: session.principal });
    const open = ORACLE_CONSUMER_REQUIRED.find(name => report.checks[name].status !== 'verified');
    report.workload = open ? { ready: false, reason: `${open}_${report.checks[open].status}` } : { ready: true, reason: 'ready' };
    return report;
  }, { isolationLevel: 'repeatable read' }));
}
