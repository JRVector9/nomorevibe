import { expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';
import { dbErrorPrefix, dbErrorTag, isDbDeadlock } from '@/lib/db/error-fields';

// postgres.js 의 PostgresError 모양(name·code 와 서버 필드 이름 그대로)
const pg = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.message ?? 'server error')), { name: 'PostgresError', ...fields });
const wrapped = (cause: unknown) => new DrizzleQueryError('select "name" from "jobs" where "jobs"."name" = $1 for share', ['second-review'], cause as Error);

it('reads the SQLSTATE through the drizzle wrapper that hides it in the message', () => {
  const deadlock = wrapped(pg({ code: '40P01', message: 'deadlock detected', detail: 'Process 1 waits for ShareLock on transaction 2' }));
  expect(deadlock.message).not.toContain('40P01');
  expect(dbErrorTag(deadlock)).toEqual({ code: '40P01', table: null, constraint: null });
  expect(dbErrorPrefix(dbErrorTag(deadlock))).toBe('[40P01] ');
  expect(isDbDeadlock(deadlock)).toBe(true);
});

it('names the table and constraint but never the detail or key values', () => {
  const tag = dbErrorTag(wrapped(pg({ code: '23505', table_name: 'jobs', constraint_name: 'jobs_pkey', schema_name: 'public',
    detail: 'Key (name)=(secret-value) already exists.' })));
  expect(tag).toEqual({ code: '23505', table: 'jobs', constraint: 'jobs_pkey' });
  expect(dbErrorPrefix(tag)).toBe('[23505 table=jobs constraint=jobs_pkey] ');
  expect(JSON.stringify(tag)).not.toContain('secret-value');
  // 식별자 모양이 아니면 싣지 않는다
  expect(dbErrorTag(pg({ code: '23514', table_name: 'odd name"; drop', constraint_name: 'x'.repeat(80) })))
    .toEqual({ code: '23514', table: null, constraint: null });
});

it('ignores system, pool and application error codes', () => {
  for (const error of [Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), new Error('job_lease_lost'), 'boom', null,
    wrapped(undefined)]) {
    expect(dbErrorTag(error)).toBeNull();
    expect(dbErrorPrefix(dbErrorTag(error))).toBe('');
    expect(isDbDeadlock(error)).toBe(false);
  }
  expect(isDbDeadlock(wrapped(pg({ code: '55P03', message: 'lock timeout' })))).toBe(false);
});
