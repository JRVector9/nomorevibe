import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/*
 * PR06e 실제 AI2 consumer 진입점(scripts/pipeline-consumer.ts)이 HOST_BUDGET_ENFORCEMENT 에서 거절하지 않고 worker 와 같은 host 장부에
 * 자리를 얻고(DB 시계 lease) 갱신하며, 종료 신호에 자기 행만 지운다. host 가 미루면(이 instance 는 HTTP 장부에 매핑되지 않음)
 * 대기 표가 있어도 claim·item lease·실패 기록이 없다. 꺼져 있으면 장부·DB·출력이 바뀌지 않는다.
 * 자식은 최소 env 만 받는다 — 모델 주소는 닫힌 로컬 포트다.
 */
type Raw = Record<string, unknown>;
const marker = `pr06e-host-${randomUUID().slice(0, 8)}`, RELEASE = 'pr06e-host-fixture', instance = `ai2-consumer-${marker}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const children = new Set<() => Promise<void>>();
const fixture = { candidates: [] as number[], votes: [] as number[] };
let baseline: Record<string, Raw[]>;
const relaxed = { maxLoadPerCpu: 1_000, maxHostRssBytes: 2 ** 40, maxEventLoopDelayMs: 60_000, maxHeartbeatGapMs: 60_000 };

async function whole(): Promise<Record<string, Raw[]>> {
  const result: Record<string, Raw[]> = {};
  for (const { tablename } of await admin`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await admin.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  }
  return result;
}
function environment(enforced: boolean): NodeJS.ProcessEnv {
  const policy = { version: 1, host: 'mini', release: RELEASE, roles: ['reviewer'], reviewerConsumers: ['ai2'], schedulerReplicas: 0,
    webReplicas: 0, webReadReplica: false, monitor: false, connectAgent: false, preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
  return { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LOG_LEVEL: 'info',
    ABCLLM_BASE_URL: 'http://127.0.0.1:9', DATABASE_URL: TEST_DATABASE_URL, DB_POOLER_MODE: 'direct', DB_STATEMENT_TIMEOUT_MS: '5000',
    DB_LOCK_TIMEOUT_MS: '2000', WORKER_ROLE: 'reviewer', PHYSICAL_HOST: 'mini', RELEASE_TAG: RELEASE, SERVICE_INSTANCE_ID: instance,
    PIPELINE_ITEM_CONSUMER_VERSION: '1', PIPELINE_ITEM_CONSUMER_INSTANCE_ID: instance,
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy, process: { kind: 'worker', role: 'reviewer', consumer: 'ai2', host: 'mini', release: RELEASE, replica: 1, copy: 1 } }),
    ...(enforced ? { HOST_BUDGET_ENFORCEMENT: JSON.stringify({ mode: 'enabled', pressure: relaxed }), HTTP_ORIGIN_PERMITS: '1' } : {}) };
}
function consumer(env: NodeJS.ProcessEnv, once: boolean) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/pipeline-consumer.ts', '--stage=ai2', ...(once ? ['--once'] : [])],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-65_536); });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8_192); });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  children.add(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  return { child, closed, output: () => ({ stdout, stderr }) };
}
const ledger = () => admin<{ key: string; value: Raw }[]>`SELECT key, value FROM operations_observations WHERE key LIKE 'host-slot:mini:%' ORDER BY key`;
async function pendingVote() {
  const repo = `${marker}/app-${fixture.candidates.length + 1}`;
  const [candidate] = await admin`INSERT INTO crawl_candidates (repo, product_url, state, reason, decided_by)
    VALUES (${repo}, ${`https://${marker}.example`}, 'approved', 'passed', 'auto') RETURNING id`;
  fixture.candidates.push(candidate.id);
  const [vote] = await admin`INSERT INTO second_reviews (candidate_id, repo, trigger, first_decision, input_hash, generation_key, provider, model)
    VALUES (${candidate.id}, ${repo}, 'ai_approved', 'approve', ${'a'.repeat(64)}, ${marker}, 'abcllm', 'pr06e-host-model') RETURNING id`;
  fixture.votes.push(vote.id);
  return Number(vote.id);
}

beforeAll(async () => {
  ensureSchema(); baseline = await whole();
  // 같은 host 의 남의 자리와 섞이지 않는다 — fixture 전 mini 장부가 비어 있어야 한다
  expect(baseline.operations_observations.filter(row => String(row.key).startsWith('host-slot:mini:'))).toEqual([]);
});
afterEach(async () => {
  await Promise.allSettled([...children].map(kill => kill()));
  children.clear();
  await admin.begin(async tx => {
    for (const id of fixture.votes) await tx`DELETE FROM second_reviews WHERE id=${id} AND repo LIKE ${`${marker}/%`}`;
    for (const id of fixture.candidates) await tx`DELETE FROM crawl_candidates WHERE id=${id} AND repo LIKE ${`${marker}/%`}`;
    // 정상 종료한 프로세스는 자기 행을 이미 지웠다. 장부 anchor 는 기준선에 없을 때만 지운다
    await tx`DELETE FROM operations_observations WHERE key LIKE 'host-slot:mini:%' AND value->>'identity' = 'worker:reviewer:ai2:1:1'`;
    if (!baseline.operations_observations.some(row => row.key === 'host-slot:mini'))
      await tx`DELETE FROM operations_observations WHERE key='host-slot:mini' AND value->>'type'='anchor'`;
  });
  fixture.candidates = []; fixture.votes = [];
  expect(await whole()).toEqual(baseline);
});
afterAll(async () => { await admin.end({ timeout: 5 }); });

it('takes, renews and releases its own worker seat, and defers a pending vote before any claim while the host is not admitted', async () => {
  const id = await pendingVote(), vote = async () => (await admin`SELECT to_jsonb(s) AS row FROM second_reviews s WHERE id=${id}`)[0].row;
  const before = await vote();
  const running = consumer(environment(true), false);
  let first: Raw | undefined;
  await vi.waitFor(async () => {
    const rows = await ledger();
    expect(rows.map(row => row.key)).toEqual(['host-slot:mini:p:worker:reviewer:ai2:1:1']);
    first = rows[0].value;
  }, { timeout: 20_000, interval: 100 });
  expect(first).toMatchObject({ type: 'process', identity: 'worker:reviewer:ai2:1:1', release: RELEASE, primaryMax: 3, readMax: 0 });
  // 이 instance 는 HTTP 장부에 매핑되지 않았으니 admit 은 미룬다 — 그 표는 claim 되지 않는다
  await vi.waitFor(() => expect(running.output().stdout).toContain('"event":"pipeline_consumer.deferred"'), { timeout: 20_000, interval: 100 });
  expect(running.output().stdout).toContain('"reason":"host_http_unbound"');
  // 갱신 주기(10초) 뒤 같은 boot 의 lease 가 DB 시계로 늘어난다
  await vi.waitFor(async () => {
    const [row] = await ledger();
    expect(row.value.bootId).toBe(first!.bootId);
    expect(Number(row.value.renewedAtMs)).toBeGreaterThan(Number(first!.renewedAtMs));
    expect(Number(row.value.leaseUntilMs)).toBeGreaterThan(Number(first!.leaseUntilMs));
  }, { timeout: 20_000, interval: 250 });
  expect(await vote()).toEqual(before);
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${id}`}`).toEqual([]);
  running.child.kill('SIGTERM');
  expect(await running.closed).toBe(0);
  expect(running.output().stderr).toBe('');
  // 정상 종료는 자기 자리만 즉시 지운다(lease 만료를 기다리지 않음)
  expect(await ledger()).toEqual([]);
  expect(await vote()).toEqual(before);
}, 60_000);

it('with enforcement off writes no ledger row, leaves the database unchanged and prints nothing (previous behavior)', async () => {
  await pendingVote();
  const before = await whole();
  const once = consumer(environment(false), true);
  expect(await once.closed).toBe(0);
  expect(once.output()).toEqual({ stdout: '', stderr: '' });
  expect(await admin`SELECT key FROM operations_observations WHERE key LIKE 'host-slot:%'`)
    .toEqual(baseline.operations_observations.filter(row => String(row.key).startsWith('host-slot:')).map(row => ({ key: row.key })));
  expect(await whole()).toEqual(before);
}, 60_000);
