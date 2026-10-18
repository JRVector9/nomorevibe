import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryClaims, agentRepositoryScans, agentScanControl, crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts,
  crawlSettings, jobs, operationsObservations, productEvidenceSources, productLinks, products } from '@/lib/db/schema';
import { AGENT_SCAN_PRIORITY, claimAgentRepository, recordAgentRepositoryScan, type AgentScanLease } from '@/lib/domain/evidence/agents/claims';
import { beginAgentScanDrain, bumpAgentScanContract, completeAgentScanTransition } from '@/lib/domain/evidence/agents/claim-control';
import { getLatestRepositoryAgentScan, saveRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import type { CollectCursor, CollectResult } from '@/lib/domain/evidence/agents/collect';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { refreshAgentEvidenceJob, type AgentEvidenceRefreshCursor } from '@/lib/jobs/products/agent-evidence-refresh';
import { runJob } from '@/lib/jobs/runner';
import type { GitHubHttpResult } from '@/lib/crawl/github';
import { changeReviewMode, getSettings, saveSettings } from '@/lib/crawl/settings';
import { getCandidate, putDocument, recordJudgement } from '@/lib/crawl/repository';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { candidateRevisionHash, requestCandidateEvidence } from '@/lib/crawl/admin-review';
import type { ControlResult, ControlSnapshot } from '@/lib/operations/pipeline-control';
import { readWorkerProgress } from '@/lib/operations/worker-progress-query';
import { roleHasUnexplainedStall } from '@/scripts/role-worker';
import { ensureSchema, resetTables, TEST_DATABASE_URL } from './setup';

/*
 * E3(PR3) items 모드 컨트롤러·운영 명령·진행 표시. 공유 test DB 의 agent_scan_control 은 파일 끝에 처음 값으로 되돌린다.
 */
const client = postgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
let originalControl: typeof agentScanControl.$inferSelect | undefined;
let originalSettings: (typeof crawlSettings.$inferSelect)[] = [];

beforeAll(async () => {
  ensureSchema();
  [originalControl] = await db.select().from(agentScanControl);
  originalSettings = await db.select().from(crawlSettings);
});
beforeEach(async () => {
  await resetTables();
  await db.delete(agentRepositoryClaims); await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates); await db.delete(crawlDocuments);
  await db.delete(crawlFrontier); await db.delete(crawlSettings); await db.delete(jobs); await db.delete(operationsObservations);
  await saveSettings({ enabled: false, agentEvidence: { enabled: true } }, 'e3-test');
  await db.execute(sql`UPDATE agent_scan_control SET mode = 'legacy', draining_from = NULL, epoch = 1, writer_contract_version = 0 WHERE id = 1`);
});
afterAll(async () => {
  try {
    await db.delete(agentRepositoryClaims);
    if (originalControl) await db.update(agentScanControl).set({ mode: originalControl.mode, drainingFrom: originalControl.drainingFrom,
      epoch: originalControl.epoch, writerContractVersion: originalControl.writerContractVersion }).where(eq(agentScanControl.id, 1));
    await db.delete(crawlSettings);
    if (originalSettings.length) await db.insert(crawlSettings).values(originalSettings);
  } finally { await client.end({ timeout: 3 }); }
});

const inTx = <T>(load: (tx: ProductTransaction) => Promise<T>) => db.transaction(load);
const control = async () => (await db.select().from(agentScanControl))[0];
const claimRow = async (key: string) => (await db.select().from(agentRepositoryClaims).where(eq(agentRepositoryClaims.repositoryKey, key)))[0];
async function toItems() {
  await inTx(tx => bumpAgentScanContract(tx));
  await inTx(tx => beginAgentScanDrain(tx));
  return inTx(tx => completeAgentScanTransition(tx, 'items'));
}
const owner = (name: string) => ({ instanceId: `agent-scan-consumer-${name}`, bootId: randomUUID() });
async function claimed(name: string): Promise<AgentScanLease> {
  const result = await claimAgentRepository({ owner: owner(name) });
  if (result.kind !== 'claimed') throw new Error(`expected a claim, got ${result.reason}`);
  return result.lease;
}
/** 저장소마다 다른 GitHub id 를 주고 파일이 없는 공개 저장소를 그리는 GitHub. 불린 경로를 남긴다 */
function repositories(paths: string[], onRequest: (path: string) => Promise<void> = async () => {}) {
  const ids = new Map<string, number>();
  return async <T>(path: string): Promise<GitHubHttpResult<T>> => {
    paths.push(path);
    await onRequest(path);
    const key = path.split('/').slice(2, 4).join('/');
    if (!ids.has(key)) ids.set(key, 3_000 + ids.size);
    const value = path.includes('/git/trees/') ? { tree: [], truncated: false }
      : path.includes('/commits/') ? { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } }
        : { private: false, id: ids.get(key), default_branch: 'main', full_name: key };
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
}
/** items 틱은 GitHub 를 부르면 안 된다 — 부르면 남기고 던진다 */
function forbiddenGitHub(paths: string[]) {
  return async <T>(path: string): Promise<GitHubHttpResult<T>> => { paths.push(path); throw new Error('github_called_in_items'); };
}
const tick = (request: ReturnType<typeof repositories>) =>
  runJob<AgentEvidenceRefreshCursor>('agent-evidence-refresh', ctx => refreshAgentEvidenceJob(ctx, { request }), { budgetMs: 55_000 });
const job = async () => (await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh')))[0];

const HEAD = 'c'.repeat(40);
const cursorFor = (repositoryKey: string, repositoryId: string, patch: Partial<CollectCursor> = {}): CollectCursor => ({ repositoryId, repositoryKey,
  commitSha: HEAD, detectorVersion: AGENT_DETECTOR_VERSION, scope: '', pendingTrees: [], pendingBlobs: [], pendingCommits: [], ...patch });
const scanOf = (repositoryKey: string, repositoryId: string, patch: Partial<CollectResult> = {}): CollectResult => ({ repositoryId, repositoryKey,
  commitSha: HEAD, scope: '', state: 'partial', observations: [], requestCount: 4, fileCount: 0, errorCode: null, retryAt: null,
  cursor: cursorFor(repositoryKey, repositoryId), ...patch });
const complete = (key: string, id: string) => scanOf(key, id, { state: 'complete', cursor: null });
const ago = (ms: number) => new Date(Date.now() - ms);
const publicProduct = async (slug: string, repositoryKey: string, patch: Partial<typeof products.$inferInsert> = {}) => (await db.insert(products).values({
  slug, url: `https://${slug}.example`, name: slug, tagline: 'test', description: 'test', category: 'Dev', verifyToken: `token-${slug}`,
  editTokenHash: 'a'.repeat(64), repoUrl: `https://github.com/${repositoryKey}`, status: 'seeded', createdAt: ago(200 * 86_400_000), ...patch }).returning())[0];
/** 레포 링크·근거 행이 있는(연결할 곳이 있는) 공개 제품 */
async function linkedProduct(slug: string, repositoryKey: string) {
  const product = await publicProduct(slug, repositoryKey);
  await db.insert(productLinks).values({ slug, kind: 'repository', declarationSource: 'maker', url: `https://github.com/${repositoryKey}`, normalizedKey: repositoryKey });
  await db.insert(productEvidenceSources).values({ slug, kind: 'repository', provider: 'github', sourceKey: repositoryKey, normalizedFacts: { type: 'github_repository' } });
  return product;
}
const attachedScanId = async (slug: string) => (await db.select().from(productEvidenceSources).where(eq(productEvidenceSources.slug, slug)))[0]
  ?.normalizedFacts?.agentScanId ?? null;
/** 자동 판정이 보류한 후보와 원본. 돌려준 함수가 관리자 추가 수집 요청이다(admin-review.ts). repo 는 대소문자가 섞여도 된다 */
async function adminCandidate(repo: string, githubId: number) {
  const productUrl = `https://${repo.toLowerCase().replace('/', '-')}.test`;
  await putDocument({ repo, repoMeta: { id: githubId, full_name: repo, private: false, fork: false, archived: false, stargazers_count: 3,
    pushed_at: '2026-10-01T00:00:00.000Z', owner: { type: 'User' }, homepage: productUrl, description: 'A deployed task tracker' },
  productUrl, pageStatus: 200, pageMeta: { title: 'Task tracker', description: 'Create and manage projects' } });
  await recordJudgement({ repo, productUrl, state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
  await db.insert(crawlFrontier).values({ repo, signal: 'e3-test', state: 'done' });
  await db.update(crawlDocuments).set({ fetchedAt: sql`clock_timestamp() - interval '1 hour'` }).where(eq(crawlDocuments.repo, repo));
  return async () => {
    const candidate = (await getCandidate(repo))!;
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo));
    const input = await loadReviewInput(candidate, document, await getSettings());
    const accepted = await requestCandidateEvidence({ repo, actor: 'e3-test', reason: 'Refresh public evidence', inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, candidateRevisionHash: candidateRevisionHash(candidate) });
    expect(accepted).toMatchObject({ ok: true });
    // 요청 시각(앱 시계)과 스캔 완료 시각(DB 시계)의 로컬 시계 차가 끼지 않게 요청을 1분 앞으로 둔다
    await db.update(crawlReviewAttempts).set({ startedAt: ago(60_000) }).where(eq(crawlReviewAttempts.candidateId, candidate.id));
    return candidate.id;
  };
}
async function enableReview() {
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, 'e3-test');
  vi.stubEnv('CRAWL_REVIEW_READY', 'true');
  expect(await changeReviewMode({ mode: 'enforce', expectedMode: 'off', actor: 'e3-test', reason: 'controller priorities' })).toMatchObject({ ok: true });
  vi.unstubAllEnvs();
}
/** 원본은 방금 받았고 스캔은 하루도 더 전에 끝난 1차 심사 대기 후보(agent-evidence-refresh.test.ts 와 같은 모양) */
async function waitingOnReview(repo: string, githubId: number) {
  const productUrl = `https://${githubId}.example`, fetchedAt = ago(2000);
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt,
    repoMeta: { description: 'A deployed service' }, pageMeta: { title: 'App', description: 'A deployed service' } });
  await db.insert(crawlCandidates).values({ repo, productUrl, state: 'approved', reason: 'passed', decidedBy: 'auto', judgedAt: fetchedAt });
  const scan = (await saveRepositoryAgentScan(complete(repo, String(githubId)), ago(1000)))!;
  const old = ago(30 * 3_600_000);
  await db.update(agentRepositoryScans).set({ startedAt: old, completedAt: old, nextAttemptAt: new Date(old.getTime() + 86_400_000) })
    .where(eq(agentRepositoryScans.id, scan.id));
}

it('runs an items tick as a controller: no GitHub call, every priority class queued, products attached and candidates released', async () => {
  await enableReview();
  const askAdmin = await adminCandidate('Acme/AdminMixed', 911001);
  await waitingOnReview('acme/review', 911002);
  await publicProduct('fresh', 'acme/fresh');
  await db.insert(crawlCandidates).values({ repo: 'acme/candidate' });
  await publicProduct('pending', 'acme/pending');
  await saveRepositoryAgentScan(scanOf('acme/pending', '911004', { cursor: cursorFor('acme/pending', '911004', { pendingTrees: [{ path: 'src', sha: 'd'.repeat(40) }] }) }), ago(2 * 86_400_000));
  await linkedProduct('regular', 'acme/regular');
  const regularScan = (await saveRepositoryAgentScan(complete('acme/regular', '911005'), ago(2 * 86_400_000)))!;
  await publicProduct('broken', 'acme/broken');
  await saveRepositoryAgentScan({ ...scanOf('acme/broken', '911006'), errorCode: 'unavailable' }, ago(2 * 86_400_000));
  // 근거가 갖춰졌는데 근거 대기로 멈춘 후보 — 컨트롤러가 판정으로 되돌린다
  await db.insert(crawlCandidates).values({ repo: 'acme/released', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' });
  await saveRepositoryAgentScan(complete('acme/released', '911007'), ago(1000));
  await askAdmin();
  // legacy 스캔이 남긴 공급자 대기·스캔 전 실패·일반 대기 자리 — 컨트롤러는 그 대기에 막히지 않고, 새 제품 몫의 자리만 남긴다
  // (관리자 요청이 이 잡을 이미 요청해 행이 있다)
  const legacyCursor = { afterRepository: 'acme/zzz', afterNewProduct: 7, retryAfter: new Date(Date.now() + 30 * 60_000).toISOString(),
    providerFailure: { repositoryKey: 'acme/fresh', code: 'rate_limited', firstFailureAt: ago(600_000).toISOString(), lastFailureAt: ago(60_000).toISOString(), failures: 2 } };
  await db.update(jobs).set({ cursor: legacyCursor }).where(eq(jobs.name, 'agent-evidence-refresh'));
  expect((await job()).cursor).toEqual(legacyCursor);
  await toItems();
  const scansBefore = (await db.select().from(agentRepositoryScans)).length;
  const paths: string[] = [];

  expect(await tick(forbiddenGitHub(paths))).toMatchObject({ status: 'completed', done: true });
  expect(paths).toEqual([]);
  expect((await db.select().from(agentRepositoryScans)).length).toBe(scansBefore);
  expect((await job()).cursor).toEqual({ afterNewProduct: 7 });
  const priorities = Object.fromEntries((await db.select().from(agentRepositoryClaims)).map(row => [row.repositoryKey, row.priority]));
  expect(priorities).toEqual({ 'acme/adminmixed': AGENT_SCAN_PRIORITY.admin, 'acme/review': AGENT_SCAN_PRIORITY.review,
    'acme/fresh': AGENT_SCAN_PRIORITY.newProduct, 'acme/candidate': AGENT_SCAN_PRIORITY.newCandidate, 'acme/pending': AGENT_SCAN_PRIORITY.resume,
    'acme/regular': AGENT_SCAN_PRIORITY.regular, 'acme/released': AGENT_SCAN_PRIORITY.regular, 'acme/broken': AGENT_SCAN_PRIORITY.failing });
  expect(await attachedScanId('regular')).toBe(regularScan.id);
  expect((await getCandidate('acme/released'))?.state).toBe('new');
  const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, 'job:agent-evidence-refresh'));
  expect((observation.value as { events: unknown[] }).events).toContainEqual({ event: 'agent_scan.queue_filled', counts: { upserted: 8, gone: 0 } });
  // 요청 뒤 스캔이 아직 없으므로 관리자 요청은 남는다
  expect((await getCandidate('Acme/AdminMixed'))?.state).toBe('needs_review');

  // consumer 는 관리자 요청 저장소를 먼저 맡는다. 스캔이 끝나면 다음 컨트롤러 틱이 실제 repo(대소문자 섞임)로 요청을 소비한다(R6)
  const lease = await claimed('m3');
  expect(lease.repositoryKey).toBe('acme/adminmixed');
  expect(await recordAgentRepositoryScan(lease, complete('acme/adminmixed', '911001'))).toMatchObject({ outcome: 'complete' });
  expect(await tick(forbiddenGitHub(paths))).toMatchObject({ status: 'completed', done: true });
  expect(paths).toEqual([]);
  const consumed = (await getCandidate('Acme/AdminMixed'))!;
  const [request] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, consumed.id));
  expect(consumed).toMatchObject({ state: 'new', reason: 'source_changed', signals: expect.objectContaining({ adminEvidenceRefreshConsumedId: request.id }) });
  const [after] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, 'job:agent-evidence-refresh'));
  expect((after.value as { events: unknown[] }).events).toContainEqual({ event: 'agent_scan.admin_consumed', counts: { consumed: 1 } });
  // 소비된 요청은 더 이상 관리자 몫(priority 0)이 아니다
  expect(await tick(forbiddenGitHub(paths))).toMatchObject({ status: 'completed' });
  expect((await claimRow('acme/adminmixed')).priority).not.toBe(AGENT_SCAN_PRIORITY.admin);
}, 60_000);

it('consumes a mixed-case administrator request after a legacy scan completes (R6)', async () => {
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, 'e3-test');
  const askAdmin = await adminCandidate('Acme/LegacyMixed', 912001);
  const candidateId = await askAdmin();
  const paths: string[] = [];
  expect(await tick(repositories(paths))).toMatchObject({ status: 'completed' });
  expect(paths.some(path => path.includes('acme/legacymixed'))).toBe(true);
  expect(await getLatestRepositoryAgentScan('acme/legacymixed')).toMatchObject({ state: 'complete', lastErrorCode: null });
  const [request] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidateId));
  expect(await getCandidate('Acme/LegacyMixed')).toMatchObject({ state: 'new', reason: 'source_changed',
    signals: expect.objectContaining({ adminEvidenceRefreshConsumedId: request.id }) });
});

it('starts no new legacy scan once the control leaves legacy mid-tick, then runs as a controller while draining', async () => {
  await db.insert(crawlCandidates).values(['acme/r00', 'acme/r01', 'acme/r02'].map(repo => ({ repo })));
  await inTx(tx => bumpAgentScanContract(tx));
  const paths: string[] = [];
  let drained = false;
  // r00 을 받는 도중 운영자가 drain 한다
  const request = repositories(paths, async path => {
    if (!drained && path.includes('acme/r00')) { drained = true; await inTx(tx => beginAgentScanDrain(tx)); }
  });
  expect(await tick(request)).toMatchObject({ status: 'completed', done: false });
  expect(await control()).toMatchObject({ mode: 'draining', drainingFrom: 'legacy' });
  // 시작한 스캔 하나는 draining(from legacy) 관문을 지나 기록되고, 그 뒤 저장소는 시작하지 않는다
  expect(new Set(paths.map(path => path.split('/').slice(2, 4).join('/')))).toEqual(new Set(['acme/r00']));
  expect((await db.select().from(agentRepositoryScans)).map(row => row.repositoryKey)).toEqual(['acme/r00']);

  paths.length = 0;
  expect(await tick(repositories(paths))).toMatchObject({ status: 'completed', done: true });
  expect(paths).toEqual([]);
  expect((await db.select().from(agentRepositoryClaims)).map(row => row.repositoryKey).sort()).toEqual(['acme/r00', 'acme/r01', 'acme/r02']);
});

it('counts claim-table waiting, oldest age and back-offs in items, never asks for a crawler restart, and alarms on a missing consumer', async () => {
  // 수요(후보 3개)와 claim 표: 도래 1 · 저장소 backoff 1 · 미래 1 · gone 1. 스캔은 없다
  await db.insert(crawlCandidates).values(['acme/due', 'acme/backoff', 'acme/later'].map(repo => ({ repo, updatedAt: ago(20 * 60_000) })));
  const utc = (offset: string) => sql`(clock_timestamp() AT TIME ZONE 'UTC') + ${offset}::interval`;
  await db.execute(sql`INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at, state) VALUES
    ('acme/due', ${AGENT_SCAN_PRIORITY.newCandidate}, true, ${utc('-10 minutes')}, 'active'),
    ('acme/later', ${AGENT_SCAN_PRIORITY.newCandidate}, true, ${utc('1 hour')}, 'active'),
    ('acme/old', ${AGENT_SCAN_PRIORITY.regular}, true, ${utc('-1 day')}, 'gone')`);
  await db.execute(sql`INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at, retry_after, failure_streak,
      first_failure_at, last_error_code, last_outcome, last_finished_at)
    VALUES ('acme/backoff', ${AGENT_SCAN_PRIORITY.failing}, true, ${utc('-1 hour')}, ${utc('1 hour')}, 2, ${utc('-2 hours')}, 'unavailable', 'failed', ${utc('-10 minutes')})`);
  // legacy 스캔이 커서에 남긴 스캔 전 공급자 실패 — claim 표로 셀 때는 쓰지 않는다
  await db.insert(jobs).values({ name: 'agent-evidence-refresh', cursor: { providerFailure: { repositoryKey: 'acme/due', code: 'rate_limited',
    firstFailureAt: ago(10 * 60_000).toISOString(), lastFailureAt: ago(5 * 60_000).toISOString(), failures: 2 } } });
  const observe = (key: string) => db.insert(operationsObservations).values({ key, value: { status: 'running' }, observedAt: new Date() })
    .onConflictDoUpdate({ target: operationsObservations.key, set: { observedAt: new Date() } });
  for (const role of ['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text']) await observe(`service:${role}:e3-${role}`);
  const agentStage = async () => {
    const report = await readWorkerProgress();
    return { report, stage: report.stages.find(row => row.stage === 'agent-evidence')! };
  };

  // legacy: 수요와 최신 스캔으로 센다(스캔 없는 후보 3개가 대기, 커서의 공급자 실패)
  const legacy = (await agentStage()).stage;
  expect(legacy).toMatchObject({ waiting: 3, providerErrors: 1 });

  await saveSettings({ enabled: false, agentEvidence: { enabled: true } }, 'e3-test');
  await toItems();
  const missing = await agentStage();
  expect(missing.stage).toMatchObject({ waiting: 1, deferred: 1, providerErrors: 0, errors5m: 0, completed5m: 0,
    reason: 'consumer_missing', alarm: true, restartEligible: false });
  expect(missing.stage.oldestMinutes).toBeGreaterThanOrEqual(9.5);
  expect(missing.stage.oldestMinutes).toBeLessThan(11);
  expect(roleHasUnexplainedStall(missing.report, 'crawler')).toBe(false);

  // consumer 가 살아 있으면 consumer_missing 이 아니다. 진행이 없어도 crawler 재시작 대상은 아니다(설계 R4)
  await observe('service:crawler:agent-scan-consumer-m3');
  const alive = await agentStage();
  expect(alive.stage).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: false });
  expect(roleHasUnexplainedStall(alive.report, 'crawler')).toBe(false);

  // consumer 가 기록한 스캔이 처리로 보이고, 기록한 저장소는 다음 기한으로 대기에서 빠진다
  const lease = await claimed('m3');
  expect(lease.repositoryKey).toBe('acme/due');
  await recordAgentRepositoryScan(lease, complete('acme/due', '913001'));
  expect((await agentStage()).stage).toMatchObject({ waiting: 0, completed5m: 1, progress5m: 1, deferred: 1, reason: 'progressing', restartEligible: false });
}, 60_000);

// --- 운영 명령(scripts/ops/pipeline-control.ts agent-scan …) ---
const CLI = ['--import', 'tsx', 'scripts/ops/pipeline-control.ts'];
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$)/.test(key))),
  NODE_ENV: 'test', PIPELINE_CONTROL_DATABASE_URL: TEST_DATABASE_URL };
const tag = randomUUID().slice(0, 8), operator = `e3-${tag}`;
const audit = [`--operator=${operator}`, '--reason=e3 agent-scan integration'];
type CliRun = { status: number | null; stderr: string; out: (ControlResult & { snapshot: ControlSnapshot }) | null };
function cli(...args: string[]): CliRun {
  const run = spawnSync(process.execPath, [...CLI, ...args, '--json'], { encoding: 'utf8', env, timeout: 60_000 });
  return { status: run.status, stderr: run.stderr, out: run.stdout.trim() ? JSON.parse(run.stdout) : null };
}
const controlRow = async () => (await client`SELECT to_jsonb(t) AS row FROM agent_scan_control t WHERE id = 1`)[0].row as Record<string, unknown>;
const auditMax = async () => (await client`SELECT coalesce(max(id), 0)::int AS id FROM operations_audit`)[0].id as number;
const ownAudit = (after: number) => client`SELECT id, action, target, actor_kind, detail FROM operations_audit WHERE id > ${after} AND actor = ${operator} ORDER BY id`;
/** 살아 있는 claim 한 행(consumer 가 맡은 상태). 소유 열 7개는 함께 채운다 */
const liveClaim = (key: string, epoch: number) => db.execute(sql`INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at,
    epoch, control_epoch, binding_hash, instance_id, boot_id, token, claimed_at, lease_until)
  VALUES (${key}, 5, true, (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute', 1, ${epoch}, ${'a'.repeat(64)}, 'agent-scan-consumer-e3',
    ${randomUUID()}::uuid, ${randomUUID()}::uuid, (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC') + interval '2 minutes')`);

it('plans agent-scan commands in dry-run without writing, then moves legacy → draining → items by compare-and-set with one audit row each', async () => {
  const { epoch } = await control(), before = await controlRow(), auditBefore = await auditMax();
  const contract = ['agent-scan', 'contract', '--expect-contract=0', `--expect-epoch=${epoch}`, ...audit];
  const dry = cli(...contract);
  expect([dry.status, dry.stderr]).toEqual([0, '']);
  expect(dry.out).toMatchObject({ command: 'agent-scan contract', dryRun: true, executed: false, blocked: false,
    plan: { target: 'agent_scan_control', change: 'writer_contract 0 → 1', blocked: [] } });
  expect(dry.out?.before.agentScan).toMatchObject({ mode: 'legacy', contract: 0, epoch, live: 0, consumers: 0 });
  const early = cli('agent-scan', 'drain', '--from-mode=legacy', `--expect-epoch=${epoch}`, ...audit, '--execute');
  expect([early.status, early.out?.executed, early.out?.plan.blocked]).toEqual([3, false, ['agent_scan_contract_required']]);
  const human = spawnSync(process.execPath, [...CLI, 'agent-scan', 'status'], { encoding: 'utf8', env, timeout: 60_000 });
  expect([human.status, human.stderr]).toEqual([0, '']);
  expect(human.stdout).toContain(`[agent-scan] mode=legacy from=- epoch=${epoch} contract=0 live=0 unsettled=0 legacy_job=idle consumers=0`);
  expect(human.stdout).not.toContain('[capacity routes]');
  expect([await controlRow(), await auditMax()]).toEqual([before, auditBefore]);

  expect(cli(...contract, '--execute')).toMatchObject({ status: 0, out: { executed: true } });
  // 기대값이 낡았으면 실행하지 않는다
  const stale = cli('agent-scan', 'drain', '--from-mode=legacy', `--expect-epoch=${epoch + 1}`, ...audit, '--execute');
  expect([stale.status, stale.out?.executed, stale.out?.plan.blocked]).toEqual([3, false, [`expect_epoch_mismatch:${epoch}`]]);
  const drain = cli('agent-scan', 'drain', '--from-mode=legacy', `--expect-epoch=${epoch}`, ...audit, '--execute');
  expect([drain.status, drain.out?.executed, drain.out?.plan.warnings]).toEqual([0, true,
    ['consumer_heartbeat_missing:agent-scan', 'agent_scan_paused_until_complete']]);
  expect(await control()).toMatchObject({ mode: 'draining', drainingFrom: 'legacy', epoch, writerContractVersion: 1 });

  // drain 전에 시작한 잡 틱이 살아 있으면 경고한다(그 틱만 legacy 스캔을 할 수 있다). drain 뒤에 시작한 틱은 컨트롤러라 경고하지 않는다
  const complete = ['agent-scan', 'complete', '--draining-from=legacy', '--to=items', `--expect-epoch=${epoch}`, ...audit];
  await db.execute(sql`INSERT INTO jobs (name, lease_token, locked_at, last_run_at) VALUES ('agent-evidence-refresh', ${randomUUID()}, now(), now() - interval '1 minute')
    ON CONFLICT (name) DO UPDATE SET lease_token = excluded.lease_token, locked_at = excluded.locked_at, last_run_at = excluded.last_run_at`);
  const inFlight = cli(...complete);
  expect([inFlight.status, inFlight.out?.before.agentScan.legacyJobLive, inFlight.out?.plan.warnings]).toEqual([0, true,
    ['consumer_heartbeat_missing:agent-scan', 'legacy_job_in_flight:agent-scan']]);
  await db.execute(sql`UPDATE jobs SET last_run_at = now() WHERE name = 'agent-evidence-refresh'`);
  expect(cli(...complete).out?.before.agentScan.legacyJobLive).toBe(false);
  await db.execute(sql`UPDATE jobs SET lease_token = NULL, locked_at = NULL WHERE name = 'agent-evidence-refresh'`);

  // 살아 있는 claim 이 있으면 dry-run 부터 거절하고, batch 계획도 그것을 센다
  await liveClaim('acme/live', epoch);
  const busy = cli(...complete);
  expect([busy.status, busy.out?.plan.blocked]).toEqual([3, ['agent_scan_not_drained:1']]);
  expect(busy.out?.before).toMatchObject({ agentScan: { live: 1 }, batch: { liveAgentClaims: 1 } });
  expect(cli(...complete, '--execute')).toMatchObject({ status: 3, out: { executed: false, plan: { blocked: ['agent_scan_not_drained:1'] } } });
  expect(await control()).toMatchObject({ mode: 'draining', epoch });
  await db.delete(agentRepositoryClaims);

  const done = cli(...complete, '--execute');
  expect([done.status, done.stderr, done.out?.executed, done.out?.plan.warnings]).toEqual([0, '', true, ['consumer_heartbeat_missing:agent-scan']]);
  expect(await control()).toMatchObject({ mode: 'items', drainingFrom: null, epoch: epoch + 1, writerContractVersion: 1 });
  const rows = await ownAudit(auditBefore);
  expect(rows.map(row => [row.action, row.target, row.actor_kind])).toEqual([
    ['pipeline-control-agent-scan-contract', 'agent_scan_control', null],
    ['pipeline-control-agent-scan-drain', 'agent_scan_control', null],
    ['pipeline-control-agent-scan-complete', 'agent_scan_control', null],
  ]);
  expect(rows[2].detail).toMatchObject({ change: `draining(from legacy) → items, epoch ${epoch} → ${epoch + 1}`,
    before: { mode: 'draining', drainingFrom: 'legacy', epoch }, after: { mode: 'items', epoch: epoch + 1 },
    expected: { drainingFrom: 'legacy', to: 'items', expectEpoch: epoch } });

  // 되돌리기: items → draining(from items) → legacy. 직행은 거절한다
  const direct = cli('agent-scan', 'complete', '--draining-from=items', '--to=legacy', `--expect-epoch=${epoch + 1}`, ...audit, '--execute');
  expect([direct.status, direct.out?.plan.blocked]).toEqual([3, ['expect_mode_mismatch:items', 'expect_draining_from_mismatch:none']]);
  expect(cli('agent-scan', 'drain', '--from-mode=items', `--expect-epoch=${epoch + 1}`, ...audit, '--execute').status).toBe(0);
  expect(cli('agent-scan', 'complete', '--draining-from=items', '--to=legacy', `--expect-epoch=${epoch + 1}`, ...audit, '--execute').status).toBe(0);
  expect(await control()).toMatchObject({ mode: 'legacy', drainingFrom: null, epoch: epoch + 2, writerContractVersion: 1 });
}, 180_000);

it('refuses an agent-scan transition whose control row changed while it waited for the row lock', async () => {
  await inTx(tx => bumpAgentScanContract(tx));
  const { epoch } = await control(), auditBefore = await auditMax();
  const child = spawn(process.execPath, [...CLI, 'agent-scan', 'drain', '--from-mode=legacy', `--expect-epoch=${epoch}`, ...audit, '--execute', '--json'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('close', resolve));
  await client.begin(async tx => {
    await tx`SELECT id FROM agent_scan_control WHERE id = 1 FOR UPDATE`;
    // CLI 의 읽기 전용 판정은 통과했고 실행 TX 가 이 행 잠금 뒤에서 기다리는 것을 본 다음에 바꾼다
    for (let attempt = 0; ; attempt++) {
      const [{ n }] = await client`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'nomorevibe:pipeline-control' AND wait_event_type = 'Lock'`;
      if (n === 1) break;
      if (attempt > 300) throw new Error('cli_lock_wait_timeout');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await tx`UPDATE agent_scan_control SET epoch = epoch + 1 WHERE id = 1`;
  });
  expect([await exited, stderr]).toEqual([3, '']);
  expect(JSON.parse(stdout)).toMatchObject({ executed: false, blocked: true, plan: { blocked: [`expect_epoch_mismatch:${epoch + 1}`] } });
  expect(await control()).toMatchObject({ mode: 'legacy', epoch: epoch + 1 });
  expect(await auditMax()).toBe(auditBefore);
}, 120_000);
