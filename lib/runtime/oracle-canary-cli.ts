/**
 * Operator entry for the Oracle canary. Run on osaka-smoke with the role's worker env file (DATABASE_URL is the role's
 * least-privilege principal) plus ORACLE_ATTEST_DATABASE_URL for the separate attest principal, e.g.
 *   node --import tsx lib/runtime/oracle-canary-cli.ts canary --role=official-news --job=news-refresh
 * Commands: canary (attest latest -> one elected real tick -> attest it), attest (latest ACK only), refresh (capability only),
 * seed (first-ever ACK: one real tick under the drained legacy parent role while job_batch_control is legacy).
 * The OCI identity record must match IMDS first; there is no flag that skips it.
 */
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { attestOracleCanary, oracleCanaryIdentity, refreshOracleCapability, runOracleCanary, runOracleLegacySeedTick } from './oracle-canary';

const APPROVED_IDENTITY = '/etc/nomorevibe-core/oracle-identity.json';
type Dependencies = { identity: () => boolean; connect: (url: string) => postgres.Sql; write: (line: string) => void };
const defaults: Dependencies = {
  identity: () => spawnSync('python3', ['deploy/oracle/oci_identity.py', '--approved', APPROVED_IDENTITY],
    { stdio: ['ignore', 'ignore', 'ignore'], timeout: 15_000 }).status === 0,
  connect: url => postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'nomorevibe:oracle-attest' } }),
  write: line => { process.stdout.write(`${line}\n`); },
};

/** 0 = evidence written and ready, 2 = written/inspected but not ready, 78 = refused before any DB write. */
export async function oracleCanaryMain(args: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Dependencies = defaults): Promise<number> {
  const [command, ...options] = args;
  const value = (name: string) => options.find(option => option.startsWith(`--${name}=`))?.slice(name.length + 3);
  const role = value('role') ?? '', job = value('job') ?? '';
  const expected = command === 'refresh' ? 1 : 2;
  if (!['canary', 'attest', 'refresh', 'seed'].includes(command ?? '') || options.length !== expected || !role || (command !== 'refresh' && !job)
    || !env.ORACLE_ATTEST_DATABASE_URL || env.ORACLE_ATTEST_DATABASE_URL === env.DATABASE_URL) {
    dependencies.write(JSON.stringify({ code: 'oracle_canary_arguments_invalid' })); return 78;
  }
  let identity;
  try { identity = oracleCanaryIdentity(role, env); } catch { dependencies.write(JSON.stringify({ code: 'oracle_canary_identity_invalid' })); return 78; }
  if (!dependencies.identity()) { dependencies.write(JSON.stringify({ code: 'oracle_identity_unverified' })); return 78; }
  const attest = dependencies.connect(env.ORACLE_ATTEST_DATABASE_URL);
  const permits = env.HTTP_ORIGIN_PERMITS === '1';
  try {
    if (command === 'seed') {
      const run = await runOracleLegacySeedTick(identity, job, randomUUID());
      dependencies.write(JSON.stringify({ seed: run })); return run.status === 'completed' ? 0 : 2;
    }
    if (command === 'refresh') { dependencies.write(JSON.stringify({ refresh: await refreshOracleCapability({ identity, attest, permits }) })); return 0; }
    if (command === 'attest') {
      const result = await attestOracleCanary({ identity, job, attest, permits, anchor: 'if_stale' });
      dependencies.write(JSON.stringify({ attest: result })); return result.ready ? 0 : 2;
    }
    const result = await runOracleCanary({ identity, job, attest, permits });
    dependencies.write(JSON.stringify({ canary: result })); return result.after?.ready ? 0 : 2;
  } finally { await attest.end({ timeout: 5 }); }
}

if (process.argv[1] && /^oracle-canary-cli\.[cm]?[jt]s$/.test(basename(process.argv[1]))) {
  void oracleCanaryMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    // Only a fixed code and our own error code are printed; never a URL, SQL or env value.
    process.stdout.write(`${JSON.stringify({ code: 'oracle_canary_failed', reason: error instanceof Error && /^oracle_[a-z_]+$/.test(error.message) ? error.message : 'error' })}\n`);
    process.exitCode = 1;
  }).finally(() => (globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }));
}
