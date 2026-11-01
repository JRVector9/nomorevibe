import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { discoveryHash } from '@/lib/crawl/discovery-checkpoint-contract';
import { ORACLE_CONSUMER_DB_PROFILES, oracleConsumerGrantStatements } from '@/lib/runtime/oracle-db-profile';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const profile = ORACLE_CONSUMER_DB_PROFILES['github-ko-discovery']!;
const password = randomUUID(), subject = discoveryHash(`int-discovery-rls-${password}`), hash = discoveryHash('config');
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
let oracle: postgres.Sql | undefined, created = false;
beforeAll(async () => {
  ensureSchema();
  expect(await admin`SELECT 1 FROM pg_roles WHERE rolname=${profile.principal}`).toHaveLength(0);
  for (const statement of oracleConsumerGrantStatements(profile, { connectionLimit: 2 })) await admin.unsafe(statement);
  created = true;
  await admin.unsafe(`ALTER ROLE ${profile.principal} PASSWORD '${password}'`);
  const url = new URL(TEST_DATABASE_URL); url.username = profile.principal; url.password = password;
  oracle = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  await admin`INSERT INTO discovery_checkpoints(source,subject,slot,generation,semantic,intent)
    VALUES('github-full',${subject},127,${hash},${hash},'ready')`;
});
afterAll(async () => {
  try {
    await oracle?.end({ timeout: 5 });
    await admin`DELETE FROM discovery_checkpoints WHERE subject=${subject}`;
    if (created) { await admin.unsafe(`DROP OWNED BY ${profile.principal}`); await admin.unsafe(`DROP ROLE ${profile.principal}`); }
  } finally { await admin.end({ timeout: 5 }); }
});
const code = (promise: Promise<unknown>) => promise.then(() => 'allowed', (error: { code?: string }) => error.code);

it('permits only Korean query/shared/language receipts and no home cursor, apply, key update or delete', async () => {
  const session = oracle!;
  for (const source of ['korean-query', 'korean-shared', 'korean-language']) {
    await session`INSERT INTO discovery_checkpoints(source,subject,slot,generation,semantic,intent)
      VALUES(${source},${subject},127,${hash},${hash},'ready')
      ON CONFLICT(source,subject) DO UPDATE SET semantic=excluded.semantic,recorded_at=clock_timestamp()`;
  }
  for (const source of ['github-full', 'github-latest', 'show-hn', 'korean-apply'])
    expect(await code(session`INSERT INTO discovery_checkpoints(source,subject,slot,generation,semantic,intent)
      VALUES(${source},${discoveryHash(source)},126,${hash},${hash},'ready')`), source).toBe('42501');
  expect((await session`SELECT source FROM discovery_checkpoints WHERE subject=${subject} ORDER BY source`).map(row => row.source))
    .toEqual(['korean-language', 'korean-query', 'korean-shared']);
  expect(await session`UPDATE discovery_checkpoints SET intent='no_work' WHERE source='github-full' AND subject=${subject} RETURNING source`).toHaveLength(0);
  expect(await code(session`UPDATE discovery_checkpoints SET source='github-full' WHERE subject=${subject}`)).toBe('42501');
  expect(await code(session`UPDATE discovery_checkpoints SET subject=${hash} WHERE subject=${subject}`)).toBe('42501');
  expect(await code(session`UPDATE discovery_checkpoints SET slot=126 WHERE subject=${subject}`)).toBe('42501');
  expect(await code(session`DELETE FROM discovery_checkpoints WHERE subject=${subject}`)).toBe('42501');
  expect(await code(session`INSERT INTO discovery_checkpoints(source,subject,slot,generation,semantic,intent)
    VALUES('korean-query',${discoveryHash('out-of-bounds')},128,${hash},${hash},'ready')`)).toBe('23514');
  expect(await code(session`INSERT INTO discovery_checkpoints(source,subject,slot,generation,semantic,intent)
    VALUES('korean-query',${discoveryHash('duplicate-slot')},127,${hash},${hash},'ready')`)).toBe('23505');
});
