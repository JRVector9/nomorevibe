import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews } from '@/lib/db/schema';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { README_SAMPLE_VERSION } from '@/lib/crawl/readme';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { reviewCliArgs, reviewCliPrompt } from '@/lib/crawl/agent-review';
import { loadReviewInput, recordAgentReview } from '@/lib/crawl/agent-review-repository';
import { reviewCrawlCandidates } from '@/lib/crawl/jobs/agent-review';
import { executeFirstReviewConsumerItem } from '@/lib/crawl/agent-review-item-lifecycle';
import { executeSecondReviewConsumerItem } from '@/lib/crawl/second-review-item-lifecycle';
import { secondReviewGeneration } from '@/lib/crawl/second-review-input';
import { agentReviewBinding } from '@/lib/crawl/agent-review-ownership';
import { claudeCliTokenBound, type CliServingContract } from '@/lib/llm/cli-serving-contract';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { requestAi1ModelSlot, requestCliModelSlot, cancelReservedModelSlot } from '@/lib/llm/capacity-repository';
import { itemBindingHash } from '@/lib/jobs/items/types';
import { runJob, type JobContext, type JobOutcome } from '@/lib/jobs/runner';
import { requestJob } from '@/lib/jobs/control';
import { tryAcquireRole, releaseRole, type RoleLease } from '@/lib/jobs/role-leader';
import { jobsForRole } from '@/lib/jobs/catalog';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/*
 * PR05c-4 실제 DB driver. 실제 AI1 legacy job(runJob)·AI1/AI2 item consumer·claim TX·장부·runner 를 쓰고, 바꾸는 것은 CLI 계약
 * allowlist(resolveCliServingContract) 하나뿐이다. 모델 CLI 는 tests/fixtures/fake-cli/fake.mjs(가짜) 이고 자식 PATH 는 빈 디렉터리다 —
 * 실제 claude/grok·provider·운영 DB 는 쓰지 않는다. 각 시험 뒤 DB 전체를 시작 상태와 같게 되돌린다(CI 공유 DB 이식성).
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
vi.mock('@/lib/llm/cli-serving-contract', async original => ({
  ...await original<typeof import('@/lib/llm/cli-serving-contract')>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));
type Raw = Record<string, unknown>;
type Snapshot = Record<string, Raw[]>;
const marker = `pr05c4-${randomUUID().slice(0, 8)}`, model = 'fake-model', backup = 'fake-backup';
const instanceId = `${marker}-reviewer`, bootId = randomUUID(), ownBoots = new Set<string>([bootId]);
const owner = { instanceId, bootId };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'pr05c4-cli-fixture' } });
const managedJobs = ['crawl-agent-review', 'second-review', 'crawl-publish'];
const candidates = new Map<number, string>(), documents = new Map<number, string>();
const work = new Set<Promise<unknown>>();
let baseline: Snapshot, held: Raw[] = [], role: RoleLease | null = null, initialized = false, serial = 0;
let root = '', bin = '', records = '', tmp = '', empty = '';
const createdJobs = new Set<string>(), createdObservations = new Set<string>();

const claudeShape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const C = claudeCliTokenBound(claudeShape);
const claude = (routeId: string, name = model): CliServingContract => ({ version: 1, protocol: 'cli-process-v1', routeId, provider: 'claude-cli',
  model: name, cliVersion: 'fake 0.0.0', totalTokenBound: C, costBoundUsdMicros: 150_000, boundProvenance: 'derived', ...claudeShape });
const CONTRACTS = [claude('crawl-agent-review'), claude('second-review'), claude('second-review', backup)];
const route = (routeId: string, provider: string, name: string, providerBudgetId: string) => ({ routeId, provider, model: name, providerBudgetId, groupId: 'reviewers' });
const policy = (claudeLimit = 4): ModelCapacityPolicy => ({ version: 1, globalLimit: 8, providerLimits: { 'claude-sub': claudeLimit, abcllm: 4 },
  groupLimits: { reviewers: 8 }, poolLimits: { reviewer: 8, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [route('crawl-agent-review', 'claude-cli', model, 'claude-sub'),
    route('crawl-agent-review', 'abcllm', 'gw-model', 'abcllm'), route('second-review', 'claude-cli', model, 'claude-sub'),
    route('second-review', 'claude-cli', backup, 'claude-sub')] });
const settings = (second = false): CrawlSettings => ({ ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'observe',
  reviewConcurrency: 1, firstReview: { provider: 'claude-cli', model },
  agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility: false },
  secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: second,
    voters: [{ provider: 'claude-cli', model }], fallbacks: [{ provider: 'claude-cli', model: backup }] } });

function track<T>(value: Promise<T>): Promise<T> { work.add(value); void value.catch(() => {}); return value; }
async function drain() { const pending = [...work]; await Promise.allSettled(pending); pending.forEach(value => work.delete(value)); }
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'pr05c4_cleanup_failed', { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`); result[tablename] = row.value;
  }
  return result;
}
async function install(mode: 'disabled' | 'open', options: { second?: boolean; stage?: { ai1?: 'legacy' | 'items'; ai2?: 'legacy' | 'items' };
  claudeLimit?: number } = {}) {
  const values = settings(options.second);
  await db.insert(crawlSettings).values({ id: 1, values, updatedBy: marker }).onConflictDoUpdate({ target: crawlSettings.id, set: { values, updatedBy: marker } });
  for (const [stage, value] of Object.entries(options.stage ?? {}))
    await admin`UPDATE pipeline_stage_modes SET mode=${value},draining_from=NULL,writer_contract_version=1 WHERE stage=${stage}`;
  const selected = policy(options.claudeLimit);
  await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(selected)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(selected)},cursor=0 WHERE id=1`;
}
async function restoreManaged(tx: postgres.TransactionSql, table: string, key: string, values: readonly unknown[]) {
  if (!['crawl_settings', 'pipeline_stage_modes', 'model_capacity_control', 'jobs', 'operations_observations', 'role_leases'].includes(table))
    throw new Error('invalid_fixture_table');
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  for (const value of values) {
    const original = baseline[table].find(row => row[key] === value);
    const [found] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${quote(table)} t WHERE ${quote(key)}::text=$1 FOR UPDATE`, [String(value)]);
    if (!found) { expect(original).toBeUndefined(); continue; }
    const current = found.row as Raw;
    if (table === 'jobs') expect(current.lease_token).toBeNull();
    if (table === 'role_leases') expect(current.owner_instance_id).toBeNull();
    if (original) {
      const columns = Object.keys(original).filter(column => column !== key);
      expect(await tx.unsafe(`UPDATE public.${quote(table)} t SET ${columns.map(column => `${quote(column)}=saved.${quote(column)}`).join(',')}
        FROM jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb) saved
        WHERE t.${quote(key)}=saved.${quote(key)} AND to_jsonb(t)=$2::text::jsonb RETURNING t.${quote(key)}`,
      [JSON.stringify(original), JSON.stringify(current)])).toHaveLength(1);
    } else {
      const ownedRow = table === 'jobs' ? createdJobs.has(String(value)) : table === 'operations_observations' ? createdObservations.has(String(value))
        : table === 'role_leases' ? current.owner_release === marker : table === 'crawl_settings' ? current.updated_by === marker : false;
      expect(ownedRow, `unowned fixture row ${table}`).toBe(true);
      expect(await tx.unsafe(`DELETE FROM public.${quote(table)} t WHERE ${quote(key)}::text=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING ${quote(key)}`,
        [String(value), JSON.stringify(current)])).toHaveLength(1);
    }
  }
}
async function cleanup() {
  if (!initialized) return;
  await drain();
  if (role) { expect(await releaseRole(role)).toBe(true); role = null; }
  // 손자 프로세스(가짜 CLI 의 pipe 쥔 손자)를 정리한다
  for (const value of await recorded()) if (value.grandchild) try { process.kill(value.grandchild, 'SIGKILL'); } catch { /* already gone */ }
  for (const name of await readdir(records)) await rm(path.join(records, name));
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    expect((await tx`SELECT lease_token FROM jobs WHERE name=ANY(${managedJobs}) FOR UPDATE`).every(row => row.lease_token === null)).toBe(true);
    const ids = [...candidates.keys()];
    const requests = (await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${instanceId} ORDER BY request_id FOR UPDATE`).map(row => row.row as Raw);
    for (const row of requests) {
      expect(ownBoots.has(String(row.owner_boot_id))).toBe(true);
      expect(ids.some(id => String(row.logical_work_key).startsWith(`ai1:${id}`) || String(row.logical_work_key).startsWith(`ai2:${id}:`))).toBe(true);
      expect(baseline.model_capacity_requests.some(old => old.request_id === row.request_id)).toBe(false);
    }
    const requestIds = requests.map(row => String(row.request_id));
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const guard = () => tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`;
    const guards = [{ tgname: 'model_capacity_events_no_change', tgenabled: 'A' }, { tgname: 'model_capacity_events_no_truncate', tgenabled: 'A' }];
    expect(Array.from(await guard())).toEqual(guards);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=ANY(${requestIds}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid
        AND to_jsonb(e)=${JSON.stringify(event.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    expect(Array.from(await guard())).toEqual(guards);
    for (const row of requests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${String(row.request_id)}::uuid
      AND owner_instance_id=${instanceId} AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    const votes = await tx`SELECT to_jsonb(s) AS row FROM second_reviews s WHERE candidate_id=ANY(${ids}) ORDER BY id FOR UPDATE`;
    const items = await tx`SELECT to_jsonb(i) AS row FROM pipeline_item_leases i WHERE (stage='ai1' AND work_key=ANY(${ids.map(id => `ai1:${id}`)}))
      OR (stage='ai2' AND work_key=ANY(${votes.map(vote => `ai2:${vote.row.id}`)})) FOR UPDATE`;
    for (const { row } of items) {
      expect(row.token).toBeNull();
      expect(await tx`DELETE FROM pipeline_item_leases i WHERE stage=${row.stage} AND work_key=${row.work_key} AND token IS NULL
        AND to_jsonb(i)=${JSON.stringify(row)}::text::jsonb RETURNING work_key`).toHaveLength(1);
    }
    for (const { row } of votes) {
      expect(baseline.second_reviews.some(old => old.id === row.id)).toBe(false);
      expect(await tx`DELETE FROM second_reviews s WHERE id=${row.id} AND to_jsonb(s)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    const attempts = await tx`SELECT to_jsonb(a) AS row FROM crawl_review_attempts a WHERE candidate_id=ANY(${ids}) ORDER BY id FOR UPDATE`;
    for (const { row } of attempts) {
      expect(row.state).not.toBe('running');
      expect(await tx`DELETE FROM crawl_review_attempts a WHERE id=${row.id} AND to_jsonb(a)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    for (const [id, repo] of candidates) {
      const [current] = await tx`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${id} AND repo=${repo} FOR UPDATE`;
      expect(await tx`DELETE FROM crawl_candidates c WHERE id=${id} AND to_jsonb(c)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    const changes = await tx`SELECT to_jsonb(c) AS row FROM crawl_publication_changes c WHERE repo=ANY(${[...candidates.values()]}) ORDER BY id FOR UPDATE`;
    for (const { row } of changes) {
      expect(baseline.crawl_publication_changes.some(old => old.id === row.id || old.repo === row.repo)).toBe(false);
      expect(await tx`DELETE FROM crawl_publication_changes c WHERE id=${row.id} AND to_jsonb(c)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    for (const [id, repo] of documents) {
      const [current] = await tx`SELECT to_jsonb(d) AS row FROM crawl_documents d WHERE id=${id} AND repo=${repo} FOR UPDATE`;
      expect(await tx`DELETE FROM crawl_documents d WHERE id=${id} AND to_jsonb(d)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    await restoreManaged(tx, 'crawl_settings', 'id', [1]); await restoreManaged(tx, 'pipeline_stage_modes', 'stage', ['ai1', 'ai2']);
    await restoreManaged(tx, 'model_capacity_control', 'id', [1]); await restoreManaged(tx, 'jobs', 'name', managedJobs);
    await restoreManaged(tx, 'operations_observations', 'key', managedJobs.map(name => `job:${name}`));
    await restoreManaged(tx, 'role_leases', 'role', ['reviewer']);
    // 시작 때 잠시 admin 으로 돌려 둔 남의 auto 후보는 afterAll 이 되돌린다 — 그 밖은 시작 상태와 같아야 한다
    const current = await whole(tx);
    expect({ ...current, crawl_candidates: current.crawl_candidates.filter(row => !held.some(hold => hold.id === row.id)) })
      .toEqual({ ...baseline, crawl_candidates: baseline.crawl_candidates.filter(row => !held.some(hold => hold.id === row.id)) });
  });
  candidates.clear(); documents.clear(); createdJobs.clear(); createdObservations.clear();
  expect(await readdir(tmp)).toEqual([]);
}

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  expect(journal.entries.map((entry: { tag: string }) => entry.tag)).toContain('0094_model_capacity_cli_process_terminal');
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  baseline = await whole();
  // 장부 만료 sweep 은 전역이다 — 남의 요청·item·job owner 가 있으면 DML 전에 멈춘다
  expect(baseline.model_capacity_requests).toEqual([]);
  expect(baseline.pipeline_item_leases.filter(row => row.token !== null)).toEqual([]);
  expect(baseline.jobs.filter(row => jobsForRole('reviewer').includes(String(row.name)) && row.lease_token !== null)).toEqual([]);
  const oldRole = baseline.role_leases.find(row => row.role === 'reviewer');
  if (oldRole?.owner_instance_id || oldRole?.owner_boot_id) throw new Error('foreign_reviewer_role_owner');
  // legacy job 이 남의 auto 후보를 집지 않게 시험 동안만 admin 으로 돌린다(afterAll 이 원래 값으로 되돌린다)
  held = await admin.begin(async tx => {
    const rows = await tx`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE decided_by='auto' ORDER BY id FOR UPDATE`;
    for (const row of rows) await tx`UPDATE crawl_candidates SET decided_by='admin' WHERE id=${row.row.id} AND to_jsonb(crawl_candidates)=${JSON.stringify(row.row)}::text::jsonb`;
    return rows.map(row => row.row as Raw);
  });
  root = await mkdtemp(path.join(os.tmpdir(), 'nmv-pr05c4-'));
  empty = path.join(root, 'empty-path'); records = path.join(root, 'records'); tmp = path.join(root, 'tmp');
  for (const dir of [empty, records, tmp]) await mkdir(dir);
  const fake = path.resolve('tests/fixtures/fake-cli/fake.mjs');
  for (const value of [root, fake, process.execPath]) expect(value).not.toContain("'");
  bin = path.join(root, 'fake-cli'); await writeFile(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`); await chmod(bin, 0o755);
  initialized = true;
});
beforeEach(async () => {
  fixture.contracts = [...CONTRACTS];
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected_external_http'); }));
  vi.stubEnv('TMPDIR', tmp); vi.stubEnv('PATH', empty); vi.stubEnv('FAKE_CLI_MODE', 'ok'); vi.stubEnv('FAKE_CLI_RECORD', records);
  vi.stubEnv('CLAUDE_CLI', bin); vi.stubEnv('GROK_CLI', bin);
  await admin.begin(async tx => {
    for (const name of managedJobs) {
      const [current] = await tx`SELECT name FROM jobs WHERE name=${name} FOR UPDATE`;
      if (!current) { await tx`INSERT INTO jobs(name) VALUES(${name})`; createdJobs.add(name); }
      const key = `job:${name}`;
      if (!baseline.operations_observations.some(row => row.key === key)
        && (await tx`INSERT INTO operations_observations(key,value) VALUES(${key},'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING key`).length) createdObservations.add(key);
    }
    await tx`UPDATE jobs SET requested_version=requested_version+1 WHERE name='crawl-agent-review'`;
  });
});
afterEach(async () => { await steps([cleanup, async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }]); });
afterAll(async () => {
  await steps([drain, cleanup, async () => {
    if (!initialized) return;
    await admin.begin(async tx => { for (const row of held) {
      const [current] = await tx`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${Number(row.id)} FOR UPDATE`;
      expect(current.row).toEqual({ ...row, decided_by: 'admin' });
      await tx`UPDATE crawl_candidates SET decided_by=${String(row.decided_by)} WHERE id=${Number(row.id)}`;
    } });
    expect(await whole()).toEqual(baseline);
  }, () => rm(root, { recursive: true, force: true }), async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, () => admin.end()]);
});

type Recorded = { mode: string; pid: number; argv: string[]; env: Record<string, string | null>; realCliOnPath: boolean; stdin?: string; grandchild?: number };
async function recorded(): Promise<Recorded[]> {
  if (!records) return [];
  return Promise.all((await readdir(records)).map(async name => JSON.parse(await readFile(path.join(records, name), 'utf8')) as Recorded));
}
async function source() {
  const repo = `${marker}/app-${++serial}`, now = new Date(Date.now() - 2_000), productUrl = `https://${marker}-${serial}.example`;
  for (const table of ['crawl_candidates', 'crawl_documents', 'crawl_publication_changes'])
    expect(await admin.unsafe(`SELECT repo FROM ${table} WHERE repo=$1`, [repo])).toHaveLength(0);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'A deployed task tracker', homepage: productUrl, pushed_at: now.toISOString(), owner: { type: 'User' }, stargazers_count: 3 },
    pageMeta: { title: 'Task tracker', description: 'Create projects and manage tasks online', textSample: 'Create projects and manage tasks online.',
      readmeSample: 'A deployed task tracker', readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  documents.set(document.id, repo);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: 'approved', reason: 'passed', decidedBy: 'auto',
    judgedAt: now, updatedAt: now }).returning();
  candidates.set(candidate.id, repo);
  return { candidate, document };
}
/** AI2 원 표: 1차 승인 attempt(원본 fixture) 위의 CLI 표 하나 */
async function vote() {
  const { candidate, document } = await source(), configured = settings(true);
  const input = await loadReviewInput(candidate, document, configured), now = new Date(Date.now() - 2_000);
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: 'automatic', state: 'succeeded',
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: 'claude-cli', model: 'first-model', attemptNumber: 1,
    validUntil: input.validUntil, completedAt: now, outcome: { decision: 'approve', confidence: .94, reason: 'Deployed app', evidenceIds: ['product'] } }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo, trigger: 'ai_approved', firstDecision: 'approve',
    firstConfidence: .94, firstModel: first.model, firstAttemptId: first.id, publishedSlug: null,
    generationKey: secondReviewGeneration(first.id, input, 'ai_approved'), inputHash: input.inputHash, provider: 'claude-cli', model }).returning();
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`).toHaveLength(0);
  return { candidate, document, input, first, row };
}
const tick = (handler: (ctx: JobContext<null>) => Promise<JobOutcome<null>> = reviewCrawlCandidates) =>
  track(runJob('crawl-agent-review', handler, { requestedOnly: true, roleLease: role! }));
async function withRole() {
  role = await tryAcquireRole({ role: 'reviewer', instanceId, bootId, release: marker, kind: 'primary' }); expect(role).not.toBeNull();
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: 'reviewer', ROLE_LEASE_INSTANCE_ID: instanceId, ROLE_LEASE_BOOT_ID: bootId,
    ROLE_LEASE_RELEASE: marker, ROLE_LEASE_EPOCH: String(role!.epoch) })) vi.stubEnv(key, value);
}
const attempts = async (id: number) => (await admin`SELECT to_jsonb(a) AS row FROM crawl_review_attempts a WHERE candidate_id=${id} ORDER BY id`).map(row => row.row as Raw);
const requests = async () => (await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${instanceId} ORDER BY queue_ordinal`).map(row => row.row as Raw);
const events = async (id: unknown) => (await admin`SELECT kind,reason FROM model_capacity_events WHERE request_id=${String(id)}::uuid ORDER BY id`).map(row => row.reason ? `${row.kind}:${row.reason}` : row.kind);
const votes = async (candidateId: number) => (await admin`SELECT to_jsonb(s) AS row FROM second_reviews s WHERE candidate_id=${candidateId} ORDER BY id`).map(row => row.row as Raw);
const evidence = (row: Raw) => (row.terminal_evidence as { process: Raw } | null)?.process;

it('AI1 legacy job: open 이지만 운영 resolver(null)면 slot·attempt·spawn 없이 model_capacity 로 미룬다', async () => {
  const { candidate } = await source(); await install('open'); await withRole(); fixture.contracts = [];
  expect(await tick()).toMatchObject({ status: 'deferred', reason: 'model_capacity' });
  expect(await attempts(candidate.id)).toEqual([]); expect(await requests()).toEqual([]); expect(await recorded()).toEqual([]);
});

it('AI1 legacy job: disabled 는 원 legacy CLI 경로 그대로(장부 0) — argv·env 가 아래 native 경로와 같다', async () => {
  const { candidate, document } = await source(); await install('disabled'); await withRole();
  expect(await tick()).toMatchObject({ status: 'completed' });
  expect(await requests()).toEqual([]);
  expect(await attempts(candidate.id)).toMatchObject([{ state: 'succeeded', provider: 'claude-cli', model, attempt_number: 1 }]);
  const [child] = await recorded();
  expect(child).toMatchObject({ argv: reviewCliArgs(model), realCliOnPath: false, env: { PATH: empty, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2000', CLAUDECODE: null } });
  const input = await loadReviewInput(candidate, document, settings());
  expect(Buffer.from(child.stdin!, 'base64').toString('utf8')).toBe(reviewCliPrompt(JSON.stringify(input.snapshot)));
});

it('AI1 legacy job: open+계약이면 slot → 같은 TX attempt·dispatch → 가짜 CLI 한 번 → terminal 정산 → 기존 결과 기록', async () => {
  const { candidate, document } = await source(); await install('open'); await withRole();
  expect(await tick()).toMatchObject({ status: 'completed' });
  const [row] = await requests();
  expect(row).toMatchObject({ state: 'settled', class: 'first', route_id: 'crawl-agent-review', provider: 'claude-cli', model,
    logical_work_key: `ai1:${candidate.id}`, provider_budget_id: 'claude-sub' });
  const [attempt] = await attempts(candidate.id);
  expect(attempt).toMatchObject({ state: 'succeeded', provider: 'claude-cli', model, attempt_number: 1 });
  expect(row.dispatch_binding).toMatchObject({ kind: 'ai1_legacy_cli', candidateId: candidate.id, attemptId: attempt.id, totalTokenBound: C, chargedTokens: C,
    transport: { protocol: 'cli-process-v1', provider: 'claude-cli', model, timeoutMs: 20_000 } });
  expect(evidence(row)).toMatchObject({ ending: 'exited', exitCode: 0, provenance: 'cli_reported' });
  expect(await events(row.request_id)).toEqual(['queued', 'reserved', 'dispatch_started', 'dispatch_settled']);
  const [child] = await recorded();
  expect(child).toMatchObject({ argv: reviewCliArgs(model), realCliOnPath: false, env: { PATH: empty, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2000', CLAUDECODE: null } });
  const input = await loadReviewInput(candidate, document, settings());
  expect(Buffer.from(child.stdin!, 'base64').toString('utf8')).toBe(reviewCliPrompt(JSON.stringify(input.snapshot)));
});

it('AI1 legacy job: 출력 초과 kill 도 물리 종료라 정산하고, 결과는 기존 output_too_large 실패·backoff 그대로다', async () => {
  const { candidate } = await source(); await install('open'); await withRole(); vi.stubEnv('FAKE_CLI_MODE', 'flood');
  expect(await tick()).toMatchObject({ status: 'completed' });
  const [row] = await requests();
  expect(row.state).toBe('settled'); expect(evidence(row)).toMatchObject({ ending: 'killed', killReason: 'output_too_large', signal: 'SIGKILL' });
  const [attempt] = await attempts(candidate.id);
  expect(attempt).toMatchObject({ state: 'failed', error_code: 'output_too_large' });
  const [{ wait }] = await admin`SELECT extract(epoch FROM retry_after-completed_at)::float8 AS wait FROM crawl_review_attempts WHERE id=${Number(attempt.id)}`;
  expect(wait).toBeGreaterThan(55); expect(wait).toBeLessThan(65);
});

it('AI1 legacy job: pipe 쥔 손자면 process_exit indeterminate 로 점유를 유지하고, 재진입·gateway 모두 spawn 없이 미뤄진다', async () => {
  const { candidate, document } = await source(); await install('open'); await withRole(); vi.stubEnv('FAKE_CLI_MODE', 'grandchild-hold');
  expect(await tick()).toMatchObject({ status: 'completed' });
  const [unknown] = await requests();
  expect(unknown).toMatchObject({ state: 'indeterminate', terminal_evidence: null, dispatch_binding: { kind: 'ai1_legacy_cli', chargedTokens: C } });
  expect(await events(unknown.request_id)).toEqual(['queued', 'reserved', 'dispatch_started', 'dispatch_indeterminate:process_exit']);
  const before = await attempts(candidate.id);
  expect(before).toMatchObject([{ state: 'failed', error_code: 'cli_error' }]);
  expect(await recorded()).toHaveLength(1);
  // 같은 boot 의 재진입은 coordinator 가 dispatched 로 막는다(재시도 대기와 무관하게 직접 부른다)
  const coordinator = await import('@/lib/crawl/review-cli-model-capacity');
  await track(requestJob('crawl-agent-review'));
  expect(await tick(async ctx => { await coordinator.claimAgentReviewCliModelCapacity({ candidate, document, settings: settings(),
    input: await loadReviewInput(candidate, document, settings()), provider: 'claude-cli', model, lease: ctx.lease!, timeoutMs: 20_000 });
  throw new Error('indeterminate_cli_reentered'); })).toMatchObject({ status: 'deferred', reason: 'model_capacity' });
  // 다른 boot 의 CLI·gateway 도 같은 후보 키에서 막힌다
  const other = { instanceId, bootId: randomUUID() }; ownBoots.add(other.bootId);
  const binding = agentReviewBinding(candidate.id, await loadReviewInput(candidate, document, settings()), { provider: 'claude-cli', model });
  expect(await requestCliModelSlot({ requestId: randomUUID(), owner: other, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review',
    provider: 'claude-cli', model, workKey: `ai1:${candidate.id}:${itemBindingHash(binding)}` }, { kind: 'ai1', candidateId: candidate.id }))
    .toEqual({ kind: 'deferred', reason: 'capacity' });
  expect(await requestAi1ModelSlot({ requestId: randomUUID(), owner: other, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review',
    provider: 'abcllm', model: 'gw-model', workKey: `ai1:${candidate.id}:${'a'.repeat(64)}` }, candidate.id)).toEqual({ kind: 'deferred', reason: 'capacity' });
  expect(await recorded()).toHaveLength(1); expect(await attempts(candidate.id)).toEqual(before);
  expect(await requests()).toEqual([unknown]);
}, 30_000);

it('AI1 legacy job: 같은 후보에 gateway 예약이 살아 있으면 CLI 는 attempt·spawn 없이 미뤄진다(transport 를 넘은 한 활성 호출)', async () => {
  const { candidate } = await source(); await install('open'); await withRole();
  const gateway = await requestAi1ModelSlot({ requestId: randomUUID(), owner, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review',
    provider: 'abcllm', model: 'gw-model', workKey: `ai1:${candidate.id}:${'b'.repeat(64)}` }, candidate.id);
  expect(gateway.kind).toBe('granted');
  expect(await tick()).toMatchObject({ status: 'deferred', reason: 'model_capacity' });
  expect(await attempts(candidate.id)).toEqual([]); expect(await recorded()).toEqual([]);
  expect((await requests()).map(row => [row.provider, row.state])).toEqual([['abcllm', 'reserved']]);
  if (gateway.kind === 'granted') expect(await cancelReservedModelSlot(gateway.reservation)).toBe(true);
});

it('AI1 legacy: commit 된 dispatch 를 spawn 전에 포기하면 not_started 로 정산해 슬롯을 놓고(D5) 결과는 기존 cancelled 다', async () => {
  const { candidate, document } = await source(); await install('open'); await withRole();
  const coordinator = await import('@/lib/crawl/review-cli-model-capacity');
  expect(await tick(async ctx => {
    const context = { candidate, document, settings: settings(), input: await loadReviewInput(candidate, document, settings()) };
    const { claim, call } = await coordinator.claimAgentReviewCliModelCapacity({ ...context, provider: 'claude-cli', model, lease: ctx.lease!, timeoutMs: 20_000 });
    if (claim.kind !== 'claimed' || !claim.dispatch) throw new Error('fresh_cli_dispatch_required');
    expect(await coordinator.abandonCliModelCapacity(claim.dispatch, call)).toBe(true);
    await recordAgentReview({ ...context, receipt: claim.receipt, error: 'cancelled', retryAfter: new Date(Date.now() + 60_000) });
    return { done: false };
  })).toMatchObject({ status: 'completed' });
  const [row] = await requests();
  expect(row.state).toBe('settled'); expect(evidence(row)).toMatchObject({ ending: 'not_started', exitCode: null, stdoutBytes: 0 });
  expect(await attempts(candidate.id)).toMatchObject([{ state: 'failed', error_code: 'cancelled' }]);
  expect(await recorded()).toEqual([]);
});

it('AI1 item consumer: CLI 의도 → slot → attempt·item·dispatch → 가짜 CLI → 정산 → 기존 결과 기록·item 반납', async () => {
  const { candidate } = await source(); await install('open', { stage: { ai1: 'items' } });
  // observe 모드라 후보 상태는 바꾸지 않는다(applied=false) — 기존 writer 의 의미 그대로다
  expect(await track(executeFirstReviewConsumerItem({ candidateId: candidate.id, owner }))).toEqual({ applied: false, state: 'succeeded' });
  const [row] = await requests();
  expect(row).toMatchObject({ state: 'settled', logical_work_key: `ai1:${candidate.id}`, dispatch_binding: { kind: 'ai1_item_cli', chargedTokens: C,
    item: { workKey: `ai1:${candidate.id}`, owner } } });
  expect(evidence(row)).toMatchObject({ ending: 'exited', exitCode: 0 });
  expect(await attempts(candidate.id)).toMatchObject([{ state: 'succeeded', provider: 'claude-cli', model }]);
  expect((await admin`SELECT token FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${`ai1:${candidate.id}`}`)[0].token).toBeNull();
  expect(await recorded()).toHaveLength(1);
});

it('AI2 consumer: 운영 resolver(null)면 item·요청·표 변화 없이 provider_contract_unavailable', async () => {
  const f = await vote(); await install('open', { second: true, stage: { ai2: 'items' } }); fixture.contracts = [];
  const before = await whole();
  await expect(track(executeSecondReviewConsumerItem({ secondReviewId: f.row.id, owner }))).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(await whole()).toEqual(before); expect(await recorded()).toEqual([]);
});

it('AI2 consumer: CLI 표는 slot → item·dispatch → 가짜 CLI → 정산 뒤에만 표를 적는다', async () => {
  const f = await vote(); await install('open', { second: true, stage: { ai2: 'items' } });
  expect(await track(executeSecondReviewConsumerItem({ secondReviewId: f.row.id, owner }))).toEqual({ state: 'recorded' });
  const [row] = await requests();
  expect(row).toMatchObject({ state: 'settled', class: 'second', logical_work_key: `ai2:${f.candidate.id}:${f.row.id}`,
    dispatch_binding: { kind: 'ai2_item_cli', failureCount: 0, chargedTokens: C, item: { workKey: `ai2:${f.row.id}`, owner } } });
  expect(await events(row.request_id)).toEqual(['queued', 'reserved', 'dispatch_started', 'dispatch_settled']);
  const [voteRow] = await votes(f.candidate.id);
  expect(voteRow).toMatchObject({ second_decision: 'approve', failure_count: 0 }); expect(voteRow.status).not.toBe('pending');
  expect(await recorded()).toHaveLength(1);
});

it('AI2 consumer: 실제 CLI 실패(exit 1)는 정산하고 기존 규칙대로 실패 수+1·예비모델 행 하나를 만든다', async () => {
  const f = await vote(); await install('open', { second: true, stage: { ai2: 'items' } }); vi.stubEnv('FAKE_CLI_MODE', 'fail');
  expect(await track(executeSecondReviewConsumerItem({ secondReviewId: f.row.id, owner }))).toEqual({ state: 'recorded' });
  const [row] = await requests();
  expect(row.state).toBe('settled'); expect(evidence(row)).toMatchObject({ ending: 'exited', exitCode: 1 });
  const [original, fallback, ...rest] = await votes(f.candidate.id);
  expect(rest).toEqual([]);
  expect(original).toMatchObject({ status: 'resolved', resolution: 'fallback', failure_count: 1, error_code: 'rate_limited' });
  expect(fallback).toMatchObject({ status: 'pending', provider: 'claude-cli', model: backup, fallback_for_id: original.id, failure_count: 1 });
});

it('AI2 consumer: 슬롯 대기면 item·표·예비모델 행 변화 0 으로 미루고 대기 요청만 남긴다', async () => {
  const f = await vote(); const other = await vote(); await install('open', { second: true, stage: { ai2: 'items' }, claudeLimit: 1 });
  // 다른 표가 Claude 계정 한도 1 을 차지한다
  const binding = { stage: 'ai2' as const, secondReviewId: other.row.id, candidateId: other.candidate.id,
    source: { kind: 'first_attempt' as const, firstAttemptId: other.first.id }, inputHash: other.input.inputHash, sourceRevisionHash: other.input.sourceRevisionHash,
    policyHash: 'c'.repeat(64), promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, reviewer: { provider: 'claude-cli', model },
    generationKey: other.row.generationKey, vote: other.row.id, fallbackForId: null };
  const occupy = await requestCliModelSlot({ requestId: randomUUID(), owner, class: 'second', pool: 'reviewer', routeId: 'second-review', provider: 'claude-cli',
    model, workKey: `ai2:${other.candidate.id}:${other.row.id}:${itemBindingHash(binding)}` }, { kind: 'ai2', candidateId: other.candidate.id, vote: other.row.id });
  expect(occupy.kind).toBe('granted');
  const votesBefore = await votes(f.candidate.id);
  await expect(track(executeSecondReviewConsumerItem({ secondReviewId: f.row.id, owner }))).rejects.toMatchObject({ reason: 'capacity' });
  expect(await votes(f.candidate.id)).toEqual(votesBefore); expect(votesBefore).toMatchObject([{ status: 'pending', failure_count: 0 }]);
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${f.row.id}`}`).toHaveLength(0);
  expect((await requests()).map(row => [row.logical_work_key, row.state])).toEqual([[`ai2:${other.candidate.id}:${other.row.id}`, 'reserved'],
    [`ai2:${f.candidate.id}:${f.row.id}`, 'waiting']]);
  expect(await recorded()).toEqual([]);
  if (occupy.kind === 'granted') expect(await cancelReservedModelSlot(occupy.reservation)).toBe(true);
});

it('AI2 consumer: pipe 쥔 손자로 원 표가 indeterminate 면 실패 기록이 만든 예비모델 행도 새 boot 에서 spawn 없이 미뤄진다', async () => {
  const f = await vote(); await install('open', { second: true, stage: { ai2: 'items' } }); vi.stubEnv('FAKE_CLI_MODE', 'grandchild-hold');
  expect(await track(executeSecondReviewConsumerItem({ secondReviewId: f.row.id, owner }))).toEqual({ state: 'recorded' });
  const [unknown] = await requests();
  expect(unknown).toMatchObject({ state: 'indeterminate', terminal_evidence: null });
  expect(await events(unknown.request_id)).toEqual(['queued', 'reserved', 'dispatch_started', 'dispatch_indeterminate:process_exit']);
  const [original, fallback] = await votes(f.candidate.id);
  expect(original).toMatchObject({ resolution: 'fallback', error_code: 'cli_error' }); expect(fallback).toMatchObject({ status: 'pending', model: backup });
  vi.stubEnv('FAKE_CLI_MODE', 'ok');
  const reboot = { instanceId, bootId: randomUUID() }; ownBoots.add(reboot.bootId);
  await expect(track(executeSecondReviewConsumerItem({ secondReviewId: Number(fallback.id), owner: reboot }))).rejects.toMatchObject({ reason: 'capacity' });
  expect(await recorded()).toHaveLength(1);
  expect((await votes(f.candidate.id))[1]).toEqual(fallback);
  // 같은 표 키의 fence 는 대기 행을 넣기 전에 미룬다 — 새 요청 행도 없다
  expect(await requests()).toEqual([unknown]);
}, 30_000);
