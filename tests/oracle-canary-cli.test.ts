import { expect, it, vi } from 'vitest';
import { oracleCanaryIdentity } from '@/lib/runtime/oracle-canary';
import { oracleCanaryMain } from '@/lib/runtime/oracle-canary-cli';
import { oracleSchedulerIdentity } from '@/lib/runtime/oracle-scheduler-evidence';

const env = { JOB_BATCH_VERSION: '1', PHYSICAL_HOST: 'oracle-osaka-smoke', SERVICE_INSTANCE_ID: 'oracle-news', RELEASE_TAG: 'a'.repeat(40),
  DATABASE_URL: 'postgres://worker@db/x', ORACLE_ATTEST_DATABASE_URL: 'postgres://attest@db/x' };
function deps(identity = true) {
  const lines: string[] = [];
  return { lines, identity: vi.fn(() => identity), connect: vi.fn(() => { throw new Error('no database in this unit'); }), write: (line: string) => lines.push(line) };
}

it('accepts only the exact Oracle canary identity', () => {
  expect(oracleCanaryIdentity('official-news', env)).toEqual({ role: 'official-news', instanceId: 'oracle-news', release: 'a'.repeat(40) });
  for (const [role, change] of [['scheduler', {}], ['crawler', {}], ['official-news', { PHYSICAL_HOST: 'm3' }], ['official-news', { JOB_BATCH_VERSION: undefined }],
    ['official-news', { RELEASE_TAG: 'main' }], ['official-news', { SERVICE_INSTANCE_ID: 'bad id' }]] as const)
    expect(() => oracleCanaryIdentity(role, { ...env, ...change })).toThrow('oracle_canary_identity_invalid');
});

it('refuses before any database connection without separate attest credentials, arguments or a matching OCI identity', async () => {
  const cases: Array<[string[], Record<string, string | undefined>, boolean, string]> = [
    [['canary', '--role=official-news'], env, true, 'oracle_canary_arguments_invalid'],
    [['canary', '--role=official-news', '--job=news-refresh', '--force'], env, true, 'oracle_canary_arguments_invalid'],
    [['canary', '--role=official-news', '--job=news-refresh'], { ...env, ORACLE_ATTEST_DATABASE_URL: env.DATABASE_URL }, true, 'oracle_canary_arguments_invalid'],
    [['canary', '--role=official-news', '--job=news-refresh'], { ...env, ORACLE_ATTEST_DATABASE_URL: undefined }, true, 'oracle_canary_arguments_invalid'],
    [['attest', '--role=official-news', '--job=news-refresh'], { ...env, PHYSICAL_HOST: 'mini' }, true, 'oracle_canary_identity_invalid'],
    [['refresh', '--role=official-news'], env, false, 'oracle_identity_unverified'],
  ];
  for (const [args, values, identity, code] of cases) {
    const dependency = deps(identity);
    expect(await oracleCanaryMain(args, values, dependency)).toBe(78);
    expect(dependency.lines).toEqual([JSON.stringify({ code })]);
    expect(dependency.connect).not.toHaveBeenCalled();
  }
});

it('accepts bootstrap only with an explicit role and job and still refuses before any database connection', async () => {
  for (const [args, values, identity, code] of [
    [['bootstrap', '--role=site-evidence'], env, true, 'oracle_canary_arguments_invalid'],
    [['bootstrap', '--role=site-evidence', '--job=product-site-evidence-refresh', '--skip-grant'], env, true, 'oracle_canary_arguments_invalid'],
    [['bootstrap', '--role=site-evidence', '--job=product-site-evidence-refresh'], { ...env, ORACLE_ATTEST_DATABASE_URL: undefined }, true, 'oracle_canary_arguments_invalid'],
    [['bootstrap', '--role=site-evidence', '--job=product-site-evidence-refresh'], env, false, 'oracle_identity_unverified'],
  ] as Array<[string[], Record<string, string | undefined>, boolean, string]>) {
    const dependency = deps(identity);
    expect(await oracleCanaryMain(args, values, dependency)).toBe(78);
    expect(dependency.lines).toEqual([JSON.stringify({ code })]); expect(dependency.connect).not.toHaveBeenCalled();
  }
});

it('accepts only scheduler canary and attest without a job and still refuses before any database connection', async () => {
  const scheduler = { ...env, SERVICE_INSTANCE_ID: 'oracle-scheduler' };
  expect(oracleSchedulerIdentity(scheduler)).toEqual({ instanceId: 'oracle-scheduler', release: 'a'.repeat(40) });
  for (const change of [{ PHYSICAL_HOST: 'm3' }, { JOB_BATCH_VERSION: undefined }, { RELEASE_TAG: 'main' }, { SERVICE_INSTANCE_ID: 'bad id' }])
    expect(() => oracleSchedulerIdentity({ ...scheduler, ...change })).toThrow('oracle_scheduler_identity_invalid');
  const invalid = 'oracle_canary_arguments_invalid';
  for (const [args, values, identity, code] of [
    [['canary', '--role=scheduler', '--job=heartbeat'], scheduler, true, invalid],
    [['refresh', '--role=scheduler'], scheduler, true, invalid],
    [['seed', '--role=scheduler'], scheduler, true, invalid],
    [['bootstrap', '--role=scheduler'], scheduler, true, invalid],
    [['recanary', '--role=scheduler'], scheduler, true, invalid],
    [['canary', '--role=scheduler'], { ...scheduler, ORACLE_ATTEST_DATABASE_URL: undefined }, true, invalid],
    [['canary', '--role=scheduler'], { ...scheduler, PHYSICAL_HOST: 'mini' }, true, 'oracle_canary_identity_invalid'],
    [['canary', '--role=scheduler'], scheduler, false, 'oracle_identity_unverified'],
    [['attest', '--role=scheduler'], scheduler, false, 'oracle_identity_unverified'],
  ] as Array<[string[], Record<string, string | undefined>, boolean, string]>) {
    const dependency = deps(identity);
    expect(await oracleCanaryMain(args, values, dependency)).toBe(78);
    expect(dependency.lines).toEqual([JSON.stringify({ code })]); expect(dependency.connect).not.toHaveBeenCalled();
  }
});
