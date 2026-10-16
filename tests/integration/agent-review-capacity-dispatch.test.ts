import { randomUUID, createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Ai1GatewayServingContract } from '@/lib/crawl/agent-review-serving-contract';
const serving = vi.hoisted(() => ({ contract: undefined as Ai1GatewayServingContract | undefined }));
vi.mock('@/lib/crawl/agent-review-serving-contract', async load => {
  const original = await load<typeof import('@/lib/crawl/agent-review-serving-contract')>();
  return { ...original, resolveAi1GatewayServingContract: (model: string) => serving.contract ?? original.resolveAi1GatewayServingContract(model) };
});
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlSettings } from '@/lib/db/schema';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { README_SAMPLE_VERSION } from '@/lib/crawl/readme';
import { loadReviewInput, claimAgentReview, recordAgentReview } from '@/lib/crawl/agent-review-repository';
import { reviewCrawlCandidates } from '@/lib/crawl/jobs/agent-review';
import { claimAgentReviewModelCapacity } from '@/lib/crawl/agent-review-model-capacity';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { runJob, type JobContext, type JobOutcome } from '@/lib/jobs/runner';
import { requestJob } from '@/lib/jobs/control';
import { tryAcquireRole, releaseRole, type RoleLease } from '@/lib/jobs/role-leader';
import { jobsForRole } from '@/lib/jobs/catalog';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

type Raw = Record<string, unknown>;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'pr05b3-c-admin' } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'pr05b3-c-observer' } });
const marker = `pr05b3-c-${randomUUID().slice(0, 8)}`;
const instanceId = `${marker}-reviewer`, bootId = randomUUID();
const managedJobs = ['crawl-agent-review', 'crawl-fetch', 'crawl-publish', 'second-review'];
const pending = new Set<Promise<unknown>>();
const ownCandidates = new Map<number, string>(), ownDocuments = new Map<number, string>(), ownRequests = new Set<string>();
const createdJobs = new Set<string>(), createdObservations = new Set<string>();
const touched = ['jobs', 'operations_observations', 'crawl_settings', 'model_capacity_control', 'role_leases'] as const;
let baseline: Record<string, Raw[]> | undefined, heldCandidates: Raw[] = [], role: RoleLease | null = null;
let cleanupFlight: Promise<void> | undefined;
let roleTouched = false;
const evidence = `/tmp/nomorevibe-pr05b3-c-fixture-${process.pid}-20261016`;
const raw = async (table: string, tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Raw[]> =>
  (await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public."${table.replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).map(row => row.row);
async function whole() {
  const result: Record<string, Raw[]> = {};
  for (const row of await admin`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) result[row.tablename] = await raw(row.tablename);
  return result;
}
function track<T>(value: Promise<T>): Promise<T> { pending.add(value); void value.catch(() => {}); return value; }
function exercise(load: () => Promise<void>) { return track(Promise.resolve().then(load)); }
async function drain() { const snapshot = [...pending]; await Promise.allSettled(snapshot); snapshot.forEach(value => pending.delete(value)); }
async function allSteps(steps: (() => Promise<unknown>)[], previous: unknown[] = []) {
  const errors = [...previous]; for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'pr05b3_fixture_cleanup');
}
async function restore(table: string, key: string, original: Raw, current: Raw, tx: postgres.TransactionSql) {
  const columns = Object.keys(original).filter(column => column !== key);
  const changed = await tx.unsafe(`UPDATE "${table}" t SET ${columns.map(column => `"${column}"=s."${column}"`).join(',')}
    FROM jsonb_populate_record(NULL::"${table}",$1::text::jsonb) s WHERE t."${key}"=s."${key}" AND to_jsonb(t)=$2::text::jsonb RETURNING t."${key}"`, [JSON.stringify(original), JSON.stringify(current)]);
  expect(changed).toHaveLength(1);
}
const configured = (): CrawlSettings => ({ ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'observe', reviewConcurrency: 1,
  firstReview: { provider: 'abcllm', model: 'pr05b3-loopback-model' }, secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { fixture: 1 }, groupLimits: { fixture: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: 'crawl-agent-review', provider: 'abcllm', model: 'pr05b3-loopback-model', providerBudgetId: 'fixture', groupId: 'fixture' }] };
async function mode(value: 'disabled' | 'open' | 'draining', reservationTtlMs = 60_000) {
  const selected = { ...policy, reservationTtlMs };
  await admin`UPDATE model_capacity_control SET mode=${value},policy=${JSON.stringify(selected)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(selected)} WHERE id=1`;
}
async function source() {
  const repo = `${marker}/app-${ownCandidates.size + 1}`;
  expect(await admin`SELECT id FROM crawl_publication_changes WHERE repo=${repo}`).toHaveLength(0);
  const [{ at }] = await admin`SELECT date_trunc('milliseconds',clock_timestamp())-interval '2 seconds' AS at`;
  const fetchedAt = new Date(at), productUrl = `https://${marker}-${ownCandidates.size + 1}.example`;
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt, pageStatus: 200,
    repoMeta: { description: 'A deployed task tracker', pushed_at: fetchedAt.toISOString(), owner: { type: 'User' }, stargazers_count: 3 },
    pageMeta: { title: 'Task tracker', description: 'Create projects and manage tasks online', textSample: 'Create projects and manage tasks online.',
      readmeSample: 'A deployed task tracker', readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  ownDocuments.set(document.id, repo);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: 'approved', reason: 'passed', decidedBy: 'auto', judgedAt: fetchedAt, updatedAt: fetchedAt }).returning();
  ownCandidates.set(candidate.id, repo);
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${`ai1:${candidate.id}`}`).toHaveLength(0);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE logical_work_key=${`ai1:${candidate.id}`}`).toHaveLength(0);
  const settings = configured();
  return { candidate, document, settings, input: await loadReviewInput(candidate, document, settings), provider: 'abcllm', model: settings.firstReview!.model };
}
const attempts = async (id: number) => (await admin`SELECT to_jsonb(a) AS row FROM crawl_review_attempts a WHERE candidate_id=${id} ORDER BY id`).map(row => row.row);
const requests = async () => (await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${instanceId} AND owner_boot_id=${bootId} ORDER BY queue_ordinal`).map(row => row.row);
const events = async (id: string) => (await admin`SELECT kind FROM model_capacity_events WHERE request_id=${id}::uuid ORDER BY id`).map(row => row.kind);
const tick = (handler: (ctx: JobContext<null>) => Promise<JobOutcome<null>> = reviewCrawlCandidates) => track(runJob('crawl-agent-review', handler, { requestedOnly: true, roleLease: role! }));
async function until(load: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 2500;
  while (!await load()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function serve(load: (endpoint: string, calls: { count: number; bodies: string[]; received: Promise<void> }, responses: Set<ServerResponse>) => Promise<void>, broken = false, responseGate?: Promise<void>) {
  let received!: () => void;
  const calls = { count: 0, bodies: [] as string[], received: new Promise<void>(resolve => { received = resolve; }) };
  const responses = new Set<ServerResponse>(), responseWork = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    calls.count++; responses.add(response); response.once('close', () => responses.delete(response));
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      calls.bodies.push(body); received();
      const responding = track((async () => {
        if (responseGate) await responseGate;
        if (broken) { response.writeHead(200); response.write('{'); response.destroy(); return; }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 'pr05b3-loopback-completion', object: 'chat.completion', created: 1, model: 'pr05b3-loopback-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ decision: 'approve', confidence: 0.99, reason: 'A deployed task tracker', evidenceIds: ['product'] }) } }], usage_provenance: 'upstream_reported', usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
      })());
      responseWork.add(responding);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
  serving.contract = { version: 1, protocol: 'abcllm-raw-total-bound-v1', routeId: 'crawl-agent-review', provider: 'abcllm', model: 'pr05b3-loopback-model', responseModel: 'pr05b3-loopback-model', deploymentRevision: marker, totalTokenBound: 8192, endpoint };
  const errors: unknown[] = [];
  try { await load(endpoint, calls, responses); } catch (error) { errors.push(error); }
  finally { serving.contract = undefined; for (const response of responses) response.destroy(); await allSteps([async () => {
    const results = await Promise.allSettled([...responseWork]);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected.length) throw new AggregateError(rejected.map(result => result.reason), 'pr05b3_response_work');
  }, () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))], errors); }
}
function cleanup(): Promise<void> {
  if (cleanupFlight) return cleanupFlight;
  const task = (async () => {
    if (!baseline) return;
    await drain();
    // releaseRole mutates reviewer jobs, so refuse before calling it if any
    // actual in-flight owner remains. Never expire or revoke a foreign token.
    expect(await admin`SELECT name FROM jobs WHERE name=ANY(${jobsForRole('reviewer')}) AND lease_token IS NOT NULL`).toHaveLength(0);
    if (role) { expect(await releaseRole(role)).toBe(true); role = null; }
    await admin.begin(async tx => {
      const mine = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${instanceId} AND owner_boot_id=${bootId} FOR UPDATE`;
      for (const row of mine) { expect([...ownCandidates.keys()].map(id => `ai1:${id}`)).toContain(row.row.logical_work_key); ownRequests.add(row.row.request_id); }
      const eventIds = ownRequests.size ? await tx`SELECT id,request_id FROM model_capacity_events WHERE request_id=ANY(${[...ownRequests]}::uuid[]) ORDER BY id` : [];
      if (eventIds.length) {
        await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
        for (const row of eventIds) await tx`DELETE FROM model_capacity_events WHERE id=${row.id} AND request_id=${row.request_id}::uuid`;
        await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
      }
      for (const id of ownRequests) await tx`DELETE FROM model_capacity_requests WHERE request_id=${id}::uuid AND owner_instance_id=${instanceId} AND owner_boot_id=${bootId}`;
      for (const [id, repo] of ownCandidates) await tx`DELETE FROM crawl_candidates WHERE id=${id} AND repo=${repo}`;
      for (const [id, repo] of ownDocuments) await tx`DELETE FROM crawl_documents WHERE id=${id} AND repo=${repo}`;
      for (const repo of ownCandidates.values()) {
        const changes = await tx`SELECT id FROM crawl_publication_changes WHERE repo=${repo}`;
        for (const row of changes) await tx`DELETE FROM crawl_publication_changes WHERE id=${row.id} AND repo=${repo}`;
      }
      for (const table of touched) {
        const key = table === 'jobs' ? 'name' : table === 'operations_observations' ? 'key' : table === 'role_leases' ? 'role' : 'id';
        const originals = baseline![table].filter(row => table === 'jobs' ? managedJobs.includes(String(row.name))
          : table === 'operations_observations' ? managedJobs.map(name => `job:${name}`).includes(String(row.key)) : table === 'role_leases' ? row.role === 'reviewer' : row.id === 1);
        const keys = table === 'jobs' ? managedJobs : table === 'operations_observations' ? managedJobs.map(name => `job:${name}`) : table === 'role_leases' ? ['reviewer'] : [1];
        for (const value of keys) {
          const current = (await tx.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${key}"=$1 FOR UPDATE`, [value]))[0]?.row as Raw | undefined;
          if (!current) continue;
          const original = originals.find(row => row[key] === value);
          if (table === 'role_leases' && !roleTouched) { expect(current).toEqual(original); continue; }
          if (table === 'jobs') expect(current.lease_token).toBeNull();
          if (table === 'role_leases') { expect(current.owner_instance_id).toBeNull(); expect(current.owner_boot_id).toBeNull(); }
          if (original) await restore(table, key, original, current, tx);
          else {
            const owned = table === 'jobs' ? createdJobs.has(String(value)) : table === 'operations_observations' ? createdObservations.has(String(value)) : table === 'crawl_settings' ? current.updated_by === marker : table === 'role_leases' ? current.owner_release === marker : false;
            expect(owned, `unowned cleanup key ${table}`).toBe(true);
            await tx.unsafe(`DELETE FROM "${table}" t WHERE "${key}"=$1 AND to_jsonb(t)=$2::text::jsonb`, [value, JSON.stringify(current)]);
          }
        }
      }
    });
    ownRequests.clear(); ownCandidates.clear(); ownDocuments.clear(); createdJobs.clear(); createdObservations.clear(); roleTouched = false;
  })();
  cleanupFlight = task; void task.finally(() => { if (cleanupFlight === task) cleanupFlight = undefined; }).catch(() => {});
  return task;
}
beforeAll(() => track((async () => {
  ensureSchema(); baseline = await whole(); await writeFile(`${evidence}-before.json`, JSON.stringify(baseline, null, 2));
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${instanceId} OR owner_boot_id=${bootId}`).toHaveLength(0);
  // This serial positive fixture must not expire or grant another owner's queue.
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toHaveLength(0);
  // Fail before fixture DML if this serial role fixture could revoke a foreign owner.
  const oldRole = baseline.role_leases.find(row => row.role === 'reviewer');
  if (oldRole?.owner_instance_id || oldRole?.owner_boot_id) throw new Error('foreign_reviewer_role_owner');
  expect(await admin`SELECT name FROM jobs WHERE name=ANY(${jobsForRole('reviewer')}) AND lease_token IS NOT NULL`).toHaveLength(0);
  heldCandidates = await admin.begin(async tx => {
    const rows = await tx`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE decided_by='auto' ORDER BY id FOR UPDATE`;
    for (const row of rows) {
      expect(row.row).toEqual(baseline!.crawl_candidates.find(value => value.id === row.row.id));
      await tx`UPDATE crawl_candidates SET decided_by='admin' WHERE id=${row.row.id} AND to_jsonb(crawl_candidates)=${JSON.stringify(row.row)}::text::jsonb`;
    }
    return rows.map(row => row.row);
  });
  // The only global fetch injection prevents accidental external legacy HTTP.
  // Positive fixed calls use B's unmodified native undici sender to loopback.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected_external_http'); }));
  vi.stubEnv('ABCLLM_API_KEY', `${marker}-dummy-local-only`);
})()));
beforeEach(() => track((async () => {
  serving.contract = undefined;
  const originalRole = baseline!.role_leases.filter(row => row.role === 'reviewer');
  expect((await admin`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role='reviewer'`).map(row => row.row)).toEqual(originalRole);
  expect(await admin`SELECT name FROM jobs WHERE name=ANY(${jobsForRole('reviewer')}) AND lease_token IS NOT NULL`).toHaveLength(0);
  const committed = await admin.begin(async tx => {
    const created = { jobs: [] as string[], observations: [] as string[] };
    for (const name of managedJobs.toSorted()) {
      const current = (await tx`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${name} FOR UPDATE`)[0]?.row;
      if (current) { expect(current.lease_token).toBeNull(); expect(current).toEqual(baseline!.jobs.find(row => row.name === name)); }
      else {
        const inserted = await tx`INSERT INTO jobs(name) VALUES(${name}) ON CONFLICT DO NOTHING RETURNING name`;
        expect(inserted).toHaveLength(1); created.jobs.push(name);
      }
      const key = `job:${name}`;
      if (!baseline!.operations_observations.some(row => row.key === key)) {
        const inserted = await tx`INSERT INTO operations_observations(key,value) VALUES(${key},'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING key`;
        expect(inserted).toHaveLength(1); created.observations.push(key);
      }
    }
    await tx`UPDATE jobs SET requested_version=12,processed_version=4,cursor='{"pr05b3":"prior"}'::jsonb,last_error='prior-error',not_before=NULL WHERE name='crawl-agent-review'`;
    return created;
  });
  committed.jobs.forEach(value => createdJobs.add(value)); committed.observations.forEach(value => createdObservations.add(value));
  await db.insert(crawlSettings).values({ id: 1, values: configured(), updatedBy: marker })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: configured(), updatedBy: marker } });
  expect(await admin`SELECT name FROM jobs WHERE name=ANY(${jobsForRole('reviewer')}) AND lease_token IS NOT NULL`).toHaveLength(0);
  role = await tryAcquireRole({ role: 'reviewer', instanceId, bootId, release: marker, kind: 'primary' }); expect(role).not.toBeNull(); roleTouched = true;
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: 'reviewer', ROLE_LEASE_INSTANCE_ID: instanceId,
    ROLE_LEASE_BOOT_ID: bootId, ROLE_LEASE_RELEASE: marker, ROLE_LEASE_EPOCH: String(role!.epoch) })) vi.stubEnv(key, value);
})()));
afterEach(async () => { await cleanup(); });
afterAll(async () => {
  await allSteps([drain, cleanup, async () => {
    if (!baseline) return;
    await admin.begin(async tx => { for (const row of heldCandidates) {
      const [current] = await tx`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${Number(row.id)} FOR UPDATE`;
      expect(current.row).toEqual({ ...row, decided_by: 'admin' });
      await tx`UPDATE crawl_candidates SET decided_by=${String(row.decided_by)} WHERE id=${Number(row.id)}`;
    } });
    const after = await whole(); await writeFile(`${evidence}-after.json`, JSON.stringify(after, null, 2)); expect(after).toEqual(baseline);
  }, async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); },
  () => admin.end(), () => observer.end(), async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end(); }]);
});

it('production unsupported fresh admission has no POST, queue row, attempt, or producer ACK', () => exercise(async () => {
  const context = await source(); await mode('open');
  const before = (await raw('jobs')).find(row => row.name === 'crawl-agent-review');
  expect(await tick()).toMatchObject({ status: 'deferred', reason: 'model_capacity' });
  expect(await attempts(context.candidate.id)).toHaveLength(0); expect(await requests()).toHaveLength(0);
  const after = (await raw('jobs')).find(row => row.name === 'crawl-agent-review');
  for (const key of ['requested_version', 'processed_version', 'cursor', 'not_before', 'last_error', 'last_success_at']) expect(after![key]).toEqual(before![key]);
  expect(after).toMatchObject({ lease_token: null, locked_at: null }); expect(fetch).not.toHaveBeenCalled();
}));
it('disabled keeps the actual claim and original cancellation writer without a model reservation', () => exercise(async () => {
  const context = await source(); await mode('disabled');
  expect(await tick(async ctx => {
    const claim = await claimAgentReview({ ...context, lease: ctx.lease! }); expect(claim.kind).toBe('claimed');
    if (claim.kind === 'skipped') throw new Error('disabled_claim_skipped');
    await recordAgentReview({ ...context, receipt: claim.receipt, error: 'cancelled' }); return { done: false };
  })).toMatchObject({ status: 'completed' });
  expect(await requests()).toHaveLength(0); expect(await attempts(context.candidate.id)).toMatchObject([{ state: 'failed', error_code: 'cancelled' }]);
}));
it('actual AI1 job binds a fresh attempt and dispatch before one native POST and terminal settlement', () => exercise(async () => {
  const context = await source(); await mode('open');
  await serve(async (_endpoint, calls) => {
    expect(await tick()).toMatchObject({ status: 'completed' }); expect(calls.count).toBe(1);
    const [row] = await requests(); expect(row.state).toBe('settled');
    expect(row.logical_work_key).toBe(`ai1:${context.candidate.id}`);
    expect(row.dispatch_binding).toMatchObject({ candidateId: context.candidate.id, inputHash: context.input.inputHash, chargedTokens: 8192, totalTokenBound: 8192 });
    expect((row.dispatch_binding as Raw).wireHash).toBe(createHash('sha256').update(calls.bodies[0]).digest('hex'));
    expect(await events(String(row.request_id))).toEqual(['queued', 'reserved', 'dispatch_started', 'dispatch_settled']);
    expect(await attempts(context.candidate.id)).toMatchObject([{ state: 'succeeded', attempt_number: 1 }]);
  });
}));
it('domain lock wait observes a current human decision and cancels only its original reservation', () => exercise(async () => {
  const context = await source(); await mode('open');
  await serve(async (_endpoint, calls) => {
    const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false }); let unlock!: () => void, entered!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; }), started = new Promise<number>(resolve => { entered = resolve; });
    const holding = track(blocker.begin(async tx => {
      await tx`SELECT id FROM crawl_candidates WHERE id=${context.candidate.id} FOR UPDATE`;
      entered(Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid)); await gate;
      await tx`UPDATE crawl_candidates SET decided_by='admin' WHERE id=${context.candidate.id}`;
    }));
    const errors: unknown[] = []; let execution: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([started, holding.then(() => { throw new Error('holder_ended_before_lock'); })]);
      execution = tick(async ctx => {
        const result = await claimAgentReviewModelCapacity({ ...context, lease: ctx.lease! });
        expect(result.claim).toMatchObject({ kind: 'skipped', reason: 'input_changed' }); return { done: false };
      });
      await until(async () => Boolean((await observer`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`)[0].count), 'actual_candidate_wait_missing');
      unlock(); await holding; expect(await execution).toMatchObject({ status: 'completed' });
      expect(calls.count).toBe(0); expect(await attempts(context.candidate.id)).toHaveLength(0);
      expect(await requests()).toMatchObject([{ state: 'withdrawn' }]);
      expect(await events(String((await requests())[0].request_id))).toEqual(['queued', 'reserved', 'reservation_cancelled']);
    } catch (error) { errors.push(error); }
    finally { unlock(); await allSteps([() => holding, async () => { await execution; }, () => blocker.end()], errors); }
  });
}));

it('reserved expiry during a live-start domain wait rolls back the fresh attempt and dispatch', () => exercise(async () => {
  const context = await source(); await mode('open', 1000);
  const before = (await raw('jobs')).find(row => row.name === 'crawl-agent-review')!;
  await serve(async (_endpoint, calls) => {
    const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false }); let unlock!: () => void, entered!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; }), started = new Promise<number>(resolve => { entered = resolve; });
    const holding = track(blocker.begin(async tx => {
      await tx`SELECT id FROM crawl_candidates WHERE id=${context.candidate.id} FOR UPDATE`;
      entered(Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid)); await gate;
    }));
    const errors: unknown[] = []; let execution: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([started, holding.then(() => { throw new Error('expiry_holder_ended_before_lock'); })]);
      execution = tick(async ctx => { await claimAgentReviewModelCapacity({ ...context, lease: ctx.lease! }); throw new Error('expired_reservation_was_claimed'); });
      let sample: { pid: number; healthy_at_start: boolean } | undefined;
      await until(async () => {
        const rows = await observer`SELECT a.pid,a.xact_start<r.reserved_until AS healthy_at_start
          FROM pg_stat_activity a CROSS JOIN model_capacity_requests r WHERE ${pid}=ANY(pg_blocking_pids(a.pid))
          AND r.owner_instance_id=${instanceId} AND r.owner_boot_id=${bootId} AND r.logical_work_key=${`ai1:${context.candidate.id}`}`;
        sample = rows[0] as typeof sample; return Boolean(sample);
      }, 'reserved_expiry_actual_domain_wait_missing');
      expect(sample!.healthy_at_start).toBe(true);
      const [original] = await requests(); expect(original.state).toBe('reserved'); expect(original.token).toEqual(expect.any(String));
      await until(async () => Boolean((await observer`SELECT clock_timestamp()>reserved_until AS past FROM model_capacity_requests WHERE request_id=${String(original.request_id)}::uuid`)[0].past), 'reservation_dbwall_not_past');
      unlock(); await holding; expect(await execution).toMatchObject({ status: 'deferred', reason: 'model_capacity' });
      expect(calls.count).toBe(0); expect(await attempts(context.candidate.id)).toHaveLength(0);
      const [after] = await requests();
      for (const key of ['request_id','owner_instance_id','owner_boot_id','token','epoch','revision','policy_hash','logical_work_key']) expect(after[key]).toEqual(original[key]);
      expect(after).toMatchObject({ state: 'withdrawn', dispatch_binding: null, dispatch_binding_hash: null, dispatched_at: null });
      expect(await events(String(original.request_id))).toEqual(['queued','reserved','reservation_expired']);
      const job = (await raw('jobs')).find(row => row.name === 'crawl-agent-review')!;
      for (const key of ['requested_version','processed_version','cursor','not_before','last_error','last_success_at']) expect(job[key]).toEqual(before[key]);
    } catch (error) { errors.push(error); }
    finally { unlock(); await allSteps([() => holding, async () => { await execution; }, () => blocker.end()], errors); }
  });
}));

it('native EOF without a terminal retains charge and a new actual tick cannot POST again', () => exercise(async () => {
  const context = await source(); await mode('open');
  await serve(async (_endpoint, calls) => {
    expect(await tick()).toMatchObject({ status: 'completed' }); expect(calls.count).toBe(1);
    const [unknown] = await requests(); expect(unknown.state).toBe('indeterminate');
    expect(unknown.dispatch_binding).toMatchObject({ candidateId: context.candidate.id, chargedTokens: 8192, totalTokenBound: 8192 });
    expect(unknown.terminal_evidence).toBeNull(); expect(unknown.settled_at).toBeNull();
    expect(await events(String(unknown.request_id))).toEqual(['queued','reserved','dispatch_started','dispatch_indeterminate']);
    const originalAttempts = await attempts(context.candidate.id); expect(originalAttempts).toMatchObject([{ state: 'failed' }]);
    await track(requestJob('crawl-agent-review'));
    expect(await tick(async ctx => { await claimAgentReviewModelCapacity({ ...context, lease: ctx.lease! }); throw new Error('unknown_dispatch_reentered'); }))
      .toMatchObject({ status: 'deferred', reason: 'model_capacity' });
    expect(await requests()).toEqual([unknown]); expect(await attempts(context.candidate.id)).toEqual(originalAttempts); expect(calls.count).toBe(1);
  }, true);
}));

it('caller abort after native POST retains unknown charge and a fresh-signal tick cannot POST again', () => exercise(async () => {
  const context = await source(); await mode('open');
  const controller = new AbortController(); let finish!: () => void;
  const responseGate = new Promise<void>(resolve => { finish = resolve; });
  await serve(async (_endpoint, calls) => {
    // This is the actual caller signal accepted by runJob and forwarded by its
    // real review lane; it does not replace a job/role/permit authority object.
    const execution = track(runJob('crawl-agent-review', reviewCrawlCandidates, { requestedOnly: true, roleLease: role!, signal: controller.signal }));
    const errors: unknown[] = [];
    try {
      await Promise.race([calls.received, execution.then(() => { throw new Error('abort_job_ended_before_post'); })]);
      const [dispatched] = await requests(); expect(dispatched.state).toBe('dispatched'); expect(calls.count).toBe(1);
      controller.abort(); expect(await execution).toMatchObject({ status: 'completed' });
      const [unknown] = await requests(); expect(unknown.state).toBe('indeterminate');
      for (const key of ['request_id','owner_instance_id','owner_boot_id','token','epoch','revision','policy_hash','dispatch_binding','dispatch_binding_hash','dispatched_at']) expect(unknown[key]).toEqual(dispatched[key]);
      expect(unknown.terminal_evidence).toBeNull(); expect(unknown.settled_at).toBeNull();
      expect(await attempts(context.candidate.id)).toMatchObject([{ state: 'failed', error_code: 'cancelled' }]);
      expect(await events(String(unknown.request_id))).toEqual(['queued','reserved','dispatch_started','dispatch_indeterminate']);
      expect(await observer`SELECT reason FROM model_capacity_events WHERE request_id=${String(unknown.request_id)}::uuid AND kind='dispatch_indeterminate'`).toMatchObject([{ reason: 'local_abort' }]);
      await track(requestJob('crawl-agent-review'));
      expect(await tick(async ctx => { expect(ctx.signal?.aborted).not.toBe(true); await claimAgentReviewModelCapacity({ ...context, lease: ctx.lease! }); throw new Error('aborted_dispatch_reentered'); }))
        .toMatchObject({ status: 'deferred', reason: 'model_capacity' });
      expect(await requests()).toEqual([unknown]); expect(calls.count).toBe(1);
    } catch (error) { errors.push(error); }
    finally { finish(); await allSteps([async () => { await execution; }], errors); }
  }, false, responseGate);
}));

it('late physical terminal settles capacity while an expired-job domain writer and producer ACK roll back', () => exercise(async () => {
  const context = await source(); await mode('open');
  let finish!: () => void; const responseGate = new Promise<void>(resolve => { finish = resolve; });
  await serve(async (_endpoint, calls) => {
    const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
    let unlock!: () => void, entered!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; }), started = new Promise<number>(resolve => { entered = resolve; });
    const execution = tick(); let holding: Promise<unknown> | undefined, originalToken: string | undefined;
    const errors: unknown[] = [];
    try {
      await Promise.race([calls.received, execution.then(() => { throw new Error('late_job_ended_before_post'); })]);
      const [dispatched] = await requests(); expect(dispatched.state).toBe('dispatched');
      const attemptBefore = await attempts(context.candidate.id); expect(attemptBefore).toMatchObject([{ state: 'running' }]);
      const candidateBefore = (await raw('crawl_candidates')).find(row => row.id === context.candidate.id);
      const outboxBefore = { publication: await raw('crawl_publication_changes'), votes: await raw('second_reviews'), products: await raw('products'),
        downstream: (await raw('jobs')).filter(row => row.name !== 'crawl-agent-review') };
      originalToken = String((dispatched.dispatch_binding as Raw).job && ((dispatched.dispatch_binding as Raw).job as Raw).token);
      // Age only this actual job/token after its real POST; production90s TTL
      // and all provider/domain/result timeouts remain unchanged.
      const [aged] = await admin`UPDATE jobs SET locked_at=clock_timestamp()-interval '88 seconds'
        WHERE name='crawl-agent-review' AND lease_token=${originalToken}::text
        AND locked_at>clock_timestamp()-interval '90 seconds' RETURNING to_jsonb(jobs) AS row,
        locked_at+interval '90 seconds'>clock_timestamp() AS live`;
      expect(aged.live).toBe(true);
      holding = track(blocker.begin(async tx => {
        await tx`SELECT name FROM jobs WHERE name='crawl-agent-review' AND lease_token=${originalToken!}::text FOR UPDATE`;
        entered(Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid)); await gate;
      }));
      const pid = await Promise.race([started, holding.then(() => { throw new Error('late_job_holder_ended_before_lock'); })]);
      finish();
      await until(async () => (await requests())[0].state === 'settled', 'late_physical_terminal_not_settled');
      let sample: { pid: number; healthy_at_start: boolean } | undefined;
      await until(async () => {
        const rows = await observer`SELECT a.pid,a.xact_start<j.locked_at+interval '90 seconds' AS healthy_at_start
          FROM pg_stat_activity a CROSS JOIN jobs j WHERE ${pid}=ANY(pg_blocking_pids(a.pid))
          AND j.name='crawl-agent-review' AND j.lease_token=${originalToken!}::text`;
        sample = rows[0] as typeof sample; return Boolean(sample);
      }, 'late_writer_actual_job_wait_missing');
      expect(sample!.healthy_at_start).toBe(true);
      await until(async () => Boolean((await observer`SELECT clock_timestamp()>locked_at+interval '90 seconds' AS past FROM jobs WHERE name='crawl-agent-review' AND lease_token=${originalToken!}::text`)[0].past), 'late_job_dbwall_not_past');
      unlock(); await holding;
      expect(await execution).toMatchObject({ status: 'failed', error: 'job_lease_lost' }); expect(calls.count).toBe(1);
      const [settled] = await requests(); expect(settled.state).toBe('settled');
      for (const key of ['request_id','owner_instance_id','owner_boot_id','token','epoch','revision','policy_hash','dispatch_binding','dispatch_binding_hash']) expect(settled[key]).toEqual(dispatched[key]);
      expect(await events(String(settled.request_id))).toEqual(['queued','reserved','dispatch_started','dispatch_settled']);
      expect(await attempts(context.candidate.id)).toEqual(attemptBefore);
      expect((await raw('crawl_candidates')).find(row => row.id === context.candidate.id)).toEqual(candidateBefore);
      expect({ publication: await raw('crawl_publication_changes'), votes: await raw('second_reviews'), products: await raw('products'),
        downstream: (await raw('jobs')).filter(row => row.name !== 'crawl-agent-review') }).toEqual(outboxBefore);
      // Check the original owner/producer before a legitimate successor cleans up.
      expect((await raw('jobs')).find(row => row.name === 'crawl-agent-review')).toEqual(aged.row);
    } catch (error) { errors.push(error); }
    finally {
      finish(); unlock?.();
      await allSteps([async () => { await holding; }, async () => { await execution; }, async () => {
        const [current] = await admin`SELECT lease_token,locked_at<clock_timestamp()-interval '90 seconds' AS expired FROM jobs WHERE name='crawl-agent-review'`;
        if (current.lease_token !== null) {
          expect(current.lease_token).toBe(originalToken); expect(current.expired).toBe(true);
          expect(await tick(async () => ({ done: false }))).toMatchObject({ status: 'completed' });
        }
      }, () => blocker.end()], errors);
    }
  }, false, responseGate);
}));
