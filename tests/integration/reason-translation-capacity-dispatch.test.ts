import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TRANSLATE_MODEL, textHash } from '@/lib/crawl/translate';
import { translateReasons } from '@/lib/crawl/jobs/translate-reasons';
import { prepareReasonTranslationDispatch, retryableTranslations,
  untriedTranslations, type PendingTranslation } from '@/lib/crawl/translations';
import { prepareReasonTranslationGatewayCall } from '@/lib/crawl/agent-review-gateway';
import { runJob, type JobContext } from '@/lib/jobs/runner';
import { requestJob, type JobLease } from '@/lib/jobs/control';
import { tryAcquireRole, releaseRole, type RoleLease } from '@/lib/jobs/role-leader';
import { jobsForRole } from '@/lib/jobs/catalog';
import { batchCanaryAnchorKey, batchPolicyHash } from '@/lib/jobs/batches';
import { requestReasonTranslationModelSlot, cancelReservedModelSlot } from '@/lib/llm/capacity-repository';
import { modelCapacityPolicyHash, reasonTranslationLogicalWorkKey, reasonTranslationInputHash,
  type ModelCapacityPolicy, type ModelCapacityRequest } from '@/lib/llm/capacity';
import type { ReasonTranslationServingContract } from '@/lib/llm/reason-translation-serving-contract';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const legacyTransport = vi.fn(async () => { throw new Error('fixture_unexpected_legacy_transport'); });
const serving = vi.hoisted(() => ({ contract: null as ReasonTranslationServingContract | null }));
vi.mock('@/lib/llm/reason-translation-serving-contract', async original => ({
  ...await original<typeof import('@/lib/llm/reason-translation-serving-contract')>(), resolveReasonTranslationServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
const prefix = `reason-native-${randomUUID().slice(0, 12)}`, jobName = 'reason-translate';
const managedJobs = [...new Set([...jobsForRole('text'), 'product-translate', 'product-tagline-ko'])].sort();
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
const work = new Set<Promise<unknown>>(), exercises = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>(), setups = new Set<Promise<unknown>>();
const ownSources = new Map<number, string>(), ownHashes = new Set<string>(), ownerBoots = new Set<string>();
let initial: Record<string, unknown>, initialized = false, role: RoleLease, serial = 0, cleaning: Promise<void> | undefined;
const basePolicy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { account: 2 }, groupLimits: { engine: 2 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60000, reservationTtlMs: 60000,
  routes: [{ routeId: jobName, provider: 'abcllm', model: TRANSLATE_MODEL, providerBudgetId: 'account', groupId: 'engine' },
    { routeId: 'crawl-agent-review', provider: 'abcllm', model: TRANSLATE_MODEL, providerBudgetId: 'account', groupId: 'engine' }] };
const tracked = <T>(pending: Promise<T>, set = work): Promise<T> => { const actual = Promise.resolve(pending); set.add(actual); void actual.catch(() => {}); return actual; };
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), exercises);
async function drain(set: Set<Promise<unknown>>, report = false) {
  const errors: unknown[] = [];
  while (set.size) { const pending = [...set], results = await Promise.allSettled(pending); for (const promise of pending) set.delete(promise);
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason); }
  if (report && errors.length) throw new AggregateError(errors, 'reason_fixture_pending_failure');
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'reason_fixture_cleanup_failed', { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, unknown> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  } return result;
}
const baseline = (table: string): Raw[] => initial[table] as Raw[];
async function restore(tx: postgres.TransactionSql, table: 'model_capacity_control' | 'job_batch_control' | 'role_leases' | 'jobs' | 'operations_observations', key: string, value: string | number) {
  const saved = baseline(table).find(row => row[key] === value);
  const [current] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE "${key}"=$1 FOR UPDATE`, [value]);
  if (!current) { expect(saved).toBeUndefined(); return; }
  if (!saved) { expect(await tx.unsafe(`DELETE FROM ${table} t WHERE "${key}"=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING "${key}"`, [value, JSON.stringify(current.row)])).toHaveLength(1); return; }
  const columns = Object.keys(saved).map(name => '"' + name.replaceAll('"', '""') + '"').join(',');
  expect(await tx.unsafe(`UPDATE ${table} t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::${table},$1::text::jsonb)) WHERE "${key}"=$2 AND to_jsonb(t)=$3::text::jsonb RETURNING "${key}"`,
    [JSON.stringify(saved), value, JSON.stringify(current.row)])).toHaveLength(1);
}
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`SELECT id FROM job_batch_control WHERE id=1 FOR UPDATE`;
    const roles = await tx`SELECT * FROM role_leases WHERE role IN ('text','translation') ORDER BY role FOR UPDATE`;
    for (const current of roles.filter(row => row.owner_instance_id !== null)) {
      expect(current.owner_instance_id).toBe(prefix); expect(ownerBoots.has(current.owner_boot_id)).toBe(true);
    }
    expect(await tx`SELECT name FROM jobs WHERE name=ANY(${managedJobs}::text[]) AND lease_token IS NOT NULL ORDER BY name FOR UPDATE`).toEqual([]);
    const requests = await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal FOR UPDATE`;
    const ids = requests.map(({ row }) => { expect(ownerBoots.has(row.owner_boot_id)).toBe(true);
      if (row.route_id === jobName) expect(row.logical_member_keys.every((key: string) => ownHashes.has(key.slice(3)))).toBe(true);
      return row.request_id as string; });
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const guards = async () => Array.from(await tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`);
    expect(await guards()).toEqual([{ tgname: 'model_capacity_events_no_change', tgenabled: 'A' }, { tgname: 'model_capacity_events_no_truncate', tgenabled: 'A' }]);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=ANY(${ids}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid AND to_jsonb(e)=${JSON.stringify(event.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    expect(await guards()).toEqual([{ tgname: 'model_capacity_events_no_change', tgenabled: 'A' }, { tgname: 'model_capacity_events_no_truncate', tgenabled: 'A' }]);
    for (const { row } of requests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${row.request_id}::uuid AND owner_instance_id=${prefix} AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    for (const hash of ownHashes) {
      const [row] = await tx`SELECT to_jsonb(t) AS row FROM text_translations t WHERE source_hash=${hash} AND target_lang='ko' FOR UPDATE`;
      if (row) expect(await tx`DELETE FROM text_translations t WHERE source_hash=${hash} AND target_lang='ko' AND to_jsonb(t)=${JSON.stringify(row.row)}::text::jsonb RETURNING source_hash`).toHaveLength(1);
    }
    for (const [id, repo] of ownSources) {
      const [row] = await tx`SELECT to_jsonb(s) AS row FROM second_reviews s WHERE id=${id} AND repo=${repo} FOR UPDATE`;
      expect(row).toBeDefined(); expect(ownHashes.has(textHash(String(row.row.second_reason)))).toBe(true);
      expect(await tx`DELETE FROM second_reviews s WHERE id=${id} AND repo=${repo} AND to_jsonb(s)=${JSON.stringify(row.row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    const candidates = await tx`SELECT role,instance_id,to_jsonb(c) AS row FROM job_batch_candidates c WHERE instance_id=${prefix} FOR UPDATE`;
    for (const candidate of candidates) { expect(candidate.role).toBe('translation'); expect(ownerBoots.has(candidate.row.boot_id)).toBe(true);
      expect(await tx`DELETE FROM job_batch_candidates c WHERE role=${candidate.role} AND instance_id=${prefix} AND to_jsonb(c)=${JSON.stringify(candidate.row)}::text::jsonb RETURNING role`).toHaveLength(1); }
    await restore(tx, 'model_capacity_control', 'id', 1); await restore(tx, 'job_batch_control', 'id', 1);
    for (const name of ['text','translation']) await restore(tx, 'role_leases', 'role', name);
    for (const name of managedJobs) await restore(tx, 'jobs', 'name', name);
    const observations = await tx`SELECT key FROM operations_observations WHERE key=${`job:${jobName}`} OR key=${`batch-result:${prefix}:${jobName}`} OR key=${batchCanaryAnchorKey('translation',prefix)} ORDER BY key FOR UPDATE`;
    for (const { key } of observations) await restore(tx, 'operations_observations', 'key', key);
    expect(await whole(tx)).toEqual(initial);
  });
  ownSources.clear(); ownHashes.clear();
}
function cleanup() {
  if (cleaning) return cleaning; const pending = performCleanup(); cleaning = pending;
  void pending.then(() => { if (cleaning === pending) cleaning = undefined; }, () => {}); return pending;
}
async function install(policy = basePolicy, mode = 'open') {
  await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
function environment() {
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: role.role, ROLE_LEASE_INSTANCE_ID: role.instanceId, ROLE_LEASE_BOOT_ID: role.bootId,
    ROLE_LEASE_RELEASE: role.release, ROLE_LEASE_EPOCH: String(role.epoch), ROLE_LEASE_BATCH_VERSION: role.batchVersion ? '1' : undefined,
    ROLE_LEASE_HOST: role.host, ROLE_LEASE_BATCH_EPOCH: role.batchEpoch ? String(role.batchEpoch) : undefined })) vi.stubEnv(key, value);
}
async function elect() {
  const bootId = randomUUID(); ownerBoots.add(bootId);
  const acquired = await tracked(tryAcquireRole({ role: 'text', instanceId: prefix, bootId, release: 'local-reason-fixture', kind: 'primary' }));
  expect(acquired).not.toBeNull(); if (!acquired) throw new Error('fixture_role_required'); role = acquired; environment();
}
async function seed(attempts = 0): Promise<PendingTranslation> {
  const repo = `${prefix}/source-${++serial}`, body = `This source reason ${repo} describes a deployed task tracker with a useful calendar.`;
  const hash = textHash(body);
  expect(await admin`SELECT id FROM second_reviews WHERE repo=${repo}`).toEqual([]);
  expect(await admin`SELECT source_hash FROM text_translations WHERE source_hash=${hash}`).toEqual([]);
  const id = await tracked(admin.begin(async tx => {
    // A synthetic completed second-review history source, not an AI verdict or a model permit.
    const [source] = await tx`INSERT INTO second_reviews(candidate_id,repo,trigger,first_decision,input_hash,model,status,second_reason,reviewed_at)
      VALUES(2147480000,${repo},'sample','approve',${hash},'history-fixture','resolved',${body},now()) RETURNING id`;
    if (attempts) await tx`INSERT INTO text_translations(source_hash,target_lang,status,translated,model,attempts,error_code,retry_at,created_at,updated_at)
      VALUES(${hash},'ko','failed',NULL,'previous-model',${attempts},'timeout',now()-interval '1 minute',
        '2026-01-01 00:00:00.123456'::timestamp,'2026-01-01 00:00:00.654321'::timestamp)`;
    return Number(source.id);
  }));
  ownSources.set(id, repo); ownHashes.add(hash); // Actual commit resolved before ownership registration.
  return { hash, body, attempts };
}
const replyBody = (translations: (string | null)[] = ['한국어 사유']) => ({ id: 'reason-local', object: 'chat.completion', created: 1,
  model: 'served-reason', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(translations) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 70, completion_tokens: 20, total_tokens: 90 }, usage_provenance: 'upstream_reported' });
async function server(run: (state: { bodies: string[]; setReply: (reply: (response: ServerResponse) => void) => void }) => Promise<void>) {
  const bodies: string[] = [], responses = new Set<Promise<unknown>>(), failures: unknown[] = [];
  let reply = (response: ServerResponse) => { response.end(JSON.stringify(replyBody())); };
  const http = createServer((request, response) => {
    const closed = new Promise<void>(resolve => response.once('close', resolve));
    tracked((async () => { let body = ''; for await (const part of request) body += part.toString(); bodies.push(body); reply(response); await closed; })(), responses);
  });
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
    serving.contract = { version: 1, protocol: 'abcllm-reason-total-bound-v1', routeId: jobName, provider: 'abcllm', model: TRANSLATE_MODEL,
      responseModel: 'served-reason', deploymentRevision: 'local-only', endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8000 };
    await run({ bodies, setReply: next => { reply = next; } });
  } catch (error) { failures.push(error); }
  finally { serving.contract = null; await steps([() => drain(work),
    () => new Promise<void>((resolve, reject) => http.listening ? http.close(error => error ? reject(error) : resolve()) : resolve()),
    () => drain(responses, true)], failures); }
}
async function tick() { await tracked(requestJob(jobName)); return tracked(runJob(jobName, translateReasons, { requestedOnly: true, roleLease: role, budgetMs: 55000 })); }
async function custom(run: (lease: JobLease) => Promise<void>) {
  await tracked(requestJob(jobName)); return tracked(runJob(jobName, async (ctx: JobContext<null>) => {
    expect(ctx.lease).toBeDefined(); await run(ctx.lease!); return { done: true };
  }, { requestedOnly: true, roleLease: role }));
}
function latch() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 2500;
  while (!await check()) { if (Date.now() >= deadline) throw new Error('fixture_barrier_deadline'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function reserve(batch: PendingTranslation[], lease: JobLease) {
  const call = prepareReasonTranslationGatewayCall(batch.map(item => item.body), { model: TRANSLATE_MODEL, timeoutMs: 45000 });
  expect(call.kind).toBe('prepared'); if (call.kind !== 'prepared') throw new Error('fixture_native_contract_required');
  const ready = await tracked(prepareReasonTranslationDispatch(batch, lease, { roleLease: role, call }));
  expect(ready.kind).toBe('ready'); if (ready.kind !== 'ready' || !('members' in ready)) throw new Error('fixture_current_input_required');
  const request: ModelCapacityRequest = { requestId: randomUUID(), owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: 'background', pool: 'text', routeId: jobName, provider: 'abcllm', model: TRANSLATE_MODEL,
    workKey: `${reasonTranslationLogicalWorkKey(ready.members)}:${reasonTranslationInputHash({ members: ready.members, model: TRANSLATE_MODEL })}` };
  const slot = await tracked(requestReasonTranslationModelSlot(request, ready.members));
  expect(slot.kind).toBe('granted'); if (slot.kind !== 'granted') throw new Error('fixture_reservation_required');
  const { requestId: _id, ...identity } = request; void _id; return { call, ready, reservation: slot.reservation, identity };
}
beforeAll(() => tracked((async () => {
  ensureSchema(); initial = await whole();
  // Fresh, isolated CI step required. Never park or delete foreign live work.
  expect(baseline('model_capacity_requests').filter(row => row.owner_instance_id === prefix)).toEqual([]);
  expect(baseline('job_batch_candidates').filter(row => row.instance_id === prefix)).toEqual([]);
  expect(baseline('operations_observations').filter(row => row.key === `batch-result:${prefix}:${jobName}`)).toEqual([]);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`).toEqual([]);
  expect(await untriedTranslations(1)).toEqual([]); expect(await retryableTranslations(1)).toEqual([]);
  expect(baseline('role_leases').filter(row => ['text','translation'].includes(String(row.role))).every(row => row.owner_instance_id === null)).toBe(true);
  expect(baseline('jobs').filter(row => managedJobs.includes(String(row.name))).every(row => row.lease_token === null)).toBe(true);
  expect(baseline('job_batch_control')[0]).toMatchObject({ mode: 'legacy', writer_contract_version: 0 }); initialized = true;
})(), setups));
beforeEach(() => tracked((async () => {
  vi.stubEnv('ABCLLM_API_KEY', 'local-test-only'); legacyTransport.mockClear(); vi.stubGlobal('fetch', legacyTransport);
  await install(); await elect();
})(), setups));
afterEach(() => tracked(steps([() => drain(setups), () => drain(exercises), () => drain(work), cleanup, async () => { serving.contract = null; vi.unstubAllEnvs(); vi.unstubAllGlobals(); }]), hooks));
afterAll(async () => { await steps([() => drain(setups), () => drain(exercises), () => drain(work), () => drain(hooks), cleanup,
  () => admin.end(), async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end(); }]); });

it('keeps production unsupported before any request, cache attempt, provider call or producer ACK', exercise(async () => {
  const item = await seed();
  expect(await tick()).toMatchObject({ status: 'deferred', reason: 'model_capacity' });
  expect(legacyTransport).not.toHaveBeenCalled();
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}`).toEqual([]);
  expect(await admin`SELECT source_hash FROM text_translations WHERE source_hash=${item.hash}`).toEqual([]);
  const [job] = await admin`SELECT requested_version,processed_version,lease_token,last_error FROM jobs WHERE name=${jobName}`;
  expect(Number(job.processed_version)).toBeLessThan(Number(job.requested_version)); expect(job.lease_token).toBeNull(); expect(job.last_error).toBeNull();
}));
it('preserves disabled original transport, partial quality and the original three-argument cache writer', exercise(async () => {
  const first = await seed(), second = await seed(); await install(basePolicy, 'disabled');
  const legacy = vi.fn(async () => new Response(JSON.stringify(replyBody(['한국어 성공', null])))); vi.stubGlobal('fetch', legacy);
  expect(await tick()).toMatchObject({ status: 'completed', done: true }); expect(legacy).toHaveBeenCalledTimes(1);
  expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${prefix}`).toEqual([]);
  const rows = await admin`SELECT status,attempts FROM text_translations WHERE source_hash=ANY(${[first.hash,second.hash]}::text[]) ORDER BY status`;
  expect(Array.from(rows)).toEqual([{ status: 'done', attempts: 1 }, { status: 'failed', attempts: 1 }]);
}));
it('commits actual legacy text role/job, one batch permit, native terminal, partial cache attempts and final ACK', exercise(async () => {
  const first = await seed(), second = await seed(); await server(async ({ bodies, setReply }) => {
    setReply(response => response.end(JSON.stringify(replyBody(['한국어 성공', null]))));
    expect(await tick()).toMatchObject({ status: 'completed', done: true }); expect(bodies).toHaveLength(1);
    const [request] = await admin`SELECT * FROM model_capacity_requests WHERE owner_instance_id=${prefix}`;
    expect(request.state).toBe('settled'); expect(request.logical_member_keys).toEqual([`ko:${first.hash}`,`ko:${second.hash}`].sort());
    expect(request.dispatch_binding).toMatchObject({ kind: 'reason_translation_gateway', chargedTokens: 8000,
      role: { role: 'text', instanceId: prefix, bootId: role.bootId, epoch: role.epoch, batch: { mode: 'legacy' } } });
    expect(request.terminal_evidence.dispatch.bindingHash).toBe(request.dispatch_binding_hash);
    const rows = await admin`SELECT status,attempts,error_code,retry_at>clock_timestamp() AS backed_off FROM text_translations WHERE source_hash=ANY(${[first.hash,second.hash]}::text[]) ORDER BY status`;
    expect(Array.from(rows)).toEqual([{ status: 'done', attempts: 1, error_code: null, backed_off: null }, { status: 'failed', attempts: 1, error_code: 'invalid_output', backed_off: true }]);
    const [job] = await admin`SELECT requested_version,processed_version,lease_token FROM jobs WHERE name=${jobName}`;
    expect(job.processed_version).toBe(job.requested_version); expect(job.lease_token).toBeNull();
  });
}));
it('compares the complete present cache including one microsecond before reserved dispatch and POST', exercise(async () => {
  const item = await seed(2); await server(async ({ bodies }) => {
    expect(await custom(async lease => {
      const { ready, reservation, identity, call } = await reserve([item], lease);
      expect(ready.members[0].cache).toMatchObject({ kind: 'present', attempts: 2 });
      const [before] = await admin`SELECT to_char(updated_at,'YYYY-MM-DD HH24:MI:SS.US') AS at FROM text_translations WHERE source_hash=${item.hash} AND target_lang='ko'`;
      expect(before.at.endsWith('654321')).toBe(true);
      await admin`UPDATE text_translations SET updated_at=updated_at+interval '1 microsecond' WHERE source_hash=${item.hash} AND target_lang='ko'`;
      expect(await tracked(prepareReasonTranslationDispatch([item], lease, { roleLease: role, call,
        reserved: { reservation, identity, members: ready.members, role: ready.role } }))).toEqual({ kind: 'skipped' });
      expect(await tracked(cancelReservedModelSlot(reservation))).toBe(true);
    })).toMatchObject({ status: 'completed' });
    expect(bodies).toHaveLength(0); expect((await admin`SELECT attempts FROM text_translations WHERE source_hash=${item.hash}`)[0].attempts).toBe(2);
    expect((await admin`SELECT state,dispatch_binding FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0]).toMatchObject({ state: 'withdrawn', dispatch_binding: null });
  });
}));
it('preserves original present-row attempt and exponential retry semantics after a real physical terminal', exercise(async () => {
  const item = await seed(2); await server(async ({ bodies, setReply }) => {
    setReply(response => response.end(JSON.stringify(replyBody([null]))));
    expect(await tick()).toMatchObject({ status: 'completed', done: true }); expect(bodies).toHaveLength(1);
    const [row] = await admin`SELECT attempts,status,extract(epoch FROM retry_at-updated_at)::int AS delay,to_char(created_at,'YYYY-MM-DD HH24:MI:SS.US') AS created FROM text_translations WHERE source_hash=${item.hash}`;
    expect(row).toEqual({ attempts: 3, status: 'failed', delay: 1200, created: '2026-01-01 00:00:00.123456' });
    expect((await admin`SELECT state FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0].state).toBe('settled');
  });
}));
it('rolls the whole positive writer back when a formerly absent member is inserted while native is pending', exercise(async () => {
  const first = await seed(), second = await seed(); await server(async ({ bodies, setReply }) => {
    const arrived = latch(), release = latch(); setReply(response => { arrived.resolve(); tracked(release.promise.then(() => response.end(JSON.stringify(replyBody(['하나','둘']))))); });
    const running = tracked(tick()); let sentinel: unknown; const failures: unknown[] = [];
    try {
      await Promise.race([arrived.promise, running.then(value => { throw new Error('fixture_job_ended_before_post', { cause: value }); })]);
      await admin`INSERT INTO text_translations(source_hash,target_lang,status,translated,attempts,model) VALUES(${first.hash},'ko','done','먼저 저장한 번역',7,'other-writer')`;
      sentinel = (await admin`SELECT to_jsonb(t) AS row FROM text_translations t WHERE source_hash=${first.hash} AND target_lang='ko'`)[0].row;
    } catch (error) { failures.push(error); }
    finally { release.resolve(); await steps([async () => { expect(await running).toMatchObject({ status: 'completed', done: false }); }], failures); }
    expect(bodies).toHaveLength(1); expect((await admin`SELECT to_jsonb(t) AS row FROM text_translations t WHERE source_hash=${first.hash} AND target_lang='ko'`)[0].row).toEqual(sentinel);
    expect(await admin`SELECT source_hash FROM text_translations WHERE source_hash=${second.hash}`).toEqual([]);
    expect((await admin`SELECT state FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0].state).toBe('settled');
  });
}));
it('settles historical terminal before a late actual job wall rolls cache and original producer ACK back', exercise(async () => {
  const item = await seed(); await server(async ({ bodies, setReply }) => {
    const arrived = latch(), nativeRelease = latch(), holderReady = latch(), holderRelease = latch();
    setReply(response => { arrived.resolve(); tracked(nativeRelease.promise.then(() => response.end(JSON.stringify(replyBody())))); });
    const running = tracked(tick());
    const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, connection: { application_name: `${prefix}-late-holder` } });
    let holding: Promise<unknown> | undefined, pid = 0, expiry = '', token = ''; const failures: unknown[] = [];
    try {
      await Promise.race([arrived.promise, running.then(value => { throw new Error('fixture_job_ended_before_post', { cause: value }); })]);
      token = String((await admin`SELECT lease_token FROM jobs WHERE name=${jobName}`)[0].lease_token);
      holding = tracked(holder.begin(async tx => {
        pid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
        const [anchor] = await tx`UPDATE jobs SET locked_at=clock_timestamp()-interval '88 seconds'
          WHERE name=${jobName} AND lease_token=${token}::text RETURNING (locked_at+interval '90 seconds')::text AS expiry`;
        expect(anchor).toBeDefined(); expiry = anchor.expiry; holderReady.resolve(); await holderRelease.promise;
      }));
      await Promise.race([holderReady.promise, holding.then(() => { throw new Error('fixture_holder_ended_before_ready'); })]);
      nativeRelease.resolve();
      await until(async () => (await admin`SELECT pid FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`).length === 1);
      // Native proof is durably historical even while the mandatory writer awaits the job lock.
      expect((await admin`SELECT state FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)[0].state).toBe('settled');
      await until(async () => (await admin`SELECT clock_timestamp()>${expiry}::text::timestamp AS past`)[0].past === true);
      holderRelease.resolve(); await holding;
      expect(await running).toMatchObject({ status: 'failed', error: 'job_lease_lost' }); expect(bodies).toHaveLength(1);
      expect(await admin`SELECT source_hash FROM text_translations WHERE source_hash=${item.hash}`).toEqual([]);
      const [job] = await admin`SELECT lease_token,requested_version,processed_version FROM jobs WHERE name=${jobName}`;
      expect(job.lease_token).toBe(token); expect(Number(job.processed_version)).toBeLessThan(Number(job.requested_version));
      // Only after asserting the original failed writer/ACK: a genuine successor claims the expired job and finishes it.
      expect(await tracked(runJob(jobName, async () => ({ done: true }), { requestedOnly: true, roleLease: role }))).toMatchObject({ status: 'completed', done: true });
    } catch (error) { failures.push(error); }
    finally { nativeRelease.resolve(); holderRelease.resolve(); await steps([
      async () => { await Promise.allSettled([running, ...(holding ? [holding] : [])]); }, () => holder.end()], failures); }
  });
}));
it('retains full C after EOF and fences a new boot from another POST or failed cache attempt', exercise(async () => {
  const item = await seed(); await server(async ({ bodies, setReply }) => {
    setReply(response => { response.writeHead(200, { 'Content-Length': '1000' }); response.write('{'); response.socket?.destroy(); });
    expect(await tick()).toMatchObject({ status: 'completed', done: false }); expect(bodies).toHaveLength(1);
    const [unknown] = await admin`SELECT request_id,state,dispatch_binding FROM model_capacity_requests WHERE owner_instance_id=${prefix}`;
    expect(unknown.state).toBe('indeterminate'); expect(unknown.dispatch_binding.chargedTokens).toBe(8000);
    expect((await admin`SELECT attempts FROM text_translations WHERE source_hash=${item.hash}`)[0].attempts).toBe(1);
    expect(await tracked(releaseRole(role))).toBe(true); await elect();
    await admin`UPDATE text_translations SET retry_at=clock_timestamp()-interval '1 second' WHERE source_hash=${item.hash} AND target_lang='ko'`;
    expect(await tick()).toMatchObject({ status: 'deferred', reason: 'model_capacity' }); expect(bodies).toHaveLength(1);
    expect(Array.from(await admin`SELECT request_id,state FROM model_capacity_requests WHERE owner_instance_id=${prefix}`)).toEqual([{ request_id: unknown.request_id, state: 'indeterminate' }]);
    expect((await admin`SELECT attempts FROM text_translations WHERE source_hash=${item.hash}`)[0].attempts).toBe(1);
  });
}));
it('admits the actual versioned translation role and records an actual local stored-result ACK', exercise(async () => {
  const item = await seed(); await server(async ({ bodies }) => {
    const policy = { version: 1 as const, release: role.release, instances: [{ instanceId: prefix, host: 'oracle-osaka-smoke' as const }] };
    // This original legacy result is real local cache/ACK evidence, not a fabricated ready count.
    await admin`UPDATE job_batch_control SET writer_contract_version=1,policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${batchPolicyHash(policy)} WHERE id=1`;
    expect(await tick()).toMatchObject({ status: 'completed', done: true }); expect(bodies).toHaveLength(1);
    expect(await tracked(releaseRole(role))).toBe(true);
    const [clock] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
    const [observation] = await admin`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${`batch-result:${prefix}:${jobName}`}`;
    // Local fixture capability/readback only; not physical Oracle privileges/C/activation evidence.
    const capability = { host: 'oracle-osaka-smoke', release: role.release, instanceId: prefix, dbPrivileges: 'verified',
      dbRole: 'local-fixture-only', effectivePrivilegeHash: 'a'.repeat(64), modelBoundEvidenceHash: 'b'.repeat(64), http: 'verified', model: 'verified', observedAt: clock.at };
    const readback = { host: 'oracle-osaka-smoke', release: role.release, instanceId: prefix, job: jobName,
      requestedVersion: observation.result.requestedVersion, domainReadbackHash: textHash(JSON.stringify((await admin`SELECT to_jsonb(t) AS row FROM text_translations t WHERE source_hash=${item.hash}`)[0].row)), observedAt: clock.at };
    await admin`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
      VALUES('translation',${prefix},'oracle-osaka-smoke',${role.bootId},${role.release},${batchPolicyHash(policy)},${JSON.stringify(capability)}::text::jsonb,${JSON.stringify(readback)}::text::jsonb)`;
    await admin`UPDATE job_batch_control SET mode='versioned',draining_from=NULL,writer_contract_version=1,policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${batchPolicyHash(policy)} WHERE id=1`;
    const acquired = await tracked(tryAcquireRole({ role: 'translation', instanceId: prefix, bootId: role.bootId, release: role.release,
      kind: 'primary', batchVersion: 1, host: 'oracle-osaka-smoke' }));
    expect(acquired).not.toBeNull(); if (!acquired) throw new Error('fixture_translation_role_required'); role = acquired; environment();
    await seed(); expect(await tick()).toMatchObject({ status: 'completed', done: true }); expect(bodies).toHaveLength(2);
    const [request] = await admin`SELECT dispatch_binding FROM model_capacity_requests WHERE owner_instance_id=${prefix} ORDER BY queue_ordinal DESC LIMIT 1`;
    expect(request.dispatch_binding.role).toMatchObject({ role: 'translation', batch: { mode: 'versioned', host: 'oracle-osaka-smoke', batchEpoch: role.batchEpoch } });
  });
}));
