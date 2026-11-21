import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { readTextStageProgress, resetTextReasonProgressForTest, TEXT_REASON_MAX_AGE_MS, TEXT_REASON_RETRY_MS, TEXT_REASON_REUSE_MS,
  warmTextReasonProgress } from '@/lib/operations/text-stage-progress';

type Group = 'reason' | 'other';
const fixture = vi.hoisted(() => ({ transactions: [] as Array<{ group: Group | null; config: unknown; statements: string[] }>,
  failure: {} as Partial<Record<Group | 'home', unknown>>, waiting: 3, hold: null as Promise<void> | null,
  warn: [] as Array<{ event: string; fields: unknown }>, stdout: [] as string[] }));
vi.mock('@/lib/db', () => ({ db: {
  transaction: async (load: (tx: { execute(query: SQL): Promise<unknown> }) => Promise<unknown>, config: unknown) => {
    const record = { group: null as Group | null, config, statements: [] as string[] }; fixture.transactions.push(record);
    return load({ execute: async query => {
      const compiled = new PgDialect().sqlToQuery(query).sql;
      record.statements.push(compiled);
      if (compiled.startsWith('SET ')) return [];
      const group: Group = compiled.includes("WHERE key='reason-translate'") ? 'reason' : 'other';
      record.group = group;
      if (fixture.hold) await fixture.hold;
      if (fixture.failure[group]) throw fixture.failure[group];
      return group === 'reason'
        ? [{ key: 'reason-translate', waiting: fixture.waiting, oldest: '120', completed: 0, errors: 0, deferred: 0, blocked: 0, provider_errors: 0, error_age: null }]
        : [{ key: 'intro-check', waiting: 1, oldest: '20', completed: 2, errors: 0, deferred: 0, blocked: 0, provider_errors: 0, error_age: null }];
    } });
  },
} }));
vi.mock('@/lib/domain/products/korean-taglines', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/domain/products/korean-taglines')>(),
  homeListSlugs: async () => { if (fixture.failure.home) throw fixture.failure.home; return []; },
}));

const START = Date.parse('2026-11-21T00:00:00.000Z');
// drizzle 이 감싼 드라이버 오류 꼴 — message 에 SQL 본문과 입력값이 들어 있다
const deadline = () => Object.assign(new Error('Failed query: select secret_body from t where token = $1\nparams: hunter2'),
  { cause: Object.assign(new Error('canceling statement due to statement timeout'), { name: 'PostgresError', code: '57014' }) });
const reads = (group: Group) => fixture.transactions.filter(tx => tx.group === group).length;
const stage = (rows: Awaited<ReturnType<typeof readTextStageProgress>>, key: string) => rows.find(row => row.key === key)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(START);
  resetTextReasonProgressForTest();
  fixture.transactions.length = 0; fixture.failure = {}; fixture.waiting = 3; fixture.hold = null; fixture.warn.length = 0; fixture.stdout.length = 0;
  // 조각 실패 줄은 stderr 로만 간다 — 관문 스크립트의 stdout 은 보고 JSON 한 줄이어야 한다(배포 도구가 stdout 전체를 JSON 으로 읽는다)
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    const { ts, level, event, ...fields } = JSON.parse(String(chunk)) as { ts: string; level: string; event: string };
    expect(level).toBe('warn'); expect(Number.isNaN(Date.parse(ts))).toBe(false);
    fixture.warn.push({ event, fields }); return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { fixture.stdout.push(String(chunk)); return true; });
});
afterEach(() => { expect(fixture.stdout).toEqual([]); vi.restoreAllMocks(); vi.useRealTimers(); });

it('merges exact reason and other queues from separate bounded read-only statements', async () => {
  const rows = await readTextStageProgress();
  expect(rows).toHaveLength(7);
  expect(stage(rows, 'reason-translate')).toMatchObject({ waiting: 3, oldestMinutes: 120, measuredAgeSeconds: 0 });
  expect(stage(rows, 'intro-check')).toMatchObject({ waiting: 1, completed5m: 2 });
  expect(rows.some(row => row.unread)).toBe(false);
  // 가벼운 other(3초·32MB)를 먼저, 무거운 reason(20초·256MB — 해시 집계 약 90MB 가 임시 파일로 흐르지 않게)을 맨 뒤에
  expect(fixture.transactions.map(tx => tx.group)).toEqual(['other', 'reason']);
  for (const tx of fixture.transactions) {
    expect(tx.config).toEqual({ accessMode: 'read only' });
    expect(tx.statements).toContain(tx.group === 'reason' ? "SET LOCAL statement_timeout = '20s'" : "SET LOCAL statement_timeout = '3s'");
    expect(tx.statements).toContain(tx.group === 'reason' ? "SET LOCAL work_mem = '256MB'" : "SET LOCAL work_mem = '32MB'");
  }
});

it('does not count the reason group again for five minutes and reports how old the reused value is', async () => {
  await readTextStageProgress();
  fixture.waiting = 9;
  vi.setSystemTime(START + TEXT_REASON_REUSE_MS - 1_000);
  const reused = await readTextStageProgress();
  expect(reads('reason')).toBe(1);
  // 그 밖 그룹은 지금처럼 매번 읽는다
  expect(reads('other')).toBe(2);
  expect(stage(reused, 'reason-translate')).toMatchObject({ waiting: 3, measuredAgeSeconds: 299 });
  expect(stage(reused, 'intro-check').measuredAgeSeconds).toBeUndefined();
  vi.setSystemTime(START + TEXT_REASON_REUSE_MS);
  const recounted = await readTextStageProgress();
  expect(reads('reason')).toBe(2);
  expect(stage(recounted, 'reason-translate')).toMatchObject({ waiting: 9, measuredAgeSeconds: 0 });
});

it('keeps the other stages judged when the reason group fails, and names only the piece and SQLSTATE', async () => {
  fixture.failure.reason = deadline();
  const rows = await readTextStageProgress();
  expect(rows).toHaveLength(7);
  expect(stage(rows, 'reason-translate')).toEqual({ key: 'reason-translate', enabled: true, waiting: 0, oldestMinutes: null, completed5m: 0,
    progress5m: 0, errors5m: 0, unread: { piece: 'text-reason', code: '57014' } });
  expect(stage(rows, 'intro-check')).toMatchObject({ waiting: 1, completed5m: 2 });
  expect(rows.filter(row => row.unread).map(row => row.key)).toEqual(['reason-translate']);
  expect(fixture.warn).toEqual([{ event: 'progress.piece_failed', fields: { piece: 'text-reason', code: '57014' } }]);
  expect(JSON.stringify(fixture.warn)).not.toMatch(/secret_body|hunter2|Failed query/);
});

it('keeps the reason stage judged when the other group or the home list fails', async () => {
  fixture.failure.other = deadline();
  const rows = await readTextStageProgress();
  expect(stage(rows, 'reason-translate')).toMatchObject({ waiting: 3, oldestMinutes: 120 });
  expect(stage(rows, 'reason-translate').unread).toBeUndefined();
  expect(rows.filter(row => row.unread)).toHaveLength(6);
  expect(stage(rows, 'intro-check').unread).toEqual({ piece: 'text-other', code: '57014' });
  fixture.failure = { home: Object.assign(new Error('pool'), { name: 'DbPoolWaitTimeoutError', code: 'DB_POOL_WAIT_TIMEOUT' }) };
  const withoutHome = await readTextStageProgress();
  expect(stage(withoutHome, 'tagline-ko').unread).toEqual({ piece: 'text-other', code: 'DB_POOL_WAIT_TIMEOUT' });
  expect(stage(withoutHome, 'reason-translate').unread).toBeUndefined();
});

it('reuses the last counted value with its age while the reason read keeps failing, then reports unknown past the age limit', async () => {
  await readTextStageProgress();
  fixture.failure.reason = deadline();
  vi.setSystemTime(START + TEXT_REASON_REUSE_MS);
  const stale = await readTextStageProgress();
  expect(reads('reason')).toBe(2);
  expect(stage(stale, 'reason-translate')).toMatchObject({ waiting: 3, measuredAgeSeconds: 300 });
  expect(stage(stale, 'reason-translate').unread).toBeUndefined();
  // 실패한 뒤 1분은 다시 시도하지 않는다
  vi.setSystemTime(START + TEXT_REASON_REUSE_MS + TEXT_REASON_RETRY_MS - 1);
  await readTextStageProgress();
  expect(reads('reason')).toBe(2);
  vi.setSystemTime(START + TEXT_REASON_REUSE_MS + TEXT_REASON_RETRY_MS);
  await readTextStageProgress();
  expect(reads('reason')).toBe(3);
  vi.setSystemTime(START + TEXT_REASON_MAX_AGE_MS);
  expect(stage(await readTextStageProgress(), 'reason-translate')).toMatchObject({ waiting: 3, measuredAgeSeconds: 900 });
  // 15분보다 낡은 값으로 정상이라 말하지 않는다 — 그 단계만 모름, 원인은 마지막 실패
  vi.setSystemTime(START + TEXT_REASON_MAX_AGE_MS + 1);
  const expired = await readTextStageProgress();
  expect(stage(expired, 'reason-translate').unread).toEqual({ piece: 'text-reason', code: '57014' });
  expect(stage(expired, 'reason-translate').measuredAgeSeconds).toBeUndefined();
  expect(stage(expired, 'intro-check')).toMatchObject({ waiting: 1 });
  // 다시 읽히면 곧바로 돌아온다
  fixture.failure = {}; fixture.waiting = 5;
  vi.setSystemTime(START + TEXT_REASON_MAX_AGE_MS + TEXT_REASON_RETRY_MS + 5_000);
  expect(stage(await readTextStageProgress(), 'reason-translate')).toMatchObject({ waiting: 5, measuredAgeSeconds: 0 });
});

it('reads nothing heavy in reuse-only mode and reports an uncounted or stale value as unknown', async () => {
  const cold = await readTextStageProgress({ reuseReasonOnly: true });
  expect(reads('reason')).toBe(0);
  expect(stage(cold, 'reason-translate').unread).toEqual({ piece: 'text-reason', code: 'not_read' });
  await warmTextReasonProgress();
  expect(reads('reason')).toBe(1);
  // 5분이 지나도 여기서는 다시 세지 않는다(따로 warm 을 부르는 호출자의 몫) — 15분까지는 나이와 함께 쓴다
  vi.setSystemTime(START + TEXT_REASON_REUSE_MS + 30_000);
  expect(stage(await readTextStageProgress({ reuseReasonOnly: true }), 'reason-translate')).toMatchObject({ waiting: 3, measuredAgeSeconds: 330 });
  expect(reads('reason')).toBe(1);
  vi.setSystemTime(START + TEXT_REASON_MAX_AGE_MS + 1);
  expect(stage(await readTextStageProgress({ reuseReasonOnly: true }), 'reason-translate').unread).toEqual({ piece: 'text-reason', code: 'stale' });
});

it('counts once for concurrent callers and never throws from the warm-up', async () => {
  let release!: () => void;
  fixture.hold = new Promise<void>(resolve => { release = resolve; });
  const pending = [warmTextReasonProgress(), warmTextReasonProgress(), warmTextReasonProgress()];
  release();
  await Promise.all(pending);
  expect(reads('reason')).toBe(1);
  fixture.hold = null; fixture.failure.reason = new Error('boom');
  vi.setSystemTime(START + TEXT_REASON_REUSE_MS);
  await expect(warmTextReasonProgress()).resolves.toBeUndefined();
  expect(fixture.warn).toEqual([{ event: 'progress.piece_failed', fields: { piece: 'text-reason', code: 'Error' } }]);
});
