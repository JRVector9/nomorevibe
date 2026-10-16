import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ORACLE_DB_PRINCIPALS, ORACLE_DB_PROFILES, oracleDbGrantStatements, oracleDbPrivilegeMismatches, renderOracleDbGrantSql,
  type OracleDbService, type PrivilegeRow } from '@/lib/runtime/oracle-db-profile';

const services = Object.keys(ORACLE_DB_PRINCIPALS) as OracleDbService[];
function catalog(service: OracleDbService, extraTable?: string): PrivilegeRow[] {
  const tables = [...Object.keys(ORACLE_DB_PROFILES[service].tables), ...(extraTable ? [extraTable] : [])];
  return tables.map(table => {
    const grant = ORACLE_DB_PROFILES[service].tables[table] ?? {};
    const column = (kind: 'insert' | 'update', name: string) => grant[kind] === true || Array.isArray(grant[kind]) && (grant[kind] as readonly string[]).includes(name);
    const names = ['id', 'slug', 'product_id', 'cursor', 'updated_at', 'progress', 'host', 'boot_id', 'release', 'policy_hash', 'observed_at', 'capability', 'result_evidence', 'mode'];
    return { schema: 'public', table, select: Boolean(grant.select), insert: grant.insert === true, update: grant.update === true, delete: Boolean(grant.delete),
      columns: names.map(name => ({ name, select: Boolean(grant.select), insert: column('insert', name), update: column('update', name) })) };
  });
}

it('keeps the checked-in operator SQL byte-identical to the verified profile', () => {
  expect(readFileSync('deploy/oracle/least-privilege.sql', 'utf8')).toBe(renderOracleDbGrantSql());
});

it('accepts only the exact approved catalog for the exact principal', () => {
  for (const service of services) {
    expect(oracleDbPrivilegeMismatches(service, ORACLE_DB_PRINCIPALS[service], catalog(service))).toEqual([]);
    expect(oracleDbPrivilegeMismatches(service, 'nomorevibe', catalog(service))).toEqual(['principal']);
    expect(oracleDbPrivilegeMismatches(service, ORACLE_DB_PRINCIPALS[service], catalog(service, 'crawl_candidates').map(row =>
      row.table === 'crawl_candidates' ? { ...row, insert: true } : row))).toEqual(['public.crawl_candidates']);
    const missing = catalog(service).slice(1);
    expect(oracleDbPrivilegeMismatches(service, ORACLE_DB_PRINCIPALS[service], missing)).toEqual([`public.${catalog(service)[0].table}`]);
  }
  const widened = catalog('official-news').map(row => row.table === 'job_batch_candidates'
    ? { ...row, columns: row.columns.map(column => column.name === 'capability' ? { ...column, update: true } : column) } : row);
  expect(oracleDbPrivilegeMismatches('official-news', ORACLE_DB_PRINCIPALS['official-news'], widened)).toEqual(['public.job_batch_candidates']);
  expect(oracleDbPrivilegeMismatches('scheduler', ORACLE_DB_PRINCIPALS.scheduler, 'not-a-catalog')).toEqual(['catalog']);
});

it('never grants workers evidence updates, deletes or DDL, and keeps the attester away from runtime state', () => {
  for (const service of services.filter(service => service !== 'attest')) {
    const profile = ORACLE_DB_PROFILES[service];
    expect(Object.values(profile.tables).some(grant => grant.delete)).toBe(false);
    const candidate = profile.tables.job_batch_candidates;
    if (candidate) expect(candidate.update).toEqual(['host', 'boot_id', 'release', 'policy_hash', 'observed_at']);
    expect(oracleDbGrantStatements(service, { connectionLimit: 4 }).join('\n')).not.toMatch(/\b(CREATE ON|ALL PRIVILEGES|TRUNCATE|SUPERUSER |CREATEROLE |BYPASSRLS )/);
  }
  const attest = ORACLE_DB_PROFILES.attest.tables;
  expect(attest.job_batch_candidates.update).toEqual(['capability', 'result_evidence']);
  expect(Object.entries(attest).filter(([, grant]) => grant.insert || grant.update === true).map(([table]) => table)).toEqual(['job_batch_candidates']);
  expect(() => oracleDbGrantStatements('translation', { connectionLimit: 0 })).toThrow('invalid_connection_limit');
  expect(() => oracleDbGrantStatements('translation', { connectionLimit: ':x; DROP' as `:${string}` })).toThrow('invalid_connection_limit');
});
