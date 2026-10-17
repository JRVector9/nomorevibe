import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { batchCanaryAnchorKey, batchPolicyHash } from '@/lib/jobs/batches';
import { httpOriginPolicyHash } from '@/lib/net/http-origin-policy';
import { productTranslationSourceHash } from '@/lib/domain/products/translation-policy';
import { ORACLE_DB_PRINCIPALS, ORACLE_REFRESH_PRINCIPAL, oracleDbGrantStatements, type OracleDbService } from '@/lib/runtime/oracle-db-profile';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// Real PostgreSQL privileges. Capability/result rows seeded below are FIXTURE admission seeds that let the
// restricted child be elected; they are not Oracle canary evidence. External HTTP/model calls are loopback only.
const prefix = `o11c${randomUUID().slice(0, 6)}`, password = randomUUID();
const release = createHash('sha1').update(prefix).digest('hex'); // The runtime preflight accepts only a full40 release SHA.
const ROLES = ['official-news', 'product-health', 'site-evidence', 'translation'] as const;
type Role = typeof ROLES[number];
const JOBS: Record<Role, string[]> = { 'official-news': ['news-refresh'], 'product-health': ['uptime-ping'],
  'site-evidence': ['product-site-evidence-refresh'], translation: ['reason-translate', 'product-tagline-ko', 'product-translate'] };
const instance = (role: Role | 'scheduler') => `${prefix}-${role}`;
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: `${prefix}-admin` } });
const services: OracleDbService[] = [...ROLES, 'scheduler', 'attest'];
const policy = { version: 1 as const, release, instances: [...ROLES, 'scheduler' as const].map(role => ({ instanceId: instance(role), host: 'oracle-osaka-smoke' as const })) };
const httpPolicy = { version: 1 as const, instanceHosts: Object.fromEntries(policy.instances.map(row => [row.instanceId, 'oracle-osaka-smoke' as const])) };
// Children first for deletes; every row present before the file is restored byte-for-byte afterwards.
const RESTORED = ['model_capacity_events', 'model_capacity_requests', 'http_origin_events', 'http_origin_hops', 'uptime_observations', 'uptime_gates', 'product_health', 'product_evidence_audit',
  'product_links', 'product_evidence_sources', 'evidence_source_claims', 'product_refresh_requests', 'product_korean_taglines',
  'product_translations', 'text_translations', 'news_items', 'second_reviews', 'crawl_candidates', 'products', 'cdn_purges',
  'job_batch_candidates', 'operations_observations', 'jobs', 'role_leases', 'job_batch_control', 'http_origin_control', 'uptime_control',
  'evidence_source_control', 'evidence_settings', 'crawl_settings', 'model_capacity_control'];
const APPEND_ONLY = [['http_origin_events', 'http_origin_events_no_change'], ['uptime_observations', 'uptime_observations_no_change'],
  ['model_capacity_events', 'model_capacity_events_no_change']];
let server: Server, base = '', roleCatalog: unknown, baseline: Record<string, unknown[]> = {};
const keys: Record<string, string[]> = {};
const ids = { health: 0, site: 0, candidate: 0 };
type Canary = { ready: boolean; reason: string; bootId: string; anchorInvalidated: boolean; readbackRows: number; requestedVersion: number;
  capability: Record<string, string> };

function principalUrl(service: OracleDbService) {
  const url = new URL(TEST_DATABASE_URL); url.username = ORACLE_DB_PRINCIPALS[service]; url.password = password; return url.toString();
}
const roles = () => admin`SELECT rolname,rolsuper,rolcanlogin,rolconnlimit FROM pg_roles WHERE rolname LIKE 'nomorevibe_oracle_%' ORDER BY rolname`;
async function snapshot(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const rows = await tx.unsafe(RESTORED.map(table => `SELECT '${table}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM public."${table}" t`).join(' UNION ALL '));
  return Object.fromEntries(rows.map(row => [row.name, row.rows])) as Record<string, unknown[]>;
}
async function restore(tx: postgres.TransactionSql) {
  for (const [table, trigger] of APPEND_ONLY) await tx.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  for (const table of RESTORED) {
    const pk = keys[table], original = baseline[table] as Record<string, unknown>[];
    const key = `jsonb_build_object(${pk.map(column => `'${column}',t."${column}"`).join(',')})`;
    await tx.unsafe(`DELETE FROM public."${table}" t WHERE NOT (${key} = ANY(SELECT jsonb_build_object(${pk.map(column => `'${column}',r->'${column}'`).join(',')}) FROM jsonb_array_elements($1::text::jsonb) r))`,
      [JSON.stringify(original)]);
  }
  for (const table of [...RESTORED].reverse()) {
    const columns = (await tx`SELECT attname FROM pg_attribute WHERE attrelid=${`public.${table}`}::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`).map(row => `"${row.attname}"`).join(',');
    for (const row of baseline[table] as Record<string, unknown>[]) {
      const match = keys[table].map(column => `t."${column}"=r."${column}"`).join(' AND ');
      const updated = await tx.unsafe(`UPDATE public."${table}" t SET (${columns})=(SELECT ${columns} FROM jsonb_populate_record(NULL::public."${table}",$1::text::jsonb)) FROM jsonb_populate_record(NULL::public."${table}",$1::text::jsonb) r WHERE ${match} RETURNING 1`, [JSON.stringify(row)]);
      if (!updated.length) await tx.unsafe(`INSERT INTO public."${table}"(${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::public."${table}",$1::text::jsonb)`, [JSON.stringify(row)]);
    }
  }
  for (const [table, trigger] of APPEND_ONLY) await tx.unsafe(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`);
}
function child(service: OracleDbService, input: Record<string, unknown>, attestService: OracleDbService = 'attest', asRole?: Role,
  instanceId?: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; output: Record<string, unknown> }> {
  const role = asRole ?? service as Role | 'scheduler';
  return new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/oracle-role-db-driver.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? 'test', LOG_LEVEL: 'error', DATABASE_URL: principalUrl(service),
        DB_POOL_MAX: '3', WORKER_ROLE: role, SERVICE_INSTANCE_ID: instanceId ?? instance(role), RELEASE_TAG: release, JOB_BATCH_VERSION: '1',
        PHYSICAL_HOST: 'oracle-osaka-smoke', HTTP_ORIGIN_PERMITS: '1', ALLOW_PRIVATE_URLS: '1', ABCLLM_API_KEY: 'local-fixture-only',
        ABCLLM_BASE_URL: `${base}/gateway`, ORACLE_ATTEST_DATABASE_URL: principalUrl(attestService), ORACLE_DRIVER_INPUT: JSON.stringify(input),
        ...extraEnv },
    });
    let stdout = '', stderr = '';
    process_.stdout.on('data', data => { stdout += String(data); });
    process_.stderr.on('data', data => { stderr += String(data); });
    process_.once('error', reject);
    process_.once('exit', code => {
      try { resolve({ code, output: JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') }); }
      catch { reject(new Error(`driver_output_invalid:${stdout.slice(-500)}:${stderr.slice(-2000)}`)); }
    });
  });
}
function fixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/news/')) {
      if (decodeURIComponent(url.pathname.slice(6)) !== 'https://openai.com/news/rss.xml') { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/rss+xml' }).end(`<rss><channel><item><title>${prefix} release</title>`
        + `<link>https://openai.com/index/${prefix}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
      return;
    }
    if (url.pathname.startsWith('/site/')) { response.writeHead(200, { 'content-type': 'text/html' }).end(`<html><title>${prefix}</title><body>docs</body></html>`); return; }
    if (url.pathname === '/gateway/v1/chat/completions' && request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const items = JSON.parse(JSON.parse(body).messages[1].content) as unknown[];
        const content = items.map(item => typeof item === 'string' ? '제품이 아니라 문서 페이지라서 거절했다'
          : 'field' in (item as object) ? 'A small tool that tracks daily habits' : `${(item as { name: string }).name} 이라는 습관 기록 도구`);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      });
      return;
    }
    response.writeHead(404).end();
  });
}
async function product(slug: string, url: string) {
  const [row] = await admin`INSERT INTO products(slug,url,name,tagline,description,category,status,source,verify_token,edit_token_hash,created_at)
    VALUES(${slug},${url},${slug},'Track your daily habits','Habit tracker','Dev','verified','crawler','fixture',${'e'.repeat(64)},now()-interval '30 days') RETURNING id`;
  return row.id as number;
}
async function seed() {
  const [clock] = await admin`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;
  const [control] = await admin`SELECT epoch FROM job_batch_control WHERE id=1`;
  // Existing public website products are suspended so no fixture job can contact a non-loopback host.
  await admin`UPDATE products SET access_mode='installable' WHERE access_mode='website'`;
  await admin`UPDATE job_batch_control SET mode='versioned',draining_from=NULL,writer_contract_version=1,policy=${admin.json(policy)},policy_hash=${batchPolicyHash(policy)} WHERE id=1`;
  await admin`UPDATE http_origin_control SET mode='open',policy=${admin.json(httpPolicy)},policy_hash=${httpOriginPolicyHash(httpPolicy)} WHERE id=1`;
  await admin`UPDATE uptime_control SET observations_enabled=true,gate_enabled=false,sources=${admin.json([{ host: 'oracle-osaka-smoke', instanceId: instance('product-health'), region: 'ap-osaka-1' }])} WHERE id=1`;
  await admin`UPDATE evidence_source_control SET enabled=true WHERE id=1`;
  await admin`INSERT INTO evidence_settings(id,values) VALUES(1,'{}') ON CONFLICT(id) DO NOTHING`;
  for (const role of ROLES) {
    const job = JOBS[role][0], at = clock.at as string, id = instance(role);
    // FIXTURE ADMISSION SEED ONLY (see file header).
    const capability = { host: 'oracle-osaka-smoke', release, instanceId: id, dbPrivileges: 'verified', dbRole: 'fixture-only',
      effectivePrivilegeHash: 'a'.repeat(64), http: 'verified', model: 'verified', modelBoundEvidenceHash: 'b'.repeat(64), observedAt: at };
    const result = { role, batchEpoch: Number(control.epoch), job, instanceId: id, host: 'oracle-osaka-smoke', release, bootId: 'fixture',
      recordedAt: at, count: 1, requestedVersion: 1 };
    const readback = { job, instanceId: id, host: 'oracle-osaka-smoke', release, requestedVersion: 1, domainReadbackHash: 'c'.repeat(64), observedAt: at };
    await admin`INSERT INTO operations_observations(key,value) VALUES(${`batch-result:${id}:${job}`},${admin.json({ batchResult: result })})`;
    await admin`INSERT INTO job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence)
      VALUES(${role},${id},'oracle-osaka-smoke','fixture',${release},${batchPolicyHash(policy)},${admin.json(capability)},${admin.json(readback)})`;
  }
  ids.health = await product(`${prefix}-health`, `${base}/site/${prefix}`);
  const source = { id: ids.health, name: `${prefix}-health`, tagline: 'Track your daily habits' };
  await admin`INSERT INTO product_translations(product_id,locale,field,source_hash,provenance) VALUES(${ids.health},'en','tagline',${productTranslationSourceHash(source, 'tagline')},'{}')`;
  const [candidate] = await admin`INSERT INTO crawl_candidates(repo) VALUES(${`${prefix}/repo`}) RETURNING id`;
  ids.candidate = candidate.id;
  await admin`INSERT INTO second_reviews(candidate_id,repo,trigger,first_decision,input_hash,status,second_decision,second_reason,model)
    VALUES(${candidate.id},${`${prefix}/repo`},'ai_decided','reject','fixture','needs_human','reject',${`The page ${prefix} is documentation, not a usable product.`},'fixture')`;
}

beforeAll(async () => {
  ensureSchema();
  roleCatalog = await roles();
  expect(roleCatalog).toEqual([]);
  for (const table of RESTORED) keys[table] = (await admin`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
    WHERE i.indrelid=${`public.${table}`}::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)`).map(row => row.attname as string);
  expect(Object.values(keys).every(pk => pk.length > 0)).toBe(true);
  baseline = await snapshot();
  const [busy] = await admin`SELECT EXISTS(SELECT 1 FROM role_leases WHERE owner_instance_id IS NOT NULL AND lease_until>clock_timestamp())
    OR EXISTS(SELECT 1 FROM jobs WHERE lease_token IS NOT NULL) AS busy`;
  expect(busy.busy).toBe(false);
  server = fixtureServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const service of services) {
    for (const statement of oracleDbGrantStatements(service, { connectionLimit: 8 })) await admin.unsafe(statement);
    await admin.unsafe(`ALTER ROLE ${ORACLE_DB_PRINCIPALS[service]} PASSWORD '${password}'`);
  }
  await seed();
}, 120_000);

afterAll(async () => {
  const errors: unknown[] = [];
  for (const step of [() => new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()),
    () => admin.begin(async tx => {
      await restore(tx);
      for (const service of services) {
        const name = ORACLE_DB_PRINCIPALS[service];
        if ((await tx`SELECT 1 FROM pg_roles WHERE rolname=${name}`).length) { await tx.unsafe(`DROP OWNED BY ${name}`); await tx.unsafe(`DROP ROLE ${name}`); }
      }
      const after = await snapshot(tx);
      expect(RESTORED.filter(table => JSON.stringify(after[table]) !== JSON.stringify(baseline[table]))).toEqual([]);
      expect(after).toEqual(baseline);
    }),
    async () => { expect(await roles()).toEqual(roleCatalog); }, () => admin.end({ timeout: 5 })]) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'oracle_db_roles_cleanup_failed');
}, 60_000);

// Each statement is a no-op if a regression ever allowed it; the expected result is a privilege error.
const COMMON_DENIED = ['UPDATE public.job_batch_control SET mode=mode WHERE false',
  'UPDATE public.job_batch_candidates SET capability=capability,result_evidence=result_evidence WHERE false',
  'DELETE FROM public.operations_observations WHERE false', 'DELETE FROM public.jobs WHERE false',
  'UPDATE public.products SET status=status WHERE false', "INSERT INTO public.crawl_candidates(repo) SELECT 'x' WHERE false",
  'CREATE TABLE public.oracle_negative_probe(id integer)'];
const DENIED: Record<Role | 'scheduler', string[]> = {
  'official-news': ['UPDATE public.news_items SET state=state WHERE false', 'UPDATE public.http_origin_control SET mode=mode WHERE false'],
  'product-health': ['DELETE FROM public.uptime_observations WHERE false', 'UPDATE public.uptime_control SET gate_enabled=gate_enabled WHERE false'],
  'site-evidence': ['UPDATE public.evidence_source_control SET enabled=enabled WHERE false', 'DELETE FROM public.product_evidence_sources WHERE false'],
  translation: ['UPDATE public.second_reviews SET status=status WHERE false', 'UPDATE public.model_capacity_control SET mode=mode WHERE false'],
  scheduler: ["INSERT INTO public.role_leases(role) SELECT 'x' WHERE false", 'SELECT 1 FROM public.products LIMIT 1'],
};

it.each(ROLES)('runs the actual %s role path with only its least-privilege principal', async role => {
  if (role === 'site-evidence') {
    // The uptime target leaves the site queue; the canonical row needs a public-form URL that is never fetched here.
    await admin`UPDATE products SET access_mode='installable' WHERE id=${ids.health}`;
    ids.site = await product(`${prefix}-site`, `https://${prefix}-site.example/`);
  }
  const negatives = [...COMMON_DENIED, ...DENIED[role]];
  const { code, output } = await child(role, { role, jobs: JOBS[role], httpBase: base, bootId: randomUUID(), negatives });
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  expect(code).toBe(0);
  expect(output.principal).toBe(ORACLE_DB_PRINCIPALS[role]);
  for (const job of JOBS[role]) expect((output.runs as Record<string, { status: string }>)[job].status).toBe('completed');
  expect(output.renewed).toBe(true); expect(output.released).toBe(true);
  const preflight = output.preflight as { checks: Record<string, { status: string; reason: string }> };
  expect(preflight.checks.database).toMatchObject({ status: 'verified', reason: 'approved_privilege_profile_matches' });
  expect(preflight.checks.timeouts.status).toBe('verified'); expect(preflight.checks.batch.status).toBe('verified');
  expect(output.negatives).toEqual(Object.fromEntries(negatives.map(statement => [statement, '42501'])));
  // Domain readback through the administrator connection: the restricted process actually wrote these rows.
  const written = {
    'official-news': admin`SELECT count(*)::int AS n FROM news_items WHERE url=${`https://openai.com/index/${prefix}`}`,
    'product-health': admin`SELECT count(*)::int AS n FROM uptime_observations WHERE instance_id=${instance(role)} AND status=200 AND disposition='raw_only'`,
    'site-evidence': admin`SELECT count(*)::int AS n FROM product_evidence_sources WHERE slug=${`${prefix}-site`} AND state='ok'`,
    translation: admin`SELECT ((SELECT count(*) FROM text_translations t JOIN second_reviews s ON t.source_hash=encode(sha256(convert_to(s.second_reason,'UTF8')),'hex')
      WHERE s.candidate_id=${ids.candidate} AND t.status='done') + (SELECT count(*) FROM product_korean_taglines WHERE product_id=${ids.health})
      + (SELECT count(*) FROM product_translations WHERE product_id=${ids.health} AND attempts=1))::int AS n`,
  }[role];
  expect((await written)[0].n).toBe(role === 'translation' ? 3 : 1);
  const [hops] = await admin`SELECT count(*) FILTER (WHERE state='released')::int AS released, count(*) FILTER (WHERE state<>'released')::int AS other
    FROM http_origin_hops WHERE instance_id=${instance(role)}`;
  expect(hops.other).toBe(0);
  // Site collection HTTP is the fixed fixture above; news/uptime used the actual shared origin permits.
  if (role === 'official-news' || role === 'product-health') expect(hops.released).toBeGreaterThan(0);
}, 60_000);

it('runs the independent scheduler path with only its principal', async () => {
  const negatives = [...COMMON_DENIED.filter(statement => !statement.includes('job_batch_candidates')), ...DENIED.scheduler];
  const { code, output } = await child('scheduler', { role: 'scheduler', jobs: [], httpBase: base, bootId: randomUUID(), negatives });
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  expect(code).toBe(0);
  expect(output.principal).toBe(ORACLE_DB_PRINCIPALS.scheduler); expect(typeof output.requested).toBe('number');
  expect(output.negatives).toEqual(Object.fromEntries(negatives.map(statement => [statement, '42501'])));
}, 60_000);

async function canaryState(role: Role) {
  const [candidate] = await admin`SELECT boot_id AS "bootId",capability,result_evidence AS "resultEvidence" FROM job_batch_candidates WHERE role=${role} AND instance_id=${instance(role)}`;
  const [anchor] = await admin`SELECT value FROM operations_observations WHERE key LIKE 'batch-canary:%' AND value->'batchCanary'->'result'->>'instanceId'=${instance(role)}`;
  const job = JOBS[role][0];
  const [result] = await admin`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${`batch-result:${instance(role)}:${job}`}`;
  const [jobRow] = await admin`SELECT processed_version FROM jobs WHERE name=${job}`;
  const [control] = await admin`SELECT epoch FROM job_batch_control WHERE id=1`;
  return { candidate, anchor: anchor?.value, result: result.result, processed: Number(jobRow.processed_version), epoch: Number(control.epoch) };
}
const io = (role: Role, mode: string, bootId = randomUUID()) => ({ role, jobs: JOBS[role], httpBase: base, bootId, negatives: [], mode });

it('records a genuine product-health canary only through the attest principal and the runtime preflight becomes ready', async () => {
  // The public-form site URL is never contacted; a fresh loopback product is the canary tick's only target.
  await admin`UPDATE products SET access_mode='installable' WHERE id=${ids.site}`;
  await product(`${prefix}-canary`, `${base}/site/${prefix}-canary`);
  const { code, output } = await child('product-health', io('product-health', 'canary'));
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  expect(code).toBe(0);
  const canary = output.canary as { before: Canary; run: { status: string }; after: Canary };
  const positive = { dbPrivileges: 'verified', http: 'verified', model: 'unknown' };
  expect(canary.before).toMatchObject({ ready: true, reason: 'ready', anchorInvalidated: true, readbackRows: 1, capability: positive });
  expect(canary.run.status).toBe('completed');
  expect(canary.after).toMatchObject({ ready: true, reason: 'ready', anchorInvalidated: true, readbackRows: 1, capability: positive });
  const state = await canaryState('product-health');
  expect(state.anchor).toBeUndefined();
  expect(state.candidate.bootId).toBe(canary.after.bootId);
  expect(state.candidate.capability).toMatchObject({ dbRole: ORACLE_DB_PRINCIPALS['product-health'], dbPrivileges: 'verified', http: 'verified', model: 'unknown' });
  expect(state.candidate.resultEvidence).toMatchObject({ job: 'uptime-ping', requestedVersion: state.processed });
  expect(state.result).toMatchObject({ role: 'product-health', bootId: canary.after.bootId, batchEpoch: state.epoch, requestedVersion: state.processed });
  const [observed] = await admin`SELECT count(*)::int AS n FROM uptime_observations o JOIN products p ON p.id=o.product_id WHERE p.slug=${`${prefix}-canary`}`;
  expect(observed.n).toBe(1);
  const { output: inspected } = await child('product-health', io('product-health', 'preflight'));
  const preflight = inspected.preflight as { workload: Record<string, unknown>; checks: Record<string, { status: string }> };
  expect(preflight.workload).toMatchObject({ ready: true, reason: 'ready', job: 'uptime-ping' });
  for (const name of ['identity', 'batch', 'database', 'timeouts']) expect(preflight.checks[name].status).toBe('verified');
  // Capability-only re-observation keeps the stored result evidence and anchor state unchanged.
  const { output: refreshed } = await child('product-health', io('product-health', 'refresh'));
  expect(refreshed.refresh).toMatchObject(positive);
  const after = await canaryState('product-health');
  expect(after.candidate.resultEvidence).toEqual(state.candidate.resultEvidence); expect(after.anchor).toBeUndefined();
  expect(Date.parse(after.candidate.capability.observedAt)).toBeGreaterThanOrEqual(Date.parse(state.candidate.capability.observedAt));
}, 90_000);

it('a restarted boot keeps DB election but loses launch readiness until a new canary replaces the anchor', async () => {
  const restarted = randomUUID();
  const { output: beat } = await child('product-health', io('product-health', 'heartbeat', restarted));
  expect(beat).toMatchObject({ elected: true, released: true });
  const pinned = await canaryState('product-health');
  expect(pinned.candidate.bootId).toBe(restarted);
  expect(pinned.anchor).toMatchObject({ batchCanary: { kind: 'verified_batch_canary' } });
  const { output: stale } = await child('product-health', io('product-health', 'preflight'));
  expect((stale.preflight as { workload: { ready: boolean } }).workload.ready).toBe(false);
  // The stale-only attest keeps a still-valid anchor; launch readiness needs a result from the current boot.
  const { output: kept } = await child('product-health', io('product-health', 'attest'));
  expect(kept.attest).toMatchObject({ ready: true, anchorInvalidated: false, bootId: restarted });
  expect((await canaryState('product-health')).anchor).toEqual(pinned.anchor);
  await product(`${prefix}-canary2`, `${base}/site/${prefix}-canary2`);
  const { output } = await child('product-health', io('product-health', 'canary'));
  const canary = output.canary as { before: Canary; after: Canary };
  expect(canary.before).toMatchObject({ ready: true, anchorInvalidated: true });
  expect(canary.after).toMatchObject({ ready: true, anchorInvalidated: true });
  expect(canary.after.bootId).not.toBe(restarted);
  const { output: ready } = await child('product-health', io('product-health', 'preflight'));
  expect((ready.preflight as { workload: { ready: boolean } }).workload.ready).toBe(true);
}, 120_000);

it('keeps translation unknown without model-bound evidence and refuses a worker principal as the attester', async () => {
  const { output } = await child('translation', io('translation', 'attest'));
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  expect(output.attest).toMatchObject({ ready: false, reason: 'capability_unknown', capability: { dbPrivileges: 'verified', model: 'unknown' } });
  const before = await canaryState('official-news');
  const { output: refused } = await child('official-news', io('official-news', 'attest'), 'official-news');
  expect(refused).toMatchObject({ message: expect.stringContaining('oracle_attest_principal_required') });
  expect(await canaryState('official-news')).toEqual(before);
}, 60_000);

it('lets the attest principal change only evidence columns and anchors', async () => {
  const negatives = ['UPDATE public.jobs SET cursor=cursor WHERE false', "INSERT INTO public.operations_observations(key,value) SELECT 'x','{}' WHERE false",
    'UPDATE public.operations_observations SET value=value WHERE false', 'UPDATE public.job_batch_candidates SET boot_id=boot_id WHERE false',
    'UPDATE public.role_leases SET epoch=epoch WHERE false', 'UPDATE public.products SET status=status WHERE false',
    'DELETE FROM public.job_batch_candidates WHERE false', 'CREATE TABLE public.oracle_negative_probe(id integer)'];
  const { output } = await child('attest', { role: 'product-health', jobs: [], httpBase: base, bootId: randomUUID(), negatives, mode: 'negatives' }, 'attest', 'product-health');
  expect(output.principal).toBe(ORACLE_DB_PRINCIPALS.attest);
  expect(output.negatives).toEqual(Object.fromEntries(negatives.map(statement => [statement, '42501'])));
}, 60_000);

it('bootstraps a first-ever canary from one legacy-parent tick, then a versioned canary makes the launch preflight ready', async () => {
  // A fresh instance with no stored ACK. FIXTURE control changes only: the operator performs these transitions in production.
  const fresh = `${prefix}-first`, seeded = { ...policy, instances: [...policy.instances, { instanceId: fresh, host: 'oracle-osaka-smoke' as const }] };
  const http = { version: 1 as const, instanceHosts: { ...httpPolicy.instanceHosts, [fresh]: 'oracle-osaka-smoke' as const } };
  await admin`UPDATE job_batch_control SET mode='legacy',policy=${admin.json(seeded)},policy_hash=${batchPolicyHash(seeded)} WHERE id=1`;
  await admin`UPDATE http_origin_control SET policy=${admin.json(http)},policy_hash=${httpOriginPolicyHash(http)} WHERE id=1`;
  await admin`UPDATE uptime_control SET sources=${admin.json([{ host: 'oracle-osaka-smoke', instanceId: fresh, region: 'ap-osaka-1' }])} WHERE id=1`;
  await product(`${prefix}-first-a`, `${base}/site/${prefix}-first-a`);
  const run = (mode: string) => child('product-health', io('product-health', mode), 'attest', undefined, fresh);
  const { output: missing } = await run('attest');
  expect(missing).toMatchObject({ message: expect.stringContaining('oracle_canary_result_missing') });
  const { output: seed } = await run('seed');
  if ('error' in seed) throw new Error(`driver_failed:${JSON.stringify(seed)}`);
  expect(seed.seed).toMatchObject({ status: 'completed' });
  const [ack] = await admin`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${`batch-result:${fresh}:uptime-ping`}`;
  expect(ack.result).toMatchObject({ role: 'maintenance', host: 'oracle-osaka-smoke', instanceId: fresh, count: 1 });
  const { output: legacy } = await run('attest');
  expect(legacy.attest).toMatchObject({ ready: true, anchorInvalidated: false, readbackRows: 1 });
  await admin`UPDATE job_batch_control SET mode='versioned',epoch=epoch+1 WHERE id=1`;
  const { output: early } = await run('preflight');
  expect((early.preflight as { workload: { ready: boolean } }).workload.ready).toBe(false); // legacy-parent ACK is not a launch canary
  await product(`${prefix}-first-b`, `${base}/site/${prefix}-first-b`);
  const { output } = await run('canary');
  const canary = output.canary as { before: Canary; after: Canary };
  expect(canary.before).toMatchObject({ ready: true }); expect(canary.after).toMatchObject({ ready: true, readbackRows: 1 });
  const { output: ready } = await run('preflight');
  expect((ready.preflight as { workload: { ready: boolean } }).workload.ready).toBe(true);
}, 120_000);

// PR11d follow-ups. The previous case left FIXTURE control on its seeded policy; these cases set their own control rows.
async function useControlPolicy(next: typeof policy, http: typeof httpPolicy) {
  await admin`UPDATE job_batch_control SET mode='versioned',policy=${admin.json(next)},policy_hash=${batchPolicyHash(next)} WHERE id=1`;
  await admin`UPDATE http_origin_control SET policy=${admin.json(http)},policy_hash=${httpOriginPolicyHash(http)} WHERE id=1`;
}

it('verifies PgBouncer-mode timeouts from the restricted role catalog and rejects an unbounded role-in-database override', async () => {
  await useControlPolicy(policy, httpPolicy);
  const pooled = () => child('product-health', io('product-health', 'preflight'), 'attest', undefined, undefined, { DB_POOLER_MODE: 'pgbouncer' });
  const { output } = await pooled();
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  // No startup timeouts are sent in pgbouncer mode: the values come only from ALTER ROLE ... SET in pg_db_role_setting.
  expect((output.preflight as { checks: Record<string, unknown> }).checks.timeouts).toEqual({ status: 'verified', reason: 'role_server_timeouts_bounded' });
  const [{ name }] = await admin`SELECT current_database() AS name`;
  const principal = ORACLE_DB_PRINCIPALS['product-health'];
  await admin.unsafe(`ALTER ROLE ${principal} IN DATABASE "${name}" SET idle_in_transaction_session_timeout = 0`);
  try {
    const { output: unbounded } = await pooled();
    const preflight = unbounded.preflight as { checks: Record<string, unknown>; workload: { ready: boolean; reason: string } };
    expect(preflight.checks.timeouts).toEqual({ status: 'rejected', reason: 'role_server_timeouts_unbounded' });
    expect(preflight.workload).toEqual({ ready: false, reason: 'timeouts_rejected' });
  } finally { await admin.unsafe(`ALTER ROLE ${principal} IN DATABASE "${name}" RESET idle_in_transaction_session_timeout`); }
}, 60_000);

it('keeps translation model evidence unknown while every translation serving contract is null', async () => {
  const { output } = await child('translation', io('translation', 'attest'));
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  // The attester reads the model ledger as itself (no 42501); legacy-capacity calls leave no bound row to verify.
  expect(output.attest).toMatchObject({ ready: false, reason: 'capability_unknown', modelEvidence: 'model_readback_empty',
    capability: { dbPrivileges: 'verified', model: 'unknown' } });
  const [candidate] = await admin`SELECT capability FROM job_batch_candidates WHERE role='translation' AND instance_id=${instance('translation')}`;
  expect(candidate.capability.model).toBe('unknown'); expect(candidate.capability).not.toHaveProperty('modelBoundEvidenceHash');
  const { output: inspected } = await child('translation', io('translation', 'preflight'));
  const preflight = inspected.preflight as { checks: Record<string, { status: string }>; workload: { ready: boolean } };
  expect(preflight.workload.ready).toBe(false); expect(preflight.checks.model.status).toBe('unknown');
}, 60_000);

it('refreshes capability through the separate capability-only principal and refuses it for every other write', async () => {
  const refreshUrl = new URL(TEST_DATABASE_URL); refreshUrl.username = ORACLE_REFRESH_PRINCIPAL; refreshUrl.password = password;
  for (const statement of oracleDbGrantStatements('refresh', { connectionLimit: 2 })) await admin.unsafe(statement);
  await admin.unsafe(`ALTER ROLE ${ORACLE_REFRESH_PRINCIPAL} PASSWORD '${password}'`);
  try {
    const before = await canaryState('product-health');
    const env = { ORACLE_ATTEST_DATABASE_URL: refreshUrl.toString() };
    const { output } = await child('product-health', io('product-health', 'refresh'), 'attest', undefined, undefined, env);
    if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
    expect(output.refresh).toMatchObject({ dbPrivileges: 'verified', http: 'verified', model: 'unknown' });
    const after = await canaryState('product-health');
    expect(after.candidate.resultEvidence).toEqual(before.candidate.resultEvidence); expect(after.anchor).toEqual(before.anchor);
    expect(after.candidate.bootId).toBe(before.candidate.bootId);
    expect(Date.parse(after.candidate.capability.observedAt)).toBeGreaterThanOrEqual(Date.parse(before.candidate.capability.observedAt));
    for (const mode of ['attest', 'canary']) {
      const { output: refused } = await child('product-health', io('product-health', mode), 'attest', undefined, undefined, env);
      expect(refused).toMatchObject({ message: expect.stringContaining('oracle_attest_principal_required') });
    }
    expect((await canaryState('product-health')).candidate.resultEvidence).toEqual(before.candidate.resultEvidence);
    const negatives = ['UPDATE public.job_batch_candidates SET result_evidence=result_evidence WHERE false',
      'UPDATE public.job_batch_candidates SET boot_id=boot_id WHERE false', "INSERT INTO public.job_batch_candidates(role) SELECT 'x' WHERE false",
      'DELETE FROM public.job_batch_candidates WHERE false', 'DELETE FROM public.operations_observations WHERE false',
      "INSERT INTO public.operations_observations(key,value) SELECT 'x','{}' WHERE false", 'UPDATE public.job_batch_control SET mode=mode WHERE false',
      'SELECT 1 FROM public.model_capacity_requests LIMIT 1', 'SELECT 1 FROM public.jobs LIMIT 1', 'CREATE TABLE public.oracle_negative_probe(id integer)'];
    const { output: denied } = await child('product-health', { ...io('product-health', 'negatives'), negatives }, 'attest', undefined, undefined,
      { DATABASE_URL: refreshUrl.toString() });
    expect(denied.principal).toBe(ORACLE_REFRESH_PRINCIPAL);
    expect(denied.negatives).toEqual(Object.fromEntries(negatives.map(statement => [statement, '42501'])));
  } finally {
    await admin.unsafe(`DROP OWNED BY ${ORACLE_REFRESH_PRINCIPAL}`); await admin.unsafe(`DROP ROLE ${ORACLE_REFRESH_PRINCIPAL}`);
  }
}, 90_000);

it('bootstraps a first-ever site-evidence ACK only through an attest grant, then a normal canary makes the preflight ready', async () => {
  const boot = `${prefix}-boot`, booted = { ...policy, instances: [...policy.instances, { instanceId: boot, host: 'oracle-osaka-smoke' as const }] };
  await useControlPolicy(booted, { version: 1, instanceHosts: { ...httpPolicy.instanceHosts, [boot]: 'oracle-osaka-smoke' } });
  // Only the fixed public-form products below are due canonical sources; their URLs are never fetched (fixture collection).
  await admin`UPDATE products SET access_mode='installable' WHERE slug LIKE ${`${prefix}-%`} AND access_mode='website'`;
  await product(`${prefix}-boot-a`, `https://${prefix}-boot-a.example/`);
  const run = (mode: string, role: Role = 'site-evidence') => child(role, io(role, mode), 'attest', undefined, boot);
  const { output: legacyless } = await run('seed');
  expect(legacyless).toMatchObject({ message: expect.stringContaining('oracle_canary_seed_unsupported') });
  const { output: missing } = await run('attest');
  expect(missing).toMatchObject({ message: expect.stringContaining('oracle_canary_result_missing') });
  const { output: unsupported } = await run('bootstrap', 'product-health');
  expect(unsupported).toMatchObject({ message: expect.stringContaining('oracle_bootstrap_unsupported') });
  const { code, output } = await run('bootstrap');
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  expect(code).toBe(0);
  const bootstrap = output.bootstrap as { grant: { granted: boolean; bootId: string }; run: { status: string }; revoked: boolean; acknowledged: boolean };
  expect(bootstrap).toMatchObject({ grant: { granted: true }, run: { status: 'completed' }, revoked: true, acknowledged: true });
  const [control] = await admin`SELECT epoch FROM job_batch_control WHERE id=1`;
  const [ack] = await admin`SELECT value->'batchResult' AS result FROM operations_observations WHERE key=${`batch-result:${boot}:product-site-evidence-refresh`}`;
  expect(ack.result).toMatchObject({ role: 'site-evidence', host: 'oracle-osaka-smoke', instanceId: boot, bootId: bootstrap.grant.bootId,
    batchEpoch: Number(control.epoch), count: 1 });
  const [granted] = await admin`SELECT capability,result_evidence AS "resultEvidence" FROM job_batch_candidates WHERE role='site-evidence' AND instance_id=${boot}`;
  expect(granted.resultEvidence).toBeNull();
  expect(granted.capability).toMatchObject({ dbRole: ORACLE_DB_PRINCIPALS['site-evidence'], dbPrivileges: 'verified', http: 'verified' });
  const { output: again } = await run('bootstrap');
  expect(again).toMatchObject({ message: expect.stringContaining('oracle_bootstrap_prior_evidence') });
  const { output: early } = await run('preflight');
  expect((early.preflight as { workload: { ready: boolean } }).workload.ready).toBe(false); // the bootstrap ACK is not a launch canary
  const { output: attested } = await run('attest');
  expect(attested.attest).toMatchObject({ ready: true, anchorInvalidated: false, readbackRows: 1 });
  await product(`${prefix}-boot-b`, `https://${prefix}-boot-b.example/`);
  const { output: canaried } = await run('canary');
  const canary = canaried.canary as { before: Canary; run: { status: string }; after: Canary };
  expect(canary.before).toMatchObject({ ready: true }); expect(canary.run.status).toBe('completed');
  expect(canary.after).toMatchObject({ ready: true, readbackRows: 1 }); expect(canary.after.bootId).not.toBe(bootstrap.grant.bootId);
  const { output: ready } = await run('preflight');
  expect((ready.preflight as { workload: Record<string, unknown> }).workload).toMatchObject({ ready: true, job: 'product-site-evidence-refresh' });
}, 120_000);

// PR11e. FIXTURE control changes only, as above; every row is restored by afterAll.
it('0098: a worker principal cannot insert candidate evidence, while the heartbeat shape and the attest principal still insert', async () => {
  const id = instance('product-health'), hash = batchPolicyHash(policy);
  const keyed = (columns: string, values: string) => `INSERT INTO public.job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash${columns}) `
    + `VALUES ('product-health','${id}','oracle-osaka-smoke','forged','${release}','${hash}'${values}) ON CONFLICT DO NOTHING`;
  const fresh = `INSERT INTO public.job_batch_candidates(role,instance_id,host,boot_id,release,policy_hash,capability,result_evidence) `
    + `VALUES ('product-health','${prefix}-forged','oracle-osaka-smoke','forged','${release}','${hash}','{"dbPrivileges":"verified"}','{"batchBootstrap":{}}')`;
  const worker = [keyed(',capability', `,'{"dbPrivileges":"verified"}'`), keyed(',result_evidence', `,'{"batchBootstrap":{}}'`), fresh, keyed('', '')];
  const before = await admin`SELECT to_jsonb(c) AS row FROM job_batch_candidates c ORDER BY role,instance_id`;
  const { output } = await child('product-health', { ...io('product-health', 'negatives'), negatives: worker });
  expect(output.principal).toBe(ORACLE_DB_PRINCIPALS['product-health']);
  // The trigger fires before the conflict check, so even a no-op conflicting row cannot carry evidence; the heartbeat shape still inserts.
  expect(output.negatives).toEqual({ [worker[0]]: '42501', [worker[1]]: '42501', [worker[2]]: '42501', [worker[3]]: 'allowed' });
  const attest = [keyed(',capability,result_evidence', `,'{}','{}'`)];
  const { output: attested } = await child('attest', { role: 'product-health', jobs: [], httpBase: base, bootId: randomUUID(), negatives: attest, mode: 'negatives' }, 'attest', 'product-health');
  expect(attested.principal).toBe(ORACLE_DB_PRINCIPALS.attest);
  expect(attested.negatives).toEqual({ [attest[0]]: 'allowed' });
  expect(await admin`SELECT to_jsonb(c) AS row FROM job_batch_candidates c ORDER BY role,instance_id`).toEqual(before);
}, 60_000);

it('re-opens a product-health instance whose every result is older than 24 hours only through an attest re-canary grant', async () => {
  const id = instance('product-health'), run = (mode: string) => child('product-health', io('product-health', mode));
  await useControlPolicy(policy, httpPolicy);
  await admin`UPDATE uptime_control SET sources=${admin.json([{ host: 'oracle-osaka-smoke', instanceId: id, region: 'ap-osaka-1' }])} WHERE id=1`;
  // Public-form fixture URLs are never contacted; a fresh loopback product is each tick's only uptime target.
  await admin`UPDATE products SET access_mode='installable' WHERE slug LIKE ${`${prefix}-%`} AND access_mode='website'`;
  // FIXTURE time travel only: every stored result of this instance (batch-result rows and any anchor result) moves 25 hours back.
  const stale = admin`to_jsonb(to_char((clock_timestamp()-interval '25 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
  expect((await admin`UPDATE operations_observations SET value=jsonb_set(value,'{batchResult,recordedAt}',${stale}) WHERE key LIKE ${`batch-result:${id}:%`} RETURNING key`).length).toBe(1);
  await admin`UPDATE operations_observations SET value=jsonb_set(value,'{batchCanary,result,recordedAt}',${stale}) WHERE key=${batchCanaryAnchorKey('product-health', id)}`;
  // The gap: no fresh ACK can exist, so the strict paths refuse and nothing elects the instance by itself.
  expect((await run('attest')).output).toMatchObject({ message: expect.stringContaining('oracle_canary_result_stale') });
  expect((await run('canary')).output).toMatchObject({ message: expect.stringContaining('oracle_canary_result_stale') });
  expect((await child('product-health', io('product-health', 'heartbeat'))).output).toMatchObject({ elected: false });
  expect(((await run('preflight')).output.preflight as { workload: { ready: boolean } }).workload.ready).toBe(false);
  await product(`${prefix}-stale-a`, `${base}/site/${prefix}-stale-a`);
  const { code, output } = await run('recanary');
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  expect(code).toBe(0);
  const recanary = output.recanary as { grant: { granted: boolean; reason: string; bootId: string }; run: { status: string }; revoked: boolean; acknowledged: boolean };
  expect(recanary).toMatchObject({ grant: { granted: true, reason: 'recanary_granted' }, run: { status: 'completed' }, revoked: true, acknowledged: true });
  const [control] = await admin`SELECT epoch FROM job_batch_control WHERE id=1`;
  const [ack] = await admin`SELECT value->'batchResult' AS result, (value->'batchResult'->>'recordedAt')::timestamptz > clock_timestamp()-interval '5 minutes' AS fresh
    FROM operations_observations WHERE key=${`batch-result:${id}:uptime-ping`}`;
  expect(ack).toMatchObject({ fresh: true, result: { role: 'product-health', instanceId: id, bootId: recanary.grant.bootId, batchEpoch: Number(control.epoch), count: 1 } });
  const [granted] = await admin`SELECT capability,result_evidence AS "resultEvidence" FROM job_batch_candidates WHERE role='product-health' AND instance_id=${id}`;
  expect(granted.resultEvidence).toBeNull();
  expect(granted.capability).toMatchObject({ dbRole: ORACLE_DB_PRINCIPALS['product-health'], dbPrivileges: 'verified', http: 'verified' });
  // The first new ACK ends the grant path; from here only the normal attest -> canary path makes the launch preflight ready.
  const { output: refused } = await run('recanary');
  expect(refused.recanary).toMatchObject({ grant: { granted: false, reason: 'recanary_prior_fresh' }, run: null });
  expect(((await run('preflight')).output.preflight as { workload: { ready: boolean } }).workload.ready).toBe(false);
  expect((await run('attest')).output.attest).toMatchObject({ ready: true, readbackRows: 1 });
  await product(`${prefix}-stale-b`, `${base}/site/${prefix}-stale-b`);
  const canary = (await run('canary')).output.canary as { before: Canary; run: { status: string }; after: Canary };
  expect(canary.before).toMatchObject({ ready: true }); expect(canary.run.status).toBe('completed');
  expect(canary.after).toMatchObject({ ready: true, readbackRows: 1 });
  expect(((await run('preflight')).output.preflight as { workload: Record<string, unknown> }).workload).toMatchObject({ ready: true, job: 'uptime-ping' });
}, 180_000);

it('F4: no worker principal can rewrite a runtime key column, and translation can read the HTTP control row', async () => {
  const keyRewrites = ['UPDATE public.jobs SET name=name WHERE false', 'UPDATE public.role_leases SET role=role WHERE false',
    'UPDATE public.operations_observations SET key=key WHERE false'];
  const httpRead = 'SELECT mode FROM public.http_origin_control WHERE id=1';
  for (const role of [...ROLES, 'scheduler'] as const) {
    const reads = role === 'translation' ? [httpRead] : [];
    const { code, output } = await child(role, { role, jobs: [], httpBase: base, bootId: randomUUID(), negatives: [...keyRewrites, ...reads], mode: 'negatives' });
    if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
    expect(code).toBe(0);
    expect(output.negatives, role).toEqual({ ...Object.fromEntries(keyRewrites.map(statement => [statement, '42501'])),
      ...Object.fromEntries(reads.map(statement => [statement, 'allowed'])) });
  }
}, 120_000);
