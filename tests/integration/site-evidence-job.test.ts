import { afterAll, afterEach, beforeAll, beforeEach, expect, it as actualIt, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { db } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { runJob } from '@/lib/jobs/runner';
import { requestJob, type JobLease, JobLeaseLostError } from '@/lib/jobs/control';
import { tryAcquireRole, releaseRole, type RoleLease } from '@/lib/jobs/role-leader';
import { beginJobBatchDrain, completeJobBatchTransition } from '@/lib/jobs/batch-repository';
import { batchCanaryAnchorKey, batchPolicyHash, classifyBatchReadiness } from '@/lib/jobs/batches';
import { refreshSiteEvidenceJob } from '@/lib/jobs/products/site-evidence-refresh';
import { refreshProductEvidenceJob, type EvidenceRefreshCursor } from '@/lib/jobs/products/evidence-refresh';
import { claimCanonicalEvidenceSource, renewCanonicalEvidenceSource, recordCanonicalEvidenceSource,
  abandonCanonicalEvidenceSource } from '@/lib/domain/evidence/source-claims';
import { queueProductRefresh } from '@/lib/domain/evidence/refresh-requests';
import { sourceRefreshKey } from '@/lib/domain/evidence/source-contract';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const oldJob = 'product-evidence-refresh', siteJob = 'product-site-evidence-refresh';
const names = [oldJob, siteJob]; // Same lexicographic order as the production outbox helper.
const prefix = `pr10c-${randomUUID().slice(0, 8)}`;
const identity = { role: 'site-evidence' as const, instanceId: prefix, bootId: 'site-boot', release: prefix,
  kind: 'primary' as const, batchVersion: 1 as const, host: 'oracle-osaka-smoke' as const };
const policy = { version: 1 as const, release: prefix, instances: [{ instanceId: prefix, host: identity.host }] };
const owner = { instanceId: prefix, bootId: identity.bootId };
const client = postgres(TEST_DATABASE_URL, { max: 3, connection: { application_name: prefix } });
const tasks = new Set<Promise<unknown>>();
function track<T>(task: Promise<T>): Promise<T> { tasks.add(task); void task.catch(() => {}); return task; }
function it(name: string, body: () => Promise<void>) { actualIt(name, () => track(body())); }
async function drain() { const pending = [...tasks]; await Promise.allSettled(pending); pending.forEach(task => tasks.delete(task)); }
async function allSteps(steps: (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior];
  for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'site_evidence_fixture_cleanup');
}
let tables: string[] = [], baseline: Record<string, Record<string, unknown>[]>, catalog: unknown;
let setup: Promise<void> | undefined, cleaning: Promise<void> | undefined;
const owned: Array<{ productId: number; slug: string; url: string }> = [];
const claimKeys = new Set<number>(), requestKeys = new Set<number>();
const observationKeys = [batchCanaryAnchorKey('site-evidence',prefix),`job:${oldJob}`, `job:${siteJob}`, `batch-result:${prefix}:${siteJob}`];
const managed: Array<[string, string, string | number]> = [
  ['job_batch_control', 'id', 1], ['evidence_source_control', 'id', 1], ['evidence_settings', 'id', 1],
  ...names.map(name => ['jobs', 'name', name] as [string, string, string]),
  ...['crawler', 'site-evidence'].map(role => ['role_leases', 'role', role] as [string, string, string]),
  ...observationKeys.map(key => ['operations_observations', 'key', key] as [string, string, string]),
];
async function snapshot(tx: postgres.Sql | postgres.TransactionSql = client) {
  const rows = await tx.unsafe(tables.map(table => `SELECT '${table}' AS name, coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${table}" t`).join(' UNION ALL '));
  return Object.fromEntries(rows.map(row => [row.name, row.rows])) as typeof baseline;
}
async function catalogSnapshot() {
  return client`SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.relname) FROM
    (SELECT relname,relacl FROM pg_class WHERE relnamespace='public'::regnamespace) t) AS relations,
    (SELECT datacl FROM pg_database WHERE datname=current_database()) AS database_acl,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.rolname) FROM (SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolbypassrls FROM pg_roles) t) AS roles,
    (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.oid),'[]'::jsonb) FROM pg_default_acl t) AS defaults,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM (SELECT oid,proname,proacl,md5(pg_get_functiondef(oid)) AS definition_hash FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind IN ('f','p')) t) AS functions,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.tgname) FROM
    (SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN
      (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)) t) AS triggers`;
}
async function restoreManaged(tx: postgres.TransactionSql, table: string, key: string, value: string | number) {
  const original = baseline[table].find(row => row[key] === value);
  if (!original) { await tx.unsafe(`DELETE FROM "${table}" WHERE "${key}"=$1`, [value]); return; }
  const fields = Object.keys(original).filter(field => field !== key).map(field => `"${field}"`);
  await tx.unsafe(`UPDATE "${table}" t SET (${fields.join(',')})=(${fields.map(field => `r.${field}`).join(',')}) FROM jsonb_populate_record(NULL::"${table}",$1::text::jsonb) r WHERE t."${key}"=$2`, [JSON.stringify(original), value]);
}
const suspended: Record<string, unknown>[] = [];
const requests: Record<string, unknown>[] = [];
async function cleanupOnce() {
  await setup;
  await drain();
  if (!baseline) return;
  await client.begin(async tx => {
    for (const row of owned) {
      // Absence was proved before these exact product IDs/slugs were registered.
      if (claimKeys.has(row.productId)) await tx`DELETE FROM evidence_source_claims WHERE product_id=${row.productId}`;
      if (requestKeys.has(row.productId)) await tx`DELETE FROM product_refresh_requests WHERE product_id=${row.productId}`;
      for (const table of ['product_links', 'product_evidence_sources', 'product_evidence_audit'])
        await tx.unsafe(`DELETE FROM "${table}" WHERE slug=$1`, [row.slug]);
      await tx`DELETE FROM products WHERE id=${row.productId} AND slug=${row.slug}`;
      await tx`DELETE FROM cdn_purges WHERE slug=${row.slug}`;
    }
    await tx`DELETE FROM job_batch_candidates WHERE role='site-evidence' AND instance_id=${prefix}`;
    for (const [table, key, value] of managed) await restoreManaged(tx, table, key, value);
    for (const row of suspended) {
      const [current] = await tx`SELECT to_jsonb(t) AS row FROM products t WHERE id=${Number(row.id)}`;
      expect({ ...current.row, access_mode: row.access_mode }).toEqual(row);
      await tx`UPDATE products SET access_mode=${String(row.access_mode)} WHERE id=${Number(row.id)}`;
    }
    for (const row of requests) {
      const [current] = await tx`SELECT to_jsonb(t) AS row FROM product_refresh_requests t WHERE product_id=${Number(row.product_id)}`;
      expect({ ...current.row, next_attempt_at: row.next_attempt_at }).toEqual(row);
      await tx`UPDATE product_refresh_requests t SET next_attempt_at=r.next_attempt_at FROM jsonb_populate_record(NULL::product_refresh_requests,${JSON.stringify(row)}::text::jsonb) r WHERE t.product_id=r.product_id`;
    }
    expect(await snapshot(tx)).toEqual(baseline);
  });
  owned.length = 0; claimKeys.clear(); requestKeys.clear();
  expect(await catalogSnapshot()).toEqual(catalog);
}
async function cleanup() {
  if (cleaning) return cleaning;
  const current = cleanupOnce(); cleaning = current;
  try { await current; } finally { if (cleaning === current) cleaning = undefined; }
}
beforeAll(() => setup = track((async () => {
  ensureSchema();
  const found = await client`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
  tables = found.map(row => row.tablename as string);
  baseline = await snapshot(); catalog = await catalogSnapshot();
  writeFileSync(`/tmp/${prefix}-baseline.json`, JSON.stringify({ baseline, catalog }));
  expect(baseline.job_batch_candidates.some(row => row.instance_id === prefix)).toBe(false);
  // This fixture never evicts a healthy foreign owner, including unrelated jobs/items.
  const [busy] = await client`SELECT EXISTS(SELECT 1 FROM jobs WHERE lease_token IS NOT NULL AND locked_at>clock_timestamp()-interval '90 seconds')
    OR EXISTS(SELECT 1 FROM role_leases WHERE owner_instance_id IS NOT NULL AND lease_until>clock_timestamp())
    OR EXISTS(SELECT 1 FROM evidence_source_claims WHERE token IS NOT NULL AND lease_until>clock_timestamp())
    OR EXISTS(SELECT 1 FROM pipeline_item_leases WHERE token IS NOT NULL AND lease_until>clock_timestamp()) AS busy`;
  expect(busy.busy).toBe(false);
  suspended.push(...baseline.products.filter(row => ['seeded', 'verified'].includes(String(row.status)) && row.access_mode === 'website'));
  requests.push(...baseline.product_refresh_requests.filter(row => Number(row.requested_version) > Number(row.completed_version)));
})()));
beforeEach(() => track((async () => {
  for (const row of suspended) await client`UPDATE products SET access_mode='installable' WHERE id=${Number(row.id)}`;
  for (const row of requests) await client`UPDATE product_refresh_requests SET next_attempt_at='9999-01-01Z' WHERE product_id=${Number(row.product_id)}`;
  await client`UPDATE job_batch_control SET mode='legacy',draining_from=NULL,epoch=1,writer_contract_version=1,policy=${client.json(policy)},policy_hash=${batchPolicyHash(policy)} WHERE id=1`;
  await client`UPDATE evidence_source_control SET enabled=true,cursor=0 WHERE id=1`;
  await client`INSERT INTO evidence_settings(id,values) VALUES(1,'{}') ON CONFLICT(id) DO UPDATE SET values='{}'`;
  for (const name of names) await client`INSERT INTO jobs(name) VALUES(${name}) ON CONFLICT(name) DO UPDATE SET locked_at=NULL,lease_token=NULL,not_before=NULL`;
})()));
afterEach(async () => { await allSteps([drain, cleanup, async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); }]); });
afterAll(async () => { await allSteps([cleanup, () => client.end()]); });
async function target() {
  const slug = `${prefix}-${owned.length}`;
  expect(await client`SELECT id FROM products WHERE slug=${slug}`).toEqual([]);
  for (const table of ['product_links', 'product_evidence_sources', 'product_evidence_audit', 'cdn_purges'])
    expect(await client.unsafe(`SELECT 1 FROM "${table}" WHERE slug=$1 LIMIT 1`, [slug])).toEqual([]);
  const [row] = await db.insert(products).values({ slug, url: `https://${slug}.example`, name: slug, tagline: 'Evidence', description: 'Evidence',
    category: 'Other', status: 'verified', verifyToken: 'test', editTokenHash: 'a'.repeat(64), createdAt: new Date('1900-01-01') })
    .returning({ productId: products.id, slug: products.slug, url: products.url });
  owned.push(row);
  expect(await client`SELECT 1 FROM evidence_source_claims WHERE product_id=${row.productId}`).toEqual([]); claimKeys.add(row.productId);
  expect(await client`SELECT 1 FROM product_refresh_requests WHERE product_id=${row.productId}`).toEqual([]); requestKeys.add(row.productId);
  return row;
}
async function rawClaim(id: number) { return (await client`SELECT to_jsonb(t) AS row FROM evidence_source_claims t WHERE product_id=${id}`)[0]?.row; }
const collected = (url: string) => ({ state: 'ok' as const, facts: { type: 'site_fingerprint' as const, finalUrl: url,
  bodyDigest: 'a'.repeat(64), parserVersion: 1 as const, repositoryKeys: [] }, etag: null, lastModified: null });
function setRole(lease: RoleLease) {
  const values = { ROLE_LEASE_ROLE: lease.role, ROLE_LEASE_INSTANCE_ID: lease.instanceId, ROLE_LEASE_BOOT_ID: lease.bootId,
    ROLE_LEASE_RELEASE: lease.release, ROLE_LEASE_EPOCH: String(lease.epoch), ROLE_LEASE_BATCH_VERSION: lease.batchVersion ? '1' : undefined,
    ROLE_LEASE_BATCH_EPOCH: lease.batchEpoch ? String(lease.batchEpoch) : undefined, ROLE_LEASE_HOST: lease.host };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}
async function versioned() {
  await client`UPDATE job_batch_control SET mode='versioned' WHERE id=1`;
  const [clock] = await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  // OPERATOR FIXTURE SEED ONLY: it opens the test admission gate, not an actual source/operational canary.
  const evidence = { host: identity.host, release: prefix, instanceId: prefix, dbPrivileges: 'verified', dbRole: 'fixture-only',
    effectivePrivilegeHash: 'a'.repeat(64), http: 'verified', model: 'unknown', observedAt: clock.at };
  const result = { ...identity, batchVersion: undefined, kind: undefined, role: identity.role, batchEpoch: 1,
    job: siteJob, recordedAt: clock.at, count: 41, requestedVersion: 1 };
  delete result.batchVersion; delete result.kind;
  const readback = { job: siteJob, instanceId: prefix, host: identity.host, release: prefix, requestedVersion: 1,
    domainReadbackHash: 'b'.repeat(64), observedAt: clock.at };
  await client`INSERT INTO operations_observations(key,value,observed_at) VALUES(${`batch-result:${prefix}:${siteJob}`},${client.json({ batchResult: result })},clock_timestamp())`;
  await client`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
    VALUES('site-evidence',${prefix},${identity.host},${identity.bootId},${prefix},${batchPolicyHash(policy)},${client.json(evidence)},${client.json(readback)})`;
  const lease = await tryAcquireRole(identity); expect(lease).not.toBeNull(); setRole(lease!);
  return { lease: lease!, evidence };
}
function mockCanonical() {
  const calls: string[] = [];
  const pending = import('@/lib/net/fetch').then(net => vi.spyOn(net, 'fetchCapped').mockImplementation(async url => {
    calls.push(url);
    expect(owned.some(row => row.url === url)).toBe(true); // Any GitHub/media/foreign HTTP fails here.
    return { ok: true as const, status: 200, finalUrl: url, headers: new Headers(), body: Buffer.from('<html>canonical only</html>') };
  }));
  return { calls, pending };
}
async function withJob<T>(role: RoleLease | undefined, body: (job: JobLease) => Promise<T>, name = siteJob, expectedStatus = 'completed') {
  let value!: T, failure: unknown;
  const result = await track(runJob<null>(name, async ctx => {
    try { value = await body(ctx.lease!); return { done: true }; } catch (error) { failure = error; throw error; }
  }, { roleLease: role }));
  if (failure !== undefined) throw failure;
  expect(result.status).toBe(expectedStatus); return value;
}
it('legacy direct site dispatch is blocked without touching requests or handlers', async () => {
  await requestJob(siteJob);
  const [before] = await client`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${siteJob}`;
  let calls = 0;
  expect(await runJob(siteJob, async () => { calls++; return { done: true }; }, { requestedOnly: true })).toMatchObject({ status: 'skipped', reason: 'stopping' });
  expect(calls).toBe(0);
  expect((await client`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${siteJob}`)[0].row).toEqual(before.row);
});
it('versioned requires the genuine site role and the real source result is atomically ACKed with its readback', async () => {
  const row = await target();
  await queueProductRefresh({ slug: row.slug, productId: row.productId, actor: 'fixture', force: true });
  const { lease, evidence } = await versioned();
  const net = mockCanonical(); await net.pending;
  expect(await runJob(siteJob, refreshSiteEvidenceJob)).toMatchObject({ status: 'skipped', reason: 'stopping' });
  expect(net.calls).toEqual([]);
  expect(await runJob(siteJob, refreshSiteEvidenceJob, { roleLease: lease, requestedOnly: true })).toMatchObject({ status: 'completed', done: true });
  expect(net.calls).toEqual([row.url]);
  const [source] = await client`SELECT to_jsonb(s) AS row FROM product_evidence_sources s WHERE slug=${row.slug} AND kind='documentation' AND source_key='canonical_site'`;
  expect(source.row).toMatchObject({ state: 'ok', source_url: row.url, normalized_facts: { type: 'site_fingerprint', finalUrl: row.url } });
  const claim = await rawClaim(row.productId);
  expect(claim).toMatchObject({ token: null, last_outcome: 'ok', binding: { productId: row.productId, requestVersion: 1 } });
  const [request] = await client`SELECT to_jsonb(r) AS row FROM product_refresh_requests r WHERE product_id=${row.productId}`;
  expect(request.row).toMatchObject({ active_version: 1, completed_version: 0,
    progress: { completedKeys: [sourceRefreshKey({ kind: 'documentation', sourceKey: 'canonical_site', sourceUrl: row.url })] } });
  const [ack] = await client`SELECT value FROM operations_observations WHERE key=${`batch-result:${prefix}:${siteJob}`}`;
  const [job] = await client`SELECT requested_version,processed_version,lease_token FROM jobs WHERE name=${siteJob}`;
  expect(ack.value.batchResult).toMatchObject({ job: siteJob, count: 1, requestedVersion: Number(job.processed_version), instanceId: prefix });
  expect(Number(job.requested_version)).toBeGreaterThan(Number(job.processed_version)); expect(job.lease_token).toBeNull();
  const [clock] = await client`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  const readback = { job: siteJob, instanceId: prefix, host: identity.host, release: prefix, requestedVersion: Number(job.processed_version),
    domainReadbackHash: createHash('sha256').update(JSON.stringify({ source: source.row, claim, request: request.row })).digest('hex'), observedAt: clock.at };
  const check = { role: identity.role, host: identity.host, instanceId: prefix, release: prefix, at: Date.parse(clock.at), evidence, result: ack.value.batchResult };
  expect(classifyBatchReadiness(check).ready).toBe(false);
  expect(classifyBatchReadiness({ ...check, readback }).ready).toBe(true);
  expect(await releaseRole(lease)).toBe(true);
});
it('legacy inline still collects canonical while the versioned old consumer cannot collect it', async () => {
  const row = await target();
  const legacy = await tryAcquireRole({ role: 'crawler', instanceId: prefix, bootId: identity.bootId, release: prefix, kind: 'primary' });
  expect(legacy).not.toBeNull(); setRole(legacy!);
  const net = mockCanonical(); await net.pending;
  // Keep the product/GitHub request not due; canonical admission is independently due.
  await client`INSERT INTO product_refresh_requests(product_id,slug,actor,requested_version,completed_version,active_version,active_force,next_attempt_at)
    VALUES(${row.productId},${row.slug},'fixture',1,0,1,true,clock_timestamp()+interval '1 day')`;
  const github = vi.fn();
  expect(await runJob<EvidenceRefreshCursor>(oldJob, ctx => refreshProductEvidenceJob({ ...ctx, hasBudget: () => ctx.hasBudget() && net.calls.length === 0 }, { github }), { roleLease: legacy! })).toMatchObject({ status: 'completed' });
  expect(net.calls).toEqual([row.url]); expect(github).not.toHaveBeenCalled();
  expect(await releaseRole(legacy!)).toBe(true);
  await client`DELETE FROM product_evidence_sources WHERE slug=${row.slug}`;
  await client`DELETE FROM evidence_source_claims WHERE product_id=${row.productId}`;
  const { lease } = await versioned();
  // The crawler role still owns the old product work in versioned mode; no inline canonical dispatch.
    // Direct old execution is intentionally rejected by versioned admission without its own genuine role.
  let dispatched = 0;
  expect(await runJob<EvidenceRefreshCursor>(oldJob, async ctx => { dispatched++; return refreshProductEvidenceJob(ctx, { github }); })).toMatchObject({ status: 'skipped', reason: 'stopping' });
  expect(dispatched).toBe(0); expect(net.calls).toEqual([row.url]);
  expect(await runJob(siteJob, refreshSiteEvidenceJob, { roleLease: lease })).toMatchObject({ status: 'completed' });
  expect(net.calls).toEqual([row.url, row.url]);
  expect(await releaseRole(lease)).toBe(true);
});
it('a live original source survives draining and its actual owner can settle before the transition', async () => {
  const row = await target(), lease = await claimCanonicalEvidenceSource({ owner, productId: row.productId }); expect(lease).not.toBeNull();
  const before = await rawClaim(row.productId);
  await beginJobBatchDrain();
  await expect(completeJobBatchTransition('versioned')).rejects.toThrow('job_batch_not_drained');
  expect(await rawClaim(row.productId)).toEqual(before);
  expect(await recordCanonicalEvidenceSource(lease!, collected(row.url))).toEqual({ state: 'recorded', factsChanged: 1 });
  expect(await completeJobBatchTransition('versioned')).toMatchObject({ mode: 'versioned' });
});
it('transition waits for the actual source renewal control lock before locking jobs and preserves the renewed owner', async () => {
  const row = await target(), lease = await claimCanonicalEvidenceSource({ owner, productId: row.productId }); expect(lease).not.toBeNull();
  await beginJobBatchDrain();
  const ready = Promise.withResolvers<void>(), open = Promise.withResolvers<void>(); let holderPid = 0;
  const trigger = `${prefix.replaceAll('-', '_')}_renew`, lockKey = 871032;
  await client.unsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NEW; END $$`);
  let installed = false;
  await client.unsafe(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON evidence_source_claims FOR EACH ROW WHEN (NEW.product_id=${row.productId} AND NEW.token=OLD.token AND NEW.lease_until>OLD.lease_until) EXECUTE FUNCTION "${trigger}"()`); installed = true;
  const [anchor] = await client`UPDATE evidence_source_claims SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE product_id=${row.productId} RETURNING lease_until::text AS expiry`;
  // Block the actual renewal UPDATE after it has locked source control and authenticated its original owner.
  const holder = track(client.begin(async tx => {
    holderPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
    await tx`SELECT pg_advisory_xact_lock(${lockKey})`;
    ready.resolve(); await open.promise;
  }));
  let renewing: Promise<unknown> | undefined, transitioning: Promise<unknown> | undefined, transitionError: unknown, renewPid = 0;
  const errors: unknown[] = [];
  try {
    await Promise.race([ready.promise, holder]);
    renewing = track(renewCanonicalEvidenceSource(lease!));
    await vi.waitFor(async () => {
      const [wait] = await client`SELECT pid FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))`;
      expect(wait?.pid).toBeDefined(); renewPid = Number(wait.pid);
    });
    transitioning = track(completeJobBatchTransition('versioned').catch(error => { transitionError = error; }));
    await vi.waitFor(async () => {
      const [wait] = await client`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${renewPid}=ANY(pg_blocking_pids(pid))) AS waiting`;
      expect(wait.waiting).toBe(true);
    });
    // The transition must not acquire either outbox job while waiting for the renew.
    await client.begin(async tx => { for (const name of names) await tx`SELECT name FROM jobs WHERE name=${name} FOR UPDATE NOWAIT`; });
    await vi.waitFor(async () => { expect((await client`SELECT ${anchor.expiry}::text::timestamptz<=clock_timestamp() AS expired`)[0].expired).toBe(true); });
  } catch (error) { errors.push(error); } finally { open.resolve(); await allSteps([() => holder, async () => { expect(await renewing).toMatchObject({ token: lease!.token }); }, async () => { await transitioning; },
    async () => { if (installed) await client.unsafe(`DROP TRIGGER "${trigger}" ON evidence_source_claims`); }, () => client.unsafe(`DROP FUNCTION "${trigger}"()`)], errors); }
  expect(transitionError).toBeInstanceOf(Error); expect((transitionError as Error).message).toBe('job_batch_not_drained');
  expect(await rawClaim(row.productId)).toMatchObject({ token: lease!.token, instance_id: owner.instanceId, boot_id: owner.bootId,
    binding_hash: lease!.bindingHash, epoch: lease!.epoch });
  expect(await recordCanonicalEvidenceSource(lease!, collected(row.url))).toEqual({ state: 'recorded', factsChanged: 1 });
});
it('a mode change closes only new admission and preserves the genuine source owner plus successful ACK', async () => {
  const row = await target(), { lease } = await versioned();
  await withJob(lease, async job => {
    const source = await claimCanonicalEvidenceSource({ owner, productId: row.productId, job, roleLease: lease }); expect(source).not.toBeNull();
    await beginJobBatchDrain();
    expect(await recordCanonicalEvidenceSource(source!, collected(row.url))).toEqual({ state: 'recorded', factsChanged: 1 });
  });
  expect((await client`SELECT lease_token FROM jobs WHERE name=${siteJob}`)[0].lease_token).toBeNull();
  expect(await releaseRole(lease)).toBe(true);
  expect(await completeJobBatchTransition('legacy')).toMatchObject({ mode: 'legacy' });
});
it('the sorted second wakeup fault rolls back canonical storage, progress, cursor, and original release', async () => {
  const row = await target(), { lease } = await versioned();
  await queueProductRefresh({ slug: row.slug, productId: row.productId, actor: 'fixture', force: true });
  await withJob(lease, async job => {
    const source = await claimCanonicalEvidenceSource({ owner, productId: row.productId, job, roleLease: lease }); expect(source).not.toBeNull();
    const before = await snapshot(); const trigger = `${prefix.replaceAll('-', '_')}_fault`; let installed = false;
    const errors: unknown[] = []; let failure: unknown;
    await client.unsafe(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'site_outbox_fault'; END $$`);
    try {
      await client.unsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW WHEN (NEW.name='${siteJob}') EXECUTE FUNCTION "${trigger}"()`); installed = true;
      try { await recordCanonicalEvidenceSource(source!, collected(row.url)); } catch (error) { failure = error; }
      expect((failure as { cause?: Error }).cause?.message ?? (failure as Error)?.message).toContain('site_outbox_fault');
      expect(await snapshot()).toEqual(before);
    } catch (error) { errors.push(error); } finally {
      await allSteps([async () => { if (installed) await client.unsafe(`DROP TRIGGER "${trigger}" ON jobs`); }, () => client.unsafe(`DROP FUNCTION "${trigger}"()`)], errors);
    }
    await abandonCanonicalEvidenceSource(source!);
  });
  expect(await releaseRole(lease)).toBe(true);
});
it('a second-job row wait crossing the real job wall rolls back both wakeups and source writes', async () => {
  const row = await target(), { lease } = await versioned();
  await withJob(lease, async job => {
    const source = await claimCanonicalEvidenceSource({ owner, productId: row.productId, job, roleLease: lease }); expect(source).not.toBeNull();
    const ready = Promise.withResolvers<void>(), open = Promise.withResolvers<void>(); let holderPid = 0, expiresAt = '';
    const holder = track(client.begin(async tx => {
      holderPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      const [anchor] = await tx`UPDATE jobs SET locked_at=clock_timestamp()-interval '90 seconds'+interval '500 milliseconds' WHERE name=${siteJob} RETURNING (locked_at+interval '90 seconds')::text AS expiry`;
      expiresAt = anchor.expiry;
      ready.resolve(); await open.promise;
    }));
    let writer: Promise<unknown> | undefined, failure: unknown; const errors: unknown[] = [];
    const beforeClaim = await rawClaim(row.productId);
    const [beforeOld] = await client`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${oldJob}`;
    try {
      await Promise.race([ready.promise, holder]);
      writer = track(recordCanonicalEvidenceSource(source!, collected(row.url)).catch(error => { failure = error; }));
      await vi.waitFor(async () => {
        const [wait] = await client`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))) AS blocked`;
        expect(wait.blocked).toBe(true);
      });
      await vi.waitFor(async () => {
        const [clock] = await client`SELECT ${expiresAt}::text::timestamp<=clock_timestamp() AS expired`;
        expect(clock.expired).toBe(true);
      });
    } catch (error) { errors.push(error); } finally {
      // Commit the holder's exact expired timestamp only after the real writer wait was observed.
      open.resolve(); await allSteps([() => holder, async () => { await writer; }], errors);
    }
    expect(failure).toBeInstanceOf(JobLeaseLostError);
    expect(await rawClaim(row.productId)).toEqual(beforeClaim);
    expect((await client`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${oldJob}`)[0].row).toEqual(beforeOld.row);
    expect(await client`SELECT 1 FROM product_evidence_sources WHERE slug=${row.slug}`).toEqual([]);
  }, siteJob, 'failed');
  expect(await releaseRole(lease)).toBe(true);
});
for (const expire of [false, true]) it(`new source claim checks the actual site role after a source-control wait (expire=${expire})`, async () => {
  const row = await target(), { lease } = await versioned();
  await withJob(lease, async job => {
    const ready = Promise.withResolvers<void>(), open = Promise.withResolvers<void>(); let holderPid = 0, expiry = '';
    const holder = track(client.begin(async tx => {
      holderPid = Number((await tx`SELECT pg_backend_pid() AS pid`)[0].pid);
      await tx`SELECT id FROM evidence_source_control WHERE id=1 FOR UPDATE`;
      ready.resolve(); await open.promise;
    }));
    let claiming: Promise<unknown> | undefined, result: Awaited<ReturnType<typeof claimCanonicalEvidenceSource>>, failure: unknown;
    const errors: unknown[] = [];
    try {
      await Promise.race([ready.promise, holder]);
      if (expire) {
        const [anchor] = await client`UPDATE role_leases SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE role='site-evidence' RETURNING lease_until::text AS expiry`;
        expiry = anchor.expiry;
      }
      claiming = track(claimCanonicalEvidenceSource({ owner, productId: row.productId, job, roleLease: lease })
        .then(value => { result = value; }, error => { failure = error; }));
      await vi.waitFor(async () => {
        const [wait] = await client`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))) AS blocked`;
        expect(wait.blocked).toBe(true);
      });
      expect((await client`SELECT lease_until>clock_timestamp() AS healthy FROM role_leases WHERE role='site-evidence'`)[0].healthy).toBe(true);
      if (expire) await vi.waitFor(async () => {
        const [clock] = await client`SELECT ${expiry}::text::timestamp<=clock_timestamp() AS expired`;
        expect(clock.expired).toBe(true);
      });
    } catch (error) { errors.push(error); } finally {
      open.resolve(); await allSteps([() => holder, async () => { await claiming; }], errors);
    }
    if (expire) {
      expect((failure as Error)?.message).toBe('role_lease_lost');
      expect(result!).toBeUndefined();
      expect(await rawClaim(row.productId)).toBeUndefined();
    } else {
      expect(failure).toBeUndefined(); expect(result!).not.toBeNull();
      await abandonCanonicalEvidenceSource(result!);
    }
  });
  expect(await releaseRole(lease)).toBe(true);
});
