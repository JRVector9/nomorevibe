import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryClaims, agentRepositoryScans, agentScanControl, crawlSettings, githubCollectorAccounts, githubCollectorApps,
  operationsObservations } from '@/lib/db/schema';
import type { GitHubHttpResult } from '@/lib/crawl/github';
import { saveSettings } from '@/lib/crawl/settings';
import { AGENT_SCAN_PRIORITY } from '@/lib/domain/evidence/agents/claims';
import { beginAgentScanDrain, bumpAgentScanContract, completeAgentScanTransition } from '@/lib/domain/evidence/agents/claim-control';
import { runAgentScanConsumer } from '@/lib/domain/evidence/agents/consumer';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import { jobDeferralKey } from '@/lib/jobs/deferral-observation';
import { seal } from '@/lib/operations/credential-vault';
import { ORACLE_CONSUMER_DB_PROFILES, oracleConsumerGrantStatements } from '@/lib/runtime/oracle-db-profile';
import { ensureSchema, resetTables, TEST_DATABASE_URL } from './setup';

/*
 * E5 제작 근거 스캔 consumer 실제 PostgreSQL. 가짜 GitHub(요청 함수 주입) 로 consumer 두 개가 같은 큐를 나눠 맡고,
 * Oracle agent-scan 계정(생성 SQL 그대로)으로 claim·기록이 되고 다른 표 쓰기는 거절되는 것을 본다.
 * 공유 test DB 의 agent_scan_control·crawl_settings 는 파일 끝에 처음 값으로 되돌린다.
 */
const PROFILE = ORACLE_CONSUMER_DB_PROFILES['agent-scan']!;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'e5-agent-scan-admin' } });
const password = randomUUID(), secret = `e5-collector-secret-${randomUUID()}`, release = 'e'.repeat(40);
let originalControl: typeof agentScanControl.$inferSelect | undefined;
let originalSettings: (typeof crawlSettings.$inferSelect)[] = [];
const dropPrincipal = async () => {
  if ((await admin`SELECT 1 FROM pg_roles WHERE rolname = ${PROFILE.principal}`).length) {
    await admin.unsafe(`DROP OWNED BY ${PROFILE.principal}`); await admin.unsafe(`DROP ROLE ${PROFILE.principal}`);
  }
};

beforeAll(async () => {
  ensureSchema();
  [originalControl] = await db.select().from(agentScanControl);
  originalSettings = await db.select().from(crawlSettings);
}, 60_000);
beforeEach(async () => {
  await resetTables();
  await db.delete(agentRepositoryClaims); await db.delete(crawlSettings);
  await db.delete(githubCollectorApps); await db.delete(githubCollectorAccounts);
  await db.delete(operationsObservations).where(inArray(operationsObservations.key, [jobDeferralKey('agent-scan')]));
  await saveSettings({ enabled: false, agentEvidence: { enabled: true } }, 'e5-test');
  await db.execute(sql`UPDATE agent_scan_control SET mode = 'legacy', draining_from = NULL, epoch = 1, writer_contract_version = 0 WHERE id = 1`);
});
afterAll(async () => {
  try {
    await db.delete(agentRepositoryClaims); await db.delete(githubCollectorApps);
    if (originalControl) await db.update(agentScanControl).set({ mode: originalControl.mode, drainingFrom: originalControl.drainingFrom,
      epoch: originalControl.epoch, writerContractVersion: originalControl.writerContractVersion }).where(eq(agentScanControl.id, 1));
    await db.delete(crawlSettings);
    if (originalSettings.length) await db.insert(crawlSettings).values(originalSettings);
    await dropPrincipal();
  } finally { await admin.end({ timeout: 5 }); }
}, 60_000);

const owner = (name: string) => ({ instanceId: `agent-scan-consumer-${name}`, bootId: randomUUID() });
async function toItems() {
  await db.transaction(tx => bumpAgentScanContract(tx));
  await db.transaction(tx => beginAgentScanDrain(tx));
  await db.transaction(tx => completeAgentScanTransition(tx, 'items'));
}
/** 큐 채우기 대신 행을 바로 넣는다. 기한은 DB 시계 기준(UTC) */
async function queue(rows: { key: string; priority?: number; due?: string; retryAfter?: string }[]) {
  for (const value of rows) await db.execute(sql`INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at, retry_after)
    VALUES (${value.key}, ${value.priority ?? AGENT_SCAN_PRIORITY.regular}, false, (clock_timestamp() AT TIME ZONE 'UTC') + ${value.due ?? '-1 minute'}::interval,
      CASE WHEN ${value.retryAfter ?? null}::text IS NULL THEN NULL ELSE (clock_timestamp() AT TIME ZONE 'UTC') + ${value.retryAfter ?? null}::interval END)`);
}
const claimRow = async (key: string) => (await db.select().from(agentRepositoryClaims).where(eq(agentRepositoryClaims.repositoryKey, key)))[0];
const scansOf = (key: string) => db.select().from(agentRepositoryScans).where(eq(agentRepositoryScans.repositoryKey, key));
const HEAD = 'c'.repeat(40), TREE = 'd'.repeat(40);
/** 파일 없는 공개 저장소들(저장소마다 GitHub ID 하나)을 그리는 GitHub. 불린 경로를 남기고, 요청마다 조금 기다려 두 consumer 가 섞이게 한다 */
function fakeGitHub(paths: string[], options: { delayMs?: number; before?: (path: string) => GitHubHttpResult<never> | void } = {}) {
  return async <T>(path: string): Promise<GitHubHttpResult<T>> => {
    paths.push(path);
    if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
    const early = options.before?.(path);
    if (early) return early;
    const key = /^\/repos\/([^/]+\/[^/]+)/.exec(path)![1];
    const value = path.includes('/git/trees/') ? { tree: [], truncated: false } : path.includes('/commits/') ? { sha: HEAD, commit: { tree: { sha: TREE } } }
      : { private: false, fork: false, id: 1000 + Number(/(\d+)$/.exec(key)?.[1] ?? 0), default_branch: 'main' };
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
}
const metadataCalls = (paths: string[], key: string) => paths.filter(path => path === `/repos/${key}`).length;

it('two consumers (owner A and B) scan every due repository exactly once without losing a lease', async () => {
  const due = Array.from({ length: 12 }, (_, index) => `acme/repo-${index + 1}`);
  await queue(due.map((key, index) => ({ key, priority: index % 3 === 0 ? AGENT_SCAN_PRIORITY.newProduct : AGENT_SCAN_PRIORITY.regular })));
  await queue([{ key: 'acme/later-90', due: '1 hour' }, { key: 'acme/backoff-91', retryAfter: '1 hour' }]);
  await toItems();
  const paths: string[] = [];
  const request = fakeGitHub(paths, { delayMs: 15 });
  const [a, b] = await Promise.all([runAgentScanConsumer({ owner: owner('a'), once: true, concurrency: 2, request }),
    runAgentScanConsumer({ owner: owner('b'), once: true, concurrency: 2, request })]);
  for (const key of due) {
    expect(metadataCalls(paths, key), key).toBe(1);
    const scans = await scansOf(key);
    expect(scans, key).toHaveLength(1);
    expect(scans[0]).toMatchObject({ state: 'complete', requestCount: 3, lastErrorCode: null });
    // epoch 1 = 단 한 번 맡았다. 기록이 소유를 풀고 다음 기한(완료 +1일)으로 옮겼다
    expect(await claimRow(key)).toMatchObject({ epoch: 1, token: null, instanceId: null, lastOutcome: 'complete', failureStreak: 0 });
  }
  for (const key of ['acme/later-90', 'acme/backoff-91']) {
    expect(metadataCalls(paths, key)).toBe(0);
    expect(await claimRow(key)).toMatchObject({ epoch: 0, token: null, lastOutcome: null });
  }
  expect(a.leaseLost + b.leaseLost).toBe(0); expect(a.errors + b.errors).toBe(0); expect(a.abandoned + b.abandoned).toBe(0);
  expect(a.claimed + b.claimed).toBe(12); expect(a.recorded.complete + b.recorded.complete).toBe(12);
  expect(a.claimed).toBeGreaterThan(0); expect(b.claimed).toBeGreaterThan(0);
  const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, 'agent-scan:agent-scan-consumer-a'));
  expect(observation.value).toMatchObject({ instanceId: 'agent-scan-consumer-a', concurrency: 2, claimed: a.claimed, leaseLost: 0, lastIdleReason: 'empty' });
}, 60_000);

it('stays idle without GitHub while the control is legacy', async () => {
  await queue([{ key: 'acme/legacy-1' }]);
  const paths: string[] = [];
  const stats = await runAgentScanConsumer({ owner: owner('legacy'), once: true, request: fakeGitHub(paths) });
  expect(stats).toMatchObject({ claimed: 0, deferred: { mode: 1 } });
  expect(paths).toEqual([]); expect(await claimRow('acme/legacy-1')).toMatchObject({ epoch: 0, token: null });
});

it('defers claims while GitHub headroom is low and pauses after a provider rate limit', async () => {
  await queue([{ key: 'acme/limited-1', priority: AGENT_SCAN_PRIORITY.newProduct }, { key: 'acme/next-2' }]);
  await toItems();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  await db.insert(githubCollectorApps).values({ installationId: 7001, appId: 1, appSlug: 'e5', accountLogin: 'e5', encryptedPrivateKey: 'x',
    coreQuota: { limit: 5000, used: 4900, remaining: 100, reset } });
  const paths: string[] = [];
  const quota = await runAgentScanConsumer({ owner: owner('quota'), once: true, request: fakeGitHub(paths) });
  expect(quota).toMatchObject({ claimed: 0, deferred: { quota: 1 } }); expect(paths).toEqual([]);
  await expect.poll(async () => (await db.select().from(operationsObservations).where(eq(operationsObservations.key, jobDeferralKey('agent-scan'))))[0]?.value,
    { timeout: 5_000 }).toMatchObject({ reason: 'github_headroom_low' });

  await db.update(githubCollectorApps).set({ coreQuota: { limit: 5000, used: 10, remaining: 4990, reset } });
  const retryAt = new Date(Date.now() + 10 * 60_000);
  const limited = await runAgentScanConsumer({ owner: owner('limit'), once: true, request: fakeGitHub(paths, {
    before: path => path === '/repos/acme/limited-1' ? { ok: false, error: { kind: 'rate_limited', resetAt: retryAt } } : undefined }) });
  // 기록은 하고(스캔 없는 공급자 대기: 실패 수 0, retry_after = 재개 시각) 그 시각까지 새 claim 을 하지 않는다
  expect(limited).toMatchObject({ claimed: 1, recorded: { failed: 1 }, deferred: { rateLimited: 1 } });
  expect(paths).toEqual(['/repos/acme/limited-1']);
  const row = await claimRow('acme/limited-1');
  expect(row).toMatchObject({ token: null, lastOutcome: 'failed', failureStreak: 0 });
  expect(Math.abs(row.retryAfter!.getTime() - retryAt.getTime())).toBeLessThan(1_000);
  expect(await claimRow('acme/next-2')).toMatchObject({ epoch: 0 });
}, 30_000);

/** 기록 뒤 claim 이 곧바로 다시 도래하지 않는다 — greatest(due_at, retry_after) 가 DB 시계로 지금보다 뒤다 */
async function nextClaimSeconds(key: string): Promise<number> {
  const [{ seconds }] = await db.execute<{ seconds: string }>(sql`SELECT extract(epoch FROM greatest(due_at, coalesce(retry_after, due_at))
    - (clock_timestamp() AT TIME ZONE 'UTC'))::text AS seconds FROM agent_repository_claims WHERE repository_key = ${key}`);
  return Number(seconds);
}

it('a renamed repository whose scan lands on the old-name row backs off instead of being re-claimed at once', async () => {
  // 옛 이름으로 한 번 스캔해 (GitHub id 1007, head C) 행을 만든다. 옛 이름은 수요에서 빠졌다(gone)
  await queue([{ key: 'oldorg/repo-7' }]);
  await toItems();
  await runAgentScanConsumer({ owner: owner('old'), once: true, request: fakeGitHub([]) });
  expect(await scansOf('oldorg/repo-7')).toHaveLength(1);
  await db.update(agentRepositoryClaims).set({ state: 'gone' }).where(eq(agentRepositoryClaims.repositoryKey, 'oldorg/repo-7'));
  // 같은 id·head 의 새 이름이 새 후보로 들어온다 — 스캔은 옛 이름 행에 묶이고(별칭 재확인) 새 이름으로는 최신 스캔이 없다
  await queue([{ key: 'neworg/repo-7', priority: AGENT_SCAN_PRIORITY.newCandidate }]);
  const paths: string[] = [], controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  const stats = await runAgentScanConsumer({ owner: owner('new'), signal: controller.signal, request: fakeGitHub(paths, { delayMs: 5 }) });
  clearTimeout(timer);
  // 한 번 보고 다음 기한까지 쉰다(고치기 전: 2초에 수십 번 같은 저장소를 다시 잡았다)
  expect(metadataCalls(paths, 'neworg/repo-7')).toBe(1);
  expect(stats).toMatchObject({ claimed: 1, errors: 0, leaseLost: 0 });
  expect(await claimRow('neworg/repo-7')).toMatchObject({ token: null, epoch: 1, failureStreak: 1, lastErrorCode: 'alias_conflict' });
  expect(await nextClaimSeconds('neworg/repo-7')).toBeGreaterThan(14 * 60);
  expect(await scansOf('neworg/repo-7')).toEqual([]);
  expect(await scansOf('oldorg/repo-7')).toMatchObject([{ lastErrorCode: 'alias_recheck_required' }]);
}, 30_000);

it('judges the cache by the claim (DB) clock so a host clock behind the DB scans once instead of spinning on cached records', async () => {
  const key = 'acme/skew-1', scopeHash = createHash('sha256').update(JSON.stringify('')).digest('hex');
  // 최신 스캔(다른 head)과 claim 이 DB 시계로 2초 전에 도래했다. 후보 수요라 매일 주기(next_attempt_at 그대로)
  await db.execute(sql`INSERT INTO agent_repository_scans (github_repository_id, repository_key, commit_sha, detector_version, scope, scope_hash,
      state, request_count, file_count, coverage, started_at, completed_at, next_attempt_at)
    VALUES (1001, ${key}, ${'e'.repeat(40)}, ${AGENT_DETECTOR_VERSION}, '', ${scopeHash}, 'complete', 3, 0, '{}'::jsonb,
      (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day', (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day',
      (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 seconds')`);
  await db.execute(sql`INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at)
    VALUES (${key}, ${AGENT_SCAN_PRIORITY.regular}, true, (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 seconds')`);
  await toItems();
  const paths: string[] = [], controller = new AbortController();
  // host 시계를 DB 보다 5초 늦춘다(Date 만 — 타이머는 실제)
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  let stats: Awaited<ReturnType<typeof runAgentScanConsumer>>;
  try {
    vi.setSystemTime(Date.now() - 5_000);
    const timer = setTimeout(() => controller.abort(), 2_000);
    stats = await runAgentScanConsumer({ owner: owner('skew'), signal: controller.signal, request: fakeGitHub(paths, { delayMs: 5 }) });
    clearTimeout(timer);
  } finally { vi.useRealTimers(); }
  // 고치기 전: host 시계로는 아직 볼 때가 아니라 cached 를 수백 번 기록하며 같은 저장소를 다시 잡았다
  expect(stats).toMatchObject({ claimed: 1, recorded: { cached: 0, complete: 1 }, errors: 0 });
  expect(metadataCalls(paths, key)).toBe(1);
  expect(await nextClaimSeconds(key)).toBeGreaterThan(60);
}, 30_000);

it('follows the job pause: a paused agent-evidence-refresh keeps consumers idle without GitHub until it is resumed', async () => {
  await queue([{ key: 'acme/paused-1' }]);
  await toItems();
  // 운영자의 잡 멈춤(not_before 먼 미래) — legacy 에서 스캔을 멈추는 그 값이다
  await db.execute(sql`INSERT INTO jobs (name, not_before) VALUES ('agent-evidence-refresh', '2100-01-01')
    ON CONFLICT (name) DO UPDATE SET not_before = excluded.not_before`);
  try {
    const paths: string[] = [];
    // 고치기 전: claim 이 잡 멈춤을 보지 않아 계속 스캔했다
    const paused = await runAgentScanConsumer({ owner: owner('paused'), once: true, request: fakeGitHub(paths) });
    expect(paused).toMatchObject({ claimed: 0, deferred: { paused: 1 } });
    expect(paths).toEqual([]);
    expect(await claimRow('acme/paused-1')).toMatchObject({ epoch: 0, token: null });
    // 잡을 다시 열면(not_before 비움) 이어서 맡는다
    await db.execute(sql`UPDATE jobs SET not_before = NULL WHERE name = 'agent-evidence-refresh'`);
    const resumed = await runAgentScanConsumer({ owner: owner('resumed'), once: true, request: fakeGitHub(paths) });
    expect(resumed).toMatchObject({ claimed: 1, recorded: { complete: 1 } });
  } finally { await db.execute(sql`DELETE FROM jobs WHERE name = 'agent-evidence-refresh'`); }
});

it('abandons the claim without writing when shutdown interrupts the scan', async () => {
  await queue([{ key: 'acme/stop-1' }, { key: 'acme/stop-2' }]);
  await toItems();
  const controller = new AbortController(), paths: string[] = [];
  const stats = await runAgentScanConsumer({ owner: owner('stop'), signal: controller.signal, request: fakeGitHub(paths, {
    before: () => { controller.abort(); return { ok: false, error: { kind: 'transport' } }; } }) });
  expect(stats).toMatchObject({ claimed: 1, abandoned: 1, errors: 0, recorded: { failed: 0 } });
  expect(paths).toHaveLength(1);
  const key = paths[0].slice('/repos/'.length);
  // 실패로 세지 않는다: 시계·실패 수 그대로, 스캔 행 없음. 다른 저장소는 손대지 않았다
  expect(await claimRow(key)).toMatchObject({ token: null, lastOutcome: 'abandoned', failureStreak: 0, retryAfter: null, lastErrorCode: null, epoch: 1 });
  expect(await scansOf(key)).toEqual([]);
  expect(await claimRow(key === 'acme/stop-1' ? 'acme/stop-2' : 'acme/stop-1')).toMatchObject({ epoch: 0 });
});

it('the Oracle agent-scan principal claims, records and abandons through App-only credentials but cannot write products or item leases', async () => {
  await dropPrincipal();
  for (const statement of oracleConsumerGrantStatements(PROFILE, { connectionLimit: 4 })) await admin.unsafe(statement);
  await admin.unsafe(`ALTER ROLE ${PROFILE.principal} PASSWORD '${password}'`);
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  // 운영자가 이 설치를 Oracle 계정에 허용한다(0106 RLS). 허용하지 않은 설치는 그 계정에 보이지 않는다
  await db.insert(githubCollectorApps).values({ installationId: 4242, appId: 99, appSlug: 'e5-oracle', accountLogin: 'e5', encryptedPrivateKey: seal(pem, secret),
    oraclePrincipals: [PROFILE.principal] });
  // 개인 토큰 표에 행이 있어도 App 전용 서버는 읽지 않는다(그 계정은 권한이 없다)
  await db.insert(githubCollectorAccounts).values({ userId: 4243, login: 'e5-pat', encryptedToken: seal('pat-fixture-never-read-by-oracle', secret) });
  await queue([{ key: 'acme/oracle-1', priority: AGENT_SCAN_PRIORITY.newProduct }, { key: 'acme/oracle-2' }]);
  await toItems();
  const negatives = ['UPDATE public.products SET status = status WHERE false', "INSERT INTO public.pipeline_item_leases (stage) SELECT 'ai1' WHERE false",
    'UPDATE public.pipeline_item_leases SET token = token WHERE false', 'SELECT 1 FROM public.github_collector_accounts LIMIT 1',
    'UPDATE public.crawl_candidates SET state = state WHERE false', 'UPDATE public.jobs SET cursor = cursor WHERE false',
    "INSERT INTO public.agent_repository_claims (repository_key, priority, requires_daily, due_at) SELECT 'x/y', 5, true, now() WHERE false",
    'UPDATE public.agent_repository_claims SET priority = priority WHERE false', 'UPDATE public.agent_scan_control SET mode = mode WHERE false',
    'DELETE FROM public.agent_repository_scans WHERE false', 'UPDATE public.crawl_settings SET "values" = "values" WHERE false'];
  const url = new URL(TEST_DATABASE_URL); url.username = PROFILE.principal; url.password = password;
  const output = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/agent-scan-consumer-driver.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? 'test', LOG_LEVEL: 'error', DATABASE_URL: url.toString(), DB_POOL_MAX: '3',
        WORKER_ROLE: 'crawler', SERVICE_INSTANCE_ID: 'agent-scan-consumer-oracle', RELEASE_TAG: release, PHYSICAL_HOST: 'oracle-osaka-smoke', TZ: 'UTC',
        DB_POOLER_MODE: 'direct', GITHUB_COLLECTOR_SOURCES: 'apps', GITHUB_COLLECTOR_APP_INSTALLATIONS: '4242', GITHUB_COLLECTOR_SECRET: secret,
        AGENT_SCAN_DRIVER_INPUT: JSON.stringify({ installationId: 4242, repositories: { 'acme/oracle-1': 501, 'acme/oracle-2': 502 }, negatives }) } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
    child.once('error', reject);
    child.once('exit', () => {
      try { resolve(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')); }
      catch { reject(new Error(`driver_output_invalid:${stdout.slice(-500)}:${stderr.slice(-2000)}`)); }
    });
  });
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  expect(output.principal).toBe(PROFILE.principal);
  // 준비 확인: 정확한 권한·UTC·App 전용 자격·비밀키로 풀리는 설치 키·제어 행·탐지기 버전
  expect(output.preflight).toMatchObject({ checks: { identity: { status: 'verified' }, database: { status: 'verified' }, timeouts: { status: 'verified' },
    timezone: { status: 'verified' }, consumer: { status: 'verified', reason: 'agent_scan_ready' } }, workload: { ready: true, reason: 'ready' } });
  // 직접 맡았다 15분 미뤄 푼 저장소는 consumer 가 다시 잡지 않는다
  expect(output.abandoned).toEqual({ repositoryKey: 'acme/oracle-1', released: true });
  const abandoned = await claimRow('acme/oracle-1');
  expect(abandoned).toMatchObject({ token: null, lastOutcome: 'abandoned', failureStreak: 0, epoch: 1 });
  const [{ minutes }] = await admin<{ minutes: number }[]>`SELECT extract(epoch FROM retry_after - (clock_timestamp() AT TIME ZONE 'UTC')) / 60 AS minutes
    FROM agent_repository_claims WHERE repository_key = 'acme/oracle-1'`;
  expect(Number(minutes)).toBeGreaterThan(14); expect(Number(minutes)).toBeLessThanOrEqual(15);
  // 실제 GitHub 클라이언트(설치 토큰 발급 → 요청 → 한도 관측). 트리 응답이 core 를 다 썼다고 알려 다음 바퀴는 여유 관문에서 멈춘다
  expect(output.stats).toMatchObject({ claimed: 1, recorded: { complete: 1 }, leaseLost: 0, errors: 0, githubRequests: 3, deferred: { quota: 1 } });
  expect(output.paths).toEqual(['/app/installations/4242/access_tokens', '/repos/acme/oracle-2', '/repos/acme/oracle-2/commits/main',
    `/repos/acme/oracle-2/git/trees/${'b'.repeat(40)}`]);
  expect(await scansOf('acme/oracle-2')).toMatchObject([{ state: 'complete', requestCount: 3, githubRepositoryId: BigInt(502) }]);
  expect(await claimRow('acme/oracle-2')).toMatchObject({ token: null, lastOutcome: 'complete', epoch: 1 });
  const [app] = await db.select().from(githubCollectorApps).where(eq(githubCollectorApps.installationId, 4242));
  expect(app.coreQuota).toMatchObject({ limit: 5000, remaining: 0 });
  expect(await admin`SELECT key FROM rate_limits WHERE key LIKE 'github:quota:%:primary:core'`).toHaveLength(1);
  expect((await db.select().from(operationsObservations).where(eq(operationsObservations.key, 'agent-scan:agent-scan-consumer-oracle')))[0]?.value)
    .toMatchObject({ claimed: 1, githubRequests: 3 });
  expect(output.negatives).toEqual(Object.fromEntries(negatives.map(statement => [statement, '42501'])));
  await dropPrincipal();
}, 120_000);
